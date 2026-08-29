"""
LocWarp Device Manager

Handles iOS device detection, connection lifecycle, tunnel establishment,
and location service creation.  Wraps pymobiledevice3 internals so the
rest of the application never touches low-level device APIs directly.

Supports both USB and WiFi connections.  ``list_devices()`` from usbmuxd
returns devices with ``connection_type`` of ``"USB"`` or ``"Network"``.
WiFi requires the device to be paired and on the same local network.

For iOS 17+, a TCP tunnel via CoreDeviceTunnelProxy is established first,
then a RemoteServiceDiscoveryService (RSD) is created over the tunnel to
access DVT services.  This requires administrator privileges on Windows.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import socket
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Optional

from pymobiledevice3.lockdown import create_using_usbmux, create_using_tcp
from pymobiledevice3.remote.remote_service_discovery import RemoteServiceDiscoveryService
from pymobiledevice3.remote.tunnel_service import CoreDeviceTunnelProxy
from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.simulate_location import DtSimulateLocation
from pymobiledevice3.usbmux import list_devices

from config import DEVICE_NAMES_FILE
from models.schemas import DeviceInfo
from services.json_safe import safe_load_json, safe_write_json
from services.location_service import (
    DeviceLostError,
    DvtLocationService,
    LegacyLocationService,
    LocationService,
)


class UnsupportedIosVersionError(RuntimeError):
    """Raised when a connecting device's iOS version is below the minimum
    supported by LocWarp (currently 16.0). Surfaces a structured error to
    the API layer so the frontend can show an actionable message rather
    than a stack trace."""

    MIN_VERSION = "16.0"

    def __init__(self, version: str) -> None:
        self.version = version
        super().__init__(f"iOS {version} is not supported (requires {self.MIN_VERSION}+)")


class DDIMountError(RuntimeError):
    """Structured error for personalized DDI mount / repair failures."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)

logger = logging.getLogger(__name__)


def _parse_ios_version(version_string: str) -> tuple[int, ...]:
    """Convert an iOS version string like '17.4.1' into a comparable tuple."""
    try:
        return tuple(int(p) for p in version_string.split("."))
    except (ValueError, AttributeError):
        logger.warning("Unable to parse iOS version '%s', assuming 0.0", version_string)
        return (0, 0)


def _load_device_name_cache() -> Dict[str, str]:
    """Load the persisted UDID → DeviceName map. Returns empty dict on any failure."""
    raw = safe_load_json(DEVICE_NAMES_FILE)
    if not isinstance(raw, dict):
        return {}
    return {str(k): str(v) for k, v in raw.items() if isinstance(v, str) and v}


def _remember_device_name(udid: str, name: str) -> None:
    """Persist a real DeviceName for *udid* if it isn't a generic fallback.

    The cache only stores user-set names. We deliberately skip the
    DeviceClass fallback ("iPhone") and "Unknown" so a once-known real
    name isn't overwritten by a later degraded read.
    """
    if not udid or not name:
        return
    if name in ("iPhone", "iPad", "iPod touch", "Unknown"):
        return
    cache = _load_device_name_cache()
    if cache.get(udid) == name:
        return
    cache[udid] = name
    safe_write_json(DEVICE_NAMES_FILE, cache)


@dataclass
class _ActiveConnection:
    """Internal bookkeeping for a single connected device."""
    udid: str
    lockdown: object  # LockdownClient or RemoteServiceDiscoveryService
    ios_version: str
    connection_type: str = "USB"  # "USB" or "Network"
    name: str = "iPhone"  # Cached DeviceName so discover_devices can surface
                          # WiFi-tunnel devices that no longer appear in usbmuxd
                          # after USB is unplugged (RemotePairing tunnel only).
    dvt_provider: Optional[DvtProvider] = None
    tunnel_proxy: Optional[CoreDeviceTunnelProxy] = None
    tunnel_context: object = None  # async context manager for the tunnel
    userspace_tunnel: Optional[UserspaceRsdTunnel] = None
    rsd: Optional[RemoteServiceDiscoveryService] = None
    owns_rsd: bool = True  # False when TunnelRunner owns a userspace RSD
    location_service: Optional[LocationService] = None
    usbmux_lockdown: object = None  # Original lockdown client (for legacy fallback on iOS 17+)
    # macOS root-free WiFi worker owns the actual RSD/DVT objects in a child
    # process.  The main process keeps only this opaque controller and the
    # LocationService-compatible proxy; it must never attempt to close or
    # reconnect the child's RSD directly.
    worker: object = None
    external_location_service: bool = False


class DeviceManager:
    """
    Manages the full lifecycle of iOS device connections.

    Usage::

        dm = DeviceManager()
        devices = await dm.discover_devices()
        await dm.connect(devices[0].udid)
        loc = await dm.get_location_service(devices[0].udid)
        await loc.set(37.7749, -122.4194)
        await dm.disconnect(devices[0].udid)
    """

    def __init__(self) -> None:
        self._connections: Dict[str, _ActiveConnection] = {}
        self._lock = asyncio.Lock()
        self._connect_locks: Dict[str, asyncio.Lock] = {}

    @staticmethod
    def _identity_key(udid: str | None) -> str:
        """Normalize a UDID for identity comparisons without changing UI text."""
        return str(udid or "").strip().casefold()

    def _connection_key(self, udid: str | None) -> str | None:
        """Find the stored connection key case-insensitively.

        usbmuxd, RemotePairing, and cached worker metadata can disagree only
        in casing. Treating those as different devices was enough to create a
        duplicate connection and later disconnect the wrong tunnel.
        """
        if udid is None:
            return None
        if udid in self._connections:
            return udid
        wanted = self._identity_key(udid)
        return next(
            (stored for stored in self._connections if self._identity_key(stored) == wanted),
            None,
        )

    def _connection_for(self, udid: str | None) -> _ActiveConnection | None:
        key = self._connection_key(udid)
        return self._connections.get(key) if key is not None else None

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    async def discover_devices(self) -> list[DeviceInfo]:
        """
        Scan for all iOS devices visible over USB and WiFi (usbmuxd).

        usbmuxd returns both USB-connected and WiFi-paired devices on
        the same network.  Each device carries a ``connection_type`` of
        ``"USB"`` or ``"Network"``.

        Returns a list of ``DeviceInfo`` objects with basic identification
        data.  This does **not** establish a persistent connection.
        """
        devices: list[DeviceInfo] = []
        seen_udids: set[str] = set()

        try:
            raw_devices = await list_devices()
        except Exception:
            logger.exception("Failed to list usbmux devices")
            return devices

        for raw in raw_devices:
            try:
                conn_type = getattr(raw, "connection_type", "USB")
                # If we already saw this device via USB, skip the Network duplicate
                raw_identity = self._identity_key(raw.serial)
                if raw_identity in seen_udids:
                    # But upgrade to USB if this entry is USB (prefer USB info)
                    if conn_type == "USB":
                        for d in devices:
                            if self._identity_key(d.udid) == raw_identity:
                                d.connection_type = "USB"
                    continue
                seen_udids.add(raw_identity)

                lockdown = await create_using_usbmux(serial=raw.serial)
                all_values = lockdown.all_values
                # If device is already connected, report the active connection type
                active_conn = self._connection_for(raw.serial)
                if active_conn:
                    conn_type = active_conn.connection_type
                device_name = all_values.get("DeviceName", "Unknown")
                _remember_device_name(raw.serial, device_name)
                info = DeviceInfo(
                    udid=raw.serial,
                    name=device_name,
                    ios_version=all_values.get("ProductVersion", "0.0"),
                    connection_type=conn_type,
                )
                info.is_connected = self._connection_key(raw.serial) is not None
                # Query Developer Mode status (iOS 16+). Tolerate failure —
                # None means "unknown", frontend will hide the reveal button.
                try:
                    ver = _parse_ios_version(info.ios_version)
                    if ver >= (16, 0):
                        info.developer_mode_enabled = await lockdown.get_developer_mode_status()
                except Exception:
                    logger.debug("get_developer_mode_status failed for %s", raw.serial, exc_info=True)
                devices.append(info)
                logger.debug("Discovered device %s (%s) running iOS %s via %s (connected=%s)",
                             info.name, info.udid, info.ios_version, conn_type, info.is_connected)
            except Exception:
                logger.exception("Failed to query device %s", getattr(raw, "serial", "?"))

        # Surface devices that are in our connection table but did not get
        # added from usbmuxd above. Happens for the dual-device A-WiFi +
        # B-USB flow: A is paired via the in-process RemotePairing tunnel
        # (port 49152), NOT through usbmuxd's iTunes-WiFi-sync path, so
        # once A's USB cable is unplugged usbmuxd may stop listing A
        # entirely. Without this fallback `discover_devices()` would
        # return only B, and the frontend's listDevices refresh on B's
        # auto-connect broadcast would wipe A out of the device sidebar /
        # connectedDevices fanout, so the user would see A as if it had
        # been kicked. Compare against actually-added udids (not
        # `seen_udids` which is set early for raw-entry dedup) so a
        # failed lockdown query above doesn't suppress the fallback.
        added_udids = {self._identity_key(d.udid) for d in devices}
        for udid, conn in self._connections.items():
            if self._identity_key(udid) in added_udids:
                continue
            try:
                info = DeviceInfo(
                    udid=udid,
                    name=conn.name or "iPhone",
                    ios_version=conn.ios_version or "0.0",
                    connection_type=conn.connection_type or "Network",
                )
                info.is_connected = True
                devices.append(info)
                logger.debug(
                    "Discovered cached %s device %s (%s) iOS %s (no usbmux entry)",
                    conn.connection_type, info.name, udid, info.ios_version,
                )
            except Exception:
                logger.exception("Failed to surface cached connection for %s", udid)

        return devices

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    async def connect(self, udid: str) -> None:
        """Serialize connection creation per device.

        The frontend can issue duplicate location requests while a USB device
        is re-enumerating. Without this lock, both requests can pass the
        initial ``_connections`` check and build competing CoreDevice
        tunnels, which makes macOS tear the phone's NCM interface down again.
        """
        key = self._identity_key(udid)
        connect_lock = self._connect_locks.setdefault(key, asyncio.Lock())
        async with connect_lock:
            try:
                await asyncio.wait_for(self._connect_once(udid), timeout=20.0)
            except asyncio.TimeoutError as exc:
                logger.warning("Connection attempt timed out for %s after 20s", udid)
                raise RuntimeError(
                    "USB 裝置連線逾時；請確認線材與接頭穩定後再試。"
                ) from exc

    async def _connect_once(self, udid: str) -> None:
        """
        Establish a connection appropriate for the device's iOS version.

        Supports both USB and WiFi (Network) connections via usbmuxd.

        * **iOS 17+** -- TCP tunnel via CoreDeviceTunnelProxy + RSD.
        * **iOS 16.x** -- plain lockdown over usbmux + legacy location service.
        """
        async with self._lock:
            if self._connection_key(udid) is not None:
                logger.info("Device %s is already connected", udid)
                return

        # Detect connection type from usbmux device list.
        connection_type = "USB"
        try:
            raw_devices = await list_devices()
            for raw in raw_devices:
                if self._identity_key(raw.serial) == self._identity_key(udid):
                    connection_type = getattr(raw, "connection_type", "USB")
                    # Prefer USB if device shows up as both
                    if connection_type == "USB":
                        break
        except Exception:
            logger.debug("Could not determine connection type for %s, assuming USB", udid)

        logger.info("Connecting to %s via %s", udid, connection_type)

        # Create a fresh lockdown client to read the iOS version.
        lockdown = None
        try:
            lockdown = await create_using_usbmux(serial=udid)
            ios_version_str: str = lockdown.all_values.get("ProductVersion", "0.0")
            device_name: str = lockdown.all_values.get("DeviceName", "iPhone")
            _remember_device_name(udid, device_name)
            ver = _parse_ios_version(ios_version_str)

            if ver < (16, 0):
                logger.warning(
                    "Refusing connect: %s reports iOS %s, below minimum %s",
                    udid, ios_version_str, UnsupportedIosVersionError.MIN_VERSION,
                )
                raise UnsupportedIosVersionError(ios_version_str)

            if ver >= (17, 0):
                conn = await self._connect_tunnel(udid, lockdown, ios_version_str)
            else:
                conn = self._connect_legacy(udid, lockdown, ios_version_str)
            conn.connection_type = connection_type
            conn.name = device_name

            async with self._lock:
                existing_key = self._connection_key(udid)
                if existing_key is not None:
                    # A concurrent discovery may have inserted the same
                    # identity with different casing while the transport was
                    # being established. Keep one connection record and let
                    # the duplicate caller close its just-created handles.
                    duplicate = existing_key
                else:
                    self._connections[udid] = conn
                    duplicate = None

            if duplicate is not None:
                await self._close_connection_resources(conn, udid)
                logger.info("Device %s was connected concurrently; reusing %s", udid, duplicate)
                return

            logger.info("Connected to %s (iOS %s) via %s", udid, ios_version_str, connection_type)
        except BaseException:
            if lockdown is not None:
                try:
                    maybe_awaitable = lockdown.close()
                    if inspect.isawaitable(maybe_awaitable):
                        await maybe_awaitable
                except Exception:
                    logger.debug(
                        "Ignoring error closing failed lockdown for %s",
                        udid,
                        exc_info=True,
                    )
            logger.exception("Cannot connect to %s via %s", udid, connection_type)
            raise

    # -- iOS 17+ via CoreDeviceTunnelProxy ---------------------------------

    async def _connect_tunnel(
        self, udid: str, lockdown, ios_version: str
    ) -> _ActiveConnection:
        """TCP tunnel for iOS 17+.

        On macOS, prefer pymobiledevice3's in-process userspace tunnel. It
        avoids installing another kernel ``utun`` route alongside VPN
        clients, and it is the current pymobiledevice3 default for
        host-initiated developer services. Other platforms retain the
        existing kernel tunnel path.
        """
        logger.debug("Establishing TCP tunnel for %s (iOS %s)", udid, ios_version)

        try:
            # PyTCP supports one userspace tunnel per process. Keep the
            # existing kernel path available for an additional device in
            # LocWarp's multi-device mode.
            has_userspace_tunnel = any(
                active.userspace_tunnel is not None
                for active in self._connections.values()
            )
            if sys.platform == "darwin" and not has_userspace_tunnel:
                userspace_tunnel = UserspaceRsdTunnel(
                    serial=udid,
                    autopair=True,
                    remotepairing_fallback=False,
                )
                rsd = await userspace_tunnel.aopen()
                logger.info(
                    "Userspace RSD tunnel established for %s: %s:%s",
                    udid,
                    rsd.service.address[0],
                    rsd.service.address[1],
                )
                try:
                    await lockdown.close()
                except Exception:
                    logger.debug(
                        "Ignoring error closing discovery lockdown for %s",
                        udid,
                        exc_info=True,
                    )
                return _ActiveConnection(
                    udid=udid,
                    lockdown=rsd,
                    ios_version=ios_version,
                    userspace_tunnel=userspace_tunnel,
                    rsd=rsd,
                    usbmux_lockdown=None,
                )

            proxy = await CoreDeviceTunnelProxy.create(lockdown)
            tunnel_ctx = proxy.start_tcp_tunnel()
            tunnel_result = await tunnel_ctx.__aenter__()

            logger.info("Tunnel established for %s: %s:%s",
                        udid, tunnel_result.address, tunnel_result.port)

            # Create RSD over the tunnel
            rsd = RemoteServiceDiscoveryService((tunnel_result.address, tunnel_result.port))
            await rsd.connect()
            logger.info("RSD connected for %s", udid)

            return _ActiveConnection(
                udid=udid,
                lockdown=rsd,
                ios_version=ios_version,
                tunnel_proxy=proxy,
                tunnel_context=tunnel_ctx,
                rsd=rsd,
                usbmux_lockdown=lockdown,
            )
        except Exception:
            logger.exception(
                "TCP tunnel failed for %s (iOS %s). "
                "Ensure you are running as administrator.",
                udid, ios_version,
            )
            raise RuntimeError(
                f"無法建立裝置通道 (iOS {ios_version})。"
                f"請以系統管理員身份執行 LocWarp。"
            )

    # iOS < 17 path removed in v0.1.49 — see UnsupportedIosVersionError.

    def _connect_legacy(
        self, udid: str, lockdown, ios_version: str
    ) -> _ActiveConnection:
        """Direct usbmux lockdown connection for iOS 16.x devices."""
        logger.info("Using legacy lockdown connection for %s (iOS %s)", udid, ios_version)
        return _ActiveConnection(
            udid=udid,
            lockdown=lockdown,
            ios_version=ios_version,
            usbmux_lockdown=lockdown,
        )

    # ------------------------------------------------------------------
    # Disconnection
    # ------------------------------------------------------------------

    async def _close_connection_resources(self, conn: _ActiveConnection, udid: str) -> None:
        """Close a connection object that lost a duplicate-race publish.

        This path must not call ``disconnect(udid)`` because that would pop
        the already-published connection with the same case-insensitive
        identity. It mirrors the resource order used by disconnect().
        """
        if conn.dvt_provider is not None:
            try:
                await conn.dvt_provider.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing duplicate DvtProvider for %s", udid)
        if conn.worker is not None:
            try:
                stop_worker = getattr(conn.worker, "stop", None)
                if callable(stop_worker):
                    await stop_worker()
            except Exception:
                logger.exception("Error stopping duplicate WiFi worker for %s", udid)
        if conn.rsd is not None and conn.userspace_tunnel is None and conn.owns_rsd:
            try:
                await conn.rsd.close()
            except Exception:
                logger.exception("Error closing duplicate RSD for %s", udid)
        if conn.userspace_tunnel is not None:
            try:
                await conn.userspace_tunnel.aclose()
            except Exception:
                logger.exception("Error closing duplicate userspace tunnel for %s", udid)
        if conn.tunnel_context is not None:
            try:
                await conn.tunnel_context.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing duplicate tunnel for %s", udid)
        if conn.tunnel_proxy is not None:
            try:
                maybe_awaitable = conn.tunnel_proxy.close()
                if inspect.isawaitable(maybe_awaitable):
                    await maybe_awaitable
            except Exception:
                logger.exception("Error closing duplicate tunnel proxy for %s", udid)
        if conn.usbmux_lockdown is not None and conn.usbmux_lockdown is not conn.rsd:
            try:
                maybe_awaitable = conn.usbmux_lockdown.close()
                if inspect.isawaitable(maybe_awaitable):
                    await maybe_awaitable
            except Exception:
                logger.exception("Error closing duplicate lockdown for %s", udid)

    async def disconnect(self, udid: str, *, clear_location: bool = True) -> None:
        """Tear down the connection and clean up resources for *udid*.

        ``clear_location`` should stay ``True`` for user-initiated
        disconnect / restore flows where we still have a live transport and
        want the iPhone to revert to its real GPS immediately.

        Recovery paths (USB/WiFi reconnect, watchdog cleanup after tunnel
        death, hard reset after DeviceLostError) should pass
        ``clear_location=False`` so we do not try to clear against a dead or
        half-rebuilt DVT channel. That clear attempt was re-entering the same
        broken recovery path and causing the post-reconnect hang seen in the
        field logs ("DVT channel dropped during clear ... reconnecting").
        """
        async with self._lock:
            connection_key = self._connection_key(udid)
            conn = self._connections.pop(connection_key, None) if connection_key is not None else None

        if conn is None:
            logger.warning("Disconnect requested for unknown device %s", udid)
            return

        # Clear any active location simulation first, unless the caller is
        # already in a transport-recovery path and explicitly asked us not to
        # touch the stale DVT channel.
        if clear_location and conn.location_service is not None:
            try:
                await conn.location_service.clear(strict=True)
            except Exception:
                logger.exception("Error clearing location on disconnect for %s", udid)
        elif not clear_location and conn.location_service is not None:
            logger.info(
                "Skipping location clear while disconnecting %s during recovery teardown",
                udid,
            )

        # Shut down the DVT provider if it was opened.
        if conn.dvt_provider is not None:
            try:
                await conn.dvt_provider.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing DvtProvider for %s", udid)

        # A worker-backed WiFi connection owns the RSD/DVT process outside the
        # backend.  Stop it here as a final shutdown safety net as well as in
        # api.device's registry teardown; stop() is idempotent, so either
        # owner can win a concurrent cleanup race without leaking a child.
        if conn.worker is not None:
            try:
                stop_worker = getattr(conn.worker, "stop", None)
                if callable(stop_worker):
                    await stop_worker()
            except Exception:
                logger.exception("Error stopping WiFi worker for %s", udid)

        # Close RSD.
        if conn.rsd is not None and conn.userspace_tunnel is None and conn.owns_rsd:
            try:
                await conn.rsd.close()
            except Exception:
                logger.exception("Error closing RSD for %s", udid)

        # Close the in-process userspace tunnel after its DVT/RSD consumers.
        if conn.userspace_tunnel is not None:
            try:
                await conn.userspace_tunnel.aclose()
            except Exception:
                logger.exception("Error closing userspace tunnel for %s", udid)

        # Close tunnel context.
        if conn.tunnel_context is not None:
            try:
                await conn.tunnel_context.__aexit__(None, None, None)
            except Exception:
                logger.exception("Error closing tunnel for %s", udid)

        # Close tunnel proxy.
        if conn.tunnel_proxy is not None:
            try:
                maybe_awaitable = conn.tunnel_proxy.close()
                if inspect.isawaitable(maybe_awaitable):
                    await maybe_awaitable
            except Exception:
                logger.exception("Error closing tunnel proxy for %s", udid)

        # Release the original usbmux lockdown session. Reconnects used to
        # accumulate these sessions indefinitely, adding more pressure to an
        # already flapping USB transport.
        if conn.usbmux_lockdown is not None and conn.usbmux_lockdown is not conn.rsd:
            try:
                maybe_awaitable = conn.usbmux_lockdown.close()
                if inspect.isawaitable(maybe_awaitable):
                    await maybe_awaitable
            except Exception:
                logger.exception("Error closing usbmux lockdown for %s", udid)

        logger.info("Disconnected device %s", udid)

    # ------------------------------------------------------------------
    # Location service
    # ------------------------------------------------------------------

    async def get_location_service(self, udid: str) -> LocationService:
        """
        Return a ``LocationService`` instance for the given device.

        The concrete type depends on the iOS version:

        * iOS 17+  ->  ``DvtLocationService`` (uses DVT instrumentation)
        * iOS < 17 ->  ``LegacyLocationService`` (uses DtSimulateLocation)

        The service is cached on the connection so subsequent calls are cheap.
        """
        async with self._lock:
            connection_key = self._connection_key(udid)
            conn = self._connections.get(connection_key) if connection_key is not None else None

        if conn is None:
            raise RuntimeError(
                f"Device {udid} is not connected. Call connect() first."
            )

        if conn.location_service is not None:
            return conn.location_service

        ver = _parse_ios_version(conn.ios_version)
        if ver >= (17, 0):
            loc = await self._create_dvt_location_service(conn)
        else:
            loc = await self._create_legacy_location_service(conn)
        conn.location_service = loc
        return loc

    async def _ensure_personalized_ddi_mounted(self, conn: _ActiveConnection) -> None:
        """Check whether the Personalized DDI is mounted on the iPhone.

        v0.2.58 change: LocWarp no longer auto-downloads / auto-mounts
        the DDI. On iOS 26.4.1 the 20MB image upload routinely dropped
        the RSD tunnel mid-transfer, poisoning subsequent DVT calls
        with InvalidService. We now rely on the iPhone already having
        the DDI mounted (Xcode, 3uTools, 愛思助手, pymobiledevice3 CLI,
        or an earlier successful mount that iOS is still caching).

        This method is therefore a pure status check. If the iPhone
        has DDI mounted we log it and return happily. If not, we emit
        a WS event so the UI can tell the user to mount it via another
        tool, and we return anyway — the caller (`_create_dvt_location_service`)
        will then attempt DVT directly and produce a clean error if
        dtservicehub isn't advertised.
        """
        mounted = await self._query_personalized_ddi_mounted(conn)
        if mounted is None:
            return

        if mounted:
            logger.info("Personalized DDI already mounted on %s; DVT should work", conn.udid)
            await self._broadcast_ddi_event("ddi_mounted", {"udid": conn.udid})
            return

        logger.warning(
            "Personalized DDI is NOT mounted on %s. LocWarp will not "
            "auto-mount; please mount DDI for this iPhone first, then "
            "reconnect.", conn.udid,
        )
        await self._broadcast_ddi_event("ddi_not_mounted", {
            "udid": conn.udid,
            "hint": (
                "iPhone 上未偵測到 DDI。請先為這支 iPhone 掛載一次 DDI(Developer Disk Image),"
                "再重新連接 LocWarp;或先重開 iPhone 後再試。"
            ),
        })

    async def _broadcast_ddi_event(self, event: str, payload: dict) -> None:
        try:
            from api.websocket import broadcast
            await broadcast(event, payload)
        except Exception:
            pass

    async def _query_personalized_ddi_mounted(self, conn: _ActiveConnection) -> Optional[bool]:
        try:
            from pymobiledevice3.services.mobile_image_mounter import MobileImageMounterService
        except ImportError as exc:
            logger.warning(
                "pymobiledevice3 mobile_image_mounter not importable (%s: %s); "
                "skipping DDI status check", type(exc).__name__, exc,
            )
            return None

        try:
            mounter = MobileImageMounterService(lockdown=conn.lockdown)
            try:
                await mounter.connect()
                return await mounter.is_image_mounted("Personalized")
            finally:
                try:
                    await mounter.close()
                except Exception:
                    pass
        except Exception:
            logger.warning("Could not query DDI mount status on %s", conn.udid, exc_info=True)
            return None

    def _personalized_ddi_cache_paths(self) -> dict[str, Path]:
        base = Path.home() / ".pymobiledevice3" / "Xcode_iOS_DDI_Personalized"
        return {
            "base": base,
            "image": base / "Image.dmg",
            "manifest": base / "BuildManifest.plist",
            "trustcache": base / "Image.trustcache",
        }

    async def _mount_cached_personalized_ddi(self, conn: _ActiveConnection) -> bool:
        try:
            from pymobiledevice3.exceptions import AlreadyMountedError
            from pymobiledevice3.services.mobile_image_mounter import PersonalizedImageMounter
        except ImportError as exc:
            raise DDIMountError(
                "ddi_mount_failed",
                f"無法載入 Personalized DDI 掛載模組: {exc}",
            ) from exc

        cache = self._personalized_ddi_cache_paths()
        missing = [str(path) for key, path in cache.items() if key != "base" and not path.exists()]
        if missing:
            raise DDIMountError(
                "ddi_cache_missing",
                "本機找不到已快取的 Personalized DDI 素材，缺少: " + ", ".join(missing),
            )

        logger.info(
            "Personalized DDI repair requested for %s; using cached files from %s",
            conn.udid,
            cache["base"],
        )
        await self._broadcast_ddi_event("ddi_mounting", {
            "udid": conn.udid,
            "stage": "cached-image",
        })

        mounter = PersonalizedImageMounter(lockdown=conn.lockdown)
        try:
            await asyncio.wait_for(
                mounter.mount(cache["image"], cache["manifest"], cache["trustcache"]),
                timeout=120.0,
            )
            logger.info("Personalized DDI mounted successfully for %s", conn.udid)
            await self._broadcast_ddi_event("ddi_mounted", {"udid": conn.udid})
            return True
        except AlreadyMountedError:
            logger.info("Personalized DDI already mounted during repair flow for %s", conn.udid)
            await self._broadcast_ddi_event("ddi_mounted", {"udid": conn.udid})
            return True
        except Exception as exc:
            logger.warning("Personalized DDI mount failed for %s", conn.udid, exc_info=True)
            await self._broadcast_ddi_event("ddi_mount_failed", {
                "udid": conn.udid,
                "error": str(exc),
            })
            raise DDIMountError(
                "ddi_mount_failed",
                f"DDI 掛載失敗，請確認 iPhone 已解鎖且開發者模式已開啟: {exc}",
            ) from exc
        finally:
            try:
                await mounter.close()
            except Exception:
                pass

    async def mount_personalized_ddi(self, udid: str) -> dict[str, object]:
        async with self._lock:
            connection_key = self._connection_key(udid)
            conn = self._connections.get(connection_key) if connection_key is not None else None

        if conn is None:
            raise DDIMountError("device_not_connected", f"找不到已連線裝置: {udid}")
        if _parse_ios_version(conn.ios_version) < (17, 0):
            raise DDIMountError(
                "ddi_mount_unsupported",
                f"此流程只適用 iOS 17+，目前裝置為 iOS {conn.ios_version}",
            )
        if conn.connection_type != "USB":
            raise DDIMountError(
                "ddi_mount_needs_usb",
                "掛載 Personalized DDI 需要 USB 直連，請先插上 iPhone 再試。",
            )

        mounted = await self._query_personalized_ddi_mounted(conn)
        if mounted:
            return {
                "udid": udid,
                "already_mounted": True,
                "mounted": True,
                "reconnected": False,
                "message": "Personalized DDI 已經掛載，不需要再次處理。",
            }

        await self._mount_cached_personalized_ddi(conn)

        logger.info(
            "Refreshing USB connection after DDI repair for %s so fresh RSD/DVT handles are used",
            udid,
        )
        reconnected = await self.full_reconnect(udid)
        message = (
            "DDI 已掛載，且已重新建立 USB 連線。"
            if reconnected
            else "DDI 已掛載，但 USB 連線刷新失敗，請手動重新插拔或重新連線。"
        )
        return {
            "udid": udid,
            "already_mounted": False,
            "mounted": True,
            "reconnected": reconnected,
            "message": message,
        }

    async def _ensure_classic_ddi_mounted(self, conn: _ActiveConnection) -> None:
        """Best-effort Developer Disk Image mount for iOS 16.x devices."""
        try:
            import pymobiledevice3.services.mobile_image_mounter as mim
        except ImportError as exc:
            logger.warning(
                "mobile_image_mounter not importable for classic DDI (%s: %s); "
                "skipping classic DDI mount",
                type(exc).__name__, exc,
            )
            return

        mounter_cls = getattr(mim, "MobileImageMounterService", None)
        if mounter_cls is not None:
            try:
                mounter = mounter_cls(lockdown=conn.lockdown)
                try:
                    await mounter.connect()
                    if await mounter.is_image_mounted("Developer"):
                        logger.debug("Classic DDI already mounted on %s", conn.udid)
                        return
                finally:
                    try:
                        await mounter.close()
                    except Exception:
                        pass
            except Exception:
                logger.warning("Could not query classic DDI mount state", exc_info=True)

        mount_fn = None
        for name in ("auto_mount_developer", "auto_mount", "auto_mount_disk_image"):
            candidate = getattr(mim, name, None)
            if callable(candidate):
                mount_fn = candidate
                break
        if mount_fn is None:
            logger.warning("No classic DDI auto-mount helper found; continuing without mount")
            return

        logger.info("Classic DDI not mounted on %s; attempting auto-mount", conn.udid)
        try:
            from api.websocket import broadcast
            await broadcast("ddi_mounting", {"udid": conn.udid})
        except Exception:
            pass

        mounted = False
        try:
            await asyncio.wait_for(mount_fn(conn.lockdown), timeout=120.0)
            mounted = True
            logger.info("Classic DDI mounted successfully for %s", conn.udid)
        except Exception:
            logger.warning("Classic DDI auto-mount failed for %s", conn.udid, exc_info=True)
        finally:
            try:
                from api.websocket import broadcast
                event = "ddi_mounted" if mounted else "ddi_mount_failed"
                payload = {"udid": conn.udid}
                if not mounted:
                    payload["error"] = "Classic DDI mount failed"
                await broadcast(event, payload)
            except Exception:
                pass

    async def _create_dvt_location_service(
        self, conn: _ActiveConnection
    ) -> DvtLocationService:
        """Spin up a DVT provider and hand it to ``DvtLocationService``.

        If DVT fails because the Developer Disk Image is not mounted,
        we try to mount it automatically and retry once.
        """
        # Try to mount DDI proactively (fast no-op when already mounted).
        try:
            await self._ensure_personalized_ddi_mounted(conn)
        except Exception:
            logger.warning("DDI auto-mount failed; DVT may still fail", exc_info=True)

        try:
            dvt = DvtProvider(conn.lockdown)
            await dvt.__aenter__()
            conn.dvt_provider = dvt
            logger.debug("DVT provider opened for %s", conn.udid)
            # Bind a per-udid factory so DvtLocationService._reconnect can
            # ask us for a fresh DvtProvider on the *current* lockdown.
            # This is what makes the location service survive WiFi tunnel
            # restarts — when the tunnel watchdog rebuilds the tunnel and
            # replaces conn.lockdown, the factory picks up the new one
            # automatically instead of rebuilding on a now-orphan ref.
            udid = conn.udid

            async def _factory(_udid: str = udid) -> DvtProvider:
                return await self.get_fresh_dvt_provider(_udid)

            return DvtLocationService(
                dvt,
                lockdown=conn.lockdown,
                dvt_factory=_factory,
            )
        except Exception as dvt_exc:
            logger.warning(
                "DVT location service failed for %s (%s). Falling back to "
                "legacy DtSimulateLocation over lockdown.",
                conn.udid, dvt_exc,
            )
            # iOS 17+ still exposes com.apple.dt.simulatelocation on some
            # devices (reported working on iOS 26 by multiple users), so
            # try the legacy service before giving up entirely.
            try:
                # Prefer the original usbmux/TCP lockdown for DtSimulateLocation;
                # fall back to whatever we have stored if not available.
                legacy_lockdown = conn.usbmux_lockdown or conn.lockdown
                legacy = LegacyLocationService(legacy_lockdown)
                logger.info("Using LegacyLocationService fallback for %s", conn.udid)
                return legacy
            except Exception:
                logger.exception(
                    "Both DVT and legacy location services failed for %s", conn.udid
                )
                raise dvt_exc

    async def _create_legacy_location_service(
        self, conn: _ActiveConnection
    ) -> LegacyLocationService:
        """Build the legacy location service for iOS 16.x devices."""
        try:
            await self._ensure_classic_ddi_mounted(conn)
        except Exception:
            logger.warning("Classic DDI auto-mount failed; legacy location may still fail", exc_info=True)
        logger.info("Using LegacyLocationService for %s", conn.udid)
        return LegacyLocationService(conn.lockdown)

    # _ensure_classic_ddi_mounted, _create_legacy_location_service, and
    # connect_wifi (legacy direct-IP WiFi) removed in v0.1.49 — see
    # UnsupportedIosVersionError. iOS 17+ continues to use the
    # personalized DDI mount path + DvtLocationService (with
    # LegacyLocationService as a runtime fallback inside
    # _create_dvt_location_service when DVT itself fails).

    # ------------------------------------------------------------------
    # WiFi connection (iOS 17+ tunnel only)
    # ------------------------------------------------------------------

    async def _adopt_wifi_worker(self, worker: object) -> DeviceInfo:
        """Adopt one process-isolated worker under its canonical UDID lock."""
        worker_info = getattr(worker, "info", None) or {}
        udid = str(getattr(worker, "udid", None) or worker_info.get("udid") or "")
        if not udid or udid.startswith("pending:"):
            raise RuntimeError("WiFi worker did not provide a verified device UDID")
        worker_rsd = getattr(worker, "rsd", None)
        if worker_rsd is not None:
            raise RuntimeError("worker connection must not expose an in-process RSD")
        worker_location = getattr(worker, "location_service", None)
        if worker_location is None:
            raise RuntimeError("WiFi worker did not expose a location proxy")
        worker_ios = str(worker_info.get("ios_version") or "0.0")
        worker_name = str(worker_info.get("name") or "iPhone")

        identity = self._identity_key(udid)
        connect_lock = self._connect_locks.setdefault(identity, asyncio.Lock())
        async with connect_lock:
            existing_key = self._connection_key(udid)
            if existing_key is not None:
                existing_conn = self._connections[existing_key]
                if getattr(existing_conn, "worker", None) is worker:
                    # Concurrent stale-IP attempts can converge on the exact
                    # same verified worker. Reuse it; closing a duplicate
                    # connection record would stop the worker already owned by
                    # the first request.
                    return DeviceInfo(
                        udid=existing_conn.udid,
                        name=existing_conn.name or worker_name,
                        ios_version=existing_conn.ios_version or worker_ios,
                        connection_type="Network",
                        is_connected=True,
                    )
                await self.disconnect(existing_key, clear_location=False)

            conn = _ActiveConnection(
                udid=udid,
                lockdown=None,
                ios_version=worker_ios,
                connection_type="Network",
                name=worker_name,
                location_service=worker_location,
                external_location_service=True,
                worker=worker,
                owns_rsd=False,
            )
            async with self._lock:
                publish_key = self._connection_key(udid)
                if publish_key is None:
                    self._connections[udid] = conn
                    duplicate = None
                else:
                    duplicate = publish_key
            if duplicate is not None:
                existing = self._connection_for(duplicate)
                if existing is not None and getattr(existing, "worker", None) is worker:
                    return DeviceInfo(
                        udid=existing.udid,
                        name=existing.name or worker_name,
                        ios_version=existing.ios_version or worker_ios,
                        connection_type="Network",
                        is_connected=True,
                    )
                await self._close_connection_resources(conn, udid)
                existing = self._connection_for(duplicate)
                return DeviceInfo(
                    udid=existing.udid if existing is not None else duplicate,
                    name=existing.name if existing is not None else worker_name,
                    ios_version=existing.ios_version if existing is not None else worker_ios,
                    connection_type="Network",
                    is_connected=True,
                )

            logger.info("Adopted worker-backed WiFi connection for %s (iOS %s)", udid, worker_ios)
            return DeviceInfo(
                udid=udid,
                name=worker_name,
                ios_version=worker_ios,
                connection_type="Network",
                is_connected=True,
            )

    async def connect_wifi_tunnel(
        self,
        rsd_address: str,
        rsd_port: int,
        *,
        existing_rsd: RemoteServiceDiscoveryService | None = None,
        worker: object | None = None,
    ) -> DeviceInfo:
        """Connect to a device via an existing WiFi tunnel.

        Use this when a WiFi tunnel has already been established (by the
        in-process ``TunnelRunner`` or ``pymobiledevice3 remote start-tunnel``).
        The caller provides the RSD address and port.

        Returns a ``DeviceInfo`` describing the connected device.
        """
        logger.info("Connecting via WiFi tunnel RSD at %s:%d", rsd_address, rsd_port)

        # A macOS worker cannot share its RSD/dial plane with the backend
        # process.  It has already validated the target UDID and opened DVT;
        # adopt only its serialisable identity and location proxy.
        if worker is not None:
            return await self._adopt_wifi_worker(worker)

        rsd = existing_rsd
        owns_rsd = existing_rsd is None
        if rsd is None:
            import asyncio as _asyncio
            last_exc: Exception | None = None
            # Kernel TUN routes (Windows and the standalone endpoint) may
            # take a few seconds to become reachable after the provider says
            # ready, so retain the established retry path there.
            for attempt in range(1, 11):
                rsd = RemoteServiceDiscoveryService((rsd_address, rsd_port))
                try:
                    await rsd.connect()
                    last_exc = None
                    break
                except Exception as exc:
                    last_exc = exc
                    logger.warning(
                        "RSD connect attempt %d/10 failed (%s): %s",
                        attempt, exc.__class__.__name__, exc,
                    )
                    try:
                        await rsd.close()
                    except (OSError, ConnectionError):
                        pass
                    await _asyncio.sleep(min(0.5 * attempt, 2.0))

            if last_exc is not None:
                logger.error("Failed to connect to RSD at %s:%d after retries", rsd_address, rsd_port)
                raise RuntimeError(
                    f"無法連線到 WiFi tunnel RSD ({rsd_address}:{rsd_port})。"
                    "請確認 WiFi tunnel 仍然活躍。"
                ) from last_exc
        else:
            logger.info(
                "Adopting TunnelRunner's connected userspace RSD at %s:%d",
                rsd_address,
                rsd_port,
            )

        assert rsd is not None

        peer = rsd.peer_info or {}
        props = peer.get("Properties", {})
        udid = props.get("UniqueDeviceID", "")
        ios_version_str = props.get("OSVersion", "0.0")
        # peer_info["Properties"] only carries DeviceClass ("iPhone"), not
        # the user-set DeviceName (e.g. "My iPhone"). RSD.connect() already
        # opens a lockdown service over the tunnel internally and exposes
        # the result as rsd.all_values, so the live DeviceName is right
        # there for free. We still keep two fallbacks for the edge case
        # where the lockdown sub-service failed (e.g. RemoteXPC variants
        # that don't advertise it): a still-active USB conn's cached name,
        # then the persisted ~/.locwarp/device_names.json populated
        # whenever USB or discovery saw a real DeviceName.
        all_values = getattr(rsd, "all_values", None) or {}
        device_name = all_values.get("DeviceName") or ""
        if not device_name:
            existing = self._connection_for(udid)
            if existing is not None and existing.name and existing.name != "iPhone":
                device_name = existing.name
        if not device_name:
            cached = _load_device_name_cache().get(udid)
            if cached:
                device_name = cached
        if not device_name:
            device_name = props.get("DeviceClass", "iPhone")
        # Live DeviceName from the WiFi tunnel is just as authoritative as
        # USB, so feed it back into the persistent cache too — covers the
        # "user renamed the device since last USB plug" case.
        _remember_device_name(udid, device_name)

        existing_key = self._connection_key(udid)
        if existing_key is not None:
            await self.disconnect(existing_key, clear_location=False)

        conn = _ActiveConnection(
            udid=udid,
            lockdown=rsd,
            ios_version=ios_version_str,
            connection_type="Network",
            name=device_name,
            rsd=rsd,
            owns_rsd=owns_rsd,
        )

        async with self._lock:
            publish_key = self._connection_key(udid)
            if publish_key is None:
                self._connections[udid] = conn
            else:
                # Keep the first canonical record if two external callers
                # adopt the same RSD concurrently. The new RSD has not been
                # published, so it can be closed without touching the live
                # connection.
                duplicate = publish_key
        if publish_key is not None:
            if owns_rsd:
                try:
                    await rsd.close()
                except Exception:
                    logger.debug("Ignoring duplicate WiFi RSD close for %s", udid, exc_info=True)
            existing = self._connection_for(duplicate)
            return DeviceInfo(
                udid=existing.udid if existing is not None else duplicate,
                name=existing.name if existing is not None else device_name,
                ios_version=existing.ios_version if existing is not None else ios_version_str,
                connection_type="Network",
                is_connected=True,
            )

        logger.info("WiFi tunnel connected to %s (iOS %s)", udid, ios_version_str)

        return DeviceInfo(
            udid=udid,
            name=device_name,
            ios_version=ios_version_str,
            connection_type="Network",
            is_connected=True,
        )

    async def scan_wifi_devices(
        self,
        subnet: str | None = None,
        timeout: float = 0.5,
    ) -> list[dict]:
        """Scan the local network for iOS devices on port 62078 (lockdownd).

        Tries each IP in the subnet concurrently.  Returns a list of
        ``{"ip": ..., "name": ..., "udid": ...}`` dicts for reachable
        devices.

        If *subnet* is not given, the local machine's subnet is guessed
        from the default route interface.
        """
        if subnet is None:
            subnet = _guess_local_subnet()
            if subnet is None:
                logger.warning("Cannot determine local subnet for WiFi scan")
                return []

        logger.info("Scanning subnet %s for iOS devices...", subnet)

        # Generate IPs: e.g. "192.168.1" → .1 to .254
        base = subnet.rsplit(".", 1)[0]
        ips = [f"{base}.{i}" for i in range(1, 255)]

        async def _probe(ip: str) -> dict | None:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(ip, 62078),
                    timeout=timeout,
                )
                writer.close()
                await writer.wait_closed()
                # Port is open — try a quick lockdown to get device info
                try:
                    pair_rec = _load_pair_record()
                    lockdown = await asyncio.wait_for(
                        create_using_tcp(
                            ip,
                            pair_record=pair_rec,
                            autopair=pair_rec is None,
                        ),
                        timeout=5.0,
                    )
                    vals = lockdown.all_values
                    return {
                        "ip": ip,
                        "name": vals.get("DeviceName", "Unknown"),
                        "udid": vals.get("UniqueDeviceID", lockdown.udid or ""),
                        "ios_version": vals.get("ProductVersion", "0.0"),
                    }
                except Exception:
                    # Port open but lockdown failed — still report it
                    return {"ip": ip, "name": "iOS Device", "udid": "", "ios_version": ""}
            except (OSError, asyncio.TimeoutError):
                return None

        results = await asyncio.gather(*[_probe(ip) for ip in ips])
        found = [r for r in results if r is not None]
        logger.info("WiFi scan found %d device(s)", len(found))
        return found

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    @property
    def connected_udids(self) -> list[str]:
        """Return the UDIDs of all currently connected devices."""
        return list(self._connections.keys())

    def is_connected(self, udid: str) -> bool:
        """Check whether a device is currently connected."""
        return self._connection_key(udid) is not None

    def get_connection_type(self, udid: str) -> str:
        """Return ``'USB'`` or ``'Network'`` for a connected device."""
        conn = self._connection_for(udid)
        return conn.connection_type if conn else "USB"

    # ------------------------------------------------------------------
    # Recovery helpers (used by location_service factory + API safety net)
    # ------------------------------------------------------------------

    async def get_fresh_dvt_provider(
        self, udid: str, *, timeout: float = 15.0
    ) -> DvtProvider:
        """Return a freshly-opened ``DvtProvider`` for *udid*.

        Used by ``DvtLocationService._reconnect`` after the DVT instrument
        channel drops. Probes connection health, transparently waits for
        any in-flight WiFi tunnel restart driven by ``_per_tunnel_watchdog``
        (see ``api/device.py``), then opens a new ``DvtProvider`` on the
        *current* lockdown. The previous provider stored on the active
        connection is closed best-effort.

        Raises ``DeviceLostError`` (with a categorised ``reason``) when
        no live provider can be obtained inside *timeout* seconds —
        typically because the user really did unplug USB, turn off the
        iPhone, or the WiFi tunnel cannot be restarted.
        """
        import time
        started_at = time.monotonic()
        deadline = started_at + timeout
        last_exc: Exception | None = None
        usb_reconnect_attempted = False

        while True:
            async with self._lock:
                connection_key = self._connection_key(udid)
                conn = self._connections.get(connection_key) if connection_key is not None else None

            if conn is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DeviceLostError(
                        f"Device {udid} no longer connected",
                        reason=DeviceLostError.REASON_USB_GONE,
                    )
                # During USB/WiFi auto-recovery there can be a brief window
                # where the old connection has been torn down but the watchdog
                # has not yet recreated the new one. Wait out that gap instead
                # of surfacing DeviceLostError immediately.
                await asyncio.sleep(min(0.5, remaining))
                continue

            # WiFi: peek at the tunnel runner. If it has died, the watchdog
            # is in the middle of restarting it — wait until either a fresh
            # runner appears (success path swaps in a new TunnelRunner and
            # replaces conn.lockdown along the way) or we time out.
            if conn.connection_type == "Network":
                runner = None
                try:
                    from api.device import _tunnels  # local import: avoids cycle at module load
                    runner = _tunnels.get(udid)
                    if runner is None:
                        # The worker registry is normalized, while older
                        # callers may still pass the original UDID casing.
                        runner = next(
                            (
                                candidate
                                for key, candidate in _tunnels.items()
                                if str(key).lower() == str(udid).lower()
                            ),
                            None,
                        )
                except ImportError:
                    runner = None
                if runner is not None and not runner.is_running():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise DeviceLostError(
                            f"WiFi tunnel for {udid} did not restart in {timeout:.0f}s",
                            reason=DeviceLostError.REASON_TUNNEL_DEAD,
                        )
                    await asyncio.sleep(min(0.5, remaining))
                    continue

                # A macOS WiFi worker keeps RSD, dial-plane, DVT, and the
                # location instrument in its child process.  The parent
                # connection intentionally has ``lockdown=None`` and only a
                # LocationService proxy.  Never call DvtProvider(None):
                # surface a typed tunnel failure so the API recovery layer
                # invokes full_reconnect(), which rebuilds this worker.
                if getattr(conn, "worker", None) is not None or getattr(
                    conn, "external_location_service", False
                ):
                    raise DeviceLostError(
                        f"WiFi worker owns the DVT channel for {udid}; restart the worker",
                        reason=DeviceLostError.REASON_TUNNEL_DEAD,
                    )

            # USB, or WiFi with a live tunnel: try opening a new DvtProvider.
            try:
                new_dvt = DvtProvider(conn.lockdown)
                await new_dvt.__aenter__()
            except Exception as exc:
                last_exc = exc
                elapsed = time.monotonic() - started_at
                remaining = deadline - time.monotonic()
                if (
                    conn.connection_type == "USB"
                    and not usb_reconnect_attempted
                    and elapsed >= 1.5
                ):
                    usb_reconnect_attempted = True
                    logger.warning(
                        "DVT provider probe still failing for %s over USB (%s: %s); attempting full USB reconnect (phase=full_reconnect)",
                        udid, type(exc).__name__, exc,
                    )
                    try:
                        await self.full_reconnect(udid)
                    except Exception:
                        logger.exception("In-place USB full_reconnect raised for %s", udid)
                    continue
                if remaining <= 0:
                    logger.warning(
                        "get_fresh_dvt_provider exhausted for %s: %s", udid, exc,
                    )
                    raise DeviceLostError(
                        f"Could not open DvtProvider for {udid}: {exc}",
                        reason=DeviceLostError.REASON_LOCKDOWN_DEAD,
                    ) from exc
                await asyncio.sleep(min(0.5, remaining))
                continue

            # Success — swap into the active connection record so future
            # discover/clear paths find it. Best-effort close on the old.
            old_dvt = conn.dvt_provider
            conn.dvt_provider = new_dvt
            if old_dvt is not None and old_dvt is not new_dvt:
                try:
                    await old_dvt.__aexit__(None, None, None)
                except Exception:
                    logger.debug(
                        "Ignoring error closing stale DvtProvider for %s",
                        udid, exc_info=True,
                    )
            logger.info("DVT provider re-acquired for %s (phase=provider_reacquire)", udid)
            return new_dvt

    async def full_reconnect(self, udid: str) -> bool:
        """Last-resort recovery: force a complete teardown + reconnect.

        Used as the API-layer safety net (``api/location.py``) when the
        location service's factory-driven reconnect still raised
        ``DeviceLostError``. For WiFi this drives the same restart path
        the tunnel watchdog uses (rebuilding tunnel + RSD lockdown +
        DvtProvider). For USB, this disconnects + reconnects from
        scratch.

        Returns ``True`` when *udid* is healthily connected at exit.
        """
        async with self._lock:
            connection_key = self._connection_key(udid)
            conn = self._connections.get(connection_key) if connection_key is not None else None
        conn_type = conn.connection_type if conn else None
        # Keep all subsequent teardown/reconnect operations on the stored
        # canonical spelling. Callers may pass a casing-only alias from RSD,
        # the UI, or a cached worker record.
        target_udid = connection_key or udid

        if conn_type == "Network":
            logger.info("full_reconnect starting for %s over Network", udid)
            try:
                from api.device import _tunnels, _attempt_tunnel_restart
            except ImportError:
                logger.debug("full_reconnect: api.device not importable")
                return False
            runner = _tunnels.get(target_udid)
            if runner is None:
                runner = next(
                    (
                        candidate
                        for key, candidate in _tunnels.items()
                        if self._identity_key(key) == self._identity_key(target_udid)
                    ),
                    None,
                )
            if runner is None or not runner.target_ip or not runner.target_port:
                logger.debug(
                    "full_reconnect: no live tunnel runner for %s; cannot recover", target_udid,
                )
                return False
            try:
                ok = await _attempt_tunnel_restart(
                    target_udid, runner.target_ip, runner.target_port, None, runner,
                )
                logger.info("full_reconnect finished for %s over Network (ok=%s)", target_udid, bool(ok))
                return bool(ok)
            except Exception:
                logger.exception("full_reconnect: WiFi tunnel restart failed for %s", target_udid)
                return False

        # USB (or unknown type — try the bluntest recovery available).
        logger.info("full_reconnect starting for %s over USB", udid)
        try:
            try:
                await self.disconnect(target_udid, clear_location=False)
            except Exception:
                logger.debug("full_reconnect: USB disconnect failed for %s", target_udid, exc_info=True)
            await self.connect(target_udid)
            async with self._lock:
                ok = self._connection_key(target_udid) is not None
            logger.info("full_reconnect finished for %s over USB (ok=%s)", target_udid, ok)
            return ok
        except Exception:
            logger.exception("full_reconnect: USB reconnect failed for %s", udid)
            return False

    async def disconnect_all(self) -> None:
        """Disconnect every active device."""
        udids = list(self._connections.keys())
        for udid in udids:
            await self.disconnect(udid)
        logger.info("All devices disconnected")


def _load_pair_record(udid: str | None = None) -> dict | None:
    """Load a USB pair record from Apple's system Lockdown store.

    On Windows, pair records live in ``%ALLUSERSPROFILE%\\Apple\\Lockdown``.
    If *udid* is given, loads that specific record; otherwise loads the
    first ``.plist`` found (most setups have only one device).
    """
    import os
    import plistlib

    lockdown_dir = Path(os.environ.get("ALLUSERSPROFILE", "C:/ProgramData")) / "Apple" / "Lockdown"
    if not lockdown_dir.exists():
        logger.debug("Apple Lockdown directory not found: %s", lockdown_dir)
        return None

    target: Path | None = None
    if udid:
        candidate = lockdown_dir / f"{udid}.plist"
        if candidate.exists():
            target = candidate
    else:
        # Pick the first device plist (skip SystemConfiguration.plist)
        for f in lockdown_dir.glob("*.plist"):
            if f.stem != "SystemConfiguration":
                target = f
                break

    if target is None:
        logger.debug("No pair record found in %s", lockdown_dir)
        return None

    try:
        with open(target, "rb") as fh:
            record = plistlib.load(fh)
        logger.debug("Loaded pair record from %s", target)
        return record
    except Exception:
        logger.exception("Failed to load pair record from %s", target)
        return None


def _guess_local_subnet() -> str | None:
    """Best-effort guess of the local LAN subnet (e.g. '192.168.1.0/24').

    Returns the base IP like '192.168.1.0' or ``None`` if unable to determine.
    """
    try:
        # Open a UDP socket to a public IP (doesn't actually send)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        # Return the /24 base
        parts = local_ip.rsplit(".", 1)
        return f"{parts[0]}.0"
    except (OSError, IndexError):
        return None
