import { useEffect, useState } from "react";
import { client, listAll, type Biller, type SenderFilter, type EmailAccount } from "../client";

const CATEGORIES = [
  "power", "gas", "water", "internet", "rent",
  "mortgage", "service", "utility", "other",
] as const;
type Category = (typeof CATEGORIES)[number];

export default function Billers() {
  const [billers, setBillers] = useState<Biller[]>([]);
  const [filters, setFilters] = useState<SenderFilter[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category>("power");
  const [backfilling, setBackfilling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [b, f, a] = await Promise.all([
        listAll((nextToken) => client.models.Biller.list({ nextToken })),
        listAll((nextToken) => client.models.SenderFilter.list({ nextToken })),
        listAll((nextToken) => client.models.EmailAccount.list({ nextToken })),
      ]);
      setBillers(b);
      setFilters(f);
      setAccounts(a);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function addBiller(e: React.FormEvent) {
    e.preventDefault();
    if (!name) return;
    const res = await client.models.Biller.create({ name, category });
    if (res.errors?.length) {
      setError(res.errors.map((x) => x.message).join("; "));
      return;
    }
    setName("");
    await load();
  }

  async function removeBiller(id: string) {
    const res = await client.models.Biller.delete({ id });
    if (res.errors?.length) {
      setError(res.errors.map((x) => x.message).join("; "));
      return;
    }
    await load();
  }

  async function backfill(billerId: string) {
    setBackfilling(billerId);
    setError(null);
    setNotice(null);
    try {
      const res = await client.mutations.backfillBiller({ billerId, sinceDays: 365 });
      if (res.errors?.length) {
        setError(res.errors.map((x) => x.message).join("; "));
      } else {
        setNotice("Backfill started. It runs in the background — bills appear on the Dashboard in a few minutes.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBackfilling(null);
    }
  }

  return (
    <div>
      <h2>Billers</h2>
      {error && <p className="error-box">{error}</p>}
      {notice && <p className="notice-box">{notice}</p>}

      <form className="form-row" onSubmit={addBiller}>
        <input
          placeholder="Biller name (e.g. City Power)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="submit">Add biller</button>
      </form>

      {billers.map((b) => (
        <BillerCard
          key={b.id}
          biller={b}
          filters={filters.filter((f) => f.billerId === b.id)}
          accounts={accounts}
          backfilling={backfilling === b.id}
          onChange={load}
          onError={setError}
          onRemove={() => removeBiller(b.id)}
          onBackfill={() => backfill(b.id)}
        />
      ))}
      {billers.length === 0 && <p>No billers yet.</p>}
    </div>
  );
}

function BillerCard(props: {
  biller: Biller;
  filters: SenderFilter[];
  accounts: EmailAccount[];
  backfilling: boolean;
  onChange: () => Promise<void>;
  onError: (msg: string) => void;
  onRemove: () => void;
  onBackfill: () => void;
}) {
  const { biller, filters, accounts, backfilling } = props;
  const [accountId, setAccountId] = useState("");
  const [matchType, setMatchType] = useState<"fromAddress" | "fromDomain">("fromAddress");
  const [matchValue, setMatchValue] = useState("");
  const [subjectContains, setSubjectContains] = useState("");

  async function addFilter(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !matchValue) return;
    const res = await client.models.SenderFilter.create({
      billerId: biller.id,
      emailAccountId: accountId,
      fromAddress: matchType === "fromAddress" ? matchValue : undefined,
      fromDomain: matchType === "fromDomain" ? matchValue : undefined,
      subjectContains: subjectContains || undefined,
    });
    if (res.errors?.length) {
      props.onError(res.errors.map((x) => x.message).join("; "));
      return;
    }
    setMatchValue("");
    setSubjectContains("");
    await props.onChange();
  }

  async function removeFilter(id: string) {
    const res = await client.models.SenderFilter.delete({ id });
    if (res.errors?.length) {
      props.onError(res.errors.map((x) => x.message).join("; "));
      return;
    }
    await props.onChange();
  }

  return (
    <section className="biller-card">
      <div className="biller-head">
        <div>
          <strong>{biller.name}</strong> <span className="tag">{biller.category}</span>
        </div>
        <div className="actions">
          <button disabled={backfilling} onClick={props.onBackfill}>
            {backfilling ? "Backfilling…" : "Backfill 12 months"}
          </button>
          <button className="danger" onClick={props.onRemove}>Delete</button>
        </div>
      </div>

      <ul className="filters">
        {filters.map((f) => (
          <li key={f.id}>
            <code>{f.fromAddress ?? f.fromDomain}</code>
            {f.subjectContains ? ` · subject ~ "${f.subjectContains}"` : ""}
            {" → "}
            {accounts.find((a) => a.id === f.emailAccountId)?.emailAddress ?? "?"}
            <button className="link" onClick={() => removeFilter(f.id)}>remove</button>
          </li>
        ))}
        {filters.length === 0 && <li className="muted">No sender filters yet.</li>}
      </ul>

      <form className="form-row" onSubmit={addFilter}>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Select account…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.emailAddress}</option>)}
        </select>
        <select value={matchType} onChange={(e) => setMatchType(e.target.value as typeof matchType)}>
          <option value="fromAddress">from address</option>
          <option value="fromDomain">from domain</option>
        </select>
        <input
          placeholder={matchType === "fromAddress" ? "billing@citypower.com" : "citypower.com"}
          value={matchValue}
          onChange={(e) => setMatchValue(e.target.value)}
        />
        <input
          placeholder="subject contains (optional)"
          value={subjectContains}
          onChange={(e) => setSubjectContains(e.target.value)}
        />
        <button type="submit">Add filter</button>
      </form>
    </section>
  );
}
