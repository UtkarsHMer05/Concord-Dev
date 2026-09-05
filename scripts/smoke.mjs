// HTTP smoke checks for a running Concord dev/preview server.
// Usage: BASE_URL=http://localhost:3000 npm run smoke
// Requires the app to be running (npm run dev) with a provisioned Convex backend.

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DOC_ID = process.env.SMOKE_DOC_ID ?? "nonexistent-doc-for-auth-check";

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

const unauthorized = await fetch(`${BASE_URL}/api/liveblocks-auth`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ room: DOC_ID }),
});
check(
  "liveblocks auth rejects unauthenticated requests",
  unauthorized.status === 401 || unauthorized.status === 404,
  `(status ${unauthorized.status})`,
);

if (failures > 0) {
  process.exit(1);
}
console.log("Smoke checks passed.");
