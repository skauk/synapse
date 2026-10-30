#!/bin/sh
# Starts the Worker for the demo stack. Everything is local: mock ID Austria, Mailpit, HAPI, Synapse.
set -e
cat > .dev.vars <<VARS
BOT_API_TOKEN=${BOT_API_TOKEN}
OIDC_CLIENT_SECRET=
AS_TOKEN=${AS_TOKEN}
HS_TOKEN=${HS_TOKEN}
IDP=mock
BASE_URL=http://localhost:8787
FHIR_BASE_URL=http://hapi:8080/fhir
MATRIX_HOMESERVER_URL=http://synapse:8008
MAIL_MODE=mailpit
MAILPIT_URL=http://mailpit:8025
MATRIX_MEMBERS=@lena.hofer:klinikum.example
MATRIX_OPEN=${MATRIX_OPEN:-false}
BOT_MAX_MESSAGES=${BOT_MAX_MESSAGES:-0}
BOT_ACTIVE_DATE=${BOT_ACTIVE_DATE:-}
ALLOWED_PATIENTS=
VARS
npx wrangler d1 migrations apply DB --local
exec npx wrangler dev --ip 0.0.0.0 --port 8787
