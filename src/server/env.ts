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

const serverEnvSchema = z.object({
  DATABASE_URL: postgresUrlSchema,
  DATABASE_TEST_URL: postgresUrlSchema.optional(),
  CLERK_SECRET_KEY: z.string().min(1),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
});

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
