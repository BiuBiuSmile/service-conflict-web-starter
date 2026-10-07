const CONNECTOR = "http://127.0.0.1:8765";
const MIN_CONNECTOR_VERSION = "0.5.5";
const $ = (id) => document.getElementById(id);

let connectorOnline = false;
let lastLogKey = "";
let authToken = sessionStorage.getItem("serviceConflictToken") || "";
let currentUser = null;
let setupMode = false;

function versionAtLeast(current, required) {
  const a = String(current || "0").split(".").map(n => parseInt(n, 10) || 0);
  const b = String(required || "0").split(".").map(n => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function log(msg, key="") {
  const dedupeKey = key || msg;
  if (dedupeKey === lastLogKey) return;
  lastLogKey = dedupeKey;
  $("log").textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  $("log").scrollTop = $("log").scrollHeight;
}

function setConnectorState(ok, version="") {
  connectorOnline = ok;
  const badge = $("connectorBadge");
  const panel = $("installPanel");

  if (ok) {
    badge.textContent = version ? `資料啟動器已連線 v${version}` : "資料啟動器已連線";
    badge.className = "badge good";
    panel.classList.add("hidden");
  } else {
    badge.textContent = "資料啟動器未連線";
    badge.className = "badge bad";
    panel.classList.remove("hidden");
  }

  ["btnOpenCompal","btnCompal","btnOpenLcms","btnLcms","btnAnalyze"].forEach(id => {
    $(id).disabled = !ok;
  });
}

async function api(path, options={}, timeoutMs=2500) {
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CONNECTOR + path, {
      ...options,
      signal: ctl.signal,
      headers: {
        "Content-Type":"application/json",
        ...(authToken ? {"Authorization":"Bearer " + authToken} : {}),
        ...(options.headers||{})
      }
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {error: raw}; }

    if (!res.ok) {
      const err = new Error(data.error || (`HTTP ${res.status}`));
      err.status = res.status;
      err.code = data.code || "";
      err.data = data;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}


function showAuthScreen(message="") {
  $("authScreen").classList.remove("hidden");
  $("appShell").classList.add("hidden");
  if ($("authMessage")) $("authMessage").textContent = message;
}

function showConnectorStep(state, version="") {
  showAuthScreen();
  $("connectorPage").classList.remove("hidden");
  $("loginPage").classList.add("hidden");

  const badge = $("authConnectorBadge");
  const downloadBox = $("connectorDownloadBox");

  if (state === "checking") {
    $("connectorStepTitle").textContent = "正在檢查連線器";
    $("connectorStepText").textContent = "請稍候…";
    badge.textContent = "檢查中";
    badge.className = "badge wait";
    downloadBox.classList.add("hidden");
  } else if (state === "missing") {
    $("connectorStepTitle").textContent = "尚未連線服務衝突連線器";
    $("connectorStepText").textContent = "第一次使用請先下載並開啟連線器。";
    badge.textContent = "未連線";
    badge.className = "badge bad";
    downloadBox.classList.remove("hidden");
  } else if (state === "outdated") {
    $("connectorStepTitle").textContent = "連線器版本過舊";
    $("connectorStepText").textContent = "請關閉目前的舊版，再下載並開啟最新版。";
    badge.textContent = version ? "舊版 v" + version : "版本過舊";
    badge.className = "badge bad";
    downloadBox.classList.remove("hidden");
  } else if (state === "ready") {
    $("connectorStepTitle").textContent = "連線器已就緒";
    $("connectorStepText").textContent = version ? "已連線 v" + version : "已連線";
    badge.textContent = version ? "已連線 v" + version : "已連線";
    badge.className = "badge good";
    downloadBox.classList.add("hidden");
  }
}

function showLoginForm() {
  showAuthScreen();
  $("connectorPage").classList.add("hidden");
  $("loginPage").classList.remove("hidden");
}

function showApp() {
  $("authScreen").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("btnAdmin").classList.toggle("hidden", currentUser?.role !== "admin");
}

function applyAuthConfiguredState(configured) {
  setupMode = !configured;

  $("authTitle").textContent = setupMode ? "首次設定管理者" : "帳號登入";
  $("authSubtitle").textContent = setupMode
    ? "這台電腦尚未建立帳號，請先建立第一個管理者帳號"
    : "請輸入帳號及密碼";
  $("btnAuthSubmit").textContent = setupMode ? "建立管理者帳號" : "登入";
  $("authPasswordConfirmWrap").classList.toggle("hidden", !setupMode);
}

async function loadAuthMode() {
  const data = await api("/auth/status", {}, 2500);
  applyAuthConfiguredState(Boolean(data.configured));

  if (authToken) {
    try {
      currentUser = await api("/auth/me", {}, 2500);
      showApp();
      return true;
    } catch (_) {
      authToken = "";
      sessionStorage.removeItem("serviceConflictToken");
    }
  }

  showLoginForm();
  return false;
}

async function bootstrapAuthFlow() {
  showConnectorStep("checking");

  let health = null;
  try {
    health = await api("/health", {}, 1800);
  } catch (_) {
    showConnectorStep("missing");
    return false;
  }

  connectorOnline = true;
  setConnectorState(true, health.version || "");

  if (!health.auth || !versionAtLeast(health.version, MIN_CONNECTOR_VERSION)) {
    showConnectorStep("outdated", health.version || "");
    return false;
  }

  showConnectorStep("ready", health.version || "");

  // 新版 Connector 直接在 /health 回傳帳號是否已設定，
  // 不再卡在「連線器已就緒」等待第二個狀態請求。
  if (typeof health.configured === "boolean") {
    applyAuthConfiguredState(health.configured);

    if (authToken) {
      try {
        currentUser = await api("/auth/me", {}, 2500);
        showApp();
        return true;
      } catch (_) {
        authToken = "";
        sessionStorage.removeItem("serviceConflictToken");
      }
    }

    showLoginForm();
    return false;
  }

  try {
    return await loadAuthMode();
  } catch (e) {
    let message = e.message || "登入功能異常";
    if (message.includes("404")) {
      showConnectorStep("outdated", health.version || "");
    } else {
      showLoginForm();
      $("authMessage").textContent = "驗證功能異常：" + message;
    }
    return false;
  }
}

async function submitAuth() {
  const username = $("authUsername").value.trim();
  const password = $("authPassword").value;
  const confirm = $("authPasswordConfirm").value;

  $("authMessage").textContent = "";

  if (!username || !password) {
    $("authMessage").textContent = "請輸入帳號及密碼";
    return;
  }

  if (setupMode && password !== confirm) {
    $("authMessage").textContent = "兩次輸入的密碼不一致";
    return;
  }

  $("btnAuthSubmit").disabled = true;
  const originalButtonText = $("btnAuthSubmit").textContent;
  $("btnAuthSubmit").textContent = setupMode ? "正在建立管理者…" : "登入中…";
  $("authMessage").textContent = setupMode ? "正在建立管理者帳號，請稍候…" : "正在驗證帳號，請稍候…";

  try {
    const path = setupMode ? "/auth/setup" : "/auth/login";
    const data = await api(path, {
      method:"POST",
      body:JSON.stringify({username, password})
    }, 15000);

    authToken = data.token;
    currentUser = data.user;
    sessionStorage.setItem("serviceConflictToken", authToken);
    $("authMessage").textContent = "";
    showApp();
    await ping(false);
    await refreshStatuses();
  } catch (e) {
    if (e.code === "ALREADY_CONFIGURED" || e.status === 409) {
      setupMode = false;
      $("authTitle").textContent = "帳號登入";
      $("authSubtitle").textContent = "管理者帳號已建立，請使用帳號密碼登入";
      $("btnAuthSubmit").textContent = "登入";
      $("authPasswordConfirmWrap").classList.add("hidden");
      $("authMessage").textContent = e.message || "管理者帳號已建立，請改用登入。";
    } else {
      $("authMessage").textContent = e.message || "操作失敗";
    }
  } finally {
    $("btnAuthSubmit").disabled = false;
    $("btnAuthSubmit").textContent = setupMode ? "建立管理者帳號" : "登入";
  }
}

async function logout() {
  try {
    if (authToken) {
      await api("/auth/logout", {method:"POST", body:"{}"}, 2500);
    }
  } catch (_) {}

  authToken = "";
  currentUser = null;
  sessionStorage.removeItem("serviceConflictToken");
  $("authPassword").value = "";
  $("authPasswordConfirm").value = "";
  await loadAuthMode();
}

async function ping(silent=false) {
  try {
    const data = await api("/health", {}, 1800);
    setConnectorState(true, data.version || "");
    if (!silent) log("本機資料啟動器連線成功", "ping-ok");
    return true;
  } catch (e) {
    setConnectorState(false);
    if (!silent) log("尚未偵測到資料啟動器。請先下載並開啟 Windows 連線器。", "ping-fail");
    return false;
  }
}


async function refreshStatuses() {
  if (!connectorOnline) return;
  try {
    const results = await Promise.all([
      api('/status/compal', {}, 12000).catch(e => ({logged_in:false,message:e.message})),
      api('/status/lcms', {}, 12000).catch(e => ({logged_in:false,message:e.message}))
    ]);
    const compal = results[0], lcms = results[1];
    $('compalStatus').textContent = compal.logged_in ? '✓ 已登入' : '✕ 尚未登入';
    $('lcmsStatus').textContent = lcms.logged_in ? '✓ 已登入' : '✕ 尚未登入';
    $('compalStatus').title = compal.message || '';
    $('lcmsStatus').title = lcms.message || '';
  } catch (_) {}
}

function renderServerAnalysis(data) {
  const rows = data.rows || [];
  const issues = data.issues || [];
  const stats = data.stats || {};

  $('summary').textContent =
    '共讀取 ' + (stats.total_services ?? rows.length) +
    ' 筆服務，掃描 ' + (stats.cases_scanned ?? 0) +
    ' 位個案，發現 ' + (stats.total_issues ?? issues.length) + ' 筆異常。';

  if (!issues.length) {
    $('results').innerHTML =
      '<div class="conflict ok"><strong>未發現服務重疊、居服員撞班或規則異常。</strong></div>';
    return;
  }

  const esc = (v) => String(v ?? '').replace(/[&<>\"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'
  }[c]));

  const rowsHtml = issues.map((x, index) => {
    let typeText = x.title || '異常';
    let subject = x.client || x.worker || '';
    let detailA = '';
    let detailB = '';
    let minutes = x.minutes ? (x.minutes + ' 分鐘') : '';

    if (x.type === 'case_overlap') {
      detailA =
        '<div><strong>A</strong>｜' +
        esc(x.a.unit) + '｜' +
        esc(x.a.worker) + '｜' +
        esc(x.a.title) + '｜' +
        esc(x.a.start) + '-' + esc(x.a.end) +
        '</div>';

      detailB =
        '<div><strong>B</strong>｜' +
        esc(x.b.unit) + '｜' +
        esc(x.b.worker) + '｜' +
        esc(x.b.title) + '｜' +
        esc(x.b.start) + '-' + esc(x.b.end) +
        '</div>';
    } else if (x.type === 'staff_overlap') {
      typeText = '居服員撞班';
      subject = x.worker || '';

      detailA =
        '<div><strong>A</strong>｜' +
        esc(x.a.unit) + '｜' +
        esc(x.a.client) + '｜' +
        esc(x.a.title) + '｜' +
        esc(x.a.start) + '-' + esc(x.a.end) +
        '</div>';

      detailB =
        '<div><strong>B</strong>｜' +
        esc(x.b.unit) + '｜' +
        esc(x.b.client) + '｜' +
        esc(x.b.title) + '｜' +
        esc(x.b.start) + '-' + esc(x.b.end) +
        '</div>';
    } else {
      detailA = esc(x.detail || '');
    }

    return (
      '<tr>' +
        '<td class="col-no">' + (index + 1) + '</td>' +
        '<td class="col-type"><span class="issue-badge">' + esc(typeText) + '</span></td>' +
        '<td class="col-subject">' + esc(subject) + '</td>' +
        '<td class="col-date">' + esc(x.date || '') + '</td>' +
        '<td class="col-minutes">' + esc(minutes) + '</td>' +
        '<td class="col-detail">' +
          detailA +
          (detailB ? '<div class="detail-gap"></div>' + detailB : '') +
        '</td>' +
      '</tr>'
    );
  }).join('');

  $('results').innerHTML =
    '<div class="issue-table-wrap">' +
      '<table class="issue-table">' +
        '<thead>' +
          '<tr>' +
            '<th>#</th>' +
            '<th>異常類型</th>' +
            '<th>個案／居服員</th>' +
            '<th>日期</th>' +
            '<th>重疊</th>' +
            '<th>服務明細</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
    '</div>';
}

async function openLogin(system) {
  if (!(await ping(true))) return;
  const label = system === "compal" ? "仁寶" : "照管";
  const target = system === "compal" ? $("compalStatus") : $("lcmsStatus");
  try {
    target.textContent = "正在開啟官方登入頁…";
    const data = await api(`/connect/${system}`, {method:"POST", body:"{}"});
    target.textContent = "請在官方 Chrome 頁面完成登入";
    log(`${label}：${data.message}`);
  } catch(e) {
    target.textContent = "開啟失敗";
    log(`${label}登入頁開啟失敗：${e.message}`);
  }
}

async function checkLogin(system) {
  if (!(await ping(true))) return;
  const label = system === "compal" ? "仁寶" : "照管";
  const target = system === "compal" ? $("compalStatus") : $("lcmsStatus");
  try {
    target.textContent = "檢查中…";
    const data = await api(`/status/${system}`);
    target.textContent = data.logged_in ? "✓ 已登入" : "✕ 尚未登入";
    log(`${label}：${data.message}`);
  } catch(e) {
    target.textContent = "檢查失敗";
    log(`${label}檢查失敗：${e.message}`);
  }
}

function toMinutes(s) {
  const [h,m] = s.split(":").map(Number);
  return h*60+m;
}

function findConflicts(rows) {
  const byWorkerDate = new Map();
  for (const r of rows) {
    const key = `${r.worker}__${r.date}`;
    if (!byWorkerDate.has(key)) byWorkerDate.set(key, []);
    byWorkerDate.get(key).push(r);
  }

  const conflicts = [];
  for (const items of byWorkerDate.values()) {
    items.sort((a,b)=>toMinutes(a.start)-toMinutes(b.start));
    for (let i=0;i<items.length;i++) {
      for (let j=i+1;j<items.length;j++) {
        const a=items[i], b=items[j];
        const overlap = Math.min(toMinutes(a.end),toMinutes(b.end)) -
                        Math.max(toMinutes(a.start),toMinutes(b.start));
        if (overlap > 0) conflicts.push({a,b,overlap});
        if (toMinutes(b.start) >= toMinutes(a.end)) break;
      }
    }
  }
  return conflicts;
}

function render(rows) {
  const conflicts = findConflicts(rows);
  $("summary").textContent = `共讀取 ${rows.length} 筆服務，發現 ${conflicts.length} 組時段衝突。`;

  if (!conflicts.length) {
    $("results").innerHTML = `<div class="conflict ok"><strong>未發現服務時段重疊。</strong></div>`;
    return;
  }

  $("results").innerHTML = conflicts.map(c => `
    <div class="conflict">
      <strong>${c.a.worker}</strong>｜${c.a.date}｜重疊 ${c.overlap} 分鐘<br>
      A：${c.a.unit}／${c.a.client}／${c.a.start}-${c.a.end}<br>
      B：${c.b.unit}／${c.b.client}／${c.b.start}-${c.b.end}
    </div>
  `).join("");
}

function updateAnalysisMode() {
  const monthly = $("modeMonth").checked;
  $("dayAnalysisFields").classList.toggle("hidden", monthly);
  $("monthAnalysisFields").classList.toggle("hidden", !monthly);

  if (monthly) {
    const month = $("monthInput").value;
    $("analysisRangeHint").textContent = month
      ? "將分析 " + month + " 整月份服務紀錄"
      : "請選擇要分析的月份";
  } else {
    const date = $("dateInput").value;
    $("analysisRangeHint").textContent = date
      ? "將分析 " + date + " 當日服務紀錄"
      : "請選擇要分析的日期";
  }
}

async function analyze() {
  if (!(await ping(true))) return;

  const monthly = $("modeMonth").checked;
  const payload = monthly
    ? {mode:"month", month:$("monthInput").value}
    : {mode:"day", date:$("dateInput").value};

  if ((monthly && !payload.month) || (!monthly && !payload.date)) {
    $("summary").textContent = monthly ? "請先選擇月份" : "請先選擇日期";
    return;
  }

  try {
    $('summary').textContent = monthly
      ? '正在查詢整月份照管個案與 QD120A 服務紀錄，資料較多請稍候…'
      : '正在查詢照管個案與 QD120A 服務紀錄…';
    $('results').innerHTML = '';
    const data = await api('/services', {method:'POST', body: JSON.stringify(payload)}, monthly ? 600000 : 180000);
    log('照管 QD120A：取得 ' + data.rows.length + ' 筆服務資料');
    renderServerAnalysis(data);
  } catch(e) {
    $('summary').textContent = '抓取失敗';
    $('results').innerHTML = '<div class="conflict"><strong>抓取失敗</strong><br>' + e.message + '</div>';
    log('分析失敗：' + e.message);
  }
}

$("btnOpenCompal").onclick = ()=>openLogin("compal");
$("btnCompal").onclick = ()=>checkLogin("compal");
$("btnOpenLcms").onclick = ()=>openLogin("lcms");
$("btnLcms").onclick = ()=>checkLogin("lcms");
$("btnAnalyze").onclick = analyze;
$("btnRetryConnector").onclick = ()=>ping(false).then(ok => { if (ok) refreshStatuses(); });
$("btnDemo").onclick = async ()=>{
  if (!(await ping(true))) {
    const rows = [
      {"unit":"大安心","worker":"王小明","client":"陳OO","date":"2026-10-06","start":"09:00","end":"10:00"},
      {"unit":"大慶","worker":"王小明","client":"李OO","date":"2026-10-06","start":"09:30","end":"10:30"}
    ];
    render(rows);
    log("資料啟動器未啟動，已載入前端示範資料");
    return;
  }
  const data = await api("/demo");
  render(data.rows);
  log("已載入示範資料");
};

const todayIso = new Date().toISOString().slice(0,10);
$("dateInput").value = todayIso;
$("monthInput").value = todayIso.slice(0,7);
$("modeDay").addEventListener("change", updateAnalysisMode);
$("modeMonth").addEventListener("change", updateAnalysisMode);
$("dateInput").addEventListener("change", updateAnalysisMode);
$("monthInput").addEventListener("change", updateAnalysisMode);
updateAnalysisMode();

$("btnAuthSubmit").onclick = submitAuth;
$("authPassword").addEventListener("keydown", e => {
  if (e.key === "Enter") submitAuth();
});
$("authPasswordConfirm").addEventListener("keydown", e => {
  if (e.key === "Enter") submitAuth();
});
$("btnAuthRetryConnector").onclick = bootstrapAuthFlow;
$("btnLogout").onclick = logout;
$("btnAdmin").onclick = ()=>{ window.location.href = "./admin.html"; };

setConnectorState(false);
bootstrapAuthFlow().then(async loggedIn => {
  if (loggedIn) {
    await refreshStatuses();
  }
});

setInterval(async ()=>{
  if (!$("authScreen").classList.contains("hidden")) {
    if (!connectorOnline || !$("loginPage").classList.contains("hidden")) return;

    try {
      const health = await api("/health", {}, 1800);
      if (health.auth) {
        connectorOnline = true;
        setConnectorState(true, health.version || "");
        await loadAuthMode();
      }
    } catch (_) {}
    return;
  }

  if (!authToken) return;
  const ok = await ping(true);
  if (ok) await refreshStatuses();
}, 5000);
