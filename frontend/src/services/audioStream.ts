import { getStoredToken, getDefaultServerUrl } from './api';

export type AudioStateChangeHandler = (active: boolean, error?: string) => void;
export type LatencyPreset = 'ultra' | 'movie' | 'music';

export interface AudioStats {
  latencyMs: number;
  sampleRate: number;
  deviceSampleRate: number;
}

export class AudioStreamClient {
  private ws: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  private keepAliveSource: AudioBufferSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private wakeLock: any = null;

  // Ring Buffer: Interleaved Stereo Float32 Samples
  // 96,000 frames = 2 seconds of 48kHz Stereo (192,000 floats)
  private readonly RING_CAPACITY_FRAMES = 96000;
  private ringBuffer = new Float32Array(this.RING_CAPACITY_FRAMES * 2);
  private writeFrameIdx = 0;
  private readFrameFloat = 0.0;
  private availableFrames = 0;
  private isPlaying = false;

  // Audio & Hardware Configuration
  public backendSampleRate = 48000;
  public backendChannels = 2;
  public deviceSampleRate = 48000;
  private nominalRatio = 1.0;

  // Drift Control Loop (Proportional-Integral)
  private integralErr = 0.0;
  private currentRatio = 1.0;
  private softGain = 0.0; // Smooth 0.0 -> 1.0 ramp to eliminate clicks & pops

  // Controls & Settings
  private volume = 1.0;
  private isPhoneMutedState = false;
  private latencyPreset: LatencyPreset = 'movie';
  private isRunning = false;
  private onStateChangeCallback?: AudioStateChangeHandler;

  // Diagnostic Stats
  private stats: AudioStats = {
    latencyMs: 75,
    sampleRate: 48000,
    deviceSampleRate: 48000
  };

  constructor(onStateChange?: AudioStateChangeHandler) {
    this.onStateChangeCallback = onStateChange;
  }

  public isActive(): boolean {
    return this.isRunning;
  }

  public getVolume(): number {
    return this.volume;
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1.5, vol));
    if (this.gainNode) {
      this.gainNode.gain.value = this.isPhoneMutedState ? 0 : this.volume;
    }
  }

  public isMuted(): boolean {
    return this.isPhoneMutedState;
  }

  public toggleMute(): boolean {
    this.isPhoneMutedState = !this.isPhoneMutedState;
    if (this.gainNode) {
      this.gainNode.gain.value = this.isPhoneMutedState ? 0 : this.volume;
    }
    return this.isPhoneMutedState;
  }

  public getLatencyPreset(): LatencyPreset {
    return this.latencyPreset;
  }

  public setLatencyPreset(mode: LatencyPreset): void {
    this.latencyPreset = mode;
    this.integralErr = 0;
  }

  public getStats(): AudioStats {
    this.stats.latencyMs = Math.round((this.availableFrames / this.backendSampleRate) * 1000);
    this.stats.sampleRate = this.backendSampleRate;
    this.stats.deviceSampleRate = this.deviceSampleRate;
    return this.stats;
  }

  public getFrequencyData(array: Uint8Array): void {
    if (this.analyserNode && this.isRunning && this.isPlaying) {
      this.analyserNode.getByteFrequencyData(array as any);
    } else {
      array.fill(0);
    }
  }

  private getTargetLatencySeconds(): number {
    switch (this.latencyPreset) {
      case 'ultra':
        return 0.050; // ~50ms ultra-low latency
      case 'movie':
        return 0.080; // ~80ms smooth sync
      case 'music':
      default:
        return 0.140; // ~140ms jitter buffer
    }
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
          this.audioCtx = new AudioContextClass({ sampleRate: 48000, latencyHint: 'interactive' });
        } catch {
          this.audioCtx = new AudioContextClass();
        }
      }

      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      this.deviceSampleRate = this.audioCtx.sampleRate || 48000;
      this.nominalRatio = this.backendSampleRate / this.deviceSampleRate;
      this.currentRatio = this.nominalRatio;

      // 2. Request Screen WakeLock so mobile phone doesn't sleep
      if ('wakeLock' in navigator) {
        try {
          this.wakeLock = await (navigator as any).wakeLock.request('screen');
        } catch {
          // ignore wakeLock error
        }
      }

      // Reset Buffer & DSP State
      this.ringBuffer.fill(0);
      this.writeFrameIdx = 0;
      this.readFrameFloat = 0.0;
      this.availableFrames = 0;
      this.isPlaying = false;
      this.integralErr = 0.0;
      this.softGain = 0.0;

      // 3. Audio Processing Pipeline: ScriptProcessor -> GainNode -> Compressor -> Analyser -> Destination
      // 1024 frame buffer for swift responsiveness
      const bufferSize = 1024;
      this.processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 2);

      // Keep-alive silent driver so mobile browsers never deprioritize or sleep onaudioprocess
      try {
        const silentBuffer = this.audioCtx.createBuffer(1, 1024, this.deviceSampleRate);
        this.keepAliveSource = this.audioCtx.createBufferSource();
        this.keepAliveSource.buffer = silentBuffer;
        this.keepAliveSource.loop = true;
        this.keepAliveSource.connect(this.processor);
        this.keepAliveSource.start();
      } catch {
        // ignore fallback
      }

      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.isPhoneMutedState ? 0 : this.volume;

      // Studio Mastering Limiter: Prevents clipping distortion & enhances punch at all volume levels
      this.compressorNode = this.audioCtx.createDynamicsCompressor();
      this.compressorNode.threshold.value = -1.0;
      this.compressorNode.knee.value = 6.0;
      this.compressorNode.ratio.value = 12.0;
      this.compressorNode.attack.value = 0.003;
      this.compressorNode.release.value = 0.12;

      this.analyserNode = this.audioCtx.createAnalyser();
      this.analyserNode.fftSize = 64;
      this.analyserNode.smoothingTimeConstant = 0.8;

      this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
        const outLeft = e.outputBuffer.getChannelData(0);
        const outRight = e.outputBuffer.getChannelData(1);
        const outLength = outLeft.length;

        const targetSec = this.getTargetLatencySeconds();
        const targetFrames = targetSec * this.backendSampleRate;
        const prebufferThreshold = targetFrames * 1.05;

        // Start playback once initial prebuffer is filled
        if (!this.isPlaying) {
          if (this.availableFrames >= prebufferThreshold) {
            this.isPlaying = true;
          } else {
            outLeft.fill(0);
            outRight.fill(0);
            return;
          }
        }

        // Catch up if buffer grew excessively (e.g. background tab resumed)
        const maxHeadroomFrames = targetFrames * 3.5;
        if (this.availableFrames > maxHeadroomFrames) {
          const excess = this.availableFrames - targetFrames;
          this.readFrameFloat = (this.readFrameFloat + excess) % this.RING_CAPACITY_FRAMES;
          this.availableFrames -= excess;
          this.softGain = 0.2; // brief soften to prevent click
        }

        // Buffer Underrun Check: if network packet was delayed, fade out gracefully without glitching
        if (this.availableFrames < outLength * this.currentRatio) {
          for (let i = 0; i < outLength; i++) {
            this.softGain = Math.max(0.0, this.softGain - 0.02);
            outLeft[i] *= this.softGain;
            outRight[i] *= this.softGain;
          }
          this.isPlaying = false; // pause until packet refill
          return;
        }

        // --- Proportional-Integral (PI) Clock Drift Controller ---
        // Dynamically adjusts playback speed by up to ±1.5% to maintain exact target latency
        // Without ANY jumps, frame drops, or robotic pitch zigzag!
        const frameError = this.availableFrames - targetFrames;
        const errorSec = frameError / this.backendSampleRate;

        // P term: immediate correction
        const pTerm = errorSec * 0.35;
        // I term: cumulative drift compensation
        this.integralErr += errorSec * (outLength / this.deviceSampleRate) * 0.05;
        this.integralErr = Math.max(-0.012, Math.min(0.012, this.integralErr));

        // Speed adjustment delta capped at ±1.5% (imperceptible to human ears)
        const speedDelta = Math.max(-0.015, Math.min(0.015, pTerm + this.integralErr));
        this.currentRatio = this.nominalRatio * (1.0 + speedDelta);

        // --- Linear Interpolation Resampling ---
        const cap = this.RING_CAPACITY_FRAMES;
        for (let i = 0; i < outLength; i++) {
          if (this.availableFrames < 2) {
            outLeft[i] = 0;
            outRight[i] = 0;
            continue;
          }

          const f0 = Math.floor(this.readFrameFloat);
          const frac = this.readFrameFloat - f0;
          const idx0 = f0 % cap;
          const idx1 = (idx0 + 1) % cap;

          const s0_L = this.ringBuffer[idx0 * 2];
          const s0_R = this.ringBuffer[idx0 * 2 + 1];
          const s1_L = this.ringBuffer[idx1 * 2];
          const s1_R = this.ringBuffer[idx1 * 2 + 1];

          // Linearly interpolated stereo samples
          const sampleL = s0_L + frac * (s1_L - s0_L);
          const sampleR = s0_R + frac * (s1_R - s0_R);

          // Smooth ramp-up to eliminate start/restart pops
          if (this.softGain < 1.0) {
            this.softGain = Math.min(1.0, this.softGain + 0.01);
          }

          outLeft[i] = sampleL * this.softGain;
          outRight[i] = sampleR * this.softGain;

          this.readFrameFloat = (this.readFrameFloat + this.currentRatio) % cap;
          this.availableFrames -= this.currentRatio;
        }
      };

      // Connect DSP chain: Processor -> Gain -> Compressor -> Analyser -> Destination
      this.processor.connect(this.gainNode);
      this.gainNode.connect(this.compressorNode);
      this.compressorNode.connect(this.analyserNode);
      this.analyserNode.connect(this.audioCtx.destination);

      // Mobile Safari keepalive audio source
      try {
        const dummy = this.audioCtx.createBufferSource();
        dummy.buffer = this.audioCtx.createBuffer(1, 1, 22050);
        dummy.connect(this.audioCtx.destination);
        dummy.start(0);
      } catch {
        // ignore
      }

      // 4. Connect WebSocket
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
              this.backendSampleRate = meta.sampleRate || 48000;
              this.backendChannels = meta.channels || 2;
              if (this.audioCtx) {
                this.deviceSampleRate = this.audioCtx.sampleRate || 48000;
                this.nominalRatio = this.backendSampleRate / this.deviceSampleRate;
                this.currentRatio = this.nominalRatio;
              }
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

    const numFrames = Math.floor(numSamples / 2);
    const cap = this.RING_CAPACITY_FRAMES;

    // Fast batch write into ring buffer with normalization to [-1.0, 1.0]
    for (let f = 0; f < numFrames; f++) {
      const idx = (this.writeFrameIdx + f) % cap;
      this.ringBuffer[idx * 2] = int16[f * 2] / 32768.0;
      this.ringBuffer[idx * 2 + 1] = int16[f * 2 + 1] / 32768.0;
    }

    this.writeFrameIdx = (this.writeFrameIdx + numFrames) % cap;
    this.availableFrames = Math.min(cap, this.availableFrames + numFrames);
  }

  public stop(error?: string): void {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    if (this.keepAliveSource) {
      try {
        this.keepAliveSource.stop();
        this.keepAliveSource.disconnect();
      } catch {
        // ignore
      }
      this.keepAliveSource = null;
    }
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this.compressorNode) {
      this.compressorNode.disconnect();
      this.compressorNode = null;
    }
    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
    }
    if (this.wakeLock) {
      try {
        this.wakeLock.release();
      } catch {
        // ignore
      }
      this.wakeLock = null;
    }
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.suspend().catch(() => {});
    }
    this.isRunning = false;
    this.isPlaying = false;
    this.availableFrames = 0;
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

// Global shared singleton so WirelessSpeaker and Touchpad can share the audio client if needed
export const sharedAudioClient = new AudioStreamClient();
