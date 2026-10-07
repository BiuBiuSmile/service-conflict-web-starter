const $ = (id) => document.getElementById(id);
const CLOUD_API = String(
  (window.SERVICE_CONFLICT_CONFIG && window.SERVICE_CONFLICT_CONFIG.apiBase) ||
  "http://127.0.0.1:5001"
).replace(/\/$/, "");

let authToken = localStorage.getItem("serviceConflictCloudToken") || "";
let currentUser = null;

async function api(path, options={}, timeoutMs=10000) {
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), timeoutMs);
  try {
    const res = await fetch(CLOUD_API + path, {
      ...options,
      signal:ctl.signal,
      headers:{
        "Content-Type":"application/json",
        ...(authToken ? {"Authorization":"Bearer " + authToken} : {}),
        ...(options.headers || {})
      }
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = {error:raw}; }
    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"]/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"
  }[c]));
}

function formatAdminDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

async function loadUsers() {
  const data = await api("/admin/users");
  const users = Array.isArray(data.users) ? data.users : [];
  $("memberCount").textContent = users.length;
  $("paidCount").textContent = users.filter(u => u.subscription_active).length;
  $("trialCount").textContent = users.filter(u => !u.subscription_active && Number(u.trial_remaining || 0) > 0).length;

  $("userRows").innerHTML = users.map(u => {
    const trialUsed = Number(u.trial_used || 0);
    const trialLimit = Number(u.trial_limit || 3);
    const trialRemaining = Number(u.trial_remaining || 0);
    const trialClass = trialRemaining > 0 ? "trial-active" : "trial-used";
    const roleText = u.role === "admin" ? "管理者" : "一般會員";
    const paidText = u.subscription_active ? formatAdminDate(u.subscription_until) : "-";

    return `
      <tr>
        <td class="admin-email-cell">
          <div class="admin-user-avatar">${esc((u.email || "?").slice(0,1).toUpperCase())}</div>
          <div>
            <strong>${esc(u.email)}</strong>
            <div class="admin-row-sub">ID #${u.id}</div>
          </div>
        </td>
        <td>
          <span class="admin-status-badge ${u.email_verified ? "verified" : "pending"}">
            ${u.email_verified ? "✓ 已驗證" : "待驗證"}
          </span>
        </td>
        <td>
          <div class="trial-progress">
            <div class="trial-progress-top">
              <span>${trialUsed}/${trialLimit}</span>
              <span class="${trialClass}">剩 ${trialRemaining}</span>
            </div>
            <div class="trial-progress-track">
              <div class="trial-progress-fill" style="width:${Math.min(100, Math.max(0, (trialUsed / Math.max(1, trialLimit)) * 100))}%"></div>
            </div>
          </div>
        </td>
        <td>
          <div class="admin-date-cell">
            <strong>${esc(paidText)}</strong>
            <span>${u.subscription_active ? "付費方案有效" : "尚未付費"}</span>
          </div>
        </td>
        <td>
          <span class="admin-role-badge ${u.role === "admin" ? "admin" : "user"}">${roleText}</span>
        </td>
        <td>
          <span class="admin-account-badge ${u.enabled ? "enabled" : "disabled"}">
            ${u.enabled ? "啟用" : "停用"}
          </span>
        </td>
        <td>
          <div class="admin-action-group">
            <button class="admin-action-btn ${u.enabled ? "danger-soft" : "success-soft"}" data-action="toggle" data-id="${u.id}" data-enabled="${u.enabled}">
              ${u.enabled ? "停用" : "啟用"}
            </button>
            <button class="admin-action-btn" data-action="trial" data-id="${u.id}">重設試用</button>
            <button class="admin-action-btn primary-soft" data-action="days" data-id="${u.id}">加會員天數</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  document.querySelectorAll("[data-action]").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      try {
        if (btn.dataset.action === "toggle") {
          await api("/admin/users/" + id, {
            method:"PATCH",
            body:JSON.stringify({enabled:btn.dataset.enabled !== "true"})
          });
        } else if (btn.dataset.action === "trial") {
          await api("/admin/users/" + id, {
            method:"PATCH",
            body:JSON.stringify({trial_used:0})
          });
        } else if (btn.dataset.action === "days") {
          const days = parseInt(prompt("要增加幾天會員期限？", "30"), 10);
          if (!days) return;
          await api("/admin/users/" + id, {
            method:"PATCH",
            body:JSON.stringify({subscription_days:days})
          });
        }
        await loadUsers();
      } catch (e) {
        alert(e.message);
      }
    };
  });
}

async function init() {
  try {
    currentUser = await api("/auth/me");
    if (currentUser.role !== "admin") throw new Error("目前帳號沒有管理者權限");
    $("adminContent").classList.remove("hidden");
    await loadUsers();
  } catch (e) {
    $("adminDenied").classList.remove("hidden");
    $("adminDeniedText").textContent = e.message || "請先登入管理者帳號。";
  }
}

$("btnBack").onclick = ()=>{ window.location.href = "./"; };
$("btnRefreshUsers").onclick = loadUsers;
$("btnAdminLogout").onclick = async ()=>{
  try { await api("/auth/logout", {method:"POST", body:"{}"}); } catch (_) {}
  localStorage.removeItem("serviceConflictCloudToken");
  window.location.href = "./";
};
init();
