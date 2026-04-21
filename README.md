# LocWarp

**跨平台 iPhone 虛擬定位工具（目前以 CLI + browser UI 為主）**。

這個 fork 的目標不是延續「只在 Windows 打包 Electron app」的使用方式，而是把 LocWarp 整理成：

- 可在 **macOS** 啟動
- 可直接用 **CLI** 操作
- 需要 UI 時，用 **browser 前端** 連 backend

目前最穩定、最明確支援的使用方式是：
- **CLI / browser 模式**
- **macOS 開發使用**
- **Windows 也可沿用相同 CLI / browser 流程**

> 注意：這個 fork 目前不是「完整原生 mac app」，而是把原專案改造成更實用的跨平台啟動方式。

---

## 快速開始

### macOS

```bash
cd locwarp
python3 locwarp.py serve --open
```

或：

```bash
python3 start.py
```

或直接雙擊：

```text
LocWarp.command
```

### 只啟 backend

```bash
python3 locwarp.py serve --backend-only
```

### 常用 CLI

```bash
python3 locwarp.py device-list
python3 locwarp.py device-connect <udid>
python3 locwarp.py status
python3 locwarp.py search 台北101
python3 locwarp.py teleport 25.033 121.5654
python3 locwarp.py navigate 25.033 121.5654 --mode walking
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
```

---

## CLI 指令

### 啟動服務

```bash
python3 locwarp.py serve --open
python3 locwarp.py serve --backend-only
```

### 開啟前端

```bash
python3 locwarp.py open
```

### 裝置操作

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

### 查地點

```bash
python3 locwarp.py search 台北101
python3 locwarp.py real-location
```

---

## 執行模式

LocWarp 目前有兩層：

1. **backend**
   - FastAPI
   - 負責裝置連線、定位模擬、路線控制、配對與 tunnel 流程

2. **frontend**
   - Vite + React
   - 透過瀏覽器操作 backend

新的 `locwarp.py` 會幫你處理：
- backend 啟動
- frontend dev server 啟動
- 開瀏覽器
- 用簡單 CLI 打常用 API

---

## 適用平台

### 目前建議

- macOS: **支援 CLI / browser 模式**
- Windows: **支援 CLI / browser 模式**，也仍保留上游 Electron 相關檔案

### 目前不保證

- 完整原生 macOS Electron app 打包
- 所有 iOS 版本與 Apple 配對 / tunnel 流程都完全穩定

實際能否成功控制裝置，仍取決於：
- `pymobiledevice3`
- iOS / iPadOS 版本
- Apple trust / pairing 狀態
- tunnel / developer mode / usb 連線狀況

---

## 功能

### 移動模式

- Teleport，直接跳點
- Navigate，沿路線移動
- Route Loop，循環路線
- Multi-stop，多點停留
- Random Walk，隨機漫步
- Joystick，搖桿控制

### 其他能力

- USB 連線
- WiFi / tunnel 相關流程
- Dual-device group mode
- 書籤、最近位置、路線規劃
- browser UI 控制

---

## 安裝需求

### 必要工具

- Python 3
- Node.js / npm

### Python 相依

主要由 `backend/requirements.txt` 安裝，例如：

- `pymobiledevice3`
- `fastapi`
- `uvicorn`
- `httpx`
- `gpxpy`

### 前端相依

由 `frontend/package.json` 管理。

---

## 開發

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

### 整體啟動

```bash
python3 locwarp.py serve --open
```

---

## 與上游的差異

這個 fork 和原始專案的主要差異是：

- 將啟動方式調整為 **CLI / browser-first**
- 新增 **macOS 可用** 的啟動流程
- 新增 `locwarp.py` 作為統一入口
- 新增 `LocWarp.command` 方便 mac 直接啟動
- 將 `start.py` 改為直接導向新 CLI 啟動流程
- README 改成以跨平台實際使用方式為主，而不是只聚焦 Windows 打包 app

---

## 已知限制

- CLI 已補上 `device-connect`、`device-info`、`status`、`search`、`navigate`、`pause`、`resume`、`stop`
- 仍可再繼續補 loop、multistop、randomwalk、bookmark 管理等進階指令
- Electron 打包流程仍偏向 Windows
- 某些流程可能仍有 Windows-only 分支或假設
- 若 Apple / iOS 版本更新，`pymobiledevice3` 相容性可能受影響

---

## 專案結構

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
