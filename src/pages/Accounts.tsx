import { Fragment, useEffect, useMemo, useState } from "react";
import {
  client,
  deleteAccountCascade,
  type Account,
  type Biller,
  type LedgerEntry,
} from "../client";
import { projectAccount, type LedgerEvent } from "../../amplify/functions/scan/ledger";

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [billerList, setBillerList] = useState<Biller[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live updates: accounts/entries written by a background scan appear automatically.
  useEffect(() => {
    const subs = [
      client.models.Account.observeQuery().subscribe({
        next: ({ items }) => setAccounts([...items]),
        error: (e) => setError(String(e)),
      }),
      client.models.LedgerEntry.observeQuery().subscribe({
        next: ({ items }) => setEntries([...items]),
        error: (e) => setError(String(e)),
      }),
      client.models.Biller.observeQuery().subscribe({
        next: ({ items }) => setBillerList([...items]),
        error: (e) => setError(String(e)),
      }),
    ];
    return () => subs.forEach((s) => s.unsubscribe());
  }, []);

  const billers = useMemo(
    () => Object.fromEntries(billerList.map((b) => [b.id, b])),
    [billerList],
  );
  const entriesByAccount = useMemo(() => {
    const map = new Map<string, LedgerEntry[]>();
    for (const e of entries) {
      const list = map.get(e.accountId) ?? [];
      list.push(e);
      map.set(e.accountId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => byEventDate(b).localeCompare(byEventDate(a))); // newest first
    }
    return map;
  }, [entries]);

  async function removeAccount(id: string) {
    if (!confirm("Delete this account and all of its ledger entries? A future scan can re-import them.")) return;
    try {
      await deleteAccountCascade(id);
    } catch (e) {
      setError(String(e));
    }
  }

  // Delete one ledger entry and recompute the account's balance from what's left,
  // reusing the same projection the scan uses so the math always matches.
  async function removeEntry(account: Account, entry: LedgerEntry) {
    if (!confirm("Delete this ledger entry and recompute the balance?")) return;
    try {
      const del = await client.models.LedgerEntry.delete({ id: entry.id });
      if (del.errors?.length) { setError(del.errors.map((x) => x.message).join("; ")); return; }

      const remaining = (entriesByAccount.get(account.id) ?? []).filter((e) => e.id !== entry.id);
      const s = projectAccount(remaining.map(toEvent));
      const upd = await client.models.Account.update({
        id: account.id,
        currentAmount: s.currentAmount,
        pastDueAmount: s.pastDueAmount,
        balance: s.balance,
        dueDate: s.dueDate ?? null,
        cutoffDate: s.cutoffDate ?? null,
        isPastDue: s.isPastDue,
        isDisconnectWarning: s.isDisconnectWarning,
        isEvictionNotice: s.isEvictionNotice,
        lastEventAt: s.lastEventAt ?? null,
      });
      if (upd.errors?.length) setError(upd.errors.map((x) => x.message).join("; "));
    } catch (e) {
      setError(String(e));
    }
  }

  const sorted = [...accounts].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));

  return (
    <div>
      <div className="page-head">
        <h2>Accounts</h2>
        <span className="muted">Live — balances are computed from each account's ledger.</span>
      </div>

      {error && <p className="error-box">{error}</p>}

      <table className="grid">
        <thead>
          <tr>
            <th>Biller</th>
            <th>Account</th>
            <th>Balance</th>
            <th>Current</th>
            <th>Past due</th>
            <th>Due</th>
            <th>Flags</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => {
            const accountEntries = entriesByAccount.get(a.id) ?? [];
            return (
              <Fragment key={a.id}>
                <tr className={a.isPastDue ? "row-warn" : undefined}>
                  <td>{billers[a.billerId]?.name ?? "—"}</td>
                  <td>{a.accountNumber || "—"}{a.label ? ` · ${a.label}` : ""}</td>
                  <td>{fmtMoney(a.balance ?? 0)}</td>
                  <td>{fmtMoney(a.currentAmount ?? 0)}</td>
                  <td>{(a.pastDueAmount ?? 0) > 0.005 ? fmtMoney(a.pastDueAmount ?? 0) : "—"}</td>
                  <td>{a.dueDate ?? "—"}</td>
                  <td>{flagText(a)}</td>
                  <td className="actions">
                    <button className="link" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
                      {openId === a.id ? "hide" : `ledger (${accountEntries.length})`}
                    </button>
                    <button className="danger" onClick={() => removeAccount(a.id)}>Delete</button>
                  </td>
                </tr>

                {openId === a.id && (
                  <tr>
                    <td colSpan={8} className="source">
                      <table className="grid">
                        <thead>
                          <tr>
                            <th>Date</th>
                            <th>Kind</th>
                            <th>Amount</th>
                            <th>Asserted total</th>
                            <th>Email</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {accountEntries.map((e) => (
                            <tr key={e.id}>
                              <td>{byEventDate(e).slice(0, 10) || "—"}</td>
                              <td>{e.kind}</td>
                              <td>{e.amount != null ? fmtMoney(e.amount) : "—"}</td>
                              <td>{e.assertedTotalDue != null ? fmtMoney(e.assertedTotalDue) : "—"}</td>
                              <td>
                                {e.subject ?? "—"}
                                {e.messageId && (
                                  <>
                                    {" "}
                                    <a
                                      href={`https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(e.messageId)}`}
                                      target="_blank"
                                      rel="noreferrer"
                                    >↗</a>
                                  </>
                                )}
                              </td>
                              <td className="actions">
                                <button className="link" onClick={() => removeEntry(a, e)}>remove</button>
                              </td>
                            </tr>
                          ))}
                          {accountEntries.length === 0 && (
                            <tr><td colSpan={6}>No ledger entries.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {sorted.length === 0 && (
            <tr><td colSpan={8}>No accounts yet. Add a biller and run a scan.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function byEventDate(e: LedgerEntry): string {
  return e.eventDate ?? e.receivedAt ?? "";
}

function toEvent(e: LedgerEntry): LedgerEvent {
  return {
    kind: (e.kind ?? "statement") as LedgerEvent["kind"],
    amount: e.amount ?? null,
    assertedTotalDue: e.assertedTotalDue ?? null,
    assertedPastDue: e.assertedPastDue ?? null,
    assertedCurrent: e.assertedCurrent ?? null,
    eventDate: e.eventDate ?? null,
    dueDate: e.dueDate ?? null,
    cutoffDate: e.cutoffDate ?? null,
    isPastDue: !!e.isPastDue,
    isDisconnectWarning: !!e.isDisconnectWarning,
    isEvictionNotice: !!e.isEvictionNotice,
    receivedAt: e.receivedAt ?? null,
  };
}

function flagText(a: Account): string {
  const f: string[] = [];
  if (a.isEvictionNotice) f.push("eviction");
  if (a.isDisconnectWarning) f.push("disconnect");
  if (a.isPastDue) f.push("past due");
  return f.join(", ") || "—";
}

function fmtMoney(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
