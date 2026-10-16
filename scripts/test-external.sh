#!/usr/bin/env bash
# Runs the gated external-backend tests (docs/PLAN.md section 3.3) against CockroachDB and MinIO.
#
#   docker compose -f docker/compose.test.yml up -d --wait   # start the backends first
#   scripts/test-external.sh            cargo test --workspace -- external_
#   scripts/test-external.sh --all      the whole workspace suite with the gates set, so the
#                                       conformance suites also run on Backend::External
#   scripts/test-external.sh --up ...   start docker/compose.test.yml before testing
#
# Every BEEGIT_TEST_* variable may be overridden from the environment.
set -euo pipefail
cd "$(dirname "$0")/.."

ALL=0
UP=0
EXTRA=()
for arg in "$@"; do
  case "$arg" in
    --all) ALL=1 ;;
    --up) UP=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) EXTRA+=("$arg") ;;
  esac
done

export BEEGIT_TEST_CRDB_URL="${BEEGIT_TEST_CRDB_URL:-postgresql://root@localhost:26257/defaultdb?sslmode=disable}"
export BEEGIT_TEST_S3_ENDPOINT="${BEEGIT_TEST_S3_ENDPOINT:-http://localhost:9000}"
export BEEGIT_TEST_S3_BUCKET="${BEEGIT_TEST_S3_BUCKET:-beegit-test}"
export BEEGIT_TEST_S3_ACCESS_KEY="${BEEGIT_TEST_S3_ACCESS_KEY:-minioadmin}"
export BEEGIT_TEST_S3_SECRET_KEY="${BEEGIT_TEST_S3_SECRET_KEY:-minioadmin}"
export BEEGIT_TEST_S3_REGION="${BEEGIT_TEST_S3_REGION:-us-east-1}"

if [ "$UP" = 1 ]; then
  docker compose -f docker/compose.test.yml up -d --wait
fi

echo "external backends: crdb=${BEEGIT_TEST_CRDB_URL} s3=${BEEGIT_TEST_S3_ENDPOINT} bucket=${BEEGIT_TEST_S3_BUCKET}"
if [ "$ALL" = 1 ]; then
  cargo test --workspace -- "${EXTRA[@]+"${EXTRA[@]}"}"
else
  cargo test --workspace -- external_ "${EXTRA[@]+"${EXTRA[@]}"}"
fi
