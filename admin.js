const CONNECTOR = "http://127.0.0.1:8765";
const $ = (id) => document.getElementById(id);

let authToken = sessionStorage.getItem("serviceConflictToken") || "";
let currentUser = null;

async function api(path, options={}, timeoutMs=5000) {
  const ctl = new AbortController();
  const timer = setTimeout(()=>ctl.abort(), timeoutMs);

  try {
    const res = await fetch(CONNECTOR + path, {
      ...options,
      signal:ctl.signal,
      headers:{
        "Content-Type":"application/json",
        ...(authToken ? {"Authorization":"Bearer " + authToken} : {}),
        ...(options.headers || {})
      }
    });

    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {error:text}; }

    if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function esc(v) {
  return String(v ?? "").replace(/[&<>\"]/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"
  }[c]));
}

async function loadUsers() {
  const data = await api("/admin/users");
  $("userRows").innerHTML = data.users.map(u => {
    const self = currentUser && u.username === currentUser.username;
    return `
      <tr>
        <td><strong>${esc(u.username)}</strong>${self ? "（目前帳號）" : ""}</td>
        <td>
          <select class="user-role" data-user="${esc(u.username)}" ${self ? "disabled" : ""}>
            <option value="user" ${u.role === "user" ? "selected" : ""}>一般使用者</option>
            <option value="admin" ${u.role === "admin" ? "selected" : ""}>管理者</option>
          </select>
        </td>
        <td>${u.enabled ? "啟用" : "停用"}</td>
        <td>${esc(u.created_at || "")}</td>
        <td>
          <div class="btn-group">
            <button class="btn-toggle-user" data-user="${esc(u.username)}" data-enabled="${u.enabled}" ${self ? "disabled" : ""}>
              ${u.enabled ? "停用" : "啟用"}
            </button>
            <button class="btn-reset-user" data-user="${esc(u.username)}">重設密碼</button>
            <button class="btn-delete-user danger-btn" data-user="${esc(u.username)}" ${self ? "disabled" : ""}>刪除</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  document.querySelectorAll(".user-role").forEach(el => {
    el.onchange = async ()=>{
      try {
        await api("/admin/users/" + encodeURIComponent(el.dataset.user), {
          method:"PATCH",
          body:JSON.stringify({role:el.value})
        });
        await loadUsers();
      } catch(e) { alert(e.message); }
    };
  });

  document.querySelectorAll(".btn-toggle-user").forEach(el => {
    el.onclick = async ()=>{
      try {
        await api("/admin/users/" + encodeURIComponent(el.dataset.user), {
          method:"PATCH",
          body:JSON.stringify({enabled:el.dataset.enabled !== "true"})
        });
        await loadUsers();
      } catch(e) { alert(e.message); }
    };
  });

  document.querySelectorAll(".btn-reset-user").forEach(el => {
    el.onclick = async ()=>{
      const password = prompt("請輸入新密碼（至少 8 個字元）");
      if (!password) return;
      try {
        await api("/admin/users/" + encodeURIComponent(el.dataset.user), {
          method:"PATCH",
          body:JSON.stringify({password})
        });
        alert("密碼已更新");
      } catch(e) { alert(e.message); }
    };
  });

  document.querySelectorAll(".btn-delete-user").forEach(el => {
    el.onclick = async ()=>{
      if (!confirm("確定要刪除帳號「" + el.dataset.user + "」嗎？")) return;
      try {
        await api("/admin/users/" + encodeURIComponent(el.dataset.user), {
          method:"DELETE"
        });
        await loadUsers();
      } catch(e) { alert(e.message); }
    };
  });
}

async function init() {
  try {
    currentUser = await api("/auth/me");
    if (currentUser.role !== "admin") {
      $("adminDenied").classList.remove("hidden");
      $("adminDeniedText").textContent = "目前帳號沒有管理者權限。";
      return;
    }

    $("adminContent").classList.remove("hidden");
    await loadUsers();
  } catch(e) {
    $("adminDenied").classList.remove("hidden");
    $("adminDeniedText").textContent = "請先回主系統登入管理者帳號。";
  }
}

$("btnBack").onclick = ()=>{ window.location.href = "./"; };
$("btnRefreshUsers").onclick = loadUsers;
$("btnCreateUser").onclick = async ()=>{
  $("adminMessage").textContent = "";
  try {
    await api("/admin/users", {
      method:"POST",
      body:JSON.stringify({
        username:$("newUsername").value.trim(),
        password:$("newPassword").value,
        role:$("newRole").value
      })
    });
    $("newUsername").value = "";
    $("newPassword").value = "";
    $("adminMessage").textContent = "帳號已新增";
    await loadUsers();
  } catch(e) {
    $("adminMessage").textContent = e.message;
  }
};

$("btnAdminLogout").onclick = async ()=>{
  try { await api("/auth/logout", {method:"POST", body:"{}"}); } catch (_) {}
  sessionStorage.removeItem("serviceConflictToken");
  window.location.href = "./";
};

init();