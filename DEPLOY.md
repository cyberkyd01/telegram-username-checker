# Deploy Telegram Community Manager on a VPS (over SSH)

This guide takes you from a fresh SSH session to the dashboard (this repo, `telegram-username-checker`) running at `https://your-domain`. It runs as its own systemd service, sits behind nginx with a password prompt, and has one-command updates with automatic rollback. Everything it creates is kept separate from other sites and apps on the same server.

Every command is meant to be copied and pasted as-is. The only values you edit are in step 1.

> Target: **Ubuntu 22.04 / 24.04 LTS or Debian 12**, x86_64 or arm64. You log in as a sudo user or as root. Every block uses `sudo`, which also works as root. On minimal Debian logged in as root, run `apt-get install -y sudo` first.

## At a glance

| | |
|---|---|
| Install directory | `/opt/tg-checker` (releases in `/opt/tg-checker/releases`, live one at `/opt/tg-checker/current`) |
| Config | `/etc/tg-checker/` (`deploy.conf`, dashboard password, localhost shim) |
| System user | `tg-checker` (no login shell) |
| Service | `tg-checker.service` (+ optional `tg-checker-backup.timer`) |
| Internal port | `127.0.0.1:3112` only, never public |
| Public URL | `https://<DOMAIN>`, or `http://<server-ip>:8112` in no-domain mode |
| Runtime | Node.js 24 LTS in `/opt/tg-checker/runtime/node`, separate from any system Node |
| Database | SQLite, `/opt/tg-checker/shared/data/app.db`. The app creates it. It also stores the bot token. |
| Telegram | Bot API with **long polling**, so no webhook, no user-account login and no phone code |
| Never touches | the system Node/npm, other nginx sites, `nginx.conf`, the `default` site, firewall policy, existing databases, other services |

### How this app talks to Telegram (read once)

- **Username verification** fetches the public `https://t.me/<username>` page. It needs no token.
- **Group feed and moderation** use a **bot token** (from @BotFather) through the Bot API's `getUpdates` **long polling** (`telegram.js`). There is **no webhook**, so Telegram never needs to reach your server, and HTTPS isn't required for the bot to work. There's also **no MTProto user session**, so there's no interactive phone-code login.
- You don't put the bot token in a file. You paste it into the dashboard's **Settings** tab after deploying, and it's saved in the SQLite database.
- **Only one running copy per bot token.** If the same token is also polling somewhere else (for example `npm start` on your laptop), Telegram answers `409 Conflict` and the feed stops on one of them.
- **The dashboard has no login of its own.** The README says so: anyone who can open it can post to your group and ban members. This guide therefore puts it behind an nginx password (HTTP basic auth) and serves it over HTTPS. You can also keep it completely private with an SSH tunnel (step 11, option C).

## Requirements

- A VPS running Ubuntu 22.04/24.04 or Debian 12 with **1 vCPU, 512 MB RAM and 1 GB free disk**. The app uses about 70 MB RAM and there's no build step.
- **Outbound HTTPS** from the server to `api.telegram.org` and `t.me`. Some providers and countries block Telegram; step 2 checks this.
- **Recommended:** a domain or subdomain (e.g. `tg.example.com`) with a DNS **A record** pointing at the server's public IPv4, plus an email address for Let's Encrypt. Without a domain the dashboard still works on `http://<server-ip>:8112`, but the password then travels unencrypted.
- A Telegram bot token from [@BotFather](https://t.me/BotFather). You need it after deploying, not before.
- Access to `https://github.com/cyberkyd01/telegram-username-checker` so you can add a deploy key, because the repo is private.

## 1. Connect and set your variables

From your computer:

```bash
ssh your-user@your-server-ip
```

On the server, edit the values in this block if needed (usually only `DOMAIN` and `EMAIL`), then paste it. **This file is the only place you edit settings.** Every later block reads it, so you can safely reconnect at any time.

```bash
sudo mkdir -p /etc/tg-checker
sudo tee /etc/tg-checker/deploy.conf >/dev/null <<'EOF'
# tg-checker deployment settings - the ONLY place you edit values.
APP=tg-checker
APP_USER=tg-checker
APP_HOME=/opt/tg-checker
REPO_URL=git@github.com:cyberkyd01/telegram-username-checker.git
BRANCH=master
PORT=3112           # internal port, bound to 127.0.0.1 only
PUBLIC_PORT=8112    # used only when DOMAIN is empty (no-domain mode)
DOMAIN=             # e.g. tg.example.com - leave empty for no-domain mode
EMAIL=              # for Let's Encrypt notices - required when DOMAIN is set
NODE_MAJOR=24       # node:sqlite needs Node 22.13+; 24 is the current LTS
EOF
sudo chmod 644 /etc/tg-checker/deploy.conf
cat /etc/tg-checker/deploy.conf
```

To change a value later, run `sudo nano /etc/tg-checker/deploy.conf` and then re-run the step that uses it. If the repo were public you could use `REPO_URL=https://github.com/cyberkyd01/telegram-username-checker.git` and skip step 6.

## 2. Preflight checks

This block changes nothing. It prints `OK`, `WARN` or `STOP` lines.

```bash
sudo bash -uo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
FAIL=0
ok()   { echo "OK    $*"; }
warn() { echo "WARN  $*"; }
stop() { echo "STOP  $*"; FAIL=1; }
. /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:22.04|ubuntu:24.04|debian:12) ok "OS: $PRETTY_NAME" ;;
  *) warn "OS: $PRETTY_NAME is not Ubuntu 22.04/24.04 or Debian 12 (may still work)" ;;
esac
case "$(uname -m)" in
  x86_64|aarch64) ok "CPU: $(uname -m)" ;;
  *) stop "CPU $(uname -m) is not supported (need x86_64 or arm64)" ;;
esac
MEM_MB=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -ge 450 ]; then ok "RAM: ${MEM_MB} MB"; else stop "RAM: ${MEM_MB} MB (need 512 MB)"; fi
DISK_MB=$(df -Pm /opt | awk 'NR==2 {print $4}')
if [ "$DISK_MB" -ge 1024 ]; then ok "Free disk on /opt: ${DISK_MB} MB"; else stop "Free disk on /opt: ${DISK_MB} MB (need 1 GB)"; fi
if ss -ltnH "sport = :$PORT" | grep -q .; then
  if systemctl is-active --quiet "$APP"; then ok "Port $PORT is used by $APP itself (already installed)"
  else stop "Port $PORT is already in use: $(ss -ltnpH "sport = :$PORT" | head -1). Pick a free port, set PORT= in /etc/$APP/deploy.conf, re-run."; fi
else ok "Port $PORT is free"; fi
if [ -z "$DOMAIN" ]; then
  if ss -ltnH "sport = :$PUBLIC_PORT" | grep -q . && [ ! -e "/etc/nginx/sites-enabled/$APP" ] && [ ! -e "/etc/nginx/conf.d/$APP.conf" ]; then
    stop "Public port $PUBLIC_PORT is in use. Set PUBLIC_PORT= in /etc/$APP/deploy.conf to a free port."
  else ok "No-domain mode: dashboard will be at http://<server-ip>:$PUBLIC_PORT"; fi
fi
WEB=$(ss -ltnpH '( sport = :80 or sport = :443 )' | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' ' || true)
case "$WEB" in
  "")       ok "Ports 80/443: free (nginx will be installed)" ;;
  "nginx ") ok "Ports 80/443: nginx (this guide only adds its own site)" ;;
  *)        stop "Ports 80/443 are used by: $WEB- skip nginx and use the Appendix (Caddy/Apache) in step 11" ;;
esac
if command -v curl >/dev/null; then
  for u in https://api.telegram.org/ https://t.me/telegram; do
    if curl -sS -o /dev/null --max-time 10 "$u"; then ok "Outbound HTTPS to $u"
    else stop "Cannot reach $u from this server (blocked by provider or country?) - the app needs it"; fi
  done
  if [ -n "$DOMAIN" ]; then
    SERVER_IP=$(curl -4fsS --max-time 10 https://api.ipify.org || true)
    DNS_IPS=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')
    if [ -n "$SERVER_IP" ] && echo " $DNS_IPS" | grep -q " $SERVER_IP "; then ok "DNS: $DOMAIN -> $SERVER_IP"
    else stop "DNS: $DOMAIN resolves to '${DNS_IPS:-nothing}' but this server is '${SERVER_IP:-unknown}'. Fix the A record and wait."; fi
  fi
else
  warn "curl is not installed yet - re-run this block after step 3 for the Telegram and DNS checks"
fi
[ "$FAIL" -eq 0 ] && echo "==> All checks passed." || echo "==> Fix the STOP lines above, then re-run this block."
EOF
```

You should see only `OK` lines, and maybe a `WARN`, ending with `==> All checks passed.`

## 3. Install system packages

This only adds packages. Nothing is upgraded or removed. nginx is installed only when ports 80/443 are free or already belong to nginx.

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/tg-checker/deploy.conf
export DEBIAN_FRONTEND=noninteractive
apt-get update
MISSING_PKGS=""; for p in ca-certificates curl git openssh-client xz-utils openssl sqlite3 iproute2; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || MISSING_PKGS="$MISSING_PKGS $p"; done
if [ -n "$MISSING_PKGS" ]; then apt-get install -y --no-install-recommends $MISSING_PKGS; fi   # only what's missing - never upgrades installed packages
WEB=$(ss -ltnpH '( sport = :80 or sport = :443 )' | grep -oE 'users:\(\("[^"]+"' | cut -d'"' -f2 | sort -u | tr '\n' ' ' || true)
if [ -z "$WEB" ] || [ "$WEB" = "nginx " ]; then
  if ! command -v nginx >/dev/null; then apt-get install -y --no-install-recommends nginx; fi
  nginx -v
else
  echo "Ports 80/443 belong to: $WEB- nginx NOT installed. Use the Appendix in step 11."
fi
EOF
```

You should see `nginx version: nginx/1.x` at the end, unless another web server owns ports 80/443.

## 4. Create the app user and folders

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --user-group --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$APP_HOME"
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/releases" "$APP_HOME/runtime"
install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$APP_HOME/shared" "$APP_HOME/shared/data" "$APP_HOME/backups" "$APP_HOME/.ssh"
install -d -m 755 -o root -g root "$APP_HOME/bin" "/etc/$APP"
id "$APP_USER"
ls -la "$APP_HOME"
EOF
```

You should see `uid=...(tg-checker) gid=...(tg-checker)` and the folders `bin backups releases runtime shared .ssh`. `bin/` is owned by root on purpose, so the app user can't change the deploy script that runs as root.

## 5. Install the runtime (isolated Node.js)

The app uses the built-in `node:sqlite` module. That module needs Node 22.13 or newer, even though `package.json` says `>=18`. This block installs the latest Node 24 LTS into `/opt/tg-checker/runtime/node` and checks the official checksum. It doesn't touch any system Node.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
case "$(uname -m)" in x86_64) NARCH=x64 ;; aarch64|arm64) NARCH=arm64 ;; *) echo "Unsupported CPU: $(uname -m)"; exit 1 ;; esac
BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
TARBALL="$(curl -fsSL "$BASE/SHASUMS256.txt" | grep -oE "node-v[0-9.]+-linux-${NARCH}\.tar\.xz" | head -1)"
TMP="$(mktemp -d)"
curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL"
(cd "$TMP" && curl -fsSL "$BASE/SHASUMS256.txt" | grep " $TARBALL\$" | sha256sum -c -)
rm -rf "$APP_HOME/runtime/node" && mkdir -p "$APP_HOME/runtime/node"
tar -xJf "$TMP/$TARBALL" -C "$APP_HOME/runtime/node" --strip-components=1
rm -rf "$TMP"
chown -R "$APP_USER:$APP_USER" "$APP_HOME/runtime"
sudo -u "$APP_USER" "$APP_HOME/runtime/node/bin/node" --no-warnings -e "require('node:sqlite'); console.log('node', process.version, '- node:sqlite OK')"
EOF
```

You should see `...tar.xz: OK` followed by `node v24.x.x - node:sqlite OK`.

## 6. Give the server read access to the repo

Create a read-only deploy key that belongs to the `tg-checker` user:

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
KEY="$APP_HOME/.ssh/id_ed25519"
[ -f "$KEY" ] || sudo -u "$APP_USER" ssh-keygen -q -t ed25519 -N "" -C "$APP@$(hostname)" -f "$KEY"
touch "$APP_HOME/.ssh/known_hosts"
ssh-keygen -F github.com -f "$APP_HOME/.ssh/known_hosts" >/dev/null || ssh-keyscan -t ed25519 github.com 2>/dev/null >> "$APP_HOME/.ssh/known_hosts"
chown -R "$APP_USER:$APP_USER" "$APP_HOME/.ssh"
chmod 700 "$APP_HOME/.ssh"; chmod 600 "$APP_HOME/.ssh/known_hosts"
echo; echo "=== Copy the whole next line into GitHub ==="
cat "$KEY.pub"
EOF
```

1. Open **https://github.com/cyberkyd01/telegram-username-checker/settings/keys/new**.
2. Title: `tg-checker server`. Key: paste the `ssh-ed25519 ...` line. **Leave "Allow write access" unticked.**
3. Click **Add key**, then test it:

```bash
sudo -u tg-checker -H ssh -T git@github.com
```

You should see `Hi cyberkyd01/telegram-username-checker! You've successfully authenticated, but GitHub does not provide shell access.` If you see `Permission denied (publickey)`, the key wasn't saved on the right repo.

## 7. Configure the app

There's **no `.env` file and no secret to generate.** The code reads exactly one environment variable:

| Variable | Required | Value | Set where |
|---|---|---|---|
| `PORT` | yes | `3112` (from `deploy.conf`) | systemd unit (step 9) |
| `NODE_ENV` | no | `production`. The app doesn't read it, but Express uses it to hide stack traces. | systemd unit |
| `LISTEN_HOST` | no | `127.0.0.1`. Read by the localhost shim below, not by the app. | systemd unit |

The **bot token, group chat ID and Safe-mode limits** are entered in the dashboard's **Settings** tab and stored in SQLite (step 12).

**Code limitation and workaround:** `server.js` calls `app.listen(PORT)` without a host, so by default it would listen on **every** network interface. That would put a password-less dashboard on the public internet at port 3112. The repo has no setting for this, so the service preloads a tiny shim (with Node's `--require`) that adds `127.0.0.1` to that `listen()` call. The repo code is not changed. Create the shim:

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
cat > "/etc/$APP/listen-localhost.cjs" <<'JS'
// Keeps tg-checker private. server.js calls app.listen(PORT) without a host,
// which would listen on every interface. This preload (node --require) adds
// the host LISTEN_HOST (default 127.0.0.1) to any listen(port[, callback]) call.
"use strict";
const net = require("node:net");
const host = process.env.LISTEN_HOST || "127.0.0.1";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const p = args[0];
  const isPort = typeof p === "number" || (typeof p === "string" && /^\d+$/.test(p));
  if (isPort && (args.length === 1 || typeof args[1] === "function")) args.splice(1, 0, host);
  return listen.apply(this, args);
};
JS
chmod 644 "/etc/$APP/listen-localhost.cjs"
echo "Wrote /etc/$APP/listen-localhost.cjs"
EOF
```

## 8. Database

There's nothing to set up. On first start, `db.js` creates `data/app.db` (SQLite, WAL mode) and its tables with `CREATE TABLE IF NOT EXISTS`, so there are no migrations and no seed. In each release, `data/` is a symlink to `/opt/tg-checker/shared/data`, so the database survives updates and rollbacks. That folder is `chmod 700` and the service runs with `UMask=0077`, because the database contains the bot token.

Run **only one copy** of the app against this database. A second copy fails with `database is locked`.

## 9. Run it as a service

The unit is enabled now and started by the first deploy in step 10.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
cat > "/etc/systemd/system/$APP.service" <<UNIT
[Unit]
Description=$APP - Telegram Community Manager dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_HOME/current
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=LISTEN_HOST=127.0.0.1
Environment=PATH=$APP_HOME/runtime/node/bin:/usr/bin:/bin
ExecStart=$APP_HOME/runtime/node/bin/node --no-warnings --require /etc/$APP/listen-localhost.cjs server.js
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_HOME

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$APP"
if [ -e "$APP_HOME/current" ]; then systemctl restart "$APP"; fi
systemctl is-enabled "$APP"
EOF
```

You should see `Created symlink ...` the first time, then `enabled`.

## 10. Create the deploy script and deploy

`/opt/tg-checker/bin/deploy.sh` handles the first install and every update in the same way. It fetches the branch, unpacks it into a new release folder, links the shared `data/` folder and runs `npm ci`. Then it switches `current`, restarts the service and health-checks `/api/health`. If the check fails it **rolls back automatically**. It keeps the last 3 releases.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
cat > "$APP_HOME/bin/deploy.sh" <<'DEPLOY'
#!/usr/bin/env bash
# Deploys the latest commit of $BRANCH. First install and every update. Safe to re-run.
set -Eeuo pipefail
source /etc/tg-checker/deploy.conf
[ "$(id -u)" -eq 0 ] || { echo "Run with: sudo $0"; exit 1; }

RELEASES="$APP_HOME/releases"; SHARED="$APP_HOME/shared"; REPO="$APP_HOME/repo"
export PATH="$APP_HOME/runtime/node/bin:/usr/local/bin:/usr/bin:/bin"
as_app() { sudo -u "$APP_USER" -H env HOME="$APP_HOME" PATH="$PATH" bash -euo pipefail -c "$1"; }

SHARED_DIRS=(data)                          # SQLite database (db.js uses ./data)
SERVICES=("$APP")
HEALTH_URL="http://127.0.0.1:$PORT/api/health"

echo "==> Fetching $BRANCH"
if [ ! -d "$REPO/.git" ]; then as_app "git clone --quiet '$REPO_URL' '$REPO'"; fi
as_app "cd '$REPO' && git fetch --quiet --prune origin '$BRANCH' && git reset --quiet --hard 'origin/$BRANCH'"
SHA="$(as_app "cd '$REPO' && git rev-parse --short HEAD")"
NEW="$RELEASES/$(date +%Y%m%d%H%M%S)-$SHA"
as_app "mkdir -p '$NEW' && cd '$REPO' && git archive HEAD | tar -x -C '$NEW'"

echo "==> Linking shared folders"
for d in "${SHARED_DIRS[@]}"; do as_app "mkdir -p '$SHARED/$d' && rm -rf '$NEW/$d' && ln -sfn '$SHARED/$d' '$NEW/$d'"; done

echo "==> Installing dependencies"
as_app "cd '$NEW' && npm ci --omit=dev --no-audit --no-fund --no-update-notifier"

echo "==> Switching to $NEW"
PREV="$(readlink -f "$APP_HOME/current" 2>/dev/null || true)"
ln -sfn "$NEW" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
systemctl restart "${SERVICES[@]}"

echo "==> Health check $HEALTH_URL"
for i in $(seq 1 45); do
  if curl -fs -o /dev/null --max-time 5 "$HEALTH_URL"; then
    echo "==> Deployed $SHA"
    ls -1dt "$RELEASES"/*/ | tail -n +4 | xargs -r rm -rf   # keep last 3
    exit 0
  fi
  sleep 2
done
echo "!! Health check failed - rolling back" >&2
journalctl -u "${SERVICES[0]}" -n 40 --no-pager >&2 || true
if [ -n "$PREV" ] && [ -d "$PREV" ]; then
  ln -sfn "$PREV" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
  systemctl restart "${SERVICES[@]}"
  echo "!! Rolled back to $PREV" >&2
fi
exit 1
DEPLOY
chown root:root "$APP_HOME/bin/deploy.sh"
chmod 750 "$APP_HOME/bin/deploy.sh"
echo "Wrote $APP_HOME/bin/deploy.sh"
EOF
```

Deploy for the first time:

```bash
sudo /opt/tg-checker/bin/deploy.sh
```

You should see `==> Deployed <commit>` after about 10–30 seconds. Then confirm the app listens on localhost only:

```bash
source /etc/tg-checker/deploy.conf
systemctl is-active "$APP"
curl -fsS "http://127.0.0.1:$PORT/api/health"; echo
sudo ss -ltnH "sport = :$PORT"
```

You should see `active`, `{"ok":true}`, and a `LISTEN` line showing **`127.0.0.1:3112`**. If it shows `*:3112` or `0.0.0.0:3112`, the shim from step 7 isn't loaded.

## 11. Put it on your domain (nginx + password + HTTPS)

Choose one:

- **A. Domain (recommended).** `DOMAIN` and `EMAIL` are set, and you get `https://DOMAIN` with a password prompt.
- **B. No domain.** `DOMAIN` is empty, and you get `http://<server-ip>:8112` with a password prompt. The password is sent **unencrypted**, so only use this if option C isn't practical.
- **C. Private, SSH tunnel only.** Skip this step entirely. On your computer run `ssh -N -L 3112:127.0.0.1:3112 your-user@your-server-ip`, then open `http://localhost:3112` while that command runs. Nothing is exposed and no password is needed.

The block below covers A and B. It generates a dashboard login once (`admin` plus a random password, kept on re-runs) and adds **only** this app's nginx site. It opens the needed port if ufw is active. In domain mode it also checks DNS and gets a Let's Encrypt certificate, with HTTP redirected to HTTPS. You can re-run it at any time. It rewrites the site and then re-applies the existing certificate.

The site sets `proxy_read_timeout 600s` because one "Verify & add" batch can take minutes with Safe mode on. The browser sends 50 usernames per request and they're checked one at a time, 1.2 s apart, with up to 8 s timeout each. nginx's default 60 s would cut that off with a 504.

```bash
sudo bash -euo pipefail <<'EOF'
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1   # additive only: needrestart must not restart other services
source /etc/tg-checker/deploy.conf
command -v nginx >/dev/null || { echo "STOP: nginx is not installed (another web server owns 80/443?). Use the Appendix."; exit 1; }
if [ -n "$DOMAIN" ] && [ -z "$EMAIL" ]; then echo "STOP: set EMAIL= in /etc/$APP/deploy.conf (needed for Let's Encrypt)."; exit 1; fi

# --- dashboard login (generated once) ---
if [ ! -s "/etc/$APP/htpasswd" ]; then
  PASS="$(openssl rand -hex 12)"
  printf 'admin:%s\n' "$(printf '%s' "$PASS" | openssl passwd -apr1 -stdin)" > "/etc/$APP/htpasswd"
  ( umask 077; printf 'Dashboard login for %s\nuser:     admin\npassword: %s\n' "$APP" "$PASS" > "/etc/$APP/dashboard-login.txt" )
fi
NGX_USER="$(nginx -T 2>/dev/null | awk '$1 == "user" {sub(/;$/, "", $2); print $2; exit}' || true)"
NGX_GROUP="$(id -gn "${NGX_USER:-www-data}" 2>/dev/null || true)"
if [ -n "$NGX_GROUP" ]; then chown "root:$NGX_GROUP" "/etc/$APP/htpasswd"; chmod 640 "/etc/$APP/htpasswd"; else chmod 644 "/etc/$APP/htpasswd"; fi

# --- nginx site ---
if [ -n "$DOMAIN" ]; then LPORT=80; NAME_LINE="server_name $DOMAIN;"; else LPORT="$PUBLIC_PORT"; NAME_LINE="# no domain: http://<server-ip>:$PUBLIC_PORT"; fi
LISTEN_LINES="listen $LPORT;"
if [ -f /proc/net/if_inet6 ]; then LISTEN_LINES="$LISTEN_LINES
    listen [::]:$LPORT;"; fi
if [ -d /etc/nginx/sites-available ]; then CONF="/etc/nginx/sites-available/$APP"; LINK="/etc/nginx/sites-enabled/$APP"
else CONF="/etc/nginx/conf.d/$APP.conf"; LINK=""; fi
cat > "$CONF" <<NGINX
# $APP - written by DEPLOY.md step 11. Re-run that step instead of editing by hand.
server {
    $LISTEN_LINES
    $NAME_LINE

    access_log /var/log/nginx/$APP.access.log;
    error_log  /var/log/nginx/$APP.error.log;

    client_max_body_size 2m;

    # The dashboard has no login of its own: always keep this password in front of it.
    auth_basic "$APP";
    auth_basic_user_file /etc/$APP/htpasswd;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
NGINX
if [ -n "$LINK" ]; then ln -sfn "$CONF" "$LINK"; fi
nginx -t
systemctl reload nginx || systemctl start nginx

# --- firewall: only if ufw is already active (never enables it) ---
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  if [ -n "$DOMAIN" ]; then ufw allow 80/tcp; ufw allow 443/tcp; else ufw allow "$PUBLIC_PORT/tcp"; fi
fi

# --- HTTPS (domain mode) ---
if [ -n "$DOMAIN" ]; then
  SERVER_IP="$(curl -4fsS --max-time 10 https://api.ipify.org || true)"
  if ! getent ahostsv4 "$DOMAIN" | awk '{print $1}' | grep -qx "${SERVER_IP:-none}"; then
    echo "STOP: $DOMAIN does not resolve to this server (${SERVER_IP:-unknown}) yet. Fix the DNS A record, wait, then re-run this block."
    exit 1
  fi
  if ! command -v certbot >/dev/null || { ! dpkg -s python3-certbot-nginx >/dev/null 2>&1 && [ ! -e /snap/bin/certbot ]; }; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends certbot python3-certbot-nginx
  fi
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring
  echo "==> Dashboard: https://$DOMAIN"
else
  echo "==> Dashboard: http://$(curl -4fsS --max-time 10 https://api.ipify.org || echo '<server-ip>'):$PUBLIC_PORT"
fi
echo "==> Login is stored in /etc/$APP/dashboard-login.txt (show it with: sudo cat /etc/$APP/dashboard-login.txt)"
EOF
```

You should see `syntax is ok`, `test is successful`, and in domain mode `Successfully deployed certificate`, then the dashboard URL. If your VPS provider has its own firewall (security groups), allow TCP 80+443 (domain) or 8112 (no-domain) there as well.

## 12. Verify

Check through nginx (expect `401` without the password and `{"ok":true}` with it):

```bash
source /etc/tg-checker/deploy.conf
if [ -n "$DOMAIN" ]; then URL="https://$DOMAIN"; else URL="http://$(curl -4fsS https://api.ipify.org):$PUBLIC_PORT"; fi
curl -s -o /dev/null -w "without password: %{http_code}\n" "$URL/"
curl -fsS -u "admin:$(sudo awk '/^password:/ {print $2}' "/etc/$APP/dashboard-login.txt")" "$URL/api/health"; echo
sudo cat "/etc/$APP/dashboard-login.txt"
```

Then do the first-time setup in the browser:

1. Open the URL and log in with the user and password printed above. The **Users** tab (verify usernames, roster, CSV) already works without a bot.
2. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`, then copy the token. Send `/setprivacy` and choose **Disable**, then `/setjoingroups` and choose **Enable**.
3. In the dashboard, go to **Settings**, paste the token and click **Save & connect**. The bot starts polling.
4. Now create a group (a supergroup), add the bot, and make it an **admin** with at least *Ban users* and *Invite users via link*. The bot being added or promoted is what makes the group appear under **Detected groups**. Click the group, then click **Save & connect** again. The **Group Chat** and **Members** tabs then fill in.

The full feature walkthrough is in [README.md](README.md#connect-the-bot-in-the-settings-tab).

To check the bot connection from the server (the token is shown masked):

```bash
source /etc/tg-checker/deploy.conf
curl -fsS "http://127.0.0.1:$PORT/api/settings"; echo
```

You should see `"polling":true` and `"lastError":null` once a token is saved.

**Change the dashboard password:** delete the login files and re-run step 11, which generates a new one:

```bash
source /etc/tg-checker/deploy.conf
sudo rm -f "/etc/$APP/htpasswd" "/etc/$APP/dashboard-login.txt"
```

## Updating

```bash
sudo /opt/tg-checker/bin/deploy.sh
```

This deploys the latest commit on `BRANCH`. Your database, bot token and settings live in `shared/data` and are kept. To move to a newer Node release later, re-run step 5 and then `sudo systemctl restart tg-checker`.

## Rolling back

`deploy.sh` rolls back on its own when the health check fails. To go back manually to the most recent other release:

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
cd "$APP_HOME/releases"
ls -1dt */
CUR="$(basename "$(readlink -f "$APP_HOME/current")")"
PREV="$(ls -1dt */ | sed 's#/$##' | grep -vx "$CUR" | head -1 || true)"
[ -n "$PREV" ] || { echo "No other release to roll back to."; exit 1; }
ln -sfn "$APP_HOME/releases/$PREV" "$APP_HOME/current.new" && mv -Tf "$APP_HOME/current.new" "$APP_HOME/current"
systemctl restart "$APP"
echo "Now running $PREV"
EOF
```

The schema only ever adds tables with `IF NOT EXISTS`, so rolling back is safe for the database. The next `deploy.sh` run goes forward to the latest commit again.

## Logs, status, restart

```bash
sudo systemctl status tg-checker --no-pager
sudo journalctl -u tg-checker -f
sudo journalctl -u tg-checker -n 100 --no-pager
sudo systemctl restart tg-checker
sudo tail -f /var/log/nginx/tg-checker.access.log /var/log/nginx/tg-checker.error.log
```

Telegram polling errors don't always reach the journal. They appear in **Settings** in the dashboard and as `lastError` in `curl -fsS http://127.0.0.1:3112/api/settings`.

## Backups and restore

Everything that matters is in **`/opt/tg-checker/shared/data/app.db`**: the roster, members, group feed, bot token and settings. Code comes from git. `/etc/tg-checker/` can be recreated with steps 1, 7 and 11.

Create a small backup script. It takes a consistent SQLite online backup while the app keeps running, checks it and keeps 14 days:

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
cat > "$APP_HOME/bin/backup.sh" <<'SCRIPT'
#!/usr/bin/env bash
# Online backup of the tg-checker SQLite database. Keeps 14 days.
set -euo pipefail
source /etc/tg-checker/deploy.conf
OUT="$APP_HOME/backups/app-$(date +%Y%m%d-%H%M%S).db"
as_app() { if [ "$(id -u)" -eq 0 ]; then sudo -u "$APP_USER" "$@"; else "$@"; fi; }
as_app sqlite3 "$APP_HOME/shared/data/app.db" ".backup '$OUT'"
[ "$(as_app sqlite3 "$OUT" 'PRAGMA integrity_check;')" = "ok" ] || { echo "Backup failed integrity check: $OUT" >&2; exit 1; }
as_app find "$APP_HOME/backups" -name 'app-*.db' -mtime +14 -delete
echo "Backup OK: $OUT"
SCRIPT
chown root:root "$APP_HOME/bin/backup.sh"
chmod 755 "$APP_HOME/bin/backup.sh"
"$APP_HOME/bin/backup.sh"
EOF
```

You should see `Backup OK: /opt/tg-checker/backups/app-<date>.db`. Take a backup any time with `sudo /opt/tg-checker/bin/backup.sh`. **Backups contain your bot token, so keep them private.** To copy the newest one to your computer, first copy it to your home folder on the server:

```bash
source /etc/tg-checker/deploy.conf
LATEST="$(sudo sh -c "ls -1t $APP_HOME/backups/*.db | head -1")"
sudo install -m 600 -o "$(id -un)" "$LATEST" ~/
ls -l ~/app-*.db
```

Then download it from your computer with `scp your-user@your-server-ip:~/app-*.db .`, and delete the copy on the server with `rm ~/app-*.db`.

Optional: run the backup every day at 03:30.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
cat > "/etc/systemd/system/$APP-backup.service" <<UNIT
[Unit]
Description=$APP - SQLite backup

[Service]
Type=oneshot
User=$APP_USER
Group=$APP_USER
UMask=0077
ExecStart=$APP_HOME/bin/backup.sh
UNIT
cat > "/etc/systemd/system/$APP-backup.timer" <<UNIT
[Unit]
Description=$APP - daily SQLite backup

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now "$APP-backup.timer"
systemctl start "$APP-backup.service"
journalctl -u "$APP-backup.service" -n 3 --no-pager
systemctl list-timers "$APP-backup.timer" --no-pager
EOF
```

You should see `Backup OK: ...` in the journal lines and the next run time in the timer list.

**Restore:** if the backup is on your computer, upload it first with `scp app-XXXX.db your-user@your-server-ip:~/`. Then set `BACKUP=` in the block below and paste it. The block stops the app, sets the current database aside, puts the backup in place and starts the app again.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
BACKUP="/opt/tg-checker/backups/app-YYYYMMDD-HHMMSS.db"   # <- edit: full path of the backup (or /home/your-user/app-....db)
[ -f "$BACKUP" ] || { echo "Backup not found: $BACKUP"; exit 1; }
D="$APP_HOME/shared/data"; STAMP="$(date +%Y%m%d-%H%M%S)"
systemctl stop "$APP"
for f in app.db app.db-wal app.db-shm; do
  if [ -e "$D/$f" ]; then mv "$D/$f" "$D/$f.before-restore-$STAMP"; fi
done
install -m 600 -o "$APP_USER" -g "$APP_USER" "$BACKUP" "$D/app.db"
systemctl start "$APP"
sleep 3; curl -fsS "http://127.0.0.1:$PORT/api/health"; echo
EOF
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Preflight: `Port 3112 is already in use` | Another app uses it | Set a free `PORT=` in `/etc/tg-checker/deploy.conf`, then re-run steps 9 and 11 and `sudo /opt/tg-checker/bin/deploy.sh` |
| `ss` shows `*:3112` / `0.0.0.0:3112` | Shim not loaded | Re-run step 7 and step 9. Check that `ExecStart` contains `--require /etc/tg-checker/listen-localhost.cjs` |
| nginx `502 Bad Gateway` | Service not running | `sudo journalctl -u tg-checker -n 50 --no-pager`, then `sudo systemctl restart tg-checker` |
| `504 Gateway Time-out` on big verifications | Batch took longer than 600 s (many usernames timing out) | Verify fewer names at a time, or raise `proxy_read_timeout` in step 11 and re-run it |
| Browser keeps asking for the password | Wrong password, or file unreadable by nginx | `sudo cat /etc/tg-checker/dashboard-login.txt`. Check `/var/log/nginx/tg-checker.error.log` for `permission denied`, then re-run step 11 |
| `nginx -t` fails | Error in another site, or a leftover `/etc/nginx/conf.d/tg-checker.conf` and `sites-enabled/tg-checker` both present | Read the file and line it names. Keep only one tg-checker site file |
| certbot: `DNS problem` / `Timeout during connect` | A record wrong or not propagated, or port 80 blocked by a provider firewall | `getent ahostsv4 your-domain` must show the server IP. Open 80/443 in the provider panel, then re-run step 11 |
| `deploy.sh`: `Permission denied (publickey)` | Deploy key missing on GitHub | Redo step 6 and check `sudo -u tg-checker -H ssh -T git@github.com` |
| Service log: `No such built-in module: node:sqlite` | Node older than 22.13 | Check `NODE_MAJOR=24` in `deploy.conf`, re-run step 5, restart |
| Service log: `database is locked` | A second copy is running (e.g. someone ran `npm start` in a release folder) | Stop the other copy. Only `tg-checker.service` may use `shared/data` |
| Settings shows `Conflict: terminated by other getUpdates request` | The same bot token is polling elsewhere (your laptop, another server) | Stop the other copy, or give this server its own bot |
| Settings shows `can't use getUpdates method while webhook is active` | A webhook was set on this bot by another tool | Run `curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"` once. This app only uses polling |
| Group never appears under "Detected groups" | The bot was added while the dashboard wasn't polling, or the service restarted. The list is kept in memory and only fills when the bot is added to or promoted in a group. | With the token saved, remove the bot's admin rights and grant them again (or remove and re-add the bot), then reload Settings |
| Every verification shows `Network error` / `timed out` | `t.me` blocked or rate-limiting this server's IP | `curl -sI https://t.me/telegram` on the server. Keep Safe mode on |
| `Permission denied` on `data/app.db` | Files created by hand as root | `sudo chown -R tg-checker:tg-checker /opt/tg-checker/shared/data && sudo chmod 700 /opt/tg-checker/shared/data` |

## Uninstall

This removes only what this guide created: the service and timer, the nginx site and logs, the certificate, the ufw port rule from no-domain mode, `/opt/tg-checker` (**including the database and backups**, so copy them off first), `/etc/tg-checker` and the `tg-checker` user. Packages stay installed. Also delete the deploy key on GitHub (repo → Settings → Deploy keys).

```bash
sudo bash -uo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf || exit 1
systemctl disable --now "$APP-backup.timer" "$APP" 2>/dev/null
rm -f "/etc/systemd/system/$APP.service" "/etc/systemd/system/$APP-backup.service" "/etc/systemd/system/$APP-backup.timer"
systemctl daemon-reload
rm -f "/etc/nginx/sites-enabled/$APP" "/etc/nginx/sites-available/$APP" "/etc/nginx/conf.d/$APP.conf"
if command -v nginx >/dev/null; then nginx -t && systemctl reload nginx; fi
rm -f /var/log/nginx/"$APP".access.log* /var/log/nginx/"$APP".error.log*
if [ -n "$DOMAIN" ] && command -v certbot >/dev/null; then certbot delete --cert-name "$DOMAIN" --non-interactive; fi
if [ -z "$DOMAIN" ] && command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw delete allow "$PUBLIC_PORT/tcp"; fi
userdel "$APP_USER" 2>/dev/null
rm -rf "${APP_HOME:?}" "/etc/${APP:?}"
echo "tg-checker removed. Installed packages were left in place."
EOF
```

## Appendix: Caddy / Apache instead of nginx

Use this if step 2 found another web server on ports 80/443. Do steps 1–10 as written, then use one of these in place of step 11. Both keep the password in front of the dashboard and the 600 s timeout.

**Caddy** (automatic HTTPS). Create a password hash with `caddy hash-password` (it prompts), add this to your Caddyfile, then run `sudo systemctl reload caddy`:

```
tg.example.com {
    basic_auth {
        admin <paste the $2a$... hash here>
    }
    reverse_proxy 127.0.0.1:3112 {
        transport http {
            read_timeout 600s
        }
    }
}
```

**Apache**: first create the password file. This prints the generated password once.

```bash
sudo bash -euo pipefail <<'EOF'
source /etc/tg-checker/deploy.conf
PASS="$(openssl rand -hex 12)"
printf 'admin:%s\n' "$(printf '%s' "$PASS" | openssl passwd -apr1 -stdin)" > "/etc/$APP/htpasswd"
chown root:www-data "/etc/$APP/htpasswd"; chmod 640 "/etc/$APP/htpasswd"
echo "Dashboard login: admin / $PASS"
a2enmod proxy proxy_http
EOF
```

Then create `/etc/apache2/sites-available/tg-checker.conf`, run `sudo a2ensite tg-checker && sudo apache2ctl configtest && sudo systemctl reload apache2`, and finally `sudo certbot --apache -d tg.example.com` (package `python3-certbot-apache`):

```
<VirtualHost *:80>
    ServerName tg.example.com
    ProxyPreserveHost On
    ProxyTimeout 600
    ProxyPass        / http://127.0.0.1:3112/
    ProxyPassReverse / http://127.0.0.1:3112/
    <Location />
        AuthType Basic
        AuthName "tg-checker"
        AuthUserFile /etc/tg-checker/htpasswd
        Require valid-user
    </Location>
</VirtualHost>
```
