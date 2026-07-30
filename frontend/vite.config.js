import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 3000 and 8000 are taken by other projects on this machine's shared dev
  // config, so TalkEx runs on its own pair of ports.
  server: { port: 3020 },
})
