// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtTime = (unix) => new Date((unix || 0) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

// ---------- tabs ----------
const tabs = document.querySelectorAll("nav button");
tabs.forEach((b) =>
  b.addEventListener("click", () => {
    tabs.forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $("tab-" + b.dataset.tab).classList.add("active");
    onTab(b.dataset.tab);
  })
);
function onTab(name) {
  if (name === "users") loadRoster();
  if (name === "chat") { loadFeed(true); startFeedPolling(); } else stopFeedPolling();
  if (name === "members") loadMembers();
  if (name === "settings") loadSettings();
}

// ---------- status pill ----------
async function refreshStatus() {
  try {
    const s = await api("/api/settings");
    const pill = $("statusPill"), txt = $("statusText");
    if (s.polling && s.chatId) { pill.classList.add("on"); txt.textContent = `@${s.botUsername} · live`; }
    else if (s.hasToken) { pill.classList.remove("on"); txt.textContent = `@${s.botUsername || "bot"} · no group`; }
    else { pill.classList.remove("on"); txt.textContent = "not connected"; }
    return s;
  } catch { return null; }
}

// ---------- USERS: upload + verify + roster ----------
const HEADER_WORDS = new Set(["username","usernames","handle","handles","name","names","user","users"]);
function parseTokens(text) { return text.split(/[\r\n,;\t ]+/).map((s) => s.trim()).filter(Boolean); }
function splitCsvLine(line) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur); return out;
}
function parseCsvSingleColumn(text) {
  const lines = text.split(/\r?\n/); const values = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const f = splitCsvLine(lines[i]);
    while (f.length && f[f.length - 1].trim() === "") f.pop();
    if (f.length > 1) return { badLine: i + 1, badCols: f.length };
    values.push((f[0] || "").trim());
  }
  return { values };
}
function setFileMsg(t, err) { $("fileName").textContent = t; $("fileName").style.color = err ? "var(--warn)" : ""; }
function currentUsernames() {
  const seen = new Set(), list = [];
  for (const t of parseTokens($("uInput").value)) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); list.push(t); } }
  return list;
}
function refreshCount() { const n = currentUsernames().length; $("uCount").textContent = `${n} username${n === 1 ? "" : "s"} ready`; }

$("uInput").addEventListener("input", refreshCount);
$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const text = await file.text();
  const isCsv = /\.csv$/i.test(file.name) || file.type === "text/csv";
  let tokens;
  if (isCsv) {
    const p = parseCsvSingleColumn(text);
    if (p.badLine) { setFileMsg(`${file.name} — rejected: line ${p.badLine} has ${p.badCols} columns. CSV must be one column.`, true); e.target.value = ""; return; }
    tokens = p.values.filter(Boolean);
  } else tokens = parseTokens(text);
  if (tokens.length && HEADER_WORDS.has(tokens[0].toLowerCase())) tokens.shift();
  if (!tokens.length) { setFileMsg(`${file.name} — no usernames found.`, true); e.target.value = ""; return; }
  const existing = $("uInput").value.trim();
  $("uInput").value = (existing ? existing + "\n" : "") + tokens.join("\n");
  setFileMsg(`${file.name} — added ${tokens.length}`, false); refreshCount(); e.target.value = "";
});
$("uClear").addEventListener("click", () => { $("uInput").value = ""; $("uResults").innerHTML = ""; setFileMsg("CSV must be a single column · .txt one per line", false); refreshCount(); });

$("uGo").addEventListener("click", async () => {
  const usernames = currentUsernames();
  if (!usernames.length) { toast("Enter or upload at least one username."); return; }
  const btn = $("uGo"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Verifying…`;
  const out = $("uResults"); out.innerHTML = "";
  try {
    const all = [];
    for (let i = 0; i < usernames.length; i += 50) {
      const { results } = await api("/api/users/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: usernames.slice(i, i + 50) }),
      });
      all.push(...results); renderCheck(all);
    }
    const added = all.filter((r) => r.saved).length;
    toast(`${added} verified and added to roster.`);
    loadRoster();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = "Verify & add"; }
});
function renderCheck(results) {
  const LABEL = { taken: "Registered", available: "Not found", invalid: "Invalid", error: "Error" };
  $("uResults").innerHTML = results.map((r) => `
    <div class="result d-${r.status}">
      <span class="dot"></span>
      <div><div style="font-weight:600">${esc(r.displayName || r.username || r.input)}</div>
      <div class="meta">${r.status === "taken" ? "@" + esc(r.username) + (r.saved ? " · saved" : "") : esc(r.detail || "@" + r.username)}</div></div>
      <span class="badge b-${r.status === "taken" ? "verified" : r.status}">${LABEL[r.status] || r.status}</span>
    </div>`).join("");
}

async function loadRoster() {
  try {
    const { users } = await api("/api/users");
    const wrap = $("rosterWrap");
    if (!users.length) { wrap.innerHTML = `<p class="hint">No users yet — verify some above.</p>`; return; }
    wrap.innerHTML = `<table><thead><tr><th>Username</th><th>Name</th><th>Status</th><th>In group</th><th></th></tr></thead><tbody>${
      users.map((u) => `<tr>
        <td><a href="https://t.me/${esc(u.username)}" target="_blank">@${esc(u.username)}</a></td>
        <td>${esc(u.display_name || "—")}</td>
        <td><span class="badge b-${u.status}">${esc(u.status)}</span></td>
        <td>${u.in_group ? "✅" : "—"}</td>
        <td style="text-align:right"><a class="ghost tiny" style="text-decoration:none" href="https://t.me/${esc(u.username)}" target="_blank">Message</a>
        <button class="ghost tiny danger" data-del="${u.id}">Remove</button></td>
      </tr>`).join("")
    }</tbody></table>`;
    wrap.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      await api(`/api/users/${b.dataset.del}`, { method: "DELETE" }); loadRoster();
    }));
  } catch (e) { $("rosterWrap").innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

// ---------- GROUP CHAT ----------
let lastMsgId = 0, feedTimer = null;
async function loadFeed(reset) {
  const s = await refreshStatus();
  const banner = $("chatBanner");
  if (!s || !s.hasToken) { banner.innerHTML = `<div class="banner warn">No bot connected yet — set it up in <b>Settings</b>.</div>`; }
  else if (!s.chatId) { banner.innerHTML = `<div class="banner warn">Bot connected, but no group chosen. Add it to your group as admin, then pick the group in <b>Settings</b>.</div>`; }
  else { banner.innerHTML = `<div class="banner ok">Live: mirroring your group via @${esc(s.botUsername)}.</div>`; }

  try {
    if (reset) { lastMsgId = 0; $("feed").innerHTML = ""; }
    const { messages } = await api("/api/group/messages" + (lastMsgId ? `?sinceId=${lastMsgId}` : ""));
    if (reset && !messages.length) { $("feed").innerHTML = `<p class="hint">No messages yet.</p>`; return; }
    if (messages.length && $("feed").querySelector(".hint")) $("feed").innerHTML = "";
    const atBottom = isFeedAtBottom();
    for (const m of messages) { appendMsg(m); lastMsgId = Math.max(lastMsgId, m.id); }
    if (atBottom) scrollFeed();
  } catch (e) { /* keep quiet during polling */ }
}
function isFeedAtBottom() { const f = $("feed"); return f.scrollHeight - f.scrollTop - f.clientHeight < 60; }
function scrollFeed() { const f = $("feed"); f.scrollTop = f.scrollHeight; }
function appendMsg(m) {
  const f = $("feed");
  if (m.kind === "join" || m.kind === "leave") {
    const d = document.createElement("div"); d.className = "msg svc";
    d.textContent = `${m.from_name || "Someone"} ${m.kind === "join" ? "joined" : "left"}`;
    f.appendChild(d); return;
  }
  const mine = m.via === "interface";
  const el = document.createElement("div");
  el.className = "msg" + (mine ? " me" : "");
  el.innerHTML = `<div class="who">${esc(m.from_name || m.from_username || "Unknown")}</div>
    <div class="txt">${esc(m.text)}</div><div class="time">${fmtTime(m.date)}</div>`;
  f.appendChild(el);
}
function startFeedPolling() { stopFeedPolling(); feedTimer = setInterval(() => loadFeed(false), 3000); }
function stopFeedPolling() { if (feedTimer) clearInterval(feedTimer); feedTimer = null; }

async function sendGroup() {
  const input = $("sendInput"); const text = input.value.trim(); if (!text) return;
  $("sendBtn").disabled = true;
  try { await api("/api/group/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    input.value = ""; await loadFeed(false); scrollFeed();
  } catch (e) { toast(e.message); }
  finally { $("sendBtn").disabled = false; }
}
$("sendBtn").addEventListener("click", sendGroup);
$("sendInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendGroup(); });
$("inviteBtn").addEventListener("click", async () => {
  try { const { link } = await api("/api/group/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await navigator.clipboard.writeText(link).catch(() => {}); toast("Invite link copied: " + link);
  } catch (e) { toast(e.message); }
});

// ---------- MEMBERS ----------
async function loadMembers() {
  try {
    const { members } = await api("/api/members");
    const wrap = $("membersWrap");
    if (!members.length) { wrap.innerHTML = `<p class="hint">No members seen yet. The bot records people as they post or join.</p>`; return; }
    wrap.innerHTML = `<table><thead><tr><th>Member</th><th>Username</th><th>Msgs</th><th>Status</th><th></th></tr></thead><tbody>${
      members.map((m) => `<tr>
        <td>${esc(m.display_name || "—")}${m.is_bot ? ' <span class="hint">(bot)</span>' : ""}</td>
        <td>${m.username ? `<a href="https://t.me/${esc(m.username)}" target="_blank">@${esc(m.username)}</a>` : "—"}</td>
        <td>${m.msg_count}</td>
        <td><span class="badge b-${m.status}">${esc(m.status)}</span></td>
        <td style="text-align:right">
          ${m.status === "banned"
            ? `<button class="ghost tiny" data-unban="${m.tg_user_id}">Unban</button>`
            : `<button class="ghost tiny" data-kick="${m.tg_user_id}">Kick</button>
               <button class="ghost tiny danger" data-ban="${m.tg_user_id}">Ban</button>`}
        </td></tr>`).join("")
    }</tbody></table>`;
    const act = (sel, path, msg) => wrap.querySelectorAll(sel).forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.ban || b.dataset.kick || b.dataset.unban;
      b.disabled = true;
      try { await api(`/api/members/${id}/${path}`, { method: "POST" }); toast(msg); loadMembers(); }
      catch (e) { toast(e.message); b.disabled = false; }
    }));
    act("[data-ban]", "ban", "Member banned.");
    act("[data-kick]", "kick", "Member removed (can rejoin).");
    act("[data-unban]", "unban", "Member unbanned.");
  } catch (e) { $("membersWrap").innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

// ---------- SETTINGS ----------
async function loadSettings() {
  const s = await refreshStatus(); if (!s) return;
  $("tokenInput").placeholder = s.tokenMasked ? s.tokenMasked + " (saved — leave blank to keep)" : "123456:ABC-...";
  $("tokenState").textContent = s.hasToken ? `Connected as @${s.botUsername}${s.lastError ? " · last error: " + s.lastError : ""}` : "No token saved yet.";
  if (s.chatId) $("chatInput").value = s.chatId;
  const det = $("detected");
  if (s.detectedChats?.length) {
    det.innerHTML = s.detectedChats.map((c) => `<button class="ghost tiny" data-chat="${esc(c.id)}">${esc(c.title)} (${esc(c.id)})</button>`).join(" ");
    det.querySelectorAll("[data-chat]").forEach((b) => b.addEventListener("click", () => { $("chatInput").value = b.dataset.chat; }));
  } else det.textContent = "none yet";
}
$("saveSettings").addEventListener("click", async () => {
  const token = $("tokenInput").value.trim();
  const chatId = $("chatInput").value.trim();
  const body = {}; if (token) body.token = token; if (chatId) body.chatId = chatId;
  if (!Object.keys(body).length) { toast("Nothing to save."); return; }
  const btn = $("saveSettings"); btn.disabled = true; $("settingsMsg").textContent = "Connecting…";
  try {
    await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    $("tokenInput").value = ""; $("settingsMsg").textContent = "Saved.";
    toast("Connected."); loadSettings(); refreshStatus();
  } catch (e) { $("settingsMsg").textContent = ""; toast(e.message); }
  finally { btn.disabled = false; }
});

// ---------- boot ----------
refreshStatus();
loadRoster();
setInterval(refreshStatus, 15000);
