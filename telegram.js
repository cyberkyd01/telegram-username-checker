// Minimal Telegram Bot API client + long-polling loop.
// No external dependencies: talks to api.telegram.org over fetch.

import * as store from "./db.js";

const API = "https://api.telegram.org";

const state = {
  token: null,
  chatId: null, // configured community group chat id (string)
  botId: null,
  botUsername: null,
  polling: false,
  admins: new Set(), // tg user ids allowed to run bot commands
  lastError: null,
  detectedChats: new Map(), // chatId -> title (groups the bot was added to)
  abort: null,
};

export function status() {
  return {
    hasToken: Boolean(state.token),
    botUsername: state.botUsername,
    botId: state.botId,
    chatId: state.chatId,
    polling: state.polling,
    lastError: state.lastError,
    detectedChats: [...state.detectedChats.entries()].map(([id, title]) => ({ id, title })),
  };
}

export async function call(method, params = {}) {
  if (!state.token) throw new Error("No bot token configured.");
  const res = await fetch(`${API}/bot${state.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) {
    const msg = data.description || `Telegram API error (${method})`;
    const err = new Error(msg);
    err.code = data.error_code;
    throw err;
  }
  return data.result;
}

/** Validate a token and remember the bot identity (does not start polling). */
export async function verifyToken(token) {
  const res = await fetch(`${API}/bot${token}/getMe`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "Invalid bot token.");
  return data.result; // { id, username, ... }
}

async function refreshAdmins() {
  if (!state.chatId) return;
  try {
    const admins = await call("getChatAdministrators", { chat_id: state.chatId });
    state.admins = new Set(admins.map((a) => a.user.id));
  } catch {
    /* chat not ready yet; ignore */
  }
}

/** (Re)configure token + chat and (re)start the polling loop. */
export async function configure({ token, chatId }) {
  if (token !== undefined) state.token = token || null;
  if (chatId !== undefined) state.chatId = chatId ? String(chatId) : null;

  stopPolling();

  if (state.token) {
    const me = await verifyToken(state.token);
    state.botId = me.id;
    state.botUsername = me.username;
    store.setSetting("bot_token", state.token);
    store.setSetting("bot_username", state.botUsername || "");
  }
  if (state.chatId) store.setSetting("chat_id", state.chatId);

  state.lastError = null;
  if (state.token) {
    await refreshAdmins();
    startPolling();
  }
  return status();
}

/** Load persisted settings at boot and start polling if configured. */
export async function init() {
  const token = store.getSetting("bot_token");
  const chatId = store.getSetting("chat_id");
  if (token) {
    try {
      await configure({ token, chatId: chatId || undefined });
    } catch (e) {
      state.lastError = e.message;
    }
  }
}

let pollTimer = null;
export function stopPolling() {
  state.polling = false;
  if (state.abort) state.abort.abort();
  state.abort = null;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

export function startPolling() {
  if (state.polling || !state.token) return;
  state.polling = true;
  loop();
}

async function loop() {
  while (state.polling) {
    const offset = Number(store.getSetting("update_offset", "0")) || 0;
    state.abort = new AbortController();
    try {
      const res = await fetch(`${API}/bot${state.token}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: state.abort.signal,
        body: JSON.stringify({
          offset,
          timeout: 30,
          allowed_updates: ["message", "edited_message", "chat_member", "my_chat_member"],
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        state.lastError = data.description || "getUpdates failed";
        await sleep(3000);
        continue;
      }
      state.lastError = null;
      for (const update of data.result) {
        store.setSetting("update_offset", String(update.update_id + 1));
        try {
          await handleUpdate(update);
        } catch (e) {
          console.error("update handler error:", e.message);
        }
      }
    } catch (e) {
      if (e.name === "AbortError") break;
      state.lastError = e.message;
      await sleep(3000);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fullName(u) {
  if (!u) return null;
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
}

function inConfiguredChat(chat) {
  return chat && state.chatId && String(chat.id) === String(state.chatId);
}

async function handleUpdate(update) {
  // Bot added/removed/promoted somewhere → remember the chat so the admin can pick it.
  const mcm = update.my_chat_member;
  if (mcm && (mcm.chat.type === "group" || mcm.chat.type === "supergroup")) {
    state.detectedChats.set(String(mcm.chat.id), mcm.chat.title || String(mcm.chat.id));
    if (inConfiguredChat(mcm.chat)) await refreshAdmins();
  }

  // Membership changes (joins/leaves/bans) reported via chat_member.
  const cm = update.chat_member;
  if (cm && inConfiguredChat(cm.chat)) {
    const u = cm.new_chat_member?.user;
    const newStatus = cm.new_chat_member?.status;
    if (u) {
      store.seenMember({ tg_user_id: u.id, username: u.username, display_name: fullName(u), is_bot: u.is_bot });
      if (newStatus === "left" || newStatus === "kicked") {
        store.setMemberStatus(u.id, newStatus === "kicked" ? "banned" : "left");
      } else if (newStatus === "member" || newStatus === "administrator" || newStatus === "creator") {
        store.setMemberStatus(u.id, "member");
      }
    }
  }

  const msg = update.message;
  if (!msg || !inConfiguredChat(msg.chat)) return;

  const from = msg.from;
  if (from) {
    store.seenMember({ tg_user_id: from.id, username: from.username, display_name: fullName(from), is_bot: from.is_bot });
    store.bumpMemberMessage(from.id);
  }

  // Service messages: joins / leaves
  if (msg.new_chat_members?.length) {
    for (const u of msg.new_chat_members) {
      store.seenMember({ tg_user_id: u.id, username: u.username, display_name: fullName(u), is_bot: u.is_bot });
      store.setMemberStatus(u.id, "member");
      store.addMessage({ from_id: u.id, from_name: fullName(u), from_username: u.username, text: `joined the group`, kind: "join", date: msg.date });
    }
    return;
  }
  if (msg.left_chat_member) {
    const u = msg.left_chat_member;
    store.setMemberStatus(u.id, "left");
    store.addMessage({ from_id: u.id, from_name: fullName(u), from_username: u.username, text: `left the group`, kind: "leave", date: msg.date });
    return;
  }

  const text = msg.text || msg.caption || "";

  // Moderation commands (admins only): /ban, /kick, /help, /stats
  if (text.startsWith("/")) {
    await handleCommand(msg, text);
    // still record the command text in the feed
  }

  if (text || msg.caption) {
    store.addMessage({
      tg_message_id: msg.message_id,
      from_id: from?.id,
      from_name: fullName(from),
      from_username: from?.username,
      text: text || "[media]",
      kind: "text",
      via: "telegram",
      date: msg.date,
    });
  }
}

async function handleCommand(msg, text) {
  const cmd = text.split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
  const issuer = msg.from?.id;
  const isAdmin = state.admins.has(issuer);

  if (cmd === "/help") {
    await reply(msg, isAdmin
      ? "Admin commands:\n/ban (reply to a message) — ban that user\n/kick (reply) — remove, allow rejoin\n/stats — group stats"
      : "This bot mirrors the group to the admin dashboard.");
    return;
  }

  if (cmd === "/stats") {
    const members = store.listMembers().filter((m) => m.status === "member").length;
    await reply(msg, `Tracked members: ${members}`);
    return;
  }

  if (cmd === "/ban" || cmd === "/kick") {
    if (!isAdmin) {
      await reply(msg, "Only group admins can use that.");
      return;
    }
    const target = msg.reply_to_message?.from;
    if (!target) {
      await reply(msg, `Reply to the spammer's message with ${cmd}.`);
      return;
    }
    try {
      await call("banChatMember", { chat_id: state.chatId, user_id: target.id });
      if (cmd === "/kick") {
        await call("unbanChatMember", { chat_id: state.chatId, user_id: target.id, only_if_banned: true });
        store.setMemberStatus(target.id, "left");
      } else {
        store.setMemberStatus(target.id, "banned");
      }
      await reply(msg, `${fullName(target)} removed.`);
    } catch (e) {
      await reply(msg, `Could not remove: ${e.message}`);
    }
  }
}

async function reply(msg, text) {
  try {
    await call("sendMessage", { chat_id: msg.chat.id, text, reply_to_message_id: msg.message_id });
  } catch {
    /* ignore */
  }
}

// --- actions used by the HTTP interface -----------------------------------
export async function sendToGroup(text) {
  if (!state.chatId) throw new Error("No group chat configured.");
  const sent = await call("sendMessage", { chat_id: state.chatId, text });
  const id = store.addMessage({
    tg_message_id: sent.message_id,
    from_id: state.botId,
    from_name: `${state.botUsername} (you via bot)`,
    from_username: state.botUsername,
    text,
    kind: "text",
    via: "interface",
    date: sent.date,
  });
  return { id, sent };
}

export async function banMember(userId, { kick = false } = {}) {
  if (!state.chatId) throw new Error("No group chat configured.");
  await call("banChatMember", { chat_id: state.chatId, user_id: userId });
  if (kick) {
    await call("unbanChatMember", { chat_id: state.chatId, user_id: userId, only_if_banned: true });
    store.setMemberStatus(userId, "left");
  } else {
    store.setMemberStatus(userId, "banned");
  }
}

export async function unbanMember(userId) {
  if (!state.chatId) throw new Error("No group chat configured.");
  await call("unbanChatMember", { chat_id: state.chatId, user_id: userId, only_if_banned: true });
  store.setMemberStatus(userId, "left");
}

export async function createInvite({ memberLimit } = {}) {
  if (!state.chatId) throw new Error("No group chat configured.");
  const params = { chat_id: state.chatId, creates_join_request: false };
  if (memberLimit) params.member_limit = memberLimit;
  const link = await call("createChatInviteLink", params);
  return link;
}
