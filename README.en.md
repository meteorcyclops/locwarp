# LocWarp

A cross-platform iPhone virtual location tool. This fork is not primarily about repackaging the upstream Windows Electron app. Instead, it focuses on making LocWarp **usable on macOS, scriptable through a CLI, and still convenient through a browser UI**.

![LocWarp demo](docs/demo-v2.gif)

## What this fork is for

Compared with upstream, this fork is tuned more for practical day to day use and automation:

- **macOS-friendly** workflow
- a real **CLI entrypoint** for scripting and automation
- keeps the existing **browser UI** without forcing an Electron desktop shell
- routes `start.py`, `LocWarp.command`, and the CLI through one consistent startup path
- selectively pulls in upstream fixes when they make sense

If you want a version of LocWarp that is actually usable on a Mac and easier to automate, this fork is aimed at that workflow.

## Feature summary

- iPhone discovery and connection
- instant teleport
- point to point navigation
- route loop
- multi-stop route simulation
- random walk
- pause, resume, stop, and restore real location
- place search and geocoding
- bookmarks, categories, and recent places
- route save/import/export and GPX import/export
- browser UI plus CLI workflow

## Project layout

```text
locwarp/
├─ backend/         FastAPI + pymobiledevice3 backend
├─ frontend/        Vite / React browser UI
├─ locwarp.py       unified CLI entrypoint
├─ start.py         legacy launcher that forwards to the CLI
└─ LocWarp.command  quick macOS launcher
```

## Requirements

Recommended environment:

- macOS as the main target environment
- Python 3.10+
- Node.js 18+
- npm
- iPhone trusted by the computer
- some flows may require iPhone Developer Mode

The backend relies heavily on `pymobiledevice3`, so real world compatibility still depends on iOS version, Apple tooling, pairing state, and device conditions.

## Quick start

### 1. Clone the repo

```bash
git clone https://github.com/meteorcyclops/locwarp.git
cd locwarp
```

### 2. Start the full stack

```bash
python3 locwarp.py serve --open
```

This will:

- install backend Python dependencies
- install frontend npm dependencies if needed
- start the backend on `http://127.0.0.1:8777`
- start the frontend on `http://127.0.0.1:5173`
- open the browser automatically

### 3. Backend only

```bash
python3 locwarp.py serve --backend-only
```

### 4. Start through the legacy entrypoint

```bash
python3 start.py
```

### 5. macOS double click

```text
LocWarp.command
```

## Common CLI usage

Command format:

```bash
python3 locwarp.py <command>
```

### Devices

```bash
python3 locwarp.py device-list
python3 locwarp.py device-connect <udid>
python3 locwarp.py device-info <udid>
```

### Search and status

```bash
python3 locwarp.py search "Taipei 101"
python3 locwarp.py real-location
python3 locwarp.py status
```

### Teleport and movement

```bash
python3 locwarp.py teleport 25.033 121.5654
python3 locwarp.py navigate 25.033 121.5654 --mode walking
python3 locwarp.py loop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --mode walking
python3 locwarp.py multistop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --stop-duration 10
python3 locwarp.py randomwalk 25.033 121.5654 --radius-m 500
```

### Control the current simulation

```bash
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
```

### Bookmarks, recents, and routes

```bash
python3 locwarp.py recent-list
python3 locwarp.py bookmark-list
python3 locwarp.py category-list
python3 locwarp.py route-list
python3 locwarp.py route-export routes.json
python3 locwarp.py gpx-import my-route.gpx
```

For the full command list:

```bash
python3 locwarp.py --help
```

## Browser UI

After `serve --open`, use the browser UI directly:

- Frontend: `http://127.0.0.1:5173`
- Backend API docs: `http://127.0.0.1:8777/docs`

This fork keeps the graphical workflow, but it does not require a packaged desktop app to be the primary way of using LocWarp.

## How this differs from upstream

This repo does not try to mirror upstream releases exactly. The goals here are:

- keep useful upstream core logic
- make the macOS workflow practical
- expose a CLI-first interface
- selectively sync upstream fixes when needed

So versions, startup flow, packaging, and README details here may differ from upstream on purpose.

## Compatibility notes

- Apple, iOS, and `pymobiledevice3` compatibility still affects real world behavior
- WiFi pairing, USB connection state, DDI, and Developer Mode can all affect whether control works
- some upstream features may land first in Windows or Electron specific flows, then get adapted here later
- if you package this repo into a macOS app, treat that as an extra wrapper layer, not the same thing as an official upstream release

## Development notes

The frontend still contains upstream Electron build settings, but the main workflow in this fork is:

- run the backend directly with Python
- run the frontend directly with Vite
- use the browser for UI
- use `locwarp.py` as the unified automation entrypoint

## License

Same license as the original project. See [LICENSE](LICENSE).
