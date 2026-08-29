import asyncio
import io
import json
import sys
import unittest
from unittest.mock import AsyncMock, patch

from core.wifi_worker import WifiTunnelWorker, WifiWorkerLocationService, WifiWorkerRunner, worker_main
from core.device_manager import DeviceManager
from services.location_service import DeviceLostError


class _FakeClient:
    def __init__(self):
        self.closed = asyncio.Event()

    async def wait_closed(self):
        await self.closed.wait()


class _FakeTunnel:
    def __init__(self):
        self.client = _FakeClient()


class WifiWorkerProtocolTests(unittest.IsolatedAsyncioTestCase):
    def test_worker_self_test_is_hardware_free_json(self):
        class Stdout:
            def __init__(self):
                self.buffer = io.BytesIO()

        stdout = Stdout()
        with patch("core.wifi_worker.sys.stdout", stdout):
            code = worker_main(["--wifi-worker", "--self-test"])
        self.assertEqual(code, 0)
        self.assertEqual(
            json.loads(stdout.buffer.getvalue()),
            {"ok": True, "mode": "wifi-worker", "protocol": 1},
        )

    def test_worker_command_does_not_put_device_identity_in_argv(self):
        command, cwd = WifiWorkerRunner._command("UDID-SECRET", "192.0.2.41", 54321)
        self.assertNotIn("UDID-SECRET", command)
        self.assertNotIn("192.0.2.41", command)
        self.assertNotIn("54321", command)
        self.assertIn("--wifi-worker", command)
        self.assertTrue(cwd is None or cwd.endswith("/backend"))

    async def test_parent_watchdog_requests_shutdown_after_reparent(self):
        worker = WifiTunnelWorker("phone", "192.0.2.41", 54321)
        worker._parent_pid = 12345
        with patch("core.wifi_worker.os.getppid", return_value=1), patch(
            "core.wifi_worker.asyncio.sleep", new=AsyncMock(return_value=None)
        ), patch("core.wifi_worker.os._exit", side_effect=SystemExit(0)):
            with self.assertRaises(SystemExit):
                await worker._watch_parent()
        self.assertTrue(worker.stop_event.is_set())

    async def test_closed_socket_task_survives_health_command(self):
        worker = WifiTunnelWorker("phone", "192.0.2.41", 54321)
        tunnel = _FakeTunnel()
        worker._connect = AsyncMock(return_value=(tunnel, object()))
        sent = []

        async def send(payload):
            sent.append(payload)

        worker.protocol.send = send

        async def feed(queue):
            await queue.put({"id": 1, "op": "health"})
            await queue.put({"id": 2, "op": "shutdown"})

        worker._read_stdin = feed
        result = await worker.run()

        self.assertEqual(result, 0)
        self.assertEqual([item.get("id") for item in sent if "id" in item], [1, 2])
        self.assertEqual([item.get("ok") for item in sent if "id" in item], [True, True])
        self.assertTrue(worker._connect.await_count == 1)


class WifiWorkerLocationProxyTests(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_forwards_location_and_health(self):
        class Runner:
            async def request(self, op, payload, *, timeout=None):
                self.last = (op, payload)
                return {"ok": True, "last_position": payload} if op == "set" else {"ok": True}

        runner = Runner()
        proxy = WifiWorkerLocationService(runner)
        callback = AsyncMock()
        proxy.set_health_callback(callback)

        await proxy.set(25.033, 121.565)
        await proxy.clear(strict=False)

        self.assertEqual(runner.last[0], "clear")
        callback.assert_any_await("healthy", {"recovered": False})
        self.assertFalse(proxy._active)

    async def test_proxy_classifies_dead_worker_for_recovery(self):
        class Runner:
            async def request(self, op, payload, *, timeout=None):
                raise RuntimeError("worker process is not running")

        proxy = WifiWorkerLocationService(Runner())
        with self.assertRaises(DeviceLostError) as caught:
            await proxy.set(25.033, 121.565)
        self.assertEqual(caught.exception.reason, DeviceLostError.REASON_TUNNEL_DEAD)

    async def test_device_manager_adopts_proxy_without_touching_private_rsd(self):
        class Worker:
            udid = "phone-a"
            rsd = None
            info = {"udid": "phone-a", "name": "A", "ios_version": "18.0"}
            location_service = object()
            stop = AsyncMock()

        manager = DeviceManager()
        worker = Worker()
        info = await manager.connect_wifi_tunnel("fd00::1", 12345, worker=worker)
        self.assertEqual(info.udid, "phone-a")
        self.assertIs(manager._connections["phone-a"].location_service, worker.location_service)
        self.assertTrue(manager._connections["phone-a"].external_location_service)
        await manager.disconnect("phone-a", clear_location=False)
        worker.stop.assert_awaited_once()

    async def test_device_manager_worker_adoption_is_case_insensitive_and_idempotent(self):
        class Worker:
            udid = "PHONE-A"
            rsd = None
            info = {"udid": "PHONE-A", "name": "A", "ios_version": "18.0"}
            location_service = object()
            stop = AsyncMock()

        manager = DeviceManager()
        worker = Worker()
        first = await manager.connect_wifi_tunnel("fd00::1", 12345, worker=worker)
        second = await manager.connect_wifi_tunnel("fd00::1", 12345, worker=worker)

        self.assertEqual(first.udid, "PHONE-A")
        self.assertEqual(second.udid, "PHONE-A")
        self.assertEqual(list(manager._connections), ["PHONE-A"])
        worker.stop.assert_not_awaited()

    async def test_concurrent_worker_adoption_never_stops_shared_worker(self):
        class Worker:
            udid = "PHONE-A"
            rsd = None
            info = {"udid": "PHONE-A", "name": "A", "ios_version": "18.0"}
            location_service = object()
            stop = AsyncMock()

        manager = DeviceManager()
        worker = Worker()
        results = await asyncio.gather(
            manager.connect_wifi_tunnel("fd00::1", 12345, worker=worker),
            manager.connect_wifi_tunnel("fd00::2", 12346, worker=worker),
        )

        self.assertEqual([item.udid for item in results], ["PHONE-A", "PHONE-A"])
        self.assertEqual(list(manager._connections), ["PHONE-A"])
        self.assertIs(manager._connections["PHONE-A"].worker, worker)
        worker.stop.assert_not_awaited()

    async def test_concurrent_stop_waiter_has_a_bound(self):
        runner = WifiWorkerRunner()
        runner._stopping = True
        runner.STOP_TIMEOUT = 0.01
        runner.task = asyncio.create_task(asyncio.sleep(60))

        await asyncio.wait_for(runner.stop(), timeout=0.2)

        self.assertFalse(runner.task.done())
        runner.task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await runner.task

    async def test_parent_controller_round_trips_against_a_worker_process(self):
        # This tiny protocol peer stands in for the frozen worker. It verifies
        # that start/health/stop are carried over stdin/stdout, independently
        # of pymobiledevice3 hardware availability.
        script = (
            "import sys,json\n"
            "for line in sys.stdin:\n"
            " c=json.loads(line)\n"
            " if c.get('op')=='start':\n"
            "  print(json.dumps({'event':'ready','udid':'phone','name':'A','ios_version':'18.0','rsd_address':'fd00::1','rsd_port':12345}), flush=True)\n"
            " elif c.get('op')=='health':\n"
            "  print(json.dumps({'id':c.get('id'),'ok':True,'state':'ready'}), flush=True)\n"
            " elif c.get('op')=='shutdown':\n"
            "  print(json.dumps({'id':c.get('id'),'ok':True}), flush=True)\n"
            "  break\n"
        )
        runner = WifiWorkerRunner()
        with patch.object(
            WifiWorkerRunner,
            "_command",
            staticmethod(lambda *_args: ([sys.executable, "-u", "-c", script], None)),
        ):
            info = await runner.start("phone", "192.0.2.41", 54321, timeout=3)
            self.assertEqual(info["udid"], "phone")
            health = await runner.request("health", {})
            self.assertEqual(health["state"], "ready")
            await runner.stop()
        self.assertFalse(runner.is_running())


if __name__ == "__main__":
    unittest.main()
