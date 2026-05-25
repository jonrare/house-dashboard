import { Fragment, useEffect, useMemo, useState } from "react";
import { client, clearAlertsForBill, type Bill, type Biller } from "../client";

type StatusFilter = "all" | "unpaid" | "paid" | "pastdue" | "dismissed";

interface EditForm {
  amount: string;
  currency: string;
  statementDate: string;
  dueDate: string;
  billerId: string;
  status: "unpaid" | "paid" | "pastdue" | "dismissed";
  isPastDue: boolean;
  isDisconnectWarning: boolean;
  isEvictionNotice: boolean;
}

export default function Bills() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [billerList, setBillerList] = useState<Biller[]>([]);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Live updates: scanned bills appear automatically, no manual refresh needed.
  useEffect(() => {
    const billSub = client.models.Bill.observeQuery().subscribe({
      next: ({ items }) => setBills([...items]),
      error: (e) => setError(String(e)),
    });
    const billerSub = client.models.Biller.observeQuery().subscribe({
      next: ({ items }) => setBillerList([...items]),
      error: (e) => setError(String(e)),
    });
    return () => {
      billSub.unsubscribe();
      billerSub.unsubscribe();
    };
  }, []);

  const billers = useMemo(
    () => Object.fromEntries(billerList.map((b) => [b.id, b])),
    [billerList],
  );

  function startEdit(b: Bill) {
    setEditingId(b.id);
    setOpenId(null);
    setForm({
      amount: b.amount?.toString() ?? "",
      currency: b.currency ?? "USD",
      statementDate: b.statementDate ?? "",
      dueDate: b.dueDate ?? "",
      billerId: b.billerId,
      status: (b.status ?? "unpaid") as EditForm["status"],
      isPastDue: !!b.isPastDue,
      isDisconnectWarning: !!b.isDisconnectWarning,
      isEvictionNotice: !!b.isEvictionNotice,
    });
  }

  async function saveEdit(id: string) {
    if (!form) return;
    const amt = form.amount.trim() === "" ? null : Number(form.amount);
    if (amt != null && Number.isNaN(amt)) {
      setError("Amount must be a number.");
      return;
    }
    const res = await client.models.Bill.update({
      id,
      amount: amt,
      currency: form.currency || "USD",
      statementDate: form.statementDate || null,
      dueDate: form.dueDate || null,
      billerId: form.billerId,
      status: form.status,
      isPastDue: form.isPastDue,
      isDisconnectWarning: form.isDisconnectWarning,
      isEvictionNotice: form.isEvictionNotice,
    });
    if (res.errors?.length) {
      setError(res.errors.map((e) => e.message).join("; "));
      return;
    }
    setEditingId(null);
    setForm(null);
  }

  async function markPaid(id: string) {
    const res = await client.models.Bill.update({ id, status: "paid", isPastDue: false });
    if (res.errors?.length) {
      setError(res.errors.map((e) => e.message).join("; "));
      return;
    }
    await clearAlertsForBill(id); // a paid bill should no longer drive urgent alerts
  }

  async function dismiss(id: string) {
    if (!confirm("Mark this as 'not a bill'? It will be hidden from the dashboard and its alerts removed.")) return;
    const res = await client.models.Bill.update({
      id,
      status: "dismissed",
      isPastDue: false,
      isDisconnectWarning: false,
      isEvictionNotice: false,
    });
    if (res.errors?.length) {
      setError(res.errors.map((e) => e.message).join("; "));
      return;
    }
    await clearAlertsForBill(id);
  }

  async function deleteBill(id: string) {
    if (!confirm("Delete this bill permanently? (A future scan could re-import it from the email.)")) return;
    await clearAlertsForBill(id);
    const res = await client.models.Bill.delete({ id });
    if (res.errors?.length) setError(res.errors.map((e) => e.message).join("; "));
  }

  const shown = bills
    .filter((b) => status === "all" || b.status === status)
    .sort((a, b) => (b.dueDate ?? "").localeCompare(a.dueDate ?? ""));

  return (
    <div>
      <div className="page-head">
        <h2>Bills</h2>
        <span className="muted">Live — updates as scans complete.</span>
      </div>

      {error && <p className="error-box">{error}</p>}

      <div className="form-row">
        <label>
          Status:{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="all">all</option>
            <option value="unpaid">unpaid</option>
            <option value="pastdue">pastdue</option>
            <option value="paid">paid</option>
            <option value="dismissed">dismissed</option>
          </select>
        </label>
      </div>

      <table className="grid">
        <thead>
          <tr>
            <th>Biller</th>
            <th>Amount</th>
            <th>Statement</th>
            <th>Due</th>
            <th>Status</th>
            <th>Confidence</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {shown.map((b) => (
            <Fragment key={b.id}>
              <tr className={b.isPastDue ? "row-warn" : undefined}>
                <td>{billers[b.billerId]?.name ?? "—"}</td>
                <td>{b.amount != null ? fmtMoney(b.amount, b.currency) : "—"}</td>
                <td>{b.statementDate ?? "—"}</td>
                <td>{b.dueDate ?? "—"}</td>
                <td>{b.status}{lowConfidence(b) ? " ⚠" : ""}</td>
                <td>{b.confidence != null ? `${Math.round(b.confidence * 100)}%` : "—"}</td>
                <td className="actions">
                  <button className="link" onClick={() => { setOpenId(openId === b.id ? null : b.id); setEditingId(null); }}>
                    {openId === b.id ? "hide" : "source"}
                  </button>
                  <button className="link" onClick={() => startEdit(b)}>edit</button>
                  {b.status !== "paid" && b.status !== "dismissed" && (
                    <button onClick={() => markPaid(b.id)}>Mark paid</button>
                  )}
                </td>
              </tr>

              {openId === b.id && (
                <tr>
                  <td colSpan={7} className="source">
                    <strong>{b.subject}</strong>
                    <p>{b.sourceSnippet}</p>
                    {b.messageId && (
                      <a
                        href={`https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(b.messageId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open in Gmail ↗
                      </a>
                    )}
                  </td>
                </tr>
              )}

              {editingId === b.id && form && (
                <tr>
                  <td colSpan={7} className="edit-row">
                    <div className="edit-grid">
                      <label>Biller
                        <select value={form.billerId} onChange={(e) => setForm({ ...form, billerId: e.target.value })}>
                          {billerList.map((bl) => <option key={bl.id} value={bl.id}>{bl.name}</option>)}
                        </select>
                      </label>
                      <label>Amount
                        <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                      </label>
                      <label>Currency
                        <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
                      </label>
                      <label>Statement date
                        <input type="date" value={form.statementDate} onChange={(e) => setForm({ ...form, statementDate: e.target.value })} />
                      </label>
                      <label>Due date
                        <input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                      </label>
                      <label>Status
                        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as EditForm["status"] })}>
                          <option value="unpaid">unpaid</option>
                          <option value="pastdue">pastdue</option>
                          <option value="paid">paid</option>
                          <option value="dismissed">dismissed</option>
                        </select>
                      </label>
                    </div>
                    <div className="edit-flags">
                      <label><input type="checkbox" checked={form.isPastDue} onChange={(e) => setForm({ ...form, isPastDue: e.target.checked })} /> past due</label>
                      <label><input type="checkbox" checked={form.isDisconnectWarning} onChange={(e) => setForm({ ...form, isDisconnectWarning: e.target.checked })} /> disconnect</label>
                      <label><input type="checkbox" checked={form.isEvictionNotice} onChange={(e) => setForm({ ...form, isEvictionNotice: e.target.checked })} /> eviction</label>
                    </div>
                    <div className="actions">
                      <button onClick={() => saveEdit(b.id)}>Save</button>
                      <button className="link" onClick={() => { setEditingId(null); setForm(null); }}>Cancel</button>
                      <button className="link" onClick={() => dismiss(b.id)}>Not a bill</button>
                      <button className="danger" onClick={() => deleteBill(b.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={7}>No bills match.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function lowConfidence(b: Bill): boolean {
  return b.confidence != null && b.confidence < 0.6 && b.status !== "dismissed";
}

function fmtMoney(n: number, currency: string | null | undefined): string {
  return n.toLocaleString(undefined, { style: "currency", currency: currency ?? "USD" });
}
