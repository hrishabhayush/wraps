# @wraps/issuer

The issuer signs blind tokens, settles them for merchants, and pays each merchant its tab in
RLUSD at fixed intervals (SPEC §4 step 7).

Start it with `npm run issuer`. Settings come from environment variables.

## Merchant payouts

At each interval the issuer takes every unpaid tab, applies the SR6 caps, and pays each merchant
in one batch, mixed across all customers. Two rails exist:

- `PAYOUT_RAIL=mock` (default). Logs the batch. Needs no key. Tests and the demo use it.
- `PAYOUT_RAIL=xrpl-evm`. Sends RLUSD (ERC-20) on the XRPL EVM sidechain from the issuer payout
  address to each merchant's registered address.

### What the xrpl-evm rail guarantees

- It signs only plain `transfer(address,uint256)` calls on the RLUSD contract, with no native
  value, to registered merchant addresses (SR8).
- Gas per transfer, gas price and fee per batch have hard caps. The batch also has the SR6 caps on
  line count, total tokens and fee in RLUSD.
- Nonces are consecutive within a batch. A refused send ends the batch, so no nonce gap is left.
- A tab is marked paid only after a success receipt. A reverted or refused line stays unpaid and
  is retried in the next batch.
- A tx whose send timed out, or whose receipt has not come yet, stays in flight. The next batch
  checks its receipt by hash first, and rebroadcasts the same signed bytes if it is not mined. No
  new transfer is signed for that merchant while one is in flight, so no merchant is paid twice.
- In-flight transactions are stored with issuer state before they are sent. A file-backed local
  run or the Confidential Space Cloud Storage store can resume the same signed transaction after
  restart. A process using only the in-memory store cannot recover it.
- The issuer checks that the RPC reports the configured chain ID before it sends.

Each confirmed payout adds a signed record to the merchant's history:
`GET /payouts?merchantId=<id>`. A record has the tx hash, the payout address, the token and
chain, the total paid so far, and the merchant's latest claim (`claimSeq`, `claimTotalTokens`).
It is signed with the attested claim key and the request requires that merchant's Ed25519
signature. Check the record with `verifyPayoutRecord()`.

## Merchant authentication and issuer state

The issuer requires a per-merchant Ed25519 signature on `/settle`, `/settle/status` and
`GET /payouts?merchantId=<id>`. It covers the merchant ID, HTTP method, exact path, SHA-256 body
hash, timestamp and a random nonce. Timestamps are accepted within 60 seconds; a nonce cannot be
reused. Configure public keys as `ISSUER_MERCHANT_AUTH_KEYS`, a JSON object mapping merchant IDs
to base64url-encoded Ed25519 SPKI keys.

Generate a keypair and the matching env lines with:

```sh
npm run merchant:auth-key -- merchant-research-data
```

Keep `MERCHANT_AUTH_PRIVATE_KEY` secret in the merchant process. Put the generated public-key
mapping in the issuer's `ISSUER_MERCHANT_AUTH_KEYS`. Local `demo:core` and `demo` runs generate and
register an ephemeral keypair automatically. `ISSUER_DEV_MERCHANT_AUTH=1` is a local-only bypass;
the issuer accepts it only on a loopback, non-Confidential-Space listener.

The relay HTTP client sends `Authorization: Bearer <ISSUER_RELAY_SETTLE_KEY>` and uses the fixed
`ISSUER_RELAY_MERCHANT_ID` (default `relay`) on settle and settle-status requests when configured.
For Confidential Space, put the credential in Secret Manager and configure only its version name
and the Workload Identity Pool provider resource on the VM. The issuer reads
`ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION` through `readConfidentialSecret()` using a Google
Confidential Space token with the `https://sts.googleapis.com` audience, exchanges it through
Google STS, and accesses Secret Manager as the federated workload identity. Do not pass the secret
value in `tee-env-*` metadata. The WIF provider must restrict access to the approved production
image digests, and `roles/secretmanager.secretAccessor` must be granted on this secret only to the
corresponding digest principals. Enable the Secret Manager API and provision those IAM bindings
before deployment. `GCP_WIF_PROVIDER` is the provider resource name, for example
`projects/123456789012/locations/global/workloadIdentityPools/wraps-prod/providers/confidential-space`.

The Confidential Space issuer refuses to start unless at least one merchant credential is
configured. It also refuses an inline `ISSUER_RELAY_SETTLE_KEY`; use a Secret Manager version
reference with a numeric version (do not use the mutable `latest` alias). The relay workload must
read the same version through WIF and pass the value as its `issuerSettleKey` option before
enabling enforcement. The desktop app still settles as `node:<id>` without a credential; register
its public key and update its caller before enabling strict authentication for the live app.

For local and mock-attestation runs, enforcement remains opt-in for compatibility. If either
`ISSUER_MERCHANT_AUTH_KEYS` or `ISSUER_RELAY_SETTLE_KEY` is configured, merchant routes enforce
credentials. With neither set, the issuer reports `merchantAuth: "legacy-open"` on `/health` and
`/attestation`, logs one loud startup warning, and accepts unsigned legacy settles. In
Confidential Space, the issuer fails startup unless at least one valid merchant credential is
loaded. SDK consumers retain the mode and the live preflight displays it. This mode field is
runtime-reported and not covered by the key attestation.

`startIssuer()` uses `MemoryIssuerStateStore` by default in local/test runs. For local or non-enclave
runs, set `ISSUER_STATE_FILE=./data/issuer-state.jsonl` to use the append-only, hash-chained file
journal. It fsyncs each complete state snapshot before acknowledging a mutation and detects
tampering, partial truncation, and rollback against its local head marker.

The Confidential Space CLI requires the encrypted `GcsIssuerStateStore`; it refuses to start in
memory-only mode. It compresses each state snapshot, encrypts it with a fresh AES-256-GCM data key,
and wraps that data key with Cloud KMS. Only ciphertext and the wrapped data key are stored in
Cloud Storage. The WIF token is bound to the production issuer image digest. A new snapshot is a
new immutable object with a create-only precondition, so two instances loaded from the same
sequence cannot both acknowledge a write. The workload requires `storage.objectViewer` and
`storage.objectCreator` on a dedicated bucket, plus `cloudkms.cryptoKeyEncrypterDecrypter` on one
symmetric KMS key. It does not need permission to delete or overwrite state objects.

Before the first Confidential Space deployment, create a Standard bucket in `us-central1` with
uniform bucket-level access and public access prevention, and a symmetric `ENCRYPT_DECRYPT` Cloud
KMS key. Configure these non-secret resource names in the immutable issuer image (not changeable
TEE metadata):

| Variable | Meaning |
| --- | --- |
| `ISSUER_STATE_GCS_BUCKET` | Dedicated bucket for encrypted issuer snapshots. |
| `ISSUER_STATE_GCS_PREFIX` | Optional object prefix; defaults to `issuer-state/v1`. Use one prefix for one issuer. |
| `ISSUER_STATE_KMS_KEY` | Full Cloud KMS cryptoKey resource name, for example `projects/wraps-hack/locations/us-central1/keyRings/issuer-state/cryptoKeys/state`. |
| `GCP_WIF_PROVIDER` | Global Workload Identity Pool provider resource used by the issuer's attested token source. |

The provider must accept the Confidential Space issuer `https://confidentialcomputing.googleapis.com/`
with audience `https://sts.googleapis.com` and require production secure-boot, `STABLE`,
`disabled-since-boot`, and the final issuer image digest. Bind its exact digest principal directly
to the bucket and KMS key; do not grant the VM service account broad storage or KMS roles. Enable
`storage.googleapis.com` and `cloudkms.googleapis.com`. Use a dedicated bucket and do not configure
a lifecycle rule that might delete the newest snapshot. An administrator with bucket or IAM
control can still delete recent snapshots or redirect access; the workload identity itself cannot
delete or overwrite them. There is no external monotonic anchor against a privileged cloud
administrator restoring an older snapshot.

The snapshot log is append-only and grows with issuer mutations. Cloud Storage Standard storage in
`us-central1` is currently listed at about `$0.02/GiB-month`; regional Class A operations are
`$0.005/1,000` and Class B are `$0.0004/1,000`. Software Cloud KMS has an active key-version charge
of about `$0.06/month` and cryptographic operations at `$0.03/10,000`; this store uses one KMS
encrypt per mutation and one decrypt at startup. Check [Cloud Storage pricing](https://cloud.google.com/storage/pricing)
and [Cloud KMS pricing](https://cloud.google.com/kms/pricing) before production rollout. Cost grows
with the number and compressed size of retained snapshots.

Issuer token and claim signing keys remain memory-only. A restart creates new keys; previously
issued tokens are then unknown to the issuer, while persisted tabs, settlement records and payout
transactions remain in the configured state store. Old signed claims and payout records do not
verify under the new claim key. The state log preserves ledger and payout accounting, not the
issuer's token-signing key epochs. `/health` and `/attestation` report the active `statePersistence` mode (`memory`, `file-journal`, or `gcs-kms-encrypted`) so operators can check which backend started.

### Environment variables

For a secret-free testnet setup template, start with [`funder.env.example`](./funder.env.example).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAYOUT_RAIL` | `mock` | `mock` or `xrpl-evm`. |
| `ISSUER_PAYOUT_PRIVATE_KEY` | none | Issuer payout key, `0x` + 64 hex. Required for `xrpl-evm`. Never commit it. The issuer removes it from its environment after start-up and never logs it. |
| `ISSUER_PAYOUT` | none | Issuer payout address. If set, it must match the key. Top-ups arrive here too. |
| `RLUSD_ADDRESS` | none | RLUSD ERC-20 contract on XRPL EVM. The app uses the same value as `VITE_RLUSD_ADDRESS`. |
| `MERCHANT_PAYOUT_ADDRESSES` | none | Merchant registry: `m-1=0x…,m-2=0x…` or JSON `{"m-1":"0x…"}`. A merchant not listed is never paid on-chain. A registered address cannot change while the issuer runs. |
| `XRPL_EVM_RPC` | `https://rpc.testnet.xrplevm.org` | JSON-RPC endpoint. |
| `XRPL_EVM_CHAIN_ID` | `1449000` | Chain the RPC must report (XRPL EVM testnet). |
| `RLUSD_DECIMALS` | read from the contract | Token decimals. |
| `PAYOUT_INTERVAL_MS` | `30000` | Time between batches. |
| `PAYOUT_MAX_LINES` | `50` | SR6: most merchants per batch. |
| `PAYOUT_MAX_BATCH_TOKENS` | `100000` | SR6: most tokens per batch (1 token = 0.10 RLUSD). The rest waits. |
| `PAYOUT_MAX_FEE_RLUSD` | `1` | SR6: most fee per batch, in RLUSD. |
| `XRP_PRICE_RLUSD` | `5` | Upper bound on the XRP price, to turn gas into RLUSD for the fee cap. |
| `PAYOUT_MAX_GAS_PER_TRANSFER` | `100000` | Hard gas cap per transfer. |
| `PAYOUT_MAX_GAS_PRICE_GWEI` | `100` | Above this gas price nothing is sent. |
| `PAYOUT_MAX_BATCH_FEE_XRP` | `0.5` | Hard gas fee cap per batch, in XRP. |
| `PAYOUT_RECEIPT_TIMEOUT_MS` | `60000` | How long a batch waits for receipts before leaving a tx in flight. |
| `ISSUER_ADMIN_TOKEN` | none | Bearer token for the payout admin routes. Without it, they answer loopback callers only. |
| `ISSUER_MERCHANT_AUTH_KEYS` | `{}` | JSON map of merchant ID to base64url Ed25519 SPKI public key. Required for merchant-specific routes in strict mode. |
| `ISSUER_RELAY_SETTLE_KEY` | none | Temporary bearer credential for the fixed relay merchant ID; local and mock runs only. Confidential Space loads it from `ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION`. |
| `ISSUER_RELAY_SETTLE_KEY_SECRET_VERSION` | none | Secret Manager version resource for Confidential Space deployments; the CLI fetches it with attestation-bound Workload Identity Federation. |
| `GCP_WIF_PROVIDER` | none | Global Workload Identity Pool provider resource used to exchange the Confidential Space token for direct Secret Manager access. |
| `ISSUER_RELAY_MERCHANT_ID` | `relay` | Merchant ID allowed to use `ISSUER_RELAY_SETTLE_KEY`. |
| `ISSUER_DEV_MERCHANT_AUTH` | `0` | Local-only merchant auth bypass. Requires a loopback host and non-Confidential-Space attestation. |
| `ISSUER_STATE_FILE` | none | Optional append-only file store for local/non-enclave runs. Rejected in Confidential Space. |
| `ISSUER_STATE_GCS_BUCKET` | none | Required in Confidential Space; dedicated bucket for encrypted state snapshots. |
| `ISSUER_STATE_GCS_PREFIX` | `issuer-state/v1` | Object prefix for the one issuer state stream. |
| `ISSUER_STATE_KMS_KEY` | none | Required in Confidential Space; symmetric Cloud KMS cryptoKey resource used to wrap fresh snapshot data keys. |
| `ISSUER_URL` | `http://127.0.0.1:4001` | Used by the payout scripts below. |

### Scripts

Both scripts talk to a running issuer. The payout key stays in the issuer process.

```sh
npm run payout:dry-run   # prints the next batch and the exact transfers; sends nothing
npm run payout:once      # asks the issuer to send one batch now
```

`payout:dry-run` calls `GET /payouts/pending`. If the issuer runs the mock rail, the script
plans the transfers itself from `RLUSD_ADDRESS` and `MERCHANT_PAYOUT_ADDRESSES` in your shell.

`payout:once` calls `POST /payouts/run`. It refuses unless the issuer runs `PAYOUT_RAIL=xrpl-evm`
with a key. It prints each paid line with an explorer link and each line still unpaid.

### Run a live payout on XRPL EVM testnet

1. Make a fresh testnet wallet for the issuer. Do not reuse a wallet that holds real funds.
2. Fund its address with testnet XRP for gas (XRPL EVM faucet) and with testnet RLUSD. The
   issuer payout address must hold enough RLUSD for the batch and enough XRP for gas.
3. Start the issuer:

   ```sh
   PAYOUT_RAIL=xrpl-evm \
   ISSUER_PAYOUT_PRIVATE_KEY=0x… \
   ISSUER_PAYOUT=0x<issuer address> \
   RLUSD_ADDRESS=0x27b57a9d0b8d24eb97259c4e2279e45255e016f3 \
   MERCHANT_PAYOUT_ADDRESSES='merchant-research-data=0x<merchant address>' \
   PAYOUT_INTERVAL_MS=3600000 \
   npm run issuer
   ```

   Put the key in your shell from a password manager or an untracked file. Do not commit it.
   Confirm `RLUSD_ADDRESS` against the AP4M portal network config (see `app/.env.example`).
4. Make some sales so the merchant has a tab. In two more terminals run `npm run merchant`
   (its merchant ID is `merchant-research-data`) and then `npm run agent`. The agent tops up
   with the mock rail unless the issuer runs `ISSUER_RAIL=xrpl-evm`.
5. Run `npm run payout:dry-run`. Check every recipient and amount.
6. Run `npm run payout:once`. Open the explorer links and check the transfers.
7. Check the signed record: `curl 'http://127.0.0.1:4001/payouts?merchantId=merchant-research-data'`.

## Tests

`npm test` runs the payout tests against a fake JSON-RPC node (`test/payout-xrpl-evm.test.ts`)
and, when [Foundry](https://getfoundry.sh)'s `anvil` is installed, against a local EVM with a
deployed ERC-20 and chain ID 1449000 (`test/payout-anvil.test.ts`). Without anvil, those are
skipped.
