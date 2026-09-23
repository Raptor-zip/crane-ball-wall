// Playwright E2E (GAME_DESIGN.md §10.7). Owner: O0.
//
// `npm run test:e2e` builds dist-test/ (VITE_TEST=1) and dist-single/ first, then:
//   project "e2e"    - tests/e2e/*.spec.ts against `vite preview` of dist-test/ (baseURL below);
//                      single-HTML tests open file://<dist-single>/index.html?yptest=1 (see SINGLE_HTML_URL).
//   project "demo"   - render-demo.spec.ts (O5) and ui-screens.spec.ts (O7) against the vite dev server,
//                      which is the only place dev/*.html demo pages are served (e.g. page.goto('/dev/render-demo.html')).
//   project "worker" - worker.spec.ts: builds the production bundle and runs it under `wrangler dev` with a
//                      throw-away local D1 (it starts and stops its own server; see tests/e2e/helpers.ts).
//
// Everything that could collide when several people (or agents) test from one working tree is configurable:
//   PW_PREVIEW_PORT / PW_DEV_PORT   ports of the preview / dev servers (default 4273 / 5273)
//   PW_WORKER_PORT                  wrangler dev port of worker.spec.ts (default PW_PREVIEW_PORT + 4000)
//   YP_DIST_TEST / YP_DIST_SINGLE   build directories (default dist-test / dist-single; vite.config.ts reads the same)
//   YP_E2E_WORKER_DIR               scratch directory of worker.spec.ts (default <tmp>/yp-e2e-worker-<port>)
//   PW_OUTPUT_DIR                   Playwright output (default test-results; it is emptied at the start of a run)
//   PW_SERVERS                      which web servers to start: "preview,dev" (default), "preview", "dev" or "none"
//   PW_WORKERS                      parallel workers (default 25% of the cores: every page renders WebGL on the CPU)
//   PW_CHROME_ARGS                  extra Chromium flags. Headless Chromium draws WebGL with SwiftShader (software);
//                                   to use the machine's GPU, e.g. PW_CHROME_ARGS="--enable-gpu --use-angle=vulkan --ignore-gpu-blocklist"
// Example: PW_PREVIEW_PORT=4606 PW_DEV_PORT=5606 YP_DIST_TEST=/tmp/me/dist-test YP_DIST_SINGLE=/tmp/me/dist-single \
//          PW_OUTPUT_DIR=/tmp/me/test-results npm run test:e2e -- --project e2e --project worker
import { defineConfig, devices } from '@playwright/test';

// Ports can be overridden so that several agents can run Playwright at the same time.
export const PREVIEW_PORT = Number(process.env.PW_PREVIEW_PORT ?? 4273);
export const DEV_PORT = Number(process.env.PW_DEV_PORT ?? 5273);
const DIST_TEST = process.env.YP_DIST_TEST || 'dist-test';
const DEMO_SPECS = /(render-demo|ui-screens)\.spec\.ts$/;
const WORKER_SPECS = /worker\.spec\.ts$/;
const SERVERS = (process.env.PW_SERVERS ?? 'preview,dev').split(',').map((s) => s.trim());
const CHROME_ARGS = (process.env.PW_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean);

const previewServer = {
  command: `npx vite preview --outDir ${JSON.stringify(DIST_TEST)} --port ${PREVIEW_PORT} --strictPort`,
  url: `http://localhost:${PREVIEW_PORT}/`,
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
};
const devServer = {
  command: `npx vite --port ${DEV_PORT} --strictPort`,
  url: `http://localhost:${DEV_PORT}/`,
  reuseExistingServer: !process.env.CI,
  timeout: 60_000,
};

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: process.env.PW_OUTPUT_DIR || 'test-results',
  fullyParallel: true,
  workers: /^\d+$/.test(process.env.PW_WORKERS ?? '') ? Number(process.env.PW_WORKERS) : process.env.PW_WORKERS || '25%',
  // a page draws WebGL with SwiftShader on the CPU: a whole run of the game takes tens of seconds on a busy machine
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: CHROME_ARGS },
  },
  webServer: [
    ...(SERVERS.includes('preview') ? [previewServer] : []),
    ...(SERVERS.includes('dev') ? [devServer] : []),
  ],
  projects: [
    {
      name: 'e2e',
      testIgnore: [DEMO_SPECS, WORKER_SPECS],
      // The game is Japanese first (§7.13 share texts, 「オフライン」 chip); en is covered by ui-screens.spec.ts.
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PREVIEW_PORT}`, locale: 'ja-JP' },
    },
    {
      name: 'demo',
      testMatch: DEMO_SPECS,
      use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${DEV_PORT}` },
    },
    {
      name: 'worker',
      testMatch: WORKER_SPECS,
      use: { ...devices['Desktop Chrome'], locale: 'ja-JP' },
    },
  ],
});
