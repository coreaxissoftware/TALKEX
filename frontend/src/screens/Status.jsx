import { useEffect, useState } from "react";
import { Chats, Contacts, Me, Stories, Uploads } from "../api.js";
import {
  Av, Button, Field, G, I, Spinner, countdown, localInputToUnix, whenLabel,
} from "../ui.jsx";
import { MoreMenu } from "./CallOverlay.jsx";
import PhotoEditor from "../PhotoEditor.jsx";

const BACKGROUNDS = [
  "linear-gradient(135deg,#6366f1,#4f46e5)",
  "linear-gradient(135deg,#f59e0b,#ef4444)",
  "linear-gradient(135deg,#10b981,#059669)",
  "linear-gradient(135deg,#ec4899,#8b5cf6)",
  "linear-gradient(135deg,#0ea5e9,#2563eb)",
];

// A fixed set rather than a free font-name field — nobody is hand-rolling a
// @font-face, and a bad/unknown value here should just fall back quietly
// rather than break the layout, so this is keyed by a short id, not a raw
// CSS string the client has to trust.
const FONTS = [
  { key: "system", label: "Classic", stack: "'SF Pro Text',-apple-system,sans-serif" },
  { key: "serif", label: "Serif", stack: "Georgia,'Times New Roman',serif" },
  { key: "mono", label: "Mono", stack: "'SF Mono',Consolas,monospace" },
  { key: "rounded", label: "Rounded", stack: "'Segoe UI',Verdana,sans-serif" },
  { key: "script", label: "Script", stack: "'Brush Script MT',cursive" },
];
const FONT_STACK_BY_KEY = Object.fromEntries(FONTS.map((f) => [f.key, f.stack]));
function fontStackFor(key) { return FONT_STACK_BY_KEY[key] || FONT_STACK_BY_KEY.system; }

const FONT_SIZES = [
  { key: "small", label: "S", px: 15 },
  { key: "medium", label: "M", px: 19 },
  { key: "large", label: "L", px: 25 },
];
const FONT_PX_BY_KEY = Object.fromEntries(FONT_SIZES.map((f) => [f.key, f.px]));
function fontPxFor(key) { return FONT_PX_BY_KEY[key] || FONT_PX_BY_KEY.medium; }

const KINDS = [
  { kind: "text", label: "Text", icon: "✍️" },
  { kind: "photo", label: "Photo", icon: I.image },
  { kind: "video", label: "Video", icon: I.video },
  { kind: "audio", label: "Music", icon: I.musicNote },
  { kind: "link", label: "Link", icon: I.link },
];

// One line describing a non-text status, used everywhere a row only has
// room for a preview line rather than the actual media (queued/mine/feed).
function kindPreviewLabel(story) {
  if (story.kind === "photo") return "📷 Photo" + (story.text ? ` · ${story.text}` : "");
  if (story.kind === "video") return "🎥 Video" + (story.text ? ` · ${story.text}` : "");
  if (story.kind === "audio") return "🎵 Audio" + (story.text ? ` · ${story.text}` : "");
  if (story.kind === "link") return story.text || story.link_url;
  return story.text;
}

// The small circle next to a queued/mine row: the emoji for a text status,
// or an icon naming the kind for a media/link one (the emoji is still saved
// but a photo/video/audio/link status is better identified by what it is).
function kindGlyph(story, color) {
  if (story.kind === "photo") return I.image(color, 18);
  if (story.kind === "video") return I.video(color, 18);
  if (story.kind === "audio") return I.musicNote(color, 18);
  if (story.kind === "link") return I.link(color, 18);
  return story.emoji;
}

/**
 * Status, including ones queued to publish later.
 *
 * A scheduled status is deliberately invisible to everyone else until it goes
 * live — it only appears in your own "My status" list, marked as queued.
 */
export default function Status({ me, toast }) {
  const [feed, setFeed] = useState([]);
  const [mine, setMine] = useState([]);
  const [muted, setMuted] = useState([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [muteMenuFor, setMuteMenuFor] = useState(null); // the author row currently showing its menu

  function reload() {
    setLoading(true);
    Promise.all([Stories.list(), Stories.mine(), Stories.mutedStatuses()])
      .then(([theirs, ours, mutedList]) => { setFeed(theirs); setMine(ours); setMuted(mutedList); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  async function muteAuthor(userId) {
    setMuteMenuFor(null);
    try {
      await Stories.muteStatus(userId);
      toast("Status muted");
      reload();
    } catch (problem) {
      toast(problem.message || "Could not mute");
    }
  }

  async function unmuteAuthor(userId) {
    try {
      await Stories.unmuteStatus(userId);
      toast("Status unmuted");
      reload();
    } catch (problem) {
      toast(problem.message || "Could not unmute");
    }
  }

  useEffect(reload, []);

  async function open(story) {
    setViewing(story);
    try { await Stories.view(story.id); } catch { /* viewing is best-effort */ }
  }

  const scheduled = mine.filter((story) => story.status === "scheduled");
  const live = mine.filter((story) => story.status === "live");

  if (loading) return <Spinner/>;

  return (
    <div style={{ flex: 1, overflowY: "auto", paddingBottom: 20 }}>
      <div style={{ padding: "14px 16px", display: "flex", gap: 8 }}>
        <Button onClick={() => setComposing(true)} style={{ flex: 1 }}>
          + Add to my status
        </Button>
        <div onClick={() => setPrivacyOpen(true)} title="Status privacy" style={{
          width: 42, height: 42, borderRadius: 12, border: `1px solid ${G.border}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", flexShrink: 0,
        }}>
          {I.lock(G.sub, 18)}
        </div>
      </div>

      {scheduled.length > 0 && (
        <>
          <SectionLabel>Queued</SectionLabel>
          {scheduled.map((story) => (
            <div key={story.id} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
              borderBottom: `1px solid ${G.border}`,
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: "50%", background: story.background,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: `2px dashed ${G.muted}`,
              }}>{kindGlyph(story, "#fff") || I.clock("#fff", 18)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5 }}>{kindPreviewLabel(story)}</div>
                <div style={{ fontSize: 12, color: G.yellow }}>
                  Publishes {whenLabel(story.publish_at)} · {countdown(story.publish_at)}
                </div>
              </div>
              <div onClick={async () => {
                await Stories.delete(story.id);
                toast("Cancelled");
                reload();
              }} style={{ cursor: "pointer" }}>{I.trash()}</div>
            </div>
          ))}
        </>
      )}

      {live.length > 0 && (
        <>
          <SectionLabel>My status</SectionLabel>
          {live.map((story) => (
            <div key={story.id} onClick={() => open(story)}
              style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                borderBottom: `1px solid ${G.border}`, cursor: "pointer",
              }}>
              <div style={{
                width: 44, height: 44, borderRadius: "50%", background: story.background,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 20, border: `2.5px solid ${G.accent}`,
              }}>{kindGlyph(story, "#fff")}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5 }}>{kindPreviewLabel(story)}</div>
                <div style={{ fontSize: 12, color: G.muted }}>
                  {story.view_count} view{story.view_count === 1 ? "" : "s"} ·
                  gone {countdown(story.expires_at)}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      <SectionLabel>Recent updates</SectionLabel>
      {feed.filter((author) => author.user_id !== me.id).length === 0 && (
        <div style={{ padding: 30, textAlign: "center", color: G.muted, fontSize: 13.5 }}>
          Nothing from your contacts yet.
        </div>
      )}
      {feed.filter((author) => author.user_id !== me.id).map((author) => (
        <div key={author.user_id} onClick={() => open(author.stories[0])}
          style={{
            display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
            borderBottom: `1px solid ${G.border}`, cursor: "pointer",
          }}>
          <Av av={author.avatar_letter} color={author.color} size={48} photoId={author.avatar_attachment_id}
              hasStory={author.stories.some((story) => !story.seen)}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{author.name}</div>
            <div style={{ fontSize: 12.5, color: G.muted }}>
              {author.stories.length} update{author.stories.length === 1 ? "" : "s"} ·
              {" "}{whenLabel(author.stories[0].created_at)}
            </div>
          </div>
          <div onClick={(event) => { event.stopPropagation(); setMuteMenuFor(author); }}
               style={{ padding: 8, cursor: "pointer" }}>
            {I.moreVertical(G.muted, 18)}
          </div>
        </div>
      ))}

      {muted.length > 0 && (
        <>
          <SectionLabel>Muted</SectionLabel>
          {muted.map((person) => (
            <div key={person.id} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
              borderBottom: `1px solid ${G.border}`,
            }}>
              <Av av={person.avatar_letter} color={person.color} size={44} photoId={person.avatar_attachment_id}/>
              <div style={{ flex: 1, fontSize: 14.5, color: G.muted }}>{person.name}</div>
              <div onClick={() => unmuteAuthor(person.id)} style={{
                fontSize: 12.5, color: G.accent, cursor: "pointer", fontWeight: 600,
              }}>Unmute</div>
            </div>
          ))}
        </>
      )}

      {muteMenuFor && (
        <MoreMenu onClose={() => setMuteMenuFor(null)} items={[
          {
            label: `Mute ${muteMenuFor.name}'s status`,
            sub: "You won't see their status updates until you unmute",
            icon: I.eyeOff ? I.eyeOff(G.text, 18) : "🔕",
            onClick: () => muteAuthor(muteMenuFor.user_id),
          },
        ]}/>
      )}

      {composing && (
        <Compose onClose={() => setComposing(false)}
                 onDone={() => { setComposing(false); reload(); }}
                 toast={toast}/>
      )}

      {viewing && (
        <Viewer story={viewing} me={me} toast={toast}
                onClose={() => { setViewing(null); reload(); }}/>
      )}

      {privacyOpen && (
        <StatusPrivacySheet onClose={() => setPrivacyOpen(false)} toast={toast}/>
      )}
    </div>
  );
}

const AUDIENCE_MODES = [
  { key: "contacts", label: "My contacts", sub: "Everyone you share a chat with" },
  { key: "except", label: "My contacts except…", sub: "Everyone you share a chat with, except the people you pick" },
  { key: "only", label: "Only share with…", sub: "Just the people you pick" },
];

function StatusPrivacySheet({ onClose, toast }) {
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState("contacts");
  const [selected, setSelected] = useState(new Set());
  const [contacts, setContacts] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([Me.storyAudience(), Contacts.list()])
      .then(([audience, rows]) => {
        setMode(audience.mode);
        setSelected(new Set(audience.user_ids));
        setContacts(rows.filter((c) => c.user));
      })
      .catch(() => toast("Could not load your status privacy settings"))
      .finally(() => setLoading(false));
  }, []);

  function toggle(userId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await Me.setStoryAudience(mode, [...selected]);
      toast("Status privacy updated");
      onClose();
    } catch (problem) {
      toast(problem.message || "Could not save");
    } finally {
      setSaving(false);
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
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Status privacy</div>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 16 }}>
          Who sees status updates you post from now on. Anything already posted keeps its old audience.
        </div>
        {loading ? <Spinner small/> : (
          <>
            {AUDIENCE_MODES.map((option) => (
              <div key={option.key} onClick={() => setMode(option.key)} style={{
                padding: "12px 14px", borderRadius: 12, marginBottom: 8, cursor: "pointer",
                border: `1px solid ${mode === option.key ? G.accent : G.border}`,
                background: mode === option.key ? G.accentSoft : "transparent",
              }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: mode === option.key ? G.accentText : G.text }}>
                  {option.label}
                </div>
                <div style={{ fontSize: 12, color: G.muted, marginTop: 2 }}>{option.sub}</div>
              </div>
            ))}

            {(mode === "except" || mode === "only") && (
              <div style={{ marginTop: 10, marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: G.muted, marginBottom: 8 }}>
                  {selected.size} selected
                </div>
                {contacts.length === 0 ? (
                  <div style={{ fontSize: 13, color: G.muted, padding: "10px 0" }}>No saved contacts yet</div>
                ) : contacts.map((contact) => (
                  <label key={contact.id} onClick={(event) => event.stopPropagation()} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 2px", cursor: "pointer",
                  }}>
                    <input type="checkbox" checked={selected.has(contact.user.id)}
                           onChange={() => toggle(contact.user.id)}/>
                    <Av av={contact.user.avatar_letter} color={contact.user.color} size={30}/>
                    <div style={{ fontSize: 13.5 }}>{contact.name}</div>
                  </label>
                ))}
              </div>
            )}

            <Button onClick={save} disabled={saving} style={{ width: "100%" }}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div style={{
      padding: "14px 16px 6px", fontSize: 12, fontWeight: 700,
      color: G.muted, textTransform: "uppercase", letterSpacing: 0.6,
    }}>{children}</div>
  );
}

const ACCEPT_BY_KIND = {
  photo: "image/*",
  video: "video/*",
  audio: "audio/*",
};

function Compose({ onClose, onDone, toast }) {
  const [kind, setKind] = useState("text");
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState("⚡");
  const [background, setBackground] = useState(BACKGROUNDS[0]);
  const [font, setFont] = useState("system");
  const [fontSize, setFontSize] = useState("medium");
  const [linkUrl, setLinkUrl] = useState("");
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  // Off by default — only you can forward/share this status unless you
  // turn this on, same WhatsApp-style opt-in the viewer's Forward/Share
  // menu items are gated on (see moreItems in Viewer below).
  const [allowShare, setAllowShare] = useState(false);

  // Set once the file for a photo/video/audio status has actually finished
  // uploading — the same two-step "upload, then reference the id" pattern
  // ChatView's AttachSheet uses, so a failed/retried post never re-sends the
  // file itself.
  const [upload, setUpload] = useState(null); // { attachmentId, previewUrl, fileName }
  const [uploading, setUploading] = useState(false);
  // The picked (or already-edited) File for a photo status — kept around
  // so "Edit" can be tapped again after the first upload, same idea as
  // ChatView's AttachSheet keeping a working copy separate from what's
  // already gone to the server.
  const [rawPhotoFile, setRawPhotoFile] = useState(null);
  const [editingPhoto, setEditingPhoto] = useState(false);

  function pickKind(next) {
    setKind(next);
    setUpload(null);
    setRawPhotoFile(null);
  }

  async function uploadFile(file, previewUrl) {
    setUploading(true);
    try {
      const attachment = await Uploads.create(file);
      setUpload((current) => {
        if (current?.previewUrl && current.previewUrl !== previewUrl) URL.revokeObjectURL(current.previewUrl);
        return { attachmentId: attachment.attachment_id, previewUrl, fileName: file.name };
      });
    } catch (problem) {
      toast(problem.message || "Could not upload file");
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    } finally {
      setUploading(false);
    }
  }

  async function onFilePicked(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (kind === "photo") setRawPhotoFile(file);
    const previewUrl = kind === "photo" || kind === "video" ? URL.createObjectURL(file) : null;
    await uploadFile(file, previewUrl);
  }

  function onPhotoEdited(editedFile) {
    setEditingPhoto(false);
    setRawPhotoFile(editedFile);
    uploadFile(editedFile, URL.createObjectURL(editedFile));
  }

  if (editingPhoto) {
    return (
      <PhotoEditor file={rawPhotoFile} onCancel={() => setEditingPhoto(false)} onDone={onPhotoEdited}/>
    );
  }

  async function save() {
    if (kind === "text" && !text.trim()) return;
    if ((kind === "photo" || kind === "video" || kind === "audio") && !upload) {
      toast(`Pick a${kind === "audio" ? "n" : ""} ${kind} first`);
      return;
    }
    let trimmedLink = "";
    if (kind === "link") {
      trimmedLink = linkUrl.trim();
      if (!trimmedLink.startsWith("http://") && !trimmedLink.startsWith("https://")) {
        toast("Link must start with http:// or https://");
        return;
      }
    }

    let publishAt = null;
    if (later) {
      if (!when) { toast("Pick a time"); return; }
      publishAt = localInputToUnix(when);
      if (publishAt <= Date.now() / 1000) { toast("Pick a time in the future"); return; }
    }

    setBusy(true);
    try {
      await Stories.create({
        text: text.trim(), emoji, background, kind,
        attachmentId: upload?.attachmentId || null,
        linkUrl: kind === "link" ? trimmedLink : null,
        publishAt, font, fontSize, allowShare,
      });
      toast(later ? "Status queued" : "Status posted");
      onDone();
    } catch (problem) {
      toast(problem.message || "Could not post");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000cc", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        maxHeight: "85vh", overflowY: "auto",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>New status</div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          {KINDS.map(({ kind: option, label, icon }) => (
            <button key={option} onClick={() => pickKind(option)} style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              padding: "8px 4px", borderRadius: 10, cursor: "pointer",
              background: kind === option ? G.accentSoft : G.dim,
              border: `1px solid ${kind === option ? G.accent : G.border}`,
              color: kind === option ? G.accent : G.sub,
            }}>
              {typeof icon === "function" ? icon(kind === option ? G.accent : G.sub, 18) : icon}
              <span style={{ fontSize: 10.5, fontWeight: 600 }}>{label}</span>
            </button>
          ))}
        </div>

        {kind === "text" && (
          <>
            <div style={{
              height: 120, borderRadius: 16, background, display: "flex",
              alignItems: "center", justifyContent: "center", marginBottom: 14,
              fontSize: fontPxFor(fontSize), color: "#fff", fontWeight: 600, padding: 16,
              textAlign: "center", fontFamily: fontStackFor(font),
            }}>{emoji} {text || "Your status"}</div>

            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {FONTS.map(({ key, label, stack }) => (
                <button key={key} onClick={() => setFont(key)} style={{
                  flex: 1, padding: "7px 4px", borderRadius: 10, cursor: "pointer",
                  fontFamily: stack, fontSize: 12.5,
                  background: font === key ? G.accentSoft : G.dim,
                  border: `1px solid ${font === key ? G.accent : G.border}`,
                  color: font === key ? G.accent : G.sub,
                }}>{label}</button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
              {FONT_SIZES.map(({ key, label }) => (
                <button key={key} onClick={() => setFontSize(key)} style={{
                  flex: 1, padding: "7px 4px", borderRadius: 10, cursor: "pointer",
                  fontSize: 13, fontWeight: 700,
                  background: fontSize === key ? G.accentSoft : G.dim,
                  border: `1px solid ${fontSize === key ? G.accent : G.border}`,
                  color: fontSize === key ? G.accent : G.sub,
                }}>{label}</button>
              ))}
            </div>
          </>
        )}

        {(kind === "photo" || kind === "video" || kind === "audio") && (
          <div style={{ marginBottom: 14 }}>
            {upload ? (
              <div style={{
                position: "relative", borderRadius: 16, overflow: "hidden", background: G.dim,
                border: `1px solid ${G.border}`,
              }}>
                {kind === "photo" && (
                  <img src={upload.previewUrl} alt="Selected photo preview" style={{ width: "100%", maxHeight: 220, objectFit: "cover", display: "block" }}/>
                )}
                {kind === "photo" && rawPhotoFile && (
                  <button onClick={() => setEditingPhoto(true)} style={{
                    position: "absolute", top: 10, right: 10, display: "flex", alignItems: "center", gap: 6,
                    padding: "6px 12px", borderRadius: 20, border: "none", cursor: "pointer",
                    background: "#00000099", color: "#fff", fontSize: 12.5, fontWeight: 600,
                  }}>{I.edit("#fff", 14)} Edit</button>
                )}
                {kind === "video" && (
                  <video src={upload.previewUrl} controls style={{ width: "100%", maxHeight: 220, display: "block" }}/>
                )}
                {kind === "audio" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: 16 }}>
                    {I.musicNote(G.accent, 24)}
                    <span style={{ fontSize: 13.5 }}>{upload.fileName}</span>
                  </div>
                )}
              </div>
            ) : (
              <label style={{
                height: 120, borderRadius: 16, background: G.dim, display: "flex",
                flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8,
                border: `1.5px dashed ${G.border}`, cursor: "pointer",
              }}>
                {uploading ? <Spinner small/> : (
                  <>
                    {kind === "photo" && I.image(G.sub, 26)}
                    {kind === "video" && I.video(G.sub, 26)}
                    {kind === "audio" && I.musicNote(G.sub, 26)}
                    <span style={{ fontSize: 13, color: G.muted }}>
                      Choose a {kind} file
                    </span>
                  </>
                )}
                <input type="file" accept={ACCEPT_BY_KIND[kind]} hidden
                       disabled={uploading} onChange={onFilePicked}/>
              </label>
            )}
          </div>
        )}

        {kind === "link" && (
          <Field label="Link" value={linkUrl}
                 onChange={(event) => setLinkUrl(event.target.value)}
                 placeholder="https://…" style={{ marginBottom: 4 }}/>
        )}

        <Field label={kind === "text" ? "Text" : "Caption (optional)"} value={text}
               onChange={(event) => setText(event.target.value)}
               placeholder="What's happening?"/>

        {kind === "text" && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {["⚡", "🔥", "🚀", "🎉", "☕", "💼"].map((option) => (
                <button key={option} onClick={() => setEmoji(option)} style={{
                  fontSize: 20, padding: "6px 10px", borderRadius: 10, cursor: "pointer",
                  background: emoji === option ? G.accentSoft : G.dim,
                  border: `1px solid ${emoji === option ? G.accent : G.border}`,
                }}>{option}</button>
              ))}
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {BACKGROUNDS.map((option) => (
                <div key={option} onClick={() => setBackground(option)} style={{
                  width: 40, height: 40, borderRadius: 10, background: option,
                  cursor: "pointer",
                  border: background === option ? `2.5px solid ${G.text}` : "none",
                }}/>
              ))}
            </div>
          </>
        )}

        <label style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
          fontSize: 14, cursor: "pointer",
        }}>
          <input type="checkbox" checked={allowShare}
                 onChange={(event) => setAllowShare(event.target.checked)}/>
          Allow others to forward/share this
        </label>
        <div style={{ fontSize: 12, color: G.muted, marginBottom: 12, marginLeft: 26 }}>
          Off by default — only you can forward or share this status elsewhere.
        </div>

        <label style={{
          display: "flex", alignItems: "center", gap: 10, marginBottom: 12,
          fontSize: 14, cursor: "pointer",
        }}>
          <input type="checkbox" checked={later}
                 onChange={(event) => setLater(event.target.checked)}/>
          Publish later
        </label>

        {later && (
          <Field label="Publish at" type="datetime-local" value={when}
                 onChange={(event) => setWhen(event.target.value)}/>
        )}

        <Button onClick={save} disabled={busy || uploading} style={{ width: "100%" }}>
          {busy ? "Saving…" : later ? "Queue status" : "Post status"}
        </Button>

        {later && (
          <div style={{ fontSize: 12, color: G.muted, marginTop: 10 }}>
            Nobody can see it until then. Its 24 hours start when it publishes.
          </div>
        )}
      </div>
    </div>
  );
}

const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "👏", "🔥"];

function Viewer({ story, me, toast, onClose }) {
  const isMedia = story.kind === "photo" || story.kind === "video" || story.kind === "audio";
  const isAuthor = story.user_id === me.id;
  const [myReaction, setMyReaction] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  // Author-only: who's seen it and who reacted, merged into one list —
  // loaded lazily since a viewer who isn't the author would just get a 404
  // for both calls.
  const [activity, setActivity] = useState(null);
  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    if (!isAuthor) return;
    Promise.all([Stories.viewers(story.id), Stories.reactions(story.id)])
      .then(([viewers, reactions]) => setActivity({ viewers, reactions }))
      .catch(() => {});
  }, [story.id, isAuthor]);

  async function react(emoji) {
    // Tapping the already-active one un-reacts — same "tap again to
    // remove" convention a message reaction already uses in ChatView.
    const next = myReaction === emoji ? null : emoji;
    const previous = myReaction;
    setMyReaction(next);
    try {
      if (next) await Stories.react(story.id, next);
      else await Stories.unreact(story.id);
    } catch (problem) {
      setMyReaction(previous);
      toast?.(problem.message || "Could not react");
    }
  }

  const copyableText = story.kind === "link"
    ? (story.link_url || story.text || "")
    : story.kind === "text" ? story.text : "";

  async function copyStory() {
    try {
      await navigator.clipboard.writeText(copyableText);
      toast?.("Copied");
    } catch {
      toast?.("Could not copy");
    }
  }

  async function shareStory() {
    try {
      if (isMedia && story.attachment_id) {
        const blobUrl = await Uploads.fetchBlobUrl(story.attachment_id);
        const blob = await fetch(blobUrl).then((r) => r.blob());
        const file = new File([blob], `status.${blob.type.split("/")[1] || "bin"}`, { type: blob.type });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], text: story.text || undefined });
          return;
        }
      }
      if (navigator.share) {
        await navigator.share({ text: copyableText || story.text || "Check out this status on TalkEx" });
      } else {
        await navigator.clipboard.writeText(copyableText || story.text);
        toast?.("Copied — sharing isn't supported in this browser");
      }
    } catch (problem) {
      if (problem?.name !== "AbortError") toast?.("Could not share");
    }
  }

  async function deleteThisStory() {
    if (!window.confirm("Delete this status? This can't be undone.")) return;
    try {
      await Stories.delete(story.id);
      toast?.("Deleted");
      onClose();
    } catch (problem) {
      toast?.(problem.message || "Could not delete");
    }
  }

  // WhatsApp-style: forwarding/sharing is the author's own privilege by
  // default. A viewer only gets it too if the author turned "Allow share"
  // on for this specific status — matches the server-side check in
  // forward_story (main.py), repeated here so the option isn't even shown
  // for a viewer it would just 403 for.
  const canReshare = isAuthor || Boolean(story.allow_share);
  const moreItems = [
    ...(canReshare ? [{ label: "Forward", icon: I.fwd("#fff", 18), onClick: () => setForwarding(true) }] : []),
    ...(canReshare ? [{ label: "Share", icon: I.send("#fff", 18), onClick: shareStory }] : []),
    ...(copyableText ? [{ label: "Copy", icon: I.link("#fff", 18), onClick: copyStory }] : []),
    ...(isAuthor ? [{ label: "Delete", icon: I.trash("#ff8080", 18), onClick: deleteThisStory }] : []),
  ];

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: isMedia ? "#000" : (story.background || G.bg),
      zIndex: 70, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: 30,
    }}>
      {moreItems.length > 0 && (
        <div onClick={(event) => { event.stopPropagation(); setShowMore(true); }} title="More"
             style={{
               position: "absolute", top: 16, right: 16, zIndex: 1,
               width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
               background: "#ffffff1a", display: "flex", alignItems: "center", justifyContent: "center",
             }}>
          {I.moreVertical("#fff", 18)}
        </div>
      )}

      {(story.kind === "photo" || story.kind === "video") && (
        <div onClick={(event) => event.stopPropagation()}>
          <StoryMedia story={story}/>
        </div>
      )}
      {story.kind === "audio" && (
        <div onClick={(event) => event.stopPropagation()} style={{
          width: "100%", maxWidth: 340, textAlign: "center", color: "#fff",
        }}>
          {I.musicNote("#fff", 48)}
          <StoryMedia story={story}/>
        </div>
      )}
      {story.kind === "link" && (
        <div style={{ textAlign: "center", color: "#fff" }}>
          {I.link("#fff", 48)}
          <a href={story.link_url} target="_blank" rel="noopener noreferrer"
             onClick={(event) => event.stopPropagation()}
             style={{ display: "block", color: "#fff", fontSize: 15, marginTop: 14, wordBreak: "break-all" }}>
            {story.link_url}
          </a>
        </div>
      )}
      {story.kind !== "link" && !isMedia && (
        <div style={{ fontSize: 56, marginBottom: 18 }}>{story.emoji}</div>
      )}

      {story.text && (
        <div style={{
          fontSize: story.kind === "text" ? fontPxFor(story.font_size) + 3 : 15,
          fontFamily: story.kind === "text" ? fontStackFor(story.font) : undefined,
          fontWeight: story.kind === "text" ? 600 : 500,
          lineHeight: 1.4, color: "#fff", textAlign: "center", marginTop: isMedia ? 14 : 0,
          maxWidth: 340,
        }}>{story.text}</div>
      )}
      <div style={{ fontSize: 12.5, opacity: 0.75, marginTop: 20, color: "#fff" }}>
        {whenLabel(story.created_at)} · tap anywhere to close
      </div>

      {isAuthor ? (
        <div onClick={(event) => { event.stopPropagation(); setActivityOpen(true); }} style={{
          marginTop: 16, display: "flex", alignItems: "center", gap: 6,
          color: "#fff", fontSize: 13, cursor: "pointer", background: "#ffffff1a",
          padding: "8px 16px", borderRadius: 20,
        }}>
          {I.eye("#fff", 15)}
          {activity ? `${activity.viewers.length} view${activity.viewers.length === 1 ? "" : "s"}` : "Views"}
          {activity && activity.reactions.length > 0 &&
            ` · ${activity.reactions.length} reacted`}
        </div>
      ) : (
        <div onClick={(event) => event.stopPropagation()} style={{
          marginTop: 18, display: "flex", gap: 12, background: "#ffffff1a",
          padding: "9px 16px", borderRadius: 30,
        }}>
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} onClick={() => react(emoji)} style={{
              fontSize: 22, background: "none", border: "none", cursor: "pointer", padding: 0,
              lineHeight: 1, opacity: myReaction && myReaction !== emoji ? 0.4 : 1,
              transform: myReaction === emoji ? "scale(1.3)" : "scale(1)",
              transition: "transform 0.15s, opacity 0.15s",
            }}>{emoji}</button>
          ))}
        </div>
      )}

      {activityOpen && (
        <StoryActivitySheet activity={activity}
                             onClose={() => setActivityOpen(false)}/>
      )}

      {showMore && <MoreMenu items={moreItems} onClose={() => setShowMore(false)}/>}

      {forwarding && (
        <StoryForwardSheet story={story} onClose={() => setForwarding(false)}
                           onDone={() => { setForwarding(false); toast?.("Sent"); }} toast={toast}/>
      )}
    </div>
  );
}

/** Send a status update into one or more chats as an ordinary message —
 * same chat-picker shape ChatView's own ForwardSheet uses for a message. */
function StoryForwardSheet({ story, onClose, onDone, toast }) {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    Chats.list().then(setChats).catch(() => {}).finally(() => setLoading(false));
  }, []);

  function toggle(chatId) {
    setSelected((current) =>
      current.includes(chatId) ? current.filter((id) => id !== chatId) : [...current, chatId]);
  }

  async function send() {
    if (!selected.length) return;
    setSending(true);
    try {
      await Stories.forward(story.id, selected);
      onDone();
    } catch (problem) {
      toast?.(problem.message || "Could not forward");
    } finally {
      setSending(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 80,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, maxHeight: "70vh", background: G.surface,
        padding: 20, borderTopLeftRadius: 22, borderTopRightRadius: 22,
        display: "flex", flexDirection: "column",
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>Forward to…</div>
        {loading ? <Spinner small/> : (
          <div style={{ overflowY: "auto", marginBottom: 14 }}>
            {chats.map((target) => (
              <label key={target.id} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 4px",
                cursor: "pointer", borderBottom: `1px solid ${G.border}`,
              }}>
                <input type="checkbox" checked={selected.includes(target.id)}
                       onChange={() => toggle(target.id)}/>
                <Av av={target.avatar_letter} color={target.color} size={32} photoId={target.avatar_attachment_id}/>
                <div style={{ fontSize: 14 }}>{target.name || "Direct message"}</div>
              </label>
            ))}
          </div>
        )}
        <Button onClick={send} disabled={!selected.length || sending} style={{ width: "100%" }}>
          {sending ? "Forwarding…" : `Forward${selected.length ? ` (${selected.length})` : ""}`}
        </Button>
      </div>
    </div>
  );
}

/** Author-only: everyone who's seen a status, newest first, with their
 * reaction emoji alongside their name if they left one. */
function StoryActivitySheet({ activity, onClose }) {
  const reactionByUser = new Map((activity?.reactions || []).map((r) => [r.user_id, r.emoji]));
  const viewers = activity?.viewers || [];

  return (
    <div onClick={(event) => { event.stopPropagation(); onClose(); }} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 80,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, maxHeight: "60vh", overflowY: "auto",
        background: G.surface, padding: 20, borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 14 }}>
          {viewers.length} view{viewers.length === 1 ? "" : "s"}
        </div>
        {viewers.length === 0 && (
          <div style={{ fontSize: 13, color: G.muted, textAlign: "center", padding: "20px 0" }}>
            Nobody has seen this yet.
          </div>
        )}
        {viewers.map((viewer) => (
          <div key={viewer.user_id} style={{
            display: "flex", alignItems: "center", gap: 12, padding: "8px 4px",
          }}>
            <Av av={viewer.avatar_letter} color={viewer.color} photoId={viewer.avatar_attachment_id} size={38}/>
            <div style={{ flex: 1, fontSize: 14 }}>{viewer.name}</div>
            {reactionByUser.has(viewer.user_id) && (
              <div style={{ fontSize: 20 }}>{reactionByUser.get(viewer.user_id)}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The actual photo/video/audio bytes for a status, fetched as a blob for the
 * same reason ChatView's Attachment does it: downloading needs the bearer
 * token, which a plain <img src> cannot carry.
 */
function StoryMedia({ story }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!story.attachment_id) return;
    let cancelled = false;
    let objectUrl = null;

    Uploads.fetchBlobUrl(story.attachment_id)
      .then((url) => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        objectUrl = url;
        setBlobUrl(url);
      })
      .catch(() => !cancelled && setError(true));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [story.attachment_id]);

  if (error) return <div style={{ color: "#fff", fontSize: 14 }}>Could not load file</div>;
  if (!blobUrl) return <Spinner/>;

  if (story.kind === "photo") {
    return <img src={blobUrl} alt={story.text || "Status photo"} style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 10 }}/>;
  }
  if (story.kind === "video") {
    return <video src={blobUrl} controls autoPlay style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 10 }}/>;
  }
  return <audio src={blobUrl} controls autoPlay style={{ width: "100%", marginTop: 14 }}/>;
}
