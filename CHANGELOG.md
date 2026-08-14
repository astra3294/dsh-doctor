# Changelog

## 0.2.0 — 2026-08-15

### One-click recovery to a working Harness

- `recover` now resets the whole profile configuration to the latest healthy checkpoint as its safe fast path, reconciles dependencies, and verifies the boot with a real probe when the Harness was down.
- New `boot` command: spawns the Harness, watches the WebUI port, and maps captured boot failures (bad patch/JSON, missing module, port conflict, crashing plugin) onto repair actions.
- New `checkpoint` command snapshots a healthy baseline; healthy baselines are refreshed automatically after clean boots, clean conversations, and successful recoveries.
- Cold-start rescue: with no healthy checkpoint, Doctor synthesizes minimal valid config files after explicit confirmation, preserving the broken originals.
- New `launch --auto-recover`: boots the Harness, diagnoses failures, repairs, and relaunches in one command.
- Retention raised to 10 checkpoints per profile; the newest healthy checkpoint is never pruned. Healthy baselines require no errors and no blocking warnings (non-registry sources like `file:`/`link:` links stay non-blocking for plugin developers).

### Broader coverage

- Session records (`session.jsonl.zstd` headers/sizes) and storage caches are checked for corruption; a reversible quarantine action recovers them without deleting data.
- `cordis.yml` and `pnpm-workspace.yaml` are scanned and checkpointed alongside the existing config files.
- The live probe now verifies the model actually acknowledges the request, and runtime route checks classify missing/invalid credentials.
- A floating emergency entry appears in the frame overlay when the profile is broken, independent of the sidebar and conversation plugins.
- Doctor-disabled plugins are listed and can be re-enabled (`undisable-plugin`).

### Fixes

- `disable-plugin` no longer corrupts `cordis.patch.yml`: entries are merged into the parsed YAML array instead of string-appended (the previous output was unparseable and could block the next boot).
- Stale repair locks are reclaimed (dead pid or older than 10 minutes); live locks still fail closed.
- Run history persists across Host restarts.
- `--all-profiles` now actually controls profile scope; `--no-all-profiles` scans the current profile.
- Symbolic paths are resolved with a dedicated inverse function instead of string replacement.

## 0.1.0 — 2026-08-15

- Add deterministic offline diagnostics for DSH `0.1.0-rc.6` profiles, Cordis runtime state, model routing, local logs, configuration syntax, dependencies, and basic plugin-source risks.
- Add atomic checkpoints, hash-bound repair plans, safe file restoration, confirmed plugin/dependency actions, automatic rollback, and healthy baselines.
- Add standalone `scan`, `recover`, and `rollback` CLI commands.
- Add loopback-only Host RPC plus sidebar, conversation recovery, rescue panel, and Settings surfaces for the WebUI.
- Add Chinese and English UI/documentation, Node 24 cross-platform CI, package smoke tests, and secret scanning.
