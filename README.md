# 服務衝突檢查系統 — GitHub Pages + Local Connector

## 架構

```text
GitHub Pages / chkia.dev
        │
        │ HTTP localhost
        ▼
127.0.0.1:8765
Local Connector
   │          │
   ▼          ▼
 仁寶        照管
```

## 安全原則

- GitHub Pages 不保存仁寶/照管帳號密碼。
- Session、Cookie、Token 應只存在使用者自己的電腦。
- Connector 只回傳衝突分析必要欄位。
- 正式版應限制 CORS，只允許你的正式網站網域。
- 不建議把 Session、Cookie、Token 直接回傳前端。

## 執行 Connector

```bash
cd connector
pip install -r requirements.txt
python connector.py
```

看到：

```text
Listening on http://127.0.0.1:8765
```

代表本機服務正常。

## 開啟前端

可直接打開 `web/index.html` 測試。

部署 GitHub Pages 時，將 `web` 內容放到 Repository 的 Pages 來源目錄。

## 下一階段

目前 `/status/compal`、`/status/lcms` 與 `/services` 使用模擬資料。

下一版需把既有的：

- Chrome CDP 連線
- 仁寶 Session/API 偵測
- 照管登入資料偵測
- 班表/服務資料抓取

接到 `connector.py` 中。

建議不要重新做「輸入帳密」功能，而是讓使用者在官方網站自己登入，再由 Connector 判斷登入狀態。


## v0.2

- 網頁新增「登入仁寶」「登入照管」。
- Connector 會使用獨立 Chrome Profile 開啟官方網站。
- 不在 GitHub Pages 輸入或保存官方帳密。
- `/status/compal` 與 `/status/lcms` 可檢查專用 Chrome 是否已進入登入後頁面。
- 下一版接回舊程式已驗證過的真實 Session/API 擷取。
