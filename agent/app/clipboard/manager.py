"""Windows clipboard reader and writer via ctypes Win32 APIs."""
import sys
import ctypes
from ctypes import wintypes
from typing import Optional

# Setup 64-bit safe Win32 function signatures
if sys.platform.startswith("win"):
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    # OpenClipboard
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL

    # CloseClipboard
    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL

    # EmptyClipboard
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = wintypes.BOOL

    # GetClipboardData
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE

    # SetClipboardData
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE

    # GlobalAlloc
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL

    # GlobalLock (CRUCIAL: restype must be c_void_p to return full 64-bit address)
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = ctypes.c_void_p

    # GlobalUnlock
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL

    # GlobalFree
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.restype = wintypes.HGLOBAL

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x0002

def get_clipboard_text() -> str:
    """Retrieve text currently stored in Windows clipboard."""
    if not sys.platform.startswith("win"):
        return ""

    if not user32.OpenClipboard(None):
        return ""

    try:
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ""

        data_ptr = kernel32.GlobalLock(handle)
        if not data_ptr:
            return ""

        try:
            return ctypes.c_wchar_p(data_ptr).value or ""
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()

def set_clipboard_text(text: str) -> bool:
    """Write text to Windows clipboard."""
    if not sys.platform.startswith("win"):
        return False

    encoded = (text + "\0").encode("utf-16le")
    byte_len = len(encoded)

    h_mem = kernel32.GlobalAlloc(GMEM_MOVEABLE, byte_len)
    if not h_mem:
        return False

    p_mem = kernel32.GlobalLock(h_mem)
    if not p_mem:
        kernel32.GlobalFree(h_mem)
        return False

    try:
        ctypes.memmove(p_mem, encoded, byte_len)
    finally:
        kernel32.GlobalUnlock(h_mem)

    if not user32.OpenClipboard(None):
        kernel32.GlobalFree(h_mem)
        return False

    try:
        user32.EmptyClipboard()
        user32.SetClipboardData(CF_UNICODETEXT, h_mem)
        return True
    finally:
        user32.CloseClipboard()
