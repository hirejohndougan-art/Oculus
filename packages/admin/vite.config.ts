// The admin's build (D-073): React with SWC on the pinned Vite 7. In
// development the Vite server forwards /api to Fastify on 127.0.0.1 with
// changeOrigin off, so the browser sees one origin and the Origin, Host,
// cookie and CSRF checks run unchanged (list http://localhost:5173 in
// OCULUS_ORIGINS and OCULUS_ADMIN_ORIGIN).
import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No inline scripts or styles anywhere: the admin's CSP allows 'self' only.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
    // React, the router, Query and React Aria come to about 190 KB gzipped (D-073).
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: "localhost",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
});
