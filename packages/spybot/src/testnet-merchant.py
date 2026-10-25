#!/usr/bin/env python3
"""A tiny local t54 x402 resource for the SPY-04 testnet walkthrough."""

import os

from fastapi import FastAPI
from xrpl.wallet import Wallet
from x402_xrpl.server import require_payment


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


merchant = Wallet.from_seed(required("XRPL_MERCHANT_SEED"))
facilitator_url = os.environ.get(
    "T54_TESTNET_FACILITATOR_URL", "https://xrpl-facilitator-testnet.t54.ai"
).strip()
price_drops = os.environ.get("T54_TESTNET_AMOUNT_DROPS", "1000").strip()

app = FastAPI()
app.middleware("http")(
    require_payment(
        path="/hello",
        price=price_drops,
        pay_to_address=merchant.classic_address,
        network="xrpl:1",
        asset="XRP",
        facilitator_url=facilitator_url,
        resource="demo:spybot-testnet",
        description="SPY-04 XRPL testnet demo greeting",
        source_tag=804681468,
    )
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "merchant": merchant.classic_address}


@app.get("/hello")
def hello() -> dict[str, str]:
    return {"message": "Hello from the SPY-04 XRPL testnet resource."}
