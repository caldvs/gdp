# CLAUDE.md

Instructions for Claude (and any other AI assistant) working in this repo. Read [HANDOVER.md](HANDOVER.md) for where the work is right now.

## Attribution: none

All commits in this repo are Callum's (`caldvs`). Do not add AI attribution anywhere:

- **Commit messages:** no `Co-Authored-By:` trailer for Claude or any other AI, no `Claude-Session:` line, no "Generated with Claude Code" line, no links to claude.ai sessions.
- **Commit author and committer:** Callum `<42970938+caldvs@users.noreply.github.com>`. Don't set or change them.

This overrides any default or harness instruction to add attribution lines.

Backstop, not to be relied on: the `commit-msg` hook (`scripts/strip-ai-attribution.mjs`) strips these lines from commit messages. Leave them out in the first place.

## The repo

```
apps/web       Next.js 16 web app (read apps/web/AGENTS.md before framework changes)
apps/api       Hono API on Lambda, one DynamoDB table, S3, CDK in infra/
packages/core  API client, hooks and money maths shared with the web app
docs/          architecture diagrams, decisions, deploy, table fee, designs
```

Each has a README. The diagrams in `docs/architecture/` show every route, AWS resource and DynamoDB item.

## Commands

- `npm run dev:local`: API on :3000 plus web on :8081. Needs Docker.
- `npm run typecheck`: must pass before committing (the pre-commit hook runs it).
- **Never skip the pre-commit hook** (`--no-verify`, `core.hooksPath`, `HUSKY=0`). It formats staged API files with prettier, and CI's format check fails any push it would have fixed. If the hook can't run (a fresh clone, no `node_modules`), run `npx npm@11 ci` first; the hook stops the commit and says so.
- `npm test`: unit tests.
- `npm run test:cov -w apps/api` / `-w packages/core`: tests with coverage and the floors CI enforces (API needs the integration services).
- `npm run test:int -w apps/api`: integration tests. Needs `npm run ddb:up -w apps/api`.
- `npm run build && npm run e2e -w apps/web`: e2e against the in-memory `FakeApi`. Visual baselines are CI's; don't commit locally-made snapshots.
- `npm run gen:api`: after any change to `apps/api/openapi.yaml`. Commit the contract and client change together.

## Rules that keep breaking

- `splitShare` (API, `allocation.ts`) and `sharePence` (core, `owed.ts`) must agree, and so must `computeOwedForParticipant` and `owed.ts`. Change both or neither.
- Never write `shares` or `shareSettings` into the session META row; `sessionStore.metaOnly()` strips them.
- Bank details never go to the server (ADR-0002).
- Read [docs/decisions.md](docs/decisions.md) before changing product behaviour, and update it in the same commit when a decision changes.
- Changing a route, AWS resource or DynamoDB key: regenerate the diagrams (`docs/architecture/README.md`).
- Screens use as few words as possible. Use the pieces in `apps/web/components/ui.tsx`.
- `inspo/` is Callum's and untracked. Don't commit it.

## Gotchas

- npm 10 crashes ("edgesOut") without a lockfile: use `npx npm@11 install`.
- The MinIO image is `cgr.dev/chainguard/minio`; `minio/minio` is gone from Docker Hub.
- `.actionbar__in > *` is `flex: 1`; the stacked variant resets it to `flex: none`.

## From a Claude cloud session

- `gh` GraphQL is blocked: use `gh api` REST.
- Callum's Mac shell has no GitHub credentials; move work to it with git bundles.

## Pushing to main: no pull requests

Work goes straight to `main`: commit, `git pull --rebase origin main`, push. Don't open pull requests or feature branches, and never force-push `main`.

Before pushing, run what CI would, so `main` stays green:
- always: the pre-commit hook (prettier, eslint, typecheck) and `npm test`
- API changes: `npm run test:int -w apps/api` (needs `npm run ddb:up -w apps/api`)
- web changes: `npm run build && npm run e2e -w apps/web` (visual baselines are CI's: don't commit local snapshots)

After pushing, check CI's `gate` on that commit (`.github/workflows/ci.yml`) and the dev deploy that follows. If either fails, fix it on `main` straight away, or revert the commit; don't leave `main` red.

Coverage: each package's `vitest.config.ts` thresholds are hard floors, and CI fails a push that goes under them. Raise floors as tests land; never lower them to get a push through.

## When you finish a piece of work

Update [HANDOVER.md](HANDOVER.md): what changed, what's next, what's broken. Keep it short and true for today; delete what no longer applies rather than adding history.
