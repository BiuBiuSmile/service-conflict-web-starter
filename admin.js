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

async function loadUsers() {
  const data = await api("/admin/users");
  $("userRows").innerHTML = data.users.map(u => `
    <tr>
      <td><strong>${esc(u.email)}</strong></td>
      <td>${u.email_verified ? "✓ 已驗證" : "待驗證"}</td>
      <td>${u.trial_used}/${u.trial_limit}</td>
      <td>${esc(u.subscription_until || "-")}</td>
      <td>${esc(u.role)}</td>
      <td>${u.enabled ? "啟用" : "停用"}</td>
      <td>
        <div class="btn-group">
          <button data-action="toggle" data-id="${u.id}" data-enabled="${u.enabled}">
            ${u.enabled ? "停用" : "啟用"}
          </button>
          <button data-action="trial" data-id="${u.id}">重設試用</button>
          <button data-action="days" data-id="${u.id}">加會員天數</button>
        </div>
      </td>
    </tr>
  `).join("");

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
