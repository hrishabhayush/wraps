# How agents work in this repo

Read this before you change anything. Several agents (Codex, Claude Code) and people work on this repo at the same time. These rules stop us from overwriting each other.

The design is in `docs/SPEC.md`. The task list is in `docs/TODO.md`.

---

## 1. Never work in the shared checkout

`/Users/adarsha/ifi/agent-pay-hackathon` is shared. Do not edit files there, switch its branch, or commit there.

Make your own worktree for every task:

```sh
cd /Users/adarsha/ifi/agent-pay-hackathon
git fetch origin
git worktree add ../wraps-<task-id> -b codex/<task-id>-<short-name> origin/main
cd ../wraps-<task-id>
npm install
```

Example: `git worktree add ../wraps-rly-03 -b codex/rly-03-confidential-space origin/main`.

When your PR is merged, remove it: `git worktree remove ../wraps-<task-id>`.

## 2. Claim a task before you start

1. Pick an open task from `docs/TODO.md`.
2. Check nobody else has it: `gh pr list -R hrishabhayush/wraps --state open --search "<TASK-ID>"`.
3. If a PR exists for that task ID, pick another task.
4. Claim it: push your branch and open a **draft PR** right away, with the task ID at the start of the title:

```sh
git commit --allow-empty -m "RLY-03: start"
git push -u origin HEAD
gh pr create -R hrishabhayush/wraps --draft --base main --title "RLY-03: Run the relay in Confidential Space" --body "Claimed. Work in progress."
```

The open draft PR is the claim. One task ID, one PR.

## 3. Stay in your folder

Each folder has one owner lane. Only edit files in your task's folder.

| Folder | Lane | Task IDs |
|---|---|---|
| `packages/tokens`, `packages/issuer` | Tokens and issuer | ISS-* |
| `packages/attestation` | Attestation | SDK-01, INF-12, INF-13 |
| `packages/ap4m` | Payments / AP4M | PAY-* |
| `packages/relay` | Relay / VPN | RLY-* |
| `packages/sdk`, `packages/agent` | Agent and SDK | SDK-* |
| `packages/merchant` | Merchant | MER-* |
| `packages/spybot` | Spy bot | SPY-* |
| `apps/demo`, `scripts/` | Demo | DEM-* |
| `infra/gcp` | Infra (Google Confidential Space) | INF-* |
| `infra/` (Nitro, not used) | Do not edit | - |
| `app/` | Menu bar app (teammate) | Ask first |

If you need a change in another lane's folder, do not make it. Write it in your PR under "Needs from other lanes" and keep going with a stub.

## 4. Shared files: small, separate changes

These files affect everyone: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `docs/SPEC.md`, `docs/TODO.md`, `AGENTS.md`.

- Change them only when your task needs it, and keep the change small.
- **`docs/TODO.md`:** only tick the checkbox for your own task, in your own PR. Do not reword other tasks.
- **`docs/SPEC.md`:** do not edit it in a code PR. Open a separate `docs/...` PR.
- **`package-lock.json` conflicts:** do not merge by hand. Take `origin/main`'s version, then run `npm install` and commit the result.
- **Adding a workspace or dependency:** add it to your own package's `package.json`. Only touch the root `package.json` to add a new workspace path.

## 5. Shared interfaces: don't break them

Other packages import these. Changing them breaks other lanes.

- `packages/tokens`: token issue/verify and the `PrivateToken` header format.
- `packages/attestation`: `AttestationProvider`, `AttestationVerifier`, `hashPublicKeys()`.
- `packages/issuer`: the protocol types it exports, and the HTTP routes `/attestation`, `/issue`, `/verify`, `/settle`, `/reserves`.
- `packages/sdk`: `PrivatePayClient` and its `transport` option.

If you must change one, add the new thing beside the old one, keep the old one working, and say so in your PR.

## 6. If you depend on an unmerged PR

Base your branch on that PR's branch, not `main`, and open your PR against it:

```sh
git worktree add ../wraps-sdk-02 -b codex/sdk-02-relay origin/codex/rly-01-connect
gh pr create --base codex/rly-01-connect ...
```

Write "Depends on #N" at the top of the PR body. When #N merges, rebase onto `main` and change the PR base to `main`.

## 7. Before you mark a PR ready

```sh
git fetch origin
git rebase origin/main        # resolve conflicts; for package-lock.json see section 4
npm install
npm run typecheck
npm test
```

All must pass. Then mark the PR ready: `gh pr ready`.

## 8. Commits and PRs

- Commit messages: plain English, start with the task ID. Example: `RLY-03: build relay image with Cloud Build`.
- No `Co-Authored-By` lines and no "Generated with" lines in commits or PRs.
- Keep PRs small: one task per PR.
- Never commit secrets: no private keys, `.env` files, service-account JSON or RPC URLs with tokens. Use `.env.example`.
- Do not merge your own PR or anyone else's. A person merges.

Use this PR body:

```md
Task: <TASK-ID>
Depends on: #N (or "none")

## What works
## What is mocked
## Tests
## Needs from other lanes
```

## 9. Facts every agent should know

- **Confidential computing:** Google Cloud Confidential Space (AMD SEV), project `wraps-hack`, region `us-central1`. Not AWS Nitro. The AWS account is on the Free plan and cannot run Nitro.
- **Registry:** `us-central1-docker.pkg.dev/wraps-hack/wraps`. Service account `wraps-workload@wraps-hack.iam.gserviceaccount.com`. Firewall tag `wraps` opens port 443.
- **Cost:** $20 budget. Any VM you create must have a max run time (12 hours, then stop), the label `project=wraps`, and machine type `n2d-standard-2`. Stop VMs when you are done testing.
- **AP4M:** Mastercard's payment primitive on XRPL EVM testnet (chain ID 1449000). Our agent signs the AP4M voucher at top-up. Do not invent AP4M API details: the real SDK files go in `vendor/ap4m/` once someone downloads them from the portal.
- **Run things:** `npm run demo:core` (core flow), `npm test`, `npm run typecheck`, `npm run spybot`.
