import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./db.js";
import * as tg from "./telegram.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---------------------------------------------------------------
const MAX_BATCH = 50;
const REQUEST_TIMEOUT_MS = 8000;
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

// =========================================================================
// Public username verification (no bot token needed)
// =========================================================================
function normalizeUsername(raw) {
  let u = String(raw).trim();
  if (!u) return "";
  u = u.replace(/^https?:\/\//i, "");
  u = u.replace(/^(www\.)?t(elegram)?\.me\//i, "");
  u = u.replace(/^@/, "");
  u = u.split(/[/?#]/)[0];
  return u;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function checkUsername(rawInput) {
  const username = normalizeUsername(rawInput);
  if (!USERNAME_RE.test(username)) {
    return { input: rawInput, username, status: "invalid",
      detail: "Not a valid Telegram username (5–32 chars, letters/digits/underscore, must start with a letter)." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`https://t.me/${encodeURIComponent(username)}`, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en",
      },
    });
    const html = await res.text();
    const exists = html.includes("tgme_page_title");
    if (!exists) return { input: rawInput, username, status: "available" };

    const nameMatch = html.match(/tgme_page_title[^>]*>\s*<span[^>]*>([^<]+)<\/span>/i);
    const displayName = nameMatch ? decodeEntities(nameMatch[1].trim()) : null;
    let type = "user";
    if (/tgme_page_extra[^>]*>[^<]*(subscriber|member)/i.test(html)) type = "channel/group";
    else if (/<div class="tgme_page_context_link">[^<]*bot/i.test(html)) type = "bot";

    return { input: rawInput, username, status: "taken", displayName, type, link: `https://t.me/${username}` };
  } catch (err) {
    return { input: rawInput, username, status: "error",
      detail: err.name === "AbortError" ? "Request timed out." : "Network error." };
  } finally {
    clearTimeout(timer);
  }
}

async function mapWithConcurrency(items, limit, fn, delayMs = 0) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function cleanList(list) {
  if (!Array.isArray(list)) return null;
  return list.map((x) => String(x).trim()).filter(Boolean);
}

// Apply the safe-mode daily verification cap; returns the slice we may run.
function applyVerifyCap(cleaned) {
  const lim = store.effectiveLimits();
  if (lim.verifyDailyCap == null) return { toRun: cleaned, skipped: 0, lim };
  const remaining = Math.max(0, lim.verifyDailyCap - store.getCounter("verify"));
  if (remaining <= 0) return { toRun: [], skipped: cleaned.length, lim, capped: true };
  if (cleaned.length > remaining) return { toRun: cleaned.slice(0, remaining), skipped: cleaned.length - remaining, lim };
  return { toRun: cleaned, skipped: 0, lim };
}

app.post("/api/check", async (req, res) => {
  const cleaned = cleanList(req.body?.usernames);
  if (!cleaned) return res.status(400).json({ error: "Body must be { usernames: string[] }." });
  if (cleaned.length === 0) return res.status(400).json({ error: "No usernames provided." });
  if (cleaned.length > MAX_BATCH) return res.status(400).json({ error: `Max ${MAX_BATCH} usernames per request.` });

  const { toRun, skipped, lim, capped } = applyVerifyCap(cleaned);
  if (capped) return res.status(429).json({ error: `Safe mode: daily verification limit (${lim.verifyDailyCap}) reached. Raise it in Settings or wait until tomorrow.` });
  const results = await mapWithConcurrency(toRun, lim.verifyConcurrency, checkUsername, lim.verifyDelayMs);
  store.incrCounter("verify", toRun.length);
  res.json({ count: results.length, results, skipped });
});

// =========================================================================
// Roster (verified users stored in the DB)
// =========================================================================
app.get("/api/users", (_req, res) => res.json({ users: store.listUsers() }));

// Verify a batch AND persist verified ones to the roster.
app.post("/api/users/import", async (req, res) => {
  const cleaned = cleanList(req.body?.usernames);
  if (!cleaned) return res.status(400).json({ error: "Body must be { usernames: string[] }." });
  if (cleaned.length === 0) return res.status(400).json({ error: "No usernames provided." });
  if (cleaned.length > MAX_BATCH) return res.status(400).json({ error: `Max ${MAX_BATCH} usernames per request.` });

  const { toRun, skipped, lim, capped } = applyVerifyCap(cleaned);
  if (capped) return res.status(429).json({ error: `Safe mode: daily verification limit (${lim.verifyDailyCap}) reached. Raise it in Settings or wait until tomorrow.` });
  const results = await mapWithConcurrency(toRun, lim.verifyConcurrency, checkUsername, lim.verifyDelayMs);
  store.incrCounter("verify", toRun.length);
  for (const r of results) {
    if (r.status === "taken") {
      store.upsertUser({ username: r.username, display_name: r.displayName, status: "verified" });
      r.saved = true;
    }
  }
  res.json({ count: results.length, results, skipped });
});

app.delete("/api/users/:id", (req, res) => {
  store.deleteUser(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/users/export.csv", (_req, res) => {
  const users = store.listUsers();
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["username", "display_name", "status", "in_group", "tg_user_id", "verified_at"];
  const rows = users.map((u) =>
    [u.username, u.display_name, u.status, u.in_group ? "yes" : "no", u.tg_user_id || "", u.verified_at].map(esc).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="roster.csv"');
  res.send([header.join(","), ...rows].join("\r\n"));
});

// =========================================================================
// Settings (bot token + group chat)
// =========================================================================
app.get("/api/settings", (_req, res) => {
  const s = tg.status();
  const token = store.getSetting("bot_token");
  res.json({
    ...s,
    tokenMasked: token ? token.slice(0, 6) + "…" + token.slice(-4) : null,
  });
});

app.post("/api/settings", async (req, res) => {
  const { token, chatId } = req.body || {};
  try {
    // Validate token first (clear error if wrong) without wiping config.
    if (token) await tg.verifyToken(token);
    const result = await tg.configure({
      token: token !== undefined ? token : undefined,
      chatId: chatId !== undefined ? chatId : undefined,
    });
    res.json({ ok: true, status: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// =========================================================================
// Safe mode (rate-limit protection) + onboarding budget
// =========================================================================
function buildSafePayload() {
  const config = store.getSafeConfig();
  const lim = store.effectiveLimits();
  return {
    config,
    usage: {
      verify: { used: store.getCounter("verify"), cap: lim.verifyDailyCap },
      action: { used: store.getCounter("action"), cap: lim.actionDailyCap },
      onboard: { used: store.getCounter("onboard"), cap: lim.onboardDailyCap },
    },
  };
}

function sanitizeSafePatch(body) {
  const patch = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));
  const nums = {
    verifyDelayMs: [0, 10000],
    verifyConcurrency: [1, 10],
    verifyDailyCap: [1, 100000],
    actionMinGapMs: [0, 10000],
    actionDailyCap: [1, 100000],
    onboardDailyCap: [1, 100000],
  };
  for (const [k, [lo, hi]] of Object.entries(nums)) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== "" && !Number.isNaN(Number(body[k]))) {
      patch[k] = clamp(body[k], lo, hi);
    }
  }
  return patch;
}

app.get("/api/safe", (_req, res) => res.json(buildSafePayload()));

app.post("/api/safe", (req, res) => {
  store.setSafeConfig(sanitizeSafePatch(req.body || {}));
  res.json(buildSafePayload());
});

// Manual onboarding budget: you record people you've added yourself, so the
// meter keeps your manual adds under a daily threshold.
app.post("/api/onboard/use", (req, res) => {
  const n = Math.max(1, Math.min(100, Math.round(Number(req.body?.n) || 1)));
  const lim = store.effectiveLimits();
  const used = store.getCounter("onboard");
  if (lim.onboardDailyCap != null && used >= lim.onboardDailyCap) {
    return res.status(429).json({ error: `You've hit today's safe onboarding budget (${lim.onboardDailyCap}). Pause adds until tomorrow to protect your account.`, ...buildSafePayload() });
  }
  store.incrCounter("onboard", n);
  const payload = buildSafePayload();
  const over = lim.onboardDailyCap != null && payload.usage.onboard.used >= lim.onboardDailyCap;
  res.json({ ok: true, over, ...payload });
});

// =========================================================================
// Group chat (synced feed)
// =========================================================================
app.get("/api/group/messages", (req, res) => {
  const sinceId = Number(req.query.sinceId) || 0;
  const rows = sinceId > 0 ? store.messagesSince(sinceId) : store.recentMessages(100);
  res.json({ messages: rows });
});

app.post("/api/group/send", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Empty message." });
  try {
    const out = await tg.sendToGroup(text);
    res.json({ ok: true, id: out.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/group/invite", async (req, res) => {
  try {
    const link = await tg.createInvite({ memberLimit: Number(req.body?.memberLimit) || undefined });
    res.json({ ok: true, link: link.invite_link });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// =========================================================================
// Members / moderation
// =========================================================================
app.get("/api/members", (_req, res) => res.json({ members: store.listMembers() }));

app.post("/api/members/:userId/ban", async (req, res) => {
  try {
    await tg.banMember(Number(req.params.userId), { kick: false });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/members/:userId/kick", async (req, res) => {
  try {
    await tg.banMember(Number(req.params.userId), { kick: true });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/members/:userId/unban", async (req, res) => {
  try {
    await tg.unbanMember(Number(req.params.userId));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

await tg.init();
app.listen(PORT, () => {
  console.log(`\n  Telegram community manager running:\n  → http://localhost:${PORT}\n`);
});
