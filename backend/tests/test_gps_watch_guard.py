import asyncio
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

    async def test_batch_preflight_rejects_busy_member_before_any_delivery(self):
        idle = SimpleNamespace(state=SimulationState.IDLE)
        busy = SimpleNamespace(state=SimulationState.NAVIGATING)
        deliver = AsyncMock()

        with (
            patch.object(location_api, "_engine", AsyncMock(side_effect=[idle, busy])),
            patch.object(location_api, "teleport", deliver),
        ):
            with self.assertRaises(HTTPException) as caught:
                await location_api.teleport_batch(location_api.BatchTeleportRequest(
                    lat=25.033,
                    lng=121.5654,
                    udids=["phone-a", "phone-b"],
                ))

        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail["code"], "group_not_idle")
        deliver.assert_not_awaited()

    async def test_batch_launches_all_members_in_parallel_and_aggregates(self):
        engines = [SimpleNamespace(state=SimulationState.IDLE) for _ in range(2)]
        started = 0
        maximum = 0
        both_started = asyncio.Event()

        async def deliver(_request):
            nonlocal started, maximum
            started += 1
            maximum = max(maximum, started)
            if started == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=0.5)
            started -= 1
            return {"status": "ok"}

        with (
            patch.object(location_api, "_engine", AsyncMock(side_effect=engines)),
            patch.object(location_api, "teleport", side_effect=deliver),
        ):
            result = await location_api.teleport_batch(location_api.BatchTeleportRequest(
                lat=25.033,
                lng=121.5654,
                udids=["phone-a", "phone-b"],
            ))

        self.assertEqual(maximum, 2)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["ok"], ["phone-a", "phone-b"])
        self.assertEqual(result["failed"], [])


if __name__ == "__main__":
    unittest.main()
