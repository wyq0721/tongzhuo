# Project guide

Tongzhuo is a small group chat service hosted on the room owner's Mac. Humans share messages and files; owner-approved requests are processed by one OpenAI-hosted Codex task per room. Cloud execution must not silently fall back to local inference or a separately billed model API.

## Runtime and validation

- Node.js 22.13+ with built-in `node:sqlite`.
- Python 3 for the standard-library transport client and its integration test.
- No npm runtime dependencies. There is no lockfile requiring `npm ci`.
- Run from the repository root:

```sh
npm run check
npm test
npm run build
```

The tests start temporary loopback HTTP services and use temporary databases and fake CLI commands. They do not submit real cloud tasks. Passing tests is not evidence of a successful hosted model run.

## Cloud environment preparation

Install or select the runtimes above and run validation. Do not start the Mac server, public tunnel, browser QA, or public QA as environment startup services. The cloud worker uses `agent_client.py` or the room protocol supplied in its task; it does not require a second Codex login or model API key.

## Data and execution boundaries

- `.local/` contains private databases, files, account capabilities, logs, and machine-specific tools. Never commit or upload it.
- Role labels identify speakers; they do not grant owner permissions.
- Ordinary messages stay quiet. An explicit `@Agent` request creates work; member requests require owner approval.
- Preserve one running request per room, fixed message/file snapshots, byte checksums, idempotent results, and explicit unknown states. Never automatically replay an ambiguous submission.
- Report actual cloud execution separately from local protocol tests.

Source entry points: `server.mjs`, `cloud-runtime.mjs`, `public/`, and `agent_client.py`. Product goals are in `docs/product-spec.md`; current validation limits are in `MVP-status.md`.
