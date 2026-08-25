import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import API_HOST, API_PORT, SETTINGS_FILE, DEFAULT_LOCATION
from security import DesktopApiSecurityMiddleware
from core.device_manager import DeviceManager
from services.cooldown import CooldownTimer
from services.bookmarks import BookmarkManager
from services.route_store import RouteManager
from services.coord_format import CoordinateFormatter
from services.reconnect import ReconnectManager
from services.connection_health import ConnectionHealthTracker

# Configure logging — console + rotating file in ~/.locwarp/logs/
_log_fmt = "%(asctime)s [%(name)s] %(levelname)s: %(message)s"
_log_dir = Path.home() / ".locwarp" / "logs"
_legacy_log_moved: Path | None = None
try:
    _log_dir.mkdir(parents=True, exist_ok=True)
    _active_log = _log_dir / "backend.log"
    # Releases before the non-root migration created backend.log as root.
    # The user owns the containing directory, so preserve the old file under a
    # timestamped name and create a fresh writable log without another admin
    # prompt.  Never delete the diagnostic history.
    if _active_log.exists() and not os.access(_active_log, os.W_OK):
        _legacy_log_moved = _log_dir / (
            f"backend.root-owned-{time.strftime('%Y%m%d-%H%M%S')}.log"
        )
        _active_log.rename(_legacy_log_moved)
    _file_handler = RotatingFileHandler(
        _active_log,
        maxBytes=2 * 1024 * 1024,  # 2 MB
        backupCount=3,
        encoding="utf-8",
    )
    _file_handler.setFormatter(logging.Formatter(_log_fmt))
    _file_handler.setLevel(logging.INFO)
    _handlers = [logging.StreamHandler(), _file_handler]
except Exception:
    _handlers = [logging.StreamHandler()]
logging.basicConfig(level=logging.INFO, format=_log_fmt, handlers=_handlers, force=True)
logger = logging.getLogger("locwarp")
if _legacy_log_moved is not None:
    logger.warning("Preserved legacy root-owned log as %s", _legacy_log_moved)


class AppState:
    """Central application state — shared across API endpoints."""

    def __init__(self):
        self.device_manager = DeviceManager()
        # Per-udid simulation engines (group mode, max 3). The legacy
        # `simulation_engine` attribute still returns the most-recently-
        # created engine for single-device call sites that have not yet
        # been refactored.
        self.simulation_engines: dict = {}
        self._engine_locks: dict[str, asyncio.Lock] = {}
        self._primary_udid: str | None = None
        self.cooldown_timer = CooldownTimer()
        self.bookmark_manager = BookmarkManager()
        self.route_manager = RouteManager()
        self.coord_formatter = CoordinateFormatter()
        self.reconnect_manager = None
        self.connection_health = ConnectionHealthTracker()
        self._last_position = None
        # User-chosen initial map center (persisted between launches). When
        # None, the frontend falls back to a hardcoded default.
        self._initial_map_position: dict | None = None
        # Which bookmark category ids the user has expanded in the panel.
        # None = never set (first-time install); frontend applies the
        # "auto-collapse when total bookmarks > 30" rule. Empty list means
        # explicitly all-collapsed.
        self._bookmark_expanded_categories: list[str] | None = None
        # Geocode provider preference. Mirrors what the desktop UI saves to
        # its own localStorage, so /api/phone/geocode (which runs against
        # the backend, not the renderer) can honour the same choice.
        self._geocode_provider: str = "nominatim"
        self._google_geocode_key: str = ""
        # WiFi tunnel keep-alive: re-push the current simulated location to
        # idle Network tunnels so iOS doesn't drop the RSD socket when the
        # phone screen turns off. Default ON; user can toggle in the panel.
        self._wifi_keepalive_enabled: bool = True
        self._load_settings()

    def _load_settings(self):
        from services.json_safe import safe_load_json
        data = safe_load_json(SETTINGS_FILE)
        if not isinstance(data, dict):
            return
        try:
            pos = data.get("last_position")
            if pos:
                self._last_position = pos
            fmt = data.get("coord_format")
            if fmt:
                from models.schemas import CoordinateFormat
                self.coord_formatter.format = CoordinateFormat(fmt)
            imp = data.get("initial_map_position")
            if isinstance(imp, dict) and "lat" in imp and "lng" in imp:
                self._initial_map_position = {"lat": float(imp["lat"]), "lng": float(imp["lng"])}
            bmExp = data.get("bookmark_expanded_categories")
            if isinstance(bmExp, list):
                self._bookmark_expanded_categories = [str(x) for x in bmExp]
            gp = data.get("geocode_provider")
            if isinstance(gp, str) and gp in ("nominatim", "photon", "google"):
                self._geocode_provider = gp
            gk = data.get("google_geocode_key")
            if isinstance(gk, str):
                self._google_geocode_key = gk
            ka = data.get("wifi_keepalive_enabled")
            if isinstance(ka, bool):
                self._wifi_keepalive_enabled = ka
        except (ValueError, KeyError):
            logger.warning("Settings payload field malformed; keeping defaults", exc_info=True)

    def save_settings(self):
        from services.json_safe import safe_write_json
        data = {
            "last_position": self._last_position,
            "coord_format": self.coord_formatter.format.value,
            "initial_map_position": self._initial_map_position,
            "bookmark_expanded_categories": self._bookmark_expanded_categories,
            "geocode_provider": self._geocode_provider,
            "google_geocode_key": self._google_geocode_key,
            "wifi_keepalive_enabled": self._wifi_keepalive_enabled,
        }
        safe_write_json(SETTINGS_FILE, data)

    def get_initial_position(self) -> dict:
        if self._last_position:
            return self._last_position
        # Could try IP geolocation here; fallback to default
        return DEFAULT_LOCATION

    def update_last_position(self, lat: float, lng: float):
        self._last_position = {"lat": lat, "lng": lng}

    @property
    def simulation_engine(self):
        """Legacy accessor: the most-recently-created engine.
        Prefer get_engine(udid) in new code."""
        if self._primary_udid and self._primary_udid in self.simulation_engines:
            return self.simulation_engines[self._primary_udid]
        return None

    @simulation_engine.setter
    def simulation_engine(self, value):
        """Legacy setter. Only `= None` (clear all) is meaningful."""
        if value is None:
            self.simulation_engines.clear()
            self._primary_udid = None
        else:
            # Best-effort: stash under a synthetic key if udid unknown
            self.simulation_engines["__legacy__"] = value
            self._primary_udid = "__legacy__"

    def get_engine(self, udid: str | None):
        """Return the engine for *udid*, or the primary engine if udid is None."""
        if udid is None:
            return self.simulation_engine
        return self.simulation_engines.get(udid)

    async def create_engine_for_device(self, udid: str):
        """Serialize engine creation per device."""
        key = udid.lower()
        engine_lock = self._engine_locks.setdefault(key, asyncio.Lock())
        async with engine_lock:
            if udid in self.simulation_engines:
                return
            await self._create_engine_once(udid)

    async def _create_engine_once(self, udid: str):
        """Create a SimulationEngine for the connected device.

        Idempotent: if an engine already exists for this udid, we
        reuse it instead of overwriting. The watchdog sometimes calls
        this every second (e.g. when list_devices()'s udid string
        doesn't byte-match our _connections key due to case / separator
        differences in certain pymobiledevice3 versions). Without this
        guard the re-created engine would wipe current_position back to
        None, so the user teleports successfully but any subsequent
        navigate / loop / multi-stop / random-walk raises "Cannot
        navigate: no current position" because the engine they're
        aiming at is a fresh one that never saw the teleport.
        """
        if udid in self.simulation_engines:
            logger.debug("Simulation engine already exists for %s; preserving current_position", udid)
            return
        from core.simulation_engine import SimulationEngine
        from api.websocket import broadcast

        loc_service = await self.device_manager.get_location_service(udid)

        async def location_health_callback(channel_state: str, details: dict):
            previous = self.connection_health.get_device(udid) or {}
            if channel_state == "recovering":
                health = self.connection_health.record_location_recovering(
                    udid,
                    reason=details.get("reason"),
                    phase=details.get("phase"),
                )
                await broadcast("connection_health", health)
                return
            health = self.connection_health.record_location_success(
                udid,
                recovered=bool(details.get("recovered")),
            )
            if previous.get("location_channel_state") == "recovering":
                await broadcast("connection_health", health)

        set_health_callback = getattr(loc_service, "set_health_callback", None)
        if callable(set_health_callback):
            set_health_callback(location_health_callback)

        async def event_callback(event_type: str, data: dict):
            # Always tag emissions with udid so the frontend can route per-device.
            if isinstance(data, dict) and "udid" not in data:
                data = {**data, "udid": udid}
            await broadcast(event_type, data)
            if event_type == "position_update" and "lat" in data:
                self.update_last_position(data["lat"], data["lng"])
                self.connection_health.record_location_success(udid)
            elif event_type == "state_change":
                state = data.get("state")
                active = state not in (None, "idle", "disconnected")
                previous = self.connection_health.get_device(udid) or {}
                health = self.connection_health.set_location_active(udid, active)
                if previous.get("location_active") != active:
                    await broadcast("connection_health", health)

        engine = SimulationEngine(loc_service, event_callback)
        self.simulation_engines[udid] = engine
        # Keep the existing primary on additional device connects. If no
        # primary is set (e.g. fresh install, first device), this udid
        # becomes primary. Second device plugging in no longer hijacks
        # the map view away from the first device.
        if self._primary_udid is None:
            self._primary_udid = udid

        # DO NOT push any initial location to the device on connect. The
        # engine's current_position stays None until the user explicitly
        # teleports / navigates / picks a bookmark. iPhone's real GPS is
        # left untouched by merely plugging the phone into LocWarp.
        #
        # The map UI still shows a default center (Taipei or the user's
        # `initial_map_position` setting) — that's purely a visual default
        # for the Leaflet view, not a virtual GPS coordinate.

        # Setup reconnect manager
        self.reconnect_manager = ReconnectManager(self.device_manager)

        logger.info("Simulation engine created for device %s (no initial location pushed)", udid)


app_state = AppState()


# ── Lifespan ─────────────────────────────────────────────

async def _auto_sync_new_device_to_primary(new_udid: str) -> None:
    """Align a freshly-connected second device to whatever the primary
    device is doing, so dual-device mode behaves as one unit without the
    user having to explicitly restart actions.

    Behaviour:
      * No primary yet, or primary is the same as *new_udid* → noop
      * Primary has a ``current_position`` → teleport new device there
      * Primary is running navigate / loop / multi_stop / random_walk →
        replay the same action (with the same args) on the new engine so
        both devices share the target / waypoints / seed
      * Primary is idle / paused / teleport-only → only the position
        sync happens; the user's next action will fan-out to both
    """
    import asyncio
    primary_udid = app_state._primary_udid
    if primary_udid is None or primary_udid == new_udid:
        return
    primary_eng = app_state.simulation_engines.get(primary_udid)
    new_eng = app_state.simulation_engines.get(new_udid)
    if primary_eng is None or new_eng is None:
        return

    pos = primary_eng.current_position
    if pos is None:
        # Primary hasn't been given a position yet — nothing to sync.
        logger.info("Auto-sync: primary %s has no position, skipping %s", primary_udid, new_udid)
        return

    # 1) Teleport the new device to match the primary's current virtual
    #    position (keeps the 'one marker' invariant in dual mode).
    try:
        await new_eng.teleport(pos.lat, pos.lng)
        logger.info("Auto-sync: %s teleported to primary %s position (%.6f, %.6f)",
                    new_udid, primary_udid, pos.lat, pos.lng)
    except Exception:
        logger.exception("Auto-sync: teleport failed for %s", new_udid)
        return

    # 2) If the primary is running a dynamic sim, attach the new device
    #    as a position-follower instead of replaying the sim from scratch.
    #    Why not replay: each sim mode restarts at its own "beginning"
    #      * loop:      _move_along_route emits coords[0] first → iPhone
    #                   teleports back to waypoint[0] before walking
    #      * multi_stop: routes from current pos back to waypoint[0]
    #                   first if >50m away → iPhone walks back to start
    #      * random_walk: rng resets at walk_count=0 → iPhone walks the
    #                   first random destination from scratch
    #    All three desync the rejoining iPhone from the surviving one and
    #    show up on Google Maps as the rejoining phone going back to the
    #    route's beginning. Following primary's positions instead keeps
    #    both iPhones perfectly in sync.
    from models.schemas import SimulationState
    dynamic = {
        SimulationState.NAVIGATING,
        SimulationState.LOOPING,
        SimulationState.MULTI_STOP,
        SimulationState.RANDOM_WALK,
    }
    if primary_eng.state not in dynamic:
        return

    logger.info("Auto-sync: attaching %s as position-follower of primary %s", new_udid, primary_udid)
    asyncio.create_task(_follow_primary_positions(new_udid, primary_udid))


async def _follow_primary_positions(follower_udid: str, primary_udid: str) -> None:
    """Mirror the primary engine's current_position onto the follower
    device. Runs until the primary changes, the follower disconnects,
    the follower starts its own simulation (which sets _stop_event via
    _ensure_stopped), or the primary engine is gone."""
    import asyncio
    poll_interval = 0.5  # 500ms — primary's own updates run ~1 Hz, so this oversamples slightly without thrashing
    last_pushed_lat: float | None = None
    last_pushed_lng: float | None = None
    while True:
        # Tear down conditions
        if app_state._primary_udid != primary_udid:
            logger.info("Follower %s: primary changed (%s → %s), stopping follow",
                        follower_udid, primary_udid, app_state._primary_udid)
            return
        follower_eng = app_state.simulation_engines.get(follower_udid)
        if follower_eng is None:
            logger.info("Follower %s: engine gone, stopping follow", follower_udid)
            return
        if follower_eng._stop_event.is_set():
            logger.info("Follower %s: stop_event set (own sim started or stop pressed), stopping follow",
                        follower_udid)
            return
        primary_eng = app_state.simulation_engines.get(primary_udid)
        if primary_eng is None:
            logger.info("Follower %s: primary engine gone, stopping follow", follower_udid)
            return

        pos = primary_eng.current_position
        if pos is not None and (pos.lat != last_pushed_lat or pos.lng != last_pushed_lng):
            try:
                await follower_eng._set_position(pos.lat, pos.lng)
                last_pushed_lat, last_pushed_lng = pos.lat, pos.lng
            except Exception:
                logger.debug("Follower %s: _set_position failed", follower_udid, exc_info=True)
        await asyncio.sleep(poll_interval)


async def _usbmux_presence_watchdog():
    """Poll usbmuxd every 1 s for both directions:

    * **Disappearance** — a UDID present in DeviceManager._connections that
      drops off the usbmux list for consecutive polls is treated as USB
      unplug: disconnect, clear simulation_engine, broadcast device_disconnected.
      The threshold is dynamic: idle devices disconnect quickly, while an
      actively moving device gets a longer grace window so short iOS 17+
      tunnel renegotiations do not immediately kill the in-flight sim.
    * **Appearance** — a USB device showing up while we have no active
      connection must remain visible for consecutive polls before it
      triggers an auto-connect + engine rebuild. Failed and short-lived
      connections use exponential backoff, so a flapping USB/NCM link does
      not get hammered by a fresh tunnel attempt every few seconds.

    WiFi (Network) devices are skipped on both sides — those are covered by
    the WiFi tunnel watchdog. Consecutive-miss debouncing protects against
    usbmuxd re-enumeration hiccups.
    """
    import asyncio
    import time
    from pymobiledevice3.usbmux import list_devices
    from api.websocket import broadcast
    from models.schemas import SimulationState as _SS

    miss_counts: dict[str, int] = {}
    idle_miss_threshold = 3
    active_sim_miss_threshold = 8
    appearance_counts: dict[str, int] = {}
    appearance_stability_threshold = 3
    # Key by lowercase UDID because usbmux / pymobiledevice3 can report
    # serial casing differently between list_devices() and connect().
    # Using the raw string here makes a perfectly good reconnect snapshot
    # look "missing" on auto-connect, which is exactly the silent failure
    # mode we want to avoid.
    reconnect_resume_snapshots: dict[str, dict] = {}
    resumable_states = {
        _SS.NAVIGATING,
        _SS.LOOPING,
        _SS.MULTI_STOP,
        _SS.RANDOM_WALK,
    }
    last_reconnect_attempt: dict[str, float] = {}
    connection_started_at: dict[str, float] = {}
    absent_since: dict[str, float] = {}
    # Per-udid consecutive failure count. Drives exponential backoff so a
    # device that consistently fails to connect (Trust pending, Windows
    # firewall blocking the RSD loopback, no admin rights, dead USB cable)
    # doesn't get hammered every 5 seconds for the rest of the session and
    # spam the log with hundreds of identical tracebacks. A connect() call
    # returning is not enough to reset this counter: the RSD tunnel can die
    # one second later. Reset only after a genuinely stable connection, or
    # after the device has remained absent long enough to indicate a real
    # unplug/replug rather than USB/NCM re-enumeration.
    reconnect_failure_count: dict[str, int] = {}
    reconnect_cooldown_base = 5.0  # seconds for first retry
    reconnect_cooldown_max = 300.0  # cap at 5 minutes per UDID
    stable_connection_window = 20.0
    reset_after_absence = 30.0

    while True:
        await asyncio.sleep(1.0)
        try:
            dm = app_state.device_manager
            # Build two views:
            #
            # * connected_usb_original: USB-tracked connections only. This
            #   drives disappearance detection because only those should be
            #   treated as "USB unplugged" when they vanish from usbmuxd.
            # * connected_any: every active connection regardless of whether
            #   it currently routes over USB or Network. This drives
            #   appearance detection so a device already connected via WiFi
            #   tunnel is NOT re-treated as a brand new USB device every
            #   second just because the cable is still plugged in.
            #
            # Everything is keyed by lowercase UDID because some
            # pymobiledevice3 versions report different serial casing
            # between list_devices() and connect().
            connected_usb_original: dict[str, str] = {}  # lowercase → original
            connected_any: set[str] = set()
            for udid, conn in dm._connections.items():
                udid_lc = udid.lower()
                connected_any.add(udid_lc)
                if getattr(conn, "connection_type", "USB") == "USB":
                    connected_usb_original[udid_lc] = udid
            connected_usb = set(connected_usb_original.keys())

            try:
                raw = await list_devices()
            except Exception:
                logger.debug("usbmux list_devices failed in watchdog", exc_info=True)
                continue
            present_usb_original: dict[str, str] = {}  # lowercase → original
            for r in raw:
                if getattr(r, "connection_type", "USB") == "USB":
                    present_usb_original[r.serial.lower()] = r.serial
            present_usb = set(present_usb_original.keys())
            now = time.monotonic()

            # Keep failure history across brief disappear/reappear cycles.
            # iOS 17+ switches through USB/NCM states while creating a
            # developer tunnel; treating every short absence as a deliberate
            # replug used to erase the backoff and create a reconnect storm.
            tracked_reconnects = (
                set(reconnect_failure_count)
                | set(last_reconnect_attempt)
                | set(absent_since)
            )
            for udid_lc in tracked_reconnects:
                if udid_lc in present_usb:
                    absent_since.pop(udid_lc, None)
                    continue
                first_absent = absent_since.setdefault(udid_lc, now)
                if now - first_absent >= reset_after_absence:
                    reconnect_failure_count.pop(udid_lc, None)
                    last_reconnect_attempt.pop(udid_lc, None)
                    absent_since.pop(udid_lc, None)
                    appearance_counts.pop(udid_lc, None)
                    connection_started_at.pop(udid_lc, None)
                    logger.info(
                        "usbmux watchdog: reset reconnect backoff for %s "
                        "after %.0fs continuously absent",
                        udid_lc,
                        reset_after_absence,
                    )

            # --- Disappearance detection ---
            # connected / present_usb are lowercase for set math; map
            # back to original-case when touching simulation_engines /
            # _connections so whichever case was stored in those maps
            # is what we use for look-ups.
            lost_now: list[str] = []
            for udid_lc in connected_usb:
                if udid_lc in present_usb:
                    miss_counts.pop(udid_lc, None)
                    started_at = connection_started_at.setdefault(udid_lc, now)
                    if (
                        now - started_at >= stable_connection_window
                        and reconnect_failure_count.get(udid_lc, 0) > 0
                    ):
                        reconnect_failure_count.pop(udid_lc, None)
                        last_reconnect_attempt.pop(udid_lc, None)
                        logger.info(
                            "usbmux watchdog: connection %s stable for %.0fs; "
                            "reconnect backoff cleared",
                            udid_lc,
                            stable_connection_window,
                        )
                else:
                    udid = connected_usb_original[udid_lc]
                    eng = app_state.simulation_engines.get(udid)
                    miss_threshold = (
                        active_sim_miss_threshold
                        if eng is not None and eng.state in resumable_states
                        else idle_miss_threshold
                    )
                    miss_counts[udid_lc] = miss_counts.get(udid_lc, 0) + 1
                    if miss_counts[udid_lc] >= miss_threshold:
                        lost_now.append(udid)

            if lost_now:
                logger.warning("usbmux watchdog: device(s) gone → %s", lost_now)
                lost_health: list[dict] = []
                for udid in lost_now:
                    udid_lc = udid.lower()
                    started_at = connection_started_at.pop(udid_lc, now)
                    lifetime = max(0.0, now - started_at)
                    health = app_state.connection_health.record_usb_disconnect(
                        udid, lifetime=lifetime
                    )
                    lost_health.append(health)
                    if health["state"] == "usb_flapping":
                        logger.warning(
                            "connection_health: usb_flapping udid=%s disconnects_5m=%d; "
                            "cable/connector/power is now the leading cause",
                            udid,
                            health["usb_disconnects_5m"],
                        )
                    if lifetime < stable_connection_window:
                        failure_count = reconnect_failure_count.get(udid_lc, 0) + 1
                        reconnect_failure_count[udid_lc] = failure_count
                        last_reconnect_attempt[udid_lc] = now
                        logger.warning(
                            "usbmux watchdog: short-lived connection for %s "
                            "(%.1fs); reconnect failure count=%d",
                            udid,
                            lifetime,
                            failure_count,
                        )
                # If the leader is among the lost devices, capture its
                # snapshot BEFORE we cancel its task so we can hand the
                # in-flight sim off to whichever follower we promote.
                leader_lost = app_state._primary_udid in lost_now
                handoff_snapshot: dict | None = None
                if leader_lost:
                    leader_eng = app_state.simulation_engines.get(app_state._primary_udid)
                    if leader_eng is not None:
                        try:
                            handoff_snapshot = leader_eng.capture_resumable_snapshot()
                            if handoff_snapshot:
                                logger.info(
                                    "watchdog: captured handoff snapshot from leader %s (kind=%s, segment=%d)",
                                    app_state._primary_udid,
                                    handoff_snapshot.get("kind"),
                                    handoff_snapshot.get("segment_index", 0),
                                )
                        except Exception:
                            logger.exception("watchdog: capture_resumable_snapshot failed")

                for udid in lost_now:
                    miss_counts.pop(udid.lower(), None)
                    # Signal any simulation in flight (random-walk / loop /
                    # multi-stop) to exit its inner loop cleanly. Without
                    # this, the handler would keep trying to push positions
                    # through the now-dead DVT channel, silently log fake
                    # 'arrived at destination' events, and leave a zombie
                    # task running against a stale engine reference.
                    old_eng = app_state.simulation_engines.get(udid)
                    if old_eng is not None:
                        try:
                            # Same-device auto-resume: preserve a snapshot
                            # only when this disconnect leaves no surviving
                            # engine behind. If another device is still alive,
                            # that peer should keep leading and the returning
                            # device should re-attach via auto-sync instead of
                            # reviving its own stale copy of the sim.
                            surviving_engines = [
                                other for other in app_state.simulation_engines.keys()
                                if other not in lost_now and other != udid
                            ]
                            if not surviving_engines:
                                reconnect_snapshot = old_eng.capture_resumable_snapshot()
                                if reconnect_snapshot:
                                    reconnect_resume_snapshots[udid.lower()] = reconnect_snapshot
                                    logger.info(
                                        "watchdog: stored reconnect snapshot for %s (kind=%s, segment=%d)",
                                        udid,
                                        reconnect_snapshot.get("kind"),
                                        reconnect_snapshot.get("segment_index", 0),
                                    )
                        except Exception:
                            logger.exception("watchdog: capture reconnect snapshot failed for %s", udid)
                        try:
                            # Mark DISCONNECTED before cancelling the active
                            # task. Otherwise _run_handler's finally block sees
                            # a non-IDLE state and forces it to IDLE, emitting
                            # state_change=idle. In dual-device mode, if the
                            # primary is the one being unplugged, that idle
                            # event slips through the frontend filter (primary
                            # match) and wipes the global routePath / dest so
                            # the surviving device's polyline disappears.
                            old_eng.state = _SS.DISCONNECTED
                            try:
                                await old_eng._emit("state_change", {"state": old_eng.state.value})
                            except Exception:
                                logger.debug("watchdog: disconnected state_change emit failed", exc_info=True)
                            old_eng._stop_event.set()
                            old_eng._pause_event.set()  # unstick anyone awaiting pause_event
                            active = getattr(old_eng, "_active_task", None)
                            if active is not None and not active.done():
                                active.cancel()
                        except Exception:
                            logger.debug("watchdog: failed to stop old engine %s", udid, exc_info=True)
                    try:
                        await dm.disconnect(udid, clear_location=False)
                    except Exception:
                        logger.exception("watchdog: disconnect failed for %s", udid)
                    # Only remove the lost device's engine. The legacy setter
                    # `simulation_engine = None` wipes *all* engines, which
                    # destroys the surviving device's engine in dual mode.
                    app_state.simulation_engines.pop(udid, None)
                    if app_state._primary_udid == udid:
                        remaining = next(iter(app_state.simulation_engines.keys()), None)
                        app_state._primary_udid = remaining

                # Promote: if the leader was among the lost AND there's
                # a successor still connected AND we captured a usable
                # snapshot, kick off resume_from_snapshot on the new
                # leader so the simulation continues seamlessly from the
                # exact segment / lap / walk-count the old leader had
                # reached. Other surviving devices then re-attach as
                # followers of the new leader (their old follower task,
                # if any, self-terminates on _primary_udid change).
                new_leader = app_state._primary_udid
                if leader_lost and new_leader and handoff_snapshot:
                    new_leader_eng = app_state.simulation_engines.get(new_leader)
                    if new_leader_eng is not None:
                        # The new leader was a follower of the old leader
                        # and was constantly being teleported by that
                        # follower task. _set_position never sets
                        # _stop_event, so we don't need to clear it
                        # before resume_from_snapshot — but we DO need to
                        # ensure the snapshot's teleport-to-current-pos
                        # is the last thing the old follower task can do
                        # before it sees the primary swap and exits.
                        logger.info(
                            "watchdog: promoting %s to leader, resuming sim from snapshot",
                            new_leader,
                        )
                        asyncio.create_task(new_leader_eng.resume_from_snapshot(handoff_snapshot))
                        # Re-attach any remaining devices (besides the
                        # new leader) as followers of the new leader.
                        for other_udid in app_state.simulation_engines.keys():
                            if other_udid == new_leader:
                                continue
                            asyncio.create_task(
                                _follow_primary_positions(other_udid, new_leader)
                            )

                try:
                    await broadcast("device_disconnected", {
                        "udids": lost_now,
                        "reason": "usb_unplugged",
                        # Remaining connected count AFTER cleanup. Frontend
                        # suppresses the full-screen banner when > 0 since
                        # the other device(s) are still usable; only the
                        # affected chip in the sidebar needs updating.
                        "remaining_count": len(dm._connections),
                        "connection_health": lost_health,
                    })
                    for health in lost_health:
                        await broadcast("connection_health", health)
                except Exception:
                    logger.exception("watchdog: broadcast (disconnected) failed")
                continue  # skip appearance logic this tick

            # --- Appearance (auto-connect up to 3 devices, group mode) ---
            # Auto-connect any USB device not yet connected, up to the multi-
            # device cap. The user environment is assumed to only ever have
            # their own iPhones plugged in.
            MAX_DEVICES = 3
            new_udids_lc = present_usb - connected_any
            for udid_lc in list(appearance_counts):
                if udid_lc not in new_udids_lc:
                    appearance_counts.pop(udid_lc, None)
            for udid_lc in new_udids_lc:
                appearance_counts[udid_lc] = appearance_counts.get(udid_lc, 0) + 1
                if appearance_counts[udid_lc] <= appearance_stability_threshold:
                    udid = present_usb_original.get(udid_lc, udid_lc)
                    health = app_state.connection_health.set_state(
                        udid,
                        "stabilizing",
                        stable_samples=appearance_counts[udid_lc],
                        required_samples=appearance_stability_threshold,
                    )
                    await broadcast("connection_health", health)

            stable_new_udids_lc = {
                udid_lc
                for udid_lc in new_udids_lc
                if appearance_counts.get(udid_lc, 0) >= appearance_stability_threshold
            }
            if not stable_new_udids_lc or len(dm._connections) >= MAX_DEVICES:
                continue
            # Map back to the original-case serials from list_devices so
            # downstream dm.connect() sees the format pymobiledevice3
            # itself expects.
            new_udids = [present_usb_original[lc] for lc in stable_new_udids_lc]

            for udid in new_udids:
                if len(dm._connections) >= MAX_DEVICES:
                    break
                udid_lc = udid.lower()
                fail_count = reconnect_failure_count.get(udid_lc, 0)
                # 5s, 10s, 20s, 40s, 80s, 160s, 300s, 300s ...
                cooldown = min(
                    reconnect_cooldown_base * (2 ** fail_count),
                    reconnect_cooldown_max,
                )
                last = last_reconnect_attempt.get(udid_lc, 0.0)
                if now - last < cooldown:
                    continue
                last_reconnect_attempt[udid_lc] = now
                health = app_state.connection_health.set_state(
                    udid, "connecting", attempt=fail_count + 1
                )
                await broadcast("connection_health", health)
                logger.info(
                    "usbmux watchdog: new USB device %s detected, auto-connecting (fail_count=%d, cooldown=%.0fs)",
                    udid, fail_count, cooldown,
                )
                try:
                    await dm.connect(udid)
                    await app_state.create_engine_for_device(udid)
                    connection_started_at[udid_lc] = time.monotonic()
                    appearance_counts.pop(udid_lc, None)
                    # Broadcast from the connection metadata we just created.
                    # Calling discover_devices() here opened a second lockdown
                    # session during the most fragile part of tunnel startup.
                    try:
                        conn = dm._connections.get(udid)
                        await broadcast("device_connected", {
                            "udid": udid,
                            "name": getattr(conn, "name", ""),
                            "ios_version": getattr(conn, "ios_version", ""),
                            "connection_type": getattr(conn, "connection_type", "USB"),
                        })
                        await broadcast(
                            "connection_health",
                            app_state.connection_health.set_state(
                                udid, "connected", connection_type="USB"
                            ),
                        )
                    except Exception:
                        logger.exception("watchdog: broadcast (connected) failed")
                    logger.info("Auto-connect succeeded for %s", udid)

                    reconnect_snapshot = reconnect_resume_snapshots.pop(udid.lower(), None)
                    if reconnect_snapshot is not None:
                        try:
                            new_eng = app_state.simulation_engines.get(udid)
                            if new_eng is not None and len(app_state.simulation_engines) == 1:
                                logger.info(
                                    "Auto-resuming %s from reconnect snapshot (kind=%s)",
                                    udid,
                                    reconnect_snapshot.get("kind"),
                                )
                                asyncio.create_task(new_eng.resume_from_snapshot(reconnect_snapshot))
                            elif new_eng is not None:
                                logger.info(
                                    "Skipping reconnect snapshot resume for %s because another engine is still active",
                                    udid,
                                )
                        except Exception:
                            logger.exception("Auto-resume after reconnect failed for %s", udid)

                    # Auto-sync the new device to the primary device: if the
                    # primary has a virtual position set, teleport the new
                    # device there; if the primary is running a dynamic
                    # simulation (navigate / loop / multi_stop / random_walk),
                    # also replay that action on the new device so both move
                    # together. Dual-device group mode semantics: one marker,
                    # two phones in lockstep.
                    try:
                        await _auto_sync_new_device_to_primary(udid)
                    except Exception:
                        logger.exception("Auto-sync of new device %s to primary failed", udid)
                except Exception:
                    reconnect_failure_count[udid_lc] = fail_count + 1
                    appearance_counts[udid_lc] = 0
                    # connect() stores the transport before engine creation.
                    # If the latter fails, do not leave a half-connected entry
                    # that prevents the watchdog from ever retrying.
                    if (
                        udid in dm._connections
                        and udid not in app_state.simulation_engines
                    ):
                        try:
                            await dm.disconnect(udid, clear_location=False)
                        except Exception:
                            logger.debug(
                                "Failed to clean up partial connection for %s",
                                udid,
                                exc_info=True,
                            )
                    next_cooldown = min(
                        reconnect_cooldown_base * (2 ** (fail_count + 1)),
                        reconnect_cooldown_max,
                    )
                    health = app_state.connection_health.set_state(
                        udid,
                        "reconnect_backoff",
                        attempt=fail_count + 1,
                        retry_in_seconds=round(next_cooldown, 1),
                        retry_at_unix=round(time.time() + next_cooldown, 3),
                    )
                    await broadcast("connection_health", health)
                    # Drop full traceback after the first 3 failures so the
                    # log doesn't fill with identical stacks. Cause is always
                    # the same: Trust pending, no admin rights, or firewall
                    # blocking the RSD loopback handshake.
                    log_with_trace = fail_count < 3
                    logger.warning(
                        "Auto-connect for %s failed (attempt %d, will retry in %.0fs): likely Trust pending / no admin / firewall",
                        udid, fail_count + 1, next_cooldown,
                        exc_info=log_with_trace,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("usbmux watchdog iteration crashed; continuing")


async def _wifi_tunnel_keepalive():
    """Keep idle WiFi tunnels alive across phone screen-off.

    During active navigation the engine pushes coordinates every cycle,
    which is exactly why a moving WiFi tunnel survives the screen turning
    off while an idle one drops within seconds. This loop mirrors that
    traffic: every KEEPALIVE_INTERVAL it re-pushes the current simulated
    location for each Network-connected device whose engine is idle. The
    re-push doubles as keeping the fake location pinned. Active sims are
    skipped (they already generate traffic). Toggleable via settings —
    issue #33."""
    import asyncio
    from models.schemas import SimulationState
    KEEPALIVE_INTERVAL = 1.0
    # States where the engine is NOT actively pushing on its own, so the
    # socket would otherwise go quiet and iOS could reap it.
    IDLE_STATES = {SimulationState.IDLE, SimulationState.PAUSED}
    while True:
        try:
            await asyncio.sleep(KEEPALIVE_INTERVAL)
            if not app_state._wifi_keepalive_enabled:
                continue
            dm = app_state.device_manager
            for udid, conn in list(dm._connections.items()):
                if getattr(conn, "connection_type", "USB") != "Network":
                    continue
                eng = app_state.simulation_engines.get(udid)
                if eng is None or eng.state not in IDLE_STATES:
                    continue
                pos = eng.current_position
                if pos is None:
                    continue
                try:
                    await eng.location_service.set(pos.lat, pos.lng)
                except Exception:
                    logger.debug(
                        "WiFi keepalive re-push failed for %s", udid, exc_info=True,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("WiFi keepalive loop iteration error", exc_info=True)


@asynccontextmanager
async def lifespan(application: FastAPI):
    import asyncio
    # ── Startup ──
    # The USB watchdog is the single owner of automatic connections. It
    # requires several consecutive presence samples before connecting, which
    # prevents an app launch during a USB/NCM re-enumeration from immediately
    # starting another tunnel and extending the reconnect storm.
    logger.info("LocWarp starting — waiting for stable USB device presence…")
    watchdog_task = asyncio.create_task(_usbmux_presence_watchdog())
    keepalive_task = asyncio.create_task(_wifi_tunnel_keepalive())

    yield

    # ── Shutdown ──
    watchdog_task.cancel()
    keepalive_task.cancel()
    for _t in (watchdog_task, keepalive_task):
        try:
            await _t
        except (asyncio.CancelledError, Exception):
            pass

    app_state.save_settings()
    await app_state.device_manager.disconnect_all()
    logger.info("LocWarp shut down")


# ── FastAPI app ───────────────────────────────────────────

APP_VERSION = "0.2.193-kx.3"

app = FastAPI(title="LocWarp", version=APP_VERSION, description="iOS Virtual Location Simulator", lifespan=lifespan)

app.add_middleware(DesktopApiSecurityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["null", "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["Content-Type", "X-LocWarp-Desktop-Token"],
)

# Register routers
from api.device import router as device_router
from api.location import router as location_router
from api.route import router as route_router
from api.geocode import router as geocode_router
from api.bookmarks import router as bookmarks_router
from api.recent import router as recent_router
from api.websocket import router as ws_router
from api.system import router as system_router
from api.phone_control import router as phone_router
from api.diagnostics import router as diagnostics_router

app.include_router(device_router)
app.include_router(location_router)
app.include_router(route_router)
app.include_router(geocode_router)
app.include_router(system_router)
app.include_router(bookmarks_router)
app.include_router(recent_router)
app.include_router(ws_router)
app.include_router(phone_router)
app.include_router(diagnostics_router)


@app.get("/")
async def root():
    return {
        "name": "LocWarp",
        "version": APP_VERSION,
        "status": "running",
        "initial_position": app_state.get_initial_position(),
    }


@app.get("/healthz", include_in_schema=False)
async def healthz():
    """Minimal unauthenticated probe used by the Electron parent process."""
    return {"status": "ok", "version": APP_VERSION}



if __name__ == "__main__":
    # v0.2.59: enable uvicorn access logging so we can see which HTTP
    # endpoints the frontend is hitting (needed to debug the "WiFi tunnel
    # drops on USB unplug" report — we need to confirm whether the UI is
    # POSTing /wifi/tunnel/stop or something else is triggering the
    # cleanup).
    uvicorn_access = logging.getLogger("uvicorn.access")
    uvicorn_access.setLevel(logging.INFO)
    uvicorn_access.propagate = True  # route through our basicConfig handlers
    uvicorn.run("main:app", host=API_HOST, port=API_PORT, reload=False, access_log=True)
