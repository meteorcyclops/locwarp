"""Strict multi-device simulation coordination.

The desktop can keep more than one iPhone connected at the same time.  The
normal group implementation uses one primary engine and lightweight follower
engines, which is deliberately efficient but has an important safety edge:
if the primary or a follower disappears, the surviving phone must not keep
walking while the other phone is being recovered.

``GroupSyncCoordinator`` owns only that cross-device safety policy.  It does
not own a device connection, a route handler, or a global engine lock.  It is
called from the engine event/health callbacks in ``main.py`` and uses short
critical sections around its own bookkeeping.  Device operations happen after
the bookkeeping lock is released so an engine's emitted state events cannot
deadlock the coordinator.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

from models.schemas import SimulationState

logger = logging.getLogger(__name__)


DYNAMIC_STATES = frozenset({
    SimulationState.NAVIGATING,
    SimulationState.LOOPING,
    SimulationState.MULTI_STOP,
    SimulationState.RANDOM_WALK,
})


def _key(udid: str | None) -> str:
    return str(udid or "").strip().lower()


def _state_value(state: Any) -> str:
    value = getattr(state, "value", state)
    return str(value or "")


def _is_dynamic(state: Any) -> bool:
    value = getattr(state, "value", state)
    return value in DYNAMIC_STATES or value in {
        item.value for item in DYNAMIC_STATES
    }


@dataclass
class _Ack:
    udid: str
    sequence: int
    lat: float
    lng: float
    requested_at: float
    acknowledged_at: float
    latency_ms: float


@dataclass
class _Recovery:
    group_id: str
    expected: dict[str, str]
    primary_key: str | None
    snapshot: dict | None
    lost: set[str] = field(default_factory=set)
    degraded: set[str] = field(default_factory=set)
    rejoined: set[str] = field(default_factory=set)
    paused: set[str] = field(default_factory=set)
    attempt: int = 1
    max_attempts: int = 3
    primary_lost: bool = False
    reconcile_inflight: bool = False
    cancelled: bool = False


class GroupSyncCoordinator:
    """Coordinate strict pause/recovery semantics for a device group.

    A coordinator is intentionally attached to one ``AppState`` instance.
    Groups are discovered from the engine table at the first dynamic-channel
    degradation; no persistent membership is written to disk.  This keeps
    single-device behaviour unchanged and avoids treating a newly connected
    idle phone as a member of an unrelated route.
    """

    EVENT_TYPE = "group_sync"

    def __init__(
        self,
        app_state,
        *,
        strict_sync: bool = True,
        max_recovery_attempts: int = 3,
        retry_delays: tuple[float, ...] = (1.0, 2.0),
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.app_state = app_state
        self.strict_sync = bool(strict_sync)
        self.max_recovery_attempts = max(1, int(max_recovery_attempts))
        self.retry_delays = tuple(max(0.0, float(value)) for value in retry_delays) or (1.0,)
        self._clock = clock
        self._lock = asyncio.Lock()
        self._recovery: _Recovery | None = None
        self._last_payload: dict[str, Any] | None = None
        self._follower_starter: Callable[[str, str], Any] | None = None
        self._retry_task: asyncio.Task | None = None

        # Position ACK telemetry.  This is deliberately in-memory: it is
        # operational telemetry, not user data, and a new session should not
        # inherit old timing values.
        self._acks: dict[str, _Ack] = {}
        self._last_ack_delta_ms: float = 0.0
        self._max_ack_delta_ms: float = 0.0

    @property
    def is_recovering(self) -> bool:
        """Whether a strict group is waiting for a member to recover."""
        recovery = self._recovery
        return bool(recovery is not None and not recovery.cancelled)

    @property
    def last_payload(self) -> dict[str, Any] | None:
        return dict(self._last_payload) if self._last_payload else None

    @property
    def max_ack_delta_ms(self) -> float:
        return round(self._max_ack_delta_ms, 1)

    def set_follower_starter(self, starter: Callable[[str, str], Any] | None) -> None:
        """Set the main-process callback used to attach a follower task.

        The import direction is kept one-way: this core module does not import
        ``main.py`` (which would create a circular import during app startup).
        """
        self._follower_starter = starter

    def _engines(self) -> dict[str, tuple[str, Any]]:
        result: dict[str, tuple[str, Any]] = {}
        for udid, engine in list(
            getattr(self.app_state, "simulation_engines", {}).items()
        ):
            result[_key(udid)] = (str(udid), engine)
        return result

    def _available_engines(self) -> dict[str, tuple[str, Any]]:
        result: dict[str, tuple[str, Any]] = {}
        for key, item in self._engines().items():
            engine = item[1]
            if _state_value(getattr(engine, "state", None)) != SimulationState.DISCONNECTED.value:
                result[key] = item
        return result

    def _lookup_engine(self, udid: str) -> Any | None:
        item = self._engines().get(_key(udid))
        return item[1] if item else None

    @staticmethod
    def _capture(engine: Any, *, allow_disconnected: bool = False) -> dict | None:
        if engine is None:
            return None
        capture = getattr(engine, "capture_resumable_snapshot", None)
        if not callable(capture):
            return None
        try:
            # New engines accept the explicit disconnected option.  The
            # fallback keeps lightweight test doubles and older engines
            # compatible without weakening the normal dynamic-state guard.
            try:
                return capture(allow_disconnected=allow_disconnected)
            except TypeError:
                return capture()
        except Exception:
            logger.debug("group sync: snapshot capture failed", exc_info=True)
            return None

    def _snapshot_for_trigger(self, trigger_key: str) -> dict | None:
        engines = self._engines()
        trigger = engines.get(trigger_key)
        if trigger:
            snap = self._capture(trigger[1], allow_disconnected=True)
            if snap:
                return snap
        primary_key = _key(getattr(self.app_state, "_primary_udid", None))
        primary = engines.get(primary_key)
        if primary:
            snap = self._capture(primary[1])
            if snap:
                return snap
        for _key_name, (_udid, engine) in engines.items():
            snap = self._capture(engine)
            if snap:
                return snap
        return None

    def _new_recovery_locked(
        self,
        trigger_key: str,
        *,
        degraded: bool,
    ) -> _Recovery | None:
        if not self.strict_sync:
            return None
        engines = self._engines()
        if len(engines) < 2:
            return None

        trigger = engines.get(trigger_key)
        trigger_snapshot = self._snapshot_for_trigger(trigger_key)
        dynamic_present = any(
            _is_dynamic(getattr(engine, "state", None))
            for _udid, engine in engines.values()
        )
        # A disconnected engine is already marked DISCONNECTED by the
        # caller, so use its captured route snapshot as the dynamic evidence.
        if not dynamic_present and trigger_snapshot is None:
            return None

        expected = {key: udid for key, (udid, _engine) in engines.items()}
        primary_key = _key(getattr(self.app_state, "_primary_udid", None))
        recovery = _Recovery(
            group_id=uuid.uuid4().hex,
            expected=expected,
            primary_key=primary_key if primary_key in expected else None,
            snapshot=trigger_snapshot,
            max_attempts=self.max_recovery_attempts,
        )
        # ACK skew is session telemetry; do not carry a previous route's
        # maximum into a newly formed group.
        self._acks.clear()
        self._last_ack_delta_ms = 0.0
        self._max_ack_delta_ms = 0.0
        if degraded:
            recovery.degraded.add(trigger_key)
        else:
            recovery.lost.add(trigger_key)
            recovery.primary_lost = trigger_key == recovery.primary_key
        return recovery

    def _payload_locked(self, status: str, **extra: Any) -> dict[str, Any]:
        recovery = self._recovery
        if recovery is None:
            return {
                "status": status,
                "strict_sync": self.strict_sync,
                "expected_count": 0,
                "connected_count": 0,
                "ready_count": 0,
                "attempt": 0,
                "max_attempts": self.max_recovery_attempts,
                **extra,
            }

        available = self._available_engines()
        expected_keys = set(recovery.expected)
        ready_keys = set(available).intersection(expected_keys)
        ready_keys.difference_update(recovery.lost)
        ready_keys.difference_update(recovery.degraded)
        missing_keys = expected_keys - ready_keys

        members = []
        for key, udid in recovery.expected.items():
            engine_item = available.get(key) or self._engines().get(key)
            engine = engine_item[1] if engine_item else None
            members.append({
                "udid": udid,
                "state": _state_value(getattr(engine, "state", "disconnected")),
                "connected": key in ready_keys,
                "lost": key in recovery.lost,
                "degraded": key in recovery.degraded,
                "rejoined": key in recovery.rejoined,
            })

        payload: dict[str, Any] = {
            "status": status,
            "phase": "recovering" if status in {"paused", "recovering", "recovery_failed"} else status,
            "group_id": recovery.group_id,
            "strict_sync": self.strict_sync,
            "expected_count": len(expected_keys),
            "total": len(expected_keys),
            "connected_count": len(ready_keys),
            "ready_count": len(ready_keys),
            "reconnected_count": len(recovery.rejoined),
            "missing_udids": [recovery.expected[k] for k in sorted(missing_keys)],
            "lost_udids": [recovery.expected[k] for k in sorted(recovery.lost)],
            "degraded_udids": [recovery.expected[k] for k in sorted(recovery.degraded)],
            "paused_udids": [recovery.expected[k] for k in sorted(recovery.paused)],
            "attempt": recovery.attempt,
            "max_attempts": recovery.max_attempts,
            "primary_udid": recovery.expected.get(recovery.primary_key or ""),
            "route_kind": (recovery.snapshot or {}).get("kind"),
            "members": members,
            "last_ack_delta_ms": round(self._last_ack_delta_ms, 1),
            "max_ack_delta_ms": round(self._max_ack_delta_ms, 1),
        }
        payload.update(extra)
        return payload

    async def _emit(self, status: str, **extra: Any) -> dict[str, Any]:
        async with self._lock:
            payload = self._payload_locked(status, **extra)
            self._last_payload = dict(payload)
        try:
            from api.websocket import broadcast

            await broadcast(self.EVENT_TYPE, payload)
        except Exception:
            logger.debug("group sync: event broadcast failed", exc_info=True)
        return payload

    async def _pause_engines(self, targets: list[tuple[str, Any]]) -> None:
        if not targets:
            return

        async def pause_one(item: tuple[str, Any]):
            key, engine = item
            try:
                await engine.pause()
                return key, None
            except Exception as exc:  # pragma: no cover - defensive path
                return key, exc

        results = await asyncio.gather(
            *(pause_one(item) for item in targets),
            return_exceptions=False,
        )
        failures = [
            {"udid": key, "reason": str(exc)}
            for key, exc in results
            if exc is not None
        ]
        if failures:
            logger.warning("group sync: failed to pause members: %s", failures)
            await self._emit("recovery_failed", failed=failures)

    async def member_degraded(self, udid: str, *, reason: str | None = None) -> bool:
        """Park a strict group when a location channel starts recovering."""
        key = _key(udid)
        pause_targets: list[tuple[str, Any]] = []
        created = False
        async with self._lock:
            recovery = self._recovery
            if recovery is None or recovery.cancelled:
                recovery = self._new_recovery_locked(key, degraded=True)
                if recovery is None:
                    return False
                self._recovery = recovery
                created = True
            elif key not in recovery.expected:
                return False

            if key in recovery.lost:
                return True
            already_degraded = key in recovery.degraded
            recovery.degraded.add(key)
            for member_key, (_udid, engine) in self._engines().items():
                if member_key not in recovery.expected:
                    continue
                if _is_dynamic(getattr(engine, "state", None)):
                    recovery.paused.add(member_key)
                    pause_targets.append((member_key, engine))
            payload = self._payload_locked(
                "paused",
                trigger_udid=udid,
                reason=reason or "location_channel_recovering",
                created=created,
            )
            self._last_payload = dict(payload)

        await self._pause_engines(pause_targets)
        try:
            from api.websocket import broadcast

            await broadcast(self.EVENT_TYPE, payload)
        except Exception:
            logger.debug("group sync: degraded event broadcast failed", exc_info=True)
        if not already_degraded:
            logger.warning(
                "group sync: paused strict group %s because %s is recovering",
                payload.get("group_id"), udid,
            )
        return True

    async def member_lost(self, udid: str, *, reason: str | None = None) -> bool:
        """Park all surviving dynamic members after a real disconnect."""
        key = _key(udid)
        pause_targets: list[tuple[str, Any]] = []
        created = False
        async with self._lock:
            recovery = self._recovery
            if recovery is None or recovery.cancelled:
                recovery = self._new_recovery_locked(key, degraded=False)
                if recovery is None:
                    return False
                self._recovery = recovery
                created = True
            elif key not in recovery.expected:
                return False

            recovery.degraded.discard(key)
            recovery.lost.add(key)
            recovery.rejoined.discard(key)
            if key == recovery.primary_key:
                recovery.primary_lost = True
            for member_key, (_udid, engine) in self._engines().items():
                if member_key not in recovery.expected or member_key == key:
                    continue
                if _is_dynamic(getattr(engine, "state", None)):
                    recovery.paused.add(member_key)
                    pause_targets.append((member_key, engine))
            payload = self._payload_locked(
                "paused",
                trigger_udid=udid,
                reason=reason or "device_disconnected",
                created=created,
            )
            self._last_payload = dict(payload)

        await self._pause_engines(pause_targets)
        try:
            from api.websocket import broadcast

            await broadcast(self.EVENT_TYPE, payload)
        except Exception:
            logger.debug("group sync: lost event broadcast failed", exc_info=True)
        logger.warning(
            "group sync: strict group %s paused after %s disconnected (%d/%d ready)",
            payload.get("group_id"), udid,
            payload.get("ready_count", 0), payload.get("expected_count", 0),
        )
        return True

    async def engine_created(self, udid: str) -> bool:
        """Mark a newly rebuilt engine as rejoined, without resuming yet."""
        key = _key(udid)
        async with self._lock:
            recovery = self._recovery
            if recovery is None or key not in recovery.expected:
                return False
            if recovery.cancelled:
                return False
            if self._lookup_engine(udid) is None:
                return False
            if key not in recovery.lost and key not in recovery.degraded:
                return True
            recovery.lost.discard(key)
            recovery.degraded.discard(key)
            recovery.rejoined.add(key)
            payload = self._payload_locked(
                "recovering",
                trigger_udid=udid,
                reason="engine_reconnected",
            )
            self._last_payload = dict(payload)
        try:
            from api.websocket import broadcast

            await broadcast(self.EVENT_TYPE, payload)
        except Exception:
            logger.debug("group sync: rejoined event broadcast failed", exc_info=True)
        return True

    async def member_reconnected(self, udid: str) -> bool:
        """Reconcile and resume once all expected members are back."""
        key = _key(udid)
        handled = False
        async with self._lock:
            recovery = self._recovery
            if recovery is not None and not recovery.cancelled and key in recovery.expected:
                handled = True
        if not handled:
            return False
        # ``engine_created`` is normally called by AppState first.  Calling
        # it here as well keeps direct test/integration callers idempotent.
        await self.engine_created(udid)
        # The explicit auto-sync path has no route-resume task of its own, so
        # it is safe to reconcile while the fresh engine is idle.  Watchdog
        # resume_from_snapshot paths use engine lifecycle events instead and
        # wait until that task reaches a dynamic state (see _maybe_reconcile)
        # to avoid racing its first route setup.
        await self._maybe_reconcile(force=True)
        return True

    async def handle_engine_event(self, udid: str, event_type: str, data: dict | None = None) -> bool:
        """Consume engine lifecycle events from the AppState callback."""
        payload = data or {}
        state = _state_value(payload.get("state"))
        if event_type == "state_change" and state == SimulationState.DISCONNECTED.value:
            return await self.member_lost(udid, reason="device_disconnected")

        async with self._lock:
            recovery = self._recovery
            if recovery is None or _key(udid) not in recovery.expected:
                return False
            # A user-initiated stop while waiting for a member must cancel the
            # pending automatic resume.  Without this guard, replugging a
            # phone after the user pressed Stop would unexpectedly restart the
            # previous route.
            if (
                event_type == "state_change"
                and state == SimulationState.IDLE.value
                and _key(udid) in recovery.paused
                and not recovery.reconcile_inflight
            ):
                recovery.cancelled = True
                payload_out = self._payload_locked(
                    "cancelled", reason="user_or_route_stopped", trigger_udid=udid
                )
                self._last_payload = dict(payload_out)
                # Keep only the terminal payload for diagnostics.  A later
                # disconnect must form a fresh recovery session instead of
                # reusing the cancelled membership/snapshot.
                self._recovery = None
                retry_task = self._retry_task
                self._retry_task = None
            else:
                payload_out = None
                retry_task = None

        if retry_task is not None and retry_task is not asyncio.current_task():
            retry_task.cancel()

        if payload_out is not None:
            try:
                from api.websocket import broadcast

                await broadcast(self.EVENT_TYPE, payload_out)
            except Exception:
                logger.debug("group sync: cancelled event broadcast failed", exc_info=True)
            return True

        if event_type == "state_change" and (
            state in {item.value for item in DYNAMIC_STATES}
            or state == SimulationState.IDLE.value
        ):
            await self._maybe_reconcile()
        return True

    async def handle_location_health(self, udid: str, channel_state: str, *, reason: str | None = None) -> bool:
        """Bridge location-channel health into strict group recovery."""
        state = str(channel_state or "").lower()
        if state == "recovering":
            return await self.member_degraded(udid, reason=reason)
        if state in {"healthy", "idle"}:
            key = _key(udid)
            async with self._lock:
                recovery = self._recovery
                if recovery is None or key not in recovery.expected:
                    return False
                engine = self._lookup_engine(udid)
                if engine is None or _state_value(getattr(engine, "state", None)) == SimulationState.DISCONNECTED.value:
                    return False
                recovery.degraded.discard(key)
            await self._maybe_reconcile()
            return True
        return False

    def _select_leader_locked(self, recovery: _Recovery, available: dict[str, tuple[str, Any]]) -> tuple[str, Any] | None:
        preferred = _key(getattr(self.app_state, "_primary_udid", None))
        candidates = [recovery.primary_key, preferred]
        if recovery.primary_lost:
            candidates = [preferred]
        for candidate in candidates:
            if candidate and candidate in available and candidate not in recovery.lost and candidate not in recovery.degraded:
                return candidate, available[candidate][1]
        for candidate, item in available.items():
            if candidate in recovery.expected and candidate not in recovery.lost and candidate not in recovery.degraded:
                return candidate, item[1]
        return None

    async def _attach_follower(self, follower_key: str, leader_key: str) -> None:
        starter = self._follower_starter or getattr(self.app_state, "_start_group_follower", None)
        if not callable(starter):
            return
        follower_udid = self._engines().get(follower_key, (follower_key, None))[0]
        leader_udid = self._engines().get(leader_key, (leader_key, None))[0]
        try:
            result = starter(follower_udid, leader_udid)
            # The production starter returns a strongly-referenced Task whose
            # lifetime is the whole route.  Awaiting that task here would keep
            # reconciliation stuck forever and suppress the terminal resumed
            # event.  Only await a short setup coroutine; scheduled
            # Task/Future handles are already owned by the starter.
            if inspect.isawaitable(result) and not isinstance(result, asyncio.Future):
                await result
        except Exception:
            logger.exception(
                "group sync: failed to attach follower %s to %s",
                follower_udid,
                leader_udid,
            )

    def _retain_resume_task(self, task: asyncio.Task) -> None:
        """Keep a handoff route task alive until it completes."""
        task_set = getattr(self.app_state, "_group_resume_tasks", None)
        if task_set is None:
            task_set = set()
            self.app_state._group_resume_tasks = task_set
        task_set.add(task)
        task.add_done_callback(task_set.discard)

    async def _wait_for_leader_route(self, engine: Any, task: asyncio.Task, timeout: float = 15.0) -> bool:
        """Wait until snapshot handoff has entered a followable route state.

        ``resume_from_snapshot`` spans the route's entire lifetime, so it must
        remain a background task.  Followers may only be attached after its
        startup teleport has completed and the engine becomes dynamic.
        """
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            if _is_dynamic(getattr(engine, "state", None)) or (
                _state_value(getattr(engine, "state", None)) == SimulationState.PAUSED.value
            ):
                return True
            if task.done():
                # Consume a startup exception so it does not surface later as
                # an unobserved task failure.
                try:
                    task.result()
                except Exception:
                    logger.debug("group sync: leader resume task failed", exc_info=True)
                return False
            await asyncio.sleep(0.05)
        return False

    def _schedule_retry(self, group_id: str, delay: float) -> None:
        """Schedule one bounded recovery retry for the current group."""
        existing = self._retry_task
        current = asyncio.current_task()
        if existing is not None and not existing.done() and existing is not current:
            return

        async def run_retry():
            try:
                await asyncio.sleep(delay)
                async with self._lock:
                    recovery = self._recovery
                    if recovery is None or recovery.cancelled or recovery.group_id != group_id:
                        return
                    payload = self._payload_locked(
                        "recovering",
                        reason="automatic_retry",
                    )
                    self._last_payload = dict(payload)
                try:
                    from api.websocket import broadcast

                    await broadcast(self.EVENT_TYPE, payload)
                except Exception:
                    logger.debug("group sync: retry event broadcast failed", exc_info=True)
                await self._maybe_reconcile(force=True)
            except asyncio.CancelledError:
                return

        task = asyncio.create_task(run_retry())
        self._retry_task = task

        def clear(done_task):
            if self._retry_task is done_task:
                self._retry_task = None

        task.add_done_callback(clear)

    async def _maybe_reconcile(self, *, force: bool = False) -> bool:
        """Sync rejoined members and resume the route when the group is whole."""
        async with self._lock:
            recovery = self._recovery
            if recovery is None or recovery.cancelled:
                return False
            available = self._available_engines()
            expected_keys = set(recovery.expected)
            ready = set(available).intersection(expected_keys)
            ready.difference_update(recovery.lost)
            ready.difference_update(recovery.degraded)
            if ready != expected_keys:
                return True
            if not force and recovery.rejoined:
                # A tunnel watchdog may already have scheduled
                # ``resume_from_snapshot`` on a newly-created engine.  Its
                # initial teleport emits idle/teleporting events before the
                # route handler enters NAVIGATING; wait for that dynamic
                # state event so reconciliation can safely stop the duplicate
                # task and convert the returning engine into a follower.
                rejoined_engines = [
                    self._engines().get(key, (key, None))[1]
                    for key in recovery.rejoined
                ]
                if rejoined_engines and all(
                    not _is_dynamic(getattr(engine, "state", None))
                    for engine in rejoined_engines
                    if engine is not None
                ):
                    return True
            if recovery.reconcile_inflight:
                return True
            leader_item = self._select_leader_locked(recovery, available)
            if leader_item is None:
                return True
            leader_key, leader = leader_item
            recovery.reconcile_inflight = True
            snapshot = dict(recovery.snapshot or {}) if recovery.snapshot else None
            rejoined = set(recovery.rejoined)
            primary_lost = recovery.primary_lost

        target_pos = getattr(leader, "current_position", None)
        if target_pos is None and snapshot:
            target_pos = snapshot.get("current_pos")
        if hasattr(target_pos, "lat"):
            target_pos_tuple = (target_pos.lat, target_pos.lng)
        elif isinstance(target_pos, (tuple, list)) and len(target_pos) >= 2:
            target_pos_tuple = (float(target_pos[0]), float(target_pos[1]))
        else:
            target_pos_tuple = None

        # Rejoined engines are deliberately synced through their own
        # TeleportHandler before the surviving route resumes.  This keeps the
        # operation compatible with both USB and worker-backed WiFi engines.
        failures: list[dict[str, str]] = []
        leader_resume_task: asyncio.Task | None = None
        if target_pos_tuple is not None:
            for key in sorted(rejoined):
                if key == leader_key:
                    continue
                item = self._engines().get(key)
                if item is None:
                    failures.append({"udid": key, "reason": "engine_missing"})
                    continue
                try:
                    await item[1].teleport(*target_pos_tuple)
                except Exception as exc:
                    failures.append({"udid": item[0], "reason": str(exc) or type(exc).__name__})
        elif rejoined:
            failures.extend({"udid": key, "reason": "no_recovery_position"} for key in sorted(rejoined))

        if not failures:
            try:
                leader_state = _state_value(getattr(leader, "state", None))
                if leader_state == SimulationState.PAUSED.value:
                    await leader.resume()
                elif primary_lost and snapshot and leader_state in {
                    SimulationState.IDLE.value,
                    SimulationState.DISCONNECTED.value,
                }:
                    # The old leader's snapshot is the only reliable route
                    # progress source when the surviving engine had been a
                    # follower (and therefore never owned a route handler).
                    # Start it in the background because resume_from_snapshot
                    # intentionally awaits the full route handler lifetime.
                    leader_resume_task = asyncio.create_task(leader.resume_from_snapshot(snapshot))
                    self._retain_resume_task(leader_resume_task)
                    try:
                        self.app_state._primary_udid = self._engines().get(
                            leader_key, (leader_key, None)
                        )[0]
                    except Exception:
                        pass
                # In-place channel recovery can park more than one engine
                # (for example, when both engines own dynamic handlers in a
                # strict test/group action).  The surviving primary's
                # ``resume`` above is not enough for those peers.  A primary
                # handoff is different: peers are followers and must remain
                # idle until the new leader is running.
                if not primary_lost:
                    for member_key in sorted(recovery.paused - {leader_key} - rejoined):
                        item = self._engines().get(member_key)
                        if item is None:
                            continue
                        if _state_value(getattr(item[1], "state", None)) == SimulationState.PAUSED.value:
                            await item[1].resume()
                elif leader_resume_task is not None and not await self._wait_for_leader_route(
                    leader, leader_resume_task
                ):
                    failures.append({
                        "udid": self._engines().get(leader_key, (leader_key, None))[0],
                        "reason": "leader_resume_did_not_start",
                    })
            except Exception as exc:
                failures.append({
                    "udid": self._engines().get(leader_key, (leader_key, None))[0],
                    "reason": str(exc) or type(exc).__name__,
                })

        if failures:
            retry: tuple[str, float] | None = None
            async with self._lock:
                recovery = self._recovery
                if recovery is not None:
                    recovery.reconcile_inflight = False
                    failed_attempt = recovery.attempt
                    payload = self._payload_locked(
                        "recovery_failed",
                        failed=failures,
                        attempt=failed_attempt,
                    )
                    self._last_payload = dict(payload)
                    existing_retry = self._retry_task
                    retry_already_scheduled = (
                        existing_retry is not None
                        and not existing_retry.done()
                        and existing_retry is not asyncio.current_task()
                    )
                    if failed_attempt < recovery.max_attempts and not retry_already_scheduled:
                        recovery.attempt = failed_attempt + 1
                        delay_index = min(failed_attempt - 1, len(self.retry_delays) - 1)
                        retry = (recovery.group_id, self.retry_delays[delay_index])
            try:
                from api.websocket import broadcast

                await broadcast(self.EVENT_TYPE, payload)
            except Exception:
                logger.debug("group sync: recovery failure broadcast failed", exc_info=True)
            if retry is not None:
                self._schedule_retry(*retry)
            return True

        # If the old primary disappeared, every surviving follower needs a
        # fresh follower task after _primary_udid changes.  If the old primary
        # survived, only newly rejoined members need one; existing followers
        # are still attached to the same leader task.
        follower_keys = set(rejoined)
        if primary_lost:
            follower_keys.update(expected_keys - {leader_key})
        for follower_key in sorted(follower_keys):
            if follower_key != leader_key:
                await self._attach_follower(follower_key, leader_key)

        async with self._lock:
            recovery = self._recovery
            if recovery is None:
                return True
            recovery.reconcile_inflight = False
            payload = self._payload_locked(
                "resumed",
                reason="group_rejoined",
                leader_udid=self._engines().get(leader_key, (leader_key, None))[0],
            )
            self._last_payload = dict(payload)
            recovery.cancelled = True
            # The terminal event remains available through last_payload, but
            # active recovery state must be discarded so the next disconnect
            # creates a new group/session id and cannot short-circuit on the
            # old cancelled session.
            self._recovery = None
            retry_task = self._retry_task
            self._retry_task = None

        if retry_task is not None and retry_task is not asyncio.current_task():
            retry_task.cancel()

        try:
            from api.websocket import broadcast

            await broadcast(self.EVENT_TYPE, payload)
        except Exception:
            logger.debug("group sync: resumed event broadcast failed", exc_info=True)
        logger.info(
            "group sync: group %s resumed with %d members (max ACK delta %.1f ms)",
            payload.get("group_id"), payload.get("ready_count", 0),
            payload.get("max_ack_delta_ms", 0.0),
        )
        return True

    def record_position_ack(
        self,
        udid: str,
        sequence: int,
        lat: float,
        lng: float,
        requested_at: float,
        acknowledged_at: float,
    ) -> dict[str, float | int]:
        """Record a successful location write and group ACK skew.

        A location write returning from ``LocationService.set`` is the
        backend's ACK boundary.  We compare recent ACKs only when their
        coordinates are near one another; this avoids reporting a fake group
        skew while two devices are intentionally in different single-device
        actions.
        """
        key = _key(udid)
        latency_ms = max(0.0, (acknowledged_at - requested_at) * 1000.0)
        ack = _Ack(
            udid=str(udid), sequence=int(sequence), lat=float(lat), lng=float(lng),
            requested_at=float(requested_at), acknowledged_at=float(acknowledged_at),
            latency_ms=latency_ms,
        )
        self._acks[key] = ack

        engines = self._engines()
        group_keys = set(engines)
        recovery = self._recovery
        if recovery is not None:
            group_keys = set(recovery.expected).intersection(group_keys)
        if len(group_keys) < 2:
            self._last_ack_delta_ms = 0.0
            return {
                "position_sequence": ack.sequence,
                "ack_latency_ms": round(latency_ms, 1),
                "group_ack_delta_ms": 0.0,
                "group_max_ack_delta_ms": round(self._max_ack_delta_ms, 1),
            }

        recent = [self._acks.get(member_key) for member_key in group_keys]
        recent = [item for item in recent if item is not None]
        compatible = (
            len(recent) == len(group_keys)
            and max(item.acknowledged_at for item in recent)
            - min(item.acknowledged_at for item in recent) <= 2.0
            and max(item.lat for item in recent) - min(item.lat for item in recent) <= 0.0004
            and max(item.lng for item in recent) - min(item.lng for item in recent) <= 0.0004
        )
        if compatible:
            delta_ms = (
                max(item.acknowledged_at for item in recent)
                - min(item.acknowledged_at for item in recent)
            ) * 1000.0
            self._last_ack_delta_ms = max(0.0, delta_ms)
            self._max_ack_delta_ms = max(self._max_ack_delta_ms, self._last_ack_delta_ms)
        return {
            "position_sequence": ack.sequence,
            "ack_latency_ms": round(latency_ms, 1),
            "group_ack_delta_ms": round(self._last_ack_delta_ms, 1),
            "group_max_ack_delta_ms": round(self._max_ack_delta_ms, 1),
        }

    def position_event_metadata(self, udid: str) -> dict[str, float | int]:
        """Return ACK telemetry for a just-emitted position event."""
        ack = self._acks.get(_key(udid))
        if ack is None:
            return {}
        return {
            "position_sequence": ack.sequence,
            "ack_latency_ms": round(ack.latency_ms, 1),
            "group_ack_delta_ms": round(self._last_ack_delta_ms, 1),
            "group_max_ack_delta_ms": round(self._max_ack_delta_ms, 1),
        }


__all__ = ["DYNAMIC_STATES", "GroupSyncCoordinator"]
