import type { AppSyncResolverEvent } from "aws-lambda";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/scan";
import type { Schema } from "../../data/resource";
import { fetchMatchingEmails, type SenderQuery } from "./gmail";
import { parseBillEmail, type BillCandidate } from "./parse";

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const DEFAULT_LOOKBACK_DAYS = 45; // first scan, or the next scan after the cursor is reset
const BACKFILL_DAYS = 365;
const SCAN_STATE_ID = "global"; // singleton ScanState row holding the incremental cursor

type Mode = "scheduled" | "manual" | "backfill";
type SenderFilterRecord = Schema["SenderFilter"]["type"];
type BillRecord = Schema["Bill"]["type"];

interface ScanArgs {
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
 *  - AppSync mutation `triggerScan`   → manual scan of the configured mailbox
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
      await runScan(startedAt, summary);
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

/** Scheduled / manual: scan all sender filters since the last successful scan. */
async function runScan(startedAt: string, summary: ScanSummary): Promise<void> {
  const filters = await listAll((nextToken) =>
    client.models.SenderFilter.list({ nextToken }),
  );
  if (filters.length === 0) return;

  const { data: state } = await client.models.ScanState.get({ id: SCAN_STATE_ID });
  const since = state?.lastScanAt
    ? new Date(state.lastScanAt)
    : daysAgo(DEFAULT_LOOKBACK_DAYS);

  await scanFilters(filters, since, summary);

  // Advance the cursor only after a clean run (a throw above skips this). Use startedAt,
  // not now, so messages that arrived mid-scan aren't skipped next run.
  await upsertScanState(startedAt);
}

/** Backfill one biller's senders. Does not move the incremental cursor. */
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

  await scanFilters(filters, daysAgo(sinceDays), summary);
}

/** Fetch → dedupe → reconcile (create / update / skip) → write Bills/Alerts. */
async function scanFilters(
  filters: SenderFilterRecord[],
  since: Date,
  summary: ScanSummary,
): Promise<void> {
  const gmailAddress = env.GMAIL_ADDRESS;
  const appPassword = env.GMAIL_APP_PASSWORD;
  if (!gmailAddress || !appPassword) {
    throw new Error("GMAIL_ADDRESS env var and GMAIL_APP_PASSWORD secret must be configured");
  }

  const byId = new Map(filters.map((f) => [f.id, f]));
  const queries: SenderQuery[] = filters.map((f) => ({
    id: f.id,
    fromAddress: f.fromAddress,
    fromDomain: f.fromDomain,
    subjectContains: f.subjectContains,
  }));

  const emails = await fetchMatchingEmails({ emailAddress: gmailAddress, appPassword, queries, since });
  summary.messagesScanned += emails.length;

  // Process oldest first so a payment/resolution email is seen after the bill it affects.
  emails.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

  // Recent bills per biller, used as reconciliation context for the parser. Seeded from the
  // DB on first use and kept in sync as we create/update bills within this run.
  const candidatesByBiller = new Map<string, BillRecord[]>();
  async function candidatesFor(billerId: string): Promise<BillRecord[]> {
    let bills = candidatesByBiller.get(billerId);
    if (!bills) {
      const all = await listAll((nextToken) =>
        client.models.Bill.list({ filter: { billerId: { eq: billerId } }, nextToken }),
      );
      all.sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""));
      bills = all.slice(0, 25);
      candidatesByBiller.set(billerId, bills);
    }
    return bills;
  }

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

    const candidates = await candidatesFor(filter.billerId);
    const parsed = await parseBillEmail(email, candidates.map(toCandidate));

    if (parsed.action === "skip") continue;

    const target =
      parsed.action === "update" && parsed.targetIndex != null
        ? candidates[parsed.targetIndex]
        : undefined;

    if (target) {
      // Update an existing bill (e.g. a payment that resolves a past-due/disconnect notice).
      const updated = await client.models.Bill.update({
        id: target.id,
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
      });
      assertOk("Bill.update", updated);
      if (updated.data) Object.assign(target, updated.data); // keep the cached candidate current
      await syncAlerts(target.id, parsed, email.subject);
    } else {
      // Create a new bill.
      const created = await client.models.Bill.create({
        billerId: filter.billerId,
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
      candidates.unshift(bill); // newest first; visible to later emails in this run
      await syncAlerts(bill.id, parsed, email.subject);
    }
  }
}

/** Compact view of a tracked bill for the parser's reconciliation context. */
function toCandidate(b: BillRecord): BillCandidate {
  return {
    amount: b.amount ?? null,
    currency: b.currency ?? null,
    statementDate: b.statementDate ?? null,
    dueDate: b.dueDate ?? null,
    status: b.status ?? null,
    isPastDue: !!b.isPastDue,
    isDisconnectWarning: !!b.isDisconnectWarning,
    isEvictionNotice: !!b.isEvictionNotice,
    subject: b.subject ?? null,
    receivedAt: b.receivedAt ?? null,
  };
}

/** Make a bill's Alerts match its current urgent flags (clear all, then recreate). */
async function syncAlerts(
  billId: string,
  flags: { isEvictionNotice: boolean; isDisconnectWarning: boolean; isPastDue: boolean },
  excerpt: string,
): Promise<void> {
  const existing = await listAll((nextToken) =>
    client.models.Alert.list({ filter: { billId: { eq: billId } }, nextToken }),
  );
  for (const a of existing) {
    assertOk("Alert.delete", await client.models.Alert.delete({ id: a.id }));
  }

  const alerts: { type: "disconnect" | "eviction" | "pastdue"; severity: number }[] = [];
  if (flags.isEvictionNotice) alerts.push({ type: "eviction", severity: 3 });
  if (flags.isDisconnectWarning) alerts.push({ type: "disconnect", severity: 2 });
  if (flags.isPastDue) alerts.push({ type: "pastdue", severity: 1 });
  for (const a of alerts) {
    assertOk(
      "Alert.create",
      await client.models.Alert.create({
        billId,
        type: a.type,
        severity: a.severity,
        excerpt,
        detectedAt: new Date().toISOString(),
        acknowledged: false,
      }),
    );
  }
}

/** Upsert the singleton scan cursor. */
async function upsertScanState(lastScanAt: string): Promise<void> {
  const { data: existing } = await client.models.ScanState.get({ id: SCAN_STATE_ID });
  if (existing) {
    assertOk(
      "ScanState.update",
      await client.models.ScanState.update({ id: SCAN_STATE_ID, lastScanAt }),
    );
  } else {
    assertOk(
      "ScanState.create",
      await client.models.ScanState.create({ id: SCAN_STATE_ID, lastScanAt }),
    );
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
