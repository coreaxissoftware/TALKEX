/**
 * MusicPicker — WhatsApp-style music browser for status posts.
 *
 * Uses the iTunes Search API (proxied through backend to avoid CORS).
 * Shows trending categories, search, and 30-second previews.
 */
import { useEffect, useRef, useState } from "react";
import { Music } from "./api.js";
import { G, I } from "./ui.jsx";

const CATEGORIES = [
  { key: "bollywood", label: "🇮🇳 Bollywood", query: "bollywood hits" },
  { key: "pop", label: "🎵 Pop", query: "pop hits 2025" },
  { key: "hiphop", label: "🎤 Hip Hop", query: "hip hop trending" },
  { key: "romantic", label: "💕 Romantic", query: "romantic songs" },
  { key: "sad", label: "😢 Sad", query: "sad songs" },
  { key: "party", label: "🎉 Party", query: "party dance songs" },
  { key: "lofi", label: "🌙 Lo-Fi", query: "lofi beats" },
  { key: "edm", label: "⚡ EDM", query: "edm electronic" },
];

function formatDuration(ms) {
  if (!ms) return "";
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export default function MusicPicker({ onSelect, onClose }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState(null);
  const [playing, setPlaying] = useState(null); // track id currently playing
  const audioRef = useRef(null);
  const searchTimer = useRef(null);

  // Load default results on mount
  useEffect(() => {
    doSearch("trending popular songs");
  }, []);

  function doSearch(q) {
    setLoading(true);
    Music.search(q, 25)
      .then((data) => {
        setResults(data.results || []);
        setLoading(false);
      })
      .catch(() => {
        setResults([]);
        setLoading(false);
      });
  }

  function onQueryChange(e) {
    const val = e.target.value;
    setQuery(val);
    setActiveCategory(null);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (val.trim()) doSearch(val.trim());
    }, 400);
  }

  function selectCategory(cat) {
    setActiveCategory(cat.key);
    setQuery("");
    doSearch(cat.query);
  }

  function togglePlay(track) {
    if (playing === track.id) {
      // Stop
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlaying(null);
    } else {
      // Play new
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(track.previewUrl);
      audio.play().catch(() => {});
      audio.onended = () => setPlaying(null);
      audioRef.current = audio;
      setPlaying(track.id);
    }
  }

  function handleSelect(track) {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setPlaying(null);
    onSelect(track);
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0a0a0a", zIndex: 80,
      display: "flex", flexDirection: "column",
      animation: "txEditorSlideIn 0.3s ease-out",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", padding: "14px 16px", gap: 12,
        borderBottom: "1px solid #ffffff12",
      }}>
        <div onClick={onClose} style={{
          width: 32, height: 32, borderRadius: "50%", background: "#ffffff14",
          display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", color: "#fff", fontSize: 18,
        }}>✕</div>
        <div style={{ flex: 1, fontSize: 17, fontWeight: 700, color: "#fff" }}>
          Choose Music
        </div>
      </div>

      {/* Search bar */}
      <div style={{ padding: "10px 16px" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
          borderRadius: 12, background: "#ffffff12",
        }}>
          {I.search("#ffffff66", 18)}
          <input
            type="text"
            placeholder="Search songs, artists..."
            value={query}
            onChange={onQueryChange}
            style={{
              flex: 1, border: "none", outline: "none", background: "transparent",
              color: "#fff", fontSize: 14, fontFamily: "inherit",
            }}
          />
          {query && (
            <div onClick={() => { setQuery(""); doSearch("trending popular songs"); }}
                 style={{ cursor: "pointer", color: "#ffffff66", fontSize: 16 }}>✕</div>
          )}
        </div>
      </div>

      {/* Category chips */}
      <div style={{
        display: "flex", gap: 8, padding: "0 16px 10px", overflowX: "auto", flexShrink: 0,
      }}>
        {CATEGORIES.map((cat) => (
          <div key={cat.key} onClick={() => selectCategory(cat)} style={{
            padding: "6px 14px", borderRadius: 20, fontSize: 12, flexShrink: 0,
            cursor: "pointer", whiteSpace: "nowrap",
            background: activeCategory === cat.key ? `${G.accent}33` : "#ffffff12",
            color: activeCategory === cat.key ? G.accent : "#ffffffcc",
            border: `1px solid ${activeCategory === cat.key ? G.accent + "55" : "transparent"}`,
          }}>{cat.label}</div>
        ))}
      </div>

      {/* Results list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 16px" }}>
        {loading && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 40, color: "#ffffff66",
          }}>
            <div style={{
              width: 24, height: 24, border: "2.5px solid #ffffff33",
              borderTopColor: G.accent, borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }}/>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {!loading && results.length === 0 && (
          <div style={{
            textAlign: "center", padding: 40, color: "#ffffff44", fontSize: 14,
          }}>
            {query ? "No songs found" : "Search for music"}
          </div>
        )}

        {results.map((track) => (
          <div key={track.id} style={{
            display: "flex", alignItems: "center", gap: 12, padding: "10px 0",
            borderBottom: "1px solid #ffffff08",
          }}>
            {/* Album art + play button */}
            <div onClick={() => togglePlay(track)} style={{
              width: 48, height: 48, borderRadius: 8, overflow: "hidden",
              flexShrink: 0, position: "relative", cursor: "pointer",
            }}>
              <img src={track.artwork} alt=""
                   referrerPolicy="no-referrer"
                   onError={(e) => { e.target.style.display = "none"; }}
                   style={{
                width: "100%", height: "100%", objectFit: "cover",
              }}/>
              <div style={{
                position: "absolute", inset: 0,
                background: playing === track.id ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.2)",
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "background 0.15s",
              }}>
                {playing === track.id ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
                    <rect x="6" y="4" width="4" height="16" rx="1"/>
                    <rect x="14" y="4" width="4" height="16" rx="1"/>
                  </svg>
                ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff">
                    <polygon points="8,5 19,12 8,19"/>
                  </svg>
                )}
              </div>
            </div>

            {/* Track info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: "#fff",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>{track.title}</div>
              <div style={{
                fontSize: 12, color: "#ffffff88", marginTop: 2,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>{track.artist}</div>
              <div style={{ fontSize: 11, color: "#ffffff44", marginTop: 1 }}>
                {track.genre}{track.duration ? ` · ${formatDuration(track.duration)}` : ""}
              </div>
            </div>

            {/* Select button */}
            <div onClick={() => handleSelect(track)} style={{
              padding: "6px 14px", borderRadius: 20, cursor: "pointer",
              background: `${G.accent}22`, color: G.accent,
              border: `1px solid ${G.accent}55`,
              fontSize: 12, fontWeight: 600, flexShrink: 0,
            }}>Use</div>
          </div>
        ))}
      </div>
    </div>
  );
}
