import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

import api.device as device_api

from api.device import (
    WifiTunnelFindPortRequest,
    WifiTunnelStartRequest,
    _build_tunnel_udid_candidates,
    _build_tunnel_port_candidates,
    _filter_remotepairing_ports,
    wifi_tunnel_find_port,
    wifi_tunnel_start,
)


class _FakeRunner:
    attempts = []
    timeout_ports = set()

    def __init__(self):
        self.target_ip = None
        self.target_port = None
        self.info = None
        self._running = False

    def is_running(self):
        return self._running

    async def start(self, udid, ip, port, timeout):
        type(self).attempts.append((udid, port, timeout))
        self.target_ip = ip
        self.target_port = port
        if port in type(self).timeout_ports:
            raise asyncio.TimeoutError()
        self._running = True
        self.info = {"rsd_address": "fd00::1", "rsd_port": 12345}
        return self.info


class WifiPortCandidateTests(unittest.TestCase):
    def test_filters_lockdownd_port_without_reordering_candidates(self):
        self.assertEqual(
            _filter_remotepairing_ports([62078, 49152, 54321, 62078]),
            [49152, 54321],
        )

    def test_builds_unique_valid_candidates_with_requested_port_first(self):
        request = WifiTunnelStartRequest(
            ip="192.0.2.10",
            port=55000,
            ports=[62078, 55000, 56000, 0, 65536],
        )

        self.assertEqual(_build_tunnel_port_candidates(request), [55000, 56000])

    def test_known_wrong_primary_can_fall_back_to_discovered_ports(self):
        request = WifiTunnelStartRequest(
            ip="192.0.2.10",
            port=62078,
            ports=[62078, 57000],
        )

        self.assertEqual(_build_tunnel_port_candidates(request), [57000])

    def test_explicit_udid_is_strict_and_does_not_try_other_pair_records(self):
        """A pinned identity must never be silently replaced after an IP rebind."""
        request = WifiTunnelStartRequest(
            ip="192.0.2.10",
            port=55000,
            udid="phone-requested",
        )

        # The helper returns before consulting DeviceManager/pair-record
        # discovery. This patch makes the test fail if a future refactor
        # accidentally starts probing other cached identities again.
        with patch.object(device_api, "_dm", side_effect=AssertionError("strict UDID must not enumerate fallbacks")):
            self.assertEqual(
                _build_tunnel_udid_candidates(request),
                ["phone-requested"],
            )


class WifiPortFlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        device_api.begin_wifi_tunnel_lifecycle()
        device_api._tunnels.clear()
        device_api._tunnel_watchdogs.clear()
        device_api._tunnel_target_locks.clear()
        device_api._tunnel_start_cancellations.clear()
        device_api._tunnel_start_runners.clear()
        _FakeRunner.attempts = []
        _FakeRunner.timeout_ports = set()

    def tearDown(self):
        device_api._tunnels.clear()
        device_api._tunnel_watchdogs.clear()
        device_api._tunnel_target_locks.clear()
        device_api._tunnel_start_cancellations.clear()
        device_api._tunnel_start_runners.clear()

    async def test_timeout_moves_to_next_port_without_retrying_every_udid(self):
        _FakeRunner.timeout_ports = {51000}
        scan = AsyncMock(return_value=[])
        request = WifiTunnelStartRequest(
            ip="192.0.2.10",
            port=51000,
            ports=[52000],
        )

        with (
            patch.object(device_api, "TunnelRunner", _FakeRunner),
            patch.object(device_api, "_build_tunnel_udid_candidates", return_value=["phone-a", "phone-b"]),
            patch.object(device_api, "_scan_ports_for_ip", scan),
            patch.object(device_api, "_per_tunnel_watchdog", new=lambda *args: None),
            patch.object(device_api.asyncio, "create_task", return_value=object()),
        ):
            result = await wifi_tunnel_start(request)

        self.assertEqual(result["port"], 52000)
        self.assertEqual(
            [(udid, port) for udid, port, _ in _FakeRunner.attempts],
            [("phone-a", 51000), ("phone-a", 52000)],
        )
        scan.assert_not_awaited()

    async def test_exhausted_known_ports_rescans_and_uses_fresh_port(self):
        _FakeRunner.timeout_ports = {51000}
        scan = AsyncMock(return_value=[62078, 53000])
        request = WifiTunnelStartRequest(ip="192.0.2.10", port=51000)

        with (
            patch.object(device_api, "TunnelRunner", _FakeRunner),
            patch.object(device_api, "_build_tunnel_udid_candidates", return_value=["phone"]),
            patch.object(device_api, "_scan_ports_for_ip", scan),
            patch.object(device_api, "_per_tunnel_watchdog", new=lambda *args: None),
            patch.object(device_api.asyncio, "create_task", return_value=object()),
        ):
            result = await wifi_tunnel_start(request)

        self.assertEqual(result["port"], 53000)
        self.assertEqual([port for _, port, _ in _FakeRunner.attempts], [51000, 53000])
        scan.assert_awaited_once_with("192.0.2.10")

    async def test_manual_port_scan_drops_known_lockdownd_port(self):
        scan = AsyncMock(return_value=[62078, 54000])

        with patch.object(device_api, "_scan_ports_for_ip", scan):
            result = await wifi_tunnel_find_port(WifiTunnelFindPortRequest(ip="192.0.2.10"))

        self.assertEqual(result, {"ip": "192.0.2.10", "ports": [54000]})

    async def test_full_range_scanner_bounds_scheduled_probe_concurrency(self):
        active = 0
        maximum = 0

        async def probe(_ip, port, _timeout):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            await asyncio.sleep(0)
            active -= 1
            return port in {3, 17}

        with patch.object(device_api, "_tcp_probe", side_effect=probe):
            hits = await device_api._scan_ports_for_ip(
                "192.0.2.10",
                start=1,
                end=20,
                concurrency=4,
            )

        self.assertEqual(hits, [3, 17])
        self.assertLessEqual(maximum, 4)

    async def test_different_devices_handshake_in_parallel_and_publish_canonical_ids(self):
        class ParallelRunner(_FakeRunner):
            started = 0
            maximum = 0
            both_started = asyncio.Event()

            async def start(self, udid, ip, port, timeout):
                type(self).started += 1
                type(self).maximum = max(type(self).maximum, type(self).started)
                if type(self).started == 2:
                    type(self).both_started.set()
                await asyncio.wait_for(type(self).both_started.wait(), timeout=0.5)
                self.target_ip = ip
                self.target_port = port
                self._running = True
                self.info = {
                    "udid": udid.upper(),
                    "rsd_address": "fd00::1",
                    "rsd_port": 12345,
                }
                type(self).started -= 1
                return self.info

        requests = [
            WifiTunnelStartRequest(ip="192.0.2.10", port=52000, udid="phone-a"),
            WifiTunnelStartRequest(ip="192.0.2.11", port=52001, udid="phone-b"),
        ]
        with (
            patch.object(device_api, "TunnelRunner", ParallelRunner),
            patch.object(device_api, "_per_tunnel_watchdog", new=lambda *args: None),
            patch.object(device_api.asyncio, "create_task", return_value=object()),
        ):
            results = await asyncio.gather(*(wifi_tunnel_start(req) for req in requests))

        self.assertEqual(ParallelRunner.maximum, 2)
        self.assertEqual({result["udid"] for result in results}, {"PHONE-A", "PHONE-B"})
        self.assertEqual(set(device_api._tunnels), {"phone-a", "phone-b"})

    async def test_same_target_start_is_idempotent_under_transaction_lock(self):
        request = WifiTunnelStartRequest(
            ip="192.0.2.10",
            port=52000,
            udid="PHONE-A",
        )
        with (
            patch.object(device_api, "TunnelRunner", _FakeRunner),
            patch.object(device_api, "_per_tunnel_watchdog", new=lambda *args: None),
            patch.object(device_api.asyncio, "create_task", return_value=object()),
        ):
            results = await asyncio.gather(
                wifi_tunnel_start(request),
                wifi_tunnel_start(request),
            )

        self.assertEqual({result["status"] for result in results}, {"started", "already_running"})
        self.assertEqual(len(_FakeRunner.attempts), 1)

    async def test_capacity_race_never_publishes_a_fourth_worker(self):
        class FourWayRunner(_FakeRunner):
            started = 0
            all_started = asyncio.Event()

            async def start(self, udid, ip, port, timeout):
                type(self).started += 1
                if type(self).started == 4:
                    type(self).all_started.set()
                await asyncio.wait_for(type(self).all_started.wait(), timeout=0.5)
                self.target_ip = ip
                self.target_port = port
                self._running = True
                self.info = {"udid": udid, "rsd_address": "fd00::1", "rsd_port": 12345}
                return self.info

            async def stop(self):
                self._running = False

        requests = [
            WifiTunnelStartRequest(ip=f"192.0.2.{20 + index}", port=53000 + index, udid=f"phone-{index}")
            for index in range(4)
        ]
        with (
            patch.object(device_api, "TunnelRunner", FourWayRunner),
            patch.object(device_api, "_per_tunnel_watchdog", new=lambda *args: None),
            patch.object(device_api.asyncio, "create_task", return_value=object()),
        ):
            results = await asyncio.gather(
                *(wifi_tunnel_start(req) for req in requests),
                return_exceptions=True,
            )

        self.assertEqual(len(device_api._tunnels), 3)
        rejected = [item for item in results if isinstance(item, HTTPException)]
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0].status_code, 409)

    async def test_cancelled_start_stops_unpublished_runner_and_clears_tracking(self):
        class BlockingRunner(_FakeRunner):
            started = asyncio.Event()
            stopped = asyncio.Event()

            async def start(self, udid, ip, port, timeout):
                self.target_ip = ip
                self.target_port = port
                type(self).started.set()
                await asyncio.Event().wait()

            async def stop(self):
                self._running = False
                type(self).stopped.set()

        request = WifiTunnelStartRequest(
            ip="192.0.2.10",
            port=52000,
            udid="PHONE-A",
        )
        with (
            patch.object(device_api, "TunnelRunner", BlockingRunner),
            patch.object(device_api, "_per_tunnel_watchdog", new=lambda *args: None),
        ):
            task = asyncio.create_task(wifi_tunnel_start(request))
            await asyncio.wait_for(BlockingRunner.started.wait(), timeout=0.5)
            self.assertIn("udid:phone-a", device_api._tunnel_start_runners)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.wait_for(BlockingRunner.stopped.wait(), timeout=0.5)

        self.assertEqual(device_api._tunnel_start_runners, {})


if __name__ == "__main__":
    unittest.main()
