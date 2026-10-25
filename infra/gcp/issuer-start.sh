#!/bin/sh
set -eu

merchant_auth_keys=$(cat /app/issuer-merchant-auth.json)
if [ -n "$merchant_auth_keys" ]; then
  ISSUER_MERCHANT_AUTH_KEYS=$merchant_auth_keys
  export ISSUER_MERCHANT_AUTH_KEYS
fi

exec node /app/issuer.mjs
