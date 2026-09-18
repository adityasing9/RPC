import React, { useState, useEffect, useRef } from 'react';
import { Camera, RefreshCw, Maximize2, X, Download, Play, Pause, Radio, MousePointer, Monitor, ExternalLink } from 'lucide-react';
import { api } from '../../services/api';
import { useApp } from '../../context/AppContext';

interface ClickRipple {
  id: number;
  x: number;
  y: number;
  button: 'left' | 'right';
}

export const ScreenshotViewer: React.FC = () => {
  const { setActiveTab } = useApp();
  // Mode: 'live' or 'snapshot'
  const [mode, setMode] = useState<'live' | 'snapshot'>('live');
  
  // Live Stream State
  const [isLiveActive, setIsLiveActive] = useState<boolean>(true);
  const [fps, setFps] = useState<number>(10);
  const [quality, setQuality] = useState<number>(50);
  const [streamKey, setStreamKey] = useState<number>(Date.now());
  const [streamError, setStreamError] = useState<boolean>(false);
  const [screenInfo, setScreenInfo] = useState<{ width: number; height: number } | null>(null);

  // Snapshot State
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(false);

  // View & Interaction State
  const [fullScreen, setFullScreen] = useState<boolean>(false);
  const [touchControlEnabled, setTouchControlEnabled] = useState<boolean>(true);
  const [rightClickNext, setRightClickNext] = useState<boolean>(false);
  const [ripples, setRipples] = useState<ClickRipple[]>([]);
  const imageRef = useRef<HTMLImageElement>(null);
  const fullscreenImageRef = useRef<HTMLImageElement>(null);

  // Load screen metrics on mount
  useEffect(() => {
    api.getScreenInfo()
      .then((info) => {
        if (info?.width && info?.height) {
          setScreenInfo({ width: info.width, height: info.height });
        }
      })
      .catch(() => {});
  }, []);

  // Compute live stream URL
  const streamUrl = api.getScreenStreamUrl(fps, quality, 1024) + `&_k=${streamKey}`;

  const toggleLive = () => {
    if (!isLiveActive) {
      setStreamError(false);
      setStreamKey(Date.now());
      setIsLiveActive(true);
    } else {
      setIsLiveActive(false);
    }
  };

  const captureSnapshot = async () => {
    setSnapshotLoading(true);
    try {
      const url = await api.fetchScreenshotBlob();
      setSnapshotUrl(url);
    } catch (e) {
      console.error('Snapshot error', e);
    } finally {
      setSnapshotLoading(false);
    }
  };

  // Handle touch / click interaction on the screen preview
  const handleScreenInteraction = async (
    e: React.MouseEvent<HTMLImageElement> | React.TouchEvent<HTMLImageElement>,
    targetRef: React.RefObject<HTMLImageElement | null>
  ) => {
    if (!touchControlEnabled) return;

    const img = targetRef.current;
    if (!img) return;

    const rect = img.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ('touches' in e) {
      if (e.touches.length === 0) return;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;

    if (offsetX < 0 || offsetX > rect.width || offsetY < 0 || offsetY > rect.height) return;

    const xPercent = Math.max(0.0, Math.min(1.0, offsetX / rect.width));
    const yPercent = Math.max(0.0, Math.min(1.0, offsetY / rect.height));

    const buttonToUse = rightClickNext ? 'right' : 'left';

    // Show visual ripple
    const rippleId = Date.now();
    setRipples((prev) => [...prev.slice(-4), { id: rippleId, x: offsetX, y: offsetY, button: buttonToUse }]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== rippleId));
    }, 600);

    // Reset right click after use
    if (rightClickNext) setRightClickNext(false);

    try {
      await api.clickOnScreen(xPercent, yPercent, buttonToUse);
    } catch (err) {
      console.error('Click error', err);
    }
  };

  return (
    <div className="rounded-3xl bg-dark-900 border border-dark-800 p-5 shadow-xl transition-all">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Monitor className="w-4 h-4 text-brand-primary" />
              Windows Desktop Screen
            </h3>
            {mode === 'live' && isLiveActive && !streamError && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-bold text-emerald-400 animate-pulse">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                LIVE
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {screenInfo ? `${screenInfo.width}×${screenInfo.height} Display` : 'Real-time interactive desktop monitor'}
          </p>
        </div>

        {/* Mode Switcher Pills & Link */}
        <div className="flex flex-wrap items-center gap-1.5 self-start sm:self-auto">
          <button
            onClick={() => setActiveTab('input')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-brand-primary/15 hover:bg-brand-primary/25 border border-brand-primary/40 text-brand-primary transition-all"
            title="Open Live Screen and Touch Controls together in the same window"
          >
            <Monitor className="w-3.5 h-3.5" />
            <span>Screen + Touchpad</span>
            <ExternalLink className="w-3 h-3 opacity-70" />
          </button>

          <div className="flex items-center gap-1 bg-dark-950/80 p-1 rounded-2xl border border-dark-800">
            <button
              onClick={() => setMode('live')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                mode === 'live'
                  ? 'bg-brand-primary text-dark-950 shadow-md shadow-brand-primary/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Radio className="w-3.5 h-3.5" />
              Live Stream
            </button>
            <button
              onClick={() => setMode('snapshot')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                mode === 'snapshot'
                  ? 'bg-brand-primary text-dark-950 shadow-md shadow-brand-primary/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Camera className="w-3.5 h-3.5" />
              Snapshot
            </button>
          </div>
        </div>
      </div>

      {/* Screen Display Area */}
      <div className="relative rounded-2xl overflow-hidden bg-black/80 border border-dark-800 aspect-video flex items-center justify-center select-none">
        {mode === 'live' ? (
          isLiveActive && !streamError ? (
            <div className="relative w-full h-full flex items-center justify-center">
              <img
                ref={imageRef}
                src={streamUrl}
                alt="Live Windows Desktop"
                className={`w-full h-full object-contain ${touchControlEnabled ? 'cursor-crosshair' : 'cursor-default'}`}
                onError={() => setStreamError(true)}
                onClick={(e) => handleScreenInteraction(e, imageRef)}
              />

              {/* Click Ripple Animations */}
              {ripples.map((r) => (
                <span
                  key={r.id}
                  className={`absolute pointer-events-none rounded-full animate-ping -translate-x-1/2 -translate-y-1/2 ${
                    r.button === 'right' ? 'w-7 h-7 bg-amber-400/80' : 'w-6 h-6 bg-brand-primary/80'
                  }`}
                  style={{ left: r.x, top: r.y }}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center p-6 text-center">
              <Pause className="w-8 h-8 text-slate-600 mb-2" />
              <p className="text-xs text-slate-400 font-medium">
                {streamError ? 'Stream temporarily disconnected' : 'Live stream paused'}
              </p>
              <button
                onClick={toggleLive}
                className="mt-3 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-primary text-dark-950 text-xs font-bold shadow-md hover:bg-cyan-400 active:scale-95 transition-all"
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                Resume Live Stream
              </button>
            </div>
          )
        ) : snapshotUrl ? (
          <img
            src={snapshotUrl}
            alt="Windows Desktop Snapshot"
            className="w-full h-full object-contain cursor-pointer"
            onClick={() => setFullScreen(true)}
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center">
            <Camera className="w-8 h-8 text-slate-600 mb-2" />
            <p className="text-xs text-slate-400 font-medium">No snapshot taken</p>
            <button
              onClick={captureSnapshot}
              disabled={snapshotLoading}
              className="mt-3 flex items-center gap-1.5 px-4 py-2 rounded-xl bg-brand-primary text-dark-950 text-xs font-bold shadow-md hover:bg-cyan-400 active:scale-95 transition-all disabled:opacity-50"
            >
              {snapshotLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
              Take Snapshot
            </button>
          </div>
        )}

        {/* Overlay Action Buttons */}
        <div className="absolute top-2 right-2 flex items-center gap-1.5 z-10">
          <button
            onClick={() => setFullScreen(true)}
            className="p-2 rounded-xl bg-dark-950/80 hover:bg-dark-900 text-white backdrop-blur-md shadow-lg transition-all"
            title="Full Screen Remote View"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          {snapshotUrl && (
            <a
              href={snapshotUrl}
              download={`rcpc-desktop-${Date.now()}.jpg`}
              className="p-2 rounded-xl bg-dark-950/80 hover:bg-dark-900 text-white backdrop-blur-md shadow-lg transition-all"
              title="Download Snapshot"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* Control Bar Below Preview */}
      <div className="mt-4 pt-3 border-t border-dark-800/80 flex flex-wrap items-center justify-between gap-3">
        {mode === 'live' ? (
          <>
            {/* Stream Play/Pause and FPS */}
            <div className="flex items-center gap-2">
              <button
                onClick={toggleLive}
                className={`p-2.5 rounded-xl border text-xs font-bold transition-all flex items-center gap-1.5 ${
                  isLiveActive && !streamError
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20'
                    : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20'
                }`}
              >
                {isLiveActive && !streamError ? (
                  <>
                    <Pause className="w-3.5 h-3.5" /> Pause
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" /> Play
                  </>
                )}
              </button>

              {/* FPS Selector */}
              <div className="flex items-center bg-dark-950 p-1 rounded-xl border border-dark-800 text-[11px]">
                {[5, 10, 15, 20].map((f) => (
                  <button
                    key={f}
                    onClick={() => {
                      setFps(f);
                      setStreamKey(Date.now());
                    }}
                    className={`px-2 py-1 rounded-lg font-semibold transition-all ${
                      fps === f ? 'bg-brand-primary text-dark-950' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {f} FPS
                  </button>
                ))}
              </div>

              {/* Quality Selector */}
              <div className="flex items-center bg-dark-950 p-1 rounded-xl border border-dark-800 text-[11px]">
                <button
                  onClick={() => {
                    setQuality(40);
                    setStreamKey(Date.now());
                  }}
                  className={`px-2 py-1 rounded-lg font-semibold transition-all ${
                    quality <= 45 ? 'bg-brand-primary text-dark-950' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Eco
                </button>
                <button
                  onClick={() => {
                    setQuality(65);
                    setStreamKey(Date.now());
                  }}
                  className={`px-2 py-1 rounded-lg font-semibold transition-all ${
                    quality > 45 ? 'bg-brand-primary text-dark-950' : 'text-slate-400 hover:text-white'
                  }`}
                >
                  HD
                </button>
              </div>
            </div>

            {/* Tap-to-Click Controls */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTouchControlEnabled(!touchControlEnabled)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                  touchControlEnabled
                    ? 'bg-brand-primary/10 border-brand-primary/40 text-brand-primary'
                    : 'bg-dark-950 border-dark-800 text-slate-500'
                }`}
                title="Tap directly on screen to move cursor & click"
              >
                <MousePointer className="w-3.5 h-3.5" />
                <span>{touchControlEnabled ? 'Touch: ON' : 'Touch: OFF'}</span>
              </button>

              {touchControlEnabled && (
                <button
                  onClick={() => setRightClickNext(!rightClickNext)}
                  className={`px-3 py-2 rounded-xl text-xs font-semibold border transition-all ${
                    rightClickNext
                      ? 'bg-amber-500 text-dark-950 border-amber-500 shadow-md shadow-amber-500/20'
                      : 'bg-dark-950 border-dark-800 text-slate-400 hover:text-white'
                  }`}
                  title="Next tap acts as Right Click"
                >
                  Right Click
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-between w-full">
            <p className="text-xs text-slate-400">Single frame desktop snapshot</p>
            <button
              onClick={captureSnapshot}
              disabled={snapshotLoading}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-brand-primary text-dark-950 text-xs font-bold hover:bg-cyan-400 active:scale-95 transition-all shadow-md disabled:opacity-50"
            >
              {snapshotLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />}
              Capture Screen
            </button>
          </div>
        )}
      </div>

      {/* Fullscreen Remote Desktop Overlay */}
      {fullScreen && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col p-2 sm:p-4 animate-fadeIn">
          {/* Floating Fullscreen Header */}
          <div className="flex justify-between items-center pb-2 px-2 bg-dark-950/80 backdrop-blur-md rounded-2xl border border-dark-800 mb-2 py-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-300 font-bold flex items-center gap-1.5">
                <Monitor className="w-4 h-4 text-brand-primary" />
                Remote Desktop
              </span>
              {mode === 'live' && isLiveActive && (
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[10px] font-bold">
                  {fps} FPS
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {mode === 'live' && touchControlEnabled && (
                <button
                  onClick={() => setRightClickNext(!rightClickNext)}
                  className={`px-3 py-1 rounded-xl text-xs font-semibold border ${
                    rightClickNext
                      ? 'bg-amber-500 text-dark-950 border-amber-500'
                      : 'bg-dark-900 border-dark-800 text-slate-300'
                  }`}
                >
                  Right Click
                </button>
              )}
              <button
                onClick={() => setFullScreen(false)}
                className="p-2 text-slate-400 hover:text-white rounded-xl bg-dark-900 border border-dark-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Fullscreen Image Canvas */}
          <div className="flex-1 relative flex items-center justify-center overflow-hidden bg-black rounded-2xl border border-dark-900">
            {mode === 'live' && isLiveActive && !streamError ? (
              <div className="relative w-full h-full flex items-center justify-center">
                <img
                  ref={fullscreenImageRef}
                  src={streamUrl}
                  alt="Live Desktop Fullscreen"
                  className={`max-w-full max-h-full object-contain ${
                    touchControlEnabled ? 'cursor-crosshair' : 'cursor-default'
                  }`}
                  onClick={(e) => handleScreenInteraction(e, fullscreenImageRef)}
                />
                {ripples.map((r) => (
                  <span
                    key={r.id}
                    className={`absolute pointer-events-none rounded-full animate-ping -translate-x-1/2 -translate-y-1/2 ${
                      r.button === 'right' ? 'w-8 h-8 bg-amber-400/80' : 'w-6 h-6 bg-brand-primary/80'
                    }`}
                    style={{ left: r.x, top: r.y }}
                  />
                ))}
              </div>
            ) : snapshotUrl ? (
              <img src={snapshotUrl} alt="Desktop Snapshot Fullscreen" className="max-w-full max-h-full object-contain" />
            ) : (
              <p className="text-sm text-slate-500">No screen display available</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
