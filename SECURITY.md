# Security policy

## Supported version

Security fixes are provided for the latest DSH Doctor release. Version 0.2.0 only enables mutating repair for the explicitly tested DeepSeek Harness version documented in the README.

## Trust boundary

- The Web recovery RPC is registered on a dedicated `/dsh-doctor` channel with `loopback` authority.
- Scan output anonymizes paths unless the user explicitly opts in.
- Known API key, bearer token, password, and secret patterns are redacted from evidence — including boot-probe output captured from a failing Harness.
- Doctor never exports checkpoints or reads the managed credential document.
- Online metadata requests are disabled by default; the model-route probe never reads or transmits credentials.
- Repair plans expire and bind to hashes of the files that were scanned.
- Every mutation is checkpointed and automatically rolled back if structural verification fails.
- `cordis.patch.yml` is never edited by string concatenation: entries are merged into the parsed YAML document, and the file must remain one valid top-level array.
- The boot probe spawns `dsh` only when the WebUI port is closed, always reaps the probe process on every path, and never launches a second instance of a running Harness.
- Cold-start synthesis writes minimal templates only after explicit confirmation and always preserves the broken originals in the pre-repair checkpoint.
- Corrupt session files are quarantined by reversible rename; Doctor never deletes session data.
- Core rescue plugins (connection, layout, settings, conversation, runtime, module loader, and Doctor itself) can never be disabled.

Local checkpoints can contain exact configuration bytes and should be treated as sensitive local data. They are created with owner-only permissions where supported and are excluded from reports and source control.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for this repository. Do not include real API keys, credentials, private configuration, or unredacted logs in an issue.
