/**
 * Manual verification for the scan pipeline.
 *
 *   npx tsx scripts/test-parse.ts
 *
 * Two parts:
 *  1. projectAccount replay checks — pure arithmetic, no API key needed. These cover the
 *     partial-payment case (pay the past-due portion → disconnect clears, current remains).
 *  2. parseBillEmail extraction checks — require ANTHROPIC_API_KEY; skipped without it.
 */
import { parseBillEmail, type EmailForParsing } from "../amplify/functions/scan/parse";
import { projectAccount, type LedgerEvent } from "../amplify/functions/scan/ledger";

function ev(e: Partial<LedgerEvent>): LedgerEvent {
  return {
    kind: "statement",
    amount: null,
    assertedTotalDue: null,
    assertedPastDue: null,
    assertedCurrent: null,
    eventDate: null,
    dueDate: null,
    cutoffDate: null,
    isPastDue: false,
    isDisconnectWarning: false,
    isEvictionNotice: false,
    receivedAt: null,
    ...e,
  };
}

const replayCases: { name: string; events: LedgerEvent[]; expect: (s: ReturnType<typeof projectAccount>) => boolean }[] = [
  {
    name: "partial payment clears disconnect, leaves current",
    events: [
      ev({
        kind: "statement",
        assertedTotalDue: 511.27,
        assertedPastDue: 236.01,
        assertedCurrent: 275.26,
        isPastDue: true,
        isDisconnectWarning: true,
        cutoffDate: "2026-05-21",
        eventDate: "2026-05-20",
      }),
      ev({ kind: "payment", amount: 236.01, eventDate: "2026-05-25" }),
    ],
    expect: (s) =>
      s.balance === 275.26 &&
      s.pastDueAmount === 0 &&
      s.currentAmount === 275.26 &&
      !s.isPastDue &&
      !s.isDisconnectWarning &&
      s.cutoffDate === null,
  },
  {
    name: "full payment zeroes the balance",
    events: [
      ev({ kind: "statement", assertedTotalDue: 70, assertedCurrent: 70, eventDate: "2026-05-16" }),
      ev({ kind: "payment", amount: 70, eventDate: "2026-05-20" }),
    ],
    expect: (s) => s.balance === 0 && !s.isPastDue,
  },
  {
    name: "late fee adds to current",
    events: [
      ev({ kind: "statement", assertedTotalDue: 100, assertedCurrent: 100, eventDate: "2026-05-01" }),
      ev({ kind: "fee", amount: 15, eventDate: "2026-05-10" }),
    ],
    expect: (s) => s.balance === 115,
  },
];

const emailCases: { name: string; email: EmailForParsing; expect: (r: Awaited<ReturnType<typeof parseBillEmail>>) => boolean }[] = [
  {
    name: "statement with breakdown",
    email: {
      from: "service@energyunited.com",
      subject: "Past due notice",
      receivedAt: "2026-05-20T08:00:00Z",
      body: "Your account is past due in the amount of $236.01. Service is subject to disconnection if the past due amount is not paid by May 21, 2026. Account: 2803243. Past Due Amount: $236.01. Current Amount: $275.26. Total Amount Due: $511.27. Cutoff Date: May 21, 2026.",
    },
    expect: (r) =>
      r.isRelevant &&
      r.kind === "statement" &&
      r.accountNumber === "2803243" &&
      r.assertedTotalDue === 511.27 &&
      r.assertedPastDue === 236.01 &&
      r.isDisconnectWarning,
  },
  {
    name: "payment confirmation",
    email: {
      from: "service@energyunited.com",
      subject: "Payment received",
      receivedAt: "2026-05-25T15:11:00Z",
      body: "Your payment of $236.01 has been processed. Thank you. Transaction ID: 5999059. Account: 2803243. Amount: $236.01.",
    },
    expect: (r) =>
      r.isRelevant &&
      r.kind === "payment" &&
      r.amount === 236.01 &&
      r.accountNumber === "2803243" &&
      r.reference === "5999059",
  },
];

async function main() {
  let failures = 0;

  console.log("== projectAccount replay ==");
  for (const c of replayCases) {
    const result = projectAccount(c.events);
    const ok = c.expect(result);
    if (!ok) failures += 1;
    console.log(`\n[${ok ? "PASS" : "FAIL"}] ${c.name}`);
    console.log(JSON.stringify(result));
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("\n(skipping parseBillEmail checks — set ANTHROPIC_API_KEY to run them)");
  } else {
    console.log("\n== parseBillEmail extraction ==");
    for (const c of emailCases) {
      const result = await parseBillEmail(c.email);
      const ok = c.expect(result);
      if (!ok) failures += 1;
      console.log(`\n[${ok ? "PASS" : "FAIL"}] ${c.name}`);
      console.log(JSON.stringify(result, null, 2));
    }
  }

  console.log(`\n${failures === 0 ? "All" : failures + " check(s)"} ${failures === 0 ? "checks passed." : "FAILED."}`);
  process.exit(failures ? 1 : 0);
}

void main();
