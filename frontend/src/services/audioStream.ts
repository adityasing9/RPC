import { getStoredToken, getDefaultServerUrl } from './api';

export type AudioStateChangeHandler = (active: boolean, error?: string) => void;

export class AudioStreamClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;

  // Circular Ring Buffer Configuration (2 seconds of 48kHz Stereo)
  private readonly RING_CAPACITY = 48000 * 2 * 2; // 192,000 samples
  private ringBuffer = new Float32Array(this.RING_CAPACITY);
  private writePtr = 0;
  private readPtr = 0;
  private availableSamples = 0;
  private hasStartedPlayback = false;

  public sampleRate = 48000;
  public channels = 2;
  private isRunning = false;
  private onStateChangeCallback?: AudioStateChangeHandler;

  constructor(onStateChange?: AudioStateChangeHandler) {
    this.onStateChangeCallback = onStateChange;
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    const token = getStoredToken();
    if (!token) {
      this.onStateChangeCallback?.(false, 'Device not paired or token missing');
      return;
    }

    try {
      // 1. Initialize AudioContext
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        try {
          this.audioCtx = new AudioContextClass({ sampleRate: 48000 });
        } catch {
          this.audioCtx = new AudioContextClass();
        }
      }

      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      // Reset Ring Buffer
      this.ringBuffer.fill(0);
      this.writePtr = 0;
      this.readPtr = 0;
      this.availableSamples = 0;
      this.hasStartedPlayback = false;

      // 2. Create Continuous Ring-Buffer Audio Processor (2048 buffer size = ~42ms)
      const bufferSize = 2048;
      this.processor = this.audioCtx.createScriptProcessor(bufferSize, 0, 2);

      this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const left = e.outputBuffer.getChannelData(0);
        const right = e.outputBuffer.getChannelData(1);
        const frames = left.length;
        const needed = frames * 2; // Stereo interleaved

        // Pre-buffer 100ms (~9,600 samples) before initial playback to completely absorb Wi-Fi jitter
        if (!this.hasStartedPlayback) {
          if (this.availableSamples >= 4800 * 2) {
            this.hasStartedPlayback = true;
          } else {
            left.fill(0);
            right.fill(0);
            return;
          }
        }

        // Buffer Underrun Handling: If network packet was delayed, output smooth fade to silence
        if (this.availableSamples < needed) {
          for (let i = 0; i < frames; i++) {
            if (this.availableSamples >= 2) {
              left[i] = this.ringBuffer[this.readPtr];
              this.readPtr = (this.readPtr + 1) % this.RING_CAPACITY;
              right[i] = this.ringBuffer[this.readPtr];
              this.readPtr = (this.readPtr + 1) % this.RING_CAPACITY;
              this.availableSamples -= 2;
            } else {
              left[i] = 0;
              right[i] = 0;
            }
          }
          this.hasStartedPlayback = false; // Wait for brief refill before playing again
          return;
        }

        // Seamless continuous linear sample playback:
        for (let i = 0; i < frames; i++) {
          left[i] = this.ringBuffer[this.readPtr];
          this.readPtr = (this.readPtr + 1) % this.RING_CAPACITY;
          right[i] = this.ringBuffer[this.readPtr];
          this.readPtr = (this.readPtr + 1) % this.RING_CAPACITY;
        }
        this.availableSamples -= needed;

        // Clock drift control: If buffer accumulates over 250ms due to device clock difference,
        // smoothly advance read pointer to maintain sub-120ms real-time latency without stutter.
        const maxBufferLead = 48000 * 2 * 0.25;
        if (this.availableSamples > maxBufferLead) {
          const excess = this.availableSamples - (48000 * 2 * 0.12);
          this.readPtr = (this.readPtr + excess) % this.RING_CAPACITY;
          this.availableSamples -= excess;
        }
      };

      // Keep processor alive by connecting to destination
      this.processor.connect(this.audioCtx.destination);

      // Mobile Safari keepalive audio source
      try {
        const dummy = this.audioCtx.createBufferSource();
        dummy.buffer = this.audioCtx.createBuffer(1, 1, 22050);
        dummy.connect(this.audioCtx.destination);
        dummy.start(0);
      } catch {
        // ignore
      }

      // 3. Connect WebSocket
      const serverUrl = getDefaultServerUrl();
      const wsUrl = serverUrl.replace(/^http/, 'ws') + `/api/v1/audio/ws?token=${encodeURIComponent(token)}`;

      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.isRunning = true;
        this.onStateChangeCallback?.(true);
      };

      this.ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data === 'string') {
          try {
            const meta = JSON.parse(event.data);
            if (meta.type === 'init') {
              this.sampleRate = meta.sampleRate || 48000;
              this.channels = meta.channels || 2;
            }
          } catch {
            // ignore
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          this.enqueuePcmChunk(event.data);
        }
      };

      this.ws.onerror = () => {
        this.stop('Audio connection error');
      };

      this.ws.onclose = () => {
        this.stop();
      };
    } catch (err: any) {
      this.stop(err?.message || 'Audio initialization failed');
    }
  }

  private enqueuePcmChunk(buffer: ArrayBuffer) {
    if (!this.audioCtx) return;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    const int16 = new Int16Array(buffer);
    const numSamples = int16.length;
    if (numSamples <= 0) return;

    // Direct circular buffer write
    for (let i = 0; i < numSamples; i++) {
      this.ringBuffer[this.writePtr] = int16[i] / 32768.0;
      this.writePtr = (this.writePtr + 1) % this.RING_CAPACITY;
    }
    this.availableSamples += numSamples;
  }

  public stop(error?: string): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.suspend().catch(() => {});
    }
    this.isRunning = false;
    this.hasStartedPlayback = false;
    this.availableSamples = 0;
    this.onStateChangeCallback?.(false, error);
  }

  public toggle(): void {
    if (this.isRunning) {
      this.stop();
    } else {
      this.start();
    }
  }
}
