# Security policy

## Supported version

Security fixes are provided for the latest DSH Doctor release. Version 0.1.0 only enables mutating repair for the explicitly tested DeepSeek Harness version documented in the README.

## Trust boundary

- The Web recovery RPC is registered on a dedicated `/dsh-doctor` channel with `loopback` authority.
- Scan output anonymizes paths unless the user explicitly opts in.
- Known API key, bearer token, password, and secret patterns are redacted from evidence.
- Doctor never exports checkpoints or reads the managed credential document.
- Online metadata requests are disabled by default.
- Repair plans expire and bind to hashes of the files that were scanned.
- Every mutation is checkpointed and automatically rolled back if structural verification fails.

Local checkpoints can contain exact configuration bytes and should be treated as sensitive local data. They are created with owner-only permissions where supported and are excluded from reports and source control.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting for this repository. Do not include real API keys, credentials, private configuration, or unredacted logs in an issue.
