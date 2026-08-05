import { useEffect, useRef, useState } from "react";
import { Av, G, I, useCallLayout } from "../ui.jsx";

export function mmss(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export const canPickAudioOutput = typeof document !== "undefined"
  && typeof document.createElement("video").setSinkId === "function";

function pinchDistance(touches) {
  const [a, b] = touches;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

const MAX_ZOOM = 4;

/**
 * The one place every video element in a call passes through — remote/self
 * video in a 1:1 call, every group-call grid tile, and the screen-share/
 * spotlight main stage all render through this. Zoom/pan lives here
 * (instead of duplicated per call site) so a scroll-wheel or pinch gesture
 * works the same way everywhere: pinch/wheel to zoom, drag to pan once
 * zoomed, double-tap or the reset pill to snap back to fit.
 *
 * `zoomable` defaults on but is turned off for tiles where the gesture
 * would fight something else the tile already needs touch for — the small
 * self-preview PiP, and the group call's horizontally-SCROLLING filmstrip
 * strip of small tiles (a 1-finger swipe there needs to reach the
 * container's native scroll, not get captured by pan-while-zoomed).
 */
export function VideoTag({ stream, muted, style, sinkId, zoomable = true }) {
  const ref = useRef(null);
  const containerRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const pinchRef = useRef(null);   // { startDist, startZoom } while a 2-finger touch is active
  const dragRef = useRef(null);    // { startX, startY, startPan } while panning a zoomed-in tile

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null;
  }, [stream]);
  // Chrome/Edge only (no Safari/Firefox) — canPickAudioOutput gates whether
  // the picker that supplies this even shows up, so elsewhere sinkId is
  // just always undefined and this is a no-op.
  useEffect(() => {
    if (ref.current && sinkId && typeof ref.current.setSinkId === "function") {
      ref.current.setSinkId(sinkId).catch(() => {});
    }
  }, [sinkId]);
  // A new stream (a different participant, screen share starting/ending)
  // is a completely different picture — carrying over an old zoom/pan onto
  // it would be disorienting, not useful.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [stream]);

  function clampPan(nextZoom, nextPan) {
    if (nextZoom <= 1) return { x: 0, y: 0 };
    const box = containerRef.current;
    const maxX = box ? (box.clientWidth * (nextZoom - 1)) / 2 : 0;
    const maxY = box ? (box.clientHeight * (nextZoom - 1)) / 2 : 0;
    return {
      x: Math.max(-maxX, Math.min(maxX, nextPan.x)),
      y: Math.max(-maxY, Math.min(maxY, nextPan.y)),
    };
  }

  function applyZoom(nextZoom) {
    const clamped = Math.max(1, Math.min(MAX_ZOOM, nextZoom));
    setZoom(clamped);
    setPan((current) => clampPan(clamped, current));
  }

  function resetZoom() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  // Desktop: plain wheel to zoom (also what a trackpad pinch reports as).
  // Only meaningfully different from a page-scroll gesture in that these
  // tiles are fixed-size grid/flex cells, not scrollable containers, so
  // there is nothing else here a wheel event would otherwise be for.
  function handleWheel(event) {
    event.preventDefault();
    applyZoom(zoom - event.deltaY * 0.0015);
  }

  function handleTouchStart(event) {
    if (event.touches.length === 2) {
      pinchRef.current = { startDist: pinchDistance(event.touches), startZoom: zoom };
      dragRef.current = null;
    } else if (event.touches.length === 1 && zoom > 1) {
      dragRef.current = {
        startX: event.touches[0].clientX, startY: event.touches[0].clientY, startPan: pan,
      };
    }
  }

  // preventDefault is only ever called once an actual pinch/pan is
  // recognized, never on a plain single-finger touch at zoom===1 — that
  // path is deliberately left alone so it doesn't fight a scrollable
  // ancestor (nothing here needs it, and blocking it unconditionally is
  // what would break e.g. the group call's filmstrip if this were ever
  // reused there without zoomable=false).
  function handleTouchMove(event) {
    if (event.touches.length === 2 && pinchRef.current) {
      event.preventDefault();
      const scale = pinchDistance(event.touches) / pinchRef.current.startDist;
      applyZoom(pinchRef.current.startZoom * scale);
    } else if (event.touches.length === 1 && dragRef.current) {
      event.preventDefault();
      const dx = event.touches[0].clientX - dragRef.current.startX;
      const dy = event.touches[0].clientY - dragRef.current.startY;
      setPan(clampPan(zoom, { x: dragRef.current.startPan.x + dx, y: dragRef.current.startPan.y + dy }));
    }
  }

  function handleTouchEnd(event) {
    if (event.touches.length < 2) pinchRef.current = null;
    if (event.touches.length < 1) dragRef.current = null;
  }

  if (!zoomable) {
    return <video ref={ref} autoPlay playsInline muted={muted} style={style}/>;
  }

  const zoomed = zoom > 1.01;
  return (
    <div ref={containerRef} style={{ ...style, position: "relative", overflow: "hidden" }}
         onWheel={handleWheel} onTouchStart={handleTouchStart}
         onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}
         onDoubleClick={zoomed ? resetZoom : undefined}>
      <video ref={ref} autoPlay playsInline muted={muted} style={{
        width: "100%", height: "100%", objectFit: style?.objectFit || "cover",
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: "center center",
        transition: pinchRef.current || dragRef.current ? "none" : "transform 0.12s ease-out",
        cursor: zoomed ? "grab" : undefined,
      }}/>
      {zoomed && (
        <div onClick={resetZoom} title="Reset zoom" style={{
          position: "absolute", bottom: 6, right: 6, fontSize: 11, color: "#fff",
          background: "#00000099", padding: "3px 9px", borderRadius: 10, cursor: "pointer",
        }}>{Math.round(zoom * 100)}% · Reset</div>
      )}
    </div>
  );
}

/**
 * A popup listing whatever audio-output devices the browser can enumerate —
 * speaker, wired headphones, a connected Bluetooth headset all show up here
 * as ordinary entries with whatever label the OS gives them. There is no way
 * for a web app to single out "Bluetooth" specifically (device switching
 * itself is the OS's job); this is the generic picker every device funnels
 * through, Bluetooth included when it's actually connected.
 */
export function AudioOutputPicker({ current, onSelect, onClose }) {
  const [devices, setDevices] = useState([]);

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices()
      .then((all) => setDevices(all.filter((d) => d.kind === "audiooutput")))
      .catch(() => setDevices([]));
  }, []);

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#182234", borderTopLeftRadius: 20,
        borderTopRightRadius: 20, padding: "18px 8px 28px", color: "#fff",
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, padding: "0 14px 10px" }}>Audio output</div>
        {devices.length === 0 && (
          <div style={{ padding: "10px 14px", fontSize: 13, color: "#ffffff88" }}>
            No other output devices found.
          </div>
        )}
        {devices.map((d) => (
          <div key={d.deviceId} onClick={() => { onSelect(d.deviceId); onClose(); }} style={{
            display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
            borderRadius: 10, cursor: "pointer",
            background: current === d.deviceId ? "#ffffff1a" : "transparent",
          }}>
            {I.volume(current === d.deviceId ? G.accent : "#ffffffaa", 18)}
            <span style={{ fontSize: 14, flex: 1 }}>{d.label || "Audio device"}</span>
            {current === d.deviceId && I.check(G.accent, 16)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The overflow "…" menu — currently just Share screen, a real spot to grow
 * (add people, merge calls, host controls) once those exist. */
export function MoreMenu({ items, onClose }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1100, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#182234", borderTopLeftRadius: 20,
        borderTopRightRadius: 20, padding: "8px 8px 28px", color: "#fff",
      }}>
        {items.map((item) => (
          <div key={item.label}
               onClick={() => { if (!item.disabled) { item.onClick(); onClose(); } }}
               style={{
                 display: "flex", alignItems: "center", gap: 14, padding: "13px 14px",
                 borderRadius: 10, cursor: item.disabled ? "default" : "pointer",
                 opacity: item.disabled ? 0.4 : 1,
               }}>
            {item.icon}
            <div>
              <div style={{ fontSize: 14 }}>{item.label}</div>
              {item.sub && <div style={{ fontSize: 12, color: "#ffffff88", marginTop: 2 }}>{item.sub}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Full-screen call UI, mounted once at the top of the app so an incoming call
 * shows up no matter which tab or chat is currently open — a call is not a
 * property of the chat screen, it can interrupt anything.
 */
export default function CallOverlay({
  call, onAccept, onReject, onEnd, onToggleMute, onToggleCamera, onSwitchCamera, onShareScreen,
}) {
  const [sinkId, setSinkId] = useState(undefined);
  const { expanded, toggle, isDesktop } = useCallLayout();

  if (!call) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      // Desktop defaults to filling the real browser viewport (Zoom/Meet
      // style) instead of staying pinned to the app's mobile-width column;
      // a phone's viewport already IS that width, so there's nothing this
      // does there. `toggle` (the expand/shrink button below) overrides
      // either way, per device or by preference.
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
      {call.phase === "incoming" && <IncomingCall call={call} onAccept={onAccept} onReject={onReject}/>}
      {call.phase === "outgoing" && <OutgoingCall call={call} onEnd={onEnd}/>}
      {call.phase === "active" && (
        <ActiveCall call={call} onEnd={onEnd} onToggleMute={onToggleMute} onToggleCamera={onToggleCamera}
                    onSwitchCamera={onSwitchCamera}
                    onShareScreen={onShareScreen} sinkId={sinkId} onSinkId={setSinkId}/>
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
        <CallButton onClick={() => onReject()} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Decline"/>
        <CallButton onClick={onAccept} background="#22c55e" icon={I.phone("#fff", 24)} label="Accept"/>
      </div>
    </>
  );
}

function OutgoingCall({ call, onEnd }) {
  return (
    <>
      <div style={{ flex: 1 }}>
        {/* "Calling…" until the server confirms the invite actually
            reached a live, focused device (call.ringConfirmed, set from
            the call_ringing event in useCall.js) — only then is "Ringing…"
            an honest description of what's happening on their end. Before
            that we genuinely don't know: a logged-out account, a dead
            connection, or a stale client all look identical from here
            until either this arrives or the call times out. */}
        <PeerIdentity call={call} subtitle={call.ringConfirmed ? "Ringing…" : "Calling…"}/>
      </div>
      <div style={{ display: "flex", justifyContent: "center", padding: "0 40px 60px" }}>
        <CallButton onClick={onEnd} background="#ef4444" icon={I.callEnd("#fff", 24)} label="Cancel"/>
      </div>
    </>
  );
}

function ActiveCall({ call, onEnd, onToggleMute, onToggleCamera, onSwitchCamera, onShareScreen, sinkId, onSinkId }) {
  const [showSpeakerPicker, setShowSpeakerPicker] = useState(false);
  const [showMore, setShowMore] = useState(false);
  // The remote peer's OWN video state, not mine — turning my camera off
  // must not also blank out video they're still sending.
  const hasRemoteVideo = call.remoteStream?.getVideoTracks().length > 0;

  return (
    <>
      <div style={{ flex: 1, position: "relative" }}>
        {/* Always mounted, regardless of whether there's a video track, so
            remote audio actually plays on a voice-only call — hidden
            visually rather than left unmounted when there's nothing to
            show. This is also the element setSinkId() routes through. */}
        <VideoTag stream={call.remoteStream} sinkId={sinkId} style={hasRemoteVideo ? {
          width: "100%", height: "100%", objectFit: "cover",
        } : { display: "none" }}/>

        {!hasRemoteVideo && <PeerIdentity call={call} subtitle={mmss(call.duration)}/>}

        {hasRemoteVideo && (
          <div style={{
            position: "absolute", top: 16, left: 0, right: 0,
            textAlign: "center", fontSize: 13, color: "#ffffffcc",
          }}>
            {call.peerName} · {mmss(call.duration)}
          </div>
        )}

        {call.callKind === "video" && !call.cameraOff && call.localStream && (
          <div style={{ position: "absolute", bottom: 16, right: 16 }}>
            <VideoTag stream={call.localStream} muted zoomable={false} style={{
              width: 100, height: 140, borderRadius: 12, objectFit: "cover",
              border: "2px solid #ffffff33",
            }}/>
            {onSwitchCamera && (
              <div onClick={onSwitchCamera} title="Switch camera" style={{
                position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: "50%",
                background: "#00000099", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
              }}>
                {I.rotateRight("#fff", 15)}
              </div>
            )}
          </div>
        )}

        {call.sharingScreen && (
          <div style={{
            position: "absolute", top: 16, left: 16, padding: "5px 10px", borderRadius: 8,
            background: "#ef444422", border: "1px solid #ef444455", color: "#ff8080",
            fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
          }}>{I.screenShare("#ff8080", 13)} Sharing screen</div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "center", gap: 16, padding: "0 20px 60px", flexWrap: "wrap" }}>
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
        <CallButton onClick={onEnd} background="#ef4444" icon={I.callEnd("#fff", 24)} label="End"/>
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
        ]}/>
      )}
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
