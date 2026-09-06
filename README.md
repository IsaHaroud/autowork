# Autowork — Bun + Telegram + WhatsApp (MVP)

Single Telegram bot. `/start` returns Telegram ID + owner WhatsApp. Admin controls everything from Telegram, monthly billing.

## Stack
Bun 1.4.0 + grammy + SQLite (`bun:sqlite` WAL)

## Workflow (admin via Telegram)

```
User /start → auto C-0001 TRIAL → contacts you on WhatsApp
  ↓
You: /addservice C-0001 order-processing | cron daily 9am import Excel | 500
     → DB service TRIAL + customers/C-0001/order-processing/README.md (AI prompt)
     → User tests via /myservices (TRIAL)
  ↓
Likes it → pays → You: /paid C-0001 order-processing 500  OR  /activate C-0001 1
     → ACTIVE +30d (expires_at set), customer ACTIVE
  ↓
Cron on your PC checks: SELECT status,expires_at FROM services WHERE id=?
Only if ACTIVE && expires_at > now() → run customers/C-0001/order-processing/index.ts
  ↓
Month later expired → auto STOP → You: /extend or /paid again → +30d
  ↓
Not paying → /suspend C-0001 1  or  /suspend_customer C-0001
Want remove → /remove C-0001 1  or  /rmcustomer C-0001
```

## Quick start
```
bun install
# .env has BOT_TOKEN, OWNER_WHATSAPP_NUMBER, ADMIN_TELEGRAM_ID (your /start ID)
bun run dev  # watch
```
Test: `t.me/YourBot` → `/start`, `/myservices`, `/help`

## Admin commands (only ADMIN_TELEGRAM_ID)
```
/customers                    # list 30
/customer C-0001              # full detail + services + payments
/services C-0001              # list services

/addservice C-0001 <name> | <description for AI> | <price DH>
  ex: /addservice C-0001 order-processing | automate Excel daily 9am | 500
  → creates customers/C-0001/<slug>/README.md + PROMPT.md

/activate C-0001 <id|slug>    # ACTIVE +30d
/suspend C-0001 <id|slug>     # SUSPENDED
/remove C-0001 <id|slug>      # delete + rm folder
/paid C-0001 <id|slug> <amount> # record PAID + activate +30d
/extend C-0001 <id|slug> <days>

# customer level
/suspend_customer C-0001
/activate_customer C-0001
/rmcustomer C-0001
```

## Customer commands
```
/start /myid /status /myservices /help
```
Any plain text → remind to contact owner WhatsApp.

## WhatsApp (later)
Add `WHATSAPP_TOKEN` + `PHONE_NUMBER_ID` → webhook `https://you/webhook/whatsapp`

## Structure
```
src/config.ts
src/db/schema.ts (customers/identities/services/payments/jobs/whatsapp_accounts)
src/db/database.ts
src/bot/admin.ts   # lifecycle helpers + scaffold
src/bot/bot.ts     # single bot + admin check
src/channels/whatsapp.ts
src/api/admin.ts   # REST for dashboard
public/index.html  # landing page
public/admin.html  # admin dashboard
customers/C-0001/<slug>/  # isolated per service
```

## UI — Landing + Admin Dashboard
```
bun run src/index.ts
# Landing: http://localhost:3000/
# Admin:   http://localhost:3000/admin
# API:     http://localhost:3000/api/admin/stats
```
Landing explains the business (hero, solutions, how TRIAL→ACTIVE works, pricing in DH, WhatsApp/Telegram CTA).
Admin dashboard controls everything without Telegram commands:
- Overview: customers/services/revenue/jobs + expiring soon
- Customers: search, click for channels (Telegram ID copy + tg://, WhatsApp wa.me), services, payments, notes, activate/suspend/delete
- Services: add (name + description for AI + price DH → TRIAL + customers/ folder), activate +30d, paid, extend, suspend, remove
- Payments: record + history
- WhatsApp: connect customer Business numbers they gave you (label, display number, phone_number_id, business_account_id, token masked), link to customer
- Jobs: runs log

Auth: set `ADMIN_TOKEN=long-secret` in .env, enter it top-right in /admin (sent as `x-admin-token`). Without it API is open (dev mode warning).
