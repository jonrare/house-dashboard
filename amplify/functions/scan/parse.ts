import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

/**
 * Static system prompt — kept frozen (no per-email data interpolated) and marked with
 * cache_control below. The volatile parts (the email and the candidate bills) go in the
 * user turn, after the breakpoint, so they never invalidate the cached prefix.
 */
const SYSTEM_PROMPT = `You extract and reconcile billing information from emails for a personal bill tracker.

You are given ONE email (sender, subject, date, body) plus a list of bills already tracked for the
same biller ("candidates", newest first, each with an index). Decide how this email relates to them
and respond by calling the record_bill tool exactly once.

Choose an action:
- "create": the email is a NEW bill, statement, payment notice, or urgent account warning (past due,
  service disconnect, or eviction) that does not correspond to any candidate. Extract its fields.
- "update": the email changes an EXISTING candidate — most often a payment confirmation that pays it
  off, but also a corrected amount, a revised due date, or a notice that escalates or clears urgency.
  Set targetIndex to that candidate's index and return the bill's RESULTING state. For a payment
  confirmation that clears the balance, that means status "paid" and isPastDue, isDisconnectWarning,
  and isEvictionNotice all false.
- "skip": the email is marketing, a receipt for an already-paid one-off purchase, or a duplicate of a
  candidate that adds no new information.

Field guidance (for create and update):
- amount: the total amount due for this statement (a number, no currency symbol).
- balance: outstanding balance if stated separately from the current amount.
- statementDate / dueDate: ISO dates (YYYY-MM-DD). Resolve relative dates using the email's date.
- status: "paid" if payment is confirmed; "pastdue" if the balance is overdue/late; otherwise "unpaid".
- isPastDue: true if the email indicates a missed or late payment.
- isDisconnectWarning: true if it threatens to disconnect/shut off/suspend service.
- isEvictionNotice: true if it threatens eviction or lease termination for non-payment.
- confidence: 0–1, how confident you are in the extracted amount and due date.

To match a candidate, compare the amount and the statement/due dates; a payment confirmation usually
states the amount paid. When unsure between create and update, choose update only if you are confident
it is the same underlying bill.`;

/** Tool schema mirrors the Bill model fields plus the reconciliation action. */
const RECORD_BILL_TOOL: Anthropic.Tool = {
  name: "record_bill",
  description:
    "Record how this email maps to the tracked bills: create a new bill, update an existing candidate, or skip.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "skip"],
        description: "How this email relates to the candidate bills.",
      },
      targetIndex: {
        type: ["integer", "null"],
        description: "Index of the candidate to update. Required when action is 'update'.",
      },
      amount: { type: ["number", "null"], description: "Total amount due." },
      currency: { type: ["string", "null"], description: "ISO currency code, e.g. USD." },
      balance: { type: ["number", "null"], description: "Outstanding balance if stated." },
      statementDate: { type: ["string", "null"], description: "Statement date (YYYY-MM-DD)." },
      dueDate: { type: ["string", "null"], description: "Payment due date (YYYY-MM-DD)." },
      status: {
        type: "string",
        enum: ["unpaid", "paid", "pastdue"],
        description: "Resulting payment status.",
      },
      isPastDue: { type: "boolean" },
      isDisconnectWarning: { type: "boolean" },
      isEvictionNotice: { type: "boolean" },
      confidence: {
        type: "number",
        description: "0–1 confidence in the extracted amount and due date.",
      },
    },
    required: [
      "action",
      "status",
      "isPastDue",
      "isDisconnectWarning",
      "isEvictionNotice",
      "confidence",
    ],
    additionalProperties: false,
  },
};

/** Compact view of an already-tracked bill, given to the model as reconciliation context. */
export interface BillCandidate {
  amount: number | null;
  currency: string | null;
  statementDate: string | null;
  dueDate: string | null;
  status: string | null;
  isPastDue: boolean;
  isDisconnectWarning: boolean;
  isEvictionNotice: boolean;
  subject: string | null;
  receivedAt: string | null;
}

export interface ParsedBill {
  action: "create" | "update" | "skip";
  /** Index into the candidates passed to parseBillEmail; only meaningful for action "update". */
  targetIndex: number | null;
  amount: number | null;
  currency: string | null;
  balance: number | null;
  statementDate: string | null;
  dueDate: string | null;
  status: "unpaid" | "paid" | "pastdue";
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

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

/**
 * Send one email (with the biller's recent bills as context) through Claude and return the
 * reconciliation decision: create a new bill, update an existing candidate, or skip.
 */
export async function parseBillEmail(
  email: EmailForParsing,
  candidates: BillCandidate[] = [],
): Promise<ParsedBill> {
  const candidateText = candidates.length
    ? `Tracked bills for this biller (candidates, newest first):\n${JSON.stringify(
        candidates.map((c, index) => ({ index, ...c })),
        null,
        2,
      )}`
    : "Tracked bills for this biller: none.";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ],
    tools: [RECORD_BILL_TOOL],
    tool_choice: { type: "tool", name: "record_bill" },
    messages: [
      {
        role: "user",
        content:
          `From: ${email.from}\n` +
          `Subject: ${email.subject}\n` +
          `Received: ${email.receivedAt}\n\n` +
          `${candidateText}\n\n` +
          `--- Email body ---\n` +
          email.body.slice(0, 24000),
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Claude did not return a record_bill tool call");
  }

  const input = toolUse.input as Partial<ParsedBill>;
  return {
    action: input.action ?? "skip",
    targetIndex: input.targetIndex ?? null,
    amount: input.amount ?? null,
    currency: input.currency ?? "USD",
    balance: input.balance ?? null,
    statementDate: input.statementDate ?? null,
    dueDate: input.dueDate ?? null,
    status: input.status ?? "unpaid",
    isPastDue: input.isPastDue ?? false,
    isDisconnectWarning: input.isDisconnectWarning ?? false,
    isEvictionNotice: input.isEvictionNotice ?? false,
    confidence: input.confidence ?? 0,
  };
}
