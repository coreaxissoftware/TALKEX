import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Served from the talkex.coreaxis.cloud subdomain, whose document root
  // points at this same build output — so it's the ROOT of that origin,
  // not a /talkex/ subpath, and root-absolute asset URLs are correct as-is.
  // 3000 and 8000 are taken by other projects on this machine's shared dev
  // config, so TalkEx runs on its own pair of ports.
  server: { port: 3020 },
  build: {
    rollupOptions: {
      output: {
        // The whole app was one ~900KB JS file, so every screen (chat,
        // status, photo editor, meetings...) had to be parsed and evaluated
        // before the first frame could paint — the biggest lever a
        // low/mid-range Android WebView has on "app feels slow to open".
        // Splitting vendor code from app code lets the two chunks be
        // parsed/cached independently, and vendor code (react etc.) only
        // needs re-parsing when a dependency actually changes, not on
        // every app release.
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
})
