import os
import re
import json
import time
import secrets
import sqlite3
import smtplib
import hashlib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from urllib.parse import quote_plus

from flask import Flask, jsonify, request, redirect
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE_DIR, "service_conflict.db"))
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://127.0.0.1:5500").rstrip("/")
API_PUBLIC_URL = os.environ.get("API_PUBLIC_URL", "http://127.0.0.1:5001").rstrip("/")
TOKEN_HOURS = int(os.environ.get("TOKEN_HOURS", "168"))
VERIFY_MINUTES = int(os.environ.get("VERIFY_MINUTES", "60"))
TRIAL_LIMIT = int(os.environ.get("TRIAL_LIMIT", "3"))
PLAN_DAYS = int(os.environ.get("PLAN_DAYS", "30"))
PLAN_PRICE = int(os.environ.get("PLAN_PRICE", "0"))

MAIL_MODE = os.environ.get("MAIL_MODE", "console").lower()
SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM = os.environ.get("SMTP_FROM", SMTP_USER or "no-reply@example.com")
SMTP_STARTTLS = os.environ.get("SMTP_STARTTLS", "1") == "1"

ECPAY_MODE = os.environ.get("ECPAY_MODE", "stage").lower()
ECPAY_MERCHANT_ID = os.environ.get("ECPAY_MERCHANT_ID", "")
ECPAY_HASH_KEY = os.environ.get("ECPAY_HASH_KEY", "")
ECPAY_HASH_IV = os.environ.get("ECPAY_HASH_IV", "")

if ECPAY_MODE == "stage":
    ECPAY_ACTION = "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5"
else:
    ECPAY_ACTION = "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5"

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

def now_utc():
    return datetime.now(timezone.utc)

def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()

def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    return con

def init_db():
    con = db()
    con.executescript("""
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user',
      enabled INTEGER NOT NULL DEFAULT 1,
      trial_used INTEGER NOT NULL DEFAULT 0,
      subscription_until TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_verifications(
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS analysis_permits(
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS payments(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      merchant_trade_no TEXT NOT NULL UNIQUE,
      trade_no TEXT,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      payload TEXT,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    """)
    con.commit()

    admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "")
    if admin_email and admin_password:
        row = con.execute("SELECT id FROM users WHERE email=?", (admin_email,)).fetchone()
        if not row:
            con.execute(
                """INSERT INTO users(email,password_hash,email_verified,role,enabled,trial_used,created_at)
                   VALUES(?,?,?,?,?,?,?)""",
                (admin_email, generate_password_hash(admin_password), 1, "admin", 1, 0, iso(now_utc()))
            )
            con.commit()
    con.close()

def clean_email(value):
    return str(value or "").strip().lower()

def valid_email(email):
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email))

def user_status(row):
    until = row["subscription_until"]
    active = False
    if until:
        try:
            active = datetime.fromisoformat(until) > now_utc()
        except Exception:
            active = False

    trial_used = int(row["trial_used"] or 0)
    trial_remaining = max(0, TRIAL_LIMIT - trial_used)
    return {
        "subscription_active": active,
        "subscription_until": until,
        "trial_limit": TRIAL_LIMIT,
        "trial_used": trial_used,
        "trial_remaining": trial_remaining,
        "can_analyze": bool(active or trial_remaining > 0),
    }

def auth_user():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return None
    token = header[7:].strip()
    con = db()
    row = con.execute(
        """SELECT u.* FROM sessions s
           JOIN users u ON u.id=s.user_id
           WHERE s.token=? AND s.expires_at>? AND u.enabled=1""",
        (token, iso(now_utc()))
    ).fetchone()
    con.close()
    return row

def require_auth(fn):
    from functools import wraps
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = auth_user()
        if not user:
            return jsonify(error="登入已失效，請重新登入"), 401
        request.cloud_user = user
        return fn(*args, **kwargs)
    return wrapper

def require_admin(fn):
    from functools import wraps
    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = auth_user()
        if not user:
            return jsonify(error="登入已失效，請重新登入"), 401
        if user["role"] != "admin":
            return jsonify(error="需要管理者權限"), 403
        request.cloud_user = user
        return fn(*args, **kwargs)
    return wrapper

def send_verification(email, token):
    link = f"{API_PUBLIC_URL}/auth/verify?token={token}"
    if MAIL_MODE != "smtp":
        print(f"[EMAIL VERIFY] {email}: {link}", flush=True)
        return

    msg = EmailMessage()
    msg["Subject"] = "服務衝突檢查系統｜Email 驗證"
    msg["From"] = SMTP_FROM
    msg["To"] = email
    msg.set_content(
        "您好，\n\n請點擊以下連結完成 Email 驗證：\n"
        f"{link}\n\n此連結 {VERIFY_MINUTES} 分鐘內有效。\n"
    )

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as smtp:
        if SMTP_STARTTLS:
            smtp.starttls()
        if SMTP_USER:
            smtp.login(SMTP_USER, SMTP_PASSWORD)
        smtp.send_message(msg)

def create_verification(con, user_id, email):
    token = secrets.token_urlsafe(32)
    expires = now_utc() + timedelta(minutes=VERIFY_MINUTES)
    con.execute("UPDATE email_verifications SET used=1 WHERE user_id=? AND used=0", (user_id,))
    con.execute(
        "INSERT INTO email_verifications(token,user_id,expires_at,used,created_at) VALUES(?,?,?,?,?)",
        (token, user_id, iso(expires), 0, iso(now_utc()))
    )
    con.commit()
    send_verification(email, token)

def ecpay_urlencode(value):
    encoded = quote_plus(value, safe="-_.!*()")
    return encoded.lower()

def ecpay_check_mac(params):
    if not ECPAY_HASH_KEY or not ECPAY_HASH_IV:
        raise RuntimeError("尚未設定綠界 HashKey / HashIV")
    data = {str(k): str(v) for k, v in params.items() if k != "CheckMacValue"}
    raw = "&".join(f"{k}={data[k]}" for k in sorted(data.keys(), key=lambda x: x.lower()))
    raw = f"HashKey={ECPAY_HASH_KEY}&{raw}&HashIV={ECPAY_HASH_IV}"
    encoded = ecpay_urlencode(raw)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest().upper()

@app.get("/health")
def health():
    return jsonify(ok=True, service="service-conflict-central-api")

@app.get("/public/config")
def public_config():
    return jsonify(
        trial_limit=TRIAL_LIMIT,
        plan_days=PLAN_DAYS,
        plan_price=PLAN_PRICE,
        ecpay_mode=ECPAY_MODE,
    )

@app.post("/auth/register")
def register():
    data = request.get_json(silent=True) or {}
    email = clean_email(data.get("email"))
    password = str(data.get("password") or "")
    if not valid_email(email):
        return jsonify(error="Email 格式不正確"), 400
    if len(password) < 8:
        return jsonify(error="密碼至少需要 8 個字元"), 400

    con = db()
    existing = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if existing:
        if existing["email_verified"]:
            con.close()
            return jsonify(error="此 Email 已註冊，請直接登入"), 409
        create_verification(con, existing["id"], email)
        con.close()
        return jsonify(ok=True, message="帳號尚未驗證，已重新寄送驗證信。")

    cur = con.execute(
        """INSERT INTO users(email,password_hash,email_verified,role,enabled,trial_used,created_at)
           VALUES(?,?,?,?,?,?,?)""",
        (email, generate_password_hash(password), 0, "user", 1, 0, iso(now_utc()))
    )
    con.commit()
    user_id = cur.lastrowid
    create_verification(con, user_id, email)
    con.close()
    return jsonify(ok=True, message="註冊成功，驗證信已寄出。請先完成 Email 驗證。")

@app.post("/auth/resend-verification")
def resend_verification():
    data = request.get_json(silent=True) or {}
    email = clean_email(data.get("email"))
    con = db()
    row = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not row:
        con.close()
        return jsonify(ok=True, message="若帳號存在，系統已寄出驗證信。")
    if row["email_verified"]:
        con.close()
        return jsonify(ok=True, message="此 Email 已完成驗證，可以直接登入。")
    create_verification(con, row["id"], email)
    con.close()
    return jsonify(ok=True, message="驗證信已重新寄出。")

@app.get("/auth/verify")
def verify_email():
    token = str(request.args.get("token") or "")
    con = db()
    row = con.execute(
        """SELECT ev.*, u.email FROM email_verifications ev
           JOIN users u ON u.id=ev.user_id
           WHERE ev.token=? AND ev.used=0 AND ev.expires_at>?""",
        (token, iso(now_utc()))
    ).fetchone()
    if not row:
        con.close()
        return redirect(FRONTEND_URL + "/?verified=0")
    con.execute("UPDATE email_verifications SET used=1 WHERE token=?", (token,))
    con.execute("UPDATE users SET email_verified=1 WHERE id=?", (row["user_id"],))
    con.commit()
    con.close()
    return redirect(FRONTEND_URL + "/?verified=1")

@app.post("/auth/login")
def login():
    data = request.get_json(silent=True) or {}
    email = clean_email(data.get("email"))
    password = str(data.get("password") or "")
    con = db()
    row = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not row or not check_password_hash(row["password_hash"], password):
        con.close()
        return jsonify(error="Email 或密碼錯誤"), 401
    if not row["enabled"]:
        con.close()
        return jsonify(error="帳號已停用"), 403
    if not row["email_verified"]:
        con.close()
        return jsonify(error="請先完成 Email 驗證", code="EMAIL_NOT_VERIFIED"), 403

    token = secrets.token_urlsafe(40)
    expires = now_utc() + timedelta(hours=TOKEN_HOURS)
    con.execute(
        "INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)",
        (token, row["id"], iso(expires), iso(now_utc()))
    )
    con.commit()
    con.close()
    return jsonify(
        ok=True,
        token=token,
        user={"email":row["email"], "role":row["role"]}
    )

@app.post("/auth/logout")
@require_auth
def logout():
    token = request.headers.get("Authorization", "")[7:].strip()
    con = db()
    con.execute("DELETE FROM sessions WHERE token=?", (token,))
    con.commit()
    con.close()
    return jsonify(ok=True)

@app.get("/auth/me")
@require_auth
def me():
    row = request.cloud_user
    out = {"email":row["email"], "role":row["role"], "email_verified":bool(row["email_verified"])}
    out.update(user_status(row))
    return jsonify(out)

@app.get("/usage/status")
@require_auth
def usage_status():
    return jsonify(user_status(request.cloud_user))

@app.post("/usage/begin")
@require_auth
def usage_begin():
    user = request.cloud_user
    status = user_status(user)
    con = db()
    con.execute(
        "UPDATE analysis_permits SET status='expired' WHERE status='pending' AND expires_at<=?",
        (iso(now_utc()),)
    )
    con.commit()

    if status["subscription_active"]:
        kind = "paid"
    else:
        pending = con.execute(
            "SELECT COUNT(*) AS c FROM analysis_permits WHERE user_id=? AND kind='trial' AND status='pending' AND expires_at>?",
            (user["id"], iso(now_utc()))
        ).fetchone()["c"]
        if int(user["trial_used"]) + int(pending) >= TRIAL_LIMIT:
            con.close()
            return jsonify(error="免費試用已使用完畢，請先完成付款", code="PAYMENT_REQUIRED"), 402
        kind = "trial"

    token = secrets.token_urlsafe(32)
    con.execute(
        "INSERT INTO analysis_permits(token,user_id,kind,status,expires_at,created_at) VALUES(?,?,?,?,?,?)",
        (token, user["id"], kind, "pending", iso(now_utc()+timedelta(minutes=20)), iso(now_utc()))
    )
    con.commit()
    con.close()
    return jsonify(ok=True, permit_token=token, kind=kind)

@app.post("/usage/complete")
@require_auth
def usage_complete():
    data = request.get_json(silent=True) or {}
    token = str(data.get("permit_token") or "")
    success = bool(data.get("success"))
    user = request.cloud_user

    con = db()
    row = con.execute(
        "SELECT * FROM analysis_permits WHERE token=? AND user_id=?",
        (token, user["id"])
    ).fetchone()
    if not row:
        con.close()
        return jsonify(error="分析授權不存在"), 404
    if row["status"] != "pending":
        con.close()
        return jsonify(ok=True, already_completed=True)

    if success and row["kind"] == "trial":
        con.execute("UPDATE users SET trial_used=trial_used+1 WHERE id=?", (user["id"],))
    con.execute(
        "UPDATE analysis_permits SET status=?, completed_at=? WHERE token=?",
        ("completed" if success else "cancelled", iso(now_utc()), token)
    )
    con.commit()
    fresh = con.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    con.close()
    return jsonify(ok=True, usage=user_status(fresh))

@app.post("/billing/ecpay/create")
@require_auth
def create_payment():
    user = request.cloud_user
    if PLAN_PRICE <= 0:
        return jsonify(error="尚未設定正式方案金額 PLAN_PRICE"), 503
    if not ECPAY_MERCHANT_ID or not ECPAY_HASH_KEY or not ECPAY_HASH_IV:
        return jsonify(error="尚未設定綠界 MerchantID / HashKey / HashIV"), 503
    if not API_PUBLIC_URL.startswith("https://") and ECPAY_MODE != "stage":
        return jsonify(error="正式綠界付款的 API_PUBLIC_URL 必須使用 HTTPS"), 503

    trade_no = "SC" + datetime.now().strftime("%y%m%d%H%M%S") + secrets.token_hex(3).upper()
    trade_no = trade_no[:20]

    con = db()
    con.execute(
        "INSERT INTO payments(user_id,merchant_trade_no,amount,status,created_at) VALUES(?,?,?,?,?)",
        (user["id"], trade_no, PLAN_PRICE, "created", iso(now_utc()))
    )
    con.commit()
    con.close()

    params = {
        "MerchantID": ECPAY_MERCHANT_ID,
        "MerchantTradeNo": trade_no,
        "MerchantTradeDate": datetime.now().strftime("%Y/%m/%d %H:%M:%S"),
        "PaymentType": "aio",
        "TotalAmount": str(PLAN_PRICE),
        "TradeDesc": "ServiceConflict",
        "ItemName": f"服務衝突檢查系統 {PLAN_DAYS} 天使用方案",
        "ReturnURL": f"{API_PUBLIC_URL}/billing/ecpay/return",
        "ClientBackURL": FRONTEND_URL + "/?payment=returned",
        "ChoosePayment": "ALL",
        "EncryptType": "1",
        "CustomField1": str(user["id"]),
    }
    params["CheckMacValue"] = ecpay_check_mac(params)
    return jsonify(action=ECPAY_ACTION, params=params)

@app.post("/billing/ecpay/return")
def ecpay_return():
    params = {k:v for k,v in request.form.items()}
    received = params.get("CheckMacValue", "")
    try:
        expected = ecpay_check_mac(params)
    except Exception:
        return "0|ERROR", 400

    if not secrets.compare_digest(received.upper(), expected.upper()):
        return "0|ERROR", 400

    trade_no = params.get("MerchantTradeNo", "")
    rtn_code = str(params.get("RtnCode", ""))
    con = db()
    payment = con.execute("SELECT * FROM payments WHERE merchant_trade_no=?", (trade_no,)).fetchone()
    if not payment:
        con.close()
        return "1|OK"

    con.execute(
        "UPDATE payments SET payload=?, trade_no=? WHERE merchant_trade_no=?",
        (json.dumps(params, ensure_ascii=False), params.get("TradeNo", ""), trade_no)
    )

    if rtn_code == "1" and payment["status"] != "paid":
        user = con.execute("SELECT * FROM users WHERE id=?", (payment["user_id"],)).fetchone()
        base = now_utc()
        if user["subscription_until"]:
            try:
                current_until = datetime.fromisoformat(user["subscription_until"])
                if current_until > base:
                    base = current_until
            except Exception:
                pass
        new_until = base + timedelta(days=PLAN_DAYS)
        con.execute(
            "UPDATE payments SET status='paid', paid_at=? WHERE merchant_trade_no=?",
            (iso(now_utc()), trade_no)
        )
        con.execute(
            "UPDATE users SET subscription_until=? WHERE id=?",
            (iso(new_until), payment["user_id"])
        )
    con.commit()
    con.close()
    return "1|OK"

@app.get("/admin/users")
@require_admin
def admin_users():
    con = db()
    rows = con.execute("SELECT * FROM users ORDER BY id DESC").fetchall()
    result = []
    for r in rows:
        x = {
            "id":r["id"], "email":r["email"], "role":r["role"],
            "enabled":bool(r["enabled"]), "email_verified":bool(r["email_verified"]),
            "created_at":r["created_at"],
        }
        x.update(user_status(r))
        result.append(x)
    con.close()
    return jsonify(users=result)

@app.patch("/admin/users/<int:user_id>")
@require_admin
def admin_update_user(user_id):
    data = request.get_json(silent=True) or {}
    con = db()
    row = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    if not row:
        con.close()
        return jsonify(error="找不到帳號"), 404

    fields = []
    values = []
    if "enabled" in data:
        fields.append("enabled=?"); values.append(1 if data["enabled"] else 0)
    if "role" in data and data["role"] in ("user","admin"):
        fields.append("role=?"); values.append(data["role"])
    if "trial_used" in data:
        n = max(0, min(TRIAL_LIMIT, int(data["trial_used"])))
        fields.append("trial_used=?"); values.append(n)
    if "subscription_days" in data:
        days = int(data["subscription_days"])
        base = now_utc()
        if row["subscription_until"]:
            try:
                cur = datetime.fromisoformat(row["subscription_until"])
                if cur > base:
                    base = cur
            except Exception:
                pass
        fields.append("subscription_until=?")
        values.append(iso(base + timedelta(days=days)))

    if fields:
        values.append(user_id)
        con.execute("UPDATE users SET " + ",".join(fields) + " WHERE id=?", values)
        con.commit()
    con.close()
    return jsonify(ok=True)

if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5001")), debug=False)
