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
const required = process.env.REQUIRE_WORLD_CLOUDS === '1';

test('world cloud layers remain visible above, inside and below their physical heights', {
  skip: !chromium && !required ? 'Playwright is optional; configure NODE_PATH to run the cloud GPU test.' : false,
  timeout: 120000
}, async t => {
  assert.ok(chromium, 'Playwright is required when REQUIRE_WORLD_CLOUDS=1');
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
    assert.equal(await page.evaluate(() => window.cloudVolumeError), undefined, 'world cloud fixture initializes');
    const report = await page.evaluate(() => window.cloudVolumeStress.runChecks());
    if (process.env.CLOUD_VOLUME_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.CLOUD_VOLUME_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.CLOUD_VOLUME_ARTIFACT_DIR, 'cloud-volume-report.json'), JSON.stringify(report, null, 2));
      const images = await page.evaluate(() => window.cloudVolumeImages);
      for (const [name, data] of Object.entries(images)) fs.writeFileSync(path.join(process.env.CLOUD_VOLUME_ARTIFACT_DIR, 'cloud-volume-' + name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    }
    t.diagnostic(JSON.stringify(report));
    assert.deepEqual(errors, [], 'no cloud shader, framebuffer or browser errors');
    for (const view of report.views) {
      assert(view.effect.changedPixels > 500, 'world clouds are visible in the ' + view.name + ' view');
      assert(view.effect.mean > 0.2, 'world clouds contribute measurable opacity in the ' + view.name + ' view');
    }
    assert.deepEqual(report.regional.map(item => item.altitudeM), [70000, 250000, 220000], 'regional views cover top-down and diagonal maximum-distance camera poses');
    for (const item of report.regional) {
      assert(item.farM >= 350000, 'regional clouds are tested with an adequate far plane');
      assert(item.effect.changedPixels > 200, 'clouds remain visible from ' + item.altitudeM + ' m above the model');
    }
    assert(report.drift.difference.changedPixels > 200, 'world clouds drift at fixed camera and geometry');
    assert.equal(report.cache.sameTime.raymarchUpdates, report.cache.before.raymarchUpdates, 'same-camera same-time frames reuse cloud integration');
    assert.equal(report.cache.sameTime.reflectionUpdates, report.cache.before.reflectionUpdates, 'same-time frames reuse reflection columns');
    assert.equal(report.cache.shortStep.raymarchUpdates, report.cache.before.raymarchUpdates, 'sub-update clock steps do not remarch cloud rays');
    assert.equal(report.idle.difference.changedPixels, 0, 'cloud framebuffer stays frozen without draw requests');
    assert.deepEqual(report.idle.after, report.idle.before, 'world cloud state has no independent idle timer');
    assert(report.depth.whole.changedPixels > 500, 'depth scene still contains visible cloud outside the occluder');
    assert(report.depth.center.maximum <= 2, 'foreground opaque geometry completely occludes the clouds behind it');
    assert.equal(report.temporal.active, true, 'world clouds work after temporal reconstruction');
    assert(report.temporalDrift.changedPixels > 200, 'temporal history does not freeze the composited moving clouds');
    assert.equal(report.hidden.visible, false, 'cloud layers behind a downward-facing camera are culled');
    assert.equal(report.hidden.effect.maximum, 0, 'hidden clouds preserve the scene image');
    assert.equal(report.hidden.after.raymarchUpdates, report.hidden.before.raymarchUpdates, 'hidden layers do not raymarch');
    assert(report.reflection.finite, 'world-cloud reflection samples are finite');
    assert(report.reflection.drift.mean > 0.001, 'moving world clouds change the reflected column field');
    assert(report.reflection.minimumTransmission < 0.9 && report.reflection.maximumTransmission > report.reflection.minimumTransmission + 0.05, 'cloud column coverage modulates sunlight');
    assert(report.reflection.fallbackError < 0.00001, 'disabled world clouds preserve background and full sunlight');
    assert.equal(report.restoration.sameTarget, true, 'cloud passes restore the caller render target');
    assert.deepEqual(report.restoration.after, report.restoration.before, 'cloud passes restore renderer state');
    assert.deepEqual(report.restoration.cameraAfter, report.restoration.cameraBefore, 'cloud passes leave the caller camera unchanged');
    assert.deepEqual(report.final.layerHeightsM, [[1800, 3200], [5000, 5700]], 'two cloud layers retain physical world heights');
    assert.equal(report.final.noiseVolumeSize, 128, 'world-cloud density uses the bounded 128-cubed noise volume');
    assert(report.final.raymarchSize[0] <= 1280 && report.final.raymarchSize[1] <= 800, 'raymarch buffer stays bounded');
    assert(report.final.estimatedTextureMiB < 32, 'cloud textures stay within the focused fixture memory budget');
    assert.deepEqual(report.dpr.map(item => item.ratio), [1.25, 0.75], 'the fixture exercises DPR above and below one');
    for (const item of report.dpr) {
      assert.deepEqual(item.scaledSize, [720 * item.ratio, 480 * item.ratio], 'logical and physical dimensions remain distinct');
      assert(item.coarseRMSE < 8, 'DPR changes preserve the normalized cloud view rather than clipping render targets');
      assert(item.depth.maximum <= 2, 'foreground scene depth remains correct at fractional DPR');
      assert.equal(item.temporal.active, true, 'temporal reconstruction and world effects both work at fractional DPR');
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
