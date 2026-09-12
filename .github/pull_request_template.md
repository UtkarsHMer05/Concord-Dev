<!--
Thank you for the PR. Fill in the sections below. CI (phase6-pr-ci + CodeQL)
must pass; the full local gate list is in CONTRIBUTING.md.
-->

## Summary

<!-- What does this change do, and why? Reference the issue number if one
exists ("Closes #N"). -->

## Change type

<!-- Check all that apply -->

- [ ] Bug fix (`fix:`)
- [ ] Security fix (`security:` — include the regression test that pins it)
- [ ] Feature (`feat:`)
- [ ] Documentation (`docs:`)
- [ ] CI / tooling (`ci:` / `chore:`)

## Testing evidence

<!-- Which gates did you run, and what were the results? Copy the relevant
commands and outcomes (suite names and pass counts are enough). -->

- Gates run:
- Results:

```
# paste command output here
```

## Checklist

- [ ] Tests added — new behavior is covered by a test; security fixes carry a
      regression test that fails against the unfixed code
- [ ] No secrets, tokens, or credentials in the diff (`.env.local` stays
      git-ignored; never bake real values into images)
- [ ] Docs updated if the change affects a documented contract
      (protocol, configuration, storage, security, benchmarks)
- [ ] [CHANGELOG.md](https://github.com/UtkarsHMer05/Concord-Dev/blob/main/CHANGELOG.md) entry added for user-visible
      changes
