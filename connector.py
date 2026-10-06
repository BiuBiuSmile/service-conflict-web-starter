import os
import sys
import time
import shutil
import subprocess
import threading
import webbrowser
from pathlib import Path
from datetime import date

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

VERSION = "0.3.0"
PORT = 8765
WEBSITE_URL = "https://biubiusmile.github.io/service-conflict-web/"

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
    # Chrome Private Network Access 預檢所需。
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

def executable_path():
    return Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve()

def register_startup():
    """加入目前使用者 Windows 開機啟動，不需要管理員權限。"""
    if os.name != "nt":
        return
    try:
        import winreg
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        value = f'"{executable_path()}" --background'
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            key_path,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.SetValueEx(
                key,
                "ServiceConflictConnector",
                0,
                winreg.REG_SZ,
                value,
            )
    except Exception:
        pass

def unregister_startup():
    if os.name != "nt":
        return
    try:
        import winreg
        key_path = r"Software\Microsoft\Windows\CurrentVersion\Run"
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            key_path,
            0,
            winreg.KEY_SET_VALUE,
        ) as key:
            winreg.DeleteValue(key, "ServiceConflictConnector")
    except Exception:
        pass

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
        logged = (
            cfg["host"] in lower
            and "/lcms/" in lower
            and not any(t in lower for t in obvious_login_tokens)
        )

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

    try:
        started = launch_login(system)
    except Exception as e:
        return jsonify(error=str(e)), 500

    return jsonify(
        ok=True,
        started=started,
        message=(
            "已開啟官方登入頁，請完成登入。"
            if started
            else "專用 Chrome 已經開啟，請在該視窗完成登入。"
        ),
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

    # v0.3 仍保留示範資料。
    # 下一階段會把既有仁寶 CDP/API 與照管 QD120A 流程接到這裡。
    rows = [r for r in demo_rows() if r["date"] == selected_date]
    return jsonify(rows=rows)

def run_server():
    app.run(
        host="127.0.0.1",
        port=PORT,
        debug=False,
        use_reloader=False,
        threaded=True,
    )

def build_tray_icon():
    try:
        from PIL import Image, ImageDraw
        img = Image.new("RGB", (64,64), "white")
        d = ImageDraw.Draw(img)
        d.rounded_rectangle((6,6,58,58), radius=12, fill=(37,99,235))
        d.ellipse((19,19,45,45), fill="white")
        d.rectangle((28,14,36,50), fill=(37,99,235))
        return img
    except Exception:
        return None

def run_tray():
    try:
        import pystray

        def open_site(icon, item):
            webbrowser.open(WEBSITE_URL)

        def quit_app(icon, item):
            unregister_startup()
            icon.stop()
            os._exit(0)

        menu = pystray.Menu(
            pystray.MenuItem("開啟服務衝突系統", open_site, default=True),
            pystray.MenuItem("停止並取消開機啟動", quit_app),
        )

        icon_img = build_tray_icon()
        if icon_img is None:
            return False

        icon = pystray.Icon(
            "ServiceConflictConnector",
            icon_img,
            "服務衝突連線器",
            menu,
        )
        icon.run()
        return True
    except Exception:
        return False

def main():
    if already_running():
        webbrowser.open(WEBSITE_URL)
        return

    register_startup()

    t = threading.Thread(target=run_server, daemon=True)
    t.start()

    # 等 localhost 起來
    for _ in range(20):
        if already_running():
            break
        time.sleep(0.15)

    background = "--background" in sys.argv
    if not background:
        webbrowser.open(WEBSITE_URL)

    # EXE 以系統列常駐；若 tray 無法建立，仍維持背景服務。
    if not run_tray():
        while True:
            time.sleep(3600)

if __name__ == "__main__":
    main()
