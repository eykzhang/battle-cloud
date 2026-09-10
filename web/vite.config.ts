import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Cloudflare Pages serves whatever is here; the name is its "build output
    // directory" setting.
    outDir: 'dist',
    sourcemap: true,
  },
});
