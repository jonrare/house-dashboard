import { useEffect, useMemo, useState } from "react";
import { client, type Account, type Biller } from "../client";

export default function Dashboard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [billerList, setBillerList] = useState<Biller[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Live updates: balances recomputed by a background scan appear automatically.
  useEffect(() => {
    const subs = [
      client.models.Account.observeQuery().subscribe({
        next: ({ items }) => { setAccounts([...items]); setLoading(false); },
        error: (e) => { setError(String(e)); setLoading(false); },
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

  if (loading) return <p>Loading…</p>;

  const owed = accounts.filter((a) => (a.balance ?? 0) > 0.005);
  const pastDue = owed.filter((a) => a.isPastDue);
  const urgent = accounts.filter((a) => a.isDisconnectWarning || a.isEvictionNotice);
  const totalDue = owed.reduce((sum, a) => sum + (a.balance ?? 0), 0);

  const sorted = [...owed].sort((a, b) =>
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"),
  );

  return (
    <div>
      <div className="page-head">
        <h2>Dashboard</h2>
        <span className="muted">Live — updates as scans complete.</span>
      </div>

      {error && <p className="error-box">{error}</p>}

      <div className="cards">
        <Card label="Accounts owing" value={String(owed.length)} />
        <Card label="Total due" value={fmtMoney(totalDue)} />
        <Card label="Past due" value={String(pastDue.length)} tone={pastDue.length ? "warn" : undefined} />
        <Card label="Urgent" value={String(urgent.length)} tone={urgent.length ? "danger" : undefined} />
      </div>

      {urgent.length > 0 && (
        <section className="alert-banner">
          <h3>⚠ Urgent</h3>
          <ul>
            {urgent.map((a) => (
              <li key={a.id}>
                <strong>{a.isEvictionNotice ? "Eviction notice" : "Disconnect warning"}</strong>
                {" — "}
                {billers[a.billerId]?.name ?? "—"}
                {a.accountNumber ? ` (${a.accountNumber})` : ""}: {fmtMoney(a.pastDueAmount ?? 0)} past due
                {a.cutoffDate ? `, by ${a.cutoffDate}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}

      <h3>Open balances</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Biller</th>
            <th>Account</th>
            <th>Balance</th>
            <th>Past due</th>
            <th>Due</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id} className={a.isPastDue ? "row-warn" : undefined}>
              <td>{billers[a.billerId]?.name ?? "—"}</td>
              <td>{a.accountNumber || "—"}{a.label ? ` · ${a.label}` : ""}</td>
              <td>{fmtMoney(a.balance ?? 0)}</td>
              <td>{(a.pastDueAmount ?? 0) > 0.005 ? fmtMoney(a.pastDueAmount ?? 0) : "—"}</td>
              <td>{a.dueDate ?? "—"}</td>
              <td>{flagText(a)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6}>No open balances. Add a biller and run a scan.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Card({ label, value, tone }: { label: string; value: string; tone?: "warn" | "danger" }) {
  return (
    <div className={`card ${tone ?? ""}`}>
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
    </div>
  );
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
