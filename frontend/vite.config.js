import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Deployed under coreaxis.cloud/talkex/, not the domain root — without
  // this, the build emits root-absolute asset URLs (/assets/...) that
  // resolve to the unrelated app living at the actual domain root and
  // 404. The dev server itself is still served from "/" locally.
  base: mode === 'production' ? '/talkex/' : '/',
  // 3000 and 8000 are taken by other projects on this machine's shared dev
  // config, so TalkEx runs on its own pair of ports.
  server: { port: 3020 },
}))
