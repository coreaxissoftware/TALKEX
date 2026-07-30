import { useEffect, useState } from "react";
import { Stories, Uploads } from "../api.js";
import {
  Av, Button, Field, G, I, Spinner, countdown, localInputToUnix, whenLabel,
} from "../ui.jsx";

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
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [viewing, setViewing] = useState(null);

  function reload() {
    setLoading(true);
    Promise.all([Stories.list(), Stories.mine()])
      .then(([theirs, ours]) => { setFeed(theirs); setMine(ours); })
      .catch(() => {})
      .finally(() => setLoading(false));
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
      <div style={{ padding: "14px 16px" }}>
        <Button onClick={() => setComposing(true)} style={{ width: "100%" }}>
          + Add to my status
        </Button>
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
        </div>
      ))}

      {composing && (
        <Compose onClose={() => setComposing(false)}
                 onDone={() => { setComposing(false); reload(); }}
                 toast={toast}/>
      )}

      {viewing && <Viewer story={viewing} onClose={() => { setViewing(null); reload(); }}/>}
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

  // Set once the file for a photo/video/audio status has actually finished
  // uploading — the same two-step "upload, then reference the id" pattern
  // ChatView's AttachSheet uses, so a failed/retried post never re-sends the
  // file itself.
  const [upload, setUpload] = useState(null); // { attachmentId, previewUrl, fileName }
  const [uploading, setUploading] = useState(false);

  function pickKind(next) {
    setKind(next);
    setUpload(null);
  }

  async function onFilePicked(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const previewUrl = kind === "photo" || kind === "video" ? URL.createObjectURL(file) : null;
    setUploading(true);
    try {
      const attachment = await Uploads.create(file);
      setUpload({ attachmentId: attachment.attachment_id, previewUrl, fileName: file.name });
    } catch (problem) {
      toast(problem.message || "Could not upload file");
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    } finally {
      setUploading(false);
    }
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
        publishAt, font, fontSize,
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
                borderRadius: 16, overflow: "hidden", background: G.dim,
                border: `1px solid ${G.border}`,
              }}>
                {kind === "photo" && (
                  <img src={upload.previewUrl} alt="" style={{ width: "100%", maxHeight: 220, objectFit: "cover", display: "block" }}/>
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

function Viewer({ story, onClose }) {
  const isMedia = story.kind === "photo" || story.kind === "video" || story.kind === "audio";

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: isMedia ? "#000" : (story.background || G.bg),
      zIndex: 70, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", padding: 30,
    }}>
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
    return <img src={blobUrl} alt="" style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 10 }}/>;
  }
  if (story.kind === "video") {
    return <video src={blobUrl} controls autoPlay style={{ maxWidth: "100%", maxHeight: "70vh", borderRadius: 10 }}/>;
  }
  return <audio src={blobUrl} controls autoPlay style={{ width: "100%", marginTop: 14 }}/>;
}
