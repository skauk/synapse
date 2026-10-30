#!/bin/sh
# Runs every automated test against the running stack, from a temporary container on the Compose network.
set -e
echo "== unit tests"
npx vitest run
echo "== end-to-end tests (identity, FHIR, misdeliveries, audit)"
node test/e2e.mjs
echo "== end-to-end tests through Matrix"
node test/matrix-e2e.mjs
echo "== all tests passed"
