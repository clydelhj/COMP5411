/* Asset-free world-cloud checks. Readback and diagnostic controls exist only in this fixture. */
(async function createCloudVolumeScene() {
  'use strict';

  async function unpack(value) {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const buffer = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return new TextDecoder().decode(buffer);
  }
  const moduleURL = source => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

  try {
    const core = moduleURL(await unpack(window.NOTO_LIBRARIES.core));
    const library = moduleURL((await unpack(window.NOTO_LIBRARIES.module)).replaceAll('./three.core.js', core));
    const THREE = await import(library);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(1);
    renderer.setSize(720, 480);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.querySelector('#viewport').append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x79b3d7);
    const camera = new THREE.PerspectiveCamera(55, 720 / 480, 1, 130000);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(160000, 160000).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x285464, side: THREE.DoubleSide }));
    ground.name = 'Generated opaque sea-level surface';
    scene.add(ground);
    const island = new THREE.Mesh(new THREE.BoxGeometry(4800, 2600, 3800), new THREE.MeshBasicMaterial({ color: 0x75674b }));
    island.position.set(-6400, 1300, -1800);
    island.name = 'Generated terrain partly intersecting the low cloud layer';
    scene.add(island);
    const occluder = new THREE.Mesh(new THREE.PlaneGeometry(1100, 1100).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf1312c, side: THREE.DoubleSide }));
    occluder.visible = false;
    occluder.name = 'Opaque foreground depth probe';
    scene.add(occluder);
    const clouds = window.NotoCloudLayers.create({ THREE, renderer, metadata: { width_m: 33225, height_m: 23135 } });
    const temporal = window.NotoTemporalReconstruction.create({ THREE, renderer });
    temporal.setEnabled(false);
    let time = 0, now = 1000, postController = clouds, lastInputs = null;

    function setPose(eye, target) {
      camera.position.set(...eye);
      const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
      camera.up.set(...(Math.abs(dy) > Math.hypot(dx, dz) * 20 ? [0, 0, -1] : [0, 1, 0]));
      camera.lookAt(...target);
      camera.updateMatrixWorld();
      temporal.invalidate('test-pose');
    }

    function setLighting(elevation = 35, weather = 'cloudy') {
      const angle = elevation * Math.PI / 180;
      clouds.setLighting({
        elevation, weather, direction: [0.5 * Math.cos(angle), Math.sin(angle), -Math.sqrt(0.75) * Math.cos(angle)],
        sunColor: elevation < 12 ? [1, 0.48, 0.20] : [1, 0.94, 0.84], sunIntensity: elevation > 0 ? 2 : 0,
        skyColor: elevation < -12 ? [0.002, 0.004, 0.01] : [0.25, 0.48, 0.65]
      });
    }

    function frame(withClouds = true, nextTime = time, temporalEnabled = false) {
      time = nextTime;
      now += 100;
      camera.updateMatrixWorld();
      clouds.setTime(time);
      clouds.update?.(time);
      temporal.setEnabled(temporalEnabled);
      temporal.setPostProcessor(withClouds ? postController : null);
      temporal.render(scene, camera, { now });
      document.querySelector('#state').textContent = JSON.stringify({ camera: camera.position.toArray(), cloud: clouds.getState(), temporal: temporal.getState() }, null, 2);
    }

    function snapshot() {
      const gl = renderer.getContext();
      const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
      gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    }

    const images = {};
    window.cloudVolumeImages = images;
    function capture(name) { images[name] = renderer.domElement.toDataURL('image/png'); }
    function difference(a, b, bounds = [0, 0, 1, 1]) {
      const width = renderer.domElement.width, height = renderer.domElement.height;
      let total = 0, maximum = 0, changedPixels = 0, count = 0;
      for (let row = Math.floor(height * bounds[1]); row < Math.floor(height * bounds[3]); row++) {
        for (let col = Math.floor(width * bounds[0]); col < Math.floor(width * bounds[2]); col++) {
          const index = (row * width + col) * 4;
          let change = 0;
          for (let channel = 0; channel < 3; channel++) {
            const delta = Math.abs(a[index + channel] - b[index + channel]);
            total += delta;
            change = Math.max(change, delta);
          }
          maximum = Math.max(maximum, change);
          if (change > 3) changedPixels++;
          count++;
        }
      }
      return { mean: total / Math.max(1, count * 3), maximum, changedPixels, pixels: count };
    }

    function rendererState() {
      return {
        viewport: renderer.getViewport(new THREE.Vector4()).toArray(), scissor: renderer.getScissor(new THREE.Vector4()).toArray(),
        scissorTest: renderer.getScissorTest(), clearColor: renderer.getClearColor(new THREE.Color()).toArray(), clearAlpha: renderer.getClearAlpha(),
        autoClear: renderer.autoClear, infoAutoReset: renderer.info.autoReset, xrEnabled: renderer.xr.enabled,
        shadowAutoUpdate: renderer.shadowMap.autoUpdate, shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
        toneMapping: renderer.toneMapping, outputColorSpace: renderer.outputColorSpace
      };
    }

    function reflectionProbe() {
      const previous = renderer.getRenderTarget();
      const target = new THREE.WebGLRenderTarget(48, 24, { type: THREE.FloatType, depthBuffer: false });
      const material = new THREE.ShaderMaterial({
        uniforms: { ...clouds.uniforms, uOrigin: { value: new THREE.Vector3(0, 1, 0) } },
        vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: `${window.NotoCloudLayers.shaderDeclarations}
          varying vec2 vUv;uniform vec3 uOrigin;
          void main(){
            vec3 ray=normalize(vec3((vUv.x-0.5)*1.8,0.16+vUv.y*0.7,-1.0));
            gl_FragColor=vec4(worldCloudReflection(uOrigin,ray,vec3(0.04,0.20,0.40)),worldCloudSunTransmission(uOrigin,ray));
          }`,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending
      });
      const probe = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      probe.add(mesh);
      const pixels = new Float32Array(48 * 24 * 4);
      try {
        renderer.setRenderTarget(target);
        renderer.render(probe, new THREE.Camera());
        renderer.readRenderTargetPixels(target, 0, 0, 48, 24, pixels);
      } finally {
        renderer.setRenderTarget(previous);
        target.dispose(); material.dispose(); mesh.geometry.dispose();
      }
      return pixels;
    }

    function fieldDifference(a, b) {
      let total = 0, maximum = 0, changed = 0;
      for (let index = 0; index < a.length; index++) {
        const delta = Math.abs(a[index] - b[index]);
        total += delta; maximum = Math.max(maximum, delta);
        if (delta > 0.002) changed++;
      }
      return { mean: total / a.length, maximum, changedValues: changed };
    }

    function coarseImage(pixels, width, height) {
      const result = [];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
        const sum = [0, 0, 0];
        let count = 0;
        for (let row = Math.floor(height * y / 8); row < Math.floor(height * (y + 1) / 8); row++) {
          for (let col = Math.floor(width * x / 12); col < Math.floor(width * (x + 1) / 12); col++) {
            const index = (row * width + col) * 4;
            for (let channel = 0; channel < 3; channel++) sum[channel] += pixels[index + channel];
            count++;
          }
        }
        result.push(...sum.map(value => value / count));
      }
      return result;
    }

    async function measureCloudCost() {
      const gl = renderer.getContext();
      const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const report = { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), timerAvailable: Boolean(timer), cases: [] };
      for (const pose of [
        { name: 'below', eye: [0, 800, 0], target: [0, 3200, -6500] },
        { name: 'above', eye: [0, 9500, 0], target: [0, 0, -1] }
      ]) {
        setPose(pose.eye, pose.target);
        postController = { render(context) { lastInputs = { ...context, outputSize: context.outputSize.clone(), jitterUv: context.jitterUv.clone() }; return clouds.render(context); } };
        frame(true, time + 1);
        postController = clouds;
        const samples = { name: pose.name, gpuMs: [], cpuSubmitMs: [], timerResults: [] };
        // Warmed controller render only: it includes scheduled column maps, ray integration and composite,
        // while excluding scene rendering, PNG encoding and pixel readback.
        for (let index = 0; index < 3; index++) {
          const query = timer ? gl.createQuery() : null;
          try {
            clouds.setTime(time + index + 1);
            if (query) gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
            const start = performance.now();
            clouds.render({ ...lastInputs, sceneRevision: lastInputs.sceneRevision + index + 1 });
            samples.cpuSubmitMs.push(performance.now() - start);
            if (query) gl.endQuery(timer.TIME_ELAPSED_EXT);
            if (!query) { samples.timerResults.push('unavailable'); continue; }
            let complete = false;
            for (let attempt = 0; attempt < 30; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 8));
              if (gl.getParameter(timer.GPU_DISJOINT_EXT)) { samples.timerResults.push('disjoint'); complete = true; break; }
              if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
                samples.gpuMs.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
                samples.timerResults.push('available'); complete = true; break;
              }
            }
            if (!complete) samples.timerResults.push('pending-timeout');
          } finally { if (query) gl.deleteQuery(query); }
        }
        report.cases.push(samples);
      }
      return report;
    }

    function checkRegionalAltitude() {
      const saved = {
        near: camera.near, far: camera.far, position: camera.position.clone(),
        quaternion: camera.quaternion.clone(), up: camera.up.clone()
      };
      const results = [];
      try {
        // Match the production regional near-plane policy so this probes cloud distance handling,
        // rather than avoidable depth quantization from a 1 m near plane across 400 km.
        camera.near = 16;
        camera.far = 400000;
        camera.updateProjectionMatrix();
        for (const pose of [
          { altitude: 70000, eye: [0, 70000, 0], image: 'regional-above-70km' },
          { altitude: 250000, eye: [0, 250000, 0], image: 'regional-above-250km' },
          { altitude: 220000, eye: [100000, 220000, 100000], image: 'regional-orbit-261km' }
        ]) {
          setPose(pose.eye, [0, 0, -1]);
          frame(false, 20);
          const bare = snapshot();
          frame(true, 20);
          results.push({ altitudeM: pose.altitude, cameraPosition: pose.eye, nearM: camera.near, farM: camera.far, effect: difference(bare, snapshot()), state: clouds.getState() });
          capture(pose.image);
        }
      } finally {
        camera.near = saved.near; camera.far = saved.far;
        camera.position.copy(saved.position); camera.quaternion.copy(saved.quaternion); camera.up.copy(saved.up);
        camera.updateProjectionMatrix(); camera.updateMatrixWorld();
        temporal.invalidate('test-regional-return');
      }
      return results;
    }

    async function runChecks() {
      const report = { views: [] };
      setLighting();
      for (const pose of [
        { name: 'below', eye: [0, 800, 0], target: [0, 3200, -6500] },
        { name: 'inside-low', eye: [0, 2450, 0], target: [0, 2450, -6500] },
        { name: 'between', eye: [0, 4200, 0], target: [0, 0, -1] },
        { name: 'above', eye: [0, 9500, 0], target: [0, 0, -1] }
      ]) {
        setPose(pose.eye, pose.target);
        frame(false, 20);
        const bare = snapshot();
        frame(true, 20);
        const cloudy = snapshot();
        capture(pose.name);
        report.views.push({ name: pose.name, camera: camera.position.toArray(), effect: difference(bare, cloudy), state: clouds.getState() });
      }
      report.regional = checkRegionalAltitude();

      setPose([0, 9500, 0], [0, 0, -1]);
      frame(true, 20);
      const early = snapshot();
      const beforeDrift = clouds.getState();
      frame(true, 80);
      const drifted = snapshot();
      capture('above-drifted');
      report.drift = { difference: difference(early, drifted), before: beforeDrift, after: clouds.getState() };
      frame(true, 80);
      const beforeSameTime = clouds.getState();
      frame(true, 80);
      const afterSameTime = clouds.getState();
      frame(true, 80.01);
      report.cache = { before: beforeSameTime, sameTime: afterSameTime, shortStep: clouds.getState() };
      const frozen = snapshot(), frozenState = clouds.getState();
      await new Promise(resolve => setTimeout(resolve, 150));
      report.idle = { before: frozenState, after: clouds.getState(), difference: difference(frozen, snapshot()) };

      // The red surface lies in front of both world cloud layers for this downward view.
      occluder.position.set(0, 7900, 0);
      occluder.visible = true;
      temporal.invalidate('geometry');
      frame(false, 80);
      const bareOccluder = snapshot();
      frame(true, 80);
      const cloudOccluder = snapshot();
      capture('above-opaque-depth');
      report.depth = { center: difference(bareOccluder, cloudOccluder, [0.43, 0.43, 0.57, 0.57]), whole: difference(bareOccluder, cloudOccluder) };
      occluder.visible = false;
      temporal.invalidate('geometry');

      // Reconstruction remains a static-scene stage; the moving volume is composited afterward.
      setPose([0, 9500, 0], [0, 0, -1]);
      frame(true, 80, true);
      for (let index = 0; index < 8; index++) frame(true, 80, true);
      report.temporal = temporal.getState();
      const withHistory = snapshot();
      frame(true, 140, true);
      report.temporalDrift = difference(withHistory, snapshot());
      capture('above-temporal-drift');

      setPose([0, 800, 0], [0, 0, -1]);
      frame(false, 140);
      const bareDownward = snapshot();
      const beforeHidden = clouds.getState();
      frame(true, 140);
      report.hidden = { visible: clouds.hasVisibleVolume(camera), effect: difference(bareDownward, snapshot()), before: beforeHidden, after: clouds.getState() };

      clouds.setTime(20); clouds.update(20);
      const reflectedEarly = reflectionProbe();
      clouds.setTime(80); clouds.update(80);
      const reflectedLater = reflectionProbe();
      const enabled = clouds.uniforms.uWorldCloudsEnabled.value;
      clouds.uniforms.uWorldCloudsEnabled.value = 0;
      const reflectedDisabled = reflectionProbe();
      clouds.uniforms.uWorldCloudsEnabled.value = enabled;
      let finite = true, minimumTransmission = 1, maximumTransmission = 0, fallbackError = 0;
      for (let index = 0; index < reflectedLater.length; index++) finite &&= Number.isFinite(reflectedLater[index]);
      for (let index = 0; index < reflectedLater.length; index += 4) {
        minimumTransmission = Math.min(minimumTransmission, reflectedLater[index + 3]);
        maximumTransmission = Math.max(maximumTransmission, reflectedLater[index + 3]);
        fallbackError = Math.max(fallbackError, ...[0.04, 0.20, 0.40, 1].map((expected, channel) => Math.abs(reflectedDisabled[index + channel] - expected)));
      }
      report.reflection = { finite, minimumTransmission, maximumTransmission, fallbackError, drift: fieldDifference(reflectedEarly, reflectedLater) };

      setPose([0, 9500, 0], [0, 0, -1]);
      postController = { render(context) { lastInputs = { ...context, outputSize: context.outputSize.clone(), jitterUv: context.jitterUv.clone() }; return clouds.render(context); } };
      frame(true, 140);
      postController = clouds;
      const beforeCamera = { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray(), inverse: camera.projectionMatrixInverse.toArray() };
      const previousTarget = renderer.getRenderTarget(), originalState = rendererState();
      const sentinel = new THREE.WebGLRenderTarget(32, 32, { depthBuffer: false });
      try {
        renderer.setRenderTarget(sentinel);
        renderer.setViewport(1, 2, 24, 25);
        renderer.setScissor(3, 4, 18, 19);
        renderer.setScissorTest(true);
        renderer.setClearColor(0x345678, 0.3);
        renderer.autoClear = false;
        renderer.info.autoReset = false;
        renderer.xr.enabled = true;
        renderer.shadowMap.needsUpdate = true;
        const before = rendererState();
        clouds.setTime(141);
        clouds.render({ ...lastInputs, sceneRevision: lastInputs.sceneRevision + 1 });
        report.restoration = { before, after: rendererState(), sameTarget: renderer.getRenderTarget() === sentinel };
      } finally {
        renderer.setRenderTarget(previousTarget);
        renderer.setViewport(...originalState.viewport); renderer.setScissor(...originalState.scissor);
        renderer.setScissorTest(originalState.scissorTest);
        renderer.setClearColor(new THREE.Color().fromArray(originalState.clearColor), originalState.clearAlpha);
        renderer.autoClear = originalState.autoClear; renderer.info.autoReset = originalState.infoAutoReset;
        renderer.xr.enabled = originalState.xrEnabled;
        renderer.shadowMap.autoUpdate = originalState.shadowAutoUpdate; renderer.shadowMap.needsUpdate = originalState.shadowNeedsUpdate;
        sentinel.dispose();
      }
      report.restoration.cameraBefore = beforeCamera;
      report.restoration.cameraAfter = { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray(), inverse: camera.projectionMatrixInverse.toArray() };

      report.performance = await measureCloudCost();

      setPose([0, 9500, 0], [0, 0, -1]);
      frame(true, 200);
      const baseSize = [renderer.domElement.width, renderer.domElement.height];
      const baseCoarse = coarseImage(snapshot(), ...baseSize);
      report.dpr = [];
      for (const ratio of [1.25, 0.75]) {
        renderer.setPixelRatio(ratio);
        renderer.setSize(720, 480);
        frame(true, 200);
        const scaledSize = [renderer.domElement.width, renderer.domElement.height];
        const scaledCoarse = coarseImage(snapshot(), ...scaledSize);
        const coarseErrors = scaledCoarse.map((value, index) => Math.abs(value - baseCoarse[index]));
        capture('above-dpr' + Math.round(ratio * 100));
        occluder.visible = true;
        temporal.invalidate('geometry');
        frame(false, 200);
        const nativeOccluder = snapshot();
        frame(true, 200);
        const nativeDepth = difference(nativeOccluder, snapshot(), [0.43, 0.43, 0.57, 0.57]);
        frame(true, 200, true);
        for (let index = 0; index < 8; index++) frame(true, 200, true);
        report.dpr.push({
          ratio: renderer.getPixelRatio(), baseSize, scaledSize,
          coarseRMSE: Math.sqrt(coarseErrors.reduce((sum, value) => sum + value * value, 0) / coarseErrors.length),
          coarseMaximum: Math.max(...coarseErrors), depth: nativeDepth, temporal: temporal.getState()
        });
        occluder.visible = false;
        temporal.invalidate('geometry');
      }
      renderer.setPixelRatio(1);
      renderer.setSize(720, 480);

      setLighting(3, 'clear');
      setPose([0, 750, 0], [0, 2300, -6500]);
      frame(true, 142);
      capture('sunset-below');
      report.final = clouds.getState();
      return report;
    }

    setLighting();
    setPose([0, 800, 0], [0, 3200, -6500]);
    frame();
    window.cloudVolumeStress = { THREE, renderer, scene, camera, clouds, temporal, frame, setPose, setLighting, snapshot, rendererState, checkRegionalAltitude, runChecks };
  } catch (error) {
    console.error(error);
    document.querySelector('#state').textContent = error.stack || String(error);
    window.cloudVolumeError = error.message || String(error);
  }
})();
