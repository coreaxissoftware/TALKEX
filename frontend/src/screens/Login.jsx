import { useEffect, useRef, useState } from "react";
import { Auth, setToken, clearStoredReferral } from "../api.js";
import { Button, Field, G, I, ParticleNetwork, Screen, Spinner, useIsDesktop } from "../ui.jsx";
import { COUNTRY_CODES, flagFor, samplePlaceholder } from "../countryCodes.js";

/**
 * Sign in or create an account.
 *
 * There is no one-click demo button any more. v1 had one backed by a server
 * branch that logged anyone in as the `demo` account with any password at all.
 * The "try it" button below registers a genuine throwaway account instead, so
 * the convenience survives without the backdoor.
 */
export default function Login({ onAuthenticated }) {
  const [mode, setMode] = useState("phone");
  const [form, setForm] = useState({ username: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingToken, setPendingToken] = useState(null); // set once the password is right but a PIN is still owed

  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  function completeAuth(result) {
    setToken(result.token);
    localStorage.setItem("ht_user", JSON.stringify(result.user));
    // A pending invite referral has now done its job (the register call that
    // just completed carried it) — drop it so it can never be reused to credit
    // a different account signing in later on this same device.
    clearStoredReferral();
    onAuthenticated(result.user, Boolean(result.account_disabled));
  }

  async function submit(action) {
    setBusy(true);
    setError("");
    try {
      completeAuth(await action());
    } catch (problem) {
      setError(problem.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setError("");
    try {
      const result = await Auth.login({ username: form.username.trim(), password: form.password });
      if (result.requires_pin) setPendingToken(result.pending_token);
      else completeAuth(result);
    } catch (problem) {
      setError(problem.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (pendingToken) {
    return (
      <TwoStepGate
        onSubmit={async (pin) => {
          setBusy(true);
          setError("");
          try {
            completeAuth(await Auth.verifyTwoStepPin(pendingToken, pin));
          } catch (problem) {
            setError(problem.message || "Wrong PIN");
          } finally {
            setBusy(false);
          }
        }}
        onBack={() => { setPendingToken(null); setError(""); }}
        busy={busy} error={error}/>
    );
  }

  const isDesktop = useIsDesktop();
  const wideQr = isDesktop && mode === "qr";

  const tabs = [
    { key: "phone", label: "Phone number" },
    { key: "login", label: "Username" },
    { key: "qr", label: "Scan QR" },
  ];
  const tabIndex = tabs.findIndex((t) => t.key === mode);

  return (
    <Screen style={{
      justifyContent: "center", padding: 24, position: "relative", overflow: "hidden",
      maxWidth: isDesktop ? (wideQr ? 860 : 480) : 430, background: "transparent",
    }}>
      <ParticleNetwork/>

      {/* One rounded-rectangle card, top to bottom — the brand strip and the
          form live inside the same box (border/shadow/radius shared) rather
          than the wordmark floating separately above a second card. */}
      <div style={{
        position: "relative", zIndex: 1,
        background: G.bg, border: `1px solid #ffffff26`, borderRadius: 24,
        overflow: "hidden", boxShadow: "0 30px 70px -20px #00000066, 0 2px 8px #0003",
      }}>
        <div style={{
          textAlign: "center", padding: "30px 24px 26px",
          background: "linear-gradient(160deg, #101f38, #0c1930)",
        }}>
          <div style={{
            width: 68, height: 68, borderRadius: 20, margin: "0 auto 14px",
            overflow: "hidden", boxShadow: `0 12px 30px ${G.accentGlow}, 0 0 0 4px #ffffff14`,
          }}><img src="/icon.png" alt="TalkEx" style={{ width: "100%", height: "100%", objectFit: "cover" }}/></div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.7, color: "#fff" }}>TalkEx</div>
          <div style={{ fontSize: 13, color: "#a9c2e0", marginTop: 6, letterSpacing: 0.2 }}>
            Chat • Meetings • Business • Automation
          </div>
        </div>

        <div style={{ padding: 22 }}>
        <div style={{
          position: "relative", display: "flex", padding: 4, background: G.dim,
          borderRadius: 14, marginBottom: 22,
        }}>
          <div style={{
            position: "absolute", top: 4, bottom: 4, left: 4,
            width: `calc(${100 / tabs.length}% - 4px)`,
            transform: `translateX(calc(${tabIndex} * (100% + ${4 / tabs.length}px)))`,
            background: G.accent, borderRadius: 10, transition: "transform 220ms ease",
          }}/>
          {tabs.map((tab) => (
            <button key={tab.key} onClick={() => { setMode(tab.key); setError(""); }}
              style={{
                position: "relative", flex: 1, padding: "10px 4px", borderRadius: 10,
                border: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600,
                background: "transparent", color: mode === tab.key ? "#fff" : G.sub,
                transition: "color 150ms ease",
              }}>
              {tab.label}
            </button>
          ))}
        </div>

        {mode === "qr" ? (
          <QrSignIn onAuthenticated={onAuthenticated} wide={wideQr}
                    onUsePhone={() => setMode("phone")}/>
        ) : mode === "phone" ? (
          <PhoneAuth onAuthenticated={onAuthenticated}/>
        ) : (
          <>
            <Field label="Username" value={form.username} onChange={set("username")}
                   placeholder="its_satyajeet_coreaxis" autoCapitalize="none"/>
            <Field label="Password" type="password" value={form.password}
                   onChange={set("password")} placeholder="At least 8 characters"
                   onKeyDown={(event) => event.key === "Enter" && login()}/>

            {error && <ErrorBox>{error}</ErrorBox>}

            <Button onClick={login} disabled={busy}
                    style={{ width: "100%", padding: 14, marginBottom: 10 }}>
              {busy ? "Please wait…" : "Sign in"}
            </Button>
          </>
        )}
        </div>
      </div>
    </Screen>
  );
}

/**
 * WhatsApp-style sign-in/sign-up: a phone number, then a code texted to it,
 * then — only the first time that number is ever seen — a name. This is now
 * how every new account gets created; the "Username" tab next to it exists
 * only so accounts made before this flow existed can still sign in.
 */
function PhoneAuth({ onAuthenticated }) {
  const [step, setStep] = useState("phone"); // phone | code | name
  const [country, setCountry] = useState(COUNTRY_CODES[0]);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The number actually sent to the server: whatever country was picked,
  // plus only the digits the person typed (in case they paste a number
  // with spaces, dashes, or their own leading "+91").
  const fullPhone = country.dial + phone;

  function onPhoneChange(event) {
    // Digits only, capped to this country's expected local-number length —
    // no more "type as many digits as you want" free-for-all.
    setPhone(event.target.value.replace(/\D/g, "").slice(0, country.len));
  }

  function finish(result) {
    setToken(result.token);
    localStorage.setItem("ht_user", JSON.stringify(result.user));
    onAuthenticated(result.user, Boolean(result.account_disabled));
  }

  async function requestCode() {
    if (!phone.trim()) return;
    setBusy(true);
    setError("");
    try {
      await Auth.requestPhoneOtp(fullPhone);
      setStep("code");
    } catch (problem) {
      setError(problem.message || "Could not send a code");
    } finally {
      setBusy(false);
    }
  }

  async function verifyCode() {
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await Auth.verifyPhoneOtp(fullPhone, code.trim());
      finish(result);
    } catch (problem) {
      // A brand new number 400s here specifically because a name is
      // required — that's the cue to ask for one, not a real error.
      if (problem.status === 400 && /name is required/i.test(problem.message || "")) {
        setStep("name");
      } else {
        setError(problem.message || "Incorrect code");
      }
    } finally {
      setBusy(false);
    }
  }

  async function createAccount() {
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await Auth.verifyPhoneOtp(fullPhone, code.trim(), name.trim());
      finish(result);
    } catch (problem) {
      setError(problem.message || "Could not create your account");
    } finally {
      setBusy(false);
    }
  }

  if (step === "phone") {
    const validLength = phone.length === country.len;
    return (
      <>
        <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>Enter phone number</div>
        <div style={{ fontSize: 13, color: G.sub, marginBottom: 20 }}>
          Select a country and enter your phone number.
        </div>

        {/* A styled row showing flag + country name + chevron, with the real
            <select> transparent and stretched over it — native picker
            behavior (keyboard, search-by-letter, mobile wheel) with a look
            that isn't a cramped little dropdown box. */}
        <div style={{ position: "relative", marginBottom: 10 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 10, padding: "13px 16px",
            borderRadius: 14, background: G.dim, border: `1px solid ${G.border}`,
          }}>
            <span style={{ fontSize: 20 }}>{flagFor(country.iso)}</span>
            <span style={{ flex: 1, fontSize: 15, fontWeight: 500 }}>{country.name}</span>
            <span style={{ color: G.muted, fontSize: 12 }}>▾</span>
          </div>
          <select value={country.iso} aria-label="Country"
                  onChange={(event) => {
                    setCountry(COUNTRY_CODES.find((c) => c.iso === event.target.value));
                    setPhone("");
                  }}
                  style={{
                    position: "absolute", inset: 0, width: "100%", height: "100%",
                    opacity: 0, cursor: "pointer", fontSize: 16,
                  }}>
            {COUNTRY_CODES.map((c) => (
              <option key={c.iso} value={c.iso}>{c.name} ({c.dial})</option>
            ))}
          </select>
        </div>

        <div style={{
          display: "flex", alignItems: "center", borderRadius: 14, background: G.dim,
          border: `1px solid ${G.border}`, marginBottom: 20, overflow: "hidden",
        }}>
          <div style={{
            padding: "13px 14px", fontSize: 15, fontWeight: 600, color: G.sub,
            borderRight: `1px solid ${G.border}`,
          }}>{country.dial}</div>
          <input value={phone} onChange={onPhoneChange} inputMode="tel" autoFocus
                 placeholder={samplePlaceholder(country.len)}
                 onKeyDown={(event) => event.key === "Enter" && validLength && requestCode()}
                 style={{
                   flex: 1, width: "100%", padding: "13px 14px", border: "none",
                   background: "transparent", color: G.text, fontSize: 15.5,
                   outline: "none", boxSizing: "border-box", letterSpacing: 0.3,
                 }}/>
        </div>

        {error && <ErrorBox>{error}</ErrorBox>}
        <Button onClick={requestCode} disabled={busy || !validLength}
                style={{ width: "100%", padding: 15, borderRadius: 999, fontSize: 15 }}>
          {busy ? "Sending…" : "Next"}
        </Button>
      </>
    );
  }

  if (step === "code") {
    return (
      <>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          We sent a code to {fullPhone}.
        </div>
        <Field label="Code" value={code} inputMode="numeric" autoCapitalize="none"
               onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
               placeholder="123456"
               onKeyDown={(event) => event.key === "Enter" && verifyCode()}/>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Button onClick={verifyCode} disabled={busy || !code.trim()}
                style={{ width: "100%", padding: 14, marginBottom: 10 }}>
          {busy ? "Checking…" : "Continue"}
        </Button>
        <Button variant="ghost" onClick={requestCode} disabled={busy} style={{ width: "100%" }}>
          Resend code
        </Button>
      </>
    );
  }

  return (
    <>
      <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
        {phone} is new here — what should we call you?
      </div>
      <Field label="Your name" value={name}
             onChange={(event) => setName(event.target.value)}
             placeholder="Rahul Sharma"
             onKeyDown={(event) => event.key === "Enter" && createAccount()}/>
      {error && <ErrorBox>{error}</ErrorBox>}
      <Button onClick={createAccount} disabled={busy || !name.trim()}
              style={{ width: "100%", padding: 14 }}>
        {busy ? "Creating…" : "Create account"}
      </Button>
    </>
  );
}

function ErrorBox({ children }) {
  return (
    <div style={{
      padding: "10px 14px", borderRadius: 10, background: `${G.red}18`,
      border: `1px solid ${G.red}44`, color: G.red, fontSize: 13, marginBottom: 12,
    }}>{children}</div>
  );
}

/**
 * The second half of signing in when the account has two-step verification
 * on. The password already checked out server-side — this screen exists
 * because "requires_pin" came back instead of a token, not because it
 * decided to show up on its own.
 */
function TwoStepGate({ onSubmit, onBack, busy, error }) {
  const [pin, setPin] = useState("");

  return (
    <Screen style={{ justifyContent: "center", padding: 28 }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 22, margin: "0 auto 16px",
          background: `linear-gradient(135deg,${G.accent},${G.accentD})`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{I.lock("#fff", 30)}</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Enter your PIN</div>
        <div style={{ fontSize: 13, color: G.sub, marginTop: 6 }}>
          This account has two-step verification on
        </div>
      </div>

      <Field label="PIN" type="password" value={pin} inputMode="numeric" autoCapitalize="none"
             onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
             placeholder="••••••"
             onKeyDown={(event) => event.key === "Enter" && pin && onSubmit(pin)}/>

      {error && (
        <div style={{
          padding: "10px 14px", borderRadius: 10, background: `${G.red}18`,
          border: `1px solid ${G.red}44`, color: G.red, fontSize: 13, marginBottom: 12,
        }}>{error}</div>
      )}

      <Button onClick={() => onSubmit(pin)} disabled={busy || !pin}
              style={{ width: "100%", padding: 14, marginBottom: 10 }}>
        {busy ? "Checking…" : "Continue"}
      </Button>
      <Button variant="ghost" onClick={onBack} disabled={busy} style={{ width: "100%" }}>
        Back
      </Button>
    </Screen>
  );
}

const POLL_INTERVAL_MS = 2000;

/**
 * "Sign in via QR" — the new-device side of WhatsApp Web-style linking.
 *
 * Shows a code (as a QR and as text), then polls until an already-signed-in
 * device approves it. The QR is rendered server-side with a real QR library
 * (see backend/qr.py) rather than hand-encoded in the browser — QR encoding
 * involves Reed-Solomon error correction, and a JS implementation good enough
 * to LOOK right but not verified against a real scanner is a worse bet than
 * just asking the server, which already has a trusted library available.
 */
function Step({ n, children }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 18 }}>
      <div style={{
        width: 26, height: 26, borderRadius: "50%", border: `1.5px solid ${G.border}`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 12.5, fontWeight: 700, color: G.sub, flexShrink: 0,
      }}>{n}</div>
      <div style={{ fontSize: 14.5, color: G.text, paddingTop: 3 }}>{children}</div>
    </div>
  );
}

function QrSignIn({ onAuthenticated, wide, onUsePhone }) {
  const [state, setState] = useState("loading");   // loading | ready | expired | error
  const [code, setCode] = useState("");
  const [qrSvg, setQrSvg] = useState("");
  const pollTimer = useRef(null);

  async function start() {
    setState("loading");
    clearInterval(pollTimer.current);
    try {
      const started = await Auth.startLink();
      setCode(started.code);
      setQrSvg(started.qr_svg);
      setState("ready");
      pollTimer.current = setInterval(() => poll(started.code), POLL_INTERVAL_MS);
    } catch {
      setState("error");
    }
  }

  async function poll(currentCode) {
    try {
      const result = await Auth.pollLink(currentCode);
      if (result.status === "approved") {
        clearInterval(pollTimer.current);
        setToken(result.token);
        localStorage.setItem("ht_user", JSON.stringify(result.user));
        onAuthenticated(result.user);
      } else if (result.status === "expired" || result.status === "denied") {
        clearInterval(pollTimer.current);
        setState("expired");
      }
      // 'pending' — keep polling, nothing to do.
    } catch {
      // A transient network hiccup should not kill the flow — the next tick
      // tries again on its own.
    }
  }

  useEffect(() => {
    start();
    return () => clearInterval(pollTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === "loading") return <Spinner/>;

  if (state === "expired" || state === "error") {
    return (
      <div style={{ textAlign: "center", padding: "20px 0" }}>
        <div style={{ fontSize: 13.5, color: G.muted, marginBottom: 14 }}>
          {state === "expired" ? "This code expired or was declined." : "Could not reach the server."}
        </div>
        <Button onClick={start} style={{ width: "100%" }}>Try again</Button>
      </div>
    );
  }

  const qrBlock = (
    <div
      // Server-generated SVG from qrcode.make() — not user input, safe to inline.
      dangerouslySetInnerHTML={{ __html: qrSvg }}
      style={{
        width: wide ? 200 : 180, height: wide ? 200 : 180, margin: wide ? "0 0 16px" : "0 auto 16px",
        background: "#fff", borderRadius: 14, padding: 10, display: "flex",
        alignItems: "center", justifyContent: "center",
      }}/>
  );

  const codeBlock = (
    <div style={{
      fontSize: 24, fontWeight: 800, letterSpacing: 6, color: G.text,
      marginBottom: 16, fontFamily: "monospace",
    }}>{code}</div>
  );

  const waitingBlock = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: wide ? "flex-start" : "center" }}>
      <Spinner small/>
      <span style={{ fontSize: 12.5, color: G.sub }}>Waiting for approval…</span>
    </div>
  );

  if (wide) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 220px", gap: 32, alignItems: "start" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 18 }}>Scan to log in</div>
          <Step n={1}>Open <b>TalkEx</b> on a device you're already signed into</Step>
          <Step n={2}>Go to <b>Settings → Linked devices → Link a device</b></Step>
          <Step n={3}>Scan this QR code, or type the code shown alongside it</Step>
          {onUsePhone && (
            <div onClick={onUsePhone} style={{
              marginTop: 8, fontSize: 13.5, fontWeight: 600, color: G.accentD,
              cursor: "pointer", textDecoration: "underline", width: "fit-content",
            }}>Log in with phone number →</div>
          )}
        </div>
        <div style={{ textAlign: "left" }}>
          {qrBlock}
          {codeBlock}
          {waitingBlock}
        </div>
      </div>
    );
  }

  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ display: "flex", justifyContent: "center" }}>{qrBlock}</div>

      <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 8 }}>
        Open TalkEx on a device you're already signed into →
        Settings → Linked devices → Link a device, and enter this code:
      </div>

      {codeBlock}
      {waitingBlock}
    </div>
  );
}
