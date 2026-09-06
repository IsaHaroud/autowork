import { createBot } from "./bot/bot.ts";
import { config } from "./config.ts";
import { getDb } from "./db/database.ts";
import { whatsappWebhookHandler } from "./channels/whatsapp.ts";
import { handleAdminApi } from "./api/admin.ts";

// Ensure DB initialized
getDb();

const bot = createBot();

console.log("🤖 Starting Autowork Bot...");
console.log(`   Owner WhatsApp: ${config.ownerWhatsapp}`);
console.log(`   Admin ID: ${config.adminId ?? "(not set - set ADMIN_TELEGRAM_ID in .env)"}`);
console.log(`   DB: ${config.databasePath}`);

if (!config.botToken) {
  console.error("❌ Cannot start: BOT_TOKEN missing");
  process.exit(1);
}

// Start Telegram polling (grammY)
bot.start({
  onStart: (info) => {
    console.log(`✅ Bot @${info.username} started (polling)`);
    console.log(`   Try /start in Telegram - it will return your ID + WhatsApp contact`);
  },
});

// HTTP server: landing + admin dashboard + admin API + WhatsApp webhooks + health
// Single process, no extra deps
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

async function serveFile(path: string): Promise<Response | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return new Response(f, {
    headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
  });
}

// ---- Admin gate: NOBODY sees dashboard HTML without password ----
// ADMIN_TOKEN in .env IS the password.
// Server checks (in order): ?token= query, x-admin-token header,
// Authorization: Bearer, cookie aw_token.
// If missing/wrong → serve login.html (password only, zero dashboard code).
// If correct → serve admin.html.
function tokenFromReq(req: Request): string | null {
  const url = new URL(req.url);
  const q = url.searchParams.get("token") || url.searchParams.get("pw");
  if (q) return q;
  const h =
    req.headers.get("x-admin-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (h) return h.trim();
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(/(?:^|;\s*)aw_token=([^;]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return m[1]!;
    }
  }
  return null;
}

function hasAdminAccess(req: Request): boolean {
  const expected = config.adminToken;
  if (!expected) return true; // dev: no password set → open
  const got = tokenFromReq(req);
  return !!got && got === expected;
}

const server = Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "autowork", whatsapp: !!config.whatsappToken }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/webhook/whatsapp")) {
      return await whatsappWebhookHandler(req);
    }

    if (url.pathname.startsWith("/api/admin")) {
      const res = await handleAdminApi(req);
      if (res) return res;
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Admin dashboard — SERVER-SIDE GATE
    if (
      url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname === "/admin.html"
    ) {
      if (hasAdminAccess(req)) {
        const r = await serveFile("public/admin.html");
        if (r) return r;
      }
      // No/wrong password → password page only. Dashboard HTML never leaves server.
      const login = await serveFile("public/login.html");
      if (login) return login;
      return new Response("Locked. Set ADMIN_TOKEN.", { status: 401 });
    }

    // Landing
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const r = await serveFile("public/index.html");
      if (r) return r;
    }

    // Static: public/* and logo/*
    if (url.pathname.startsWith("/logo/")) {
      const r = await serveFile(url.pathname.slice(1));
      if (r) return r;
    }
    // try public dir
    const pub = await serveFile("public" + url.pathname);
    if (pub) return pub;

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`🌐 HTTP server on http://localhost:${server.port}`);
console.log(`   Landing (PUBLIC):  http://localhost:${server.port}/`);
console.log(`   Admin (PASSWORD):  http://localhost:${server.port}/admin`);
console.log(`   API private:       /api/admin/* (needs ADMIN_TOKEN)`);
console.log(`   API public:        /api/admin/config, /api/admin/login`);
console.log(`   Webhook (PUBLIC):  /webhook/whatsapp (Meta only, verified by token)`);
if (!config.adminToken) {
  console.log(`   ⚠️  ADMIN_TOKEN not set — /admin is OPEN (set ADMIN_TOKEN in .env for VPS!)`);
} else {
  console.log(`   🔒 Admin locked with ADMIN_TOKEN password`);
}

function shutdown() {
  console.log("\n🛑 Shutting down...");
  bot.stop();
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
