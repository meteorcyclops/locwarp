/**
 * Return whether the simulation status represents a user-started route.
 *
 * The backend emits a short `teleporting` state for every manual or GPS
 * watcher teleport.  The general `running` flag is true during that state,
 * but it must not be treated as an active route by passive automations.
 * Keeping this predicate in one place prevents a GPS watcher from stopping
 * itself when its own teleport acknowledgement arrives over WebSocket.
 */
export interface SimulationStatusLike {
  running?: boolean
  state?: string | null
}

export function isRouteRunningStatus(status: SimulationStatusLike | null | undefined): boolean {
  if (!status?.running) return false
  // `running` is intentionally broad in useSimulation: it also covers the
  // transient TELEPORTING state.  Idle/disconnected can be briefly observed
  // with a stale running bit while WebSocket updates are being applied; both
  // are non-route states and should not stop the GPS watcher either.
  return status.state !== 'teleporting'
    && status.state !== 'idle'
    && status.state !== 'disconnected'
}

