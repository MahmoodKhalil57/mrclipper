import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Clipdesk",
    identifier: "dev.clipdesk.cuttingroom",
    version: "0.1.0",
  },
  build: {
    // Real Bun runtime (not Cottontail): the server uses Bun.serve, Bun.spawn and Bun.file.
    mainProcess: "bun",
    bun: { entrypoint: "src/desktop/index.ts" },
    win: { bundleCEF: false },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
