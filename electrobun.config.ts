import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "mrClipper",
    identifier: "dev.mrclipper.app",
    version: "0.1.0",
  },
  build: {
    // Real Bun runtime (not Cottontail): the server uses Bun.serve, Bun.spawn and Bun.file.
    mainProcess: "bun",
    bun: { entrypoint: "src/desktop/index.ts" },
    // The standalone app carries its own UI/Director bundles and every tool it runs (scripts/vendor.ts).
    copy: {
      "dist/ui": "dist/ui",
      "dist/worker": "dist/worker",
      "vendor/runtime": "runtime",
      "vendor/models": "models",
      templates: "templates",
      sounds: "sounds",
    },
    win: { bundleCEF: false },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
