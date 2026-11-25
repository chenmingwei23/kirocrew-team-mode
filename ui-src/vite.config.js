// Builds the Team Mode page to ../ui/index.mjs, the file app.json's ui.entry names.
// The host provides React, the SDK, the shared UI kit and lucide-react through its
// import map, so they stay external: bundling them would give the page a second
// React and break hooks.
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const HOST_PROVIDED = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  '@kirocrew/app-sdk',
  '@kirocrew/app-sdk/ui',
  'lucide-react',
]

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('../ui', import.meta.url)),
    emptyOutDir: true,
    target: 'es2020',
    minify: false,
    lib: {
      // index.mjs = the page (ui.entry); panel.mjs = the Bot page tab (contributes.panelTabs).
      entry: {
        index: fileURLToPath(new URL('./src/index.jsx', import.meta.url)),
        panel: fileURLToPath(new URL('./src/panel.jsx', import.meta.url)),
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.mjs`,
    },
    rollupOptions: { external: HOST_PROVIDED, output: { chunkFileNames: '[name].mjs' } },
  },
})
