import { useEffect, useRef, useState } from "react";
import { Chats } from "../api.js";
import { Av, Button, G, I, useCallLayout } from "../ui.jsx";
import { AudioOutputPicker, CallButton, MoreMenu, VideoTag, canPickAudioOutput, mmss } from "./CallOverlay.jsx";
import { useCallRecording } from "../useCallRecording.js";

/** Any current participant can add people; a chat member already in the
 * call or already in `existingIds` (the call's own participants) is
 * filtered out client-side, and the server re-checks calling_permitted()
 * for each target regardless. */
function AddPeoplePicker({ chatId, existingIds, onAdd, onClose }) {
  const [members, setMembers] = useState(null);
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    Chats.get(chatId).then((chat) => setMembers(chat.members || [])).catch(() => setMembers([]));
  }, [chatId]);

  const candidates = (members || []).filter((m) => !existingIds.includes(m.id));

  function toggle(userId) {
    setSelected((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#182234", borderTopLeftRadius: 20,
        borderTopRightRadius: 20, padding: "18px 14px 24px", color: "#fff",
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Add people to this call</div>
        {members === null ? (
          <div style={{ fontSize: 13, color: "#ffffff88" }}>Loading…</div>
        ) : candidates.length === 0 ? (
          <div style={{ fontSize: 13, color: "#ffffff88" }}>Everyone in this chat is already here.</div>
        ) : (
          <div style={{ maxHeight: 280, overflowY: "auto", marginBottom: 14 }}>
            {candidates.map((person) => (
              <label key={person.id} onClick={(e) => e.stopPropagation()} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 4px", cursor: "pointer",
              }}>
                <input type="checkbox" checked={selected.includes(person.id)}
                       onChange={() => toggle(person.id)}/>
                <Av av={person.avatar_letter} color={person.color} size={30}/>
                <div style={{ fontSize: 13.5 }}>{person.name}</div>
              </label>
            ))}
          </div>
        )}
        <button onClick={() => { onAdd(selected); onClose(); }} disabled={selected.length === 0}
                style={{
                  width: "100%", padding: 12, borderRadius: 10, border: "none", cursor: "pointer",
                  background: selected.length ? G.accent : "#ffffff26",
                  color: "#fff", fontWeight: 600, opacity: selected.length ? 1 : 0.6,
                }}>
          {selected.length ? `Add (${selected.length})` : "Select someone to add"}
        </button>
      </div>
    </div>
  );
}

/**
 * Splits everyone currently on the call into N new rooms. Assignment is
 * auto (round-robin) rather than drag-and-drop — simpler, and reassignable
 * any time by just running this again (a second call just creates a fresh
 * batch of rooms; the old ones are still ordinary group chats, never
 * deleted, just no longer what "the" breakout rooms are).
 */
function BreakoutRoomsSetup({ chatId, myUserId, participants, onClose }) {
  const [roomCount, setRoomCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const everyone = [myUserId, ...Object.keys(participants)];

  async function create() {
    setBusy(true);
    setError("");
    const assignments = {};
    everyone.forEach((userId, i) => { assignments[userId] = i % roomCount; });
    try {
      await Chats.createBreakoutRooms(chatId, assignments);
      onClose();
    } catch (problem) {
      setError(problem.message || "Could not create breakout rooms");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#182234", borderTopLeftRadius: 20,
        borderTopRightRadius: 20, padding: "18px 14px 24px", color: "#fff",
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Breakout rooms</div>
        <div style={{ fontSize: 12.5, color: "#ffffff88", marginBottom: 16 }}>
          Splits everyone here evenly into new rooms — each shows up as a "Join" prompt on their screen.
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <span style={{ fontSize: 13 }}>Number of rooms</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
            <button onClick={() => setRoomCount((n) => Math.max(2, n - 1))} style={{
              width: 28, height: 28, borderRadius: "50%", border: "1px solid #ffffff33",
              background: "transparent", color: "#fff", cursor: "pointer", fontSize: 16,
            }}>−</button>
            <span style={{ fontSize: 15, fontWeight: 700, minWidth: 16, textAlign: "center" }}>{roomCount}</span>
            <button onClick={() => setRoomCount((n) => Math.min(everyone.length, n + 1))} style={{
              width: 28, height: 28, borderRadius: "50%", border: "1px solid #ffffff33",
              background: "transparent", color: "#fff", cursor: "pointer", fontSize: 16,
            }}>+</button>
          </div>
        </div>
        {error && <div style={{ fontSize: 12.5, color: "#ff8080", marginBottom: 12 }}>{error}</div>}
        <button onClick={create} disabled={busy || roomCount < 2} style={{
          width: "100%", padding: 12, borderRadius: 10, border: "none", cursor: "pointer",
          background: G.accent, color: "#fff", fontWeight: 600, opacity: busy ? 0.6 : 1,
        }}>
          {busy ? "Creating…" : `Create ${roomCount} rooms`}
        </button>
      </div>
    </div>
  );
}

function ParticipantsList({ call, isHost, onKick, onClose }) {
  const others = Object.entries(call.participants);
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#182234", borderTopLeftRadius: 20,
        borderTopRightRadius: 20, padding: "18px 14px 24px", color: "#fff", maxHeight: "70vh", overflowY: "auto",
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          Participants ({others.length + 1})
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px" }}>
          <Av av="Y" color={G.accent} size={34}/>
          <div style={{ flex: 1, fontSize: 13.5 }}>You{isHost ? " · host" : ""}</div>
          {call.muted && I.micOff("#ffffff88", 15)}
          {call.handRaised && <span style={{ fontSize: 15 }}>✋</span>}
        </div>
        {others.map(([userId, participant]) => (
          <div key={userId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 4px" }}>
            <Av av={participant.avatar} color={participant.color} size={34}/>
            <div style={{ flex: 1, fontSize: 13.5 }}>{participant.name}</div>
            {participant.handRaised && <span style={{ fontSize: 15 }}>✋</span>}
            {isHost && (
              <div onClick={() => onKick(userId)} title="Remove from call" style={{
                cursor: "pointer", color: "#ff8080", fontSize: 12.5, marginLeft: 8,
              }}>Remove</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The group-call counterpart to CallOverlay — same full-screen mount point,
 * same button styling, but a grid of participants instead of one peer.
 * Kept as a separate component/hook pair from the 1:1 call rather than
 * generalizing one to cover both: a 1:1 call is a fixed pair with ringing
 * semantics (invite/accept/reject/busy), a group call is an open room
 * anyone can join or leave at any moment — forcing both into one state
 * machine would have made the simpler, already-shipped 1:1 path harder to
 * reason about for no real benefit.
 */
export default function GroupCallOverlay({
  call, myUserId, onAccept, onDecline, onLeave, onToggleMute, onToggleCamera, onShareScreen,
  onSetScreenOptimization,
  onForceMuteAll, onKickParticipant, onAddPeople, onToggleWhiteboard, events, send,
  onSendReaction, onToggleRaiseHand, onToggleCaptions, onCaptionText,
  onJoinBreakoutRoom, onReturnToMainCall, onAdmitParticipant, onDenyParticipant,
}) {
  const [sinkId, setSinkId] = useState(undefined);
  const [minimized, setMinimized] = useState(false);
  const { expanded, toggle, isDesktop } = useCallLayout();

  if (!call) return null;

  // Minimizing never touches the call itself — no leave(), no torn-down
  // peer connections — it's purely "don't cover the chat right now." The
  // audio keeps playing either way; only the video grid and controls stop
  // being drawn.
  if (minimized && call.phase !== "incoming") {
    return (
      <div onClick={() => setMinimized(false)} style={{
        position: "fixed", bottom: 90, right: 16, zIndex: 999, cursor: "pointer",
        display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 8px 8px",
        background: "#182234", color: "#fff", borderRadius: 30,
        boxShadow: "0 4px 16px #00000055", border: "1px solid #ffffff26",
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: "50%", background: G.accent,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>{call.muted ? I.micOff("#fff", 14) : I.phone("#fff", 14)}</div>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>Call in progress · tap to return</span>
      </div>
    );
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 999, // just under the 1:1 overlay's 1000 — a 1:1 call always wins focus
      maxWidth: expanded ? "none" : 430, margin: "0 auto",
      background: "#0b1220", color: "#fff",
      display: "flex", flexDirection: "column",
    }}>
      {isDesktop && (
        <div onClick={toggle} title={expanded ? "Exit full screen" : "Full screen"} style={{
          position: "absolute", top: 14, right: 14, zIndex: 1,
          width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
          background: "#ffffff1a", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {expanded ? I.shrink("#fff", 16) : I.expand("#fff", 16)}
        </div>
      )}
      {call.phase === "incoming"
        ? <IncomingGroupCall call={call} onAccept={onAccept} onDecline={onDecline}/>
        : call.phase === "waiting"
        ? <WaitingForHost call={call} onLeave={onLeave}/>
        : <ActiveGroupCall call={call} myUserId={myUserId} onLeave={onLeave} onToggleMute={onToggleMute}
                           onToggleCamera={onToggleCamera} onShareScreen={onShareScreen}
                           onSetScreenOptimization={onSetScreenOptimization}
                           onForceMuteAll={onForceMuteAll} onKickParticipant={onKickParticipant}
                           onAddPeople={onAddPeople} onToggleWhiteboard={onToggleWhiteboard}
                           onSendReaction={onSendReaction} onToggleRaiseHand={onToggleRaiseHand}
                           onToggleCaptions={onToggleCaptions} onCaptionText={onCaptionText}
                           onJoinBreakoutRoom={onJoinBreakoutRoom} onReturnToMainCall={onReturnToMainCall}
                           onMinimize={() => setMinimized(true)}
                           onAdmitParticipant={onAdmitParticipant} onDenyParticipant={onDenyParticipant}
                           events={events} send={send}
                           sinkId={sinkId} onSinkId={setSinkId}/>}
    </div>
  );
}

function WaitingForHost({ call, onLeave }) {
  return (
    <>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <div style={{
          width: 64, height: 64, borderRadius: "50%", background: "#ffffff1a",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28,
        }}>⏳</div>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Waiting for the host to let you in…</div>
        <div style={{ fontSize: 13, color: "#ffffffaa" }}>This meeting has a waiting room turned on.</div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", padding: "0 40px 60px" }}>
        <CallButton onClick={onLeave} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Cancel"/>
      </div>
    </>
  );
}

function IncomingGroupCall({ call, onAccept, onDecline }) {
  return (
    <>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 80 }}>
        <Av av={call.inviterAvatar} color={call.inviterColor} size={100}/>
        <div style={{ fontSize: 20, fontWeight: 600 }}>{call.inviterName} started a call</div>
        <div style={{ fontSize: 14, color: "#ffffffaa" }}>
          Incoming group {call.callKind === "video" ? "video" : "voice"} call…
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-around", padding: "0 40px 60px" }}>
        <CallButton onClick={onDecline} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Decline"/>
        <CallButton onClick={onAccept} background="#22c55e" icon={I.phone("#fff", 24)} label="Join"/>
      </div>
    </>
  );
}

const REACTION_EMOJIS = ["👍", "❤️", "👏", "😂", "🎉"];

// Chrome/Edge only (no Firefox/Safari) — the same shape of gate as
// canPickAudioOutput in CallOverlay.jsx: feature-detected once, everywhere
// else just trusts it rather than re-checking.
const canUseSpeechRecognition = typeof window !== "undefined"
  && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

/**
 * Non-visual — owns the browser's local SpeechRecognition instance and
 * hands each finished phrase up via onText. There is no server-side speech
 * pipeline anywhere in this app: every participant's browser transcribes
 * only its OWN microphone, which is also the only audio the Web Speech API
 * can actually listen to from a web page.
 */
function LiveCaptions({ enabled, onText }) {
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (!enabled || !canUseSpeechRecognition) return;
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (result.isFinal) onText(result[0].transcript.trim());
    };
    recognition.onend = () => {
      // Chrome stops a continuous session on its own after a while — restart
      // for as long as captions are still meant to be on.
      if (recognitionRef.current === recognition) {
        try { recognition.start(); } catch { /* already starting */ }
      }
    };
    recognition.onerror = () => {};
    try { recognition.start(); } catch { /* a mic permission prompt already in flight, etc. */ }
    recognitionRef.current = recognition;

    return () => {
      recognitionRef.current = null;
      recognition.stop();
    };
  }, [enabled, onText]);

  return null;
}

function ActiveGroupCall({
  call, myUserId, onLeave, onToggleMute, onToggleCamera, onShareScreen,
  onSetScreenOptimization,
  onForceMuteAll, onKickParticipant, onAddPeople, onToggleWhiteboard,
  onSendReaction, onToggleRaiseHand, onToggleCaptions, onCaptionText,
  onJoinBreakoutRoom, onReturnToMainCall, onMinimize,
  onAdmitParticipant, onDenyParticipant, events, send,
  sinkId, onSinkId,
}) {
  const [showSpeakerPicker, setShowSpeakerPicker] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [showBreakoutSetup, setShowBreakoutSetup] = useState(false);
  const [showAnnotate, setShowAnnotate] = useState(false);
  const [closingBreakout, setClosingBreakout] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const recorder = useCallRecording(call);
  const others = Object.entries(call.participants);
  const tileCount = others.length + 1; // + yourself
  const columns = tileCount <= 2 ? 1 : 2;
  const isHost = myUserId != null && call.hostId === myUserId;

  return (
    <>
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        <div style={{
          height: "100%", display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 2, padding: 2, overflow: "hidden",
        }}>
          <SelfTile call={call} isHost={isHost}/>
          {others.map(([userId, participant]) => (
            <ParticipantTile key={userId} participant={participant} sinkId={sinkId}
                             canKick={isHost} onKick={() => onKickParticipant(userId)}/>
          ))}
        </div>
        <ReactionOverlay reaction={call.lastReaction}/>
        {recorder.recording && (
          <div style={{
            position: "absolute", top: 10, left: 10, display: "flex", alignItems: "center", gap: 6,
            background: "#00000088", padding: "4px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444" }}/>
            REC {mmss(recorder.elapsed)}
          </div>
        )}
        {call.captionsOn && call.captions?.length > 0 && (
          <div style={{
            position: "absolute", bottom: 8, left: 8, right: 8, display: "flex",
            flexDirection: "column", gap: 2, pointerEvents: "none",
          }}>
            {call.captions.map((line) => (
              <div key={line.key} style={{
                background: "#000000aa", color: "#fff", fontSize: 12.5, padding: "4px 10px",
                borderRadius: 8, alignSelf: "flex-start",
              }}><b>{line.from === "me" ? "You" : line.from}:</b> {line.text}</div>
            ))}
          </div>
        )}
      </div>
      <LiveCaptions enabled={Boolean(call.captionsOn)} onText={onCaptionText}/>

      {(() => {
        const myRoom = call.breakoutRooms?.find((r) => r.member_ids.includes(myUserId));
        if (!myRoom) return null;
        return (
          <div style={{
            display: "flex", alignItems: "center", gap: 10, margin: "0 16px 10px", padding: "10px 14px",
            background: "#22c55e22", border: "1px solid #22c55e55", borderRadius: 12,
          }}>
            <div style={{ flex: 1, fontSize: 13 }}>You've been moved to <b>{myRoom.name}</b></div>
            <Button onClick={() => onJoinBreakoutRoom(myRoom.chat_id, call.chatId, call.callKind)}
                    style={{ padding: "7px 14px" }}>Join</Button>
          </div>
        );
      })()}
      {call.breakoutRoomsClosed && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, margin: "0 16px 10px", padding: "10px 14px",
          background: "#facc1522", border: "1px solid #facc1555", borderRadius: 12,
        }}>
          <div style={{ flex: 1, fontSize: 13 }}>Breakout rooms have ended</div>
          <Button onClick={onReturnToMainCall} style={{ padding: "7px 14px" }}>Return to main call</Button>
        </div>
      )}

      {(call.joinRequests || []).map((request) => (
        <div key={request.user_id} style={{
          display: "flex", alignItems: "center", gap: 10, margin: "0 16px 10px", padding: "10px 14px",
          background: "#38bdf822", border: "1px solid #38bdf855", borderRadius: 12,
        }}>
          <Av av={request.avatar} color={request.color} size={28}/>
          <div style={{ flex: 1, fontSize: 13 }}><b>{request.name}</b> wants to join</div>
          <div onClick={() => onDenyParticipant(request.user_id)} style={{
            cursor: "pointer", fontSize: 12.5, color: "#ff8080", padding: "6px 10px",
          }}>Deny</div>
          <Button onClick={() => onAdmitParticipant(request.user_id)} style={{ padding: "6px 12px" }}>Admit</Button>
        </div>
      ))}

      {call.sharingScreen && (
        <div style={{
          alignSelf: "center", margin: "0 0 8px", padding: "5px 10px", borderRadius: 8,
          background: "#ef444422", border: "1px solid #ef444455", color: "#ff8080",
          fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
        }}>{I.screenShare("#ff8080", 13)} Sharing screen</div>
      )}

      <div style={{ display: "flex", justifyContent: "center", gap: 16, padding: "16px 20px 60px", flexWrap: "wrap" }}>
        <CallButton onClick={onToggleMute} background={call.muted ? "#fff" : "#ffffff26"}
                    icon={call.muted ? I.micOff("#0b1220", 20) : I.mic("#fff", 20)} label="Mute" small/>
        <CallButton onClick={onToggleCamera} background={call.cameraOff ? "#fff" : "#ffffff26"}
                    icon={call.cameraOff ? I.videoOff("#0b1220", 20) : I.video("#fff", 20)}
                    label={call.callKind === "video" ? "Camera" : "Video"} small/>
        <CallButton onClick={() => setShowReactions((v) => !v)} background="#ffffff26"
                    icon={<span style={{ fontSize: 20 }}>😊</span>} label="React" small/>
        <CallButton onClick={onToggleRaiseHand} background={call.handRaised ? "#facc15" : "#ffffff26"}
                    icon={<span style={{ fontSize: 20 }}>✋</span>} label="Hand" small/>
        <CallButton onClick={onMinimize} background="#ffffff26"
                    icon={<span style={{ fontSize: 18 }}>💬</span>} label="Chat" small/>
        {canPickAudioOutput && (
          <CallButton onClick={() => setShowSpeakerPicker(true)} background="#ffffff26"
                      icon={I.volume("#fff", 20)} label="Speaker" small/>
        )}
        <CallButton onClick={() => setShowMore(true)} background="#ffffff26"
                    icon={I.moreVertical("#fff", 20)} label="More" small/>
        <CallButton onClick={onLeave} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Leave"/>
      </div>

      {showReactions && (
        <div onClick={() => setShowReactions(false)} style={{
          position: "fixed", inset: 0, zIndex: 1100,
        }}>
          <div onClick={(event) => event.stopPropagation()} style={{
            position: "absolute", bottom: 130, left: "50%", transform: "translateX(-50%)",
            display: "flex", gap: 8, background: "#182234", border: "1px solid #ffffff26",
            borderRadius: 30, padding: "10px 14px",
          }}>
            {REACTION_EMOJIS.map((emoji) => (
              <div key={emoji} onClick={() => { onSendReaction(emoji); setShowReactions(false); }}
                   style={{ fontSize: 24, cursor: "pointer" }}>{emoji}</div>
            ))}
          </div>
        </div>
      )}

      {showSpeakerPicker && (
        <AudioOutputPicker current={sinkId} onSelect={onSinkId} onClose={() => setShowSpeakerPicker(false)}/>
      )}
      {showMore && (
        <MoreMenu onClose={() => setShowMore(false)} items={[
          {
            label: call.sharingScreen ? "Stop sharing screen" : "Share screen",
            sub: call.callKind !== "video" ? "Turn your camera on first" : undefined,
            icon: I.screenShare("#fff", 18),
            disabled: call.callKind !== "video",
            onClick: onShareScreen,
          },
          ...(call.sharingScreen ? [{
            label: `Optimize for video ${call.screenOptimizeFor === "motion" ? "●" : "○"}`,
            sub: "Smoother motion, softer detail — best for playing a video",
            icon: <span style={{ fontSize: 15 }}>🎞️</span>,
            onClick: () => onSetScreenOptimization("motion"),
          }, {
            label: `Optimize for text ${call.screenOptimizeFor === "detail" ? "●" : "○"}`,
            sub: "Crisper static frames — best for a document or code",
            icon: <span style={{ fontSize: 15 }}>📄</span>,
            onClick: () => onSetScreenOptimization("detail"),
          }] : []),
          {
            label: "Add people",
            icon: I.user("#fff", 18),
            onClick: () => setShowAddPeople(true),
          },
          {
            label: call.whiteboardOpen ? "Close whiteboard" : "Whiteboard",
            icon: I.edit("#fff", 18),
            onClick: onToggleWhiteboard,
          },
          {
            label: showAnnotate ? "Stop annotating" : "Annotate on shared screen",
            sub: call.sharingScreen ? undefined : "Someone needs to be sharing their screen first",
            icon: <span style={{ fontSize: 15 }}>🖊️</span>,
            disabled: !call.sharingScreen && !showAnnotate,
            onClick: () => setShowAnnotate((v) => !v),
          },
          {
            label: recorder.recording ? "Stop recording" : "Start recording",
            sub: recorder.recording ? undefined : "Saved to your device when you stop — not stored anywhere else",
            icon: <span style={{
              width: 12, height: 12, borderRadius: recorder.recording ? 3 : "50%", background: "#ef4444",
            }}/>,
            onClick: recorder.recording ? recorder.stop : recorder.start,
          },
          {
            label: call.captionsOn ? "Turn off live captions" : "Live captions",
            sub: canUseSpeechRecognition
              ? "Your own speech only — each person's browser transcribes itself"
              : "Not supported in this browser",
            icon: <span style={{ fontSize: 15 }}>💬</span>,
            disabled: !canUseSpeechRecognition,
            onClick: onToggleCaptions,
          },
          {
            label: "Participants",
            icon: I.user("#fff", 18),
            onClick: () => setShowParticipants(true),
          },
          {
            label: "Mute everyone",
            sub: isHost ? undefined : "Only the person who started this call can do that",
            icon: I.micOff("#fff", 18),
            disabled: !isHost,
            onClick: onForceMuteAll,
          },
          {
            label: "Breakout rooms",
            sub: isHost ? undefined : "Only the person who started this call can do that",
            icon: I.user("#fff", 18),
            disabled: !isHost,
            onClick: () => setShowBreakoutSetup(true),
          },
          ...(call.breakoutRooms || call.breakoutParentChatId ? [{
            label: "Close breakout rooms",
            icon: <span style={{ fontSize: 15 }}>↩</span>,
            disabled: closingBreakout,
            onClick: async () => {
              setClosingBreakout(true);
              try { await Chats.closeBreakoutRooms(call.breakoutParentChatId || call.chatId); }
              catch { /* most likely "not the person who created them" — a silent no-op is fine here */ }
              setClosingBreakout(false);
            },
          }] : []),
        ]}/>
      )}
      {showAddPeople && (
        <AddPeoplePicker chatId={call.chatId}
                         existingIds={[myUserId, ...Object.keys(call.participants)]}
                         onAdd={onAddPeople} onClose={() => setShowAddPeople(false)}/>
      )}
      {showParticipants && (
        <ParticipantsList call={call} isHost={isHost} onKick={onKickParticipant}
                          onClose={() => setShowParticipants(false)}/>
      )}
      {call.whiteboardOpen && (
        <Whiteboard chatId={call.chatId} events={events} send={send} onClose={onToggleWhiteboard}/>
      )}
      {showAnnotate && (
        <Whiteboard chatId={call.chatId} events={events} send={send}
                   onClose={() => setShowAnnotate(false)} transparent/>
      )}
      {showBreakoutSetup && (
        <BreakoutRoomsSetup chatId={call.chatId} myUserId={myUserId} participants={call.participants}
                            onClose={() => setShowBreakoutSetup(false)}/>
      )}
    </>
  );
}

function SelfTile({ call, isHost }) {
  const showVideo = call.callKind === "video" && !call.cameraOff && call.localStream;
  return (
    <div style={{
      position: "relative", background: "#142235", borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    }}>
      {showVideo ? (
        <VideoTag stream={call.localStream} muted style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
      ) : (
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: G.accent }}/>
      )}
      {call.handRaised && (
        <div style={{ position: "absolute", top: 6, left: 8, fontSize: 18 }}>✋</div>
      )}
      <div style={{
        position: "absolute", bottom: 6, left: 8, fontSize: 11.5, color: "#ffffffcc",
        background: "#00000066", padding: "2px 8px", borderRadius: 8,
      }}>You{isHost ? " · host" : ""}{call.muted ? " · muted" : ""}</div>
    </div>
  );
}

/**
 * A floating emoji that rises and fades, one per reaction — purely a visual
 * effect, nothing about `reaction` is kept once its animation ends. Keyed by
 * `reaction.key` so the exact same emoji sent twice in a row still mounts a
 * fresh element (React would otherwise treat an unchanged key as "nothing
 * to animate").
 */
function ReactionOverlay({ reaction }) {
  const [visible, setVisible] = useState(null);

  useEffect(() => {
    if (!reaction) return;
    setVisible(reaction);
    const timer = setTimeout(() => setVisible(null), 2000);
    return () => clearTimeout(timer);
  }, [reaction]);

  if (!visible) return null;
  return (
    <div key={visible.key} style={{
      position: "absolute", bottom: 20, left: "50%", fontSize: 42,
      animation: "txFloatUp 2s ease-out forwards", pointerEvents: "none",
    }}>
      {visible.emoji}
      <style>{`@keyframes txFloatUp { 0% { transform: translate(-50%, 0); opacity: 1; } 100% { transform: translate(-50%, -160px); opacity: 0; } }`}</style>
    </div>
  );
}

function ParticipantTile({ participant, sinkId, canKick, onKick }) {
  const hasVideo = participant.stream?.getVideoTracks().length > 0;
  return (
    <div style={{
      position: "relative", background: "#142235", borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    }}>
      {/* Always mounted so this participant's audio plays even with no
          video track (voice call, or their camera's off) — hidden rather
          than unmounted, same reasoning as CallOverlay's remote VideoTag. */}
      <VideoTag stream={participant.stream} sinkId={sinkId} style={hasVideo ? {
        width: "100%", height: "100%", objectFit: "cover",
      } : { display: "none" }}/>
      {!hasVideo && <Av av={participant.avatar} color={participant.color} size={64}/>}
      {participant.handRaised && (
        <div style={{ position: "absolute", top: 6, left: 8, fontSize: 18 }}>✋</div>
      )}
      <div style={{
        position: "absolute", bottom: 6, left: 8, fontSize: 11.5, color: "#ffffffcc",
        background: "#00000066", padding: "2px 8px", borderRadius: 8,
      }}>{participant.name}</div>
      {!participant.stream && (
        <div style={{ position: "absolute", top: 6, right: 8, fontSize: 10.5, color: "#ffffff99" }}>
          connecting…
        </div>
      )}
      {canKick && (
        <div onClick={onKick} title="Remove from call" style={{
          position: "absolute", top: 6, right: 8, width: 22, height: 22, borderRadius: "50%",
          background: "#00000088", color: "#ff8080", fontSize: 15, lineHeight: "22px",
          textAlign: "center", cursor: "pointer",
        }}>×</div>
      )}
    </div>
  );
}

const WHITEBOARD_COLORS = ["#f8fafc", "#ef4444", "#f59e0b", "#22c55e", "#38bdf8", "#a855f7"];

const TOOLS = [
  { key: "pen", label: "Pen", icon: "✏️" },
  { key: "highlighter", label: "Highlighter", icon: "🖍️" },
  { key: "eraser", label: "Eraser", icon: null },
  { key: "line", label: "Line", icon: "／" },
  { key: "rect", label: "Rectangle", icon: "▭" },
  { key: "circle", label: "Circle", icon: "◯" },
  { key: "text", label: "Text", icon: "T" },
  { key: "sticky", label: "Sticky note", icon: "🗒️" },
  { key: "image", label: "Insert image", icon: "🖼️" },
  { key: "laser", label: "Laser pointer", icon: "🔴" },
];

function isLightColor(hex) {
  const value = (hex || "#000000").replace("#", "");
  if (value.length !== 6) return false;
  const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

function wrapCanvasText(context, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  let line = "", lineY = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (context.measureText(test).width > maxWidth && line) {
      context.fillText(line, x, lineY);
      line = word;
      lineY += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) context.fillText(line, x, lineY);
}

/**
 * A shared drawing surface for the meeting, not a persisted document — it
 * exists only as long as the call room does, same as screen share. Two
 * families of mark, both riding the same whiteboard_draw/_clear relay
 * (a bare stroke.kind is missing entirely for the original freehand case,
 * so old and new clients that only understand pen strokes still degrade
 * gracefully — anything with a kind they don't recognize just doesn't
 * render for them instead of crashing):
 *   - freehand (pen/highlighter/eraser): streamed point-to-point exactly
 *     like before, one segment per pointermove.
 *   - shapes/text (line/rect/circle/text): a single message sent once, on
 *     release — there's nothing meaningful to stream mid-drag for "the
 *     rectangle isn't finished yet."
 * Coordinates always travel as 0–1 fractions of canvas size so a mark lines
 * up the same way on every participant's differently-sized screen.
 *
 * `transparent`, when true, is the "annotate on top of the shared screen"
 * mode — same board, same tools, just no opaque background covering the
 * video underneath.
 */
function Whiteboard({ chatId, events, send, onClose, transparent }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const lastPoint = useRef(null);
  const shapeStart = useRef(null);
  const snapshotRef = useRef(null); // canvas pixels at drag-start, for a live shape preview
  const lastAppliedN = useRef(0);
  const [color, setColor] = useState(WHITEBOARD_COLORS[0]);
  const [tool, setTool] = useState("pen");
  const fileInputRef = useRef(null);
  const [laserDots, setLaserDots] = useState({});
  const laserTimers = useRef({});
  const lastLaserSent = useRef(0);

  function ctx() {
    return canvasRef.current?.getContext("2d");
  }

  function resizeCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = canvas;
    canvas.width = clientWidth * dpr;
    canvas.height = clientHeight * dpr;
    ctx()?.scale(dpr, dpr);
  }

  useEffect(() => {
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, []);

  function paintSegment(fromFrac, toFrac, strokeColor, size) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    context.strokeStyle = strokeColor;
    context.lineWidth = size;
    context.lineCap = "round";
    context.globalAlpha = strokeColor === "highlight" ? 0.35 : 1;
    context.globalCompositeOperation = strokeColor === "erase" ? "destination-out" : "source-over";
    context.beginPath();
    context.moveTo(fromFrac.x * w, fromFrac.y * h);
    context.lineTo(toFrac.x * w, toFrac.y * h);
    context.stroke();
    context.globalAlpha = 1;
  }

  function paintShape(shapeType, startFrac, endFrac, strokeColor, size) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const x1 = startFrac.x * w, y1 = startFrac.y * h;
    const x2 = endFrac.x * w, y2 = endFrac.y * h;
    context.strokeStyle = strokeColor;
    context.lineWidth = size;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.beginPath();
    if (shapeType === "line") {
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
    } else if (shapeType === "rect") {
      context.rect(x1, y1, x2 - x1, y2 - y1);
    } else if (shapeType === "circle") {
      const rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
      context.ellipse((x1 + x2) / 2, (y1 + y2) / 2, rx, ry, 0, 0, Math.PI * 2);
    }
    context.stroke();
  }

  function paintText(startFrac, text, strokeColor) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !text) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.fillStyle = strokeColor;
    context.font = "20px sans-serif";
    context.fillText(text, startFrac.x * w, startFrac.y * h);
  }

  function paintSticky(startFrac, text, strokeColor) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !text) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const x = startFrac.x * w, y = startFrac.y * h;
    const boxW = 150, boxH = 96, pad = 10;
    context.globalCompositeOperation = "source-over";
    context.globalAlpha = 1;
    context.fillStyle = strokeColor;
    context.fillRect(x, y, boxW, boxH);
    context.strokeStyle = "#00000022";
    context.lineWidth = 1;
    context.strokeRect(x, y, boxW, boxH);
    context.fillStyle = isLightColor(strokeColor) ? "#1a1a1a" : "#ffffff";
    context.font = "13px sans-serif";
    wrapCanvasText(context, text, x + pad, y + pad + 12, boxW - pad * 2, 16);
  }

  function paintImage(startFrac, dataUrl, sizeFrac) {
    const canvas = canvasRef.current;
    const context = ctx();
    if (!canvas || !context || !dataUrl) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const img = new Image();
    img.onload = () => {
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.drawImage(img, startFrac.x * w, startFrac.y * h, sizeFrac.w * w, sizeFrac.h * h);
    };
    img.src = dataUrl;
  }

  function applyStroke(stroke) {
    if (!stroke) return;
    if (stroke.kind === "shape") {
      paintShape(stroke.shapeType, stroke.start, stroke.end, stroke.color, stroke.size);
    } else if (stroke.kind === "text") {
      paintText(stroke.start, stroke.text, stroke.color);
    } else if (stroke.kind === "sticky") {
      paintSticky(stroke.start, stroke.text, stroke.color);
    } else if (stroke.kind === "image") {
      paintImage(stroke.start, stroke.dataUrl, stroke.size);
    } else {
      paintSegment(stroke.from, stroke.to, stroke.color, stroke.size);
    }
  }

  function showLaserDot(key, point, dotColor) {
    setLaserDots((current) => ({ ...current, [key]: { x: point.x, y: point.y, color: dotColor } }));
    clearTimeout(laserTimers.current[key]);
    laserTimers.current[key] = setTimeout(() => {
      setLaserDots((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }, 900);
  }

  function handleImageFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        const cw = canvas?.clientWidth || 1, ch = canvas?.clientHeight || 1;
        const maxW = 480;
        const scale = Math.min(1, maxW / img.width);
        const drawW = img.width * scale, drawH = img.height * scale;
        const off = document.createElement("canvas");
        off.width = drawW;
        off.height = drawH;
        off.getContext("2d").drawImage(img, 0, 0, drawW, drawH);
        const dataUrl = off.toDataURL("image/jpeg", 0.72);
        const start = { x: Math.max(0, 0.5 - drawW / cw / 2), y: Math.max(0, 0.5 - drawH / ch / 2) };
        const size = { w: drawW / cw, h: drawH / ch };
        paintImage(start, dataUrl, size);
        send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "image", start, size, dataUrl } });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // Remote strokes and clears — read straight from the shared events array
  // rather than going through useGroupCall's state, so a burst of draw
  // points never triggers a re-render of the call UI around this canvas.
  useEffect(() => {
    const fresh = events.filter((event) => event._n > lastAppliedN.current
      && event.chat_id === chatId
      && (event.type === "whiteboard_draw" || event.type === "whiteboard_clear" || event.type === "whiteboard_laser"));
    if (fresh.length === 0) return;
    lastAppliedN.current = events[events.length - 1]._n;
    for (const event of fresh) {
      if (event.type === "whiteboard_clear") {
        const canvas = canvasRef.current;
        ctx()?.clearRect(0, 0, canvas?.clientWidth || 0, canvas?.clientHeight || 0);
      } else if (event.type === "whiteboard_laser") {
        if (event.point) showLaserDot(event.from, event.point, event.point.color || "#ef4444");
      } else {
        applyStroke(event.stroke);
      }
    }
  }, [events, chatId]);

  function pointFromEvent(event) {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  function strokeColorFor() {
    if (tool === "eraser") return "erase";
    if (tool === "highlighter") return "highlight";
    return color;
  }

  function handlePointerDown(event) {
    const point = pointFromEvent(event);
    if (tool === "text") {
      const text = window.prompt("Text:");
      if (text && text.trim()) {
        paintText(point, text.trim(), color);
        send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "text", start: point, text: text.trim(), color } });
      }
      return;
    }
    if (tool === "sticky") {
      const text = window.prompt("Note text:");
      if (text && text.trim()) {
        paintSticky(point, text.trim(), color);
        send({ type: "whiteboard_draw", chat_id: chatId, stroke: { kind: "sticky", start: point, text: text.trim(), color } });
      }
      return;
    }
    drawing.current = true;
    lastPoint.current = point;
    if (["line", "rect", "circle"].includes(tool)) {
      shapeStart.current = point;
      const canvas = canvasRef.current;
      snapshotRef.current = ctx()?.getImageData(0, 0, canvas.width, canvas.height);
    }
  }

  function handlePointerMove(event) {
    if (!drawing.current) return;
    const point = pointFromEvent(event);

    if (tool === "laser") {
      showLaserDot("__self", point, color);
      const now = Date.now();
      if (now - lastLaserSent.current >= 40) {
        lastLaserSent.current = now;
        send({ type: "whiteboard_laser", chat_id: chatId, point: { x: point.x, y: point.y, color } });
      }
      return;
    }

    if (["line", "rect", "circle"].includes(tool)) {
      // A live preview only — restore the pre-drag snapshot each frame so
      // dragging the shape around doesn't leave a trail of every position
      // it passed through.
      if (snapshotRef.current) ctx()?.putImageData(snapshotRef.current, 0, 0);
      paintShape(tool, shapeStart.current, point, color, 3);
      return;
    }

    const size = tool === "highlighter" ? 14 : tool === "eraser" ? 22 : 3;
    const strokeColor = strokeColorFor();
    paintSegment(lastPoint.current, point, strokeColor, size);
    send({
      type: "whiteboard_draw", chat_id: chatId,
      stroke: { from: lastPoint.current, to: point, color: strokeColor, size },
    });
    lastPoint.current = point;
  }

  function handlePointerUp(event) {
    if (drawing.current && ["line", "rect", "circle"].includes(tool) && shapeStart.current) {
      const point = pointFromEvent(event);
      if (snapshotRef.current) ctx()?.putImageData(snapshotRef.current, 0, 0);
      paintShape(tool, shapeStart.current, point, color, 3);
      send({
        type: "whiteboard_draw", chat_id: chatId,
        stroke: { kind: "shape", shapeType: tool, start: shapeStart.current, end: point, color, size: 3 },
      });
    }
    drawing.current = false;
    lastPoint.current = null;
    shapeStart.current = null;
    snapshotRef.current = null;
  }

  function clearBoard() {
    const canvas = canvasRef.current;
    ctx()?.clearRect(0, 0, canvas?.clientWidth || 0, canvas?.clientHeight || 0);
    send({ type: "whiteboard_clear", chat_id: chatId });
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1150, display: "flex", flexDirection: "column",
      background: transparent ? "transparent" : "#0b1220",
      pointerEvents: transparent ? "none" : "auto",
    }}>
      <div style={{ position: "relative", flex: 1, pointerEvents: "auto" }}>
        <canvas ref={canvasRef}
                onPointerDown={handlePointerDown} onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp}
                style={{
                  width: "100%", height: "100%", touchAction: "none",
                  cursor: tool === "laser" ? "none" : "crosshair",
                }}/>
        {Object.entries(laserDots).map(([key, dot]) => (
          <div key={key} style={{
            position: "absolute", left: `${dot.x * 100}%`, top: `${dot.y * 100}%`,
            width: 16, height: 16, marginLeft: -8, marginTop: -8, borderRadius: "50%",
            background: dot.color, boxShadow: `0 0 14px 4px ${dot.color}99`, pointerEvents: "none",
          }}/>
        ))}
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageFile}/>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
        background: "#111a2cee", borderTop: "1px solid #ffffff1a", flexWrap: "wrap", pointerEvents: "auto",
      }}>
        {TOOLS.map((t) => (
          <div key={t.key}
               onClick={() => (t.key === "image" ? fileInputRef.current?.click() : setTool(t.key))}
               title={t.label} style={{
            width: 28, height: 28, borderRadius: 8, cursor: "pointer", fontSize: 14,
            display: "flex", alignItems: "center", justifyContent: "center",
            background: tool === t.key ? "#ffffff33" : "transparent",
          }}>{t.key === "eraser" ? (I.eraser ? I.eraser("#fff", 15) : "⌫") : t.icon}</div>
        ))}
        <div style={{ width: 1, alignSelf: "stretch", background: "#ffffff26", margin: "0 2px" }}/>
        {WHITEBOARD_COLORS.map((c) => (
          <div key={c} onClick={() => setColor(c)} style={{
            width: 22, height: 22, borderRadius: "50%", background: c, cursor: "pointer",
            border: color === c ? "2px solid #fff" : "2px solid transparent",
          }}/>
        ))}
        <div onClick={clearBoard} style={{
          fontSize: 12.5, color: "#ff8080", cursor: "pointer", marginLeft: "auto",
        }}>Clear</div>
        <div onClick={onClose} style={{
          fontSize: 12.5, color: "#fff", cursor: "pointer", fontWeight: 600,
        }}>Close</div>
      </div>
    </div>
  );
}
