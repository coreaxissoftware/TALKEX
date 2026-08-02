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
})
