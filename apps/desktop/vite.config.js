import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
/** In browser dev mode (no Tauri) serve ~/.aura/daemon.json so the UI can
 *  connect to a running daemon. Never enabled in production builds. */
function auraDevDaemonInfo() {
    return {
        name: "aura-dev-daemon-info",
        apply: "serve",
        configureServer: function (server) {
            server.middlewares.use("/__aura/daemon.json", function (_req, res) {
                var _a;
                var dir = (_a = process.env.AURA_DATA_DIR) !== null && _a !== void 0 ? _a : path.join(os.homedir(), ".aura");
                try {
                    var info = JSON.parse(fs.readFileSync(path.join(dir, "daemon.json"), "utf8"));
                    // Development only: a daemon started by hand with --window-secret-stdin, and the same
                    // secret in AURA_DEV_WINDOW_SECRET, lets this dev window approve. Never in a build.
                    if (process.env.AURA_DEV_WINDOW_SECRET)
                        info.windowSecret = process.env.AURA_DEV_WINDOW_SECRET;
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify(info));
                }
                catch (_b) {
                    res.statusCode = 404;
                    res.end("{}");
                }
            });
        },
    };
}
var host = process.env.TAURI_DEV_HOST;
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
