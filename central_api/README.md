# Central API

Railway 部署設定：

- Root Directory: `/central_api`
- Start Command: `gunicorn -b 0.0.0.0:$PORT server:app`
- Healthcheck: `/health`
- SQLite 持久化：掛載 Railway Volume 到 `/data`
- DB_PATH: `/data/service_conflict.db`

真正的 ADMIN_PASSWORD、SMTP_PASSWORD、ECPAY_HASH_KEY、ECPAY_HASH_IV 不可提交到 GitHub。
