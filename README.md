# LocWarp

**跨平台 iPhone 虛擬定位工具，這個 fork 目前以完整 CLI + browser UI 為主。**

這個 fork 的方向很明確：

- **macOS 可跑**
- **CLI 可直接操作主要功能**
- 需要圖形介面時，使用 **browser UI** 連 backend
- 不再把「Windows 打包 Electron app」當成唯一主軸

如果你想把 LocWarp 當成一套真正可腳本化、可自動化、可在 mac 上實際使用的工具，這個 fork 就是往那個方向整理的版本。

---

## 快速開始

### 啟動完整服務

```bash
cd locwarp
python3 locwarp.py serve --open
```

### 用舊入口啟動

```bash
python3 start.py
```

### mac 直接雙擊

```text
LocWarp.command
```

### 只啟 backend

```bash
python3 locwarp.py serve --backend-only
```

---

## CLI 總覽

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

實際執行時請用：

```bash
python3 locwarp.py <command>
```

---

## 常用流程

### 1. 啟動服務

```bash
python3 locwarp.py serve --open
```

### 2. 列出裝置

```bash
python3 locwarp.py device-list
```

### 3. 連接裝置

```bash
python3 locwarp.py device-connect <udid>
```

### 4. 查地點

```bash
python3 locwarp.py search 台北101
```

### 5. 直接跳點

```bash
python3 locwarp.py teleport 25.033 121.5654
```

### 6. 開始導航

```bash
python3 locwarp.py navigate 25.033 121.5654 --mode walking
```

### 7. 查看狀態

```bash
python3 locwarp.py status
```

### 8. 暫停 / 恢復 / 停止 / 還原

```bash
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
```

---

## 指令說明

## 啟動與前端

### `serve`
啟動 backend，必要時也啟 frontend。

```bash
python3 locwarp.py serve --open
python3 locwarp.py serve --backend-only
```

### `open`
直接打開前端頁面。

```bash
python3 locwarp.py open
```

---

## 裝置

### `device-list`
列出已發現裝置。

```bash
python3 locwarp.py device-list
```

### `device-connect`
依 UDID 連接裝置。

```bash
python3 locwarp.py device-connect <udid>
```

### `device-info`
查單一裝置資訊。

```bash
python3 locwarp.py device-info <udid>
```

---

## 定位與移動

### `status`
查看目前模擬狀態。

```bash
python3 locwarp.py status
python3 locwarp.py status --udid <udid>
```

### `teleport`
直接跳到指定座標。

```bash
python3 locwarp.py teleport 25.033 121.5654
python3 locwarp.py teleport 25.033 121.5654 --udid <udid>
```

### `navigate`
導航到指定座標。

```bash
python3 locwarp.py navigate 25.033 121.5654 --mode walking
python3 locwarp.py navigate 25.033 121.5654 --mode driving --speed-kmh 40
```

### `loop`
循環路線。

```bash
python3 locwarp.py loop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --mode walking
python3 locwarp.py loop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --lap-count 5
```

### `multistop`
多點停留。

```bash
python3 locwarp.py multistop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --stop-duration 10
```

### `randomwalk`
以某個中心點為圓心隨機漫步。

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

## 地理查詢

### `search`
搜尋地點。

```bash
python3 locwarp.py search 台北101
python3 locwarp.py search "Shibuya Station"
```

### `real-location`
查詢目前 public IP 對應的大致真實位置。

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
規劃兩點間路線。

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

## 執行模式

LocWarp 目前有兩層：

1. **backend**
   - FastAPI
   - 負責裝置連線、定位模擬、路線控制、配對與 tunnel 流程

2. **frontend**
   - Vite + React
   - 透過瀏覽器操作 backend

`locwarp.py` 現在是這個 fork 的統一入口。

---

## 平台定位

### 目前最推薦

- macOS: **完整 CLI / browser workflow**
- Windows: **也可沿用 CLI / browser workflow**

### 目前不是重點

- 原生打包 macOS app
- 保證所有 Electron 打包流程都跨平台乾淨可用

---

## 與上游差異

這個 fork 主要做了這些事：

- 改成 **CLI / browser-first**
- 補上 **macOS 可跑** 的入口
- 新增 `locwarp.py` 當統一 CLI 入口
- `start.py` 改為導向新的 CLI 流程
- README 依照實際使用方式重寫
- 把原本分散在 API / frontend 的核心能力整理成 CLI 可直接用的命令

---

## 已知限制

- bookmark/category 還沒補 update / move / import/export 指令
- device disconnect、wifi tunnel、developer mode reveal 這些還能再補 CLI
- Electron 打包流程仍偏向 Windows
- Apple / iOS / pymobiledevice3 相容性仍會影響實際控制效果

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
