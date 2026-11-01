import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const repoRoot = resolve(srcDir, '..');
const requireFromSrc = createRequire(resolve(srcDir, 'package.json'));

/**
 * Configuração Vitest para a suíte de aceitação Gherkin em `testes/`.
 * Resolve pacotes bare de `src/node_modules` mantendo `testes/` na raiz do repositório.
 *
 * @spec SPEC-01
 * @spec SPEC-03
 * @spec SPEC-04
 * @spec SPEC-05
 * @spec SPEC-06
 * @spec SPEC-08
 * @spec SPEC-09
 * @rnf RNF-11
 * @rnf RNF-19
 * @rnf RNF-21
 */
export default defineConfig({
  root: repoRoot,
  plugins: [
    {
      name: 'resolve-src-node-modules',
      enforce: 'pre',
      resolveId(source) {
        if (
          source.startsWith('.') ||
          source.startsWith('/') ||
          source.startsWith('node:') ||
          source.startsWith('vitest') ||
          source.startsWith('@tradepilot/') ||
          /^[a-zA-Z]:[\\/]/.test(source)
        ) {
          return null;
        }
        try {
          const resolved = requireFromSrc.resolve(source);
          return { id: resolved, external: true };
        } catch {
          return null;
        }
      },
    },
  ],
  resolve: {
    alias: {
      '@tradepilot/shared': resolve(srcDir, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    include: ['testes/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
