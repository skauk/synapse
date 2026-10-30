#!/bin/sh
# Runs the HL7 FHIR validator on every resource the service files. Installs Java in this temporary container.
set -e
apt-get update -qq
apt-get install -y -qq --no-install-recommends default-jre-headless curl >/dev/null
./scripts/validate-fhir.sh
