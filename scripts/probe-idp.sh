#!/usr/bin/env bash
# Ask the ID Austria reference IdP whether it accepts a client ID. No credentials involved.
# An unknown or not yet accredited service gets an error page ("not registered for the login");
# an accepted one gets the login page.   Usage: scripts/probe-idp.sh [client_id]
set -euo pipefail
CLIENT_ID=${1:-$(sed -n 's/.*"OIDC_CLIENT_ID": "\([^"]*\)".*/\1/p' "$(dirname "$0")/../wrangler.jsonc")}
REDIRECT=https%3A%2F%2Fsynapse.skauk.workers.dev%2Fauth%2Fcallback
URL="https://idp.ref.id-austria.gv.at/auth/idp/profile/oidc/authorize?response_type=code&scope=openid&redirect_uri=$REDIRECT&state=probe&nonce=probe&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&client_id=$CLIENT_ID"
CODE=$(curl -s -m 20 -o /tmp/idp-probe.html -w '%{http_code}' "$URL")
if grep -q "not registered for the login" /tmp/idp-probe.html; then
  echo "client_id=$CLIENT_ID: REJECTED (HTTP $CODE): not registered, or accreditation not active yet"; exit 1
fi
echo "client_id=$CLIENT_ID: HTTP $CODE, no 'not registered' error, so the IdP seems to accept it"
