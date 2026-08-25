import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import api.device as device_api

from api.device import (
    WifiTunnelFindPortRequest,
    WifiTunnelStartRequest,
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


class WifiPortFlowTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        device_api._tunnels.clear()
        device_api._tunnel_watchdogs.clear()
        _FakeRunner.attempts = []
        _FakeRunner.timeout_ports = set()

    def tearDown(self):
        device_api._tunnels.clear()
        device_api._tunnel_watchdogs.clear()

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


if __name__ == "__main__":
    unittest.main()
