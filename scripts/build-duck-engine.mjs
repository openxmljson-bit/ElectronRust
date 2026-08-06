/**
 * Bundle the vendored GigaTables DuckDB engine (TypeScript) into a single CJS
 * file the Electron main process spawns as a utilityProcess:
 *
 *   duck-engine/engine/host.ts  ->  dist/engine/engine.cjs
 *
 * The DuckDB bindings are a native addon and MUST stay an external require so
 * they load from node_modules at runtime (electron-builder unpacks them).
 */
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

// The vendored TS uses ESM-style `./x.js` specifiers that actually point at
// `./x.ts`. Map them back so esbuild can resolve them.
const tsExtensionFix = {
  name: 'ts-extension-fix',
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const asTs = resolvePath(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      if (existsSync(asTs)) return { path: asTs };
      return null;
    });
  },
};

const target = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: dev ? 'inline' : true,
  minify: !dev,
  logLevel: 'info',
  plugins: [tsExtensionFix],
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  entryPoints: [resolvePath(root, 'duck-engine/engine/host.ts')],
  outfile: resolvePath(root, 'dist/engine/engine.cjs'),
  // Native addon: keep it a real runtime require.
  external: ['@duckdb/node-api', '@duckdb/node-bindings'],
};

if (watch) {
  const ctx = await esbuild.context(target);
  await ctx.watch();
  console.log('[build-duck-engine] watching for changes…');
} else {
  await esbuild.build(target);
  console.log('[build-duck-engine] done -> dist/engine/engine.cjs');
}
