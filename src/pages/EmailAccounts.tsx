import { useEffect, useState } from "react";
import { client, listAll, type EmailAccount } from "../client";

export default function EmailAccounts() {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [email, setEmail] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [scanning, setScanning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const data = await listAll((nextToken) => client.models.EmailAccount.list({ nextToken }));
      setAccounts(data);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !credentialRef) return;
    const res = await client.models.EmailAccount.create({
      emailAddress: email,
      provider: "gmail",
      credentialRef,
      status: "active",
    });
    if (res.errors?.length) {
      setError(res.errors.map((x) => x.message).join("; "));
      return;
    }
    setEmail("");
    setCredentialRef("");
    await load();
  }

  async function remove(id: string) {
    const res = await client.models.EmailAccount.delete({ id });
    if (res.errors?.length) {
      setError(res.errors.map((x) => x.message).join("; "));
      return;
    }
    await load();
  }

  async function scanNow(id?: string) {
    setScanning(id ?? "all");
    setError(null);
    setNotice(null);
    try {
      const res = await client.mutations.triggerScan(id ? { emailAccountId: id } : {});
      if (res.errors?.length) {
        setError(res.errors.map((x) => x.message).join("; "));
      } else {
        setNotice("Scan started. It runs in the background — bills appear on the Dashboard in a few minutes (use Refresh there).");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(null);
      await load();
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>Email Accounts</h2>
        <button disabled={scanning != null} onClick={() => scanNow()}>
          {scanning === "all" ? "Scanning…" : "Scan all accounts"}
        </button>
      </div>

      {error && <p className="error-box">{error}</p>}
      {notice && <p className="notice-box">{notice}</p>}

      <form className="form-row" onSubmit={add}>
        <input
          type="email"
          placeholder="you@gmail.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="text"
          placeholder="Secrets Manager ref (e.g. bill-tracker/you-gmail)"
          value={credentialRef}
          onChange={(e) => setCredentialRef(e.target.value)}
        />
        <button type="submit">Add account</button>
      </form>
      <p className="hint">
        Store the Gmail <strong>App Password</strong> in AWS Secrets Manager under a
        name starting with <code>bill-tracker/</code> (the function's IAM policy is scoped
        to that prefix), then enter that exact secret name above. The password itself is
        never stored in the app.
      </p>

      <table className="grid">
        <thead>
          <tr>
            <th>Email</th>
            <th>Status</th>
            <th>Last scan</th>
            <th>Last error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.emailAddress}</td>
              <td>{a.status}</td>
              <td>{a.lastScanAt ? new Date(a.lastScanAt).toLocaleString() : "never"}</td>
              <td className="err">{a.lastError ?? ""}</td>
              <td className="actions">
                <button disabled={scanning != null} onClick={() => scanNow(a.id)}>
                  {scanning === a.id ? "Scanning…" : "Scan now"}
                </button>
                <button className="danger" onClick={() => remove(a.id)}>Remove</button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && (
            <tr><td colSpan={5}>No accounts yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
