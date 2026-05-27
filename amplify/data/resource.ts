import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { scan } from "../functions/scan/resource";

/**
 * Data model for the bill tracker. Single Cognito user, so every model is
 * authorized with `allow.authenticated()`.
 *
 * Flow: Biller + SenderFilter are user-managed config. The `scan` function reads
 * them, pulls matching messages from the one configured Gmail mailbox (GMAIL_ADDRESS
 * env var + GMAIL_APP_PASSWORD secret), and parses each into a LedgerEntry. An Account
 * is a *projection* of its ledger: the scan replays a biller/account's entries in date
 * order to recompute its balance and flags. ScanState holds the incremental cursor.
 * See amplify/functions/scan.
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

    // The kind of event an email represents in the ledger.
    //  statement  = a bill/statement/notice that asserts an amount owed (a snapshot)
    //  payment    = a confirmed payment that draws the balance down
    //  fee        = a standalone charge added to the balance (late fee, etc.)
    //  adjustment = a manual or miscellaneous correction (credit/charge)
    LedgerKind: a.enum(["statement", "payment", "fee", "adjustment"]),

    ScanMode: a.enum(["scheduled", "manual", "backfill"]),

    /** A biller the user wants to track (power, rent, internet, ...). */
    Biller: a
      .model({
        name: a.string().required(),
        category: a.ref("BillerCategory").required(),
        notes: a.string(),
        senderFilters: a.hasMany("SenderFilter", "billerId"),
        accounts: a.hasMany("Account", "billerId"),
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

    /**
     * A billing account with a running balance. There is one Account per Biller — the
     * account number is only a display detail (providers state it inconsistently, e.g.
     * masked as "**1344" or omitted), never an identity key. Every field below `label`
     * is *derived* by replaying this account's ledger entries (see
     * amplify/functions/scan/ledger.ts) — never edited directly by hand.
     */
    Account: a
      .model({
        billerId: a.id().required(),
        biller: a.belongsTo("Biller", "billerId"),
        accountNumber: a.string(), // best-known provider account number, for display only
        label: a.string(), // e.g. service location / type, for display
        currentAmount: a.float().default(0), // current-period charges outstanding
        pastDueAmount: a.float().default(0), // overdue portion outstanding
        balance: a.float().default(0), // currentAmount + pastDueAmount
        dueDate: a.date(),
        cutoffDate: a.date(), // service disconnection date, if threatened
        isPastDue: a.boolean().default(false),
        isDisconnectWarning: a.boolean().default(false),
        isEvictionNotice: a.boolean().default(false),
        lastEventAt: a.datetime(),
        entries: a.hasMany("LedgerEntry", "accountId"),
      })
      .authorization((allow) => [allow.authenticated()]),

    /** One parsed email event. `messageId` is the Gmail Message-ID, the dedupe key. */
    LedgerEntry: a
      .model({
        accountId: a.id().required(),
        account: a.belongsTo("Account", "accountId"),
        billerId: a.id().required(),
        messageId: a.string().required(),
        kind: a.ref("LedgerKind").required(),
        // Magnitude of the event: payment/fee/adjustment amount.
        amount: a.float(),
        // Provider transaction/confirmation id, used to dedupe duplicate payment notices.
        reference: a.string(),
        // Snapshot values a statement/notice asserts, used to recompute the balance.
        assertedTotalDue: a.float(),
        assertedPastDue: a.float(),
        assertedCurrent: a.float(),
        eventDate: a.date(), // payment date / statement date (falls back to receivedAt)
        dueDate: a.date(),
        cutoffDate: a.date(),
        isPastDue: a.boolean().default(false),
        isDisconnectWarning: a.boolean().default(false),
        isEvictionNotice: a.boolean().default(false),
        confidence: a.float(),
        subject: a.string(),
        sourceSnippet: a.string(),
        receivedAt: a.datetime(),
      })
      .secondaryIndexes((index) => [index("messageId")])
      .authorization((allow) => [allow.authenticated()]),

    /** Append-only log of scan runs for observability. */
    ScanRun: a
      .model({
        mode: a.ref("ScanMode").required(),
        startedAt: a.datetime(),
        finishedAt: a.datetime(),
        messagesScanned: a.integer().default(0),
        entriesRecorded: a.integer().default(0),
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
