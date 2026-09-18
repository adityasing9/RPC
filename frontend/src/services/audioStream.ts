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
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!this.audioCtx) {
        this.audioCtx = new AudioContextClass();
      }

      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

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
          } catch (err) {
            // ignore non-json text
          }
          return;
        }

        if (event.data instanceof ArrayBuffer && this.audioCtx && this.audioCtx.state === 'running') {
          this.playPcmChunk(event.data);
        }
      };

      this.ws.onerror = () => {
        this.stop('Connection error');
      };

      this.ws.onclose = () => {
        this.stop();
      };
    } catch (err: any) {
      this.stop(err?.message || 'Audio initialization failed');
    }
  }

  private playPcmChunk(buffer: ArrayBuffer) {
    if (!this.audioCtx) return;

    const int16 = new Int16Array(buffer);
    const numChannels = this.channels;
    const numFrames = int16.length / numChannels;
    if (numFrames <= 0) return;

    const audioBuffer = this.audioCtx.createBuffer(numChannels, numFrames, this.sampleRate);

    // Deinterleave 16-bit PCM to Float32 [-1.0, 1.0]
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numFrames; i++) {
        channelData[i] = int16[i * numChannels + ch] / 32768.0;
      }
    }

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);

    const currentTime = this.audioCtx.currentTime;
    // Keep playback in real-time sync with 30ms jitter safety window
    if (this.nextPlayTime < currentTime || this.nextPlayTime > currentTime + 0.15) {
      this.nextPlayTime = currentTime + 0.03;
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
    if (this.audioCtx) {
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
