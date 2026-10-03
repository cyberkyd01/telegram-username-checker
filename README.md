# Telegram Community Manager

A self-hosted web dashboard for running a **small Telegram community of your own
consented users** — the people who told you on your platform's signup form that
they're on Telegram and gave their `@username`.

> **Deploying to a server?** Follow the step-by-step VPS guide: **[DEPLOY.md](DEPLOY.md)**

It lets you:

- **Verify & build a roster** — paste or upload the `@usernames` your users
  submitted; the app confirms each is a real Telegram account (via Telegram's
  public `t.me` page, with no action required from the user) and saves the valid
  ones to a local database. Export the roster as CSV.
- **Mirror your community group** — a live, two-way feed of your group chat.
  Members chat in Telegram as normal; you can also post to the group from the
  dashboard.
- **Moderate** — see everyone the bot has seen in the group and remove spammers
  with **Ban** / **Kick**, either from the dashboard or by replying `/ban` /
  `/kick` to a message in Telegram.
- **Invite** — generate a group invite link to share from your platform.

Everything runs on your machine. Your bot token and all data live in a local
SQLite file (`data/app.db`) that is **git-ignored and never committed**.

## What this is NOT

It only works with usernames your users **gave you with consent**. It does not
look anyone up by phone number or email, and it is not a bulk
contact-matching / de-anonymization tool.

## Safe mode (rate-limit protection)

On by default, tunable in **Settings → Safe mode**. It paces everything the app
does so you stay well under Telegram's limits:

- **Verification throttle** — public `t.me` checks run one at a time with a delay
  and a daily cap (default 200/day). Over the cap, extra names are skipped with a
  clear message.
- **Bot-action pacing** — a minimum gap between bot calls, automatic handling of
  Telegram's `429 retry_after` (it waits instead of retrying blindly), and a daily
  action cap (default 500).
- **Manual-add budget** — a daily counter + meter (default 25) for people you add
  **yourself** in the Telegram app. The app can't throttle the native client, so
  this is a self-paced budget: record each batch you add, and the meter warns you
  before you reach the threshold that gets accounts flagged. Prefer invite links
  over direct adds.

Turning safe mode off removes all caps (throttles drop to minimal).

## Telegram Bot API limits worth knowing

These are platform rules, not app choices:

- A bot **can't add people to a group** — they join via an invite link or you add
  them manually. (Direct-invite-from-platform can come later via invite links.)
- A bot **can only DM a user who messaged it first**. To chat with an individual
  user you haven't heard from, use the **Message** button on the roster, which
  opens `t.me/<username>` so you chat as yourself.
- A bot **can't fetch old history** — the group feed starts from when the bot is
  running and is an admin.
- Accounts **can't be verified by phone** via the Bot API.

## Run locally

Requires Node.js 18+ (uses the built-in `node:sqlite`; developed on Node 26).

```bash
npm install
npm start
```

Open **http://localhost:3000**.

You can use the **Users** tab (verify + roster + CSV) with no bot token at all.
The **Group Chat** and **Members** tabs need a bot connected in **Settings**.

## Connect the bot (in the Settings tab)

1. **Create the bot** — [@BotFather](https://t.me/BotFather) → `/newbot` → copy the
   token into Settings. Then `/setprivacy` → **Disable** (so it can read group
   messages) and `/setjoingroups` → **Enable**.
2. **Create a group**, add the bot, and use it as a **supergroup**.
3. **Make the bot an admin** with at least *Ban users* and *Invite via link*.
4. Save the token in Settings; your group appears under **Detected groups** —
   click it to fill the chat ID, then **Save & connect**.

## HTTP API (all local)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/check` | Verify usernames (no save) |
| POST | `/api/users/import` | Verify + save verified to roster |
| GET | `/api/users` / `/api/users/export.csv` | Roster list / CSV |
| DELETE | `/api/users/:id` | Remove a roster entry |
| GET/POST | `/api/settings` | Read / set bot token + chat ID |
| GET | `/api/group/messages?sinceId=` | Group feed |
| POST | `/api/group/send` | Post to the group as the bot |
| POST | `/api/group/invite` | Create an invite link |
| GET | `/api/members` | Members the bot has seen |
| POST | `/api/members/:id/ban` · `/kick` · `/unban` | Moderation |

## Security notes

- Keep this dashboard on `localhost` or behind your own auth — anyone who can
  reach it can post to your group and ban members. It ships with no login.
- The bot token grants full control of the bot; the `data/` directory is
  git-ignored for that reason.

## License

MIT
