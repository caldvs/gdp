#!/usr/bin/env bash
# Merge a PR only when CI's `gate` check passed on its latest commit and the
# branch is up to date with main. This is the only way PRs get merged: the
# repo is private on the free plan, so GitHub can't block its merge button.
#
#   scripts/merge-pr.sh <pr-number> [--force]
#
# --force skips the checks. Callum only; a Claude session never passes it
# unless Callum says so in chat.
#
# Merges locally with --no-ff and pushes main, so the merge commit is yours
# and GitHub marks the PR merged. Needs `gh` (REST only) and push access.
set -euo pipefail

repo="caldvs/gdp"
pr="${1:-}"
force="${2:-}"
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "usage: scripts/merge-pr.sh <pr-number> [--force]" >&2; exit 2; }
[[ -z "$force" || "$force" == "--force" ]] || { echo "unknown option: $force" >&2; exit 2; }

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Working tree has uncommitted changes; commit or stash them first." >&2
  exit 1
fi

read -r state head_ref head_sha base_ref < <(
  gh api "repos/$repo/pulls/$pr" --jq '[.state, .head.ref, .head.sha, .base.ref] | @tsv'
)
[[ "$state" == "open" ]] || { echo "PR #$pr is $state." >&2; exit 1; }
[[ "$base_ref" == "main" ]] || { echo "PR #$pr targets $base_ref, not main." >&2; exit 1; }
title="$(gh api "repos/$repo/pulls/$pr" --jq .title)"

if [[ "$force" != "--force" ]]; then
  # 1. The gate check passed on the PR's latest commit.
  gate="$(gh api "repos/$repo/commits/$head_sha/check-runs?check_name=gate&per_page=100" \
    --jq '[.check_runs[] | {status, conclusion, started_at}] | sort_by(.started_at) | last | "\(.status) \(.conclusion)"')"
  if [[ "$gate" != "completed success" ]]; then
    echo "PR #$pr: gate on ${head_sha:0:7} is '${gate:-missing}'. Not merging." >&2
    exit 1
  fi
  # 2. The branch contains current main, so the gate ran against it.
  behind="$(gh api "repos/$repo/compare/main...$head_sha" --jq .behind_by)"
  if [[ "$behind" != "0" ]]; then
    echo "PR #$pr is $behind commit(s) behind main. Merge main into $head_ref, push, and wait for the gate." >&2
    exit 1
  fi
fi

git fetch origin "+refs/heads/main:refs/remotes/origin/main" "+refs/heads/$head_ref:refs/remotes/origin/$head_ref"
fetched_head="$(git rev-parse "origin/$head_ref")"
if [[ "$fetched_head" != "$head_sha" ]]; then
  echo "origin/$head_ref is ${fetched_head:0:7}, but the PR head is ${head_sha:0:7}. Try again." >&2
  exit 1
fi

start_branch="$(git rev-parse --abbrev-ref HEAD)"
git checkout -q main
git merge -q --ff-only origin/main
git merge --no-ff "$head_sha" -m "Merge pull request #$pr from caldvs/$head_ref" -m "$title"
git push origin main
[[ "$start_branch" == "main" ]] || git checkout -q "$start_branch"
echo "Merged PR #$pr."
