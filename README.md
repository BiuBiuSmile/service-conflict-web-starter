# 中央會員 / 綠界付款 API

這個資料夾是 v0.6.0 新增的中央後端。

## 已完成
- Email 註冊
- Email 驗證
- Email + 密碼登入
- 新帳號免費試用 3 次
- 只有「分析成功」才扣 1 次
- 試用用完後封鎖分析
- 綠界 AioCheckOut 付款單建立
- 綠界 ReturnURL CheckMacValue 驗證
- 付款成功後自動延長會員方案
- 管理者查詢會員 / 調整帳號狀態

## 本機測試

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
set MAIL_MODE=console
set PLAN_PRICE=100
python server.py
```

預設 API: `http://127.0.0.1:5001`

`MAIL_MODE=console` 時，註冊後的 Email 驗證連結會印在伺服器視窗。

## 正式上線必做

1. 部署此資料夾到可公開 HTTPS 的伺服器。
2. 將網站 `config.js` 的 `apiBase` 改成中央 API HTTPS 網址。
3. 設定 SMTP 信箱寄信參數。
4. 設定正式綠界 MerchantID / HashKey / HashIV。
5. 設定實際 `PLAN_PRICE`。
6. `API_PUBLIC_URL` 必須可讓綠界從網際網路連入，ReturnURL 不可用 localhost。

請勿把正式 HashKey / HashIV 寫入前端 JavaScript。
