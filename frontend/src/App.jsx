import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError, Auth, Calls, Chats, Contacts, E2EE, Me, Meetings, Messages, Scheduled, Search, Users,
  clearToken, flushEverything, getToken, rememberAccount,
  storedRefDm, clearRefDm, storedPhoneLink, storedPhoneText, clearPhoneLink,
} from "./api.js";
import { initE2EE, clearE2EEKeys } from "./e2ee.js";
import { initNativePush, stopNativePush } from "./pushNative.js";
import { getAllContacts } from "./nativeContacts.js";
import { useRealtime } from "./useRealtime.js";
import { useCall } from "./useCall.js";
import { useGroupCall } from "./useGroupCall.js";
import { useGroupCallSfu } from "./useGroupCallSfu.js";
import { Sfu } from "./api.js";
import {
  Button, ChatBackdrop, Field, G, I, Screen, Spinner, useIsDesktop, useViewportHeightVar,
  applyTheme, getStoredAccent, getStoredTheme, saveAccent, saveTheme,
} from "./ui.jsx";
import { getAppLockTimeout, isAppLockEnabled, isBiometricEnabled, verifyAppLockPin, verifyBiometric } from "./appLock.js";
import { playNotifyTone } from "./notifyTone.js";
import { useT } from "./i18n.jsx";
import * as offlineDb from "./offlineDb.js";

import ChatList from "./screens/ChatList.jsx";
import ChatView from "./screens/ChatView.jsx";
import Login from "./screens/Login.jsx";

const AdminPanel = lazy(() => import("./screens/AdminPanel.jsx"));
const CallOverlay = lazy(() => import("./screens/CallOverlay.jsx"));
const CallsScreen = lazy(() => import("./screens/Calls.jsx"));
const GroupCallOverlay = lazy(() => import("./screens/GroupCallOverlay.jsx"));
const Discover = lazy(() => import("./screens/Discover.jsx"));
const Planner = lazy(() => import("./screens/Planner.jsx"));
const Settings = lazy(() => import("./screens/Settings.jsx"));
const Status = lazy(() => import("./screens/Status.jsx"));

// Plain content comparison for reloadChats below — a chat list is small
// (tens of rows, not thousands), so JSON.stringify is cheap enough here and
// correct by construction, unlike hand-picking "the fields that matter"
// and inevitably missing one the next time a chat field gets added.
function sameChats(a, b) {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

// "Discover" (people/contacts/channels/communities/join-via-code) used to be
// its own bottom tab. It's really a set of "start something new" actions, not
// a place you go back to — so it now lives behind the "+" button on Chats
// (DiscoverOverlay) instead of costing the nav a whole slot.
const TAB_KEYS = [
  { key: "chats", i18n: "nav.chats", icon: I.chat },
  { key: "calls", i18n: "nav.calls", icon: I.phone },
  { key: "status", i18n: "nav.status", icon: I.status },
  { key: "planner", i18n: "nav.planner", icon: I.calendar },
  { key: "settings", i18n: "nav.settings", icon: I.settings },
];

/**
 * The shell: authentication, the tab bar, and the one WebSocket.
 *
 * v1 was a single 900-line component holding every screen and every piece of
 * state. Splitting it means opening a chat no longer re-renders the settings
 * page, and each screen can be read on its own.
 */
export default function App() {
  const isDesktop = useIsDesktop();
  // Keep --app-height tracking the space above the keyboard so the bottom nav
  // and message composer never overlap it or float over it (see the hook).
  useViewportHeightVar();
  const [me, setMe] = useState(null);
  const [reactivatePending, setReactivatePending] = useState(false);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState("chats");
  const [chats, setChats] = useState([]);
  const [loadingChats, setLoadingChats] = useState(true);
  const [openChat, setOpenChat] = useState(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [chatListMenuPos, setChatListMenuPos] = useState(null); // { x, y } — the chat list's own ⋮ button lives in TopBar now, not inside ChatList itself
  const [newCallOpen, setNewCallOpen] = useState(false); // Calls tab's "New call" button lives in TopBar too
  const [callsMenuPos, setCallsMenuPos] = useState(null); // { x, y } — the Calls tab's own ⋮ menu, same idea as chatListMenuPos
  const [events, setEvents] = useState([]);
  const [typingBy, setTypingBy] = useState({});
  const [toastText, setToastText] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const typingTimers = useRef({});
  const eventCounter = useRef(0);
  const reloadTimer = useRef(null);
  const plannerReloadTimer = useRef(null);
  const [reconnectedAt, setReconnectedAt] = useState(0);
  const [sfuEnabled, setSfuEnabled] = useState(false);
  useEffect(() => { Sfu.config().then((c) => setSfuEnabled(c.enabled)).catch(() => {}); }, []);
  const [theme, setThemeState] = useState(getStoredTheme);
  const [accent, setAccentState] = useState(getStoredAccent);
  const [settingsNavDepth, setSettingsNavDepth] = useState(0);
  const settingsGoBackRef = useRef(null);

  // The "chat with N people to earn the blue tick" nudge — { chatted_with,
  // target } while still working toward it, cleared (never re-fetched) once
  // me.blue_tick is true. Deliberately component state, not persisted to
  // localStorage: the ask was "every time the app opens, until earned",
  // and a fresh mount is exactly what "the app opens" means here — a
  // dismiss should not suppress it forever, only until the next open.
  const [blueTickNudge, setBlueTickNudge] = useState(null);
  const [blueTickCelebrate, setBlueTickCelebrate] = useState(false);

  // Chats unlocked with a PIN this session. Deliberately not persisted — the
  // whole point of a lock is that it re-engages the next time the app is
  // actually reopened, not just the next time this component re-renders.
  const [unlockedChats, setUnlockedChats] = useState(() => new Set());

  // App-wide passcode lock — device-local, separate from account sign-in.
  // Starts locked whenever the setting is on, so a fresh page load (or a
  // browser that was closed and reopened) always asks first.
  const [appLocked, setAppLocked] = useState(isAppLockEnabled);
  const hiddenAt = useRef(0);

  useEffect(() => {
    // isAppLockEnabled() is checked INSIDE the handler, on every visibility
    // change, rather than once here at mount. The old version bailed out of
    // attaching the listener at all when the lock happened to be off on
    // first render — so a user who turned it on mid-session (Settings just
    // writes to localStorage; it doesn't tell this component) got a "app
    // lock turned on" toast for a listener that was never actually
    // attached, and backgrounding the tab silently never re-locked for the
    // rest of that session.
    function onVisibility() {
      if (!isAppLockEnabled()) return;
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
      } else if (hiddenAt.current) {
        const awayMs = Date.now() - hiddenAt.current;
        if (awayMs >= getAppLockTimeout() * 1000) setAppLocked(true);
        hiddenAt.current = 0;
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Runs on every render, including the first, so G's colors always match
  // `theme`/`accent` before any child component reads them this pass. Cheap
  // and idempotent — assigning the same values twice (StrictMode's
  // double-render) changes nothing.
  applyTheme(theme, accent);

  const setTheme = useCallback((mode) => {
    saveTheme(mode);
    setThemeState(mode);
  }, []);

  const setAccent = useCallback((accentKey) => {
    saveAccent(accentKey);
    setAccentState(accentKey);
  }, []);

  // The body element sits outside anything React styles (Screen only covers
  // its own div), so overscroll-bounce areas on mobile would keep showing the
  // old theme's color without this.
  useEffect(() => {
    document.body.style.background = G.bg;
  }, [theme]);

  const toastTimer = useRef(null);
  const toast = useCallback((text) => {
    setToastText(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(""), 2200);
  }, []);

  // Reachable straight from the desktop rail, not just buried in Settings →
  // Account — same real sign-out (revokes the session server-side first),
  // just one click away instead of three.
  const signOut = useCallback(async () => {
    await stopNativePush(); // stop this device receiving FCM push
    try { await Auth.logout(); } catch { /* the token is going away regardless */ }
    clearToken();
    setMe(null);
    setChats([]);
    setTab("chats");
  }, []);

  // ── Session ────────────────────────────────────────────────────────────────

  // Native (Android) FCM push: register once signed in. Tapping a push opens
  // that chat. No-op on web (which uses the Web Push path).
  useEffect(() => {
    if (!me?.id) return;
    initNativePush(async (chatId) => {
      setTab("chats");
      try { const chat = await Chats.get(chatId); if (chat) setOpenChat(chat); } catch { /* ignore */ }
    });
  }, [me?.id]);

  // Request all runtime permissions upfront on native Android so the user
  // approves them once right after sign-in instead of being surprised later.
  useEffect(() => {
    if (!me?.id) return;
    const PERM_KEY = "talkex_permissions_requested";
    if (localStorage.getItem(PERM_KEY)) return;
    localStorage.setItem(PERM_KEY, "1");
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch { /* user denied or no device — fine */ }
      try { navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 1 }); } catch {}
    })();
  }, [me?.id]);

  // Initialize E2EE after user is loaded
  useEffect(() => {
    if (me && getToken()) {
      initE2EE(E2EE.uploadKeys).catch(() => {
        // E2EE init is best-effort — the app works without it
        console.warn("E2EE initialization skipped (non-fatal)");
      });
    }
  }, [me]);

  // WhatsApp-style contact auto-sync: on app open, read the device address
  // book and match phone numbers against TalkEx users. New matches are added
  // as contacts automatically. Only runs on native Android (getAllContacts
  // returns null elsewhere) and at most once per hour to avoid hammering.
  useEffect(() => {
    if (!me) return;
    const SYNC_KEY = "talkex_last_contact_sync";
    const ONE_HOUR = 60 * 60 * 1000;
    const last = parseInt(localStorage.getItem(SYNC_KEY) || "0", 10);
    if (Date.now() - last < ONE_HOUR) return;
    (async () => {
      const deviceContacts = await getAllContacts();
      if (!deviceContacts || deviceContacts.length === 0) return;
      const phones = deviceContacts
        .map((c) => (c.tel || [])[0])
        .filter(Boolean);
      if (phones.length === 0) return;
      const matched = await Users.matchContacts(phones);
      if (!matched || matched.length === 0) {
        localStorage.setItem(SYNC_KEY, String(Date.now()));
        return;
      }
      const existing = await Contacts.list();
      const existingUserIds = new Set(existing.filter((c) => c.user).map((c) => c.user.id));
      for (const user of matched) {
        if (existingUserIds.has(user.id)) continue;
        const name = deviceContacts.find((c) =>
          (c.tel || []).some((t) => {
            const dA = t.replace(/\D/g, "");
            const dB = (user.phone || "").replace(/\D/g, "");
            return dA && dB && (dA.endsWith(dB.slice(-10)) || dB.endsWith(dA.slice(-10)));
          })
        )?.name?.[0] || user.name;
        try { await Contacts.add(name, user.phone); } catch { /* duplicate or other — skip */ }
      }
      localStorage.setItem(SYNC_KEY, String(Date.now()));
    })().catch(() => {});
  }, [me]);

  useEffect(() => {
    if (!getToken()) { setChecking(false); return; }
    Me.get()
      .then(setMe)
      .catch((error) => {
        // A real 401 means the token itself is invalid or expired — signing
        // out is correct. Anything else (no route to the server at all,
        // fetch() rejecting before a status code ever exists) proves
        // nothing about the session — it just means nothing could be
        // confirmed right now. Falling back to the profile cached from the
        // last successful check keeps a genuinely signed-in, merely
        // offline user in the app, the way WhatsApp opens straight to your
        // chats with no signal instead of asking you to sign in again.
        if (error instanceof ApiError && error.status === 401) {
          setMe(null);
          return;
        }
        setMe(offlineDb.getCachedProfile());
      })
      .finally(() => setChecking(false));
  }, []);

  const reloadChats = useCallback(() => {
    if (!getToken()) return;
    // Every realtime event that touches a chat (a new message, a read
    // receipt, someone's online status) used to call this, and this always
    // called setChats with a BRAND NEW array from IndexedDB/the network —
    // even when the data that came back was byte-for-byte identical to
    // what was already on screen. React can't tell "same content, new
    // array" from "actually changed" on its own, so a busy conversation
    // (read receipts alone can fire every few seconds) re-rendered the
    // entire chat list over and over, which is what showed up as the list
    // visibly reflowing/flickering with nothing having actually changed.
    // Bailing out with the PREVIOUS reference when the JSON is identical
    // is what actually stops that re-render, not just deduping the fetch.
    offlineDb.getChats().then((cached) => {
      if (cached.length > 0) {
        setChats((current) => sameChats(current, cached) ? current : cached);
        setLoadingChats(false);
      }
    });
    Chats.list()
      .then((fresh) => setChats((current) => sameChats(current, fresh) ? current : fresh))
      .catch(() => {})
      .finally(() => setLoadingChats(false));
  }, []);

  // A busy chat delivers messages faster than the list needs redrawing, and
  // refetching every chat on each one is wasted work. Collapse a burst into a
  // single reload shortly after it stops.
  const reloadChatsSoon = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(reloadChats, 400);
  }, [reloadChats]);

  useEffect(() => {
    if (me) reloadChats();
  }, [me, reloadChats]);

  // A "Send call link" (or a plain group invite link) lands here as
  // ?invite=<code> — joining is idempotent server-side (INSERT OR IGNORE),
  // so re-visiting an already-used link just opens the chat again rather
  // than erroring.
  useEffect(() => {
    if (!me) return;
    const code = new URLSearchParams(window.location.search).get("invite");
    if (!code) return;
    window.history.replaceState(null, "", window.location.pathname);
    Chats.joinViaInvite(code)
      .then(({ chat_id }) => {
        reloadChats();
        return Chats.get(chat_id);
      })
      .then(setOpenChat)
      .catch((problem) => toast(problem.message || "That call link is invalid or expired"));
  }, [me]);

  // A meeting's "Copy link" button (Planner/ChatView) shares
  // ?meeting=<id> — same idea as ?invite= above, just for jumping straight
  // to an already-scheduled meeting's chat instead of joining a new one.
  // Unlike an invite link this never grants NEW chat access — GET
  // /meetings/{id} still 404s for anyone who isn't already a member, same
  // as opening the chat any other way. Lands on the chat with the meeting
  // card right there rather than auto-joining the call sight unseen.
  useEffect(() => {
    if (!me) return;
    const meetingId = new URLSearchParams(window.location.search).get("meeting");
    if (!meetingId) return;
    window.history.replaceState(null, "", window.location.pathname);
    Meetings.get(meetingId)
      .then((meeting) => Chats.get(meeting.chat_id))
      .then(setOpenChat)
      .catch((problem) => toast(problem.message || "That meeting link is invalid or you don't have access"));
  }, [me]);

  // A scanned "add me" QR / profile link lands here as ?user=<username> —
  // resolve it to that account and open a DM, so scanning someone's code
  // starts a chat straight away (WhatsApp's my-QR flow).
  useEffect(() => {
    if (!me) return;
    const username = new URLSearchParams(window.location.search).get("user");
    if (!username) return;
    window.history.replaceState(null, "", window.location.pathname);
    Users.list(username)
      .then((matches) => {
        const person = (matches || []).find((u) => u.username?.toLowerCase() === username.toLowerCase());
        if (!person) throw new Error("No account with that username");
        return Chats.dm(person.id);
      })
      .then((chat) => { reloadChats(); setOpenChat(chat); })
      .catch((problem) => toast(problem.message || "That profile link is invalid"));
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const refUsername = storedRefDm();
    if (!refUsername) return;
    clearRefDm();
    Users.list(refUsername)
      .then((matches) => {
        const person = (matches || []).find((u) => u.username?.toLowerCase() === refUsername.toLowerCase());
        if (!person || person.id === me.id) return;
        return Chats.dm(person.id);
      })
      .then((chat) => { if (chat) { reloadChats(); setOpenChat(chat); } })
      .catch(() => {});
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const chatId = new URLSearchParams(window.location.search).get("chat");
    if (!chatId) return;
    window.history.replaceState(null, "", window.location.pathname);
    Chats.get(chatId).then(setOpenChat).catch(() => {});
  }, [me]);

  useEffect(() => {
    if (!me) return;
    const phone = storedPhoneLink();
    if (!phone) return;
    const prefill = storedPhoneText();
    clearPhoneLink();
    Users.byPhone(phone)
      .then((person) => {
        if (!person || person.id === me.id) return null;
        return Chats.dm(person.id);
      })
      .then((chat) => {
        if (!chat) return;
        reloadChats();
        if (prefill) chat.draft = prefill;
        setOpenChat(chat);
      })
      .catch(() => toast("No TalkEx account found for that number"));
  }, [me]);

  // Just a count for the tab badge — Planner itself fetches the real lists.
  // "What have I got waiting" mirrors Planner's own framing of the screen:
  // upcoming meetings plus messages still queued to send.
  const [plannerCount, setPlannerCount] = useState(0);
  const reloadPlannerCountNow = useCallback(() => {
    if (!getToken()) return;
    Promise.all([Meetings.mine(true), Scheduled.list()])
      .then(([upcoming, pending]) => setPlannerCount(upcoming.length + pending.length))
      .catch(() => {});
  }, []);

  // Same coalescing reloadChatsSoon above uses: a burst of meeting events
  // (several RSVPs on one meeting, a few scheduled sends failing around the
  // same time) used to fire one full pair of requests PER EVENT instead of
  // one for the whole burst.
  const reloadPlannerCount = useCallback(() => {
    clearTimeout(plannerReloadTimer.current);
    plannerReloadTimer.current = setTimeout(reloadPlannerCountNow, 400);
  }, [reloadPlannerCountNow]);

  useEffect(() => {
    if (me) reloadPlannerCount();
  }, [me, reloadPlannerCount]);

  // Missed calls: ones placed TO this user that never completed, since the
  // last time the Calls tab was opened. `calls_seen_at` is a single
  // watermark on the user row — the call log spans every chat, so there's
  // no one chat's last_read_seq this could piggyback on.
  const [missedCalls, setMissedCalls] = useState(0);
  const reloadMissedCalls = useCallback(() => {
    if (!getToken()) return;
    Calls.missedCount().then(({ count }) => setMissedCalls(count)).catch(() => {});
  }, []);

  useEffect(() => {
    if (me) reloadMissedCalls();
  }, [me, reloadMissedCalls]);

  // Switching to Calls clears the badge — same "opening it is what marks it
  // read" idea as a phone's own call log — everywhere the tab is changed
  // (mobile tab bar, desktop rail both funnel through this).
  const changeTab = useCallback((key) => {
    setTab(key);
    setSearchResults(null);
    if (key !== "settings") { setSettingsNavDepth(0); settingsGoBackRef.current = null; }
    if (key === "calls" && missedCalls > 0) {
      setMissedCalls(0);
      Calls.markSeen().catch(() => {});
    }
  }, [missedCalls]);

  // ── Hardware / browser back button ───────────────────────────────────────────
  //
  // Wrapped in Capacitor (Android), the app is a single WebView. Android's
  // hardware back button, by default, exits the whole app the moment the
  // WebView has no page history to go back through — and this SPA never
  // navigated between real pages, so it had none. That's why one back press
  // closed everything instead of stepping back one screen at a time.
  //
  // The fix models the app's own navigation depth with synthetic History API
  // entries: each open "layer" (a non-default tab, an open chat, the Discover
  // sheet, a search results view) pushes one entry, and pressing back pops the
  // topmost layer instead of exiting. Only when every layer is closed does a
  // further back finally leave the app — exactly the step-by-step behaviour a
  // native app has. Works in a desktop browser too (the browser Back button
  // drives the same popstate), so there's nothing Capacitor-specific here.
  const backLayers = [];
  if (tab !== "chats" && !openChat) backLayers.push(() => {
    if (tab === "settings" && settingsGoBackRef.current) { settingsGoBackRef.current(); return; }
    changeTab("chats");
  });
  if (tab === "settings" && settingsNavDepth > 0) {
    for (let i = 0; i < settingsNavDepth; i++) {
      backLayers.push(() => settingsGoBackRef.current?.());
    }
  }
  if (openChat) backLayers.push(() => setOpenChat(null));
  if (discoverOpen) backLayers.push(() => setDiscoverOpen(false));
  if (searchResults) backLayers.push(() => setSearchResults(null));

  const backLayersRef = useRef([]);
  backLayersRef.current = backLayers;
  const backDepth = useRef(0);
  const suppressPop = useRef(0);

  // Keep the number of synthetic history entries equal to the number of open
  // layers. Growing: push entries as layers open. Shrinking because the UI
  // itself closed a layer (an on-screen ✕/back arrow, not the hardware
  // button): quietly consume the now-extra history entries with history.go,
  // flagging suppressPop so our own popstate handler ignores those.
  useEffect(() => {
    const target = backLayers.length;
    const current = backDepth.current;
    if (target > current) {
      for (let i = current; i < target; i += 1) window.history.pushState({ htLayer: i + 1 }, "");
      backDepth.current = target;
    } else if (target < current) {
      suppressPop.current += current - target;
      backDepth.current = target;
      window.history.go(-(current - target));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backLayers.length]);

  useEffect(() => {
    function onPop() {
      if (suppressPop.current > 0) { suppressPop.current -= 1; return; }
      const layers = backLayersRef.current;
      if (layers.length === 0) return;
      backDepth.current = layers.length - 1;
      layers[layers.length - 1]();
    }
    window.addEventListener("popstate", onPop);

    // On Android (Capacitor), the hardware back button bypasses popstate when
    // the WebView history is empty and exits the app immediately. The
    // @capacitor/app plugin intercepts it BEFORE the WebView processes it, so
    // we can close layers instead of exiting.
    let capCleanup;
    import("@capacitor/app").then(({ App }) => {
      App.addListener("backButton", ({ canGoBack }) => {
        const layers = backLayersRef.current;
        if (layers.length > 0) {
          backDepth.current = Math.max(0, backDepth.current - 1);
          layers[layers.length - 1]();
        } else if (canGoBack) {
          window.history.back();
        } else {
          App.minimizeApp();
        }
      }).then((handle) => { capCleanup = handle; });
    }).catch(() => {});

    return () => {
      window.removeEventListener("popstate", onPop);
      capCleanup?.remove();
    };
  }, []);

  // ── Realtime ───────────────────────────────────────────────────────────────

  const onEvent = useCallback((event) => {
    // Each event gets a number so a screen can tell which ones it has already
    // applied. Without it a screen can only look at the newest event, and a
    // burst of two arriving between renders loses the earlier one.
    eventCounter.current += 1;

    // Keep a short tail rather than every event ever: an unbounded array is a
    // slow memory leak in a long-lived session.
    setEvents((current) => [...current.slice(-40), { ...event, _n: eventCounter.current }]);

    if (event.type === "typing") {
      // Keyed by chat, holding {userId: name} — a group needs to know WHO is
      // typing, not just that the chat has activity, so this can't collapse
      // to a boolean the way a single flag per chat used to.
      setTypingBy((current) => ({
        ...current,
        [event.chat_id]: { ...current[event.chat_id], [event.user_id]: event.name },
      }));
      const timerKey = `${event.chat_id}:${event.user_id}`;
      clearTimeout(typingTimers.current[timerKey]);
      typingTimers.current[timerKey] = setTimeout(() => {
        setTypingBy((current) => {
          const forChat = { ...current[event.chat_id] };
          delete forChat[event.user_id];
          return { ...current, [event.chat_id]: forChat };
        });
      }, 4000);
      return;
    }

    // Anything that changes a chat's last message or unread count — plus a
    // rename / new photo / owner change / membership change, so the open chat's
    // header (name & photo come from the chats list) updates live instead of
    // only on reopen.
    if (["message", "message_deleted", "message_expired", "read",
         "chat_updated", "chat_owner_changed", "members_changed"].includes(event.type)) {
      reloadChatsSoon();
    }
    // chat_updated on the chat that's currently OPEN needs an immediate
    // refetch, not just the sidebar reload above — e.g. the other member
    // flipping Vanish mode on should show up in this open chat's own
    // per-member fields right away, not only after leaving and reopening it.
    if (event.type === "chat_updated" && event.chat_id && openChat?.id === event.chat_id) {
      Chats.get(event.chat_id).then((chat) => { if (chat) setOpenChat(chat); }).catch(() => {});
    }

    // A DM peer going online/offline — patched into whichever chat objects
    // already know that peer_id, live, rather than waiting for the next
    // reloadChats. Without this, GET /chats' peer_online/peer_last_seen
    // was only ever as fresh as the last full reload — right after opening
    // the app, but stale for as long as a chat stayed open after that.
    if (event.type === "presence") {
      const patch = (chat) => (chat.peer_id === event.user_id
        ? { ...chat, peer_online: event.online, peer_last_seen: event.last_seen }
        : chat);
      setChats((current) => current.map(patch));
      setOpenChat((current) => (current ? patch(current) : current));
    }

    // Mirrored into the offline store as it arrives, not just when a chat is
    // opened — otherwise a message that lands while you're on a different
    // screen (or a different chat entirely) would be invisible offline until
    // you happened to reopen that conversation once more while online.
    if (event.type === "message" && event.message?.chat_id) {
      offlineDb.saveMessages(event.message.chat_id, [event.message]).catch(() => {});
    }

    // Acknowledge delivery of any message received from someone else — whether
    // or not its chat is open — so the sender's single tick flips to a double
    // while we're connected. (Messages that arrived while we were offline get
    // backfilled server-side the moment the socket reconnects.)
    if (event.type === "message" && event.message && event.message.sender_id !== me?.id
        && event.message.seq && event.message.chat_id) {
      Chats.markDelivered(event.message.chat_id, event.message.seq).catch(() => {});
    }

    // A call log entry for a call placed TO this user — refresh the missed
    // count so it doesn't wait for the next sign-in/reload. Calls the user
    // placed themselves never move this badge either way. Already sitting
    // on the Calls tab counts as having seen it immediately, same as
    // switching there does.
    if (event.type === "message" && event.message?.kind === "call" && event.message.sender_id !== me?.id) {
      if (tab === "calls") Calls.markSeen().catch(() => {});
      else reloadMissedCalls();
    }

    // This chat's own in-app tone (Settings > per-chat > Notification
    // sound) — plays for any incoming message regardless of which screen is
    // open, same as a phone's message tone would, as long as the chat isn't
    // muted. A muted chat plays nothing here no matter what tone is set;
    // muting is the stronger, chat-wide "silence this" switch.
    if (event.type === "message" && event.message && event.message.sender_id !== me?.id) {
      const chat = chats.find((c) => c.id === event.message.chat_id);
      const muted = (chat?.muted_until || 0) > Date.now() / 1000;
      if (!muted) playNotifyTone(chat?.notify_tone);
    }

    // A mention while that chat isn't the one currently open — surfaced the
    // same way a meeting reminder is. The chat being open already shows the
    // message on screen, so there is nothing this toast would add there.
    if (event.type === "message" && me?.username && event.message?.sender_id !== me.id) {
      const mentioned = (event.message.text || "").includes(`@${me.username}`);
      if (mentioned && openChat?.id !== event.message.chat_id) {
        const chat = chats.find((c) => c.id === event.message.chat_id);
        toast(`💬 You were mentioned in ${chat?.name || "a chat"}`);
      }
    }

    if (event.type === "meeting_reminder") {
      toast(`📅 ${event.title} starts ${event.minutes_away ? `in ${event.minutes_away} min` : "now"}`);
    }
    if (event.type === "meeting_started") {
      toast(`📅 ${event.title} has started`);
    }
    if (event.type === "scheduled_message_failed") {
      toast(`A scheduled message was not sent: ${event.error}`);
    }

    // Pushed once, the instant maybe_award_blue_tick's DM-count check
    // crosses BLUE_TICK_TARGET server-side — updates the badge everywhere
    // it's shown (profile, chat headers) without waiting for the next GET
    // /me, and swaps the ongoing "N/10" nudge for a one-time celebration
    // instead of it just quietly disappearing.
    if (event.type === "blue_tick_awarded") {
      setMe((current) => (current ? { ...current, blue_tick: true } : current));
      setBlueTickNudge(null);
      setBlueTickCelebrate(true);
    }

    // Anything that changes what Planner's badge is counting.
    if ([
      "meeting_created", "meeting_updated", "meeting_cancelled", "meeting_started",
      "meeting_ended", "scheduled_message_failed",
    ].includes(event.type)) {
      reloadPlannerCount();
    }
  }, [reloadChatsSoon, reloadPlannerCount, reloadMissedCalls, toast, me, openChat, chats, tab]);

  // Fired when a dropped socket comes back. Bumping the timestamp is what tells
  // the open chat to fetch everything it missed while the connection was down.
  const onReconnect = useCallback(() => {
    reloadChats();
    setReconnectedAt(Date.now());
  }, [reloadChats]);

  // Keyed on the user id so the socket opens the moment someone signs in and
  // is replaced if a different account signs in later.
  const realtime = useRealtime(onEvent, me?.id, onReconnect);
  const call = useCall(events, realtime.send, toast);
  const groupCallMesh = useGroupCall(sfuEnabled ? [] : events, realtime.send, toast, reconnectedAt);
  const groupCallSfu = useGroupCallSfu(sfuEnabled ? events : [], realtime.send, toast);
  const groupCall = sfuEnabled ? groupCallSfu : groupCallMesh;

  // "Add participant" during a 1:1 call: spin up a hidden ephemeral call room
  // holding the current peer + whoever's being added, end the 1:1, and start a
  // group call there — everyone gets rung by the usual group_call flow.
  const addParticipantToCall = useCallback(async (userIds) => {
    const active = call.call;
    if (!active?.peerId) return;
    const kind = active.callKind || "video";
    try {
      const room = await Chats.createCallRoom([active.peerId, ...userIds], "Group call");
      call.endCall();
      await groupCall.join(room.id, kind);
    } catch (problem) {
      toast(problem.message || "Could not add participant");
    }
  }, [call, groupCall, toast]);

  // The composer fires this instead of importing the connection directly, so
  // typing signals do not force the socket through the component tree.
  useEffect(() => {
    const onTyping = (event) => realtime.typing(event.detail);
    window.addEventListener("ht:typing", onTyping);
    return () => window.removeEventListener("ht:typing", onTyping);
  }, [realtime]);

  // A dropped token cannot be fixed by reconnecting, so send them to sign in.
  useEffect(() => {
    if (realtime.status === "unauthorized") setMe(null);
  }, [realtime.status]);

  // The blue-tick nudge, checked once per app open — keyed on me?.id rather
  // than the whole `me` object so a profile edit elsewhere doesn't re-fire
  // this. Skipped entirely once me.blue_tick is true, so an account that
  // already has the badge never makes this call at all. appLocked/
  // reactivatePending are excluded on purpose: this only needs to run once
  // the person is actually looking at their chats, not while still staring
  // at a PIN screen.
  useEffect(() => {
    if (!me || me.blue_tick || appLocked || reactivatePending) return;
    let cancelled = false;
    Me.blueTickProgress().then((progress) => {
      if (cancelled || progress.earned) return;
      setBlueTickNudge(progress);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, me?.blue_tick, appLocked, reactivatePending]);

  // Anything queued while offline goes out as soon as the tab is visible
  // again — flushEverything covers the plain-text Outbox, queued
  // photo/video/voice/document sends, and every queued react/edit/delete/
  // vote/pin/star/mark-read action, in that order, all through the same
  // real network calls the online path uses (so a 4xx drops the item
  // instead of retrying forever, exactly like the original text-only
  // Outbox already did).
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== "visible") return;
      flushEverything().then(reloadChats);
      // Also re-confirms the session now that a real connection exists —
      // the offline fallback above trusts a cached profile on faith; this
      // is what catches the rare case where the token was actually revoked
      // (signed out elsewhere, account deleted) while this device had no
      // way to find out.
      Me.get().then(setMe).catch((error) => {
        if (error instanceof ApiError && error.status === 401) {
          clearToken();
          setMe(null);
        }
      });
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("online", flush);
    // The service worker's Background Sync handler can't reach the network
    // itself (it has no page and no auth token — see service-worker.js's
    // own comment on why), so it wakes any open tab with this message
    // instead and lets that tab's own, already-correct flush do the work.
    function onSwMessage(event) {
      if (event.data?.type === "flush") flush();
      if (event.data?.type === "openChat" && event.data.chatId) {
        Chats.get(event.data.chatId).then(setOpenChat).catch(() => {});
      }
    }
    navigator.serviceWorker?.addEventListener?.("message", onSwMessage);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("online", flush);
      navigator.serviceWorker?.removeEventListener?.("message", onSwMessage);
    };
  }, [reloadChats]);

  // Warms the offline mirror for every chat, not just the ones you happen
  // to open — otherwise a chat you'd never actually looked at while online
  // would have no history at all the next time you're offline. Runs after
  // a successful chat list load (so it's inherently online already), one
  // chat at a time and quietly: a slow or failing fetch here must never
  // show a spinner or a toast, since nothing about this is a foreground
  // action the person asked for.
  useEffect(() => {
    if (chats.length === 0) return;
    let cancelled = false;
    let idleHandle = null;
    let timer = null;

    // This warm-up used to fire a back-to-back burst of fetch()+IndexedDB
    // writes for EVERY chat the instant the list loaded — cheap in a desktop
    // browser, but on the Android WebView (Capacitor) that same burst lands
    // right on top of first paint and the initial socket/E2EE setup, and the
    // single-threaded WebView visibly froze for a few seconds on accounts
    // with many chats. That's the "app hangs but the browser is fine"
    // difference. Two changes fix it without dropping the feature: wait for
    // the WebView to go idle before starting, and yield ~120ms between each
    // chat so the main thread stays free for taps and scrolling throughout.
    const start = () => {
      (async () => {
        for (const chat of chats) {
          if (cancelled) return;
          await Messages.list(chat.id).catch(() => {});
          await new Promise((resolve) => { timer = setTimeout(resolve, 120); });
        }
      })();
    };

    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(start, { timeout: 4000 });
    } else {
      timer = setTimeout(start, 1200);
    }

    return () => {
      cancelled = true;
      if (idleHandle != null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleHandle);
      if (timer != null) clearTimeout(timer);
    };
    // Deliberately keyed on the chat id list, not the whole `chats` array
    // (which gets a new reference on every unread-count tick) — this only
    // needs to re-run when the SET of chats actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats.map((c) => c.id).join(",")]);

  // Update the browser tab title with the total unread count.
  useEffect(() => {
    const total = chats.reduce((sum, c) => sum + (c.unread || 0), 0);
    document.title = total > 0 ? `(${total}) TalkEx` : "TalkEx";
  }, [chats]);

  // ── Render ─────────────────────────────────────────────────────────────────

  if (checking) return <Screen style={{ justifyContent: "center" }}><Spinner/></Screen>;

  if (!me) {
    return <Login onAuthenticated={(user, accountDisabled) => {
      rememberAccount(user, getToken());
      setMe(user);
      setLoadingChats(true);
      setReactivatePending(accountDisabled);
    }}/>;
  }

  if (appLocked) {
    return <AppLockScreen onUnlocked={() => setAppLocked(false)}
                          onSignOut={() => { clearToken(); setMe(null); setAppLocked(false); }}/>;
  }

  if (reactivatePending) {
    return (
      <ReactivateGate onReactivated={() => setReactivatePending(false)}
                      onSignOut={() => {
                        clearToken();
                        setMe(null);
                        setReactivatePending(false);
                      }}/>
    );
  }

  // Only ever added for an account the server itself flagged is_superadmin
  // (see main.py's start_session/SUPERADMIN_USERNAME) — nothing client-side
  // grants this, it just decides whether to show the door, not who may
  // walk through it. Every /admin/* call is re-checked server-side anyway.
  const tabs = me?.is_superadmin ? [...TAB_KEYS, { key: "admin", i18n: null, label: "Admin", icon: I.shield }] : TAB_KEYS;

  if (isDesktop) {
    return (
      <DesktopShell
        tab={tab} onTabChange={changeTab}
        chats={chats} loadingChats={loadingChats} typingBy={typingBy}
        onOpenChat={setOpenChat} openChat={openChat} unlockedChats={unlockedChats}
        onUnlockChat={(chatId) => setUnlockedChats((current) => new Set(current).add(chatId))}
        onRelockChat={(chatId) => setUnlockedChats((current) => {
          const next = new Set(current);
          next.delete(chatId);
          return next;
        })}
        reloadChats={reloadChats} toast={toast}
        searchResults={searchResults} onSearchResultsChange={setSearchResults}
        me={me} onMeUpdated={setMe} theme={theme} onThemeChange={setTheme}
        accent={accent} onAccentChange={setAccent}
        onSignedOut={() => { setMe(null); setChats([]); setTab("chats"); }}
        realtime={realtime} events={events} reconnectedAt={reconnectedAt}
        call={call} groupCall={groupCall} toastText={toastText}
        onAddParticipant={addParticipantToCall}
        discoverOpen={discoverOpen} onDiscoverOpen={() => setDiscoverOpen(true)}
        onDiscoverClose={() => setDiscoverOpen(false)} plannerCount={plannerCount}
        missedCalls={missedCalls} onLogout={signOut} tabs={tabs}
        chatListMenuPos={chatListMenuPos} onChatListMenuPos={setChatListMenuPos}
        newCallOpen={newCallOpen} onNewCallOpen={() => setNewCallOpen(true)}
        onNewCallClose={() => setNewCallOpen(false)}
        callsMenuPos={callsMenuPos} onCallsMenuPos={setCallsMenuPos}
        onSettingsNavChange={(nav) => { setSettingsNavDepth(nav.depth); settingsGoBackRef.current = nav.goBack; }}/>
    );
  }

  if (openChat) {
    const resolvedChat = chats.find((chat) => chat.id === openChat.id) || openChat;

    if (resolvedChat.is_locked && !unlockedChats.has(resolvedChat.id)) {
      return (
        <Screen>
          <LockGate
            chat={resolvedChat}
            onUnlocked={() => setUnlockedChats((current) => new Set(current).add(resolvedChat.id))}
            onBack={() => setOpenChat(null)}/>
        </Screen>
      );
    }

    return (
      <Screen>
        <ChatView
          chat={resolvedChat}
          me={me}
          events={events}
          typingBy={typingBy}
          reconnectedAt={reconnectedAt}
          onBack={() => { setOpenChat(null); reloadChats(); }}
          onChanged={reloadChats}
          onOpenChat={setOpenChat}
          onChatLocked={(chatId) => setUnlockedChats((current) => {
            const next = new Set(current);
            next.delete(chatId);
            return next;
          })}
          onStartCall={(kind) => call.startCall(resolvedChat, kind)}
          onStartGroupCall={(kind, password) => groupCall.join(resolvedChat.id, kind, password)}
          toast={toast}/>
        <Toast text={toastText}/>
        <Suspense fallback={null}>
          <CallOverlay call={call.call} onAccept={call.acceptIncoming} onReject={call.rejectIncoming}
                       onEnd={call.endCall} onToggleMute={call.toggleMute} onToggleCamera={call.toggleCamera}
                       onSwitchCamera={call.switchCamera} onEffect={call.setVideoEffect} onAddParticipant={addParticipantToCall}
                       onShareScreen={call.shareScreen} onToggleHold={call.toggleHold}/>
          <GroupCallOverlay call={groupCall.call} myUserId={me?.id}
                            onAccept={() => groupCall.join(groupCall.call.chatId, groupCall.call.callKind)}
                            onDecline={groupCall.declineIncoming} onLeave={groupCall.leave}
                            onToggleMute={groupCall.toggleMute} onToggleCamera={groupCall.toggleCamera}
                            onSwitchCamera={groupCall.switchCamera}
                            onShareScreen={groupCall.shareScreen} onSetScreenOptimization={groupCall.setScreenOptimization} onForceMuteAll={groupCall.forceMuteAll}
                            onKickParticipant={groupCall.kickParticipant} onAddPeople={groupCall.addPeople}
                            onToggleWhiteboard={groupCall.toggleWhiteboard} events={events} send={realtime.send}
                            onSendReaction={groupCall.sendReaction} onToggleRaiseHand={groupCall.toggleRaiseHand}
                            onToggleCaptions={groupCall.toggleCaptions} onCaptionText={groupCall.sendCaption}
                            onJoinBreakoutRoom={groupCall.joinBreakoutRoom} onReturnToMainCall={groupCall.returnToMainCall}
                            onAdmitParticipant={groupCall.admitParticipant} onDenyParticipant={groupCall.denyParticipant}
                            onSetPermission={groupCall.setPermission} onMuteParticipant={groupCall.muteParticipant}
                            onSpotlight={groupCall.spotlight} onTransferHost={groupCall.transferHost}/>
        </Suspense>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar status={realtime.status} tab={tab}
              onNewChat={() => setDiscoverOpen(true)}
              onMenuClick={(event) => setChatListMenuPos({ x: event.clientX, y: event.clientY })}
              onNewCall={() => setNewCallOpen(true)}
              onCallsMenuClick={(event) => setCallsMenuPos({ x: event.clientX, y: event.clientY })}/>

      {/* One flex:1 region that ALWAYS fills the space between the top bar and
          the bottom nav — so a screen that returns just a short <Spinner/>
          while loading (CallsScreen, Status, …) can't let the nav bar ride up
          into the middle of the viewport. Whatever renders inside sizes itself
          within this region; the nav stays pinned at the bottom regardless. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {searchResults ? (
        <SearchResults results={searchResults} onClose={() => setSearchResults(null)}
                       onOpen={(chatId) => {
                         const chat = chats.find((candidate) => candidate.id === chatId);
                         if (chat) { setSearchResults(null); setOpenChat(chat); }
                       }}/>
      ) : (
        <Suspense fallback={<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}><Spinner/></div>}>
          {tab === "chats" && (
            <ChatList chats={chats} loading={loadingChats} typingBy={typingBy} me={me}
                      onOpen={setOpenChat} onChanged={reloadChats} toast={toast}
                      onNewChat={() => setDiscoverOpen(true)} onLogout={signOut}
                      headerMenuPos={chatListMenuPos} onHeaderMenuClose={() => setChatListMenuPos(null)}
                      onSearch={(query) => Search.query(query).then(setSearchResults)}/>
          )}
          {tab === "calls" && (
            <CallsScreen me={me} toast={toast} onCallBack={(chatLike, kind) => {
              if (chatLike.type === "dm") call.startCall(chatLike, kind);
              else groupCall.join(chatLike.id, kind);
            }} newCallOpen={newCallOpen} onNewCallClose={() => setNewCallOpen(false)}
                        menuPos={callsMenuPos} onMenuClose={() => setCallsMenuPos(null)}/>
          )}
          {tab === "status" && <Status me={me} toast={toast}/>}
          {tab === "planner" && (
            <Planner toast={toast} chats={chats} onOpenChat={setOpenChat} me={me}
                     onJoinCall={(chatId, kind, password) => {
                       // A meeting can be scheduled inside a DM, but group_call_start
                       // (main.py) is deliberately a no-op there — DMs already have their
                       // own ring/accept 1:1 call flow, and routing through the group-call
                       // machinery instead would silently connect nothing (see
                       // test_group_calling_is_restricted_to_group_chats on the backend).
                       const target = chats.find((c) => c.id === chatId);
                       if (target?.type === "dm") call.startCall(target, kind);
                       else groupCall.join(chatId, kind, password);
                     }}/>
          )}
          {tab === "settings" && (
            <Settings me={me} onUpdated={setMe} toast={toast}
                      theme={theme} onThemeChange={setTheme}
                      accent={accent} onAccentChange={setAccent}
                      onOpenChat={(chat) => { reloadChats(); setOpenChat(chat); }}
                      onSignedOut={() => { setMe(null); setChats([]); setTab("chats"); }}
                      onNavigationChange={(nav) => { setSettingsNavDepth(nav.depth); settingsGoBackRef.current = nav.goBack; }}/>
          )}
          {tab === "admin" && me.is_superadmin && <AdminPanel toast={toast}/>}
        </Suspense>
      )}
      </div>

      <TabBar tab={tab} onChange={changeTab}
              unread={chats.reduce((total, chat) => total + (chat.unread || 0), 0)}
              plannerCount={plannerCount} missedCalls={missedCalls} tabs={tabs}/>
      <Toast text={toastText}/>
      <Suspense fallback={null}>
        <CallOverlay call={call.call} onAccept={call.acceptIncoming} onReject={call.rejectIncoming}
                     onEnd={call.endCall} onToggleMute={call.toggleMute} onToggleCamera={call.toggleCamera}
                       onSwitchCamera={call.switchCamera} onEffect={call.setVideoEffect} onAddParticipant={addParticipantToCall}
                     onShareScreen={call.shareScreen} onToggleHold={call.toggleHold}/>
        <GroupCallOverlay call={groupCall.call} myUserId={me?.id}
                          onAccept={() => groupCall.join(groupCall.call.chatId, groupCall.call.callKind)}
                          onDecline={groupCall.declineIncoming} onLeave={groupCall.leave}
                          onToggleMute={groupCall.toggleMute} onToggleCamera={groupCall.toggleCamera}
                            onSwitchCamera={groupCall.switchCamera}
                          onShareScreen={groupCall.shareScreen} onSetScreenOptimization={groupCall.setScreenOptimization} onForceMuteAll={groupCall.forceMuteAll}
                          onKickParticipant={groupCall.kickParticipant} onAddPeople={groupCall.addPeople}
                          onToggleWhiteboard={groupCall.toggleWhiteboard} events={events} send={realtime.send}
                            onSendReaction={groupCall.sendReaction} onToggleRaiseHand={groupCall.toggleRaiseHand}
                            onToggleCaptions={groupCall.toggleCaptions} onCaptionText={groupCall.sendCaption}
                            onJoinBreakoutRoom={groupCall.joinBreakoutRoom} onReturnToMainCall={groupCall.returnToMainCall}
                            onAdmitParticipant={groupCall.admitParticipant} onDenyParticipant={groupCall.denyParticipant}
                            onSetPermission={groupCall.setPermission} onMuteParticipant={groupCall.muteParticipant}
                            onSpotlight={groupCall.spotlight} onTransferHost={groupCall.transferHost}/>
      </Suspense>
      {discoverOpen && (
        <Suspense fallback={null}>
          <DiscoverOverlay onClose={() => setDiscoverOpen(false)}
                           onOpenChat={(chat) => { setDiscoverOpen(false); setOpenChat(chat); }}
                           onChanged={reloadChats} toast={toast}/>
        </Suspense>
      )}
      {blueTickNudge && (
        <BlueTickNudge progress={blueTickNudge} onClose={() => setBlueTickNudge(null)}
                       onInvite={() => {
                         setBlueTickNudge(null);
                         // Trigger the Web Share invite with the user's referral link
                         const url = `https://web.talkex.in/?ref=${me?.username || ""}`;
                         if (navigator.share) {
                           navigator.share({ title: "Join me on TalkEx", text: "Hey! Try TalkEx — it's free, fast, and secure messaging. Join here:", url }).catch(() => {});
                         } else {
                           navigator.clipboard?.writeText(url).then(() => toast("Invite link copied!")).catch(() => {});
                         }
                       }}/>
      )}
      {blueTickCelebrate && (
        <BlueTickCelebrate onClose={() => setBlueTickCelebrate(false)}/>
      )}
    </Screen>
  );
}

/**
 * The "chat with N people to earn the blue tick" nudge — shown once per app
 * open (see the fetch effect in App) for as long as the account hasn't
 * earned it yet. A bottom sheet, not a hard blocking dialog: dismissible
 * with a tap outside or "Maybe later", because this is a nudge toward a
 * badge, not something that should ever stop someone from reading a chat.
 */
function BlueTickNudge({ progress, onClose, onInvite }) {
  const invited = progress.invited ?? progress.chatted_with ?? 0;
  const remaining = Math.max(0, progress.target - invited);
  const pct = Math.min(100, Math.round((invited / progress.target) * 100));

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 24,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        border: `1px solid ${G.border}`, textAlign: "center",
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: "50%", background: "#1d9bf022",
          display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px",
        }}>
          {I.blueTick(30)}
        </div>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Get the TalkEx Blue Tick</div>
        <div style={{ fontSize: 13.5, color: G.sub, marginBottom: 18, lineHeight: 1.5 }}>
          Invite {progress.target} friends to join TalkEx and a blue tick badge
          is added to your profile automatically — {remaining > 0
            ? `just ${remaining} more to go!`
            : "almost there!"}
        </div>

        <div style={{
          height: 8, borderRadius: 4, background: G.dim, overflow: "hidden", marginBottom: 8,
        }}>
          <div style={{
            height: "100%", width: `${pct}%`, borderRadius: 4,
            background: "linear-gradient(90deg,#1d9bf0,#0d7bc4)", transition: "width .3s ease",
          }}/>
        </div>
        <div style={{ fontSize: 12, color: G.muted, marginBottom: 20 }}>
          {invited} of {progress.target} friends joined
        </div>

        <Button onClick={onInvite} style={{ width: "100%", marginBottom: 8 }}>
          Invite a friend
        </Button>
        <Button variant="ghost" onClick={onClose} style={{ width: "100%" }}>
          Maybe later
        </Button>
      </div>
    </div>
  );
}

/**
 * The one-time congratulations moment when maybe_award_blue_tick's realtime
 * push lands — see the "blue_tick_awarded" case in onEvent. Auto-dismisses
 * so it doesn't linger over whatever the person was doing (they were mid
 * DM-send when this fired), but stays closable immediately too.
 */
function BlueTickCelebrate({ onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 6000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 24,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        border: `1px solid ${G.border}`, textAlign: "center",
      }}>
        <div style={{
          width: 64, height: 64, borderRadius: "50%", background: "#1d9bf022",
          display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px",
        }}>
          {I.blueTick(36)}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
          🎉 You earned the blue tick!
        </div>
        <div style={{ fontSize: 13.5, color: G.sub, marginBottom: 20, lineHeight: 1.5 }}>
          Your profile now shows a blue tick badge — thanks for being active on TalkEx.
        </div>
        <Button onClick={onClose} style={{ width: "100%" }}>Nice!</Button>
      </div>
    </div>
  );
}

/**
 * Shown right after signing into a deactivated account instead of the
 * normal app — the same moment WhatsApp/Instagram-style apps ask "welcome
 * back, want to reactivate?" rather than silently un-hiding the account.
 */
function ReactivateGate({ onReactivated, onSignOut }) {
  const [busy, setBusy] = useState(false);

  async function reactivate() {
    setBusy(true);
    try {
      await Me.reactivate();
      onReactivated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen style={{ justifyContent: "center", padding: 28 }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 44, marginBottom: 14 }}>🙈</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Your account is deactivated</div>
        <div style={{ fontSize: 13.5, color: G.sub, marginTop: 8, lineHeight: 1.5 }}>
          It's hidden from search and new chats. Reactivate it to use TalkEx again —
          nothing was deleted.
        </div>
      </div>
      <Button onClick={reactivate} disabled={busy} style={{ width: "100%", padding: 14, marginBottom: 10 }}>
        {busy ? "Reactivating…" : "Reactivate my account"}
      </Button>
      <Button variant="ghost" onClick={onSignOut} disabled={busy} style={{ width: "100%" }}>
        Sign out instead
      </Button>
    </Screen>
  );
}

function AppLockScreen({ onUnlocked, onSignOut }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const biometricOn = isBiometricEnabled();

  async function tryBiometric() {
    if (bioBusy) return;
    setBioBusy(true);
    try {
      const ok = await verifyBiometric();
      if (ok) onUnlocked();
      else setError(true);
    } finally {
      setBioBusy(false);
    }
  }

  useEffect(() => {
    if (pin.length < 4) return;
    let cancelled = false;
    setChecking(true);
    verifyAppLockPin(pin).then((ok) => {
      if (cancelled) return;
      if (ok) { onUnlocked(); return; }
      setError(true);
      setPin("");
    }).finally(() => !cancelled && setChecking(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  return (
    <Screen style={{ justifyContent: "center", padding: 28 }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        {I.lock ? I.lock(G.accent, 40) : null}
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 10 }}>Enter your app lock PIN</div>
        {error && (
          <div style={{ fontSize: 13, color: G.red, marginTop: 6 }}>Wrong PIN — try again</div>
        )}
      </div>
      {biometricOn && (
        <div onClick={tryBiometric} style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
          margin: "0 auto 24px", cursor: bioBusy ? "default" : "pointer", opacity: bioBusy ? 0.6 : 1,
        }}>
          {I.fingerprint(G.accent, 34)}
          <span style={{ fontSize: 12.5, color: G.sub }}>
            {bioBusy ? "Checking…" : "Use fingerprint / Face ID"}
          </span>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 8 }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{
            width: 14, height: 14, borderRadius: "50%",
            border: `1.5px solid ${G.border}`,
            background: pin.length > i ? G.accent : "transparent",
          }}/>
        ))}
      </div>
      <input value={pin} onChange={(e) => { setError(false); setPin(e.target.value.replace(/\D/g, "").slice(0, 6)); }}
             type="password" inputMode="numeric" autoFocus disabled={checking}
             style={{
               opacity: 0, position: "absolute", pointerEvents: "none",
             }}/>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, maxWidth: 260, margin: "16px auto 0" }}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((key, i) => (
          <button key={i} disabled={!key || checking}
                  onClick={() => {
                    if (key === "⌫") { setPin((p) => p.slice(0, -1)); setError(false); return; }
                    setError(false);
                    setPin((p) => (p.length < 6 ? p + key : p));
                  }}
                  style={{
                    padding: "14px 0", borderRadius: 12, fontSize: 18, fontWeight: 600,
                    border: `1px solid ${G.border}`, background: key ? G.card : "transparent",
                    color: G.text, cursor: key ? "pointer" : "default", visibility: key ? "visible" : "hidden",
                  }}>{key}</button>
        ))}
      </div>
      <Button variant="ghost" onClick={onSignOut} style={{ width: "100%", marginTop: 20 }}>
        Forgot PIN? Sign out instead
      </Button>
    </Screen>
  );
}

function TopBar({ status, tab, onNewChat, onMenuClick, onNewCall, onCallsMenuClick }) {
  const { t } = useT();
  const entry = TAB_KEYS.find((e) => e.key === tab);
  const label = tab === "admin" ? "Admin" : (entry?.i18n ? t(entry.i18n) : "TalkEx");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "14px 16px", paddingTop: "max(14px, env(safe-area-inset-top, 0px))",
      borderBottom: `1px solid ${G.border}`, background: G.surface,
      position: "sticky", top: 0, zIndex: 5, flexShrink: 0,
    }}>
      <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>{label}</div>
      {tab === "chats" && onNewChat && (
        <div onClick={onNewChat} title="New chat" style={{
          width: 32, height: 32, borderRadius: 10, background: G.accent,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", flexShrink: 0,
        }}>
          {I.newChatBox("#fff", 15)}
        </div>
      )}
      {tab === "chats" && onMenuClick && (
        <div onClick={onMenuClick} title="More options" style={{
          width: 34, height: 34, borderRadius: "50%", display: "flex",
          alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
        }}>
          {I.moreVertical(G.sub, 19)}
        </div>
      )}
      {tab === "calls" && onNewCall && (
        <div onClick={onNewCall} title="New call" style={{
          width: 32, height: 32, borderRadius: 10, background: G.accent,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", flexShrink: 0,
        }}>
          {I.phone("#fff", 15)}
        </div>
      )}
      {tab === "calls" && onCallsMenuClick && (
        <div onClick={onCallsMenuClick} title="More options" style={{
          width: 34, height: 34, borderRadius: "50%", display: "flex",
          alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0,
        }}>
          {I.moreVertical(G.sub, 19)}
        </div>
      )}
      <ConnectionDot status={status}/>
    </div>
  );
}

function ConnectionDot({ status }) {
  // Showing the connection honestly matters here: a message that is queued
  // rather than sent looks identical otherwise.
  const looks = {
    online: { color: G.green, text: "" },
    connecting: { color: G.yellow, text: "connecting" },
    reconnecting: { color: G.yellow, text: "reconnecting" },
    unauthorized: { color: G.red, text: "signed out" },
  }[status] || { color: G.muted, text: "offline" };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      {looks.text && <span style={{ fontSize: 11.5, color: looks.color }}>{looks.text}</span>}
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: looks.color }}/>
    </div>
  );
}

function TabBar({ tab, onChange, unread, plannerCount, missedCalls, tabs = TAB_KEYS }) {
  const { t } = useT();
  const badgeFor = (key) => (
    key === "chats" ? unread : key === "planner" ? plannerCount : key === "calls" ? missedCalls : 0
  );
  return (
    // The outer strip stays a plain sticky footer (so it never disappears
    // behind other content); the actual bar floats inside it as a rounded
    // rectangle with its own background/shadow, like a modern app's pill nav.
    <div style={{
      position: "sticky", bottom: 0, zIndex: 5, flexShrink: 0,
      background: G.bg, paddingTop: 6, paddingLeft: 10, paddingRight: 10,
      // Same reasoning as the composer: reserve the device's own bottom
      // inset so the tab bar never ends up underneath the OS nav bar.
      paddingBottom: "max(10px, env(safe-area-inset-bottom))",
    }}>
      <div style={{
        display: "flex", background: G.surface, borderRadius: 20,
        border: `1px solid ${G.border}`, boxShadow: `0 4px 16px ${G.border}`,
      }}>
        {tabs.map((entry) => {
          const active = tab === entry.key;
          return (
            <div key={entry.key} onClick={() => onChange(entry.key)}
              style={{
                flex: 1, padding: "9px 0 10px", textAlign: "center", cursor: "pointer",
                position: "relative",
              }}>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <div style={{
                  width: 34, height: 34, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: active ? G.accentSoft : "transparent",
                  transition: "background 0.15s ease",
                }}>
                  {entry.icon(active ? G.accent : G.muted, 21)}
                </div>
              </div>
              <div style={{
                fontSize: 10.5, marginTop: 3, color: active ? G.accentText : G.muted,
                fontWeight: active ? 600 : 400,
                transition: "color .15s ease",
              }}>{entry.i18n ? t(entry.i18n) : entry.label}</div>

              {badgeFor(entry.key) > 0 && (
                <div style={{
                  position: "absolute", top: 5, left: "calc(50% + 8px)",
                  minWidth: 16, height: 16, borderRadius: 8, background: G.accent,
                  color: "#fff", fontSize: 9.5, fontWeight: 700, padding: "0 4px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{badgeFor(entry.key) > 99 ? "99+" : badgeFor(entry.key)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Desktop (>=900px) layout: a persistent icon rail for switching tabs, a
 * fixed-width column for whichever tab is active, and a right-hand panel
 * showing the open chat — a WhatsApp-Web-style split view, rather than the
 * phone-width single column mobile gets. Every screen underneath (ChatList,
 * ChatView, Calls, Status, Planner, Discover, Settings) is unchanged — this
 * just gives them a wider, persistent frame instead of swapping the whole
 * viewport out from under them.
 */
function DesktopShell({
  tab, onTabChange, chats, loadingChats, typingBy, onOpenChat, openChat, unlockedChats,
  onUnlockChat, onRelockChat, reloadChats, toast, searchResults, onSearchResultsChange,
  me, onMeUpdated, theme, onThemeChange, accent, onAccentChange, onSignedOut,
  realtime, events, reconnectedAt, call, groupCall, toastText,
  onAddParticipant: addParticipantToCall,
  discoverOpen, onDiscoverOpen, onDiscoverClose, plannerCount, missedCalls, onLogout, tabs,
  chatListMenuPos, onChatListMenuPos, newCallOpen, onNewCallOpen, onNewCallClose,
  callsMenuPos, onCallsMenuPos, onSettingsNavChange,
}) {
  const resolvedOpenChat = openChat ? (chats.find((chat) => chat.id === openChat.id) || openChat) : null;
  const chatLocked = resolvedOpenChat?.is_locked && !unlockedChats.has(resolvedOpenChat.id);
  const unread = chats.reduce((total, chat) => total + (chat.unread || 0), 0);

  return (
    <div style={{
      height: "var(--app-height, 100vh)", overflow: "hidden", background: G.bg,
      fontFamily: "'SF Pro Text',-apple-system,sans-serif", color: G.text,
      display: "flex",
    }}>
      <DesktopRail tab={tab} onChange={onTabChange} unread={unread} plannerCount={plannerCount}
                   missedCalls={missedCalls} tabs={tabs}
                   onLogout={onLogout}/>

      <div style={{
        width: 400, flexShrink: 0, borderRight: `1px solid ${G.border}`,
        display: "flex", flexDirection: "column", height: "100%", overflow: "hidden",
      }}>
        <TopBar status={realtime.status} tab={tab}
                onNewChat={onDiscoverOpen}
                onMenuClick={(event) => onChatListMenuPos({ x: event.clientX, y: event.clientY })}
                onNewCall={onNewCallOpen}
                onCallsMenuClick={(event) => onCallsMenuPos({ x: event.clientX, y: event.clientY })}/>
        {searchResults ? (
          <SearchResults results={searchResults} onClose={() => onSearchResultsChange(null)}
                         onOpen={(chatId) => {
                           const chat = chats.find((candidate) => candidate.id === chatId);
                           if (chat) { onSearchResultsChange(null); onOpenChat(chat); }
                         }}/>
        ) : (
          <Suspense fallback={<div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center"}}><Spinner/></div>}>
            {tab === "chats" && (
              <ChatList chats={chats} loading={loadingChats} typingBy={typingBy} me={me}
                        onOpen={onOpenChat} onChanged={reloadChats} toast={toast}
                        onNewChat={onDiscoverOpen} onLogout={onLogout}
                        headerMenuPos={chatListMenuPos} onHeaderMenuClose={() => onChatListMenuPos(null)}
                        onSearch={(query) => Search.query(query).then(onSearchResultsChange)}/>
            )}
            {tab === "calls" && (
              <CallsScreen me={me} toast={toast} onCallBack={(chatLike, kind) => {
                if (chatLike.type === "dm") call.startCall(chatLike, kind);
                else groupCall.join(chatLike.id, kind);
              }} newCallOpen={newCallOpen} onNewCallClose={onNewCallClose}
                          menuPos={callsMenuPos} onMenuClose={() => onCallsMenuPos(null)}/>
            )}
            {tab === "status" && <Status me={me} toast={toast}/>}
            {tab === "planner" && (
              <Planner toast={toast} chats={chats} onOpenChat={onOpenChat} me={me}
                       onJoinCall={(chatId, kind, password) => {
                       // A meeting can be scheduled inside a DM, but group_call_start
                       // (main.py) is deliberately a no-op there — DMs already have their
                       // own ring/accept 1:1 call flow, and routing through the group-call
                       // machinery instead would silently connect nothing (see
                       // test_group_calling_is_restricted_to_group_chats on the backend).
                       const target = chats.find((c) => c.id === chatId);
                       if (target?.type === "dm") call.startCall(target, kind);
                       else groupCall.join(chatId, kind, password);
                     }}/>
            )}
            {tab === "settings" && (
              <Settings me={me} onUpdated={onMeUpdated} toast={toast}
                        theme={theme} onThemeChange={onThemeChange}
                        accent={accent} onAccentChange={onAccentChange}
                        onOpenChat={onOpenChat}
                        onSignedOut={onSignedOut}
                        onNavigationChange={onSettingsNavChange}/>
            )}
            {tab === "admin" && me.is_superadmin && <AdminPanel toast={toast}/>}
          </Suspense>
        )}
      </div>

      <div style={{ flex: 1, height: "100%", overflow: "hidden", position: "relative" }}>
        {resolvedOpenChat ? (
          chatLocked ? (
            <LockGate chat={resolvedOpenChat}
                      onUnlocked={() => onUnlockChat(resolvedOpenChat.id)}
                      onBack={() => onOpenChat(null)}/>
          ) : (
            <ChatView
              chat={resolvedOpenChat}
              me={me}
              events={events}
              typingBy={typingBy}
              reconnectedAt={reconnectedAt}
              onBack={() => { onOpenChat(null); reloadChats(); }}
              onChanged={reloadChats}
              onOpenChat={onOpenChat}
              onChatLocked={onRelockChat}
              onStartCall={(kind) => call.startCall(resolvedOpenChat, kind)}
              onStartGroupCall={(kind, password) => groupCall.join(resolvedOpenChat.id, kind, password)}
              toast={toast}/>
          )
        ) : (
          <EmptyChatPanel/>
        )}
      </div>

      <Toast text={toastText}/>
      <Suspense fallback={null}>
        <CallOverlay call={call.call} onAccept={call.acceptIncoming} onReject={call.rejectIncoming}
                     onEnd={call.endCall} onToggleMute={call.toggleMute} onToggleCamera={call.toggleCamera}
                       onSwitchCamera={call.switchCamera} onEffect={call.setVideoEffect} onAddParticipant={addParticipantToCall}
                     onShareScreen={call.shareScreen} onToggleHold={call.toggleHold}/>
        <GroupCallOverlay call={groupCall.call} myUserId={me?.id}
                          onAccept={() => groupCall.join(groupCall.call.chatId, groupCall.call.callKind)}
                          onDecline={groupCall.declineIncoming} onLeave={groupCall.leave}
                          onToggleMute={groupCall.toggleMute} onToggleCamera={groupCall.toggleCamera}
                            onSwitchCamera={groupCall.switchCamera}
                          onShareScreen={groupCall.shareScreen} onSetScreenOptimization={groupCall.setScreenOptimization} onForceMuteAll={groupCall.forceMuteAll}
                          onKickParticipant={groupCall.kickParticipant} onAddPeople={groupCall.addPeople}
                          onToggleWhiteboard={groupCall.toggleWhiteboard} events={events} send={realtime.send}
                            onSendReaction={groupCall.sendReaction} onToggleRaiseHand={groupCall.toggleRaiseHand}
                            onToggleCaptions={groupCall.toggleCaptions} onCaptionText={groupCall.sendCaption}
                            onJoinBreakoutRoom={groupCall.joinBreakoutRoom} onReturnToMainCall={groupCall.returnToMainCall}
                            onAdmitParticipant={groupCall.admitParticipant} onDenyParticipant={groupCall.denyParticipant}
                            onSetPermission={groupCall.setPermission} onMuteParticipant={groupCall.muteParticipant}
                            onSpotlight={groupCall.spotlight} onTransferHost={groupCall.transferHost}/>
      </Suspense>
      {discoverOpen && (
        <Suspense fallback={null}>
          <DiscoverOverlay onClose={onDiscoverClose}
                           onOpenChat={(chat) => { onDiscoverClose(); onOpenChat(chat); }}
                           onChanged={reloadChats} toast={toast}/>
        </Suspense>
      )}
    </div>
  );
}

function DesktopRail({ tab, onChange, unread, plannerCount, missedCalls, onLogout, tabs = TAB_KEYS }) {
  const { t } = useT();
  const badgeFor = (key) => (
    key === "chats" ? unread : key === "planner" ? plannerCount : key === "calls" ? missedCalls : 0
  );
  return (
    <div style={{
      width: 76, flexShrink: 0, height: "100%", background: G.surface,
      borderRight: `1px solid ${G.border}`, display: "flex", flexDirection: "column",
      alignItems: "center", padding: "18px 0", gap: 4, overflowY: "auto",
    }}>
      <img src="/icon.png" alt="TalkEx" style={{ width: 34, height: 34, borderRadius: 10, marginBottom: 10 }}/>

      {tabs.map((entry) => {
        const active = tab === entry.key;
        return (
          <div key={entry.key} onClick={() => onChange(entry.key)} title={entry.i18n ? t(entry.i18n) : entry.label}
               style={{ width: 56, padding: "8px 0", borderRadius: 14, textAlign: "center", cursor: "pointer", position: "relative" }}>
            <div style={{
              width: 40, height: 40, borderRadius: 12, margin: "0 auto",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: active ? G.accentSoft : "transparent",
              transition: "background 0.15s ease",
            }}>
              {entry.icon(active ? G.accent : G.muted, 21)}
            </div>
            <div style={{
              fontSize: 9.5, marginTop: 3, color: active ? G.accentText : G.muted,
              fontWeight: active ? 600 : 400,
            }}>{entry.i18n ? t(entry.i18n) : entry.label}</div>

            {badgeFor(entry.key) > 0 && (
              <div style={{
                position: "absolute", top: 3, right: 6,
                minWidth: 16, height: 16, borderRadius: 8, background: G.accent,
                color: "#fff", fontSize: 9.5, fontWeight: 700, padding: "0 4px",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>{badgeFor(entry.key) > 99 ? "99+" : badgeFor(entry.key)}</div>
            )}
          </div>
        );
      })}

      <div style={{ flex: 1 }}/>

      <div onClick={() => { if (window.confirm("Log out of TalkEx?")) onLogout(); }}
           title="Log out"
           style={{ width: 56, padding: "8px 0", borderRadius: 14, textAlign: "center", cursor: "pointer" }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12, margin: "0 auto",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {I.logOut(G.red, 20)}
        </div>
        <div style={{ fontSize: 9.5, marginTop: 3, color: G.red }}>Log out</div>
      </div>
    </div>
  );
}

/** The right-hand panel's resting state — no chat open yet, same idea as WhatsApp Web's placeholder. */
function EmptyChatPanel() {
  return (
    <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
      <ChatBackdrop/>
      <div style={{
        position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", color: "#a9c2e0", textAlign: "center", padding: 40,
      }}>
        <img src="/icon.png" alt="TalkEx" style={{
          width: 88, height: 88, borderRadius: 24, marginBottom: 20,
          boxShadow: `0 12px 30px ${G.accentGlow}, 0 0 0 4px #ffffff14`,
        }}/>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#fff" }}>TalkEx</div>
        <div style={{ fontSize: 13.5, marginTop: 8, maxWidth: 320 }}>Chat • Meetings • Business • Automation</div>
        <div style={{ fontSize: 13, marginTop: 16, maxWidth: 320 }}>Select a chat from the list to start messaging.</div>
      </div>
    </div>
  );
}

/**
 * "Start something new" — people search, contacts, channels, communities,
 * join-via-code, create group/broadcast. Used to be its own persistent
 * bottom tab; now it's a modal reached from the "+" on Chats, since none of
 * this is a place you come back to sit in, unlike Chats/Calls/Status/Planner.
 */
function DiscoverOverlay({ onClose, onOpenChat, onChanged, toast }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", justifyContent: "center",
    }}>
      <div style={{
        width: "100%", maxWidth: 430, height: "100%", background: G.bg,
        display: "flex", flexDirection: "column", boxShadow: "0 0 40px #00000055",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "14px 16px",
          borderBottom: `1px solid ${G.border}`, flexShrink: 0,
        }}>
          <div onClick={onClose} style={{ cursor: "pointer", display: "flex" }}>{I.back()}</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>New chat</div>
        </div>
        <Discover onOpenChat={onOpenChat} onChanged={onChanged} toast={toast}/>
      </div>
    </div>
  );
}

function SearchResults({ results, onClose, onOpen }) {
  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
        borderBottom: `1px solid ${G.border}`,
      }}>
        <div style={{ flex: 1, fontSize: 13, color: G.sub }}>
          {results.length} result{results.length === 1 ? "" : "s"}
        </div>
        <div onClick={onClose} style={{ cursor: "pointer", color: G.accentText, fontSize: 13 }}>
          Close
        </div>
      </div>

      {results.map((message) => (
        <div key={message.id} onClick={() => onOpen(message.chat_id)}
          style={{
            padding: "12px 16px", borderBottom: `1px solid ${G.border}`, cursor: "pointer",
          }}>
          <div style={{ fontSize: 12, color: G.accentText }}>
            {message.chat_name || message.chat_type}
          </div>
          <div style={{ fontSize: 14, marginTop: 3 }}>{message.text}</div>
        </div>
      ))}
    </div>
  );
}

function Toast({ text }) {
  if (!text) return null;
  return (
    <div style={{
      position: "fixed", bottom: 84, left: "50%", transform: "translateX(-50%)",
      background: G.card2, border: `1px solid ${G.border}`, color: G.text,
      padding: "11px 18px", borderRadius: 14, fontSize: 13.5, zIndex: 90,
      maxWidth: 360, textAlign: "center", boxShadow: "0 8px 30px #00000066",
      animation: "talkexToastIn .25s cubic-bezier(.32,.72,.37,1.1)",
    }}>
      <style>{`@keyframes talkexToastIn{from{opacity:0;transform:translateX(-50%) translateY(16px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}`}</style>
      {text}
    </div>
  );
}

/**
 * PIN entry for a locked chat.
 *
 * Unlocking is per-session and in-memory only (see `unlockedChats` in App) —
 * this screen exists to be shown again the next time the chat is genuinely
 * reopened, not to be a one-time hurdle.
 */
function LockGate({ chat, onUnlocked, onBack }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!pin) return;
    setBusy(true);
    setError("");
    try {
      await Chats.unlock(chat.id, pin);
      onUnlocked();
    } catch (problem) {
      setError(problem.message || "Wrong PIN");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      flex: 1, position: "relative", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: 28, textAlign: "center",
    }}>
      <div onClick={onBack} style={{
        position: "absolute", top: 18, left: 18, cursor: "pointer",
      }}>{I.back()}</div>

      <div style={{
        width: 64, height: 64, borderRadius: 20, marginBottom: 18,
        background: G.accentSoft, display: "flex", alignItems: "center", justifyContent: "center",
      }}>{I.lock(G.accent, 26)}</div>

      <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>
        {chat.name || "This chat"} is locked
      </div>
      <div style={{ fontSize: 13, color: G.muted, marginBottom: 22 }}>
        Enter the PIN to open it
      </div>

      <div style={{ width: "100%", maxWidth: 260 }}>
        <Field type="password" inputMode="numeric" value={pin} placeholder="PIN"
               onChange={(event) => setPin(event.target.value)}
               onKeyDown={(event) => event.key === "Enter" && submit()}
               style={{ textAlign: "center", fontSize: 20, letterSpacing: 4 }}/>

        {error && (
          <div style={{ color: G.red, fontSize: 13, marginBottom: 12 }}>{error}</div>
        )}

        <Button onClick={submit} disabled={busy || !pin} style={{ width: "100%" }}>
          {busy ? "Checking…" : "Unlock"}
        </Button>
      </div>
    </div>
  );
}
