"""WiFi tunnel runner compatibility layer.

The legacy in-process runner is retained for non-macOS callers and tests.
macOS production callers opt into :class:`WifiWorkerRunner`, which starts a
separate same-executable worker for each iPhone.  pymobiledevice3's root-free
PyTCP stack is process-global, so process isolation is what makes two WiFi
devices safe at the same time.
"""

import asyncio
import logging
import sys
from contextlib import AsyncExitStack

logger = logging.getLogger("wifi_tunnel")


class _InProcessTunnelRunner:
    """Owns the tunnel asyncio task and its RSD info."""

    def __init__(self, owner: object | None = None) -> None:
        self._owner = owner or self
        self.info: dict | None = None
        # On macOS this RSD is reachable only through the in-process PyTCP
        # dial plane. DeviceManager must adopt this exact connected object.
        self.rsd: object | None = None
        # pymobiledevice3's userspace_stack_addr()/UserspaceUdp helpers read
        # `_active_tunnel.tun`, so our singleton owner must expose the same
        # surface as UserspaceRsdTunnel.
        self.tun: object | None = None
        self.task: asyncio.Task | None = None
        self.lock = asyncio.Lock()
        self._stop: asyncio.Event = asyncio.Event()
        self._ready: asyncio.Event = asyncio.Event()
        self._error: BaseException | None = None
        # Original (ip, port) the runner was launched against. Useful so
        # callers can tell "is the running tunnel actually for the same
        # iPhone the user is trying to connect to right now?" without
        # having to re-resolve the udid.
        self.target_ip: str | None = None
        self.target_port: int | None = None

    def is_running(self) -> bool:
        return self.task is not None and not self.task.done()

    @staticmethod
    def _consume_task_result(task: asyncio.Task) -> None:
        """Mark background task exceptions as retrieved.

        Tunnel start / restart timeouts can race cancellation, and the task
        may finish with an exception after the caller has already moved on.
        Without consuming the terminal result, asyncio emits noisy
        "Task exception was never retrieved" tracebacks that obscure the real
        tunnel-reset timeline in backend.log.
        """
        try:
            task.exception()
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    async def _run(self, udid: str, ip: str, port: int) -> None:
        import pymobiledevice3.remote.tunnel_service as tunnel_service
        from pymobiledevice3.remote.remote_service_discovery import (
            RemoteServiceDiscoveryService,
        )
        from pymobiledevice3.remote.tunnel_service import (
            create_core_device_tunnel_service_using_remotepairing,
        )
        try:
            logger.info("Connecting to RemotePairing service at %s:%d", ip, port)
            service = await create_core_device_tunnel_service_using_remotepairing(
                udid, ip, port,
            )
            logger.info("RemotePairing connected (identifier=%s)", service.remote_identifier)

            async with AsyncExitStack() as stack:
                stack.push_async_callback(service.close)

                userspace_module = None
                if sys.platform == "darwin":
                    # A kernel utun needs root on macOS. LocWarp deliberately
                    # runs its backend as the signed-in user, so claim
                    # pymobiledevice3's process-global root-free PyTCP stack.
                    import pymobiledevice3.remote.userspace_tunnel as userspace_module
                    from pymobiledevice3.remote.userspace_tunnel import UserspaceDialPlane

                    active = getattr(userspace_module, "_active_tunnel", None)
                    if active is not None and active is not self._owner:
                        raise RuntimeError(
                            "USB userspace tunnel is still active; unplug the iPhone "
                            "and wait for USB disconnect before starting WiFi"
                        )
                    userspace_module._active_tunnel = self._owner
                    userspace_module.USERSPACE_ACTIVE = True
                    tunnel_service.USE_USERSPACE_TUNNEL = True

                tunnel = await stack.enter_async_context(service.start_tcp_tunnel())

                if userspace_module is not None:
                    tun = tunnel.client.tun
                    tun.set_peer(tunnel.address)
                    self.tun = tun
                    dial_plane = await stack.enter_async_context(
                        UserspaceDialPlane(tun, tunnel.address)
                    )
                    rsd = RemoteServiceDiscoveryService(
                        (tunnel.address, tunnel.port),
                        open_connection=dial_plane.dial,
                    )
                    stack.push_async_callback(rsd.close)
                    await rsd.connect()
                    self.rsd = rsd

                self.info = {
                    "rsd_address": tunnel.address,
                    "rsd_port": tunnel.port,
                    "interface": tunnel.interface,
                    "protocol": str(tunnel.protocol),
                }
                logger.info(
                    "WiFi tunnel established: %s:%d iface=%s",
                    tunnel.address, tunnel.port, tunnel.interface,
                )
                self._ready.set()

                # Wait until either (a) the user requests stop, or (b) the
                # underlying TCP socket dies. pymobiledevice3's sock_read_task
                # exits silently on OSError / ConnectionReset and does NOT
                # propagate out of the start_tcp_tunnel context, so without
                # this wait_closed() race the runner task hangs forever even
                # after the iPhone has gone away. _per_tunnel_watchdog only
                # restarts when runner.task ends, so detecting tunnel death
                # here is what wires up the existing auto-restart machinery.
                stop_task = asyncio.create_task(self._stop.wait())
                closed_task = asyncio.create_task(tunnel.client.wait_closed())
                try:
                    _, pending = await asyncio.wait(
                        [stop_task, closed_task],
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                finally:
                    for t in (stop_task, closed_task):
                        if not t.done():
                            t.cancel()
                            try:
                                await t
                            except (asyncio.CancelledError, Exception):
                                pass

                if self._stop.is_set():
                    logger.info("Tunnel stop signal received; closing context")
                else:
                    logger.warning(
                        "Tunnel underlying TCP socket died (sock_read_task exited); "
                        "exiting runner so watchdog can restart"
                    )
        except BaseException as exc:
            self._error = exc
            self._ready.set()
            raise
        finally:
            self.rsd = None
            self.tun = None
            self.info = None
            if sys.platform == "darwin":
                try:
                    import pymobiledevice3.remote.userspace_tunnel as userspace_module
                    import pymobiledevice3.remote.tunnel_service as tunnel_service

                    if getattr(userspace_module, "_active_tunnel", None) is self._owner:
                        userspace_module._active_tunnel = None
                        userspace_module.USERSPACE_ACTIVE = False
                        tunnel_service.USE_USERSPACE_TUNNEL = False
                except Exception:
                    logger.exception("Failed to release userspace tunnel claim")

    async def start(self, udid: str, ip: str, port: int, timeout: float = 20.0) -> dict:
        """Start the tunnel and wait until RSD info is ready.

        Raises asyncio.TimeoutError on timeout or the underlying exception
        if the tunnel setup failed before becoming ready.
        """
        self._stop = asyncio.Event()
        self._ready = asyncio.Event()
        self._error = None
        self.info = None
        self.rsd = None
        self.tun = None
        self.target_ip = ip
        self.target_port = port
        self.task = asyncio.create_task(self._run(udid, ip, port))
        self.task.add_done_callback(self._consume_task_result)
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            self._stop.set()
            try:
                await asyncio.wait_for(self.task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                pass
            self.task = None
            raise
        if self._error is not None:
            exc = self._error
            self.task = None
            raise exc
        return dict(self.info or {})

    async def stop(self) -> None:
        if not self.is_running():
            self.task = None
            self.info = None
            self.rsd = None
            self.tun = None
            return
        self._stop.set()
        try:
            await asyncio.wait_for(self.task, timeout=5.0)
        except asyncio.TimeoutError:
            logger.warning("Tunnel task did not exit in 5s; cancelling")
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass
        except (asyncio.CancelledError, Exception):
            pass
        self.task = None
        self.info = None
        self.rsd = None
        self.tun = None


class TunnelRunner:
    """Compatibility facade for the old runner and the macOS worker runner.

    Existing unit tests and non-macOS paths still get the in-process runner.
    The API layer calls :meth:`enable_worker` on macOS before starting a WiFi
    tunnel; keeping the selection explicit avoids changing legacy callers
    that rely on an in-process RSD object.
    """

    def __init__(self) -> None:
        self._impl: object = _InProcessTunnelRunner(owner=self)
        self._worker_enabled = False

    def enable_worker(self) -> None:
        """Switch this not-yet-started facade to a process-isolated worker."""
        if self._worker_enabled:
            return
        if getattr(self._impl, "is_running", lambda: False)():
            raise RuntimeError("cannot switch a running tunnel to worker mode")
        from core.wifi_worker import WifiWorkerRunner

        self._impl = WifiWorkerRunner()
        self._worker_enabled = True

    def __getattr__(self, name: str):
        # Delegate the established public fields (task, info, rsd, target_*)
        # and methods to whichever implementation was selected.
        return getattr(self._impl, name)

    async def start(self, udid: str, ip: str, port: int, timeout: float = 20.0) -> dict:
        return await self._impl.start(udid, ip, port, timeout=timeout)

    async def stop(self) -> None:
        return await self._impl.stop()

    def is_running(self) -> bool:
        return bool(self._impl.is_running())

    async def request(self, op: str, payload: dict, *, timeout: float | None = None) -> dict:
        request = getattr(self._impl, "request", None)
        if request is None:
            raise RuntimeError("in-process tunnel has no worker command channel")
        return await request(op, payload, timeout=timeout)
