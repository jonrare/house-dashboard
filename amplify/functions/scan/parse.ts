import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

/**
 * Static system prompt — kept frozen (no per-email data interpolated) and marked with
 * cache_control below. The volatile email content goes in the user turn, after the
 * breakpoint, so it never invalidates the cached prefix.
 *
 * The model only EXTRACTS facts. It does not compute balances — the scan handler replays
 * events deterministically (see ledger.ts), so the prompt must not do arithmetic.
 */
const SYSTEM_PROMPT = `You extract billing facts from a single email for a personal bill tracker.

Each email is one event for a billing account. Read it and call the record_event tool exactly once.

Classify the email with "kind":
- "statement": a bill, statement, or past-due/disconnect/eviction notice that asserts an amount owed.
  Capture the amounts it states (see below).
- "payment": a confirmation that a payment was made. Put the amount paid in "amount".
- "fee": a standalone charge added to the account (e.g. a late fee) with no full statement.
  Put the fee in "amount".
- "adjustment": a credit or miscellaneous correction. Put its magnitude in "amount".
If the email is marketing, a receipt for an unrelated one-off purchase, or otherwise not about this
account's balance, set isRelevant to false and leave the rest null/false.

Amounts are plain numbers (no currency symbols). For a "statement", capture whatever the email states:
- assertedTotalDue: the total amount due / balance.
- assertedPastDue: the past-due / overdue portion, if itemized separately.
- assertedCurrent: the current-period charges, if itemized separately.
Capture only what the email actually states; leave the others null. Do NOT compute or infer values.

Other fields:
- reference: for a payment, the transaction / confirmation / authorization id if present
  (e.g. "Transaction ID: 5999059" → "5999059"); else null. This is used to recognize the
  same payment reported more than once.
- accountNumber: the provider account number if present (e.g. "2803243"); else null.
- eventDate: ISO date (YYYY-MM-DD) the event happened — the payment date, or the statement date.
  Resolve relative dates using the email's received date.
- dueDate: payment due date (YYYY-MM-DD), if stated.
- cutoffDate: service disconnection / shut-off date (YYYY-MM-DD), if threatened.
- isPastDue: the email indicates a missed or late payment.
- isDisconnectWarning: it threatens to disconnect/shut off/suspend service.
- isEvictionNotice: it threatens eviction or lease termination for non-payment.
- label: a short human label for the account if obvious (e.g. service type or address); else null.
- confidence: 0–1 in the amounts you extracted.`;

/** Tool schema mirrors a LedgerEntry's extractable fields. */
const RECORD_EVENT_TOOL: Anthropic.Tool = {
  name: "record_event",
  description: "Record the billing facts extracted from this email.",
  input_schema: {
    type: "object",
    properties: {
      isRelevant: {
        type: "boolean",
        description: "True if this email is about a billing account (a statement, payment, or fee).",
      },
      kind: {
        type: ["string", "null"],
        enum: ["statement", "payment", "fee", "adjustment", null],
        description: "The kind of billing event this email represents.",
      },
      accountNumber: { type: ["string", "null"], description: "Provider account number, if present." },
      label: { type: ["string", "null"], description: "Short human label for the account, if obvious." },
      amount: {
        type: ["number", "null"],
        description: "Payment / fee / adjustment amount (for kind payment, fee, or adjustment).",
      },
      reference: {
        type: ["string", "null"],
        description: "Payment transaction / confirmation / authorization id, if present.",
      },
      assertedTotalDue: { type: ["number", "null"], description: "Total amount due stated (statement)." },
      assertedPastDue: { type: ["number", "null"], description: "Past-due portion stated (statement)." },
      assertedCurrent: { type: ["number", "null"], description: "Current charges stated (statement)." },
      eventDate: { type: ["string", "null"], description: "Date the event happened (YYYY-MM-DD)." },
      dueDate: { type: ["string", "null"], description: "Payment due date (YYYY-MM-DD)." },
      cutoffDate: { type: ["string", "null"], description: "Disconnection/shut-off date (YYYY-MM-DD)." },
      isPastDue: { type: "boolean" },
      isDisconnectWarning: { type: "boolean" },
      isEvictionNotice: { type: "boolean" },
      confidence: { type: "number", description: "0–1 confidence in the extracted amounts." },
    },
    required: [
      "isRelevant",
      "isPastDue",
      "isDisconnectWarning",
      "isEvictionNotice",
      "confidence",
    ],
    additionalProperties: false,
  },
};

export interface ParsedEvent {
  isRelevant: boolean;
  kind: "statement" | "payment" | "fee" | "adjustment";
  accountNumber: string | null;
  label: string | null;
  amount: number | null;
  reference: string | null;
  assertedTotalDue: number | null;
  assertedPastDue: number | null;
  assertedCurrent: number | null;
  eventDate: string | null;
  dueDate: string | null;
  cutoffDate: string | null;
  isPastDue: boolean;
  isDisconnectWarning: boolean;
  isEvictionNotice: boolean;
  confidence: number;
}

export interface EmailForParsing {
  from: string;
  subject: string;
  receivedAt: string;
  body: string;
}

// Lazily constructed so importing this module (e.g. for ledger replay tests) doesn't
// require ANTHROPIC_API_KEY to be set.
let anthropic: Anthropic | null = null;
const client = (): Anthropic => (anthropic ??= new Anthropic());

/** Send one email through Claude and return the extracted billing event. */
export async function parseBillEmail(email: EmailForParsing): Promise<ParsedEvent> {
  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    tools: [RECORD_EVENT_TOOL],
    tool_choice: { type: "tool", name: "record_event" },
    messages: [
      {
        role: "user",
        content:
          `From: ${email.from}\n` +
          `Subject: ${email.subject}\n` +
          `Received: ${email.receivedAt}\n\n` +
          email.body.slice(0, 24000),
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Claude did not return a record_event tool call");
  }

  const input = toolUse.input as Partial<ParsedEvent>;
  return {
    isRelevant: input.isRelevant ?? false,
    kind: input.kind ?? "statement",
    accountNumber: input.accountNumber ?? null,
    label: input.label ?? null,
    amount: input.amount ?? null,
    reference: input.reference ?? null,
    assertedTotalDue: input.assertedTotalDue ?? null,
    assertedPastDue: input.assertedPastDue ?? null,
    assertedCurrent: input.assertedCurrent ?? null,
    eventDate: input.eventDate ?? null,
    dueDate: input.dueDate ?? null,
    cutoffDate: input.cutoffDate ?? null,
    isPastDue: input.isPastDue ?? false,
    isDisconnectWarning: input.isDisconnectWarning ?? false,
    isEvictionNotice: input.isEvictionNotice ?? false,
    confidence: input.confidence ?? 0,
  };
}
