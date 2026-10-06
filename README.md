# 服務衝突檢查系統 v0.3

## 一般使用者

1. 開啟 GitHub Pages。
2. 若顯示「Connector 未連線」，按「下載 Windows 連線器」。
3. 開啟 `ServiceConflictConnector.exe`。
4. 連線器會自動：
   - 啟動本機 API `127.0.0.1:8765`
   - 加入目前 Windows 使用者的開機自動啟動
   - 常駐系統列
   - 開啟服務衝突網站
5. 之後不需要 CMD，也不需要安裝 Python。

## 開發者

### 本機 Python 測試

```powershell
pip install -r connector/requirements.txt
python connector/connector.py
```

### GitHub 自動打包 Windows EXE

專案包含：

```text
.github/workflows/build-connector.yml
ServiceConflictConnector.spec
```

Push 到 `main` 後，GitHub Actions 會使用 `windows-latest` 建置：

```text
dist/ServiceConflictConnector.exe
```

同時建立／更新 GitHub Release，前端下載網址固定為：

```text
https://github.com/biubiusmile/service-conflict-web/releases/latest/download/ServiceConflictConnector.exe
```

## v0.3 已完成

- 網頁自動偵測 Connector。
- 未安裝時顯示下載按鈕。
- 每 3 秒重新偵測，安裝後不需要手動刷新。
- Connector 可打包為無 CMD 視窗的 Windows EXE。
- 第一次執行後自動加入 Windows 使用者開機啟動。
- 系統列常駐。
- 支援 Chrome Private Network Access header。
- 限制 CORS 到指定網站來源。
- 帳密 / Cookie / Token 不傳到 GitHub Pages。

## 尚未完成

目前 `/services` 仍使用示範資料。

下一階段要接：
- 仁寶既有 CDP + API
- 照管既有 Session + QD120A
- 真實跨單位服務衝突規則
