import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the frontend (`:5173`) resolves API_BASE to the relative `/api` and
// relies on this proxy to reach the API server (`:8787`). This mirrors
// production, where Firebase Hosting rewrites `/api/**` to the Cloud Function on
// the same origin — so `npm run dev` works with no VITE_API_BASE_URL set.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.AGENT_API_PORT || 8787}`,
        changeOrigin: true,
      },
    },
  },
});