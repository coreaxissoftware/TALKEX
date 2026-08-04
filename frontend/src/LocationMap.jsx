import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet's default marker relies on relative image paths (marker-icon.png
// etc.) that break once bundled by Vite — a plain divIcon sidesteps the
// asset-path problem entirely instead of wiring up three separate image
// imports just to get a pin. Colored to match the app's own accent so it
// doesn't look like a foreign widget dropped into the UI.
function pinIcon(color) {
  return L.divIcon({
    className: "",
    html: `<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;` +
          `background:${color};transform:rotate(-45deg);` +
          `border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45)"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  });
}

/**
 * A small OpenStreetMap view — no API key, no billing account, works the
 * same for every user out of the box. Two modes:
 *
 *   Preview (default): static, no zoom/pan/drag — used inside a chat
 *   bubble, where the surrounding message is what's clickable, not the map.
 *
 *   interactive: pan/zoom/click-to-move-pin/drag-to-move-pin, for the
 *   share-location picker, so a share can be confirmed or nudged before
 *   it ever goes out instead of blindly sending the device's raw GPS fix.
 */
export default function LocationMap({ lat, lng, height = 160, interactive = false, onPick, zoom = 15, color = "#6366f1" }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);

  // Mount once — coordinate changes are applied via setView/setLatLng in
  // the effect below rather than tearing the map (and its tile requests)
  // down and rebuilding on every position update, which matters for the
  // live-location bubble that re-renders on every watchPosition tick.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [lat, lng],
      zoom,
      zoomControl: interactive,
      dragging: interactive,
      scrollWheelZoom: false,
      doubleClickZoom: interactive,
      touchZoom: interactive,
      boxZoom: false,
      keyboard: false,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
    }).addTo(map);

    markerRef.current = L.marker([lat, lng], { icon: pinIcon(color), draggable: interactive }).addTo(map);

    if (interactive && onPick) {
      markerRef.current.on("dragend", () => {
        const pos = markerRef.current.getLatLng();
        onPick(pos.lat, pos.lng);
      });
      map.on("click", (event) => {
        markerRef.current.setLatLng(event.latlng);
        onPick(event.latlng.lat, event.latlng.lng);
      });
    }

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; markerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    mapRef.current.setView([lat, lng]);
    markerRef.current.setLatLng([lat, lng]);
  }, [lat, lng]);

  return <div ref={containerRef} style={{ height, width: "100%", borderRadius: 10, overflow: "hidden" }}/>;
}
