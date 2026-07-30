import { useEffect, useState } from "react";
import { Meetings, Scheduled } from "../api.js";
import {
  Button, Field, G, I, Spinner, countdown, localInputToUnix, unixToLocalInput, whenLabel,
} from "../ui.jsx";

/**
 * Everything with a time attached: queued messages and upcoming meetings.
 *
 * These are two different tables on the server but one idea to a person — "what
 * have I got waiting" — so they share a screen.
 */
export default function Planner({ toast, onOpenChat, chats }) {
  const [tab, setTab] = useState("meetings");
  const [meetings, setMeetings] = useState([]);
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingItem, setEditingItem] = useState(null);

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

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
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
