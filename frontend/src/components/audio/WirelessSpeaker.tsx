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
  Sun,
  Bluetooth,
  Headphones,
  ShieldCheck,
  ExternalLink,
  RefreshCw,
  Check
} from 'lucide-react';
import { sharedAudioClient } from '../../services/audioStream';
import type { LatencyPreset } from '../../services/audioStream';
import { api } from '../../services/api';

export const WirelessSpeaker: React.FC = () => {
  const [audioTab, setAudioTab] = useState<'wifi' | 'bluetooth'>('wifi');
  const [isActive, setIsActive] = useState<boolean>(sharedAudioClient.isActive());
  const [volume, setVolume] = useState<number>(sharedAudioClient.getVolume());
  const [isPhoneMuted, setIsPhoneMuted] = useState<boolean>(sharedAudioClient.isMuted());
  const [latencyPreset, setLatencyPreset] = useState<LatencyPreset>(sharedAudioClient.getLatencyPreset());
  const [streamingEngine, setStreamingEngine] = useState<'webrtc' | 'websocket'>(sharedAudioClient.getStreamingEngine());
  const [connecting, setConnecting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLaptopMuted, setIsLaptopMuted] = useState<boolean>(false);
  const [frequencies, setFrequencies] = useState<number[]>(new Array(16).fill(0));
  const [bluetoothDevices, setBluetoothDevices] = useState<{ name: string; status: string; connected: boolean }[]>([]);
  const [loadingBt, setLoadingBt] = useState<boolean>(false);
  const [outputDevices, setOutputDevices] = useState<{
    id: string;
    name: string;
    state: string;
    is_active: boolean;
    is_default: boolean;
    is_bluetooth: boolean;
  }[]>([]);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

  const animFrameRef = useRef<number | null>(null);
  const freqDataRef = useRef<Uint8Array>(new Uint8Array(32));

  // Sync state with audio client
  useEffect(() => {
    sharedAudioClient.setOnStateChange((active, err) => {
      setIsActive(active);
      setConnecting(false);
      if (err) {
        setErrorMessage(err);
      } else if (active) {
        setErrorMessage(null);
      }
    });

    const checkState = () => {
      setIsActive(sharedAudioClient.isActive());
      setVolume(sharedAudioClient.getVolume());
      setIsPhoneMuted(sharedAudioClient.isMuted());
      setStreamingEngine(sharedAudioClient.getStreamingEngine());
    };

    api.getVolumeStatus().then((status) => {
      if (status && typeof status.muted === 'boolean') {
        setIsLaptopMuted(status.muted);
      }
    });

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
    setErrorMessage(null);
    if (isActive) {
      sharedAudioClient.stop();
      setIsActive(false);
      setConnecting(false);
    } else {
      setConnecting(true);
      await sharedAudioClient.start();
      setIsActive(sharedAudioClient.isActive());
      setConnecting(false);
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

  const handleToggleEngine = async (eng: 'webrtc' | 'websocket') => {
    if (eng === streamingEngine) return;
    setErrorMessage(null);
    setStreamingEngine(eng);
    if (isActive) {
      setConnecting(true);
      await sharedAudioClient.setStreamingEngine(eng);
      setIsActive(sharedAudioClient.isActive());
      setConnecting(false);
    } else {
      sharedAudioClient.setStreamingEngine(eng);
    }
  };

  const handleMuteLaptopSpeakers = async () => {
    try {
      const res = await api.volumeMute();
      if (typeof res.muted === 'boolean') {
        setIsLaptopMuted(res.muted);
      } else {
        setIsLaptopMuted(!isLaptopMuted);
      }
    } catch (e) {
      console.error('Failed to toggle laptop volume mute', e);
    }
  };

  const fetchBluetoothDevices = async () => {
    setLoadingBt(true);
    try {
      const [btDevs, outDevs] = await Promise.all([
        api.getBluetoothAudioDevices(),
        api.getAudioOutputDevices()
      ]);
      setBluetoothDevices(btDevs);
      setOutputDevices(outDevs);
    } catch (e) {
      console.error('Failed to fetch Bluetooth or output devices', e);
    } finally {
      setLoadingBt(false);
    }
  };

  const fetchOutputDevices = async () => {
    try {
      const devs = await api.getAudioOutputDevices();
      setOutputDevices(devs);
    } catch (e) {
      console.error('Failed to fetch output devices', e);
    }
  };

  const handleSetDefaultOutput = async (deviceId: string) => {
    setSettingDefaultId(deviceId);
    try {
      const ok = await api.setDefaultAudioOutput(deviceId);
      if (ok) {
        await fetchOutputDevices();
      }
    } catch (e) {
      console.error('Failed to set default output device', e);
    } finally {
      setSettingDefaultId(null);
    }
  };

  useEffect(() => {
    if (audioTab === 'bluetooth') {
      fetchBluetoothDevices();
    }
  }, [audioTab]);

  const handleOpenBluetoothSettings = async () => {
    try {
      await api.openBluetoothSettings();
    } catch (e) {
      console.error('Failed to open Bluetooth settings', e);
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

      {/* Audio Technology Switcher Tabs */}
      <div className="flex items-center gap-2 mt-4 p-1 rounded-2xl bg-dark-950 border border-dark-800 text-xs relative z-10">
        <button
          onClick={() => setAudioTab('wifi')}
          className={`flex-1 py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
            audioTab === 'wifi'
              ? 'bg-brand-primary text-dark-950 shadow-md shadow-brand-primary/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
          <span>Phone Speaker (Wi-Fi Studio)</span>
        </button>
        <button
          onClick={() => {
            setAudioTab('bluetooth');
            fetchBluetoothDevices();
          }}
          className={`flex-1 py-2 px-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all ${
            audioTab === 'bluetooth'
              ? 'bg-blue-600 text-white shadow-md shadow-blue-500/20'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <Bluetooth className="w-3.5 h-3.5" />
          <span>Bluetooth Devices</span>
        </button>
      </div>

      {audioTab === 'wifi' ? (
        <>
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
              disabled={connecting}
              className={`w-full sm:w-auto px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 ${
                connecting
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 cursor-wait'
                  : isActive
                  ? 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-400 border border-rose-500/40 shadow-rose-500/10'
                  : 'bg-brand-primary text-dark-950 hover:bg-cyan-400 shadow-brand-primary/20'
              }`}
            >
              <Radio className={`w-3.5 h-3.5 ${connecting || isActive ? 'animate-pulse' : ''}`} />
              <span>
                {connecting
                  ? (streamingEngine === 'webrtc' ? 'Connecting WebRTC...' : 'Connecting Stream...')
                  : isActive
                  ? 'Disconnect Speaker'
                  : 'Turn ON Speaker'}
              </span>
            </button>
          </div>

          {/* Connection Error Notification */}
          {errorMessage && (
            <div className="mt-3 p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-between text-xs text-rose-300 relative z-10 animate-fadeIn">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping" />
                <span>{errorMessage}</span>
              </div>
              <button
                onClick={() => setErrorMessage(null)}
                className="text-[10px] uppercase font-bold text-rose-400 hover:text-white px-2 py-0.5 rounded-lg bg-rose-500/20"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Live Frequency Audio Visualizer */}
          {isActive && (
            <div className="mt-4 p-3.5 rounded-2xl bg-dark-950 border border-dark-800/80 relative z-10">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Sparkles className="w-3 h-3 text-brand-primary" />
                  Live Audio Output Visualizer
                </span>
                <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1">
                  <ShieldCheck className="w-3 h-3 text-emerald-400" />
                  {streamingEngine === 'webrtc' ? 'WebRTC + Opus (UDP) • NetEQ Active' : '48,000 Hz Lossless PCM • Studio Limiter Active'}
                </span>
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
              <div>
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

              {/* Streaming Protocol Engine Selector */}
              <div className="flex items-center justify-between pt-2 mt-2 border-t border-dark-800/60">
                <span className="text-[10px] text-slate-400 font-medium">Protocol</span>
                <div className="flex items-center bg-dark-900 p-0.5 rounded-lg border border-dark-800 text-[10px]">
                  <button
                    onClick={() => handleToggleEngine('webrtc')}
                    className={`px-2 py-0.5 rounded-md font-bold transition-all ${
                      streamingEngine === 'webrtc'
                        ? 'bg-emerald-500 text-dark-950 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                    title="WebRTC + Opus over UDP: zero-zigzag, resilient to packet loss"
                  >
                    WebRTC (Opus)
                  </button>
                  <button
                    onClick={() => handleToggleEngine('websocket')}
                    className={`px-2 py-0.5 rounded-md font-bold transition-all ${
                      streamingEngine === 'websocket'
                        ? 'bg-brand-primary text-dark-950 shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                    title="WebSocket: uncompressed 48kHz lossless studio PCM"
                  >
                    WebSocket (PCM)
                  </button>
                </div>
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
                <div className="flex items-center gap-1.5">
                  <Laptop className={`w-3.5 h-3.5 ${isLaptopMuted ? 'text-rose-400' : 'text-slate-400'}`} />
                  <span className="text-[11px] text-slate-300 font-medium">Laptop Speakers</span>
                  <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md ${isLaptopMuted ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'}`}>
                    {isLaptopMuted ? 'MUTED' : 'ACTIVE'}
                  </span>
                </div>
                <button
                  onClick={handleMuteLaptopSpeakers}
                  className={`text-[10px] font-bold px-2.5 py-1 rounded-lg border transition-all active:scale-95 flex items-center gap-1.5 ${
                    isLaptopMuted
                      ? 'bg-rose-500/20 border-rose-500/40 text-rose-300 hover:bg-rose-500/30'
                      : 'bg-dark-900 hover:bg-dark-800 border-dark-700 text-slate-300 hover:text-white'
                  }`}
                  title={isLaptopMuted ? 'Click to unmute physical laptop speakers' : 'Mute physical laptop speakers so audio only plays through your phone'}
                >
                  {isLaptopMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5 text-slate-400" />}
                  <span>{isLaptopMuted ? 'Unmute Laptop' : 'Mute Laptop'}</span>
                </button>
              </div>
            </div>
          </div>
        </>
      ) : (
        /* Bluetooth Devices View */
        <div className="mt-4 space-y-3 relative z-10 animate-fadeIn">
          {/* Bluetooth Action Bar */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 p-4 rounded-2xl bg-dark-950 border border-blue-500/20">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/30">
                <Bluetooth className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-xs font-bold text-white">Direct Bluetooth Audio</h4>
                <p className="text-[11px] text-slate-400">Connect laptop directly to Bluetooth speakers, earbuds, or phones</p>
              </div>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={fetchBluetoothDevices}
                disabled={loadingBt}
                className="px-3 py-2 rounded-xl bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 hover:text-white text-xs font-medium flex items-center gap-1.5 transition-all"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingBt ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
              <button
                onClick={handleOpenBluetoothSettings}
                className="flex-1 sm:flex-none px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all shadow-lg shadow-blue-500/20"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open PC Bluetooth</span>
              </button>
            </div>
          </div>

          {/* Windows Audio Playback Routing (Set Default Device) */}
          <div className="p-4 rounded-2xl bg-dark-950 border border-dark-800">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-[11px] font-bold text-slate-200 flex items-center gap-1.5">
                  <Volume2 className="w-3.5 h-3.5 text-brand-primary" />
                  Laptop Audio Output Routing
                </span>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  Select which connected speaker, headphones, or Bluetooth audio device the laptop outputs to
                </p>
              </div>
              <span className="text-[10px] font-mono text-slate-500">{outputDevices.length} endpoints</span>
            </div>

            {outputDevices.length > 0 ? (
              <div className="space-y-2">
                {outputDevices.map((dev) => (
                  <div
                    key={dev.id}
                    className={`p-3 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                      dev.is_default
                        ? 'bg-emerald-500/10 border-emerald-500/40 shadow-sm shadow-emerald-500/10'
                        : 'bg-dark-900/80 border-dark-800 hover:border-dark-700'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className={`p-2 rounded-lg border shrink-0 ${
                        dev.is_default
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : dev.is_bluetooth
                          ? 'bg-blue-500/10 text-blue-400 border-blue-500/20'
                          : 'bg-dark-950 text-slate-400 border-dark-800'
                      }`}>
                        {dev.is_bluetooth ? <Headphones className="w-4 h-4" /> : <Laptop className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-white truncate">{dev.name}</span>
                          {dev.is_default && (
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shrink-0">
                              DEFAULT
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-400 block font-mono truncate">
                          {dev.is_active ? 'Active / Connected' : dev.state}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0">
                      {dev.is_default ? (
                        <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-400 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                          <Check className="w-3.5 h-3.5" />
                          <span>Active Output</span>
                        </div>
                      ) : (
                        <button
                          onClick={() => handleSetDefaultOutput(dev.id)}
                          disabled={settingDefaultId === dev.id}
                          className="px-3 py-1 rounded-lg text-xs font-bold border transition-all active:scale-95 bg-dark-950 hover:bg-brand-primary hover:text-dark-950 border-dark-700 text-slate-300 hover:border-brand-primary flex items-center gap-1.5"
                        >
                          {settingDefaultId === dev.id ? (
                            <>
                              <RefreshCw className="w-3 h-3 animate-spin" />
                              <span>Switching...</span>
                            </>
                          ) : (
                            <span>Set as Output</span>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-slate-400">
                <span>Click Refresh to scan Windows audio outputs.</span>
              </div>
            )}
          </div>

          {/* Paired Bluetooth Audio Devices List */}
          <div className="p-4 rounded-2xl bg-dark-950 border border-dark-800">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-slate-300 flex items-center gap-1.5">
                <Headphones className="w-3.5 h-3.5 text-blue-400" />
                Paired Audio Devices & Speakers on Laptop
              </span>
              <span className="text-[10px] font-mono text-slate-500">{bluetoothDevices.length} devices detected</span>
            </div>

            {loadingBt ? (
              <div className="py-6 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-brand-primary" />
                <span>Scanning Bluetooth audio devices...</span>
              </div>
            ) : bluetoothDevices.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {bluetoothDevices.map((dev, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl bg-dark-900/80 border border-dark-800 hover:border-dark-700 flex items-center justify-between transition-all"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="p-2 rounded-lg bg-dark-950 text-blue-400 border border-dark-800">
                        <Headphones className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-semibold text-white block truncate">{dev.name}</span>
                        <span className="text-[10px] text-slate-400 block font-mono">
                          {dev.connected ? 'Connected / Active' : 'Paired'}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider ${
                        dev.connected
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                          : 'bg-dark-950 text-slate-400 border border-dark-800'
                      }`}
                    >
                      {dev.connected ? 'Active' : 'Paired'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center">
                <p className="text-xs text-slate-400">No Bluetooth audio devices detected yet.</p>
                <button
                  onClick={handleOpenBluetoothSettings}
                  className="mt-2 text-xs font-bold text-blue-400 hover:underline inline-flex items-center gap-1"
                >
                  Pair a Bluetooth device in Windows Settings <ExternalLink className="w-3 h-3" />
                </button>
              </div>
            )}
          </div>

          {/* Sound Quality Comparison Card */}
          <div className="p-3.5 rounded-2xl bg-dark-950/60 border border-dark-800/80 text-xs text-slate-400 space-y-2">
            <div className="flex items-center gap-1.5 text-slate-300 font-semibold text-[11px]">
              <ShieldCheck className="w-3.5 h-3.5 text-brand-primary" />
              <span>Which gives the best sound output?</span>
            </div>
            <p className="text-[11px] leading-relaxed">
              <strong className="text-white">Phone Wi-Fi Mode (Lossless HD)</strong>: Delivers full bit-perfect <strong className="text-brand-primary">48,000 Hz 16-bit Studio PCM</strong> (1,536 kbps) with zero audio compression and real-time ~50ms ultra-low latency. Use this to turn your phone into a high-fidelity wireless speaker.
            </p>
            <p className="text-[11px] leading-relaxed">
              <strong className="text-white">Bluetooth Mode</strong>: Direct hardware connection from Windows to external Bluetooth speakers or earbuds (`Xiaomi Sound`, `Boult Audio`, `AirBass`).
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
