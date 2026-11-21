'use strict';

// Optional real-GPU fixture; it does not add a runtime browser dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Explicitly optional outside a GPU test environment. */ }
const root = path.resolve(__dirname, '..');
const required = (process.env.REQUIRE_SKY_CLOUDS || process.env.REQUIRE_WORLD_CLOUDS) === '1';

test('sky clouds stay behind opaque surfaces at all viewing altitudes', {
  skip: !chromium && !required ? 'Playwright is optional; configure NODE_PATH to run the cloud GPU test.' : false,
  timeout: 120000
}, async t => {
  assert.ok(chromium, 'Playwright is required for the cloud regression test');
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return response.writeHead(404).end();
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
  });
  let browser;
  const errors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ headless: true, ...(process.env.OCEAN_BROWSER_CHANNEL ? { channel: process.env.OCEAN_BROWSER_CHANNEL } : {}) });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/cloud-volume-scene.html`);
    await page.waitForFunction(() => window.cloudVolumeStress || window.cloudVolumeError, null, { timeout: 45000 });
    assert.equal(await page.evaluate(() => window.cloudVolumeError), undefined, 'sky background fixture initializes');
    const report = await page.evaluate(() => window.cloudVolumeStress.runChecks());
    if (process.env.CLOUD_VOLUME_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.CLOUD_VOLUME_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.CLOUD_VOLUME_ARTIFACT_DIR, 'cloud-volume-report.json'), JSON.stringify(report, null, 2));
      const images = await page.evaluate(() => window.cloudVolumeImages);
      for (const [name, data] of Object.entries(images)) fs.writeFileSync(path.join(process.env.CLOUD_VOLUME_ARTIFACT_DIR, 'cloud-volume-' + name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    }
    t.diagnostic(JSON.stringify(report));
    assert.deepEqual(errors, [], 'no cloud shader, framebuffer or browser errors');
    assert(report.weatherSky.changedPixels > 500, 'weather changes the sky');
    assert.equal(report.foreground.maximum, 0, 'cloud and weather changes leave opaque foreground intact');
    for (const view of report.altitudes) {
      assert(view.sky.maximum <= 1, 'sky texture depends on direction only at ' + view.altitude + ' m');
      assert.equal(view.foreground.maximum, 0, 'no cloud crosses the foreground at ' + view.altitude + ' m');
    }
    assert(report.cached, 'sub-interval updates reuse the cached sky');
    assert(report.drift.changedPixels > 500, 'clouds drift with the animation clock');
    assert.equal(report.foregroundDrift.maximum, 0, 'drift does not alter the foreground');
    assert(report.temporal.active, 'the temporal path is exercised');
    assert(report.temporal.sky.changedPixels > 500, 'background drift is visible with reconstruction enabled');
    assert(report.temporal.foreground.maximum <= 1, 'opaque foreground is stable with reconstruction enabled');
    assert(report.horizon.water.changedPixels > 8000, 'distant coastal water extends beyond the far clip');
    assert.equal(report.horizon.sky.maximum, 0, 'the sea background stays below the horizon');
    assert.equal(report.horizon.overviewOpacity, 0, 'the regional view preserves the survey boundary');
    assert.equal(report.horizon.inland.maximum, 0, 'a broad land edge does not become a distant sea');
    assert.equal(report.horizon.landOnlyOpacity, 0, 'an inland-only dataset has no offshore horizon');
    assert(report.moon.full.changedPixels > 100, 'an above-horizon full moon is visible');
    assert(report.moon.rainy.mean < report.moon.full.mean * 0.6, 'dense cloud cover attenuates the lunar disk');
    assert(report.moon.sunward.mean > report.moon.away.mean + 10, 'the illuminated half faces the Sun');
    assert.equal(report.moon.occluded.maximum, 0, 'foreground geometry hides the lunar disk');
    assert.equal(report.moon.below.maximum, 0, 'the lunar disk disappears below the horizon');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
