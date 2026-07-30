import { useEffect, useMemo, useRef, useState } from "react";
import { Chats, Contacts } from "../api.js";
import { Av, G, I, Spinner, whenLabel } from "../ui.jsx";

// Swipe distances, in pixels. Right-swipe (pin) is a smaller one-shot
// gesture since pinning is harmless to trigger by accident; left-swipe
// (archive/clear/delete) opens further and needs an explicit tap on one of
// the revealed icons, since those are more consequential.
const PIN_SWIPE_TRIGGER = 46;
const ACTIONS_WIDTH = 168;
const ACTIONS_OPEN_TRIGGER = 90;

const CATEGORIES = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "non_contact", label: "Non-Contact" },
  { key: "group", label: "Group" },
  { key: "channel", label: "Channel" },
  { key: "community", label: "Community" },
  { key: "archive", label: "Archive" },
];

/**
 * The conversation list.
 *
 * Unread counts come straight from the server as `last_seq - last_read_seq`,
 * so this screen never counts messages itself.
 *
 * Folders are Telegram's idea: each member files a chat under a folder name of
 * their own, stored per membership rather than per chat, so your filing does
 * not change what anyone else sees.
 */
export default function ChatList({ chats, loading, typingBy, onOpen, onSearch, onChanged, toast, onNewChat }) {
  const [folder, setFolder] = useState("All");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [contactUserIds, setContactUserIds] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Only needed for the "Non-Contact" filter — a DM counts as a contact once
  // its peer's phone number matches something in your saved address book.
  useEffect(() => {
    Contacts.list()
      .then((rows) => setContactUserIds(new Set(rows.filter((c) => c.user).map((c) => c.user.id))))
      .catch(() => {});
  }, []);

  // An archived chat is a "not right now," not a "never show me this again" —
  // it drops out of the main list and its own folder filtering, but is never
  // hidden outright: it un-archives itself the moment a new message arrives
  // (server-side, see main.py's send_message), and the collapsed banner below
  // always shows how many are waiting there regardless.
  const activeChats = useMemo(() => chats.filter((chat) => !chat.archived), [chats]);
  const archivedChats = useMemo(() => chats.filter((chat) => chat.archived), [chats]);

  const folders = useMemo(() => {
    const named = activeChats.map((chat) => chat.folder).filter(Boolean);
    return ["All", ...Array.from(new Set(named))];
  }, [activeChats]);

  const visible = useMemo(() => {
    let list = category === "archive" ? archivedChats : activeChats;

    if (category === "unread") list = list.filter((chat) => chat.unread > 0);
    else if (category === "non_contact") {
      list = list.filter((chat) => chat.type === "dm" && chat.peer_id && !contactUserIds.has(chat.peer_id));
    } else if (category === "group") list = list.filter((chat) => chat.type === "group");
    else if (category === "channel") list = list.filter((chat) => chat.type === "channel");
    else if (category === "community") list = list.filter((chat) => chat.type === "community");

    if (category !== "archive" && folder !== "All") {
      list = list.filter((chat) => chat.folder === folder);
    }
    if (query.trim()) {
      const needle = query.trim().toLowerCase();
      list = list.filter((chat) => displayName(chat).toLowerCase().includes(needle));
    }
    return list;
  }, [activeChats, archivedChats, category, contactUserIds, folder, query]);

  async function togglePin(chat) {
    try {
      await Chats.settings(chat.id, { is_pinned: !chat.is_pinned });
      onChanged();
    } catch (problem) {
      toast(problem.message || "Could not pin chat");
    }
  }

  async function archiveChat(chat) {
    await Chats.settings(chat.id, { archived: !chat.archived });
    onChanged();
  }

  async function clearChat(chat) {
    await Chats.clear(chat.id);
    toast("Chat cleared");
    onChanged();
  }

  async function deleteChat(chat) {
    // "Delete" here means what WhatsApp's own "Delete chat" means: your view
    // of the history is wiped and it drops off your active list. The chat
    // itself (and the other side's copy) is untouched — a DM peer or group
    // still exists, exactly like clearing plus archiving.
    await Chats.clear(chat.id);
    await Chats.settings(chat.id, { archived: true });
    toast("Chat deleted");
    onChanged();
  }

  function toggleSelected(chatId) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(chatId)) next.delete(chatId); else next.add(chatId);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(visible.map((chat) => chat.id)));
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  async function archiveSelected() {
    await Promise.all([...selectedIds].map((id) => Chats.settings(id, { archived: true })));
    toast(`${selectedIds.size} chat${selectedIds.size === 1 ? "" : "s"} archived`);
    exitSelectMode();
    onChanged();
  }

  async function deleteSelected() {
    await Promise.all([...selectedIds].map(async (id) => {
      await Chats.clear(id);
      await Chats.settings(id, { archived: true });
    }));
    toast(`${selectedIds.size} chat${selectedIds.size === 1 ? "" : "s"} deleted`);
    exitSelectMode();
    onChanged();
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
          <div onClick={selectAll} style={{ fontSize: 13, color: G.accentText, cursor: "pointer" }}>
            Select all
          </div>
          <div onClick={() => selectedIds.size && archiveSelected()}
               style={{ cursor: selectedIds.size ? "pointer" : "default", opacity: selectedIds.size ? 1 : 0.4, display: "flex" }}
               title="Archive selected">
            {I.archive(G.sub, 19)}
          </div>
          <div onClick={() => selectedIds.size && deleteSelected()}
               style={{ cursor: selectedIds.size ? "pointer" : "default", opacity: selectedIds.size ? 1 : 0.4, display: "flex" }}
               title="Delete selected">
            {I.trash(G.red, 19)}
          </div>
        </div>
      ) : (
        <div style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{
            flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
            background: G.dim, borderRadius: 12, border: `1px solid ${G.border}`,
          }}>
            {I.search()}
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter searches message contents on the server; typing alone only
                // filters the list of chat names already on screen.
                if (event.key === "Enter" && query.trim()) onSearch(query.trim());
              }}
              placeholder="Search chats, or press Enter for messages"
              style={{
                flex: 1, background: "transparent", border: "none", outline: "none",
                color: G.text, fontSize: 14,
              }}/>
          </div>
          {visible.length > 0 && (
            <div onClick={() => setSelectMode(true)} style={{
              fontSize: 13, color: G.accentText, cursor: "pointer", whiteSpace: "nowrap",
            }}>Select</div>
          )}
          <div onClick={onNewChat} title="New chat" style={{
            width: 38, height: 38, borderRadius: "50%", background: G.accent,
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", flexShrink: 0,
          }}>
            {I.plus("#fff", 18)}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto" }}>
        {CATEGORIES.map(({ key, label }) => (
          <button key={key} onClick={() => setCategory(key)}
            style={{
              padding: "6px 14px", borderRadius: 20, whiteSpace: "nowrap",
              border: `1px solid ${category === key ? G.accent : G.border}`,
              background: category === key ? G.accentSoft : "transparent",
              color: category === key ? G.accentText : G.sub,
              fontSize: 13, cursor: "pointer",
            }}>{label}</button>
        ))}
      </div>

      {category !== "archive" && folders.length > 1 && (
        <div style={{ display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto" }}>
          {folders.map((name) => (
            <button key={name} onClick={() => setFolder(name)}
              style={{
                padding: "6px 14px", borderRadius: 20, whiteSpace: "nowrap",
                border: `1px solid ${folder === name ? G.accent : G.border}`,
                background: folder === name ? G.accentSoft : "transparent",
                color: folder === name ? G.accentText : G.sub,
                fontSize: 13, cursor: "pointer",
              }}>{name}</button>
          ))}
        </div>
      )}

      {category !== "archive" && archivedChats.length > 0 && (
        <div onClick={() => setShowArchived((v) => !v)} style={{
          display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
          cursor: "pointer", borderBottom: `1px solid ${G.border}`, color: G.sub,
        }}>
          {I.archive(G.sub, 18)}
          <div style={{ flex: 1, fontSize: 14 }}>Archived</div>
          <div style={{ fontSize: 13 }}>{archivedChats.length}</div>
        </div>
      )}

      {category !== "archive" && showArchived && archivedChats.map((chat) => (
        <ChatRow key={chat.id} chat={chat} typing={typingBy[chat.id]}
                 onOpen={() => onOpen(chat)} onPin={() => togglePin(chat)}
                 onArchive={() => archiveChat(chat)} onClear={() => clearChat(chat)}
                 onDelete={() => deleteChat(chat)}
                 selectMode={selectMode} selected={selectedIds.has(chat.id)}
                 onToggleSelect={() => toggleSelected(chat.id)}/>
      ))}

      {visible.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: G.muted, fontSize: 14 }}>
          {category === "archive" ? "No archived chats."
            : category === "all" ? "No conversations yet. Tap + to find someone or start a chat."
            : "Nothing here yet."}
        </div>
      )}

      {visible.map((chat) => (
        <ChatRow key={chat.id} chat={chat} typing={typingBy[chat.id]}
                 onOpen={() => onOpen(chat)} onPin={() => togglePin(chat)}
                 onArchive={() => archiveChat(chat)} onClear={() => clearChat(chat)}
                 onDelete={() => deleteChat(chat)}
                 selectMode={selectMode} selected={selectedIds.has(chat.id)}
                 onToggleSelect={() => toggleSelected(chat.id)}/>
      ))}
    </div>
  );
}

function displayName(chat) {
  if (chat.name) return chat.name;
  // A DM has no stored name — it is whoever the other member is. The server
  // sends the member list on /chats/{id}, but the list endpoint stays light, so
  // fall back to something readable rather than fetching per row.
  return chat.type === "dm" ? "Direct message" : "Chat";
}

function ChatRow({ chat, typing, onOpen, onPin, onArchive, onClear, onDelete,
                   selectMode, selected, onToggleSelect }) {
  const typingNames = Object.values(typing || {});
  const [dragX, setDragX] = useState(0);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startedAt = useRef(0);

  const preview = () => {
    if (typingNames.length > 0) return "typing…";
    if (chat.draft) return <><span style={{ color: G.green, fontWeight: 600 }}>Draft: </span>{chat.draft.slice(0, 50)}</>;
    const last = chat.last_message;
    if (!last) return "No messages yet";
    if (last.deleted_at) return "This message was deleted";
    // The stored text already begins with the calendar emoji, so this must not
    // add another one.
    if (last.kind === "meeting") return last.text || "📅 Meeting";
    if (last.kind === "poll") return "📊 Poll";
    if (last.kind === "location") return "📍 Location";
    if (last.kind === "contact") return "👤 Contact";
    if (last.kind === "video") return last.text ? `🎥 ${last.text}` : "🎥 Video";
    if (last.kind === "sticker") return "Sticker";
    if (last.kind === "call") {
      const { call_kind: callKind, status } = last.payload || {};
      const verb = callKind === "video" ? "Video call" : "Voice call";
      return status === "completed" ? `📞 ${verb}` : `📞 Missed ${verb.toLowerCase()}`;
    }
    if (last.kind === "photo") return last.text ? `📷 ${last.text}` : "📷 Photo";
    if (last.kind === "voice") return "🎤 Voice message";
    if (last.kind === "document") return last.text ? `📄 ${last.text}` : "📄 Document";
    return last.text || `[${last.kind}]`;
  };

  function onPointerDown(event) {
    if (selectMode) return; // no swipe while picking rows for a bulk action
    // A row already snapped open just closes on the next tap, anywhere on it —
    // it doesn't start a fresh drag from an offset position.
    if (dragX !== 0) { setDragX(0); return; }
    dragging.current = true;
    startX.current = event.clientX;
    startedAt.current = Date.now();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event) {
    if (selectMode || !dragging.current) return;
    const delta = event.clientX - startX.current;
    // Right swipe (positive) is a short one-shot pin gesture; left swipe
    // (negative) opens further to reveal three action icons.
    setDragX(Math.max(-ACTIONS_WIDTH, Math.min(PIN_SWIPE_TRIGGER + 20, delta)));
  }

  function onPointerUpOrCancel() {
    if (!dragging.current) return;
    dragging.current = false;

    if (dragX >= PIN_SWIPE_TRIGGER) {
      onPin();
      setDragX(0);
    } else if (dragX <= -ACTIONS_OPEN_TRIGGER) {
      setDragX(-ACTIONS_WIDTH);
    } else {
      setDragX(0);
    }
  }

  function handleOpen() {
    if (selectMode) { onToggleSelect(); return; }
    // A drag that never actually moved is just a tap — open the chat. One
    // that's still snapped open just closes instead of navigating away.
    if (dragX !== 0) { setDragX(0); return; }
    onOpen();
  }

  return (
    <div style={{ position: "relative", overflow: "hidden", borderBottom: `1px solid ${G.border}` }}>
      <div style={{
        position: "absolute", inset: 0, display: "flex", alignItems: "stretch",
        justifyContent: "space-between",
      }}>
        <div style={{
          width: ACTIONS_WIDTH, display: "flex", alignItems: "center",
          justifyContent: "flex-start", paddingLeft: 20, background: G.accentSoft,
        }}>
          {I.pin(G.accent, 18)}
        </div>
        <div style={{ display: "flex" }}>
          <SwipeAction color={G.yellow} icon={I.archive("#fff", 17)} label="Archive"
                      onClick={() => { onArchive(); setDragX(0); }}/>
          <SwipeAction color={G.sub} icon={I.broom("#fff", 17)} label="Clear"
                      onClick={() => { onClear(); setDragX(0); }}/>
          <SwipeAction color={G.red} icon={I.trash("#fff", 17)} label="Delete"
                      onClick={() => { onDelete(); setDragX(0); }}/>
        </div>
      </div>

      <div
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUpOrCancel} onPointerCancel={onPointerUpOrCancel}
        onClick={handleOpen}
        style={{
          display: "flex", alignItems: "center", gap: 11, padding: "7px 16px",
          cursor: "pointer", background: G.bg,
          transform: `translateX(${dragX}px)`,
          transition: dragging.current ? "none" : "transform 0.2s ease",
          touchAction: "pan-y",
        }}
        onMouseEnter={(event) => (event.currentTarget.style.background = G.card)}
        onMouseLeave={(event) => (event.currentTarget.style.background = G.bg)}>

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

        <Av av={chat.avatar_letter} color={chat.color} size={42} photoId={chat.avatar_attachment_id}
            isMe={chat.type === "saved"}/>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              fontSize: 14, fontWeight: 600, whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis",
            }}>{displayName(chat)}</div>
            {chat.is_verified ? I.verified() : null}
            {chat.is_locked ? I.lock() : null}
            {chat.disappear_secs ? I.timer(G.yellow, 13) : null}
          </div>
          <div style={{
            fontSize: 12.5, color: typing ? G.accentText : G.muted, marginTop: 1,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            fontStyle: typing ? "italic" : "normal",
          }}>{preview()}</div>
        </div>

        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 10.5, color: G.muted }}>
            {chat.last_message ? whenLabel(chat.last_message.created_at) : ""}
          </div>
          {chat.unread > 0 && (
            <div style={{
              marginTop: 3, minWidth: 18, height: 18, borderRadius: 9,
              background: G.accent, color: "#fff", fontSize: 10.5, fontWeight: 700,
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              padding: "0 5px",
            }}>{chat.unread > 99 ? "99+" : chat.unread}</div>
          )}
          {chat.is_pinned ? <div style={{ marginTop: 3 }}>{I.pin(G.muted, 11)}</div> : null}
        </div>
      </div>
    </div>
  );
}

function SwipeAction({ color, icon, label, onClick }) {
  return (
    <div onClick={(event) => { event.stopPropagation(); onClick(); }} style={{
      width: 56, display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", gap: 2, background: color, color: "#fff",
      cursor: "pointer",
    }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      <span style={{ fontSize: 9.5, fontWeight: 600 }}>{label}</span>
    </div>
  );
}
