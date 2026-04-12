---

## 使用者端需求

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

**Full Changelog**: https://github.com/keezxc1223/locwarp/releases
