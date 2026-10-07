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
            ${currentUser && String(currentUser.email).toLowerCase() === String(u.email).toLowerCase()
              ? '<button class="admin-action-btn delete-user disabled" type="button" disabled title="不可刪除目前登入中的管理者帳號">刪除</button>'
              : '<button class="admin-action-btn delete-user" data-action="delete" data-id="' + u.id + '" data-email="' + esc(u.email) + '">刪除</button>'}
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
        } else if (btn.dataset.action === "delete") {
          const email = btn.dataset.email || "這個使用者";
          const ok = confirm(
            "確定要刪除使用者？\n\n" +
            email +
            "\n\n刪除後將一併移除此帳號的登入資料、驗證資料、試用紀錄與付款紀錄，且無法復原。"
          );
          if (!ok) return;
          await api("/admin/users/" + id, {method:"DELETE"});
        }
        await Promise.all([loadUsers(), loadPayments()]);
      } catch (e) {
        alert(e.message);
      }
    };
  });
}


async function loadPayments() {
  const data = await api("/admin/payments");
  const payments = Array.isArray(data.payments) ? data.payments : [];

  $("paymentCount").textContent = payments.length;
  $("paymentPaidCount").textContent = payments.filter(p => p.status === "paid").length;
  $("paymentPendingCount").textContent = payments.filter(p => p.status !== "paid").length;

  $("paymentRows").innerHTML = payments.length ? payments.map(p => {
    const paid = p.status === "paid";
    return `
      <tr>
        <td class="payment-time-cell">${esc(formatAdminDate(p.created_at))}</td>
        <td>
          <strong>${esc(p.email || "-")}</strong>
          <div class="admin-row-sub">User ID #${esc(p.user_id)}</div>
        </td>
        <td><strong>NT${esc(p.amount)}</strong></td>
        <td>
          <div class="payment-order-cell">
            <code>${esc(p.merchant_trade_no)}</code>
            <button class="copy-order-btn" type="button" data-copy-order="${esc(p.merchant_trade_no)}">複製</button>
          </div>
        </td>
        <td><code>${esc(p.trade_no || "-")}</code></td>
        <td>
          <span class="payment-status-badge ${paid ? "paid" : "pending"}">
            ${paid ? "已付款" : "待付款／未回呼"}
          </span>
        </td>
        <td>${esc(p.paid_at ? formatAdminDate(p.paid_at) : "-")}</td>
      </tr>
    `;
  }).join("") : '<tr><td colspan="7" class="payment-empty">目前尚無付款紀錄</td></tr>';

  document.querySelectorAll("[data-copy-order]").forEach(btn => {
    btn.onclick = async () => {
      const value = btn.dataset.copyOrder || "";
      try {
        await navigator.clipboard.writeText(value);
        const old = btn.textContent;
        btn.textContent = "已複製";
        setTimeout(() => { btn.textContent = old; }, 1200);
      } catch (_) {
        window.prompt("請複製商店訂單編號：", value);
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
$("btnRefreshPayments").onclick = loadPayments;
$("btnAdminLogout").onclick = async ()=>{
  try { await api("/auth/logout", {method:"POST", body:"{}"}); } catch (_) {}
  localStorage.removeItem("serviceConflictCloudToken");
  window.location.href = "./";
};
init();
