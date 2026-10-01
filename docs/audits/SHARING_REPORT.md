# Feature 6: document sharing and invitation discovery

Feature 6 implements the user-confirmed **Share dialog + Shared with me**
scope. Owners share documents with existing verified accounts, manage their
roles, and copy a permission-respecting document link. Recipients discover
explicit invitations across workspaces and open them with the current access
role. This report records local acceptance on 2026-10-01; hosted deployment
is outside this evidence.

## What was implemented

- The editor has a top-bar **Share** dialog. Verified account email is the
  default identifier; existing collaboration IDs remain supported. The owner
  sees collaborator names/emails, changes viewer/commenter/editor roles, and
  removes direct grants. Account lookup is owner-gated and requires an exact
  verified address. A recipient can receive a grant before their first visit.
- **Shared with me** collects direct invitations across personal/organization
  workspaces, excludes owned documents, displays the effective role, and
  supports title search, pagination, refresh, and navigation. The account
  comes from the verified session. Workspace listing retains its existing
  scope. Read-only recipients are not offered rename/delete actions.
- Open non-owner editors refresh their role every ten seconds while visible
  and when focus/connectivity returns. Promotions enable editing; downgrades
  disable editing/comment entry; lost read access renders the masked
  unavailable-document page. An unavailable status poll preserves offline
  content instead of manufacturing a grant.
- Gateway local and NATS delivery bulk-recheck recipient read roles before
  new content/presence is queued. Revoked recipients are closed. Database
  failure also closes the affected recipients instead of trusting join-time
  authorization. This supplements the existing transactional write check.
- Errors preserve the invite input; a failed follow-up list read reports an
  already committed change honestly. Profile lookup failure falls back to
  saved local identities, allowing existing grants to remain manageable.
  JSON requests are bounded, reject injected fields/OWNER, and reject foreign
  origins. The configured public origin overrides the standalone bind host.

The implementation reuses PostgreSQL permissions/audit records, Clerk,
Radix, existing list components, the effective-role resolver, and the browser
harness. It adds **no dependency and no schema migration**.

## Browser acceptance

Command:

```bash
CONCORD_E2E_MODE=production npm run test:sharing:browser -- --headed
```

The driver used a production Next.js standalone build, actual Chromium,
WASM/native synchronization, Rust gateway, PostgreSQL, real Clerk identities
and HTTPS JWKS, and local NATS/Redis. Three isolated browser contexts represent
an owner, recipient, and unrelated user. The accounts and `concord_e2e`
database are disposable; no existing user document is used.

| Acceptance stage | Result and direct observation |
|---|---|
| Email grant and dialog | Passed: a recipient not yet projected locally received commenter access by uppercase verified email; unknown-account input was retained. Clipboard URL, Escape/focus return, desktop/mobile geometry, and dialog accessibility passed. |
| Discovery and authorization | Passed: invitation appeared across the recipient's active workspace; title search and clear retained the shared collection; commenter read content and saved an actual anchored comment. A non-owner grant and unrelated-account read returned 404. The unrelated collection contained no invitation. |
| Live roles | Passed: commenter promoted to editor made actual durable edits visible to the owner; downgrade to viewer disabled editing and removed comment entry without a manual reload. |
| Revocation independent of polling | Passed: permission status requests were deliberately answered with 503, then the owner removed access and made a new durable edit. The revoked viewer received none of that new text; HTTP returned 404. After polling recovered, the open page became unavailable and the invitation disappeared. |
| Failure and retry | Passed: interrupted permission POST retained the email and created no phantom database grant; retry saved the viewer grant. |

Axe reported **zero violations** for the Share dialog and document-collection
navigation, using WCAG 2 A/AA tags. Chromium reported **zero uncaught page
errors**. The 390 x 844 dialog check includes its viewport bounds and content
width after responsive layout settles. These are scoped accessibility checks,
not a claim that every page in the application has zero issues.

Manual native browser control additionally verified **Refresh documents**,
opening the invitation, viewer-only sharing controls, the owner's collaborator
list, expanded document link/ID fallback, copying the link, and saving a role
change. The recipient's new role appeared in the owner dialog.

The existing production review-branch driver also passed **all six acceptance
stages**, exercising collaboration-ID grants, separate branch access,
offline proposal edits, concurrent main edits, selective merge, and recovery
after an interrupted response. Its input/identity helpers were updated for the
new sharing controls.

Evidence:

- [Sanitized sharing stage results](../assets/sharing/acceptance.json)
- [Owner Share dialog](../assets/sharing/share-dialog.png)
- [Recipient Shared with me collection](../assets/sharing/shared-with-me.png)
- [Mobile Share dialog](../assets/sharing/share-mobile.png)
- Runnable driver: `scripts/e2e/sharing.mjs`; local detailed logs/screenshots
  stay in ignored `output/playwright/sharing/`. Authentication state is not
  included in committed evidence.

## Supporting verification

| Check | Verified result |
|---|---|
| Web unit suite | 315 passed; 2 intentional skips |
| PostgreSQL service suite | 83 passed, including exact verified-email matching, pre-first-visit projection, owner-only lookup, role restrictions, account isolation, pagination, literal wildcard search, revocation, organization role fallback, and unavailable profile service |
| Rust library suite | 104 passed; 1 intentional ignored test |
| Rust database integration | 16 passed, including revoked-reader closure before any further room delivery |
| WebSocket integration | 17 passed |
| Multi-gateway integration | 9 passed; rerun with Docker available after cleanup was limited to owned child processes |
| TypeScript, ESLint, production build | Passed |
| Rust formatting and Clippy all targets with warnings denied | Passed |
| npm audit | 0 vulnerabilities |
| Secret scan and mechanical provenance gate | Clean scan; 54 baseline-overlapping paths checked with 0 unallowlisted identical files |

Additional fixes found during acceptance were the browser-facing origin check
for standalone requests, valid mobile dialog width/layout, server navigation
when committing a title filter, and an old multi-gateway cleanup that killed
all matching release gateways. The gateway test now stops its tracked children
on success and on drop, preserving the browser test's independent gateway.

## Product and evidence limits

The email must identify an existing verified account in the configured Clerk
instance. Granting access sends no outbound email; discovery is inside Concord.
Owner privileges cannot be granted or transferred. A direct role overrides
organization-derived editor access; removing that direct grant restores normal
organization membership access. Review branches keep their own ACLs.

Revocation governs future authorized deliveries. An in-flight delivery checked
before the revoke commit may finish. Previously received content and offline
copies cannot be withdrawn. The browser's status poll is a UI convenience; the
server's request/transaction/broadcast checks enforce access.

Authenticated acceptance is local. The repository's remote browser CI uses
anonymous Chromium smoke and does not replace this Clerk-backed run. Prior
performance measurements and evidence are preserved; sharing acceptance makes
no new performance or hosted-deployment claim. Adding a PostgreSQL read check
per room delivery may affect throughput; a new performance claim requires a
fresh campaign under that authorization policy.
