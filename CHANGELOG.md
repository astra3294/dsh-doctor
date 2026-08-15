# Changelog

## 0.3.0 — 2026-08-15

### Self-updating knowledge layer

- New `failure-patterns.json` machine-readable catalog: every pattern with source, severity, bilingual hint, and optional data-driven detectors. Fetched catalogs override builtin ones by id — **new knowledge reaches users without a release**.
- First data-driven detector shipped: `DSH_VERSION_LINE_MIX` (installed `@deepseek-ai` packages spanning multiple version lines — the verified dist-tag stall finding).
- New `dsh-doctor update` command: fetches the community catalog (data only, no code executes), stores it under `$DSH_HOME/doctor/knowledge/`, and the next scan applies it.
- New `dsh-doctor self-update [--apply]`: compares against the npm latest and installs it into the profile.

### Background process management

- New `dsh-doctor start|stop|status`: start the Harness detached with logs under the Doctor run directory, stop it cleanly (process tree), and check liveness — the community-requested fix for "closing the terminal kills the WebUI".
- `boot` now warns about the dual-instance hazard (`DUAL_INSTANCE_RISK` — two instances corrupt session logs with seq gaps).

### Boot probe hardening

- Boot failures now map native-module prebuild gaps (`NATIVE_MODULE_MISSING`, e.g. node-pty) and `EACCES` binds to the reserved-port-range guidance (`PORT_IN_EXCLUDED_RANGE`).

### Release-triggered mining loop

- New `scripts/mine.mjs` + `.github/workflows/mine.yml`: polls the Harness Discussions and the `@deepseek-ai/dsh` dist-tags every 6 hours; a changed dist-tag (new DSH release) opens a triage issue automatically — intensive mining starts in the first week of every release without a human watching.

## 0.2.1 — 2026-08-15

### Mined from the community (13 new detections)

The first mining pass across the Harness Discussions, the plugin ecosystem, Chinese community blogs, and the npm registry produced 55 raw findings (≈40 deduplicated patterns). Thirteen new deterministic checks landed, each with a bilingual plain-language hint:

- `NODE_VERSION_UNSUPPORTED` — Node outside the Harness engine range (zstd exports, hangs, native-module failures).
- `DOTENV_DIRECTORY` — a folder named `.env` confuses the boot loader (EISDIR).
- `PORT_IN_EXCLUDED_RANGE` — 3080 inside a Windows reserved port range (Hyper-V/WSL2, EACCES).
- `PS_UNIX_TOOLS_MISSING` — PowerShell 5.1 without head/tail/grep.
- `KOFFI_VERSION_RISK` — koffi versions known to crash the native directory picker.
- `UTF16_PATH_TRUNCATION` — workspace paths with characters whose UTF-16LE low byte is 0x00 (开/耀/言…).
- `ROOT_WORKSPACE` — a drive/volume root registered as a workspace.
- `LINKED_PLUGIN_RESOLUTION` — link:/file: plugins that cannot resolve `@deepseek-ai/*` at boot.
- `INACTIVE_PLUGIN_DEPENDENCY` — plugin-looking packages installed but never mounted as bundles.
- `PATCH_NAME_UNRESOLVED` — stale patch insert names after a rename.
- `PATCH_PATH_NOT_URL` — bare drive paths in `cordis.patch.yml` (must be `file:///` URLs).
- `PLUGIN_PEER_MISMATCH` — peer dependencies on the wrong `@deepseek-ai` version line.
- `WEB_SKILL_DISABLED` — skills silently disabled in the web bundle.

### Community cost-sharing

- New `dsh-doctor report` command: builds an opt-in, redacted failure report (secrets and local paths masked) with a preview, browser pre-fill (`--open`), and gh CLI submission (`--submit`). This is the open-source mining loop: findings flow back from users instead of being hunted one by one.
- New `docs/FAILURE_PATTERNS.md` catalog: every mined pattern with source links, root cause, and Doctor action, maintained by the release-triggered mining loop.

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
