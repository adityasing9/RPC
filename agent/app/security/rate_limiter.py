"""Rate limiting middleware and utility for RCPC Agent."""
import time
from collections import defaultdict
from typing import Dict, List, Optional
from fastapi import Request, WebSocket, HTTPException, status
from app.config import settings

class RateLimiter:
    """Sliding-window in-memory rate limiter."""
    def __init__(self, requests_per_minute: int = 120):
        self.rpm = requests_per_minute
        self.requests: Dict[str, List[float]] = defaultdict(list)

    def check_rate_limit(self, client_key: str):
        now = time.time()
        window_start = now - 60.0
        
        # Prune old timestamps
        timestamps = [t for t in self.requests[client_key] if t > window_start]
        self.requests[client_key] = timestamps
        
        if len(timestamps) >= self.rpm:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded. Maximum {self.rpm} requests per minute."
            )
            
        self.requests[client_key].append(now)

rate_limiter = RateLimiter(requests_per_minute=settings.rate_limit_per_minute)

async def check_rate_limit_dependency(
    request: Optional[Request] = None,
    websocket: Optional[WebSocket] = None
):
    """Dependency to check rate limit on incoming HTTP requests."""
    # Exclude persistent WebSocket connections from standard HTTP rate limits
    if websocket is not None:
        return
    if request is not None and request.client:
        client_ip = request.client.host
        rate_limiter.check_rate_limit(client_ip)

