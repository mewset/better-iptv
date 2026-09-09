import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// The user-agent the app sends must name the version it actually is. Rust
// builds its half from CARGO_PKG_VERSION; this is the same number for the
// frontend, and sync-version.cjs keeps the two files in step.
import { appVersion } from "./scripts/app-version.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Build optimizations
  build: {
    // Use esbuild for fast minification
    minify: "esbuild",
    // Target modern browsers for smaller bundle
    target: "esnext",
    // Chunk splitting for better caching
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunk for React
          "react-vendor": ["react", "react-dom"],
          // UI libraries chunk
          "ui-vendor": ["lucide-react"],
          // State management chunk
          "state-vendor": ["zustand"],
          // Virtual scrolling chunk
          "virtual-vendor": ["@tanstack/react-virtual"],
        },
      },
    },
    // Enable source maps for production debugging (optional)
    sourcemap: false,
    // Chunk size warning limit (kB)
    chunkSizeWarningLimit: 500,
  },

  // Optimize dependencies
  optimizeDeps: {
    // Pre-bundle these dependencies for faster dev startup
    include: [
      "react",
      "react-dom",
      "zustand",
      "lucide-react",
      "@tanstack/react-virtual",
    ],
  },
}));
