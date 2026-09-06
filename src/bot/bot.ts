import { Bot, InlineKeyboard } from "grammy";
import { config } from "../config.ts";
import {
  findOrCreateCustomerByTelegram,
  getCustomerById,
  getIdentities,
} from "../db/database.ts";
import {
  renderCustomersList,
  renderCustomerDetail,
  parseAddServiceArgs,
  scaffoldServiceFolder,
  createService,
  listServices,
  findService,
  activateService,
  extendService,
  setServiceStatus,
  deleteService,
  recordPayment,
  setCustomerStatus,
  deleteCustomer,
  formatPrice,
  formatExpiry,
} from "./admin.ts";

function isAdmin(userId: number | undefined): boolean {
  if (!userId) return false;
  if (!config.adminId) return false;
  return userId === config.adminId;
}

function requireAdmin(ctx: any): boolean {
  if (!isAdmin(ctx.from?.id)) {
    ctx.reply("⛔ Admin only. Set ADMIN_TELEGRAM_ID in .env to your Telegram ID.").catch(() => {});
    return false;
  }
  return true;
}

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  // ---- /start ----
  bot.command("start", async (ctx) => {
    const tgId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || undefined;
    const username = ctx.from?.username;
    if (!tgId) {
      await ctx.reply("❌ Could not identify you. Please try again.");
      return;
    }
    const { id: customerId, isNew } = findOrCreateCustomerByTelegram({
      telegramId: String(tgId),
      name,
      username,
    });
    const customer = getCustomerById(customerId);
    const whatsapp = config.ownerWhatsapp;
    const msg =
      `👋 Welcome${name ? ` ${name}` : ""}!\n\n` +
      `🆔 Your Telegram ID: \`${tgId}\`\n` +
      `💬 Chat ID: \`${chatId}\`\n` +
      `👤 Your Customer ID: \`${customerId}\` ${isNew ? "(new)" : ""}\n` +
      `📊 Status: ${customer?.status ?? "TRIAL"}\n\n` +
      `➡️ Next step:\n` +
      `Contact the owner on WhatsApp: *${whatsapp}*\n` +
      `Send him your Telegram ID (\`${tgId}\`) and describe the repetitive task you want to automate.\n` +
      `He will add your service and you can test it here.\n\n` +
      `Use /help for commands.`;
    await ctx.reply(msg, { parse_mode: "Markdown" });
  });

  bot.command("help", async (ctx) => {
    const admin = isAdmin(ctx.from?.id);
    let text =
      `*Autowork Bot*\n\n` +
      `*For everyone:*\n` +
      `/start - Get your IDs & owner WhatsApp\n` +
      `/myid - Show your IDs\n` +
      `/status - Your status\n` +
      `/myservices - Your services & trial/active info\n` +
      `/help - This message\n`;
    if (admin) {
      text +=
        `\n*Admin (YOU):*\n` +
        `/customers - List last 30 customers\n` +
        `/customer C-0001 - Full detail + services + payments\n` +
        `/services C-0001 - List services for customer\n` +
        `\n*Add service (no code yet, just description for AI):*\n` +
        `\`/addservice C-0001 <name> | <description> | <price>\`\n` +
        `Ex: \`/addservice C-0001 order-processing | cron daily 9am import Excel orders | 500\`\n` +
        `Creates \`customers/C-0001/<slug>/README.md\` with AI prompt.\n` +
        `\n*Lifecycle (monthly):*\n` +
        `/activate C-0001 <id|slug> - ACTIVE +30d (when paid)\n` +
        `/suspend C-0001 <id|slug> - SUSPENDED (stops cron)\n` +
        `/remove C-0001 <id|slug> - delete service + folder\n` +
        `/paid C-0001 <id|slug> <amount> - record payment & activate+30d\n` +
        `/extend C-0001 <id|slug> <days> - extend expiry\n` +
        `\n*Customer level:*\n` +
        `/suspend_customer C-0001\n` +
        `/activate_customer C-0001\n` +
        `/rmcustomer C-0001 - delete customer + all services\n` +
        `\n*Workflow:* /start (auto) → /addservice (TRIAL) → test → /activate or /paid (ACTIVE 30d) → monthly /paid or /extend`;
    } else {
      text += `\n_You are not admin. Set ADMIN_TELEGRAM_ID in .env._`;
    }
    await ctx.reply(text, { parse_mode: "Markdown" });
  });

  bot.command("myid", async (ctx) => {
    const tgId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!tgId) return;
    const { id: customerId } = findOrCreateCustomerByTelegram({
      telegramId: String(tgId),
      name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || undefined,
      username: ctx.from?.username,
    });
    await ctx.reply(
      `🆔 Telegram ID: \`${tgId}\`\n💬 Chat ID: \`${chatId}\`\n👤 Customer ID: \`${customerId}\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("status", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const { id: customerId } = findOrCreateCustomerByTelegram({ telegramId: String(tgId) });
    const customer = getCustomerById(customerId);
    const ids = getIdentities(customerId);
    const tg = ids.find((i) => i.type === "telegram")?.external_id ?? String(tgId);
    const wa = ids.find((i) => i.type === "whatsapp")?.external_id ?? "not connected";
    const services = listServices(customerId);
    let svcText = services.length ? "\n\n*Your services:*\n" : "\n\n_No services yet — contact owner._\n";
    for (const s of services) {
      const emoji = s.status === "ACTIVE" ? "🟢" : s.status === "TRIAL" ? "🟡" : "🔴";
      svcText += `${emoji} ${s.name} — ${s.status} — ${formatPrice(s.price)}/mo — exp: ${formatExpiry(s.expires_at)}\n`;
    }
    await ctx.reply(
      `*Your Status*\n\n👤 ${customerId} - ${customer?.name ?? "—"} ${customer?.username ? `(@${customer.username})` : ""}\nTelegram: \`${tg}\`\nWhatsApp: \`${wa}\`\nStatus: *${customer?.status}*${svcText}\nOwner WhatsApp: *${config.ownerWhatsapp}*`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("myservices", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const { id: customerId } = findOrCreateCustomerByTelegram({ telegramId: String(tgId) });
    const services = listServices(customerId);
    if (services.length === 0) {
      await ctx.reply("No services yet. Contact owner on WhatsApp: " + config.ownerWhatsapp);
      return;
    }
    let text = `*Your services (${customerId})*\n\n`;
    for (const s of services) {
      const emoji = s.status === "ACTIVE" ? "🟢" : s.status === "TRIAL" ? "🟡" : "🔴";
      text += `${emoji} \`${s.id}\` *${s.name}* (\`${s.slug}\`)\n  Status: ${s.status} — ${formatPrice(s.price)}/mo — exp: ${formatExpiry(s.expires_at)}\n`;
      if (s.description) text += `  _${s.description.slice(0, 100)}_\n`;
      text += s.status === "ACTIVE" ? "  ✅ Running\n\n" : s.status === "TRIAL" ? "  🧪 Trial — test it, then pay to activate\n\n" : "  ⏸️ Suspended\n\n";
    }
    await ctx.reply(text, { parse_mode: "Markdown" });
  });

  // ---- Admin commands ----
  bot.command("customers", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    await ctx.reply(renderCustomersList(), { parse_mode: "Markdown" });
  });

  bot.command("customer", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const arg = (ctx.match as string)?.trim() || ctx.message?.text?.split(/\s+/).slice(1).join(" ").trim();
    if (!arg) {
      await ctx.reply("Usage: /customer C-0001");
      return;
    }
    const id = arg.split(/\s+/)[0]!.toUpperCase();
    await ctx.reply(renderCustomerDetail(id), { parse_mode: "Markdown" });
  });

  bot.command("services", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const arg = (ctx.match as string)?.trim() || ctx.message?.text?.split(/\s+/).slice(1).join(" ").trim() || "";
    const customerId = arg.split(/\s+/)[0]?.toUpperCase();
    if (!customerId || !/^C-\d{4}$/.test(customerId)) {
      await ctx.reply("Usage: /services C-0001");
      return;
    }
    const c = getCustomerById(customerId);
    if (!c) {
      await ctx.reply(`❌ Customer \`${customerId}\` not found`, { parse_mode: "Markdown" });
      return;
    }
    const services = listServices(customerId);
    if (services.length === 0) {
      await ctx.reply(`No services for \`${customerId}\`. Add with:\n/addservice ${customerId} <name> | <description> | <price>`, { parse_mode: "Markdown" });
      return;
    }
    let text = `*Services for ${customerId} (${services.length})*\n\n`;
    for (const s of services) {
      const emoji = s.status === "ACTIVE" ? "🟢" : s.status === "TRIAL" ? "🟡" : "🔴";
      text += `${emoji} \`${s.id}\` *${s.name}* (\`${s.slug}\`) — ${s.status}\n  Price: ${formatPrice(s.price)}/mo — exp: ${formatExpiry(s.expires_at)}\n`;
    }
    await ctx.reply(text, { parse_mode: "Markdown" });
  });

  // /addservice C-0001 name | description | price
  bot.command("addservice", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const full = ctx.message?.text ?? "";
    const parsed = parseAddServiceArgs(full);
    if ("error" in parsed) {
      await ctx.reply(`❌ ${parsed.error}`, { parse_mode: "Markdown" });
      return;
    }
    const { customerId, name, description, price } = parsed;
    try {
      const svc = createService({ customerId, name, description, price });
      const folder = scaffoldServiceFolder(customerId, svc.name, svc.slug!, description, price);
      await ctx.reply(
        `✅ Service added *TRIAL*\n\n` +
          `Customer: \`${customerId}\`\n` +
          `Service: \`${svc.id}\` *${svc.name}* (\`${svc.slug}\`)\n` +
          `Price: ${formatPrice(price)}/mo\n` +
          `Status: TRIAL (customer can test)\n` +
          `Folder: \`${folder}/\`\n` +
          `Description: ${description ?? "—"}\n\n` +
          `Next: implement in \`customers/${customerId}/${svc.slug}/\` on your PC.\n` +
          `When paid: \`/activate ${customerId} ${svc.slug}\` or \`/paid ${customerId} ${svc.slug} 500\` → ACTIVE +30d`,
        { parse_mode: "Markdown" }
      );
    } catch (e: any) {
      await ctx.reply(`❌ Failed: ${e.message}`);
    }
  });

  // /activate C-0001 <id|slug>
  bot.command("activate", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const customerId = parts[0]?.toUpperCase();
    const svcIdent = parts.slice(1).join(" ").trim();
    if (!customerId || !svcIdent) {
      await ctx.reply("Usage: /activate C-0001 <service_id|slug>\nEx: /activate C-0001 1  or  /activate C-0001 order-processing");
      return;
    }
    if (!/^C-\d{4}$/.test(customerId)) {
      await ctx.reply("First arg must be C-0001");
      return;
    }
    const svc = findService(customerId, svcIdent);
    if (!svc) {
      await ctx.reply(`❌ Service \`${svcIdent}\` not found for \`${customerId}\``, { parse_mode: "Markdown" });
      return;
    }
    const updated = activateService(svc.id, 1);
    setCustomerStatus(customerId, "ACTIVE");
    await ctx.reply(
      `✅ Activated *${updated.name}* (\`${updated.slug}\`)\nCustomer: \`${customerId}\`\nService: \`${updated.id}\` — ACTIVE\nExpires: ${formatExpiry(updated.expires_at)}\n(+30 days monthly)`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("suspend", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const customerId = parts[0]?.toUpperCase();
    const svcIdent = parts.slice(1).join(" ").trim();
    if (!customerId || !svcIdent) {
      await ctx.reply("Usage: /suspend C-0001 <service_id|slug>");
      return;
    }
    const svc = findService(customerId, svcIdent);
    if (!svc) {
      await ctx.reply(`❌ Service \`${svcIdent}\` not found for \`${customerId}\``, { parse_mode: "Markdown" });
      return;
    }
    setServiceStatus(svc.id, "SUSPENDED");
    await ctx.reply(`⏸️ Suspended *${svc.name}* (\`${svc.slug}\`) for \`${customerId}\` — cron will stop`, { parse_mode: "Markdown" });
  });

  bot.command("remove", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const customerId = parts[0]?.toUpperCase();
    const svcIdent = parts.slice(1).join(" ").trim();
    if (!customerId || !svcIdent) {
      await ctx.reply("Usage: /remove C-0001 <service_id|slug>  — deletes service + folder");
      return;
    }
    const svc = findService(customerId, svcIdent);
    if (!svc) {
      await ctx.reply(`❌ Service \`${svcIdent}\` not found`, { parse_mode: "Markdown" });
      return;
    }
    deleteService(svc.id);
    // remove folder if exists
    try {
      const { rmSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const p = join("customers", customerId, svc.slug!);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      await ctx.reply(`🗑️ Removed service *${svc.name}* (\`${svc.slug}\`) for \`${customerId}\` + deleted \`${p}/\``, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(`🗑️ Removed service *${svc.name}* from DB`, { parse_mode: "Markdown" });
    }
  });

  // /paid C-0001 <id|slug> <amount> [method]
  bot.command("paid", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const customerId = parts[0]?.toUpperCase();
    const amountRaw = parts[parts.length - 1];
    const svcIdent = parts.slice(1, -1).join(" ").trim();
    // handle case where svcIdent contains spaces, amount is last token
    if (!customerId || !svcIdent || !amountRaw) {
      await ctx.reply("Usage: /paid C-0001 <service_id|slug> <amount>\nEx: /paid C-0001 order-processing 500  or  /paid C-0001 1 500");
      return;
    }
    const svc = findService(customerId, svcIdent);
    if (!svc) {
      await ctx.reply(`❌ Service \`${svcIdent}\` not found`, { parse_mode: "Markdown" });
      return;
    }
    const cleaned = Number(amountRaw.replace(/[^\d.]/g, ""));
    if (Number.isNaN(cleaned)) {
      await ctx.reply("❌ Amount must be number, e.g. 500");
      return;
    }
    const cents = Math.round(cleaned * 100);
    recordPayment({ customerId, serviceId: svc.id, amount: cents, method: "manual" });
    const updated = activateService(svc.id, 1);
    setCustomerStatus(customerId, "ACTIVE");
    await ctx.reply(
      `💰 Payment recorded: ${cleaned} DH for *${svc.name}* (\`${svc.slug}\`)\nCustomer: \`${customerId}\`\nService now: ACTIVE — exp: ${formatExpiry(updated.expires_at)} (+30d)\n`,
      { parse_mode: "Markdown" }
    );
  });

  // /extend C-0001 <id|slug> <days>
  bot.command("extend", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
    const customerId = parts[0]?.toUpperCase();
    const daysRaw = parts[parts.length - 1];
    const svcIdent = parts.slice(1, -1).join(" ").trim();
    if (!customerId || !svcIdent || !daysRaw) {
      await ctx.reply("Usage: /extend C-0001 <service_id|slug> <days>\nEx: /extend C-0001 order-processing 30");
      return;
    }
    const svc = findService(customerId, svcIdent);
    if (!svc) {
      await ctx.reply(`❌ Service not found`, { parse_mode: "Markdown" });
      return;
    }
    const days = Number(daysRaw);
    if (Number.isNaN(days) || days <= 0) {
      await ctx.reply("Days must be >0");
      return;
    }
    const updated = extendService(svc.id, days);
    await ctx.reply(`✅ Extended *${svc.name}* by ${days}d → exp: ${formatExpiry(updated.expires_at)}`, { parse_mode: "Markdown" });
  });

  // Customer-level
  bot.command("suspend_customer", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const id = (ctx.message?.text ?? "").split(/\s+/)[1]?.toUpperCase();
    if (!id || !/^C-\d{4}$/.test(id)) {
      await ctx.reply("Usage: /suspend_customer C-0001");
      return;
    }
    if (!getCustomerById(id)) {
      await ctx.reply(`❌ ${id} not found`);
      return;
    }
    setCustomerStatus(id, "SUSPENDED");
    // also suspend all services
    for (const s of listServices(id)) setServiceStatus(s.id, "SUSPENDED");
    await ctx.reply(`🔴 Customer \`${id}\` + all services SUSPENDED`, { parse_mode: "Markdown" });
  });

  bot.command("activate_customer", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const id = (ctx.message?.text ?? "").split(/\s+/)[1]?.toUpperCase();
    if (!id || !/^C-\d{4}$/.test(id)) {
      await ctx.reply("Usage: /activate_customer C-0001");
      return;
    }
    if (!getCustomerById(id)) {
      await ctx.reply(`❌ ${id} not found`);
      return;
    }
    setCustomerStatus(id, "ACTIVE");
    await ctx.reply(`🟢 Customer \`${id}\` ACTIVE`, { parse_mode: "Markdown" });
  });

  bot.command("rmcustomer", async (ctx) => {
    if (!requireAdmin(ctx)) return;
    const id = (ctx.message?.text ?? "").split(/\s+/)[1]?.toUpperCase();
    if (!id || !/^C-\d{4}$/.test(id)) {
      await ctx.reply("Usage: /rmcustomer C-0001  — deletes customer + all services + folder");
      return;
    }
    if (!getCustomerById(id)) {
      await ctx.reply(`❌ ${id} not found`);
      return;
    }
    deleteCustomer(id);
    try {
      const { rmSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const p = join("customers", id);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    } catch {}
    await ctx.reply(`🗑️ Customer \`${id}\` deleted`, { parse_mode: "Markdown" });
  });

  // Fallback text
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return next();
    const tgId = ctx.from?.id;
    if (tgId && !isAdmin(tgId)) {
      await ctx.reply(
        `Thanks! 🙏\nTo automate a task, contact owner on WhatsApp: *${config.ownerWhatsapp}*\nSend your Telegram ID: \`${tgId}\` + task description.\nUse /myservices to see your services.`,
        { parse_mode: "Markdown" }
      );
    }
  });

  bot.catch((err) => console.error("Bot error:", err));
  return bot;
}
