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
- In-flight state lives in memory, like the rest of the issuer (SPEC §12). Do not restart the
  issuer while a payout is in flight.
- The issuer checks that the RPC reports the configured chain ID before it sends.

Each confirmed payout adds a signed record to the merchant's history:
`GET /payouts?merchantId=<id>`. A record has the tx hash, the payout address, the token and
chain, the total paid so far, and the merchant's latest claim (`claimSeq`, `claimTotalTokens`).
It is signed with the attested claim key. Check it with `verifyPayoutRecord()`.

### Environment variables

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
