"""Hardware-free contract tests for the read-only diagnostics status API."""

from __future__ import annotations

from types import SimpleNamespace
import unittest
from unittest.mock import patch

from api.diagnostics import build_system_diagnostics, router


class _Health:
    def __init__(self, entries):
        self.entries = entries
        self.calls = 0

    def snapshot(self):
        self.calls += 1
        return {"devices": list(self.entries)}


class _Worker:
    def __init__(self, running=True):
        self.running = running
        self.health_calls = 0
        self.info = {
            "name": "Nokia",
            "ios_version": "17.5.1",
            "protocol": "tcp",
            "interface": "utun9",
            "worker_pid": 1234,
        }

    def is_running(self):
        return self.running

    def health(self):  # pragma: no cover - diagnostics must never call this
        self.health_calls += 1
        raise AssertionError("diagnostics must not probe worker health")


def _state(*, connections=None, engines=None, health=None, group=None):
    return SimpleNamespace(
        device_manager=SimpleNamespace(_connections=connections or {}),
        simulation_engines=engines or {},
        connection_health=_Health(health or []),
        group_sync=group or SimpleNamespace(
            strict_sync=True,
            is_recovering=False,
            last_payload=None,
            max_ack_delta_ms=0.0,
        ),
    )


class DiagnosticsContractTests(unittest.TestCase):
    def setUp(self):
        self.versions = {
            "pymobiledevice3": "11.2.4",
            "pmd-pytcp": "0.3.7",
        }
        self.version_patch = patch(
            "api.diagnostics._package_version",
            side_effect=lambda name: self.versions.get(name),
        )
        self.registry_patch = patch("api.diagnostics._tunnel_registry", return_value={})
        self.max_devices_patch = patch("api.diagnostics._max_devices", return_value=3)
        self.version_patch.start()
        self.registry_patch.start()
        self.max_devices_patch.start()

    def tearDown(self):
        self.max_devices_patch.stop()
        self.registry_patch.stop()
        self.version_patch.stop()

    def test_route_and_compact_contract_are_stable(self):
        paths = {route.path for route in router.routes}
        self.assertIn("/api/diagnostics/system", paths)
        self.assertIn("/api/diagnostics/connection", paths)

        state = _state()
        payload = build_system_diagnostics(
            state,
            app_version="0.2.196-kx.18",
            now_monotonic=10.0,
            now_wall=1_700_000_000.0,
        )

        self.assertEqual(payload["status"], "healthy")
        self.assertEqual(payload["app_version"], "0.2.196-kx.18")
        self.assertEqual(payload["backend_version"], "0.2.196-kx.18")
        self.assertEqual(payload["checked_at_unix"], 1_700_000_000.0)
        self.assertEqual(payload["dependencies"], {
            "pymobiledevice3": "11.2.4",
            "pmd_pytcp": "0.3.7",
        })
        self.assertEqual(payload["platform"]["python"], payload["python"]["version"])
        self.assertEqual(payload["counts"]["max_devices"], 3)
        self.assertIsNone(payload["group"])
        self.assertEqual(payload["devices"], [])

    def test_worker_readiness_is_local_only_and_never_calls_health(self):
        worker = _Worker(running=True)
        conn = SimpleNamespace(
            udid="AAA",
            name="Nokia",
            ios_version="17.5.1",
            connection_type="Network",
            worker=worker,
            rsd=None,
            userspace_tunnel=None,
        )
        health = {
            "udid": "AAA",
            "state": "connected",
            "location_active": True,
            "location_channel_state": "healthy",
            "last_location_success_unix": 1_699_999_990.0,
            "last_location_success_age_seconds": 10.0,
        }
        group_payload = {
            "status": "ready",
            "strict_sync": True,
            "expected_count": 1,
            "ready_count": 1,
            "missing_udids": [],
            "last_ack_delta_ms": 1.2,
            "max_ack_delta_ms": 2.3,
            "members": [{"udid": "AAA", "connected": True}],
        }
        state = _state(
            connections={"aaa": conn},
            engines={"AAA": SimpleNamespace(state="navigating")},
            health=[health],
            group=SimpleNamespace(
                strict_sync=True,
                is_recovering=False,
                last_payload=group_payload,
                max_ack_delta_ms=2.3,
            ),
        )

        payload = build_system_diagnostics(state, app_version="v", now_wall=1_700_000_000)
        device = payload["devices"][0]
        self.assertEqual(device["tunnel"]["mode"], "worker")
        self.assertEqual(device["tunnel"]["state"], "ready")
        self.assertTrue(device["tunnel"]["ready"])
        self.assertFalse(device["tunnel"]["end_to_end_verified"])
        self.assertEqual(device["tunnel"]["check"], "worker_process_alive")
        self.assertTrue(device["gps"]["ready"])
        self.assertEqual(payload["counts"]["connected_devices"], 1)
        self.assertEqual(payload["counts"]["wifi_tunnels"], 1)
        self.assertEqual(payload["counts"]["gps_ready_devices"], 1)
        self.assertEqual(payload["group"]["ready_count"], 1)
        self.assertEqual(payload["group"]["max_ack_delta_ms"], 2.3)
        self.assertEqual(payload["status"], "healthy")
        self.assertEqual(worker.health_calls, 0)

    def test_connected_without_successful_location_write_is_unknown_not_green(self):
        conn = SimpleNamespace(
            udid="USB-1",
            name="Sabrina",
            ios_version="16.7",
            connection_type="USB",
            worker=None,
            rsd=None,
            userspace_tunnel=None,
        )
        state = _state(
            connections={"USB-1": conn},
            health=[{
                "udid": "USB-1",
                "state": "connected",
                "location_active": True,
                "location_channel_state": "healthy",
                # A healthy channel without a successful write is not enough
                # evidence for GPS readiness.
            }],
        )

        payload = build_system_diagnostics(state, app_version="v")
        device = payload["devices"][0]
        self.assertTrue(device["connection_ready"])
        self.assertIsNone(device["gps"]["ready"])
        self.assertEqual(device["gps"]["check"], "last_success_required")
        self.assertEqual(payload["counts"]["gps_ready_devices"], 0)
        self.assertEqual(payload["status"], "degraded")

    def test_recovering_health_preserves_last_success_and_recovery_fields(self):
        state = _state(
            connections={"AAA": SimpleNamespace(
                udid="AAA", name=None, ios_version=None, connection_type="USB",
                worker=None, rsd=None, userspace_tunnel=None,
            )},
            health=[{
                "udid": "AAA",
                "state": "connected",
                "location_active": True,
                "location_channel_state": "recovering",
                "last_location_success_unix": 1_700_000_000.0,
                "last_location_success_age_seconds": 8.0,
                "last_location_recovery_unix": None,
                "location_recovery_reason": "TimeoutError",
                "location_recovery_phase": "provider_reacquire",
                "location_stall_seconds": 8.0,
            }],
        )

        payload = build_system_diagnostics(state, app_version="v")
        gps = payload["devices"][0]["gps"]
        self.assertFalse(gps["ready"])
        self.assertEqual(gps["check"], "recovering")
        self.assertEqual(gps["last_success_unix"], 1_700_000_000.0)
        self.assertEqual(gps["recovery_reason"], "TimeoutError")
        self.assertEqual(gps["recovery_phase"], "provider_reacquire")
        self.assertEqual(payload["counts"]["recovering_devices"], 1)
        self.assertEqual(payload["status"], "degraded")


if __name__ == "__main__":
    unittest.main()
