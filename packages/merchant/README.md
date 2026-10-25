# Merchant authentication

The merchant signs every `/settle` and `/settle/status` request with the Ed25519 private key
registered for its merchant ID at the issuer. Generate the pair and matching environment lines:

```sh
npm run merchant:auth-key -- merchant-research-data
```

Set `MERCHANT_ID` and `MERCHANT_AUTH_PRIVATE_KEY` in the merchant process. Set the emitted
`ISSUER_MERCHANT_AUTH_KEYS` JSON mapping in the issuer process. Keep the private key only in the
merchant's secret environment. The local `demo:core` and `demo` flows generate and register a
temporary keypair automatically.
