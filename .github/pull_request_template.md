<!--
PR description format for this repo. Keep the ## headings in this order, and keep each section terse.
Delete a section only when it does not apply (Fix is for bug fixes only).
Title: a conventional commit, `type(scope): subject`.
PR-Agent appends PR Type, Description, a diagram and a file walkthrough below this description on
every PR (auto_describe in .github/workflows/pr-agent.yml). Don't write those by hand.
.pr_agent.toml ([pr_description] extra_instructions) lists the same headings; keep the two in sync.
-->

## Summary

<!-- 1-2 lines: what changed and why. -->

## What changed

<!-- Bullets, by key file or module. -->

-

## Problem / feature

<!-- The bug being fixed, or the feature delivered. -->

## Fix

<!-- Bug fixes only: the root cause and how it was fixed. Delete this section otherwise. -->

## Test plan

<!-- A checklist, manual and automated. Tick what ran; say what did not run and why. -->

- [ ] `node --test tests/viewer/`
- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (in `src-tauri/`)
- [ ] Manual check in the running app (`cd src-tauri && cargo run`)

## Deployment steps

<!-- Migrations, env vars, secrets, restarts. "None" if pure code. -->

None.

## Verification

<!-- Gate status: which gates ran and their results. -->
