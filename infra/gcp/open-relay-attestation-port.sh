#!/usr/bin/env bash
# Adds the relay's plain HTTP nonce-attestation port to the existing wraps rule.
# Only --allow is updated; source ranges, target tags, network, and priority stay intact.
# Usage: infra/gcp/open-relay-attestation-port.sh [--dry-run]
source "$(dirname "$0")/lib.sh"

case "${1:-}" in
  "") ;;
  --dry-run)
    [ "$#" -eq 1 ] || die "usage: $0 [--dry-run]"
    echo "gcloud --project=${GCP_PROJECT} compute firewall-rules update wraps-allow-443 --allow=tcp:443,tcp:8080"
    exit 0
    ;;
  *) die "usage: $0 [--dry-run]" ;;
esac

gc compute firewall-rules update wraps-allow-443 --allow=tcp:443,tcp:8080
gc compute firewall-rules describe wraps-allow-443 \
  --format='yaml(name,allowed,sourceRanges,targetTags,network,priority,direction,disabled)'
