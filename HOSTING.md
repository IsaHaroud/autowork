# HOSTING — cheapest real plan (VPS + domain + Meta webhook)

Goal: `https://YOURDOMAIN/` (landing, public) + `https://YOURDOMAIN/admin` (password)
+ `https://YOURDOMAIN/webhook/whatsapp` (Meta only) from one cheap VPS, one `bun` process.

## 0. Cheapest stack (2026 prices, incl. VAT approx)

| Piece | Pick | Cost |
|---|---|---|
| VPS | **Hetzner CAX11** (ARM, 2 vCPU / 4 GB / 40 GB, Falkenstein or Paris) | ~€4/mo |
| Domain | **.com via Cloudflare Registrar** (at-cost, free DNS + proxy off) — avoid `.ma` (~300 MAD/yr) for v1 | ~$10/yr |
| HTTPS | **Caddy** (auto Let's Encrypt, no certbot) | free |
| DNS | Cloudflare free (or registrar DNS) | free |
| App | This repo: Bun + SQLite (`./data/autowork.db`), port 3000, systemd | free |

Total year 1: **~€48 + ~$10 ≈ 600 MAD**. No database, no Redis, no Docker needed.

> Why Hetzner: cheapest reliable EU VPS with good ping to Morocco. Alternative: Contabo VPS S (~€4.5) — slower support. Avoid free-tier hosts for SQLite (disk wipes).

## 1. Buy + point domain (10 min)

1. Hetzner Cloud → New project → Server → Ubuntu 24.04, CAX11, Falkenstein (`fsn1`). Add your SSH key. Note IPv4, e.g. `1.2.3.4`.
2. Registrar (Cloudflare / Porkbun / Namecheap) → buy `yourdomain.com`.
3. DNS records (Cloudflare DNS → DNS → Records, proxy **OFF / grey cloud** so Caddy can issue certs):
```
A  @    1.2.3.4  (proxied OFF)
A  www  1.2.3.4  (proxied OFF)
```
4. Wait 2–10 min, check: `dig +short yourdomain.com` → `1.2.3.4`.

## 2. VPS base (SSH as root)

```bash
ssh root@1.2.3.4
apt update && apt upgrade -y
apt install -y git ufw curl gpg

# firewall: only SSH + HTTP/S (app listens on 127.0.0.1:3000, Caddy proxies)
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# Bun (app runtime)
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun --version   # want 1.4.x

# Caddy (HTTPS reverse proxy)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
systemctl enable --now caddy
```

## 3. Deploy app

```bash
mkdir -p /opt && cd /opt
git clone https://github.com/YOU/autowork.git
cd autowork
bun install

# env — copy from your PC, NEVER commit .env
nano .env
```

Required `.env` on VPS (see `.env.example`):
```
BOT_TOKEN=8675...                  # Telegram @BotFather
ADMIN_TELEGRAM_ID=5985506836
OWNER_WHATSAPP_NUMBER=+2126XXXXXXXX
WHATSAPP_TOKEN=EAA...              # Meta test or permanent token
WHATSAPP_PHONE_NUMBER_ID=1208...
WHATSAPP_VERIFY_TOKEN=autowork_verify_123   # you invent this, Meta must send it back
ADMIN_TOKEN=long-random-password-here        # IS the /admin password. REQUIRED.
TELEGRAM_BOT_USERNAME=autowork0_bot
PORT=3000
DATABASE_PATH=./data/autowork.db
```

```bash
# first run (foreground, check logs)
bun run src/index.ts
# expect: ✅ Bot @... + 🔒 Admin locked with ADMIN_TOKEN password
# Ctrl+C, then run as service below
```

## 4. systemd (keep alive + autostart)

`/etc/systemd/system/autowork.service`:
```ini
[Unit]
Description=Autowork Bun
After=network.target

[Service]
WorkingDirectory=/opt/autowork
ExecStart=/root/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5
EnvironmentFile=/opt/autowork/.env

[Install]
WantedBy=multi-user.target
```
```bash
systemctl daemon-reload
systemctl enable --now autowork
journalctl -u autowork -f   # logs: bot polling + 📩 WhatsApp
curl -s http://127.0.0.1:3000/health
# {"ok":true,"service":"autowork","whatsapp":true}
```

## 5. Caddy (domain → app)

`/etc/caddy/Caddyfile`:
```caddy
yourdomain.com {
    reverse_proxy 127.0.0.1:3000
}
www.yourdomain.com {
    redir https://yourdomain.com{uri}
}
```
```bash
caddy fmt --overwrite /etc/caddy/Caddyfile
systemctl reload caddy
# test (cert auto-issued in ~30s):
curl -s https://yourdomain.com/health
curl -s https://yourdomain.com/ | head -c 100
# /admin WITHOUT password must show login page ("Private area"), never dashboard:
curl -s https://yourdomain.com/admin | grep -o "Private area\|Control Center"
# → Private area
```

## 6. Link webhook to Meta / FB app (5 min)

This repo already implements verification in `src/channels/whatsapp.ts`:
`GET /webhook/whatsapp?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=...`
→ returns `challenge` only if tokens match.

1. Go to **developers.facebook.com → your App → WhatsApp → Configuration → Webhook → Edit**.
2. Fill:
```
Callback URL:  https://yourdomain.com/webhook/whatsapp
Verify token:  autowork_verify_123   (exactly WHATSAPP_VERIFY_TOKEN from .env)
```
3. **Verify and Save** → Meta sends GET, server logs `✅ WhatsApp webhook verified`.
4. **Webhook fields → Subscribe** to `messages` (needed for inbound).
5. Test: WhatsApp → API Setup → send `hello_world` template to your recipient number, then reply from phone → VPS logs `📩 WhatsApp from 212... → Customer C-XXXX`, auto-reply sent.

Troubleshooting:
| Symptom | Fix |
|---|---|
| Verify fails / 403 | `WHATSAPP_VERIFY_TOKEN` mismatch, or Caddy not reaching app (`curl http://127.0.0.1:3000/health` on VPS) |
| Challenge timeout | firewall/DNS: `curl -s https://yourdomain.com/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=autowork_verify_123&hub.challenge=123` must return `123` |
| 131030 recipient not allowed | test number: add recipient in Meta → API Setup → Manage numbers |
| 190 token expired | regenerate token in Meta, update `.env` → `systemctl restart autowork` |
| Messages arrive but no reply | `WHATSAPP_TOKEN`/`PHONE_NUMBER_ID` wrong — check `journalctl -u autowork` |

## 7. Operate (monthly)

```bash
# update
cd /opt/autowork && git pull && bun install && systemctl restart autowork

# backup (SQLite + customer folders + env) — weekly cron recommended
tar czf ~/autowork-backup-$(date +%F).tgz -C /opt/autowork data customers .env

# logs
journalctl -u autowork --since today | grep -E "WhatsApp|Bot|ERROR" | tail -50

# token rotation (Meta test tokens expire ~24h; production permanent token does not)
nano /opt/autowork/.env   # update WHATSAPP_TOKEN
systemctl restart autowork
```

Security notes: `ADMIN_TOKEN` set (else `/admin` open, startup warns). No extra ports open. `.env` never in git (`.gitignore`). Tokens in `whatsapp_accounts` table are masked in API lists. Webhook stays public by design (Meta can't send a password) — safety comes from verify-token + only creating TRIAL customers, never admin actions.
