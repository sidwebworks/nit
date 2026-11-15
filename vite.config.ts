import { readFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// The running nit that `bun run dev:ui` forwards /api to.
const api = `http://127.0.0.1:${process.env.NIT_PORT ?? 40123}`;

/** Pierre's self-contained highlighting worker, served beside the page (ui/pool.tsx). */
function pierreWorker(): Plugin {
  const file = join(import.meta.dirname, "node_modules/@pierre/diffs/dist/worker/worker-portable.js");
  return {
    name: "nit:pierre-worker",
    configureServer(server) {
      server.middlewares.use("/worker-portable.js", (_req, res) => {
        res.setHeader("content-type", "text/javascript");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "worker-portable.js", source: readFileSync(file) });
    },
  };
}

/** nit puts the saved theme and settings in the page before first paint; the dev server asks it for the same. */
const bootScript: Plugin = {
  name: "nit:boot",
  apply: "serve",
  transformIndexHtml: () => [{ tag: "script", attrs: { src: "/api/boot.js" }, injectTo: "head" }],
};

export default defineConfig({
  root: "src/ui",
  plugins: [react({ compiler: true }), tailwindcss(), pierreWorker(), bootScript],
  build: { sourcemap: true, chunkSizeWarningLimit: 4000 },
  server: {
    // nit only answers its own host and origin, so the proxy speaks as nit's own page.
    proxy: {
      "/api": {
        target: api,
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on("proxyReq", (req) => req.removeHeader("origin"));
          proxy.on("proxyReqWs", (req) => req.removeHeader("origin"));
        },
      },
    },
  },
});
