"""Windows multimedia key controller with direct Core Audio hardware endpoint volume support."""
import sys
import time
import logging
from typing import Optional

logger = logging.getLogger("rcpc.media")

# Windows Virtual Key Codes
VK_VOLUME_MUTE = 0xAD
VK_VOLUME_DOWN = 0xAE
VK_VOLUME_UP = 0xAF
VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
VK_MEDIA_STOP = 0xB2
VK_MEDIA_PLAY_PAUSE = 0xB3

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002

def ensure_interactive_desktop():
    """Ensure current thread is attached to the active user's interactive desktop."""
    if not sys.platform.startswith("win"):
        return
    import ctypes
    user32 = ctypes.windll.user32
    hdesk = user32.OpenInputDesktop(0, False, 0x01FF)
    if not hdesk:
        hdesk = user32.OpenDesktopW("default", 0, False, 0x01FF)
    if hdesk:
        user32.SetThreadDesktop(hdesk)
        user32.CloseDesktop(hdesk)

def _send_vk(vk_code: int):
    """Simulate keypress for virtual key code using ctypes SendInput / keybd_event."""
    if not sys.platform.startswith("win"):
        logger.warning(f"Simulate VK {hex(vk_code)} called on non-Windows")
        return
    ensure_interactive_desktop()
    import ctypes
    user32 = ctypes.windll.user32
    scan = user32.MapVirtualKeyW(vk_code, 0)
    user32.keybd_event(vk_code, scan, KEYEVENTF_EXTENDEDKEY, 0)
    time.sleep(0.02)
    user32.keybd_event(vk_code, scan, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0)

def _get_endpoint_volume():
    """Retrieve Windows default playback device master EndpointVolume interface."""
    try:
        from pycaw.pycaw import AudioUtilities
        speakers = AudioUtilities.GetSpeakers()
        if speakers:
            return speakers.EndpointVolume
    except Exception as e:
        logger.debug(f"pycaw endpoint volume unavailable: {e}")
    return None

def get_volume_status() -> dict:
    """Query current Windows master volume and hardware mute state."""
    ep = _get_endpoint_volume()
    if ep:
        try:
            return {
                "muted": bool(ep.GetMute()),
                "volume": round(float(ep.GetMasterVolumeLevelScalar()), 2)
            }
        except Exception as e:
            logger.debug(f"Failed to query volume status via pycaw: {e}")
    return {"muted": False, "volume": 0.5}

def volume_mute_toggle(desired_mute: Optional[bool] = None) -> dict:
    """Toggle or explicitly set Windows master output mute without affecting WASAPI loopback."""
    ep = _get_endpoint_volume()
    if ep:
        try:
            current_mute = bool(ep.GetMute())
            new_mute = (not current_mute) if desired_mute is None else desired_mute
            ep.SetMute(1 if new_mute else 0, None)
            actual_mute = bool(ep.GetMute())
            logger.info(f"Windows master audio mute set to: {actual_mute} (was: {current_mute})")
            return {"action": "volume_mute_toggle", "muted": actual_mute}
        except Exception as e:
            logger.warning(f"Failed to toggle mute via pycaw: {e}")

    # Fallback to pyautogui or keybd_event
    ensure_interactive_desktop()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        pyautogui.press("volumemute")
    except Exception:
        _send_vk(VK_VOLUME_MUTE)

    return {"action": "volume_mute_toggle", "muted": None}

def volume_up(steps: int = 1) -> dict:
    ep = _get_endpoint_volume()
    if ep:
        try:
            for _ in range(max(1, min(steps, 10))):
                ep.VolumeStepUp(None)
            actual_vol = round(float(ep.GetMasterVolumeLevelScalar()), 2)
            logger.info(f"Volume stepped up to {actual_vol}")
            return {"action": "volume_up", "steps": steps, "volume": actual_vol}
        except Exception as e:
            logger.warning(f"pycaw volume_up failed: {e}")

    ensure_interactive_desktop()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        for _ in range(max(1, min(steps, 10))):
            pyautogui.press("volumeup")
    except Exception:
        for _ in range(max(1, min(steps, 10))):
            _send_vk(VK_VOLUME_UP)
    return {"action": "volume_up", "steps": steps}

def volume_down(steps: int = 1) -> dict:
    ep = _get_endpoint_volume()
    if ep:
        try:
            for _ in range(max(1, min(steps, 10))):
                ep.VolumeStepDown(None)
            actual_vol = round(float(ep.GetMasterVolumeLevelScalar()), 2)
            logger.info(f"Volume stepped down to {actual_vol}")
            return {"action": "volume_down", "steps": steps, "volume": actual_vol}
        except Exception as e:
            logger.warning(f"pycaw volume_down failed: {e}")

    ensure_interactive_desktop()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        for _ in range(max(1, min(steps, 10))):
            pyautogui.press("volumedown")
    except Exception:
        for _ in range(max(1, min(steps, 10))):
            _send_vk(VK_VOLUME_DOWN)
    return {"action": "volume_down", "steps": steps}

def media_play_pause() -> dict:
    ensure_interactive_desktop()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        pyautogui.press("playpause")
    except Exception:
        _send_vk(VK_MEDIA_PLAY_PAUSE)
    return {"action": "media_play_pause"}

def media_next() -> dict:
    ensure_interactive_desktop()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        pyautogui.press("nexttrack")
    except Exception:
        _send_vk(VK_MEDIA_NEXT_TRACK)
    return {"action": "media_next"}

def media_prev() -> dict:
    ensure_interactive_desktop()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        pyautogui.press("prevtrack")
    except Exception:
        _send_vk(VK_MEDIA_PREV_TRACK)
    return {"action": "media_prev"}

def media_stop() -> dict:
    ensure_interactive_desktop()
    try:
        import pyautogui
        pyautogui.FAILSAFE = False
        pyautogui.press("stop")
    except Exception:
        _send_vk(VK_MEDIA_STOP)
    return {"action": "media_stop"}
