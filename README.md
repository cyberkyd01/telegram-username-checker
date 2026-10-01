# Telegram Username Checker

A small web app that checks whether **public Telegram usernames** are registered
or available. It queries Telegram's own public `t.me/<username>` preview — the
same page anyone sees when visiting that link — and reports the result.

Useful for:

- Picking a new, unused handle for yourself, a bot, or a channel.
- Verifying that a known public account/channel username resolves.

## What it does **not** do

This tool intentionally only resolves **public usernames**. It does not look up
people by phone number or email, and it is not a bulk contact-matching or
de-anonymization tool. If you want to find which of **your own** contacts are on
Telegram, use Telegram's built-in contact sync in the official app instead.

Please keep usage reasonable — it talks to Telegram's public endpoint and is
rate-limited (max 50 names per request) to stay a good citizen. Scraping or bulk
enumeration may violate [Telegram's Terms of Service](https://core.telegram.org/api/terms).

## Run locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000**.

For auto-reload during development:

```bash
npm run dev
```

## How it works

- `POST /api/check` with `{ "usernames": ["durov", "@telegram", "t.me/foo"] }`
  returns a JSON result per username with status `taken` / `available` /
  `invalid` / `error`.
- Existence is determined by whether Telegram's public preview page renders a
  profile title for that username.

Results are a best-effort signal from a public page; Telegram may change its
markup, and some handles are reserved.

## License

MIT
