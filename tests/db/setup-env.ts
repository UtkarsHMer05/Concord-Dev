/**
 * Test-environment setup for PostgreSQL integration tests.
 *
 * Points the server DB layer at the isolated test database so services and
 * repositories exercise real SQL against concord_test — never dev data.
 * Runs before the module graph of every tests/db file.
 */

if (!process.env.DATABASE_TEST_URL) {
  throw new Error(
    "DATABASE_TEST_URL is not set — DB integration tests refuse to run.",
  );
}
if (!process.env.DATABASE_TEST_URL.includes("concord_test")) {
  throw new Error(
    "DATABASE_TEST_URL must point at the isolated concord_test database.",
  );
}

process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
