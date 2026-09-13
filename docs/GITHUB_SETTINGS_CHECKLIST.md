# GitHub Settings Checklist (owner-only)

Exact steps for the repository owner
(**github.com/UtkarsHMer05/Concord-Dev**) after the hardening branch
merges to `main`. These settings live in GitHub's UI/API — they cannot
be changed from a commit. `gh` CLI commands are given where possible
(requires `gh auth login` with owner credentials); the repo slug is
`UtkarsHMer05/Concord-Dev` throughout.

Work top to bottom; check each box when verified.

---

## 0. Preconditions

- [ ] The final hardening candidate has been merged to `main` and pushed
      (`git push origin main`); verify the exact candidate SHA before changing
      protection settings.
- [ ] `gh auth status` shows an authenticated session with admin rights
      on `UtkarsHMer05/Concord-Dev`.

## 1. Default branch → `main`

If the repository was created with the default branch `master` (or the
push created one), make `main` the default before protecting it:

```bash
gh api -X PATCH repos/UtkarsHMer05/Concord-Dev \
  -f default_branch=main
```

- [ ] Verify: repo home shows `main` as the default branch
      (Settings → General → Default branch).

## 2. Branch protection on `main`

Require PRs, the CI status checks, and block force pushes/deletions.
This example uses the classic protection API — the required status
check names come from the completed final run. The matrix lanes are
`web`, `rust`, `native (g++)`, `native (clang++)`, `wasm`,
`browser (chromium)`, `browser (firefox)`, `browser (webkit)`, and
`security`; CodeQL's observed names are `Analyze (javascript-typescript)`
and `Analyze (cpp)`:

```bash
gh api -X PUT repos/UtkarsHMer05/Concord-Dev/branches/main/protection \
  -f "required_status_checks[strict]=true" \
  -f "required_status_checks[checks][]=web" \
  -f "required_status_checks[checks][]=rust" \
  -f "required_status_checks[checks][]=native (g++)" \
  -f "required_status_checks[checks][]=native (clang++)" \
  -f "required_status_checks[checks][]=wasm" \
  -f "required_status_checks[checks][]=browser (chromium)" \
  -f "required_status_checks[checks][]=browser (firefox)" \
  -f "required_status_checks[checks][]=browser (webkit)" \
  -f "required_status_checks[checks][]=security" \
  -f "required_status_checks[checks][]=Analyze (javascript-typescript)" \
  -f "required_status_checks[checks][]=Analyze (cpp)" \
  -f "enforce_admins=false" \
  -f "required_pull_request_reviews[required_approving_review_count]=0" \
  -F "restrictions=null" \
  -F "required_linear_history=true" \
  -F "allow_force_pushes=false" \
  -F "allow_deletions=false"
```

Notes:

- `required_approving_review_count=0` — single-owner repository; PRs
  still enforce the checks. Raise it if collaborators join.
- `enforce_admins=false` is pragmatic for a solo owner; flip to `true`
  for strictness once you accept the friction (the owner then cannot
  self-bypass).
- If GitHub renames a check context (e.g. `phase6-pr-ci / web`), read
  the exact name from a completed run
  (`gh api repos/UtkarsHMer05/Concord-Dev/commits/<sha>/check-runs`)
  and substitute it.
- [ ] Verify: open a throwaway PR against `main` — the merge button must
      stay disabled until all listed checks pass; force-push and delete
      on `main` must be rejected.

## 3. Repository description + topics

Set the description and the topic list (they drive discovery and the
README badge story):

```bash
gh api -X PATCH repos/UtkarsHMer05/Concord-Dev \
  -f description="Local-first collaborative document editor — C++20/WASM sequence CRDT, Rust/Tokio sync gateways, PostgreSQL commit-before-ACK durability, NATS JetStream fanout. Systems-engineering portfolio project." \
  -f homepage="https://concord-dev.vercel.app"

gh api -X PUT repos/UtkarsHMer05/Concord-Dev/topics \
  -f "names[]=crdt" -f "names[]=local-first" -f "names[]=distributed-systems" \
  -f "names[]=rust" -f "names[]=cpp" -f "names[]=webassembly" \
  -f "names[]=websocket" -f "names[]=postgresql" -f "names[]=nats" \
  -f "names[]=offline-first" -f "names[]=collaborative-editing"
```

- [ ] Verify: the topics render on the repo home page.

## 4. Security tab + private vulnerability reporting

Enable the GitHub-recognized security policy surface that
[`SECURITY.md`](../SECURITY.md) (root) depends on:

- [ ] Settings → Code security and analysis:
      - **Private vulnerability reporting**: Enabled (this is what
        SECURITY.md's "Report a vulnerability" button requires).
      - **Dependency graph**: Enabled.
      - **Dependabot alerts**: Enabled (security updates optional but
        recommended).
      - **Code scanning**: default setup **off** if it conflicts — the
        repo's own `codeql.yml` workflow is the source of truth; avoid
        double-running a default-setup CodeQL.
- [ ] Verify: the repo's Security tab shows "Security policy" (from
      root `SECURITY.md`) and a working "Report a vulnerability" button.
- [ ] After the first push, confirm the Security tab's "View last scan"
      reflects a completed CodeQL run from
      [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml).

## 5. Dependabot verification

[`.github/dependabot.yml`](../.github/dependabot.yml) configures
weekly update PRs for npm, cargo (`/rust`), github-actions, and Dockerfile
directories. Docker and compose image references are digest-pinned; refresh
PRs update those digests when tags move.

- [ ] After the first weekly cycle, check the repo's PR list (or
      `gh pr list --label dependencies`) for the first Dependabot PRs.
- [ ] Settings → Code security and analysis → Dependabot version
      updates: confirm "Configured" (green).
- [ ] Dependabot PRs will run the full `phase6-pr-ci` suite — merge only
      green ones; digest/image refresh PRs additionally go through the
      trivy `scan-gate.sh` verdict in
      [`.github/workflows/phase6-release-artifacts.yml`](../.github/workflows/phase6-release-artifacts.yml).

## 6. Social preview image

The social preview is the image shown when the repo URL is shared.

- [ ] Check `docs/branding/` for a prepared image. **Note: at the time
      of writing no `docs/branding/` directory exists** — if none was
      added since, create one (e.g. a 1280×640 PNG built from
      `public/logo.svg` — dark text on the repo's background color,
      with the Concord name) and add it under `docs/branding/` first.
- [ ] Upload at Settings → General → Social preview (choose a custom
      image; avoid the auto-generated page capture).
- [ ] Verify: share the repo URL into a chat box and confirm the card
      renders.

## 7. Final sanity pass

- [ ] `gh repo view UtkarsHMer05/Concord-Dev` — description, homepage,
      topics correct.
- [ ] `gh api repos/UtkarsHMer05/Concord-Dev/branches/main/protection`
      returns the protection rule.
- [ ] Issue templates render (repo → Issues → New issue should offer
      "Bug report" and "Feature request" forms only — no security
      template, by design; vulnerability reporting goes private via the
      Security tab per [`SECURITY.md`](../SECURITY.md)).
- [ ] New PRs show the pull request template body (summary / change
      type / testing evidence / checklist).
- [ ] `CODEOWNERS` resolves: the last commit or PR page shows
      "UtkarsHMer05 (Owner)" as requested reviewer.
- [ ] Merge a trivial PR once to confirm required checks block until
      green, then delete the branch (branch deletion on feature
      branches is fine — only `main` is protected from deletion).
