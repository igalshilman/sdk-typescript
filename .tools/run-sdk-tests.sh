#!/usr/bin/env bash
set -euo pipefail

# Run the Restate SDK conformance test suite locally.
#
# Prerequisites:
#   - Java 21+
#   - podman or docker
#
# Usage:
#   ./.tools/run-sdk-tests.sh                          # build image + run all default suite tests
#   ./.tools/run-sdk-tests.sh --skip-build             # skip image build, reuse existing
#   ./.tools/run-sdk-tests.sh --gen                    # test the restate-sdk-gen services
#   ./.tools/run-sdk-tests.sh --effect                 # test the restate-sdk-effect services
#   ./.tools/run-sdk-tests.sh --test-suite=default --test-name=Combinators
#
# The target's exclusions file and service env file are wired automatically, matching what
# CI passes. Any unknown flags are passed through to the test runner (e.g. --test-suite,
# --test-name). Note that paths given to the runner must be repo-relative: its dotenv
# loader prepends "./" and rejects an absolute path.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- Version: single source of truth is the workflow file ----
SDK_TEST_SUITE_VERSION="$(grep -m1 'uses: restatedev/e2e/sdk-tests@' \
  "${REPO_ROOT}/.github/workflows/integration.yaml" | sed 's/.*@//' | tr -d ' ')"

JAR_PATH="${REPO_ROOT}/sdk-tests.jar"
JAR_URL="https://github.com/restatedev/e2e/releases/download/${SDK_TEST_SUITE_VERSION}/sdk-tests.jar"
RESTATE_IMAGE="${RESTATE_CONTAINER_IMAGE:-ghcr.io/restatedev/restate:main}"
DATE="$(date +%Y%m%d-%H%M%S)"
REPORT_DIR="${REPO_ROOT}/test-report/${DATE}"

# ---- Detect container runtime ----
if command -v podman &>/dev/null; then
  DOCKER=podman
elif command -v docker &>/dev/null; then
  DOCKER=docker
else
  echo "Error: neither podman nor docker found" >&2
  exit 1
fi

# ---- Parse args ----
SKIP_BUILD=false
SERVICE_IMAGE="localhost/e2e-ts-test-services:local"
SERVICE_DIR="packages/tests/restate-e2e-services"
PASSTHROUGH=()

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --gen)
      SERVICE_IMAGE="localhost/e2e-ts-gen-test-services:local"
      SERVICE_DIR="packages/libs/restate-sdk-gen/test-services"
      ;;
    --effect)
      SERVICE_IMAGE="localhost/e2e-ts-effect-test-services:local"
      SERVICE_DIR="packages/libs/restate-sdk-effect/test-services"
      ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

DOCKERFILE="${SERVICE_DIR}/Dockerfile"

# Match what CI passes (see .github/workflows/integration*.yaml). These must stay
# repo-relative: the runner's dotenv loader cannot read an absolute path.
RUNNER_FILES=()
[ -f "${REPO_ROOT}/${SERVICE_DIR}/exclusions.yaml" ] &&
  RUNNER_FILES+=("--exclusions-file=${SERVICE_DIR}/exclusions.yaml")
[ -f "${REPO_ROOT}/${SERVICE_DIR}/.env" ] &&
  RUNNER_FILES+=("--service-container-env-file=${SERVICE_DIR}/.env")

# ---- 1. Build the service image ----
if [ "$SKIP_BUILD" = false ]; then
  echo "==> Building ${SERVICE_IMAGE}..."
  "${DOCKER}" build -t "${SERVICE_IMAGE}" -f "${DOCKERFILE}" "${REPO_ROOT}"
fi

# ---- 2. Download the test suite JAR (cached by version) ----
# The cache is keyed by a version stamp, not just the file's existence: a jar left
# over from an older pin is silently the wrong test suite.
mkdir -p "$(dirname "$JAR_PATH")"
JAR_STAMP="${JAR_PATH}.version"
if [ ! -f "$JAR_PATH" ] ||
  [ "$(cat "$JAR_STAMP" 2>/dev/null)" != "$SDK_TEST_SUITE_VERSION" ]; then
  echo "==> Downloading sdk-test-suite ${SDK_TEST_SUITE_VERSION}..."
  curl -fSL -o "$JAR_PATH" "$JAR_URL"
  echo "$SDK_TEST_SUITE_VERSION" >"$JAR_STAMP"
else
  echo "==> Using cached sdk-test-suite ${SDK_TEST_SUITE_VERSION}"
fi

# ---- 3. Pull the Restate runtime image ----
# The runner uses --image-pull-policy=CACHED, so a locally present image is enough:
# a failed pull (offline, or an expired ghcr.io login in ~/.docker/config.json) is a
# warning, not a reason to abandon the run.
echo "==> Pulling Restate image: ${RESTATE_IMAGE}..."
if ! "${DOCKER}" pull "${RESTATE_IMAGE}"; then
  if "${DOCKER}" image inspect "${RESTATE_IMAGE}" &>/dev/null; then
    echo "==> WARNING: pull failed; using the local copy of ${RESTATE_IMAGE} (may be stale)"
  else
    echo "Error: pull failed and ${RESTATE_IMAGE} is not present locally" >&2
    exit 1
  fi
fi

# ---- 4. Run the tests ----
echo "==> Running integration tests (suite ${SDK_TEST_SUITE_VERSION})..."
rm -rf "${REPORT_DIR}"
mkdir -p "${REPORT_DIR}"

cd "${REPO_ROOT}"
RESTATE_CONTAINER_IMAGE="${RESTATE_IMAGE}" java -jar "${JAR_PATH}" run \
  --sequential \
  --image-pull-policy=CACHED \
  --report-dir="${REPORT_DIR}" \
  --service-container-image="${SERVICE_IMAGE}" \
  "${RUNNER_FILES[@]+"${RUNNER_FILES[@]}"}" \
  "${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}"

echo ""
echo "==> Done. Report: ${REPORT_DIR}"
