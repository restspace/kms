import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Public build target (docs/03 §3): the React API aliased onto preact/compat,
 * so the CFP island ships ~13 KB gzip against a 60 KB budget. The admin SPA
 * gets its own config bundling real React.
 */
export default defineConfig({
  root: r('.'),
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: {
    // Aliases are prefix-matched in declaration order, so the specific entries
    // must precede `react`/`react-dom` or they never get a chance to match.
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: 'preact/jsx-runtime' },
      { find: /^react\/jsx-dev-runtime$/, replacement: 'preact/jsx-dev-runtime' },
      { find: /^react-dom\/client$/, replacement: 'preact/compat/client' },
      { find: /^react-dom$/, replacement: 'preact/compat' },
      { find: /^react$/, replacement: 'preact/compat' },
    ],
    // preact/jsx-runtime and preact/compat must share ONE preact instance, or
    // hooks register on a different `options` object than the renderer uses and
    // hydration dies on `undefined.__H`.
    dedupe: ['preact', 'preact/compat', 'preact/hooks', 'preact/jsx-runtime'],
  },
  build: {
    outDir: r('dist/static'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: { hello: r('src/hello.client.tsx') },
      output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' },
    },
  },
})
