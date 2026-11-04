#!/usr/bin/env bash
# Runs what .github/workflows/ci.yml runs, locally, so a commit can go to main
# without waiting on GitHub. Works from any git worktree of this repo.
#
#   scripts/ci-local.sh            jobs for what changed since main (like CI's path filter)
#   scripts/ci-local.sh --all      every job
#   scripts/ci-local.sh --base REF compare against REF instead of main
#
# The integration tests (DynamoDB Local :8000, MinIO :9000) and the e2e suite
# (:8081) use fixed ports, so runs from different worktrees take turns: a lock
# in the shared git dir makes later runs wait. Needs Docker for API changes.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
base=main
all=false
while [ $# -gt 0 ]; do
  case "$1" in
    --all) all=true ;;
    --base) base="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

lock="$(git rev-parse --git-common-dir)/ci-local.lock"
until mkdir "$lock" 2>/dev/null; do
  echo "waiting for another ci-local run ($(cat "$lock/owner" 2>/dev/null || echo '?'))…"
  sleep 15
done
echo "$PWD pid $$" > "$lock/owner"
trap 'rm -rf "$lock"' EXIT

# Path filter, as in ci.yml's `changes` job.
api=$all core=$all web=$all
if [ "$all" = false ]; then
  changed=$( { git diff --name-only "$(git merge-base HEAD "$base")"; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
  shared='^(package\.json|package-lock\.json|\.nvmrc|\.github/workflows/ci\.yml)$'
  grep -Eq "$shared|^apps/api/" <<<"$changed" && api=true
  grep -Eq "$shared|^packages/" <<<"$changed" && core=true
  grep -Eq "$shared|^apps/web/|^packages/" <<<"$changed" && web=true
fi
echo "jobs: scripts api=$api core=$core web=$web (base $base)"

step() { echo; echo "▶ $*"; "$@"; }

# Same install as CI, only when the lockfile moved since the last one.
stamp=node_modules/.ci-local-lock-hash
hash=$(shasum package-lock.json | cut -d' ' -f1)
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$hash" ]; then
  step npx -y npm@11 ci
  echo "$hash" > "$stamp"
fi

step npm run test:scripts

if [ "$api" = true ]; then
  (
    cd apps/api
    step npm run format:check
    step npm run lint
    step npm run typecheck
    step npm run openapi:lint
  )
  step npm run gen:api
  git diff --exit-code packages/core/src/api/schema.d.ts \
    || { echo "✗ Run 'npm run gen:api' and commit packages/core/src/api/schema.d.ts"; exit 1; }
  (
    cd apps/api
    step npm test
    step npm run build
    step npm run validate:bundle
    docker info >/dev/null 2>&1 || { echo "✗ Docker isn't running; the integration tests need it"; exit 1; }
    step docker compose up -d
    for _ in $(seq 30); do curl -s http://localhost:8000 >/dev/null 2>&1 && break; sleep 1; done
    for _ in $(seq 30); do curl -sf http://localhost:9000/minio/health/live >/dev/null && break; sleep 1; done
    DYNAMODB_ENDPOINT=http://localhost:8000 S3_ENDPOINT=http://localhost:9000 step npm run test:cov
  )
fi

if [ "$core" = true ]; then
  step npm run typecheck -w packages/core
  step npm run test:cov -w packages/core
fi

if [ "$web" = true ]; then
  if lsof -iTCP:8081 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✗ Something is already on :8081 (npm run dev:local?). Playwright would test it instead of this build; stop it first."
    exit 1
  fi
  step npm run typecheck -w apps/web
  # CI builds with no API URL or Stripe key; a local apps/web/.env.local
  # (the main checkout has one) would turn on the test bar and the table fee.
  envfile=apps/web/.env.local
  if [ -f "$envfile" ]; then
    mv "$envfile" "$envfile.ci-local-aside"
    trap 'mv -f "$envfile.ci-local-aside" "$envfile" 2>/dev/null; rm -rf "$lock"' EXIT
  fi
  ( for v in $(env | grep -oE '^NEXT_PUBLIC_[A-Z_]+'); do unset "$v"; done
    step npm run build -w apps/web )
  [ -f "$envfile.ci-local-aside" ] && mv -f "$envfile.ci-local-aside" "$envfile"
  # Visual baselines are CI's Linux renders; elsewhere, skip the screenshot
  # comparisons (the flows in visual.spec still run).
  e2e_args=()
  [ "$(uname -s)" = Linux ] || e2e_args=(--ignore-snapshots)
  step npm run e2e -w apps/web -- "${e2e_args[@]}"
  git checkout -- apps/web/e2e/*-snapshots 2>/dev/null || true
  git clean -fdq -- apps/web/e2e/*-snapshots 2>/dev/null || true
fi

echo; echo "✓ ci-local passed: $(git rev-parse --short HEAD)"
