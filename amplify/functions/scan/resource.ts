import { defineFunction, secret } from "@aws-amplify/backend";

/**
 * Core ingestion function. Plays three roles, distinguished at runtime by the
 * event shape (see handler.ts):
 *   - scheduled (EventBridge, hourly) — incremental scan of every active account
 *   - triggerScan mutation (AppSync) — manual "Scan now"
 *   - backfillBiller mutation (AppSync) — scan the last N days for one biller
 *
 * `resourceGroupName: "data"` co-locates this with the Data stack so it can both
 * resolve Data mutations and call the Data API without a circular dependency.
 */
export const scan = defineFunction({
  name: "scan",
  entry: "./handler.ts",
  timeoutSeconds: 600,
  memoryMB: 512,
  resourceGroupName: "data",
  schedule: "every 1h",
  environment: {
    ANTHROPIC_API_KEY: secret("ANTHROPIC_API_KEY"),
    // The single Gmail mailbox to scrape. Address is non-sensitive config (set it as
    // an Amplify Hosting environment variable, picked up at deploy time); the App
    // Password is a secret stored alongside ANTHROPIC_API_KEY.
    GMAIL_ADDRESS: process.env.GMAIL_ADDRESS ?? "",
    GMAIL_APP_PASSWORD: secret("GMAIL_APP_PASSWORD"),
    // Default model; can be overridden per environment.
    CLAUDE_MODEL: "claude-sonnet-4-6",
  },
});
