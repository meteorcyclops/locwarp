import asyncio
import unittest
from unittest.mock import patch

from services.location_service import DvtLocationService


class FakeProvider:
    async def __aexit__(self, *_args):
        return None


class HangingLocationSimulation:
    def __init__(self, _provider):
        pass

    async def connect(self):
        return None

    async def set(self, _lat, _lng):
        await asyncio.Event().wait()


class WorkingLocationSimulation:
    def __init__(self, _provider):
        pass

    async def connect(self):
        return None

    async def set(self, _lat, _lng):
        return None


class DvtLocationServiceTimeoutTests(unittest.IsolatedAsyncioTestCase):
    async def test_hung_write_times_out_then_recovers(self):
        events = []

        async def factory():
            return FakeProvider()

        async def health_callback(state, details):
            events.append((state, details))

        service = DvtLocationService(
            FakeProvider(),
            dvt_factory=factory,
            health_callback=health_callback,
        )
        service.SET_TIMEOUT_SECONDS = 0.01

        with patch(
            "services.location_service.LocationSimulation",
            side_effect=[HangingLocationSimulation(None), WorkingLocationSimulation(None)],
        ):
            await service.set(25.0, 121.0)

        self.assertEqual([state for state, _ in events], ["recovering", "healthy"])
        self.assertEqual(events[0][1]["reason"], "TimeoutError")
        self.assertTrue(events[1][1]["recovered"])


if __name__ == "__main__":
    unittest.main()
