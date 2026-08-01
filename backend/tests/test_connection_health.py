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


if __name__ == "__main__":
    unittest.main()
