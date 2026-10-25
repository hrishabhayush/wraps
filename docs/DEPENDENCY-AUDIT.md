# Production dependency audit

Checked on 2026-10-25 with `npm audit --omit=dev`.

The initial audit reported five production dependency findings. The `ws` findings were
resolved by `npm audit fix`: the lockfile now resolves `viem` to `2.57.11` and `ws` to
`8.21.0`, and the current audit reports no `ws` advisory.

## Remaining finding

The current audit still reports the high severity SJCL point-on-curve validation advisory
([GHSA-2w8x-224x-785m](https://github.com/advisories/GHSA-2w8x-224x-785m)). The affected
production path is pinned transitively as:

`@cloudflare/privacypass-ts@0.9.0` → `@cloudflare/blindrsa-ts@0.4.5` → `sjcl@1.0.8`.

The audit reports no fix for this dependency chain. The vulnerable package has an exact
`sjcl@1.0.8` dependency, so this change does not force an unsupported cryptography override.
Keep this finding open for an upstream Privacy Pass / Blind RSA release or a separately
reviewed migration. Do not describe the production dependency audit as clean: npm continues
to report three high severity entries associated with this nested SJCL path.

## Verification

- `npm audit --omit=dev`: only the nested SJCL advisory remains.
- `npm run typecheck`: passed.
- `npm test`: passed (28 package test files / 269 tests; 7 demo test files / 33 tests).
