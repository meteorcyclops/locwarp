# LocWarp

跨平台 iPhone 虛擬定位工具。這個 fork 的重點不是把上游的 Windows Electron 包原樣搬過來，而是把它整理成 **macOS 可用、CLI 可腳本化、browser UI 可直接操作** 的版本。

![LocWarp demo](docs/demo-v2.gif)

## 這個 fork 在做什麼

相較於上游，這個版本更偏向日常實用與自動化：

- 支援 **macOS** 作為主要使用環境
- 提供 **CLI 入口**，方便腳本、自動化與遠端操作
- 保留原本的 **browser UI**，不強綁 Electron 視窗
- 讓 `start.py`、`LocWarp.command`、CLI 都回到同一條啟動路徑
- 可以視需要選擇性跟進 upstream 的核心修正

如果你想要的是「能在 Mac 上實際用、也能拿來串腳本」的 LocWarp，這個 fork 比較接近這個方向。

## 功能摘要

- iPhone 裝置偵測與連線
- 即時座標瞬移
- 導航移動
- 路線巡迴
- 多點停留
- 隨機漫步
- 暫停、恢復、停止、還原真實位置
- 地址搜尋 / 地理編碼
- 收藏點、分類、最近地點
- 路線儲存、匯入匯出、GPX 匯入匯出
- Browser UI + CLI 雙入口

## 專案結構

```text
locwarp/
├─ backend/      FastAPI + pymobiledevice3 後端
├─ frontend/     Vite / React browser UI
├─ locwarp.py    統一 CLI 入口
├─ start.py      舊入口，實際轉呼叫 CLI
└─ LocWarp.command  macOS 快速啟動腳本
```

## 系統需求

建議環境：

- macOS 為主，也可自行調整到其他平台
- Python 3.10+
- Node.js 18+
- npm
- iPhone 已信任電腦
- 某些情境需要 iPhone 已開啟 Developer Mode

後端核心依賴是 `pymobiledevice3`，實際可用性仍會受 iOS 版本、Apple 驅動與配對狀態影響。

## 快速開始

### 1. 下載 repo

```bash
git clone https://github.com/meteorcyclops/locwarp.git
cd locwarp
```

### 2. 啟動完整服務

```bash
python3 locwarp.py serve --open
```

這會做幾件事：

- 安裝 backend 需要的 Python 套件
- 必要時安裝 frontend 的 npm 依賴
- 啟動 backend，預設 `http://127.0.0.1:8777`
- 啟動 frontend，預設 `http://127.0.0.1:5173`
- 自動打開瀏覽器

### 3. 只啟 backend

```bash
python3 locwarp.py serve --backend-only
```

### 4. 用舊入口啟動

```bash
python3 start.py
```

### 5. macOS 直接雙擊

```text
LocWarp.command
```

## 常用 CLI

實際執行格式：

```bash
python3 locwarp.py <command>
```

### 裝置

```bash
python3 locwarp.py device-list
python3 locwarp.py device-connect <udid>
python3 locwarp.py device-info <udid>
```

### 查地點與目前狀態

```bash
python3 locwarp.py search "Taipei 101"
python3 locwarp.py real-location
python3 locwarp.py status
```

### 瞬移與移動

```bash
python3 locwarp.py teleport 25.033 121.5654
python3 locwarp.py navigate 25.033 121.5654 --mode walking
python3 locwarp.py loop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --mode walking
python3 locwarp.py multistop 25.033,121.5654 25.034,121.5660 25.032,121.5670 --stop-duration 10
python3 locwarp.py randomwalk 25.033 121.5654 --radius-m 500
```

### 控制目前模擬

```bash
python3 locwarp.py pause
python3 locwarp.py resume
python3 locwarp.py stop
python3 locwarp.py restore
```

### 收藏 / 最近地點 / 路線

```bash
python3 locwarp.py recent-list
python3 locwarp.py bookmark-list
python3 locwarp.py category-list
python3 locwarp.py route-list
python3 locwarp.py route-export routes.json
python3 locwarp.py gpx-import my-route.gpx
```

完整指令請直接看：

```bash
python3 locwarp.py --help
```

## Browser UI

`serve --open` 啟動後，可直接用瀏覽器操作前端。

- Frontend: `http://127.0.0.1:5173`
- Backend API docs: `http://127.0.0.1:8777/docs`

這個 fork 的 UI 定位是「保留好用的圖形操作」，但不強迫你一定要用封裝好的桌面 app。

## 與上游的差異

這個 repo 不追求完全照搬 upstream release，而是偏向：

- 保留 upstream 可用的核心邏輯
- 補上 macOS 實際使用流程
- 提供 CLI-first 的操作方式
- 視需要挑選 upstream 修正來同步

所以這裡看到的版本、啟動方式、README 與上游 release 可能不完全一致，這是刻意的。

## 相容性與注意事項

- Apple / iOS / `pymobiledevice3` 相容性仍然會影響實際效果
- WiFi 配對、USB 連線、DDI / Developer Mode 狀態都可能影響能不能成功控制
- 某些 upstream 新功能可能先做在 Windows/Electron 流程，這個 fork 會視情況再整合
- 若你是拿這個 repo 自行包成 macOS app，請把它視為另一層包裝，不等同 upstream 官方 release

## 開發備註

前端目前仍保留上游的 Electron 打包設定，但這個 fork 的主要使用方式是：

- backend 直接跑 Python
- frontend 直接跑 Vite
- 透過瀏覽器操作 UI
- 透過 `locwarp.py` 統一腳本入口

## 授權

沿用原專案授權，詳見 [LICENSE](LICENSE)。
