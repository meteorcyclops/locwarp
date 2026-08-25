import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pymobiledevice3.remote.remote_service_discovery as rsd_module
import pymobiledevice3.remote.tunnel_service as tunnel_service
import pymobiledevice3.remote.userspace_tunnel as userspace_module

from core.device_manager import DeviceManager
from core.wifi_tunnel import TunnelRunner


class _FakeTun:
    def __init__(self):
        self.peer = None

    def set_peer(self, address):
        self.peer = address


class _FakeClient:
    def __init__(self, tun):
        self.tun = tun
        self.closed = asyncio.Event()

    async def wait_closed(self):
        await self.closed.wait()


class _FakeTunnelContext:
    def __init__(self, result, events):
        self.result = result
        self.events = events

    async def __aenter__(self):
        self.events.append("tunnel_enter")
        return self.result

    async def __aexit__(self, exc_type, exc, traceback):
        self.events.append("tunnel_exit")


class _FakeService:
    remote_identifier = "phone"

    def __init__(self, result, events):
        self._context = _FakeTunnelContext(result, events)
        self.events = events

    def start_tcp_tunnel(self):
        return self._context

    async def close(self):
        self.events.append("service_close")


class _FakeDialPlane:
    instances = []

    def __init__(self, tun, address):
        self.tun = tun
        self.address = address
        self.events = None
        type(self).instances.append(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return None

    async def dial(self, host=None, port=None, **kwargs):
        raise AssertionError("unit test does not open a real relay")


class _FakeRsd:
    instances = []

    def __init__(self, service, open_connection=None):
        self.service = SimpleNamespace(address=service)
        self.open_connection = open_connection
        self.peer_info = {
            "Properties": {
                "UniqueDeviceID": "phone",
                "OSVersion": "18.6",
                "DeviceClass": "iPhone",
            }
        }
        self.all_values = {"DeviceName": "Test iPhone"}
        self.connect_count = 0
        self.close_count = 0
        type(self).instances.append(self)

    async def connect(self):
        self.connect_count += 1

    async def close(self):
        self.close_count += 1


class UserspaceWifiRunnerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old_owner = getattr(userspace_module, "_active_tunnel", None)
        self.old_active = userspace_module.USERSPACE_ACTIVE
        self.old_factory = tunnel_service.USE_USERSPACE_TUNNEL
        userspace_module._active_tunnel = None
        userspace_module.USERSPACE_ACTIVE = False
        tunnel_service.USE_USERSPACE_TUNNEL = False
        _FakeDialPlane.instances.clear()
        _FakeRsd.instances.clear()

    async def asyncTearDown(self):
        userspace_module._active_tunnel = self.old_owner
        userspace_module.USERSPACE_ACTIVE = self.old_active
        tunnel_service.USE_USERSPACE_TUNNEL = self.old_factory

    async def test_runner_builds_rsd_on_userspace_dial_plane_and_cleans_up(self):
        events = []
        tun = _FakeTun()
        client = _FakeClient(tun)
        result = SimpleNamespace(
            address="fd00::1",
            port=12345,
            interface="utun-userspace",
            protocol="tcp",
            client=client,
        )
        service = _FakeService(result, events)
        create_service = AsyncMock(return_value=service)
        runner = TunnelRunner()

        with (
            patch.object(tunnel_service, "create_core_device_tunnel_service_using_remotepairing", create_service),
            patch.object(userspace_module, "UserspaceDialPlane", _FakeDialPlane),
            patch.object(rsd_module, "RemoteServiceDiscoveryService", _FakeRsd),
            patch("core.wifi_tunnel.sys.platform", "darwin"),
        ):
            info = await runner.start("phone", "192.0.2.10", 49152)
            self.assertEqual(info["interface"], "utun-userspace")
            self.assertEqual(tun.peer, "fd00::1")
            self.assertIs(runner.tun, tun)
            self.assertIs(userspace_module._active_tunnel, runner)
            self.assertTrue(tunnel_service.USE_USERSPACE_TUNNEL)
            self.assertEqual(len(_FakeRsd.instances), 1)
            self.assertIs(
                _FakeRsd.instances[0].open_connection.__self__,
                _FakeDialPlane.instances[0],
            )

            await runner.stop()

        self.assertIsNone(runner.rsd)
        self.assertIsNone(userspace_module._active_tunnel)
        self.assertFalse(tunnel_service.USE_USERSPACE_TUNNEL)
        self.assertEqual(_FakeRsd.instances[0].close_count, 1)
        self.assertEqual(events[-2:], ["tunnel_exit", "service_close"])


class ExistingRsdOwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def test_device_manager_adopts_runner_rsd_without_reconnect_or_close(self):
        rsd = _FakeRsd(("fd00::1", 12345), open_connection=object())
        manager = DeviceManager()

        info = await manager.connect_wifi_tunnel(
            "fd00::1",
            12345,
            existing_rsd=rsd,
        )

        self.assertEqual(info.udid, "phone")
        self.assertEqual(rsd.connect_count, 0)
        self.assertFalse(manager._connections["phone"].owns_rsd)

        await manager.disconnect("phone", clear_location=False)
        self.assertEqual(rsd.close_count, 0)


if __name__ == "__main__":
    unittest.main()
