# Contributing

1. Use Node 24 and pnpm.
2. Run `pnpm install` and `pnpm check`.
3. Add fixtures for every new diagnostic code and both success and failure repair paths.
4. Keep repairs deterministic, reversible, and independent from the Agent conversation loop.
5. Never add a mutating action without a checkpoint, verification, rollback, and an explicit risk classification.

DeepSeek Harness is a developer preview. Compatibility changes should be isolated behind version checks and documented in the recovery matrix.
