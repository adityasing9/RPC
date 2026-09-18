"""Live PC system audio streaming via WASAPI loopback and WebSockets."""
import asyncio
import json
import logging
import threading
from typing import Optional, Set
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPBearer
from app.auth.dependencies import get_current_device, get_websocket_device
from app.auth.vault import PairedDevice
from app.logging_config import audit_logger

logger = logging.getLogger("rcpc.audio")

router = APIRouter(prefix="/api/v1/audio", tags=["Audio Stream"])
bearer_scheme = HTTPBearer(auto_error=False)

class AudioLoopbackManager:
    """Manages low-latency WASAPI loopback audio capture and broadcasting."""

    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers: Set[asyncio.Queue] = set()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._pa = None
        self._in_stream = None
        self._out_stream = None
        self._device_info: Optional[dict] = None
        self.sample_rate: int = 48000
        self.channels: int = 2
        self.chunk_ms: int = 25

    def get_info(self) -> dict:
        """Return audio device and stream capabilities."""
        return {
            "available": True,
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "format": "pcm_s16le",
            "chunkDurationMs": self.chunk_ms,
            "listeners": len(self._subscribers),
            "deviceName": self._device_info.get("name") if self._device_info else "Default WASAPI Loopback"
        }

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> asyncio.Queue:
        """Register a new listener and start capture worker if needed."""
        with self._lock:
            q: asyncio.Queue = asyncio.Queue(maxsize=50)
            self._subscribers.add(q)
            self._loop = loop

            if len(self._subscribers) == 1 or self._in_stream is None:
                self._start_capture()
            return q

    def unsubscribe(self, q: asyncio.Queue):
        """Unregister a listener and terminate capture worker if no subscribers left."""
        with self._lock:
            self._subscribers.discard(q)
            if not self._subscribers:
                self._stop_capture()

    def _start_capture(self):
        """Start non-blocking callback capture with a silent keepalive feeder."""
        try:
            import pyaudiowpatch as pyaudio

            if self._pa is None:
                self._pa = pyaudio.PyAudio()

            wasapi_info = self._pa.get_host_api_info_by_type(pyaudio.paWASAPI)
            default_speakers = self._pa.get_device_info_by_index(wasapi_info["defaultOutputDevice"])

            loopback_dev = None
            if default_speakers.get("isLoopbackDevice"):
                loopback_dev = default_speakers
            else:
                for lb in self._pa.get_loopback_device_info_generator():
                    if default_speakers["name"] in lb["name"]:
                        loopback_dev = lb
                        break
                if not loopback_dev:
                    loopback_dev = self._pa.get_default_wasapi_loopback()

            self._device_info = loopback_dev
            self.channels = int(loopback_dev.get("maxInputChannels", 2))
            self.sample_rate = int(loopback_dev.get("defaultSampleRate", 48000))
            frames_per_buffer = int(self.sample_rate * (self.chunk_ms / 1000.0))

            logger.info(f"Starting WASAPI loopback on '{loopback_dev['name']}': {self.sample_rate}Hz, {self.channels}ch")

            def _in_callback(in_data, frame_count, time_info, status):
                if in_data:
                    with self._lock:
                        subscribers = list(self._subscribers)
                        loop = self._loop

                    if subscribers and loop and not loop.is_closed():
                        for sub_q in subscribers:
                            try:
                                if sub_q.full():
                                    try:
                                        sub_q.get_nowait()
                                    except asyncio.QueueEmpty:
                                        pass
                                loop.call_soon_threadsafe(sub_q.put_nowait, in_data)
                            except Exception:
                                pass
                return (None, pyaudio.paContinue)

            self._in_stream = self._pa.open(
                format=pyaudio.paInt16,
                channels=self.channels,
                rate=self.sample_rate,
                input=True,
                input_device_index=loopback_dev["index"],
                frames_per_buffer=frames_per_buffer,
                stream_callback=_in_callback
            )

            self._in_stream.start_stream()
            logger.info("Dedicated audio loopback capture active")

        except Exception as e:
            logger.error(f"Failed to start audio loopback: {e}", exc_info=True)
            self._stop_capture()

    def _stop_capture(self):
        """Stop streams and release PortAudio resources."""
        if self._in_stream:
            try:
                self._in_stream.stop_stream()
                self._in_stream.close()
            except Exception:
                pass
            self._in_stream = None

        if self._pa:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None

        logger.info("Audio loopback streams stopped and resources freed")

audio_manager = AudioLoopbackManager()

@router.get("/status")
async def get_audio_status(current_device: PairedDevice = Depends(get_current_device)):
    """Check audio loopback stream availability and parameters."""
    return audio_manager.get_info()

@router.websocket("/ws")
async def audio_stream_websocket(
    websocket: WebSocket,
    token: Optional[str] = Query(None)
):
    """Real-time binary PCM audio stream via WebSocket."""
    device = await get_websocket_device(websocket, token)
    if not device:
        await websocket.close(code=4001, reason="Unauthorized or revoked device")
        return

    await websocket.accept()
    loop = asyncio.get_running_loop()
    queue = audio_manager.subscribe(loop)
    logger.info(f"Audio WebSocket connected from device {device.device_name} ({device.device_id})")

    try:
        init_payload = {
            "type": "init",
            "sampleRate": audio_manager.sample_rate,
            "channels": audio_manager.channels,
            "format": "pcm_s16le",
            "chunkDurationMs": audio_manager.chunk_ms
        }
        await websocket.send_text(json.dumps(init_payload))

        while True:
            chunk = await queue.get()
            await websocket.send_bytes(chunk)

    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as e:
        logger.debug(f"Audio WebSocket stream closed: {e}")
    finally:
        audio_manager.unsubscribe(queue)
        logger.info(f"Audio WebSocket disconnected for {device.device_name}")
