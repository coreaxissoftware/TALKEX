import { useEffect, useRef, useState } from "react";
import { Realtime } from "./api.js";

/**
 * Owns the one WebSocket for the whole app.
 *
 * The connection is created once and kept for the life of the session. Screens
 * subscribe to events through `onEvent`, which is held in a ref so that a
 * component re-rendering does not tear the socket down and open a new one —
 * that mistake is what made the old client reconnect on every keystroke-driven
 * state change.
 */
export function useRealtime(onEvent, sessionKey, onReconnect) {
  const [status, setStatus] = useState("connecting");
  const connection = useRef(null);
  const handler = useRef(onEvent);
  const reconnectHandler = useRef(onReconnect);

  // Keep the refs pointing at the latest handlers without touching the socket.
  handler.current = onEvent;
  reconnectHandler.current = onReconnect;

  useEffect(() => {
    // No session yet means there is no token to authenticate with. Connecting
    // now would just be refused; we wait for sessionKey to change instead.
    if (!sessionKey) {
      setStatus("connecting");
      return undefined;
    }

    const realtime = new Realtime({
      onEvent: (event) => handler.current?.(event),
      onStatus: setStatus,
      onReconnect: () => reconnectHandler.current?.(),
    });
    realtime.connect();
    connection.current = realtime;

    return () => {
      realtime.close();
      connection.current = null;
    };
    // Keyed on the signed-in user: one socket per session, opened as soon as
    // there is a session and torn down when it ends. An empty dependency list
    // here was a bug — the effect ran once at mount, before login, and so no
    // socket was ever opened for the account that signed in afterwards.
  }, [sessionKey]);

  return {
    status,
    typing: (chatId) => connection.current?.typing(chatId),
    // Call signaling (and anything else that needs the raw socket) goes
    // through this rather than each caller reaching into the connection
    // directly, for the same reason `typing` does.
    send: (payload) => connection.current?.send(payload) ?? false,
  };
}
