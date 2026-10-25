#!/usr/bin/env bash
# Deploy a test-only WireGuard egress VM outside Confidential Space.
# The VM has no service account and stores its server key only in /run (tmpfs).
source "$(dirname "$0")/lib.sh"

NAME="${WG_GATEWAY_NAME:-wraps-wg-gateway}"
PEER_PUBLIC_KEY="${WG_PEER_PUBLIC_KEY:-}"
DRY_RUN=0
for option in "$@"; do
  case "${option}" in
    --dry-run) DRY_RUN=1 ;;
    *) die "unknown option: ${option}" ;;
  esac
done

[[ "${NAME}" =~ ^[a-z]([-a-z0-9]*[a-z0-9])?$ ]] || die "WG_GATEWAY_NAME is invalid"
[[ "${PEER_PUBLIC_KEY}" =~ ^[A-Za-z0-9+/]{43}=$ ]] || die "WG_PEER_PUBLIC_KEY must be a 32-byte WireGuard public key"
node -e 'const k=process.argv[1]; const b=Buffer.from(k,"base64"); if(b.length!==32 || b.toString("base64")!==k) process.exit(1)' "${PEER_PUBLIC_KEY}" \
  || die "WG_PEER_PUBLIC_KEY must be canonical base64"

if gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" --format='value(name)' >/dev/null 2>&1; then
  die "${NAME} already exists; inspect it before deploying another gateway"
fi

TAG=wraps-wg-gateway
ALLOW_RULE=wraps-allow-wg-gateway
DENY_RULE=wraps-deny-wg-gateway-ingress
if [ "${DRY_RUN}" = 0 ]; then
  if ! gc compute firewall-rules describe "${ALLOW_RULE}" >/dev/null 2>&1; then
    gc compute firewall-rules create "${ALLOW_RULE}" --direction=INGRESS --priority=800 \
      --network=default --allow=udp:51820 --source-ranges=0.0.0.0/0 --target-tags="${TAG}"
  fi
  ALLOW_JSON="$(gc compute firewall-rules describe "${ALLOW_RULE}" --format=json)"
  node -e '
    const rule=JSON.parse(process.argv[1]);
    const allowed=rule.allowed||[];
    if(rule.direction!=="INGRESS" || rule.disabled || rule.priority!==800 ||
       (rule.sourceRanges||[]).length!==1 || rule.sourceRanges[0]!=="0.0.0.0/0" ||
       (rule.targetTags||[]).length!==1 || rule.targetTags[0]!=="wraps-wg-gateway" ||
       !String(rule.network||"").endsWith("/networks/default") ||
       allowed.length!==1 || allowed[0].IPProtocol!=="udp" ||
       (allowed[0].ports||[]).length!==1 || allowed[0].ports[0]!=="51820" ||
       (rule.denied||[]).length) process.exit(1);
  ' "${ALLOW_JSON}" || die "${ALLOW_RULE} must allow only UDP 51820 from the internet to ${TAG} at priority 800"
  if ! gc compute firewall-rules describe "${DENY_RULE}" >/dev/null 2>&1; then
    gc compute firewall-rules create "${DENY_RULE}" --direction=INGRESS --priority=900 \
      --network=default --action=DENY --rules=all --source-ranges=0.0.0.0/0 --target-tags="${TAG}"
  fi
  DENY_JSON="$(gc compute firewall-rules describe "${DENY_RULE}" --format=json)"
  node -e '
    const rule=JSON.parse(process.argv[1]);
    const denied=rule.denied||[];
    if(rule.direction!=="INGRESS" || rule.disabled || rule.priority!==900 ||
       (rule.sourceRanges||[]).length!==1 || rule.sourceRanges[0]!=="0.0.0.0/0" ||
       (rule.targetTags||[]).length!==1 || rule.targetTags[0]!=="wraps-wg-gateway" ||
       !String(rule.network||"").endsWith("/networks/default") ||
       denied.length!==1 || denied[0].IPProtocol!=="all" || (rule.allowed||[]).length) process.exit(1);
  ' "${DENY_JSON}" || die "${DENY_RULE} must deny other IPv4 ingress to ${TAG} at priority 900"
fi

CREATE_ARGS=(
  compute instances create "${NAME}"
  "--zone=${GCP_ZONE}"
  "--machine-type=${MACHINE_TYPE}"
  --maintenance-policy=MIGRATE
  --shielded-secure-boot
  --image-project=debian-cloud
  --image-family=debian-12
  "--metadata=wg-peer-public-key=${PEER_PUBLIC_KEY}"
  "--metadata-from-file=startup-script=$(dirname "$0")/wireguard-gateway-startup.sh"
  --no-service-account
  --no-scopes
  "--tags=${TAG}"
  "--labels=project=wraps,role=wireguard,mode=nonconfidential"
  "--max-run-duration=${MAX_RUN_DURATION}"
  --instance-termination-action=STOP
  --can-ip-forward
)

if [ "${DRY_RUN}" = 1 ]; then
  printf 'DRY RUN:'
  printf ' %q' gcloud --project="${GCP_PROJECT}" "${CREATE_ARGS[@]}"
  printf '\n'
  exit 0
fi

echo "Creating ${NAME} (Debian 12, ${MACHINE_TYPE}, UDP 51820, stops after ${MAX_RUN_DURATION})..."
gc "${CREATE_ARGS[@]}"
IP="$(gc compute instances describe "${NAME}" --zone "${GCP_ZONE}" \
  --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"
mkdir -p "${STATE_DIR}"
printf '%s\n' "${IP}" > "${STATE_DIR}/wireguard-gateway.ip"
printf '\nVM:       %s (%s)\n' "${NAME}" "${IP}"
printf 'Endpoint: %s:51820/udp\n' "${IP}"
printf 'Attested: no; this standalone test gateway runs outside Confidential Space.\n'
printf 'Stop:     gcloud --project=%s compute instances stop %s --zone %s\n' \
  "${GCP_PROJECT}" "${NAME}" "${GCP_ZONE}"
