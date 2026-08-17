/**
 * GifPicker — composer's animated-GIF search, backed by Tenor via the
 * backend proxy (see /api/gifs/search in main.py). Picking a result hands
 * its {gif_url, preview_url, width, height} straight to onSelect — nothing
 * is uploaded or re-hosted, the message just carries the Tenor URL, the
 * same lightweight external-URL shape MusicPicker's music_url already uses.
 */
import { useEffect, useRef, useState } from "react";
import { Gifs } from "./api.js";
import { G, I } from "./ui.jsx";

export default function GifPicker({ onSelect, onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notConfigured, setNotConfigured] = useState(false);
  const searchTimer = useRef(null);

  function doSearch(q) {
    setLoading(true);
    Gifs.search(q, 30)
      .then((data) => { setResults(data.results || []); setNotConfigured(false); })
      .catch((problem) => { setResults([]); setNotConfigured(problem.status === 503); })
      .finally(() => setLoading(false));
  }

  useEffect(() => { doSearch(""); }, []);

  function onQueryChange(event) {
    const value = event.target.value;
    setQuery(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => doSearch(value.trim()), 400);
  }

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 1300, background: "#000000aa",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(event) => event.stopPropagation()} style={{
        width: "100%", maxWidth: 430, height: "70vh", background: G.surface,
        borderTopLeftRadius: 22, borderTopRightRadius: 22, border: `1px solid ${G.border}`,
        display: "flex", flexDirection: "column", color: G.text,
      }}>
        <div style={{ padding: "16px 16px 10px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 17, fontWeight: 700, flex: 1 }}>GIFs</div>
          <div onClick={onClose} style={{ cursor: "pointer", padding: 4 }}>{I.close?.(G.sub, 20) || "✕"}</div>
        </div>
        <div style={{ padding: "0 16px 12px" }}>
          <input value={query} onChange={onQueryChange} placeholder="Search Tenor…"
                 autoFocus style={{
                   width: "100%", padding: "10px 14px", borderRadius: 12,
                   border: `1px solid ${G.border}`, background: G.dim, color: G.text, fontSize: 14,
                 }}/>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "0 12px 16px" }}>
          {notConfigured ? (
            <div style={{ padding: 30, textAlign: "center", color: G.muted, fontSize: 13.5 }}>
              GIF search isn't set up on this server yet.
            </div>
          ) : loading ? (
            <div style={{ padding: 30, textAlign: "center", color: G.muted, fontSize: 13.5 }}>Loading…</div>
          ) : results.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: G.muted, fontSize: 13.5 }}>
              No GIFs found.
            </div>
          ) : (
            <div style={{ columnCount: 2, columnGap: 8 }}>
              {results.map((gif) => (
                <img key={gif.id} src={gif.preview_url} alt=""
                     onClick={() => onSelect(gif)}
                     style={{
                       width: "100%", display: "block", marginBottom: 8, borderRadius: 10,
                       cursor: "pointer", background: G.dim,
                     }}/>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
