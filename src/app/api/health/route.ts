import { NextResponse } from "next/server";

import { pingDb } from "@/server/db/client";

/**
 * Minimal health probe: verifies the application can reach PostgreSQL.
 * Returns no configuration or credential details.
 */
export async function GET() {
  try {
    const result = await pingDb();
    return NextResponse.json(
      { status: "ok", db: { ok: result.ok, latencyMs: result.latencyMs } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "degraded", db: { ok: false } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
