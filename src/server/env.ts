import "server-only";

import { z } from "zod";

/**
 * Typed, validated server environment.
 *
 * Fails fast and clearly when configuration is missing or malformed instead
 * of letting a bad value surface as an obscure runtime error deep inside the
 * database or auth layers. Never import this module from client components —
 * the `server-only` guard makes that a build error.
 */

const postgresUrlSchema = z
  .string()
  .min(1)
  .regex(
    /^postgres(ql)?:\/\//,
    "must be a postgres:// (or postgresql://) connection string",
  );

type Environment = Readonly<Record<string, string | undefined>>;

function emptyStringAsUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

const optionalEnvironmentString = z.preprocess(
  emptyStringAsUndefined,
  z.string().optional(),
);

/**
 * Parse the one origin used by both Clerk's web middleware and the gateway's
 * authorized-party policy. Returning URL.origin prevents path/query data from
 * being treated as an origin and makes all header values canonical.
 */
export function parseConcordAppOrigin(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;

  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("not an exact HTTP(S) origin");
    }
    return parsed.origin;
  } catch {
    throw new Error(
      "CONCORD_APP_ORIGIN must be an exact http(s) origin without credentials, a path, query, or fragment",
    );
  }
}

/**
 * Parse the browser-facing sync endpoint and return only the CSP source
 * origin. CSP connect-src cannot safely express an endpoint path, so the path
 * and query remain client configuration while only the validated scheme,
 * hostname, and port enter the policy. Raw whitespace and fragments are
 * rejected rather than normalized into a different endpoint.
 */
export function parseSyncGatewayOrigin(
  value: string | undefined,
): string | null {
  if (value === undefined || value === "") return null;
  if (value.trim() !== value || /\s/.test(value)) {
    throw new Error(
      "NEXT_PUBLIC_SYNC_GATEWAY_URL must be a ws:// or wss:// URL without whitespace",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "NEXT_PUBLIC_SYNC_GATEWAY_URL must be a valid ws:// or wss:// URL",
    );
  }

  if (
    !["ws:", "wss:"].includes(parsed.protocol) ||
    parsed.origin === "null" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_SYNC_GATEWAY_URL must use ws:// or wss:// without credentials or a fragment",
    );
  }

  return parsed.origin;
}

const webSecurityFields = {
  NODE_ENV: z.string().optional(),
  CONCORD_REQUIRE_TLS: z.preprocess(
    emptyStringAsUndefined,
    z.enum(["0", "1"]).optional(),
  ),
  CONCORD_APP_ORIGIN: optionalEnvironmentString,
  NEXT_PUBLIC_SYNC_GATEWAY_URL: optionalEnvironmentString,
};

type WebSecurityEnvironment = {
  NODE_ENV?: string;
  CONCORD_REQUIRE_TLS?: "0" | "1";
  CONCORD_APP_ORIGIN?: string;
  NEXT_PUBLIC_SYNC_GATEWAY_URL?: string;
};

function validateWebSecurityEnvironment(
  env: WebSecurityEnvironment,
  ctx: z.RefinementCtx,
): void {
  let appOrigin: string | null = null;
  let appOriginValid = true;
  if (env.CONCORD_APP_ORIGIN !== undefined) {
    try {
      appOrigin = parseConcordAppOrigin(env.CONCORD_APP_ORIGIN);
    } catch (error) {
      appOriginValid = false;
      ctx.addIssue({
        code: "custom",
        path: ["CONCORD_APP_ORIGIN"],
        message: error instanceof Error ? error.message : "invalid app origin",
      });
    }
  }

  let syncGatewayOrigin: string | null = null;
  let syncGatewayValid = true;
  if (env.NEXT_PUBLIC_SYNC_GATEWAY_URL !== undefined) {
    try {
      syncGatewayOrigin = parseSyncGatewayOrigin(
        env.NEXT_PUBLIC_SYNC_GATEWAY_URL,
      );
    } catch (error) {
      syncGatewayValid = false;
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_SYNC_GATEWAY_URL"],
        message:
          error instanceof Error ? error.message : "invalid sync gateway URL",
      });
    }
  }

  if (env.CONCORD_REQUIRE_TLS !== "1") return;

  if (env.CONCORD_APP_ORIGIN === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["CONCORD_APP_ORIGIN"],
      message:
        "must be set to an exact HTTPS origin when CONCORD_REQUIRE_TLS=1",
    });
  } else if (appOriginValid && !appOrigin?.startsWith("https://")) {
    ctx.addIssue({
      code: "custom",
      path: ["CONCORD_APP_ORIGIN"],
      message: "must use https:// when CONCORD_REQUIRE_TLS=1",
    });
  }

  if (env.NEXT_PUBLIC_SYNC_GATEWAY_URL === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["NEXT_PUBLIC_SYNC_GATEWAY_URL"],
      message:
        "must be set to a wss:// URL when CONCORD_REQUIRE_TLS=1",
    });
  } else if (syncGatewayValid && !syncGatewayOrigin?.startsWith("wss://")) {
    ctx.addIssue({
      code: "custom",
      path: ["NEXT_PUBLIC_SYNC_GATEWAY_URL"],
      message: "must use wss:// when CONCORD_REQUIRE_TLS=1",
    });
  }
}

const webSecurityEnvSchema = z
  .object(webSecurityFields)
  .superRefine(validateWebSecurityEnvironment);

export interface WebSecurityConfig {
  requireTls: boolean;
  appOrigin: string | null;
  syncGatewayOrigin: string | null;
}

function invalidEnvironmentError(
  prefix: string,
  issues: readonly z.ZodIssue[],
): Error {
  const formatted = issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  return new Error(`${prefix}:\n${formatted}`);
}

/**
 * Read and validate only the web ingress/security environment. This helper is
 * intentionally separate from getServerEnv(): proxy.ts must be able to fail
 * closed on TLS/CSP configuration without requiring database credentials.
 */
export function getWebSecurityConfig(
  env: Environment = process.env,
): WebSecurityConfig {
  const parsed = webSecurityEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw invalidEnvironmentError(
      "Invalid web security environment configuration. Check .env.local",
      parsed.error.issues,
    );
  }

  return {
    requireTls: parsed.data.CONCORD_REQUIRE_TLS === "1",
    appOrigin: parseConcordAppOrigin(parsed.data.CONCORD_APP_ORIGIN),
    syncGatewayOrigin: parseSyncGatewayOrigin(
      parsed.data.NEXT_PUBLIC_SYNC_GATEWAY_URL,
    ),
  };
}

const serverEnvSchema = z.object({
  DATABASE_URL: postgresUrlSchema,
  DATABASE_TEST_URL: postgresUrlSchema.optional(),
  CLERK_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  ...webSecurityFields,
}).superRefine(validateWebSecurityEnvironment);

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) {
    return cached;
  }
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid server environment configuration. Check .env.local against .env.example:\n${issues}`,
    );
  }
  cached = parsed.data;
  return cached;
}
