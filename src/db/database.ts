import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.ts";
import { SCHEMA_SQL } from "./schema.ts";

let db: Database | null = null;

function runMigrations(database: Database) {
  const hasCol = (table: string, col: string) => {
    const rows = database.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === col);
  };
  const adds: [string, string, string][] = [
    ["services", "slug", "ALTER TABLE services ADD COLUMN slug TEXT"],
    ["services", "description", "ALTER TABLE services ADD COLUMN description TEXT"],
    ["services", "billing_cycle", "ALTER TABLE services ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'monthly'"],
    ["services", "expires_at", "ALTER TABLE services ADD COLUMN expires_at TEXT"],
  ];
  for (const [t, c, sql] of adds) if (!hasCol(t, c)) database.exec(sql);
}

export function getDb(): Database {
  if (db) return db;

  const path = config.databasePath;
  mkdirSync(dirname(path), { recursive: true });
  db = new Database(path, { create: true });
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  // backfill slug where null
  try {
    db.exec("UPDATE services SET slug = lower(replace(replace(name,' ','-'),'/','-')) WHERE slug IS NULL");
  } catch {}
  return db;
}

export function generateCustomerId(db: Database): string {
  const row = db.query("SELECT id FROM customers ORDER BY id DESC LIMIT 1").get() as
    | { id: string }
    | null;
  if (!row) return "C-0001";
  const num = parseInt(row.id.slice(2), 10) + 1;
  return `C-${String(num).padStart(4, "0")}`;
}

export function findOrCreateCustomerByTelegram(params: {
  telegramId: string;
  name?: string;
  username?: string;
}): { id: string; isNew: boolean } {
  const database = getDb();

  const identity = database
    .query("SELECT customer_id FROM identities WHERE type='telegram' AND external_id=?")
    .get(params.telegramId) as { customer_id: string } | null;

  if (identity) {
    // update name/username if changed
    if (params.name || params.username) {
      database
        .query("UPDATE customers SET name=COALESCE(?,name), username=COALESCE(?,username), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .run(params.name ?? null, params.username ?? null, identity.customer_id);
    }
    return { id: identity.customer_id, isNew: false };
  }

  const newId = generateCustomerId(database);
  const tx = database.transaction(() => {
    database
      .query(
        "INSERT INTO customers (id, name, username, status) VALUES (?,?,?, 'TRIAL')"
      )
      .run(newId, params.name ?? null, params.username ?? null);
    database
      .query(
        "INSERT INTO identities (customer_id, type, external_id) VALUES (?, 'telegram', ?)"
      )
      .run(newId, params.telegramId);
  });
  tx();
  return { id: newId, isNew: true };
}

export type CustomerRow = {
  id: string;
  name: string | null;
  username: string | null;
  status: string;
  notes: string | null;
  created_at: string;
};

export function getCustomerById(id: string): CustomerRow | null {
  return getDb().query("SELECT * FROM customers WHERE id=?").get(id) as CustomerRow | null;
}

export function listCustomers(limit = 100): CustomerRow[] {
  return getDb()
    .query("SELECT * FROM customers ORDER BY created_at DESC LIMIT ?")
    .all(limit) as CustomerRow[];
}

export function searchCustomers(q: string, limit = 50): CustomerRow[] {
  const like = `%${q}%`;
  return getDb()
    .query(
      `SELECT DISTINCT c.* FROM customers c LEFT JOIN identities i ON i.customer_id = c.id
       WHERE c.id LIKE ? OR c.name LIKE ? OR c.username LIKE ? OR i.external_id LIKE ?
       ORDER BY c.created_at DESC LIMIT ?`
    )
    .all(like, like, like, like, limit) as CustomerRow[];
}

export function getStats() {
  const db = getDb();
  const one = (sql: string, ...params: any[]) =>
    (db.query(sql).get(...params) as any) ?? {};
  const customersTotal = (one("SELECT COUNT(*) as c FROM customers") as any).c ?? 0;
  const customersActive = (one("SELECT COUNT(*) as c FROM customers WHERE status='ACTIVE'") as any).c ?? 0;
  const customersTrial = (one("SELECT COUNT(*) as c FROM customers WHERE status='TRIAL'") as any).c ?? 0;
  const customersSuspended = (one("SELECT COUNT(*) as c FROM customers WHERE status='SUSPENDED'") as any).c ?? 0;
  const servicesTotal = (one("SELECT COUNT(*) as c FROM services") as any).c ?? 0;
  const servicesActive = (one("SELECT COUNT(*) as c FROM services WHERE status='ACTIVE'") as any).c ?? 0;
  const servicesTrial = (one("SELECT COUNT(*) as c FROM services WHERE status='TRIAL'") as any).c ?? 0;
  const revenueCents = (one("SELECT COALESCE(SUM(amount),0) as s FROM payments WHERE status='PAID'") as any).s ?? 0;
  const jobsTotal = (one("SELECT COUNT(*) as c FROM jobs") as any).c ?? 0;
  const jobsFailed = (one("SELECT COUNT(*) as c FROM jobs WHERE status='FAILED'") as any).c ?? 0;
  const expiringSoon = db
    .query(
      "SELECT s.*, c.name as customer_name FROM services s JOIN customers c ON c.id=s.customer_id WHERE s.status='ACTIVE' AND s.expires_at IS NOT NULL AND s.expires_at < datetime('now','+7 days') ORDER BY s.expires_at ASC LIMIT 10"
    )
    .all() as any[];
  return {
    customersTotal, customersActive, customersTrial, customersSuspended,
    servicesTotal, servicesActive, servicesTrial,
    revenueCents, jobsTotal, jobsFailed, expiringSoon,
  };
}

export function listAllServices(limit = 100) {
  return getDb()
    .query(
      "SELECT s.*, c.name as customer_name FROM services s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.created_at DESC LIMIT ?"
    )
    .all(limit) as any[];
}

export function listAllPayments(limit = 100) {
  return getDb()
    .query(
      "SELECT p.*, c.name as customer_name FROM payments p LEFT JOIN customers c ON c.id=p.customer_id ORDER BY p.created_at DESC LIMIT ?"
    )
    .all(limit) as any[];
}

export function listJobs(customerId?: string, limit = 50) {
  if (customerId) {
    return getDb()
      .query("SELECT * FROM jobs WHERE customer_id=? ORDER BY created_at DESC LIMIT ?")
      .all(customerId, limit) as any[];
  }
  return getDb().query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit) as any[];
}

export function getCustomerFull(id: string) {
  const customer = getCustomerById(id);
  if (!customer) return null;
  return {
    ...customer,
    identities: getIdentities(id),
    services: listServices(id),
    payments: listPayments(id, 20),
    jobs: listJobs(id, 20),
    whatsappAccounts: listWhatsappAccounts(id),
  };
}

// ---------- WhatsApp accounts (customer numbers you control) ----------
export type WhatsappAccountRow = {
  id: number;
  customer_id: string | null;
  label: string | null;
  display_number: string | null;
  phone_number_id: string | null;
  business_account_id: string | null;
  access_token: string | null;
  status: string;
  notes: string | null;
  created_at: string;
};

function maskToken(t: string | null): string | null {
  if (!t) return null;
  if (t.length <= 8) return "••••";
  return t.slice(0, 4) + "••••" + t.slice(-4);
}

export function listWhatsappAccounts(customerId?: string) {
  const rows = customerId
    ? (getDb().query("SELECT * FROM whatsapp_accounts WHERE customer_id=? ORDER BY created_at DESC").all(customerId) as WhatsappAccountRow[])
    : (getDb().query("SELECT wa.*, c.name as customer_name FROM whatsapp_accounts wa LEFT JOIN customers c ON c.id=wa.customer_id ORDER BY wa.created_at DESC").all() as any[]);
  // never leak full token via list
  return rows.map((r: any) => ({ ...r, access_token: undefined, token_masked: maskToken(r.access_token) }));
}

export function createWhatsappAccount(params: {
  customerId?: string | null;
  label?: string | null;
  displayNumber?: string | null;
  phoneNumberId?: string | null;
  businessAccountId?: string | null;
  accessToken?: string | null;
  notes?: string | null;
}) {
  const db = getDb();
  const row = db
    .query(
      "INSERT INTO whatsapp_accounts (customer_id, label, display_number, phone_number_id, business_account_id, access_token, status) VALUES (?,?,?,?,?,?,'CONNECTED') RETURNING *"
    )
    .get(
      params.customerId || null,
      params.label || null,
      params.displayNumber || null,
      params.phoneNumberId || null,
      params.businessAccountId || null,
      params.accessToken || null
    ) as WhatsappAccountRow;
  return { ...row, access_token: undefined, token_masked: maskToken(row.access_token) };
}

export function deleteWhatsappAccount(id: number) {
  getDb().query("DELETE FROM whatsapp_accounts WHERE id=?").run(id);
}

export function setWhatsappAccountStatus(id: number, status: "CONNECTED" | "DISCONNECTED" | "EXPIRED") {
  getDb()
    .query("UPDATE whatsapp_accounts SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(status, id);
}

export function getIdentities(customerId: string) {
  return getDb()
    .query("SELECT type, external_id FROM identities WHERE customer_id=?")
    .all(customerId) as { type: string; external_id: string }[];
}

export function findOrCreateCustomerByWhatsapp(params: {
  whatsappId: string; // e.g. 2126XXXXXXXX without +
  name?: string;
}): { id: string; isNew: boolean } {
  const database = getDb();
  const clean = params.whatsappId.replace(/^\+/, "");
  const identity = database
    .query("SELECT customer_id FROM identities WHERE type='whatsapp' AND external_id=?")
    .get(clean) as { customer_id: string } | null;
  if (identity) return { id: identity.customer_id, isNew: false };
  // try to link if same customer already has telegram? For now create new
  const newId = generateCustomerId(database);
  const tx = database.transaction(() => {
    database.query("INSERT INTO customers (id, name, status) VALUES (?,?, 'TRIAL')").run(newId, params.name ?? null);
    database.query("INSERT INTO identities (customer_id, type, external_id) VALUES (?, 'whatsapp', ?)").run(newId, clean);
  });
  tx();
  return { id: newId, isNew: true };
}

export function findCustomerByWhatsapp(whatsappId: string): string | null {
  const clean = whatsappId.replace(/^\+/, "");
  const row = getDb()
    .query("SELECT customer_id FROM identities WHERE type='whatsapp' AND external_id=?")
    .get(clean) as { customer_id: string } | null;
  return row?.customer_id ?? null;
}

// ---------- Services ----------
export type ServiceRow = {
  id: number;
  customer_id: string;
  name: string;
  slug: string | null;
  description: string | null;
  status: string;
  price: number | null;
  billing_cycle: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "service";
}

export function createService(params: {
  customerId: string;
  name: string;
  description?: string | null;
  price?: number | null;
  billingCycle?: string;
}): ServiceRow {
  const db = getDb();
  const customer = db.query("SELECT id FROM customers WHERE id=?").get(params.customerId) as
    | { id: string }
    | null;
  if (!customer) throw new Error(`Customer ${params.customerId} not found`);
  const slug = slugify(params.name);
  const res = db
    .query(
      "INSERT INTO services (customer_id, name, slug, description, price, billing_cycle, status) VALUES (?,?,?,?,?,?, 'TRIAL') RETURNING *"
    )
    .get(
      params.customerId,
      params.name,
      slug,
      params.description ?? null,
      params.price ?? null,
      params.billingCycle ?? "monthly"
    ) as ServiceRow;
  return res;
}

export function listServices(customerId: string): ServiceRow[] {
  return getDb()
    .query("SELECT * FROM services WHERE customer_id=? ORDER BY created_at ASC")
    .all(customerId) as ServiceRow[];
}

export function getServiceById(id: number): ServiceRow | null {
  return getDb().query("SELECT * FROM services WHERE id=?").get(id) as ServiceRow | null;
}

export function findService(customerId: string, identifier: string): ServiceRow | null {
  const id = Number(identifier);
  if (!Number.isNaN(id) && String(id) === identifier.trim()) {
    const byId = getServiceById(id);
    if (byId && byId.customer_id === customerId) return byId;
  }
  const slug = slugify(identifier);
  return (
    (getDb()
      .query("SELECT * FROM services WHERE customer_id=? AND (slug=? OR lower(name)=lower(?)) LIMIT 1")
      .get(customerId, slug, identifier) as ServiceRow | null) ?? null
  );
}

export function setServiceStatus(
  serviceId: number,
  status: "TRIAL" | "ACTIVE" | "PAUSED" | "SUSPENDED" | "CANCELLED",
  expiresAt: string | null = null
): void {
  const db = getDb();
  if (expiresAt !== null) {
    db.query(
      "UPDATE services SET status=?, expires_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
    ).run(status, expiresAt, serviceId);
  } else {
    db.query(
      "UPDATE services SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
    ).run(status, serviceId);
  }
}

export function deleteService(serviceId: number): void {
  getDb().query("DELETE FROM services WHERE id=?").run(serviceId);
}

export function activateService(serviceId: number, months = 1): ServiceRow {
  const expires = new Date();
  expires.setDate(expires.getDate() + 30 * months);
  const iso = expires.toISOString();
  setServiceStatus(serviceId, "ACTIVE", iso);
  return getServiceById(serviceId)!;
}

export function extendService(serviceId: number, days: number): ServiceRow {
  const svc = getServiceById(serviceId);
  if (!svc) throw new Error("Service not found");
  let base = svc.expires_at ? new Date(svc.expires_at) : new Date();
  if (base < new Date()) base = new Date();
  base.setDate(base.getDate() + days);
  getDb()
    .query("UPDATE services SET expires_at=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(base.toISOString(), serviceId);
  return getServiceById(serviceId)!;
}

// ---------- Payments ----------
export function recordPayment(params: {
  customerId: string;
  serviceId?: number | null;
  amount: number;
  method?: string | null;
}): void {
  getDb()
    .query(
      "INSERT INTO payments (customer_id, service_id, amount, status, method, paid_at) VALUES (?,?,?, 'PAID', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
    )
    .run(params.customerId, params.serviceId ?? null, params.amount, params.method ?? null);
}

export function listPayments(customerId: string, limit = 10) {
  return getDb()
    .query("SELECT * FROM payments WHERE customer_id=? ORDER BY created_at DESC LIMIT ?")
    .all(customerId, limit) as any[];
}

// ---------- Customers lifecycle ----------
export function createCustomerManual(params: {
  name?: string | null;
  username?: string | null;
  notes?: string | null;
  status?: "TRIAL" | "ACTIVE" | "SUSPENDED" | "CANCELLED";
  telegramId?: string | null;
  whatsappId?: string | null;
}): CustomerRow {
  const db = getDb();
  const cleanTg = params.telegramId?.trim() || null;
  const cleanWa = params.whatsappId?.replace(/[+\s]/g, "") || null;

  // uniqueness checks before creating
  if (cleanTg) {
    const clash = db
      .query("SELECT customer_id FROM identities WHERE type='telegram' AND external_id=?")
      .get(cleanTg) as { customer_id: string } | null;
    if (clash) throw new Error(`Telegram ID ${cleanTg} already linked to ${clash.customer_id}`);
  }
  if (cleanWa) {
    const clash = db
      .query("SELECT customer_id FROM identities WHERE type='whatsapp' AND external_id=?")
      .get(cleanWa) as { customer_id: string } | null;
    if (clash) throw new Error(`WhatsApp ${cleanWa} already linked to ${clash.customer_id}`);
  }

  const newId = generateCustomerId(db);
  const tx = db.transaction(() => {
    db.query("INSERT INTO customers (id, name, username, notes, status) VALUES (?,?,?,?,?)").run(
      newId,
      params.name?.trim() || null,
      params.username?.replace(/^@/, "").trim() || null,
      params.notes?.trim() || null,
      params.status || "TRIAL"
    );
    if (cleanTg) {
      db.query("INSERT INTO identities (customer_id, type, external_id) VALUES (?, 'telegram', ?)").run(newId, cleanTg);
    }
    if (cleanWa) {
      db.query("INSERT INTO identities (customer_id, type, external_id) VALUES (?, 'whatsapp', ?)").run(newId, cleanWa);
    }
  });
  tx();
  return getCustomerById(newId)!;
}

export function updateCustomerProfile(id: string, params: { name?: string | null; username?: string | null }): void {
  getDb()
    .query("UPDATE customers SET name=COALESCE(?,name), username=COALESCE(?,username), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(
      params.name?.trim() || null,
      params.username?.replace(/^@/, "").trim() || null,
      id
    );
}

export function addIdentity(
  customerId: string,
  type: "telegram" | "whatsapp",
  externalId: string
): { ok: true; already: boolean } {
  const db = getDb();
  if (!getCustomerById(customerId)) throw new Error(`Customer ${customerId} not found`);
  let clean = externalId.trim();
  if (type === "whatsapp") clean = clean.replace(/[+\s]/g, "");
  if (!clean) throw new Error("Empty ID");
  const existing = db
    .query("SELECT customer_id FROM identities WHERE type=? AND external_id=?")
    .get(type, clean) as { customer_id: string } | null;
  if (existing) {
    if (existing.customer_id === customerId) return { ok: true, already: true };
    throw new Error(`${type === "telegram" ? "Telegram ID" : "WhatsApp"} ${clean} already linked to ${existing.customer_id}`);
  }
  db.query("INSERT INTO identities (customer_id, type, external_id) VALUES (?,?,?)").run(customerId, type, clean);
  return { ok: true, already: false };
}

export function removeIdentity(customerId: string, type: "telegram" | "whatsapp", externalId: string): void {
  let clean = externalId.trim();
  if (type === "whatsapp") clean = clean.replace(/[+\s]/g, "");
  getDb()
    .query("DELETE FROM identities WHERE customer_id=? AND type=? AND external_id=?")
    .run(customerId, type, clean);
}

export function setCustomerStatus(id: string, status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "CANCELLED"): void {
  getDb()
    .query("UPDATE customers SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(status, id);
}

export function deleteCustomer(id: string): void {
  getDb().query("DELETE FROM customers WHERE id=?").run(id);
}

export function updateCustomerNotes(id: string, notes: string): void {
  getDb()
    .query("UPDATE customers SET notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(notes, id);
}
