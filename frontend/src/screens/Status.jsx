import { useEffect, useRef, useState } from "react";
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
  "linear-gradient(135deg,#1e293b,#334155)",
  "linear-gradient(135deg,#f97316,#ea580c)",
  "linear-gradient(135deg,#06b6d4,#0891b2)",
];

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

// One line describing a non-text status, used everywhere a row only has
// room for a preview line rather than the actual media (queued/mine/feed).
function kindPreviewLabel(story) {
  if (story.kind === "photo") return "📷 Photo" + (story.text ? ` · ${story.text}` : "");
  if (story.kind === "video") return "🎥 Video" + (story.text ? ` · ${story.text}` : "");
  if (story.kind === "audio") return "🎵 Audio" + (story.text ? ` · ${story.text}` : "");
  if (story.kind === "link") return story.text || story.link_url;
  return story.text;
}

// The small circle next to a queued/mine row.
function kindGlyph(story, color) {
  if (story.kind === "photo") return I.image(color, 18);
  if (story.kind === "video") return I.video(color, 18);
  if (story.kind === "audio") return I.musicNote(color, 18);
  if (story.kind === "link") return I.link(color, 18);
  return story.emoji;
}

const ACCEPT_BY_KIND = {
  photo: "image/*",
  video: "video/*",
  audio: "audio/*",
};

// CSS keyframes injected once — shared by animated reactions and the like heart.
let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    @keyframes txReactionPop {
      0% { transform: scale(0.3); opacity: 0; }
      50% { transform: scale(1.25); opacity: 1; }
      70% { transform: scale(0.95); }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes txHeartBeat {
      0% { transform: scale(1); }
      15% { transform: scale(1.35); }
      30% { transform: scale(1); }
      45% { transform: scale(1.25); }
      60% { transform: scale(1); }
    }
    @keyframes txHeartBurst {
      0% { transform: scale(0); opacity: 1; }
      100% { transform: scale(2.5); opacity: 0; }
    }
    @keyframes txSlideUp {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    @keyframes txProgressBar {
      from { width: 0%; }
      to { width: 100%; }
    }
    @keyframes txFadeIn {
      from { opacity: 0; transform: scale(0.96); }
      to { opacity: 1; transform: scale(1); }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Status screen — WhatsApp-style unified flow.
 *
 * The "+" FAB opens a single unified composer that starts in camera/gallery
 * mode and lets you switch to text or other types inline, rather than forcing
 * a choice between 5 separate module tabs upfront.
 */
export default function Status({ me, toast }) {
  const [feed, setFeed] = useState([]);
  const [mine, setMine] = useState([]);
  const [muted, setMuted] = useState([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [viewingAuthor, setViewingAuthor] = useState(null); // for cycling through an author's stories
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [muteMenuFor, setMuteMenuFor] = useState(null);

  useEffect(() => { injectStyles(); }, []);

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

  async function open(story, author) {
    setViewing(story);
    setViewingAuthor(author || null);
    try { await Stories.view(story.id); } catch { /* viewing is best-effort */ }
  }

  const scheduled = mine.filter((story) => story.status === "scheduled");
  const live = mine.filter((story) => story.status === "live");

  if (loading) return <Spinner/>;

  return (
    <div style={{ flex: 1, overflowY: "auto", paddingBottom: 80 }}>
      {/* My status ring — WhatsApp-style circular avatar with ring */}
      <div style={{ padding: "18px 16px 8px", display: "flex", alignItems: "center", gap: 14 }}>
        <div onClick={() => live.length > 0 ? open(live[0]) : setComposing(true)} style={{
          position: "relative", cursor: "pointer",
        }}>
          <div style={{
            width: 58, height: 58, borderRadius: "50%",
            background: live.length > 0
              ? `conic-gradient(${live.map((_, i) => {
                  const frac = 1 / live.length;
                  const start = i * frac * 360;
                  const end = (i + 1) * frac * 360 - 4;
                  return `${G.accent} ${start}deg, ${G.accent} ${end}deg, transparent ${end}deg`;
                }).join(", ")})`
              : `${G.border}`,
            padding: 3, display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <div style={{ width: 50, height: 50, borderRadius: "50%", overflow: "hidden" }}>
              <Av av={me.avatar_letter} color={me.color} size={50} photoId={me.avatar_attachment_id}/>
            </div>
          </div>
          {live.length === 0 && (
            <div style={{
              position: "absolute", bottom: -2, right: -2, width: 22, height: 22, borderRadius: "50%",
              background: G.accent, border: `2px solid ${G.surface}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, color: "#fff", fontWeight: 700,
            }}>+</div>
          )}
        </div>
        <div style={{ flex: 1 }} onClick={() => live.length > 0 ? open(live[0]) : setComposing(true)}>
          <div style={{ fontSize: 15, fontWeight: 600, cursor: "pointer" }}>My status</div>
          <div style={{ fontSize: 12.5, color: G.muted, marginTop: 2 }}>
            {live.length > 0
              ? `${live.length} update${live.length === 1 ? "" : "s"} · ${whenLabel(live[0].created_at)}`
              : "Tap to add status update"}
          </div>
        </div>
        <div onClick={() => setPrivacyOpen(true)} title="Status privacy" style={{
          width: 38, height: 38, borderRadius: "50%", background: G.dim,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", flexShrink: 0,
        }}>
          {I.lock(G.sub, 16)}
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
                width: 48, height: 48, borderRadius: "50%", background: story.background,
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
              }} style={{ cursor: "pointer", padding: 8 }}>{I.trash()}</div>
            </div>
          ))}
        </>
      )}

      {/* Recent updates — WhatsApp-style with story rings */}
      <SectionLabel>Recent updates</SectionLabel>
      {feed.filter((author) => author.user_id !== me.id).length === 0 && (
        <div style={{ padding: 30, textAlign: "center", color: G.muted, fontSize: 13.5 }}>
          Nothing from your contacts yet.
        </div>
      )}
      {feed.filter((author) => author.user_id !== me.id).map((author) => {
        const hasUnseen = author.stories.some((story) => !story.seen);
        return (
          <div key={author.user_id} onClick={() => open(author.stories[0], author)}
            style={{
              display: "flex", alignItems: "center", gap: 14, padding: "10px 16px",
              cursor: "pointer",
            }}>
            <div style={{
              width: 52, height: 52, borderRadius: "50%",
              padding: 2.5,
              background: hasUnseen
                ? `conic-gradient(${author.stories.map((_, i) => {
                    const frac = 1 / author.stories.length;
                    const start = i * frac * 360;
                    const end = (i + 1) * frac * 360 - 4;
                    const color = hasUnseen ? G.accent : G.muted;
                    return `${color} ${start}deg, ${color} ${end}deg, transparent ${end}deg`;
                  }).join(", ")})`
                : G.border,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{ width: 45, height: 45, borderRadius: "50%", overflow: "hidden" }}>
                <Av av={author.avatar_letter} color={author.color} size={45}
                    photoId={author.avatar_attachment_id}/>
              </div>
            </div>
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
        );
      })}

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

      {/* FAB — WhatsApp-style floating compose buttons */}
      <div style={{
        position: "fixed", bottom: 80, right: 20, display: "flex", flexDirection: "column", gap: 12,
        zIndex: 30, maxWidth: 430,
      }}>
        <div onClick={() => setComposing("text")} style={{
          width: 44, height: 44, borderRadius: "50%", background: G.card,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", boxShadow: "0 2px 12px #00000033",
          border: `1px solid ${G.border}`,
        }}>
          <span style={{ fontSize: 18, fontWeight: 700, color: G.sub }}>Aa</span>
        </div>
        <div onClick={() => setComposing("photo")} style={{
          width: 56, height: 56, borderRadius: "50%", background: G.accent,
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", boxShadow: `0 4px 16px ${G.accentGlow}`,
        }}>
          {I.image("#fff", 24)}
        </div>
      </div>

      {composing && (
        <Compose initialKind={composing === "text" ? "text" : "photo"}
                 onClose={() => setComposing(false)}
                 onDone={() => { setComposing(false); reload(); }}
                 toast={toast}/>
      )}

      {viewing && (
        <StoryViewer story={viewing} author={viewingAuthor} me={me} toast={toast}
                     allAuthors={feed}
                     onClose={() => { setViewing(null); setViewingAuthor(null); reload(); }}
                     onStoryChange={(story, author) => { setViewing(story); setViewingAuthor(author); }}/>
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

/**
 * Unified WhatsApp-style status composer.
 *
 * Opens in photo/camera mode by default (like WhatsApp's camera-first flow),
 * with a compact mode switcher at the top. Text mode shows the gradient
 * preview inline. No more 5 separate tabs — everything is one fluid screen.
 */
function Compose({ initialKind, onClose, onDone, toast }) {
  const [kind, setKind] = useState(initialKind || "photo");
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState("⚡");
  const [background, setBackground] = useState(BACKGROUNDS[0]);
  const [font, setFont] = useState("system");
  const [fontSize, setFontSize] = useState("medium");
  const [linkUrl, setLinkUrl] = useState("");
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [allowShare, setAllowShare] = useState(false);
  const [upload, setUpload] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [rawPhotoFile, setRawPhotoFile] = useState(null);
  const [editingPhoto, setEditingPhoto] = useState(false);
  const fileInputRef = useRef(null);

  function switchKind(next) {
    setKind(next);
    if (next !== "photo" && next !== "video" && next !== "audio") {
      setUpload(null);
      setRawPhotoFile(null);
    }
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

    // Auto-detect kind from file type
    if (file.type.startsWith("image/")) setKind("photo");
    else if (file.type.startsWith("video/")) setKind("video");
    else if (file.type.startsWith("audio/")) setKind("audio");

    if (file.type.startsWith("image/")) setRawPhotoFile(file);
    const previewUrl = file.type.startsWith("image/") || file.type.startsWith("video/")
      ? URL.createObjectURL(file) : null;
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

  const isMedia = kind === "photo" || kind === "video" || kind === "audio";

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000", zIndex: 60,
      display: "flex", flexDirection: "column",
      animation: "txSlideUp 0.25s ease-out",
    }}>
      {/* Top bar */}
      <div style={{
        display: "flex", alignItems: "center", padding: "12px 16px", gap: 12, flexShrink: 0,
      }}>
        <div onClick={onClose} style={{
          color: "#fff", fontSize: 14, cursor: "pointer", padding: "6px 0",
        }}>✕</div>
        <div style={{ flex: 1 }}/>

        {/* Compact mode switcher — pill-shaped, not separate boxes */}
        <div style={{
          display: "flex", background: "#ffffff14", borderRadius: 20, padding: 3, gap: 2,
        }}>
          {[
            { k: "text", label: "Aa" },
            { k: "photo", label: "📷" },
            { k: "video", label: "🎥" },
            { k: "audio", label: "🎵" },
            { k: "link", label: "🔗" },
          ].map(({ k, label }) => (
            <div key={k} onClick={() => switchKind(k)} style={{
              padding: "6px 12px", borderRadius: 18, cursor: "pointer", fontSize: 13,
              background: kind === k ? "#ffffff2a" : "transparent",
              color: kind === k ? "#fff" : "#ffffff88",
              fontWeight: kind === k ? 700 : 400,
              transition: "all 0.15s",
            }}>{label}</div>
          ))}
        </div>
      </div>

      {/* Main area — context-dependent */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto" }}>
        {kind === "text" ? (
          /* Text status — full-screen gradient preview like WhatsApp */
          <div style={{
            flex: 1, display: "flex", flexDirection: "column",
          }}>
            <div style={{
              flex: 1, background, display: "flex", alignItems: "center", justifyContent: "center",
              padding: 30, minHeight: 200,
            }}>
              <div style={{
                fontSize: fontPxFor(fontSize) + 4, color: "#fff", fontWeight: 600,
                textAlign: "center", fontFamily: fontStackFor(font),
                maxWidth: 300, wordBreak: "break-word", lineHeight: 1.4,
              }}>
                {text || "Type a status…"}
              </div>
            </div>

            {/* Text input overlaid at bottom */}
            <div style={{ padding: "12px 16px", background: "#111" }}>
              <input value={text} onChange={(e) => setText(e.target.value)}
                     placeholder="Type a status…" autoFocus
                     style={{
                       width: "100%", background: "#ffffff14", border: "none", borderRadius: 24,
                       padding: "12px 18px", color: "#fff", fontSize: 15, outline: "none",
                     }}/>
            </div>

            {/* Font picker — horizontal scroll */}
            <div style={{ display: "flex", gap: 8, padding: "8px 16px", overflowX: "auto" }}>
              {FONTS.map(({ key, label, stack }) => (
                <div key={key} onClick={() => setFont(key)} style={{
                  padding: "6px 14px", borderRadius: 20, cursor: "pointer",
                  fontFamily: stack, fontSize: 12.5, flexShrink: 0, whiteSpace: "nowrap",
                  background: font === key ? "#ffffff2a" : "#ffffff0d",
                  color: font === key ? "#fff" : "#ffffff88",
                  border: `1px solid ${font === key ? "#ffffff44" : "transparent"}`,
                }}>{label}</div>
              ))}
              <div style={{ width: 1, alignSelf: "stretch", background: "#ffffff1a", margin: "0 4px", flexShrink: 0 }}/>
              {FONT_SIZES.map(({ key, label }) => (
                <div key={key} onClick={() => setFontSize(key)} style={{
                  width: 32, height: 32, borderRadius: "50%", cursor: "pointer",
                  fontSize: 13, fontWeight: 700, flexShrink: 0,
                  background: fontSize === key ? "#ffffff2a" : "#ffffff0d",
                  color: fontSize === key ? "#fff" : "#ffffff88",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{label}</div>
              ))}
            </div>

            {/* Background swatches — circular */}
            <div style={{ display: "flex", gap: 10, padding: "8px 16px", overflowX: "auto" }}>
              {BACKGROUNDS.map((option) => (
                <div key={option} onClick={() => setBackground(option)} style={{
                  width: 32, height: 32, borderRadius: "50%", background: option,
                  cursor: "pointer", flexShrink: 0,
                  border: background === option ? "2.5px solid #fff" : "2px solid transparent",
                  boxShadow: background === option ? "0 0 0 1px #ffffff44" : "none",
                }}/>
              ))}
            </div>
          </div>
        ) : isMedia ? (
          /* Photo/Video/Audio — large preview area */
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 20 }}>
            {upload ? (
              <div style={{
                position: "relative", borderRadius: 16, overflow: "hidden", maxWidth: "100%",
                animation: "txFadeIn 0.2s ease-out",
              }}>
                {kind === "photo" && (
                  <img src={upload.previewUrl} alt="Selected photo"
                       style={{ width: "100%", maxHeight: "55vh", objectFit: "contain", display: "block" }}/>
                )}
                {kind === "video" && (
                  <video src={upload.previewUrl} controls
                         style={{ width: "100%", maxHeight: "55vh", display: "block", borderRadius: 16 }}/>
                )}
                {kind === "audio" && (
                  <div style={{
                    display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: 40,
                    background: "#ffffff0d", borderRadius: 16,
                  }}>
                    <div style={{
                      width: 80, height: 80, borderRadius: "50%", background: `${G.accent}22`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>{I.musicNote(G.accent, 36)}</div>
                    <span style={{ fontSize: 14, color: "#fff" }}>{upload.fileName}</span>
                    <audio src={upload.previewUrl || undefined} controls style={{ width: "100%" }}/>
                  </div>
                )}
                {kind === "photo" && rawPhotoFile && (
                  <div style={{
                    position: "absolute", bottom: 12, right: 12,
                    display: "flex", gap: 8,
                  }}>
                    <button onClick={() => setEditingPhoto(true)} style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 16px", borderRadius: 24, border: "none", cursor: "pointer",
                      background: "#000000cc", color: "#fff", fontSize: 13, fontWeight: 600,
                      backdropFilter: "blur(10px)",
                    }}>{I.edit("#fff", 14)} Edit</button>
                  </div>
                )}
                <button onClick={() => { setUpload(null); setRawPhotoFile(null); }} style={{
                  position: "absolute", top: 10, right: 10,
                  width: 28, height: 28, borderRadius: "50%", border: "none", cursor: "pointer",
                  background: "#000000aa", color: "#fff", fontSize: 16,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>✕</button>
              </div>
            ) : (
              <label style={{
                width: "100%", maxWidth: 320, aspectRatio: "3/4", borderRadius: 20,
                background: "#ffffff08", display: "flex",
                flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14,
                border: `2px dashed ${G.border}`, cursor: "pointer",
              }}>
                {uploading ? <Spinner/> : (
                  <>
                    <div style={{
                      width: 64, height: 64, borderRadius: "50%", background: `${G.accent}22`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      {kind === "photo" && I.image(G.accent, 28)}
                      {kind === "video" && I.video(G.accent, 28)}
                      {kind === "audio" && I.musicNote(G.accent, 28)}
                    </div>
                    <span style={{ fontSize: 14, color: "#ffffffaa" }}>
                      Tap to choose {kind === "audio" ? "an audio" : `a ${kind}`}
                    </span>
                  </>
                )}
                <input ref={fileInputRef} type="file"
                       accept={kind === "photo" ? "image/*" : kind === "video" ? "video/*" : "audio/*"}
                       hidden disabled={uploading} onChange={onFilePicked}/>
              </label>
            )}
          </div>
        ) : (
          /* Link — clean input */
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 30 }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%", background: `${G.accent}22`,
              display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20,
            }}>{I.link(G.accent, 28)}</div>
            <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)}
                   placeholder="Paste a link…" autoFocus
                   style={{
                     width: "100%", maxWidth: 320, background: "#ffffff14", border: "none",
                     borderRadius: 24, padding: "12px 18px", color: "#fff", fontSize: 15, outline: "none",
                     textAlign: "center",
                   }}/>
          </div>
        )}

        {/* Caption input — shared across all types except text */}
        {kind !== "text" && (
          <div style={{ padding: "0 16px 8px" }}>
            <input value={text} onChange={(e) => setText(e.target.value)}
                   placeholder="Add a caption…"
                   style={{
                     width: "100%", background: "#ffffff14", border: "none", borderRadius: 24,
                     padding: "10px 18px", color: "#fff", fontSize: 14, outline: "none",
                   }}/>
          </div>
        )}
      </div>

      {/* Bottom bar — options + send */}
      <div style={{
        padding: "12px 16px", background: "#111", display: "flex", alignItems: "center", gap: 12,
        borderTop: "1px solid #ffffff1a", flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, overflowX: "auto" }}>
          <label style={{
            display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
            fontSize: 12.5, color: "#ffffffaa", whiteSpace: "nowrap",
          }}>
            <input type="checkbox" checked={allowShare}
                   onChange={(e) => setAllowShare(e.target.checked)}
                   style={{ accentColor: G.accent }}/>
            Allow sharing
          </label>
          <label style={{
            display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
            fontSize: 12.5, color: "#ffffffaa", whiteSpace: "nowrap",
          }}>
            <input type="checkbox" checked={later}
                   onChange={(e) => setLater(e.target.checked)}
                   style={{ accentColor: G.accent }}/>
            Schedule
          </label>
          {later && (
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)}
                   style={{
                     background: "#ffffff14", border: "1px solid #ffffff22", borderRadius: 12,
                     padding: "6px 10px", color: "#fff", fontSize: 12,
                   }}/>
          )}
        </div>
        <button onClick={save} disabled={busy || uploading} style={{
          width: 48, height: 48, borderRadius: "50%", border: "none", cursor: "pointer",
          background: G.accent, display: "flex", alignItems: "center", justifyContent: "center",
          opacity: busy || uploading ? 0.5 : 1,
          boxShadow: `0 2px 12px ${G.accentGlow}`,
        }}>
          {busy ? <Spinner small/> : I.send("#fff", 20)}
        </button>
      </div>
    </div>
  );
}

const QUICK_REACTIONS = ["❤️", "😂", "😮", "😢", "👏", "🔥"];

/**
 * Full-screen story viewer with WhatsApp-style features:
 * - Progress bars at the top for multi-story authors
 * - Swipe/tap to cycle through stories
 * - ❤️ like button (sends heart reaction, animated)
 * - Animated reaction tray
 * - Author info header
 */
function StoryViewer({ story, author, me, toast, allAuthors, onClose, onStoryChange }) {
  const isMedia = story.kind === "photo" || story.kind === "video" || story.kind === "audio";
  const isAuthor = story.user_id === me.id;
  const [myReaction, setMyReaction] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [showReactionTray, setShowReactionTray] = useState(false);
  const [heartAnimating, setHeartAnimating] = useState(false);
  const [activity, setActivity] = useState(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);

  // Auto-progress for stories
  const stories = author?.stories || [story];
  const currentIndex = stories.findIndex((s) => s.id === story.id);
  const progressTimerRef = useRef(null);
  const STORY_DURATION = 6000; // 6s per story

  useEffect(() => {
    if (isMedia) return; // don't auto-advance media
    progressTimerRef.current = setTimeout(() => {
      if (currentIndex < stories.length - 1) {
        onStoryChange(stories[currentIndex + 1], author);
      }
    }, STORY_DURATION);
    return () => clearTimeout(progressTimerRef.current);
  }, [story.id, isMedia]);

  useEffect(() => {
    if (!isAuthor) return;
    Promise.all([Stories.viewers(story.id), Stories.reactions(story.id)])
      .then(([viewers, reactions]) => setActivity({ viewers, reactions }))
      .catch(() => {});
  }, [story.id, isAuthor]);

  async function react(emoji) {
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

  async function likeStory() {
    setHeartAnimating(true);
    setTimeout(() => setHeartAnimating(false), 1000);
    await react("❤️");
  }

  async function sendReply() {
    const trimmed = replyText.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      await Stories.react(story.id, `💬 ${trimmed}`);
      setReplyText("");
      toast?.("Reply sent");
    } catch (problem) {
      toast?.(problem.message || "Could not send reply");
    } finally {
      setSending(false);
    }
  }

  function goNext() {
    clearTimeout(progressTimerRef.current);
    if (currentIndex < stories.length - 1) {
      onStoryChange(stories[currentIndex + 1], author);
    } else {
      // Go to next author
      const authorIndex = allAuthors.findIndex((a) => a.user_id === author?.user_id);
      if (authorIndex >= 0 && authorIndex < allAuthors.length - 1) {
        const nextAuthor = allAuthors[authorIndex + 1];
        onStoryChange(nextAuthor.stories[0], nextAuthor);
      } else {
        onClose();
      }
    }
  }

  function goPrev() {
    clearTimeout(progressTimerRef.current);
    if (currentIndex > 0) {
      onStoryChange(stories[currentIndex - 1], author);
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

  const canReshare = isAuthor || Boolean(story.allow_share);
  const moreItems = [
    ...(canReshare ? [{ label: "Forward", icon: I.fwd("#fff", 18), onClick: () => setForwarding(true) }] : []),
    ...(canReshare ? [{ label: "Share", icon: I.send("#fff", 18), onClick: shareStory }] : []),
    ...(copyableText ? [{ label: "Copy", icon: I.link("#fff", 18), onClick: copyStory }] : []),
    ...(isAuthor ? [{ label: "Delete", icon: I.trash("#ff8080", 18), onClick: deleteThisStory }] : []),
  ];

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000", zIndex: 70,
      display: "flex", flexDirection: "column",
    }}>
      {/* Progress bars — WhatsApp-style segmented bar */}
      {stories.length > 1 && (
        <div style={{
          display: "flex", gap: 3, padding: "8px 12px 0", position: "absolute", top: 0, left: 0, right: 0, zIndex: 2,
        }}>
          {stories.map((s, i) => (
            <div key={s.id} style={{
              flex: 1, height: 2.5, borderRadius: 2, background: "#ffffff33", overflow: "hidden",
            }}>
              <div style={{
                height: "100%", borderRadius: 2,
                background: "#fff",
                width: i < currentIndex ? "100%"
                     : i === currentIndex ? "100%"
                     : "0%",
                animation: i === currentIndex && !isMedia ? `txProgressBar ${STORY_DURATION}ms linear` : "none",
              }}/>
            </div>
          ))}
        </div>
      )}

      {/* Author header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, padding: "20px 12px 8px",
        position: "absolute", top: stories.length > 1 ? 10 : 0, left: 0, right: 0, zIndex: 2,
      }}>
        <Av av={author?.avatar_letter || me.avatar_letter}
            color={author?.color || me.color} size={36}
            photoId={author?.avatar_attachment_id || me.avatar_attachment_id}/>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>
            {isAuthor ? "You" : (author?.name || "Someone")}
          </div>
          <div style={{ fontSize: 11.5, color: "#ffffffaa" }}>
            {whenLabel(story.created_at)}
          </div>
        </div>
        {moreItems.length > 0 && (
          <div onClick={() => setShowMore(true)} style={{
            width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
            background: "#ffffff1a", display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            {I.moreVertical("#fff", 18)}
          </div>
        )}
        <div onClick={onClose} style={{
          width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
          background: "#ffffff1a", display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18, color: "#fff",
        }}>✕</div>
      </div>

      {/* Tap zones for prev/next */}
      <div onClick={goPrev} style={{
        position: "absolute", left: 0, top: 60, bottom: 80, width: "30%", zIndex: 1,
      }}/>
      <div onClick={goNext} style={{
        position: "absolute", right: 0, top: 60, bottom: 80, width: "30%", zIndex: 1,
      }}/>

      {/* Story content */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", padding: "70px 30px 20px",
        background: isMedia ? "#000" : (story.background || G.bg),
      }}>
        {(story.kind === "photo" || story.kind === "video") && (
          <StoryMedia story={story}/>
        )}
        {story.kind === "audio" && (
          <div style={{ width: "100%", maxWidth: 340, textAlign: "center", color: "#fff" }}>
            <div style={{
              width: 80, height: 80, borderRadius: "50%", background: `${G.accent}22`,
              display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px",
            }}>{I.musicNote(G.accent, 36)}</div>
            <StoryMedia story={story}/>
          </div>
        )}
        {story.kind === "link" && (
          <div style={{ textAlign: "center", color: "#fff" }}>
            <div style={{
              width: 64, height: 64, borderRadius: "50%", background: `${G.accent}22`,
              display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px",
            }}>{I.link(G.accent, 28)}</div>
            <a href={story.link_url} target="_blank" rel="noopener noreferrer"
               style={{ display: "block", color: G.accent, fontSize: 15, wordBreak: "break-all" }}>
              {story.link_url}
            </a>
          </div>
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

        {/* Animated heart on double-tap / like */}
        {heartAnimating && (
          <div style={{
            position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
            fontSize: 80, pointerEvents: "none", zIndex: 5,
            animation: "txHeartBeat 0.8s ease-out",
          }}>❤️</div>
        )}
      </div>

      {/* Bottom interaction area */}
      {isAuthor ? (
        <div style={{
          padding: "12px 16px 28px", display: "flex", justifyContent: "center", gap: 20,
        }}>
          <div onClick={() => setActivityOpen(true)} style={{
            display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
            color: "#fff", fontSize: 13, background: "#ffffff14",
            padding: "10px 20px", borderRadius: 24,
          }}>
            {I.eye("#fff", 16)}
            {activity ? `${activity.viewers.length} view${activity.viewers.length === 1 ? "" : "s"}` : "Views"}
            {activity && activity.reactions.length > 0 &&
              ` · ${activity.reactions.length} ❤️`}
          </div>
        </div>
      ) : (
        <div style={{
          padding: "8px 16px 24px", display: "flex", alignItems: "center", gap: 10,
        }}>
          {/* Reply input */}
          <input value={replyText} onChange={(e) => setReplyText(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") sendReply(); }}
                 placeholder="Reply…"
                 style={{
                   flex: 1, background: "#ffffff14", border: "1px solid #ffffff22",
                   borderRadius: 24, padding: "10px 16px", color: "#fff", fontSize: 14,
                   outline: "none",
                 }}/>

          {/* Reaction tray toggle */}
          <div onClick={() => setShowReactionTray((v) => !v)} style={{
            cursor: "pointer", padding: 4,
          }}>
            <span style={{ fontSize: 22 }}>😊</span>
          </div>

          {/* Like button — WhatsApp-style heart */}
          <div onClick={likeStory} style={{
            cursor: "pointer", padding: 4, position: "relative",
          }}>
            <span style={{
              fontSize: 24,
              display: "inline-block",
              animation: myReaction === "❤️" ? "txHeartBeat 0.6s ease-out" : "none",
              filter: myReaction === "❤️" ? "none" : "grayscale(1) opacity(0.6)",
              transition: "filter 0.2s",
            }}>❤️</span>
            {myReaction === "❤️" && (
              <span style={{
                position: "absolute", inset: 0, fontSize: 24,
                display: "flex", alignItems: "center", justifyContent: "center",
                animation: "txHeartBurst 0.6s ease-out forwards", pointerEvents: "none",
              }}>❤️</span>
            )}
          </div>

          {replyText.trim() && (
            <button onClick={sendReply} disabled={sending} style={{
              width: 36, height: 36, borderRadius: "50%", border: "none", cursor: "pointer",
              background: G.accent, display: "flex", alignItems: "center", justifyContent: "center",
            }}>{I.send("#fff", 16)}</button>
          )}
        </div>
      )}

      {/* Animated reaction tray */}
      {showReactionTray && (
        <div onClick={() => setShowReactionTray(false)} style={{
          position: "absolute", bottom: 80, left: "50%", transform: "translateX(-50%)", zIndex: 10,
          display: "flex", gap: 4, background: "#1a1a2e", border: "1px solid #ffffff22",
          borderRadius: 30, padding: "8px 12px",
          animation: "txFadeIn 0.15s ease-out",
        }}>
          {QUICK_REACTIONS.map((emoji, i) => (
            <button key={emoji} onClick={(e) => { e.stopPropagation(); react(emoji); setShowReactionTray(false); }}
                    style={{
                      fontSize: 28, background: "none", border: "none", cursor: "pointer", padding: "4px 6px",
                      animation: `txReactionPop 0.3s ease-out ${i * 0.05}s both`,
                      display: "inline-block",
                      opacity: myReaction && myReaction !== emoji ? 0.4 : 1,
                      transition: "opacity 0.15s",
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

/** Send a status update into one or more chats as an ordinary message. */
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

/** Author-only: everyone who's seen a status. */
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
    return <img src={blobUrl} alt={story.text || "Status photo"}
                style={{ maxWidth: "100%", maxHeight: "60vh", borderRadius: 12, objectFit: "contain" }}/>;
  }
  if (story.kind === "video") {
    return <video src={blobUrl} controls autoPlay
                  style={{ maxWidth: "100%", maxHeight: "60vh", borderRadius: 12 }}/>;
  }
  return <audio src={blobUrl} controls autoPlay style={{ width: "100%", marginTop: 14 }}/>;
}
