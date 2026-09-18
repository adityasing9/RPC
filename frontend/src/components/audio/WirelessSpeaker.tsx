import React, { useState, useEffect, useRef } from 'react';
import {
  Volume2,
  VolumeX,
  Volume1,
  Radio,
  Sparkles,
  Zap,
  Music,
  Tv,
  Laptop,
  Smartphone,
  Sun
} from 'lucide-react';
import { sharedAudioClient } from '../../services/audioStream';
import type { LatencyPreset } from '../../services/audioStream';
import { api } from '../../services/api';

export const WirelessSpeaker: React.FC = () => {
  const [isActive, setIsActive] = useState<boolean>(sharedAudioClient.isActive());
  const [volume, setVolume] = useState<number>(sharedAudioClient.getVolume());
  const [isPhoneMuted, setIsPhoneMuted] = useState<boolean>(sharedAudioClient.isMuted());
  const [latencyPreset, setLatencyPreset] = useState<LatencyPreset>(sharedAudioClient.getLatencyPreset());
  const [isLaptopMuted, setIsLaptopMuted] = useState<boolean>(false);
  const [frequencies, setFrequencies] = useState<number[]>(new Array(16).fill(0));

  const animFrameRef = useRef<number | null>(null);
  const freqDataRef = useRef<Uint8Array>(new Uint8Array(32));

  // Sync state with audio client
  useEffect(() => {
    const checkState = () => {
      setIsActive(sharedAudioClient.isActive());
      setVolume(sharedAudioClient.getVolume());
      setIsPhoneMuted(sharedAudioClient.isMuted());
    };

    const interval = setInterval(checkState, 1000);
    return () => clearInterval(interval);
  }, []);

  // Visualizer render loop using requestAnimationFrame
  useEffect(() => {
    if (!isActive) {
      setFrequencies(new Array(16).fill(0));
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      return;
    }

    const updateVisualizer = () => {
      sharedAudioClient.getFrequencyData(freqDataRef.current);
      // Sample 16 frequency bands
      const bands: number[] = [];
      for (let i = 0; i < 16; i++) {
        // Frequency data is 0-255; normalize to 0-100%
        const val = freqDataRef.current[i] || 0;
        bands.push(Math.round((val / 255) * 100));
      }
      setFrequencies(bands);
      animFrameRef.current = requestAnimationFrame(updateVisualizer);
    };

    animFrameRef.current = requestAnimationFrame(updateVisualizer);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isActive]);

  const handleToggleSpeaker = async () => {
    if (isActive) {
      sharedAudioClient.stop();
      setIsActive(false);
    } else {
      await sharedAudioClient.start();
      setIsActive(sharedAudioClient.isActive());
    }
  };

  const handleVolumeChange = (newVol: number) => {
    setVolume(newVol);
    sharedAudioClient.setVolume(newVol);
  };

  const handleTogglePhoneMute = () => {
    const muted = sharedAudioClient.toggleMute();
    setIsPhoneMuted(muted);
  };

  const handleToggleLatency = (preset: LatencyPreset) => {
    setLatencyPreset(preset);
    sharedAudioClient.setLatencyPreset(preset);
  };

  const handleMuteLaptopSpeakers = async () => {
    try {
      await api.volumeMute();
      setIsLaptopMuted(!isLaptopMuted);
    } catch (e) {
      console.error('Failed to toggle laptop volume mute', e);
    }
  };

  return (
    <div className="rounded-3xl bg-dark-900 border border-dark-800 p-5 shadow-2xl relative overflow-hidden transition-all">
      {/* Background Ambient Glow when active */}
      {isActive && (
        <div className="absolute -right-16 -top-16 w-56 h-56 bg-brand-primary/10 rounded-full blur-3xl pointer-events-none animate-pulse" />
      )}

      {/* Header Bar */}
      <div className="flex items-center justify-between pb-4 border-b border-dark-800 relative z-10">
        <div className="flex items-center gap-3">
          <div
            className={`p-3 rounded-2xl border transition-all ${
              isActive
                ? 'bg-brand-primary/20 text-brand-primary border-brand-primary/40 shadow-lg shadow-brand-primary/20 scale-105'
                : 'bg-dark-950 text-slate-500 border-dark-800'
            }`}
          >
            <Volume2 className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-white tracking-tight">Wireless PC Speaker</h3>
              {isActive ? (
                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 text-[10px] font-bold animate-pulse">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                  LIVE ON PHONE
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded-full bg-dark-950 text-slate-500 border border-dark-800 text-[10px] font-mono">
                  STANDBY
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400 mt-0.5">Stream all laptop sound to this phone in real time</p>
          </div>
        </div>

        {/* Screen Awake Badge */}
        {isActive && (
          <div
            className="hidden xs:flex items-center gap-1 text-[11px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 rounded-xl"
            title="Screen WakeLock is active so phone won't sleep while playing"
          >
            <Sun className="w-3.5 h-3.5 animate-spin" style={{ animationDuration: '8s' }} />
            <span>Screen Awake</span>
          </div>
        )}
      </div>

      {/* Main Action Banner */}
      <div className="mt-5 flex flex-col sm:flex-row items-center justify-between gap-4 p-4 rounded-2xl bg-dark-950 border border-dark-800/80 relative z-10">
        <div className="flex items-center gap-3.5 w-full sm:w-auto">
          <button
            onClick={handleToggleSpeaker}
            className={`w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 border transition-all active:scale-95 shadow-xl ${
              isActive
                ? 'bg-brand-primary text-dark-950 border-brand-primary/80 shadow-brand-primary/30 ring-4 ring-brand-primary/20'
                : 'bg-dark-900 text-slate-400 hover:text-white border-dark-700 hover:border-dark-600'
            }`}
          >
            {isActive ? <Volume2 className="w-7 h-7 animate-bounce" /> : <VolumeX className="w-7 h-7" />}
          </button>
          <div>
            <span className="text-xs font-bold text-white block">
              {isActive ? 'Phone Acting as Laptop Speaker' : 'Use Phone as Wireless Speaker'}
            </span>
            <span className="text-[11px] text-slate-400 mt-0.5 block">
              {isActive ? 'Laptop audio playing via phone speakers / earphones' : 'Tap power button to connect audio stream'}
            </span>
          </div>
        </div>

        <button
          onClick={handleToggleSpeaker}
          className={`w-full sm:w-auto px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 ${
            isActive
              ? 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/40 shadow-rose-500/10'
              : 'bg-brand-primary text-dark-950 hover:bg-cyan-400 shadow-brand-primary/20'
          }`}
        >
          <Radio className={`w-3.5 h-3.5 ${isActive ? 'animate-pulse' : ''}`} />
          <span>{isActive ? 'Disconnect Speaker' : 'Turn ON Speaker'}</span>
        </button>
      </div>

      {/* Live Frequency Audio Visualizer */}
      {isActive && (
        <div className="mt-4 p-3.5 rounded-2xl bg-dark-950 border border-dark-800/80 relative z-10">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3 text-brand-primary" />
              Live Audio Output Visualizer
            </span>
            <span className="text-[10px] font-mono text-emerald-400">48,000 Hz Stereo PCM</span>
          </div>
          <div className="flex items-end justify-between gap-1.5 h-12 pt-1 px-1">
            {frequencies.map((height, idx) => (
              <div
                key={idx}
                className="flex-1 bg-dark-900 rounded-t-sm relative overflow-hidden h-full flex items-end"
              >
                <div
                  style={{ height: `${Math.max(6, height)}%` }}
                  className="w-full bg-gradient-to-t from-brand-primary via-emerald-400 to-cyan-300 rounded-t-sm transition-all duration-75"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Control Strip: Phone Volume Boost & Latency Presets */}
      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 relative z-10">
        {/* Phone Volume & Boost Slider */}
        <div className="p-3.5 rounded-2xl bg-dark-950 border border-dark-800 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
              <Smartphone className="w-3.5 h-3.5 text-brand-primary" />
              Phone Speaker Output
            </span>
            <span className={`text-[11px] font-mono font-bold ${volume > 1.0 ? 'text-amber-400' : 'text-slate-300'}`}>
              {isPhoneMuted ? 'Muted' : `${Math.round(volume * 100)}%${volume > 1.0 ? ' Boost' : ''}`}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleTogglePhoneMute}
              className={`p-1.5 rounded-lg border transition-all ${
                isPhoneMuted
                  ? 'bg-rose-500/20 border-rose-500/40 text-rose-400'
                  : 'bg-dark-900 border-dark-700 text-slate-400 hover:text-white'
              }`}
              title={isPhoneMuted ? 'Unmute phone' : 'Mute phone'}
            >
              {isPhoneMuted ? <VolumeX className="w-4 h-4" /> : <Volume1 className="w-4 h-4" />}
            </button>

            <input
              type="range"
              min="0"
              max="1.5"
              step="0.05"
              value={isPhoneMuted ? 0 : volume}
              onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
              className="flex-1 h-2 bg-dark-800 rounded-lg appearance-none cursor-pointer accent-brand-primary"
            />
          </div>
        </div>

        {/* Latency & Laptop Mute Quick Controls */}
        <div className="p-3.5 rounded-2xl bg-dark-950 border border-dark-800 flex flex-col justify-between gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-brand-primary" />
              Audio Sync Mode
            </span>
            <div className="flex items-center bg-dark-900 p-0.5 rounded-xl border border-dark-800 text-[10px] font-medium">
              <button
                onClick={() => handleToggleLatency('ultra')}
                className={`px-2 py-1 rounded-lg flex items-center gap-1 transition-all ${
                  latencyPreset === 'ultra'
                    ? 'bg-brand-primary text-dark-950 font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="Ultra-low latency (~50ms) for games and instant response"
              >
                <Zap className="w-3 h-3" />
                <span>Ultra (50ms)</span>
              </button>
              <button
                onClick={() => handleToggleLatency('movie')}
                className={`px-2 py-1 rounded-lg flex items-center gap-1 transition-all ${
                  latencyPreset === 'movie'
                    ? 'bg-brand-primary text-dark-950 font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="Balanced sync (~80ms) for YouTube & movies"
              >
                <Tv className="w-3 h-3" />
                <span>Movie</span>
              </button>
              <button
                onClick={() => handleToggleLatency('music')}
                className={`px-2 py-1 rounded-lg flex items-center gap-1 transition-all ${
                  latencyPreset === 'music'
                    ? 'bg-brand-primary text-dark-950 font-bold'
                    : 'text-slate-400 hover:text-white'
                }`}
                title="Rock-solid jitter buffer (~140ms) for music & weak Wi-Fi"
              >
                <Music className="w-3 h-3" />
                <span>Music</span>
              </button>
            </div>
          </div>

          {/* Mute Physical Laptop Speakers */}
          <div className="flex items-center justify-between pt-1 border-t border-dark-800/60">
            <span className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Laptop className="w-3.5 h-3.5 text-slate-500" />
              Laptop Speakers
            </span>
            <button
              onClick={handleMuteLaptopSpeakers}
              className="text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 hover:text-white transition-all active:scale-95"
            >
              Toggle Laptop Mute
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
