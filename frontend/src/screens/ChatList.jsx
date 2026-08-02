import { useEffect, useMemo, useRef, useState } from "react";
import { Actions, Chats, Contacts, Me, Users } from "../api.js";
import { Av, Button, ContextMenu, G, I, SRow, Spinner, whenLabel } from "../ui.jsx";
import { MuteSheet, LockSheet, FolderSheet, muteLabel } from "./ChatView.jsx";
import { AppLockSetupSheet } from "./Settings.jsx";
import { COUNTRY_CODES, flagFor, samplePlaceholder, splitPhone } from "../countryCodes.js";
import { disableAppLock, isAppLockEnabled } from "../appLock.js";

// How long a press-and-hold must last, on a touch device, before it counts
// as a long-press (opens the context menu) rather than the start of a tap
// or a swipe — matched to what mobile OSes themselves use for long-press.
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 8;

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
  { key: "favourites", label: "Favourites" },
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
export default function ChatList({ chats, loading, typingBy, onOpen, onSearch, onChanged, toast,
                                    onNewChat, onLogout, headerMenuPos, onHeaderMenuClose }) {
  const [folder, setFolder] = useState("All");
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [contactUserIds, setContactUserIds] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [menu, setMenu] = useState(null); // { x, y, chat } for the right-click/long-press row menu
  const [muteFor, setMuteFor] = useState(null); // chat currently showing the mute-duration sheet
  const [contactFor, setContactFor] = useState(null); // chat currently showing the contact-info sheet
  const [lockFor, setLockFor] = useState(null); // { chat, mode: 'set' | 'remove' } for the chat-lock sheet
  const [folderFor, setFolderFor] = useState(null); // chat currently showing the "add to list" sheet
  const [showStarred, setShowStarred] = useState(false);
  const [appLockOn, setAppLockOn] = useState(isAppLockEnabled);
  const [appLockSetupOpen, setAppLockSetupOpen] = useState(false);

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
    else if (category === "favourites") list = list.filter((chat) => chat.is_favorite);
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

  async function markChatRead(chat) {
    await Actions.markRead(chat.id, chat.last_seq);
    onChanged();
  }

  async function toggleChatCalls(chat) {
    const next = chat.calls_enabled === false;
    await Chats.settings(chat.id, { calls_enabled: next });
    toast(next ? "Calls turned on for this chat" : "Calls turned off for this chat");
    onChanged();
  }

  async function toggleFavoriteChat(chat) {
    const next = !chat.is_favorite;
    await Chats.settings(chat.id, { is_favorite: next });
    toast(next ? "Added to favourites" : "Removed from favourites");
    onChanged();
  }

  function menuItemsFor(chat) {
    const callsOn = chat.calls_enabled !== false;
    const isMuted = (chat.muted_until || 0) > Date.now() / 1000;
    return [
      ...(chat.type === "dm" && chat.peer_id
        ? [{ label: "Contact info", icon: I.user(G.sub, 16), onClick: () => setContactFor(chat) }]
        : []),
      { label: chat.is_pinned ? "Unpin chat" : "Pin chat", icon: I.pin(G.sub, 16), onClick: () => togglePin(chat) },
      {
        label: chat.is_favorite ? "Remove from favourites" : "Add to favourites",
        icon: <span style={{ fontSize: 15, color: chat.is_favorite ? G.accent : G.sub, width: 16, textAlign: "center", lineHeight: 1 }}>★</span>,
        onClick: () => toggleFavoriteChat(chat),
      },
      {
        label: isMuted ? muteLabel(chat.muted_until) : "Mute notifications",
        icon: I.bellOff(G.sub, 16),
        onClick: () => setMuteFor(chat),
      },
      ...(chat.unread > 0
        ? [{ label: "Mark as read", icon: I.check(G.sub, 16), onClick: () => markChatRead(chat) }]
        : []),
      {
        label: callsOn ? "Turn off calls for this chat" : "Turn on calls for this chat",
        icon: callsOn ? I.phone(G.sub, 16) : I.ban(G.sub, 16),
        onClick: () => toggleChatCalls(chat),
      },
      {
        label: chat.is_locked ? "Remove chat lock" : "Chat lock",
        icon: I.lock(chat.is_locked ? G.accent : G.sub, 16),
        onClick: () => setLockFor({ chat, mode: chat.is_locked ? "remove" : "set" }),
      },
      { label: "Add to list", icon: I.archive(G.sub, 16), onClick: () => setFolderFor(chat) },
      { divider: true },
      { label: chat.archived ? "Unarchive chat" : "Archive chat", icon: I.archive(G.sub, 16), onClick: () => archiveChat(chat) },
      { label: "Clear chat", icon: I.broom(G.sub, 16), onClick: () => clearChat(chat) },
      { label: "Delete chat", icon: I.trash(G.red, 16), danger: true, onClick: () => deleteChat(chat) },
    ];
  }

  async function markAllRead() {
    const unreadChats = chats.filter((chat) => chat.unread > 0);
    if (unreadChats.length === 0) return;
    await Promise.all(unreadChats.map((chat) => Actions.markRead(chat.id, chat.last_seq)));
    toast("All chats marked as read");
    onChanged();
  }

  function headerMenuItems() {
    return [
      { label: "New group", icon: I.user(G.sub, 16), onClick: onNewChat },
      {
        label: "Starred messages",
        icon: <span style={{ fontSize: 15, color: G.sub, width: 16, textAlign: "center", lineHeight: 1 }}>★</span>,
        onClick: () => setShowStarred(true),
      },
      { label: "Select chats", icon: I.check(G.sub, 16), onClick: () => setSelectMode(true) },
      { label: "Mark all as read", icon: I.check(G.sub, 16), onClick: markAllRead },
      { divider: true },
      {
        label: "App lock",
        icon: I.lock(appLockOn ? G.accent : G.sub, 16),
        onClick: () => {
          if (appLockOn) { disableAppLock(); setAppLockOn(false); toast("App lock turned off"); }
          else setAppLockSetupOpen(true);
        },
      },
      ...(onLogout
        ? [{
            label: "Log out", icon: I.logOut(G.red, 16), danger: true,
            onClick: () => { if (confirm("Log out of TalkEx?")) onLogout(); },
          }]
        : []),
    ];
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
        <>
          <div style={{ padding: "10px 16px" }}>
            <div style={{
              width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", gap: 10,
              padding: "10px 14px", background: G.dim, borderRadius: 12, border: `1px solid ${G.border}`,
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
          </div>
        </>
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
                 onMenu={(x, y) => setMenu({ x, y, chat })}
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
                 onMenu={(x, y) => setMenu({ x, y, chat })}
                 selectMode={selectMode} selected={selectedIds.has(chat.id)}
                 onToggleSelect={() => toggleSelected(chat.id)}/>
      ))}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItemsFor(menu.chat)} onClose={() => setMenu(null)}/>
      )}
      {muteFor && (
        <MuteSheet mutedUntil={muteFor.muted_until || 0} onClose={() => setMuteFor(null)}
                   onPicked={async (muted_until) => {
                     await Chats.settings(muteFor.id, { muted_until });
                     setMuteFor(null);
                     onChanged();
                   }}/>
      )}
      {contactFor && (
        <ContactQuickSheet chat={contactFor} onClose={() => setContactFor(null)} toast={toast} onChanged={onChanged}/>
      )}
      {lockFor && (
        <LockSheet chatId={lockFor.chat.id} mode={lockFor.mode} toast={toast}
                   onClose={() => setLockFor(null)}
                   onDone={() => { setLockFor(null); onChanged(); }}/>
      )}
      {folderFor && (
        <FolderSheet current={folderFor.folder || ""} onClose={() => setFolderFor(null)}
                     onPicked={async (folder) => {
                       setFolderFor(null);
                       await Chats.settings(folderFor.id, { folder });
                       toast(folder ? `Added to "${folder}"` : "Removed from list");
                       onChanged();
                     }}/>
      )}
      {headerMenuPos && (
        <ContextMenu x={headerMenuPos.x} y={headerMenuPos.y} items={headerMenuItems()} onClose={onHeaderMenuClose}/>
      )}
      {showStarred && (
        <StarredMessagesSheet chats={chats} onClose={() => setShowStarred(false)}
                               onOpenChat={(chatToOpen) => { onOpen(chatToOpen); setShowStarred(false); }}/>
      )}
      {appLockSetupOpen && (
        <AppLockSetupSheet onClose={() => setAppLockSetupOpen(false)}
                            onSet={() => { setAppLockOn(true); setAppLockSetupOpen(false); toast("App lock turned on"); }}/>
      )}
    </div>
  );
}

/** Every message starred anywhere, gathered into one list — same shape as
 * the Calls tab's cross-chat log, just for stars instead of calls. */
function StarredMessagesSheet({ chats, onClose, onOpenChat }) {
  const [items, setItems] = useState(null);

  useEffect(() => {
    Me.starred().then(setItems).catch(() => setItems([]));
  }, []);

  async function unstar(item) {
    await Actions.unstar(item.id);
    setItems((current) => current.filter((m) => m.id !== item.id));
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        border: `1px solid ${G.border}`, maxHeight: "80vh", overflowY: "auto", color: G.text,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Starred messages</div>
        {items === null ? (
          <Spinner small/>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 13, color: G.muted, textAlign: "center", padding: 20 }}>
            No starred messages yet
          </div>
        ) : items.map((item) => (
          <div key={item.id} style={{
            display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 0",
            borderBottom: `1px solid ${G.border}`,
          }}>
            <div onClick={() => {
              const chatToOpen = chats.find((c) => c.id === item.chat_id);
              if (chatToOpen) onOpenChat(chatToOpen);
            }} style={{ flex: 1, cursor: "pointer", minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: G.accentText, marginBottom: 2 }}>
                {item.chat_name || "Chat"}
              </div>
              <div style={{
                fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap", color: G.text,
              }}>{item.text || `[${item.kind}]`}</div>
              <div style={{ fontSize: 11, color: G.muted, marginTop: 2 }}>{whenLabel(item.created_at)}</div>
            </div>
            <div onClick={() => unstar(item)} title="Unstar" style={{
              cursor: "pointer", flexShrink: 0, fontSize: 16, color: G.accent, lineHeight: 1, marginTop: 2,
            }}>★</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A lighter-weight stand-in for ChatView's full ChatInfoSheet contact
 * management — just enough to view a DM peer's profile and add/edit them as
 * a saved contact straight from the chat list, without needing to open the
 * chat first.
 */
function ContactQuickSheet({ chat, onClose, toast, onChanged }) {
  const [peerProfile, setPeerProfile] = useState(null);
  const [contact, setContact] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "" });
  const [country, setCountry] = useState(COUNTRY_CODES[0]);
  const fullPhone = country.dial + form.phone;
  const phoneValid = form.phone.length === country.len;

  useEffect(() => {
    if (!chat.peer_id) return;
    Promise.all([Users.get(chat.peer_id), Contacts.list()]).then(([user, contacts]) => {
      setPeerProfile(user);
      setContact(contacts.find((entry) => entry.user?.id === chat.peer_id) || null);
    }).catch(() => {});
  }, [chat.peer_id]);

  function startEdit() {
    const existingPhone = contact ? contact.phone : (peerProfile?.phone || "");
    const { country: c, local } = splitPhone(existingPhone);
    setCountry(c);
    setForm({ name: contact ? contact.name : (peerProfile?.name || chat.name || ""), phone: local });
    setEditing(true);
  }

  async function save() {
    if (!form.name.trim() || !phoneValid) { toast("Name and a valid phone number are required"); return; }
    try {
      const saved = contact
        ? await Contacts.update(contact.id, form.name.trim(), fullPhone)
        : await Contacts.add(form.name.trim(), fullPhone);
      setContact(saved);
      setEditing(false);
      toast(contact ? "Contact updated" : "Contact added");
      onChanged();
    } catch (problem) {
      toast(problem.message || "Could not save contact");
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        border: `1px solid ${G.border}`, maxHeight: "80vh", overflowY: "auto", color: G.text,
      }}>
        {!editing ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: peerProfile?.username ? 6 : 18 }}>
              <Av av={peerProfile?.avatar_letter} color={peerProfile?.color} size={56}/>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>
                  {contact ? contact.name : (peerProfile?.name || chat.name || "Contact")}
                </div>
                {(contact?.phone || peerProfile?.phone) && (
                  <div style={{ fontSize: 13, color: G.muted }}>{contact?.phone || peerProfile?.phone}</div>
                )}
              </div>
            </div>
            {peerProfile?.username && (
              <div style={{ fontSize: 13, color: G.muted, marginBottom: 18 }}>@{peerProfile.username}</div>
            )}
            <SRow icon={I.user(G.accent, 18)} label={contact ? "Edit contact" : "Add to contacts"} onClick={startEdit}/>
          </>
        ) : (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>
              {contact ? "Edit contact" : "Add to contacts"}
            </div>
            <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 4 }}>Name</div>
            <input value={form.name} onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                   style={{
                     width: "100%", padding: "11px 13px", borderRadius: 10, marginBottom: 12,
                     border: `1px solid ${G.border}`, background: G.dim, color: G.text, fontSize: 14,
                     boxSizing: "border-box",
                   }}/>
            <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 4 }}>Phone</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
              <select value={country.iso}
                      onChange={(event) => setCountry(COUNTRY_CODES.find((c) => c.iso === event.target.value))}
                      style={{
                        padding: "10px 8px", borderRadius: 10, border: `1px solid ${G.border}`,
                        background: G.dim, color: G.text, fontSize: 14,
                      }}>
                {COUNTRY_CODES.map((c) => (
                  <option key={c.iso} value={c.iso}>{flagFor(c.iso)} {c.dial}</option>
                ))}
              </select>
              <input value={form.phone}
                     onChange={(event) => setForm((f) => ({
                       ...f, phone: event.target.value.replace(/\D/g, "").slice(0, country.len),
                     }))}
                     placeholder={samplePlaceholder(country.len)}
                     style={{
                       flex: 1, padding: "11px 13px", borderRadius: 10, border: `1px solid ${G.border}`,
                       background: G.dim, color: G.text, fontSize: 14, boxSizing: "border-box",
                     }}/>
            </div>
            <Button onClick={save} style={{ width: "100%" }}>Save</Button>
          </>
        )}
      </div>
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

function ChatRow({ chat, typing, onOpen, onPin, onArchive, onClear, onDelete, onMenu,
                   selectMode, selected, onToggleSelect }) {
  const typingNames = Object.values(typing || {});
  const [dragX, setDragX] = useState(0);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const startedAt = useRef(0);
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);

  function clearLongPressTimer() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

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
    startY.current = event.clientY;
    startedAt.current = Date.now();
    event.currentTarget.setPointerCapture(event.pointerId);

    // Touch has no right-click, so a long-press stands in for it here —
    // mirrors the desktop onContextMenu below, just reached differently.
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
    // Right swipe (positive) is a short one-shot pin gesture; left swipe
    // (negative) opens further to reveal three action icons.
    setDragX(Math.max(-ACTIONS_WIDTH, Math.min(PIN_SWIPE_TRIGGER + 20, delta)));
  }

  function onPointerUpOrCancel() {
    clearLongPressTimer();
    if (!dragging.current) return;
    dragging.current = false;
    if (longPressFired.current) { setDragX(0); return; }

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
    // A long-press that just opened the menu must not also open the chat —
    // pointerup is immediately followed by a click for the same gesture.
    if (longPressFired.current) { longPressFired.current = false; return; }
    if (selectMode) { onToggleSelect(); return; }
    // A drag that never actually moved is just a tap — open the chat. One
    // that's still snapped open just closes instead of navigating away.
    if (dragX !== 0) { setDragX(0); return; }
    onOpen();
  }

  function onContextMenu(event) {
    event.preventDefault();
    if (selectMode) return;
    setDragX(0);
    onMenu(event.clientX, event.clientY);
  }

  const chevronRef = useRef(null);

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
        onClick={handleOpen} onContextMenu={onContextMenu}
        style={{
          display: "flex", alignItems: "center", gap: 11, padding: "7px 16px",
          cursor: "pointer", background: G.bg,
          transform: `translateX(${dragX}px)`,
          transition: dragging.current ? "none" : "transform 0.2s ease",
          touchAction: "pan-y",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = G.card;
          if (chevronRef.current) chevronRef.current.style.opacity = "1";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = G.bg;
          if (chevronRef.current) chevronRef.current.style.opacity = "0";
        }}>

        {!selectMode && (
          <div ref={chevronRef}
               onClick={(event) => { event.stopPropagation(); onMenu(event.clientX, event.clientY); }}
               title="More options"
               style={{
                 position: "absolute", right: 14, bottom: 6, zIndex: 2,
                 opacity: 0, transition: "opacity 0.15s", cursor: "pointer",
                 width: 22, height: 22, borderRadius: "50%",
                 display: "flex", alignItems: "center", justifyContent: "center",
                 background: G.card, boxShadow: `0 1px 4px ${G.border}`,
               }}>{I.chevronDown(G.sub, 14)}</div>
        )}

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
