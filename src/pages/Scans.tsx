import { useEffect, useState } from "react";
import { client, listAll, type ScanRun } from "../client";

export default function Scans() {
  const [runs, setRuns] = useState<ScanRun[]>([]);
  const [scanning, setScanning] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const data = await listAll((nextToken) => client.models.ScanRun.list({ nextToken }));
      data.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
      setRuns(data.slice(0, 50));
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function scanNow() {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const res = await client.mutations.triggerScan();
      if (res.errors?.length) {
        setError(res.errors.map((x) => x.message).join("; "));
      } else {
        setNotice("Scan started. It runs in the background — bills appear on the Dashboard in a few minutes.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
      await load();
    }
  }

  // Delete every imported Bill and Alert AND reset the incremental scan cursor, so a
  // plain "Scan now" afterward re-pulls recent mail instead of finding nothing. Billers
  // and sender filters are kept. (A Backfill still re-pulls the full 12-month history.)
  async function clearBills() {
    if (!confirm("Delete ALL imported bills and alerts, and reset the scan position? Billers and filters are kept. A scan or backfill will re-import them.")) return;
    setClearing(true);
    setError(null);
    setNotice(null);
    try {
      const alerts = await listAll((nextToken) => client.models.Alert.list({ nextToken }));
      await Promise.all(alerts.map((a) => client.models.Alert.delete({ id: a.id })));
      const bills = await listAll((nextToken) => client.models.Bill.list({ nextToken }));
      await Promise.all(bills.map((b) => client.models.Bill.delete({ id: b.id })));
      // Reset the cursor so the next scan starts over (it's a no-op if none exists yet).
      await client.models.ScanState.delete({ id: "global" });
      setNotice(`Cleared ${bills.length} bill(s) and ${alerts.length} alert(s), and reset the scan position.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>Scans</h2>
        <div className="actions">
          <button disabled={scanning} onClick={scanNow}>
            {scanning ? "Scanning…" : "Scan now"}
          </button>
          <button className="danger" disabled={clearing} onClick={clearBills}>
            {clearing ? "Clearing…" : "Clear all bills"}
          </button>
        </div>
      </div>

      {error && <p className="error-box">{error}</p>}
      {notice && <p className="notice-box">{notice}</p>}

      <p className="hint">
        The mailbox is scanned hourly. Connection settings live in the backend:{" "}
        <code>GMAIL_ADDRESS</code> (Amplify environment variable) and{" "}
        <code>GMAIL_APP_PASSWORD</code> (Amplify secret). Recent runs are below.
      </p>

      <table className="grid">
        <thead>
          <tr>
            <th>Mode</th>
            <th>Started</th>
            <th>Finished</th>
            <th>Messages</th>
            <th>Bills</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={r.errors ? "row-warn" : undefined}>
              <td>{r.mode}</td>
              <td>{r.startedAt ? new Date(r.startedAt).toLocaleString() : "—"}</td>
              <td>{r.finishedAt ? new Date(r.finishedAt).toLocaleString() : "—"}</td>
              <td>{r.messagesScanned ?? 0}</td>
              <td>{r.billsCreated ?? 0}</td>
              <td className="err">{r.errors ?? ""}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr><td colSpan={6}>No scans yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
