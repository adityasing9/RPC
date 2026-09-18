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
      // 1. Initialize and unlock AudioContext synchronously during user click
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!this.audioCtx) {
        this.audioCtx = new AudioContextClass();
      }

      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      // Play a 1-sample silent burst to completely unlock mobile Safari / Chrome audio pipeline
      try {
        const silentBuf = this.audioCtx.createBuffer(1, 1, 22050);
        const silentSource = this.audioCtx.createBufferSource();
        silentSource.buffer = silentBuf;
        silentSource.connect(this.audioCtx.destination);
        silentSource.start(0);
      } catch (e) {
        // ignore
      }

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
          } catch (err) {
            // ignore
          }
          return;
        }

        if (event.data instanceof ArrayBuffer && this.audioCtx) {
          this.playPcmChunk(event.data);
        }
      };

      this.ws.onerror = () => {
        this.stop('Audio connection failed');
      };

      this.ws.onclose = () => {
        this.stop();
      };
    } catch (err: any) {
      this.stop(err?.message || 'Audio playback init failed');
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
    } catch (e) {
      // Fallback to audio context native sample rate if browser restricts
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
    // Jitter buffer: synchronize and smooth out network delivery
    if (this.nextPlayTime < currentTime || this.nextPlayTime > currentTime + 0.20) {
      this.nextPlayTime = currentTime + 0.04;
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
