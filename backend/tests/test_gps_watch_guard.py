import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import api.location as location_api
from models.schemas import SimulationState, TeleportRequest


class GpsWatchTeleportGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_require_idle_rejects_active_route_without_teleporting(self):
        engine = SimpleNamespace(
            state=SimulationState.NAVIGATING,
            current_position=None,
            teleport=AsyncMock(),
        )
        app_state = SimpleNamespace(simulation_engines={"phone": engine}, _primary_udid="phone")
        cooldown = SimpleNamespace(enabled=False, is_active=False, remaining=0)

        with (
            patch.object(location_api, "_engine", AsyncMock(return_value=engine)),
            patch.object(location_api, "_cooldown", return_value=cooldown),
            patch.dict(sys.modules, {"main": SimpleNamespace(app_state=app_state)}),
        ):
            with self.assertRaises(HTTPException) as caught:
                await location_api.teleport(TeleportRequest(
                    lat=25.033,
                    lng=121.5654,
                    udid="phone",
                    require_idle=True,
                ))

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail["code"], "simulation_not_idle")
        engine.teleport.assert_not_awaited()

    async def test_manual_teleport_keeps_existing_non_idle_behavior(self):
        engine = SimpleNamespace(
            state=SimulationState.NAVIGATING,
            current_position=None,
            teleport=AsyncMock(),
        )
        app_state = SimpleNamespace(simulation_engines={"phone": engine}, _primary_udid="phone")
        cooldown = SimpleNamespace(enabled=False, is_active=False, remaining=0)

        with (
            patch.object(location_api, "_engine", AsyncMock(return_value=engine)),
            patch.object(location_api, "_cooldown", return_value=cooldown),
            patch.dict(sys.modules, {"main": SimpleNamespace(app_state=app_state)}),
        ):
            result = await location_api.teleport(TeleportRequest(
                lat=25.033,
                lng=121.5654,
                udid="phone",
            ))

        self.assertEqual(result["status"], "ok")
        engine.teleport.assert_awaited_once_with(25.033, 121.5654)


if __name__ == "__main__":
    unittest.main()
