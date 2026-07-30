import { useEffect, useState } from "react";
import { Admin } from "../api.js";
import { Button, Field, G, SRow, Spinner, whenLabel } from "../ui.jsx";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "users", label: "Users" },
  { key: "integrations", label: "Integrations" },
  { key: "templates", label: "Templates" },
];

/**
 * The superadmin panel — only ever rendered when the signed-in account has
 * is_superadmin set (App.jsx gates the rail icon on that), and every call
 * it makes is re-checked server-side by require_superadmin regardless, the
 * same "the client-side gate is convenience, not the actual boundary" rule
 * every other permission check in this app already follows.
 */
export default function AdminPanel({ toast }) {
  const [tab, setTab] = useState("overview");

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <div style={{ display: "flex", gap: 6, padding: 16, flexWrap: "wrap" }}>
        {TABS.map((entry) => (
          <button key={entry.key} onClick={() => setTab(entry.key)}
            style={{
              flex: "1 0 auto", padding: "9px 14px", borderRadius: 10, cursor: "pointer",
              fontSize: 13.5, fontWeight: 600,
              border: `1px solid ${tab === entry.key ? G.accent : G.border}`,
              background: tab === entry.key ? G.accentSoft : "transparent",
              color: tab === entry.key ? G.accentText : G.sub,
            }}>{entry.label}</button>
        ))}
      </div>

      {tab === "overview" && <Overview/>}
      {tab === "users" && <Users toast={toast}/>}
      {tab === "integrations" && <Integrations toast={toast}/>}
      {tab === "templates" && <Templates toast={toast}/>}
    </div>
  );
}

function Overview() {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    Admin.stats().then(setStats).catch(() => {});
  }, []);

  if (!stats) return <Spinner/>;

  const cards = [
    ["Users", stats.users], ["Active users", stats.active_users],
    ["Chats", stats.chats], ["Messages", stats.messages],
    ["Live sessions", stats.active_sessions], ["Templates pending review", stats.pending_templates],
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12, padding: "0 16px 16px" }}>
      {cards.map(([label, value]) => (
        <div key={label} style={{
          padding: 16, borderRadius: 14, background: G.dim, border: `1px solid ${G.border}`,
        }}>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{value}</div>
          <div style={{ fontSize: 12, color: G.sub, marginTop: 4 }}>{label}</div>
        </div>
      ))}
    </div>
  );
}

function Users({ toast }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  function reload(q = query) {
    setLoading(true);
    Admin.users(q).then(setUsers).catch(() => {}).finally(() => setLoading(false));
  }

  useEffect(() => { reload(""); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleDisabled(user) {
    if (user.disabled_at) await Admin.enableUser(user.id);
    else await Admin.disableUser(user.id);
    reload();
  }

  async function deleteUser(user) {
    if (!window.confirm(`Permanently delete ${user.name} (@${user.username})? This cannot be undone.`)) return;
    await Admin.deleteUser(user.id);
    toast("Account deleted");
    reload();
  }

  return (
    <div>
      <div style={{ padding: "0 16px 12px", display: "flex", gap: 8 }}>
        <Field value={query} onChange={(event) => setQuery(event.target.value)}
               onKeyDown={(event) => event.key === "Enter" && reload()}
               placeholder="Search by name, username or phone" style={{ flex: 1, marginBottom: 0 }}/>
        <Button onClick={() => reload()} style={{ padding: "0 16px" }}>Search</Button>
      </div>

      {loading && <Spinner/>}

      {!loading && users.map((user) => (
        <SRow key={user.id}
              icon={<span style={{ fontSize: 14, fontWeight: 700 }}>{user.name?.[0]?.toUpperCase() || "?"}</span>}
              label={`${user.name}${user.is_superadmin ? " · superadmin" : ""}`}
              sub={`@${user.username} · ${user.phone || "no phone"}${user.disabled_at ? " · disabled" : ""}`}
              right={
                <div style={{ display: "flex", gap: 6 }}>
                  <Button variant="ghost" style={{ padding: "6px 10px", fontSize: 12 }}
                          onClick={() => toggleDisabled(user)}>
                    {user.disabled_at ? "Enable" : "Disable"}
                  </Button>
                  <Button variant="danger" style={{ padding: "6px 10px", fontSize: 12 }}
                          onClick={() => deleteUser(user)}>Delete</Button>
                </div>
              }/>
      ))}

      {!loading && users.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: G.muted, fontSize: 14 }}>No accounts match.</div>
      )}
    </div>
  );
}

function IntegrationField({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <Field label={label} type={type} value={value} onChange={onChange} placeholder={placeholder}/>
  );
}

function Integrations({ toast }) {
  const [data, setData] = useState(null);
  const [sms, setSms] = useState({ msg91_auth_key: "", msg91_template_id: "", msg91_var_name: "" });
  const [mailgun, setMailgun] = useState({ mailgun_api_key: "", mailgun_domain: "", mailgun_base_url: "", mailgun_from: "" });
  const [testPhone, setTestPhone] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [busy, setBusy] = useState(false);

  function reload() {
    Admin.integrations().then(setData).catch(() => {});
  }
  useEffect(reload, []);

  async function saveSms() {
    const fields = Object.fromEntries(Object.entries(sms).filter(([, v]) => v.trim()));
    if (Object.keys(fields).length === 0) return;
    setBusy(true);
    try {
      await Admin.updateIntegrations(fields);
      setSms({ msg91_auth_key: "", msg91_template_id: "", msg91_var_name: "" });
      toast("SMS settings saved");
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function saveMailgun() {
    const fields = Object.fromEntries(Object.entries(mailgun).filter(([, v]) => v.trim()));
    if (Object.keys(fields).length === 0) return;
    setBusy(true);
    try {
      await Admin.updateIntegrations(fields);
      setMailgun({ mailgun_api_key: "", mailgun_domain: "", mailgun_base_url: "", mailgun_from: "" });
      toast("Email settings saved");
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function runTestSms() {
    if (!testPhone.trim()) return;
    setBusy(true);
    try {
      const { result } = await Admin.testSms(testPhone.trim());
      toast(result === "sent" ? "Test OTP sent (or logged to console if SMS isn't configured)" : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function runTestEmail() {
    if (!testEmail.trim()) return;
    setBusy(true);
    try {
      const { result } = await Admin.testEmail(testEmail.trim());
      toast(result === "sent" ? "Test code sent (or logged to console if email isn't configured)" : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <Spinner/>;

  return (
    <div style={{ padding: "0 16px 24px" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
        SMS (MSG91) — {data.sms.configured ? "configured" : "not configured"}
      </div>
      <div style={{ fontSize: 12, color: G.muted, marginBottom: 10 }}>
        Powers phone-number OTPs, via the DLT-approved COREAX template wired
        into an MSG91 Flow. Blank fields below are left unchanged.
        {data.sms.configured && ` Current: ${data.sms.msg91_template_id} / ${data.sms.msg91_auth_key} / var=${data.sms.msg91_var_name}`}
      </div>
      <IntegrationField label="Auth key" type="password" value={sms.msg91_auth_key}
                         onChange={(e) => setSms({ ...sms, msg91_auth_key: e.target.value })}
                         placeholder="••••••••"/>
      <IntegrationField label="Flow (template) ID" value={sms.msg91_template_id}
                         onChange={(e) => setSms({ ...sms, msg91_template_id: e.target.value })}
                         placeholder="From MSG91 dashboard, after DLT approval"/>
      <IntegrationField label="Variable name" value={sms.msg91_var_name}
                         onChange={(e) => setSms({ ...sms, msg91_var_name: e.target.value })}
                         placeholder="var (default — whatever you named it in the Flow)"/>
      <Button onClick={saveSms} disabled={busy} style={{ width: "100%", marginBottom: 20 }}>Save SMS settings</Button>

      <div style={{ display: "flex", gap: 8, marginBottom: 28 }}>
        <Field value={testPhone} onChange={(e) => setTestPhone(e.target.value)}
               placeholder="+91… to send a test OTP to" style={{ flex: 1, marginBottom: 0 }}/>
        <Button variant="ghost" onClick={runTestSms} disabled={busy || !testPhone.trim()}
                style={{ padding: "0 16px" }}>Test</Button>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
        Email (Mailgun) — {data.email.configured ? "configured" : "not configured"}
      </div>
      <div style={{ fontSize: 12, color: G.muted, marginBottom: 10 }}>
        Powers email OTPs. Blank fields below are left unchanged.
        {data.email.configured && ` Current: ${data.email.mailgun_domain} / ${data.email.mailgun_api_key} / ${data.email.mailgun_from}`}
      </div>
      <IntegrationField label="API key" type="password" value={mailgun.mailgun_api_key}
                         onChange={(e) => setMailgun({ ...mailgun, mailgun_api_key: e.target.value })}
                         placeholder="••••••••"/>
      <IntegrationField label="Sending domain" value={mailgun.mailgun_domain}
                         onChange={(e) => setMailgun({ ...mailgun, mailgun_domain: e.target.value })}
                         placeholder="talkex.coreaxis.cloud"/>
      <IntegrationField label="Base URL" value={mailgun.mailgun_base_url}
                         onChange={(e) => setMailgun({ ...mailgun, mailgun_base_url: e.target.value })}
                         placeholder="https://api.mailgun.net"/>
      <IntegrationField label="From address" value={mailgun.mailgun_from}
                         onChange={(e) => setMailgun({ ...mailgun, mailgun_from: e.target.value })}
                         placeholder="TalkEx <noreply@your-domain>"/>
      <Button onClick={saveMailgun} disabled={busy} style={{ width: "100%", marginBottom: 20 }}>Save email settings</Button>

      <div style={{ display: "flex", gap: 8 }}>
        <Field value={testEmail} onChange={(e) => setTestEmail(e.target.value)}
               placeholder="Address to send a test code to" style={{ flex: 1, marginBottom: 0 }}/>
        <Button variant="ghost" onClick={runTestEmail} disabled={busy || !testEmail.trim()}
                style={{ padding: "0 16px" }}>Test</Button>
      </div>
    </div>
  );
}

function Templates({ toast }) {
  const [status, setStatus] = useState("pending");
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);

  function reload() {
    setLoading(true);
    Admin.templates(status === "all" ? "" : status).then(setTemplates).catch(() => {}).finally(() => setLoading(false));
  }
  useEffect(reload, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function approve(template) {
    await Admin.approveTemplate(template.id);
    toast("Template approved");
    reload();
  }

  async function reject(template) {
    await Admin.rejectTemplate(template.id);
    toast("Template rejected");
    reload();
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, padding: "0 16px 12px" }}>
        {["pending", "approved", "rejected", "all"].map((option) => (
          <button key={option} onClick={() => setStatus(option)}
            style={{
              padding: "6px 14px", borderRadius: 20, whiteSpace: "nowrap", cursor: "pointer",
              border: `1px solid ${status === option ? G.accent : G.border}`,
              background: status === option ? G.accentSoft : "transparent",
              color: status === option ? G.accentText : G.sub, fontSize: 13,
              textTransform: "capitalize",
            }}>{option}</button>
        ))}
      </div>

      {loading && <Spinner/>}

      {!loading && templates.map((template) => (
        <div key={template.id} style={{ padding: "14px 16px", borderBottom: `1px solid ${G.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>{template.name}</div>
            <div style={{
              fontSize: 11, fontWeight: 700, textTransform: "uppercase", padding: "2px 8px", borderRadius: 8,
              color: template.status === "approved" ? G.green : template.status === "rejected" ? G.red : G.yellow,
              background: `${template.status === "approved" ? G.green : template.status === "rejected" ? G.red : G.yellow}22`,
            }}>{template.status}</div>
          </div>
          <div style={{ fontSize: 13.5, color: G.text, marginTop: 6 }}>{template.content}</div>
          <div style={{ fontSize: 12, color: G.muted, marginTop: 6 }}>
            by {template.owner_name} (@{template.owner_username}) · {whenLabel(template.created_at)}
          </div>
          {template.status === "pending" && (
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <Button variant="danger" style={{ flex: 1, padding: "7px" }} onClick={() => reject(template)}>
                Reject
              </Button>
              <Button style={{ flex: 1, padding: "7px" }} onClick={() => approve(template)}>
                Approve
              </Button>
            </div>
          )}
        </div>
      ))}

      {!loading && templates.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: G.muted, fontSize: 14 }}>Nothing here.</div>
      )}
    </div>
  );
}
