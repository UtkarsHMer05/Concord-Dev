// HTTP smoke checks for a running Concord dev/preview server.
// Usage: BASE_URL=http://localhost:3000 npm run smoke
// Requires the app to be running (npm run dev) with Docker PostgreSQL up.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name} ${detail ?? ""}`);
  }
}

const home = await fetch(`${BASE_URL}/`);
check("home responds", home.status === 200, `(status ${home.status})`);
const homeText = await home.text();
check(
  "home renders app shell or sign-in gate",
  homeText.includes("Sign in") || homeText.includes("Docs") || homeText.includes("__next"),
);

// The removed realtime room authorization endpoint must not come back.
const removedEndpoint = await fetch(`${BASE_URL}/api/liveblocks-auth`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ room: "any" }),
});
check(
  "removed room auth endpoint stays gone",
  removedEndpoint.status === 404,
  `(status ${removedEndpoint.status})`,
);

if (failures > 0) {
  process.exit(1);
}
console.log("Smoke checks passed.");

// Database-backed health probe (PostgreSQL reachable from the app).
const health = await fetch(`${BASE_URL}/api/health`);
const healthBody = await health.json().catch(() => null);
check(
  "health reports database connectivity",
  health.status === 200 && healthBody?.status === "ok" && healthBody?.db?.ok === true,
  `(status ${health.status})`,
);

// Protected data APIs deny unauthenticated access.
const unauthList = await fetch(`${BASE_URL}/api/documents`);
check(
  "unauthenticated document list denied",
  unauthList.status === 401,
  `(status ${unauthList.status})`,
);
const unauthSave = await fetch(`${BASE_URL}/api/documents/00000000-0000-4000-8000-000000000000/content`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: { v: 1, doc: {} }, expectedContentVersion: 1 }),
});
check(
  "unauthenticated content save denied",
  unauthSave.status === 401,
  `(status ${unauthSave.status})`,
);
