"""Structured, low-noise connection health for diagnostics and UI."""

from __future__ import annotations

import time
from collections import defaultdict, deque
from typing import Callable


class ConnectionHealthTracker:
    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        flap_window: float = 300.0,
        flap_threshold: int = 3,
    ) -> None:
        self._clock = clock
        self._wall_clock = wall_clock
        self._flap_window = flap_window
        self._flap_threshold = flap_threshold
        self._states: dict[str, dict] = {}
        self._disconnects: dict[str, deque[float]] = defaultdict(deque)
        self._connected_since: dict[str, float] = {}
        self._last_disconnect: dict[str, float] = {}
        self._last_reconnect: dict[str, float] = {}
        self._last_location_success: dict[str, float] = {}
        self._location_stall_started: dict[str, float] = {}

    def _key(self, udid: str) -> str:
        return udid.lower()

    def _prune(self, key: str, now: float) -> None:
        events = self._disconnects[key]
        while events and now - events[0] > self._flap_window:
            events.popleft()

    def set_state(self, udid: str, state: str, **details) -> dict:
        now = self._clock()
        wall_now = self._wall_clock()
        key = self._key(udid)
        self._prune(key, now)
        previous = self._states.get(key)
        was_connected = previous is not None and previous.get("state") == "connected"
        if state == "connected":
            if not was_connected:
                self._connected_since[key] = wall_now
                if key in self._last_disconnect:
                    self._last_reconnect[key] = wall_now
        else:
            self._connected_since.pop(key, None)
        disconnect_count = len(self._disconnects[key])
        entry = {
            "udid": udid,
            "state": state,
            "updated_monotonic": round(now, 3),
            "usb_disconnects_5m": disconnect_count,
            "is_connected": state == "connected",
            "likely_hardware": disconnect_count >= self._flap_threshold,
            **details,
        }
        if previous:
            for field in (
                "location_active",
                "location_channel_state",
                "last_location_success_unix",
                "last_location_recovery_unix",
                "location_recovery_reason",
                "location_recovery_phase",
            ):
                if field in previous and field not in details:
                    entry[field] = previous[field]
        if state != "connected":
            entry["location_active"] = False
            entry["location_channel_state"] = "unavailable"
            entry.pop("location_recovery_reason", None)
            entry.pop("location_recovery_phase", None)
            self._location_stall_started.pop(key, None)
        if key in self._connected_since:
            entry["connected_since_unix"] = round(self._connected_since[key], 3)
            entry["connection_uptime_seconds"] = round(
                max(0.0, wall_now - self._connected_since[key]), 1
            )
        if key in self._last_disconnect:
            entry["last_disconnect_unix"] = round(self._last_disconnect[key], 3)
        if key in self._last_reconnect:
            entry["last_reconnect_unix"] = round(self._last_reconnect[key], 3)
        self._states[key] = entry
        return dict(entry)

    def get_device(self, udid: str) -> dict | None:
        entry = self._states.get(self._key(udid))
        return dict(entry) if entry else None

    def set_location_active(self, udid: str, active: bool) -> dict:
        key = self._key(udid)
        entry = dict(self._states.get(key) or self.set_state(udid, "connected"))
        entry["location_active"] = active
        if not active:
            # A handler that aborts because recovery failed emits an idle
            # simulation state. Keep the channel warning visible until a
            # later successful write or a real USB state transition clears it.
            if entry.get("location_channel_state") != "recovering":
                entry["location_channel_state"] = "idle"
                entry.pop("location_recovery_reason", None)
                entry.pop("location_recovery_phase", None)
                self._location_stall_started.pop(key, None)
        elif entry.get("location_channel_state") in (None, "idle", "unavailable"):
            entry["location_channel_state"] = "healthy"
        self._states[key] = entry
        return self._with_location_ages(key, entry)

    def record_location_success(self, udid: str, *, recovered: bool = False) -> dict:
        key = self._key(udid)
        wall_now = self._wall_clock()
        entry = dict(self._states.get(key) or self.set_state(udid, "connected"))
        previous_state = entry.get("location_channel_state")
        self._last_location_success[key] = wall_now
        entry.update({
            "location_active": True,
            "location_channel_state": "healthy",
            "last_location_success_unix": round(wall_now, 3),
        })
        if recovered or previous_state == "recovering":
            entry["last_location_recovery_unix"] = round(wall_now, 3)
        entry.pop("location_recovery_reason", None)
        entry.pop("location_recovery_phase", None)
        self._location_stall_started.pop(key, None)
        self._states[key] = entry
        return self._with_location_ages(key, entry)

    def record_location_recovering(
        self,
        udid: str,
        *,
        reason: str | None = None,
        phase: str | None = None,
    ) -> dict:
        key = self._key(udid)
        wall_now = self._wall_clock()
        entry = dict(self._states.get(key) or self.set_state(udid, "connected"))
        self._location_stall_started.setdefault(
            key,
            self._last_location_success.get(key, wall_now),
        )
        entry.update({
            "location_active": True,
            "location_channel_state": "recovering",
        })
        if reason:
            entry["location_recovery_reason"] = reason
        if phase:
            entry["location_recovery_phase"] = phase
        self._states[key] = entry
        return self._with_location_ages(key, entry)

    def _with_location_ages(self, key: str, entry: dict) -> dict:
        result = dict(entry)
        wall_now = self._wall_clock()
        last_success = self._last_location_success.get(key)
        if last_success is not None:
            result["last_location_success_age_seconds"] = round(
                max(0.0, wall_now - last_success), 1
            )
        stall_started = self._location_stall_started.get(key)
        if stall_started is not None:
            result["location_stall_seconds"] = round(
                max(0.0, wall_now - stall_started), 1
            )
        else:
            result.pop("location_stall_seconds", None)
        return result

    def record_usb_disconnect(self, udid: str, *, lifetime: float) -> dict:
        now = self._clock()
        key = self._key(udid)
        self._last_disconnect[key] = self._wall_clock()
        self._connected_since.pop(key, None)
        self._disconnects[key].append(now)
        self._prune(key, now)
        count = len(self._disconnects[key])
        state = "usb_flapping" if count >= self._flap_threshold else "usb_absent"
        return self.set_state(
            udid,
            state,
            connection_lifetime_seconds=round(max(0.0, lifetime), 1),
            likely_hardware=state == "usb_flapping",
        )

    def snapshot(self) -> dict:
        now = self._clock()
        wall_now = self._wall_clock()
        for key in list(self._disconnects):
            self._prune(key, now)
            if key in self._states:
                self._states[key]["usb_disconnects_5m"] = len(self._disconnects[key])
                if (
                    self._states[key]["state"] == "usb_flapping"
                    and len(self._disconnects[key]) < self._flap_threshold
                ):
                    self._states[key]["state"] = "usb_absent"
                    self._states[key]["likely_hardware"] = False
                elif self._states[key]["state"] == "connected":
                    self._states[key]["likely_hardware"] = (
                        len(self._disconnects[key]) >= self._flap_threshold
                    )
            if key in self._states and key in self._connected_since:
                self._states[key]["connection_uptime_seconds"] = round(
                    max(0.0, wall_now - self._connected_since[key]), 1
                )
        devices = [
            self._with_location_ages(key, value)
            for key, value in self._states.items()
        ]
        return {
            "devices": devices,
            "usb_flapping": any(
                item["state"] == "usb_flapping" or item.get("likely_hardware")
                for item in devices
            ),
            "flap_window_seconds": self._flap_window,
            "flap_threshold": self._flap_threshold,
        }
