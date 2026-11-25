// Builds the screenshot-only preview shell (preview/shell.jsx) to preview/dist/shell.js.
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: fileURLToPath(new URL('./shell.jsx', import.meta.url)),
      formats: ['es'],
      fileName: () => 'shell.js',
    },
  },
})
