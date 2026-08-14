# Recovery matrix

| Failure | Detection | v0.2.0 action | Confirmation | Restart |
|---|---|---|---|---|
| Invalid `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml` / settings | YAML/JSON parsers (and boot-probe output) | Reset every config file from the latest healthy checkpoint; on a cold start, synthesize minimal valid files | No for checkpoint reset; yes for cold-start synthesis | Yes |
| Missing dependency or broken link | package resolution and link target (and boot-probe output) | Run profile `pnpm install`; offline unless online was explicitly enabled | Yes | Yes |
| Failed third-party Cordis entry | live Loader snapshot (and boot-probe output) | Append `disabled: true` to the profile patch (AST merge, never string append) | Yes | Yes |
| Failed rescue/core Cordis entry | live Loader snapshot | Refuse automatic disable and show manual guidance | Manual | Yes |
| Doctor-disabled plugin | patch inspection | Re-enable by removing the disabled entry from the patch | Yes | Yes |
| Corrupt session record or storage cache | zstd header/size probe, JSON parse | Quarantine the file aside (reversible rename) | Yes | Yes |
| Invalid or missing API key | model/Agent error, route probe, live probe | Open model settings guidance; never read or overwrite the key | Manual | No |
| Harness cannot start | boot probe (port watch + captured output) | Map the boot failure to the row above and repair it; `recover` re-verifies the boot | Per mapped row | Yes |
| WebUI port occupied | boot probe | Report the conflicting port | Manual | N/A |
| Unsupported Harness version | version comparison | Read-only report; no mutating repair | Not available | N/A |
| Host is unreachable | Doctor RPC connection | Copy `npx dsh-doctor recover --profile web` (or `dsh-doctor launch --auto-recover`) | No | N/A |

“Recovered” means structural checks passed and — when the Harness was down — the boot probe passed. A real model call is offered separately and is never reported as passed when the user skips it.
