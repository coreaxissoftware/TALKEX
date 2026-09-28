import { useState } from "react";
import { G } from "./ui.jsx";
import { Meetings, setToken } from "./api.js";

/**
 * The public landing page for meet.talkex.in — a Zoom/Meet-style front door for
 * meetings, distinct from the full chat app's login. Someone with a meeting
 * link/code lands here, enters it, and is taken into the join flow (which then
 * signs them in and drops them into the meeting). Someone without a code can
 * sign in to start or schedule one.
 *
 * The meeting itself still runs inside the TalkEx app (same codebase) — this is
 * just a meeting-focused entry served at the meet.talkex.in host, so the app's
 * ordinary login isn't the first thing a meeting guest sees.
 */
export default function MeetLanding({ onContinue, onGuestJoined }) {
  const [entry, setEntry] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function parseCode(raw) {
    const text = (raw || "").trim();
    if (!text) return null;
    // A full link (…?invite=CODE or …?meeting=ID), or a bare code/id.
    try {
      const url = new URL(text);
      const invite = url.searchParams.get("invite");
      const meeting = url.searchParams.get("meeting");
      if (invite) return { kind: "invite", value: invite };
      if (meeting) return { kind: "meeting", value: meeting };
      // A path-style link like meet.talkex.in/CODE
      const seg = url.pathname.replace(/^\/+|\/+$/g, "");
      if (seg) return { kind: "invite", value: seg };
    } catch { /* not a URL — treat as a raw code */ }
    return { kind: "invite", value: text };
  }

  async function join() {
    const parsed = parseCode(entry);
    if (!parsed) return;
    setError("");
    // A ?meeting= link points at a meeting that needs a real account (it's tied
    // to a member-only chat) — route to sign-in. An ?invite= code is an ad-hoc
    // meeting room that supports guest join.
    if (parsed.kind === "meeting") {
      window.location.href = `/?meeting=${encodeURIComponent(parsed.value)}`;
      return;
    }
    setBusy(true);
    try {
      const result = await Meetings.guestJoin({ inviteCode: parsed.value, name: (name || "Guest").trim() });
      setToken(result.token);
      onGuestJoined?.(result);
    } catch (problem) {
      setBusy(false);
      // Fall back to the sign-in join flow if guest join isn't possible
      // (e.g. the link isn't an ad-hoc meeting room).
      const msg = problem?.message || "Could not join";
      if (/invalid|expired|no active/i.test(msg)) setError(msg);
      else window.location.href = `/?invite=${encodeURIComponent(parsed.value)}`;
    }
  }

  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      background: `radial-gradient(1200px 600px at 50% -10%, ${G.accent}22, transparent), ${G.bg}`,
      color: G.text,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "18px 20px" }}>
        <div style={{
          width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${G.accent}, ${G.accentD})`,
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
        }}>🎥</div>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.3 }}>
          TalkEx <span style={{ color: G.accentText, fontWeight: 700 }}>Meet</span>
        </div>
      </div>

      {/* Hero + join card */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "10px 20px 40px", gap: 26 }}>
        <div style={{ textAlign: "center", maxWidth: 520 }}>
          <h1 style={{ fontSize: 30, fontWeight: 800, margin: "0 0 10px", lineHeight: 1.15 }}>
            Secure video meetings, right from your browser
          </h1>
          <p style={{ fontSize: 15, color: G.sub, margin: 0, lineHeight: 1.5 }}>
            Join with a link or code — no download needed. End-to-end encrypted,
            powered by TalkEx.
          </p>
        </div>

        {/* Join by code / link */}
        <div style={{
          width: "100%", maxWidth: 460, background: G.surface, borderRadius: 18,
          border: `1px solid ${G.border}`, padding: 20, boxShadow: "0 10px 40px rgba(0,0,0,0.18)",
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: G.sub, marginBottom: 8 }}>Join a meeting</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            style={{
              width: "100%", boxSizing: "border-box", padding: "13px 15px", borderRadius: 12, marginBottom: 8,
              background: G.dim, border: `1px solid ${G.border}`, color: G.text, fontSize: 15, outline: "none",
            }}/>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") join(); }}
              placeholder="Paste a meeting link or code"
              style={{
                flex: 1, minWidth: 0, padding: "13px 15px", borderRadius: 12,
                background: G.dim, border: `1px solid ${G.border}`, color: G.text,
                fontSize: 15, outline: "none",
              }}/>
            <button onClick={join} disabled={!entry.trim() || busy} style={{
              padding: "0 22px", borderRadius: 12, border: "none", cursor: entry.trim() && !busy ? "pointer" : "default",
              background: entry.trim() && !busy ? `linear-gradient(135deg, ${G.accent}, ${G.accentD})` : G.dim,
              color: "#fff", fontSize: 15, fontWeight: 700, opacity: entry.trim() && !busy ? 1 : 0.6, whiteSpace: "nowrap",
            }}>{busy ? "Joining…" : "Join"}</button>
          </div>
          {error && <div style={{ marginTop: 8, fontSize: 12.5, color: G.red || "#e5484d" }}>{error}</div>}
          <div style={{ marginTop: 8, fontSize: 11.5, color: G.muted }}>
            No account needed — join as a guest with just your name.
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0" }}>
            <div style={{ flex: 1, height: 1, background: G.border }}/>
            <span style={{ fontSize: 12, color: G.muted }}>or</span>
            <div style={{ flex: 1, height: 1, background: G.border }}/>
          </div>

          <button onClick={onContinue} style={{
            width: "100%", padding: "13px", borderRadius: 12, border: `1px solid ${G.accent}`,
            background: G.accentSoft, color: G.accentText, fontSize: 15, fontWeight: 700, cursor: "pointer",
          }}>
            Sign in to start or schedule a meeting
          </button>
        </div>

        {/* Feature row */}
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", justifyContent: "center", maxWidth: 560, color: G.sub, fontSize: 13 }}>
          <span>🔒 End-to-end encrypted</span>
          <span>👥 Group calls & screen share</span>
          <span>📅 Schedule with auto links</span>
        </div>
      </div>

      <div style={{ textAlign: "center", padding: "0 20px 24px", fontSize: 12, color: G.muted }}>
        Made with ❤️ by CoreAxis Software · <a href="https://web.talkex.in" style={{ color: G.accentText, textDecoration: "none" }}>Open full TalkEx</a>
      </div>
    </div>
  );
}
