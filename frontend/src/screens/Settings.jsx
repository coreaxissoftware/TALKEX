import { useEffect, useRef, useState } from "react";
import {
  Auth, Contacts, Me, Messages, Templates, Users, clearToken, forgetAccount, getToken,
  listSavedAccounts, rememberAccount, switchToAccount,
} from "../api.js";
import { ACCENTS, Av, Button, Field, G, I, SRow, SOCIAL_PLATFORMS, SocialLinks, Spinner, Toggle,
         clockTime, whenLabel, getStoredEnterToSend, saveEnterToSend, useInstallPrompt } from "../ui.jsx";
import QrView from "../QrView.jsx";
import { disablePush, enablePush, getPushSubscription, isPushSupported } from "../push.js";
import { getAutoDownload, setAutoDownload } from "../mediaPrefs.js";
import {
  TEXTURES, getWallpaper, getWallpaperBlur, readImageAsWallpaper, setWallpaper, setWallpaperBlur,
} from "../chatWallpaper.js";
import { disableAppLock, isAppLockEnabled, setAppLockPin } from "../appLock.js";
import QrScanner from "../QrScanner.jsx";
import Login from "./Login.jsx";
import { COUNTRY_CODES, flagFor, samplePlaceholder, splitPhone } from "../countryCodes.js";

/**
 * Profile and privacy.
 *
 * The two privacy switches are real, not decorative: with last-seen off the
 * server stops announcing your presence and blanks the field for other people,
 * and with read receipts off it stops broadcasting your read marker. v1 had
 * these toggles wired to nothing.
 */
export default function Settings({ me, onUpdated, onSignedOut, toast,
                                    theme, onThemeChange, accent, onAccentChange }) {
  const [editing, setEditing] = useState(false);
  const [helpView, setHelpView] = useState(null); // 'blog' | 'feedback' | null
  const { canInstall, promptInstall } = useInstallPrompt();
  const [enterToSend, setEnterToSend] = useState(getStoredEnterToSend);
  const [form, setForm] = useState({
    name: me.name, bio: me.bio || "",
    link_website: me.link_website || "", link_facebook: me.link_facebook || "",
    link_instagram: me.link_instagram || "", link_twitter: me.link_twitter || "",
    link_youtube: me.link_youtube || "", link_linkedin: me.link_linkedin || "",
  });
  const [blocked, setBlocked] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [linkingDevice, setLinkingDevice] = useState(false);
  const [apiKeys, setApiKeys] = useState([]);
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKey, setNewKey] = useState(null);   // shown once, right after creation
  const [webhooks, setWebhooks] = useState([]);
  const [creatingWebhook, setCreatingWebhook] = useState(false);
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [cannedReplies, setCannedReplies] = useState([]);
  const [creatingReply, setCreatingReply] = useState(false);
  const [newReplyLabel, setNewReplyLabel] = useState("");
  const [newReplyText, setNewReplyText] = useState("");
  const [awayMessageDraft, setAwayMessageDraft] = useState(me.away_message || "");
  const [templates, setTemplates] = useState([]);
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateContent, setNewTemplateContent] = useState("");
  const [savedAccounts, setSavedAccounts] = useState(listSavedAccounts);
  const [addingAccount, setAddingAccount] = useState(false);
  const [twoStep, setTwoStep] = useState(null); // {enabled} — null while still loading
  const [twoStepSheet, setTwoStepSheet] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [activeSection, setActiveSection] = useState(null);
  const [autoDownload, setAutoDownloadState] = useState(getAutoDownload);
  const [wallpaper, setWallpaperState] = useState(getWallpaper);
  const [blur, setBlurState] = useState(getWallpaperBlur);
  const [appLockOn, setAppLockOn] = useState(isAppLockEnabled);
  const [appLockSheet, setAppLockSheet] = useState(false);
  const [changingPhone, setChangingPhone] = useState(false);
  const [settingPassword, setSettingPassword] = useState(false);
  const [editingUsername, setEditingUsername] = useState(false);
  const [connectingEmail, setConnectingEmail] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const avatarInputRef = useRef(null);
  const wallpaperInputRef = useRef(null);

  function changeAutoDownload(value) {
    setAutoDownload(value);
    setAutoDownloadState(value);
  }

  function changeWallpaperBlur(px) {
    setWallpaperBlur(px);
    setBlurState(px);
  }

  function changeWallpaper(value) {
    setWallpaper(value);
    setWallpaperState(value);
  }

  async function onWallpaperFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setWallpaperBusy(true);
    try {
      const dataUrl = await readImageAsWallpaper(file);
      changeWallpaper({ type: "custom", dataUrl });
    } catch {
      toast("Could not use that photo");
    } finally {
      setWallpaperBusy(false);
    }
  }

  async function onAvatarFileChosen(event) {
    const file = event.target.files?.[0];
    event.target.value = ""; // lets picking the same file twice fire change again
    if (!file) return;
    setAvatarBusy(true);
    try {
      onUpdated(await Me.setAvatar(file));
      toast("Profile photo updated");
    } catch (error) {
      toast(error.message || "Could not upload photo");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatarPhoto() {
    setAvatarBusy(true);
    try {
      onUpdated(await Me.removeAvatar());
      toast("Profile photo removed");
    } catch (error) {
      toast(error.message || "Could not remove photo");
    } finally {
      setAvatarBusy(false);
    }
  }

  useEffect(() => {
    Users.blocked().then(setBlocked).catch(() => {});
  }, []);

  useEffect(() => {
    getPushSubscription().then((sub) => setPushEnabled(Boolean(sub))).catch(() => {});
  }, []);

  async function togglePush(next) {
    setPushBusy(true);
    try {
      if (next) {
        await enablePush();
      } else {
        await disablePush();
      }
      setPushEnabled(next);
    } catch (problem) {
      toast(problem.message || "Could not update notifications");
    } finally {
      setPushBusy(false);
    }
  }

  const reloadTwoStep = () => Me.twoStep().then(setTwoStep).catch(() => {});
  useEffect(() => { reloadTwoStep(); }, []);

  const reloadSessions = () => Me.sessions().then(setSessions).catch(() => {});
  // Not `useEffect(reloadSessions, [])` — reloadSessions() returns a Promise
  // (from the .then/.catch chain), and useEffect treats whatever its callback
  // returns as a cleanup function if it isn't undefined. Handing it a Promise
  // directly crashes on unmount with "destroy is not a function". Wrapping it
  // in a function whose own body returns nothing avoids that entirely.
  useEffect(() => { reloadSessions(); }, []);

  const reloadApiKeys = () => Me.apiKeys().then(setApiKeys).catch(() => {});
  useEffect(() => { reloadApiKeys(); }, []);

  const reloadWebhooks = () => Me.webhooks().then(setWebhooks).catch(() => {});
  useEffect(() => { reloadWebhooks(); }, []);

  const reloadCannedReplies = () => Me.cannedReplies().then(setCannedReplies).catch(() => {});
  useEffect(() => { reloadCannedReplies(); }, []);

  const reloadTemplates = () => Templates.list().then(setTemplates).catch(() => {});
  useEffect(() => { reloadTemplates(); }, []);

  async function createWebhook() {
    if (!newWebhookUrl.trim()) return;
    setCreatingWebhook(true);
    try {
      await Me.createWebhook(newWebhookUrl.trim());
      setNewWebhookUrl("");
      reloadWebhooks();
      toast("Webhook added");
    } catch (problem) {
      toast(problem.message || "Could not add that webhook");
    } finally {
      setCreatingWebhook(false);
    }
  }

  async function deleteWebhook(webhookId) {
    await Me.deleteWebhook(webhookId);
    setWebhooks((current) => current.filter((w) => w.id !== webhookId));
    toast("Webhook removed");
  }

  async function createCannedReply() {
    if (!newReplyLabel.trim() || !newReplyText.trim()) return;
    setCreatingReply(true);
    try {
      await Me.createCannedReply(newReplyLabel.trim(), newReplyText.trim());
      setNewReplyLabel("");
      setNewReplyText("");
      reloadCannedReplies();
    } finally {
      setCreatingReply(false);
    }
  }

  async function deleteCannedReply(replyId) {
    await Me.deleteCannedReply(replyId);
    setCannedReplies((current) => current.filter((r) => r.id !== replyId));
  }

  async function createTemplate() {
    if (!newTemplateName.trim() || !newTemplateContent.trim()) return;
    setCreatingTemplate(true);
    try {
      await Templates.create(newTemplateName.trim(), newTemplateContent.trim());
      setNewTemplateName("");
      setNewTemplateContent("");
      reloadTemplates();
      toast("Template submitted for review");
    } finally {
      setCreatingTemplate(false);
    }
  }

  async function deleteTemplate(templateId) {
    await Templates.remove(templateId);
    setTemplates((current) => current.filter((t) => t.id !== templateId));
  }

  async function toggleAway(value) {
    onUpdated(await Me.update({ away_enabled: value }));
  }

  async function saveAwayMessage() {
    onUpdated(await Me.update({ away_message: awayMessageDraft.trim() }));
    toast("Away message saved");
  }

  async function revokeSession(sessionId) {
    await Me.revokeSession(sessionId);
    setSessions((current) => current.filter((s) => s.session_id !== sessionId));
    toast("Device signed out");
  }

  async function toggleSessionShortLived(sessionId, shortLived) {
    try {
      const updated = await Me.setSessionShortLived(sessionId, shortLived);
      setSessions((current) => current.map((s) => (s.session_id === sessionId
        ? { ...s, short_lived: updated.short_lived, expires_at: updated.expires_at } : s)));
      toast(shortLived ? "Will sign out after 4 hours" : "Back to staying signed in");
    } catch (problem) {
      toast(problem.message || "Could not update this device");
    }
  }

  async function createApiKey() {
    setCreatingKey(true);
    try {
      const created = await Me.createApiKey("API key");
      setNewKey(created.key);
      reloadApiKeys();
    } finally {
      setCreatingKey(false);
    }
  }

  async function revokeApiKey(keyId) {
    await Me.revokeApiKey(keyId);
    setApiKeys((current) => current.filter((k) => k.id !== keyId));
    toast("Key revoked");
  }

  function removeSavedAccount(userId) {
    forgetAccount(userId);
    setSavedAccounts(listSavedAccounts());
  }

  async function saveProfile() {
    const updated = await Me.update({
      name: form.name.trim(), bio: form.bio.trim(),
      link_website: form.link_website.trim(), link_facebook: form.link_facebook.trim(),
      link_instagram: form.link_instagram.trim(), link_twitter: form.link_twitter.trim(),
      link_youtube: form.link_youtube.trim(), link_linkedin: form.link_linkedin.trim(),
    });
    onUpdated(updated);
    setEditing(false);
    toast("Profile saved");
  }

  async function togglePrivacy(key, value) {
    const updated = await Me.update({ [key]: value });
    onUpdated(updated);
  }

  async function signOut() {
    try { await Auth.logout(); } catch { /* the token is going away regardless */ }
    clearToken();
    onSignedOut();
  }

  async function confirmDeactivate() {
    await Me.deactivate();
    // The server already revoked this token — clearing it locally too and
    // dropping back to the sign-in screen matches what actually happened.
    clearToken();
    onSignedOut();
  }

  async function confirmDelete() {
    await Me.deleteAccount();
    clearToken();
    onSignedOut();
  }

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      {activeSection === null && (
        <>
          <div style={{
            display: "flex", alignItems: "center", gap: 14, padding: 20,
            borderBottom: `1px solid ${G.border}`,
          }}>
            <div style={{ position: "relative" }}>
              <Av av={me.avatar_letter} color={me.color} size={64} photoId={me.avatar_attachment_id}/>
              <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: "none" }}
                     onChange={onAvatarFileChosen}/>
              <div onClick={() => !avatarBusy && avatarInputRef.current?.click()} style={{
                position: "absolute", bottom: -2, right: -2, width: 24, height: 24,
                borderRadius: "50%", background: G.accent, display: "flex",
                alignItems: "center", justifyContent: "center", cursor: "pointer",
                border: `2px solid ${G.surface}`, opacity: avatarBusy ? 0.6 : 1,
              }}>{I.camera("#fff", 13)}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 19, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}>
                {me.name} {me.blue_tick && I.blueTick(16)}
              </div>
              <div onClick={() => setEditingUsername(true)}
                   style={{ fontSize: 13, color: G.sub, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
                @{me.username} {I.edit(G.muted, 12)}
              </div>
              {me.bio && <div style={{ fontSize: 12.5, color: G.muted, marginTop: 3 }}>{me.bio}</div>}
              {me.avatar_attachment_id && (
                <div onClick={() => !avatarBusy && removeAvatarPhoto()} style={{
                  fontSize: 12, color: G.red, marginTop: 4, cursor: "pointer",
                }}>Remove photo</div>
              )}
            </div>
          </div>

          {editing ? (
            <div style={{ padding: 20 }}>
              <Field label="Name" value={form.name}
                     onChange={(event) => setForm({ ...form, name: event.target.value })}/>
              <Field label="Bio" value={form.bio}
                     onChange={(event) => setForm({ ...form, bio: event.target.value })}/>

              <div style={{ marginTop: 12, marginBottom: 6, fontSize: 13, fontWeight: 700, color: G.sub }}>
                Social Links
              </div>
              {SOCIAL_PLATFORMS.map((platform) => (
                <div key={platform.key} style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                  <span style={{
                    width: 26, height: 26, borderRadius: "50%", flexShrink: 0, marginBottom: 12,
                    background: platform.brand, display: "flex", alignItems: "center", justifyContent: "center",
                  }}>{platform.glyph("#fff", 16)}</span>
                  <Field label={platform.label} value={form[platform.field]}
                         placeholder={`https://…`} style={{ flex: 1 }}
                         onChange={(event) => setForm({ ...form, [platform.field]: event.target.value })}/>
                </div>
              ))}

              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <Button onClick={saveProfile} style={{ flex: 1 }}>Save</Button>
                <Button variant="ghost" onClick={() => setEditing(false)} style={{ flex: 1 }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <SRow icon={I.edit(G.accent, 18)} label="Edit profile" sub="Name, bio and social links"
                    onClick={() => setEditing(true)}/>
              <SocialLinks profile={me} style={{ padding: "0 20px 12px" }}/>
            </>
          )}
        </>
      )}

      {canInstall && (
        <div style={{ padding: "0 16px", marginBottom: 4 }}>
          <button onClick={async () => {
            const ok = await promptInstall();
            if (ok) toast("Installing TalkEx…");
          }} style={{
            display: "flex", alignItems: "center", gap: 12, width: "100%",
            padding: "14px 16px", borderRadius: 14, cursor: "pointer",
            background: `${G.accent}12`, border: `1px solid ${G.accent}33`, color: G.text,
            fontSize: 14.5, fontWeight: 600, textAlign: "left",
          }}>
            <span style={{ display: "flex", flexShrink: 0 }}>{I.download(G.accent, 20)}</span>
            <span style={{ flex: 1 }}>
              Install TalkEx app
              <div style={{ fontSize: 12, fontWeight: 400, color: G.muted, marginTop: 2 }}>
                Add to your home screen — opens like a native app, works offline
              </div>
            </span>
          </button>
        </div>
      )}

      <Section id="myqr" icon={I.search(G.accent, 20)} title="My QR code"
               sub="Let people scan to add you"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <div style={{ padding: "12px 20px 20px", textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <QrView value={`${window.location.origin}/?user=${me.username}`} size={220}/>
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: G.text }}>{me.name}</div>
          <div style={{ fontSize: 13, color: G.muted, marginBottom: 16 }}>@{me.username}</div>
          <Button style={{ width: "100%", marginBottom: 8 }} onClick={async () => {
            const url = `${window.location.origin}/?user=${me.username}`;
            if (navigator.share) { try { await navigator.share({ title: me.name, url }); } catch { /* cancelled */ } }
            else { navigator.clipboard?.writeText(url); toast("Profile link copied"); }
          }}>Share my code</Button>
          <div style={{ fontSize: 11.5, color: G.muted }}>
            Scanning this opens a chat with you.
          </div>
        </div>
      </Section>

      <Section id="invite" icon={I.share(G.accent, 20)} title="Invite a friend"
               sub="Share TalkEx with your contacts"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <InviteFriend me={me} toast={toast}/>
      </Section>

      <Section id="appearance" icon={I.palette(G.accent, 20)} title="Appearance" sub="Theme and color"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <div style={{ padding: "4px 20px 18px" }}>
          <div style={{
            display: "flex", gap: 6, padding: 4, background: G.dim,
            borderRadius: 14, border: `1px solid ${G.border}`,
          }}>
            {[["light", "Light", I.sun], ["dark", "Dark", I.moon]].map(([mode, label, icon]) => {
              const active = theme === mode;
              return (
                <button key={mode} onClick={() => onThemeChange(mode)} style={{
                  flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                  gap: 7, padding: "9px", borderRadius: 10, border: "none", cursor: "pointer",
                  fontSize: 13.5, fontWeight: 600,
                  background: active ? G.card : "transparent",
                  color: active ? G.text : G.sub,
                  boxShadow: active ? `0 1px 4px ${G.border}` : "none",
                }}>
                  {icon(active ? G.accent : G.sub, 16)}
                  {label}
                </button>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: G.muted, margin: "16px 0 10px" }}>Theme color</div>
          <div style={{ display: "flex", gap: 5 }}>
            {Object.entries(ACCENTS).map(([key, def]) => {
              const active = accent === key;
              return (
                <div key={key} onClick={() => onAccentChange(key)} title={def.label}
                     style={{
                       width: 26, height: 26, borderRadius: "50%", cursor: "pointer",
                       background: `linear-gradient(135deg,${def.accent},${def.accentD})`,
                       border: active ? `2px solid ${G.text}` : "2px solid transparent",
                       boxShadow: active ? `0 0 0 2px ${G.surface}` : "none",
                       display: "flex", alignItems: "center", justifyContent: "center",
                     }}>
                  {active && I.check("#fff", 11)}
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: 12, color: G.muted, margin: "16px 0 10px" }}>Chat wallpaper</div>
          <input ref={wallpaperInputRef} type="file" accept="image/*" style={{ display: "none" }}
                 onChange={onWallpaperFileChosen}/>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <WallpaperSwatch label="Animated" active={wallpaper.type === "particles"}
                              onClick={() => changeWallpaper({ type: "particles" })}
                              style={{
                                background: "linear-gradient(135deg,#0b1c33,#14294a)",
                                backgroundImage:
                                  "radial-gradient(circle at 30% 30%, #7dd3fc 0 3px, transparent 4px)," +
                                  "radial-gradient(circle at 70% 60%, #f5a524 0 2.5px, transparent 3.5px)," +
                                  "radial-gradient(circle at 50% 80%, #7dd3fc 0 2px, transparent 3px)",
                              }}/>
            <WallpaperSwatch label="Bokeh" active={wallpaper.type === "canvas" && wallpaper.id === "bokeh"}
                              onClick={() => changeWallpaper({ type: "canvas", id: "bokeh" })}
                              style={{
                                background: "linear-gradient(160deg,#0b1420,#10192b)",
                                backgroundImage:
                                  "radial-gradient(circle at 35% 65%, #7dd3fc55 0 8px, transparent 10px)," +
                                  "radial-gradient(circle at 65% 30%, #f5a52444 0 6px, transparent 8px)," +
                                  "radial-gradient(circle at 25% 20%, #7dd3fc33 0 5px, transparent 7px)",
                              }}/>
            <WallpaperSwatch label="Flow Lines" active={wallpaper.type === "canvas" && wallpaper.id === "flowlines"}
                              onClick={() => changeWallpaper({ type: "canvas", id: "flowlines" })}
                              style={{
                                background: "linear-gradient(160deg,#0b1420,#10192b)",
                                backgroundImage:
                                  "repeating-linear-gradient(100deg, transparent 0 6px, #7dd3fc4d 6px 7px, transparent 7px 16px)",
                              }}/>
            <WallpaperSwatch label="Plain" active={wallpaper.type === "none"}
                              onClick={() => changeWallpaper({ type: "none" })}
                              style={{ background: G.bg }}/>
            {TEXTURES.map((texture) => (
              <WallpaperSwatch key={texture.id} label={texture.label}
                                active={wallpaper.type === "texture" && wallpaper.id === texture.id}
                                onClick={() => changeWallpaper({ type: "texture", id: texture.id })}
                                style={{
                                  background: G.bg, backgroundImage: texture.css(G),
                                  backgroundSize: texture.size,
                                }}/>
            ))}
            <WallpaperSwatch label={wallpaperBusy ? "…" : "Photo"}
                              active={wallpaper.type === "custom"}
                              onClick={() => wallpaperInputRef.current?.click()}
                              style={wallpaper.type === "custom" && wallpaper.dataUrl
                                ? { backgroundImage: `url(${wallpaper.dataUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
                                : { background: G.dim, display: "flex", alignItems: "center", justifyContent: "center" }}>
              {!(wallpaper.type === "custom" && wallpaper.dataUrl) && I.camera(G.sub, 18)}
            </WallpaperSwatch>
          </div>

          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            margin: "16px 0 6px",
          }}>
            <div style={{ fontSize: 12, color: G.muted }}>Wallpaper blur</div>
            <div style={{ fontSize: 12, color: G.sub }}>{blur === 0 ? "Off" : `${blur}px`}</div>
          </div>
          <input type="range" min={0} max={20} value={blur}
                 onChange={(event) => changeWallpaperBlur(Number(event.target.value))}
                 style={{ width: "100%", accentColor: G.accent }}/>

          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 12, marginTop: 20, paddingTop: 16, borderTop: `1px solid ${G.border}`,
          }}>
            <div>
              <div style={{ fontSize: 14 }}>Press Enter to send</div>
              <div style={{ fontSize: 11.5, color: G.muted, marginTop: 2 }}>
                {enterToSend
                  ? "Enter sends · Shift+Enter for a new line"
                  : "Enter adds a new line · send with the button"}
              </div>
            </div>
            <Toggle on={enterToSend} onChange={(value) => { setEnterToSend(value); saveEnterToSend(value); }}/>
          </div>
        </div>
      </Section>

      <Section id="notifications" icon={I.bell(G.accent, 20)} title="Notifications" sub="Push alerts"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <SRow icon={I.bell(G.accent, 18)} label="Push notifications"
              sub={isPushSupported()
                ? "Get notified even when this tab isn't open"
                : "Not supported in this browser"}
              right={isPushSupported()
                ? <Toggle on={pushEnabled} onChange={pushBusy ? () => {} : togglePush}/>
                : null}/>
      </Section>

      <Section id="data" icon={I.wifi(G.accent, 20)} title="Data usage" sub="Auto-download media"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <div style={{ padding: "0 20px 14px", fontSize: 12.5, color: G.muted }}>
          When to automatically download photos, videos, voice notes and
          documents in chats. Files you don't auto-download can still be
          fetched any time with a tap.
        </div>
        <div style={{ padding: "0 20px 16px", display: "flex", gap: 6 }}>
          {[["always", "Always"], ["wifi", "Wi-Fi only"], ["never", "Never"]].map(([value, label]) => (
            <button key={value} onClick={() => changeAutoDownload(value)} style={{
              flex: 1, padding: "9px 4px", borderRadius: 10, cursor: "pointer",
              fontSize: 12.5, fontWeight: 600,
              border: `1px solid ${autoDownload === value ? G.accent : G.border}`,
              background: autoDownload === value ? G.accentSoft : "transparent",
              color: autoDownload === value ? G.accentText : G.sub,
            }}>{label}</button>
          ))}
        </div>
      </Section>

      <Section id="privacy" icon={I.eye(G.accent, 20)} title="Privacy" sub="Last seen and read receipts"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <SRow icon={I.eye(G.accent, 18)} label="Last seen and online"
              sub="When off, nobody is told when you come or go"
              right={<Toggle on={Boolean(me.show_last_seen)}
                             onChange={(value) => togglePrivacy("show_last_seen", value)}/>}/>

        <SRow icon={I.checkDouble(G.accent, 18)} label="Read receipts"
              sub="When off, you stop sending them"
              right={<Toggle on={Boolean(me.show_read_receipts)}
                             onChange={(value) => togglePrivacy("show_read_receipts", value)}/>}/>

        <SRow icon={I.phoneOff(G.accent, 18)} label="Hide phone number"
              sub="When on, others can't see your number — only your name and username"
              right={<Toggle on={!Boolean(me.show_phone_number)}
                             onChange={(hideOn) => togglePrivacy("show_phone_number", !hideOn)}/>}/>

        <SRow icon={I.phone(G.accent, 18)} label="Calling"
              sub="When off, you can't be called and can't call anyone — scheduled meetings still work"
              right={<Toggle on={Boolean(me.calling_enabled)}
                             onChange={(value) => togglePrivacy("calling_enabled", value)}/>}/>
      </Section>

      <Section id="livelocation" icon={I.mapPin(G.accent, 20)} title="Live Location" sub="Who's sharing, and with you"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <LiveLocationList toast={toast}/>
      </Section>

      <Section id="storage" icon={I.barChart(G.accent, 20)} title="Storage and data" sub="See what's using space, chat by chat"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <StorageUsage/>
      </Section>

      <Section id="security" icon={I.shield(G.accent, 20)} title="Security" sub="Two-step verification"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <SRow icon={I.shield(G.accent, 18)} label="Two-step verification"
              sub={twoStep ? (twoStep.enabled ? "On — a PIN is asked for at login" : "Off")
                            : "Loading…"}
              onClick={() => setTwoStepSheet(true)}/>

        <SRow icon={I.lock(G.accent, 18)} label="App lock"
              sub={appLockOn ? "On — a PIN is asked for when you reopen the app" : "Off"}
              right={<Toggle on={appLockOn} onChange={(value) => {
                if (value) { setAppLockSheet(true); return; }
                disableAppLock();
                setAppLockOn(false);
                toast("App lock turned off");
              }}/>}/>
      </Section>

      <Section id="api" icon={I.bolt(G.accent, 20)} title="Business & Automation" sub={`${apiKeys.length} API key${apiKeys.length === 1 ? "" : "s"}`}
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <div style={{ padding: "0 20px 8px", fontSize: 12.5, color: G.muted }}>
          Send messages from a script — like WhatsApp's Business API. A key
          authenticates as you for sending only; it cannot read your chats,
          change your profile, or sign in as you.
        </div>

        <SRow icon={I.key(G.accent, 18)} label={creatingKey ? "Creating…" : "New API key"}
              onClick={creatingKey ? undefined : createApiKey}/>

        {apiKeys.map((key) => (
          <SRow key={key.id} icon={I.key(G.accent, 18)} label={key.label}
                sub={`${key.prefix}… · Created ${whenLabel(key.created_at)}` +
                     (key.last_used_at ? ` · Last used ${whenLabel(key.last_used_at)}` : " · Never used")}
                right={
                  <Button variant="danger" style={{ padding: "6px 12px", fontSize: 12 }}
                          onClick={() => revokeApiKey(key.id)}>Revoke</Button>
                }/>
        ))}

        <div style={{ fontSize: 12, fontWeight: 700, color: G.sub, margin: "18px 20px 4px" }}>
          Webhooks
        </div>
        <div style={{ padding: "0 20px 8px", fontSize: 12.5, color: G.muted }}>
          Get an HTTP POST to your own server the instant a message arrives —
          signed so you can verify it really came from here.
        </div>
        <div style={{ padding: "0 20px 10px", display: "flex", gap: 8 }}>
          <Field value={newWebhookUrl} onChange={(event) => setNewWebhookUrl(event.target.value)}
                 placeholder="https://your-server.com/hook" style={{ flex: 1, marginBottom: 0 }}/>
          <Button onClick={createWebhook} disabled={creatingWebhook || !newWebhookUrl.trim()}
                  style={{ padding: "0 16px" }}>
            {creatingWebhook ? "Adding…" : "Add"}
          </Button>
        </div>
        {webhooks.map((hook) => (
          <SRow key={hook.id} icon={I.link(G.accent, 18)} label={hook.url}
                sub={hook.last_triggered_at
                  ? `Last ${hook.last_status} · ${whenLabel(hook.last_triggered_at)}`
                  : "Never triggered yet"}
                right={
                  <Button variant="danger" style={{ padding: "6px 12px", fontSize: 12 }}
                          onClick={() => deleteWebhook(hook.id)}>Remove</Button>
                }/>
        ))}

        <div style={{ fontSize: 12, fontWeight: 700, color: G.sub, margin: "18px 20px 4px" }}>
          Away message
        </div>
        <SRow icon={I.moon(G.accent, 18)} label="Auto-reply when someone DMs you"
              sub={me.away_enabled ? "On" : "Off"}
              right={<Toggle on={Boolean(me.away_enabled)} onChange={toggleAway}/>}/>
        <div style={{ padding: "0 20px 14px", display: "flex", gap: 8 }}>
          <Field value={awayMessageDraft} onChange={(event) => setAwayMessageDraft(event.target.value)}
                 placeholder="I'm away right now — I'll reply when I'm back."
                 style={{ flex: 1, marginBottom: 0 }}/>
          <Button onClick={saveAwayMessage} disabled={awayMessageDraft.trim() === (me.away_message || "")}
                  style={{ padding: "0 16px" }}>Save</Button>
        </div>

        <div style={{ fontSize: 12, fontWeight: 700, color: G.sub, margin: "18px 20px 4px" }}>
          Canned replies
        </div>
        <div style={{ padding: "0 20px 8px", fontSize: 12.5, color: G.muted }}>
          Saved snippets you can drop into any chat from the composer's quick-reply picker.
        </div>
        <div style={{ padding: "0 20px 10px" }}>
          <Field value={newReplyLabel} onChange={(event) => setNewReplyLabel(event.target.value)}
                 placeholder="Label, e.g. Pricing"/>
          <div style={{ display: "flex", gap: 8 }}>
            <Field value={newReplyText} onChange={(event) => setNewReplyText(event.target.value)}
                   placeholder="The reply text itself" style={{ flex: 1, marginBottom: 0 }}/>
            <Button onClick={createCannedReply}
                    disabled={creatingReply || !newReplyLabel.trim() || !newReplyText.trim()}
                    style={{ padding: "0 16px" }}>
              {creatingReply ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
        {cannedReplies.map((reply) => (
          <SRow key={reply.id} icon={I.checkDouble(G.accent, 18)} label={reply.label} sub={reply.text}
                right={
                  <Button variant="danger" style={{ padding: "6px 12px", fontSize: 12 }}
                          onClick={() => deleteCannedReply(reply.id)}>Remove</Button>
                }/>
        ))}

        <div style={{ fontSize: 12, fontWeight: 700, color: G.sub, margin: "18px 20px 4px" }}>
          Message templates
        </div>
        <div style={{ padding: "0 20px 8px", fontSize: 12.5, color: G.muted }}>
          Like WhatsApp Business's template system — a message meant for someone who
          hasn't started the conversation needs sign-off first. Submitted templates
          need approval before they're usable.
        </div>
        <div style={{ padding: "0 20px 10px" }}>
          <Field value={newTemplateName} onChange={(event) => setNewTemplateName(event.target.value)}
                 placeholder="Name, e.g. Order confirmation"/>
          <div style={{ display: "flex", gap: 8 }}>
            <Field value={newTemplateContent} onChange={(event) => setNewTemplateContent(event.target.value)}
                   placeholder="The template's content" style={{ flex: 1, marginBottom: 0 }}/>
            <Button onClick={createTemplate}
                    disabled={creatingTemplate || !newTemplateName.trim() || !newTemplateContent.trim()}
                    style={{ padding: "0 16px" }}>
              {creatingTemplate ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
        {templates.map((template) => (
          <SRow key={template.id} icon={I.doc(G.accent, 18)} label={template.name}
                sub={`${template.content} · ${template.status}`}
                right={
                  <Button variant="danger" style={{ padding: "6px 12px", fontSize: 12 }}
                          onClick={() => deleteTemplate(template.id)}>Remove</Button>
                }/>
        ))}
      </Section>

      <Section id="devices" icon={I.monitor(G.accent, 20)} title="Linked devices" sub={`${sessions.length} device${sessions.length === 1 ? "" : "s"}`}
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <SRow icon={I.link(G.accent, 18)} label="Link a device" sub="Approve a sign-in using a code from another device"
              onClick={() => setLinkingDevice(true)}/>

        {sessions.map((session) => (
          <SRow key={session.session_id}
                icon={session.is_current ? I.mapPin(G.accent, 18) : I.monitor(G.accent, 18)}
                label={session.device_label + (session.is_current ? " (this device)" : "")}
                sub={`Linked ${whenLabel(session.created_at)}`
                  + (!session.is_current && session.short_lived ? " · auto sign-out in 4h" : "")}
                right={
                  !session.is_current && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div title="Auto sign out after 4 hours" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 11, color: G.muted }}>4h</span>
                        <Toggle on={session.short_lived}
                                onChange={(value) => toggleSessionShortLived(session.session_id, value)}/>
                      </div>
                      <Button variant="ghost" style={{ padding: "6px 12px", fontSize: 12 }}
                              onClick={() => revokeSession(session.session_id)}>
                        Sign out
                      </Button>
                    </div>
                  )
                }/>
        ))}
      </Section>

      <Section id="blocked" icon={I.ban(G.accent, 20)} title="Blocked" sub={`${blocked.length} blocked`}
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        {blocked.length === 0 ? (
          <div style={{ padding: "14px 20px", fontSize: 13, color: G.muted }}>
            Nobody is blocked.
          </div>
        ) : blocked.map((person) => (
          <SRow key={person.id} icon={I.user(G.accent, 18)} label={person.name} sub={`@${person.username}`}
                right={
                  <Button variant="ghost" style={{ padding: "6px 12px", fontSize: 12 }}
                          onClick={async () => {
                            await Users.unblock(person.id);
                            setBlocked((current) => current.filter((p) => p.id !== person.id));
                            toast("Unblocked");
                          }}>Unblock</Button>
                }/>
        ))}
      </Section>

      <Section id="help" icon={I.info(G.accent, 20)} title="Help and feedback"
               sub="Contact support, app info"
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        <div style={{ padding: "8px 20px 18px" }}>
          <SRow icon={I.mail(G.accent, 18)} label="Contact support"
                sub="Questions, bugs or feedback"
                onClick={() => {
                  const subject = encodeURIComponent("TalkEx feedback");
                  window.location.href = `mailto:support@coreaxis.cloud?subject=${subject}`;
                }}/>
          <SRow icon={I.star(G.accent, 18)} label="Send feedback"
                sub="Answer a few quick questions"
                onClick={() => setHelpView("feedback")}/>
          <SRow icon={I.info(G.accent, 18)} label="TalkEx Blog"
                sub="News, tips and updates"
                onClick={() => setHelpView("blog")}/>
          <SRow icon={I.shield(G.accent, 18)} label="Terms and privacy"
                sub="How TalkEx handles your data"
                onClick={() => window.open(`${window.location.origin}/privacy`, "_blank")}/>

          <div style={{ marginTop: 14, marginBottom: 6, fontSize: 13, fontWeight: 700, color: G.sub }}>
            More from CoreAxis
          </div>
          <SRow icon={<span style={{ fontSize: 18 }}>🛒</span>} label="CoreAxis ePOS"
                sub="coreaxis.cloud"
                onClick={() => window.open("https://coreaxis.cloud", "_blank", "noopener")}/>
          <SRow icon={<span style={{ fontSize: 18 }}>🚀</span>} label="CoreAxis Ventures"
                sub="ventures.coreaxis.cloud"
                onClick={() => window.open("https://ventures.coreaxis.cloud", "_blank", "noopener")}/>

          <div style={{ fontSize: 12, color: G.muted, textAlign: "center", marginTop: 16 }}>
            TalkEx — Made from Bihar, connecting the world 💙💚
          </div>
        </div>
      </Section>

      {helpView === "feedback" && <FeedbackForm onClose={() => setHelpView(null)} toast={toast}/>}
      {helpView === "blog" && <BlogSheet onClose={() => setHelpView(null)}/>}

      <Section id="account" icon={I.logOut(G.accent, 20)} title="Account" sub={me.phone || "Sign out, deactivate or delete"}
               activeSection={activeSection} onOpen={setActiveSection}
               onBack={() => setActiveSection(null)}>
        {savedAccounts.filter((account) => account.userId !== me.id).map((account) => (
          <SRow key={account.userId}
                icon={<Av av={account.avatarLetter} color={account.color} size={30}/>}
                label={account.name} sub={`@${account.username}`}
                onClick={() => switchToAccount(account.userId)}
                right={
                  <Button variant="ghost" style={{ padding: "6px 12px", fontSize: 12 }}
                          onClick={(event) => { event.stopPropagation(); removeSavedAccount(account.userId); }}>
                    Forget
                  </Button>
                }/>
        ))}
        <SRow icon={I.user(G.accent, 18)} label="Add another account"
              sub="Switch between accounts on this device"
              onClick={() => {
                // Guarantees this account is in the switcher even if it was
                // signed into before this feature existed (or restored from
                // a cached session that never ran through rememberAccount).
                rememberAccount(me, getToken());
                setAddingAccount(true);
              }}/>
        <SRow icon={I.phone(G.accent, 18)} label="Change phone number" sub={me.phone || "Not set"}
              onClick={() => setChangingPhone(true)}/>
        <SRow icon={I.lock(G.accent, 18)} label="Set password"
              sub="For signing in with a username, without a phone code"
              onClick={() => setSettingPassword(true)}/>
        <SRow icon={I.mail(G.accent, 18)} label="Email address"
              sub={me.email_verified_at ? `${me.email} · verified` : "Not connected — used to recover a forgotten PIN"}
              onClick={() => setConnectingEmail(true)}/>
        <SRow icon={I.logOut(G.red, 18)} label="Sign out" danger onClick={signOut}/>
        <SRow icon={I.moon(G.red, 18)} label="Deactivate account"
              sub="Hides your account until you sign back in"
              danger onClick={() => setDeactivating(true)}/>
        <SRow icon={I.trash(G.red, 18)} label="Delete account" sub="Permanent — cannot be undone"
              danger onClick={() => setDeletingAccount(true)}/>
      </Section>

      {activeSection === null && (
        <div style={{ padding: 20, fontSize: 11.5, color: G.muted, lineHeight: 1.6 }}>
          TalkEx ~by SatyaJeet · messages are stored on your own server.
          Disappearing messages are cleared on the server when their timer runs
          out, not just hidden in the app.
        </div>
      )}

      {linkingDevice && (
        <LinkDeviceSheet onClose={() => setLinkingDevice(false)}
                         onLinked={() => { setLinkingDevice(false); reloadSessions(); }}
                         toast={toast}/>
      )}

      {addingAccount && (
        <div style={{ position: "fixed", inset: 0, zIndex: 90, background: G.bg }}>
          <div onClick={() => setAddingAccount(false)} style={{
            position: "absolute", top: 16, left: 16, zIndex: 91, cursor: "pointer",
          }}>{I.back()}</div>
          <Login onAuthenticated={(user) => {
            // Login calls setToken() before calling onAuthenticated on every
            // auth path (phone, username/password, QR) — getToken() here is
            // already the freshly-added account's session, not the one we
            // came from.
            rememberAccount(user, getToken());
            window.location.reload();
          }}/>
        </div>
      )}

      {newKey && <NewApiKeySheet apiKey={newKey} onClose={() => setNewKey(null)} toast={toast}/>}

      {twoStepSheet && (
        <TwoStepSheet enabled={Boolean(twoStep?.enabled)}
                      onClose={() => setTwoStepSheet(false)}
                      onChanged={reloadTwoStep} toast={toast}/>
      )}

      {appLockSheet && (
        <AppLockSetupSheet onClose={() => setAppLockSheet(false)}
                           onSet={() => { setAppLockOn(true); setAppLockSheet(false); toast("App lock turned on"); }}/>
      )}

      {changingPhone && (
        <ChangePhoneSheet currentPhone={me.phone} onClose={() => setChangingPhone(false)}
                          onChanged={(updated) => { setChangingPhone(false); onUpdated(updated); }}
                          toast={toast}/>
      )}

      {settingPassword && (
        <SetPasswordSheet onClose={() => setSettingPassword(false)}
                          onSet={() => { setSettingPassword(false); toast("Password set — other devices signed out"); }}
                          toast={toast}/>
      )}

      {editingUsername && (
        <EditUsernameSheet currentUsername={me.username} onClose={() => setEditingUsername(false)}
                           onChanged={(updated) => { setEditingUsername(false); onUpdated(updated); toast("Username updated"); }}
                           toast={toast}/>
      )}

      {connectingEmail && (
        <EmailSheet currentEmail={me.email_verified_at ? me.email : ""}
                    onClose={() => setConnectingEmail(false)}
                    onChanged={(updated) => { setConnectingEmail(false); onUpdated(updated); }}
                    toast={toast}/>
      )}

      {deactivating && (
        <ConfirmSheet title="Deactivate account"
                     body="Your account will be hidden from search and new chats, and you'll be signed out everywhere. Signing back in reactivates it — nothing is deleted."
                     confirmLabel="Deactivate" onConfirm={confirmDeactivate}
                     onClose={() => setDeactivating(false)}/>
      )}

      {deletingAccount && (
        <ConfirmSheet title="Delete account" typeToConfirm="DELETE"
                     body="This permanently deletes your account. Messages you sent stay in chats you shared with others, but your profile, contacts and settings are gone for good. This cannot be undone."
                     confirmLabel="Delete forever" onConfirm={confirmDelete}
                     onClose={() => setDeletingAccount(false)}/>
      )}
    </div>
  );
}

/**
 * A guarded destructive action — for the ones that need more friction than
 * a single tap (deactivating, deleting), optionally requiring the user to
 * type a confirmation word before the button even becomes clickable.
 */
function ConfirmSheet({ title, body, confirmLabel, onConfirm, onClose, typeToConfirm }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !typeToConfirm || typed === typeToConfirm;

  async function go() {
    setBusy(true);
    try {
      await onConfirm();
    } catch (problem) {
      setBusy(false);
      onClose();
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10 }}>{title}</div>
        <div style={{ fontSize: 13, color: G.muted, marginBottom: 16, lineHeight: 1.5 }}>{body}</div>
        {typeToConfirm && (
          <Field label={`Type ${typeToConfirm} to confirm`} value={typed}
                 onChange={(event) => setTyped(event.target.value)}
                 placeholder={typeToConfirm}/>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <Button variant="ghost" onClick={onClose} disabled={busy} style={{ flex: 1 }}>
            Cancel
          </Button>
          <Button variant="danger" onClick={go} disabled={busy || !ready} style={{ flex: 1 }}>
            {busy ? "Please wait…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Changing your phone number reuses the exact same two-step OTP flow as
 * signing up with one — a code goes to the NEW number, and entering it
 * correctly swaps it in.
 */
function ChangePhoneSheet({ currentPhone, onClose, onChanged, toast }) {
  const [step, setStep] = useState("phone"); // phone | code
  const [country, setCountry] = useState(() => splitPhone(currentPhone).country);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const fullPhone = country.dial + phone;
  const validLength = phone.length === country.len;

  function onPhoneChange(event) {
    setPhone(event.target.value.replace(/\D/g, "").slice(0, country.len));
  }

  async function requestCode() {
    if (!validLength) return;
    setBusy(true);
    try {
      await Me.requestPhoneChangeOtp(fullPhone);
      setStep("code");
    } catch (problem) {
      toast(problem.message || "Could not send a code");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const updated = await Me.confirmPhoneChange(fullPhone, code.trim());
      toast("Phone number updated");
      onChanged(updated);
    } catch (problem) {
      toast(problem.message || "Incorrect code");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>Change phone number</div>

        {step === "phone" ? (
          <>
            {currentPhone && (
              <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
                Current number: {currentPhone}
              </div>
            )}
            <label style={{ display: "block", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: G.sub, marginBottom: 6 }}>New phone number</div>
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
                       onKeyDown={(event) => event.key === "Enter" && validLength && requestCode()}
                       style={{
                         flex: 1, width: "100%", padding: "12px 14px", borderRadius: 12,
                         background: G.dim, border: `1px solid ${G.border}`, color: G.text,
                         fontSize: 15, outline: "none", boxSizing: "border-box",
                       }}/>
              </div>
            </label>
            <Button onClick={requestCode} disabled={busy || !validLength} style={{ width: "100%" }}>
              {busy ? "Sending…" : "Send code"}
            </Button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
              We sent a code to {fullPhone}.
            </div>
            <Field label="Code" value={code} inputMode="numeric"
                   onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                   placeholder="123456"
                   onKeyDown={(event) => event.key === "Enter" && confirm()}/>
            <Button onClick={confirm} disabled={busy || !code.trim()} style={{ width: "100%" }}>
              {busy ? "Checking…" : "Confirm"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Setting a password directly — no "current password" step. An account
 * created via phone sign-in got a random one nobody, including its owner,
 * ever saw (see main.py's verify_phone_otp), so there is nothing to prove
 * here beyond already being signed in, same trust level the account
 * deletion button below already relies on for something far more
 * permanent than this. Setting it revokes every OTHER session — this
 * device's own stays signed in.
 */
function SetPasswordSheet({ onClose, onSet, toast }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatched = confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = password.length >= 8 && password === confirmPassword;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await Me.setPassword(password);
      onSet();
    } catch (problem) {
      toast(problem.message || "Could not set password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Set password</div>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          Lets you sign in with your username instead of a phone code. Other
          signed-in devices will be signed out once this is set.
        </div>
        <Field label="New password" type="password" value={password} autoComplete="new-password"
               onChange={(event) => setPassword(event.target.value)}
               placeholder="At least 8 characters"/>
        {tooShort && (
          <div style={{ fontSize: 11.5, color: G.red, marginTop: -8, marginBottom: 12 }}>
            At least 8 characters.
          </div>
        )}
        <Field label="Confirm new password" type="password" value={confirmPassword} autoComplete="new-password"
               onChange={(event) => setConfirmPassword(event.target.value)}
               onKeyDown={(event) => event.key === "Enter" && canSubmit && submit()}
               placeholder="Type it again"/>
        {mismatched && (
          <div style={{ fontSize: 11.5, color: G.red, marginTop: -8, marginBottom: 12 }}>
            Passwords don't match.
          </div>
        )}
        <Button onClick={submit} disabled={busy || !canSubmit} style={{ width: "100%" }}>
          {busy ? "Setting…" : "Set password"}
        </Button>
      </div>
    </div>
  );
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

/**
 * Choosing/changing a username, with live availability feedback — a
 * phone-signup account never picked one at all (it got an auto-generated
 * one like user9113107586, see main.py's unique_username_from_phone), so
 * this is the first place that's ever shown or let anyone set it.
 */
function EditUsernameSheet({ currentUsername, onClose, onChanged, toast }) {
  const [username, setUsername] = useState(currentUsername);
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);

  const validFormat = USERNAME_PATTERN.test(username);
  const unchanged = username.toLowerCase() === currentUsername.toLowerCase();

  // Debounced: checking on every keystroke would fire a request per
  // character typed. 400ms is long enough to skip the request entirely
  // for someone still mid-word, short enough not to feel laggy once they pause.
  useEffect(() => {
    if (!validFormat || unchanged) { setAvailable(true); return; }
    setChecking(true);
    const timer = setTimeout(() => {
      Me.usernameAvailable(username)
        .then((result) => setAvailable(result.available))
        .catch(() => setAvailable(true)) // fail open — the submit itself still enforces this
        .finally(() => setChecking(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [username, validFormat, unchanged]);

  const canSubmit = validFormat && (unchanged || (available && !checking));

  async function submit() {
    if (!canSubmit) return;
    if (unchanged) { onClose(); return; }
    setBusy(true);
    try {
      const updated = await Me.setUsername(username);
      onChanged(updated);
    } catch (problem) {
      toast(problem.message || "Could not update username");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Username</div>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          Letters, numbers and underscores only. Used for @mentions and signing in.
        </div>
        <Field label="Username" value={username} autoComplete="off"
               onChange={(event) => setUsername(event.target.value.replace(/\s/g, ""))}
               onKeyDown={(event) => event.key === "Enter" && canSubmit && submit()}
               placeholder="your_username"/>
        {!validFormat && username.length > 0 && (
          <div style={{ fontSize: 11.5, color: G.red, marginTop: -8, marginBottom: 12 }}>
            3-32 characters — letters, numbers and underscores only.
          </div>
        )}
        {validFormat && !unchanged && checking && (
          <div style={{ fontSize: 11.5, color: G.muted, marginTop: -8, marginBottom: 12 }}>
            Checking availability…
          </div>
        )}
        {validFormat && !unchanged && !checking && !available && (
          <div style={{ fontSize: 11.5, color: G.red, marginTop: -8, marginBottom: 12 }}>
            That username is already taken.
          </div>
        )}
        {validFormat && !unchanged && !checking && available && (
          <div style={{ fontSize: 11.5, color: G.green, marginTop: -8, marginBottom: 12 }}>
            Available.
          </div>
        )}
        <Button onClick={submit} disabled={busy || !canSubmit} style={{ width: "100%" }}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Connecting a recovery email — WhatsApp's flow under two-step verification:
 * an email is never a login credential here, only where a PIN-reset link
 * would go if you ever forget it. Same two-call OTP shape as the phone
 * number change above, plus a "Remove" step once one is already verified.
 */
function EmailSheet({ currentEmail, onClose, onChanged, toast }) {
  const [step, setStep] = useState(currentEmail ? "connected" : "email"); // connected | email | code
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestCode() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await Me.requestEmailOtp(email.trim());
      setStep("code");
    } catch (problem) {
      toast(problem.message || "Could not send a code");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const updated = await Me.confirmEmail(email.trim(), code.trim());
      toast("Email connected");
      onChanged(updated);
    } catch (problem) {
      toast(problem.message || "Incorrect code");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      const updated = await Me.removeEmail();
      toast("Email disconnected");
      onChanged(updated);
    } catch (problem) {
      toast(problem.message || "Could not disconnect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Email address</div>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          Used to recover a forgotten two-step PIN — never for signing in, and
          never shown to anyone else.
        </div>

        {step === "connected" ? (
          <>
            <div style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
              borderRadius: 12, background: G.dim, marginBottom: 14,
            }}>
              {I.mail(G.accent, 18)}
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{currentEmail}</div>
              {I.checkDouble("#38bdf8", 14)}
            </div>
            <Button variant="ghost" onClick={() => setStep("email")} style={{ width: "100%", marginBottom: 8 }}>
              Change email
            </Button>
            <Button variant="danger" onClick={disconnect} disabled={busy} style={{ width: "100%" }}>
              {busy ? "Removing…" : "Disconnect"}
            </Button>
          </>
        ) : step === "email" ? (
          <>
            <Field label="Email address" value={email}
                   onChange={(event) => setEmail(event.target.value)}
                   placeholder="you@example.com" inputMode="email" type="email"
                   onKeyDown={(event) => event.key === "Enter" && requestCode()}/>
            <Button onClick={requestCode} disabled={busy || !email.trim()} style={{ width: "100%" }}>
              {busy ? "Sending…" : "Send code"}
            </Button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
              We sent a code to {email}.
            </div>
            <Field label="Code" value={code} inputMode="numeric"
                   onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))}
                   placeholder="123456"
                   onKeyDown={(event) => event.key === "Enter" && confirm()}/>
            <Button onClick={confirm} disabled={busy || !code.trim()} style={{ width: "100%" }}>
              {busy ? "Checking…" : "Confirm"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function AppLockSetupSheet({ onClose, onSet }) {
  const [step, setStep] = useState("choose"); // choose | confirm
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState("");

  function proceed() {
    if (pin.length < 4) { setError("PIN must be at least 4 digits"); return; }
    setError("");
    setStep("confirm");
  }

  async function finish() {
    if (confirmPin !== pin) {
      setError("PINs don't match");
      setConfirmPin("");
      return;
    }
    await setAppLockPin(pin);
    onSet();
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>
          {step === "choose" ? "Set a PIN" : "Confirm your PIN"}
        </div>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          This PIN stays on this device only — it's separate from your account password,
          and forgetting it just means signing out and back in.
        </div>

        {step === "choose" ? (
          <>
            <Field label="4–6 digit PIN" value={pin} inputMode="numeric" type="password"
                   onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                   onKeyDown={(event) => event.key === "Enter" && proceed()}/>
            {error && <div style={{ fontSize: 12.5, color: G.red, marginBottom: 10 }}>{error}</div>}
            <Button onClick={proceed} disabled={pin.length < 4} style={{ width: "100%" }}>Continue</Button>
          </>
        ) : (
          <>
            <Field label="Re-enter PIN" value={confirmPin} inputMode="numeric" type="password"
                   onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
                   onKeyDown={(event) => event.key === "Enter" && finish()}/>
            {error && <div style={{ fontSize: 12.5, color: G.red, marginBottom: 10 }}>{error}</div>}
            <Button onClick={finish} disabled={confirmPin.length < 4} style={{ width: "100%" }}>
              Turn on app lock
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function LiveLocationList({ toast }) {
  const [shares, setShares] = useState(null); // null while loading
  const [stoppingId, setStoppingId] = useState(null);

  function reload() {
    Me.liveLocations().then(setShares).catch(() => setShares([]));
  }

  useEffect(reload, []);

  async function stop(share) {
    setStoppingId(share.id);
    try {
      await Messages.stopLiveLocation(share.id);
      reload();
    } catch (problem) {
      toast(problem.message || "Could not stop sharing");
    } finally {
      setStoppingId(null);
    }
  }

  if (shares === null) return <div style={{ padding: 20 }}><Spinner small/></div>;

  if (shares.length === 0) {
    return (
      <div style={{ padding: "30px 20px", textAlign: "center", color: G.muted, fontSize: 13.5 }}>
        No live locations right now. Start one from a chat's attach menu.
      </div>
    );
  }

  const mine = shares.filter((s) => s.is_mine);
  const others = shares.filter((s) => !s.is_mine);

  return (
    <div>
      {mine.length > 0 && (
        <>
          <div style={{ padding: "12px 20px 4px", fontSize: 12, color: G.sub }}>You're sharing</div>
          {mine.map((share) => (
            <SRow key={share.id} icon={I.mapPin(G.accent, 18)} label={share.chat_name}
                  sub={`Until ${clockTime(share.payload.live_until)}`}
                  right={
                    <div onClick={(event) => { event.stopPropagation(); stop(share); }} style={{
                      fontSize: 12.5, color: G.red, cursor: "pointer",
                      opacity: stoppingId === share.id ? 0.5 : 1,
                    }}>Stop</div>
                  }/>
          ))}
        </>
      )}
      {others.length > 0 && (
        <>
          <div style={{ padding: "12px 20px 4px", fontSize: 12, color: G.sub }}>Shared with you</div>
          {others.map((share) => (
            <SRow key={share.id} icon={I.mapPin(G.accent, 18)}
                  label={share.chat_type === "dm" ? share.chat_name : share.sender_name}
                  sub={share.chat_type === "dm" ? `Until ${clockTime(share.payload.live_until)}`
                       : `In ${share.chat_name} · until ${clockTime(share.payload.live_until)}`}/>
          ))}
        </>
      )}
    </div>
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function StorageUsage() {
  const [usage, setUsage] = useState(null); // null while loading

  useEffect(() => {
    Me.storage().then(setUsage).catch(() => setUsage({ total_bytes: 0, total_files: 0, chats: [] }));
  }, []);

  if (usage === null) return <div style={{ padding: 20 }}><Spinner small/></div>;

  if (usage.chats.length === 0) {
    return (
      <div style={{ padding: "30px 20px", textAlign: "center", color: G.muted, fontSize: 13.5 }}>
        No media shared yet.
      </div>
    );
  }

  const largest = Math.max(...usage.chats.map((c) => c.total_bytes), 1);

  return (
    <div>
      <div style={{ padding: "12px 20px", display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 22, fontWeight: 700 }}>{formatBytes(usage.total_bytes)}</div>
        <div style={{ fontSize: 12.5, color: G.muted }}>
          across {usage.total_files} file{usage.total_files === 1 ? "" : "s"}
        </div>
      </div>
      {usage.chats.map((chat) => (
        <div key={chat.chat_id} style={{ padding: "8px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{chat.chat_name || chat.chat_type}</div>
            <div style={{ fontSize: 12.5, color: G.sub }}>{formatBytes(chat.total_bytes)}</div>
          </div>
          <div style={{ height: 5, borderRadius: 3, background: G.dim, overflow: "hidden" }}>
            <div style={{
              height: "100%", width: `${(chat.total_bytes / largest) * 100}%`,
              background: G.accent, borderRadius: 3,
            }}/>
          </div>
        </div>
      ))}
    </div>
  );
}

/** One tile in the chat-wallpaper grid — a live preview of that choice, with a check mark when it's the active one. */
function WallpaperSwatch({ label, active, onClick, style, children }) {
  return (
    <div onClick={onClick} title={label} style={{
      position: "relative", aspectRatio: "1", borderRadius: 12, cursor: "pointer",
      overflow: "hidden", border: `2px solid ${active ? G.accent : G.border}`, ...style,
    }}>
      {children}
      {active && (
        <div style={{
          position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: "50%",
          background: G.accent, display: "flex", alignItems: "center", justifyContent: "center",
        }}>{I.check("#fff", 11)}</div>
      )}
    </div>
  );
}

/**
 * A settings category as real parent-child navigation, WhatsApp-Settings-home
 * style: on the home screen (activeSection === null) this renders just a
 * summary row (icon, title, one line, chevron pointing into it); tapping it
 * drills into a dedicated screen showing only this category's own content
 * behind a back button. Nothing else on the home screen is visible while a
 * category is open — this is real navigation, not an inline expand/collapse.
 */
function Section({ id, icon, title, sub, activeSection, onOpen, onBack, children }) {
  if (activeSection === null) {
    return (
      <div onClick={() => onOpen(id)} style={{
        display: "flex", alignItems: "center", gap: 14, padding: "14px 20px",
        cursor: "pointer", borderBottom: `1px solid ${G.border}`,
      }}>
        <div style={{ fontSize: 20, width: 24, textAlign: "center" }}>{icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
          {sub && (
            <div style={{
              fontSize: 12, color: G.muted, marginTop: 2, whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis",
            }}>{sub}</div>
          )}
        </div>
        <div style={{ display: "flex", transform: "rotate(-90deg)" }}>
          {I.chevronDown(G.muted, 16)}
        </div>
      </div>
    );
  }

  // A different category is currently open — this one renders nothing at all.
  if (activeSection !== id) return null;

  return (
    <div>
      <div onClick={onBack} style={{
        display: "flex", alignItems: "center", gap: 12, padding: "14px 20px",
        cursor: "pointer", borderBottom: `1px solid ${G.border}`, background: G.surface,
      }}>
        {I.back()}
        <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}

/**
 * The already-signed-in side of linking: type in the code the new device is
 * showing, see whose request it is, then approve or deny it.
 */
function LinkDeviceSheet({ onClose, onLinked, toast }) {
  const [code, setCode] = useState("");
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);

  // Takes an explicit value rather than always reading `code` — a scanned
  // code needs to look itself up the instant it decodes, and setCode()
  // hasn't landed in state yet at that point in the same tick.
  async function lookUp(rawCode) {
    const value = (rawCode ?? code).trim().toUpperCase();
    if (value.length < 4) return;
    setBusy(true);
    setError("");
    try {
      const result = await Auth.linkInfo(value);
      setCode(value);
      setInfo(result);
    } catch (problem) {
      setError(problem.message || "Invalid or expired code");
      setInfo(null);
    } finally {
      setBusy(false);
    }
  }

  function onScanned(decoded) {
    setScanning(false);
    lookUp(decoded);
  }

  async function approve() {
    setBusy(true);
    try {
      await Auth.approveLink(code.trim().toUpperCase());
      toast("Device linked");
      onLinked();
    } catch (problem) {
      setError(problem.message || "Could not approve");
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    await Auth.denyLink(code.trim().toUpperCase());
    onClose();
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
          Link a device
        </div>

        {!info ? (
          scanning ? (
            <>
              <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
                Point the camera at the QR code on the other device's "Scan QR" screen.
              </div>
              <QrScanner onDecode={onScanned}
                         onError={(message) => { setScanning(false); setError(message); }}/>
              <Button variant="ghost" onClick={() => setScanning(false)}
                      style={{ width: "100%", marginTop: 14 }}>
                Enter code instead
              </Button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
                Scan the QR code on the other device's "Scan QR" screen, or enter its code below.
              </div>
              <Button variant="ghost" onClick={() => { setError(""); setScanning(true); }}
                      style={{
                        width: "100%", marginBottom: 14,
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      }}>
                {I.scan(G.accent, 16)} Scan QR code
              </Button>
              <Field label="Code" value={code}
                     onChange={(event) => setCode(event.target.value.toUpperCase())}
                     placeholder="A1B2C3D4" maxLength={8}
                     style={{ fontFamily: "monospace", letterSpacing: 3, fontSize: 18 }}
                     onKeyDown={(event) => event.key === "Enter" && lookUp()}/>
              {error && <div style={{ color: G.red, fontSize: 13, marginBottom: 10 }}>{error}</div>}
              <Button onClick={() => lookUp()} disabled={busy || code.length < 4} style={{ width: "100%" }}>
                {busy ? "Checking…" : "Continue"}
              </Button>
            </>
          )
        ) : (
          <>
            <div style={{
              padding: 16, borderRadius: 14, background: G.dim,
              border: `1px solid ${G.border}`, marginBottom: 16, textAlign: "center",
            }}>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
                {info.device_label}
              </div>
              <div style={{ fontSize: 12.5, color: G.muted }}>wants to sign in as you</div>
            </div>
            {error && <div style={{ color: G.red, fontSize: 13, marginBottom: 10 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <Button variant="ghost" onClick={deny} disabled={busy} style={{ flex: 1 }}>
                Deny
              </Button>
              <Button onClick={approve} disabled={busy} style={{ flex: 1 }}>
                {busy ? "Approving…" : "Approve"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The full API key, shown exactly once. The server never stores it (only a
 * hash), so this dialog is the only chance to see or copy it — closing
 * without saving it means generating a new one.
 */
function NewApiKeySheet({ apiKey, onClose, toast }) {
  function copy() {
    navigator.clipboard?.writeText(apiKey);
    toast("Copied");
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>
          Your new API key
        </div>
        <div style={{ fontSize: 12.5, color: G.red, marginBottom: 14 }}>
          Copy it now — it won't be shown again.
        </div>

        <div style={{
          padding: "12px 14px", borderRadius: 12, background: G.dim,
          border: `1px solid ${G.border}`, fontFamily: "monospace", fontSize: 13,
          wordBreak: "break-all", marginBottom: 14,
        }}>{apiKey}</div>

        <div style={{ display: "flex", gap: 10 }}>
          <Button variant="ghost" onClick={copy} style={{ flex: 1 }}>Copy</Button>
          <Button onClick={onClose} style={{ flex: 1 }}>Done</Button>
        </div>

        <div style={{ fontSize: 11.5, color: G.muted, marginTop: 14, lineHeight: 1.6 }}>
          Use it as a bearer token against{" "}
          <code style={{ fontFamily: "monospace" }}>POST /api/v1/messages</code>{" "}
          — {"{"}"to": "username", "text": "..."{"}"}.
        </div>
      </div>
    </div>
  );
}

/**
 * Turn two-step verification on/off, or change the PIN.
 *
 * Mirrors the chat-lock UI's shape: setting the first PIN needs nothing
 * extra, changing or removing an existing one always has to prove the
 * current one first — same rule, same reason, enforced again server-side.
 */
function TwoStepSheet({ enabled, onClose, onChanged, toast }) {
  const [action, setAction] = useState(enabled ? null : "set");
  const [currentPin, setCurrentPin] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [busy, setBusy] = useState(false);
  // Shown exactly once — the moment a first PIN is set, or right after a
  // deliberate regeneration. Never retrievable again after this sheet closes,
  // same as the bulk-API key screen.
  const [recoveryCodes, setRecoveryCodes] = useState(null);

  const digits = (setter) => (event) =>
    setter(event.target.value.replace(/\D/g, "").slice(0, 8));

  async function save() {
    if (pin.length < 4) { toast("PIN must be at least 4 digits"); return; }
    if (pin !== confirmPin) { toast("PINs don't match"); return; }
    setBusy(true);
    try {
      const result = await Me.setTwoStep(pin, action === "change" ? currentPin : undefined);
      onChanged();
      if (result.recovery_codes) {
        setRecoveryCodes(result.recovery_codes);
      } else {
        toast("PIN changed");
        onClose();
      }
    } catch (problem) {
      toast(problem.message || "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function removePin() {
    if (!currentPin) { toast("Enter your current PIN"); return; }
    setBusy(true);
    try {
      await Me.removeTwoStep(currentPin);
      toast("Two-step verification is off");
      onChanged();
      onClose();
    } catch (problem) {
      toast(problem.message || "Wrong PIN");
    } finally {
      setBusy(false);
    }
  }

  async function regenerateCodes() {
    if (!currentPin) { toast("Enter your current PIN"); return; }
    setBusy(true);
    try {
      const result = await Me.regenerateRecoveryCodes(currentPin);
      setRecoveryCodes(result.recovery_codes);
    } catch (problem) {
      toast(problem.message || "Wrong PIN");
    } finally {
      setBusy(false);
    }
  }

  function copyCodes() {
    navigator.clipboard?.writeText(recoveryCodes.join("\n"));
    toast("Copied");
  }

  let body;
  if (recoveryCodes) {
    body = (
      <>
        <div style={{ fontSize: 12.5, color: G.red, marginBottom: 14 }}>
          Save these somewhere safe — they won't be shown again. Each one gets
          you back in once if you ever forget your PIN, and using one turns
          two-step verification off so you can set a fresh PIN.
        </div>
        <div style={{
          padding: "12px 14px", borderRadius: 12, background: G.dim,
          border: `1px solid ${G.border}`, fontFamily: "monospace", fontSize: 14,
          lineHeight: 1.8, marginBottom: 14,
        }}>
          {recoveryCodes.map((code) => <div key={code}>{code}</div>)}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Button variant="ghost" onClick={copyCodes} style={{ flex: 1 }}>Copy</Button>
          <Button onClick={onClose} style={{ flex: 1 }}>Done</Button>
        </div>
      </>
    );
  } else if (action === null) {
    body = (
      <>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          A PIN is asked for after your password, the next time this account
          signs in anywhere.
        </div>
        <SRow icon={I.key(G.accent, 18)} label="Change PIN" onClick={() => setAction("change")}/>
        <SRow icon={I.key(G.accent, 18)} label="View new recovery codes"
              sub="Replaces the old ones — they stop working"
              onClick={() => setAction("recover")}/>
        <SRow icon={I.ban(G.red, 18)} label="Turn off" danger onClick={() => setAction("remove")}/>
      </>
    );
  } else if (action === "remove") {
    body = (
      <>
        <Field label="Current PIN" type="password" value={currentPin} inputMode="numeric"
               onChange={digits(setCurrentPin)} placeholder="••••"/>
        <Button variant="danger" onClick={removePin} disabled={busy} style={{ width: "100%" }}>
          {busy ? "Please wait…" : "Turn off"}
        </Button>
      </>
    );
  } else if (action === "recover") {
    body = (
      <>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          Generating new codes invalidates every old one immediately.
        </div>
        <Field label="Current PIN" type="password" value={currentPin} inputMode="numeric"
               onChange={digits(setCurrentPin)} placeholder="••••"/>
        <Button onClick={regenerateCodes} disabled={busy} style={{ width: "100%" }}>
          {busy ? "Please wait…" : "Generate new codes"}
        </Button>
      </>
    );
  } else {
    body = (
      <>
        {action === "change" && (
          <Field label="Current PIN" type="password" value={currentPin} inputMode="numeric"
                 onChange={digits(setCurrentPin)} placeholder="••••"/>
        )}
        <Field label="New PIN" type="password" value={pin} inputMode="numeric"
               onChange={digits(setPin)} placeholder="4-8 digits"/>
        <Field label="Confirm PIN" type="password" value={confirmPin} inputMode="numeric"
               onChange={digits(setConfirmPin)} placeholder="4-8 digits"/>
        <Button onClick={save} disabled={busy} style={{ width: "100%" }}>
          {busy ? "Please wait…" : "Save"}
        </Button>
      </>
    );
  }

  return (
    <div onClick={recoveryCodes ? undefined : onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>
          {recoveryCodes ? "Your recovery codes"
            : action === "remove" ? "Turn off two-step verification"
            : action === "recover" ? "New recovery codes"
            : action === "change" ? "Change PIN"
            : action === "set" ? "Set a PIN"
            : "Two-step verification"}
        </div>
        {body}
      </div>
    </div>
  );
}


// ── Invite a friend (WhatsApp-style) ────────────────────────────────────────

const HAS_DEVICE_CONTACTS = typeof navigator !== "undefined"
  && "contacts" in navigator && "ContactsManager" in window;

function InviteFriend({ me, toast }) {
  const inviteUrl = `${window.location.origin}/?ref=${me?.username || ""}`;
  const inviteText = `Hey! Join me on TalkEx — it's free, fast, and secure messaging & calling.\n${inviteUrl}`;

  // Saved TalkEx contacts — used to show "already on TalkEx" vs "invite"
  const [contacts, setContacts] = useState(null);
  const [query, setQuery] = useState("");
  const [deviceContacts, setDeviceContacts] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Contacts.list().then(setContacts).catch(() => {});
  }, []);

  // Load device contacts (phones), match against backend, merge in saved
  async function loadDeviceContacts() {
    if (!HAS_DEVICE_CONTACTS) return;
    setLoading(true);
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      const entries = [];
      for (const contact of picked) {
        const name = contact.name?.[0] || "";
        for (const tel of (contact.tel || [])) {
          entries.push({ name, phone: tel.replace(/[^+\d]/g, "") });
        }
      }
      if (entries.length === 0) { setLoading(false); return; }
      // Ask backend which of these phones are TalkEx users
      const phones = entries.map((entry) => entry.phone);
      let matched = [];
      try {
        matched = await Users.matchContacts(phones);
      } catch { /* fallback: show all as non-TalkEx */ }
      const matchedSet = new Set(matched.map((m) => m.phone));
      const merged = entries.map((entry) => ({
        ...entry,
        onTalkEx: matchedSet.has(entry.phone),
        user: matched.find((m) => m.phone === entry.phone) || null,
      }));
      // Sort: non-TalkEx users first (the ones you'd want to invite)
      merged.sort((a, b) => (a.onTalkEx === b.onTalkEx ? 0 : a.onTalkEx ? 1 : -1));
      setDeviceContacts(merged);
    } catch (problem) {
      if (problem.name !== "AbortError") toast("Could not read contacts");
    }
    setLoading(false);
  }

  const allContacts = deviceContacts || [];
  const filtered = query.trim()
    ? allContacts.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase())
        || c.phone.includes(query.trim()))
    : allContacts;

  function sendSmsInvite(phone) {
    // Open the native SMS composer with the invite message pre-filled.
    // `sms:` URI is the standard way to do this — works on Android (Chrome),
    // iOS Safari, and Capacitor WebView. The `?body=` or `&body=` form varies
    // by platform, but `?&body=` covers both Android (needs &) and iOS (needs ?).
    const encoded = encodeURIComponent(inviteText);
    window.open(`sms:${phone}?&body=${encoded}`, "_self");
  }

  return (
    <div style={{ padding: "4px 0 18px" }}>
      {/* Share invite link */}
      <div style={{ padding: "0 20px", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: G.muted, marginBottom: 12 }}>
          Invite friends to join TalkEx. When {me?.blue_tick ? "" : "10 friends sign up through your link, you earn the "}
          {!me?.blue_tick && <span style={{ display: "inline-flex", verticalAlign: "middle" }}>{I.blueTick(13)}</span>}
          {me?.blue_tick ? "Share TalkEx with your friends." : " blue tick!"}
        </div>
        <Button style={{ width: "100%", marginBottom: 8 }} onClick={async () => {
          if (navigator.share) {
            try { await navigator.share({ title: "TalkEx", text: inviteText, url: inviteUrl }); } catch { /* cancelled */ }
          } else {
            navigator.clipboard?.writeText(inviteText);
            toast("Invite link copied");
          }
        }}>{I.share("#fff", 15)} Share invite link</Button>
        <Button variant="ghost" style={{ width: "100%", marginBottom: 8 }} onClick={() => {
          navigator.clipboard?.writeText(inviteUrl);
          toast("Link copied");
        }}>Copy link</Button>
      </div>

      {/* Device contacts */}
      {HAS_DEVICE_CONTACTS && !deviceContacts && (
        <div style={{ padding: "0 20px", marginBottom: 14 }}>
          <Button variant="ghost" style={{ width: "100%" }} onClick={loadDeviceContacts}>
            {loading ? "Loading…" : "📇 Load phone contacts"}
          </Button>
        </div>
      )}

      {deviceContacts && (
        <>
          <div style={{ padding: "0 20px 10px" }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)}
                   placeholder="Search" style={{
              width: "100%", padding: "8px 12px", borderRadius: 10,
              background: G.dim, border: `1px solid ${G.border}`, color: G.text,
              fontSize: 13.5, outline: "none", boxSizing: "border-box",
            }}/>
          </div>
          <div style={{ maxHeight: 350, overflowY: "auto" }}>
            {filtered.map((contact, idx) => (
              <div key={contact.phone + idx} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 20px", borderBottom: `1px solid ${G.border}`,
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: "50%",
                  background: contact.onTalkEx ? G.accent + "22" : G.dim,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, fontWeight: 600, color: contact.onTalkEx ? G.accent : G.sub,
                  flexShrink: 0,
                }}>{contact.name[0]?.toUpperCase() || "?"}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {contact.name}
                  </div>
                  <div style={{ fontSize: 12, color: contact.onTalkEx ? G.accent : G.muted }}>
                    {contact.onTalkEx ? "On TalkEx ✓" : contact.phone}
                  </div>
                </div>
                {!contact.onTalkEx && (
                  <button onClick={() => sendSmsInvite(contact.phone)} style={{
                    padding: "6px 14px", borderRadius: 8, border: `1px solid ${G.accent}`,
                    background: "transparent", color: G.accent, fontSize: 12.5,
                    fontWeight: 600, cursor: "pointer", flexShrink: 0,
                  }}>Invite</button>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ fontSize: 13, color: G.muted, textAlign: "center", padding: 20 }}>
                {query ? "No matches" : "No contacts loaded"}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}


// ── Feedback form (1 free-text + 10 select-answer questions) ─────────────────

const FEEDBACK_QUESTIONS = [
  { key: "overall", q: "How would you rate TalkEx overall?", options: ["Excellent", "Good", "Average", "Poor"] },
  { key: "ease", q: "How easy is TalkEx to use?", options: ["Very easy", "Easy", "Neutral", "Difficult"] },
  { key: "speed", q: "How is the app's speed & performance?", options: ["Fast", "OK", "Slow"] },
  { key: "delivery", q: "How reliable is message delivery?", options: ["Always", "Mostly", "Sometimes", "Rarely"] },
  { key: "calls", q: "How is the call quality?", options: ["Great", "Good", "Average", "Poor", "Haven't used"] },
  { key: "most_used", q: "Which feature do you use most?", options: ["Chats", "Calls", "Status", "Channels", "Groups"] },
  { key: "recommend", q: "How likely are you to recommend TalkEx?", options: ["Very likely", "Likely", "Neutral", "Unlikely"] },
  { key: "vs_others", q: "How does TalkEx compare to other apps?", options: ["Better", "Same", "Worse"] },
  { key: "bugs", q: "Have you faced any bugs or crashes?", options: ["Never", "Rarely", "Sometimes", "Often"] },
  { key: "support", q: "How satisfied are you with support?", options: ["Very satisfied", "Satisfied", "Neutral", "Dissatisfied", "Haven't contacted"] },
];

function FeedbackForm({ onClose, toast }) {
  const [answers, setAnswers] = useState({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit() {
    if (Object.keys(answers).length === 0 && !comment.trim()) {
      toast("Please answer at least one question");
      return;
    }
    setBusy(true);
    try {
      await Me.submitFeedback(answers, comment.trim());
      setDone(true);
    } catch (problem) {
      toast(problem.message || "Could not send feedback");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        maxHeight: "85vh", overflowY: "auto",
      }}>
        {done ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🙏</div>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Thank you!</div>
            <div style={{ fontSize: 13.5, color: G.muted, marginBottom: 18 }}>
              Your feedback helps us make TalkEx better.
            </div>
            <Button onClick={onClose} style={{ width: "100%" }}>Done</Button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Send feedback</div>
            <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 16 }}>
              Tap an answer for each — it only takes a minute.
            </div>

            {FEEDBACK_QUESTIONS.map((item, index) => (
              <div key={item.key} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>
                  {index + 1}. {item.q}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {item.options.map((option) => {
                    const active = answers[item.key] === option;
                    return (
                      <button key={option}
                        onClick={() => setAnswers((current) => ({ ...current, [item.key]: option }))}
                        style={{
                          padding: "6px 12px", borderRadius: 16, fontSize: 12.5, cursor: "pointer",
                          border: `1px solid ${active ? G.accent : G.border}`,
                          background: active ? G.accent : "transparent",
                          color: active ? "#fff" : G.text, fontWeight: active ? 600 : 400,
                        }}>{option}</button>
                    );
                  })}
                </div>
              </div>
            ))}

            <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>
              Any suggestions or issues? (optional)
            </div>
            <textarea value={comment} onChange={(event) => setComment(event.target.value)}
                      placeholder="Type your feedback here…" maxLength={2000} rows={4} style={{
              width: "100%", padding: "10px 12px", borderRadius: 12, resize: "vertical",
              background: G.dim, border: `1px solid ${G.border}`, color: G.text,
              fontSize: 13.5, outline: "none", boxSizing: "border-box", fontFamily: "inherit",
              marginBottom: 16,
            }}/>

            <div style={{ display: "flex", gap: 10 }}>
              <Button onClick={submit} disabled={busy} style={{ flex: 1 }}>
                {busy ? "Sending…" : "Submit feedback"}
              </Button>
              <Button variant="ghost" onClick={onClose} style={{ flex: 1 }}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


// ── TalkEx Blog ─────────────────────────────────────────────────────────────

const BLOG_POSTS = [
  {
    title: "Welcome to TalkEx",
    date: "2026",
    body: "TalkEx is a fast, secure messenger built in Bihar for the world — chat, voice & video calls, status updates, channels, communities and meetings, all in one app. Everything is end-to-end encrypted, and it runs on your phone as well as right in your web browser.",
  },
  {
    title: "Earn your Blue Tick by inviting friends",
    date: "2026",
    body: "Invite friends to TalkEx with your personal invite link. Once 10 new people join through your link, a blue tick is added to your profile automatically — a thank-you for helping the community grow. Find your link under Settings → Invite a friend.",
  },
  {
    title: "Install TalkEx as an app",
    date: "2026",
    body: "TalkEx is a Progressive Web App — you can install it straight from your browser and it opens like a native app, even working offline for the parts that don't need a connection. Look for 'Install TalkEx app' in Settings, or your browser's install prompt.",
  },
  {
    title: "Channels & Communities",
    date: "2026",
    body: "Broadcast to any audience with Channels, and bring related groups together under one roof with Communities. Share your channel with a link or a QR code so anyone can join in a tap.",
  },
];

function BlogSheet({ onClose }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22,
        maxHeight: "85vh", overflowY: "auto",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>TalkEx Blog</div>
          <div onClick={onClose} style={{ cursor: "pointer", color: G.muted, fontSize: 20 }}>✕</div>
        </div>
        {BLOG_POSTS.map((post) => (
          <div key={post.title} style={{
            padding: "14px 0", borderBottom: `1px solid ${G.border}`,
          }}>
            <div style={{ fontSize: 15.5, fontWeight: 700, marginBottom: 2 }}>{post.title}</div>
            <div style={{ fontSize: 11.5, color: G.muted, marginBottom: 8 }}>{post.date}</div>
            <div style={{ fontSize: 13.5, color: G.text, lineHeight: 1.55 }}>{post.body}</div>
          </div>
        ))}
        <div style={{ fontSize: 12, color: G.muted, textAlign: "center", marginTop: 16 }}>
          More stories coming soon — TalkEx, made from Bihar 💙💚
        </div>
      </div>
    </div>
  );
}
