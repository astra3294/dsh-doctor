# Recovery matrix

| Failure | Detection | v0.1.0 action | Confirmation | Restart |
|---|---|---|---|---|
| Invalid `package.json` | JSON parser | Restore that file from the latest healthy checkpoint | No, only when the file is proven invalid | Yes |
| Invalid `cordis.patch.yml` | YAML parser | Restore that file from the latest healthy checkpoint | No, only when the file is proven invalid | Yes |
| Invalid settings document | YAML/JSON parser | Restore that file from the latest healthy checkpoint | No, only when the file is proven invalid | Usually |
| Missing dependency or broken link | package resolution and link target | Run profile `pnpm install`; offline unless online was explicitly enabled | Yes | Yes |
| Failed third-party Cordis entry | live Loader snapshot | Append `disabled: true` to the active profile patch | Yes | Yes |
| Failed rescue/core Cordis entry | live Loader snapshot | Refuse automatic disable and show manual guidance | Manual | Yes |
| Invalid or missing API key | model/Agent failure | Open model settings guidance; never read or overwrite the key | Manual | No |
| Unsupported Harness version | version comparison | Read-only report; no mutating repair | Not available | N/A |
| Host is unreachable | Doctor RPC connection | Copy `npx dsh-doctor recover --profile web` | No | N/A |

“Recovered” means structural checks passed. A real model call is offered separately and is never reported as passed when the user skips it.
