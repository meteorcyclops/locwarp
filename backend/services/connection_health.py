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
        devices = [dict(value) for value in self._states.values()]
        return {
            "devices": devices,
            "usb_flapping": any(
                item["state"] == "usb_flapping" or item.get("likely_hardware")
                for item in devices
            ),
            "flap_window_seconds": self._flap_window,
            "flap_threshold": self._flap_threshold,
        }
