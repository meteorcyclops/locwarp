# LocWarp

**A cross-platform iPhone virtual location tool, now focused on CLI + browser UI workflows.**

This fork is no longer centered on the original "Windows packaged Electron app" workflow. Instead, it reshapes LocWarp into a setup that is easier to run and maintain:

- runs on **macOS**
- can be used directly via **CLI**
- can still use the existing frontend through a **browser UI** connected to the backend

Right now, the most practical and clearly supported workflow in this fork is:
- **CLI / browser mode**
- **macOS development usage**
- **Windows can also use the same CLI / browser flow**

> Note: this fork is not yet a fully packaged native macOS app. It is a more practical cross-platform launcher and workflow for the existing project.

---

## Quick start

### macOS

```bash
cd locwarp
python3 locwarp.py serve --open
```

Or:

```bash
python3 start.py
```

Or double-click:

```text
LocWarp.command
```

### Backend only

```bash
python3 locwarp.py serve --backend-only
```

### Common CLI commands

```bash
python3 locwarp.py device-list
python3 locwarp.py device-connect <udid>
python3 locwarp.py status
python3 locwarp.py search "Taipei 101"
python3 locwarp.py teleport 25.033 121.5654
python3 locwarp.py navigate 25.033 121.5654 --mode walking
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
```

---

## CLI commands

### Start services

```bash
python3 locwarp.py serve --open
python3 locwarp.py serve --backend-only
```

### Open frontend

```bash
python3 locwarp.py open
```

### Device operations

```bash
python3 locwarp.py device-list
python3 locwarp.py device-connect <udid>
python3 locwarp.py device-info <udid>
python3 locwarp.py status
python3 locwarp.py status --udid <device-udid>
python3 locwarp.py teleport <lat> <lng>
python3 locwarp.py teleport <lat> <lng> --udid <device-udid>
python3 locwarp.py navigate <lat> <lng> --mode walking
python3 locwarp.py navigate <lat> <lng> --mode driving --speed-kmh 40
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
python3 locwarp.py restore --udid <device-udid>
```

### Search places

```bash
python3 locwarp.py search "Taipei 101"
python3 locwarp.py real-location
```

---

## Runtime model

LocWarp currently has two layers:

1. **backend**
   - FastAPI
   - handles device connections, virtual location control, route simulation, pairing, and tunnel flows

2. **frontend**
   - Vite + React
   - controls the backend through a browser UI

The new `locwarp.py` helps with:
- starting the backend
- starting the frontend dev server
- opening the browser
- calling common APIs through a simple CLI

---

## Platform status

### Recommended now

- macOS: **supported in CLI / browser mode**
- Windows: **supported in CLI / browser mode**, while upstream Electron-related files are still kept in the repo

### Not guaranteed yet

- fully packaged native macOS Electron app
- complete stability across every iOS version and every Apple pairing / tunnel workflow

Actual device control still depends on:
- `pymobiledevice3`
- iOS / iPadOS version
- Apple trust / pairing state
- tunnel / developer mode / USB connection health

---

## Features

### Movement modes

- Teleport
- Navigate
- Route Loop
- Multi-stop
- Random Walk
- Joystick

### Other capabilities

- USB connection
- WiFi / tunnel-related flows
- Dual-device group mode
- bookmarks, recents, route planning
- browser-based UI control

---

## Requirements

### Required tools

- Python 3
- Node.js / npm

### Python dependencies

Main dependencies come from `backend/requirements.txt`, including:

- `pymobiledevice3`
- `fastapi`
- `uvicorn`
- `httpx`
- `gpxpy`

### Frontend dependencies

Managed through `frontend/package.json`.

---

## Development

### backend

```bash
cd backend
python3 main.py
```

### frontend

```bash
cd frontend
npm install
npm run dev
```

### full startup

```bash
python3 locwarp.py serve --open
```

---

## How this fork differs from upstream

This fork mainly changes the project in these ways:

- shifts the startup model to **CLI / browser-first**
- adds a **macOS-usable** startup path
- adds `locwarp.py` as a unified entrypoint
- adds `LocWarp.command` for quick launching on macOS
- rewires `start.py` to forward into the new CLI-based startup flow
- rewrites the README around practical cross-platform usage instead of Windows-only packaged app expectations

---

## Known limitations

- the CLI now includes `device-connect`, `device-info`, `status`, `search`, `navigate`, `pause`, `resume`, and `stop`
- there is still room to add loop, multistop, randomwalk, bookmark management, and other advanced commands
- Electron packaging is still Windows-oriented
- some flows may still contain Windows-specific assumptions
- `pymobiledevice3` compatibility may shift as Apple / iOS versions change

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
