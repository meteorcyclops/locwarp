import asyncio
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import api.device as device_api
import api.location as location_api
from core.device_manager import DeviceManager, _ActiveConnection
from services.location_service import DeviceLostError


class WifiLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        device_api.begin_wifi_tunnel_lifecycle()
        device_api._tunnels.clear()
        device_api._tunnel_watchdogs.clear()
        device_api._tunnel_target_locks.clear()
        device_api._tunnel_start_cancellations.clear()
        device_api._tunnel_start_runners.clear()

    async def test_shutdown_detaches_watchdogs_and_stops_unadopted_worker(self):
        runner = SimpleNamespace(info={"udid": "Phone-A"}, stop=AsyncMock())
        watchdog = asyncio.create_task(asyncio.sleep(60))
        device_api._tunnels["phone-a"] = runner
        device_api._tunnel_watchdogs["phone-a"] = watchdog

        await device_api.shutdown_wifi_tunnels()

        self.assertTrue(device_api._tunnel_shutting_down)
        self.assertEqual(device_api._tunnels, {})
        self.assertEqual(device_api._tunnel_watchdogs, {})
        self.assertTrue(watchdog.cancelled())
        runner.stop.assert_awaited_once()

    async def test_explicit_secondary_recovery_returns_secondary_engine(self):
        primary = object()
        secondary = object()
        engines = {"PHONE-A": primary}

        async def create_engine(udid):
            engines[udid] = secondary

        app_state = SimpleNamespace(
            simulation_engines=engines,
            simulation_engine=primary,
            _primary_udid="PHONE-A",
            device_manager=SimpleNamespace(_connections={"PHONE-B": object()}),
            get_engine=lambda udid: engines.get(udid) if udid else primary,
            create_engine_for_device=create_engine,
        )
        with patch.dict(sys.modules, {"main": SimpleNamespace(app_state=app_state)}):
            recovered = await location_api._recover_engine("phone-b")

        self.assertIs(recovered, secondary)
        self.assertIsNot(recovered, primary)

    async def test_worker_connection_never_constructs_dvt_provider_with_none(self):
        manager = DeviceManager()
        manager._connections["phone-a"] = _ActiveConnection(
            udid="phone-a",
            lockdown=None,
            ios_version="18.0",
            connection_type="Network",
            worker=object(),
            external_location_service=True,
        )

        with self.assertRaises(DeviceLostError) as caught:
            await manager.get_fresh_dvt_provider("phone-a", timeout=0.1)

        self.assertEqual(caught.exception.reason, DeviceLostError.REASON_TUNNEL_DEAD)

    async def test_full_reconnect_uses_case_insensitive_network_target(self):
        manager = DeviceManager()
        manager._connections["phone-a"] = _ActiveConnection(
            udid="phone-a",
            lockdown=None,
            ios_version="18.0",
            connection_type="Network",
        )
        runner = SimpleNamespace(
            target_ip="192.0.2.41",
            target_port=54321,
        )
        restart = AsyncMock(return_value=True)
        with (
            patch.dict(device_api._tunnels, {"phone-a": runner}, clear=True),
            patch.object(device_api, "_attempt_tunnel_restart", restart),
        ):
            self.assertTrue(await manager.full_reconnect("PHONE-A"))

        restart.assert_awaited_once_with(
            "phone-a", "192.0.2.41", 54321, None, runner,
        )

    async def test_cancelled_start_and_connect_stops_newly_started_worker(self):
        runner = SimpleNamespace(
            info={"udid": "phone-a"},
            target_ip="192.0.2.41",
            target_port=54321,
            is_running=lambda: True,
            stop=AsyncMock(),
        )
        device_api._tunnels["phone-a"] = runner
        connect_started = asyncio.Event()

        class BlockingDeviceManager:
            _connections = {}

            async def connect_wifi_tunnel(self, *args, **kwargs):
                connect_started.set()
                await asyncio.Event().wait()

        app_state = SimpleNamespace(
            simulation_engines={},
            _primary_udid=None,
            create_engine_for_device=AsyncMock(),
        )
        start_result = {
            "status": "started",
            "udid": "phone-a",
            "port": 54321,
            "rsd_address": "fd00::1",
            "rsd_port": 12345,
        }
        req = device_api.WifiTunnelStartRequest(
            ip="192.0.2.41",
            port=54321,
            udid="phone-a",
        )
        with (
            patch.object(device_api, "_wifi_tunnel_start_impl", AsyncMock(return_value=start_result)),
            patch.object(device_api, "_dm", return_value=BlockingDeviceManager()),
            patch.dict(sys.modules, {"main": SimpleNamespace(app_state=app_state)}),
        ):
            task = asyncio.create_task(device_api.wifi_tunnel_start_and_connect(req))
            await asyncio.wait_for(connect_started.wait(), timeout=0.5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        runner.stop.assert_awaited_once()
        self.assertEqual(device_api._tunnels, {})

    async def test_same_target_start_and_connect_serializes_full_transaction(self):
        active = 0
        maximum = 0

        async def transaction(_req, _target_key):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            await asyncio.sleep(0.01)
            active -= 1
            return {"status": "connected", "udid": "phone-a"}

        req = device_api.WifiTunnelStartRequest(
            ip="192.0.2.41",
            port=54321,
            udid="PHONE-A",
        )
        with patch.object(
            device_api,
            "_wifi_tunnel_start_and_connect_impl",
            side_effect=transaction,
        ):
            results = await asyncio.gather(
                device_api.wifi_tunnel_start_and_connect(req),
                device_api.wifi_tunnel_start_and_connect(req),
                device_api.wifi_tunnel_start_and_connect(req),
            )

        self.assertEqual(maximum, 1)
        self.assertEqual([item["udid"] for item in results], ["phone-a"] * 3)

    async def test_explicit_wifi_connect_auto_syncs_fresh_device_to_primary(self):
        runner = SimpleNamespace(
            rsd=object(),
            is_running=lambda: True,
        )
        device_api._tunnels["phone-b"] = runner
        info = SimpleNamespace(
            udid="phone-b",
            name="Phone B",
            ios_version="18.0",
        )
        manager = SimpleNamespace(
            _connections={},
            connect_wifi_tunnel=AsyncMock(return_value=info),
        )
        auto_sync = AsyncMock()
        app_state = SimpleNamespace(
            simulation_engines={"phone-a": object()},
            _primary_udid="phone-a",
            create_engine_for_device=AsyncMock(),
        )
        start_result = {
            "status": "started",
            "udid": "phone-b",
            "port": 54321,
            "rsd_address": "fd00::2",
            "rsd_port": 12346,
        }
        req = device_api.WifiTunnelStartRequest(
            ip="192.0.2.42",
            port=54321,
            udid="phone-b",
        )

        with (
            patch.object(device_api, "_wifi_tunnel_start_impl", AsyncMock(return_value=start_result)),
            patch.object(device_api, "_dm", return_value=manager),
            patch("api.websocket.broadcast", new_callable=AsyncMock),
            patch.dict(
                sys.modules,
                {"main": SimpleNamespace(
                    app_state=app_state,
                    _auto_sync_new_device_to_primary=auto_sync,
                )},
            ),
        ):
            result = await device_api._wifi_tunnel_start_and_connect_impl(req, "phone-b")

        self.assertEqual(result["status"], "connected")
        app_state.create_engine_for_device.assert_awaited_once_with("phone-b")
        auto_sync.assert_awaited_once_with("phone-b")

    async def test_cancel_after_publish_removes_owned_worker_and_watchdog(self):
        publish_reached = asyncio.Event()

        class Runner:
            def __init__(self):
                self.info = None
                self.udid = None
                self.target_ip = None
                self.target_port = None
                self._running = False
                self.stop = AsyncMock(side_effect=self._stop)

            async def _stop(self):
                self._running = False

            async def start(self, udid, ip, port, timeout):
                self.udid = udid
                self.target_ip = ip
                self.target_port = port
                self._running = True
                self.info = {
                    "udid": udid,
                    "rsd_address": "fd00::1",
                    "rsd_port": 12345,
                }
                return self.info

            def is_running(self):
                return self._running

        untrack_calls = 0

        async def block_after_publish(target_key, runner):
            nonlocal untrack_calls
            untrack_calls += 1
            if untrack_calls == 1:
                publish_reached.set()
                await asyncio.Event().wait()
            if device_api._tunnel_start_runners.get(target_key) is runner:
                device_api._tunnel_start_runners.pop(target_key, None)

        async def watchdog(*_args):
            await asyncio.Event().wait()

        app_state = SimpleNamespace(
            simulation_engines={},
            _primary_udid=None,
        )
        req = device_api.WifiTunnelStartRequest(
            ip="192.0.2.41",
            port=54321,
            udid="phone-a",
        )
        with (
            patch.object(device_api, "TunnelRunner", Runner),
            patch.object(device_api, "_untrack_start_runner", side_effect=block_after_publish),
            patch.object(device_api, "_per_tunnel_watchdog", side_effect=watchdog),
            patch.dict(sys.modules, {"main": SimpleNamespace(app_state=app_state)}),
        ):
            task = asyncio.create_task(device_api.wifi_tunnel_start_and_connect(req))
            await asyncio.wait_for(publish_reached.wait(), timeout=0.5)
            self.assertIn("phone-a", device_api._tunnels)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        self.assertEqual(device_api._tunnels, {})
        self.assertEqual(device_api._tunnel_watchdogs, {})
        self.assertEqual(device_api._tunnel_start_runners, {})


if __name__ == "__main__":
    unittest.main()
