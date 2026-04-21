# LocWarp

**A cross-platform iPhone virtual location tool, with this fork now focused on a full CLI + browser UI workflow.**

This fork has a very different emphasis from the original project:

- **runs on macOS**
- **exposes core features through CLI**
- still supports a **browser UI** backed by the existing frontend
- no longer treats the packaged Windows Electron app as the only primary workflow

If you want LocWarp to behave like a scriptable, automatable toolchain that is practical on macOS, this fork is moving in that direction.

---

## Quick start

### Start full service

```bash
cd locwarp
python3 locwarp.py serve --open
```

### Start through the legacy entrypoint

```bash
python3 start.py
```

### Double-click on macOS

```text
LocWarp.command
```

### Backend only

```bash
python3 locwarp.py serve --backend-only
```

---

## CLI overview

```bash
locwarp serve
locwarp open
locwarp device-list
locwarp device-connect
locwarp device-info
locwarp status
locwarp search
locwarp real-location
locwarp teleport
locwarp navigate
locwarp loop
locwarp multistop
locwarp randomwalk
locwarp pause
locwarp resume
locwarp stop
locwarp restore
locwarp recent-list
locwarp recent-add
locwarp recent-clear
locwarp bookmark-list
locwarp bookmark-add
locwarp bookmark-delete
locwarp category-list
locwarp category-add
locwarp route-plan
locwarp route-list
locwarp route-save
locwarp route-rename
locwarp route-delete
locwarp route-export
locwarp route-import
locwarp gpx-import
locwarp gpx-export
```

In practice, run commands like this:

```bash
python3 locwarp.py <command>
```

---

## Common workflow

### 1. Start services

```bash
python3 locwarp.py serve --open
```

### 2. List devices

```bash
python3 locwarp.py device-list
```

### 3. Connect a device

```bash
python3 locwarp.py device-connect <udid>
```

### 4. Search a place

```bash
python3 locwarp.py search "Taipei 101"
```

### 5. Teleport

```bash
python3 locwarp.py teleport 25.033 121.5654
```

### 6. Navigate

```bash
python3 locwarp.py navigate 25.033 121.5654 --mode walking
```

### 7. Check status

```bash
python3 locwarp.py status
```

### 8. Pause / resume / stop / restore

```bash
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
```

---

## Command reference

## Startup and frontend

### `serve`
Starts backend, and optionally frontend too.

```bash
python3 locwarp.py serve --open
python3 locwarp.py serve --backend-only
```

### `open`
Open the frontend page in the browser.

```bash
python3 locwarp.py open
```

---

## Devices

### `device-list`

```bash
python3 locwarp.py device-list
```

### `device-connect`

```bash
python3 locwarp.py device-connect <udid>
```

### `device-info`

```bash
python3 locwarp.py device-info <udid>
```

---

## Location and movement

### `status`

```bash
python3 locwarp.py status
python3 locwarp.py status --udid <udid>
```

### `teleport`

```bash
python3 locwarp.py teleport 25.033 121.5654
python3 locwarp.py teleport 25.033 121.5654 --udid <udid>
```

### `navigate`

```bash
python3 locwarp.py navigate 25.033 121.5654 --mode walking
python3 locwarp.py navigate 25.033 121.5654 --mode driving --speed-kmh 40
```

### `loop`

```bash
python3 locwarp.py loop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --mode walking
python3 locwarp.py loop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --lap-count 5
```

### `multistop`

```bash
python3 locwarp.py multistop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --stop-duration 10
```

### `randomwalk`

```bash
python3 locwarp.py randomwalk 25.033 121.5654 --radius-m 500
```

### `pause` / `resume` / `stop` / `restore`

```bash
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
```

---

## Geocoding

### `search`

```bash
python3 locwarp.py search "Taipei 101"
python3 locwarp.py search "Shibuya Station"
```

### `real-location`

```bash
python3 locwarp.py real-location
```

---

## Recent

### `recent-list`

```bash
python3 locwarp.py recent-list
```

### `recent-add`

```bash
python3 locwarp.py recent-add 25.033 121.5654 --kind teleport --name "Taipei 101"
```

### `recent-clear`

```bash
python3 locwarp.py recent-clear
```

---

## Bookmarks

### `bookmark-list`

```bash
python3 locwarp.py bookmark-list
```

### `bookmark-add`

```bash
python3 locwarp.py bookmark-add "Taipei 101" 25.033 121.5654
python3 locwarp.py bookmark-add "Home" 25.0 121.5 --address "Taipei" --category-id default
```

### `bookmark-delete`

```bash
python3 locwarp.py bookmark-delete <bookmark-id>
```

### `category-list`

```bash
python3 locwarp.py category-list
```

### `category-add`

```bash
python3 locwarp.py category-add "Japan" --color "#ff5a5f"
```

---

## Routes / GPX

### `route-plan`

```bash
python3 locwarp.py route-plan 25.033 121.5654 25.047 121.517 --profile walking
```

### `route-list`

```bash
python3 locwarp.py route-list
```

### `route-save`

```bash
python3 locwarp.py route-save "Taipei Loop" 25.033,121.5654 25.034,121.5660 25.032,121.5670 --profile walking
```

### `route-rename`

```bash
python3 locwarp.py route-rename <route-id> "New Name"
```

### `route-delete`

```bash
python3 locwarp.py route-delete <route-id>
```

### `route-export`

```bash
python3 locwarp.py route-export routes.json
```

### `route-import`

```bash
python3 locwarp.py route-import routes.json
```

### `gpx-import`

```bash
python3 locwarp.py gpx-import my-route.gpx
```

### `gpx-export`

```bash
python3 locwarp.py gpx-export <route-id> output.gpx
```

---

## Runtime model

LocWarp still has two major layers:

1. **backend**
   - FastAPI
   - handles device connections, virtual location control, route simulation, pairing, and tunnel flows

2. **frontend**
   - Vite + React
   - controls the backend through a browser UI

`locwarp.py` is now the unified entrypoint for this fork.

---

## Platform focus

### Recommended now

- macOS: **full CLI / browser workflow**
- Windows: **can also use the same CLI / browser workflow**

### Not the main focus right now

- fully packaged native macOS app
- making every Electron packaging flow fully cross-platform

---

## How this fork differs from upstream

This fork mainly does the following:

- shifts the project to **CLI / browser-first**
- adds a **macOS-usable** startup path
- adds `locwarp.py` as the unified CLI entrypoint
- rewires `start.py` into the new CLI-based flow
- rewrites the README around the actual workflow
- exposes core backend abilities through CLI commands instead of relying only on the UI

---

## Known limitations

- bookmark/category update, move, import/export commands are not fully exposed yet
- device disconnect, wifi tunnel, and developer mode reveal commands can still be added
- Electron packaging is still Windows-oriented
- real-world control still depends on Apple / iOS / `pymobiledevice3` compatibility

---

## Project structure

```text
locwarp/
├── backend/
├── frontend/
├── locwarp.py
├── LocWarp.command
├── start.py
└── stop.py
```

---

## License

MIT

---

## Credits

- upstream: `keezxc1223/locwarp`
- this fork focuses on making the project more practical on macOS and in CLI/browser workflows
