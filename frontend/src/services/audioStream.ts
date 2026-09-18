import { getStoredToken, getDefaultServerUrl } from './api';

export type AudioStateChangeHandler = (active: boolean, error?: string) => void;

export class AudioStreamClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private sampleRate: number = 48000;
  private channels: number = 2;
  private nextPlayTime: number = 0;
  private isRunning: boolean = false;
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
      // 1. Initialize AudioContext at 48kHz to match Windows native rate
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

      // Mobile Safari / Chrome unlock burst
      try {
        const silentBuf = this.audioCtx.createBuffer(1, 1, 22050);
        const silentSource = this.audioCtx.createBufferSource();
        silentSource.buffer = silentBuf;
        silentSource.connect(this.audioCtx.destination);
        silentSource.start(0);
      } catch {
        // ignore
      }

      // Reset playback timeline
      this.nextPlayTime = 0;

      // 2. Connect WebSocket
      const serverUrl = getDefaultServerUrl();
      const wsUrl = serverUrl.replace(/^http/, 'ws') + `/api/v1/audio/ws?token=${encodeURIComponent(token)}`;

      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => {
        this.isRunning = true;
        this.nextPlayTime = 0;
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

        if (event.data instanceof ArrayBuffer && this.audioCtx) {
          this.playPcmChunk(event.data);
        }
      };

      this.ws.onerror = () => {
        this.stop('Audio connection error');
      };

      this.ws.onclose = () => {
        this.stop();
      };
    } catch (err: any) {
      this.stop(err?.message || 'Audio playback failed to initialize');
    }
  }

  private playPcmChunk(buffer: ArrayBuffer) {
    if (!this.audioCtx) return;

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    const int16 = new Int16Array(buffer);
    const numChannels = this.channels || 2;
    const numFrames = int16.length / numChannels;
    if (numFrames <= 0) return;

    const targetChannels = Math.min(numChannels, 2);
    let audioBuffer: AudioBuffer;
    try {
      audioBuffer = this.audioCtx.createBuffer(targetChannels, numFrames, this.sampleRate);
    } catch {
      audioBuffer = this.audioCtx.createBuffer(targetChannels, numFrames, this.audioCtx.sampleRate);
    }

    // Deinterleave 16-bit PCM to Float32 [-1.0, 1.0]
    for (let ch = 0; ch < targetChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numFrames; i++) {
        channelData[i] = int16[i * numChannels + ch] / 32768.0;
      }
    }

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);

    const currentTime = this.audioCtx.currentTime;

    // Smooth continuous audio timeline scheduling:
    // If playback fell behind the clock (underrun), anchor with a 100ms cushion.
    // Otherwise, seamlessly append chunk directly after the previous chunk (sample-perfect).
    if (this.nextPlayTime < currentTime) {
      this.nextPlayTime = currentTime + 0.10;
    } else if (this.nextPlayTime > currentTime + 0.80) {
      // If lag accumulated over 800ms, resync smoothly
      this.nextPlayTime = currentTime + 0.10;
    }

    source.start(this.nextPlayTime);
    this.nextPlayTime += audioBuffer.duration;
  }

  public stop(error?: string): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.suspend().catch(() => {});
    }
    this.isRunning = false;
    this.nextPlayTime = 0;
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
