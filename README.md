# Gitclaw — AI Code Reviewer

Repository-agnostic AI reviewer for GitHub: adversarial PR review (Gitclaw
Agent) and optional QA/test-coverage review (QA Claw), driven by an LLM
cascade behind a Cloudflare Worker proxy.

This is the **central repository**: the runtime, prompts, and workflow live
here. Attaching repositories carry no reviewer code — they add one small
caller workflow and (optionally) a policy file.

## Layout

```
src/                     Generic runtime (@gitclaw/runtime equivalent)
  ├── lifecycle.ts       Event parsing, tools, agent runner, review submission
  ├── worker.ts          Cloudflare Worker: LLM provider cascade (router + adapters)
  ├── router.ts          Role/model routing, circuit breakers, fallbacks
  ├── adapters/          tokenrouter / opencode / mistral adapters
  └── *.test.ts          bun test suite (also runs inside CI before every review)
lifecycle/               Entrypoints executed by CI
  ├── main.ts            Gitclaw Agent — adversarial reviewer (system prompts)
  ├── qa_sdet.ts         QA Claw — test-coverage reviewer (not auto-launched)
  └── shared.ts          Re-export glue over src/
cloudflare/              Deployed LLM proxy Worker (worker.js + wrangler.toml)
.github/workflows/
  └── review.yml         Reusable workflow (workflow_call) — the attach point
examples/ai-review.yml   Caller template for attaching repositories
.gitclaw/
  └── worker.json.example  Per-repo reviewer rules/excludes template
```

## Attaching to a repository (the whole procedure)

1. Copy `examples/ai-review.yml` into the attaching repo as
   `.github/workflows/ai-review.yml`. Adjust `if:` (author policy), runner
   label, and the optional second reviewer job as needed.
2. Add repository secrets:
   - `LLM_PROXY_API_KEY` — required, bearer for the LLM router.
   - `GITCLAW_TOKEN` — required only while this repo is **private**: a PAT
     (repo scope) that can read it. Once public, remove it.
   - `CF_WORKER_URL`, `LINEAR_API_KEY` — optional.
3. (Optional) Commit `.gitclaw/worker.json` with repo-specific reviewer rules
   and path excludes — see `.gitclaw/worker.json.example`. Repository policy
   files (`AGENTS.md`, etc.) are picked up automatically from the repo root.

Nothing else: no vendored code, no npm dependency, no submodule. Updates land
in this repo and every attached repo picks them up via `central_ref`
(pin `@main` for rolling updates, or a `@<sha>` for frozen versions).

## How a review run works

1. The caller workflow triggers on `pull_request_target` / `issues` /
   `issue_comment` and enforces its own author policy (no bots, no external
   contributors).
2. The reusable workflow checks out **this repo** (runtime) and the
   **reviewed repository at `github.sha`** — for `pull_request_target` that is
   the trusted base commit. PR-head code is never executed; the diff is
   fetched read-only via the GitHub API.
3. The runtime unit suite runs first; a failure aborts before any review.
4. A dedup step skips agents that already reviewed the current head SHA
   (matching the hidden `agent:gitclaw` marker in review bodies).
5. The agent runs with `GITCLAW_REPO_ROOT=reviewed`, so all file tools
   (`readRepoFile`, `searchCode`, `listRepoDirectory`, static policy context)
   operate on the reviewed checkout.

> Windows self-hosted runners: every `run:` step in `review.yml` pins
> `shell: bash`. A bare `run:` on a Windows runner executes under PowerShell,
> which cannot parse bash — the 2026-09-02 dedup-step outage.

## Configuration

- Model cascade: `cloudflare/wrangler.toml` `[vars]`
  (`MODEL_DEFAULT` / `MODEL_PLANNER` / `MODEL_CODER` / `MODEL_REVIEWER`,
  comma-separated fallback chains). Deploy with `wrangler deploy` in
  `cloudflare/` after changing vars.
- Adapter-level model defaults: `src/adapters/*.ts`
  (`DEFAULT_*_MODEL` constants).
- The lifecycle client uses `CF_WORKER_URL` when set, otherwise the built-in
  default Worker URL in `src/lifecycle.ts`.

## Local development

```bash
bun install
bun test src          # unit suite
bun run build         # bundles lifecycle + worker to .tmp/
bun run format:check
```

Prettier covers the whole repo. Workflow YAML is included — keep it formatted.
