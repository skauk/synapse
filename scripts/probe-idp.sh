#!/usr/bin/env bash
# Ask the ID Austria reference IdP whether it accepts a client ID. No credentials involved.
# A rejected client or redirect URI gets an error page; an accepted one is redirected to the login page.   Usage: scripts/probe-idp.sh [client_id]
set -euo pipefail
CLIENT_ID=${1:-$(sed -n 's/.*"OIDC_CLIENT_ID": "\([^"]*\)".*/\1/p' "$(dirname "$0")/../wrangler.jsonc")}
REDIRECT=https%3A%2F%2Fsynapse.dingsbums.click%2Fauth%2Fcallback
URL="https://idp.ref.id-austria.gv.at/auth/idp/profile/oidc/authorize?response_type=code&scope=openid&redirect_uri=$REDIRECT&state=probe&nonce=probe&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&client_id=$CLIENT_ID"
CODE=$(curl -s -m 20 -o /tmp/idp-probe.html -w '%{http_code}' "$URL")
# An accepted client and redirect URI get a 302 to the login page. Anything else is a rejection.
if [ "$CODE" = "302" ]; then
  echo "client_id=$CLIENT_ID: ACCEPTED (HTTP 302, redirect to the login page)"; exit 0
fi
REASON=$(python3 - <<'PY'
import re, html
t = open("/tmp/idp-probe.html", errors="ignore").read()
t = re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S)
t = " ".join(html.unescape(re.sub(r"<[^>]+>", " ", t)).split())
i = t.find("Fehler:")
print(t[i:i + 140] if i >= 0 else "no error text")
PY
)
echo "client_id=$CLIENT_ID: REJECTED (HTTP $CODE) $REASON"; exit 1
