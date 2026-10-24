import { readFileSync } from "node:fs";

// Keep the runtime self-hosted, lazily loaded and outside the JS bundler.
// Single-thread WASM works on GitHub Pages without COOP/COEP headers.
export function libavAssets() {
  const root = new URL("../node_modules/@libav.js/variant-webm-vp9/dist/", import.meta.url);
  const prefix = "libav-6.10.9.0-webm-vp9";
  const names = [`${prefix}.mjs`, `${prefix}.wasm.mjs`, `${prefix}.wasm.wasm`];
  const assets = () => names.map(name => ({ name, bytes: readFileSync(new URL(name, root)) }));
  return {
    name: "libav-runtime-assets",
    configureServer(server) {
      const files = new Map(assets().map(item => [item.name, item.bytes]));
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split("?")[0]?.split("/vendor/libav/")[1];
        if (!files.has(name)) return next();
        response.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        response.end(files.get(name));
      });
    },
    generateBundle() {
      for (const { name, bytes } of assets()) this.emitFile({ type: "asset", fileName: `vendor/libav/${name}`, source: bytes });
    },
  };
}
