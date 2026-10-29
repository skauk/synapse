#!/usr/bin/env bash
# One-time (and safe to repeat) setup of the local Matrix network for klinikum.example:
#  - Synapse config and the application service registration for the bot, with fresh tokens in .dev.vars
#  - Dr. Lena Hofer's account (synthetic, local only) and a room that invites the bot
# Run `npm run dev` before the room step so the bot sees its invitation, or run this script again afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER=klinikum.example
DATA=matrix/synapse
HS=http://localhost:8008
BOT_LOCALPART=pgkbot
DOCTOR=lena.hofer
DOCTOR_PASSWORD=${DOCTOR_PASSWORD:-demo-only-lena}   # synthetic account on a localhost-only server
WORKER_URL=${WORKER_URL:-http://host.docker.internal:8787}   # how Synapse (in Docker) reaches the Worker

mkdir -p "$DATA"
if [ ! -f "$DATA/homeserver.yaml" ]; then
  docker run --rm -v "$PWD/$DATA:/data" -e SYNAPSE_SERVER_NAME="$SERVER" -e SYNAPSE_REPORT_STATS=no matrixdotorg/synapse:latest generate
fi

touch .dev.vars
for name in AS_TOKEN HS_TOKEN; do
  grep -q "^$name=" .dev.vars || printf '%s=%s\n' "$name" "$(openssl rand -hex 32)" >> .dev.vars
done
AS_TOKEN=$(sed -n 's/^AS_TOKEN=//p' .dev.vars)
HS_TOKEN=$(sed -n 's/^HS_TOKEN=//p' .dev.vars)

cat > "$DATA/aimh-bot.yaml" <<YAML
id: aimh-bot
url: $WORKER_URL
as_token: $AS_TOKEN
hs_token: $HS_TOKEN
sender_localpart: $BOT_LOCALPART
rate_limited: false
namespaces:
  users:
    - exclusive: true
      regex: "@$BOT_LOCALPART:${SERVER//./\\\\.}"
  aliases: []
  rooms: []
YAML

if ! grep -q '^app_service_config_files' "$DATA/homeserver.yaml"; then
  cat >> "$DATA/homeserver.yaml" <<YAML

# Added by scripts/matrix-setup.sh
app_service_config_files:
  - /data/aimh-bot.yaml
# Closed network: no federation, no open registration.
federation_domain_whitelist: []
enable_registration: false
YAML
fi

# Local demo server with synthetic accounts: Synapse's default rate limits (logins, messages, invites) would
# make the end-to-end tests wait for minutes or have requests rejected with 429.
if ! grep -q '^rc_login' "$DATA/homeserver.yaml"; then
  cat >> "$DATA/homeserver.yaml" <<YAML

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

docker compose up -d synapse element
for _ in $(seq 1 60); do curl -sf "$HS/health" >/dev/null && break; sleep 2; done
curl -sf "$HS/health" >/dev/null || { echo "Synapse did not come up. See: docker compose logs synapse"; exit 1; }
# Pick up a changed registration file.
docker compose restart synapse >/dev/null
for _ in $(seq 1 60); do curl -sf "$HS/health" >/dev/null && break; sleep 2; done

docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml \
  -u "$DOCTOR" -p "$DOCTOR_PASSWORD" --no-admin "$HS" >/dev/null 2>&1 || echo "(user $DOCTOR exists already)"

# A second account that is NOT in the network directory (MATRIX_MEMBERS). Used by test/matrix-e2e.mjs.
docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml \
  -u gast -p "demo-only-gast" --no-admin "$HS" >/dev/null 2>&1 || echo "(user gast exists already)"

json() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }
TOKEN=$(curl -sf -X POST "$HS/_matrix/client/v3/login" -H 'content-type: application/json' \
  -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$DOCTOR\"},\"password\":\"$DOCTOR_PASSWORD\"}" | json "['access_token']")
curl -sf -X PUT "$HS/_matrix/client/v3/profile/@$DOCTOR:$SERVER/displayname" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"displayname":"Dr. Lena Hofer"}' >/dev/null

if [ ! -f matrix/room.txt ]; then
  curl -sf -X POST "$HS/_matrix/client/v3/createRoom" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"name\":\"External requests\",\"invite\":[\"@$BOT_LOCALPART:$SERVER\"],\"preset\":\"private_chat\"}" | json "['room_id']" > matrix/room.txt
fi

cat <<TXT

Matrix is ready.
  Element Web:  http://localhost:8081
  Log in as:    @$DOCTOR:$SERVER   password: $DOCTOR_PASSWORD   (homeserver http://localhost:8008)
  Room:         External requests ($(cat matrix/room.txt))
  Then type:    !help
TXT
