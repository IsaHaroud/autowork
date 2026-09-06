import { getDb } from "./database.ts";

// one-off: ensure new columns exist for existing DBs (SQLite doesn't add via CREATE IF NOT EXISTS)
const db = getDb();

function hasColumn(table: string, col: string): boolean {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === col);
}

const migrations: [string, string, string][] = [
  ["services", "slug", "ALTER TABLE services ADD COLUMN slug TEXT"],
  ["services", "description", "ALTER TABLE services ADD COLUMN description TEXT"],
  ["services", "billing_cycle", "ALTER TABLE services ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'monthly'"],
  ["services", "expires_at", "ALTER TABLE services ADD COLUMN expires_at TEXT"],
];

for (const [table, col, sql] of migrations) {
  if (!hasColumn(table, col)) {
    console.log(`Migrating: ${table}.${col}`);
    db.exec(sql);
  }
}
console.log("✅ migrations done");
