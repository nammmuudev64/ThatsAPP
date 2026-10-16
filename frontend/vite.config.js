// Vite configures the React JSX transform and the local frontend development server.
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // Read PORT from backend/.env so the proxy target always matches the Express server.
  const backendEnv = loadEnv(mode, fileURLToPath(new URL('../backend', import.meta.url)), '')
  const backendTarget = `http://localhost:${backendEnv.PORT || 5005}`

  return {
    plugins: [react()],
    server: {
      // Bind on all interfaces for LAN access; browser API requests are forwarded to Express.
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          // Keep frontend calls same-origin during development and avoid CORS in the browser.
          target: backendTarget,
          changeOrigin: true,
        },
        '/socket.io': {
          // Live events (messages, notifications, presence) travel over Socket.IO, including WebSocket upgrades.
          target: backendTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  }
})
