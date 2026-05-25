# Bill Tracker

Personal bill tracker. A scheduled Lambda scrapes a Gmail inbox (over IMAP) for
emails from configured billers, parses each with the Claude API into structured bill
data, and stores it in Amplify Data (AppSync + DynamoDB). A React dashboard surfaces
open bills, past-due amounts, and urgent disconnect/eviction warnings.

Single repo, single user, deploy-on-commit via AWS Amplify Gen 2.

## Architecture

- `amplify/auth` — Cognito (single user, self-signup disabled)
- `amplify/data` — models (EmailAccount, Biller, SenderFilter, Bill, Alert, ScanRun)
  plus custom mutations `triggerScan` and `backfillBiller`
- `amplify/functions/scan` — ingestion Lambda (hourly schedule + the two mutations):
  IMAP fetch → dedupe by Message-ID → Claude `record_bill` tool-use → write Bills/Alerts
- `src` — Vite + React frontend (Dashboard, Email Accounts, Billers, Bills)

## Prerequisites

1. Node 20+ and an AWS account with the Amplify backend tooling.
2. A Claude API key.
3. A Gmail account with 2-Step Verification enabled, plus an
   [App Password](https://support.google.com/accounts/answer/185833).

## Local development

```bash
npm install
npx ampx sandbox        # provisions a personal cloud backend, writes amplify_outputs.json
npm run dev             # Vite dev server at http://localhost:5173
```

### Secrets

- **Claude API key** — set the Amplify secret used by the `scan` function:
  ```bash
  npx ampx sandbox secret set ANTHROPIC_API_KEY
  ```
- **Gmail App Password** — store in AWS Secrets Manager under a name starting with
  `bill-tracker/` (the IAM policy in `amplify/backend.ts` scopes the function to that
  prefix), e.g.:
  ```bash
  aws secretsmanager create-secret --name bill-tracker/me-gmail \
    --secret-string '{"appPassword":"abcd efgh ijkl mnop"}'
  ```
  Enter the secret name (`bill-tracker/me-gmail`) as the account's "credential ref" in
  the Email Accounts page. The raw password is never stored in DynamoDB.

## Deploy (single repo, deploy-on-commit)

1. Push this repo to GitHub.
2. In the Amplify console, create an app from the repo and pick the branch.
3. Set the `ANTHROPIC_API_KEY` secret in the Amplify console for that branch.
4. On every push, `amplify.yml` runs `ampx pipeline-deploy` (backend) then
   `npm run build` (frontend) — see the build spec.
5. After the first deploy, create the single Cognito user (Amplify console → Auth, or
   `aws cognito-idp admin-create-user`). Self-signup is disabled.

## Verify

```bash
npm run lint                 # typecheck
npm run test:parse           # exercise the Claude extraction on sample emails
```

End-to-end: add a Gmail account + its Secrets Manager ref, create a Biller with a
sender filter, click **Backfill 12 months**, and confirm bills appear on the Dashboard
(with disconnect/eviction samples landing in the urgent banner).
