from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import date
from pathlib import Path
import json
import os
import shutil
import subprocess
import time
import requests

app = Flask(__name__)
CORS(app)

VERSION = "0.2.0"

SYSTEMS = {
    "compal": {
        "name": "仁寶",
        "url": "https://luna.compal-health.com/login",
        "host": "luna.compal-health.com",
        "port": 9360,
    },
    "lcms": {
        "name": "照管",
        "url": "https://csms.mohw.gov.tw/lcms/",
        "host": "csms.mohw.gov.tw",
        "port": 9460,
    },
}

def app_dir():
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    p = base / "ServiceConflictConnector"
    p.mkdir(parents=True, exist_ok=True)
    return p

def profile_dir(system):
    p = app_dir() / "ChromeProfiles" / system
    p.mkdir(parents=True, exist_ok=True)
    return p

def find_chrome():
    candidates = [
        Path(os.environ.get("PROGRAMFILES", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
    ]
    for c in candidates:
        if c.is_file():
            return c
    found = shutil.which("chrome") or shutil.which("chrome.exe")
    return Path(found) if found else None

def cdp_json(system, path="/json/list"):
    cfg = SYSTEMS[system]
    r = requests.get(f"http://127.0.0.1:{cfg['port']}{path}", timeout=2)
    r.raise_for_status()
    return r.json()

def cdp_available(system):
    try:
        v = cdp_json(system, "/json/version")
        return bool(v.get("webSocketDebuggerUrl"))
    except Exception:
        return False

def launch_login(system):
    cfg = SYSTEMS[system]
    chrome = find_chrome()
    if chrome is None:
        raise RuntimeError("找不到 Google Chrome。")

    if cdp_available(system):
        # 已有專用 Chrome 開著，不再啟動第二份。
        return False

    cmd = [
        str(chrome),
        f"--remote-debugging-port={cfg['port']}",
        f"--user-data-dir={profile_dir(system)}",
        "--profile-directory=Default",
        "--disable-notifications",
        "--remote-allow-origins=*",
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        cfg["url"],
    ]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return True

def browser_status(system):
    cfg = SYSTEMS[system]
    if not cdp_available(system):
        return {
            "running": False,
            "logged_in": False,
            "message": "專用 Chrome 尚未啟動。",
            "url": "",
        }
    try:
        targets = cdp_json(system, "/json/list")
    except Exception as e:
        return {
            "running": True,
            "logged_in": False,
            "message": f"Chrome 已開啟，但暫時無法讀取分頁：{e}",
            "url": "",
        }

    pages = [x for x in targets if isinstance(x, dict) and x.get("type") == "page"]
    related = [x for x in pages if cfg["host"] in str(x.get("url") or "")]
    if not related:
        return {
            "running": True,
            "logged_in": False,
            "message": f"{cfg['name']} Chrome 已開啟，尚未找到官方頁面。",
            "url": "",
        }

    # 仁寶：離開 /login /signin 後先視為可能登入完成。
    # 照管：第一版以進入 /lcms/ 內頁作初步判定；下一版再接實際 Session/API 驗證。
    url = str(related[0].get("url") or "")
    lower = url.lower()

    if system == "compal":
        logged = (
            cfg["host"] in lower
            and "/login" not in lower
            and "/signin" not in lower
            and lower.rstrip("/") != "https://luna.compal-health.com"
        )
    else:
        obvious_login_tokens = ("/login", "signin", "cloudflare", "challenge")
        logged = cfg["host"] in lower and "/lcms/" in lower and not any(t in lower for t in obvious_login_tokens)

    return {
        "running": True,
        "logged_in": logged,
        "message": "已偵測到登入後頁面。" if logged else "等待使用者在官方頁面完成登入。",
        "url": url,
    }

@app.get("/health")
def health():
    return jsonify(ok=True, version=VERSION)

@app.post("/connect/<system>")
def connect(system):
    if system not in SYSTEMS:
        return jsonify(error="unknown system"), 404
    started = launch_login(system)
    return jsonify(
        ok=True,
        started=started,
        message=("已開啟官方登入頁，請完成登入。" if started else "專用 Chrome 已經開啟，請在該視窗完成登入。")
    )

@app.get("/status/<system>")
def status(system):
    if system not in SYSTEMS:
        return jsonify(error="unknown system"), 404
    s = browser_status(system)
    return jsonify(
        system=system,
        logged_in=s["logged_in"],
        running=s["running"],
        message=s["message"],
        url=s["url"],
    )

def demo_rows():
    return [
        {"unit":"大安心","worker":"王小明","client":"陳OO","date":"2026-10-06","start":"09:00","end":"10:00"},
        {"unit":"大慶","worker":"王小明","client":"李OO","date":"2026-10-06","start":"09:30","end":"10:30"},
        {"unit":"大安心","worker":"李小天","client":"林OO","date":"2026-10-06","start":"11:00","end":"12:00"},
    ]

@app.get("/demo")
def demo():
    return jsonify(rows=demo_rows())

@app.post("/services")
def services():
    payload = request.get_json(silent=True) or {}
    selected_date = payload.get("date") or str(date.today())

    # 下一版會在這裡接回既有實際流程：
    # 仁寶：
    #   1. CDP Storage.getCookies
    #   2. 擷取 x-company-id / x-employee-id
    #   3. POST /employee/list 驗證
    #   4. POST /shiftInfo/employee 或 /shift/profile/total 取班表
    #
    # 照管：
    #   1. 從已登入 Chrome 建立 requests.Session
    #   2. 依個案查詢 QD120A
    #   3. 套用既有衝突規則
    #
    # Session/Cookie/Token 僅留在 localhost Connector，不回傳 GitHub Pages。
    rows = [r for r in demo_rows() if r["date"] == selected_date]
    return jsonify(rows=rows)

if __name__ == "__main__":
    print("Service Conflict Connector v" + VERSION)
    print("Listening on http://127.0.0.1:8765")
    app.run(host="127.0.0.1", port=8765, debug=False)
