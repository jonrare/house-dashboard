# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Single-user personal Bill Tracker. A scheduled Lambda scrapes a Gmail inbox over IMAP for emails
from configured billers, parses each with the Claude API into structured bill data, stores it in
Amplify Data (AppSync + DynamoDB), and serves a React dashboard. AWS Amplify Gen 2, TypeScript
end-to-end, single repo, deploy-on-commit.

## Commands

```bash
npm install
npx ampx sandbox        # provision a personal cloud backend; generates amplify_outputs.json + $amplify/env/*
npm run dev             # Vite dev server (needs amplify_outputs.json from a sandbox/deploy)
npm run build           # tsc -b && vite build
npm run lint            # tsc -b --noEmit
npm run test:parse      # exercise the Claude extraction on sample emails (needs ANTHROPIC_API_KEY)
```

Set secrets for the backend: `npx ampx sandbox secret set ANTHROPIC_API_KEY`, and store each Gmail
App Password in AWS Secrets Manager under a name starting with `bill-tracker/` (see README).

### Generated files — required for a full build/typecheck

`amplify_outputs.json` (imported by [src/main.tsx](src/main.tsx)) and `$amplify/env/scan` (imported by
[amplify/functions/scan/handler.ts](amplify/functions/scan/handler.ts)) are produced by `ampx sandbox`
/ `ampx pipeline-deploy` and are git-ignored. **`npm run build` / `npm run lint` fail until a sandbox
or deploy has generated them.** Without cloud access, typecheck modules in isolation instead, e.g.:

```bash
# frontend
npx tsc --noEmit --skipLibCheck --jsx react-jsx --moduleResolution bundler --module esnext \
  --target es2020 --strict --lib es2020,dom,dom.iterable --resolveJsonModule --types node \
  src/App.tsx src/client.ts src/pages/*.tsx
# the scan handler: declare `$amplify/env/scan` in a throwaway .d.ts, then point tsc at it + handler.ts
```

## Architecture

### The `scan` function plays three roles (one Lambda)

[amplify/functions/scan/handler.ts](amplify/functions/scan/handler.ts) is the whole ingestion pipeline.
It distinguishes its three invocation modes by **event shape**:

- EventBridge scheduled event (hourly, `schedule: "every 1h"`) → incremental scan of every active account
- AppSync resolver event with `event.info.fieldName === "triggerScan"` → manual scan (one account or all)
- `event.info.fieldName === "backfillBiller"` → 12-month backfill for one biller

Both custom mutations are wired to this same function in [amplify/data/resource.ts](amplify/data/resource.ts)
via `.handler(a.handler.function(scan))`. Because the function both **resolves Data mutations** and
**calls the Data API**, it sets `resourceGroupName: "data"` in
[amplify/functions/scan/resource.ts](amplify/functions/scan/resource.ts) to break the
function↔data circular dependency. Inside the Lambda it uses the Data-client-in-Lambda pattern
(`getAmplifyDataClientConfig(env)` → `Amplify.configure` → `generateClient<Schema>()`), and the schema
grants it access with `.authorization((allow) => [allow.resource(scan)])`.

### Ingestion data flow

User config (EmailAccount + Biller + SenderFilter) drives the scan. Per account:
[gmail.ts](amplify/functions/scan/gmail.ts) opens INBOX **read-only** over IMAP (`imapflow`) using the
App Password, runs one IMAP search per SenderFilter, and tags each fetched email with the matching
filter's id (`matchedQueryId`) so biller attribution is exact rather than re-guessed from the `From`
line. [handler.ts](amplify/functions/scan/handler.ts) then, per email: **dedupes** (see invariant
below), parses via [parse.ts](amplify/functions/scan/parse.ts) (forced `record_bill` tool-use), and on
`isBill` writes a `Bill` plus an `Alert` per urgent flag (eviction/disconnect/pastdue). Every run writes
a `ScanRun` log record.

### Secrets / credentials

- `ANTHROPIC_API_KEY`: Amplify secret, injected as a Lambda env var; `new Anthropic()` reads it from
  `process.env`. Model is `CLAUDE_MODEL` (default `claude-sonnet-4-6`).
- Gmail App Password: stored in AWS Secrets Manager; `EmailAccount.credentialRef` holds the **secret
  name**, never the password. [secrets.ts](amplify/functions/scan/secrets.ts) reads it; the IAM policy
  in [backend.ts](amplify/backend.ts) is scoped to `bill-tracker/*`, so secret names **must** use that
  prefix or the function gets AccessDenied. Gmail uses App Password + IMAP, not OAuth — a deliberate
  choice (see README "Gmail connection").

### Single-user auth

Cognito with self-signup disabled (`allowAdminCreateUserOnly` in [backend.ts](amplify/backend.ts);
`hideSignUp` on the `Authenticator` in [src/main.tsx](src/main.tsx)). All models authorize with
`allow.authenticated()`; the one user is created manually after first deploy.

### Frontend

Plain tab navigation (no router) in [src/App.tsx](src/App.tsx); four pages under [src/pages](src/pages).
[src/client.ts](src/client.ts) holds the shared typed Data client plus helpers (`listAll` paginator,
`clearAlertsForBill`). Dashboard and Bills use **`observeQuery` live subscriptions** so bills written by
a background scan appear without a manual refresh; other lists use `listAll`. Scans are async — the UI
triggers a mutation and shows a "runs in the background" notice rather than implying completion.

## Project-specific invariants (easy to get wrong)

- **Dedupe must use the `messageId` secondary index** (`client.models.Bill.listBillByMessageId(...)`),
  not a filtered `list()`. A filtered `list({ filter: { messageId }, limit: 1 })` scans only one page and
  can miss a match on a later page → duplicate bills. The index is declared via
  `.secondaryIndexes((index) => [index("messageId")])`.
- **Amplify Data mutations do not throw on GraphQL errors** — they resolve `{ data, errors }`. Always
  check `errors` (backend uses `assertOk`; frontend surfaces them).
- **`list()` is page-bounded (~100)** — always paginate via `nextToken` (`listAll`) when treating a
  result as complete.
- **Enum `a.ref(...)` fields do not support `.default()`** — only scalar fields do.
- **AppSync field name is `event.info.fieldName`**, not `event.fieldName`.
- The Claude system prompt in [parse.ts](amplify/functions/scan/parse.ts) is kept frozen and below the
  cacheable-prefix minimum, so `cache_control` is currently a harmless no-op; keep volatile per-email
  content in the user turn so caching starts working automatically if the prompt grows.

## Deploy

Connect the repo to Amplify Hosting once; [amplify.yml](amplify.yml) runs `ampx pipeline-deploy`
(backend) then `npm run build` (frontend) on every push to the tracked branch.
