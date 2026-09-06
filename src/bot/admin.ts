import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createService,
  listServices,
  findService,
  getServiceById,
  setServiceStatus,
  deleteService,
  activateService,
  extendService,
  recordPayment,
  listPayments,
  getCustomerById,
  listCustomers,
  getIdentities,
  setCustomerStatus,
  deleteCustomer,
} from "../db/database.ts";

function parsePrice(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.]/g, "");
  const n = Number(cleaned);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100); // store as cents
}
function formatPrice(cents: number | null): string {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(cents % 100 ? 2 : 0)} DH`;
}
function formatExpiry(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const days = Math.ceil((d.getTime() - now.getTime()) / 86400000);
  return `${d.toISOString().slice(0, 10)} (${days > 0 ? `${days}d left` : days === 0 ? "today" : "expired"})`;
}

// Scaffold folder for AI implementation
export function scaffoldServiceFolder(customerId: string, serviceName: string, slug: string, description: string | null, price: number | null) {
  const base = join("customers", customerId, slug);
  mkdirSync(join(base, "input"), { recursive: true });
  mkdirSync(join(base, "output"), { recursive: true });

  const prompt = `# ${serviceName} — ${customerId}

Customer: ${customerId}
Service: ${serviceName}
Slug: ${slug}
Price: ${formatPrice(price)} / month
Status: TRIAL

## Description (AI will use this to implement)
${description ?? "(no description yet — ask customer for details)"}

## Instructions for AI / dev on PC
1. Implement automation in this folder: \`customers/${customerId}/${slug}/\`
2. Inputs go in \`input/\`, outputs in \`output/\`
3. Use cron or on-demand trigger checked against DB:
   SELECT status, expires_at FROM services WHERE id = <service_id>
   Only run if status='ACTIVE' and expires_at > now()
4. Log jobs to DB jobs table if needed.

## Test flow
- Customer tests while TRIAL
- Admin runs /activate ${customerId} ${slug} when paid -> expires +30d

Generated: ${new Date().toISOString()}
`;
  writeFileSync(join(base, "README.md"), prompt);
  writeFileSync(join(base, "PROMPT.md"), description ?? "");
  return base;
}

export function parseAddServiceArgs(text: string): {
  customerId: string;
  name: string;
  description: string | null;
  price: number | null;
} | { error: string } {
  // formats:
  // /addservice C-0001 order-processing | description | 500
  // /addservice C-0001 "Order Processing" | description | 500 DH
  const withoutCmd = text.replace(/^\/\w+\s+/, "").trim();
  if (!withoutCmd) return { error: "Usage: /addservice C-0001 <name> | <description> | <price DH>\nEx: /addservice C-0001 order-processing | automate Excel orders daily 9am | 500" };
  const parts = withoutCmd.split("|").map((s) => s.trim());
  const first = parts[0] ?? "";
  // first part contains customerId + name
  const m = first.match(/^(C-\d{4})\s+(.+)$/i);
  if (!m) return { error: "First part must be: C-0001 <service-name>\nEx: /addservice C-0001 order-processing | description | 500" };
  const customerId = m[1].toUpperCase();
  const name = m[2].replace(/^["']|["']$/g, "").trim();
  if (!name) return { error: "Service name missing" };
  const description = parts[1]?.trim() || null;
  const price = parsePrice(parts[2]);
  return { customerId, name, description, price };
}

export function renderCustomerDetail(customerId: string): string {
  const c = getCustomerById(customerId);
  if (!c) return `❌ Customer \`${customerId}\` not found.`;
  const ids = getIdentities(customerId);
  const tg = ids.find((i) => i.type === "telegram")?.external_id ?? "—";
  const wa = ids.find((i) => i.type === "whatsapp")?.external_id ?? "—";
  const services = listServices(customerId);
  const payments = listPayments(customerId, 3);

  let text =
    `*${c.id}* — ${c.name ?? "—"} ${c.username ? `@${c.username}` : ""}\n` +
    `Telegram: \`${tg}\`  WhatsApp: \`${wa}\`\n` +
    `Customer status: *${c.status}*  Created: ${c.created_at.slice(0, 10)}\n` +
    (c.notes ? `Notes: ${c.notes}\n` : "") +
    `\n*Services (${services.length}):*\n`;
  if (services.length === 0) text += "_none — add with /addservice_\n";
  else
    for (const s of services) {
      const emoji = s.status === "ACTIVE" ? "🟢" : s.status === "TRIAL" ? "🟡" : s.status === "SUSPENDED" ? "🔴" : "⚪️";
      text += `${emoji} \`${s.id}\` *${s.name}* (\`${s.slug}\`) — ${s.status} — ${formatPrice(s.price)}/mo — exp: ${formatExpiry(s.expires_at)}\n`;
      if (s.description) text += `   _${s.description.slice(0, 80)}${s.description.length > 80 ? "…" : ""}_\n`;
    }
  if (payments.length) {
    text += `\n*Last payments:*\n`;
    for (const p of payments) text += `• ${p.amount / 100} DH — ${p.status} ${p.service_id ? `(svc ${p.service_id})` : ""} ${p.paid_at?.slice(0, 10) ?? ""}\n`;
  }
  text += `\n*Admin:*\n\`/addservice ${c.id} <name> | <description> | <price>\`\n\`/activate ${c.id} <id|slug>\`  \`/suspend ${c.id} <id|slug>\`  \`/remove ${c.id} <id|slug>\`\n\`/paid ${c.id} <id|slug> <amount>\`  \`/extend ${c.id} <id|slug> <days>\`\n\`/suspend_customer ${c.id}\`  \`/activate_customer ${c.id}\`  \`/rmcustomer ${c.id}\``;
  return text;
}

export function renderCustomersList(): string {
  const customers = listCustomers(30);
  if (customers.length === 0) return "No customers yet. They appear after /start.";
  const lines = customers.map((c) => {
    const svcCount = listServices(c.id).length;
    const emoji = c.status === "ACTIVE" ? "🟢" : c.status === "TRIAL" ? "🟡" : "🔴";
    return `${emoji} \`${c.id}\` ${c.name ?? "—"} ${c.username ? `@${c.username}` : ""} — ${c.status} — ${svcCount} svc`;
  });
  return `*Customers (${customers.length})*\n\n` + lines.join("\n") + `\n\nUse \`/customer C-0001\` for detail.`;
}

// Re-export helpers for bot.ts
export {
  createService,
  listServices,
  findService,
  getServiceById,
  setServiceStatus,
  deleteService,
  activateService,
  extendService,
  recordPayment,
  getCustomerById,
  setCustomerStatus,
  deleteCustomer,
  formatPrice,
  formatExpiry,
};
