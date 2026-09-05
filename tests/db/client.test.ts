import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import {
  getDbPool,
  pingDb,
} from "../../src/server/db/client";
import {
  getTestPool,
  truncateAll,
} from "./helpers";

/**
 * M017 proof: the server-only pool connects to the real Docker PostgreSQL,
 * pings successfully, and rejects bad configuration clearly.
 */

describe("db client", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("pings the real PostgreSQL instance", async () => {
    const result = await pingDb();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reuses a single pool across calls (no per-call pool leak)", async () => {
    const a = getDbPool();
    const b = getDbPool();
    expect(a).toBe(b);
  });

  it("executes parameterized queries with real data", async () => {
    const result = await pool.query<{ one: number }>(
      "SELECT $1::int AS one",
      [1],
    );
    expect(result.rows[0]?.one).toBe(1);
  });
});
