'use strict';

// Optional real-WebGL regressions: install Playwright in your test environment, then
// node --test tests/temporal-browser.test.cjs. Runtime/viewer dependencies stay unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');

let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Other synthetic tests require only Node.js. */ }

const root = path.resolve(__dirname, '..');
const requireGPU = process.env.REQUIRE_TEMPORAL_GPU === '1';
test('temporal reconstruction rejects thin-occluder history and lighting changes in WebGL2', {
  skip: !chromium && !requireGPU ? 'Playwright is optional; set NODE_PATH or install it in the test environment to run this GPU check.' : false,
  timeout: 90000
}, async t => {
  assert.ok(chromium, 'Playwright is required when REQUIRE_TEMPORAL_GPU=1');
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
    const channel = process.env.TEMPORAL_BROWSER_CHANNEL;
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/temporal-scene.html`);
    await page.waitForFunction(() => window.temporalStress || window.temporalStressError, null, { timeout: 30000 });
    const fixtureError = await page.evaluate(() => window.temporalStressError);
    assert.equal(fixtureError, undefined, 'fixture initialization succeeded');
    const report = await page.evaluate(() => window.temporalStress.runChecks());
    t.diagnostic(JSON.stringify(report));
    if (process.env.TEMPORAL_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.TEMPORAL_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.TEMPORAL_ARTIFACT_DIR, 'synthetic-report.json'), JSON.stringify(report, null, 2));
      const images = await page.evaluate(() => window.temporalStressImages);
      for (const [name, dataURL] of Object.entries(images)) {
        fs.writeFileSync(path.join(process.env.TEMPORAL_ARTIFACT_DIR, name + '.png'), Buffer.from(dataURL.split(',')[1], 'base64'));
      }
      await page.screenshot({ path: path.join(process.env.TEMPORAL_ARTIFACT_DIR, 'thin-occluder-scene.png') });
    }
    assert.deepEqual(errors, [], 'no shader compilation, framebuffer or browser errors');
    assert.equal(report.initial.supported, true, 'test browser supports the actual float/MRT pipeline');
    assert.equal(report.initial.active, true, 'temporal rendering did not silently fall back');
    assert.equal(report.static.state.historyFrames, 8, 'static frames genuinely reach the bounded history length');
    assert.equal(report.static.needsFrame, false, 'static settling stops after eight frames');
    assert.ok(report.static.edgeChange.changedPixels > 10, 'jittered accumulation changes edge coverage at a stationary camera');
    assert.equal(report.static.acceptedHistory.historyWasAvailable, true);
    assert.ok(report.static.acceptedHistory.historyWeight > 0, 'history weight is not globally disabled');
    assert.ok(report.static.acceptedHistory.difference.changedPixels > 10,
      'actual output differs from a counterfactual with identical current inputs and history disabled');
    assert.deepEqual(report.static.projectionAfter, report.static.projectionBefore, 'unjittered camera projection restored');
    assert.deepEqual(report.static.inverseAfter, report.static.inverseBefore, 'unjittered inverse projection restored');
    for (const pan of report.pan) {
      assert.ok(pan.comparisons >= 30, 'pan exposes a measurable blue area behind the thin occluder');
      assert.ok(pan.excessGreen <= 18, `no green history trail after camera pan to ${pan.x}: ${pan.excessGreen}`);
      assert.ok(pan.maximumError <= 24, `newly revealed surface matches the current reference: ${pan.maximumError}`);
      assert.equal(pan.state.resets, report.static.state.resets, 'ordinary camera pan tests reprojection instead of global camera-cut resets');
    }
    const maxDelta = (a, b) => Math.max(...a.map((value, channel) => Math.abs(value - b[channel])));
    assert.ok(maxDelta(report.lighting.after, report.lighting.reference) <= 3, 'lighting invalidation immediately uses current shading');
    assert.ok(maxDelta(report.lighting.after, report.lighting.before) >= 25, 'lighting stress changes the actual image');
    assert.equal(report.lighting.state.lastResetReason, 'lighting');
    assert.ok(maxDelta(report.exposure.actual, report.exposure.reference) <= 3, 'tone mapping and output color encoding are applied once');
    for (const reactive of [report.reactiveOpaque, report.reactiveTransparent, report.reactiveAdditive]) {
      assert.ok(reactive.state.reactiveMaterials >= 1, 'reactive material was detected');
      assert.ok(maxDelta(reactive.actual, reactive.reference) <= 4, 'reactive color change is not smeared through history');
      assert.equal(reactive.blendAfter, reactive.blendExpected, 'temporary alpha-mask blending does not leak to subsequent direct draws');
    }
    assert.ok(report.reactiveInstanced.state.reactiveMaterials >= 1, 'instanced foliage is classified as reactive');
    assert.ok(report.reactiveInstanced.difference.maximum <= 4, 'moving instanced texture detail matches fresh current sampling instead of old history');
    assert.equal(report.regional.state.active, true);
    assert.ok(report.regional.acceptedHistoryDifference.changedPixels > 10,
      'regional oblique terrain at near=0.5m still accepts measurable history instead of only returning current samples');
    assert.equal(report.regional.pan.resetAfter, report.regional.pan.resetBefore, 'regional pan keeps local history validation active');
    assert.ok(report.regional.pan.acceptedHistoryDifference.changedPixels > 10, 'regional pan still accepts valid reprojected history');
    assert.deepEqual(report.resize.outputSize, [256, 160]);
    assert.ok(report.resize.historyFrames <= 1, 'resize invalidates all old-sized history');
    assert.equal(report.disabled.state.active, false);
    assert.equal(report.disabled.needsFrame, false);
    assert.ok(maxDelta(report.disabled.actual, report.disabled.reference) <= 1, 'disabled mode uses the original direct renderer');
    assert.equal(report.unsupported.state.supported, false);
    assert.equal(report.unsupported.state.active, false);
    assert.equal(report.unsupported.needsFrame, false);
    assert.ok(report.unsupported.state.fallbackReason, 'unsupported mode explains its fallback');
    assert.equal(report.alphaDependentBlend.state.active, false, 'destination-alpha RGB blending selects the safe direct path');
    assert.match(report.alphaDependentBlend.state.fallbackReason, /alpha/i);
    assert.equal(report.alphaDependentBlend.needsFrame, false);
    assert.equal(report.alphaDependentBlend.blendAfter, report.alphaDependentBlend.blendExpected);
    assert.equal(report.alphaDependentBlend.sourceAfter, report.alphaDependentBlend.sourceExpected);
    assert.equal(report.idle.after, report.idle.before, 'module creates no hidden frame loop');
    assert.equal(report.idle.needsFrame, false);
    await page.locator('#pan').click();
    await page.waitForFunction(() => !document.querySelector('#pan').disabled, null, { timeout: 5000 });
    const manualRoute = await page.evaluate(async () => {
      const before = window.temporalStress.temporal.getState().frames;
      await new Promise(resolve => setTimeout(resolve, 120));
      return { cameraX: window.temporalStress.camera.position.x, before, after: window.temporalStress.temporal.getState().frames };
    });
    assert.equal(manualRoute.cameraX, 1, 'manual thin-occluder pan reaches its intended end');
    assert.equal(manualRoute.after, manualRoute.before, 'manual stress route also stops after its finite settling frames');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
