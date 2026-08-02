import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError, Auth, Calls, Chats, Me, Meetings, Messages, Scheduled, Search,
  clearToken, flushEverything, getToken, rememberAccount,
} from "./api.js";
import { useRealtime } from "./useRealtime.js";
import { useCall } from "./useCall.js";
import { useGroupCall } from "./useGroupCall.js";
import {
  Button, ChatBackdrop, Field, G, I, Screen, Spinner, useIsDesktop,
  applyTheme, getStoredAccent, getStoredTheme, saveAccent, saveTheme,
} from "./ui.jsx";
import { getAppLockTimeout, isAppLockEnabled, verifyAppLockPin } from "./appLock.js";
import * as offlineDb from "./offlineDb.js";

import AdminPanel from "./screens/AdminPanel.jsx";
import CallOverlay from "./screens/CallOverlay.jsx";
import CallsScreen from "./screens/Calls.jsx";
import GroupCallOverlay from "./screens/GroupCallOverlay.jsx";
import ChatList from "./screens/ChatList.jsx";
import ChatView from "./screens/ChatView.jsx";
import Discover from "./screens/Discover.jsx";
import Login from "./screens/Login.jsx";
import Planner from "./screens/Planner.jsx";
import Settings from "./screens/Settings.jsx";
import Status from "./screens/Status.jsx";

// "Discover" (people/contacts/channels/communities/join-via-code) used to be
// its own bottom tab. It's really a set of "start something new" actions, not
// a place you go back to — so it now lives behind the "+" button on Chats
// (DiscoverOverlay) instead of costing the nav a whole slot.
const TABS = [
  { key: "chats", label: "Chats", icon: I.chat },
  { key: "calls", label: "Calls", icon: I.phone },
  { key: "status", label: "Status", icon: I.status },
  { key: "planner", label: "Planner", icon: I.calendar },
  { key: "settings", label: "You", icon: I.settings },
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
  const [reconnectedAt, setReconnectedAt] = useState(0);
  const [theme, setThemeState] = useState(getStoredTheme);
  const [accent, setAccentState] = useState(getStoredAccent);

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
    if (!isAppLockEnabled()) return;
    function onVisibility() {
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

  const toast = useCallback((text) => {
    setToastText(text);
    setTimeout(() => setToastText(""), 2200);
  }, []);

  // Reachable straight from the desktop rail, not just buried in Settings →
  // Account — same real sign-out (revokes the session server-side first),
  // just one click away instead of three.
  const signOut = useCallback(async () => {
    try { await Auth.logout(); } catch { /* the token is going away regardless */ }
    clearToken();
    setMe(null);
    setChats([]);
    setTab("chats");
  }, []);

  // ── Session ────────────────────────────────────────────────────────────────

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
    Chats.list()
      .then(setChats)
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

  // Just a count for the tab badge — Planner itself fetches the real lists.
  // "What have I got waiting" mirrors Planner's own framing of the screen:
  // upcoming meetings plus messages still queued to send.
  const [plannerCount, setPlannerCount] = useState(0);
  const reloadPlannerCount = useCallback(() => {
    if (!getToken()) return;
    Promise.all([Meetings.mine(true), Scheduled.list()])
      .then(([upcoming, pending]) => setPlannerCount(upcoming.length + pending.length))
      .catch(() => {});
  }, []);

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
    if (key === "calls" && missedCalls > 0) {
      setMissedCalls(0);
      Calls.markSeen().catch(() => {});
    }
  }, [missedCalls]);

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

    // Anything that changes a chat's last message or unread count.
    if (["message", "message_deleted", "message_expired", "read"].includes(event.type)) {
      reloadChatsSoon();
    }

    // Mirrored into the offline store as it arrives, not just when a chat is
    // opened — otherwise a message that lands while you're on a different
    // screen (or a different chat entirely) would be invisible offline until
    // you happened to reopen that conversation once more while online.
    if (event.type === "message" && event.message?.chat_id) {
      offlineDb.saveMessages(event.message.chat_id, [event.message]).catch(() => {});
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
  const groupCall = useGroupCall(events, realtime.send, toast);

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
    (async () => {
      for (const chat of chats) {
        if (cancelled) return;
        await Messages.list(chat.id).catch(() => {});
      }
    })();
    return () => { cancelled = true; };
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
  const tabs = me?.is_superadmin ? [...TABS, { key: "admin", label: "Admin", icon: I.shield }] : TABS;

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
        discoverOpen={discoverOpen} onDiscoverOpen={() => setDiscoverOpen(true)}
        onDiscoverClose={() => setDiscoverOpen(false)} plannerCount={plannerCount}
        missedCalls={missedCalls} onLogout={signOut} tabs={tabs}
        chatListMenuPos={chatListMenuPos} onChatListMenuPos={setChatListMenuPos}
        newCallOpen={newCallOpen} onNewCallOpen={() => setNewCallOpen(true)}
        onNewCallClose={() => setNewCallOpen(false)}
        callsMenuPos={callsMenuPos} onCallsMenuPos={setCallsMenuPos}/>
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
        <CallOverlay call={call.call} onAccept={call.acceptIncoming} onReject={call.rejectIncoming}
                     onEnd={call.endCall} onToggleMute={call.toggleMute} onToggleCamera={call.toggleCamera}
                     onShareScreen={call.shareScreen}/>
        <GroupCallOverlay call={groupCall.call} myUserId={me?.id}
                          onAccept={() => groupCall.join(groupCall.call.chatId, groupCall.call.callKind)}
                          onDecline={groupCall.declineIncoming} onLeave={groupCall.leave}
                          onToggleMute={groupCall.toggleMute} onToggleCamera={groupCall.toggleCamera}
                          onShareScreen={groupCall.shareScreen} onSetScreenOptimization={groupCall.setScreenOptimization} onForceMuteAll={groupCall.forceMuteAll}
                          onKickParticipant={groupCall.kickParticipant} onAddPeople={groupCall.addPeople}
                          onToggleWhiteboard={groupCall.toggleWhiteboard} events={events} send={realtime.send}
                          onSendReaction={groupCall.sendReaction} onToggleRaiseHand={groupCall.toggleRaiseHand}
                          onToggleCaptions={groupCall.toggleCaptions} onCaptionText={groupCall.sendCaption}
                          onJoinBreakoutRoom={groupCall.joinBreakoutRoom} onReturnToMainCall={groupCall.returnToMainCall}
                          onAdmitParticipant={groupCall.admitParticipant} onDenyParticipant={groupCall.denyParticipant}/>
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

      {searchResults ? (
        <SearchResults results={searchResults} onClose={() => setSearchResults(null)}
                       onOpen={(chatId) => {
                         const chat = chats.find((candidate) => candidate.id === chatId);
                         if (chat) { setSearchResults(null); setOpenChat(chat); }
                       }}/>
      ) : (
        <>
          {tab === "chats" && (
            <ChatList chats={chats} loading={loadingChats} typingBy={typingBy}
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
            <Planner toast={toast} chats={chats} onOpenChat={setOpenChat}
                     onJoinCall={(chatId, kind, password) => groupCall.join(chatId, kind, password)}/>
          )}
          {tab === "settings" && (
            <Settings me={me} onUpdated={setMe} toast={toast}
                      theme={theme} onThemeChange={setTheme}
                      accent={accent} onAccentChange={setAccent}
                      onSignedOut={() => { setMe(null); setChats([]); setTab("chats"); }}/>
          )}
          {tab === "admin" && me.is_superadmin && <AdminPanel toast={toast}/>}
        </>
      )}

      <TabBar tab={tab} onChange={changeTab}
              unread={chats.reduce((total, chat) => total + (chat.unread || 0), 0)}
              plannerCount={plannerCount} missedCalls={missedCalls} tabs={tabs}/>
      <Toast text={toastText}/>
      <CallOverlay call={call.call} onAccept={call.acceptIncoming} onReject={call.rejectIncoming}
                   onEnd={call.endCall} onToggleMute={call.toggleMute} onToggleCamera={call.toggleCamera}
                   onShareScreen={call.shareScreen}/>
      <GroupCallOverlay call={groupCall.call} myUserId={me?.id}
                        onAccept={() => groupCall.join(groupCall.call.chatId, groupCall.call.callKind)}
                        onDecline={groupCall.declineIncoming} onLeave={groupCall.leave}
                        onToggleMute={groupCall.toggleMute} onToggleCamera={groupCall.toggleCamera}
                        onShareScreen={groupCall.shareScreen} onSetScreenOptimization={groupCall.setScreenOptimization} onForceMuteAll={groupCall.forceMuteAll}
                        onKickParticipant={groupCall.kickParticipant} onAddPeople={groupCall.addPeople}
                        onToggleWhiteboard={groupCall.toggleWhiteboard} events={events} send={realtime.send}
                          onSendReaction={groupCall.sendReaction} onToggleRaiseHand={groupCall.toggleRaiseHand}
                          onToggleCaptions={groupCall.toggleCaptions} onCaptionText={groupCall.sendCaption}
                          onJoinBreakoutRoom={groupCall.joinBreakoutRoom} onReturnToMainCall={groupCall.returnToMainCall}
                          onAdmitParticipant={groupCall.admitParticipant} onDenyParticipant={groupCall.denyParticipant}/>
      {discoverOpen && (
        <DiscoverOverlay onClose={() => setDiscoverOpen(false)}
                         onOpenChat={(chat) => { setDiscoverOpen(false); setOpenChat(chat); }}
                         onChanged={reloadChats} toast={toast}/>
      )}
    </Screen>
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
  const label = tab === "admin" ? "Admin" : TABS.find((entry) => entry.key === tab)?.label || "TalkEx";
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, padding: "14px 16px",
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

function TabBar({ tab, onChange, unread, plannerCount, missedCalls, tabs = TABS }) {
  const badgeFor = (key) => (
    key === "chats" ? unread : key === "planner" ? plannerCount : key === "calls" ? missedCalls : 0
  );
  return (
    // The outer strip stays a plain sticky footer (so it never disappears
    // behind other content); the actual bar floats inside it as a rounded
    // rectangle with its own background/shadow, like a modern app's pill nav.
    <div style={{
      position: "sticky", bottom: 0, zIndex: 5, flexShrink: 0,
      background: G.bg, padding: "6px 10px 10px",
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
              }}>{entry.label}</div>

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
  discoverOpen, onDiscoverOpen, onDiscoverClose, plannerCount, missedCalls, onLogout, tabs,
  chatListMenuPos, onChatListMenuPos, newCallOpen, onNewCallOpen, onNewCallClose,
  callsMenuPos, onCallsMenuPos,
}) {
  const resolvedOpenChat = openChat ? (chats.find((chat) => chat.id === openChat.id) || openChat) : null;
  const chatLocked = resolvedOpenChat?.is_locked && !unlockedChats.has(resolvedOpenChat.id);
  const unread = chats.reduce((total, chat) => total + (chat.unread || 0), 0);

  return (
    <div style={{
      height: "100vh", overflow: "hidden", background: G.bg,
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
          <>
            {tab === "chats" && (
              <ChatList chats={chats} loading={loadingChats} typingBy={typingBy}
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
              <Planner toast={toast} chats={chats} onOpenChat={onOpenChat}
                       onJoinCall={(chatId, kind, password) => groupCall.join(chatId, kind, password)}/>
            )}
            {tab === "settings" && (
              <Settings me={me} onUpdated={onMeUpdated} toast={toast}
                        theme={theme} onThemeChange={onThemeChange}
                        accent={accent} onAccentChange={onAccentChange}
                        onSignedOut={onSignedOut}/>
            )}
            {tab === "admin" && me.is_superadmin && <AdminPanel toast={toast}/>}
          </>
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
      <CallOverlay call={call.call} onAccept={call.acceptIncoming} onReject={call.rejectIncoming}
                   onEnd={call.endCall} onToggleMute={call.toggleMute} onToggleCamera={call.toggleCamera}
                   onShareScreen={call.shareScreen}/>
      <GroupCallOverlay call={groupCall.call} myUserId={me?.id}
                        onAccept={() => groupCall.join(groupCall.call.chatId, groupCall.call.callKind)}
                        onDecline={groupCall.declineIncoming} onLeave={groupCall.leave}
                        onToggleMute={groupCall.toggleMute} onToggleCamera={groupCall.toggleCamera}
                        onShareScreen={groupCall.shareScreen} onSetScreenOptimization={groupCall.setScreenOptimization} onForceMuteAll={groupCall.forceMuteAll}
                        onKickParticipant={groupCall.kickParticipant} onAddPeople={groupCall.addPeople}
                        onToggleWhiteboard={groupCall.toggleWhiteboard} events={events} send={realtime.send}
                          onSendReaction={groupCall.sendReaction} onToggleRaiseHand={groupCall.toggleRaiseHand}
                          onToggleCaptions={groupCall.toggleCaptions} onCaptionText={groupCall.sendCaption}
                          onJoinBreakoutRoom={groupCall.joinBreakoutRoom} onReturnToMainCall={groupCall.returnToMainCall}
                          onAdmitParticipant={groupCall.admitParticipant} onDenyParticipant={groupCall.denyParticipant}/>
      {discoverOpen && (
        <DiscoverOverlay onClose={onDiscoverClose}
                         onOpenChat={(chat) => { onDiscoverClose(); onOpenChat(chat); }}
                         onChanged={reloadChats} toast={toast}/>
      )}
    </div>
  );
}

function DesktopRail({ tab, onChange, unread, plannerCount, missedCalls, onLogout, tabs = TABS }) {
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
          <div key={entry.key} onClick={() => onChange(entry.key)} title={entry.label}
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
            }}>{entry.label}</div>

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
    }}>{text}</div>
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
