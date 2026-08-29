"""One-device Wi-Fi tunnel worker and its parent-process controller.

On macOS, pymobiledevice3's root-free PyTCP implementation keeps a process
global userspace tunnel.  That is a useful property for a single device, but
it means two tunnels in one backend process race for the same ARP worker.  A
``WifiTunnelWorker`` therefore owns *one* iPhone's complete transport in a
child process.  The parent talks to it over a deliberately small JSONL
protocol and never tries to use the child's RSD/dial plane directly.

The worker process owns:

    RemotePairing -> userspace TCP tunnel -> RSD -> DvtProvider ->
    LocationSimulation

The parent receives only serialisable status and location acknowledgements.
This keeps devices isolated, lets the existing per-UDID watchdog restart one
worker without touching another, and also works in a PyInstaller-frozen
backend (the frozen executable is relaunched with ``--wifi-worker``).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
from contextlib import AsyncExitStack, suppress
from pathlib import Path
from typing import Any

from services.location_service import DeviceLostError, LocationService

logger = logging.getLogger("wifi_worker")


def _short_device_id(value: object | None) -> str:
    """Keep worker diagnostics useful without logging a full UDID."""
    text = str(value or "")
    if len(text) <= 10:
        return text
    return f"{text[:4]}…{text[-4:]}"


def _json_line(payload: dict[str, Any]) -> bytes:
    """Encode one protocol message without allowing logs on stdout."""
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def _is_transport_error(exc: BaseException) -> bool:
    """Classify errors where restarting the whole worker is safest."""
    if isinstance(exc, (OSError, EOFError, BrokenPipeError, ConnectionError, asyncio.TimeoutError)):
        return True
    name = type(exc).__name__.lower()
    text = str(exc).lower()
    return (
        "connectionterminated" in name
        or "connectionreset" in name
        or "not connected" in text
        or "connection closed" in text
        or "remote xpc" in text
        or "tunnel" in text and "closed" in text
    )


class _WorkerProtocol:
    """Small stdout writer used by the worker's asyncio loop."""

    def __init__(self) -> None:
        self._write_lock = asyncio.Lock()

    async def send(self, payload: dict[str, Any]) -> None:
        async with self._write_lock:
            data = _json_line(payload)
            # stdout is a regular pipe, not an asyncio transport.  Writes are
            # tiny and serialized; to_thread avoids blocking the tunnel loop
            # if the parent is momentarily busy reading another worker.
            await asyncio.to_thread(sys.stdout.buffer.write, data)
            await asyncio.to_thread(sys.stdout.buffer.flush)


class _WorkerLocation:
    """DVT location writer living entirely inside the worker process."""

    SET_TIMEOUT = 4.0
    CLEAR_TIMEOUT = 8.0

    def __init__(self, dvt_provider: Any) -> None:
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

        self._dvt = dvt_provider
        self._sim: LocationSimulation | None = None
        self._active = False
        self._last_position: dict[str, float] | None = None
        self._last_set_at: float | None = None
        self._lock = asyncio.Lock()

    async def _ensure_instrument(self):
        if self._sim is None:
            from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

            self._sim = LocationSimulation(self._dvt)
            await self._sim.connect()
        return self._sim

    async def set(self, lat: float, lng: float) -> dict[str, Any]:
        async with self._lock:
            async def write() -> None:
                sim = await self._ensure_instrument()
                await sim.set(lat, lng)

            await asyncio.wait_for(write(), timeout=self.SET_TIMEOUT)
            self._active = True
            self._last_position = {"lat": float(lat), "lng": float(lng)}
            self._last_set_at = time.time()
            return self.status()

    async def clear(self, *, strict: bool = True) -> dict[str, Any]:
        async with self._lock:
            if not self._active:
                return self.status()
            try:
                sim = await self._ensure_instrument()
                await asyncio.wait_for(sim.clear(), timeout=self.CLEAR_TIMEOUT)
            except Exception:
                if strict:
                    raise
                logger.warning("best-effort worker location clear failed", exc_info=True)
            self._active = False
            return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "active": bool(self._active),
            "last_position": self._last_position,
            "last_set_at": self._last_set_at,
        }


class WifiTunnelWorker:
    """Child-process implementation for one RemotePairing endpoint."""

    def __init__(self, udid: str | None = None, ip: str | None = None, port: int | None = None) -> None:
        self.udid = udid
        self.ip = ip
        self.port = int(port) if port is not None else None
        self.protocol = _WorkerProtocol()
        self.stop_event = asyncio.Event()
        self._location: _WorkerLocation | None = None
        self._state = "starting"
        self._last_error: str | None = None
        self._context: AsyncExitStack | None = None
        self._info: dict[str, Any] = {}
        self._parent_pid = os.getppid()

    async def _send_event(self, event: str, **payload: Any) -> None:
        await self.protocol.send({"event": event, **payload})

    async def _watch_parent(self) -> None:
        """Stop if the backend disappears without closing our stdin pipe."""
        while not self.stop_event.is_set():
            await asyncio.sleep(0.5)
            if os.getppid() == self._parent_pid:
                continue
            logger.warning("backend parent exited; stopping WiFi worker")
            self.stop_event.set()
            # A RemotePairing handshake can be stuck in native/network code
            # and never observe stop_event. Give normal cleanup a short grace
            # period, then guarantee that an orphan worker cannot persist.
            await asyncio.sleep(5.0)
            os._exit(0)

    async def _connect(self) -> tuple[Any, Any]:
        import pymobiledevice3.remote.tunnel_service as tunnel_service
        from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
        from pymobiledevice3.remote.tunnel_service import (
            create_core_device_tunnel_service_using_remotepairing,
        )
        from pymobiledevice3.remote.userspace_tunnel import UserspaceDialPlane
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider

        if not self.udid or not self.ip or self.port is None:
            raise RuntimeError("worker start command is missing udid/ip/port")

        service = await create_core_device_tunnel_service_using_remotepairing(
            self.udid,
            self.ip,
            self.port,
            autopair=True,
        )
        stack = AsyncExitStack()
        try:
            await stack.__aenter__()
            stack.push_async_callback(service.close)

            # This module is imported in a fresh process, so its singleton is
            # independent from every other phone and from the backend's USB
            # connection.  Keep the flag local to this process only.
            tunnel_service.USE_USERSPACE_TUNNEL = True
            tunnel = await stack.enter_async_context(service.start_tcp_tunnel())
            tun = tunnel.client.tun
            tun.set_peer(tunnel.address)
            dial_plane = await stack.enter_async_context(
                UserspaceDialPlane(tun, tunnel.address)
            )
            rsd = RemoteServiceDiscoveryService(
                (tunnel.address, tunnel.port),
                open_connection=dial_plane.dial,
            )
            stack.push_async_callback(rsd.close)
            await rsd.connect()

            properties = (getattr(rsd, "peer_info", None) or {}).get("Properties", {})
            actual_udid = str(properties.get("UniqueDeviceID") or getattr(rsd, "udid", ""))
            if not actual_udid:
                raise RuntimeError("RemotePairing did not return a device identity")
            if actual_udid.lower() != self.udid.lower():
                raise RuntimeError(
                    "RemotePairing identity mismatch: requested "
                    f"{_short_device_id(self.udid)}, got {_short_device_id(actual_udid)}"
                )
            # Preserve the device's canonical identifier for the parent
            # registry and later per-UDID engine lookups (the candidate may
            # differ only by case/separator formatting).
            self.udid = actual_udid
            ios_version = str(properties.get("OSVersion") or "0.0")
            all_values = getattr(rsd, "all_values", None) or {}
            device_name = str(all_values.get("DeviceName") or properties.get("DeviceClass") or "iPhone")

            # Open DVT in the worker.  The main process receives only the
            # WorkerLocationService proxy, never this RSD object.
            dvt = DvtProvider(rsd)
            await dvt.__aenter__()
            stack.push_async_callback(dvt.__aexit__, None, None, None)
            self._location = _WorkerLocation(dvt)
            self._context = stack
            self._info = {
                "udid": self.udid,
                "name": device_name,
                "ios_version": ios_version,
                "rsd_address": str(tunnel.address),
                "rsd_port": tunnel.port,
                "interface": getattr(tunnel, "interface", None),
                "protocol": str(getattr(tunnel, "protocol", "tcp")),
                "worker_pid": os.getpid(),
            }
            return tunnel, rsd
        except BaseException:
            with suppress(Exception):
                await stack.aclose()
            raise

    async def _handle_command(self, command: dict[str, Any]) -> bool:
        """Handle a command. Return False when the worker should exit."""
        request_id = command.get("id")
        op = command.get("op")

        async def reply(ok: bool, **payload: Any) -> None:
            response: dict[str, Any] = {"id": request_id, "ok": ok}
            response.update(payload)
            await self.protocol.send(response)

        try:
            if op == "shutdown":
                await reply(True, state="stopping")
                self.stop_event.set()
                return False
            if op == "health":
                await reply(True, **self.status())
                return True
            if op == "set":
                if self._location is None:
                    raise RuntimeError("location service is not ready")
                lat = float(command["lat"])
                lng = float(command["lng"])
                if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
                    raise ValueError("coordinates out of range")
                result = await self._location.set(lat, lng)
                await reply(True, **result)
                await self._send_event("health", state="healthy", active=True)
                return True
            if op in ("clear", "restore"):
                if self._location is not None:
                    result = await self._location.clear(strict=bool(command.get("strict", True)))
                else:
                    result = {}
                await reply(True, **result)
                return True
            raise ValueError(f"unknown worker operation: {op!r}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._last_error = f"{type(exc).__name__}: {exc}"
            await reply(False, error=self._last_error, state=self._state)
            # A transport error means this worker's RSD is no longer safe to
            # reuse. Exit so the parent's per-device watchdog can rebuild it;
            # non-transport input errors stay recoverable.
            if _is_transport_error(exc):
                await self._send_event("tunnel_lost", reason=self._last_error)
                self.stop_event.set()
                return False
            return True

    def status(self) -> dict[str, Any]:
        location = self._location.status() if self._location is not None else {}
        return {
            "udid": self.udid,
            "state": self._state,
            "ready": self._state == "ready",
            "last_error": self._last_error,
            **location,
            **self._info,
        }

    async def _read_stdin(self, queue: asyncio.Queue[dict[str, Any] | None]) -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                await queue.put(None)
                return
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("ignoring malformed worker command")
                continue
            if isinstance(value, dict):
                await queue.put(value)

    async def run(self) -> int:
        command_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        reader_task: asyncio.Task | None = None
        closed_task: asyncio.Task | None = None
        parent_task: asyncio.Task | None = None
        try:
            # Source/frozen parents send the target over stdin after spawn so
            # no UDID or LAN address appears in process listings.  Optional
            # CLI values remain supported for manual diagnostics.
            reader_task = asyncio.create_task(self._read_stdin(command_queue))
            parent_task = asyncio.create_task(self._watch_parent())
            if not (self.udid and self.ip and self.port is not None):
                initial = await command_queue.get()
                if initial is None or initial.get("op") != "start":
                    raise RuntimeError("worker requires an initial start command")
                try:
                    self.udid = str(initial["udid"])
                    self.ip = str(initial["ip"])
                    self.port = int(initial["port"])
                except (KeyError, TypeError, ValueError) as exc:
                    raise RuntimeError("worker start command has invalid udid/ip/port") from exc

            tunnel, _rsd = await self._connect()
            self._state = "ready"
            await self._send_event("ready", **self._info)

            wait_closed = getattr(getattr(tunnel, "client", None), "wait_closed", None)
            if callable(wait_closed):
                closed_task = asyncio.create_task(wait_closed())

            while not self.stop_event.is_set():
                command_task = asyncio.create_task(command_queue.get())
                waiters = [command_task]
                if closed_task is not None:
                    waiters.append(closed_task)
                done, pending = await asyncio.wait(
                    waiters,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if closed_task is not None and closed_task in done:
                    # The command waiter is per-iteration and must be
                    # cancelled when the socket wins.  The long-lived
                    # ``closed_task`` must stay alive when a command wins;
                    # cancelling it here would make the next command look
                    # like an immediate tunnel death.
                    if command_task in pending:
                        command_task.cancel()
                        with suppress(asyncio.CancelledError, Exception):
                            await command_task
                    if not self.stop_event.is_set():
                        await self._send_event("tunnel_lost", reason="underlying tunnel socket closed")
                    return 2
                command = command_task.result()
                if command is None:
                    self.stop_event.set()
                    break
                if not await self._handle_command(command):
                    break
            return 0
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._last_error = f"{type(exc).__name__}: {exc}"
            self._state = "error"
            with suppress(Exception):
                await self._send_event("error", error=self._last_error)
            return 1
        finally:
            self._state = "stopped"
            for task in (reader_task, closed_task, parent_task):
                if task is not None and not task.done():
                    task.cancel()
            for task in (reader_task, closed_task, parent_task):
                if task is not None:
                    with suppress(asyncio.CancelledError, Exception):
                        await task
            if self._context is not None:
                with suppress(Exception):
                    await asyncio.wait_for(self._context.aclose(), timeout=5.0)


def _configure_worker_logging() -> None:
    # stdout is reserved for JSONL.  Keep useful diagnostics in the parent's
    # stderr pipe and never let a logging handler corrupt protocol framing.
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        force=True,
    )


def worker_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LocWarp one-device Wi-Fi worker")
    parser.add_argument("--wifi-worker", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    # Device identity/address are deliberately supplied through stdin after
    # spawn.  Keeping them out of argv prevents another local user from
    # learning the target iPhone/IP with ps while workers are running.
    parser.add_argument("--udid")
    parser.add_argument("--ip")
    parser.add_argument("--port", type=int)
    args = parser.parse_args(argv)
    if args.self_test:
        # Frozen-package smoke check: proves main.py dispatched into the
        # worker entrypoint and that JSONL stdout remains parseable, without
        # touching pairing records, the network, or a connected phone.
        sys.stdout.buffer.write(_json_line({"ok": True, "mode": "wifi-worker", "protocol": 1}))
        sys.stdout.buffer.flush()
        return 0
    _configure_worker_logging()
    worker = WifiTunnelWorker(args.udid, args.ip, args.port)
    return asyncio.run(worker.run())


class WifiWorkerLocationService(LocationService):
    """Parent-side LocationService-compatible proxy for one worker."""

    def __init__(self, runner: "WifiWorkerRunner") -> None:
        self._runner = runner
        self._active = False
        self._last_position: dict[str, float] | None = None
        self._health_callback = None

    def set_health_callback(self, callback) -> None:
        """Match DvtLocationService's health observer contract."""
        self._health_callback = callback

    async def _notify_health(self, state: str, **details: Any) -> None:
        callback = self._health_callback
        if callback is None:
            return
        try:
            await callback(state, details)
        except Exception:
            logger.debug("worker location health callback failed", exc_info=True)

    async def set(self, lat: float, lng: float) -> None:
        try:
            result = await self._runner.request("set", {"lat": float(lat), "lng": float(lng)})
        except Exception as exc:
            await self._notify_health(
                "recovering",
                reason=type(exc).__name__,
                phase="worker_proxy",
            )
            if isinstance(exc, DeviceLostError):
                raise
            # The API recovery path is keyed on DeviceLostError.  Keep input
            # validation errors local, but classify a dead child/pipe as a
            # tunnel failure so the per-UDID watchdog can rebuild this worker.
            if not isinstance(exc, ValueError):
                raise DeviceLostError(
                    f"WiFi worker location write failed: {exc}",
                    reason=DeviceLostError.REASON_TUNNEL_DEAD,
                ) from exc
            raise
        self._active = True
        self._last_position = {"lat": float(lat), "lng": float(lng)}
        if isinstance(result, dict) and result.get("last_position"):
            self._last_position = result["last_position"]
        await self._notify_health("healthy", recovered=False)

    async def clear(self, *, strict: bool = True) -> None:
        try:
            await self._runner.request("clear", {"strict": bool(strict)})
        except Exception as exc:
            if strict and not isinstance(exc, ValueError):
                raise DeviceLostError(
                    f"WiFi worker location clear failed: {exc}",
                    reason=DeviceLostError.REASON_TUNNEL_DEAD,
                ) from exc
            raise
        self._active = False

    async def health(self) -> dict[str, Any]:
        try:
            result = await self._runner.request("health", {})
        except Exception as exc:
            if not isinstance(exc, DeviceLostError):
                raise DeviceLostError(
                    f"WiFi worker health check failed: {exc}",
                    reason=DeviceLostError.REASON_TUNNEL_DEAD,
                ) from exc
            raise
        if isinstance(result, dict):
            self._active = bool(result.get("active", self._active))
        return result


class WifiWorkerRunner:
    """Parent controller for one frozen/source worker process."""

    REQUEST_TIMEOUT = 8.0
    STOP_TIMEOUT = 3.0

    def __init__(self) -> None:
        self.info: dict[str, Any] | None = None
        self.rsd: None = None  # Deliberately no cross-process RSD object.
        self.tun: None = None
        self.task: asyncio.Task | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.target_ip: str | None = None
        self.target_port: int | None = None
        self.udid: str | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._request_lock = asyncio.Lock()
        self._sequence = 0
        self._ready: asyncio.Future | None = None
        self._stopping = False
        # Multiple cleanup owners exist (API teardown, DeviceManager, and
        # lifespan shutdown). Serialize them so concurrent stop() callers do
        # not race on stdin/process handles or clear state while the first
        # caller is still waiting for the child.
        self._stop_lock = asyncio.Lock()
        self.location_service = WifiWorkerLocationService(self)

    async def _notify_health(self, state: str, **details: Any) -> None:
        await self.location_service._notify_health(state, **details)

    def is_running(self) -> bool:
        return self.task is not None and not self.task.done() and self.process is not None and self.process.returncode is None

    @staticmethod
    def _consume_task_result(task: asyncio.Task) -> None:
        with suppress(asyncio.CancelledError, Exception):
            task.exception()

    @staticmethod
    def _command(udid: str, ip: str, port: int) -> tuple[list[str], str | None]:
        if getattr(sys, "frozen", False):
            return [sys.executable, "--wifi-worker"], None
        backend_dir = Path(__file__).resolve().parents[1]
        # Execute main.py so source mode has the same CLI contract as a
        # frozen executable. main.py dispatches --wifi-worker before starting
        # FastAPI, while its directory supplies absolute backend imports.
        return [sys.executable, str(backend_dir / "main.py"), "--wifi-worker"], str(backend_dir)

    async def _send(self, payload: dict[str, Any]) -> None:
        proc = self.process
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise RuntimeError("WiFi worker process is not running")
        proc.stdin.write(_json_line(payload))
        await proc.stdin.drain()

    async def request(self, op: str, payload: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        async with self._request_lock:
            if not self.is_running():
                raise RuntimeError("WiFi worker process is not running")
            self._sequence += 1
            request_id = self._sequence
            loop = asyncio.get_running_loop()
            future = loop.create_future()
            self._pending[request_id] = future
            try:
                await self._send({"id": request_id, "op": op, **payload})
                try:
                    result = await asyncio.wait_for(future, timeout=timeout or self.REQUEST_TIMEOUT)
                except asyncio.TimeoutError:
                    # A command that outlives its bound can leave the child
                    # parked inside a dead RemoteXPC call.  Tear down the
                    # worker so the normal per-UDID watchdog/reconnect path
                    # can create a clean RSD/DVT session rather than queueing
                    # more writes behind the stuck one.
                    logger.warning("WiFi worker %s command %s timed out; stopping child", _short_device_id(self.udid), op)
                    await self.stop()
                    raise
                if not result.get("ok", False):
                    raise RuntimeError(result.get("error", f"worker {op} failed"))
                return result
            finally:
                self._pending.pop(request_id, None)

    async def health(self) -> dict[str, Any]:
        """Return the child's transport/location status through IPC."""
        return await self.request("health", {})

    async def _read_stdout(self) -> None:
        proc = self.process
        if proc is None or proc.stdout is None:
            return
        try:
            async for raw in proc.stdout:
                try:
                    message = json.loads(raw.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    logger.warning("Ignoring malformed WiFi worker output for %s", _short_device_id(self.udid))
                    continue
                if not isinstance(message, dict):
                    continue
                request_id = message.get("id")
                if isinstance(request_id, int):
                    future = self._pending.get(request_id)
                    if future is not None and not future.done():
                        future.set_result(message)
                    continue
                event = message.get("event")
                if event == "ready":
                    self.info = {k: v for k, v in message.items() if k != "event"}
                    if self._ready is not None and not self._ready.done():
                        self._ready.set_result(self.info)
                elif event in ("error", "tunnel_lost"):
                    reason = message.get("error") or message.get("reason") or event
                    if self._ready is not None and not self._ready.done():
                        self._ready.set_exception(RuntimeError(str(reason)))
                    logger.warning("WiFi worker %s %s: %s", _short_device_id(self.udid), event, reason)
                    await self._notify_health(
                        "recovering",
                        reason=str(reason),
                        phase="worker",
                    )
                elif event == "health":
                    state = str(message.get("state") or "healthy")
                    await self._notify_health(
                        state,
                        recovered=bool(message.get("recovered")),
                        phase="worker",
                    )
        finally:
            error = RuntimeError(f"WiFi worker exited before responding ({self.udid})")
            if self._ready is not None and not self._ready.done():
                self._ready.set_exception(error)
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(error)
            if not self._stopping:
                await self._notify_health(
                    "recovering",
                    reason="worker_exited",
                    phase="worker",
                )

    async def _read_stderr(self) -> None:
        proc = self.process
        if proc is None or proc.stderr is None:
            return
        async for raw in proc.stderr:
            text = raw.decode("utf-8", errors="replace").rstrip()
            if text:
                logger.info("[worker:%s] %s", _short_device_id(self.udid), text)

    async def _wait_process(self) -> int:
        proc = self.process
        if proc is None:
            return -1
        code = await proc.wait()
        if self._reader_task is not None and not self._reader_task.done():
            with suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(self._reader_task, timeout=0.5)
        return code

    async def start(self, udid: str, ip: str, port: int, timeout: float = 20.0) -> dict[str, Any]:
        if self.is_running():
            raise RuntimeError("WiFi worker is already running")
        self.udid = udid
        self.target_ip = ip
        self.target_port = int(port)
        self.info = None
        self._stopping = False
        self._ready = asyncio.get_running_loop().create_future()
        command, cwd = self._command(udid, ip, int(port))
        self.process = await asyncio.create_subprocess_exec(
            *command,
            cwd=cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=(sys.platform != "win32"),
        )
        self._reader_task = asyncio.create_task(self._read_stdout())
        self._stderr_task = asyncio.create_task(self._read_stderr())
        self.task = asyncio.create_task(self._wait_process())
        self.task.add_done_callback(self._consume_task_result)
        try:
            # Send target details over the private pipe instead of argv. The
            # child validates the resulting RSD peer identity before it emits
            # ready, so an IP alone can never silently select another phone.
            await self._send({
                "id": 0,
                "op": "start",
                "udid": udid,
                "ip": ip,
                "port": int(port),
            })
            return dict(await asyncio.wait_for(self._ready, timeout=timeout))
        except BaseException:
            await self.stop()
            raise

    async def stop(self) -> None:
        async with self._stop_lock:
            await self._stop_unlocked()

    async def _stop_unlocked(self) -> None:
        if self._stopping:
            if self.task is not None:
                # A prior cleanup owner may have been cancelled after
                # setting _stopping. Never let a concurrent stop waiter hang
                # forever on that stale process task; shield it so the
                # timeout does not cancel the shared waiter itself.
                with suppress(asyncio.CancelledError, Exception):
                    await asyncio.wait_for(
                        asyncio.shield(self.task),
                        timeout=self.STOP_TIMEOUT + 1.0,
                    )
            return
        self._stopping = True
        proc = self.process
        if proc is not None and proc.returncode is None:
            # Send shutdown best effort, then close stdin so a worker blocked
            # in its line reader cannot keep a thread alive after shutdown.
            with suppress(Exception):
                await self._send({"id": 0, "op": "shutdown"})
            if proc.stdin is not None:
                with suppress(Exception):
                    proc.stdin.close()
            try:
                await asyncio.wait_for(proc.wait(), timeout=self.STOP_TIMEOUT)
            except asyncio.TimeoutError:
                logger.warning("WiFi worker %s did not stop in %.1fs; killing", _short_device_id(self.udid), self.STOP_TIMEOUT)
                with suppress(ProcessLookupError, OSError):
                    if sys.platform == "win32":
                        proc.kill()
                    else:
                        # start_new_session gives each worker a private process
                        # group. Kill the exact group so helper descendants
                        # cannot survive a wedged worker shutdown.
                        os.killpg(proc.pid, signal.SIGKILL)
                with suppress(asyncio.TimeoutError, Exception):
                    await asyncio.wait_for(proc.wait(), timeout=1.0)
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
        for task in (self._reader_task, self._stderr_task, self.task):
            if task is not None:
                with suppress(asyncio.CancelledError, Exception):
                    await task
        self._reader_task = None
        self._stderr_task = None
        self.task = None
        self.process = None
        self.info = None
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(RuntimeError("WiFi worker stopped"))
        self._pending.clear()
