import { useEffect, useRef, useState } from "react";
import { Auth, setToken } from "../api.js";
import { Button, Field, G, I, Screen, Spinner } from "../ui.jsx";

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

  const tryIt = () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    return submit(() => Auth.register({
      name: "Guest " + suffix.slice(0, 3).toUpperCase(),
      username: "guest" + suffix,
      // Long random password the guest never needs to type. This is a real
      // account with a real password, not an authentication bypass.
      password: crypto.randomUUID(),
      phone: "",
      bio: "Just looking around",
    }));
  };

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

  return (
    <Screen style={{ justifyContent: "center", padding: 28 }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{
          width: 72, height: 72, borderRadius: 22, margin: "0 auto 16px",
          overflow: "hidden",
          boxShadow: `0 8px 32px ${G.accentGlow}`,
        }}><img src="/icon.png" alt="TalkEx" style={{ width: "100%", height: "100%", objectFit: "cover" }}/></div>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.5 }}>TalkEx</div>
        <div style={{ fontSize: 14, color: G.sub, marginTop: 6 }}>
          Chat • Meetings • Business • Automation
        </div>
      </div>

      <div style={{
        display: "flex", gap: 6, padding: 4, background: G.dim,
        borderRadius: 14, marginBottom: 20,
      }}>
        {["phone", "login", "qr"].map((option) => (
          <button key={option} onClick={() => { setMode(option); setError(""); }}
            style={{
              flex: 1, padding: "10px", borderRadius: 10, border: "none",
              cursor: "pointer", fontSize: 13, fontWeight: 600,
              background: mode === option ? G.accent : "transparent",
              color: mode === option ? "#fff" : G.sub,
            }}>
            {option === "phone" ? "Phone number" : option === "login" ? "Username" : "Scan QR"}
          </button>
        ))}
      </div>

      {mode === "qr" ? (
        <QrSignIn onAuthenticated={onAuthenticated}/>
      ) : mode === "phone" ? (
        <PhoneAuth onAuthenticated={onAuthenticated}/>
      ) : (
        <>
          <Field label="Username" value={form.username} onChange={set("username")}
                 placeholder="rahul_s" autoCapitalize="none"/>
          <Field label="Password" type="password" value={form.password}
                 onChange={set("password")} placeholder="At least 8 characters"
                 onKeyDown={(event) => event.key === "Enter" && login()}/>

          {error && (
            <div style={{
              padding: "10px 14px", borderRadius: 10, background: `${G.red}18`,
              border: `1px solid ${G.red}44`, color: G.red, fontSize: 13,
              marginBottom: 12,
            }}>{error}</div>
          )}

          <Button onClick={login} disabled={busy}
                  style={{ width: "100%", padding: 14, marginBottom: 10 }}>
            {busy ? "Please wait…" : "Sign in"}
          </Button>

          <Button variant="ghost" onClick={tryIt} disabled={busy} style={{ width: "100%" }}>
            Try it with a guest account
          </Button>
        </>
      )}
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
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      await Auth.requestPhoneOtp(phone.trim());
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
      const result = await Auth.verifyPhoneOtp(phone.trim(), code.trim());
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
      const result = await Auth.verifyPhoneOtp(phone.trim(), code.trim(), name.trim());
      finish(result);
    } catch (problem) {
      setError(problem.message || "Could not create your account");
    } finally {
      setBusy(false);
    }
  }

  if (step === "phone") {
    return (
      <>
        <Field label="Phone number" value={phone}
               onChange={(event) => setPhone(event.target.value)}
               placeholder="+91 98765 43210" inputMode="tel"
               onKeyDown={(event) => event.key === "Enter" && requestCode()}/>
        {error && <ErrorBox>{error}</ErrorBox>}
        <Button onClick={requestCode} disabled={busy || !phone.trim()}
                style={{ width: "100%", padding: 14 }}>
          {busy ? "Sending…" : "Send code"}
        </Button>
      </>
    );
  }

  if (step === "code") {
    return (
      <>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          We sent a code to {phone}.
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
function QrSignIn({ onAuthenticated }) {
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

  return (
    <div style={{ textAlign: "center" }}>
      <div
        // Server-generated SVG from qrcode.make() — not user input, safe to inline.
        dangerouslySetInnerHTML={{ __html: qrSvg }}
        style={{
          width: 180, height: 180, margin: "0 auto 16px", background: "#fff",
          borderRadius: 14, padding: 10, display: "flex",
          alignItems: "center", justifyContent: "center",
        }}/>

      <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 8 }}>
        Open TalkEx on a device you're already signed into →
        Settings → Linked devices → Link a device, and enter this code:
      </div>

      <div style={{
        fontSize: 24, fontWeight: 800, letterSpacing: 6, color: G.text,
        marginBottom: 16, fontFamily: "monospace",
      }}>{code}</div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
        <Spinner small/>
        <span style={{ fontSize: 12.5, color: G.sub }}>Waiting for approval…</span>
      </div>
    </div>
  );
}
