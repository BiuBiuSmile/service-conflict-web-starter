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

VERSION = "0.4.4"
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

    try:
        if not cdp_available(system):
            return {
                "running": False,
                "logged_in": False,
                "message": "專用 Chrome 尚未啟動。",
                "url": "",
            }

        targets = cdp_json(system, "/json/list")
        pages = [
            x for x in targets
            if isinstance(x, dict) and x.get("type") == "page"
        ]
        related = [
            x for x in pages
            if cfg["host"] in str(x.get("url") or "")
        ]

        if not related:
            return {
                "running": True,
                "logged_in": False,
                "message": f"{cfg['name']} 官方頁面已關閉。",
                "url": "",
            }

        url = str(related[0].get("url") or "")

        if system == "lcms":
            try:
                ok, message = probe_lcms()
                return {
                    "running": True,
                    "logged_in": bool(ok),
                    "message": message,
                    "url": url,
                }
            except Exception as e:
                return {
                    "running": True,
                    "logged_in": False,
                    "message": f"照管 Session 檢查失敗：{type(e).__name__}: {e}",
                    "url": url,
                }

        lower = url.lower()
        logged = (
            cfg["host"] in lower
            and "/login" not in lower
            and "/signin" not in lower
            and lower.rstrip("/") != "https://luna.compal-health.com"
        )
        return {
            "running": True,
            "logged_in": logged,
            "message": "已偵測到登入後頁面。" if logged else "等待使用者在官方頁面完成登入。",
            "url": url,
        }

    except Exception as e:
        return {
            "running": cdp_available(system),
            "logged_in": False,
            "message": f"狀態檢查失敗：{type(e).__name__}: {e}",
            "url": "",
        }


LCMS_CASE_URL = (
    "https://csms.mohw.gov.tw/lcms/ca/filter/"
    "?caseno=&serialno=&name=&idno=&pi400aName="
    "&_qd111Resp=&_qd1115Resp=&_qd111adjHint=&_qd111pi400Hint="
    "&_checkAa10Rsp=&_qp110adjHint=&_flexErrHint=&_ca110Modify=&_caseDeath="
    "&_uploadCc01=&_qp300HintPi400=&_qd300HintPi400=&_qd310HintPi400="
    "&_cmsLowerB=&_fh410NotExistsB="
    "&birthDt1=&birthDt2=&applyDt1=&applyDt2=&openDt1=&openDt2="
    "&closeDt1=&closeDt2=&qevalDt1=&qevalDt2=&qmaxInstructDt1=&qmaxInstructDt2="
    "&processDt1=&processD2=&applySource=&_hpCreated=&sextype=&applyType=&censusDiff="
    "&aborigine=&raceType=&liveType=&isdisbook=&sptype=&cmsLev=&disLev=&levcode="
    "&isSick=&discode=&qcntcode=&twnspcode=&vilgcode=&qinformCntcode="
    "&informTwnspcode=&informVilgcode=&qQd120ServDt_b=&qQd120ServDt_e="
    "&sb210id=&sb500id=&ca113exists=&qca113title=&qservUser=&sb400id="
    "&doQuery=true&qdList1=yes&limit=100&offset=0&order=asc"
)

LCMS_QD120_URL = (
    "https://csms.mohw.gov.tw/lcms/qd/filterQd120A/{case_id}"
    "?doQuery=yes&ca100id={case_id}&perms=true&stype=&sourceType=&status="
    "&servDt1=&servDt2=&qd120APi400=&servUserName=&aa10Status="
    "&limit=100&offset=0&order=asc"
)

def _system_page(system):
    cfg = SYSTEMS[system]
    targets = cdp_json(system, "/json/list")
    pages = [
        x for x in targets
        if isinstance(x, dict)
        and x.get("type") == "page"
        and cfg["host"] in str(x.get("url") or "")
    ]
    return pages[0] if pages else None

def _cdp_call(ws_url, method, params=None, call_id=1, timeout=30):
    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({
            "id": call_id,
            "method": method,
            "params": params or {},
        }))
        while True:
            payload = json.loads(ws.recv())
            if payload.get("id") == call_id:
                if "error" in payload:
                    raise RuntimeError(str(payload["error"]))
                return payload.get("result", {})
    finally:
        try:
            ws.close()
        except Exception:
            pass

def build_cdp_session(system):
    page = _system_page(system)
    if not page or not page.get("webSocketDebuggerUrl"):
        raise RuntimeError("找不到已開啟的官方頁面。")

    ws_url = page["webSocketDebuggerUrl"]
    cookie_result = _cdp_call(ws_url, "Storage.getCookies", call_id=101, timeout=15)
    ua_result = _cdp_call(
        ws_url,
        "Runtime.evaluate",
        {"expression": "navigator.userAgent", "returnByValue": True},
        call_id=102,
        timeout=15,
    )

    s = requests.Session()
    for ck in cookie_result.get("cookies", []) or []:
        try:
            s.cookies.set(
                ck.get("name", ""),
                ck.get("value", ""),
                domain=ck.get("domain") or None,
                path=ck.get("path") or "/",
            )
        except Exception:
            pass

    ua = ua_result.get("result", {}).get("value") or "Mozilla/5.0"
    s.headers.update({
        "User-Agent": ua,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": SYSTEMS[system]["url"],
    })
    return s

def browser_fetch_json(system, url, timeout=30):
    page = _system_page(system)
    if not page or not page.get("webSocketDebuggerUrl"):
        raise RuntimeError(f"{SYSTEMS[system]['name']} 官方頁面尚未開啟。")

    expression = (
        "(async () => {"
        "  const r = await fetch(" + json.dumps(url) + ", {"
        "    method: 'GET',"
        "    credentials: 'include',"
        "    cache: 'no-store',"
        "    headers: {"
        "      'Accept': 'application/json, text/javascript, */*; q=0.01',"
        "      'X-Requested-With': 'XMLHttpRequest'"
        "    }"
        "  });"
        "  const text = await r.text();"
        "  return {status:r.status, ok:r.ok, contentType:r.headers.get('content-type') || '', text:text};"
        "})()"
    )

    result = _cdp_call(
        page["webSocketDebuggerUrl"],
        "Runtime.evaluate",
        {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        },
        call_id=205,
        timeout=max(15, timeout),
    )

    payload = result.get("result", {}).get("value")
    if not isinstance(payload, dict):
        raise RuntimeError("瀏覽器未回傳有效資料。")

    status = int(payload.get("status") or 0)
    if status in (401, 403):
        raise RuntimeError(f"照管登入資料已失效 (HTTP {status})")
    if not payload.get("ok"):
        raise RuntimeError(f"照管查詢失敗 (HTTP {status})")

    text = payload.get("text") or ""
    try:
        return json.loads(text)
    except Exception:
        raise RuntimeError(
            f"照管回傳非 JSON (Content-Type={payload.get('contentType','')})"
        )


def safe_json_get(session, url, tag, timeout=30):
    try:
        response = session.get(url, timeout=timeout)
        if response.status_code in (401, 403):
            raise RuntimeError(
                f"{tag}：照管登入資料已失效 (HTTP {response.status_code})"
            )
        response.raise_for_status()
        try:
            return response.json()
        except Exception:
            raise RuntimeError(
                f"{tag}：照管回傳非 JSON，可能已回到登入頁。"
            )

    except requests.exceptions.SSLError:
        # Python/OpenSSL 對照管憑證鏈驗證失敗時，
        # 改由已登入的 Chrome 執行同源 fetch。
        # 這不是關閉 SSL 驗證，仍由 Chrome 正常驗證 HTTPS。
        return browser_fetch_json("lcms", url, timeout=timeout)

def probe_lcms():
    if not cdp_available("lcms"):
        return False, "照管專用 Chrome 尚未啟動。"
    try:
        session = build_cdp_session("lcms")
        probe_url = re.sub(r"limit=\d+", "limit=1", LCMS_CASE_URL)
        data = safe_json_get(session, probe_url, "照管狀態", timeout=10)
        if isinstance(data, dict) and ("rows" in data or "total" in data):
            return True, "照管 Session 有效。"
        return False, "照管頁面已開啟，但尚未取得有效 Session。"
    except Exception as e:
        return False, str(e)

def _safe_total(value, fallback):
    try:
        text = str(value).replace(",", "").strip()
        return int(text)
    except Exception:
        return fallback

def fetch_all_lcms_cases(session):
    all_rows = []
    offset = 0

    while True:
        url = re.sub(r"offset=\d+", f"offset={offset}", LCMS_CASE_URL)
        data = browser_fetch_json("lcms", url, timeout=90)
        if not isinstance(data, dict):
            raise RuntimeError("CA_FILTER 回傳格式不是物件。")

        batch = data.get("rows", []) or []
        if not isinstance(batch, list):
            raise RuntimeError("CA_FILTER rows 格式異常。")

        total = _safe_total(data.get("total"), len(batch))
        all_rows.extend(batch)

        if len(all_rows) >= total or len(batch) < 100:
            break

        offset += 100
        if offset > 5000:
            break

    result = []
    seen = set()
    for row in all_rows:
        if not isinstance(row, dict):
            continue
        case_id = row.get("id")
        if not case_id:
            continue
        try:
            case_id = int(case_id)
        except Exception:
            continue
        if case_id in seen:
            continue
        seen.add(case_id)
        result.append({
            "id": case_id,
            "name": str(row.get("name") or "(未取得姓名)").strip(),
        })
    return result

def to_roc_encoded_date(d):
    return f"{d.year - 1911}%2F{d.month:02d}%2F{d.day:02d}"

def query_qd120_rows(session, case_id, selected_date):
    base_url = LCMS_QD120_URL.format(case_id=case_id)
    roc_date = to_roc_encoded_date(selected_date)
    url0 = (
        base_url
        .replace("servDt1=&", f"servDt1={roc_date}&")
        .replace("servDt2=&", f"servDt2={roc_date}&")
    )

    all_rows = []
    offset = 0

    while True:
        url = re.sub(r"offset=\d+", f"offset={offset}", url0)
        data = browser_fetch_json("lcms", url, timeout=60)
        if not isinstance(data, dict):
            raise RuntimeError("QD120A 回傳格式不是物件。")

        batch = data.get("rows", []) or []
        if not isinstance(batch, list):
            raise RuntimeError("QD120A rows 格式異常。")

        total = _safe_total(data.get("total"), len(batch))
        all_rows.extend(batch)

        if len(all_rows) >= total or len(batch) < 100:
            break

        offset += 100
        if offset > 5000:
            break

    return all_rows

def clean_text(value):
    return re.sub(r"<.*?>", "", str(value or "")).strip()

def parse_service_datetime(serv_dt, hhmm):
    try:
        date_text = str(serv_dt or "").strip()
        if "/" in date_text:
            y, m, d = date_text.split("/")[:3]
        elif "-" in date_text:
            y, m, d = date_text.split("-")[:3]
        else:
            return None, None

        y = int(y)
        if y < 200:
            y += 1911

        raw = re.sub(r"\[.*?\]", "", clean_text(hhmm))
        raw = raw.replace("～", "~").replace("–", "-").replace("—", "-")

        if "~" in raw:
            t1, t2 = [x.strip() for x in raw.split("~", 1)]
        elif "-" in raw:
            t1, t2 = [x.strip() for x in raw.split("-", 1)]
        else:
            return None, None

        start = datetime.strptime(
            f"{y:04d}/{int(m):02d}/{int(d):02d} {t1}",
            "%Y/%m/%d %H:%M",
        )
        end = datetime.strptime(
            f"{y:04d}/{int(m):02d}/{int(d):02d} {t2}",
            "%Y/%m/%d %H:%M",
        )

        if end <= start:
            end += timedelta(days=1)

        return start, end
    except Exception:
        return None, None

def _first_value(row, keys, default=""):
    for key in keys:
        value = row.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return default

def normalize_qd_row(case_id, case_name, row):
    if not isinstance(row, dict):
        return None

    start, end = parse_service_datetime(
        row.get("servDt", ""),
        row.get("hhmm", ""),
    )
    if not start or not end:
        return None

    title = str(row.get("title") or "").strip()
    code_match = re.match(r"([A-Z0-9]{3,5})", title)
    code = code_match.group(1) if code_match else title

    return {
        "case_id": case_id,
        "client": case_name,
        "unit": _first_value(
            row,
            [
                "orgName", "instName", "companyName", "sb400Name",
                "sb400idName", "agencyName", "unitName", "providerName",
            ],
            "(未取得機構)",
        ),
        "worker": _first_value(
            row,
            [
                "servUserName", "servUser", "servUserNm",
                "servUserFullName", "userName", "workerName",
                "caregiverName", "empName",
            ],
            "(未取得居服員)",
        ),
        "worker_id": _first_value(
            row,
            [
                "servUserId", "servUserID", "servUserNo",
                "employeeNo", "workerId", "empId", "sb210id",
                "userId", "staffId",
            ],
            "",
        ),
        "title": title,
        "code": code,
        "date": start.strftime("%Y-%m-%d"),
        "start": start.strftime("%H:%M"),
        "end": end.strftime("%H:%M"),
        "_start_dt": start,
        "_end_dt": end,
    }

def analyze_services(rows):
    issues = []
    by_case = {}

    for row in rows:
        key = (row["case_id"], row["date"])
        by_case.setdefault(key, []).append(row)

    for (_, service_date), items in by_case.items():
        items.sort(key=lambda x: x["_start_dt"])

        for i, a in enumerate(items):
            for b in items[i + 1:]:
                if b["_start_dt"] >= a["_end_dt"]:
                    break
                if not (
                    a["_start_dt"] < b["_end_dt"]
                    and b["_start_dt"] < a["_end_dt"]
                ):
                    continue

                overlap_start = max(a["_start_dt"], b["_start_dt"])
                overlap_end = min(a["_end_dt"], b["_end_dt"])
                minutes = max(
                    1,
                    int((overlap_end - overlap_start).total_seconds() // 60),
                )

                issues.append({
                    "type": "case_overlap",
                    "title": "服務時間重疊",
                    "client": a["client"],
                    "date": service_date,
                    "minutes": minutes,
                    "a": {
                        k: a[k]
                        for k in ("unit", "worker", "title", "start", "end")
                    },
                    "b": {
                        k: b[k]
                        for k in ("unit", "worker", "title", "start", "end")
                    },
                })

    return issues, {
        "total_services": len(rows),
        "total_issues": len(issues),
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
        message="已開啟官方登入頁，請完成登入。" if started else "專用 Chrome 已經開啟，請在該視窗完成登入。",
    )

@app.get("/status/<system>")
def status(system):
    if system not in SYSTEMS:
        return jsonify(error="unknown system"), 404

    try:
        s = browser_status(system)
        return jsonify(
            system=system,
            logged_in=bool(s.get("logged_in")),
            running=bool(s.get("running")),
            message=str(s.get("message") or ""),
            url=str(s.get("url") or ""),
        )
    except Exception as e:
        # 狀態檢查永遠回傳可讀 JSON，不讓前端只看到 Flask 500 HTML。
        return jsonify(
            system=system,
            logged_in=False,
            running=cdp_available(system),
            message=f"狀態檢查失敗：{type(e).__name__}: {e}",
            url="",
        ), 200

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
        return jsonify(
            error="日期格式錯誤",
            stage="date",
        ), 400

    try:
        ok, message = probe_lcms()
        if not ok:
            return jsonify(
                error=f"照管尚未登入或 Session 已失效：{message}",
                stage="login",
            ), 409

        # Session 只保留給相容介面；實際 LCMS 查詢改由 Chrome 同源 fetch 執行。
        session = build_cdp_session("lcms")

        try:
            cases = fetch_all_lcms_cases(session)
        except Exception as e:
            return jsonify(
                error=f"取得照管個案清單失敗：{type(e).__name__}: {e}",
                stage="case_list",
            ), 502

        normalized = []
        failures = []

        for info in cases:
            try:
                qd_rows = query_qd120_rows(
                    session,
                    info["id"],
                    selected,
                )

                for row in qd_rows:
                    item = normalize_qd_row(
                        info["id"],
                        info["name"],
                        row,
                    )
                    if item:
                        normalized.append(item)

            except Exception as e:
                failures.append({
                    "case": info.get("name", ""),
                    "case_id": info.get("id", ""),
                    "error": f"{type(e).__name__}: {e}",
                })

        try:
            issues, stats = analyze_services(normalized)
        except Exception as e:
            return jsonify(
                error=f"衝突分析失敗：{type(e).__name__}: {e}",
                stage="analysis",
                rows_read=len(normalized),
            ), 500

        stats["cases_scanned"] = len(cases)
        stats["case_query_failures"] = len(failures)

        public_rows = [
            {
                k: v
                for k, v in row.items()
                if not k.startswith("_")
            }
            for row in normalized
        ]

        return jsonify(
            rows=public_rows,
            issues=issues,
            stats=stats,
            query_failures=failures[:20],
            source="LCMS QD120A via Chrome",
        )

    except Exception as e:
        # 最外層保護：永遠回傳 JSON 錯誤，不再讓前端看到 Flask HTML 500。
        return jsonify(
            error=f"Connector 執行失敗：{type(e).__name__}: {e}",
            stage="unexpected",
        ), 500

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

def running_connector_version():
    try:
        data = requests.get(
            f"http://127.0.0.1:{PORT}/health",
            timeout=1.5,
        ).json()
        return str(data.get("version") or "未知")
    except Exception:
        return "未知"


def main():
    if already_running():
        running_version = running_connector_version()

        if running_version != VERSION:
            messagebox.showwarning(
                "偵測到舊版 Connector",
                (
                    f"目前電腦上已有 Connector v{running_version} 正在執行。\n\n"
                    f"你剛開啟的是 v{VERSION}，但 127.0.0.1:{PORT} "
                    "仍被舊版占用，因此網頁實際連到的仍是舊版。\n\n"
                    "請先關閉舊的「服務衝突連線器」視窗，"
                    "再重新開啟最新版。"
                ),
            )
        else:
            messagebox.showinfo(
                "服務衝突連線器",
                f"Connector v{VERSION} 已經在執行中。",
            )
        return

    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    show_window()

if __name__ == "__main__":
    main()
