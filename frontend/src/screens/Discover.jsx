import { useEffect, useState } from "react";
import { Chats, Contacts, Users } from "../api.js";
import { Av, Button, Field, G, I, Spinner } from "../ui.jsx";
import { COUNTRY_CODES, flagFor, samplePlaceholder } from "../countryCodes.js";

/**
 * Find people, channels and communities.
 *
 * Channels and communities come from one /discover endpoint because on the
 * server they are the same table with a different `type` — there is no reason
 * for the client to fetch them separately.
 */
export default function Discover({ onOpenChat, onChanged, toast }) {
  const [tab, setTab] = useState("people");
  const [people, setPeople] = useState([]);
  const [public_, setPublic] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [creatingBroadcast, setCreatingBroadcast] = useState(false);
  const [joiningViaCode, setJoiningViaCode] = useState(false);
  const [addingContact, setAddingContact] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([Users.list(query), Chats.discover(), Contacts.list()])
      .then(([users, chats, mine]) => { setPeople(users); setPublic(chats); setContacts(mine); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [query]);

  function reloadContacts() {
    Contacts.list().then(setContacts).catch(() => {});
  }

  async function removeContact(contactId) {
    await Contacts.remove(contactId);
    setContacts((current) => current.filter((c) => c.id !== contactId));
    toast("Contact removed");
  }

  async function importFromDevice() {
    // The Contact Picker API is a one-shot, user-gesture-triggered picker —
    // there is no such thing as a background "sync," by design (a website
    // is never allowed standing access to the device address book). Support
    // is Android Chrome/Edge only as of this writing; the button itself is
    // hidden everywhere else via the `"contacts" in navigator` check above.
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      let imported = 0;
      for (const person of picked) {
        const name = person.name?.[0]?.trim();
        const phone = person.tel?.[0]?.trim();
        if (!name || !phone) continue;
        try {
          await Contacts.add(name, phone);
          imported++;
        } catch {
          // Already have this number saved, or it didn't validate — skip it
          // rather than aborting the whole batch over one bad entry.
        }
      }
      toast(imported > 0 ? `Imported ${imported} contact${imported === 1 ? "" : "s"}` : "No new contacts to import");
      reloadContacts();
    } catch (problem) {
      if (problem.name !== "AbortError") toast("Could not import contacts");
    }
  }

  async function startDm(user) {
    const chat = await Chats.dm(user.id);
    onChanged();
    onOpenChat(chat);
  }

  async function join(chat) {
    await Chats.join(chat.id);
    toast(`Joined ${chat.name}`);
    setPublic((current) =>
      current.map((c) => (c.id === chat.id ? { ...c, joined: 1, member_count: c.member_count + 1 } : c)));
    onChanged();
  }

  const channels = public_.filter((chat) => chat.type === "channel");
  const communities = public_.filter((chat) => chat.type === "community");

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <div style={{ padding: "10px 16px 0" }}>
        <Field value={query} onChange={(event) => setQuery(event.target.value)}
               placeholder="Search people…" style={{ marginBottom: 10 }}/>
        <Button variant="ghost" style={{ width: "100%", marginBottom: 4 }}
                onClick={() => setJoiningViaCode(true)}>
          Join via code
        </Button>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "0 16px 12px" }}>
        {["people", "contacts", "channels", "communities"].map((option) => (
          <button key={option} onClick={() => setTab(option)}
            style={{
              flex: 1, padding: "8px", borderRadius: 10, cursor: "pointer",
              fontSize: 13, fontWeight: 600, textTransform: "capitalize",
              border: `1px solid ${tab === option ? G.accent : G.border}`,
              background: tab === option ? G.accentSoft : "transparent",
              color: tab === option ? G.accentText : G.sub,
            }}>{option}</button>
        ))}
      </div>

      {loading && <Spinner/>}

      {!loading && tab === "people" && (
        <div style={{ padding: "0 16px 10px", display: "flex", gap: 8 }}>
          <Button variant="ghost" style={{ flex: 1 }} onClick={() => setCreatingGroup(true)}>
            + New group
          </Button>
          <Button variant="ghost" style={{ flex: 1 }} onClick={() => setCreatingBroadcast(true)}>
            + New broadcast
          </Button>
        </div>
      )}

      {!loading && tab === "people" && people.map((person) => (
        <div key={person.id} onClick={() => startDm(person)}
          style={{
            display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
            borderBottom: `1px solid ${G.border}`, cursor: "pointer",
          }}>
          <Av av={person.avatar_letter} color={person.color} size={44} online={person.online} photoId={person.avatar_attachment_id}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{person.name}</div>
            <div style={{ fontSize: 12.5, color: G.muted }}>
              @{person.username}{person.bio ? ` · ${person.bio}` : ""}
            </div>
          </div>
        </div>
      ))}

      {!loading && tab === "contacts" && (
        <div style={{ padding: "0 16px 10px", display: "flex", gap: 8 }}>
          <Button variant="ghost" style={{ flex: 1 }} onClick={() => setAddingContact(true)}>
            + New contact
          </Button>
          {"contacts" in navigator && (
            <Button variant="ghost" style={{ flex: 1 }} onClick={importFromDevice}>
              📱 Import from device
            </Button>
          )}
        </div>
      )}

      {!loading && tab === "contacts" && contacts.length === 0 && (
        <div style={{ padding: 30, textAlign: "center", color: G.muted, fontSize: 13.5 }}>
          No contacts yet. Add one by name and phone number.
        </div>
      )}

      {!loading && tab === "contacts" && contacts.map((contact) => (
        <div key={contact.id}
          onClick={() => contact.user && startDm(contact.user)}
          style={{
            display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
            borderBottom: `1px solid ${G.border}`, cursor: contact.user ? "pointer" : "default",
          }}>
          {contact.user
            ? <Av av={contact.user.avatar_letter} color={contact.user.color} size={44} online={contact.user.online} photoId={contact.user.avatar_attachment_id}/>
            : <div style={{
                width: 44, height: 44, borderRadius: "50%", background: G.dim,
                border: `1px solid ${G.border}`, display: "flex", alignItems: "center",
                justifyContent: "center", fontSize: 16, fontWeight: 700, color: G.muted,
              }}>{contact.name[0]?.toUpperCase()}</div>}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{contact.name}</div>
            <div style={{ fontSize: 12.5, color: contact.user ? G.accent : G.muted }}>
              {contact.user ? `@${contact.user.username} · On TalkEx` : `${contact.phone} · Not on TalkEx yet`}
            </div>
          </div>
          <div onClick={(event) => { event.stopPropagation(); removeContact(contact.id); }}
               style={{ cursor: "pointer", padding: 6 }}>{I.trash()}</div>
        </div>
      ))}

      {!loading && (tab === "channels" || tab === "communities") && (
        <>
          <div style={{ padding: "0 16px 10px" }}>
            <Button variant="ghost" style={{ width: "100%" }}
                    onClick={() => setCreating(tab === "channels" ? "channel" : "community")}>
              + Create a {tab === "channels" ? "channel" : "community"}
            </Button>
          </div>

          {(tab === "channels" ? channels : communities).map((chat) => (
            <div key={chat.id} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
              borderBottom: `1px solid ${G.border}`,
            }}>
              <Av av={chat.avatar_letter} color={chat.color} size={44}/>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{chat.name}</span>
                  {chat.is_verified ? I.verified() : null}
                </div>
                <div style={{ fontSize: 12.5, color: G.muted }}>
                  {chat.member_count} member{chat.member_count === 1 ? "" : "s"}
                  {chat.description ? ` · ${chat.description}` : ""}
                </div>
              </div>
              {chat.joined
                ? <Button variant="ghost" onClick={() => onOpenChat(chat)}
                          style={{ padding: "8px 14px" }}>Open</Button>
                : <Button onClick={() => join(chat)} style={{ padding: "8px 14px" }}>Join</Button>}
            </div>
          ))}
        </>
      )}

      {creating && (
        <CreateSheet kind={creating} onClose={() => setCreating(null)}
                     onCreated={(chat) => {
                       setCreating(null);
                       onChanged();
                       onOpenChat(chat);
                     }}/>
      )}

      {creatingGroup && (
        <MemberPickerSheet title="New group" nameLabel="Group name" namePlaceholder="Weekend Trip"
                           memberLabel="Members" maxCount={1024} people={people}
                           createFn={(name, memberIds) => Chats.createGroup({ name, member_ids: memberIds })}
                           onClose={() => setCreatingGroup(false)}
                           onCreated={(chat) => {
                             setCreatingGroup(false);
                             onChanged();
                             onOpenChat(chat);
                           }}/>
      )}

      {creatingBroadcast && (
        <MemberPickerSheet title="New broadcast" nameLabel="List name" namePlaceholder="Announcements"
                           memberLabel="Recipients" maxCount={512} people={people}
                           createFn={(name, recipientIds) => Chats.createBroadcast({ name, recipient_ids: recipientIds })}
                           onClose={() => setCreatingBroadcast(false)}
                           onCreated={(chat) => {
                             setCreatingBroadcast(false);
                             onChanged();
                             onOpenChat(chat);
                           }}/>
      )}

      {joiningViaCode && (
        <JoinViaCodeSheet onClose={() => setJoiningViaCode(false)} toast={toast}
                          onJoined={(chat) => {
                            setJoiningViaCode(false);
                            onChanged();
                            onOpenChat(chat);
                          }}/>
      )}

      {addingContact && (
        <AddContactSheet onClose={() => setAddingContact(false)} toast={toast}
                         onAdded={() => { setAddingContact(false); reloadContacts(); }}/>
      )}
    </div>
  );
}

function AddContactSheet({ onClose, onAdded, toast }) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState(COUNTRY_CODES[0]);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const fullPhone = country.dial + phone;
  const validLength = phone.length === country.len;

  function onPhoneChange(event) {
    setPhone(event.target.value.replace(/\D/g, "").slice(0, country.len));
  }

  async function save() {
    if (!name.trim() || !validLength) return;
    setBusy(true);
    try {
      await Contacts.add(name.trim(), fullPhone);
      toast("Contact added");
      onAdded();
    } catch (problem) {
      toast(problem.message || "Could not add contact");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 50,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>New contact</div>
        <Field label="Name" value={name} onChange={(event) => setName(event.target.value)}
               placeholder="Rahul Sharma"/>
        <label style={{ display: "block", marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: G.sub, marginBottom: 6 }}>Phone number</div>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={country.iso}
                    onChange={(event) => {
                      setCountry(COUNTRY_CODES.find((c) => c.iso === event.target.value));
                      setPhone("");
                    }}
                    style={{
                      padding: "12px 8px", borderRadius: 12, background: G.dim,
                      border: `1px solid ${G.border}`, color: G.text, fontSize: 15,
                      outline: "none", flexShrink: 0,
                    }}>
              {COUNTRY_CODES.map((c) => (
                <option key={c.iso} value={c.iso}>{flagFor(c.iso)} {c.dial}</option>
              ))}
            </select>
            <input value={phone} onChange={onPhoneChange} inputMode="tel"
                   placeholder={samplePlaceholder(country.len)}
                   style={{
                     flex: 1, width: "100%", padding: "12px 14px", borderRadius: 12,
                     background: G.dim, border: `1px solid ${G.border}`, color: G.text,
                     fontSize: 15, outline: "none", boxSizing: "border-box",
                   }}/>
          </div>
        </label>
        <Button onClick={save} disabled={busy || !name.trim() || !validLength}
                style={{ width: "100%" }}>
          {busy ? "Saving…" : "Save contact"}
        </Button>
        <div style={{ fontSize: 12, color: G.muted, marginTop: 10 }}>
          If that number is already on TalkEx, you'll be able to message them
          right away. If not, they'll show up here once they join.
        </div>
      </div>
    </div>
  );
}

function JoinViaCodeSheet({ onClose, onJoined, toast }) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function lookUp() {
    if (!code.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await Chats.previewInvite(code.trim());
      setPreview(result);
    } catch (problem) {
      setError(problem.message || "Invalid or expired invite link");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    setBusy(true);
    try {
      const result = await Chats.joinViaInvite(code.trim());
      const chat = await Chats.get(result.chat_id);
      toast(`Joined ${preview?.name || "the chat"}`);
      onJoined(chat);
    } catch (problem) {
      setError(problem.message || "Could not join");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 50,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Join via code</div>

        {!preview ? (
          <>
            <Field label="Invite code" value={code}
                   onChange={(event) => setCode(event.target.value)}
                   placeholder="Paste the code here"
                   onKeyDown={(event) => event.key === "Enter" && lookUp()}/>
            {error && <div style={{ color: G.red, fontSize: 13, marginBottom: 10 }}>{error}</div>}
            <Button onClick={lookUp} disabled={busy || !code.trim()} style={{ width: "100%" }}>
              {busy ? "Checking…" : "Continue"}
            </Button>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <Av av={preview.avatar_letter} color={preview.color} size={44}/>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{preview.name}</div>
                <div style={{ fontSize: 12.5, color: G.muted }}>
                  {preview.member_count} member{preview.member_count === 1 ? "" : "s"}
                </div>
              </div>
            </div>
            {error && <div style={{ color: G.red, fontSize: 13, marginBottom: 10 }}>{error}</div>}
            <Button onClick={join} disabled={busy || preview.already_joined} style={{ width: "100%" }}>
              {preview.already_joined ? "Already joined" : busy ? "Joining…" : "Join"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function CreateSheet({ kind, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const chat = kind === "channel"
        ? await Chats.createChannel({ name: name.trim(), description: description.trim() })
        : await Chats.createCommunity({ name: name.trim(), description: description.trim() });
      onCreated(chat);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 50,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>
          New {kind}
        </div>
        <Field label="Name" value={name} onChange={(event) => setName(event.target.value)}
               placeholder={kind === "channel" ? "Tech India" : "Developers India"}/>
        <Field label="Description" value={description}
               onChange={(event) => setDescription(event.target.value)}
               placeholder="What is it about?"/>
        <Button onClick={save} disabled={busy} style={{ width: "100%" }}>
          {busy ? "Creating…" : `Create ${kind}`}
        </Button>
      </div>
    </div>
  );
}

/**
 * A "pick a name, then pick some people" sheet — the same shape whether
 * you're building a group (shared chat, everyone sees every reply) or a
 * broadcast list (write once, each recipient gets their own copy in their
 * DM with you and never sees the others). Only the labels, the cap, and
 * what actually gets called to create the chat differ.
 */
function MemberPickerSheet({ title, namePlaceholder, nameLabel, memberLabel, maxCount,
                             people, onClose, onCreated, createFn }) {
  const [name, setName] = useState("");
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  function toggle(userId) {
    setSelected((current) => {
      if (current.includes(userId)) return current.filter((id) => id !== userId);
      if (current.length >= maxCount) return current;
      return [...current, userId];
    });
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const chat = await createFn(name.trim(), selected);
      onCreated(chat);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 50,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "80vh",
        overflowY: "auto",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>{title}</div>
        <Field label={nameLabel} value={name} onChange={(event) => setName(event.target.value)}
               placeholder={namePlaceholder}/>

        <div style={{ fontSize: 12, color: G.sub, margin: "10px 0 8px" }}>
          {memberLabel} ({selected.length}/{maxCount})
        </div>
        <div style={{ maxHeight: 260, overflowY: "auto", marginBottom: 14 }}>
          {people.length === 0 && (
            <div style={{ fontSize: 13, color: G.muted, padding: "8px 0" }}>
              No one to add yet — search for people first.
            </div>
          )}
          {people.map((person) => (
            <label key={person.id} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 4px",
              cursor: "pointer", borderBottom: `1px solid ${G.border}`,
              opacity: !selected.includes(person.id) && selected.length >= maxCount ? 0.4 : 1,
            }}>
              <input type="checkbox" checked={selected.includes(person.id)}
                     disabled={!selected.includes(person.id) && selected.length >= maxCount}
                     onChange={() => toggle(person.id)}/>
              <Av av={person.avatar_letter} color={person.color} size={32} photoId={person.avatar_attachment_id}/>
              <div style={{ fontSize: 14 }}>{person.name}</div>
            </label>
          ))}
        </div>

        <Button onClick={save} disabled={busy || !name.trim()} style={{ width: "100%" }}>
          {busy ? "Creating…" : title}
        </Button>
      </div>
    </div>
  );
}
