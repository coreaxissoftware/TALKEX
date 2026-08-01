import { useEffect, useState } from "react";
import { Chats } from "../api.js";
import { Av, G, I } from "../ui.jsx";
import { AudioOutputPicker, CallButton, MoreMenu, VideoTag, canPickAudioOutput } from "./CallOverlay.jsx";

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
  onForceMuteAll, onKickParticipant, onAddPeople,
}) {
  const [sinkId, setSinkId] = useState(undefined);

  if (!call) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 999, // just under the 1:1 overlay's 1000 — a 1:1 call always wins focus
      maxWidth: 430, margin: "0 auto",
      background: "#0b1220", color: "#fff",
      display: "flex", flexDirection: "column",
    }}>
      {call.phase === "incoming"
        ? <IncomingGroupCall call={call} onAccept={onAccept} onDecline={onDecline}/>
        : <ActiveGroupCall call={call} myUserId={myUserId} onLeave={onLeave} onToggleMute={onToggleMute}
                           onToggleCamera={onToggleCamera} onShareScreen={onShareScreen}
                           onForceMuteAll={onForceMuteAll} onKickParticipant={onKickParticipant}
                           onAddPeople={onAddPeople} sinkId={sinkId} onSinkId={setSinkId}/>}
    </div>
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
        <CallButton onClick={onDecline} background="#ef4444" icon={I.phoneOff("#fff", 24)} label="Decline"/>
        <CallButton onClick={onAccept} background="#22c55e" icon={I.phone("#fff", 24)} label="Join"/>
      </div>
    </>
  );
}

function ActiveGroupCall({
  call, myUserId, onLeave, onToggleMute, onToggleCamera, onShareScreen,
  onForceMuteAll, onKickParticipant, onAddPeople, sinkId, onSinkId,
}) {
  const [showSpeakerPicker, setShowSpeakerPicker] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  const others = Object.entries(call.participants);
  const tileCount = others.length + 1; // + yourself
  const columns = tileCount <= 2 ? 1 : 2;
  const isHost = myUserId != null && call.hostId === myUserId;

  return (
    <>
      <div style={{
        flex: 1, display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: 2, padding: 2, overflow: "hidden",
      }}>
        <SelfTile call={call} isHost={isHost}/>
        {others.map(([userId, participant]) => (
          <ParticipantTile key={userId} participant={participant} sinkId={sinkId}
                           canKick={isHost} onKick={() => onKickParticipant(userId)}/>
        ))}
      </div>

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
        {canPickAudioOutput && (
          <CallButton onClick={() => setShowSpeakerPicker(true)} background="#ffffff26"
                      icon={I.volume("#fff", 20)} label="Speaker" small/>
        )}
        <CallButton onClick={() => setShowMore(true)} background="#ffffff26"
                    icon={I.moreVertical("#fff", 20)} label="More" small/>
        <CallButton onClick={onLeave} background="#ef4444" icon={I.phoneOff("#fff", 24)} label="Leave"/>
      </div>

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
          {
            label: "Add people",
            icon: I.user("#fff", 18),
            onClick: () => setShowAddPeople(true),
          },
          {
            label: "Mute everyone",
            sub: isHost ? undefined : "Only the person who started this call can do that",
            icon: I.micOff("#fff", 18),
            disabled: !isHost,
            onClick: onForceMuteAll,
          },
        ]}/>
      )}
      {showAddPeople && (
        <AddPeoplePicker chatId={call.chatId}
                         existingIds={[myUserId, ...Object.keys(call.participants)]}
                         onAdd={onAddPeople} onClose={() => setShowAddPeople(false)}/>
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
      <div style={{
        position: "absolute", bottom: 6, left: 8, fontSize: 11.5, color: "#ffffffcc",
        background: "#00000066", padding: "2px 8px", borderRadius: 8,
      }}>You{isHost ? " · host" : ""}{call.muted ? " · muted" : ""}</div>
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
