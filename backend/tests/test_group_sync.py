import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from core.group_sync import GroupSyncCoordinator
from models.schemas import Coordinate, SimulationState


class _Engine:
    def __init__(self, state, *, lat=25.0, lng=121.0, snapshot=None):
        self.state = state
        self.current_position = Coordinate(lat=lat, lng=lng)
        self.snapshot = snapshot
        self.pause_calls = 0
        self.resume_calls = 0
        self.teleports = []
        self.resume_snapshots = []

    async def pause(self):
        self.pause_calls += 1
        if self.state != SimulationState.PAUSED:
            self.state = SimulationState.PAUSED

    async def resume(self):
        self.resume_calls += 1
        self.state = SimulationState.NAVIGATING

    async def teleport(self, lat, lng):
        self.teleports.append((lat, lng))
        self.current_position = Coordinate(lat=lat, lng=lng)
        self.state = SimulationState.IDLE

    async def resume_from_snapshot(self, snapshot):
        self.resume_snapshots.append(snapshot)
        self.state = SimulationState.NAVIGATING

    def capture_resumable_snapshot(self, *, allow_disconnected=False):
        if self.snapshot is not None:
            return dict(self.snapshot)
        if self.state in {
            SimulationState.NAVIGATING,
            SimulationState.LOOPING,
            SimulationState.MULTI_STOP,
            SimulationState.RANDOM_WALK,
        } or (allow_disconnected and self.state == SimulationState.DISCONNECTED):
            return {
                "kind": "start_loop",
                "args": {"waypoints": [], "mode": "walking"},
                "current_pos": (
                    self.current_position.lat,
                    self.current_position.lng,
                ),
                "segment_index": 2,
                "lap_count": 1,
            }
        return None


class GroupSyncCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.broadcast = AsyncMock()
        self.followers = []
        self.primary = _Engine(SimulationState.NAVIGATING, lat=25.1, lng=121.5)
        self.follower = _Engine(SimulationState.IDLE, lat=25.1, lng=121.5)
        self.app_state = SimpleNamespace(
            simulation_engines={"A": self.primary, "B": self.follower},
            _primary_udid="A",
        )
        self.coordinator = GroupSyncCoordinator(self.app_state)
        self.coordinator.set_follower_starter(
            lambda follower, leader: self.followers.append((follower, leader))
        )

    async def test_follower_loss_pauses_primary_then_resumes_after_rejoin(self):
        self.follower.state = SimulationState.DISCONNECTED
        with patch("api.websocket.broadcast", self.broadcast):
            handled = await self.coordinator.member_lost("B")

        self.assertTrue(handled)
        self.assertEqual(self.primary.state, SimulationState.PAUSED)
        self.assertEqual(self.primary.pause_calls, 1)
        paused_payload = self.broadcast.await_args.args[1]
        self.assertEqual(paused_payload["status"], "paused")
        self.assertEqual(paused_payload["ready_count"], 1)
        self.assertEqual(paused_payload["expected_count"], 2)

        replacement = _Engine(SimulationState.IDLE, lat=25.0, lng=121.0)
        self.app_state.simulation_engines["B"] = replacement
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.engine_created("B")
            await self.coordinator.member_reconnected("B")

        self.assertEqual(replacement.teleports, [(25.1, 121.5)])
        self.assertEqual(self.primary.resume_calls, 1)
        self.assertEqual(self.followers, [("B", "A")])
        self.assertFalse(self.coordinator.is_recovering)
        self.assertEqual(self.coordinator.last_payload["status"], "resumed")

    async def test_primary_loss_uses_snapshot_handoff_and_keeps_survivor_paused_until_rejoin(self):
        snapshot = {
            "kind": "start_loop",
            "args": {"waypoints": [Coordinate(lat=25.0, lng=121.0)], "mode": "walking"},
            "current_pos": (25.2, 121.6),
            "segment_index": 4,
            "lap_count": 3,
        }
        self.primary.state = SimulationState.DISCONNECTED
        self.primary.snapshot = snapshot

        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.member_lost("A")

        self.assertTrue(self.coordinator.is_recovering)
        # B was a follower/idle engine.  It must not be promoted before A is
        # back; no route task has been started yet.
        self.assertEqual(self.follower.resume_snapshots, [])

        self.app_state.simulation_engines.pop("A")
        self.app_state._primary_udid = "B"
        replacement = _Engine(SimulationState.IDLE, lat=25.2, lng=121.6)
        self.app_state.simulation_engines["A"] = replacement
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.engine_created("A")
            await self.coordinator.member_reconnected("A")
            await asyncio.sleep(0)

        self.assertEqual(replacement.teleports, [(25.1, 121.5)])
        self.assertEqual(self.follower.resume_snapshots, [snapshot])
        self.assertEqual(self.app_state._primary_udid, "B")
        self.assertEqual(self.followers, [("A", "B")])
        self.assertFalse(self.coordinator.is_recovering)

    async def test_reconciliation_does_not_await_route_lifetime_follower_task(self):
        follower_started = asyncio.Event()
        follower_release = asyncio.Event()
        follower_tasks = []

        async def follow_forever():
            follower_started.set()
            await follower_release.wait()

        def start_follower(_follower, _leader):
            task = asyncio.create_task(follow_forever())
            follower_tasks.append(task)
            return task

        self.coordinator.set_follower_starter(start_follower)
        self.follower.state = SimulationState.DISCONNECTED
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.member_lost("B")
        self.app_state.simulation_engines["B"] = _Engine(
            SimulationState.IDLE, lat=25.0, lng=121.0
        )

        try:
            with patch("api.websocket.broadcast", self.broadcast):
                await asyncio.wait_for(
                    self.coordinator.member_reconnected("B"), timeout=0.5
                )
            await asyncio.wait_for(follower_started.wait(), timeout=0.5)
            self.assertEqual(self.coordinator.last_payload["status"], "resumed")
        finally:
            follower_release.set()
            await asyncio.gather(*follower_tasks, return_exceptions=True)

    async def test_recovery_failure_retries_at_most_three_times_and_then_resumes(self):
        class _FlakyEngine(_Engine):
            def __init__(self, *args, failures=0, **kwargs):
                super().__init__(*args, **kwargs)
                self.failures = failures
                self.teleport_attempts = 0

            async def teleport(self, lat, lng):
                self.teleport_attempts += 1
                if self.teleport_attempts <= self.failures:
                    raise RuntimeError("temporary location channel error")
                await super().teleport(lat, lng)

        self.coordinator = GroupSyncCoordinator(
            self.app_state,
            max_recovery_attempts=3,
            retry_delays=(0.01, 0.01),
        )
        self.coordinator.set_follower_starter(
            lambda follower, leader: self.followers.append((follower, leader))
        )
        self.follower.state = SimulationState.DISCONNECTED
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.member_lost("B")

        replacement = _FlakyEngine(
            SimulationState.IDLE, lat=25.0, lng=121.0, failures=2
        )
        self.app_state.simulation_engines["B"] = replacement
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.engine_created("B")
            await self.coordinator.member_reconnected("B")
            deadline = asyncio.get_running_loop().time() + 0.5
            while self.coordinator.is_recovering and asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.01)

        self.assertEqual(replacement.teleport_attempts, 3)
        self.assertFalse(self.coordinator.is_recovering)
        self.assertEqual(self.coordinator.last_payload["status"], "resumed")

    async def test_terminal_session_is_cleared_before_next_group_recovery(self):
        self.follower.state = SimulationState.DISCONNECTED
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.member_lost("B")
        first_group = self.coordinator.last_payload["group_id"]

        replacement = _Engine(SimulationState.IDLE, lat=25.1, lng=121.5)
        self.app_state.simulation_engines["B"] = replacement
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.member_reconnected("B")

        self.assertFalse(self.coordinator.is_recovering)
        self.assertEqual(self.coordinator.last_payload["status"], "resumed")

        replacement.state = SimulationState.DISCONNECTED
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.member_lost("B")

        second_group = self.coordinator.last_payload["group_id"]
        self.assertNotEqual(first_group, second_group)
        self.assertTrue(self.coordinator.is_recovering)

    async def test_ack_telemetry_reports_delta_and_running_maximum(self):
        first = self.coordinator.record_position_ack(
            "A", 7, 25.1, 121.5, 10.0, 10.010,
        )
        second = self.coordinator.record_position_ack(
            "B", 7, 25.1, 121.5, 10.0, 10.052,
        )

        self.assertEqual(first["ack_latency_ms"], 10.0)
        self.assertEqual(second["ack_latency_ms"], 52.0)
        self.assertEqual(second["group_ack_delta_ms"], 42.0)
        self.assertEqual(second["group_max_ack_delta_ms"], 42.0)

    async def test_channel_recovery_pauses_the_triggering_route_and_peer(self):
        self.follower.state = SimulationState.NAVIGATING
        with patch("api.websocket.broadcast", self.broadcast):
            handled = await self.coordinator.member_degraded(
                "B", reason="TimeoutError"
            )

        self.assertTrue(handled)
        self.assertEqual(self.primary.state, SimulationState.PAUSED)
        self.assertEqual(self.follower.state, SimulationState.PAUSED)
        self.assertEqual(self.primary.pause_calls, 1)
        self.assertEqual(self.follower.pause_calls, 1)

        # A health-success callback is enough for an in-place channel recovery;
        # it does not require rebuilding the engine object.
        with patch("api.websocket.broadcast", self.broadcast):
            await self.coordinator.handle_location_health("B", "healthy")

        self.assertEqual(self.primary.resume_calls, 1)
        self.assertEqual(self.follower.resume_calls, 1)
        self.assertFalse(self.coordinator.is_recovering)


if __name__ == "__main__":
    unittest.main()
