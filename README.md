# DSH Doctor

Deterministic diagnostics and recovery for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DSH Doctor is the safety net for the two ways a Harness usually breaks itself: it **cannot converse** (the Web UI opens but the loop is broken), or it **cannot start** (boot fails after a config, dependency, or plugin change). When the Web UI still opens, the Doctor button calls a loopback-only Host recovery service. When Harness cannot start, the same engine runs as a standalone CLI — including a boot probe that captures the failure and a one-click reset to the last healthy checkpoint, so plugin developers can experiment and always get back to a working state.

> DSH Doctor 0.2.0 targets `@deepseek-ai/dsh 0.1.0-rc.6`. DeepSeek Harness is a developer preview; unknown versions are scanned in conservative read-only mode.

[简体中文](./README.zh-CN.md)

## Install

Add Doctor to the Web profile:

```bash
dsh plugin --profile web add dsh-doctor
dsh --profile web
```

This installs one package with both Host and browser halves. It contributes:

- a persistent Doctor action beside Settings in the sidebar;
- an automatic recovery banner above the composer after a prompt or Agent failure;
- a full Doctor page in Settings with findings, checkpoints, and rollback;
- a floating emergency entry that appears in the frame overlay whenever the profile is broken, independent of the sidebar and conversation plugins.

If the Web UI cannot start:

```bash
npx dsh-doctor recover --profile web
```

## CLI

```bash
# Scan one profile (offline and path-anonymized by default)
npx dsh-doctor scan

# Probe whether the Harness can boot and diagnose the failure from its output
npx dsh-doctor boot

# One-click recovery: reset configs to the healthy checkpoint, reconcile
# dependencies, then verify the boot again
npx dsh-doctor recover --profile web
npx dsh-doctor recover --profile web --yes   # also apply confirmed actions

# Snapshot the current profile as a healthy recovery baseline
npx dsh-doctor checkpoint --profile web

# Start the Harness; diagnose automatically when it fails to boot
npx dsh-doctor launch --auto-recover

# Restore a checkpoint
npx dsh-doctor rollback <checkpoint-id>
```

`recover` runs the safe actions with zero confirmation, then verifies the result by booting the Harness when it was down. The exit status is `1` when errors remain (or boot verification fails), warnings return `0` unless `--strict` is used, and invalid arguments or internal failures return `2`. JSON output is available with `--json`.

## What v0.2.0 checks

- Node, platform, Harness version and profile discovery;
- profile manifest, bundle shape, `cordis.yml`, `cordis.patch.yml`, and pnpm workspace syntax and permissions;
- missing dependencies, duplicate bundles, and broken profile links;
- live Cordis plugin phases when called from the Web UI;
- boot failures via a real boot probe (port watch + captured output mapped to repair actions);
- session records (`session.jsonl.zstd`) and storage caches for corruption;
- recent local fatal/plugin-failure log markers;
- non-registry and external plugin sources (flagged, but never blocking recovery);
- model route/credential state and an optional, tiny, non-session probe that verifies the model actually answers.

## Recovery

Every mutation follows the same transaction:

1. Re-check the plan expiry and hashes of profile files.
2. Create a private pre-repair checkpoint.
3. Apply only selected actions.
4. Run a fresh structural scan (and boot verification when the Harness was down).
5. Roll back automatically when verification fails.

Safe one-click actions prepare Doctor state and **reset the profile configuration to the latest healthy checkpoint**. On a cold start with no healthy checkpoint, Doctor can synthesize minimal valid config files — after explicit confirmation, with the broken originals preserved in the pre-repair checkpoint. Dependency installation, disabling a boot-crashing plugin, quarantining a corrupt session file, and re-enabling a Doctor-disabled plugin require explicit confirmation. Doctor refuses to disable the connection, layout, settings, conversation, runtime, module-loader, or Doctor rescue entries.

Checkpoints are stored locally under `$DSH_HOME/doctor/checkpoints/`, with ten retained per profile and the newest healthy checkpoint always kept. They may contain exact copies of local configuration so that rollback is byte-accurate; they are never included in reports or uploaded. API keys are never printed, changed, or sent by Doctor.

See [Recovery matrix](./docs/RECOVERY_MATRIX.md) and [Security policy](./SECURITY.md).

## Development

Requires Node 24 and pnpm.

```bash
pnpm install
pnpm check
npm pack --dry-run
```

## License

MIT
