import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

/**
 * Static system prompt — kept frozen (no dates/IDs interpolated) and marked with
 * cache_control below. Note: this prompt is currently shorter than the model's
 * minimum cacheable prefix (~2048 tokens for Sonnet), so caching is a harmless
 * no-op today; it starts paying off automatically if the prompt grows. Per-email
 * content goes in the user turn, after the breakpoint, so it never invalidates it.
 */
const SYSTEM_PROMPT = `You extract billing information from emails for a personal bill tracker.

You will be given one email (sender, subject, date, body). Decide whether it is a
bill, statement, payment notice, or service/utility communication that contains an
amount due or a due date — or an urgent account warning (past due, service
disconnect, or eviction). If it is, extract the fields. If the email is marketing,
a receipt for an already-paid one-off purchase, or otherwise not a recurring bill or
account warning, set isBill to false and leave other fields null.

Guidance:
- amount: the total amount due for this statement (a number, no currency symbol).
- balance: outstanding balance if stated separately from the current amount.
- statementDate / dueDate: ISO dates (YYYY-MM-DD). Resolve relative dates using the
  email's received date.
- status: "pastdue" if the email says the balance is overdue/late; "paid" if it
  confirms payment; otherwise "unpaid".
- isPastDue: true if the email indicates a missed or late payment.
- isDisconnectWarning: true if it threatens to disconnect/shut off/suspend service.
- isEvictionNotice: true if it threatens eviction or lease termination for non-payment.
- confidence: 0–1, how confident you are in the extracted amount and due date.

Always respond by calling the record_bill tool exactly once. Do not include any other text.`;

/** Tool schema mirrors the Bill model fields so the result maps straight in. */
const RECORD_BILL_TOOL: Anthropic.Tool = {
  name: "record_bill",
  description:
    "Record the structured billing information extracted from the email.",
  input_schema: {
    type: "object",
    properties: {
      isBill: {
        type: "boolean",
        description:
          "True if this email contains a bill, statement, amount due, due date, or an urgent account warning.",
      },
      amount: { type: ["number", "null"], description: "Total amount due." },
      currency: { type: ["string", "null"], description: "ISO currency code, e.g. USD." },
      balance: { type: ["number", "null"], description: "Outstanding balance if stated." },
      statementDate: { type: ["string", "null"], description: "Statement date (YYYY-MM-DD)." },
      dueDate: { type: ["string", "null"], description: "Payment due date (YYYY-MM-DD)." },
      status: {
        type: "string",
        enum: ["unpaid", "paid", "pastdue"],
        description: "Payment status implied by the email.",
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
      "isBill",
      "status",
      "isPastDue",
      "isDisconnectWarning",
      "isEvictionNotice",
      "confidence",
    ],
    additionalProperties: false,
  },
};

export interface ParsedBill {
  isBill: boolean;
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

/** Send one email through Claude and return the structured bill (or isBill:false). */
export async function parseBillEmail(email: EmailForParsing): Promise<ParsedBill> {
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
    isBill: input.isBill ?? false,
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
