/**
 * Manual verification for the Claude extraction step. Requires ANTHROPIC_API_KEY.
 *
 *   npx tsx scripts/test-parse.ts
 *
 * Feeds representative emails (normal statement, past-due notice, disconnect warning,
 * and a payment that resolves an existing disconnect) through parseBillEmail and prints
 * the structured result + asserts the action and urgency flags are correct.
 */
import {
  parseBillEmail,
  type BillCandidate,
  type EmailForParsing,
} from "../amplify/functions/scan/parse";

const samples: {
  name: string;
  email: EmailForParsing;
  candidates?: BillCandidate[];
  expect: (r: Awaited<ReturnType<typeof parseBillEmail>>) => boolean;
}[] = [
  {
    name: "normal statement",
    email: {
      from: "billing@citypower.com",
      subject: "Your March statement is ready",
      receivedAt: "2026-03-02T08:00:00Z",
      body: "Your statement is ready. Amount due: $142.37. Due date: March 28, 2026. Thank you for being a customer.",
    },
    expect: (r) => r.action === "create" && r.amount === 142.37 && !r.isPastDue && !r.isDisconnectWarning,
  },
  {
    name: "past-due notice",
    email: {
      from: "billing@citywater.com",
      subject: "Past due notice",
      receivedAt: "2026-04-15T08:00:00Z",
      body: "Your account is past due. A balance of $88.10 was due on April 1 and remains unpaid. Please pay immediately to avoid late fees.",
    },
    expect: (r) => r.action === "create" && r.isPastDue,
  },
  {
    name: "disconnect warning",
    email: {
      from: "service@citygas.com",
      subject: "FINAL NOTICE: service disconnection scheduled",
      receivedAt: "2026-05-10T08:00:00Z",
      body: "This is a final notice. Your gas service will be DISCONNECTED on May 20 unless the overdue balance of $213.00 is paid in full.",
    },
    expect: (r) => r.action === "create" && r.isDisconnectWarning && r.isPastDue,
  },
  {
    name: "payment resolves disconnect",
    email: {
      from: "service@citygas.com",
      subject: "Payment received",
      receivedAt: "2026-05-12T08:00:00Z",
      body: "Your payment of $213.00 has been processed. Thank you.",
    },
    candidates: [
      {
        amount: 213.0,
        currency: "USD",
        statementDate: null,
        dueDate: "2026-05-20",
        status: "pastdue",
        isPastDue: true,
        isDisconnectWarning: true,
        isEvictionNotice: false,
        subject: "FINAL NOTICE: service disconnection scheduled",
        receivedAt: "2026-05-10T08:00:00Z",
      },
    ],
    expect: (r) =>
      r.action === "update" &&
      r.targetIndex === 0 &&
      r.status === "paid" &&
      !r.isDisconnectWarning &&
      !r.isPastDue,
  },
];

async function main() {
  let failures = 0;
  for (const s of samples) {
    const result = await parseBillEmail(s.email, s.candidates ?? []);
    const ok = s.expect(result);
    if (!ok) failures += 1;
    console.log(`\n[${ok ? "PASS" : "FAIL"}] ${s.name}`);
    console.log(JSON.stringify(result, null, 2));
  }
  console.log(`\n${samples.length - failures}/${samples.length} checks passed.`);
  process.exit(failures ? 1 : 0);
}

void main();
