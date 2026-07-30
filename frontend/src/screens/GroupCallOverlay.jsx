import { Av, G, I } from "../ui.jsx";
import { CallButton, VideoTag } from "./CallOverlay.jsx";

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
export default function GroupCallOverlay({ call, onAccept, onDecline, onLeave, onToggleMute, onToggleCamera }) {
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
        : <ActiveGroupCall call={call} onLeave={onLeave}
                           onToggleMute={onToggleMute} onToggleCamera={onToggleCamera}/>}
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

function ActiveGroupCall({ call, onLeave, onToggleMute, onToggleCamera }) {
  const others = Object.entries(call.participants);
  const tileCount = others.length + 1; // + yourself
  const columns = tileCount <= 2 ? 1 : 2;

  return (
    <>
      <div style={{
        flex: 1, display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: 2, padding: 2, overflow: "hidden",
      }}>
        <SelfTile call={call}/>
        {others.map(([userId, participant]) => (
          <ParticipantTile key={userId} participant={participant}
                           showVideo={call.callKind === "video"}/>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 20, padding: "16px 24px 60px" }}>
        <CallButton onClick={onToggleMute} background={call.muted ? "#fff" : "#ffffff26"}
                    icon={call.muted ? I.micOff("#0b1220", 20) : I.mic("#fff", 20)} label="Mute" small/>
        {call.callKind === "video" && (
          <CallButton onClick={onToggleCamera} background={call.cameraOff ? "#fff" : "#ffffff26"}
                      icon={call.cameraOff ? I.videoOff("#0b1220", 20) : I.video("#fff", 20)}
                      label="Camera" small/>
        )}
        <CallButton onClick={onLeave} background="#ef4444" icon={I.phoneOff("#fff", 24)} label="Leave"/>
      </div>
    </>
  );
}

function SelfTile({ call }) {
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
      }}>You{call.muted ? " · muted" : ""}</div>
    </div>
  );
}

function ParticipantTile({ participant, showVideo }) {
  const hasVideo = showVideo && participant.stream?.getVideoTracks().length > 0;
  return (
    <div style={{
      position: "relative", background: "#142235", borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden",
    }}>
      {hasVideo ? (
        <VideoTag stream={participant.stream} style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
      ) : (
        <Av av={participant.avatar} color={participant.color} size={64}/>
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
    </div>
  );
}
