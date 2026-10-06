import json
import os
import re
import shutil
import subprocess
import threading
import webbrowser
from pathlib import Path
from datetime import date, datetime, timedelta
import tkinter as tk
from tkinter import messagebox

import requests
import websocket
from flask import Flask, jsonify, request
from flask_cors import CORS

VERSION = "0.4.0"
PORT = 8765
WEBSITE_URL = "https://biubiusmile.github.io/service-conflict-web-starter/"

app = Flask(__name__)

ALLOWED_ORIGINS = [
    "https://biubiusmile.github.io",
    "https://chkia.dev",
    "http://localhost",
    "http://127.0.0.1",
]

CORS(
    app,
    resources={r"/*": {"origins": ALLOWED_ORIGINS}},
    supports_credentials=False,
)

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

@app.after_request
def add_private_network_headers(response):
    if request.headers.get("Access-Control-Request-Private-Network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    response.headers["Cache-Control"] = "no-store"
    return response

def base_dir():
    base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    p = base / "ServiceConflictConnector"
    p.mkdir(parents=True, exist_ok=True)
    return p

def profile_dir(system):
    p = base_dir() / "ChromeProfiles" / system
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

def already_running():
    try:
        r = requests.get(f"http://127.0.0.1:{PORT}/health", timeout=0.7)
        return r.ok
    except Exception:
        return False

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
        raise RuntimeError("找不到 Google Chrome，請先安裝 Chrome。")

    if cdp_available(system):
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
    subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
    )
    return True

def browser_status(system):
    cfg = SYSTEMS[system]
    if not cdp_available(system):
        return {"running": False, "logged_in": False, "message": "專用 Chrome 尚未啟動。", "url": ""}

    try:
        targets = cdp_json(system, "/json/list")
        pages = [x for x in targets if isinstance(x, dict) and x.get("type") == "page"]
        related = [x for x in pages if cfg["host"] in str(x.get("url") or "")]
    except Exception as e:
        return {"running": True, "logged_in": False, "message": f"暫時無法讀取分頁：{e}", "url": ""}

    if not related:
        return {"running": True, "logged_in": False, "message": f"{cfg['name']} 官方頁面已關閉。", "url": ""}

    url = str(related[0].get("url") or "")
    if system == "lcms":
        ok, message = probe_lcms()
        return {"running": True, "logged_in": ok, "message": message, "url": url}

    lower=url.lower()
    logged = cfg["host"] in lower and "/login" not in lower and "/signin" not in lower and lower.rstrip("/") != "https://luna.compal-health.com"
    return {"running": True, "logged_in": logged, "message": "已偵測到登入後頁面。" if logged else "等待使用者在官方頁面完成登入。", "url": url}

@app.get("/health")
def health():
    return jsonify(ok=True, version=VERSION)

@app.post("/connect/<system>")
def connect(system):
    if system not in SYSTEMS:
        return jsonify(error="unknown system"), 404
    try:
        started = launch_login(system)
    except Exception as e:
        return jsonify(error=str(e)), 500

    return jsonify(
        ok=True,
        started=started,
        message="已開啟官方登入頁，請完成登入。" if started else "專用 Chrome 已經開啟，請在該視窗完成登入。",
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
    raw_date = payload.get("date") or str(date.today())
    try:
        selected = datetime.strptime(raw_date, "%Y-%m-%d").date()
    except Exception:
        return jsonify(error="日期格式錯誤"), 400

    ok, message = probe_lcms()
    if not ok:
        return jsonify(error=f"照管尚未登入或 Session 已失效：{message}"), 409

    session = build_cdp_session("lcms")
    cases = fetch_all_lcms_cases(session)
    normalized = []
    failures = []

    for info in cases:
        try:
            for row in query_qd120_rows(session, info["id"], selected):
                item = normalize_qd_row(info["id"], info["name"], row)
                if item:
                    normalized.append(item)
        except Exception as e:
            failures.append({"case":info["name"],"case_id":info["id"],"error":str(e)})

    issues,stats=analyze_services(normalized)
    stats["cases_scanned"]=len(cases)
    stats["case_query_failures"]=len(failures)

    public_rows=[{k:v for k,v in r.items() if not k.startswith("_")} for r in normalized]
    return jsonify(rows=public_rows,issues=issues,stats=stats,query_failures=failures[:20],source="LCMS QD120A")

def run_server():
    app.run(
        host="127.0.0.1",
        port=PORT,
        debug=False,
        use_reloader=False,
        threaded=True,
    )

def show_window():
    root = tk.Tk()
    root.title("服務衝突連線器")
    root.geometry("420x220")
    root.resizable(False, False)

    tk.Label(root, text="服務衝突連線器", font=("Microsoft JhengHei UI", 18, "bold")).pack(pady=(22, 8))
    tk.Label(
        root,
        text=f"Connector 已啟動\nhttp://127.0.0.1:{PORT}",
        font=("Microsoft JhengHei UI", 11),
        justify="center",
    ).pack(pady=8)

    btn_frame = tk.Frame(root)
    btn_frame.pack(pady=14)

    tk.Button(
        btn_frame,
        text="開啟服務衝突網站",
        width=18,
        command=lambda: webbrowser.open(WEBSITE_URL),
    ).pack(side="left", padx=6)

    tk.Button(
        btn_frame,
        text="關閉連線器",
        width=14,
        command=root.destroy,
    ).pack(side="left", padx=6)

    tk.Label(
        root,
        text="此版本不會修改開機啟動設定，也不會常駐系統列。",
        fg="#666666",
        font=("Microsoft JhengHei UI", 9),
    ).pack(pady=(8, 0))

    root.mainloop()

def main():
    if already_running():
        messagebox.showinfo("服務衝突連線器", "Connector 已經在執行中。")
        return

    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    show_window()

if __name__ == "__main__":
    main()
