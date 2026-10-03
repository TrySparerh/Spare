import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Vendor code goes into separately cached chunks (viem, wagmi, react,
    // react-query, i18next, and WalletConnect when VITE_WC_PROJECT_ID is set
    // at build time), so a deploy that only changes app code leaves them
    // cached.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;

          // WalletConnect alone is ~1.5 MB; isolated so it caches
          // independently of wagmi upgrades.
          if (id.includes('@walletconnect') || id.includes('@reown')) return 'walletconnect';
          // viem is heavy but stable across releases.
          if (id.includes('/viem/') || id.endsWith('/viem')) return 'viem';
          if (id.includes('wagmi')) return 'wallet';

          if (id.includes('react-router') || id.includes('react-dom') || /\/node_modules\/react\//.test(id)) {
            return 'react-core';
          }

          if (id.includes('@tanstack/react-query')) return 'query';
          // i18next + react-i18next: stable, cached apart from app code. The
          // Chinese strings are separate lazy chunks (src/i18n/load/*).
          if (id.includes('i18next')) return 'i18n';

          // Everything else stays in the default vendor chunk Vite picks.
          return undefined;
        },
      },
    },
    // 1500 KB warning ceiling: the main chunk is still over Vite's 500 KB
    // default, so the default warning would fire on every build.
    chunkSizeWarningLimit: 1500,
  },
}));
