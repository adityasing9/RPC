"""Secure screen capture and live streaming endpoints."""
import asyncio
import io
import sys
import ctypes
import ctypes.wintypes
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, Security
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from PIL import Image, ImageDraw, ImageGrab
from app.auth.dependencies import get_current_device
from app.auth.tokens import decode_access_token
from app.auth.vault import device_vault, PairedDevice
from app.logging_config import audit_logger

router = APIRouter(prefix="/api/v1/screen", tags=["Screen Capture & Live Stream"])
bearer_scheme = HTTPBearer(auto_error=False)

def make_dpi_aware():
    """Ensure Windows Per-Monitor DPI awareness so all screen and cursor APIs match 1:1."""
    if sys.platform.startswith("win"):
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass

make_dpi_aware()

def attach_input_desktop():
    """Ensure current thread is attached to the active input desktop station."""
    if sys.platform.startswith("win"):
        try:
            user32 = ctypes.windll.user32
            hdesk = user32.OpenInputDesktop(0, False, 0x01FF)
            if hdesk:
                user32.SetThreadDesktop(hdesk)
                user32.CloseDesktop(hdesk)
        except Exception:
            pass

def get_screen_metrics():
    """Retrieve primary monitor resolution."""
    make_dpi_aware()
    if sys.platform.startswith("win"):
        try:
            user32 = ctypes.windll.user32
            w = user32.GetSystemMetrics(0)
            h = user32.GetSystemMetrics(1)
            return w, h
        except Exception:
            pass
    return 1920, 1080

def get_cursor_pos():
    """Retrieve current Windows mouse cursor position (x, y) if visible."""
    if not sys.platform.startswith("win"):
        return None
    try:
        user32 = ctypes.windll.user32
        class CURSORINFO(ctypes.Structure):
            _fields_ = [
                ("cbSize", ctypes.wintypes.DWORD),
                ("flags", ctypes.wintypes.DWORD),
                ("hCursor", ctypes.wintypes.HANDLE),
                ("ptScreenPos", ctypes.wintypes.POINT),
            ]
        ci = CURSORINFO()
        ci.cbSize = ctypes.sizeof(CURSORINFO)
        if user32.GetCursorInfo(ctypes.byref(ci)):
            if ci.flags & 1:  # CURSOR_SHOWING
                return ci.ptScreenPos.x, ci.ptScreenPos.y
        # Fallback to GetCursorPos
        pt = ctypes.wintypes.POINT()
        if user32.GetCursorPos(ctypes.byref(pt)):
            return pt.x, pt.y
    except Exception:
        pass
    return None

def draw_mouse_cursor(image: Image.Image, cx: int, cy: int):
    """Draw a high-visibility Windows mouse cursor pointer on the image.
    Automatically flips upward or leftward near screen edges so the cursor body is never clipped.
    """
    try:
        draw = ImageDraw.Draw(image)
        w, h = image.size
        # Clamping hotspot to canvas bounds
        cx = max(0, min(cx, w - 1))
        cy = max(0, min(cy, h - 1))

        # Dynamic orientation to keep pointer fully visible near bottom and right edges
        dx_mult = -1 if cx > w - 16 else 1
        dy_mult = -1 if cy > h - 22 else 1

        points = [
            (cx, cy),
            (cx, cy + dy_mult * 19),
            (cx + dx_mult * 4, cy + dy_mult * 15),
            (cx + dx_mult * 8, cy + dy_mult * 23),
            (cx + dx_mult * 12, cy + dy_mult * 21),
            (cx + dx_mult * 8, cy + dy_mult * 13),
            (cx + dx_mult * 14, cy + dy_mult * 13),
        ]
        # Drop shadow for contrast on white/bright desktop backgrounds
        shadow = [(x + 1, y + 1) for x, y in points]
        draw.polygon(shadow, fill=(20, 20, 20))
        # Crisp white fill with black border
        draw.polygon(points, fill="white", outline="black")
    except Exception:
        pass

def grab_screen_frame(max_width: int = 1280, quality: int = 60) -> bytes:
    """Capture desktop, render mouse cursor, and return optimized JPEG bytes."""
    make_dpi_aware()
    attach_input_desktop()
    cursor_pos = get_cursor_pos()
    w_metric, h_metric = get_screen_metrics()

    try:
        screenshot = ImageGrab.grab(all_screens=False)
    except Exception:
        # Fallback placeholder if screen is locked or unreadable
        w, h = w_metric, h_metric
        img = Image.new("RGB", (min(max_width, w), int(min(max_width, w) * (h / max(1, w)))), color=(15, 23, 42))
        draw = ImageDraw.Draw(img)
        draw.text((30, 30), "Screen Inactive / Desktop Locked", fill=(148, 163, 184))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=50)
        return buf.getvalue()

    # Calculate normalized percentage of cursor across the original screen
    norm_x, norm_y = None, None
    if cursor_pos and w_metric > 0 and h_metric > 0:
        span_w = max(screenshot.width, w_metric)
        span_h = max(screenshot.height, h_metric)
        norm_x = max(0.0, min(1.0, cursor_pos[0] / float(span_w)))
        norm_y = max(0.0, min(1.0, cursor_pos[1] / float(span_h)))

    # If resizing, scale down first then draw razor-sharp cursor on top
    if screenshot.width > max_width:
        ratio = max_width / screenshot.width
        new_size = (max_width, int(screenshot.height * ratio))
        screenshot = screenshot.resize(new_size, Image.BILINEAR)

    # Project cursor onto final scaled frame
    if norm_x is not None and norm_y is not None:
        cx = int(round(norm_x * (screenshot.width - 1)))
        cy = int(round(norm_y * (screenshot.height - 1)))
        draw_mouse_cursor(screenshot, cx, cy)

    buffer = io.BytesIO()
    screenshot.save(buffer, format="JPEG", quality=max(15, min(quality, 95)))
    return buffer.getvalue()

async def resolve_device_or_query_token(
    credentials: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
    token: Optional[str] = Query(None)
) -> PairedDevice:
    """Authorize device via Authorization Header or query parameter (for direct <img> streaming)."""
    raw_token = credentials.credentials if credentials else token
    if not raw_token:
        raise HTTPException(status_code=401, detail="Missing authorization token")

    payload = decode_access_token(raw_token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired authorization token")

    device_id = payload.get("sub")
    if not device_id:
        raise HTTPException(status_code=401, detail="Malformed token")

    device = device_vault.get_device(device_id)
    if not device or device.is_revoked:
        raise HTTPException(status_code=401, detail="Device not recognized or revoked")

    return device

class ScreenClickRequest(BaseModel):
    x_percent: float
    y_percent: float
    button: str = "left"    # left, right, middle
    action: str = "click"   # click, double_click, down, up

@router.get("/info")
async def get_screen_info(current_device: PairedDevice = Depends(resolve_device_or_query_token)):
    """Return monitor metrics and live stream capability."""
    w, h = get_screen_metrics()
    return {
        "width": w,
        "height": h,
        "aspect_ratio": round(w / max(1, h), 3),
        "supported_fps": [5, 10, 15, 20, 30],
        "default_fps": 30,
    }

@router.get("/capture")
async def capture_screen(
    quality: int = 70,
    width: int = 1280,
    current_device: PairedDevice = Depends(resolve_device_or_query_token)
):
    """Capture single Windows screen snapshot and return JPEG image."""
    try:
        jpeg_bytes = grab_screen_frame(max_width=width, quality=quality)
        return Response(
            content=jpeg_bytes,
            media_type="image/jpeg",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to capture screen: {e}")

@router.get("/stream")
async def stream_screen(
    fps: int = 30,
    quality: int = 60,
    width: int = 1280,
    current_device: PairedDevice = Depends(resolve_device_or_query_token)
):
    """Continuous high-performance MJPEG live screen preview stream."""
    safe_fps = max(1, min(fps, 30))
    safe_quality = max(20, min(quality, 85))
    safe_width = max(480, min(width, 1920))
    target_frame_time = 1.0 / safe_fps

    async def frame_generator():
        try:
            while True:
                start_time = asyncio.get_event_loop().time()
                # Run frame capture in thread pool to avoid blocking the async event loop
                frame = await asyncio.to_thread(grab_screen_frame, safe_width, safe_quality)
                
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n" +
                    frame + b"\r\n"
                )

                elapsed = asyncio.get_event_loop().time() - start_time
                delay = max(0.01, target_frame_time - elapsed)
                await asyncio.sleep(delay)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    return StreamingResponse(
        frame_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Connection": "close"
        }
    )

@router.post("/click")
async def click_on_screen(
    req: ScreenClickRequest,
    current_device: PairedDevice = Depends(resolve_device_or_query_token)
):
    """Simulate mouse click at relative screen coordinates (0.0 to 1.0)."""
    if not sys.platform.startswith("win"):
        raise HTTPException(status_code=400, detail="Only supported on Windows")

    attach_input_desktop()
    w, h = get_screen_metrics()
    target_x = int(max(0.0, min(req.x_percent, 1.0)) * w)
    target_y = int(max(0.0, min(req.y_percent, 1.0)) * h)

    user32 = ctypes.windll.user32
    user32.SetCursorPos(target_x, target_y)

    down_flag = 0x0002  # MOUSEEVENTF_LEFTDOWN
    up_flag = 0x0004    # MOUSEEVENTF_LEFTUP

    if req.button == "right":
        down_flag = 0x0008
        up_flag = 0x0010
    elif req.button == "middle":
        down_flag = 0x0020
        up_flag = 0x0040

    if req.action == "down":
        user32.mouse_event(down_flag, 0, 0, 0, 0)
    elif req.action == "up":
        user32.mouse_event(up_flag, 0, 0, 0, 0)
    elif req.action == "double_click":
        user32.mouse_event(down_flag, 0, 0, 0, 0)
        await asyncio.sleep(0.02)
        user32.mouse_event(up_flag, 0, 0, 0, 0)
        await asyncio.sleep(0.06)
        user32.mouse_event(down_flag, 0, 0, 0, 0)
        await asyncio.sleep(0.02)
        user32.mouse_event(up_flag, 0, 0, 0, 0)
    else:  # click
        user32.mouse_event(down_flag, 0, 0, 0, 0)
        await asyncio.sleep(0.02)
        user32.mouse_event(up_flag, 0, 0, 0, 0)

    audit_logger.log_action(
        action="screen.click",
        result="SUCCESS",
        device_id=current_device.device_id,
        device_name=current_device.device_name,
        metadata={"x": target_x, "y": target_y, "button": req.button}
    )

    return {"success": True, "x": target_x, "y": target_y}
