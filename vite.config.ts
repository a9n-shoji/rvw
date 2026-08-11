import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { bundledPackageNotices, renderThirdPartyNotices } from "./scripts/third-party-notices.ts";

function thirdPartyNotices(): Plugin {
  return {
    name: "rvw-third-party-notices",
    generateBundle(_options, bundle) {
      const moduleIds = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const moduleId of Object.keys(output.modules)) moduleIds.add(moduleId);
      }
      this.emitFile({
        type: "asset",
        fileName: "THIRD_PARTY_NOTICES.txt",
        source: renderThirdPartyNotices(bundledPackageNotices(moduleIds), "web bundle"),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), thirdPartyNotices()],
  root: ".",
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/api": "http://127.0.0.1:4174",
    },
  },
});
