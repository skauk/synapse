#!/usr/bin/env bash
# Build the FHIR resources for both scenario documents and run the HL7 validator on each (R4).
# Needs Java and network access (the validator fetches the R4 core package and uses a terminology server for LOINC).
set -euo pipefail
cd "$(dirname "$0")/.."
JAR=.cache/validator/validator_cli.jar
OUT=.cache/fhir

if [ ! -f "$JAR" ]; then
  mkdir -p "$(dirname "$JAR")"
  curl -sSL -o "$JAR" https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
fi

rm -rf "$OUT"
FHIR_OUT="$OUT" npx vitest run test/fhir.test.ts >/dev/null
java -jar "$JAR" "$OUT"/*.json -version 4.0 2>&1 | tee "$OUT/validator.log" | tail -${TAIL:-60}
# The validator prints "Done. Times: ..." then a summary line like "*FAILURE*: 2 errors, 4 warnings, 0 notes".
! grep -q '\*FAILURE\*' "$OUT/validator.log"
