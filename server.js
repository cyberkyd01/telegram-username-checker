import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---------------------------------------------------------------
const MAX_BATCH = 50; // max usernames per request
const CONCURRENCY = 5; // simultaneous outbound requests to t.me
const REQUEST_TIMEOUT_MS = 8000;
const POLITE_DELAY_MS = 150; // small pause between batches, to be a good citizen

// Telegram username rules: 5–32 chars, [a-z0-9_], must start with a letter.
// (We normalise a leading @ and any t.me/ prefix the user might paste.)
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

/**
 * Normalise user input into a bare username.
 * Accepts: "name", "@name", "t.me/name", "https://t.me/name".
 */
function normalizeUsername(raw) {
  let u = String(raw).trim();
  if (!u) return "";
  u = u.replace(/^https?:\/\//i, "");
  u = u.replace(/^(www\.)?t(elegram)?\.me\//i, "");
  u = u.replace(/^@/, "");
  u = u.split(/[/?#]/)[0]; // drop any trailing path/query
  return u;
}

/**
 * Check a single username against Telegram's public web preview.
 * Returns one of: "taken", "available", "invalid", "error".
 */
async function checkUsername(rawInput) {
  const username = normalizeUsername(rawInput);

  if (!USERNAME_RE.test(username)) {
    return {
      input: rawInput,
      username,
      status: "invalid",
      detail:
        "Not a valid Telegram username (5–32 chars, letters/digits/underscore, must start with a letter).",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`https://t.me/${encodeURIComponent(username)}`, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // A normal browser UA so Telegram serves the public preview page.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en",
      },
    });

    const html = await res.text();

    // The public preview page renders `tgme_page_title` only when the
    // username actually resolves to a user / bot / channel / group.
    const exists = html.includes("tgme_page_title");

    if (!exists) {
      return { input: rawInput, username, status: "available" };
    }

    // Try to pull out a friendly display name + a rough type hint.
    const nameMatch = html.match(
      /tgme_page_title[^>]*>\s*<span[^>]*>([^<]+)<\/span>/i
    );
    const displayName = nameMatch ? decodeEntities(nameMatch[1].trim()) : null;

    let type = "user";
    if (/tgme_page_extra[^>]*>[^<]*(subscriber|member)/i.test(html)) {
      type = "channel/group";
    } else if (/<div class="tgme_page_context_link">[^<]*bot/i.test(html)) {
      type = "bot";
    }

    return {
      input: rawInput,
      username,
      status: "taken",
      displayName,
      type,
      link: `https://t.me/${username}`,
    };
  } catch (err) {
    return {
      input: rawInput,
      username,
      status: "error",
      detail: err.name === "AbortError" ? "Request timed out." : "Network error.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Run tasks with limited concurrency, preserving input order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
      if (POLITE_DELAY_MS) await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// --- API ------------------------------------------------------------------
app.post("/api/check", async (req, res) => {
  const list = Array.isArray(req.body?.usernames) ? req.body.usernames : null;

  if (!list) {
    return res.status(400).json({ error: "Body must be { usernames: string[] }." });
  }

  const cleaned = list
    .map((x) => String(x))
    .map((x) => x.trim())
    .filter(Boolean);

  if (cleaned.length === 0) {
    return res.status(400).json({ error: "No usernames provided." });
  }
  if (cleaned.length > MAX_BATCH) {
    return res
      .status(400)
      .json({ error: `Too many at once. Max ${MAX_BATCH} usernames per request.` });
  }

  try {
    const results = await mapWithConcurrency(cleaned, CONCURRENCY, checkUsername);
    res.json({ count: results.length, results });
  } catch {
    res.status(500).json({ error: "Internal error while checking usernames." });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n  Telegram username checker running:\n  → http://localhost:${PORT}\n`);
});
