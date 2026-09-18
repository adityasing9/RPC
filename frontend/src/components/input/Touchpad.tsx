import React, { useState, useEffect, useRef } from 'react';
import {
  MousePointer,
  Keyboard,
  CornerDownLeft,
  Delete,
  Space,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  Play,
  Pause,
  Maximize2,
  Minimize2,
  RefreshCw,
  Monitor,
  Radio,
  Layers,
  Touchpad as TouchpadIcon
} from 'lucide-react';
import { api } from '../../services/api';
import { wsService } from '../../services/websocket';

interface ClickRipple {
  id: number;
  x: number;
  y: number;
  button: 'left' | 'right' | 'double_click';
}

export const Touchpad: React.FC = () => {
  // Input Status & Modes
  const [isActive, setIsActive] = useState<boolean>(true);
  const [sensitivity, setSensitivity] = useState<number>(1.2);
  const [viewMode, setViewMode] = useState<'split' | 'direct'>('split'); // 'split' = screen + trackpad; 'direct' = large touch screen
  const [clickAction, setClickAction] = useState<'left' | 'right' | 'double_click'>('left');

  // Keyboard Drawer
  const [showKeyboard, setShowKeyboard] = useState<boolean>(false);
  const [keyboardText, setKeyboardText] = useState<string>('');

  // Live Screen Stream State
  const [isLiveActive, setIsLiveActive] = useState<boolean>(true);
  const [fps, setFps] = useState<number>(5);
  const [quality, setQuality] = useState<number>(60);
  const [streamKey, setStreamKey] = useState<number>(Date.now());
  const [streamError, setStreamError] = useState<boolean>(false);
  const [screenInfo, setScreenInfo] = useState<{ width: number; height: number } | null>(null);

  // Fullscreen Remote Desktop
  const [fullScreen, setFullScreen] = useState<boolean>(false);
  const [ripples, setRipples] = useState<ClickRipple[]>([]);

  // Refs
  const touchAreaRef = useRef<HTMLDivElement>(null);
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  const scrollLastY = useRef<number | null>(null);
  const screenImgRef = useRef<HTMLImageElement>(null);
  const fullscreenImgRef = useRef<HTMLImageElement>(null);

  // Fetch screen resolution on mount
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
  const streamUrl = api.getScreenStreamUrl(fps, quality, 1280) + `&_k=${streamKey}`;

  const toggleLive = () => {
    if (!isLiveActive) {
      setStreamError(false);
      setStreamKey(Date.now());
      setIsLiveActive(true);
    } else {
      setIsLiveActive(false);
    }
  };

  // Direct Touch on Live Screen (Tap-to-Click on PC Coordinate)
  const handleScreenTouch = async (
    e: React.MouseEvent<HTMLImageElement> | React.TouchEvent<HTMLImageElement>,
    targetRef: React.RefObject<HTMLImageElement | null>
  ) => {
    if (!isActive) return;
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

    const currentButton = clickAction;

    // Show ripple animation
    const rippleId = Date.now();
    setRipples((prev) => [...prev.slice(-4), { id: rippleId, x: offsetX, y: offsetY, button: currentButton }]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== rippleId));
    }, 600);

    // If a one-off right click or double click was selected, reset to left click
    if (clickAction !== 'left') {
      setClickAction('left');
    }

    // Send click via WebSocket (ultra-fast) with HTTP fallback
    try {
      wsService.sendInput({
        type: 'input.mouse.click_percent',
        x_percent: xPercent,
        y_percent: yPercent,
        button: currentButton === 'right' ? 'right' : 'left',
        action: currentButton === 'double_click' ? 'double_click' : 'click'
      });
    } catch {
      try {
        await api.clickOnScreen(
          xPercent,
          yPercent,
          currentButton === 'right' ? 'right' : 'left',
          currentButton === 'double_click' ? 'double_click' : 'click'
        );
      } catch (err) {
        console.error('Click error:', err);
      }
    }
  };

  // Laptop Trackpad: Relative cursor movement
  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isActive || e.touches.length === 0) return;
    const touch = e.touches[0];
    lastTouchRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isActive || e.touches.length === 0 || !lastTouchRef.current) return;
    e.preventDefault();

    const touch = e.touches[0];
    const dx = touch.clientX - lastTouchRef.current.x;
    const dy = touch.clientY - lastTouchRef.current.y;

    lastTouchRef.current = { x: touch.clientX, y: touch.clientY };

    if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
      wsService.sendInput({
        type: 'input.mouse.move',
        dx,
        dy,
        sensitivity
      });
    }
  };

  const handleTouchEnd = () => {
    lastTouchRef.current = null;
  };

  // Vertical Scroll Wheel Strip
  const handleScrollTouchMove = (e: React.TouchEvent) => {
    if (!isActive || e.touches.length === 0) return;
    e.preventDefault();
    const currentY = e.touches[0].clientY;
    if (scrollLastY.current !== null) {
      const delta = scrollLastY.current - currentY;
      if (Math.abs(delta) > 6) {
        const direction = delta > 0 ? -1 : 1;
        wsService.sendInput({
          type: 'input.mouse.scroll',
          delta: direction
        });
        scrollLastY.current = currentY;
      }
    } else {
      scrollLastY.current = currentY;
    }
  };

  const handleScrollTouchEnd = () => {
    scrollLastY.current = null;
  };

  // Physical Mouse Buttons
  const handleMouseClick = (button: 'left' | 'right', action: 'click' | 'double_click' = 'click') => {
    if (!isActive) return;
    wsService.sendInput({
      type: 'input.mouse.click',
      button,
      action
    });
  };

  // Keyboard Text & Shortcuts
  const handleSendText = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyboardText) return;
    wsService.sendInput({
      type: 'input.keyboard.text',
      text: keyboardText
    });
    setKeyboardText('');
  };

  const handleSendKey = (key: string) => {
    wsService.sendInput({
      type: 'input.keyboard.key',
      key
    });
  };

  return (
    <div className="flex flex-col rounded-3xl bg-dark-900 border border-dark-800 p-3 sm:p-4 select-none shadow-2xl space-y-3">
      {/* 1. Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-dark-800/80">
        {/* Title & Live Status */}
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5 bg-dark-950 px-2.5 py-1 rounded-xl border border-dark-800">
            {isLiveActive ? (
              <span className="flex h-2.5 w-2.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
              </span>
            ) : (
              <span className="h-2.5 w-2.5 rounded-full bg-slate-600"></span>
            )}
            <span className="text-[11px] font-mono font-bold uppercase tracking-wider text-slate-200">
              {isLiveActive ? 'LIVE' : 'PAUSED'}
            </span>
          </div>

          {screenInfo && (
            <span className="hidden sm:inline text-[10px] font-mono text-slate-400 bg-dark-950 px-2 py-1 rounded-lg border border-dark-800">
              {screenInfo.width}×{screenInfo.height}
            </span>
          )}

          {/* View Mode Toggle: Split vs Direct */}
          <div className="flex items-center bg-dark-950 p-0.5 rounded-xl border border-dark-800 text-[11px] font-medium">
            <button
              onClick={() => setViewMode('split')}
              className={`px-2 py-1 rounded-lg flex items-center gap-1 transition-all ${
                viewMode === 'split'
                  ? 'bg-brand-primary text-dark-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">Split</span>
            </button>
            <button
              onClick={() => setViewMode('direct')}
              className={`px-2 py-1 rounded-lg flex items-center gap-1 transition-all ${
                viewMode === 'direct'
                  ? 'bg-brand-primary text-dark-950 font-bold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Monitor className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">Direct Touch</span>
            </button>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 ml-auto">
          {/* Quality Mode */}
          <div className="flex items-center bg-dark-950 rounded-xl p-0.5 border border-dark-800 text-[10px] font-mono">
            <button
              onClick={() => {
                setQuality(45);
                setStreamKey(Date.now());
              }}
              className={`px-1.5 py-0.5 rounded-lg transition-all ${
                quality <= 50 ? 'bg-brand-primary/20 text-brand-primary font-bold' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              Eco
            </button>
            <button
              onClick={() => {
                setQuality(70);
                setStreamKey(Date.now());
              }}
              className={`px-1.5 py-0.5 rounded-lg transition-all ${
                quality > 50 ? 'bg-brand-primary/20 text-brand-primary font-bold' : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              HD
            </button>
          </div>

          {/* FPS Selector */}
          <div className="flex items-center bg-dark-950 rounded-xl p-0.5 border border-dark-800 text-[10px] font-mono">
            {[2, 5, 10, 15].map((f) => (
              <button
                key={f}
                onClick={() => setFps(f)}
                className={`px-1.5 py-0.5 rounded-lg transition-all ${
                  fps === f ? 'bg-brand-primary/20 text-brand-primary font-bold' : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {f}f
              </button>
            ))}
          </div>

          {/* Input Enable / Pause */}
          <button
            onClick={() => setIsActive(!isActive)}
            title={isActive ? 'Pause touch input' : 'Enable touch input'}
            className={`px-2 py-1 rounded-xl text-[10px] font-bold border transition-all ${
              isActive
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                : 'bg-red-500/10 text-red-400 border-red-500/30'
            }`}
          >
            {isActive ? 'Active' : 'Off'}
          </button>

          {/* Stream Play/Pause */}
          <button
            onClick={toggleLive}
            title={isLiveActive ? 'Pause stream' : 'Resume stream'}
            className={`p-1.5 rounded-xl border transition-all ${
              isLiveActive
                ? 'bg-dark-950 border-dark-700 text-slate-300 hover:text-white'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            }`}
          >
            {isLiveActive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>

          {/* Fullscreen Button */}
          <button
            onClick={() => setFullScreen(true)}
            title="Fullscreen Remote Desktop"
            className="p-1.5 rounded-xl bg-dark-950 border border-dark-700 text-slate-300 hover:text-brand-primary hover:border-brand-primary/40 transition-all"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>

          {/* Keyboard Toggle */}
          <button
            onClick={() => setShowKeyboard(!showKeyboard)}
            className={`p-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1 transition-all ${
              showKeyboard
                ? 'bg-brand-primary text-dark-950 border-brand-primary font-bold'
                : 'bg-dark-950 hover:bg-dark-800 border-dark-700 text-slate-300'
            }`}
          >
            <Keyboard className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 2. Unified Screen Viewport */}
      <div
        className={`relative w-full rounded-2xl overflow-hidden bg-black border border-dark-800 flex items-center justify-center transition-all ${
          viewMode === 'split' ? 'aspect-video max-h-[260px] sm:max-h-[340px]' : 'aspect-video min-h-[300px] sm:min-h-[420px]'
        }`}
      >
        {isLiveActive && !streamError ? (
          <div className="relative w-full h-full flex items-center justify-center cursor-pointer select-none">
            <img
              ref={screenImgRef}
              src={streamUrl}
              alt="Live Screen"
              onClick={(e) => handleScreenTouch(e, screenImgRef)}
              onError={() => setStreamError(true)}
              className="max-w-full max-h-full w-auto h-auto object-contain pointer-events-auto"
            />

            {/* Tap Click Ripple Animations */}
            {ripples.map((ripple) => (
              <span
                key={ripple.id}
                style={{ left: ripple.x, top: ripple.y }}
                className={`absolute w-8 h-8 -ml-4 -mt-4 rounded-full pointer-events-none animate-ping ${
                  ripple.button === 'right' ? 'bg-amber-400/80 border-2 border-amber-300' : 'bg-cyan-400/80 border-2 border-cyan-300'
                }`}
              />
            ))}

            {/* Direct Touch Screen Hint */}
            <div className="absolute top-2 left-2 pointer-events-none bg-dark-950/80 backdrop-blur-md px-2 py-0.5 rounded-lg border border-white/10 text-[10px] text-slate-300 flex items-center gap-1">
              <MousePointer className="w-2.5 h-2.5 text-brand-primary" />
              <span>Tap screen to click</span>
            </div>
          </div>
        ) : streamError ? (
          <div className="flex flex-col items-center justify-center p-6 text-center">
            <Radio className="w-10 h-10 text-red-400 mb-2 opacity-80" />
            <p className="text-xs text-red-300 font-semibold mb-2">Live stream connection interrupted</p>
            <button
              onClick={() => {
                setStreamError(false);
                setStreamKey(Date.now());
                setIsLiveActive(true);
              }}
              className="px-3 py-1.5 rounded-xl bg-dark-800 hover:bg-dark-700 border border-dark-700 text-xs font-medium text-slate-200 flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Reconnect
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center p-6 text-center text-slate-500">
            <Monitor className="w-10 h-10 mb-2 opacity-50" />
            <p className="text-xs font-mono">Stream is paused</p>
            <button
              onClick={toggleLive}
              className="mt-2 px-3 py-1 bg-brand-primary text-dark-950 rounded-xl text-xs font-bold"
            >
              Resume Live Screen
            </button>
          </div>
        )}
      </div>

      {/* 3. Direct Touch Action Selector (Left / Right / Double Click for next tap) */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1 text-[11px] font-mono text-slate-400">
          <span className="hidden sm:inline">Tap action:</span>
          <div className="flex items-center bg-dark-950 rounded-xl p-0.5 border border-dark-800">
            <button
              onClick={() => setClickAction('left')}
              className={`px-2 py-1 rounded-lg font-bold text-xs transition-all ${
                clickAction === 'left' ? 'bg-brand-primary text-dark-950 shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Left Click
            </button>
            <button
              onClick={() => setClickAction('right')}
              className={`px-2 py-1 rounded-lg font-bold text-xs transition-all ${
                clickAction === 'right' ? 'bg-amber-400 text-dark-950 shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Right Click
            </button>
            <button
              onClick={() => setClickAction('double_click')}
              className={`px-2 py-1 rounded-lg font-bold text-xs transition-all ${
                clickAction === 'double_click' ? 'bg-purple-400 text-dark-950 shadow-sm' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              2× Click
            </button>
          </div>
        </div>

        {/* Speed / Sensitivity Slider */}
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span className="text-[10px]">Speed:</span>
          <input
            type="range"
            min="0.5"
            max="3.0"
            step="0.1"
            value={sensitivity}
            onChange={(e) => setSensitivity(parseFloat(e.target.value))}
            className="w-16 sm:w-24 h-1 bg-dark-800 rounded-lg appearance-none cursor-pointer accent-brand-primary"
          />
          <span className="font-mono text-slate-300 text-[10px] w-6">{sensitivity.toFixed(1)}x</span>
        </div>
      </div>

      {/* 4. Touchpad Surface & Scroll Wheel (Visible in Split Mode) */}
      {viewMode === 'split' && (
        <div className="flex gap-2 min-h-[160px] sm:min-h-[220px]">
          {/* Main Laptop Trackpad Surface */}
          <div
            ref={touchAreaRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            className="flex-1 rounded-2xl bg-dark-950 border border-dark-800/90 flex flex-col items-center justify-center relative overflow-hidden cursor-crosshair touchpad-surface shadow-inner"
          >
            <div className="pointer-events-none flex flex-col items-center justify-center opacity-30">
              <TouchpadIcon className="w-8 h-8 text-slate-400 mb-1" />
              <span className="text-[11px] font-mono text-slate-400 uppercase tracking-widest font-semibold">
                Trackpad Surface
              </span>
              <span className="text-[10px] text-slate-500">
                Slide finger to move mouse on live screen
              </span>
            </div>

            <div className="absolute inset-0 bg-[radial-gradient(#334155_1px,transparent_1px)] [background-size:20px_20px] opacity-25 pointer-events-none" />
          </div>

          {/* Vertical Scroll Bar Strip */}
          <div
            onTouchMove={handleScrollTouchMove}
            onTouchEnd={handleScrollTouchEnd}
            className="w-11 sm:w-14 rounded-2xl bg-dark-950 border border-dark-800/90 flex flex-col items-center justify-center relative select-none touchpad-surface cursor-ns-resize shadow-inner active:bg-dark-800"
          >
            <div className="rotate-90 text-[10px] uppercase font-mono tracking-widest text-slate-500 pointer-events-none font-bold">
              Scroll
            </div>
          </div>
        </div>
      )}

      {/* 5. Left, Right & Double Click Physical Buttons */}
      <div className="grid grid-cols-3 gap-2 h-14 shrink-0">
        <button
          onClick={() => handleMouseClick('left')}
          className="rounded-2xl bg-dark-950 hover:bg-dark-800 active:bg-dark-700 active:scale-[0.98] border border-dark-700/80 text-slate-200 font-bold text-xs sm:text-sm tracking-wider uppercase flex items-center justify-center shadow-lg transition-transform"
        >
          Left Click
        </button>

        <button
          onClick={() => handleMouseClick('left', 'double_click')}
          className="rounded-2xl bg-dark-950 hover:bg-dark-800 active:bg-dark-700 active:scale-[0.98] border border-dark-700/80 text-slate-200 font-bold text-xs sm:text-sm tracking-wider uppercase flex items-center justify-center shadow-lg transition-transform"
        >
          Double Click
        </button>

        <button
          onClick={() => handleMouseClick('right')}
          className="rounded-2xl bg-dark-950 hover:bg-dark-800 active:bg-dark-700 active:scale-[0.98] border border-dark-700/80 text-slate-200 font-bold text-xs sm:text-sm tracking-wider uppercase flex items-center justify-center shadow-lg transition-transform"
        >
          Right Click
        </button>
      </div>

      {/* 6. Expandable Virtual Keyboard Drawer */}
      {showKeyboard && (
        <div className="p-3 rounded-2xl bg-dark-950 border border-dark-800 animate-fadeIn space-y-2.5">
          <form onSubmit={handleSendText} className="flex gap-2">
            <input
              type="text"
              value={keyboardText}
              onChange={(e) => setKeyboardText(e.target.value)}
              placeholder="Type text to send to Windows..."
              className="flex-1 px-3 py-2 text-xs rounded-xl bg-dark-900 border border-dark-700 text-slate-200 focus:outline-none focus:border-brand-primary"
            />
            <button
              type="submit"
              className="px-4 py-2 bg-brand-primary text-dark-950 font-bold text-xs rounded-xl hover:bg-cyan-400 active:scale-95 transition-transform"
            >
              Send
            </button>
          </form>

          {/* Quick Keys */}
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-1.5 text-xs font-mono">
            <button onClick={() => handleSendKey('enter')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 flex items-center justify-center gap-1 active:bg-brand-primary active:text-dark-950">
              <CornerDownLeft className="w-3.5 h-3.5" /> Enter
            </button>
            <button onClick={() => handleSendKey('backspace')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 flex items-center justify-center gap-1 active:bg-brand-primary active:text-dark-950">
              <Delete className="w-3.5 h-3.5" /> Bksp
            </button>
            <button onClick={() => handleSendKey('space')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 flex items-center justify-center gap-1 active:bg-brand-primary active:text-dark-950">
              <Space className="w-3.5 h-3.5" /> Space
            </button>
            <button onClick={() => handleSendKey('tab')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 active:bg-brand-primary active:text-dark-950">
              Tab
            </button>
            <button onClick={() => handleSendKey('escape')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 active:bg-brand-primary active:text-dark-950">
              Esc
            </button>
            <button onClick={() => handleSendKey('win')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-brand-primary font-bold active:bg-brand-primary active:text-dark-950">
              Win ⊞
            </button>
            <button onClick={() => handleSendKey('up')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 flex items-center justify-center active:bg-brand-primary active:text-dark-950">
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => handleSendKey('down')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 flex items-center justify-center active:bg-brand-primary active:text-dark-950">
              <ArrowDown className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => handleSendKey('left')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 flex items-center justify-center active:bg-brand-primary active:text-dark-950">
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => handleSendKey('right')} className="p-2 rounded-lg bg-dark-900 hover:bg-dark-800 border border-dark-800 text-slate-300 flex items-center justify-center active:bg-brand-primary active:text-dark-950">
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* 7. Fullscreen Remote Desktop Modal */}
      {fullScreen && (
        <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center p-0 select-none">
          {/* Floating Top HUD */}
          <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-none">
            <div className="flex items-center gap-2 bg-dark-950/80 backdrop-blur-md px-3 py-1.5 rounded-2xl border border-white/10 pointer-events-auto">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-mono font-bold text-white">LIVE REMOTE DESKTOP</span>
            </div>

            <div className="flex items-center gap-2 pointer-events-auto">
              <button
                onClick={() => setShowKeyboard(!showKeyboard)}
                className="p-2.5 rounded-2xl bg-dark-950/80 backdrop-blur-md border border-white/10 text-white hover:bg-white/10"
              >
                <Keyboard className="w-4 h-4" />
              </button>
              <button
                onClick={() => setFullScreen(false)}
                className="p-2.5 rounded-2xl bg-dark-950/80 backdrop-blur-md border border-white/10 text-white hover:bg-red-500/20 hover:text-red-400"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Fullscreen Video Viewport with direct touch */}
          <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
            <img
              ref={fullscreenImgRef}
              src={streamUrl}
              alt="Fullscreen Live Screen"
              onClick={(e) => handleScreenTouch(e, fullscreenImgRef)}
              className="max-w-full max-h-full w-auto h-auto object-contain cursor-crosshair"
            />

            {/* Tap Click Ripple Animations */}
            {ripples.map((ripple) => (
              <span
                key={ripple.id}
                style={{ left: ripple.x, top: ripple.y }}
                className={`absolute w-10 h-10 -ml-5 -mt-5 rounded-full pointer-events-none animate-ping ${
                  ripple.button === 'right' ? 'bg-amber-400/80 border-2 border-amber-300' : 'bg-cyan-400/80 border-2 border-cyan-300'
                }`}
              />
            ))}
          </div>

          {/* Floating Bottom Action Bar in Fullscreen */}
          <div className="absolute bottom-4 left-4 right-4 z-20 flex items-center justify-center gap-3 pointer-events-none">
            <div className="flex items-center gap-2 bg-dark-950/90 backdrop-blur-md p-1.5 rounded-2xl border border-white/10 pointer-events-auto shadow-2xl">
              <button
                onClick={() => setClickAction('left')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  clickAction === 'left' ? 'bg-brand-primary text-dark-950' : 'text-slate-300 hover:text-white'
                }`}
              >
                Left Click
              </button>
              <button
                onClick={() => setClickAction('right')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  clickAction === 'right' ? 'bg-amber-400 text-dark-950' : 'text-slate-300 hover:text-white'
                }`}
              >
                Right Click
              </button>
              <button
                onClick={() => setClickAction('double_click')}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
                  clickAction === 'double_click' ? 'bg-purple-400 text-dark-950' : 'text-slate-300 hover:text-white'
                }`}
              >
                Double Click
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
