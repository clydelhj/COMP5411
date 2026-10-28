/* Deterministic WebGL fixture. Pixel readback belongs to this test scene only. */
(async function createTemporalStressScene() {
  'use strict';

  async function unpack(value) {
    const bytes = Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const buffer = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    return new TextDecoder().decode(buffer);
  }
  const moduleURL = source => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const core = moduleURL(await unpack(window.NOTO_LIBRARIES.core));
    const module = moduleURL((await unpack(window.NOTO_LIBRARIES.module)).replaceAll('./three.core.js', core));
    const THREE = await import(module);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(384, 216);
    document.querySelector('#viewport').append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    const camera = new THREE.PerspectiveCamera(45, 384 / 216, 0.1, 50);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const backgroundMaterial = new THREE.MeshLambertMaterial({ color: 0x164bd5 });
    const background = new THREE.Mesh(new THREE.PlaneGeometry(16, 10), backgroundMaterial);
    background.position.z = -4;
    const occluderMaterial = new THREE.MeshLambertMaterial({ color: 0x22ee22 });
    const occluder = new THREE.Mesh(new THREE.BoxGeometry(0.18, 2.8, 0.1), occluderMaterial);
    const light = new THREE.AmbientLight(0xffffff, 1.5);
    scene.add(background, occluder, light);
    const temporal = window.NotoTemporalReconstruction.create({ THREE, renderer });
    const linearReferenceTarget = new THREE.WebGLRenderTarget(384, 216, {
      type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace
    });
    const linearReferenceScene = new THREE.Scene();
    const linearReferenceMaterial = new THREE.ShaderMaterial({
      uniforms: { image: { value: linearReferenceTarget.texture } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader: `uniform sampler2D image; varying vec2 vUv;
        void main(){gl_FragColor=vec4(texture2D(image,vUv).rgb,1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false
    });
    linearReferenceScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), linearReferenceMaterial));
    const linearReferenceCamera = new THREE.Camera();
    const counterfactual = { requested: false, target: null, hadHistory: false, weight: 0 };
    const renderWithoutInterception = renderer.render.bind(renderer);
    renderer.render = (renderScene, renderCamera) => {
      const resolve = renderScene.children.find(object => object.material?.name === 'NotoTemporalResolve');
      const result = renderWithoutInterception(renderScene, renderCamera);
      if (counterfactual.requested && resolve) {
        counterfactual.requested = false;
        const actualTarget = renderer.getRenderTarget();
        counterfactual.target?.dispose();
        counterfactual.target = new THREE.WebGLRenderTarget(actualTarget.width, actualTarget.height, {
          type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace,
          depthBuffer: false, count: 2
        });
        const historyUniform = resolve.material.uniforms.uHasHistory;
        counterfactual.hadHistory = historyUniform.value;
        counterfactual.weight = resolve.material.uniforms.uHistoryWeight.value;
        try {
          historyUniform.value = false;
          renderer.setRenderTarget(counterfactual.target);
          // Identical current color, depth, matrices and jitter; only history availability changes.
          renderWithoutInterception(renderScene, renderCamera);
        } finally {
          historyUniform.value = counterfactual.hadHistory;
          renderer.setRenderTarget(actualTarget);
        }
      }
      return result;
    };
    let now = 1000;

    function frame() {
      now += 1000 / 60;
      temporal.render(scene, camera, { now });
      document.querySelector('#state').textContent = JSON.stringify(temporal.getState(), null, 2);
    }
    function settle() {
      for (let frameIndex = 0; frameIndex < 8; frameIndex++) frame();
    }
    function snapshot() {
      const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
      renderer.getContext().readPixels(0, 0, renderer.domElement.width, renderer.domElement.height,
        renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixels);
      return pixels;
    }
    function reference() {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return snapshot();
    }
    function linearReference() {
      // The temporal pipeline correctly blends transparent RGB in linear HDR. The old direct
      // canvas path can blend already encoded colors, so it is not that operation's reference.
      linearReferenceTarget.setSize(renderer.domElement.width, renderer.domElement.height);
      renderer.setRenderTarget(linearReferenceTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(linearReferenceScene, linearReferenceCamera);
      return snapshot();
    }
    function sample(pixels, x, y, width = renderer.domElement.width) {
      const index = (Math.round(y) * width + Math.round(x)) * 4;
      return Array.from(pixels.subarray(index, index + 3));
    }
    function difference(a, b) {
      let sum = 0, maximum = 0, changed = 0;
      for (let index = 0; index < a.length; index += 4) {
        const delta = Math.max(Math.abs(a[index] - b[index]), Math.abs(a[index + 1] - b[index + 1]), Math.abs(a[index + 2] - b[index + 2]));
        sum += delta;
        maximum = Math.max(maximum, delta);
        if (delta > 3) changed++;
      }
      return { mean: sum / (a.length / 4), maximum, changedPixels: changed };
    }
    function pan(x) {
      camera.position.x = x;
      camera.lookAt(x, 0, 0);
      camera.updateMatrixWorld();
    }
    function reset() {
      renderer.setSize(384, 216);
      camera.aspect = 384 / 216;
      camera.near = 0.1;
      camera.far = 50;
      camera.position.z = 5;
      camera.updateProjectionMatrix();
      pan(0);
      light.intensity = 1.5;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1;
      backgroundMaterial.color.set(0x164bd5);
      if (backgroundMaterial.map) { backgroundMaterial.map = null; backgroundMaterial.needsUpdate = true; }
      background.scale.setScalar(1);
      background.rotation.set(0, 0, 0);
      background.position.z = -4;
      occluderMaterial.color.set(0x22ee22);
      occluder.visible = true;
      occluderMaterial.transparent = false;
      occluderMaterial.opacity = 1;
      occluderMaterial.blending = THREE.NormalBlending;
      delete occluderMaterial.userData.temporalReactive;
      temporal.setEnabled(true);
      temporal.invalidate('fixture-reset');
    }

    async function runChecks() {
      const report = {};
      const images = {};
      const capture = name => { images[name] = renderer.domElement.toDataURL('image/png'); };
      reset();
      const projection = camera.projectionMatrix.toArray();
      const inverse = camera.projectionMatrixInverse.toArray();
      frame();
      const initial = snapshot();
      capture('static-first');
      report.initial = temporal.getState();
      for (let index = 1; index < 8; index++) {
        if (index === 7) counterfactual.requested = true;
        frame();
      }
      const accumulated = snapshot();
      capture('static-accumulated');
      linearReferenceMaterial.uniforms.image.value = counterfactual.target.textures[0];
      renderer.setRenderTarget(null);
      renderWithoutInterception(linearReferenceScene, linearReferenceCamera);
      const currentOnly = snapshot();
      capture('static-same-input-without-history');
      linearReferenceMaterial.uniforms.image.value = linearReferenceTarget.texture;
      report.static = {
        state: temporal.getState(),
        edgeChange: difference(initial, accumulated),
        acceptedHistory: {
          historyWasAvailable: counterfactual.hadHistory,
          historyWeight: counterfactual.weight,
          difference: difference(accumulated, currentOnly)
        },
        projectionBefore: projection,
        projectionAfter: camera.projectionMatrix.toArray(),
        inverseBefore: inverse,
        inverseAfter: camera.projectionMatrixInverse.toArray(),
        needsFrame: temporal.needsFrame()
      };

      // A 0.25 m parallel pan exposes several pixels without qualifying as a camera cut.
      const panSamples = [];
      for (const x of [0.25, 0.5, 0.75, 1]) {
        pan(x);
        frame();
        const resolved = snapshot();
        if (x === 0.25) capture('pan-reconstructed');
        const direct = reference();
        if (x === 0.25) capture('pan-current-reference');
        const width = renderer.domElement.width, height = renderer.domElement.height;
        const focal = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        const releasedX = Math.round(width / 2 - x * focal / 9 + 1);
        // Sample newly revealed blue surface behind the old green bar, away from silhouette AA.
        let excessGreen = 0, maximumError = 0, comparisons = 0;
        for (let y = Math.round(height * 0.3); y < height * 0.7; y++) {
          for (let offset = -1; offset <= 1; offset++) {
            const actual = sample(resolved, releasedX + offset, y);
            const expected = sample(direct, releasedX + offset, y);
            if (expected[2] < expected[1] + 40) continue;
            comparisons++;
            excessGreen = Math.max(excessGreen, actual[1] - expected[1]);
            maximumError = Math.max(maximumError, ...actual.map((value, channel) => Math.abs(value - expected[channel])));
          }
        }
        panSamples.push({ x, comparisons, excessGreen, maximumError, state: temporal.getState() });
      }
      report.pan = panSamples;

      // Light changes must use the current frame immediately, without a bright historical trail.
      settle();
      const beforeLight = snapshot();
      light.intensity = 0.12;
      temporal.invalidate('lighting');
      frame();
      const afterLight = snapshot();
      capture('lighting-reconstructed');
      const lightReference = reference();
      capture('lighting-current-reference');
      report.lighting = {
        state: temporal.getState(),
        before: sample(beforeLight, 300, 100),
        after: sample(afterLight, 300, 100),
        reference: sample(lightReference, 300, 100)
      };
      // Exposure is applied once at presentation, not baked into history a second time.
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 2;
      temporal.invalidate('exposure');
      frame();
      report.exposure = {
        actual: sample(snapshot(), 300, 100),
        reference: sample(reference(), 300, 100)
      };

      reset();
      occluderMaterial.userData.temporalReactive = true;
      temporal.invalidate('reactive-tag');
      settle();
      occluderMaterial.color.set(0xee2222);
      frame();
      report.reactiveOpaque = {
        actual: sample(snapshot(), 192, 108),
        reference: sample(reference(), 192, 108),
        state: temporal.getState(),
        blendAfter: occluderMaterial.blending,
        blendExpected: THREE.NormalBlending
      };

      reset();
      occluderMaterial.transparent = true;
      occluderMaterial.opacity = 0.65;
      occluderMaterial.needsUpdate = true;
      temporal.invalidate('reactive-transparent');
      settle();
      occluderMaterial.color.set(0xee2222);
      frame();
      report.reactiveTransparent = {
        actual: sample(snapshot(), 192, 108),
        reference: sample(linearReference(), 192, 108),
        state: temporal.getState(),
        blendAfter: occluderMaterial.blending,
        blendExpected: THREE.NormalBlending
      };

      // Moving texture detail keeps both old/new colors inside a 3x3 neighborhood.
      // A simple color clamp therefore cannot substitute for a real reactive mask here.
      reset();
      occluder.visible = false;
      const stripeCanvas = document.createElement('canvas');
      stripeCanvas.width = 64;
      stripeCanvas.height = 2;
      const stripeContext = stripeCanvas.getContext('2d');
      for (let x = 0; x < 64; x += 8) {
        stripeContext.fillStyle = x % 16 ? '#eeeeee' : '#111111';
        stripeContext.fillRect(x, 0, 8, 2);
      }
      const stripeTexture = new THREE.CanvasTexture(stripeCanvas);
      stripeTexture.colorSpace = THREE.SRGBColorSpace;
      stripeTexture.wrapS = THREE.RepeatWrapping;
      stripeTexture.minFilter = stripeTexture.magFilter = THREE.NearestFilter;
      stripeTexture.generateMipmaps = false;
      const stripeMaterial = new THREE.MeshBasicMaterial({ map: stripeTexture });
      const stripeGeometry = new THREE.PlaneGeometry(2.8, 2.8);
      const stripedInstance = new THREE.InstancedMesh(stripeGeometry, stripeMaterial, 1);
      stripedInstance.setMatrixAt(0, new THREE.Matrix4());
      scene.add(stripedInstance);
      temporal.invalidate('instanced-motion');
      settle();
      stripeTexture.offset.x = 0.125;
      frame();
      const movingStripe = snapshot();
      capture('instanced-motion');
      const stripeState = temporal.getState();
      temporal.invalidate('instanced-reference');
      frame();
      capture('instanced-current-reference');
      report.reactiveInstanced = { difference: difference(movingStripe, snapshot()), state: stripeState };
      scene.remove(stripedInstance);
      stripeGeometry.dispose();
      stripeMaterial.dispose();
      stripeTexture.dispose();

      // Additive particles must keep their original RGB blend while alpha marks them reactive.
      reset();
      occluderMaterial.transparent = true;
      occluderMaterial.opacity = 0.5;
      occluderMaterial.blending = THREE.AdditiveBlending;
      temporal.invalidate('reactive-additive');
      settle();
      occluderMaterial.color.set(0xee2222);
      frame();
      report.reactiveAdditive = {
        actual: sample(snapshot(), 192, 108),
        reference: sample(linearReference(), 192, 108),
        state: temporal.getState(),
        blendAfter: occluderMaterial.blending,
        blendExpected: THREE.AdditiveBlending
      };

      // Match the viewer's metre-scale regional depth range, not only the tiny unit scene.
      reset();
      occluder.visible = false;
      camera.near = 0.5;
      camera.far = 200000;
      camera.position.set(0, 0, 60000);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      background.scale.setScalar(5000);
      background.rotation.y = 0.5;
      background.position.z = -4000;
      const regionalCanvas = document.createElement('canvas');
      regionalCanvas.width = 64;
      regionalCanvas.height = 2;
      const regionalContext = regionalCanvas.getContext('2d');
      for (let x = 0; x < 64; x += 8) {
        regionalContext.fillStyle = x % 16 ? '#aaaaaa' : '#888888';
        regionalContext.fillRect(x, 0, 8, 2);
      }
      const regionalTexture = new THREE.CanvasTexture(regionalCanvas);
      regionalTexture.colorSpace = THREE.SRGBColorSpace;
      regionalTexture.minFilter = regionalTexture.magFilter = THREE.NearestFilter;
      regionalTexture.generateMipmaps = false;
      backgroundMaterial.color.set(0xffffff);
      backgroundMaterial.map = regionalTexture;
      backgroundMaterial.needsUpdate = true;
      temporal.invalidate('regional-scale');
      for (let index = 0; index < 8; index++) {
        if (index === 7) counterfactual.requested = true;
        frame();
      }
      const regionalActual = snapshot();
      capture('regional-accumulated');
      linearReferenceMaterial.uniforms.image.value = counterfactual.target.textures[0];
      renderWithoutInterception(linearReferenceScene, linearReferenceCamera);
      capture('regional-same-input-without-history');
      report.regional = {
        state: temporal.getState(), near: camera.near, far: camera.far,
        cameraZ: camera.position.z, planeZ: background.position.z,
        acceptedHistoryDifference: difference(regionalActual, snapshot())
      };
      const regionalResets = temporal.getState().resets;
      pan(250);
      counterfactual.requested = true;
      frame();
      const regionalPan = snapshot();
      capture('regional-pan-accumulated');
      linearReferenceMaterial.uniforms.image.value = counterfactual.target.textures[0];
      renderWithoutInterception(linearReferenceScene, linearReferenceCamera);
      capture('regional-pan-same-input-without-history');
      report.regional.pan = {
        distanceM: 250, resetBefore: regionalResets, resetAfter: temporal.getState().resets,
        acceptedHistoryDifference: difference(regionalPan, snapshot())
      };
      linearReferenceMaterial.uniforms.image.value = linearReferenceTarget.texture;
      backgroundMaterial.map = null;
      backgroundMaterial.needsUpdate = true;
      regionalTexture.dispose();

      reset();
      settle();
      renderer.setSize(256, 160);
      camera.aspect = 256 / 160;
      camera.updateProjectionMatrix();
      frame();
      report.resize = temporal.getState();
      temporal.setEnabled(false);
      frame();
      report.disabled = {
        state: temporal.getState(),
        needsFrame: temporal.needsFrame(),
        actual: sample(snapshot(), 180, 80),
        reference: sample(reference(), 180, 80)
      };

      // Force an unsupported capability without allocating a large framebuffer or changing GL state.
      const actualGL = renderer.getContext();
      const context = new Proxy(actualGL, {
        get(target, property) {
          if (property === 'getExtension') return name => name === 'EXT_color_buffer_float' ? null : target.getExtension(name);
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const unsupportedRenderer = new Proxy(renderer, {
        get(target, property) {
          if (property === 'getContext') return () => context;
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      const unsupported = window.NotoTemporalReconstruction.create({ THREE, renderer: unsupportedRenderer });
      unsupported.render(scene, camera, { now });
      report.unsupported = { state: unsupported.getState(), needsFrame: unsupported.needsFrame() };
      unsupported.dispose();

      occluderMaterial.transparent = true;
      occluderMaterial.blending = THREE.CustomBlending;
      occluderMaterial.blendSrc = THREE.DstAlphaFactor;
      occluderMaterial.blendDst = THREE.ZeroFactor;
      const alphaDependent = window.NotoTemporalReconstruction.create({ THREE, renderer });
      alphaDependent.render(scene, camera, { now });
      report.alphaDependentBlend = {
        state: alphaDependent.getState(), needsFrame: alphaDependent.needsFrame(),
        blendAfter: occluderMaterial.blending, blendExpected: THREE.CustomBlending,
        sourceAfter: occluderMaterial.blendSrc, sourceExpected: THREE.DstAlphaFactor
      };
      alphaDependent.dispose();

      reset();
      settle();
      const framesBeforeWait = temporal.getState().frames;
      await new Promise(resolve => setTimeout(resolve, 120));
      report.idle = { before: framesBeforeWait, after: temporal.getState().frames, needsFrame: temporal.needsFrame() };
      frame();
      report.graphics = { version: actualGL.getParameter(actualGL.VERSION), renderer: renderer.capabilities.isWebGL2 };
      window.temporalStressReport = report;
      window.temporalStressImages = images;
      return report;
    }

    window.temporalStress = { THREE, renderer, scene, camera, temporal, runChecks, frame, settle, reset, pan };
    settle();
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    document.querySelector('#pan').onclick = async event => {
      event.target.disabled = true;
      const start = camera.position.x, end = start > 0.75 ? 0 : 1;
      // A finite manual stress route; the production module never owns an animation loop.
      for (let index = 1; index <= 36; index++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        pan(start + (end - start) * index / 36);
        frame();
      }
      for (let index = 0; index < 8; index++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        frame();
      }
      event.target.disabled = false;
    };
    document.querySelector('#lighting').onclick = () => { light.intensity = light.intensity > 1 ? 0.12 : 1.5; temporal.invalidate('lighting'); frame(); };
    document.querySelector('#toggle').onclick = () => { temporal.setEnabled(!temporal.getState().enabled); frame(); };
  } catch (error) {
    document.querySelector('#state').textContent = error.stack;
    window.temporalStressError = error.stack;
    throw error;
  }
})();
