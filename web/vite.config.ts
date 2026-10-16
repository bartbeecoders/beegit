/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI on http://localhost:5173 and proxies the gRPC-Web calls
// (/beegit.v1.*) to the local server started by scripts/start.sh. Override the target with
// BEEGIT_DEV_API, e.g. BEEGIT_DEV_API=https://beegit.hideterms.com npm run dev.
const api = process.env.BEEGIT_DEV_API ?? "https://localhost:7443";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/beegit.v1.": {
        target: api,
        changeOrigin: true,
        secure: false, // the local server uses BeeGit's private CA
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
