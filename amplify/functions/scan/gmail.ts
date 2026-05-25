import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface FetchedEmail {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  body: string;
  /** id of the SenderQuery that matched this message (for biller attribution). */
  matchedQueryId: string;
}

export interface SenderQuery {
  /** Opaque id (the SenderFilter id) returned on matching emails. */
  id: string;
  fromAddress?: string | null;
  fromDomain?: string | null;
  subjectContains?: string | null;
}

const GMAIL_IMAP_HOST = "imap.gmail.com";
const GMAIL_IMAP_PORT = 993;

/**
 * Fetch messages from a Gmail mailbox matching any of the given sender queries,
 * received on/after `since`. Read-only — opens INBOX without marking seen.
 */
export async function fetchMatchingEmails(opts: {
  emailAddress: string;
  appPassword: string;
  queries: SenderQuery[];
  since: Date;
}): Promise<FetchedEmail[]> {
  const client = new ImapFlow({
    host: GMAIL_IMAP_HOST,
    port: GMAIL_IMAP_PORT,
    secure: true,
    auth: { user: opts.emailAddress, pass: opts.appPassword },
    logger: false,
  });

  const out: FetchedEmail[] = [];
  const seenIds = new Set<string>();

  await client.connect();
  try {
    // Read-only lock so we never alter \Seen flags.
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      for (const q of opts.queries) {
        const search: Record<string, unknown> = { since: opts.since };
        if (q.fromAddress) search.from = q.fromAddress;
        else if (q.fromDomain) search.from = q.fromDomain;
        if (q.subjectContains) search.subject = q.subjectContains;

        for await (const msg of client.fetch(search, { source: true })) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const messageId = parsed.messageId ?? `uid-${opts.emailAddress}-${msg.uid}`;
          if (seenIds.has(messageId)) continue;
          seenIds.add(messageId);

          out.push({
            messageId,
            from: parsed.from?.text ?? "",
            subject: parsed.subject ?? "",
            receivedAt: (parsed.date ?? new Date()).toISOString(),
            body: parsed.text ?? htmlToText(parsed.html || ""),
            matchedQueryId: q.id,
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return out;
}

/** Minimal HTML→text fallback for emails with no text/plain part. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
