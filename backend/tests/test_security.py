import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import security
import api.websocket as websocket_api
from security import DesktopApiSecurityMiddleware


class DesktopApiSecurityTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.add_middleware(DesktopApiSecurityMiddleware)

        @app.get("/api/desktop")
        async def desktop():
            return {"ok": True}

        @app.post("/api/phone/auth")
        async def phone_auth():
            return {"phone": True}

        @app.get("/healthz")
        async def health():
            return {"status": "ok"}

        self.client = TestClient(app)

    def test_health_probe_is_public(self):
        with patch.object(security, "is_loopback_host", return_value=False):
            self.assertEqual(self.client.get("/healthz").status_code, 200)

    def test_phone_routes_preserve_lan_access(self):
        with patch.object(security, "is_loopback_host", return_value=False):
            response = self.client.post("/api/phone/auth")
        self.assertEqual(response.status_code, 200)

    def test_desktop_api_rejects_non_loopback(self):
        with (
            patch.object(security, "is_loopback_host", return_value=False),
            patch.object(security, "DESKTOP_TOKEN", "correct"),
        ):
            response = self.client.get(
                "/api/desktop", headers={"X-LocWarp-Desktop-Token": "correct"}
            )
        self.assertEqual(response.status_code, 403)

    def test_desktop_api_requires_matching_session_token(self):
        with (
            patch.object(security, "is_loopback_host", return_value=True),
            patch.object(security, "DESKTOP_TOKEN", "correct"),
            patch.object(security, "ALLOW_INSECURE_LOCAL", False),
        ):
            denied = self.client.get(
                "/api/desktop", headers={"X-LocWarp-Desktop-Token": "wrong"}
            )
            allowed = self.client.get(
                "/api/desktop", headers={"X-LocWarp-Desktop-Token": "correct"}
            )
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200)
class WebSocketSecurityTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.include_router(websocket_api.router)
        self.client = TestClient(app)

    def test_websocket_rejects_missing_token(self):
        with (
            patch.object(websocket_api, "is_loopback_host", return_value=True),
            patch.object(websocket_api, "token_matches", return_value=False),
            patch.object(websocket_api, "ALLOW_INSECURE_LOCAL", False),
        ):
            with self.assertRaises(WebSocketDisconnect) as caught:
                with self.client.websocket_connect("/ws/status"):
                    pass
        self.assertEqual(caught.exception.code, 1008)

    def test_websocket_accepts_valid_token(self):
        with (
            patch.object(websocket_api, "is_loopback_host", return_value=True),
            patch.object(websocket_api, "token_matches", return_value=True),
            patch.object(websocket_api, "ALLOW_INSECURE_LOCAL", False),
        ):
            with self.client.websocket_connect(
                "/ws/status", subprotocols=["locwarp.correct"]
            ) as socket:
                socket.send_text("not-json")


if __name__ == "__main__":
    unittest.main()
