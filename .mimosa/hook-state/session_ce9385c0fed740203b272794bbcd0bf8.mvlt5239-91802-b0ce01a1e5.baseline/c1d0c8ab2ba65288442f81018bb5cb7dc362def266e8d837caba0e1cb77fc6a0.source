import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Vite 8 uses Rolldown; keep React in a stable, long-cache vendor chunk.
    // Route-only heavy dependencies (ECharts, dnd-kit, QR/fingerprint) are
    // intentionally left to dynamic imports instead of forcing them into the
    // initial vendor chunk.
    //
    // react-router is deliberately NOT in this group: only the admin SPA
    // (index.html) imports it. The group is shared by both entry points, and a
    // group travels as one chunk — grouping the router here shipped ~170KB of
    // minified react-router to every public survey/submissions visitor who
    // never executes it. Left ungrouped it lands in the admin's own graph.
    rolldownOptions: {
      input: {
        main: "index.html",
        survey: "survey.html",
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "icon-vendor",
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 20,
            },
            {
              name: "editor-vendor",
              test: /node_modules[\\/]@dnd-kit[\\/]/,
              priority: 20,
            },
            {
              name: "qrcode-vendor",
              test: /node_modules[\\/]qrcode\.react[\\/]/,
              priority: 20,
            },
            {
              name: "fingerprint-vendor",
              test: /node_modules[\\/]@fingerprintjs[\\/]fingerprintjs[\\/]/,
              priority: 20,
            },
            {
              name: "telegram-vendor",
              test: /node_modules[\\/]@telegram-apps[\\/]sdk[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
});
