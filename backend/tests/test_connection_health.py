import unittest

from services.connection_health import ConnectionHealthTracker


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class ConnectionHealthTrackerTests(unittest.TestCase):
    def test_three_disconnects_in_five_minutes_marks_usb_flapping(self):
        clock = FakeClock()
        tracker = ConnectionHealthTracker(clock=clock)

        first = tracker.record_usb_disconnect("ABC", lifetime=40)
        clock.now += 60
        second = tracker.record_usb_disconnect("ABC", lifetime=35)
        clock.now += 60
        third = tracker.record_usb_disconnect("ABC", lifetime=42)

        self.assertEqual(first["state"], "usb_absent")
        self.assertEqual(second["state"], "usb_absent")
        self.assertEqual(third["state"], "usb_flapping")
        self.assertTrue(third["likely_hardware"])
        self.assertEqual(third["usb_disconnects_5m"], 3)

    def test_old_disconnects_age_out_of_window(self):
        clock = FakeClock()
        tracker = ConnectionHealthTracker(clock=clock)
        tracker.record_usb_disconnect("ABC", lifetime=10)
        clock.now += 301

        state = tracker.set_state("ABC", "connected")

        self.assertEqual(state["usb_disconnects_5m"], 0)
        self.assertFalse(tracker.snapshot()["usb_flapping"])

    def test_connected_snapshot_tracks_uptime_and_last_reconnect(self):
        clock = FakeClock()
        wall_clock = FakeClock()
        wall_clock.now = 1_700_000_000
        tracker = ConnectionHealthTracker(clock=clock, wall_clock=wall_clock)

        tracker.set_state("ABC", "connected")
        clock.now += 42
        wall_clock.now += 42
        connected = tracker.snapshot()["devices"][0]
        self.assertEqual(connected["connection_uptime_seconds"], 42)
        self.assertNotIn("last_reconnect_unix", connected)

        tracker.record_usb_disconnect("ABC", lifetime=42)
        clock.now += 3
        wall_clock.now += 3
        reconnected = tracker.set_state("ABC", "connected")
        self.assertEqual(reconnected["connection_uptime_seconds"], 0)
        self.assertEqual(reconnected["last_disconnect_unix"], 1_700_000_042)
        self.assertEqual(reconnected["last_reconnect_unix"], 1_700_000_045)

    def test_reconnected_device_can_be_connected_but_still_unstable(self):
        clock = FakeClock()
        tracker = ConnectionHealthTracker(clock=clock)
        for _ in range(3):
            tracker.record_usb_disconnect("ABC", lifetime=10)
            clock.now += 20

        connected = tracker.set_state("ABC", "connected")
        self.assertEqual(connected["state"], "connected")
        self.assertTrue(connected["is_connected"])
        self.assertTrue(connected["likely_hardware"])
        self.assertTrue(tracker.snapshot()["usb_flapping"])


if __name__ == "__main__":
    unittest.main()
