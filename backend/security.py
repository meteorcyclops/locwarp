"""Local desktop API boundary for LocWarp.

The backend also serves the optional phone remote on the LAN, so binding only
to loopback would break that feature.  Instead, desktop APIs are restricted to
loopback clients and authenticated with an ephemeral token supplied by the
Electron parent process.  Phone routes keep their existing PIN/token scheme.
"""

from __future__ import annotations

import hmac
import ipaddress
import os

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send


DESKTOP_TOKEN_HEADER = "x-locwarp-desktop-token"
DESKTOP_TOKEN = os.environ.get("LOCWARP_DESKTOP_TOKEN", "")
ALLOW_INSECURE_LOCAL = os.environ.get("LOCWARP_ALLOW_INSECURE_LOCAL") == "1"

PUBLIC_HTTP_PATHS = {"/healthz", "/phone", "/_reach"}
PHONE_PREFIX = "/api/phone"


def is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    # ASGI normally gives an address without brackets, but accepting them
    # makes this helper robust for hand-built test scopes and IPv6 literals.
    candidate = host.strip("[]")
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return candidate.lower() == "localhost"


def token_matches(candidate: str | None) -> bool:
    if not DESKTOP_TOKEN:
        return False
    return hmac.compare_digest(candidate or "", DESKTOP_TOKEN)


def is_phone_path(path: str) -> bool:
    return path == PHONE_PREFIX or path.startswith(PHONE_PREFIX + "/")


class DesktopApiSecurityMiddleware:
    """Protect desktop routes while preserving the authenticated phone UI."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path in PUBLIC_HTTP_PATHS or is_phone_path(path):
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        client_host = client[0] if client else None
        if not is_loopback_host(client_host):
            response = JSONResponse(
                {"detail": {"code": "desktop_api_local_only"}}, status_code=403
            )
            await response(scope, receive, send)
            return

        if ALLOW_INSECURE_LOCAL:
            await self.app(scope, receive, send)
            return

        supplied = Headers(scope=scope).get(DESKTOP_TOKEN_HEADER)
        if not DESKTOP_TOKEN:
            response = JSONResponse(
                {"detail": {"code": "desktop_api_not_configured"}}, status_code=503
            )
            await response(scope, receive, send)
            return
        if not token_matches(supplied):
            response = JSONResponse(
                {"detail": {"code": "desktop_api_unauthorized"}}, status_code=401
            )
            await response(scope, receive, send)
            return

        await self.app(scope, receive, send)
