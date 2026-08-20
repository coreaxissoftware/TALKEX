import { Component } from "react";
import { G } from "./ui.jsx";

/**
 * Catches a render error so one broken screen does not blank the whole app.
 *
 * Without this, any exception thrown while rendering unmounts the entire React
 * tree and the user is left staring at an empty page with no way forward — not
 * even a reload button. React has no hook equivalent for this; a class with
 * componentDidCatch is still the only way.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep it in the console for whoever is debugging. In a deployed app this
    // is where an error reporter would go.
    console.error("Render error:", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    // A single bad message shouldn't blank the whole chat — one bubble's
    // render throwing (a malformed/legacy payload the current renderer
    // doesn't guard against, say) degrades to a small inline notice instead
    // of taking down every other message in the conversation with it.
    if (this.props.compact) {
      return (
        <div style={{
          fontSize: 12.5, fontStyle: "italic", color: G.muted, padding: "6px 2px",
        }}>
          ⚠️ This message could not be displayed
        </div>
      );
    }

    return (
      <div style={{
        minHeight: "100vh", background: G.bg, color: G.text, maxWidth: 430,
        margin: "0 auto", padding: 28, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", textAlign: "center",
        fontFamily: "'SF Pro Text',-apple-system,sans-serif",
      }}>
        <div style={{ fontSize: 40, marginBottom: 14 }}>😵</div>
        <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 8 }}>
          Something broke on this screen
        </div>
        <div style={{ fontSize: 13.5, color: G.muted, marginBottom: 22, lineHeight: 1.5 }}>
          Your messages are safe — they are stored on the server, not here.
        </div>

        <pre style={{
          fontSize: 11, color: G.red, background: G.card, padding: 12,
          borderRadius: 10, border: `1px solid ${G.border}`, maxWidth: "100%",
          overflowX: "auto", textAlign: "left", marginBottom: 20,
        }}>{String(this.state.error?.message || this.state.error)}</pre>

        <button onClick={() => window.location.reload()} style={{
          padding: "12px 22px", borderRadius: 12, border: "none", cursor: "pointer",
          background: `linear-gradient(135deg,${G.accent},${G.accentD})`,
          color: "#fff", fontSize: 14, fontWeight: 600,
        }}>Reload</button>
      </div>
    );
  }
}
