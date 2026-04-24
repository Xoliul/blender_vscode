import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  root: __dirname,
  server: {
    port: 19320,
    proxy: {
      "/api": "http://127.0.0.1:19321",
      "/": {
        target: "http://127.0.0.1:19322",
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.path === "/") {
              proxyReq.setHeader("content-type", "application/json");
            }
          });
        }
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});
