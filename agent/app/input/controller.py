"""Windows mouse and keyboard input simulation via a dedicated desktop-attached worker thread.

The uvicorn/asyncio event loop thread has hidden windows that prevent
SetThreadDesktop from succeeding.  We solve this by running ALL Win32
input calls on a single, long-lived worker thread that attaches to the
interactive desktop once at startup and re-attaches before every batch.
"""
import sys
import time
import logging
import threading
import queue
from typing import Any, Optional

logger = logging.getLogger("rcpc.input")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Mouse event flags
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000

# Virtual key codes
VK_BACK = 0x08
VK_TAB = 0x09
VK_RETURN = 0x0D
VK_ESCAPE = 0x1B
VK_SPACE = 0x20
VK_LEFT = 0x25
VK_UP = 0x26
VK_RIGHT = 0x27
VK_DOWN = 0x28
VK_DELETE = 0x2E
VK_LWIN = 0x5B

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004

SPECIAL_KEYS = {
    "enter": VK_RETURN,
    "backspace": VK_BACK,
    "tab": VK_TAB,
    "escape": VK_ESCAPE,
    "esc": VK_ESCAPE,
    "space": VK_SPACE,
    "left": VK_LEFT,
    "up": VK_UP,
    "right": VK_RIGHT,
    "down": VK_DOWN,
    "delete": VK_DELETE,
    "win": VK_LWIN,
}

# ---------------------------------------------------------------------------
# Dedicated input worker thread
# ---------------------------------------------------------------------------

_input_queue: queue.Queue = queue.Queue()
_worker_thread: Optional[threading.Thread] = None
_worker_started = threading.Event()


def _attach_desktop():
    """Attach the current thread to the interactive desktop (Session 1 Default)."""
    import ctypes
    user32 = ctypes.windll.user32
    # Try OpenInputDesktop first (returns the desktop receiving user input)
    hdesk = user32.OpenInputDesktop(0, False, 0x01FF)
    if not hdesk:
        # Fallback: open "Default" desktop by name
        hdesk = user32.OpenDesktopW("Default", 0, False, 0x01FF)
    if hdesk:
        ok = user32.SetThreadDesktop(hdesk)
        user32.CloseDesktop(hdesk)
        return ok
    return False


def _input_worker():
    """Long-lived thread that processes all input commands."""
    import ctypes

    # Attach to the interactive desktop on this clean thread
    attached = _attach_desktop()
    logger.info(f"Input worker thread started, desktop attached: {attached}")
    _worker_started.set()

    user32 = ctypes.windll.user32

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    while True:
        try:
            cmd = _input_queue.get()
            if cmd is None:
                break

            # Re-attach each iteration in case of desktop switch (lock/unlock)
            _attach_desktop()

            action = cmd.get("action")

            if action == "mouse_move":
                dx = cmd["dx"]
                dy = cmd["dy"]
                user32.mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, 0)

            elif action == "mouse_click":
                down_flag = cmd["down"]
                up_flag = cmd["up"]
                act = cmd.get("act", "click")

                if act == "down":
                    user32.mouse_event(down_flag, 0, 0, 0, 0)
                elif act == "up":
                    user32.mouse_event(up_flag, 0, 0, 0, 0)
                elif act == "click":
                    user32.mouse_event(down_flag, 0, 0, 0, 0)
                    time.sleep(0.01)
                    user32.mouse_event(up_flag, 0, 0, 0, 0)
                elif act == "double_click":
                    user32.mouse_event(down_flag, 0, 0, 0, 0)
                    time.sleep(0.01)
                    user32.mouse_event(up_flag, 0, 0, 0, 0)
                    time.sleep(0.05)
                    user32.mouse_event(down_flag, 0, 0, 0, 0)
                    time.sleep(0.01)
                    user32.mouse_event(up_flag, 0, 0, 0, 0)

            elif action == "mouse_abs_click":
                x = cmd["x"]
                y = cmd["y"]
                user32.SetCursorPos(x, y)
                time.sleep(0.005)
                # Trigger the click via recursive queue item
                _input_queue.put({
                    "action": "mouse_click",
                    "down": cmd["down"],
                    "up": cmd["up"],
                    "act": cmd.get("act", "click"),
                })

            elif action == "mouse_scroll":
                amount = cmd["amount"]
                user32.mouse_event(MOUSEEVENTF_WHEEL, 0, 0, amount, 0)

            elif action == "key_press":
                vk = cmd["vk"]
                user32.keybd_event(vk, 0, 0, 0)
                time.sleep(0.01)
                user32.keybd_event(vk, 0, KEYEVENTF_KEYUP, 0)

            elif action == "text_input":
                for code in cmd["codes"]:
                    user32.keybd_event(0, code, KEYEVENTF_UNICODE, 0)
                    time.sleep(0.005)
                    user32.keybd_event(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0)

        except Exception as e:
            logger.error(f"Input worker error: {e}", exc_info=True)


def _ensure_worker():
    """Start the input worker thread if not already running."""
    global _worker_thread
    if _worker_thread is not None and _worker_thread.is_alive():
        return
    _worker_started.clear()
    _worker_thread = threading.Thread(target=_input_worker, daemon=True, name="rcpc-input-worker")
    _worker_thread.start()
    _worker_started.wait(timeout=3.0)


# Auto-start on import (Windows only)
if sys.platform.startswith("win"):
    _ensure_worker()


# ---------------------------------------------------------------------------
# Public API  (called from WebSocket / HTTP handlers on the event loop thread)
# ---------------------------------------------------------------------------

def move_mouse_relative(dx: float, dy: float, sensitivity: float = 1.0):
    """Move cursor by relative delta pixels."""
    if not sys.platform.startswith("win"):
        return
    _ensure_worker()
    scaled_dx = int(round(dx * sensitivity))
    scaled_dy = int(round(dy * sensitivity))
    _input_queue.put({"action": "mouse_move", "dx": scaled_dx, "dy": scaled_dy})


def mouse_click(button: str = "left", action: str = "click"):
    """Perform mouse button action: 'click', 'double_click', 'down', 'up'."""
    if not sys.platform.startswith("win"):
        return
    _ensure_worker()

    down_flag = MOUSEEVENTF_LEFTDOWN
    up_flag = MOUSEEVENTF_LEFTUP

    if button == "right":
        down_flag = MOUSEEVENTF_RIGHTDOWN
        up_flag = MOUSEEVENTF_RIGHTUP
    elif button == "middle":
        down_flag = MOUSEEVENTF_MIDDLEDOWN
        up_flag = MOUSEEVENTF_MIDDLEUP

    _input_queue.put({"action": "mouse_click", "down": down_flag, "up": up_flag, "act": action})


def click_mouse_at_percent(x_percent: float, y_percent: float, button: str = "left", action: str = "click"):
    """Move cursor to percent coordinate on screen and click."""
    if not sys.platform.startswith("win"):
        return
    _ensure_worker()
    import ctypes
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    user32 = ctypes.windll.user32
    w = user32.GetSystemMetrics(0)
    h = user32.GetSystemMetrics(1)
    target_x = int(max(0.0, min(x_percent, 1.0)) * w)
    target_y = int(max(0.0, min(y_percent, 1.0)) * h)

    down_flag = MOUSEEVENTF_LEFTDOWN
    up_flag = MOUSEEVENTF_LEFTUP
    if button == "right":
        down_flag = MOUSEEVENTF_RIGHTDOWN
        up_flag = MOUSEEVENTF_RIGHTUP
    elif button == "middle":
        down_flag = MOUSEEVENTF_MIDDLEDOWN
        up_flag = MOUSEEVENTF_MIDDLEUP

    _input_queue.put({
        "action": "mouse_abs_click",
        "x": target_x, "y": target_y,
        "down": down_flag, "up": up_flag, "act": action,
    })


def mouse_scroll(delta: int):
    """Scroll mouse wheel vertically."""
    if not sys.platform.startswith("win"):
        return
    _ensure_worker()
    amount = int(delta * 120)
    _input_queue.put({"action": "mouse_scroll", "amount": amount})


def send_special_key(key_name: str) -> bool:
    """Send a named special key like enter, backspace, etc."""
    if not sys.platform.startswith("win"):
        return False
    _ensure_worker()
    vk = SPECIAL_KEYS.get(key_name.lower())
    if not vk:
        return False
    _input_queue.put({"action": "key_press", "vk": vk})
    return True


def send_text(text: str):
    """Send unicode text characters directly."""
    if not sys.platform.startswith("win"):
        return
    _ensure_worker()
    codes = [ord(c) for c in text]
    _input_queue.put({"action": "text_input", "codes": codes})
