#!/bin/sh
# One-shot, runs in the synapse image: config for the public judge server, bot registered as application service.
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

# Added by docker/homer/matrix-init.sh
public_baseurl: ${PUBLIC_BASEURL}
app_service_config_files:
  - /data/aimh-bot.yaml
# Closed network: no federation. Accounts only with the registration token handed to the judges.
federation_domain_whitelist: []
enable_registration: true
registration_requires_token: true
enable_registration_without_verification: true
YAML
fi
# Without an explicit rule Synapse refuses to list rooms in the room directory.
if ! grep -q '^room_list_publication_rules' /data/homeserver.yaml; then
  cat >> /data/homeserver.yaml <<YAML

room_list_publication_rules:
  - user_id: "*"
    alias: "*"
    room_id: "*"
    action: allow
YAML
fi
chmod -R a+rX /data
echo "matrix-init done"
