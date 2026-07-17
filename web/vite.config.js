import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Relative asset base so the build works behind any reverse-proxy prefix
  // (e.g. Caddy /standup/* strip-prefix). See renderBuiltUrl below for the
  // talk page, which is served two path levels deep (u/<token>).
  base: '',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  build: {
    outDir: '../src/public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        talk: path.resolve(__dirname, 'talk.html'),
      },
    },
  },
  experimental: {
    // index.html is served at the component root -> plain relative URLs.
    // talk.html is served at u/<token> (one directory deeper) -> assets need
    // a ../ prefix to resolve back to <prefix>/assets/*.
    renderBuiltUrl(filename, { hostId, hostType }) {
      if (hostType === 'html' && hostId.endsWith('talk.html')) return '../' + filename;
      return { relative: true };
    },
  },
  server: {
    // Dev: run the backend on 127.0.0.1:3478 and open
    //   http://localhost:5173/           (admin SPA)
    //   http://localhost:5173/talk.html?token=<member-token>   (talk page)
    proxy: {
      '/api': { target: 'http://127.0.0.1:3478', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:3478', ws: true },
    },
  },
});
