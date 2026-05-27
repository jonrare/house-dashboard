/**
 * Deterministic projection of an account's ledger into its current state.
 *
 * An Account is never edited directly — it is recomputed by replaying its LedgerEntries
 * in chronological order. Statements/notices assert a snapshot of what is owed; payments
 * (and adjustments) draw the balance down, oldest debt first; fees add to it. Once the
 * overdue portion reaches zero, the urgency tied to it (disconnect / eviction) resolves.
 *
 * Keeping the arithmetic here — not in the LLM — makes balances reproducible and testable.
 */

export interface LedgerEvent {
  kind: "statement" | "payment" | "fee" | "adjustment";
  amount: number | null;
  assertedTotalDue: number | null;
  assertedPastDue: number | null;
  assertedCurrent: number | null;
  eventDate: string | null; // YYYY-MM-DD
  dueDate: string | null;
  cutoffDate: string | null;
  isPastDue: boolean;
  isDisconnectWarning: boolean;
  isEvictionNotice: boolean;
  receivedAt: string | null; // ISO datetime, used as a tie-breaker
}

export interface AccountState {
  currentAmount: number;
  pastDueAmount: number;
  balance: number;
  dueDate: string | null;
  cutoffDate: string | null;
  isPastDue: boolean;
  isDisconnectWarning: boolean;
  isEvictionNotice: boolean;
  lastEventAt: string | null;
}

const EPS = 0.005; // treat sub-cent balances as zero
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Replay events (in any order) and return the resulting account state. */
export function projectAccount(events: LedgerEvent[]): AccountState {
  const sorted = [...events].sort((a, b) => {
    const da = a.eventDate ?? a.receivedAt ?? "";
    const db = b.eventDate ?? b.receivedAt ?? "";
    if (da !== db) return da < db ? -1 : 1;
    return (a.receivedAt ?? "").localeCompare(b.receivedAt ?? "");
  });

  let pastDue = 0;
  let current = 0;
  let dueDate: string | null = null;
  let cutoffDate: string | null = null;
  let disconnect = false;
  let eviction = false;
  let lastEventAt: string | null = null;

  for (const e of sorted) {
    lastEventAt = e.receivedAt ?? e.eventDate ?? lastEventAt;

    if (e.kind === "statement") {
      // A statement/notice is a snapshot of what is owed at that moment.
      if (e.assertedPastDue != null) pastDue = e.assertedPastDue;
      if (e.assertedCurrent != null) {
        current = e.assertedCurrent;
      } else if (e.assertedTotalDue != null) {
        // The stated total includes the past-due portion; the rest is current charges.
        current = Math.max(0, e.assertedTotalDue - pastDue);
      }
      if (e.dueDate) dueDate = e.dueDate;
      if (e.cutoffDate) cutoffDate = e.cutoffDate;
      disconnect = e.isDisconnectWarning;
      eviction = e.isEvictionNotice;
    } else if (e.kind === "fee") {
      current = round2(current + (e.amount ?? 0));
    } else {
      // payment or adjustment: pay down the past-due portion first, then current charges.
      let pay = e.amount ?? 0;
      const toPastDue = Math.min(pay, pastDue);
      pastDue = round2(pastDue - toPastDue);
      pay = pay - toPastDue;
      current = round2(Math.max(0, current - pay));
    }

    // Once the overdue portion is cleared, the urgency tied to it is resolved.
    if (pastDue <= EPS) {
      pastDue = 0;
      disconnect = false;
      eviction = false;
      cutoffDate = null;
    }
  }

  const isPastDue = pastDue > EPS;
  return {
    currentAmount: round2(current),
    pastDueAmount: round2(pastDue),
    balance: round2(current + pastDue),
    dueDate,
    cutoffDate,
    isPastDue,
    isDisconnectWarning: disconnect && isPastDue,
    isEvictionNotice: eviction && isPastDue,
    lastEventAt,
  };
}
