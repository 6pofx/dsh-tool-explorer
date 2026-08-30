import { defineConfig } from 'tsdown'

/**
 * Client bundle build: cjs + browser platform so every runtime import stays a
 * `require()` the __ModuleLoader__ factory can resolve from the module table.
 * Only shell-seed externals are allowed by the bundle-purity gate — react
 * family and the host-injected primitives module. `wrap-client.mjs` then
 * encloses the output in the loader factory banner.
 */
export default defineConfig({
  entry: ['src/client/index.ts'],
  format: ['cjs'],
  platform: 'browser',
  outDir: 'client',
  deps: {
    neverBundle: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  },
  sourcemap: true,
  dts: false,
  clean: true,
  outputOptions: {
    entryFileNames: 'client.js',
  },
})
