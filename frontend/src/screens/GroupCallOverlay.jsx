import { useEffect, useRef, useState } from "react";
import { Chats, Messages, newClientMessageId } from "../api.js";
import { Av, Button, G, I, useCallLayout } from "../ui.jsx";
import { AudioOutputPicker, CallButton, MoreMenu, VideoTag, canPickAudioOutput, mmss } from "./CallOverlay.jsx";
import { useCallRecording } from "../useCallRecording.js";

/** Any current participant can add people; a chat member already in the
 * call or already in `existingIds` (the call's own participants) is
 * filtered out client-side, and the server re-checks calling_permitted()
 * for each target regardless. */
function AddPeoplePicker({ chatId, existingIds, onAdd, onClose }) {
  const [members, setMembers] = useState(null);
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    Chats.get(chatId).then((chat) => setMembers(chat.members || [])).catch(() => setMembers([]));
  }, [chatId]);

  const candidates = (members || []).filter((m) => !existingIds.includes(m.id));

  function toggle(userId) {
    setSelected((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#182234", borderTopLeftRadius: 20,
        borderTopRightRadius: 20, padding: "18px 14px 24px", color: "#fff",
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Add people to this call</div>
        {members === null ? (
          <div style={{ fontSize: 13, color: "#ffffff88" }}>Loading…</div>
        ) : candidates.length === 0 ? (
          <div style={{ fontSize: 13, color: "#ffffff88" }}>Everyone in this chat is already here.</div>
        ) : (
          <div style={{ maxHeight: 280, overflowY: "auto", marginBottom: 14 }}>
            {candidates.map((person) => (
              <label key={person.id} onClick={(e) => e.stopPropagation()} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", cursor: "pointer",
              }}>
                <input type="checkbox" checked={selected.includes(person.id)}
                       onChange={() => toggle(person.id)}/>
                <Av av={person.avatar_letter} color={person.color} size={30}/>
                <div style={{ fontSize: 13.5 }}>{person.name}</div>
              </label>
            ))}
          </div>
        )}
        <button onClick={() => { onAdd(selected); onClose(); }} disabled={selected.length === 0}
                style={{
                  width: "100%", padding: 12, borderRadius: 10, border: "none", cursor: "pointer",
                  background: selected.length ? G.accent : "#ffffff26",
                  color: "#fff", fontWeight: 600, opacity: selected.length ? 1 : 0.6,
                }}>
          {selected.length ? `Add (${selected.length})` : "Select someone to add"}
        </button>
      </div>
    </div>
  );
}

/**
 * Splits everyone currently on the call into N new rooms. Assignment is
 * auto (round-robin) rather than drag-and-drop — simpler, and reassignable
 * any time by just running this again (a second call just creates a fresh
 * batch of rooms; the old ones are still ordinary group chats, never
 * deleted, just no longer what "the" breakout rooms are).
 */
function BreakoutRoomsSetup({ chatId, myUserId, participants, onClose }) {
  const [roomCount, setRoomCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const everyone = [myUserId, ...Object.keys(participants)];

  async function create() {
    setBusy(true);
    setError("");
    const assignments = {};
    everyone.forEach((userId, i) => { assignments[userId] = i % roomCount; });
    try {
      await Chats.createBreakoutRooms(chatId, assignments);
      onClose();
    } catch (problem) {
      setError(problem.message || "Could not create breakout rooms");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#182234", borderTopLeftRadius: 20,
        borderTopRightRadius: 20, padding: "18px 14px 24px", color: "#fff",
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Breakout rooms</div>
        <div style={{ fontSize: 12.5, color: "#ffffff88", marginBottom: 16 }}>
          Splits everyone here evenly into new rooms — each shows up as a "Join" prompt on their screen.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <span style={{ fontSize: 13 }}>Number of rooms</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
            <button onClick={() => setRoomCount((n) => Math.max(2, n - 1))} style={{
              width: 28, height: 28, borderRadius: "50%", border: "1px solid #ffffff33",
              background: "transparent", color: "#fff", cursor: "pointer", fontSize: 16,
            }}>−</button>
            <span style={{ fontSize: 15, fontWeight: 700, minWidth: 16, textAlign: "center" }}>{roomCount}</span>
            <button onClick={() => setRoomCount((n) => Math.min(everyone.length, n + 1))} style={{
              width: 28, height: 28, borderRadius: "50%", border: "1px solid #ffffff33",
              background: "transparent", color: "#fff", cursor: "pointer", fontSize: 16,
            }}>+</button>
          </div>
        </div>
        {error && <div style={{ fontSize: 12.5, color: "#ff8080", marginBottom: 12 }}>{error}</div>}
        <button onClick={create} disabled={busy || roomCount < 2} style={{
          width: "100%", padding: 12, borderRadius: 10, border: "none", cursor: "pointer",
          background: G.accent, color: "#fff", fontWeight: 600, opacity: busy ? 0.6 : 1,
        }}>
          {busy ? "Creating…" : `Create ${roomCount} rooms`}
        </button>
      </div>
    </div>
  );
}

/**
 * Chat + participant list, docked to the right of the call on desktop full
 * screen (the only place a fixed-width panel doesn't just eat the whole
 * narrow call frame) and a full-screen slide-over everywhere else — same
 * visual language as the app's other bottom sheets, just filling the whole
 * screen instead of sliding up partway, since a 340px chat panel squeezed
 * under a mobile-width call frame has nowhere sensible to sit otherwise.
 *
 * Replaces two things that used to be separate: the old ParticipantsList
 * bottom sheet (now this panel's "People" tab), and the "Chat" button,
 * which used to just minimize the call to reveal the underlying ChatView —
 * now it opens a live view of that same chat without leaving the call.
 */
function SidePanel({
  tab, onTabChange, onClose, call, myUserId, isHost, isDesktop, expanded,
  onKick, onMute, onTransferHost, events, send,
}) {
  const docked = isDesktop && expanded;
  return (
    <div style={docked ? {
      width: 340, flexShrink: 0, background: "#111a2c", borderLeft: "1px solid #ffffff1a",
      display: "flex", flexDirection: "column", height: "100%",
    } : {
      position: "fixed", inset: 0, zIndex: 1100, background: "#0b1220",
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "flex", alignItems: "center", padding: "12px 14px",
        borderBottom: "1px solid #ffffff1a", gap: 6, flexShrink: 0,
      }}>
        <div onClick={() => onTabChange("chat")} style={{
          padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
          background: tab === "chat" ? "#ffffff1a" : "transparent",
        }}>Chat</div>
        <div onClick={() => onTabChange("people")} style={{
          padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600,
          background: tab === "people" ? "#ffffff1a" : "transparent",
        }}>People ({Object.keys(call.participants).length + 1})</div>
        <div onClick={onClose} style={{
          marginLeft: "auto", cursor: "pointer", fontSize: 20, color: "#ffffff88", padding: "0 4px",
        }}>×</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "chat" ? (
          <ChatPanel chatId={call.chatId} myUserId={myUserId} participants={call.participants} events={events}/>
        ) : (
          <PeoplePanel call={call} myUserId={myUserId} isHost={isHost}
                       onKick={onKick} onMute={onMute} onTransferHost={onTransferHost}/>
        )}
      </div>
    </div>
  );
}

function PeoplePanel({ call, myUserId, isHost, onKick, onMute, onTransferHost }) {
  const others = Object.entries(call.participants);

  function exportCsv() {
    const rows = [
      ["Name", "User ID", "Muted", "Hand raised"],
      ["You", myUserId || "", call.muted ? "yes" : "no", call.handRaised ? "yes" : "no"],
      ...others.map(([userId, p]) => [
        p.name || "", userId, p.mutedByHost ? "yes" : "no", p.handRaised ? "yes" : "no",
      ]),
    ];
    // Quoting every field (and doubling embedded quotes) is the one rule
    // that keeps a name containing a comma from splitting into extra
    // columns when this is opened in Excel/Sheets.
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `talkex-meeting-participants-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "10px 14px", color: "#fff" }}>
      <div onClick={exportCsv} title="Download participant list as CSV" style={{
        display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
        fontSize: 12.5, color: "#ffffffaa", marginBottom: 10, width: "fit-content",
      }}>⭳ Export list</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px" }}>
        <Av av="Y" color={G.accent} size={34}/>
        <div style={{ flex: 1, fontSize: 13.5 }}>You{isHost ? " · host" : ""}</div>
        {call.muted && I.micOff("#ffffff88", 15)}
        {call.handRaised && <span style={{ fontSize: 15 }}>✋</span>}
      </div>
      {others.map(([userId, participant]) => (
        <div key={userId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px" }}>
          <Av av={participant.avatar} color={participant.color} size={34}/>
          <div style={{ flex: 1, fontSize: 13.5 }}>{participant.name}</div>
          {participant.mutedByHost && I.micOff("#ffffff88", 15)}
          {participant.handRaised && <span style={{ fontSize: 15 }}>✋</span>}
          {isHost && (
            <>
              <div onClick={() => onMute(userId)} title="Mute this person" style={{
                cursor: "pointer", color: "#ffffffaa", fontSize: 12.5, marginLeft: 8,
              }}>Mute</div>
              <div onClick={() => onTransferHost(userId)} title="Make this person the host" style={{
                cursor: "pointer", color: "#ffffffaa", fontSize: 12.5, marginLeft: 8,
              }}>Make host</div>
              <div onClick={() => onKick(userId)} title="Remove from call" style={{
                cursor: "pointer", color: "#ff8080", fontSize: 12.5, marginLeft: 8,
              }}>Remove</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;
const linkPreviewCache = new Map();

function LinkPreviewCard({ url }) {
  const [preview, setPreview] = useState(() => linkPreviewCache.get(url) || null);

  useEffect(() => {
    if (linkPreviewCache.has(url)) return;
    let cancelled = false;
    Chats.linkPreview(url).then((data) => {
      linkPreviewCache.set(url, data);
      if (!cancelled) setPreview(data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  if (!preview || (!preview.title && !preview.image)) return null;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{
      display: "flex", gap: 8, marginTop: 6, padding: 8, borderRadius: 8,
      background: "#ffffff0d", border: "1px solid #ffffff1a", textDecoration: "none", color: "#fff",
      maxWidth: 260,
    }}>
      {preview.image && (
        <img src={preview.image} alt="" style={{
          width: 48, height: 48, borderRadius: 6, objectFit: "cover", flexShrink: 0,
        }}/>
      )}
      <div style={{ minWidth: 0 }}>
        {preview.title && (
          <div style={{
            fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
          }}>{preview.title}</div>
        )}
        <div style={{ fontSize: 11, color: "#ffffff88", marginTop: 2 }}>{preview.site_name}</div>
      </div>
    </a>
  );
}

/**
 * A compact live view of the SAME persisted chat this call belongs to — not
 * a separate ephemeral in-call protocol. Sends through the normal Messages
 * API and reads new arrivals off the shared `events` array the same way
 * Whiteboard reads its own draw events, so anything sent here shows up in
 * the ordinary chat screen too (and vice versa) — it's one conversation,
 * just viewable without leaving the call.
 */
function ChatPanel({ chatId, myUserId, participants, events }) {
  const [messages, setMessages] = useState(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const lastAppliedN = useRef(0);
  const listRef = useRef(null);

  useEffect(() => {
    Messages.list(chatId).then((list) => setMessages(list)).catch(() => setMessages([]));
  }, [chatId]);

  useEffect(() => {
    const fresh = events.filter((event) => event._n > lastAppliedN.current
      && event.type === "message" && event.message?.chat_id === chatId);
    if (fresh.length === 0) return;
    lastAppliedN.current = events[events.length - 1]._n;
    setMessages((current) => {
      const known = new Set((current || []).map((m) => m.id));
      const additions = fresh.map((event) => event.message).filter((m) => !known.has(m.id));
      return additions.length ? [...(current || []), ...additions] : current;
    });
  }, [events, chatId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function sendMessage() {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setText("");
    try {
      const stored = await Messages.send({
        chat_id: chatId, text: trimmed, kind: "text", client_msg_id: newClientMessageId(),
      });
      setMessages((current) => {
        const known = new Set((current || []).map((m) => m.id));
        return known.has(stored.id) ? current : [...(current || []), stored];
      });
    } catch {
      setText(trimmed); // give it back so the attempt isn't just silently lost
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "10px 14px" }}>
        {messages === null ? (
          <div style={{ fontSize: 12.5, color: "#ffffff77" }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "#ffffff77" }}>No messages yet — say hi.</div>
        ) : messages.filter((m) => m.kind === "text" || !m.kind).map((message) => {
          const mine = message.sender_id === myUserId;
          const name = mine ? "You" : participants[message.sender_id]?.name || "Someone";
          const url = message.text?.match(URL_PATTERN)?.[0];
          return (
            <div key={message.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#ffffff88", marginBottom: 2 }}>{name}</div>
              <div style={{
                display: "inline-block", maxWidth: "100%", padding: "7px 10px", borderRadius: 10,
                background: mine ? G.accent : "#ffffff14", color: "#fff", fontSize: 13, wordBreak: "break-word",
              }}>{message.text}</div>
              {url && <LinkPreviewCard url={url}/>}
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid #ffffff1a" }}>
        <input value={text} onChange={(event) => setText(event.target.value)}
               onKeyDown={(event) => { if (event.key === "Enter") sendMessage(); }}
               placeholder="Message" style={{
                 flex: 1, background: "#ffffff14", border: "none", borderRadius: 20,
                 padding: "9px 14px", color: "#fff", fontSize: 13, outline: "none",
               }}/>
        <button onClick={sendMessage} disabled={sending || !text.trim()} style={{
          border: "none", borderRadius: "50%", width: 36, height: 36, cursor: "pointer",
          background: G.accent, color: "#fff", opacity: sending || !text.trim() ? 0.5 : 1,
        }}>➤</button>
      </div>
    </>
  );
}

/**
 * The group-call counterpart to CallOverlay — same full-screen mount point,
 * same button styling, but a grid of participants instead of one peer.
 * Kept as a separate component/hook pair from the 1:1 call rather than
 * generalizing one to cover both: a 1:1 call is a fixed pair with ringing
 * semantics (invite/accept/reject/busy), a group call is an open room
 * anyone can join or leave at any moment — forcing both into one state
 * machine would have made the simpler, already-shipped 1:1 path harder to
 * reason about for no real benefit.
 */
export default function GroupCallOverlay({
  call, myUserId, onAccept, onDecline, onLeave, onToggleMute, onToggleCamera, onSwitchCamera, onShareScreen,
  onSetScreenOptimization,
  onForceMuteAll, onKickParticipant, onAddPeople, onToggleWhiteboard, events, send,
  onSendReaction, onToggleRaiseHand, onToggleCaptions, onCaptionText,
  onJoinBreakoutRoom, onReturnToMainCall, onAdmitParticipant, onDenyParticipant,
  onSetPermission, onMuteParticipant, onSpotlight, onTransferHost,
}) {
  const [sinkId, setSinkId] = useState(undefined);
  const [minimized, setMinimized] = useState(false);
  const [bubblePos, setBubblePos] = useState({ x: null, y: null }); // null → default bottom-right via CSS
  const bubbleDrag = useRef(null);
  const bubbleMoved = useRef(false);
  const { expanded, toggle, isDesktop, isLandscape } = useCallLayout();

  if (!call) return null;

  // Minimizing never touches the call itself — no leave(), no torn-down
  // peer connections — it's purely "don't cover the chat right now." The
  // audio keeps playing either way; only the video grid and controls stop
  // being drawn.
  if (minimized && call.phase !== "incoming") {
    const BW = 220, BH = 46; // matches the pill's own rendered footprint
    function onBubblePointerDown(event) {
      bubbleMoved.current = false;
      const rect = event.currentTarget.getBoundingClientRect();
      bubbleDrag.current = { startX: event.clientX, startY: event.clientY, baseX: rect.left, baseY: rect.top };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    function onBubblePointerMove(event) {
      if (!bubbleDrag.current) return;
      const dx = event.clientX - bubbleDrag.current.startX;
      const dy = event.clientY - bubbleDrag.current.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) bubbleMoved.current = true;
      const nx = Math.max(6, Math.min(window.innerWidth - BW - 6, bubbleDrag.current.baseX + dx));
      const ny = Math.max(6, Math.min(window.innerHeight - BH - 6, bubbleDrag.current.baseY + dy));
      setBubblePos({ x: nx, y: ny });
    }
    function onBubblePointerUp() { bubbleDrag.current = null; }
    const anchored = bubblePos.x == null
      ? { right: 16, bottom: 90 }
      : { left: bubblePos.x, top: bubblePos.y };
    return (
      <div
        onPointerDown={onBubblePointerDown} onPointerMove={onBubblePointerMove} onPointerUp={onBubblePointerUp}
        onClick={() => { if (!bubbleMoved.current) setMinimized(false); }}
        style={{
          position: "fixed", ...anchored, zIndex: 999, cursor: "pointer", touchAction: "none",
          display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 8px 8px",
          background: "#182234", color: "#fff", borderRadius: 30,
          boxShadow: "0 4px 16px #00000055", border: "1px solid #ffffff26",
        }}>
        <div style={{
          width: 30, height: 30, borderRadius: "50%", background: G.accent,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{call.muted ? I.micOff("#fff", 14) : I.phone("#fff", 14)}</div>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Call in progress · tap to return</span>
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 999, // just under the 1:1 overlay's 1000 — a 1:1 call always wins focus
      maxWidth: expanded ? "none" : 430, margin: "0 auto",
      background: "#0b1220", color: "#fff",
      display: "flex", flexDirection: "column",
    }}>
      {call.phase === "active" && (
        <div onClick={() => setMinimized(true)} title="Minimize" style={{
          position: "absolute", top: 14, left: 14, zIndex: 1,
          width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
          background: "#ffffff1a", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, color: "#fff",
        }}>⌄</div>
      )}
      {isDesktop && (
        <div onClick={toggle} title={expanded ? "Exit full screen" : "Full screen"} style={{
          position: "absolute", top: 14, right: 14, zIndex: 1,
          width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
          background: "#ffffff1a", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {expanded ? I.shrink("#fff", 16) : I.expand("#fff", 16)}
        </div>
      )}
      {call.phase === "incoming"
        ? <IncomingGroupCall call={call} onAccept={onAccept} onDecline={onDecline}/>
        : call.phase === "waiting"
        ? <WaitingForHost call={call} onLeave={onLeave}/>
        : <ActiveGroupCall call={call} myUserId={myUserId} onLeave={onLeave} onToggleMute={onToggleMute}
                           onToggleCamera={onToggleCamera} onSwitchCamera={onSwitchCamera} onShareScreen={onShareScreen}
                           onSetScreenOptimization={onSetScreenOptimization}
                           onForceMuteAll={onForceMuteAll} onKickParticipant={onKickParticipant}
                           onAddPeople={onAddPeople} onToggleWhiteboard={onToggleWhiteboard}
                           onSendReaction={onSendReaction} onToggleRaiseHand={onToggleRaiseHand}
                           onToggleCaptions={onToggleCaptions} onCaptionText={onCaptionText}
                           onJoinBreakoutRoom={onJoinBreakoutRoom} onReturnToMainCall={onReturnToMainCall}
                           onAdmitParticipant={onAdmitParticipant} onDenyParticipant={onDenyParticipant}
                           onSetPermission={onSetPermission} onMuteParticipant={onMuteParticipant}
                           onSpotlight={onSpotlight} onTransferHost={onTransferHost}
                           expanded={expanded} isDesktop={isDesktop} isLandscape={isLandscape}
                           events={events} send={send}
                           sinkId={sinkId} onSinkId={setSinkId}/>}
    </div>
  );
}

function WaitingForHost({ call, onLeave }) {
  return (
    <>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <div style={{
          width: 64, height: 64, borderRadius: "50%", background: "#ffffff1a",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
        }}>⏳</div>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Waiting for the host to let you in…</div>
        <div style={{ fontSize: 13, color: "#ffffffaa" }}>This meeting has a waiting room turned on.</div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", padding: "0 40px 60px" }}>
        <CallButton onClick={onLeave} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Cancel"/>
      </div>
    </>
  );
}

function IncomingGroupCall({ call, onAccept, onDecline }) {
  return (
    <>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 80 }}>
        <Av av={call.inviterAvatar} color={call.inviterColor} size={100}/>
        <div style={{ fontSize: 20, fontWeight: 600 }}>{call.inviterName} started a call</div>
        <div style={{ fontSize: 14, color: "#ffffffaa" }}>
          Incoming group {call.callKind === "video" ? "video" : "voice"} call…
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-around", padding: "0 40px 60px" }}>
        <CallButton onClick={onDecline} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Decline"/>
        <CallButton onClick={onAccept} background="#22c55e" icon={I.phone("#fff", 24)} label="Join"/>
      </div>
    </>
  );
}

const REACTION_EMOJIS = ["👍", "❤️", "👏", "😂", "🎉"];

// Chrome/Edge only (no Firefox/Safari) — the same shape of gate as
// canPickAudioOutput in CallOverlay.jsx: feature-detected once, everywhere
// else just trusts it rather than re-checking.
const canUseSpeechRecognition = typeof window !== "undefined"
  && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Non-visual — owns the browser's local SpeechRecognition instance and
 * hands each finished phrase up via onText. There is no server-side speech
 * pipeline anywhere in this app: every participant's browser transcribes
 * only its OWN microphone, which is also the only audio the Web Speech API
 * can actually listen to from a web page.
 */
function LiveCaptions({ enabled, onText }) {
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (!enabled || !canUseSpeechRecognition) return;
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (result.isFinal) onText(result[0].transcript.trim());
    };
    recognition.onend = () => {
      // Chrome stops a continuous session on its own after a while — restart
      // for as long as captions are still meant to be on.
      if (recognitionRef.current === recognition) {
        try { recognition.start(); } catch { /* already starting */ }
      }
    };
    recognition.onerror = () => {};
    try { recognition.start(); } catch { /* a mic permission prompt already in flight, etc. */ }
    recognitionRef.current = recognition;

    return () => {
      recognitionRef.current = null;
      recognition.stop();
    };
  }, [enabled, onText]);

  return null;
}

function ActiveGroupCall({
  call, myUserId, onLeave, onToggleMute, onToggleCamera, onSwitchCamera, onShareScreen,
  onSetScreenOptimization,
  onForceMuteAll, onKickParticipant, onAddPeople, onToggleWhiteboard,
  onSendReaction, onToggleRaiseHand, onToggleCaptions, onCaptionText,
  onJoinBreakoutRoom, onReturnToMainCall,
  onAdmitParticipant, onDenyParticipant,
  onSetPermission, onMuteParticipant, onSpotlight, onTransferHost,
  expanded, isDesktop, isLandscape, events, send,
  sinkId, onSinkId,
}) {
  const [showSpeakerPicker, setShowSpeakerPicker] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showPanel, setShowPanel] = useState(null); // null | "chat" | "people"
  const [showBreakoutSetup, setShowBreakoutSetup] = useState(false);
  const [showAnnotate, setShowAnnotate] = useState(false);
  const [closingBreakout, setClosingBreakout] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const recorder = useCallRecording(call);
  const others = Object.entries(call.participants);
  const tileCount = others.length + 1; // + yourself
  // Landscape gives more horizontal room — use more columns so tiles are
  // wider than tall (matching the screen's own aspect) instead of stacking
  // vertically and wasting the sides. Portrait keeps the old 1-or-2 rule.
  const columns = isLandscape
    ? (tileCount <= 1 ? 1 : tileCount <= 4 ? 2 : 3)
    : (tileCount <= 2 ? 1 : 2);
  const isHost = myUserId != null && call.hostId === myUserId;
  // Screen share wins the main stage over a spotlight when both happen to
  // be active — the shared content is almost always what everyone actually
  // wants to look at, same precedence Zoom/Meet use.
  const mainStageUserId = call.screenSharerId || call.spotlightUserId || null;
  const toggleSpotlight = (userId) => onSpotlight(call.spotlightUserId === userId ? null : userId);

  return (
    <>
      <div style={{ position: "relative", flex: 1, overflow: "hidden", display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}>
          {mainStageUserId ? (
            <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 2, padding: 2 }}>
              <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
                {mainStageUserId === myUserId ? (
                  <SelfTile call={call} isHost={isHost} onSwitchCamera={onSwitchCamera}/>
                ) : (
                  <ParticipantTile participant={call.participants[mainStageUserId]} sinkId={sinkId}
                                   canKick={isHost} onKick={() => onKickParticipant(mainStageUserId)}
                                   canSpotlight={isHost} isSpotlighted={call.spotlightUserId === mainStageUserId}
                                   onToggleSpotlight={() => toggleSpotlight(mainStageUserId)}/>
                )}
              </div>
              <div style={{ display: "flex", gap: 2, overflowX: "auto", height: isLandscape ? 64 : 84, flexShrink: 0 }}>
                {mainStageUserId !== myUserId && (
                  <div style={{ width: isLandscape ? 100 : 120, flexShrink: 0 }}>
                    <SelfTile call={call} isHost={isHost} onSwitchCamera={onSwitchCamera} zoomable={false}/>
                  </div>
                )}
                {others.filter(([userId]) => userId !== mainStageUserId).map(([userId, participant]) => (
                  <div key={userId} style={{ width: isLandscape ? 100 : 120, flexShrink: 0 }}>
                    <ParticipantTile participant={participant} sinkId={sinkId} zoomable={false}
                                     canKick={isHost} onKick={() => onKickParticipant(userId)}
                                     canSpotlight={isHost} isSpotlighted={false}
                                     onToggleSpotlight={() => toggleSpotlight(userId)}/>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{
              height: "100%", display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`,
              gap: 2, padding: 2, overflow: "hidden",
            }}>
              <SelfTile call={call} isHost={isHost} onSwitchCamera={onSwitchCamera}/>
              {others.map(([userId, participant]) => (
                <ParticipantTile key={userId} participant={participant} sinkId={sinkId}
                                 canKick={isHost} onKick={() => onKickParticipant(userId)}
                                 canSpotlight={isHost} isSpotlighted={false}
                                 onToggleSpotlight={() => toggleSpotlight(userId)}/>
              ))}
            </div>
          )}
          <ReactionOverlay reaction={call.lastReaction}/>
        {recorder.recording && (
          <div style={{
            position: "absolute", top: 10, left: 10, display: "flex", alignItems: "center", gap: 6,
            background: "#00000088", padding: "4px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444" }}/>
            REC {mmss(recorder.elapsed)}
          </div>
        )}
        {call.captionsOn && call.captions?.length > 0 && (
          <div style={{
            position: "absolute", bottom: 8, left: 8, right: 8, display: "flex",
            flexDirection: "column", gap: 2, pointerEvents: "none",
          }}>
            {call.captions.map((line) => (
              <div key={line.key} style={{
                background: "#000000aa", color: "#fff", fontSize: 12.5, padding: "4px 10px",
                borderRadius: 8, alignSelf: "flex-start",
              }}><b>{line.from === "me" ? "You" : line.from}:</b> {line.text}</div>
            ))}
          </div>
        )}
        </div>
        {showPanel && (
          <SidePanel tab={showPanel} onTabChange={setShowPanel} onClose={() => setShowPanel(null)}
                     call={call} myUserId={myUserId} isHost={isHost} isDesktop={isDesktop} expanded={expanded}
                     onKick={onKickParticipant} onMute={onMuteParticipant} onTransferHost={onTransferHost}
                     events={events} send={send}/>
        )}
      </div>
      <LiveCaptions enabled={Boolean(call.captionsOn)} onText={onCaptionText}/>

      {(() => {
        const myRoom = call.breakoutRooms?.find((r) => r.member_ids.includes(myUserId));
        if (!myRoom) return null;
        return (
          <div style={{
            display: "flex", alignItems: "center", gap: 10, margin: "0 16px 10px", padding: "10px 14px",
            background: "#22c55e22", border: "1px solid #22c55e55", borderRadius: 12,
          }}>
            <div style={{ flex: 1, fontSize: 13 }}>You've been moved to <b>{myRoom.name}</b></div>
            <Button onClick={() => onJoinBreakoutRoom(myRoom.chat_id, call.chatId, call.callKind)}
                    style={{ padding: "7px 14px" }}>Join</Button>
          </div>
        );
      })()}
      {call.breakoutRoomsClosed && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, margin: "0 16px 10px", padding: "10px 14px",
          background: "#facc1522", border: "1px solid #facc1555", borderRadius: 12,
        }}>
          <div style={{ flex: 1, fontSize: 13 }}>Breakout rooms have ended</div>
          <Button onClick={onReturnToMainCall} style={{ padding: "7px 14px" }}>Return to main call</Button>
        </div>
      )}

      {(call.joinRequests || []).map((request) => (
        <div key={request.user_id} style={{
          display: "flex", alignItems: "center", gap: 10, margin: "0 16px 10px", padding: "10px 14px",
          background: "#38bdf822", border: "1px solid #38bdf855", borderRadius: 12,
        }}>
          <Av av={request.avatar} color={request.color} size={28}/>
          <div style={{ flex: 1, fontSize: 13 }}><b>{request.name}</b> wants to join</div>
          <div onClick={() => onDenyParticipant(request.user_id)} style={{
            cursor: "pointer", fontSize: 12.5, color: "#ff8080", padding: "6px 10px",
          }}>Deny</div>
          <Button onClick={() => onAdmitParticipant(request.user_id)} style={{ padding: "6px 12px" }}>Admit</Button>
        </div>
      ))}

      {call.sharingScreen && (
        <div style={{
          alignSelf: "center", margin: "0 0 8px", padding: "5px 10px", borderRadius: 8,
          background: "#ef444422", border: "1px solid #ef444455", color: "#ff8080",
          fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
        }}>{I.screenShare("#ff8080", 13)} Sharing screen</div>
      )}

      <div style={{
        display: "flex", justifyContent: "center",
        gap: isLandscape ? 10 : 16,
        // Landscape: compact padding so the buttons don't eat the already-
        // short vertical space. Portrait: 60px bottom absorbs the phone's
        // home-indicator/safe-area bar.
        padding: isLandscape ? "6px 16px 10px" : "16px 20px 60px",
        flexWrap: "wrap",
      }}>
        <CallButton onClick={onToggleMute} background={call.muted ? "#fff" : "#ffffff26"}
                    icon={call.muted ? I.micOff("#0b1220", 20) : I.mic("#fff", 20)} label="Mute" small/>
        <CallButton onClick={onToggleCamera} background={call.cameraOff ? "#fff" : "#ffffff26"}
                    icon={call.cameraOff ? I.videoOff("#0b1220", 20) : I.video("#fff", 20)}
                    label={call.callKind === "video" ? "Camera" : "Video"} small/>
        <CallButton onClick={() => setShowReactions((v) => !v)} background="#ffffff26"
                    icon={<span style={{ fontSize: 20 }}>😊</span>} label="React" small/>
        <CallButton onClick={onToggleRaiseHand} background={call.handRaised ? "#facc15" : "#ffffff26"}
                    icon={<span style={{ fontSize: 20 }}>✋</span>} label="Hand" small/>
        <CallButton onClick={() => setShowPanel("chat")} background="#ffffff26"
                    icon={<span style={{ fontSize: 18 }}>💬</span>} label="Chat" small/>
        {canPickAudioOutput && (
          <CallButton onClick={() => setShowSpeakerPicker(true)} background="#ffffff26"
                      icon={I.volume("#fff", 20)} label="Speaker" small/>
        )}
        <CallButton onClick={() => setShowMore(true)} background="#ffffff26"
                    icon={I.moreVertical("#fff", 20)} label="More" small/>
        <CallButton onClick={onLeave} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Leave"/>
      </div>

      {showReactions && (
        <div onClick={() => setShowReactions(false)} style={{
          position: "fixed", inset: 0, zIndex: 1100,
        }}>
          <div onClick={(event) => event.stopPropagation()} style={{
            position: "absolute", bottom: isLandscape ? 60 : 130, left: "50%", transform: "translateX(-50%)",
            display: "flex", gap: 8, background: "#182234", border: "1px solid #ffffff26",
            borderRadius: 30, padding: "10px 14px",
          }}>
            {REACTION_EMOJIS.map((emoji) => (
              <div key={emoji} onClick={() => { onSendReaction(emoji); setShowReactions(false); }}
                   style={{ fontSize: 24, cursor: "pointer" }}>{emoji}</div>
            ))}
          </div>
        </div>
      )}

      {showSpeakerPicker && (
        <AudioOutputPicker current={sinkId} onSelect={onSinkId} onClose={() => setShowSpeakerPicker(false)}/>
      )}
      {showMore && (
        <MoreMenu onClose={() => setShowMore(false)} items={[
          {
            label: call.sharingScreen ? "Stop sharing screen" : "Share screen",
            // Deliberately not `disabled` — a host-only restriction is
            // enforced server-side (group_call_screen_share_start) and
            // rejection already surfaces as a toast via
            // group_call_action_denied. A disabled row here just silently
            // eats the tap with no explanation, which reads as "broken"
            // rather than "not allowed" — and would have wrongly blocked a
            // sharer from tapping "Stop sharing" if the host changed the
            // policy mid-share, since sharingScreen isn't part of this check.
            sub: call.permissions?.screen_share === "host" && !isHost && !call.sharingScreen
              ? "Only the host allows this right now" : undefined,
            icon: I.screenShare("#fff", 18),
            onClick: onShareScreen,
          },
          ...(call.sharingScreen ? [{
            label: `Optimize for video ${call.screenOptimizeFor === "motion" ? "●" : "○"}`,
            sub: "Smoother motion, softer detail — best for playing a video",
            icon: <span style={{ fontSize: 15 }}>🎞️</span>,
            onClick: () => onSetScreenOptimization("motion"),
          }, {
            label: `Optimize for text ${call.screenOptimizeFor === "detail" ? "●" : "○"}`,
            sub: "Crisper static frames — best for a document or code",
            icon: <span style={{ fontSize: 15 }}>📄</span>,
            onClick: () => onSetScreenOptimization("detail"),
          }] : []),
          {
            label: "Add people",
            icon: I.user("#fff", 18),
            onClick: () => setShowAddPeople(true),
          },
          {
            label: call.whiteboardOpen ? "Close whiteboard" : "Whiteboard",
            // Same reasoning as Share screen above — not disabled, the
            // server-side check (whiteboard_open in main.py) is what
            // actually enforces this, and a denial already surfaces as a
            // toast plus reverting the optimistic open (see
            // group_call_action_denied in useGroupCall.js).
            sub: call.permissions?.whiteboard === "host" && !isHost && !call.whiteboardOpen
              ? "Only the host allows this right now" : undefined,
            icon: I.edit("#fff", 18),
            onClick: onToggleWhiteboard,
          },
          {
            label: showAnnotate ? "Stop annotating" : "Annotate on shared screen",
            sub: call.sharingScreen ? undefined : "Someone needs to be sharing their screen first",
            icon: <span style={{ fontSize: 15 }}>🖊️</span>,
            disabled: !call.sharingScreen && !showAnnotate,
            onClick: () => setShowAnnotate((v) => !v),
          },
          {
            label: recorder.recording ? "Stop recording" : "Start recording",
            sub: recorder.recording ? undefined : "Saved to your device when you stop — not stored anywhere else",
            icon: <span style={{
              width: 12, height: 12, borderRadius: recorder.recording ? 3 : "50%", background: "#ef4444",
            }}/>,
            onClick: recorder.recording ? recorder.stop : recorder.start,
          },
          {
            label: call.captionsOn ? "Turn off live captions" : "Live captions",
            sub: canUseSpeechRecognition
              ? "Your own speech only — each person's browser transcribes itself"
              : "Not supported in this browser",
            icon: <span style={{ fontSize: 15 }}>💬</span>,
            disabled: !canUseSpeechRecognition,
            onClick: onToggleCaptions,
          },
          {
            label: "Participants",
            icon: I.user("#fff", 18),
            onClick: () => setShowPanel("people"),
          },
          {
            label: "Mute everyone",
            sub: isHost ? undefined : "Only the person who started this call can do that",
            icon: I.micOff("#fff", 18),
            disabled: !isHost,
            onClick: onForceMuteAll,
          },
          ...(isHost ? [{
            label: `Screen share: ${call.permissions?.screen_share === "host" ? "Host only" : "Everyone"}`,
            sub: "Tap to switch who's allowed to share their screen",
            icon: I.screenShare("#fff", 18),
            onClick: () => onSetPermission(
              "screen_share", call.permissions?.screen_share === "host" ? "everyone" : "host"),
          }, {
            label: `Whiteboard: ${call.permissions?.whiteboard === "host" ? "Host only" : "Everyone"}`,
            sub: "Tap to switch who's allowed to open the whiteboard",
            icon: I.edit("#fff", 18),
            onClick: () => onSetPermission(
              "whiteboard", call.permissions?.whiteboard === "host" ? "everyone" : "host"),
          }] : []),
          {
            label: "Breakout rooms",
            sub: isHost ? undefined : "Only the person who started this call can do that",
            icon: I.user("#fff", 18),
            disabled: !isHost,
            onClick: () => setShowBreakoutSetup(true),
          },
          ...(call.breakoutRooms || call.breakoutParentChatId ? [{
            label: "Close breakout rooms",
            icon: <span style={{ fontSize: 15 }}>↩</span>,
            disabled: closingBreakout,
            onClick: async () => {
              setClosingBreakout(true);
              try { await Chats.closeBreakoutRooms(call.breakoutParentChatId || call.chatId); }
              catch { /* most likely "not the person who created them" — a silent no-op is fine here */ }
              setClosingBreakout(false);
            },
          }] : []),
        ]}/>
      )}
      {showAddPeople && (
        <AddPeoplePicker chatId={call.chatId}
                         existingIds={[myUserId, ...Object.keys(call.participants)]}
                         onAdd={onAddPeople} onClose={() => setShowAddPeople(false)}/>
      )}
      {call.whiteboardOpen && (
        <Whiteboard chatId={call.chatId} events={events} send={send} onClose={onToggleWhiteboard} expanded={expanded}/>
      )}
      {showAnnotate && (
        <Whiteboard chatId={call.chatId} events={events} send={send}
                   onClose={() => setShowAnnotate(false)} transparent expanded={expanded}/>
      )}
      {showBreakoutSetup && (
        <BreakoutRoomsSetup chatId={call.chatId} myUserId={myUserId} participants={call.participants}
                            onClose={() => setShowBreakoutSetup(false)}/>
      )}
    </>
  );
}

function SelfTile({ call, isHost, onSwitchCamera, zoomable = true }) {
  const showVideo = (call.callKind === "video" || call.sharingScreen) && !call.cameraOff && call.localStream;
  // Front camera feeds look backwards to the person on them (text/gestures
  // reversed) unless mirrored — same fix as CallOverlay's 1:1 self-view.
  // Never applies to the rear camera or a shared screen.
  const selfMirror = !call.sharingScreen && call.facingMode !== "environment"
    ? { transform: "scaleX(-1)" } : undefined;
  return (
    <div style={{
      position: "relative", background: "#142235", borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    }}>
      {showVideo ? (
        <VideoTag stream={call.localStream} muted zoomable={zoomable}
                  style={{ width: "100%", height: "100%", objectFit: "cover", ...selfMirror }}/>
      ) : (
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: G.accent }}/>
      )}
      {call.handRaised && (
        <div style={{ position: "absolute", top: 6, left: 8, fontSize: 18 }}>✋</div>
      )}
      {showVideo && onSwitchCamera && (
        <div onClick={onSwitchCamera} title="Switch camera" style={{
          position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: "50%",
          background: "#00000066", display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer",
        }}>
          {I.cameraFlip("#fff", 14)}
        </div>
      )}
      <div style={{
        position: "absolute", bottom: 6, left: 8, fontSize: 11.5, color: "#ffffffcc",
        background: "#00000066", padding: "2px 8px", borderRadius: 8,
      }}>You{isHost ? " · host" : ""}{call.muted ? " · muted" : ""}</div>
    </div>
  );
}

/**
 * A floating emoji that rises and fades, one per reaction — purely a visual
 * effect, nothing about `reaction` is kept once its animation ends. Keyed by
 * `reaction.key` so the exact same emoji sent twice in a row still mounts a
 * fresh element (React would otherwise treat an unchanged key as "nothing
 * to animate").
 */
function ReactionOverlay({ reaction }) {
  const [visible, setVisible] = useState(null);

  useEffect(() => {
    if (!reaction) return;
    setVisible(reaction);
    const timer = setTimeout(() => setVisible(null), 2000);
    return () => clearTimeout(timer);
  }, [reaction]);

  if (!visible) return null;
  return (
    <div key={visible.key} style={{
      position: "absolute", bottom: 20, left: "50%", fontSize: 42,
      animation: "txFloatUp 2s ease-out forwards", pointerEvents: "none",
    }}>
      {visible.emoji}
      <style>{`@keyframes txFloatUp { 0% { transform: translate(-50%, 0); opacity: 1; } 100% { transform: translate(-50%, -160px); opacity: 0; } }`}</style>
    </div>
  );
}

function ParticipantTile({
  participant, sinkId, canKick, onKick, canSpotlight, isSpotlighted, onToggleSpotlight, zoomable = true,
}) {
  const hasVideo = participant.stream?.getVideoTracks().length > 0;
  return (
    <div style={{
      position: "relative", background: "#142235", borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    }}>
      {/* Always mounted so this participant's audio plays even with no
          video track (voice call, or their camera's off) — hidden rather
          than unmounted, same reasoning as CallOverlay's remote VideoTag. */}
      <VideoTag stream={participant.stream} sinkId={sinkId} zoomable={zoomable} style={hasVideo ? {
        width: "100%", height: "100%", objectFit: "cover",
      } : { display: "none" }}/>
      {!hasVideo && <Av av={participant.avatar} color={participant.color} size={64}/>}
      {participant.handRaised && (
        <div style={{ position: "absolute", top: 6, left: 8, fontSize: 18 }}>✋</div>
      )}
      <div style={{
        position: "absolute", bottom: 6, left: 8, fontSize: 11.5, color: "#ffffffcc",
        background: "#00000066", padding: "2px 8px", borderRadius: 8,
        display: "flex", alignItems: "center", gap: 4,
      }}>
        {participant.name}
        {participant.mutedByHost && I.micOff("#ffffffcc", 11)}
      </div>
      {!participant.stream && (
        <div style={{ position: "absolute", top: 6, right: 8, fontSize: 10.5, color: "#ffffff99" }}>
          connecting…
        </div>
      )}
      <div style={{ position: "absolute", top: 6, right: 8, display: "flex", gap: 6 }}>
        {canSpotlight && (
          <div onClick={onToggleSpotlight} title={isSpotlighted ? "Remove spotlight" : "Spotlight for everyone"}
               style={{
                 width: 22, height: 22, borderRadius: "50%", cursor: "pointer", fontSize: 12,
                 background: isSpotlighted ? G.accent : "#00000088",
                 display: "flex", alignItems: "center", justifyContent: "center",
               }}>📌</div>
        )}
        {canKick && (
          <div onClick={onKick} title="Remove from call" style={{
            width: 22, height: 22, borderRadius: "50%",
            background: "#00000088", color: "#ff8080", fontSize: 15, lineHeight: "22px",
            textAlign: "center", cursor: "pointer",
          }}>×</div>
        )}
      </div>
    </div>
  );
}

const WHITEBOARD_COLORS = [
  "#f8fafc", "#ef4444", "#f59e0b", "#22c55e", "#38bdf8", "#a855f7",
  "#000000", "#6b7280", "#f97316", "#ec4899", "#14b8a6", "#3b82f6",
];

const PEN_SIZES = [
  { key: "S", size: 2 },
  { key: "M", size: 4 },
  { key: "L", size: 8 },
];

// Tools organized into categories for the tabbed toolbar
const TOOL_CATEGORIES = [
  {
    label: "Draw", tools: [
      { key: "pen", label: "Pen", icon: "✏️" },
      { key: "marker", label: "Marker", icon: "🖊️" },
      { key: "highlighter", label: "Highlighter", icon: "🖍️" },
      { key: "eraser", label: "Eraser", icon: "🧹" },
    ],
  },
  {
    label: "Shapes", tools: [
      { key: "line", label: "Line", icon: "／" },
      { key: "arrow", label: "Arrow", icon: "➡" },
      { key: "rect", label: "Rectangle", icon: "▭" },
      { key: "circle", label: "Circle", icon: "◯" },
      { key: "triangle", label: "Triangle", icon: "△" },
      { key: "star", label: "Star", icon: "⭐" },
      { key: "diamond", label: "Diamond", icon: "◇" },
    ],
  },
  {
    label: "Add", tools: [
      { key: "text", label: "Text", icon: "T" },
      { key: "math", label: "Math", icon: "∑" },
      { key: "sticky", label: "Sticky", icon: "🗒️" },
      { key: "image", label: "Image", icon: "🖼️" },
      { key: "stamp", label: "Stamp", icon: "😊" },
    ],
  },
  {
    label: "Board", tools: [
      { key: "laser", label: "Laser", icon: "🔴" },
      { key: "grid", label: "Grid", icon: "⊞" },
      { key: "ruler", label: "Ruler", icon: "📏" },
      { key: "undo", label: "Undo", icon: "↩" },
      { key: "save", label: "Save", icon: "💾" },
    ],
  },
];

const STAMP_EMOJIS = ["✓", "✗", "⭐", "❤️", "👍", "👎", "❓", "❗", "💡", "🎯", "📌", "🔥"];

const SHAPE_TOOLS = ["line", "arrow", "rect", "circle", "triangle", "star", "diamond"];

function isLightColor(hex) {
  const value = (hex || "#000000").replace("#", "");
  if (value.length !== 6) return false;
  const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function wrapCanvasText(context, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  let line = "", lineY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (context.measureText(test).width > maxWidth && line) {
      context.fillText(line, x, lineY);
      line = word;
      lineY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) context.fillText(line, x, lineY);
}

/**
 * A shared drawing surface for the meeting — a full-featured smart board
 * with drawing, shapes, text, stamps, grid/ruler, undo, and save. Not a
 * persisted document; it exists only as long as the call room does, same
 * as screen share.
 *
 * Two families of mark, both riding the same whiteboard_draw/_clear relay:
 *   - freehand (pen/marker/highlighter/eraser): streamed point-to-point.
 *   - shapes/text/stamps: a single message sent once, on release.
 * Coordinates always travel as 0–1 fractions of canvas size so marks line
 * up on every participant's differently-sized screen.
 *
 * `transparent`, when true, is the "annotate on top of the shared screen"
 * mode — same board, same tools, just no opaque background.
 */
function Whiteboard({ chatId, events, send, onClose, transparent, expanded }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const lastPoint = useRef(null);
  const shapeStart = useRef(null);
  const snapshotRef = useRef(null);
  const lastAppliedN = useRef(0);
  const [color, setColor] = useState(WHITEBOARD_COLORS[0]);
  const [tool, setTool] = useState("pen");
  const [penSize, setPenSize] = useState(PEN_SIZES[1]); // Medium default
  const [toolTab, setToolTab] = useState(0); // which category tab is open
  const [showGrid, setShowGrid] = useState(false);
  const [showRuler, setShowRuler] = useState(false);
  const [showStampPicker, setShowStampPicker] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const fileInputRef = useRef(null);
  const [laserDots, setLaserDots] = useState({});
  const laserTimers = useRef({});
  const lastLaserSent = useRef(0);
  // Undo stack: canvas snapshots saved before each drawing action.
  // Max 20 to avoid blowing up memory on long sessions.
  const undoStack = useRef([]);
  const MAX_UNDO = 20;

  function ctx() {
    return canvasRef.current?.getContext("2d");
  }

  function saveUndoSnapshot() {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context) return;
    const snapshot = context.getImageData(0, 0, canvas.width, canvas.height);
    undoStack.current.push(snapshot);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
  }

  function undo() {
    const snapshot = undoStack.current.pop();
    if (!snapshot) return;
    ctx()?.putImageData(snapshot, 0, 0);
  }

  function resizeCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    canvas.width = clientWidth * dpr;
    canvas.height = clientHeight * dpr;
    ctx()?.scale(dpr, dpr);
  }

  useEffect(() => {
    resizeCanvas();
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => resizeCanvas());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Draw grid overlay when enabled
  useEffect(() => {
    if (!showGrid) return;
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context) return;
    function drawGrid() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      context.save();
      context.strokeStyle = "#ffffff18";
      context.lineWidth = 0.5;
      const step = 30;
      for (let x = step; x < w; x += step) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, h);
        context.stroke();
      }
      for (let y = step; y < h; y += step) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(w, y);
        context.stroke();
      }
      context.restore();
    }
    drawGrid();
  }, [showGrid]);

  function paintSegment(fromFrac, toFrac, strokeColor, size) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    context.strokeStyle = strokeColor;
    context.lineWidth = size;
    context.lineCap = "round";
    context.globalAlpha = strokeColor === "highlight" ? 0.35 : 1;
    context.globalCompositeOperation = strokeColor === "erase" ? "destination-out" : "source-over";
    context.beginPath();
    context.moveTo(fromFrac.x * w, fromFrac.y * h);
    context.lineTo(toFrac.x * w, toFrac.y * h);
    context.stroke();
    context.globalAlpha = 1;
  }

  function paintArrowhead(context, x1, y1, x2, y2, headLen) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    context.beginPath();
    context.moveTo(x2, y2);
    context.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    context.moveTo(x2, y2);
    context.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    context.stroke();
  }

  function paintShape(shapeType, startFrac, endFrac, strokeColor, size) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const x1 = startFrac.x * w, y1 = startFrac.y * h;
    const x2 = endFrac.x * w, y2 = endFrac.y * h;
    context.strokeStyle = strokeColor;
    context.lineWidth = size;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.beginPath();
    if (shapeType === "line") {
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
    } else if (shapeType === "arrow") {
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
      paintArrowhead(context, x1, y1, x2, y2, 14);
      return;
    } else if (shapeType === "rect") {
      context.rect(x1, y1, x2 - x1, y2 - y1);
    } else if (shapeType === "circle") {
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      context.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, ry, 0, 0, Math.PI * 2);
    } else if (shapeType === "triangle") {
      const midX = (x1 + x2) / 2;
      context.moveTo(midX, y1);
      context.lineTo(x2, y2);
      context.lineTo(x1, y2);
      context.closePath();
    } else if (shapeType === "star") {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const outerR = Math.min(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2;
      const innerR = outerR * 0.4;
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
        const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
        i === 0 ? context.moveTo(px, py) : context.lineTo(px, py);
      }
      context.closePath();
    } else if (shapeType === "diamond") {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const hw = Math.abs(x2 - x1) / 2, hh = Math.abs(y2 - y1) / 2;
      context.moveTo(cx, cy - hh);
      context.lineTo(cx + hw, cy);
      context.lineTo(cx, cy + hh);
      context.lineTo(cx - hw, cy);
      context.closePath();
    }
    context.stroke();
  }

  function paintText(startFrac, text, strokeColor, fontSize) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !text) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.fillStyle = strokeColor;
    context.font = `${fontSize || 20}px sans-serif`;
    context.fillText(text, startFrac.x * w, startFrac.y * h);
  }

  function paintMath(startFrac, text, strokeColor) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !text) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.fillStyle = strokeColor;
    context.font = "italic 22px serif";
    context.fillText(text, startFrac.x * w, startFrac.y * h);
  }

  function paintStamp(startFrac, emoji, fontSize) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !emoji) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.font = `${fontSize || 36}px sans-serif`;
    context.fillText(emoji, startFrac.x * w, startFrac.y * h);
  }

  function paintSticky(startFrac, text, strokeColor) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !text) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const x = startFrac.x * w, y = startFrac.y * h;
    const boxW = 150, boxH = 96, pad = 10;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.fillStyle = strokeColor;
    context.fillRect(x, y, boxW, boxH);
    context.strokeStyle = "#00000022";
    context.lineWidth = 1;
    context.strokeRect(x, y, boxW, boxH);
    context.fillStyle = isLightColor(strokeColor) ? "#1a1a1a" : "#ffffff";
    context.font = "13px sans-serif";
    wrapCanvasText(context, text, x + pad, y + pad + 12, boxW - pad * 2, 16);
  }

  function paintImage(startFrac, dataUrl, sizeFrac) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !dataUrl) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const img = new Image();
    img.onload = () => {
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.drawImage(img, startFrac.x * w, startFrac.y * h, sizeFrac.w * w, sizeFrac.h * h);
    };
    img.src = dataUrl;
  }

  function applyStroke(stroke) {
    if (!stroke) return;
    if (stroke.kind === "shape") {
      paintShape(stroke.shapeType, stroke.start, stroke.end, stroke.color, stroke.size);
    } else if (stroke.kind === "text") {
      paintText(stroke.start, stroke.text, stroke.color, stroke.fontSize);
    } else if (stroke.kind === "math") {
      paintMath(stroke.start, stroke.text, stroke.color);
    } else if (stroke.kind === "stamp") {
      paintStamp(stroke.start, stroke.emoji, stroke.fontSize);
    } else if (stroke.kind === "sticky") {
      paintSticky(stroke.start, stroke.text, stroke.color);
    } else if (stroke.kind === "image") {
      paintImage(stroke.start, stroke.dataUrl, stroke.size);
    } else {
      paintSegment(stroke.from, stroke.to, stroke.color, stroke.size);
    }
  }

  function showLaserDot(key, point, dotColor) {
    setLaserDots((current) => ({ ...current, [key]: { x: point.x, y: point.y, color: dotColor } }));
    clearTimeout(laserTimers.current[key]);
    laserTimers.current[key] = setTimeout(() => {
      setLaserDots((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, 900);
  }

  function handleImageFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        const cw = canvas?.clientWidth || 1, ch = canvas?.clientHeight || 1;
        const maxW = 480;
        const scale = Math.min(1, maxW / img.width);
        const drawW = img.width * scale, drawH = img.height * scale;
        const off = document.createElement("canvas");
        off.width = drawW;
        off.height = drawH;
        off.getContext("2d").drawImage(img, 0, 0, drawW, drawH);
        const dataUrl = off.toDataURL("image/jpeg", 0.72);
        const start = { x: Math.max(0, 0.5 - drawW / cw / 2), y: Math.max(0, 0.5 - drawH / ch / 2) };
        const size = { w: drawW / cw, h: drawH / ch };
        saveUndoSnapshot();
        paintImage(start, dataUrl, size);
        send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "image", start, size, dataUrl } });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // Remote strokes and clears
  useEffect(() => {
    const fresh = events.filter((event) => event._n > lastAppliedN.current
      && event.chat_id === chatId
      && (event.type === "whiteboard_draw" || event.type === "whiteboard_clear" || event.type === "whiteboard_laser"));
    if (fresh.length === 0) return;
    lastAppliedN.current = events[events.length - 1]._n;
    for (const event of fresh) {
      if (event.type === "whiteboard_clear") {
        const canvas = canvasRef.current;
        ctx()?.clearRect(0, 0, canvas?.clientWidth || 0, canvas?.clientHeight || 0);
      } else if (event.type === "whiteboard_laser") {
        if (event.point) showLaserDot(event.from, event.point, event.point.color || "#ef4444");
      } else {
        applyStroke(event.stroke);
      }
    }
  }, [events, chatId]);

  function pointFromEvent(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  function strokeColorFor() {
    if (tool === "eraser") return "erase";
    if (tool === "highlighter") return "highlight";
    return color;
  }

  function currentPenSize() {
    if (tool === "highlighter") return penSize.size * 3.5;
    if (tool === "marker") return penSize.size * 2;
    if (tool === "eraser") return penSize.size * 5;
    return penSize.size;
  }

  function handlePointerDown(event) {
    const point = pointFromEvent(event);
    if (tool === "text") {
      const text = window.prompt("Text:");
      if (text && text.trim()) {
        saveUndoSnapshot();
        paintText(point, text.trim(), color);
        send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "text", start: point, text: text.trim(), color } });
      }
      return;
    }
    if (tool === "math") {
      const text = window.prompt("Math expression (e.g. x² + y² = r²):");
      if (text && text.trim()) {
        saveUndoSnapshot();
        paintMath(point, text.trim(), color);
        send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "math", start: point, text: text.trim(), color } });
      }
      return;
    }
    if (tool === "sticky") {
      const text = window.prompt("Note text:");
      if (text && text.trim()) {
        saveUndoSnapshot();
        paintSticky(point, text.trim(), color);
        send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "sticky", start: point, text: text.trim(), color } });
      }
      return;
    }
    if (tool === "stamp") {
      setShowStampPicker(point);
      return;
    }
    drawing.current = true;
    lastPoint.current = point;
    if (SHAPE_TOOLS.includes(tool)) {
      shapeStart.current = point;
      const canvas = canvasRef.current;
      snapshotRef.current = ctx()?.getImageData(0, 0, canvas.width, canvas.height);
    } else {
      // Save undo snapshot before freehand drawing starts
      saveUndoSnapshot();
    }
  }

  function handlePointerMove(event) {
    if (!drawing.current) return;
    const point = pointFromEvent(event);

    if (tool === "laser") {
      showLaserDot("__self", point, color);
      const now = Date.now();
      if (now - lastLaserSent.current >= 40) {
        lastLaserSent.current = now;
        send({ type: "whiteboard_laser", chat_id: chatId, point: { x: point.x, y: point.y, color } });
      }
      return;
    }

    if (SHAPE_TOOLS.includes(tool)) {
      if (snapshotRef.current) ctx()?.putImageData(snapshotRef.current, 0, 0);
      paintShape(tool, shapeStart.current, point, color, penSize.size);
      return;
    }

    const size = currentPenSize();
    const strokeColor = strokeColorFor();
    paintSegment(lastPoint.current, point, strokeColor, size);
    send({
      type: "whiteboard_draw", chat_id: chatId,
      stroke: { from: lastPoint.current, to: point, color: strokeColor, size },
    });
    lastPoint.current = point;
  }

  function handlePointerUp(event) {
    if (drawing.current && SHAPE_TOOLS.includes(tool) && shapeStart.current) {
      const point = pointFromEvent(event);
      saveUndoSnapshot();
      if (snapshotRef.current) ctx()?.putImageData(snapshotRef.current, 0, 0);
      paintShape(tool, shapeStart.current, point, color, penSize.size);
      send({
        type: "whiteboard_draw", chat_id: chatId,
        stroke: { kind: "shape", shapeType: tool, start: shapeStart.current, end: point, color, size: penSize.size },
      });
    }
    drawing.current = false;
    lastPoint.current = null;
    shapeStart.current = null;
    snapshotRef.current = null;
  }

  function clearBoard() {
    saveUndoSnapshot();
    const canvas = canvasRef.current;
    ctx()?.clearRect(0, 0, canvas?.clientWidth || 0, canvas?.clientHeight || 0);
    send({ type: "whiteboard_clear", chat_id: chatId });
  }

  function saveBoard() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Create a temporary canvas with white background + current drawing
    const tmp = document.createElement("canvas");
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const tmpCtx = tmp.getContext("2d");
    tmpCtx.fillStyle = transparent ? "transparent" : "#0b1220";
    tmpCtx.fillRect(0, 0, tmp.width, tmp.height);
    tmpCtx.drawImage(canvas, 0, 0);
    const link = document.createElement("a");
    link.download = `whiteboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    link.href = tmp.toDataURL("image/png");
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function placeStamp(emoji, point) {
    saveUndoSnapshot();
    paintStamp(point, emoji, 36);
    send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "stamp", start: point, emoji, fontSize: 36 } });
    setShowStampPicker(false);
  }

  function handleToolClick(key) {
    if (key === "image") { fileInputRef.current?.click(); return; }
    if (key === "undo") { undo(); return; }
    if (key === "save") { saveBoard(); return; }
    if (key === "grid") { setShowGrid((v) => !v); return; }
    if (key === "ruler") { setShowRuler((v) => !v); return; }
    setTool(key);
  }

  // Which tools in current category
  const currentCategory = TOOL_CATEGORIES[toolTab];

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1150, display: "flex", flexDirection: "column",
      background: transparent ? "transparent" : "#0b1220",
      pointerEvents: transparent ? "none" : "auto",
      maxWidth: expanded ? "none" : 430, margin: "0 auto",
    }}>
      {/* Canvas area */}
      <div style={{ position: "relative", flex: 1, pointerEvents: "auto", minHeight: 0 }}>
        <canvas ref={canvasRef}
                onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
                style={{
                  width: "100%", height: "100%", touchAction: "none",
                  cursor: tool === "laser" ? "none" : "crosshair",
                }}/>
        {/* Ruler overlay */}
        {showRuler && (
          <div style={{
            position: "absolute", bottom: 40, left: 20, right: 20, height: 32, pointerEvents: "none",
            background: "#ffffff11", borderRadius: 4, border: "1px solid #ffffff33",
            display: "flex", alignItems: "flex-end", padding: "0 4px",
          }}>
            {Array.from({ length: 20 }, (_, i) => (
              <div key={i} style={{
                flex: 1, borderLeft: "1px solid #ffffff44",
                height: i % 5 === 0 ? 18 : i % 2 === 0 ? 10 : 6,
                position: "relative",
              }}>
                {i % 5 === 0 && (
                  <span style={{
                    position: "absolute", top: -14, left: -4, fontSize: 8, color: "#ffffff66",
                  }}>{i}</span>
                )}
              </div>
            ))}
          </div>
        )}
        {/* Laser dots */}
        {Object.entries(laserDots).map(([key, dot]) => (
          <div key={key} style={{
            position: "absolute", left: `${dot.x * 100}%`, top: `${dot.y * 100}%`,
            width: 16, height: 16, marginLeft: -8, marginTop: -8, borderRadius: "50%",
            background: dot.color, boxShadow: `0 0 14px 4px ${dot.color}99`, pointerEvents: "none",
          }}/>
        ))}
        {/* Stamp picker popup */}
        {showStampPicker && (
          <div onClick={() => setShowStampPicker(false)} style={{
            position: "absolute", inset: 0, zIndex: 2,
          }}>
            <div onClick={(e) => e.stopPropagation()} style={{
              position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
              background: "#182234", border: "1px solid #ffffff26", borderRadius: 16, padding: 14,
              display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8,
            }}>
              {STAMP_EMOJIS.map((emoji) => (
                <div key={emoji} onClick={() => placeStamp(emoji, showStampPicker)}
                     style={{ fontSize: 28, cursor: "pointer", textAlign: "center", padding: 4 }}>
                  {emoji}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageFile}/>

      {/* ── Toolbar ── */}
      <div style={{
        flexShrink: 0, background: "#111a2cee", borderTop: "1px solid #ffffff1a",
        pointerEvents: "auto", color: "#fff",
      }}>
        {/* Category tabs */}
        <div style={{
          display: "flex", borderBottom: "1px solid #ffffff12", padding: "0 8px",
        }}>
          {TOOL_CATEGORIES.map((cat, i) => (
            <div key={cat.label} onClick={() => setToolTab(i)} style={{
              flex: 1, textAlign: "center", padding: "8px 0", fontSize: 11.5, fontWeight: 600,
              cursor: "pointer", color: toolTab === i ? "#fff" : "#ffffff66",
              borderBottom: toolTab === i ? `2px solid ${G.accent}` : "2px solid transparent",
            }}>{cat.label}</div>
          ))}
          {/* Color dot — tap to toggle color picker */}
          <div onClick={() => setShowColorPicker((v) => !v)} style={{
            width: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
          }}>
            <div style={{
              width: 20, height: 20, borderRadius: "50%", background: color,
              border: "2px solid #ffffff55",
            }}/>
          </div>
        </div>

        {/* Color picker row (shown/hidden) */}
        {showColorPicker && (
          <div style={{
            display: "flex", gap: 6, padding: "8px 12px", overflowX: "auto",
            borderBottom: "1px solid #ffffff12",
          }}>
            {WHITEBOARD_COLORS.map((c) => (
              <div key={c} onClick={() => { setColor(c); setShowColorPicker(false); }} style={{
                width: 26, height: 26, borderRadius: "50%", background: c, cursor: "pointer",
                flexShrink: 0, border: color === c ? "2px solid #fff" : "2px solid transparent",
              }}/>
            ))}
          </div>
        )}

        {/* Tools row for current category */}
        <div style={{
          display: "flex", gap: 4, padding: "6px 8px", overflowX: "auto",
          alignItems: "center",
        }}>
          {currentCategory.tools.map((t) => {
            const isActive = (t.key === "grid" && showGrid) || (t.key === "ruler" && showRuler)
              || (t.key !== "undo" && t.key !== "save" && t.key !== "grid" && t.key !== "ruler" && tool === t.key);
            return (
              <div key={t.key}
                   onClick={() => handleToolClick(t.key)}
                   title={t.label} style={{
                minWidth: 40, height: 36, borderRadius: 8, cursor: "pointer", fontSize: 15,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: 1, flexShrink: 0,
                background: isActive ? "#ffffff22" : "transparent",
                border: isActive ? "1px solid #ffffff33" : "1px solid transparent",
              }}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>{t.icon}</span>
                <span style={{ fontSize: 9, color: "#ffffffaa" }}>{t.label}</span>
              </div>
            );
          })}

          {/* Divider */}
          <div style={{ width: 1, alignSelf: "stretch", background: "#ffffff20", margin: "0 4px", flexShrink: 0 }}/>

          {/* Pen size selector */}
          {(toolTab === 0 || toolTab === 1) && PEN_SIZES.map((ps) => (
            <div key={ps.key} onClick={() => setPenSize(ps)} title={`Size ${ps.key}`} style={{
              width: 28, height: 36, borderRadius: 6, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              background: penSize.key === ps.key ? "#ffffff22" : "transparent",
            }}>
              <div style={{
                width: ps.size * 2.5, height: ps.size * 2.5, borderRadius: "50%",
                background: color,
              }}/>
            </div>
          ))}

          {/* Spacer */}
          <div style={{ flex: 1 }}/>

          {/* Clear and Close always visible */}
          <div onClick={clearBoard} style={{
            fontSize: 11, color: "#ff8080", cursor: "pointer", padding: "6px 8px",
            flexShrink: 0, fontWeight: 600,
          }}>Clear</div>
          <div onClick={onClose} style={{
            fontSize: 11, color: "#fff", cursor: "pointer", fontWeight: 700,
            padding: "6px 8px", flexShrink: 0,
          }}>Close</div>
        </div>
      </div>
    </div>
  );
}
