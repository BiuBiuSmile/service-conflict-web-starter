const CONNECTOR = "http://127.0.0.1:8765";
const $ = (id) => document.getElementById(id);

let connectorOnline = false;
let lastLogKey = "";

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
    badge.textContent = version ? `Connector 已連線 v${version}` : "Connector 已連線";
    badge.className = "badge good";
    panel.classList.add("hidden");
  } else {
    badge.textContent = "Connector 未連線";
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
      headers: {"Content-Type":"application/json", ...(options.headers||{})}
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function ping(silent=false) {
  try {
    const data = await api("/health", {}, 1800);
    setConnectorState(true, data.version || "");
    if (!silent) log("本機 Connector 連線成功", "ping-ok");
    return true;
  } catch (e) {
    setConnectorState(false);
    if (!silent) log("尚未偵測到 Connector。請先下載並開啟 Windows 連線器。", "ping-fail");
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
  $('summary').textContent = '共讀取 ' + (stats.total_services ?? rows.length) + ' 筆服務，掃描 ' + (stats.cases_scanned ?? 0) + ' 位個案，發現 ' + (stats.total_issues ?? issues.length) + ' 筆異常。';
  if (!issues.length) {
    $('results').innerHTML = '<div class="conflict ok"><strong>未發現服務重疊、居服員撞班或規則異常。</strong></div>';
    return;
  }
  const esc = (v) => String(v ?? '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
  $('results').innerHTML = issues.map(x => {
    if (x.type === 'case_overlap') {
      return '<div class="conflict"><strong>' + esc(x.title) + '</strong>｜' + esc(x.client) + '｜' + esc(x.date) + '｜重疊 ' + esc(x.minutes) + ' 分鐘<br>A：' + esc(x.a.unit) + '／' + esc(x.a.worker) + '／' + esc(x.a.title) + '／' + esc(x.a.start) + '-' + esc(x.a.end) + '<br>B：' + esc(x.b.unit) + '／' + esc(x.b.worker) + '／' + esc(x.b.title) + '／' + esc(x.b.start) + '-' + esc(x.b.end) + '</div>';
    }
    if (x.type === 'staff_overlap') {
      return '<div class="conflict"><strong>居服員撞班：' + esc(x.worker) + '</strong>｜' + esc(x.date) + '｜重疊 ' + esc(x.minutes) + ' 分鐘<br>A：' + esc(x.a.unit) + '／' + esc(x.a.client) + '／' + esc(x.a.title) + '／' + esc(x.a.start) + '-' + esc(x.a.end) + '<br>B：' + esc(x.b.unit) + '／' + esc(x.b.client) + '／' + esc(x.b.title) + '／' + esc(x.b.start) + '-' + esc(x.b.end) + '</div>';
    }
    return '<div class="conflict"><strong>' + esc(x.title) + '</strong>｜' + esc(x.client || '') + '｜' + esc(x.date || '') + '<br>' + esc(x.detail || '') + '</div>';
  }).join('');
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

async function analyze() {
  if (!(await ping(true))) return;
  const date = $('dateInput').value;
  try {
    $('summary').textContent = '正在查詢照管個案與 QD120A 服務紀錄…';
    $('results').innerHTML = '';
    const data = await api('/services', {method:'POST', body: JSON.stringify({date})}, 180000);
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
    log("Connector 未啟動，已載入前端示範資料");
    return;
  }
  const data = await api("/demo");
  render(data.rows);
  log("已載入示範資料");
};

$("dateInput").value = new Date().toISOString().slice(0,10);

setConnectorState(false);
ping(false);

// 安裝後不需手動重整，網頁每 3 秒自動確認 Connector 是否已啟動。
setInterval(async ()=>{ const ok = await ping(true); if (ok) await refreshStatuses(); }, 5000);
