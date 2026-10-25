# Agent SDK

## Pinned relay transport

`createPinnedRelayTransport()` fetches a fresh relay attestation, verifies the receipt with the configured `AttestationVerifier`, checks that the relay certificate's public key matches the attested `tunnel` key, and then makes HTTPS requests through an Undici `ProxyAgent`. Each TLS connection to the relay is checked against that same key. The agent's HTTPS destination TLS remains end to end through the CONNECT tunnel.

The relay attestation endpoint returns JSON in this shape:

```json
{
  "format": "<attestation format>",
  "publicKeys": { "tunnel": "<base64url DER SubjectPublicKeyInfo>" },
  "tlsCertificate": "<PEM certificate>",
  "attestation": "<base64url attestation document>"
}
```

The attestation's `user_data` must bind `hashPublicKeys({ tunnel })` and the request nonce.

The relay has two listeners, and the SDK uses them for different things:

| Listener | Protocol | Default port | Used for |
| --- | --- | --- | --- |
| CONNECT proxy (`relayUrl`) | HTTPS | 443, or the port in `relayUrl` | All tunnels. Pinned to the attested key. |
| Receipt (`attestationUrl`) | HTTP | 8080 | One nonce-bound receipt at bootstrap. |

`relayUrl` must be `https:` with no credentials. Without `attestationUrl`, the SDK fetches `http://<relay-host>:8080/attestation`. The port in `relayUrl` never moves the receipt port. Set `attestationUrl` when the receipt listener uses another port; the SDK always requests its `/attestation` path. The receipt is untrusted until the verifier accepts the nonce and the key hash.

Bootstrap has one absolute 10-second deadline (`attestationTimeoutMs`) that covers the request, the headers and the body. The deadline does not depend on `fetchImpl` honouring the abort signal. The response limit is 64 KiB (`maxAttestationResponseBytes`): a larger `content-length` is refused before reading, and a body that grows past the limit is cancelled. Only HTTPS destination requests are accepted by the returned transport.

```ts
const relayTransport = await createPinnedRelayTransport({
  relayUrl: 'https://relay.example:8443',
  issuerUrl,
  verifier,
});

const sdk = new PrivatePayClient({ issuerUrl, verifier, wallet, caps, relayTransport });
try {
  await sdk.connect();
  await sdk.topUp(10); // issuer calls also travel through the relay
  await sdk.fetch('https://merchant.example/data');
  // issuer calls, quote(), and merchant fetches use the relay.
} finally {
  await relayTransport.close();
}
```

Relay mode requires a pre-top-up before the first merchant request because the relay needs a blind-token batch in `Proxy-Authorization` before it opens CONNECT and the merchant can issue its 402 challenge. The default is one dedicated relay token per tunnel, covering up to 10 MB. A paid fetch uses one relay batch for the challenge request and one for each paid attempt. The merchant's price travels in separate origin `Authorization` credentials, inside end-to-end TLS. `quote()` uses one relay batch.

Relay batches count against the daily cap and leave the balance before dispatch. They are never refunded, because the relay may settle a token before a failure is visible. Merchant tokens follow the SEC-02 reservation rules: a refusal restores the unspent ones, and an unknown outcome keeps them reserved. A retry or `resolvePending()` re-sends the same merchant tokens and pays a fresh relay batch. If that batch would pass the daily cap or the balance is too low, the attempt fails and the payment stays pending. Set `relayTokensPerTunnel` between 1 and 100 to use a larger batch; the full batch is charged even when fewer metering blocks are settled.

The issuer bootstrap and top-up requests are tunneled through the relay without meter tokens. This exception is restricted to the exact HTTPS issuer origin configured in `createPinnedRelayTransport`; the issuer's first TLS peer key is checked against its attestation, then pinned for later calls. The relay server must permit unauthenticated CONNECT only to that issuer host and port. Merchant CONNECT requests still require meter tokens in `Proxy-Authorization`; the merchant's `Authorization` header remains end-to-end inside TLS. Without `relayTransport`, `transport` and all direct behavior stay unchanged.
