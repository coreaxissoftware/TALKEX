import { useEffect, useState } from "react";
import { Chats, Meetings, Scheduled, meetingLink } from "../api.js";
import {
  Button, Field, G, I, Spinner, countdown, localInputToUnix, unixToLocalInput, whenLabel,
} from "../ui.jsx";
import { MeetingSheet } from "./ChatView.jsx";

/**
 * Everything with a time attached: queued messages and upcoming meetings.
 *
 * These are two different tables on the server but one idea to a person — "what
 * have I got waiting" — so they share a screen.
 */
export default function Planner({ toast, onOpenChat, chats, onJoinCall, me }) {
  const [tab, setTab] = useState("meetings");
  const [meetings, setMeetings] = useState([]);
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState(null);
  const [pickingChat, setPickingChat] = useState(false); // false | 'instant' | 'schedule'
  const [schedulingChat, setSchedulingChat] = useState(null);

  function reload() {
    setLoading(true);
    Promise.all([Meetings.mine(true), Scheduled.list()])
      .then(([upcoming, pending]) => { setMeetings(upcoming); setQueue(pending); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  const chatName = (chatId) => {
    const chat = chats.find((candidate) => candidate.id === chatId);
    return chat?.name || (chat?.type === "dm" ? "Direct message" : "chat");
  };

  async function shareLink(meeting) {
    const url = meetingLink(meeting.id);
    try {
      if (navigator.share) {
        await navigator.share({ url, text: `Join "${meeting.title}" on TalkEx` });
      } else {
        await navigator.clipboard.writeText(url);
        toast("Meeting link copied");
      }
    } catch (problem) {
      if (problem?.name !== "AbortError") toast("Could not share the link");
    }
  }

  // "Join now" always goes through /start first — a no-op if it's already
  // live, but the thing that actually moves a still-scheduled meeting there
  // the moment anyone taps it, exactly like Zoom/Meet start on first join
  // rather than requiring the host to click a separate "Start" button.
  async function joinMeeting(meeting) {
    if (meeting.has_password) {
      const password = window.prompt("This meeting has a password:");
      if (password === null) return; // cancelled
      try {
        await Meetings.start(meeting.id);
        onJoinCall(meeting.chat_id, "video", password);
      } catch (problem) {
        toast(problem.message || "Could not join the meeting");
      }
      return;
    }
    try {
      await Meetings.start(meeting.id);
      onJoinCall(meeting.chat_id, "video");
    } catch (problem) {
      toast(problem.message || "Could not join the meeting");
    }
  }

  async function startInstant(chat) {
    setPickingChat(false);
    try {
      await Meetings.startInstant(chat.id, `${chat.name || "Instant"} meeting`);
      onJoinCall(chat.id, "video");
      reload();
    } catch (problem) {
      toast(problem.message || "Could not start the meeting");
    }
  }

  function pickChatToSchedule(chat) {
    setPickingChat(false);
    setSchedulingChat(chat);
  }

  // Cancelling/ending is host-only server-side (main.py's cancel_meeting /
  // end_meeting both 403 anyone else) — the button is hidden for everyone
  // but the host to match, rather than letting a non-host tap it and land
  // on a confusing permission error.
  async function cancelMeeting(meeting) {
    if (!window.confirm("Cancel this meeting for everyone?")) return;
    try {
      await Meetings.cancel(meeting.id);
      toast("Meeting cancelled");
      reload();
    } catch (problem) {
      toast(problem.message || "Could not cancel the meeting");
    }
  }

  async function endMeeting(meeting) {
    if (!window.confirm("End this meeting for everyone?")) return;
    try {
      await Meetings.end(meeting.id);
      toast("Meeting ended");
      reload();
    } catch (problem) {
      toast(problem.message || "Could not end the meeting");
    }
  }

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <div style={{ padding: "16px 16px 0", display: "flex", gap: 8 }}>
        <Button onClick={() => setPickingChat("instant")} style={{ flex: 1 }}>
          🎥 Start instant meeting
        </Button>
        <Button onClick={() => setPickingChat("schedule")} variant="ghost" style={{ flex: 1 }}>
          📅 Schedule meeting
        </Button>
      </div>

      <div style={{ display: "flex", gap: 6, padding: 16 }}>
        {[["meetings", "Meetings"], ["queue", "Scheduled"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            style={{
              flex: 1, padding: "9px", borderRadius: 10, cursor: "pointer",
              fontSize: 13.5, fontWeight: 600,
              border: `1px solid ${tab === key ? G.accent : G.border}`,
              background: tab === key ? G.accentSoft : "transparent",
              color: tab === key ? G.accentText : G.sub,
            }}>{label}</button>
        ))}
      </div>

      {loading && <Spinner/>}

      {!loading && tab === "meetings" && (
        meetings.length === 0
          ? <Empty text="No meetings coming up. Open a chat and tap the calendar icon."/>
          : meetings.map((meeting) => (
            <div key={meeting.id} style={{
              padding: "14px 16px", borderBottom: `1px solid ${G.border}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1, fontSize: 15, fontWeight: 600 }}>{meeting.title}</div>
                <StatusChip status={meeting.status}/>
              </div>
              <div style={{ fontSize: 12.5, color: G.sub, marginTop: 4 }}>
                {whenLabel(meeting.starts_at)} · {countdown(meeting.starts_at)} ·
                {" "}{meeting.duration_min} min
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                <div style={{ flex: 1, fontSize: 12, color: G.muted }}>
                  in {chatName(meeting.chat_id)} · {meeting.going_count} going
                </div>
                {meeting.status !== "cancelled" && meeting.status !== "ended" && (
                  <div onClick={() => shareLink(meeting)} title="Copy/share meeting link"
                       style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                    {I.link(G.accentText, 14)}
                    <span style={{ fontSize: 11.5, color: G.accentText }}>Link</span>
                  </div>
                )}
                <div onClick={() => Meetings.downloadIcs(meeting.id)}
                     title="Add to calendar (.ics)"
                     style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  {I.calendar(G.accentText, 14)}
                  <span style={{ fontSize: 11.5, color: G.accentText }}>Add to calendar</span>
                </div>
              </div>

              {meeting.status === "scheduled" && (
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  {["going", "maybe", "declined"].map((option) => (
                    <button key={option}
                      onClick={async () => {
                        await Meetings.rsvp(meeting.id, option);
                        reload();
                      }}
                      style={{
                        flex: 1, padding: "7px", borderRadius: 9, fontSize: 12,
                        cursor: "pointer",
                        border: `1px solid ${meeting.my_response === option ? G.accent : G.border}`,
                        background: meeting.my_response === option ? G.accentSoft : "transparent",
                        color: meeting.my_response === option ? G.accentText : G.sub,
                      }}>
                      {option === "going" ? "Going" : option === "maybe" ? "Maybe" : "Can't"}
                    </button>
                  ))}
                </div>
              )}

              {(meeting.status === "scheduled" || meeting.status === "live") && (
                <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                  <Button onClick={() => joinMeeting(meeting)} style={{
                    flex: 1, padding: "8px",
                    background: meeting.status === "live" ? G.green : undefined,
                  }}>
                    {meeting.status === "live" ? "Join now — live" : "Join now"}
                  </Button>
                  {meeting.host_id === me?.id && meeting.status === "scheduled" && (
                    <Button variant="danger" onClick={() => cancelMeeting(meeting)}
                            style={{ padding: "8px 14px" }}>Cancel</Button>
                  )}
                  {meeting.host_id === me?.id && meeting.status === "live" && (
                    <Button variant="danger" onClick={() => endMeeting(meeting)}
                            style={{ padding: "8px 14px" }}>End</Button>
                  )}
                </div>
              )}
            </div>
          ))
      )}

      {!loading && tab === "queue" && (
        queue.filter((item) => item.status === "pending").length === 0 &&
        queue.filter((item) => item.status === "failed").length === 0
          ? <Empty text="Nothing scheduled. Tap the clock icon in a chat to queue a message."/>
          : (
            <>
              {queue.filter((item) => item.status === "pending").map((item) => (
                <div key={item.id} style={{
                  padding: "14px 16px", borderBottom: `1px solid ${G.border}`,
                }}>
                  <div style={{ fontSize: 14.5 }}>{item.text}</div>
                  <div style={{ fontSize: 12, color: G.yellow, marginTop: 4 }}>
                    {whenLabel(item.send_at)} · {countdown(item.send_at)} ·
                    {" "}to {chatName(item.chat_id)}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <Button variant="ghost" style={{ flex: 1, padding: "7px" }}
                            onClick={() => setEditingItem(item)}>Reschedule</Button>
                    <Button variant="danger" style={{ flex: 1, padding: "7px" }}
                            onClick={async () => {
                              await Scheduled.cancel(item.id);
                              toast("Cancelled");
                              reload();
                            }}>Cancel</Button>
                  </div>
                </div>
              ))}

              {/* Failures are shown rather than hidden — a message that silently
                  never sent is worse than one you can see failed and why. */}
              {queue.filter((item) => item.status === "failed").map((item) => (
                <div key={item.id} style={{
                  padding: "14px 16px", borderBottom: `1px solid ${G.border}`,
                  background: `${G.red}10`,
                }}>
                  <div style={{ fontSize: 14.5 }}>{item.text}</div>
                  <div style={{ fontSize: 12, color: G.red, marginTop: 4 }}>
                    Not sent — {item.error}
                  </div>
                </div>
              ))}
            </>
          )
      )}

      {editingItem && (
        <RescheduleSheet item={editingItem} onClose={() => setEditingItem(null)}
                         onDone={() => { setEditingItem(null); reload(); }} toast={toast}/>
      )}
      {pickingChat && (
        <ChatPickerSheet chats={chats} onClose={() => setPickingChat(false)}
                        onPick={pickingChat === "instant" ? startInstant : pickChatToSchedule}/>
      )}
      {schedulingChat && (
        <MeetingSheet chat={schedulingChat} toast={toast}
                     onClose={() => setSchedulingChat(null)}
                     onCreated={() => {
                       reload();
                       if (["group", "channel", "community"].includes(schedulingChat.type)
                           && confirm("Share this meeting's link now?")) {
                         Chats.createInvite(schedulingChat.id)
                           .then(async ({ invite_code: code }) => {
                             const url = `${window.location.origin}/?invite=${code}`;
                             if (navigator.share) await navigator.share({ url, text: `Join ${schedulingChat.name || "the chat"} on TalkEx` });
                             else { await navigator.clipboard.writeText(url); toast("Link copied"); }
                           })
                           .catch((problem) => toast(problem.message || "Could not create a link"));
                       }
                     }}/>
      )}
    </div>
  );
}

function ChatPickerSheet({ chats, onClose, onPick }) {
  const eligible = chats.filter((chat) => !chat.archived);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000000aa", zIndex: 60,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: G.surface, padding: 20,
        borderTopLeftRadius: 22, borderTopRightRadius: 22, maxHeight: "70vh", overflowY: "auto",
      }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Start a meeting in…</div>
        <div style={{ fontSize: 12.5, color: G.muted, marginBottom: 14 }}>
          Everyone currently in that chat is invited straight away.
        </div>
        {eligible.length === 0 ? (
          <div style={{ fontSize: 13, color: G.muted, padding: "10px 0" }}>No chats yet</div>
        ) : eligible.map((chat) => (
          <div key={chat.id} onClick={() => onPick(chat)} style={{
            display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", cursor: "pointer",
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: "50%", background: chat.color || G.accent,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "#fff", fontSize: 14, fontWeight: 700, flexShrink: 0,
            }}>{(chat.avatar_letter || chat.name || "?")[0]}</div>
            <div style={{ fontSize: 14 }}>{chat.name || "Direct message"}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty({ text }) {
  return (
    <div style={{ padding: 40, textAlign: "center", color: G.muted, fontSize: 13.5 }}>
      {text}
    </div>
  );
}

function StatusChip({ status }) {
  const colors = {
    scheduled: G.sub, live: G.green, ended: G.muted, cancelled: G.red,
  };
  return (
    <span style={{
      fontSize: 11, padding: "3px 8px", borderRadius: 10,
      background: `${colors[status]}22`, color: colors[status],
      border: `1px solid ${colors[status]}44`,
    }}>{status}</span>
  );
}

function RescheduleSheet({ item, onClose, onDone, toast }) {
  const [when, setWhen] = useState(unixToLocalInput(item.send_at));
  const [text, setText] = useState(item.text);
  const [busy, setBusy] = useState(false);

  async function save() {
    const sendAt = localInputToUnix(when);
    if (sendAt <= Date.now() / 1000) { toast("Pick a time in the future"); return; }
    setBusy(true);
    try {
      await Scheduled.update(item.id, { send_at: sendAt, text: text.trim() });
      toast("Rescheduled");
      onDone();
    } catch (problem) {
      // The server refuses if the scheduler sent it between opening this sheet
      // and saving — which is exactly the race worth reporting honestly.
      toast(problem.message || "Could not reschedule");
      onDone();
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
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 14 }}>
          Reschedule
        </div>
        <Field label="Message" value={text} onChange={(event) => setText(event.target.value)}/>
        <Field label="Send at" type="datetime-local" value={when}
               onChange={(event) => setWhen(event.target.value)}/>
        <Button onClick={save} disabled={busy} style={{ width: "100%" }}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
