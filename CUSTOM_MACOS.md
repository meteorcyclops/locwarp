# LocWarp custom macOS branch

This branch keeps the user's v0.2.190 features while hardening the macOS
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

## Build and test

Run from the repository root:

```sh
./scripts/build-macos.sh
```

The script creates an ignored `.venv`, verifies pymobiledevice3 10.3.0 and its
userspace tunnel module, runs backend regression tests, builds the frontend,
packages the backend with PyInstaller, and produces the unsigned local test app
at `frontend/release/mac-arm64/LocWarp.app`.
