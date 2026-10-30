#!/bin/sh
# One-shot: prepare Synapse's config and register the bot as an application service. Runs in the synapse image.
set -e
if [ ! -f /data/homeserver.yaml ]; then
  /start.py generate
fi

cat > /data/aimh-bot.yaml <<YAML
id: aimh-bot
url: ${WORKER_URL}
as_token: ${AS_TOKEN}
hs_token: ${HS_TOKEN}
sender_localpart: pgkbot
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@pgkbot:klinikum\\\\.example"
  aliases: []
  rooms: []
YAML

if ! grep -q '^app_service_config_files' /data/homeserver.yaml; then
  cat >> /data/homeserver.yaml <<YAML

# Added by docker/matrix-init.sh
app_service_config_files:
  - /data/aimh-bot.yaml
# Closed network: no federation, no open registration.
federation_domain_whitelist: []
enable_registration: false
# Demo server with synthetic accounts: default rate limits would reject the tests' traffic.
rc_login:
  address: { per_second: 1000, burst_count: 10000 }
  account: { per_second: 1000, burst_count: 10000 }
  failed_attempts: { per_second: 1000, burst_count: 10000 }
rc_message: { per_second: 1000, burst_count: 10000 }
rc_invites:
  per_room: { per_second: 1000, burst_count: 10000 }
  per_user: { per_second: 1000, burst_count: 10000 }
  per_issuer: { per_second: 1000, burst_count: 10000 }
YAML
fi
chmod -R a+rX /data
echo "matrix-init done"
