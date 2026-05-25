import type { AppSyncResolverEvent } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/scan";
import type { Schema } from "../../data/resource";
import { fetchMatchingEmails, type SenderQuery } from "./gmail";
import { getAppPassword } from "./secrets";
import { parseBillEmail } from "./parse";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const DEFAULT_LOOKBACK_DAYS = 14; // for the first scheduled scan of an account
const BACKFILL_DAYS = 365;

type Mode = "scheduled" | "manual" | "backfill";
type SenderFilterRecord = Schema["SenderFilter"]["type"];

interface ScanArgs {
  emailAccountId?: string | null;
  billerId?: string | null;
  sinceDays?: number | null;
}

interface ScanSummary {
  mode: Mode;
  messagesScanned: number;
  billsCreated: number;
  errors: string[];
}

/** Drain every page of a paginated list() so we never silently truncate at 100. */
async function listAll<T>(
  fetchPage: (token?: string) => Promise<{ data: T[]; nextToken?: string | null; errors?: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    const res = await fetchPage(token);
    if (res.errors) throw new Error(`list failed: ${JSON.stringify(res.errors)}`);
    out.push(...res.data);
    token = res.nextToken ?? undefined;
  } while (token);
  return out;
}

/** Throw if an Amplify Data mutation returned GraphQL errors (it does not throw on its own). */
function assertOk(label: string, res: { errors?: unknown }): void {
  if (res.errors) throw new Error(`${label} failed: ${JSON.stringify(res.errors)}`);
}

/**
 * Entry point. Distinguishes its three roles by event shape:
 *  - AppSync mutation `triggerScan`   → manual scan
 *  - AppSync mutation `backfillBiller` → backfill one biller
 *  - EventBridge scheduled event       → hourly incremental scan
 */
export const handler = async (
  event: AppSyncResolverEvent<ScanArgs> | Record<string, unknown>,
): Promise<ScanSummary> => {
  const fieldName = (event as AppSyncResolverEvent<ScanArgs>).info?.fieldName;
  const args = (event as AppSyncResolverEvent<ScanArgs>).arguments ?? {};

  let mode: Mode = "scheduled";
  if (fieldName === "backfillBiller") mode = "backfill";
  else if (fieldName === "triggerScan") mode = "manual";

  const startedAt = new Date().toISOString();
  const summary: ScanSummary = { mode, messagesScanned: 0, billsCreated: 0, errors: [] };

  try {
    if (mode === "backfill") {
      await runBackfill(args.billerId ?? null, args.sinceDays ?? BACKFILL_DAYS, summary);
    } else {
      await runScan(args.emailAccountId ?? null, startedAt, summary);
    }
  } catch (err) {
    summary.errors.push(String(err));
  }

  const run = await client.models.ScanRun.create({
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    messagesScanned: summary.messagesScanned,
    billsCreated: summary.billsCreated,
    errors: summary.errors.length ? summary.errors.join("; ") : undefined,
  });
  if (run.errors) console.error("ScanRun.create failed:", run.errors);

  return summary;
};

/** Scheduled / manual: scan all active accounts (or one) since their lastScanAt. */
async function runScan(
  onlyAccountId: string | null,
  startedAt: string,
  summary: ScanSummary,
): Promise<void> {
  const accounts = await listAll((nextToken) =>
    client.models.EmailAccount.list({ nextToken }),
  );

  for (const account of accounts) {
    if (onlyAccountId && account.id !== onlyAccountId) continue;
    if (account.status === "disabled") continue;

    const filters = await listAll((nextToken) =>
      client.models.SenderFilter.list({
        filter: { emailAccountId: { eq: account.id } },
        nextToken,
      }),
    );
    if (filters.length === 0) continue;

    const since = account.lastScanAt
      ? new Date(account.lastScanAt)
      : daysAgo(DEFAULT_LOOKBACK_DAYS);

    try {
      await scanAccount(account.emailAddress, account.credentialRef!, filters, since, summary);
      // Use startedAt (not now) so messages that arrived mid-scan aren't skipped next run.
      assertOk(
        "EmailAccount.update",
        await client.models.EmailAccount.update({
          id: account.id,
          status: "active",
          lastScanAt: startedAt,
          lastError: undefined,
        }),
      );
    } catch (err) {
      summary.errors.push(`${account.emailAddress}: ${err}`);
      await client.models.EmailAccount.update({
        id: account.id,
        status: "error",
        lastError: String(err),
      });
    }
  }
}

/** Backfill: scan the accounts referenced by one biller's sender filters. */
async function runBackfill(
  billerId: string | null,
  sinceDays: number,
  summary: ScanSummary,
): Promise<void> {
  if (!billerId) throw new Error("backfillBiller requires billerId");

  const filters = await listAll((nextToken) =>
    client.models.SenderFilter.list({ filter: { billerId: { eq: billerId } }, nextToken }),
  );
  if (filters.length === 0) return;

  const since = daysAgo(sinceDays);
  const byAccount = new Map<string, SenderFilterRecord[]>();
  for (const f of filters) {
    const list = byAccount.get(f.emailAccountId) ?? [];
    list.push(f);
    byAccount.set(f.emailAccountId, list);
  }

  for (const [accountId, accountFilters] of byAccount) {
    const { data: account } = await client.models.EmailAccount.get({ id: accountId });
    if (!account) continue;
    try {
      await scanAccount(account.emailAddress, account.credentialRef!, accountFilters, since, summary);
    } catch (err) {
      summary.errors.push(`${account.emailAddress}: ${err}`);
    }
  }
}

/** Fetch → dedupe → parse → write Bills/Alerts for one account. */
async function scanAccount(
  emailAddress: string,
  credentialRef: string,
  filters: SenderFilterRecord[],
  since: Date,
  summary: ScanSummary,
): Promise<void> {
  const byId = new Map(filters.map((f) => [f.id, f]));
  const queries: SenderQuery[] = filters.map((f) => ({
    id: f.id,
    fromAddress: f.fromAddress,
    fromDomain: f.fromDomain,
    subjectContains: f.subjectContains,
  }));

  const appPassword = await getAppPassword(credentialRef);
  const emails = await fetchMatchingEmails({ emailAddress, appPassword, queries, since });
  summary.messagesScanned += emails.length;

  for (const email of emails) {
    // Dedupe via the messageId secondary index (deterministic, unlike a filtered scan).
    const dupe = await client.models.Bill.listBillByMessageId(
      { messageId: email.messageId },
      { limit: 1 },
    );
    if (dupe.errors) throw new Error(`dedupe query failed: ${JSON.stringify(dupe.errors)}`);
    if (dupe.data.length > 0) continue;

    const filter = byId.get(email.matchedQueryId);
    if (!filter) continue;

    const parsed = await parseBillEmail(email);
    if (!parsed.isBill) continue;

    const created = await client.models.Bill.create({
      billerId: filter.billerId,
      emailAccountId: filter.emailAccountId,
      messageId: email.messageId,
      amount: parsed.amount ?? undefined,
      currency: parsed.currency ?? "USD",
      balance: parsed.balance ?? undefined,
      statementDate: parsed.statementDate ?? undefined,
      dueDate: parsed.dueDate ?? undefined,
      status: parsed.status,
      isPastDue: parsed.isPastDue,
      isDisconnectWarning: parsed.isDisconnectWarning,
      isEvictionNotice: parsed.isEvictionNotice,
      confidence: parsed.confidence,
      sourceSnippet: email.body.slice(0, 500),
      subject: email.subject,
      receivedAt: email.receivedAt,
    });
    assertOk("Bill.create", created);
    const bill = created.data;
    if (!bill) continue;
    summary.billsCreated += 1;

    // Emit Alerts for urgent flags so the dashboard can query them cheaply.
    const alerts: { type: "disconnect" | "eviction" | "pastdue"; severity: number }[] = [];
    if (parsed.isEvictionNotice) alerts.push({ type: "eviction", severity: 3 });
    if (parsed.isDisconnectWarning) alerts.push({ type: "disconnect", severity: 2 });
    if (parsed.isPastDue) alerts.push({ type: "pastdue", severity: 1 });
    for (const a of alerts) {
      assertOk(
        "Alert.create",
        await client.models.Alert.create({
          billId: bill.id,
          type: a.type,
          severity: a.severity,
          excerpt: email.subject,
          detectedAt: new Date().toISOString(),
          acknowledged: false,
        }),
      );
    }
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
