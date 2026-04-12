# LocWarp

**iOS 虛擬定位模擬器** — 在 Windows 上控制 iPhone 的 GPS 定位,支援直接跳點、導航、路線循環、多點停留、隨機漫步、搖桿操作等模擬模式,可經由 USB 或 WiFi 連線。

> ⚠ **目前僅測試過 iOS 26**,其餘版本請自行測試。

<p align="center">
  <img src="frontend/build/icon.png" width="128" alt="LocWarp">
</p>

---

## 功能

| 模式 | 說明 |
| --- | --- |
| **Teleport** | 瞬間跳到指定座標 |
| **Navigate** | 從目前位置沿 OSRM 路線步行/跑步/開車到目的地 |
| **Route Loop** | 無限循環指定路線 |
| **Multi-stop** | 依序經過多個停靠點,每點可停留 N 秒 |
| **Random Walk** | 在指定半徑內隨機漫遊,每段停頓時間可調 |
| **Joystick** | 以方向 + 力度即時操控 |

### 其他特色

- **速度自訂**:預設三檔(走路 5 / 跑步 10 / 開車 40 km/h),支援自訂固定速度與**隨機範圍**(如 40~80 km/h,每段路重抽)
- **WiFi Tunnel**:iOS 17+ 必需的 RSD tunnel,一鍵啟動(需管理員權限)
- **地圖書籤/類別**、**儲存路線**、**Cooldown 防偵測**、**座標格式切換**(DD / DMS / DM)

---

## 架構

```
┌─────────────────┐      IPC / HTTP + WS       ┌──────────────────┐
│ Electron + React│ ─────────────────────────► │ FastAPI backend  │
│  (port 5173 dev)│ ◄───────────────────────── │  (port 8777)     │
└─────────────────┘                            └────────┬─────────┘
                                                        │ pymobiledevice3
                                                        ▼
                                              ┌──────────────────┐
                                              │ iPhone (USB/WiFi)│
                                              └──────────────────┘
```

### Frontend

| 技術 | 版本 | 用途 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 30 | Desktop shell,負責視窗管理、spawn backend、注入 tile referer |
| [React](https://react.dev/) | 18.3 | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | 5.5 | Type-safe JS |
| [Vite](https://vitejs.dev/) | 5.4 | Dev server + 生產環境打包(`base: './'` 供 `file://` 載入) |
| [Leaflet](https://leafletjs.com/) | 1.9 | 互動地圖 |
| CSS | — | 手寫,單一 `styles.css` |

### Backend

| 技術 | 版本 | 用途 |
| --- | --- | --- |
| Python | 3.12 | 主 runtime |
| [FastAPI](https://fastapi.tiangolo.com/) | 0.110+ | REST API + WebSocket |
| [uvicorn](https://www.uvicorn.org/) | 0.29+ | ASGI server(`:8777`) |
| [websockets](https://websockets.readthedocs.io/) | 12+ | 即時位置/狀態推播給前端 |
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) | 9.9+ | iOS 裝置協議(DVT / RemoteServices / lockdown) |
| [pydantic](https://docs.pydantic.dev/) | 2+ | 資料驗證(schemas) |
| [httpx](https://www.python-httpx.org/) | 0.27+ | OSRM / Nominatim HTTP 呼叫 |
| [gpxpy](https://github.com/tkrajina/gpxpy) | 1.6+ | GPX 路線解析 |

### WiFi Tunnel(獨立 helper)

| 技術 | 版本 | 用途 |
| --- | --- | --- |
| Python | **3.13**(必需) | TLS-PSK 原生支援(3.12 不行) |
| pymobiledevice3 | 9.9+ | `start_tcp_tunnel()` 建立 RSD tunnel |
| pytun-pmd3 | — | Windows TUN 介面(wintun.dll) |

### 外部服務(皆免費、無需 API key)

| 服務 | 用途 |
| --- | --- |
| [OSRM](https://project-osrm.org/)(`router.project-osrm.org`) | 路線規劃(walking / driving profile) |
| [Nominatim](https://nominatim.openstreetmap.org/) | 地址 → 座標查詢 |
| [CartoDB Voyager](https://carto.com/) | 地圖底圖 tile(OSM 資料,免費散佈授權) |

### 打包工具

| 工具 | 用途 |
| --- | --- |
| [PyInstaller](https://pyinstaller.org/) | Python → 單檔 exe(backend 用 3.12,tunnel 用 3.13) |
| [electron-builder](https://www.electron.build/) | Electron 打包成 NSIS 安裝檔 |
| NSIS | Windows 安裝器 |

### 核心模組(backend/core/)

| 模組 | 職責 |
| --- | --- |
| `simulation_engine.py` | 中央控制器,管理狀態轉換、任務生命週期、`_move_along_route()` 核心移動迴圈、`EtaTracker` |
| `device_manager.py` | 裝置探索、USB / WiFi Tunnel 連線管理 |
| `navigator.py` | 單一目的地 OSRM 導航 |
| `route_loop.py` | 封閉路線無限循環 |
| `multi_stop.py` | 多點依序經過,可停留 |
| `random_walk.py` | 在半徑內隨機漫遊 |
| `joystick.py` | 即時方向/力度控制 |
| `teleport.py` / `restore.py` | 瞬移 / 恢復 |

### 關鍵設計

- **WebSocket 位置推播**:backend 每 tick(`update_interval` 由速度 profile 決定)發 `position_update` 事件,前端即時更新地圖游標 + ETA bar
- **速度解析**:`config.resolve_speed_profile(mode, speed_kmh, speed_min_kmh, speed_max_kmh)` 統一處理「模式預設 / 固定自訂 / 隨機範圍」三種輸入,優先序 `range > 固定 > 預設`
- **打包後路徑偵測**:backend 以 `sys.frozen` 判斷是否 PyInstaller bundle,從 `resources/backend/` 反推 `resources/wifi-tunnel/wifi-tunnel.exe`,避免硬編碼路徑
- **Runtime 狀態目錄**:一律寫入 `~/.locwarp/`(bookmarks / settings / tunnel info),避免 PyInstaller 的 `_MEIPASS` 臨時目錄問題
- **Tile referer / OSM 替換**:OSM 的 tile 服務封鎖散佈型應用,已改用 CartoDB(OSM 資料源、CARTO 代管 CDN、免 referer)

---

## 開發環境

### 先決條件

- Windows 10 / 11
- Python **3.12**(backend)
- Python **3.13**(WiFi tunnel,TLS-PSK 需求)
- Node.js 18+
- iPhone 已透過 iTunes / Apple Devices 配對過這台電腦
- iOS 16+ 需開啟「開發人員模式」

### 首次設置

```bash
# 1. 後端依賴
py -3.12 -m pip install -r backend/requirements.txt

# 2. WiFi tunnel 依賴(Python 3.13)
py -3.13 -m pip install pymobiledevice3

# 3. 前端依賴
cd frontend
npm install
```

### 啟動(開發模式)

雙擊 `LocWarp.bat` — 會自動提權並呼叫 `start.py`,同時啟動:
- backend(`:8777`)
- Vite dev server(`:5173`)
- Electron(載入 dev server)

或手動:

```bash
# 終端 1 — backend
cd backend && py -3.12 main.py

# 終端 2 — 前端 + Electron
cd frontend && npm run start
```

---

## 打包(產出安裝檔)

### 一次性安裝打包工具

```bash
py -3.12 -m pip install pyinstaller
py -3.13 -m pip install pyinstaller pymobiledevice3
cd frontend && npm install -D electron-builder
```

### 一鍵建置

```bash
build-installer.bat
```

依序執行:
1. **PyInstaller(3.12)** 編譯 backend → `dist-py/locwarp-backend/`
2. **PyInstaller(3.13)** 編譯 wifi-tunnel → `dist-py/wifi-tunnel/`
3. **Vite** 建置前端 → `frontend/dist/`
4. **electron-builder** 產出 NSIS 安裝檔 → `frontend/release/LocWarp Setup 0.1.0.exe`(~140 MB)

產物為單一 exe,使用者無需安裝 Python / Node / 任何套件。

---

## 使用者端需求

拿到安裝檔的使用者需要以下四項前置:

### 1. 安裝 iTunes for Windows

Windows 需要 Apple 的 USB driver 才能與 iPhone 溝通。

- **下載(必裝)**:[iTunes for Windows (64-bit)](https://secure-appldnld.apple.com/itunes12/047-76416-20260302-fefe4356-211d-4da1-8bc4-058eb36ea803/iTunes64Setup.exe)

> ⚠ 請勿使用 Microsoft Store 的「Apple Devices」— 該版本**不相容**,LocWarp 會抓不到裝置。必須裝上面連結的傳統版 iTunes。

### 2. USB 連接並信任此電腦

首次使用前,用 USB 線接上 iPhone,iPhone 會跳「要信任這部電腦嗎?」,點 **信任** 並輸入密碼。這會產生 pair record,後續 LocWarp 才能與裝置通訊。

### 3. 開啟開發人員模式(iOS 16+)

iPhone 上:**設定 → 隱私權與安全性 → 開發者模式 → 開啟**

開啟後裝置會要求重啟。重啟後會再次確認「啟用開發者模式?」,點啟用。

### 4. WiFi Tunnel(選用)

若要拔掉 USB 改走無線連線:
- iPhone 與電腦必須在**同一個 WiFi 網段**
- 第一次仍需要先用 USB 配對過(步驟 2)
- LocWarp 內按 **Start WiFi Tunnel** 會建立 RSD tunnel,之後 USB 可拔除

> ⚠ **拔除 USB 透過 WiFi 連線後,iPhone 不可鎖屏**(螢幕熄滅會導致網路介面休眠 → tunnel 中斷)。
> 建議到 **設定 → 顯示與亮度 → 自動鎖定 → 永不**,或保持 App 在前景 / 插著充電線避免螢幕熄滅。

---

安裝後桌面/開始選單出現 **LocWarp** 捷徑。開啟時會要求管理員權限(WiFi tunnel 建 TUN 介面必需)。

---

## 專案結構

```
locwarp/
├── backend/                 # FastAPI + pymobiledevice3
│   ├── api/                 # HTTP endpoints
│   ├── core/                # Simulation engine + handlers
│   │   ├── simulation_engine.py
│   │   ├── navigator.py
│   │   ├── route_loop.py
│   │   ├── multi_stop.py
│   │   ├── random_walk.py
│   │   ├── joystick.py
│   │   └── device_manager.py
│   ├── services/            # Location service, interpolator, bookmarks
│   ├── models/schemas.py    # Pydantic models
│   ├── config.py            # Speed profiles, cooldown table
│   ├── main.py              # Entrypoint
│   └── locwarp-backend.spec # PyInstaller spec
│
├── frontend/                # Electron + React
│   ├── electron/main.js     # Electron entry — spawns backend in packaged mode
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/      # MapView, ControlPanel, EtaBar, etc.
│   │   ├── hooks/           # useSimulation, useDevice, useBookmarks
│   │   └── services/api.ts
│   ├── build/icon.ico       # App icon
│   └── package.json         # electron-builder config
│
├── wifi_tunnel.py           # Python 3.13 standalone tunnel helper
├── wifi-tunnel.spec         # PyInstaller spec
├── start.py                 # Dev launcher (used by LocWarp.bat)
├── stop.py
├── LocWarp.bat              # Dev entry (auto-elevates)
└── build-installer.bat      # Build installer (one-shot)
```

---

## 疑難排解

| 症狀 | 可能原因 / 解法 |
| --- | --- |
| 安裝後開啟空白 | `file://` 路徑問題 — 已透過 `vite.config.ts` 的 `base: './'` 修正 |
| 地圖 403 / 418 | OSM 封鎖散佈型應用 — 已改用 CartoDB |
| `WinError 1231` tunnel 連不上 | TUN interface 路由尚未建立 — backend 內建 10 次指數退避重試 |
| `wintun.dll not found` 打包後 | PyInstaller spec 已加入 `collect_all('pytun_pmd3')` |
| Tunnel 啟動後 backend 連不上 | 確認以系統管理員身份啟動 |

---

## 技術備忘

- **Speed profile**:`config.resolve_speed_profile()` 統一解析 `(mode, speed_kmh, speed_min_kmh, speed_max_kmh)` → 有 range 時隨機抽,優先序 `range > 固定 > 模式預設`
- **ETA tracker**:`EtaTracker` 在 `_move_along_route` 內每 tick 更新 `traveled`,提供 `progress / eta_seconds / distance_remaining`
- **路徑解析**(打包後):backend 內偵測 `sys.frozen`,從 `resources/backend/locwarp-backend.exe` 反推 `resources/wifi-tunnel/wifi-tunnel.exe`
- **執行期資料夾**:`~/.locwarp/`(bookmarks.json / settings.json / wifi_tunnel_info.json)

---

## Roadmap

- [ ] 速度**時段內**變化(目前僅每段路重抽)
- [ ] 合併 backend + wifi_tunnel 到單一 Python 3.13 runtime(縮小安裝包)
- [ ] 開機自啟 + 常駐 tray
- [ ] 多裝置並行控制

---

## License

MIT License — 個人專案,歡迎自由使用、修改、散佈,但請保留原作者標註。無任何擔保。

> ⚠ 本工具僅供學習與個人研究用途。使用者需自行承擔因違反 Apple 服務條款、遊戲/App 使用規範而導致的帳號封鎖等後果。
