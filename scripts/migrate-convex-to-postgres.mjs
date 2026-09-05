// One-time migration: import temporary Convex documents into PostgreSQL.
//
// Usage: node scripts/migrate-convex-to-postgres.mjs <path-to-documents.jsonl>
//
// - Idempotent: re-runs upsert on documents.legacy_convex_id (no duplicates).
// - Projects Clerk principals (user/organization ids) into local rows.
// - Verifies after import: row counts, title/owner/org equality, and deep
//   equality of parsed content envelopes.
// - Never prints document bodies or secrets; prints ids and counts only.

import { readFileSync } from "node:fs";
import pg from "pg";

try {
  process.loadEnvFile(".env.local");
} catch {
  // Fall back to the environment as provided.
}

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/migrate-convex-to-postgres.mjs <documents.jsonl>");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const rows = readFileSync(inputPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

console.log(`Read ${rows.length} Convex document rows from ${inputPath}`);

const pool = new pg.Pool({ connectionString: url });

async function upsertUser(clerkUserId) {
  const existing = await pool.query(
    "SELECT id FROM users WHERE clerk_user_id = $1",
    [clerkUserId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query(
    `INSERT INTO users (clerk_user_id) VALUES ($1)
     ON CONFLICT (clerk_user_id) DO NOTHING
     RETURNING id`,
    [clerkUserId],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const raced = await pool.query("SELECT id FROM users WHERE clerk_user_id = $1", [
    clerkUserId,
  ]);
  return raced.rows[0].id;
}

async function upsertOrganization(clerkOrganizationId) {
  const existing = await pool.query(
    "SELECT id FROM organizations WHERE clerk_organization_id = $1",
    [clerkOrganizationId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query(
    `INSERT INTO organizations (clerk_organization_id) VALUES ($1)
     ON CONFLICT (clerk_organization_id) DO NOTHING
     RETURNING id`,
    [clerkOrganizationId],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const raced = await pool.query(
    "SELECT id FROM organizations WHERE clerk_organization_id = $1",
    [clerkOrganizationId],
  );
  return raced.rows[0].id;
}

function parseEnvelope(raw) {
  // Convex stored the envelope as a JSON string; PostgreSQL stores JSONB.
  if (raw === undefined || raw === null) return null;
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === "object" && parsed.v === 1 && "doc" in parsed) {
    return parsed;
  }
  throw new Error(`Unrecognized content envelope for migration (v missing)`);
}

/** Stable stringification: JSONB normalizes key order, so compare canonically. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

let imported = 0;
let updated = 0;
for (const row of rows) {
  const ownerUserId = await upsertUser(row.ownerId);
  const organizationId = row.organizationId
    ? await upsertOrganization(row.organizationId)
    : null;
  const content = parseEnvelope(row.content);
  const createdAt = new Date(row._creationTime);

  const result = await pool.query(
    `INSERT INTO documents
       (title, owner_user_id, organization_id, initial_content, content,
        content_version, metadata_version, legacy_convex_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $7, $7)
     ON CONFLICT (legacy_convex_id) DO UPDATE SET
       title = EXCLUDED.title,
       owner_user_id = EXCLUDED.owner_user_id,
       organization_id = EXCLUDED.organization_id,
       initial_content = EXCLUDED.initial_content,
       content = EXCLUDED.content,
       updated_at = EXCLUDED.updated_at
     RETURNING (xmax = 0) AS inserted`,
    [
      row.title,
      ownerUserId,
      organizationId,
      row.initialContent ?? null,
      content,
      row._id,
      createdAt,
    ],
  );
  if (result.rows[0].inserted) {
    imported += 1;
  } else {
    updated += 1;
  }
}

console.log(`Imported ${imported} new rows, updated ${updated} existing rows (idempotent re-run).`);

// ---- Verification -----------------------------------------------------------

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name} ${detail ?? ""}`);
  }
}

const counts = await pool.query(
  "SELECT count(*)::int AS total, count(legacy_convex_id)::int AS with_legacy FROM documents WHERE legacy_convex_id IS NOT NULL",
);
check(
  "row count matches export",
  counts.rows[0].total === rows.length,
  `(postgres ${counts.rows[0].total} vs export ${rows.length})`,
);

for (const row of rows) {
  const res = await pool.query(
    `SELECT d.title,
            u.clerk_user_id AS owner_clerk_id,
            o.clerk_organization_id AS org_clerk_id,
            d.initial_content,
            d.content,
            d.created_at
       FROM documents d
       JOIN users u ON u.id = d.owner_user_id
       LEFT JOIN organizations o ON o.id = d.organization_id
      WHERE d.legacy_convex_id = $1`,
    [row._id],
  );
  const doc = res.rows[0];
  check(`[${row._id}] exists`, !!doc);
  if (!doc) continue;
  check(`[${row._id}] title matches`, doc.title === row.title);
  check(`[${row._id}] owner maps to Clerk principal`, doc.owner_clerk_id === row.ownerId);
  check(
    `[${row._id}] organization scope matches`,
    (doc.org_clerk_id ?? null) === (row.organizationId ?? null),
  );
  check(
    `[${row._id}] initialContent matches`,
    (doc.initial_content ?? null) === (row.initialContent ?? null),
  );
  const expectedContent = parseEnvelope(row.content);
  check(
    `[${row._id}] content envelope deep-equals`,
    canonicalJson(doc.content ?? null) === canonicalJson(expectedContent),
  );
  const createdSame =
    Math.abs(new Date(doc.created_at).getTime() - row._creationTime) < 2;
  check(`[${row._id}] created_at within 2ms`, createdSame);
}

console.log(`Migration verification: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
await pool.end();
if (failures > 0) {
  process.exit(1);
}
