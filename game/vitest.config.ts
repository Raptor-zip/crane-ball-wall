// Vitest projects (GAME_DESIGN.md §10.1, §10.6, §10.7). Owner: O0.
//
//   npm test             -> sim, data, core, input, store (tests/store + tests/net), ui, worker
//   npm run test:browser -> browser (tests/browser/*.browser.test.ts on chromium, firefox, webkit;
//                           audio.browser.test.ts on chromium only)
//
// Environments: sim / data / core run in plain Node (the simulation must not touch the DOM);
// input / store / ui get happy-dom (window, document, localStorage, KeyboardEvent ...).
// A single file can switch with a `// @vitest-environment <name>` comment on its first line.
// worker runs inside workerd via @cloudflare/vitest-pool-workers with a local D1 that has
// migrations/*.sql applied by tests/worker/setup.ts before every test file.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { playwright } from '@vitest/browser-playwright';

const migrations = await readD1Migrations('migrations');

/**
 * wrangler.jsonc asks for compatibility_date 2026-09-01 (§10.5), but the workerd bundled with
 * @cloudflare/vitest-pool-workers can be older than that and refuses to start. For tests only,
 * clamp the date to what that runtime supports (no-op once the pool ships a newer workerd).
 */
function testCompatibilityDate(): string | undefined {
  const wanted = /"compatibility_date"\s*:\s*"([0-9-]+)"/.exec(readFileSync('wrangler.jsonc', 'utf8'))?.[1];
  let runtimeMax: string | undefined;
  try {
    runtimeMax = (createRequire(import.meta.url)('workerd') as { compatibilityDate?: string }).compatibilityDate;
  } catch {
    runtimeMax = undefined;
  }
  return wanted && runtimeMax && runtimeMax < wanted ? runtimeMax : undefined;
}
const workerCompatDate = testCompatibilityDate();

const CHROMIUM_ONLY = 'tests/browser/audio.browser.test.ts';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: { name: 'sim', include: ['tests/sim/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'data', include: ['tests/data/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'core', include: ['tests/core/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: { name: 'input', include: ['tests/input/**/*.test.ts'], environment: 'happy-dom' },
      },
      {
        extends: true,
        test: {
          name: 'store',
          include: ['tests/store/**/*.test.ts', 'tests/net/**/*.test.ts'],
          environment: 'happy-dom',
        },
      },
      {
        extends: true,
        test: { name: 'ui', include: ['tests/ui/**/*.test.ts'], environment: 'happy-dom' },
      },
      {
        extends: true,
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              ...(workerCompatDate ? { compatibilityDate: workerCompatDate } : {}),
              // DEV / READ_ONLY pinned to the production values: a developer's local .dev.vars (DEV=1 for
              // `wrangler dev`, see README) is read by the pool too and must not change what the tests see.
              // Tests that need DEV=1 pass it per call (envOverride in tests/worker/helpers.ts).
              bindings: { TEST_MIGRATIONS: migrations, DEV: '0', READ_ONLY: '0' },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['tests/worker/**/*.test.ts'],
          setupFiles: ['tests/worker/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            // audio.browser.test.ts (O6, OfflineAudioContext) is chromium-only (§10.1); golden runs on all three.
            instances: [
              { browser: 'chromium' },
              { browser: 'firefox', exclude: [CHROMIUM_ONLY] },
              { browser: 'webkit', exclude: [CHROMIUM_ONLY] },
            ],
          },
        },
      },
    ],
  },
});
