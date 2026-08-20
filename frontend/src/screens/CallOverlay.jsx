import { useEffect, useRef, useState } from "react";
import { Contacts } from "../api.js";
import { Av, G, I, useCallLayout } from "../ui.jsx";
import { setCallActive, onPipModeChange } from "../nativePip.js";

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
  // A plain two-finger trackpad swipe fires the exact same "wheel" event a
  // deliberate pinch does — the only thing that tells them apart is that a
  // browser marks a real pinch/ctrl-scroll gesture with ctrlKey (Chrome/
  // Firefox/Safari all do this specifically so a page can distinguish
  // "scroll" from "zoom"). Without this gate, casually scrolling past a
  // video tile with a trackpad — not touching it deliberately at all —
  // zoomed the video in immediately, which is exactly what looked like the
  // camera "auto-zooming" on its own. A plain mouse wheel with no modifier
  // now does nothing here and is left completely alone (no preventDefault)
  // so it never interferes with scrolling anything else on the page.
  function handleWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    applyZoom(zoom - event.deltaY * 0.0015);
  }

  // A two-finger TOUCH scroll (common on touchscreen laptops, separate
  // from a trackpad's wheel events handled above) starts with exactly the
  // same shape as a pinch: two touches landing at once. The only way to
  // tell them apart is what happens next — a pinch changes the distance
  // BETWEEN the two fingers; a two-finger scroll keeps that distance
  // roughly constant while both fingers translate together. `confirmed`
  // stays false (and nothing is captured/prevented) until the distance has
  // moved enough from where it started to no longer plausibly be a scroll —
  // only past that threshold do we commit to "this is a pinch."
  const PINCH_CONFIRM_PX = 12;

  function handleTouchStart(event) {
    if (event.touches.length === 2) {
      pinchRef.current = { startDist: pinchDistance(event.touches), startZoom: zoom, confirmed: false };
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
      const dist = pinchDistance(event.touches);
      if (!pinchRef.current.confirmed) {
        if (Math.abs(dist - pinchRef.current.startDist) < PINCH_CONFIRM_PX) return; // still ambiguous — leave it alone
        pinchRef.current.confirmed = true;
        // Re-anchor from here so zoom doesn't jump by the threshold amount
        // the instant it's confirmed.
        pinchRef.current.startDist = dist;
        pinchRef.current.startZoom = zoom;
      }
      event.preventDefault();
      const scale = dist / pinchRef.current.startDist;
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
    <div ref={containerRef} style={{
      ...style, position: "relative", overflow: "hidden",
      // Wrapping the <video> in a plain <div> (needed so zoom/pan and the
      // reset pill have somewhere to live) introduced a real flexbox bug:
      // a <video> is a "replaced element" the flex algorithm sizes safely
      // by default, but a generic <div> is not — inside a flex ancestor
      // with no explicit height of its own (the call screen's video area
      // is `flex: 1`, sized by whatever's left over, not a fixed number),
      // this div's `height: 100%` could resolve against the flex item's
      // CONTENT size instead of its actual allotted space, letting the
      // whole video area balloon to the video's natural/portrait size and
      // push the mute/camera/end-call bar completely off the bottom of
      // the screen — which is what "no end call button, video is huge"
      // turned out to actually be, not a zoom-transform bug. `minWidth`/
      // `minHeight: 0` is the standard fix: it tells this flex descendant
      // it's allowed to be SMALLER than its content wants, which is
      // exactly what should happen here since the content (the video) is
      // meant to be cropped to fit, not to dictate the box's size.
      minWidth: 0, minHeight: 0,
    }}
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
  call, onAccept, onReject, onEnd, onToggleMute, onToggleCamera, onSwitchCamera, onShareScreen, onEffect,
  onAddParticipant, onToggleHold,
}) {
  const [sinkId, setSinkId] = useState(undefined);
  const [minimized, setMinimized] = useState(false);
  const { expanded, toggle, isDesktop, isLandscape } = useCallLayout();

  // An incoming/outgoing call can never start minimized — you have to see it
  // to answer or hang up. Only an active, connected call collapses to the
  // floating window, and it snaps back to full screen the moment it ends.
  useEffect(() => {
    if (!call || call.phase !== "active") setMinimized(false);
  }, [call?.phase, call?.chatId]);

  // Ringback (outgoing) / ringtone (incoming) — synthesized with Web Audio
  // so there's no binary asset to ship or license. Neither phase used to
  // play any sound at all: "Ringing…" was just text. Stops itself the
  // moment the phase moves on (answered, declined, cancelled, timed out).
  useEffect(() => {
    const phase = call?.phase;
    if (phase !== "outgoing" && phase !== "incoming") return undefined;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return undefined;
    const ctx = new Ctx();
    ctx.resume?.().catch(() => {});
    let stopped = false;
    const timers = [];

    function beep(freq1, freq2, duration) {
      if (stopped) return;
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.16, now + 0.03);
      gain.gain.setValueAtTime(0.16, Math.max(now + 0.03, now + duration - 0.03));
      gain.gain.linearRampToValueAtTime(0, now + duration);
      gain.connect(ctx.destination);
      [freq1, freq2].forEach((freq) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + duration);
      });
    }

    function schedule() {
      if (stopped) return;
      if (phase === "outgoing") {
        // Classic ringback cadence: ~1s tone, ~3s silence.
        beep(440, 480, 1.0);
        timers.push(setTimeout(schedule, 4000));
      } else {
        // Phone-ring cadence: two short bursts, then a pause.
        beep(950, 950, 0.4);
        timers.push(setTimeout(() => beep(950, 950, 0.4), 550));
        timers.push(setTimeout(schedule, 2200));
      }
    }
    schedule();

    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
      ctx.close?.().catch(() => {});
    };
  }, [call?.phase]);

  // Native Android system Picture-in-Picture: tell MainActivity a call is on
  // screen so backgrounding the app (home button, task switch) shrinks it to
  // a real floating OS window instead of just disappearing — and swap to a
  // minimal, video-only layout while in that tiny window, since the normal
  // full-screen buttons aren't usable (or even visible) at PiP size. A no-op
  // everywhere except the native Android build (see nativePip.js).
  const [pipMode, setPipMode] = useState(false);
  useEffect(() => {
    setCallActive(Boolean(call && call.phase === "active"));
    return () => setCallActive(false);
  }, [call?.phase, call?.chatId]);
  useEffect(() => onPipModeChange(setPipMode), []);

  if (!call) return null;

  if (pipMode) {
    const pipStream = call.remoteStream || call.localStream;
    return (
      <div style={{ position: "fixed", inset: 0, background: "#0b1220" }}>
        {pipStream
          ? <VideoTag stream={pipStream} muted={!call.remoteStream}
                      zoomable={false} style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
          : <PeerIdentity call={call} subtitle={mmss(call.duration)}/>}
      </div>
    );
  }

  // Minimized: a small floating window over the app (WhatsApp's picture-in-
  // picture call bubble). The rest of the app behind it stays fully usable —
  // this is also what the in-call "chat" button lands you on, since the chat
  // is right there underneath once the call shrinks out of the way.
  if (minimized && call.phase === "active") {
    return (
      <MinimizedCall call={call} onEnd={onEnd} onExpand={() => setMinimized(false)}/>
    );
  }

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
      {/* Minimize to the floating window — available on every active call,
          the top-left "collapse" affordance from the WhatsApp call screen. */}
      {call.phase !== "incoming" && (
        <div onClick={() => setMinimized(true)} title="Minimize" style={{
          position: "absolute", top: 14, left: 14, zIndex: 2,
          width: 34, height: 34, borderRadius: "50%", cursor: "pointer",
          background: "#ffffff1a", display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          {I.chevronDown("#fff", 20)}
        </div>
      )}
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
      {/* Outgoing uses the same full-control screen as an active call —
          WhatsApp shows mute/camera/speaker the instant you place the call,
          not just once the other side answers. Local media (localStream,
          mute/camera toggles) is already live during "outgoing" (acquired
          up front in startCall), so there's nothing to wait for. */}
      {(call.phase === "outgoing" || call.phase === "active") && (
        <ActiveCall call={call} onEnd={onEnd} onToggleMute={onToggleMute} onToggleCamera={onToggleCamera}
                    onSwitchCamera={onSwitchCamera} onMinimize={() => setMinimized(true)}
                    onShareScreen={onShareScreen} onEffect={onEffect} onAddParticipant={onAddParticipant}
                    onToggleHold={onToggleHold}
                    sinkId={sinkId} onSinkId={setSinkId}
                    isLandscape={isLandscape}/>
      )}
    </div>
  );
}

/**
 * The minimized floating call — a small draggable window that keeps the call
 * alive while the rest of the app is usable behind it. Tapping it (anywhere
 * but the end button) restores the full-screen call.
 */
function MinimizedCall({ call, onEnd, onExpand }) {
  const [pos, setPos] = useState({ x: null, y: null }); // null → default bottom-right via CSS
  const dragRef = useRef(null);
  const movedRef = useRef(false);
  const isVideo = call.callKind === "video" && call.remoteStream
    && call.remoteStream.getVideoTracks().length > 0 && !call.remoteCameraOff;

  const W = isVideo ? 120 : 200;
  const H = isVideo ? 170 : 68;

  function onPointerDown(event) {
    movedRef.current = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { startX, startY, baseX: rect.left, baseY: rect.top };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event) {
    if (!dragRef.current) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) movedRef.current = true;
    const nx = Math.max(6, Math.min(window.innerWidth - W - 6, dragRef.current.baseX + dx));
    const ny = Math.max(6, Math.min(window.innerHeight - H - 6, dragRef.current.baseY + dy));
    setPos({ x: nx, y: ny });
  }
  function onPointerUp() { dragRef.current = null; }

  const anchored = pos.x == null
    ? { right: 14, bottom: 90 }
    : { left: pos.x, top: pos.y };

  return (
    <div
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onClick={() => { if (!movedRef.current) onExpand(); }}
      style={{
        position: "fixed", ...anchored, zIndex: 1200, width: W, height: H,
        borderRadius: 14, overflow: "hidden", cursor: "pointer",
        background: "#0b1220", border: "1px solid #ffffff33",
        boxShadow: "0 8px 30px #00000066", color: "#fff",
        display: "flex", flexDirection: isVideo ? "column" : "row", alignItems: "center",
        touchAction: "none",
      }}>
      {isVideo ? (
        <>
          <VideoTag stream={call.remoteStream} zoomable={false}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}/>
          <div style={{ position: "absolute", top: 6, left: 6, fontSize: 10.5,
            padding: "1px 6px", borderRadius: 6, background: "#00000066" }}>{mmss(call.duration)}</div>
          {/* End-call — stopPropagation so hanging up never counts as tap-to-expand */}
          <div onClick={(e) => { e.stopPropagation(); onEnd(); }} title="End call" style={{
            position: "absolute", bottom: 6, right: 6, width: 30, height: 30, borderRadius: "50%",
            background: "#ef4444", display: "flex", alignItems: "center", justifyContent: "center",
          }}>{I.callEnd("#fff", 15)}</div>
        </>
      ) : (
        <>
          <div style={{ padding: "0 10px", flexShrink: 0 }}>
            <Av av={call.peerAvatar} color={call.peerColor} size={44}/>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis" }}>{call.peerName}</div>
            <div style={{ fontSize: 11.5, color: "#ffffffaa" }}>{mmss(call.duration)}</div>
          </div>
          <div onClick={(e) => { e.stopPropagation(); onEnd(); }} title="End call" style={{
            width: 34, height: 34, borderRadius: "50%", margin: "0 12px", flexShrink: 0,
            background: "#ef4444", display: "flex", alignItems: "center", justifyContent: "center",
          }}>{I.callEnd("#fff", 16)}</div>
        </>
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

const VIDEO_EFFECTS = [
  { key: "none", label: "None", filter: "none" },
  { key: "bgblur_light", label: "Bg Blur Light", filter: "bgblur:6" },
  { key: "bgblur_heavy", label: "Bg Blur Heavy", filter: "bgblur:14" },
  { key: "vbg_dark", label: "Dark Room", filter: "vbg:#1a1a2e" },
  { key: "vbg_office", label: "Office", filter: "vbg:#e2e8f0" },
  { key: "vbg_green", label: "Nature", filter: "vbg:#166534" },
  { key: "blur", label: "Full Blur", filter: "blur(6px)" },
  { key: "bright", label: "Bright", filter: "brightness(1.25) contrast(1.05)" },
  { key: "warm", label: "Warm", filter: "sepia(0.35) saturate(1.3)" },
  { key: "cool", label: "Cool", filter: "hue-rotate(-15deg) saturate(1.2) brightness(1.05)" },
  { key: "mono", label: "Mono", filter: "grayscale(1) contrast(1.1)" },
  { key: "vivid", label: "Vivid", filter: "saturate(1.8) contrast(1.1)" },
];

function ActiveCall({ call, onEnd, onToggleMute, onToggleCamera, onSwitchCamera, onShareScreen, onEffect, onAddParticipant, onToggleHold, onMinimize, sinkId, onSinkId, isLandscape }) {
  const [showSpeakerPicker, setShowSpeakerPicker] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [showEffects, setShowEffects] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  // Tap the small self/peer tile to swap which feed is the big one — the
  // WhatsApp "tap to make my camera the main view" gesture. Pure local UI.
  const [swapped, setSwapped] = useState(false);

  // The remote peer's OWN media state, not mine — turning my camera off must
  // not blank out video they're still sending. remoteCameraOff arrives via the
  // call_media_state ping (useCall.js), so their tile shows their identity the
  // instant they cover their camera, not a frozen last frame.
  const hasRemoteVideo = call.remoteStream?.getVideoTracks().length > 0 && !call.remoteCameraOff;
  const hasLocalVideo = call.callKind === "video" && !call.cameraOff && call.localStream;

  // Which stream is on the main stage vs. in the little corner tile.
  const mainIsLocal = swapped && hasLocalVideo;
  const showMainVideo = mainIsLocal ? hasLocalVideo : hasRemoteVideo;

  // A front camera's own preview should look like a mirror — that's how
  // everyone expects to see themselves (their right hand on their visual
  // right, text they hold up readable to THEM). This was never applied
  // anywhere before: the caller saw their own raw, unmirrored feed (which
  // looks backwards to them) while the peer correctly saw a normal,
  // unmirrored view of the caller — so only the caller ever noticed
  // anything "wrong." Only ever applied to a tile showing MY OWN stream,
  // driven by MY OWN facingMode — never the peer's, and never the back
  // camera (mirroring a back-camera view would make text/signs backwards
  // for no reason).
  const selfMirror = call.facingMode !== "environment" ? { transform: "scaleX(-1)" } : undefined;

  // Landscape on a phone means very little vertical room — the 60px bottom
  // safe-area padding that portrait needs (iPhone notch bar) would eat half
  // the screen. Buttons go inline with minimal padding instead. The self-
  // preview PiP flips from portrait (tall) to landscape (wide) orientation.
  const pipW = isLandscape ? 120 : 100;
  const pipH = isLandscape ? 80 : 140;
  const canSwap = hasRemoteVideo && hasLocalVideo;

  // Self-view corner tile is draggable anywhere on screen — same
  // pointer-drag pattern MinimizedCall (below) already uses for the
  // floating call bubble, just clamped to this tile's own size.
  const [pipPos, setPipPos] = useState({ x: null, y: null }); // null → default bottom-right via CSS
  const pipMoved = useRef(false);
  const pipDrag = useRef(null);
  function onPipPointerDown(event) {
    pipMoved.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    pipDrag.current = { startX: event.clientX, startY: event.clientY, baseX: rect.left, baseY: rect.top };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPipPointerMove(event) {
    if (!pipDrag.current) return;
    const dx = event.clientX - pipDrag.current.startX;
    const dy = event.clientY - pipDrag.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) pipMoved.current = true;
    const nx = Math.max(6, Math.min(window.innerWidth - pipW - 6, pipDrag.current.baseX + dx));
    const ny = Math.max(6, Math.min(window.innerHeight - pipH - 6, pipDrag.current.baseY + dy));
    setPipPos({ x: nx, y: ny });
  }
  function onPipPointerUp() { pipDrag.current = null; }

  return (
    <>
      {/* overflow: hidden + minHeight: 0 is a backstop against the same
          flex-sizing issue VideoTag's own wrapper already guards against
          (see the comment there) — belt and suspenders, so even if
          something inside this area ever again asks for more room than
          it's actually got, it gets clipped here instead of pushing the
          Mute/Camera/End call bar below it clean off the screen. */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>
        {/* Remote video always mounted (even when hidden) so remote audio
            plays on a voice-only call and setSinkId has an element to route
            through. When swapped, the remote feed rides in the corner tile
            instead, so here it only fills the stage when it IS the main. */}
        <VideoTag stream={call.remoteStream} sinkId={sinkId}
                  style={(showMainVideo && !mainIsLocal) ? {
                    width: "100%", height: "100%", objectFit: "cover",
                  } : { display: "none" }}/>

        {/* Local feed on the main stage (only when swapped in) */}
        {mainIsLocal && (
          <VideoTag stream={call.localStream} muted zoomable={false} style={{
            width: "100%", height: "100%", objectFit: "cover", ...selfMirror,
          }}/>
        )}

        {!showMainVideo && (
          <PeerIdentity call={call}
            subtitle={call.onHold ? "On Hold" : call.phase === "active" ? mmss(call.duration) : (call.ringConfirmed ? "Ringing…" : "Calling…")}/>
        )}

        {showMainVideo && (
          <div style={{
            position: "absolute", top: isLandscape ? 8 : 16, left: 0, right: 0,
            textAlign: "center", fontSize: 13, color: "#ffffffcc",
          }}>
            {call.peerName} · {call.onHold ? "On Hold" : mmss(call.duration)}
          </div>
        )}

        {/* Peer's "muted" indicator — the little pill from the WhatsApp call
            screen, shown whenever they've turned their mic off. */}
        {call.remoteMuted && (
          <div style={{
            position: "absolute", top: isLandscape ? 30 : 44, left: 0, right: 0,
            display: "flex", justifyContent: "center",
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 6, padding: "5px 12px",
              borderRadius: 16, background: "#00000066", fontSize: 12.5, color: "#fff",
            }}>{I.micOff("#fff", 13)} {call.peerName?.split(" ")[0] || "They"} muted</div>
          </div>
        )}

        {/* Corner tile: shows whichever feed is NOT on the main stage. Drag it
            anywhere on screen (WhatsApp/Zoom-style); a tap that didn't move
            still swaps main/self, same as before — pipDragRef.moved is what
            tells the two apart. Camera-flip lives here when it's the self feed. */}
        {(hasLocalVideo || (mainIsLocal && hasRemoteVideo)) && (
          <div onPointerDown={onPipPointerDown} onPointerMove={onPipPointerMove}
               onPointerUp={onPipPointerUp} onPointerCancel={onPipPointerUp}
               style={{
                 position: "absolute", touchAction: "none", cursor: "grab",
                 ...(pipPos.x == null
                   ? { bottom: isLandscape ? 8 : 16, right: isLandscape ? 8 : 16 }
                   : { left: pipPos.x, top: pipPos.y }),
               }}>
            <div onClick={canSwap ? () => { if (!pipMoved.current) setSwapped((s) => !s); } : undefined}
                 title={canSwap ? "Drag to move · tap to swap" : "Drag to move"}
                 style={{ cursor: canSwap ? "pointer" : "grab" }}>
              <VideoTag stream={mainIsLocal ? call.remoteStream : call.localStream}
                        muted={!mainIsLocal} zoomable={false} style={{
                width: pipW, height: pipH, borderRadius: 12, objectFit: "cover",
                border: "2px solid #ffffff33",
                // Only this tile's feed is ever mine here when it's NOT the
                // swapped-in main stage — mirror follows that, same as above.
                ...(!mainIsLocal ? selfMirror : undefined),
              }}/>
            </div>
            {/* Camera flip acts on MY camera — show it on whichever tile is
                currently showing my feed (the corner, unless swapped). */}
            {onSwitchCamera && !mainIsLocal && (
              <div onClick={(e) => { e.stopPropagation(); onSwitchCamera(); }} title="Switch camera" style={{
                position: "absolute", top: 6, right: 6, width: 28, height: 28, borderRadius: "50%",
                background: "#00000099", display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer",
              }}>
                {I.cameraFlip("#fff", 16)}
              </div>
            )}
          </div>
        )}

        {call.sharingScreen && (
          <div style={{
            position: "absolute", top: isLandscape ? 8 : 16, left: isLandscape ? 8 : 16,
            padding: "5px 10px", borderRadius: 8,
            background: "#ef444422", border: "1px solid #ef444455", color: "#ff8080",
            fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6,
          }}>{I.screenShare("#ff8080", 13)} Sharing screen</div>
        )}
      </div>

      <div style={{
        display: "flex", justifyContent: "center", gap: isLandscape ? 12 : 16,
        // Landscape: compact single row with minimal padding — every pixel
        // of vertical space matters when the screen is short and wide.
        // Portrait: generous bottom padding absorbs the iPhone safe area.
        padding: isLandscape ? "8px 20px 12px" : "0 20px 60px",
        flexWrap: "wrap",
      }}>
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
          ...(onAddParticipant ? [{
            // Add someone to the call → migrates this 1:1 into an ad-hoc
            // group call in a hidden call room.
            label: "Add participant",
            icon: I.userPlus ? I.userPlus("#fff", 18) : I.user("#fff", 18),
            onClick: () => { setShowMore(false); setShowAdd(true); },
          }] : []),
          {
            // Minimize back to the conversation — WhatsApp's in-call "chat"
            // button: the call shrinks to the floating window and the chat
            // it belongs to is right there underneath.
            label: "Chat / minimize",
            icon: I.chat("#fff", 18),
            onClick: () => { setShowMore(false); onMinimize?.(); },
          },
          {
            label: "Effects",
            sub: call.callKind !== "video" ? "Turn your camera on first"
              : call.sharingScreen ? "Not while sharing screen" : undefined,
            icon: I.sparkles ? I.sparkles("#fff", 18) : I.star("#fff", 18),
            disabled: call.callKind !== "video" || call.sharingScreen,
            onClick: () => { setShowMore(false); setShowEffects(true); },
          },
          {
            label: call.sharingScreen ? "Stop sharing screen" : "Share screen",
            sub: call.callKind !== "video" ? "Turn your camera on first" : undefined,
            icon: I.screenShare("#fff", 18),
            disabled: call.callKind !== "video",
            onClick: onShareScreen,
          },
          {
            label: call.onHold ? "Resume call" : "Hold",
            icon: call.onHold ? I.play("#fff", 18) : I.pause("#fff", 18),
            onClick: onToggleHold,
          },
        ]}/>
      )}

      {showAdd && (
        <AddParticipantSheet
          onClose={() => setShowAdd(false)}
          onAdd={(ids) => { setShowAdd(false); onAddParticipant?.(ids); }}/>
      )}

      {showEffects && (
        <div onClick={() => setShowEffects(false)} style={{
          position: "absolute", inset: 0, zIndex: 3, background: "#00000055",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            width: "100%", maxWidth: 430, background: "#111a2b", color: "#fff",
            borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: "16px 16px 28px",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Camera effects</div>
            <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
              {VIDEO_EFFECTS.map((effect) => {
                const active = (call.videoEffect || "none") === effect.filter
                  || (effect.key === "none" && !call.videoEffect);
                return (
                  <button key={effect.key} onClick={() => { onEffect?.(effect.filter); }} style={{
                    flexShrink: 0, padding: "10px 16px", borderRadius: 12, cursor: "pointer",
                    border: `2px solid ${active ? "#3b82f6" : "#ffffff22"}`,
                    background: active ? "#3b82f633" : "#ffffff10", color: "#fff",
                    fontSize: 12.5, fontWeight: 600,
                  }}>{effect.label}</button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Picks people to pull into the call from the caller's saved TalkEx contacts.
 * Multi-select; "Add" hands the chosen ids up, where the 1:1 call is migrated
 * into an ad-hoc group call in a hidden call room.
 */
function AddParticipantSheet({ onClose, onAdd }) {
  const [contacts, setContacts] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    Contacts.list()
      .then((all) => setContacts((all || []).filter((c) => c.user)))
      .catch(() => setContacts([]));
  }, []);

  const filtered = (contacts || []).filter((c) =>
    !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()));

  function toggle(userId) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  }

  return (
    <div onClick={onClose} style={{
      position: "absolute", inset: 0, zIndex: 3, background: "#00000066",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 430, background: "#111a2b", color: "#fff",
        borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: "16px 16px 24px",
        maxHeight: "70vh", display: "flex", flexDirection: "column",
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>Add to call</div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search contacts"
               style={{
                 width: "100%", padding: "9px 12px", borderRadius: 10, marginBottom: 10,
                 background: "#ffffff12", border: "1px solid #ffffff22", color: "#fff",
                 fontSize: 13.5, outline: "none", boxSizing: "border-box",
               }}/>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
          {contacts === null && <div style={{ color: "#ffffff99", fontSize: 13, padding: 16, textAlign: "center" }}>Loading…</div>}
          {contacts?.length === 0 && (
            <div style={{ color: "#ffffff99", fontSize: 13, padding: 16, textAlign: "center" }}>
              No TalkEx contacts to add.
            </div>
          )}
          {filtered.map((contact) => {
            const on = selected.has(contact.user.id);
            return (
              <div key={contact.id} onClick={() => toggle(contact.user.id)} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "9px 4px", cursor: "pointer",
              }}>
                <Av av={contact.user.avatar_letter} color={contact.user.color} size={38}
                    photoId={contact.user.avatar_attachment_id}/>
                <div style={{ flex: 1, fontSize: 14 }}>{contact.name}</div>
                <div style={{
                  width: 20, height: 20, borderRadius: "50%",
                  border: `2px solid ${on ? "#3b82f6" : "#ffffff44"}`,
                  background: on ? "#3b82f6" : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 700, color: "#fff",
                }}>{on ? "✓" : ""}</div>
              </div>
            );
          })}
        </div>
        <button disabled={selected.size === 0} onClick={() => onAdd([...selected])} style={{
          marginTop: 12, padding: "12px", borderRadius: 12, border: "none",
          background: selected.size ? "#3b82f6" : "#ffffff22", color: "#fff",
          fontSize: 14.5, fontWeight: 700, cursor: selected.size ? "pointer" : "default",
        }}>
          Add{selected.size ? ` (${selected.size})` : ""}
        </button>
      </div>
    </div>
  );
}

export function CallButton({ onClick, background, icon, label, small }) {
  // The End/Leave button intentionally stays the odd one out here —
  // slightly bigger and red, the same "the one button you don't want to
  // hit by accident, but need to find fast" emphasis every real calling
  // app (WhatsApp, Zoom, Meet) gives it. 58 vs. 52 keeps that without the
  // more dramatic 64 this used to be, which read as oversized once the
  // full five-button row is laid out on a wide desktop call screen.
  const size = small ? 52 : 58;
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
