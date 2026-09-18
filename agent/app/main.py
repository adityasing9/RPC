"""RCPC Windows Agent Application Factory."""
import logging
import sys
import ctypes
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from app.config import settings
from app.logging_config import logger, audit_logger
from app.security.rate_limiter import check_rate_limit_dependency
from app.auth.pairing import pairing_manager
from app.transports.detector import detect_transports

def make_dpi_aware():
    """Enable Windows Per-Monitor DPI awareness so all screen and cursor APIs match 1:1."""
    if sys.platform.startswith("win"):
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass

make_dpi_aware()

# Routers
from app.api.auth_routes import router as auth_router
from app.api.system_routes import router as system_router
from app.api.monitoring_routes import router as monitoring_router
from app.api.network_routes import router as network_router
from app.api.media_routes import router as media_router
from app.api.files_routes import router as files_router
from app.api.apps_routes import router as apps_router
from app.api.clipboard_routes import router as clipboard_router
from app.api.input_routes import router as input_router
from app.api.screenshot_routes import router as screenshot_router
from app.api.activity_routes import router as activity_router
from app.api.websocket_routes import router as websocket_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    logger.info("=" * 60)
    logger.info("   RCPC — Remote Control & PC Management Platform")
    logger.info("   Windows Agent v" + settings.version)
    logger.info("=" * 60)
    
    code_info = pairing_manager.get_current_code_info()
    transports = detect_transports()
    
    logger.info(f"[*] Pairing Code:  >>> {code_info['code']} <<<")
    logger.info(f"[*] Code Validity: {code_info['expires_in_seconds']} seconds")
    
    if transports.get("wifi", {}).get("ips"):
        for ip in transports["wifi"]["ips"]:
            logger.info(f"[*] Local LAN URL:   http://{ip}:{settings.port}")
    if transports.get("tailscale", {}).get("ip"):
        logger.info(f"[*] Tailscale URL:   http://{transports['tailscale']['ip']}:{settings.port}")
    logger.info("=" * 60)
    
    audit_logger.log_action(action="agent.started", result="SUCCESS", metadata={"version": settings.version})
    
    yield
    
    # Shutdown
    logger.info("RCPC Windows Agent is shutting down...")
    audit_logger.log_action(action="agent.stopped", result="SUCCESS")

def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version=settings.version,
        description="Secure Windows PC Management & Remote Control API",
        lifespan=lifespan
    )

    # CORS configuration
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Mount API Routers
    app.include_router(auth_router)
    app.include_router(system_router)
    app.include_router(monitoring_router)
    app.include_router(network_router)
    app.include_router(media_router)
    app.include_router(files_router)
    app.include_router(apps_router)
    app.include_router(clipboard_router)
    app.include_router(input_router)
    app.include_router(screenshot_router)
    app.include_router(activity_router)
    app.include_router(websocket_router)

    @app.middleware("http")
    async def add_private_network_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    @app.get("/health")
    async def health_check():
        return {
            "status": "healthy",
            "agent": "RCPC Windows Agent",
            "version": settings.version
        }

    # Mount Frontend PWA Static Files if built
    dist_dir = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"
    if dist_dir.exists() and (dist_dir / "index.html").exists():
        app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="frontend")

    return app

app = create_app()
