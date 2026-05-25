import { useEffect, useMemo, useState } from "react";
import { client, type Bill, type Alert, type Biller } from "../client";

export default function Dashboard() {
  const [allBills, setAllBills] = useState<Bill[]>([]);
  const [allAlerts, setAllAlerts] = useState<Alert[]>([]);
  const [billerList, setBillerList] = useState<Biller[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Live updates: scanned bills/alerts appear automatically.
  useEffect(() => {
    const subs = [
      client.models.Bill.observeQuery().subscribe({
        next: ({ items }) => { setAllBills([...items]); setLoading(false); },
        error: (e) => { setError(String(e)); setLoading(false); },
      }),
      client.models.Alert.observeQuery().subscribe({
        next: ({ items }) => setAllAlerts([...items]),
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

  // Open = not paid and not dismissed. Urgent = unacknowledged alerts.
  const bills = allBills.filter((b) => b.status !== "paid" && b.status !== "dismissed");
  const alerts = allAlerts.filter((a) => !a.acknowledged);

  async function acknowledge(id: string) {
    const res = await client.models.Alert.update({ id, acknowledged: true });
    if (res.errors?.length) setError(res.errors.map((e) => e.message).join("; "));
  }

  if (loading) return <p>Loading…</p>;

  const pastDue = bills.filter((b) => b.isPastDue);
  const sorted = [...bills].sort((a, b) =>
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
        <Card label="Open bills" value={String(bills.length)} />
        <Card label="Total due (by currency)" value={totalsByCurrency(bills)} />
        <Card label="Past due" value={String(pastDue.length)} tone={pastDue.length ? "warn" : undefined} />
        <Card label="Urgent alerts" value={String(alerts.length)} tone={alerts.length ? "danger" : undefined} />
      </div>

      {alerts.length > 0 && (
        <section className="alert-banner">
          <h3>⚠ Urgent</h3>
          <ul>
            {[...alerts]
              .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
              .map((a) => (
                <li key={a.id}>
                  <strong>{alertLabel(a.type)}</strong> — {a.excerpt}
                  <button className="link" onClick={() => acknowledge(a.id)}>dismiss</button>
                </li>
              ))}
          </ul>
        </section>
      )}

      <h3>Open bills</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Biller</th>
            <th>Amount</th>
            <th>Due</th>
            <th>Status</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((b) => (
            <tr key={b.id} className={b.isPastDue ? "row-warn" : undefined}>
              <td>{billers[b.billerId]?.name ?? "—"}</td>
              <td>{b.amount != null ? fmtMoney(b.amount, b.currency) : "—"}</td>
              <td>{b.dueDate ?? "—"}</td>
              <td>{b.status}</td>
              <td>{flagText(b)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={5}>No open bills. Add a biller and run a scan.</td>
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

function alertLabel(type: string | null | undefined): string {
  switch (type) {
    case "eviction": return "Eviction notice";
    case "disconnect": return "Disconnect warning";
    case "pastdue": return "Past due";
    default: return "Alert";
  }
}

function flagText(b: Bill): string {
  const f: string[] = [];
  if (b.isEvictionNotice) f.push("eviction");
  if (b.isDisconnectWarning) f.push("disconnect");
  if (b.isPastDue) f.push("past due");
  return f.join(", ");
}

/** Sum open bills per currency so mixed-currency totals aren't conflated. */
function totalsByCurrency(bills: Bill[]): string {
  const sums = new Map<string, number>();
  for (const b of bills) {
    if (b.amount == null) continue;
    const cur = b.currency ?? "USD";
    sums.set(cur, (sums.get(cur) ?? 0) + b.amount);
  }
  if (sums.size === 0) return fmtMoney(0, "USD");
  return [...sums.entries()].map(([cur, amt]) => fmtMoney(amt, cur)).join(" + ");
}

function fmtMoney(n: number, currency: string | null | undefined): string {
  return n.toLocaleString(undefined, { style: "currency", currency: currency ?? "USD" });
}
