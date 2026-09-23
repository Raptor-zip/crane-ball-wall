// Playwright driver: headless Chromium opens the worker page, runs the benchmark cases,
// and dumps the page result (timings, transfer sizes, trajectories) as JSON.
import * as pw from '/home/somak/ball-wall/game/node_modules/playwright/index.mjs';
import fs from 'fs';
import os from 'os';

const PORT = process.env.PORT || 8731;
const cases = process.argv[2] || 'a_1-2_scratch,d_editor';
const stream = process.argv[3] === 'stream' ? '&stream=1' : '';
const outFile = process.argv[4] || '/tmp/claude-1000/yp-casadi-verify/browser_result.json';

const engine = process.env.PW_ENGINE || 'chromium';
const browser = await pw[engine].launch({ headless: true });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 500)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/web/index.html?cases=${cases}${stream}`, { waitUntil: 'load' });
await page.waitForFunction('window.__done === true', null, { timeout: 900000 });
const result = await page.evaluate('window.__result');
result.wallSeconds = (Date.now() - t0) / 1000;
result.load = os.loadavg();
result.userAgent = await page.evaluate('navigator.userAgent');
result.logs = logs.filter((l) => !l.includes('unsupported syscall')).slice(0, 40);
fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(await page.evaluate('document.getElementById("out").textContent'));
console.log('wall', result.wallSeconds.toFixed(1), 's; UA', result.userAgent);
await browser.close();
