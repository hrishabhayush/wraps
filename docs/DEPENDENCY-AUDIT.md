# Production dependency audit

Checked on 2026-10-25 with `npm audit --omit=dev` after rebasing on `origin/main`.

## Resolved finding

The `ws` advisory is cleared. The production lockfile resolves `viem@2.57.11` and
`ws@8.21.0`; `npm audit --omit=dev` reports no `ws` finding.

## Remaining finding: SJCL is pinned by the published Privacy Pass package

The current production tree contains two Blind RSA paths:

- `@cloudflare/blindrsa-ts@0.4.6` → `sjcl@1.0.9` (patched).
- `@cloudflare/privacypass-ts@0.9.0` → `@cloudflare/blindrsa-ts@0.4.5` → `sjcl@1.0.8` (affected).

The [GitHub advisory](https://github.com/advisories/GHSA-2w8x-224x-785m) marks
`sjcl` versions through `1.0.8` as affected and `1.0.9` as patched. The published
`@cloudflare/privacypass-ts@0.9.0` package declares an exact `0.4.5` dependency on
Blind RSA, whose package in turn declares exact `sjcl@1.0.8`; `npm audit` reports no
fix for that published chain and returns three high severity entries for this one
advisory.

There is an upstream fix in the current Cloudflare repository: its
[`privacypass-ts` package manifest](https://github.com/cloudflare/privacypass-ts/blob/main/package.json)
still identifies as `0.9.0` but now pins `blindrsa-ts@0.4.6`, and the
[`blindrsa-ts` manifest](https://github.com/cloudflare/blindrsa-ts/blob/main/package.json)
pins `sjcl@1.0.9`. The npm registry's published `privacypass-ts@0.9.0` metadata
still pins `blindrsa-ts@0.4.5`, so the patched dependency has not reached a published
Privacy Pass release.

A root npm override to force `blindrsa-ts@0.4.6` under the published
`privacypass-ts@0.9.0` was tested and not retained: npm installs the newer version,
but `npm ls` reports it as invalid against Privacy Pass's exact `0.4.5` dependency.
The override would therefore make the installed tree disagree with the released
package contract. A reviewed upstream release or a separately tested token-library
migration is needed before this production finding can be removed safely.

Do not describe the production dependency audit as clean until that upstream release
is available and the resulting tree is re-audited.

## Verification

- `npm audit --omit=dev`: only the nested SJCL advisory remains; no `ws` finding.
- `npm ls --omit=dev sjcl @cloudflare/blindrsa-ts @cloudflare/privacypass-ts`: confirms both paths and versions above.
- The attempted override was isolated to this worktree and reverted; no package or lockfile change remains.
- `npm run typecheck`: passed.
- `npm test`: passed (29 package test files / 277 tests; 7 demo test files / 33 tests).
