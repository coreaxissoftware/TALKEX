import { useEffect, useRef } from "react";
import { Av, G, I } from "../ui.jsx";

function mmss(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VideoTag({ stream, muted, style }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null;
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} style={style}/>;
}

/**
 * Full-screen call UI, mounted once at the top of the app so an incoming call
 * shows up no matter which tab or chat is currently open — a call is not a
 * property of the chat screen, it can interrupt anything.
 */
export default function CallOverlay({ call, onAccept, onReject, onEnd, onToggleMute, onToggleCamera }) {
  if (!call) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      maxWidth: 430, margin: "0 auto",
      background: "#0b1220", color: "#fff",
      display: "flex", flexDirection: "column",
    }}>
      {call.phase === "incoming" && <IncomingCall call={call} onAccept={onAccept} onReject={onReject}/>}
      {call.phase === "outgoing" && <OutgoingCall call={call} onEnd={onEnd}/>}
      {call.phase === "active" && (
        <ActiveCall call={call} onEnd={onEnd} onToggleMute={onToggleMute} onToggleCamera={onToggleCamera}/>
      )}
    </div>
  );
}

function PeerIdentity({ call, subtitle }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginTop: 80 }}>
      <Av av={call.peerAvatar} color={call.peerColor} size={110}/>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{call.peerName}</div>
      <div style={{ fontSize: 14, color: "#ffffffaa" }}>{subtitle}</div>
    </div>
  );
}

const QUICK_REPLIES = [
  "Can't talk right now", "I'll call you later", "In a meeting",
  "Call me in 5 minutes", "Please text me instead",
];

function IncomingCall({ call, onAccept, onReject }) {
  return (
    <>
      <div style={{ flex: 1 }}>
        <PeerIdentity call={call}
          subtitle={`Incoming ${call.callKind === "video" ? "video" : "voice"} call…`}/>
      </div>

      <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "0 20px 16px" }}>
        {QUICK_REPLIES.map((text) => (
          <button key={text} onClick={() => onReject(text)} style={{
            flexShrink: 0, padding: "8px 14px", borderRadius: 20, whiteSpace: "nowrap",
            border: "1px solid #ffffff33", background: "#ffffff1a", color: "#fff",
            fontSize: 12.5, cursor: "pointer",
          }}>{text}</button>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-around", padding: "0 40px 60px" }}>
        <CallButton onClick={() => onReject()} background="#ef4444" icon={I.phoneOff("#fff", 24)} label="Decline"/>
        <CallButton onClick={onAccept} background="#22c55e" icon={I.phone("#fff", 24)} label="Accept"/>
      </div>
    </>
  );
}

function OutgoingCall({ call, onEnd }) {
  return (
    <>
      <div style={{ flex: 1 }}>
        <PeerIdentity call={call} subtitle="Calling…"/>
      </div>
      <div style={{ display: "flex", justifyContent: "center", padding: "0 40px 60px" }}>
        <CallButton onClick={onEnd} background="#ef4444" icon={I.phoneOff("#fff", 24)} label="Cancel"/>
      </div>
    </>
  );
}

function ActiveCall({ call, onEnd, onToggleMute, onToggleCamera }) {
  const isVideo = call.callKind === "video" && !call.cameraOff;
  const hasRemoteVideo = isVideo && call.remoteStream?.getVideoTracks().length > 0;

  return (
    <>
      <div style={{ flex: 1, position: "relative" }}>
        {hasRemoteVideo ? (
          <VideoTag stream={call.remoteStream} style={{
            width: "100%", height: "100%", objectFit: "cover",
          }}/>
        ) : (
          <PeerIdentity call={call} subtitle={mmss(call.duration)}/>
        )}

        {hasRemoteVideo && (
          <div style={{
            position: "absolute", top: 16, left: 0, right: 0,
            textAlign: "center", fontSize: 13, color: "#ffffffcc",
          }}>
            {call.peerName} · {mmss(call.duration)}
          </div>
        )}

        {call.callKind === "video" && !call.cameraOff && call.localStream && (
          <VideoTag stream={call.localStream} muted style={{
            position: "absolute", bottom: 16, right: 16,
            width: 100, height: 140, borderRadius: 12, objectFit: "cover",
            border: "2px solid #ffffff33",
          }}/>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 20, padding: "0 24px 60px" }}>
        <CallButton onClick={onToggleMute} background={call.muted ? "#fff" : "#ffffff26"}
                    icon={call.muted ? I.micOff("#0b1220", 20) : I.mic("#fff", 20)} label="Mute" small/>
        {call.callKind === "video" && (
          <CallButton onClick={onToggleCamera} background={call.cameraOff ? "#fff" : "#ffffff26"}
                      icon={call.cameraOff ? I.videoOff("#0b1220", 20) : I.video("#fff", 20)}
                      label="Camera" small/>
        )}
        <CallButton onClick={onEnd} background="#ef4444" icon={I.phoneOff("#fff", 24)} label="End"/>
      </div>
    </>
  );
}

export function CallButton({ onClick, background, icon, label, small }) {
  const size = small ? 52 : 64;
  return (
    <div onClick={onClick} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, cursor: "pointer" }}>
      <div style={{
        width: size, height: size, borderRadius: "50%", background,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {icon}
      </div>
      <div style={{ fontSize: 11, color: "#ffffffaa" }}>{label}</div>
    </div>
  );
}
