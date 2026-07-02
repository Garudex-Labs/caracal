/*
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

This file configures the React SPA Vite build.
*/
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    tailwindcss(),
    viteReact(),
  ],
  server: {
    // Bind the same console port as the packaged stack; the `caracal web` launcher stops the
    // packaged web container while the dev server runs so the two never contend for it.
    port: 3001,
    // Editors that save atomically (e.g. VS Code safe-write) replace the file
    // inode, which native inotify watches miss; polling makes HMR fire reliably
    // on Linux. macOS FSEvents and Windows watchers report directory-level
    // events, so native watching stays reliable there without the polling cost.
    watch: { usePolling: process.platform === "linux", interval: 120 },
  },
  preview: { port: 3001 },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
