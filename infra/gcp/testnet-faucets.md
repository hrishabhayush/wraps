# XRPL EVM Testnet gas funding

Reviewed 2026-10-25 against the [XRPL EVM documentation](https://docs.xrplevm.org/pages/users/faucet).

The project's XRPL EVM Testnet is chain ID `1449000`; its native gas token is XRP. The official
XRPL EVM faucet is the preferred source for both the agent and issuer EVM addresses. The docs say
to paste an EVM address or connect MetaMask and allow up to 90 XRP per request. The faucet site
returned HTTP 403 to this review environment, so the claim flow and current rate limits were not
tested directly.

Other documented routes are the Enigma Validator faucet in the XRPLEVM Discord (`!faucet
<YOUR_ADDRESS>`, 50 XRP per request), the XRPL EVM Telegram faucet (up to 89 XRP per request), or
bridging from a funded XRPL Testnet account through SquidRouter. These routes involve third-party
accounts or a bridge; use the official web faucet first.

## Verify balances

Do not put wallet addresses or private keys in this repository. With each public EVM address
available locally, verify the network and balance with Foundry:

```sh
export RPC_URL_TESTNET=https://rpc.testnet.xrplevm.org
cast chain-id --rpc-url "$RPC_URL_TESTNET" # must print 1449000
cast balance --rpc-url "$RPC_URL_TESTNET" 0x<agent-address>
cast balance --rpc-url "$RPC_URL_TESTNET" 0x<issuer-address>
```

If either balance is zero or too small for the required testnet operation, request XRP for that
address at [faucet.xrplevm.org](https://faucet.xrplevm.org), then repeat the balance check. Keep
the agent and issuer addresses separate. Testnet XRP has no mainnet value.

## Audit status

The public faucet options and verification commands are documented. Current balances and actual
funding remain unverified because the public agent and issuer addresses were not supplied to this
audit. No faucet requests were made.

Sources:

- [XRPL EVM Testnet faucet options](https://docs.xrplevm.org/pages/users/faucet)
- [XRPL EVM Testnet RPC and chain ID](https://docs.xrplevm.org/pages/developers/interacting-with-evm/interact-with-the-smart-contract)
