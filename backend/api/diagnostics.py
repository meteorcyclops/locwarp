"""Read-only backend and per-device diagnostics.

The diagnostics endpoint deliberately reports observations already held by
the backend.  It does not discover devices, issue a worker ``health``
request, or probe a tunnel.  In particular, a worker process being alive is
not presented as end-to-end tunnel verification, and a connected device is
not presented as GPS-ready until the existing connection-health tracker has
observed a successful location write.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import math
import platform as platform_module
import time
from collections.abc import Mapping
from enum import Enum
from typing import Any

from fastapi import APIRouter


router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])

DIAGNOSTICS_SCHEMA_VERSION = 1
_PROCESS_STARTED_MONOTONIC = time.monotonic()


def _json_safe(value: Any) -> Any:
    """Return a JSON-compatible copy, dropping unverifiable objects.

    Health/event dictionaries are normally composed of primitive values, but
    this boundary is intentionally defensive: diagnostics must never make an
    otherwise healthy API fail because a future telemetry field contains a
    custom object, NaN, or an enum.
    """

    if isinstance(value, Enum):
        return _json_safe(value.value)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_json_safe(item) for item in value]
    return None


def _value(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _text(value: Any) -> str | None:
    if isinstance(value, Enum):
        value = value.value
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _canonical(value: Any) -> str:
    return str(value or "").strip().casefold()


def _mapping(value: Any) -> Mapping:
    return value if isinstance(value, Mapping) else {}


def _safe_call(callable_value: Any, *args: Any, **kwargs: Any) -> Any:
    if not callable(callable_value):
        return None
    try:
        return callable_value(*args, **kwargs)
    except Exception:
        return None


def _package_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except Exception:
        return None


def _module_available(module_name: str) -> bool:
    try:
        return importlib.util.find_spec(module_name) is not None
    except Exception:
        return False


def _runtime_snapshot(app_version: str | None, now_monotonic: float, now_wall: float) -> dict[str, Any]:
    pmd_version = _package_version("pymobiledevice3")
    pytcp_version = _package_version("pmd-pytcp")
    unknown_dependencies = [
        name
        for name, module_name, version in (
            ("pymobiledevice3", "pymobiledevice3", pmd_version),
            ("pmd-pytcp", "pmd_pytcp", pytcp_version),
        )
        if version is None and _module_available(module_name)
    ]
    missing_dependencies = [
        name
        for name, module_name, version in (
            ("pymobiledevice3", "pymobiledevice3", pmd_version),
            ("pmd-pytcp", "pmd_pytcp", pytcp_version),
        )
        if version is None and not _module_available(module_name)
    ]
    if missing_dependencies:
        dependency_status = "degraded"
    elif unknown_dependencies:
        dependency_status = "unknown"
    else:
        dependency_status = "ok"

    system = _text(_safe_call(platform_module.system))
    release = _text(_safe_call(platform_module.release))
    version = _text(_safe_call(platform_module.version))
    machine = _text(_safe_call(platform_module.machine))
    processor = _text(_safe_call(platform_module.processor))
    python_version = _text(_safe_call(platform_module.python_version))
    python_implementation = _text(_safe_call(platform_module.python_implementation))
    return {
        "checked_at_unix": round(max(0.0, now_wall), 3),
        "app_version": _text(app_version),
        "backend_version": _text(app_version),
        "python": {
            "version": python_version,
            "implementation": python_implementation,
        },
        "pymobiledevice3": pmd_version,
        "pmd_pytcp": pytcp_version,
        "uptime_seconds": round(max(0.0, now_monotonic - _PROCESS_STARTED_MONOTONIC), 1),
        "platform": {
            "system": system,
            "release": release,
            "version": version,
            "machine": machine,
            "processor": processor,
            "python": python_version,
        },
        "arch": machine,
        "backend_health": {
            "status": "ok",
            "check": "request_served",
        },
        "_dependency_check": {
            "status": dependency_status,
            "missing": missing_dependencies,
            "unknown": unknown_dependencies,
        },
    }


def _health_entries(app_state: Any) -> dict[str, dict[str, Any]]:
    tracker = _value(app_state, "connection_health")
    snapshot = _safe_call(_value(tracker, "snapshot"))
    entries = _mapping(snapshot).get("devices", [])
    if not isinstance(entries, (list, tuple)):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for item in entries:
        if not isinstance(item, Mapping):
            continue
        udid = _text(item.get("udid"))
        key = _canonical(udid)
        if not key:
            continue
        result[key] = dict(item)
    return result


def _tunnel_registry() -> dict[str, Any]:
    """Read the existing tunnel registry without taking its async lock."""

    try:
        from api import device as device_api

        raw = _value(device_api, "_tunnels", {})
    except Exception:
        return {}
    return dict(raw) if isinstance(raw, Mapping) else {}


def _runner_identity(key: Any, runner: Any) -> str:
    info = _mapping(_value(runner, "info", {}))
    return _text(info.get("udid")) or _text(_value(runner, "udid")) or _text(key) or ""


def _runner_running(runner: Any) -> bool | None:
    value = _value(runner, "is_running")
    if callable(value):
        try:
            return bool(value())
        except Exception:
            return None
    if isinstance(value, bool):
        return value
    return None


def _worker_info(worker: Any) -> dict[str, Any]:
    info = _mapping(_value(worker, "info", {}))
    return dict(info)


def _tunnel_snapshot(conn: Any, registry_runner: Any) -> dict[str, Any]:
    worker = _value(conn, "worker") if conn is not None else None
    runner = worker or registry_runner
    info = _worker_info(runner) if runner is not None else {}
    protocol = _text(info.get("protocol"))
    interface = _text(info.get("interface"))
    worker_pid = info.get("worker_pid")
    if not isinstance(worker_pid, int) or isinstance(worker_pid, bool):
        worker_pid = None

    if worker is not None:
        running = _runner_running(worker)
        if running is True:
            state = "ready"
            check = "worker_process_alive"
        elif running is False:
            state = "stopped"
            check = "worker_process_not_alive"
        else:
            state = "unknown"
            check = "worker_state_unreadable"
        return {
            "mode": "worker",
            "state": state,
            # This is explicitly local process readiness, not phone/RSD
            # verification.  The distinction is exposed below.
            "ready": running,
            "check": check,
            "end_to_end_verified": False,
            "protocol": protocol,
            "interface": interface,
            "worker_pid": worker_pid,
        }

    connection_type = _text(_value(conn, "connection_type")) if conn is not None else None
    rsd = _value(conn, "rsd") if conn is not None else None
    userspace_tunnel = _value(conn, "userspace_tunnel") if conn is not None else None
    local_runner_alive = _runner_running(registry_runner) if registry_runner is not None else None

    if registry_runner is not None:
        # The in-process runner's task/rsd ownership is useful context, but
        # checking it cannot prove that the phone still accepts DVT traffic.
        return {
            "mode": "in_process",
            "state": "unknown",
            "ready": None,
            "check": "no_active_probe",
            "end_to_end_verified": False,
            "local_runner_alive": local_runner_alive,
            "protocol": protocol,
            "interface": interface,
            "worker_pid": None,
        }

    if userspace_tunnel is not None or rsd is not None:
        return {
            "mode": "userspace" if userspace_tunnel is not None else "rsd",
            "state": "unknown",
            "ready": None,
            "check": "no_active_probe",
            "end_to_end_verified": False,
            "local_owner_present": True,
            "protocol": protocol,
            "interface": interface,
            "worker_pid": None,
        }

    if connection_type and connection_type.casefold() in {"network", "wifi", "wi-fi"}:
        return {
            "mode": "unknown",
            "state": "unknown",
            "ready": None,
            "check": "no_tunnel_registry",
            "end_to_end_verified": False,
            "protocol": None,
            "interface": None,
            "worker_pid": None,
        }

    return {
        "mode": "none",
        "state": "not_applicable",
        "ready": None,
        "check": "not_applicable",
        "end_to_end_verified": False,
        "protocol": None,
        "interface": None,
        "worker_pid": None,
    }


def _simulation_state(engine: Any) -> str | None:
    if engine is None:
        return None
    return _text(_value(engine, "state"))


def _gps_snapshot(
    health: Mapping,
    engine: Any,
    *,
    registry_present: bool = True,
) -> dict[str, Any]:
    channel_state = _text(health.get("location_channel_state"))
    connection_state = _text(health.get("state"))
    last_success = health.get("last_location_success_unix")
    last_success = (
        last_success
        if isinstance(last_success, (int, float)) and not isinstance(last_success, bool)
        else None
    )
    active_value = health.get("location_active")
    active = active_value if isinstance(active_value, bool) else None

    if not health:
        ready = None
        check = "no_health_evidence"
    elif connection_state != "connected":
        ready = False
        check = "device_not_connected"
    elif not registry_present:
        # A stale health entry must not make an already-removed connection
        # look GPS-ready while its per-UDID registry is being torn down.
        ready = None
        check = "connection_registry_missing"
    elif channel_state == "recovering":
        ready = False
        check = "recovering"
    elif last_success is None:
        ready = None
        check = "last_success_required"
    elif channel_state == "healthy" and active is True:
        ready = True
        check = "healthy_last_success"
    elif channel_state == "idle":
        ready = None
        check = "channel_idle"
    else:
        ready = None
        check = "channel_state_unknown"

    return {
        "state": _simulation_state(engine),
        "active": active,
        "channel_state": channel_state,
        "last_success_unix": last_success,
        "last_success_age_seconds": health.get("last_location_success_age_seconds"),
        "last_recovery_unix": health.get("last_location_recovery_unix"),
        "recovery_reason": _text(health.get("location_recovery_reason")),
        "recovery_phase": _text(health.get("location_recovery_phase")),
        "stall_seconds": health.get("location_stall_seconds"),
        "ready": ready,
        "check": check,
        "end_to_end_verified": ready is True,
    }


def _status_for_readiness(values: list[bool | None], *, none_status: str = "unknown") -> str:
    if not values:
        return "not_applicable"
    if any(value is False for value in values):
        return "degraded"
    if any(value is None for value in values):
        return none_status
    return "ok"


def _group_snapshot(app_state: Any, engines: Mapping[str, Any]) -> dict[str, Any]:
    coordinator = _value(app_state, "group_sync")
    strict_sync = _value(coordinator, "strict_sync")
    strict_sync = strict_sync if isinstance(strict_sync, bool) else None
    is_recovering_value = _value(coordinator, "is_recovering")
    is_recovering = is_recovering_value if isinstance(is_recovering_value, bool) else None
    last_payload = _value(coordinator, "last_payload")
    if isinstance(last_payload, Mapping):
        last_payload = _json_safe(last_payload)
    else:
        last_payload = None
    max_ack = _value(coordinator, "max_ack_delta_ms")
    max_ack = (
        max_ack
        if isinstance(max_ack, (int, float)) and not isinstance(max_ack, bool)
        else None
    )
    members = _mapping(last_payload).get("members") if last_payload else None
    if isinstance(members, (list, tuple)):
        member_count = len(members)
    else:
        member_count = len(engines)
    event_state = _text(_mapping(last_payload).get("status")) if last_payload else None
    state = "recovering" if is_recovering is True else (event_state or "idle")
    return {
        "strict_sync": strict_sync,
        "state": state,
        "is_recovering": is_recovering,
        "last_event": last_payload,
        "max_ack_delta_ms": max_ack,
        "member_count": member_count,
    }


def _max_devices() -> int | None:
    try:
        from api.device import MAX_DEVICES

        return int(MAX_DEVICES)
    except Exception:
        return None


def _group_contract(group: Mapping[str, Any]) -> dict[str, Any] | None:
    """Project coordinator telemetry into the Settings status-center shape."""

    last_event = _mapping(group.get("last_event"))
    if not last_event and group.get("is_recovering") is not True:
        return None

    raw_status = _text(last_event.get("status"))
    degraded_states = {"paused", "recovering", "recovery_failed", "degraded"}
    group_status = "degraded" if (
        group.get("is_recovering") is True or raw_status in degraded_states
    ) else "healthy"
    expected = last_event.get("expected_count", last_event.get("total", group.get("member_count", 0)))
    ready = last_event.get("ready_count", last_event.get("connected_count", 0))
    expected = expected if isinstance(expected, int) and not isinstance(expected, bool) else 0
    ready = ready if isinstance(ready, int) and not isinstance(ready, bool) else 0
    missing = last_event.get("missing_udids", [])
    if not isinstance(missing, (list, tuple)):
        missing = []
    missing = [value for value in (_text(item) for item in missing) if value]
    last_ack = last_event.get("last_ack_delta_ms")
    if not isinstance(last_ack, (int, float)) or isinstance(last_ack, bool):
        last_ack = None
    max_ack = group.get("max_ack_delta_ms")
    if not isinstance(max_ack, (int, float)) or isinstance(max_ack, bool):
        max_ack = last_event.get("max_ack_delta_ms")
    if not isinstance(max_ack, (int, float)) or isinstance(max_ack, bool):
        max_ack = None
    strict_sync = last_event.get("strict_sync", group.get("strict_sync"))
    strict_sync = strict_sync if isinstance(strict_sync, bool) else None
    return {
        "status": group_status,
        "strict_sync": strict_sync,
        "expected_count": expected,
        "ready_count": ready,
        "missing_udids": missing,
        "last_ack_delta_ms": last_ack,
        "max_ack_delta_ms": max_ack,
    }


def build_system_diagnostics(
    app_state: Any,
    *,
    app_version: str | None = None,
    now_monotonic: float | None = None,
    now_wall: float | None = None,
) -> dict[str, Any]:
    """Build the stable status-center payload without performing I/O."""

    now_monotonic = time.monotonic() if now_monotonic is None else now_monotonic
    now_wall = time.time() if now_wall is None else now_wall
    runtime = _runtime_snapshot(app_version, now_monotonic, now_wall)

    health = _health_entries(app_state)
    dm = _value(app_state, "device_manager")
    connections = _mapping(_value(dm, "_connections", {}))
    engines = _mapping(_value(app_state, "simulation_engines", {}))
    tunnel_registry = _tunnel_registry()

    records: dict[str, dict[str, Any]] = {}

    def record_for(value: Any) -> dict[str, Any] | None:
        key = _canonical(value)
        if not key or key == "__legacy__":
            return None
        return records.setdefault(key, {"udid": _text(value)})

    for stored_udid, conn in connections.items():
        identity = _text(_value(conn, "udid")) or _text(stored_udid)
        record = record_for(identity)
        if record is not None:
            record["connection"] = conn

    for key, item in health.items():
        record = record_for(item.get("udid") or key)
        if record is not None:
            record["health"] = item

    for stored_udid, engine in engines.items():
        record = record_for(stored_udid)
        if record is not None:
            record["engine"] = engine

    for stored_udid, runner in tunnel_registry.items():
        identity = _runner_identity(stored_udid, runner)
        record = record_for(identity)
        if record is not None:
            record["registry_runner"] = runner

    devices: list[dict[str, Any]] = []
    for key, record in records.items():
        conn = record.get("connection")
        health_entry = _mapping(record.get("health"))
        engine = record.get("engine")
        registry_runner = record.get("registry_runner")
        worker = _value(conn, "worker") if conn is not None else None
        worker_info = _worker_info(worker)

        # The connection table and worker metadata are local observations;
        # health state remains the authority for connection readiness.
        name = _text(_value(conn, "name")) or _text(worker_info.get("name"))
        ios_version = (
            _text(_value(conn, "ios_version"))
            or _text(worker_info.get("ios_version"))
        )
        connection_type = (
            _text(_value(conn, "connection_type"))
            or ("Network" if registry_runner is not None else None)
        )
        connection_state = _text(health_entry.get("state"))
        registry_present = conn is not None
        if connection_state == "connected" and registry_present:
            connection_ready: bool | None = True
        elif connection_state in {
            "usb_absent",
            "usb_flapping",
            "disconnected",
            "error",
        }:
            connection_ready = False
        else:
            connection_ready = None

        tunnel = _tunnel_snapshot(conn, registry_runner)
        gps = _gps_snapshot(
            health_entry,
            engine,
            registry_present=registry_present,
        )
        devices.append({
            "udid": _text(record.get("udid")) or key,
            "name": name,
            "ios_version": ios_version,
            "connection_type": connection_type,
            "connection_state": connection_state,
            "connection_ready": connection_ready,
            "registry_present": registry_present,
            "connection_health": _json_safe(health_entry) if health_entry else None,
            "tunnel": _json_safe(tunnel),
            "gps": _json_safe(gps),
        })

    devices.sort(key=lambda item: _canonical(item.get("udid")))
    tunnel_ready = [item["tunnel"].get("ready") for item in devices]
    gps_ready = [item["gps"].get("ready") for item in devices]
    connection_ready = [item.get("connection_ready") for item in devices]
    gps_success_count = sum(
        item["gps"].get("last_success_unix") is not None for item in devices
    )
    unknown_devices = sum(value is None for value in connection_ready)
    tunnel_applicable = [
        item["tunnel"].get("ready")
        for item in devices
        if item["tunnel"].get("mode") != "none"
    ]

    if not devices:
        device_status = tunnel_status = gps_status = "not_applicable"
    else:
        device_status = _status_for_readiness(connection_ready)
        tunnel_status = _status_for_readiness(tunnel_applicable)
        gps_status = _status_for_readiness(gps_ready)

    dependency_check = runtime.pop("_dependency_check")
    dependencies = {
        "pymobiledevice3": runtime.get("pymobiledevice3"),
        "pmd_pytcp": runtime.get("pmd_pytcp"),
    }
    group = _group_snapshot(app_state, engines)
    group_contract = _group_contract(group)
    checks = {
        "backend": {"status": "ok", "reason": "request_served"},
        "dependencies": dependency_check,
        "devices": {
            "status": device_status,
            "ready": sum(value is True for value in connection_ready),
            "total": len(devices),
        },
        "tunnels": {
            "status": tunnel_status,
            "ready": sum(value is True for value in tunnel_ready),
            "total": len(tunnel_applicable),
            "end_to_end_verified": False,
        },
        "gps": {
            "status": gps_status,
            "ready": sum(value is True for value in gps_ready),
            "total": len(devices),
        },
    }

    # A WiFi count is intentionally limited to entries for which the local
    # runner explicitly reports alive.  A registry entry that cannot be
    # inspected is not silently counted as a healthy tunnel.
    wifi_tunnels = sum(
        item["tunnel"].get("mode") in {"worker", "in_process"}
        and (
            item["tunnel"].get("ready") is True
            or item["tunnel"].get("local_runner_alive") is True
        )
        for item in devices
    )
    recovering_devices = sum(
        item["gps"].get("check") == "recovering"
        or item["gps"].get("check") == "device_not_connected"
        and _text(item.get("connection_state")) in {"reconnecting", "recovering"}
        for item in devices
    )
    simulation_engine_count = sum(
        _canonical(udid) != "__legacy__" for udid in engines
    )
    # ``unknown`` is an attention state at this compact boundary.  An idle
    # backend with no devices remains healthy; any tracked device with
    # missing evidence stays visibly degraded rather than becoming a green
    # status-center badge.
    overall_status = "healthy"
    if dependency_check.get("status") != "ok" or devices and any(
        value not in {"ok", "not_applicable"} for value in (
            checks["devices"]["status"],
            checks["tunnels"]["status"],
            checks["gps"]["status"],
        )
    ):
        overall_status = "degraded"
    if group.get("is_recovering") is True:
        overall_status = "degraded"
    if group_contract is not None and group_contract.get("status") != "healthy":
        overall_status = "degraded"

    runtime.update({
        "status": overall_status,
        "schema_version": DIAGNOSTICS_SCHEMA_VERSION,
        "dependencies": dependencies,
        "counts": {
            "connected_devices": sum(value is True for value in connection_ready),
            "simulation_engines": simulation_engine_count,
            "wifi_tunnels": wifi_tunnels,
            "gps_ready_devices": sum(value is True for value in gps_ready),
            "recovering_devices": recovering_devices,
            "max_devices": _max_devices(),
        },
        "group": group_contract,
        "devices": devices,
        "ready_counts": {
            "total": len(devices),
            "devices": sum(value is True for value in connection_ready),
            "tunnels": sum(value is True for value in tunnel_ready),
            "gps": sum(value is True for value in gps_ready),
            "gps_last_success": gps_success_count,
            "unknown_devices": unknown_devices,
        },
        "checks": checks,
        "group_sync": group,
    })
    return _json_safe(runtime)


@router.get("/system")
async def system_diagnostics():
    """Return runtime and device status without changing connection state."""

    from main import APP_VERSION, app_state

    return build_system_diagnostics(app_state, app_version=APP_VERSION)


@router.get("/connection")
async def connection_diagnostics():
    from main import app_state

    return app_state.connection_health.snapshot()
