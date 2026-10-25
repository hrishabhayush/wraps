# Deploying the relay

Build and publish the relay image first so `infra/gcp/expected.json` contains its pinned
`roles.relay.imageReference`. Then provide the relay's public attestation audience, the HTTPS
issuer URL, and the relay hostname or IP used by clients:

```sh
ATTESTATION_AUDIENCE='https://wraps.invalid/relay' \
ISSUER_URL='https://<issuer-ip>' \
RELAY_HOSTNAME='<relay-ip-or-dns-name>' \
infra/gcp/deploy.sh relay --dry-run
```

Review the printed `gcloud` command, then run it without `--dry-run` to create the VM. These
three values are public configuration passed as Confidential Space `tee-env-*` metadata; do not
put credentials, private keys, tokens, or other secrets in instance metadata. The deployment
keeps the required `n2d-standard-2` machine type, `project=wraps` label, `wraps` network tag,
and 12-hour stop limit. The firewall must permit tcp:443 and tcp:8080 for tag `wraps`.
