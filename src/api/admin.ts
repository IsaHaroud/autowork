import { config } from "../config.ts";
import {
  getStats,
  listCustomers,
  searchCustomers,
  getCustomerFull,
  getCustomerById,
  getIdentities,
  listServices,
  listAllServices,
  listAllPayments,
  listPayments,
  listJobs,
  createService,
  findService,
  activateService,
  extendService,
  setServiceStatus,
  deleteService,
  recordPayment,
  setCustomerStatus,
  deleteCustomer,
  updateCustomerNotes,
  updateCustomerProfile,
  createCustomerManual,
  addIdentity,
  removeIdentity,
  listWhatsappAccounts,
  createWhatsappAccount,
  deleteWhatsappAccount,
  setWhatsappAccountStatus,
} from "../db/database.ts";
import { scaffoldServiceFolder } from "../bot/admin.ts";

export function isAuthorized(req: Request): boolean {
  const token = config.adminToken;
  if (!token) return true; // dev mode: open on localhost, warn in logs
  const header =
    req.headers.get("x-admin-token") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const url = new URL(req.url);
  const query = url.searchParams.get("token");
  return header === token || query === token;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function body<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

export async function handleAdminApi(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/admin")) return null;

  const path = url.pathname.replace(/^\/api\/admin/, "") || "/";
  const method = req.method.toUpperCase();

  // ---- PUBLIC: no password needed ----
  // Landing page needs owner WhatsApp + bot name. No sensitive data here.
  if (path === "/config" && method === "GET") {
    return json({
      ownerWhatsapp: config.ownerWhatsapp,
      adminTokenSet: !!config.adminToken,
      botUsername: config.telegramBotUsername ?? null,
    });
  }

  // Login check: frontend sends { token } or uses header, returns ok:true if password correct.
  // If no ADMIN_TOKEN is set on server, always ok (dev mode).
  if (path === "/login" && method === "POST") {
    if (!config.adminToken) return json({ ok: true, devOpen: true });
    const b = await body<{ token?: string }>(req);
    const provided =
      b.token?.trim() ||
      req.headers.get("x-admin-token")?.trim() ||
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ||
      "";
    if (provided && provided === config.adminToken) return json({ ok: true });
    return json({ error: "Wrong password." }, 401);
  }

  // ---- PRIVATE: everything below needs the password ----
  if (!isAuthorized(req)) {
    return json({ error: "Unauthorized. Enter admin password in /admin." }, 401);
  }

  try {
    // ---- stats ----
    if (path === "/stats" && method === "GET") {
      return json({ ...getStats(), ownerWhatsapp: config.ownerWhatsapp });
    }

    // ---- customers ----
    if (path === "/customers" && method === "GET") {
      const q = url.searchParams.get("q") || url.searchParams.get("search") || "";
      const list = q ? searchCustomers(q) : listCustomers(100);
      // enrich with identities + service counts (fast enough for MVP)
      const enriched = list.map((c) => ({
        ...c,
        identities: getIdentities(c.id),
        services: listServices(c.id),
      }));
      return json(enriched);
    }

    // Manual create: name only required, channels can be attached later
    if (path === "/customers" && method === "POST") {
      const b = await body<{
        name?: string; username?: string; notes?: string;
        status?: "TRIAL" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
        telegramId?: string; whatsappId?: string;
      }>(req);
      if (!b.name?.trim() && !b.telegramId?.trim() && !b.whatsappId?.trim()) {
        return json({ error: "Give at least a name or a Telegram/WhatsApp ID." }, 400);
      }
      if (b.status && !["TRIAL", "ACTIVE", "SUSPENDED", "CANCELLED"].includes(b.status)) {
        return json({ error: "Invalid status" }, 400);
      }
      try {
        const created = createCustomerManual({
          name: b.name ?? null,
          username: b.username ?? null,
          notes: b.notes ?? null,
          status: b.status ?? "TRIAL",
          telegramId: b.telegramId ?? null,
          whatsappId: b.whatsappId ?? null,
        });
        return json(getCustomerFull(created.id) ?? created, 201);
      } catch (e: any) {
        return json({ error: e?.message ?? "Create failed" }, 400);
      }
    }

    const customerMatch = path.match(/^\/customers\/(C-\d{4})$/i);
    if (customerMatch && method === "GET") {
      const full = getCustomerFull(customerMatch[1]!.toUpperCase());
      if (!full) return json({ error: "Not found" }, 404);
      return json(full);
    }

    // Edit name/username
    const profileMatch = path.match(/^\/customers\/(C-\d{4})\/profile$/i);
    if (profileMatch && method === "POST") {
      const id = profileMatch[1]!.toUpperCase();
      if (!getCustomerById(id)) return json({ error: "Not found" }, 404);
      const b = await body<{ name?: string; username?: string }>(req);
      updateCustomerProfile(id, { name: b.name ?? null, username: b.username ?? null });
      return json({ ok: true });
    }

    // Attach a channel later: { type: 'telegram'|'whatsapp', externalId }
    const identPost = path.match(/^\/customers\/(C-\d{4})\/identities$/i);
    if (identPost && method === "POST") {
      const id = identPost[1]!.toUpperCase();
      const b = await body<{ type?: string; externalId?: string }>(req);
      if (b.type !== "telegram" && b.type !== "whatsapp") {
        return json({ error: "type must be telegram or whatsapp" }, 400);
      }
      if (!b.externalId?.trim()) return json({ error: "externalId required" }, 400);
      try {
        const r = addIdentity(id, b.type, b.externalId);
        return json(r, 201);
      } catch (e: any) {
        return json({ error: e?.message ?? "Attach failed" }, 400);
      }
    }

    // Detach: DELETE /customers/C-0001/identities/telegram/123456
    const identDel = path.match(/^\/customers\/(C-\d{4})\/identities\/(telegram|whatsapp)\/(.+)$/i);
    if (identDel && method === "DELETE") {
      const id = identDel[1]!.toUpperCase();
      removeIdentity(id, identDel[2]!.toLowerCase() as any, decodeURIComponent(identDel[3]!));
      return json({ ok: true });
    }

    const statusMatch = path.match(/^\/customers\/(C-\d{4})\/status$/i);
    if (statusMatch && method === "POST") {
      const { status } = await body<{ status: string }>(req);
      const id = statusMatch[1]!.toUpperCase();
      if (!["TRIAL", "ACTIVE", "SUSPENDED", "CANCELLED"].includes(status)) {
        return json({ error: "Invalid status" }, 400);
      }
      if (!getCustomerById(id)) return json({ error: "Not found" }, 404);
      setCustomerStatus(id, status as any);
      return json({ ok: true });
    }

    const notesMatch = path.match(/^\/customers\/(C-\d{4})\/notes$/i);
    if (notesMatch && method === "POST") {
      const { notes } = await body<{ notes: string }>(req);
      const id = notesMatch[1]!.toUpperCase();
      updateCustomerNotes(id, notes ?? "");
      return json({ ok: true });
    }

    if (customerMatch && method === "DELETE") {
      const id = customerMatch[1]!.toUpperCase();
      deleteCustomer(id);
      try {
        const { rmSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const p = join("customers", id);
        if (existsSync(p)) rmSync(p, { recursive: true, force: true });
      } catch {}
      return json({ ok: true });
    }

    // ---- services ----
    if (path === "/services" && method === "GET") {
      const customerId = url.searchParams.get("customerId");
      if (customerId) return json(listServices(customerId.toUpperCase()));
      return json(listAllServices(200));
    }

    if (path === "/services" && method === "POST") {
      const b = await body<{ customerId: string; name: string; description?: string; priceDH?: number; price?: number }>(req);
      const customerId = (b.customerId || "").toUpperCase();
      if (!customerId || !b.name) return json({ error: "customerId and name required" }, 400);
      // accept price in DH (float) or cents
      let priceCents: number | null = null;
      if (typeof b.price === "number") priceCents = Math.round(b.price);
      else if (typeof b.priceDH === "number") priceCents = Math.round(b.priceDH * 100);
      const svc = createService({
        customerId,
        name: b.name,
        description: b.description ?? null,
        price: priceCents,
      });
      const folder = scaffoldServiceFolder(customerId, svc.name, svc.slug!, b.description ?? null, priceCents);
      return json({ ...svc, folder }, 201);
    }

    const svcAction = path.match(/^\/services\/(\d+)\/(activate|suspend|extend|paid)$/);
    if (svcAction && method === "POST") {
      const sid = Number(svcAction[1]);
      const action = svcAction[2];
      const b = await body<any>(req);
      if (action === "activate") {
        const months = Number(b.months ?? 1);
        const updated = activateService(sid, months);
        if (b.customerId) setCustomerStatus(String(b.customerId).toUpperCase(), "ACTIVE");
        return json(updated);
      }
      if (action === "suspend") {
        setServiceStatus(sid, "SUSPENDED");
        return json({ ok: true });
      }
      if (action === "extend") {
        const days = Number(b.days ?? 30);
        const updated = extendService(sid, days);
        return json(updated);
      }
      if (action === "paid") {
        const amountDH = Number(b.amountDH ?? b.amount ?? 0);
        if (!amountDH) return json({ error: "amountDH required" }, 400);
        const cents = Math.round(amountDH * 100);
        // need customerId: look up service
        const { getServiceById } = await import("../db/database.ts");
        const svc = getServiceById(sid);
        if (!svc) return json({ error: "Service not found" }, 404);
        recordPayment({ customerId: svc.customer_id, serviceId: sid, amount: cents, method: b.method ?? "manual" });
        const updated = activateService(sid, Number(b.months ?? 1));
        setCustomerStatus(svc.customer_id, "ACTIVE");
        return json(updated);
      }
    }

    const svcDel = path.match(/^\/services\/(\d+)$/);
    if (svcDel && method === "DELETE") {
      const sid = Number(svcDel[1]);
      const { getServiceById } = await import("../db/database.ts");
      const svc = getServiceById(sid);
      deleteService(sid);
      if (svc) {
        try {
          const { rmSync, existsSync } = await import("node:fs");
          const { join } = await import("node:path");
          const p = join("customers", svc.customer_id, svc.slug!);
          if (svc.slug && existsSync(p)) rmSync(p, { recursive: true, force: true });
        } catch {}
      }
      return json({ ok: true });
    }

    // ---- payments ----
    if (path === "/payments" && method === "GET") {
      const customerId = url.searchParams.get("customerId");
      if (customerId) return json(listPayments(customerId.toUpperCase(), 50));
      return json(listAllPayments(100));
    }
    if (path === "/payments" && method === "POST") {
      const b = await body<{ customerId: string; serviceId?: number; amountDH: number; method?: string }>(req);
      if (!b.customerId || !b.amountDH) return json({ error: "customerId and amountDH required" }, 400);
      recordPayment({
        customerId: b.customerId.toUpperCase(),
        serviceId: b.serviceId ?? null,
        amount: Math.round(Number(b.amountDH) * 100),
        method: b.method ?? "manual",
      });
      return json({ ok: true }, 201);
    }

    // ---- jobs ----
    if (path === "/jobs" && method === "GET") {
      const customerId = url.searchParams.get("customerId")?.toUpperCase() || undefined;
      return json(listJobs(customerId, 100));
    }

    // ---- whatsapp accounts ----
    if (path === "/whatsapp-accounts" && method === "GET") {
      const customerId = url.searchParams.get("customerId")?.toUpperCase() || undefined;
      return json(listWhatsappAccounts(customerId));
    }
    if (path === "/whatsapp-accounts" && method === "POST") {
      const b = await body<any>(req);
      const created = createWhatsappAccount({
        customerId: b.customerId ? String(b.customerId).toUpperCase() : null,
        label: b.label ?? null,
        displayNumber: b.displayNumber ?? b.display_number ?? null,
        phoneNumberId: b.phoneNumberId ?? b.phone_number_id ?? null,
        businessAccountId: b.businessAccountId ?? b.business_account_id ?? null,
        accessToken: b.accessToken ?? b.access_token ?? null,
        notes: b.notes ?? null,
      });
      return json(created, 201);
    }
    const waDel = path.match(/^\/whatsapp-accounts\/(\d+)$/);
    if (waDel && method === "DELETE") {
      deleteWhatsappAccount(Number(waDel[1]));
      return json({ ok: true });
    }
    const waStatus = path.match(/^\/whatsapp-accounts\/(\d+)\/status$/);
    if (waStatus && method === "POST") {
      const { status } = await body<{ status: string }>(req);
      if (!["CONNECTED", "DISCONNECTED", "EXPIRED"].includes(status)) {
        return json({ error: "Invalid status" }, 400);
      }
      setWhatsappAccountStatus(Number(waStatus[1]), status as any);
      return json({ ok: true });
    }

    return json({ error: "Not found: " + path }, 404);
  } catch (e: any) {
    console.error("Admin API error:", e);
    return json({ error: e?.message ?? "Internal error" }, 500);
  }
}
