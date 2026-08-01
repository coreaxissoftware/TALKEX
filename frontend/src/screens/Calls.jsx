import { useEffect, useRef, useState } from "react";
import { Calls, Chats, Messages } from "../api.js";
import { Av, ContextMenu, G, I, Spinner, whenLabel } from "../ui.jsx";

const ACTIONS_WIDTH = 112;
const ACTIONS_OPEN_TRIGGER = 60;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8;

/**
 * A call log gathered from every chat's own 'call' kind messages — the same
 * entries already shown inline in each conversation, just collected into one
 * list so you don't have to remember which chat a call happened in.
 *
 * "Delete" on a row hides that one call message from just this log (the same
 * hide-for-me mechanism a chat message uses) — the underlying chat and its
 * other messages are untouched. "Archive" archives the whole chat the call
 * happened in, same as ChatList's own archive action.
 */
export default function CallsScreen({ me, onCallBack, toast }) {
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [menu, setMenu] = useState(null); // { x, y, call } for the right-click/long-press row menu

  useEffect(() => {
    Calls.list().then(setCalls).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function deleteCall(call) {
    await Messages.hide(call.id);
    setCalls((current) => current.filter((c) => c.id !== call.id));
  }

  async function archiveCallChat(call) {
    await Chats.settings(call.chat_id, { archived: true });
    toast("Chat archived");
  }

  function toggleSelected(callId) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(callId)) next.delete(callId); else next.add(callId);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  async function deleteSelected() {
    const ids = [...selectedIds];
    await Promise.all(ids.map((id) => Messages.hide(id)));
    setCalls((current) => current.filter((c) => !selectedIds.has(c.id)));
    toast(`${ids.length} call${ids.length === 1 ? "" : "s"} deleted`);
    exitSelectMode();
  }

  if (loading) return <Spinner/>;

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      {selectMode ? (
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
          borderBottom: `1px solid ${G.border}`,
        }}>
          <div onClick={exitSelectMode} style={{ cursor: "pointer" }}>{I.back()}</div>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
            {selectedIds.size} selected
          </div>
          <div onClick={() => setSelectedIds(new Set(calls.map((c) => c.id)))}
               style={{ fontSize: 13, color: G.accentText, cursor: "pointer" }}>
            Select all
          </div>
          <div onClick={() => selectedIds.size && deleteSelected()}
               style={{ cursor: selectedIds.size ? "pointer" : "default", opacity: selectedIds.size ? 1 : 0.4, display: "flex" }}
               title="Delete selected">
            {I.trash(G.red, 19)}
          </div>
        </div>
      ) : (
        calls.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 16px 0" }}>
            <div onClick={() => setSelectMode(true)} style={{ fontSize: 13, color: G.accentText, cursor: "pointer" }}>
              Select
            </div>
          </div>
        )
      )}

      {calls.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: G.muted, fontSize: 14 }}>
          No calls yet. Start one from any chat's header.
        </div>
      )}

      {calls.map((call) => (
        <CallRow key={call.id} call={call} me={me} onCallBack={onCallBack}
                 onDelete={() => deleteCall(call)} onArchive={() => archiveCallChat(call)}
                 onMenu={(x, y) => setMenu({ x, y, call })}
                 selectMode={selectMode} selected={selectedIds.has(call.id)}
                 onToggleSelect={() => toggleSelected(call.id)}/>
      ))}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
          {
            label: "Voice call",
            icon: I.phone(G.sub, 16),
            onClick: () => onCallBack({
              id: menu.call.chat_id, peer_id: menu.call.peer_id, name: menu.call.chat_name,
              avatar_letter: menu.call.chat_avatar_letter, color: menu.call.chat_color, type: menu.call.chat_type,
            }, "voice"),
          },
          {
            label: "Video call",
            icon: I.video(G.sub, 16),
            onClick: () => onCallBack({
              id: menu.call.chat_id, peer_id: menu.call.peer_id, name: menu.call.chat_name,
              avatar_letter: menu.call.chat_avatar_letter, color: menu.call.chat_color, type: menu.call.chat_type,
            }, "video"),
          },
          { divider: true },
          { label: "Archive chat", icon: I.archive(G.sub, 16), onClick: () => archiveCallChat(menu.call) },
          { label: "Delete", icon: I.trash(G.red, 16), danger: true, onClick: () => deleteCall(menu.call) },
        ]}/>
      )}
    </div>
  );
}

function CallRow({ call, me, onCallBack, onDelete, onArchive, onMenu, selectMode, selected, onToggleSelect }) {
  const [dragX, setDragX] = useState(0);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  const { call_kind: callKind, status, duration_secs: durationSecs } = call.payload || {};
  const iAmCaller = call.sender_id === me.id;
  // "Missed" only makes sense from the receiver's side — a call you yourself
  // placed and that went unanswered reads as "no answer," not "missed," same
  // distinction every phone app makes.
  const label = status === "completed"
    ? formatDuration(durationSecs)
    : iAmCaller
      ? (status === "unanswered" ? "No answer" : status === "busy" ? "Busy" : "Declined")
      : "Missed";
  const attention = !iAmCaller && status !== "completed";
  const callBack = () => onCallBack({
    id: call.chat_id, peer_id: call.peer_id, name: call.chat_name,
    avatar_letter: call.chat_avatar_letter, color: call.chat_color, type: call.chat_type,
  }, callKind);

  function onPointerDown(event) {
    if (selectMode) return;
    if (dragX !== 0) { setDragX(0); return; }
    dragging.current = true;
    startX.current = event.clientX;
    startY.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch") {
      longPressFired.current = false;
      const x = event.clientX, y = event.clientY;
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true;
        dragging.current = false;
        setDragX(0);
        onMenu(x, y);
      }, LONG_PRESS_MS);
    }
  }

  function onPointerMove(event) {
    if (selectMode || !dragging.current) return;
    const delta = event.clientX - startX.current;
    if (longPressTimer.current && (Math.abs(delta) > LONG_PRESS_MOVE_TOLERANCE
        || Math.abs(event.clientY - startY.current) > LONG_PRESS_MOVE_TOLERANCE)) {
      clearLongPressTimer();
    }
    setDragX(Math.max(-ACTIONS_WIDTH, Math.min(0, delta)));
  }

  function onPointerUpOrCancel() {
    clearLongPressTimer();
    if (!dragging.current) return;
    dragging.current = false;
    if (longPressFired.current) { setDragX(0); return; }
    setDragX(dragX <= -ACTIONS_OPEN_TRIGGER ? -ACTIONS_WIDTH : 0);
  }

  function handleTap() {
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) { onToggleSelect(); return; }
    if (dragX !== 0) { setDragX(0); return; }
    callBack();
  }

  function onContextMenu(event) {
    event.preventDefault();
    if (selectMode) return;
    setDragX(0);
    onMenu(event.clientX, event.clientY);
  }

  return (
    <div style={{ position: "relative", overflow: "hidden", borderBottom: `1px solid ${G.border}` }}>
      <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "flex-end" }}>
        <div onClick={(event) => { event.stopPropagation(); onArchive(); setDragX(0); }} style={{
          width: 56, display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 2, background: G.yellow, color: "#fff", cursor: "pointer",
        }}>
          {I.archive("#fff", 17)}
          <span style={{ fontSize: 9.5, fontWeight: 600 }}>Archive</span>
        </div>
        <div onClick={(event) => { event.stopPropagation(); onDelete(); setDragX(0); }} style={{
          width: 56, display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", gap: 2, background: G.red, color: "#fff", cursor: "pointer",
        }}>
          {I.trash("#fff", 17)}
          <span style={{ fontSize: 9.5, fontWeight: 600 }}>Delete</span>
        </div>
      </div>

      <div onPointerDown={onPointerDown} onPointerMove={onPointerMove}
           onPointerUp={onPointerUpOrCancel} onPointerCancel={onPointerUpOrCancel}
           onClick={handleTap} onContextMenu={onContextMenu}
           style={{
             display: "flex", alignItems: "center", gap: 12, padding: "10px 16px",
             cursor: "pointer", background: G.bg,
             transform: `translateX(${dragX}px)`,
             transition: dragging.current ? "none" : "transform 0.2s ease",
             touchAction: "pan-y",
           }}>
        {selectMode && (
          <div style={{
            width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
            border: `2px solid ${selected ? G.accent : G.border}`,
            background: selected ? G.accent : "transparent",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {selected && <div style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>✓</div>}
          </div>
        )}
        <Av av={call.chat_avatar_letter} color={call.chat_color} size={42}/>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>{call.chat_name}</div>
          <div style={{
            display: "flex", alignItems: "center", gap: 5, fontSize: 12.5,
            color: attention ? G.red : G.muted, marginTop: 2,
          }}>
            {callKind === "video" ? I.video(attention ? G.red : G.muted, 13)
                                  : I.phone(attention ? G.red : G.muted, 13)}
            {label}
          </div>
        </div>
        <div style={{ fontSize: 11, color: G.muted, marginRight: 4 }}>
          {whenLabel(call.created_at)}
        </div>
        {!selectMode && (
          <div onClick={(event) => { event.stopPropagation(); callBack(); }} style={{ cursor: "pointer" }}>
            {callKind === "video" ? I.video(G.accent, 19) : I.phone(G.accent, 19)}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
