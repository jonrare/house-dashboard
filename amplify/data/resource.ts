import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { scan } from "../functions/scan/resource";

/**
 * Data model for the bill tracker. Single Cognito user, so every model is
 * authorized with `allow.authenticated()`.
 *
 * Flow: Biller + SenderFilter are user-managed config. The `scan` function reads
 * them, pulls matching messages from the one configured Gmail mailbox (GMAIL_ADDRESS
 * env var + GMAIL_APP_PASSWORD secret), parses each with Claude, and writes Bill
 * (+ Alert) records. ScanState holds the incremental cursor. See amplify/functions/scan.
 */
const schema = a
  .schema({
    BillerCategory: a.enum([
      "power",
      "gas",
      "water",
      "internet",
      "rent",
      "mortgage",
      "service",
      "utility",
      "other",
    ]),

    // "dismissed" = a parsed record the user marked as not-a-bill / false positive.
    BillStatus: a.enum(["unpaid", "paid", "pastdue", "dismissed"]),

    AlertType: a.enum(["disconnect", "eviction", "pastdue", "other"]),

    ScanMode: a.enum(["scheduled", "manual", "backfill"]),

    /** A biller the user wants to track (power, rent, internet, ...). */
    Biller: a
      .model({
        name: a.string().required(),
        category: a.ref("BillerCategory").required(),
        notes: a.string(),
        senderFilters: a.hasMany("SenderFilter", "billerId"),
        bills: a.hasMany("Bill", "billerId"),
      })
      .authorization((allow) => [allow.authenticated()]),

    /** Which sender maps to a Biller (matched against the one configured mailbox). */
    SenderFilter: a
      .model({
        billerId: a.id().required(),
        biller: a.belongsTo("Biller", "billerId"),
        fromAddress: a.string(),
        fromDomain: a.string(),
        subjectContains: a.string(),
      })
      .authorization((allow) => [allow.authenticated()]),

    /** A parsed bill. `messageId` is the Gmail Message-ID, the dedupe key. */
    Bill: a
      .model({
        billerId: a.id().required(),
        biller: a.belongsTo("Biller", "billerId"),
        messageId: a.string().required(),
        amount: a.float(),
        currency: a.string().default("USD"),
        balance: a.float(),
        statementDate: a.date(),
        dueDate: a.date(),
        status: a.ref("BillStatus"),
        isPastDue: a.boolean().default(false),
        isDisconnectWarning: a.boolean().default(false),
        isEvictionNotice: a.boolean().default(false),
        confidence: a.float(),
        sourceSnippet: a.string(),
        subject: a.string(),
        receivedAt: a.datetime(),
        alerts: a.hasMany("Alert", "billId"),
      })
      .secondaryIndexes((index) => [index("messageId")])
      .authorization((allow) => [allow.authenticated()]),

    /** A derived urgent item, so the dashboard can query "urgent" cheaply. */
    Alert: a
      .model({
        billId: a.id().required(),
        bill: a.belongsTo("Bill", "billId"),
        type: a.ref("AlertType").required(),
        severity: a.integer().default(1),
        excerpt: a.string(),
        detectedAt: a.datetime(),
        acknowledged: a.boolean().default(false),
      })
      .authorization((allow) => [allow.authenticated()]),

    /** Append-only log of scan runs for observability. */
    ScanRun: a
      .model({
        mode: a.ref("ScanMode").required(),
        startedAt: a.datetime(),
        finishedAt: a.datetime(),
        messagesScanned: a.integer().default(0),
        billsCreated: a.integer().default(0),
        errors: a.string(),
      })
      .authorization((allow) => [allow.authenticated()]),

    /**
     * Singleton holding the incremental-scan cursor. The scan function reads/writes
     * one row with a fixed id ("global"); `lastScanAt` is where the next scan resumes.
     */
    ScanState: a
      .model({
        lastScanAt: a.datetime(),
      })
      .authorization((allow) => [allow.authenticated()]),

    /** Run a scan now over the configured mailbox. Resolved by the `scan` function. */
    triggerScan: a
      .mutation()
      .returns(a.json())
      .handler(a.handler.function(scan))
      .authorization((allow) => [allow.authenticated()]),

    /** Backfill the last `sinceDays` (default 365) for a biller's senders. */
    backfillBiller: a
      .mutation()
      .arguments({ billerId: a.string().required(), sinceDays: a.integer() })
      .returns(a.json())
      .handler(a.handler.function(scan))
      .authorization((allow) => [allow.authenticated()]),
  })
  .authorization((allow) => [allow.resource(scan)]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
