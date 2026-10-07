const CONNECTOR = "http://127.0.0.1:8765";
const MIN_CONNECTOR_VERSION = "0.6.0";
const $ = (id) => document.getElementById(id);
const CLOUD_API = String(
  (window.SERVICE_CONFLICT_CONFIG && window.SERVICE_CONFLICT_CONFIG.apiBase) ||
  "http://127.0.0.1:5001"
).replace(/\/$/, "");

let connectorOnline = false;
let lastLogKey = "";
let authToken = localStorage.getItem("serviceConflictCloudToken") || "";
let currentUser = null;
let authMode = "login";
let membership = {can_analyze:false, trial_remaining:0, subscription_active:false};
let uploadedCaseNames = [];
let lcmsLoggedIn = false;
let compalLoggedIn = false;

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

function updateAnalyzeAvailability() {
  const button = $("btnAnalyze");
  if (!button) return;

  const canAnalyze = connectorOnline && lcmsLoggedIn && Boolean(membership.can_analyze);
  button.disabled = !canAnalyze;

  if (!lcmsLoggedIn) {
    button.title = "請先登入照管，並確認狀態為已登入";
  } else if (!membership.can_analyze) {
    button.title = "免費試用已用完，請先完成付費";
  } else {
    button.title = "可以開始分析";
  }
  button.setAttribute("aria-disabled", canAnalyze ? "false" : "true");
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

  ["btnOpenLcms","btnLcms","btnOpenCompal","btnCompal"].forEach(id => {
    $(id).disabled = !ok;
  });

  if (!ok) {
    lcmsLoggedIn = false;
    compalLoggedIn = false;
  }
  updateAnalyzeAvailability();
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

async function cloudApi(path, options={}, timeoutMs=12000) {
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CLOUD_API + path, {
      ...options,
      signal: ctl.signal,
      headers:{
        "Content-Type":"application/json",
        ...(authToken ? {"Authorization":"Bearer " + authToken} : {}),
        ...(options.headers || {})
      }
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {error:raw}; }
    if (!res.ok) {
      const err = new Error(data.error || ("HTTP " + res.status));
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
  refreshMembership();
}

function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";
  const registering = authMode === "register";

  $("btnModeLogin").classList.toggle("active", !registering);
  $("btnModeRegister").classList.toggle("active", registering);
  $("authTitle").textContent = registering ? "建立 Email 帳號" : "Email 登入";
  $("authSubtitle").textContent = registering
    ? "註冊後需到信箱點擊驗證連結，完成後才能登入"
    : "請使用已完成信箱驗證的帳號登入";
  $("authPasswordConfirmWrap").classList.toggle("hidden", !registering);
  $("btnAuthSubmit").textContent = registering ? "註冊並寄送驗證信" : "登入";
  $("btnResendVerification").classList.toggle("hidden", !registering);
  $("authMessage").textContent = "";
}

function formatTaiwanDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date).replace(/\//g, "/");
}

async function refreshMembership() {
  if (!authToken) return;
  try {
    const data = await cloudApi("/usage/status");
    membership = data;
    const summary = $("membershipSummary");
    const badge = $("trialBadge");
    const pay = $("btnPay");

    if (data.subscription_active) {
      const expireText = formatTaiwanDateTime(data.subscription_until);
      summary.innerHTML = `
        <div class="plan-box plan-paid">
          <div class="plan-topline">
            <div>
              <div class="plan-name">月費會員</div>
              <div class="plan-subtitle">目前方案已啟用，可正常使用所有分析功能</div>
            </div>
            <span class="plan-status success">已啟用</span>
          </div>
          <div class="plan-meta">
            <div class="plan-meta-item">
              <span class="plan-meta-label">到期時間</span>
              <strong>${expireText}</strong>
            </div>
            <div class="plan-meta-item">
              <span class="plan-meta-label">使用權限</span>
              <strong>完整功能</strong>
            </div>
          </div>
        </div>
      `;
      badge.textContent = "付費會員";
      badge.className = "membership-pill paid";
      pay.classList.add("hidden");
    } else {
      const remain = Number(data.trial_remaining || 0);
      summary.innerHTML = remain > 0
        ? `
          <div class="plan-box plan-trial">
            <div class="plan-topline">
              <div>
                <div class="plan-name">免費試用</div>
                <div class="plan-subtitle">成功完成一次分析才會扣 1 次</div>
              </div>
              <span class="plan-status trial">試用中</span>
            </div>
            <div class="plan-meta">
              <div class="plan-meta-item">
                <span class="plan-meta-label">剩餘次數</span>
                <strong>${remain} 次</strong>
              </div>
              <div class="plan-meta-item">
                <span class="plan-meta-label">總試用次數</span>
                <strong>${Number(data.trial_limit || 3)} 次</strong>
              </div>
            </div>
          </div>
        `
        : `
          <div class="plan-box plan-expired">
            <div class="plan-topline">
              <div>
                <div class="plan-name">免費試用</div>
                <div class="plan-subtitle">免費次數已使用完畢，完成付款後即可繼續使用</div>
              </div>
              <span class="plan-status expired">已用完</span>
            </div>
            <div class="plan-meta">
              <div class="plan-meta-item">
                <span class="plan-meta-label">剩餘次數</span>
                <strong>0 次</strong>
              </div>
              <div class="plan-meta-item">
                <span class="plan-meta-label">下一步</span>
                <strong>升級付費方案</strong>
              </div>
            </div>
          </div>
        `;
      badge.textContent = "免費剩餘 " + remain + " 次";
      badge.className = remain > 0 ? "membership-pill trial" : "membership-pill expired";
      pay.classList.toggle("hidden", remain > 0);
    }
    updateAnalyzeAvailability();
  } catch (e) {
    membership = {can_analyze:false, trial_remaining:0, subscription_active:false};
    $("membershipSummary").textContent = "無法取得會員狀態：" + e.message;
    updateAnalyzeAvailability();
  }
}

async function loadCloudSession() {
  if (!authToken) {
    showLoginForm();
    return false;
  }

  try {
    currentUser = await cloudApi("/auth/me");
    showApp();
    await refreshMembership();
    return true;
  } catch (_) {
    authToken = "";
    currentUser = null;
    localStorage.removeItem("serviceConflictCloudToken");
    showLoginForm();
    return false;
  }
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

  if (!versionAtLeast(health.version, MIN_CONNECTOR_VERSION)) {
    showConnectorStep("outdated", health.version || "");
    return false;
  }

  showConnectorStep("ready", health.version || "");
  return await loadCloudSession();
}

async function submitAuth() {
  const email = $("authEmail").value.trim().toLowerCase();
  const password = $("authPassword").value;
  const confirm = $("authPasswordConfirm").value;
  $("authMessage").textContent = "";

  if (!email || !password) {
    $("authMessage").textContent = "請輸入 Email 及密碼";
    return;
  }

  if (authMode === "register") {
    if (password.length < 8) {
      $("authMessage").textContent = "密碼至少需要 8 個字元";
      return;
    }
    if (password !== confirm) {
      $("authMessage").textContent = "兩次輸入的密碼不一致";
      return;
    }

    $("btnAuthSubmit").disabled = true;
    $("btnAuthSubmit").textContent = "正在建立帳號…";
    try {
      const data = await cloudApi("/auth/register", {
        method:"POST",
        body:JSON.stringify({email, password})
      });
      $("authMessage").textContent = data.message || "驗證信已寄出，請到信箱完成驗證後再登入。";
      $("btnResendVerification").classList.remove("hidden");
    } catch (e) {
      $("authMessage").textContent = e.message;
    } finally {
      $("btnAuthSubmit").disabled = false;
      $("btnAuthSubmit").textContent = "註冊並寄送驗證信";
    }
    return;
  }

  $("btnAuthSubmit").disabled = true;
  $("btnAuthSubmit").textContent = "登入中…";
  try {
    const data = await cloudApi("/auth/login", {
      method:"POST",
      body:JSON.stringify({email, password})
    }, 15000);

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem("serviceConflictCloudToken", authToken);
    showApp();
    await ping(false);
    await refreshStatuses();
    await refreshMembership();
  } catch (e) {
    $("authMessage").textContent = e.message;
    if (e.code === "EMAIL_NOT_VERIFIED") {
      $("btnResendVerification").classList.remove("hidden");
    }
  } finally {
    $("btnAuthSubmit").disabled = false;
    $("btnAuthSubmit").textContent = "登入";
  }
}

async function resendVerification() {
  const email = $("authEmail").value.trim().toLowerCase();
  if (!email) {
    $("authMessage").textContent = "請先輸入 Email";
    return;
  }
  try {
    const data = await cloudApi("/auth/resend-verification", {
      method:"POST",
      body:JSON.stringify({email})
    });
    $("authMessage").textContent = data.message || "驗證信已重新寄出。";
  } catch (e) {
    $("authMessage").textContent = e.message;
  }
}

async function logout() {
  try {
    if (authToken) await cloudApi("/auth/logout", {method:"POST", body:"{}"});
  } catch (_) {}

  authToken = "";
  currentUser = null;
  membership = {can_analyze:false, trial_remaining:0, subscription_active:false};
  localStorage.removeItem("serviceConflictCloudToken");
  $("authPassword").value = "";
  $("authPasswordConfirm").value = "";
  showLoginForm();
}

async function startPayment() {
  if (!authToken) return;
  $("btnPay").disabled = true;
  $("btnPay").textContent = "建立付款單…";
  try {
    const data = await cloudApi("/billing/ecpay/create", {
      method:"POST",
      body:"{}"
    }, 15000);

    const form = document.createElement("form");
    form.method = "POST";
    form.action = data.action;
    form.style.display = "none";

    Object.entries(data.params || {}).forEach(([key, value]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = String(value);
      form.appendChild(input);
    });

    document.body.appendChild(form);
    form.submit();
  } catch (e) {
    alert("付款頁建立失敗：" + e.message);
    $("btnPay").disabled = false;
    $("btnPay").textContent = "前往綠界付款";
  }
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
    const [lcms, compal] = await Promise.all([
      api('/status/lcms', {}, 12000).catch(e => ({logged_in:false,message:e.message})),
      api('/status/compal', {}, 12000).catch(e => ({logged_in:false,message:e.message}))
    ]);

    lcmsLoggedIn = Boolean(lcms.logged_in);
    compalLoggedIn = Boolean(compal.logged_in);

    $('lcmsStatus').textContent = lcmsLoggedIn ? '✓ 已登入' : '✕ 尚未登入';
    $('compalStatus').textContent = compalLoggedIn ? '✓ 已登入' : '✕ 尚未登入';
    $('lcmsStatus').title = lcms.message || '';
    $('compalStatus').title = compal.message || '';

    const requiredBadge = $('requiredLcmsBadge');
    requiredBadge.textContent = lcmsLoggedIn ? '照管已就緒' : '照管必須登入';
    requiredBadge.className = lcmsLoggedIn ? 'mini-badge ready' : 'mini-badge required';

    updateAnalyzeAvailability();
  } catch (_) {
    lcmsLoggedIn = false;
    updateAnalyzeAvailability();
  }
}

async function uploadCaseList(file) {
  if (!(await ping(true))) return;

  const form = new FormData();
  form.append("file", file);

  $("caseListStatus").textContent = "正在讀取個案名單…";
  $("caseListPreview").classList.add("hidden");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);

  try {
    const res = await fetch(CONNECTOR + "/case-list/parse", {
      method:"POST",
      body:form,
      signal:ctl.signal,
      headers: authToken ? {"Authorization":"Bearer " + authToken} : {}
    });

    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {error:raw}; }

    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));

    uploadedCaseNames = Array.isArray(data.names) ? data.names : [];
    const count = uploadedCaseNames.length;

    $("caseListStatus").textContent = count
      ? "已載入 " + count + " 位個案"
      : "名單中沒有讀取到個案姓名";

    $("btnClearCaseList").classList.toggle("hidden", !count);

    if (count) {
      const preview = uploadedCaseNames.slice(0, 12).join("、");
      $("caseListPreview").textContent =
        preview + (count > 12 ? "……等 " + count + " 位" : "");
      $("caseListPreview").classList.remove("hidden");
      log("個案名單：已載入 " + count + " 位個案");
    }
  } catch (e) {
    uploadedCaseNames = [];
    $("caseListStatus").textContent = "名單讀取失敗";
    $("btnClearCaseList").classList.add("hidden");
    $("caseListPreview").classList.add("hidden");
    log("個案名單讀取失敗：" + e.message);
  } finally {
    clearTimeout(timer);
  }
}

function clearCaseList() {
  uploadedCaseNames = [];
  $("caseListInput").value = "";
  $("caseListStatus").textContent = "尚未上傳個案名單";
  $("caseListPreview").textContent = "";
  $("caseListPreview").classList.add("hidden");
  $("btnClearCaseList").classList.add("hidden");
}

function updateSourceMode() {
  const useExcel = $("sourceExcel").checked;
  $("excelSourcePanel").classList.toggle("hidden", !useExcel);
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
    if (system === "lcms") {
      lcmsLoggedIn = false;
      updateAnalyzeAvailability();
    }
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

    if (system === "lcms") {
      lcmsLoggedIn = Boolean(data.logged_in);
      const requiredBadge = $("requiredLcmsBadge");
      if (requiredBadge) {
        requiredBadge.textContent = lcmsLoggedIn ? "照管已就緒" : "照管必須登入";
        requiredBadge.className = lcmsLoggedIn ? "mini-badge ready" : "mini-badge required";
      }
      updateAnalyzeAvailability();
    } else {
      compalLoggedIn = Boolean(data.logged_in);
    }

    log(`${label}：${data.message}`);
  } catch(e) {
    target.textContent = "檢查失敗";
    if (system === "lcms") {
      lcmsLoggedIn = false;
      updateAnalyzeAvailability();
    } else {
      compalLoggedIn = false;
    }
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

  await refreshMembership();
  if (!membership.can_analyze) {
    alert("免費試用已使用完畢，請先完成付款。");
    return;
  }

  if (!lcmsLoggedIn) {
    alert("請先登入照管，並確認照管狀態為「已登入」。");
    return;
  }

  const sourceMode = $("sourceExcel").checked ? "excel" : "compal";

  if (sourceMode === "compal") {
    const compal = await api("/status/compal", {}, 12000).catch(e => ({
      logged_in:false,
      message:e.message
    }));
    compalLoggedIn = Boolean(compal.logged_in);
    $("compalStatus").textContent = compalLoggedIn ? "✓ 已登入" : "✕ 尚未登入";
    if (!compalLoggedIn) {
      alert("目前選擇「使用仁寶」，請先登入仁寶後再進行分析。");
      return;
    }
  } else if (!uploadedCaseNames.length) {
    alert("目前選擇「上傳個案名單」，請先上傳個案名單。");
    return;
  }

  const monthly = $("modeMonth").checked;
  const payload = monthly
    ? {mode:"month", month:$("monthInput").value, source:sourceMode, case_names:uploadedCaseNames}
    : {mode:"day", date:$("dateInput").value, source:sourceMode, case_names:uploadedCaseNames};

  if ((monthly && !payload.month) || (!monthly && !payload.date)) {
    $("summary").textContent = monthly ? "請先選擇月份" : "請先選擇日期";
    return;
  }

  let permitToken = "";
  try {
    const permit = await cloudApi("/usage/begin", {method:"POST", body:"{}"});
    permitToken = permit.permit_token;

    const targetText = sourceMode === "compal"
      ? "（個案來源：仁寶）"
      : "（個案來源：已上傳 " + uploadedCaseNames.length + " 位個案）";

    $("summary").textContent = monthly
      ? "正在查詢整月份照管服務紀錄 " + targetText + "，資料較多請稍候…"
      : "正在查詢照管服務紀錄 " + targetText + "…";
    $("results").innerHTML = "";

    const data = await api(
      "/services",
      {method:"POST", body:JSON.stringify(payload)},
      monthly ? 600000 : 180000
    );

    await cloudApi("/usage/complete", {
      method:"POST",
      body:JSON.stringify({permit_token:permitToken, success:true})
    });

    log("照管 QD120A：取得 " + data.rows.length + " 筆服務資料");
    renderServerAnalysis(data);
    await refreshMembership();
  } catch(e) {
    if (permitToken) {
      try {
        await cloudApi("/usage/complete", {
          method:"POST",
          body:JSON.stringify({permit_token:permitToken, success:false})
        });
      } catch (_) {}
    }
    $("summary").textContent = "抓取失敗";
    $("results").innerHTML = '<div class="conflict"><strong>抓取失敗</strong><br>' + e.message + '</div>';
    log("分析失敗：" + e.message);
    await refreshMembership();
  }
}

$("btnOpenLcms").onclick = ()=>openLogin("lcms");
$("btnLcms").onclick = ()=>checkLogin("lcms");
$("btnOpenCompal").onclick = ()=>openLogin("compal");
$("btnCompal").onclick = ()=>checkLogin("compal");
$("sourceCompal").addEventListener("change", updateSourceMode);
$("sourceExcel").addEventListener("change", updateSourceMode);
$("caseListInput").addEventListener("change", e => {
  const file = e.target.files && e.target.files[0];
  if (file) uploadCaseList(file);
});
$("btnClearCaseList").onclick = clearCaseList;
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
updateSourceMode();

$("btnAuthSubmit").onclick = submitAuth;
$("btnModeLogin").onclick = ()=>setAuthMode("login");
$("btnModeRegister").onclick = ()=>setAuthMode("register");
$("btnResendVerification").onclick = resendVerification;
$("authPassword").addEventListener("keydown", e => {
  if (e.key === "Enter") submitAuth();
});
$("authPasswordConfirm").addEventListener("keydown", e => {
  if (e.key === "Enter") submitAuth();
});
$("btnAuthRetryConnector").onclick = bootstrapAuthFlow;
$("btnLogout").onclick = logout;
$("btnPay").onclick = startPayment;
$("btnAdmin").onclick = ()=>{ window.location.href = "./admin.html"; };
setAuthMode("login");

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
        await loadCloudSession();
      }
    } catch (_) {}
    return;
  }

  if (!authToken) return;
  const ok = await ping(true);
  if (ok) await refreshStatuses();
}, 5000);
