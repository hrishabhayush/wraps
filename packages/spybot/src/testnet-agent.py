#!/usr/bin/env python3
"""Make one plain t54 x402 purchase on XRPL Testnet and print its receipt."""

import json
import os
import sys

import requests
from xrpl.wallet import Wallet
from x402_xrpl.clients.base import decode_payment_response
from x402_xrpl.clients.requests import x402_requests


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> int:
    seed = required("XRPL_BUYER_SEED")
    resource_url = required("T54_TESTNET_RESOURCE_URL")
    rpc_url = os.environ.get("XRPL_TESTNET_RPC_URL", "https://s.altnet.rippletest.net:51234/").strip()
    max_fee_drops = int(os.environ.get("T54_MAX_FEE_DROPS", "1000"))
    # Cap on the amount a 402 may request, in the asset's base units (drops for XRP).
    # The library drops any payment option above it and refuses to pay if none is left.
    max_amount = int(os.environ.get("T54_MAX_AMOUNT", "1000"))
    if max_amount <= 0:
        raise ValueError("T54_MAX_AMOUNT must be a positive integer")

    buyer = Wallet.from_seed(seed)
    session = x402_requests(
        buyer,
        rpc_url=rpc_url,
        network_filter="xrpl:1",
        scheme_filter="exact",
        max_value=max_amount,
        max_fee_drops=max_fee_drops,
    )
    # Do not print the seed or full signed payment payload. The transaction
    # hash and settlement result are enough for the spy bot and the demo UI.
    response = session.get(resource_url, timeout=180)
    payment_response = response.headers.get("PAYMENT-RESPONSE") or response.headers.get("X-PAYMENT-RESPONSE")
    decoded = decode_payment_response(payment_response) if payment_response else None
    event = {
        "event": "agent-result",
        "network": "xrpl:1",
        "payer": buyer.classic_address,
        "service": os.environ.get("T54_TESTNET_SERVICE", "t54 testnet resource"),
        "status": response.status_code,
        "body": response.text[:1000],
        "paymentResponse": decoded,
    }
    print(json.dumps(event, separators=(",", ":")))
    return 0 if response.ok else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, requests.RequestException, ValueError) as exc:
        print(json.dumps({"event": "agent-error", "message": str(exc)}), file=sys.stderr)
        raise SystemExit(1)
