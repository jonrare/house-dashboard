import { useState } from "react";
import Dashboard from "./pages/Dashboard";
import EmailAccounts from "./pages/EmailAccounts";
import Billers from "./pages/Billers";
import Bills from "./pages/Bills";

type Tab = "dashboard" | "accounts" | "billers" | "bills";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "accounts", label: "Email Accounts" },
  { id: "billers", label: "Billers" },
  { id: "bills", label: "Bills" },
];

interface AppProps {
  signOut?: () => void;
  user?: { signInDetails?: { loginId?: string } };
}

export default function App({ signOut, user }: AppProps) {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <div className="app">
      <header className="topbar">
        <h1>Bill Tracker</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="user">
          <span>{user?.signInDetails?.loginId}</span>
          <button onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="content">
        {tab === "dashboard" && <Dashboard />}
        {tab === "accounts" && <EmailAccounts />}
        {tab === "billers" && <Billers />}
        {tab === "bills" && <Bills />}
      </main>
    </div>
  );
}
