import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** In browser dev mode (no Tauri) serve ~/.aura/daemon.json so the UI can
 *  connect to a running daemon. Never enabled in production builds. */
function auraDevDaemonInfo(): Plugin {
  return {
    name: "aura-dev-daemon-info",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__aura/daemon.json", (_req, res) => {
        const dir = process.env.AURA_DATA_DIR ?? path.join(os.homedir(), ".aura");
        try {
          const data = fs.readFileSync(path.join(dir, "daemon.json"), "utf8");
          res.setHeader("content-type", "application/json");
          res.end(data);
        } catch {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), auraDevDaemonInfo()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM == "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
