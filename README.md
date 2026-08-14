# DSH Doctor

Deterministic diagnostics and recovery for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

DSH Doctor is deliberately independent from the Agent conversation loop. When the Web UI still opens but a conversation cannot run, the Doctor button calls a loopback-only Host recovery service rather than asking the model to repair itself. When Harness cannot start, the same engine is available as a standalone CLI.

> DSH Doctor 0.1.0 targets `@deepseek-ai/dsh 0.1.0-rc.6`. DeepSeek Harness is a developer preview; unknown versions are scanned in conservative read-only mode.

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
- a full Doctor page in Settings with findings, checkpoints, and rollback.

If the Web UI cannot start:

```bash
npx dsh-doctor recover --profile web
```

## CLI

```bash
# Scan every profile (offline and path-anonymized by default)
npx dsh-doctor scan

# Scan one profile and produce JSON
npx dsh-doctor scan --profile web --json

# Apply safe repairs; review confirmation-required actions
npx dsh-doctor recover --profile web

# Explicitly approve reversible dependency reconciliation
npx dsh-doctor recover --profile web --yes

# Restore a checkpoint
npx dsh-doctor rollback <checkpoint-id>
```

Exit status is `1` when errors remain. Warnings return `0` unless `--strict` is used. Invalid arguments or internal failures return `2`.

## What v0.1.0 checks

- Node, platform, Harness version and profile discovery;
- profile manifest and bundle shape;
- YAML/JSON syntax and permissions;
- missing dependencies, duplicate bundles, and broken profile links;
- live Cordis plugin phases when called from the Web UI;
- recent local fatal/plugin-failure log markers;
- non-registry and external plugin sources;
- model availability through an optional, tiny, non-session probe.

## Recovery safety

Every mutation follows the same transaction:

1. Re-check the plan expiry and hashes of profile files.
2. Create a private pre-repair checkpoint.
3. Apply only selected actions.
4. Run a fresh structural scan.
5. Roll back automatically when verification fails.

Safe one-click actions can prepare Doctor state and restore a proven-invalid file from the latest healthy checkpoint. Dependency installation and disabling a failed third-party plugin require explicit confirmation. Doctor refuses to disable the connection, layout, settings, conversation, runtime, module-loader, or Doctor rescue entries.

Checkpoints are stored locally under `$DSH_HOME/doctor/checkpoints/`, with five retained per profile. They may contain exact copies of local configuration so that rollback is byte-accurate; they are never included in reports or uploaded. API keys are never printed, changed, or sent by Doctor.

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
