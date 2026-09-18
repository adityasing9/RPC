"""Live PC system audio streaming via WASAPI loopback and WebSockets."""
import asyncio
import json
import logging
import threading
from typing import Optional, Set
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from app.auth.dependencies import get_current_device
from app.auth.tokens import decode_access_token
from app.auth.vault import device_vault, PairedDevice
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
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._device_info: Optional[dict] = None
        self.sample_rate: int = 48000
        self.channels: int = 2
        self.chunk_ms: int = 50

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
            # Drop older chunks if queue exceeds 6 frames (~300ms) to ensure real-time latency
            q: asyncio.Queue = asyncio.Queue(maxsize=8)
            self._subscribers.add(q)
            self._loop = loop

            if len(self._subscribers) == 1 or self._thread is None or not self._thread.is_alive():
                self._stop_event.clear()
                self._thread = threading.Thread(target=self._capture_worker, daemon=True, name="rcpc-audio-loopback")
                self._thread.start()
                logger.info("Audio loopback capture thread started")
            return q

    def unsubscribe(self, q: asyncio.Queue):
        """Unregister a listener and terminate capture worker if no subscribers left."""
        with self._lock:
            self._subscribers.discard(q)
            if not self._subscribers:
                self._stop_event.set()
                logger.info("No audio subscribers remaining; stopping loopback capture")

    def _capture_worker(self):
        """Background thread that reads audio from WASAPI loopback device and broadcasts."""
        import pyaudiowpatch as pyaudio

        p = pyaudio.PyAudio()
        stream = None
        try:
            wasapi_info = p.get_host_api_info_by_type(pyaudio.paWASAPI)
            default_speakers = p.get_device_info_by_index(wasapi_info["defaultOutputDevice"])
            
            # Find loopback endpoint for default output
            loopback_dev = None
            if default_speakers.get("isLoopbackDevice"):
                loopback_dev = default_speakers
            else:
                for lb in p.get_loopback_device_info_generator():
                    if default_speakers["name"] in lb["name"]:
                        loopback_dev = lb
                        break
                if not loopback_dev:
                    loopback_dev = p.get_default_wasapi_loopback()

            self._device_info = loopback_dev
            self.channels = int(loopback_dev.get("maxInputChannels", 2))
            self.sample_rate = int(loopback_dev.get("defaultSampleRate", 48000))
            frames_per_buffer = int(self.sample_rate * (self.chunk_ms / 1000.0))

            logger.info(f"Opening loopback stream on '{loopback_dev['name']}': {self.sample_rate}Hz, {self.channels}ch")

            stream = p.open(
                format=pyaudio.paInt16,
                channels=self.channels,
                rate=self.sample_rate,
                input=True,
                input_device_index=loopback_dev["index"],
                frames_per_buffer=frames_per_buffer
            )

            while not self._stop_event.is_set():
                try:
                    data = stream.read(frames_per_buffer, exception_on_overflow=False)
                except Exception as e:
                    logger.debug(f"Audio read warning: {e}")
                    continue

                if not data:
                    continue

                with self._lock:
                    subscribers = list(self._subscribers)
                    loop = self._loop

                if not subscribers or not loop or loop.is_closed():
                    continue

                # Broadcast data to all subscriber queues thread-safely
                for sub_q in subscribers:
                    try:
                        if sub_q.full():
                            try:
                                sub_q.get_nowait()
                            except asyncio.QueueEmpty:
                                pass
                        loop.call_soon_threadsafe(sub_q.put_nowait, data)
                    except Exception:
                        pass

        except Exception as e:
            logger.error(f"Error in audio capture worker: {e}", exc_info=True)
        finally:
            if stream:
                try:
                    stream.stop_stream()
                    stream.close()
                except Exception:
                    pass
            try:
                p.terminate()
            except Exception:
                pass
            logger.info("Audio loopback capture thread exited")

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
    # Authenticate token from query param or headers
    auth_token = token
    if not auth_token:
        auth_header = websocket.headers.get("authorization")
        if auth_header and auth_header.startswith("Bearer "):
            auth_token = auth_header.replace("Bearer ", "").strip()

    if not auth_token:
        await websocket.close(code=4001, reason="Authentication required")
        return

    device_id = decode_access_token(auth_token)
    if not device_id or not device_vault.is_paired(device_id):
        await websocket.close(code=4003, reason="Unauthorized device")
        return

    await websocket.accept()
    loop = asyncio.get_running_loop()
    queue = audio_manager.subscribe(loop)

    try:
        # Send initial audio configuration payload
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
