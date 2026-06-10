"""Restore handler -- stop simulation and clear device location."""

from __future__ import annotations

import logging

from models.schemas import SimulationState

logger = logging.getLogger(__name__)


class RestoreHandler:
    """Stops all active simulation and clears the simulated location
    on the device, restoring the real GPS signal."""

    def __init__(self, engine):
        self.engine = engine

    async def restore(self) -> None:
        """Stop everything and clear the location service.

        1. Stop any active movement task.
        2. Clear the simulated location on the device.
        3. Reset engine state to IDLE.
        """
        engine = self.engine

        # Stop any running movement
        if engine.state not in (SimulationState.IDLE, SimulationState.DISCONNECTED):
            await engine.stop()

        # Clear the simulated location on the device
        try:
            await engine.location_service.clear()
            logger.info("Device location simulation cleared (restored real GPS)")
        except Exception:
            logger.exception("Failed to clear device location")
            raise

        # Reset engine state (keep current_position so user can restart without teleporting)
        engine.distance_traveled = 0.0
        engine.distance_remaining = 0.0
        engine.lap_count = 0
        engine.segment_index = 0
        engine.total_segments = 0
        engine.state = SimulationState.IDLE

        await engine._emit("restored", {})
        await engine._emit("state_change", {"state": engine.state.value})

        logger.info("Simulation fully restored")
