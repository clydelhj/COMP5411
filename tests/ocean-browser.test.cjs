'use strict';

// Optional real-WebGL check. The viewer itself does not depend on Playwright or these test fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
let chromium;
try { ({ chromium } = require('playwright')); } catch { /* Explicitly optional outside a GPU test environment. */ }
const root = path.resolve(__dirname, '..');
const required = process.env.REQUIRE_OCEAN_GPU === '1';

test('ocean animation, shading, scale and idle behavior run in actual WebGL2', {
  skip: !chromium && !required ? 'Playwright is optional; configure NODE_PATH to run the ocean GPU test.' : false,
  timeout: 120000
}, async t => {
  assert.ok(chromium, 'Playwright is required when REQUIRE_OCEAN_GPU=1');
  const baseline = process.env.OCEAN_BASELINE_DIR;
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    const rel = pathname.slice(1);
    if (baseline && ['src/ocean-spectrum.js', 'src/ocean-reflection.js'].includes(rel)) return response.writeHead(200, { 'Content-Type': 'text/javascript' }).end('/* Baseline predates ocean GPU helpers. */');
    let file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep)) return response.writeHead(404).end();
    if (baseline && ['src/water-materials.js', 'src/water-motion.js'].includes(rel)) file = path.resolve(baseline, path.basename(rel));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return response.writeHead(404).end();
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript' })[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(response);
  });
  let browser;
  const errors = [];
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const channel = process.env.OCEAN_BROWSER_CHANNEL;
    browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
    const page = await browser.newPage({ viewport: { width: 1100, height: 780 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/ocean-scene.html`);
    await page.waitForFunction(() => window.oceanStress || window.oceanStressError, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.oceanStressError), undefined, 'ocean fixture initialized');
    const report = await page.evaluate(() => window.oceanStress.runChecks());
    if (process.env.OCEAN_ARTIFACT_DIR) {
      fs.mkdirSync(process.env.OCEAN_ARTIFACT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.OCEAN_ARTIFACT_DIR, baseline ? 'baseline-report.json' : 'ocean-report.json'), JSON.stringify(report, null, 2));
      const images = await page.evaluate(() => window.oceanStressImages);
      for (const [name, image] of Object.entries(images)) {
        fs.writeFileSync(path.join(process.env.OCEAN_ARTIFACT_DIR, (baseline ? 'baseline-' : 'ocean-') + name + '.png'), Buffer.from(image.split(',')[1], 'base64'));
      }
    }
    t.diagnostic(JSON.stringify(report));
    assert.deepEqual(errors, [], 'no shader, framebuffer or browser errors');
    for (const view of report.views) {
      assert(view.motion.changedPixels > 500, 'moving waves visibly change at ' + view.name);
      assert(view.motion.mean > 0.2, 'animation has measurable image variation at ' + view.name);
    }
    for (const probe of report.probes) {
      probe.gpu.forEach(value => assert(Number.isFinite(value), 'GPU wave displacement is finite'));
      assert(Math.max(...probe.cpu.map((value, index) => Math.abs(value - probe.gpu[index]))) < 0.02,
        'CPU geometry query agrees with shader displacement at ' + probe.point);
    }
    for (const probe of report.normalProbes) {
      assert(probe.gpu.every(Number.isFinite), 'GPU macro normal is finite');
      assert(Math.max(...probe.cpu.map((value, index) => Math.abs(value - probe.gpu[index]))) < 0.02,
        'analytic macro normal agrees with numerical surface tangents at ' + probe.point);
    }
    assert.deepEqual(report.scale.after, report.scale.before, 'vertical exaggeration does not multiply physical wave amplitudes');
    assert(report.weather.change.changedPixels > 500, 'weather changes the water image');
    assert(report.night.luminance < report.night.daylight * 0.8, 'water does not remain bright blue at night');
    assert.equal(report.temporal.active, true, 'ocean shaders work through temporal reconstruction');
    assert.equal(report.idle.timeAfter, report.idle.timeBefore, 'clock does not run without a draw request');
    assert.equal(report.idle.updatesAfter, report.idle.updatesBefore, 'spectral GPU updates stop while idle');
    assert.equal(report.idle.difference.changedPixels, 0, 'idle framebuffer stays unchanged');
    assert.equal(report.sameTime.updatesAfter, report.sameTime.updatesBefore, 'unchanged simulation time causes no redundant spectrum update');
    if (process.env.REQUIRE_OCEAN_SPECTRUM === '1') {
      assert(report.spectrum?.supported && report.spectrum.active, 'spectral simulation is actually active');
      assert(report.spectrum.updates > 0 && report.spectrum.passes > 0, 'GPU spectrum performs real passes');
      assert(report.fields.large.finite && report.fields.small.finite, 'spectral displacement and slopes contain no NaN or infinity');
      assert(report.fields.large.slopeRMS > 0.0001 && report.fields.small.slopeRMS > 0.0001, 'both spectral cascades contain varying slopes');
      assert(report.fields.large.maxima[3] - report.fields.large.minima[3] > 0.02, 'spectrum contains a nonflat physical height field');
      for (const cascade of [report.fields.large, report.fields.small]) {
        assert(cascade.gradientCorrelation > 0.5, 'spectral slopes agree in sign with the height-field gradient');
        assert(cascade.positiveHeightMeanCrest > cascade.negativeHeightMeanCrest * 2,
          'breaking compression is concentrated at positive crests rather than troughs');
      }
      assert(report.fields.evolution.mean > 0.00001, 'spectral field genuinely evolves over time');
      assert(report.fields.determinism.maximum < 0.001, 'fixed seed, time and weather reproduce the same spectrum');
      assert.equal(report.spectrumFallback.state.active, false, 'unsupported spectrum uses explicit fallback');
      assert.equal(report.spectrumFallback.enabled, 0, 'fallback does not sample unavailable GPU fields');
      assert.equal(report.rendererState.sameTarget, true, 'spectrum restores the caller render target');
      assert.deepEqual(report.rendererState.after, report.rendererState.before, 'spectrum restores viewport, scissor, clear and render settings exactly');
    }
    if (process.env.REQUIRE_OCEAN_REFLECTION === '1') {
      assert(report.reflection?.state.supported && report.reflection.state.active, 'coarse terrain reflection is actually active');
      assert(report.reflection.state.proxyTriangles > 0 && report.reflection.state.proxyTriangles <= 150000, 'reflection proxy remains bounded');
      assert(report.reflection.texture.maxima[3] > 0.5, 'reflection texture contains rendered land rather than only clear pixels');
      assert(report.reflection.imageChange.changedPixels > 30, 'terrain reflection contributes visible water pixels');
      assert.equal(report.reflection.captureAfterReuse, report.reflection.captureBefore, 'unchanged view reuses the cached reflection');
      assert.equal(report.reflection.throttled.captures, report.reflection.throttleStart, 'nearby capture requests are throttled');
      assert(report.reflection.flushed.captures > report.reflection.throttleStart && !report.reflection.flushed.pending, 'pending capture flushes after its interval');
      assert(report.reflection.scaled.captures > report.reflection.flushed.captures, 'terrain scale changes invalidate the reflection');
      assert(report.reflection.relit.captures > report.reflection.scaled.captures, 'lighting changes invalidate the reflection');
      assert.equal(report.reflection.stateRestoration.sameTarget, true, 'reflection restores the original render target');
      assert.deepEqual(report.reflection.stateRestoration.after, report.reflection.stateRestoration.before, 'reflection preserves render state');
      assert.deepEqual(report.reflection.cameraAfter, report.reflection.cameraBefore, 'reflection leaves the main camera untouched');
      assert.equal(report.reflection.hidden.after, report.reflection.hidden.before, 'hidden water does not capture reflection');
      assert.equal(report.reflection.hidden.needsFrame, false, 'hidden water cannot keep the scheduler awake');
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
