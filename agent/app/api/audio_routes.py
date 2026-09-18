"""Live PC system audio streaming via WASAPI loopback and WebSockets."""
import asyncio
import json
import logging
import re
import threading
from typing import Optional, Set
from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
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
        self.chunk_ms: int = 20

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
            q: asyncio.Queue = asyncio.Queue(maxsize=20)
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

            # Start a silent keepalive feeder on default output speakers to drive the WASAPI clock
            try:
                def _out_callback(in_data, frame_count, time_info, status):
                    return (bytes(frame_count * self.channels * 2), pyaudio.paContinue)

                self._out_stream = self._pa.open(
                    format=pyaudio.paInt16,
                    channels=self.channels,
                    rate=self.sample_rate,
                    output=True,
                    output_device_index=default_speakers["index"],
                    frames_per_buffer=frames_per_buffer,
                    stream_callback=_out_callback
                )
                self._out_stream.start_stream()
                logger.info("Silent keepalive render feeder active on speakers")
            except Exception as out_err:
                logger.warning(f"Could not start silent keepalive feeder: {out_err}")

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

        if self._out_stream:
            try:
                self._out_stream.stop_stream()
                self._out_stream.close()
            except Exception:
                pass
            self._out_stream = None

        logger.info("Audio loopback streams stopped and freed (PyAudio kept warm)")

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

@router.get("/bluetooth/devices")
async def get_bluetooth_audio_devices(current_device: PairedDevice = Depends(get_current_device)):
    """Return paired Bluetooth audio speakers, earbuds, and devices on this Windows PC."""
    import subprocess
    try:
        res = subprocess.run(
            ['powershell', '-Command', 'Get-PnpDevice -Class Bluetooth | Select-Object -Property FriendlyName, Status, Present | ConvertTo-Json'],
            capture_output=True,
            text=True,
            timeout=5
        )
        data = json.loads(res.stdout) if res.stdout else []
        if not isinstance(data, list):
            data = [data]
        audio_keywords = ['speaker', 'earbud', 'airbass', 'headphone', 'audio', 'sound', 'toad', 'buds', 'm51', 'neo']
        seen = set()
        devices = []
        for d in data:
            name = d.get('FriendlyName', '')
            lower = name.lower()
            if any(k in lower for k in audio_keywords) and not lower.endswith('avrcp transport') and not lower.endswith('service'):
                if name not in seen:
                    seen.add(name)
                    devices.append({
                        "name": name,
                        "status": d.get("Status", "OK"),
                        "connected": d.get("Present", False)
                    })
        return {"success": True, "devices": devices}
    except Exception as e:
        logger.error(f"Failed to query Bluetooth audio devices: {e}")
        return {"success": False, "devices": [], "error": str(e)}

@router.post("/bluetooth/open-settings")
async def open_bluetooth_settings(current_device: PairedDevice = Depends(get_current_device)):
    """Open Windows Bluetooth Settings on the PC for instant pairing."""
    import subprocess
    try:
        subprocess.Popen(["cmd", "/c", "start", "ms-settings:bluetooth"])
        return {"success": True, "message": "Windows Bluetooth settings opened"}
    except Exception as e:
        logger.error(f"Failed to open Bluetooth settings: {e}")
        return {"success": False, "error": str(e)}

import fractions
import time
import uuid
from typing import Dict
import numpy as np
import av
import aiortc.codecs.opus as aiortc_opus
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack

# Patch aiortc OpusEncoder: switch from telephone 'voip' to high-fidelity 'audio' CELT music mode (192 kbps)
def _patch_hifi_opus():
    def _hifi_init(self) -> None:
        self.codec = aiortc_opus.CodecContext.create("libopus", "w")
        self.codec.bit_rate = 192000  # 192 kbps studio audio quality
        self.codec.format = "s16"
        self.codec.layout = "stereo"
        self.codec.options = {"application": "audio"}  # CELT fullband music mode (20Hz-20kHz)
        self.codec.sample_rate = aiortc_opus.SAMPLE_RATE
        self.codec.time_base = aiortc_opus.TIME_BASE
        self.resampler = aiortc_opus.AudioResampler(
            format="s16",
            layout="stereo",
            rate=aiortc_opus.SAMPLE_RATE,
            frame_size=aiortc_opus.SAMPLES_PER_FRAME,
        )
        self.first_packet_pts = None
    aiortc_opus.OpusEncoder.__init__ = _hifi_init

_patch_hifi_opus()

def _inject_stereo_fmtp(sdp: str) -> str:
    """Inject standard WebRTC stereo and high-bitrate parameters into Opus SDP."""
    lines = sdp.splitlines()
    new_lines = []
    has_fmtp = False
    for line in lines:
        new_lines.append(line)
        if line.startswith("a=rtpmap:96 opus/48000/2"):
            new_lines.append("a=fmtp:96 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000")
            has_fmtp = True
    return "\r\n".join(new_lines) + "\r\n" if has_fmtp else sdp

class WebRTCSession:
    """Tracks active WebRTC peer connection and subscribed audio queue."""
    def __init__(self, session_id: str, pc: RTCPeerConnection, queue: asyncio.Queue, device_id: str = ""):
        self.session_id = session_id
        self.pc = pc
        self.queue = queue
        self.device_id = device_id
        self.created_at = time.time()

webrtc_sessions: Dict[str, WebRTCSession] = {}

class WebRTCLoopbackTrack(MediaStreamTrack):
    """High-performance real-time Opus audio track for WebRTC streaming."""
    kind = "audio"

    def __init__(self, queue: asyncio.Queue, sample_rate: int = 48000, channels: int = 2):
        super().__init__()
        self.queue = queue
        self.sample_rate = sample_rate
        self.channels = channels
        self._pts = 0
        self._time_base = fractions.Fraction(1, sample_rate)
        self._buffer = bytearray()
        self.frame_samples = int(sample_rate * 0.020)  # Standard 20ms Opus frame (960 samples @ 48kHz)
        self.bytes_per_frame = self.frame_samples * self.channels * 2  # 16-bit PCM = 2 bytes/sample

    async def recv(self):
        # Discard stale audio chunks only if queue backed up significantly (>300ms)
        while self.queue.qsize() > 15:
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break

        # Accumulate exact 20ms frame bytes from loopback queue
        while len(self._buffer) < self.bytes_per_frame:
            try:
                chunk = await asyncio.wait_for(self.queue.get(), timeout=0.080)
                self._buffer.extend(chunk)
            except Exception:
                # Fill shortfall with silence if loopback capture underruns
                shortfall = self.bytes_per_frame - len(self._buffer)
                if shortfall > 0:
                    self._buffer.extend(bytes(shortfall))
                break

        data = bytes(self._buffer[:self.bytes_per_frame])
        del self._buffer[:self.bytes_per_frame]

        arr = np.frombuffer(data, dtype=np.int16).reshape(1, -1)
        frame = av.AudioFrame.from_ndarray(arr, format='s16', layout='stereo')
        frame.sample_rate = self.sample_rate
        frame.pts = self._pts
        self._pts += self.frame_samples
        frame.time_base = self._time_base
        return frame

@router.post("/webrtc/request-offer")
async def webrtc_request_offer(
    request: Request,
    current_device: PairedDevice = Depends(get_current_device)
):
    """Server generates WebRTC Offer containing PC host LAN IP for direct UDP peer connection."""
    now = time.time()
    # 1. Clean up stale or failed sessions (>30s old)
    for sid, s in list(webrtc_sessions.items()):
        if s.pc.connectionState in ("failed", "closed", "disconnected") or (s.pc.connectionState == "connecting" and now - s.created_at > 30):
            logger.info(f"Cleaning up stale WebRTC session {sid} (state={s.pc.connectionState})")
            audio_manager.unsubscribe(s.queue)
            asyncio.create_task(s.pc.close())
            webrtc_sessions.pop(sid, None)

    # 2. Terminate any previous session for this specific device
    for sid, s in list(webrtc_sessions.items()):
        if getattr(s, "device_id", "") == current_device.device_id:
            logger.info(f"Terminating existing WebRTC session {sid} for device {current_device.device_name}")
            audio_manager.unsubscribe(s.queue)
            asyncio.create_task(s.pc.close())
            webrtc_sessions.pop(sid, None)

    loop = asyncio.get_running_loop()
    queue = audio_manager.subscribe(loop)

    pc = RTCPeerConnection()
    track = WebRTCLoopbackTrack(queue, sample_rate=audio_manager.sample_rate, channels=audio_manager.channels)
    pc.addTrack(track)

    session_id = str(uuid.uuid4())
    session = WebRTCSession(session_id, pc, queue, device_id=current_device.device_id)
    webrtc_sessions[session_id] = session

    @pc.on("iceconnectionstatechange")
    def on_iceconnectionstatechange():
        logger.info(f"WebRTC audio session {session_id} iceConnectionState: {pc.iceConnectionState}")

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"WebRTC audio session {session_id} connectionState: {pc.connectionState}")
        if pc.connectionState in ["failed", "closed", "disconnected"]:
            audio_manager.unsubscribe(queue)
            await pc.close()
            webrtc_sessions.pop(session_id, None)

    offer = await pc.createOffer()
    hifi_sdp = _inject_stereo_fmtp(offer.sdp)

    # Determine PC host LAN IP reached by client
    host_header = request.headers.get("host", "")
    server_ip = host_header.split(":")[0] if host_header else None
    if not server_ip or server_ip in ("localhost", "127.0.0.1", "0.0.0.0"):
        server_ip = request.scope.get("server", [None])[0]

    # Ensure connection line points to reachable IPv4
    if server_ip and server_ip not in ("0.0.0.0", "127.0.0.1", "localhost"):
        hifi_sdp = re.sub(r'c=IN IP[46] [^\r\n]+', f'c=IN IP4 {server_ip}', hifi_sdp)

    hifi_offer = RTCSessionDescription(sdp=hifi_sdp, type=offer.type)
    await pc.setLocalDescription(hifi_offer)

    logger.info(f"Generated Hi-Fi WebRTC Offer (256kbps Stereo) for session {session_id} (Device: {current_device.device_name}, Host IP: {server_ip})")

    return {
        "sessionId": session_id,
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    }

@router.post("/webrtc/answer")
async def webrtc_audio_answer(
    request: Request,
    payload: dict,
    current_device: PairedDevice = Depends(get_current_device)
):
    """Client provides SDP Answer to establish direct WebRTC UDP stream."""
    session_id = payload.get("sessionId")
    sdp = payload.get("sdp")
    sdp_type = payload.get("type", "answer")

    if not session_id or session_id not in webrtc_sessions:
        raise HTTPException(status_code=404, detail="WebRTC session not found or expired")
    if not sdp:
        raise HTTPException(status_code=400, detail="Missing sdp")

    session = webrtc_sessions[session_id]
    client_ip = request.client.host if request.client else None
    logger.info(f"Received WebRTC Answer for session {session_id} from client IP: {client_ip}")

    # Fix mDNS .local host candidates sent by Chromium / Brave
    if client_ip and ".local" in sdp:
        logger.info(f"Replacing mDNS .local in Answer SDP with actual client IP {client_ip}")
        sdp = re.sub(
            r'(\bcandidate:[^\r\n]*\s)[a-zA-Z0-9\.\-_]+\.local(\s\d+\styp\shost\b)',
            rf'\g<1>{client_ip}\g<2>',
            sdp
        )

    # In case the client had no candidates in Answer SDP, inject fallback host candidate
    if client_ip and "a=candidate:" not in sdp:
        port_match = re.search(r'm=audio\s+(\d+)', sdp)
        if port_match:
            port = port_match.group(1)
            cand_line = f"a=candidate:1 1 udp 2122260223 {client_ip} {port} typ host\r\n"
            sdp = re.sub(r'(m=audio[^\r\n]+\r?\n)', rf'\g<1>{cand_line}', sdp)
            logger.info(f"Injected fallback host candidate {client_ip}:{port} into Answer SDP")

    await session.pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
    logger.info(f"WebRTC session {session_id} setRemoteDescription successfully applied")

    return {
        "success": True,
        "sessionId": session_id,
        "connectionState": session.pc.connectionState
    }

@router.post("/webrtc/candidate")
async def webrtc_audio_candidate(
    request: Request,
    payload: dict,
    current_device: PairedDevice = Depends(get_current_device)
):
    """Receive trickled ICE candidate from client."""
    session_id = payload.get("sessionId")
    candidate_dict = payload.get("candidate")
    if not session_id or session_id not in webrtc_sessions:
        return {"success": False, "message": "Session not found"}
    if not candidate_dict or not candidate_dict.get("candidate"):
        return {"success": True, "message": "Ignored"}

    session = webrtc_sessions[session_id]
    cand_str = candidate_dict.get("candidate", "").strip()
    if not cand_str:
        return {"success": True}

    client_ip = request.client.host if request.client else None
    if client_ip and ".local" in cand_str:
        cand_str = re.sub(
            r'(\bcandidate:[^\r\n]*\s)[a-zA-Z0-9\.\-_]+\.local(\s\d+\styp\shost\b)',
            rf'\g<1>{client_ip}\g<2>',
            cand_str
        )

    try:
        from aiortc.sdp import candidate_from_sdp
        candidate_obj = candidate_from_sdp(cand_str)
        candidate_obj.sdpMid = candidate_dict.get("sdpMid")
        candidate_obj.sdpMLineIndex = candidate_dict.get("sdpMLineIndex")
        await session.pc.addIceCandidate(candidate_obj)
        logger.debug(f"Trickle ICE candidate added for session {session_id}: {candidate_obj.ip}:{candidate_obj.port}")
    except Exception as e:
        logger.debug(f"Could not add trickle ICE candidate: {e}")

    return {"success": True}

@router.post("/webrtc/stop")
async def webrtc_audio_stop(
    payload: dict,
    current_device: PairedDevice = Depends(get_current_device)
):
    """Explicitly release WebRTC session, peer connection, and audio loopback queue."""
    session_id = payload.get("sessionId")
    if session_id and session_id in webrtc_sessions:
        session = webrtc_sessions.pop(session_id)
        audio_manager.unsubscribe(session.queue)
        await session.pc.close()
        logger.info(f"WebRTC session {session_id} cleanly closed")
        return {"success": True, "message": "Session terminated"}
    return {"success": False, "message": "Session not found"}

@router.post("/webrtc/offer")
async def webrtc_audio_offer(
    payload: dict,
    current_device: PairedDevice = Depends(get_current_device)
):
    """Legacy client-offered WebRTC endpoint."""
    sdp = payload.get("sdp")
    sdp_type = payload.get("type", "offer")
    if not sdp:
        raise HTTPException(status_code=400, detail="Missing sdp")

    loop = asyncio.get_running_loop()
    queue = audio_manager.subscribe(loop)

    pc = RTCPeerConnection()
    track = WebRTCLoopbackTrack(queue, sample_rate=audio_manager.sample_rate, channels=audio_manager.channels)
    pc.addTrack(track)

    session_id = str(uuid.uuid4())
    session = WebRTCSession(session_id, pc, queue)
    webrtc_sessions[session_id] = session

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"Legacy WebRTC audio state changed: {pc.connectionState}")
        if pc.connectionState in ["failed", "closed", "disconnected"]:
            audio_manager.unsubscribe(queue)
            await pc.close()
            webrtc_sessions.pop(session_id, None)

    await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=sdp_type))
    answer = await pc.createAnswer()
    hifi_answer_sdp = _inject_stereo_fmtp(answer.sdp)
    hifi_answer = RTCSessionDescription(sdp=hifi_answer_sdp, type=answer.type)
    await pc.setLocalDescription(hifi_answer)

    return {
        "sessionId": session_id,
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    }
