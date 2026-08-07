# LocWarp custom macOS branch

This branch keeps the user's custom features on top of upstream v0.2.192 while hardening the macOS
runtime.  It is intentionally separate from the upstream tracking branch.

## Runtime boundary

- Electron launches the backend as the signed-in user, not as root.
- Electron generates a new 256-bit desktop API token on every app launch.
- Desktop HTTP APIs require `X-LocWarp-Desktop-Token` and loopback access.
- Desktop WebSocket authentication uses a `locwarp.<token>` subprotocol so the
  token does not appear in access-log URLs.
- `/phone` and `/api/phone/*` retain the existing LAN PIN/token flow.
- `/healthz` is the only unauthenticated desktop probe and returns only status
  and version.

For frontend development only, a manually launched backend can opt into local
requests without a desktop token by setting `LOCWARP_ALLOW_INSECURE_LOCAL=1`.
Never use that switch in a packaged build.

## Connection observability

`GET /api/diagnostics/connection` and `connection_health` WebSocket events
report `stabilizing`, `connecting`, `connected`, `reconnect_backoff`,
`usb_absent`, and `usb_flapping`. Three USB detachments in five minutes mark
the link as flapping and surface a cable/connector/power warning in the UI.
The connected view also reports continuous uptime, the rolling five-minute
disconnect count, and the most recent disconnect/reconnect time.

Active simulations additionally report the last successful location write.
A DVT write that does not complete within four seconds is treated as a stalled
location channel: the UI turns amber, shows the stall duration, and reports the
RSD/DVT rebuild instead of leaving the USB card falsely green. A successful
retry records the automatic recovery time and returns the card to healthy.

## Build and test

Run from the repository root:

```sh
./scripts/build-macos.sh
```

The script creates an ignored `.venv`, verifies pymobiledevice3 10.3.0 and its
userspace tunnel module, runs backend regression tests, builds the frontend,
packages the backend with PyInstaller, and produces the unsigned local test app
at `frontend/release/mac-arm64/LocWarp.app`.
