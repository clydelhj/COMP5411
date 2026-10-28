/* Generated ocean fixture. GPU readback and diagnostic controls exist only in this test page. */
(async function createOceanScene() {
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
    renderer.setSize(960, 540);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.querySelector('#viewport').append(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 960 / 540, 0.5, 18000);
    const controls = { target: new THREE.Vector3() };
    const sun = new THREE.DirectionalLight(0xfff4e3, 3);
    const ambient = new THREE.HemisphereLight(0xffffff, 0x7d8069, 1.4);
    scene.add(sun, sun.target, ambient);
    const group = new THREE.Group();
    scene.add(group);

    const widthM = 8192, heightM = 8192, cellM = 16;
    const cols = widthM / cellM, rows = heightM / cellM;
    const values = new Uint16Array(cols * rows);
    const coast = z => -280 + 42 * Math.sin(z / 210) + 17 * Math.sin(z / 61);
    const distance = (x, z) => x - coast(z);
    function landHeight(x, z) {
      const d = distance(x, z);
      if (d >= 0) return -8 - d * 0.025;
      const inland = -d, blend = Math.min(1, inland / 200);
      // A steep, front-facing hill provides a physically visible reflection. A shallow ramp's
      // underside should not be reflected merely to make the test texture nonempty.
      const hill = 240 * Math.exp(-(((x + 920) / 330) ** 2) - ((z + 40) / 430) ** 2);
      return inland * 0.075 + hill * blend * blend * (3 - 2 * blend);
    }
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const x = (col + 0.5) * cellM - widthM / 2;
      const z = (row + 0.5) * cellM - heightM / 2;
      values[row * cols + col] = Math.max(0, Math.min(65534, Math.round(32768 + distance(x, z) * 8)));
    }
    const source = { widthM, heightM, cellM, cols, rows };
    const materials = window.NotoWaterMaterials.create(THREE);
    materials.top.userData.temporalReactive = true;
    const spectrum = window.NotoOceanSpectrum?.create({ THREE, renderer }) || null;
    const atmosphere = window.NotoSkyAtmosphere?.create({ THREE, renderer }) || null;
    const clouds = window.NotoCloudLayers?.create({ THREE, renderer }) || null;
    const motion = await window.NotoWaterMotion.create(THREE, source, materials, { distances: values }, spectrum);
    motion.setAtmosphere?.(atmosphere);
    motion.setCloudLayers?.(clouds);
    const reflection = window.NotoOceanReflection?.create({
      THREE, renderer, camera, terrain: group,
      metadata: { width_m: widthM, height_m: heightM, elevation_max_m: 400, source_width: 8193, source_height: 8193, source_spacing_m: [1, 1] }
    }) || null;
    if (reflection) {
      const rows = 65, cols = 65;
      const heights = new Float32Array(rows * cols), landCells = new Uint8Array((rows - 1) * (cols - 1));
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const x = col * 128 - widthM / 2, z = row * 128 - heightM / 2;
        heights[row * cols + col] = landHeight(x, z);
        if (row < rows - 1 && col < cols - 1) landCells[row * (cols - 1) + col] = distance(x + 64, z + 64) < 0 ? 1 : 0;
      }
      reflection.setTerrain(new Map([['generated-coarse', { geometry: {
        heights, landCells,
        metadata: { sample_rows: rows, sample_cols: cols, heightOrigin: [-widthM / 2, -heightM / 2], heightExtent: [widthM, heightM], step: [128, 128] }
      } }]]));
      motion.setReflection?.(reflection);
    }
    const water = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM, 256, 256).rotateX(-Math.PI / 2), materials.top);
    water.name = 'Generated offshore water';
    water.receiveShadow = true;
    group.add(water);
    // A denser near patch replaces the corresponding center cells of the regional plane.
    const outerIndex = water.geometry.index.array;
    const positions = water.geometry.attributes.position.array;
    const kept = [];
    for (let index = 0; index < outerIndex.length; index += 3) {
      const a = outerIndex[index] * 3, b = outerIndex[index + 1] * 3, c = outerIndex[index + 2] * 3;
      const x = (positions[a] + positions[b] + positions[c]) / 3;
      const z = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
      if (Math.abs(x) >= 1024 || Math.abs(z) >= 1024) kept.push(outerIndex[index], outerIndex[index + 1], outerIndex[index + 2]);
    }
    water.geometry.setIndex(kept);
    const nearWater = new THREE.Mesh(new THREE.PlaneGeometry(2048, 2048, 256, 256).rotateX(-Math.PI / 2), materials.top);
    nearWater.name = 'Generated fine water';
    nearWater.receiveShadow = true;
    group.add(nearWater);
    const landGeometry = new THREE.PlaneGeometry(widthM, heightM, 256, 256).rotateX(-Math.PI / 2);
    const landPositions = landGeometry.attributes.position;
    for (let index = 0; index < landPositions.count; index++) {
      const x = landPositions.getX(index), z = landPositions.getZ(index);
      landPositions.setY(index, landHeight(x, z));
    }
    landGeometry.computeVertexNormals();
    const land = new THREE.Mesh(landGeometry, new THREE.MeshStandardMaterial({ color: 0x9c9678, roughness: 0.82 }));
    land.name = 'Generated land and submerged floor';
    land.receiveShadow = true;
    group.add(land);
    const backdrop = window.NotoOceanBackdrop?.create({
      THREE, scene, terrain: group, camera, controls,
      metadata: { width_m: widthM, height_m: heightM }, motion, materials
    }) || null;
    const temporal = window.NotoTemporalReconstruction.create({ THREE, renderer });
    temporal.setEnabled(false);
    let now = 1000, viewIndex = 0, weatherIndex = 0, skyTime = 0;
    let weather = 'clear', day = true, verticalScale = 1;
    const views = [
      { name: 'grazing', eye: [520, 11, 480], target: [120, 0, -700] },
      { name: 'coast', eye: [170, 85, 280], target: [-210, 0, -170] },
      { name: 'top', eye: [80, 880, 250], target: [-50, 0, 0] }
    ];
    function applyLighting(nextWeather = weather, daylight = day) {
      weather = nextWeather;
      day = daylight;
      const sky = new THREE.Color(day ? weather === 'rainy' ? 0x697f90 : weather === 'cloudy' ? 0xa6b4bf : 0xb8d9ed : 0x0b1222);
      scene.background = sky;
      scene.fog = new THREE.Fog(sky, weather === 'rainy' ? 1500 : 7000, weather === 'rainy' ? 6500 : 20000);
      renderer.setClearColor(sky);
      const direction = new THREE.Vector3(0.42, day ? 0.39 : -0.35, -0.8).normalize();
      sun.position.copy(direction).multiplyScalar(5000);
      sun.color.set(0xfff4e3);
      sun.intensity = day ? weather === 'clear' ? 3 : weather === 'cloudy' ? 0.9 : 0.35 : 0;
      ambient.intensity = day ? weather === 'rainy' ? 1.15 : 1.4 : 0.1;
      ambient.color.set(day ? 0xffffff : 0x23334e);
      motion.setWeather(weather);
      motion.setSky(sky);
      const lighting = {
        direction: direction.toArray(), elevation: day ? 23 : -20, weather,
        sunColor: sun.color.toArray(), sunIntensity: sun.intensity,
        hemisphereIntensity: ambient.intensity, skyColor: sky.toArray(), groundColor: ambient.groundColor.toArray()
      };
      motion.setLighting?.(lighting);
      reflection?.setLighting(lighting);
      atmosphere?.setLighting(lighting);
      spectrum?.setWeather(weather);
      temporal.invalidate('lighting');
    }
    function setView(index) {
      viewIndex = index % views.length;
      camera.position.set(...views[viewIndex].eye);
      camera.lookAt(...views[viewIndex].target);
      controls.target.set(...views[viewIndex].target);
      camera.updateMatrixWorld();
    }
    function setScale(value) {
      verticalScale = value;
      group.scale.y = value;
      motion.setView(8, value);
      reflection?.invalidate('vertical-scale');
      temporal.invalidate('vertical-scale');
    }
    function frame(seconds = 0) {
      if (seconds) motion.advance(seconds);
      skyTime += seconds;
      now += Math.max(1 / 60, seconds) * 1000;
      spectrum?.update(motion.getState().time);
      camera.updateMatrixWorld();
      group.updateMatrixWorld(true);
      atmosphere?.update(skyTime);
      backdrop?.update();
      reflection?.update({ now, waterVisible: true });
      temporal.render(scene, camera, { now });
      document.querySelector('#state').textContent = JSON.stringify({ view: views[viewIndex].name, weather, day, verticalScale, water: motion.getState(), spectrum: spectrum?.getState() || null, reflection: reflection?.getState() || null, atmosphere: atmosphere?.getState() || null, temporal: temporal.getState() }, null, 2);
    }
    function snapshot() {
      const gl = renderer.getContext();
      const pixels = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
      gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    }
    function compare(a, b, width = renderer.domElement.width, height = renderer.domElement.height) {
      let total = 0, maximum = 0, changed = 0, count = 0;
      for (let row = Math.floor(height * 0.14); row < Math.floor(height * 0.85); row++) {
        for (let col = Math.floor(width * 0.28); col < Math.floor(width * 0.88); col++) {
          const offset = (row * width + col) * 4;
          let pixelChange = 0;
          for (let channel = 0; channel < 3; channel++) { const delta = Math.abs(a[offset + channel] - b[offset + channel]); total += delta; pixelChange = Math.max(pixelChange, delta); }
          maximum = Math.max(maximum, pixelChange);
          if (pixelChange > 3) changed++;
          count++;
        }
      }
      return { mean: total / (count * 3), maximum, changedPixels: changed, pixels: count };
    }
    function meanLuminance(pixels) {
      let total = 0, count = 0;
      const width = renderer.domElement.width, height = renderer.domElement.height;
      for (let row = Math.floor(height * 0.25); row < Math.floor(height * 0.72); row++) for (let col = Math.floor(width * 0.40); col < Math.floor(width * 0.88); col++) {
        const offset = (row * width + col) * 4;
        total += pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
        count++;
      }
      return total / count;
    }
    function imageRegion(pixels, bounds) {
      const width = renderer.domElement.width, height = renderer.domElement.height;
      let r = 0, g = 0, b = 0, count = 0;
      const values = [];
      // readPixels is bottom-up. Bounds are normalized from the bottom left.
      for (let row = Math.floor(height * bounds[1]); row < Math.floor(height * bounds[3]); row++) {
        for (let col = Math.floor(width * bounds[0]); col < Math.floor(width * bounds[2]); col++) {
          const offset = (row * width + col) * 4;
          r += pixels[offset]; g += pixels[offset + 1]; b += pixels[offset + 2];
          values.push(pixels[offset], pixels[offset + 1], pixels[offset + 2]); count++;
        }
      }
      return { rgb: [r / count, g / count, b / count], values, pixels: count };
    }
    function regionDifference(a, b, bounds) {
      const left = imageRegion(a, bounds), right = imageRegion(b, bounds);
      let maximum = 0, total = 0, changedPixels = 0;
      for (let index = 0; index < left.values.length; index += 3) {
        let delta = 0;
        for (let channel = 0; channel < 3; channel++) {
          const change = Math.abs(left.values[index + channel] - right.values[index + channel]);
          total += change; delta = Math.max(delta, change);
        }
        maximum = Math.max(maximum, delta);
        if (delta > 3) changedPixels++;
      }
      return { mean: total / left.values.length, maximum, changedPixels, pixels: left.pixels };
    }
    function gpuOffsets(points, normalProbe = false) {
      const previous = renderer.getRenderTarget();
      const target = new THREE.WebGLRenderTarget(points.length, 1, { type: THREE.FloatType, depthBuffer: false });
      const material = new THREE.ShaderMaterial({
        uniforms: { ...motion.uniforms, uProbePoints: { value: points.map(point => new THREE.Vector2(...point)) } },
        vertexShader: 'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: `${motion.shaderDeclarations}\nuniform vec2 uProbePoints[${points.length}];\nvoid main(){int index=int(gl_FragCoord.x);gl_FragColor=vec4(${normalProbe ? 'seaNormal' : 'seaOffset'}(uProbePoints[index]),1.0);}`,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending
      });
      const probe = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      probe.add(mesh);
      const result = new Float32Array(points.length * 4);
      try {
        renderer.setRenderTarget(target);
        renderer.render(probe, new THREE.Camera());
        renderer.readRenderTargetPixels(target, 0, 0, points.length, 1, result);
      } finally {
        renderer.setRenderTarget(previous);
        mesh.geometry.dispose(); material.dispose(); target.dispose();
      }
      return points.map((point, index) => {
        let cpu = motion.sample(...point);
        if (normalProbe) {
          const [x, z] = point, epsilon = 0.25;
          const left = motion.sample(x - epsilon, z), right = motion.sample(x + epsilon, z);
          const down = motion.sample(x, z - epsilon), up = motion.sample(x, z + epsilon);
          const dx = new THREE.Vector3(2 * epsilon + right[0] - left[0], right[1] - left[1], right[2] - left[2]);
          const dz = new THREE.Vector3(up[0] - down[0], up[1] - down[1], 2 * epsilon + up[2] - down[2]);
          cpu = dz.cross(dx).normalize().toArray();
        }
        return { point, gpu: [...result.slice(index * 4, index * 4 + 3)], cpu };
      });
    }
    function readSpectrum(texture, lengthM = 1024) {
      const previous = renderer.getRenderTarget();
      const target = new THREE.WebGLRenderTarget(32, 32, { type: THREE.FloatType, depthBuffer: false });
      const material = new THREE.ShaderMaterial({
        uniforms: { uImage: { value: texture } },
        vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: 'uniform sampler2D uImage;varying vec2 vUv;void main(){gl_FragColor=texture2D(uImage,vUv);}',
        depthTest: false, depthWrite: false, blending: THREE.NoBlending
      });
      const probe = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      probe.add(mesh);
      const pixels = new Float32Array(32 * 32 * 4);
      try {
        renderer.setRenderTarget(target);
        renderer.render(probe, new THREE.Camera());
        renderer.readRenderTargetPixels(target, 0, 0, 32, 32, pixels);
      } finally {
        renderer.setRenderTarget(previous);
        mesh.geometry.dispose(); material.dispose(); target.dispose();
      }
      const minima = [Infinity, Infinity, Infinity, Infinity], maxima = [-Infinity, -Infinity, -Infinity, -Infinity];
      let finite = true, slopeSquares = 0, meanHeight = 0;
      let positiveHeightCrest = 0, negativeHeightCrest = 0, positiveCount = 0, negativeCount = 0, whitecaps = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        for (let channel = 0; channel < 4; channel++) {
          const value = pixels[index + channel];
          finite &&= Number.isFinite(value);
          minima[channel] = Math.min(minima[channel], value);
          maxima[channel] = Math.max(maxima[channel], value);
        }
        slopeSquares += pixels[index] ** 2 + pixels[index + 1] ** 2;
        meanHeight += pixels[index + 3];
        if (pixels[index + 3] > 0) { positiveHeightCrest += pixels[index + 2]; positiveCount++; }
        else { negativeHeightCrest += pixels[index + 2]; negativeCount++; }
        if (pixels[index + 2] > 0.54) whitecaps++;
      }
      let gradientDot = 0, gradientEnergy = 0, slopeEnergy = 0;
      const heightAt = (col, row) => pixels[(((row + 32) % 32) * 32 + (col + 32) % 32) * 4 + 3];
      for (let row = 0; row < 32; row++) for (let col = 0; col < 32; col++) {
        const index = (row * 32 + col) * 4;
        const dx = (heightAt(col + 1, row) - heightAt(col - 1, row)) * 32 / (2 * lengthM);
        const dz = (heightAt(col, row + 1) - heightAt(col, row - 1)) * 32 / (2 * lengthM);
        gradientDot += dx * pixels[index] + dz * pixels[index + 1];
        gradientEnergy += dx * dx + dz * dz;
        slopeEnergy += pixels[index] ** 2 + pixels[index + 1] ** 2;
      }
      return { pixels, statistics: {
        finite, minima, maxima, slopeRMS: Math.sqrt(slopeSquares / (pixels.length / 4)), meanHeight: meanHeight / (pixels.length / 4),
        positiveHeightMeanCrest: positiveHeightCrest / Math.max(1, positiveCount),
        negativeHeightMeanCrest: negativeHeightCrest / Math.max(1, negativeCount),
        whitecapFraction: whitecaps / (pixels.length / 4),
        gradientCorrelation: gradientDot / Math.sqrt(Math.max(1e-20, gradientEnergy * slopeEnergy))
      } };
    }
    function floatDifference(a, b) {
      let maximum = 0, total = 0;
      for (let index = 0; index < a.length; index++) { const difference = Math.abs(a[index] - b[index]); total += difference; maximum = Math.max(maximum, difference); }
      return { maximum, mean: total / a.length };
    }
    function rendererSnapshot() {
      return {
        viewport: renderer.getViewport(new THREE.Vector4()).toArray(),
        scissor: renderer.getScissor(new THREE.Vector4()).toArray(),
        scissorTest: renderer.getScissorTest(),
        clearColor: renderer.getClearColor(new THREE.Color()).toArray(),
        clearAlpha: renderer.getClearAlpha(), autoClear: renderer.autoClear,
        toneMapping: renderer.toneMapping, outputColorSpace: renderer.outputColorSpace,
        shadowAutoUpdate: renderer.shadowMap.autoUpdate, shadowNeedsUpdate: renderer.shadowMap.needsUpdate,
        infoAutoReset: renderer.info.autoReset, xrEnabled: renderer.xr.enabled
      };
    }
    function skyProbes(directions) {
      const previous = renderer.getRenderTarget();
      const target = new THREE.WebGLRenderTarget(directions.length, 1, { type: THREE.FloatType, depthBuffer: false });
      const material = new THREE.ShaderMaterial({
        uniforms: { ...atmosphere.uniforms, uProbeDirections: { value: directions.map(point => new THREE.Vector3(...point).normalize()) } },
        vertexShader: 'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: `${window.NotoSkyAtmosphere.shaderDeclarations}\nuniform vec3 uProbeDirections[${directions.length}];\nvoid main(){vec3 ray=uProbeDirections[int(gl_FragCoord.x)];gl_FragColor=vec4(atmosphereSkyColor(ray),atmosphereCloudTransmission(ray));}`,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending
      });
      const probe = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      probe.add(mesh);
      const result = new Float32Array(directions.length * 4);
      try {
        renderer.setRenderTarget(target);
        renderer.render(probe, new THREE.Camera());
        renderer.readRenderTargetPixels(target, 0, 0, directions.length, 1, result);
      } finally {
        renderer.setRenderTarget(previous);
        mesh.geometry.dispose(); material.dispose(); target.dispose();
      }
      return directions.map((direction, index) => ({ direction, rgba: [...result.slice(index * 4, index * 4 + 4)] }));
    }
    function solarLighting(elevation, mode = 'clear', azimuth = 0) {
      weather = mode;
      day = elevation > -6;
      const radians = elevation * Math.PI / 180;
      const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(radians), Math.sin(radians), -Math.cos(azimuth) * Math.cos(radians));
      sun.position.copy(direction).multiplyScalar(5000);
      sun.color.set(elevation < 12 ? 0xffbd83 : 0xfff4e3);
      sun.intensity = (weather === 'clear' ? 3 : weather === 'cloudy' ? 0.9 : 0.35) * Math.max(0, Math.min(1, direction.y * 5));
      const sky = new THREE.Color(day ? 0xb8d9ed : 0x0b1222);
      ambient.color.set(day ? 0xffffff : 0x23334e);
      ambient.intensity = day ? 1.4 : 0.1;
      const lighting = { direction: direction.toArray(), elevation, weather, sunColor: sun.color.toArray(), sunIntensity: sun.intensity, skyColor: sky.toArray() };
      motion.setWeather(weather); motion.setSky(sky); motion.setLighting?.(lighting);
      reflection?.setLighting(lighting); atmosphere?.setLighting(lighting);
      temporal.invalidate('lighting');
      return direction;
    }
    function skyLongitudeSeam() {
      const width = 254, height = 8;
      const previous = renderer.getRenderTarget();
      const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.FloatType, depthBuffer: false });
      const material = new THREE.ShaderMaterial({
        uniforms: { ...atmosphere.uniforms, uSeamMode: { value: 0 } },
        vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: `${window.NotoSkyAtmosphere.shaderDeclarations}
          uniform int uSeamMode;varying vec2 vUv;
          void main(){
            vec3 direction=normalize(vec3(-1.0,0.2,(vUv.x-0.5)*0.02));
            vec2 sampleUv=atmosphereSkyUv(direction);
            if(uSeamMode==1) gl_FragColor=texture2D(uSkyAtmosphereMap,sampleUv);
            else if(uSeamMode==2) gl_FragColor=textureLod(uSkyAtmosphereMap,sampleUv,0.0);
            else gl_FragColor=vec4(atmosphereSkyColor(direction),atmosphereCloudTransmission(direction));
          }`,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending
      });
      const probe = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      probe.add(mesh);
      const render = mode => {
        const pixels = new Float32Array(width * height * 4);
        material.uniforms.uSeamMode.value = mode;
        renderer.setRenderTarget(target);
        renderer.render(probe, new THREE.Camera());
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
        return pixels;
      };
      try {
        // An odd half-width places the wrap inside a derivative quad, exposing implicit-LOD failure.
        const actual = render(0), legacy = render(1), reference = render(2);
        const center = [width / 2 - 1, width / 2];
        const pixel = (image, x) => [...image.slice((3 * width + x) * 4, (3 * width + x) * 4 + 4)];
        const error = image => Math.max(...center.flatMap(x => pixel(image, x).map((value, channel) => Math.abs(value - pixel(reference, x)[channel]))));
        const neighborJump = image => Math.max(...center.flatMap(x => pixel(image, x).map((value, channel) => Math.abs(value - pixel(image, x === center[0] ? x - 1 : x + 1)[channel]))));
        return {
          width, height, direction: 'normalize(-1,0.2,(u-0.5)*0.02)',
          actualError: error(actual), legacyError: error(legacy),
          actualNeighborJump: neighborJump(actual), legacyNeighborJump: neighborJump(legacy),
          actualCenter: center.map(x => pixel(actual, x)), referenceCenter: center.map(x => pixel(reference, x)),
          legacyCenter: center.map(x => pixel(legacy, x))
        };
      } finally {
        renderer.setRenderTarget(previous);
        mesh.geometry.dispose(); material.dispose(); target.dispose();
      }
    }
    function checkLongitudeSeam() {
      temporal.setEnabled(false);
      solarLighting(3);
      skyTime = 100;
      frame();
      const report = skyLongitudeSeam();
      camera.position.set(3500, 14, 2000);
      controls.target.set(800, 30, 2000);
      camera.lookAt(controls.target);
      camera.updateMatrixWorld();
      frame();
      return report;
    }
    async function runChecks() {
      const report = { views: [], probes: [], spectrum: null, errors: [] };
      const images = {};
      const capture = name => { images[name] = renderer.domElement.toDataURL('image/png'); };
      applyLighting('clear', true);
      setScale(1);
      for (let index = 0; index < views.length; index++) {
        setView(index);
        frame();
        const before = snapshot();
        capture(views[index].name + '-time0');
        frame(1.25);
        const after = snapshot();
        capture(views[index].name + '-animated');
        report.views.push({ name: views[index].name, motion: compare(before, after), meanLuminance: meanLuminance(after) });
      }
      const points = [[500, 200], [100, -300], [-250, 0], [4096, 0]];
      report.probes = gpuOffsets(points);
      report.normalProbes = gpuOffsets(points, true);
      if (spectrum?.getState().active) {
        const largeBefore = readSpectrum(spectrum.uniforms.uOceanSpectrumLarge.value);
        const smallBefore = readSpectrum(spectrum.uniforms.uOceanSpectrumSmall.value, spectrum.uniforms.uOceanSpectrumSize.value.y);
        frame(0.75);
        const largeAfter = readSpectrum(spectrum.uniforms.uOceanSpectrumLarge.value);
        report.fields = { large: largeBefore.statistics, small: smallBefore.statistics, evolution: floatDifference(largeBefore.pixels, largeAfter.pixels) };
        const duplicate = window.NotoOceanSpectrum.create({ THREE, renderer });
        try {
          duplicate.setWeather(weather);
          duplicate.update(motion.getState().time);
          const duplicateField = readSpectrum(duplicate.uniforms.uOceanSpectrumLarge.value);
          report.fields.determinism = floatDifference(largeAfter.pixels, duplicateField.pixels);
        } finally { duplicate.dispose(); }
      }
      const sampleBefore = motion.sample(500, 200);
      setScale(10);
      report.scale = { before: sampleBefore, after: motion.sample(500, 200), scaleY: motion.getState().scaleY };
      setScale(1);
      setView(0);
      applyLighting('clear', true); frame();
      const clear = snapshot();
      capture('clear');
      applyLighting('rainy', true); frame();
      const rainy = snapshot();
      capture('rainy');
      report.weather = { change: compare(clear, rainy), clearLuminance: meanLuminance(clear), rainyLuminance: meanLuminance(rainy) };
      applyLighting('clear', true);
      const lowSun = new THREE.Vector3(-0.28, 0.08, -0.957).normalize();
      sun.position.copy(lowSun).multiplyScalar(5000);
      sun.color.set(0xffc28d);
      sun.intensity = 2.2;
      const lowLighting = { direction: lowSun.toArray(), elevation: 4.6, weather: 'clear', sunColor: sun.color.toArray(), sunIntensity: 2.2, skyColor: new THREE.Color(0xb8d9ed).toArray() };
      motion.setLighting?.(lowLighting);
      reflection?.setLighting(lowLighting);
      atmosphere?.setLighting(lowLighting);
      frame();
      capture('low-sun-glint');
      applyLighting('clear', false); frame();
      const night = snapshot();
      capture('night');
      report.night = { luminance: meanLuminance(night), daylight: meanLuminance(clear) };
      applyLighting('clear', true);
      temporal.setEnabled(true);
      for (let index = 0; index < 8; index++) frame();
      report.temporal = temporal.getState();
      capture('temporal');
      report.spectrum = spectrum?.getState() || null;
      const frozenTime = motion.getState().time;
      const frozenUpdates = spectrum?.getState().updates;
      const frozen = snapshot();
      await new Promise(resolve => setTimeout(resolve, 120));
      const stayedFrozen = snapshot();
      report.idle = { timeBefore: frozenTime, timeAfter: motion.getState().time, updatesBefore: frozenUpdates, updatesAfter: spectrum?.getState().updates, difference: compare(frozen, stayedFrozen) };
      frame();
      const beforeUnchangedUpdate = spectrum?.getState().updates;
      frame();
      report.sameTime = { updatesBefore: beforeUnchangedUpdate, updatesAfter: spectrum?.getState().updates };
      if (reflection) {
        temporal.setEnabled(false);
        setView(1);
        applyLighting('clear', true);
        now += 200;
        reflection.invalidate('Reflection visual check');
        frame();
        const reflected = snapshot();
        capture('terrain-reflection');
        const reflectionTexture = readSpectrum(reflection.uniforms.uSeaReflection.value);
        const enabledBefore = reflection.uniforms.uSeaReflectionEnabled.value;
        reflection.uniforms.uSeaReflectionEnabled.value = 0;
        frame();
        const withoutReflection = snapshot();
        capture('without-terrain-reflection');
        reflection.uniforms.uSeaReflectionEnabled.value = enabledBefore;
        const cameraBefore = { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray(), inverse: camera.projectionMatrixInverse.toArray() };
        const captureBefore = reflection.getState().captures;
        reflection.update({ now: now + 200, waterVisible: true });
        const captureAfterReuse = reflection.getState().captures;
        reflection.invalidate('Throttle check');
        const throttleStart = reflection.getState().captures;
        reflection.update({ now: now + 1, waterVisible: true });
        const throttled = reflection.getState();
        reflection.update({ now: now + 200, waterVisible: true });
        const flushed = reflection.getState();
        group.scale.y = 2;
        group.updateMatrixWorld(true);
        reflection.update({ now: now + 400, waterVisible: true });
        const scaled = reflection.getState();
        group.scale.y = verticalScale;
        group.updateMatrixWorld(true);
        reflection.setLighting({ direction: [0.2, 0.7, -0.4], sunIntensity: 0.4, elevation: 45, weather: 'cloudy' });
        reflection.update({ now: now + 600, waterVisible: true });
        const relit = reflection.getState();
        const priorTarget = renderer.getRenderTarget(), originalState = rendererSnapshot();
        const sentinel = new THREE.WebGLRenderTarget(24, 24, { depthBuffer: false });
        let stateRestoration;
        try {
          renderer.setRenderTarget(sentinel);
          renderer.setViewport(1, 2, 18, 17);
          renderer.setScissor(3, 4, 12, 11);
          renderer.setScissorTest(true);
          renderer.setClearColor(0x345678, 0.3);
          renderer.autoClear = false;
          renderer.shadowMap.autoUpdate = false;
          renderer.shadowMap.needsUpdate = true;
          reflection.invalidate('Renderer state check');
          const before = rendererSnapshot();
          reflection.update({ now: now + 800, waterVisible: true });
          stateRestoration = { before, after: rendererSnapshot(), sameTarget: renderer.getRenderTarget() === sentinel };
        } finally {
          renderer.setRenderTarget(priorTarget);
          renderer.setViewport(...originalState.viewport);
          renderer.setScissor(...originalState.scissor);
          renderer.setScissorTest(originalState.scissorTest);
          renderer.setClearColor(new THREE.Color().fromArray(originalState.clearColor), originalState.clearAlpha);
          renderer.autoClear = originalState.autoClear;
          renderer.shadowMap.autoUpdate = originalState.shadowAutoUpdate;
          renderer.shadowMap.needsUpdate = originalState.shadowNeedsUpdate;
          sentinel.dispose();
        }
        const hiddenBefore = reflection.getState().captures;
        reflection.invalidate('Hidden-water check');
        reflection.update({ now: now + 1000, waterVisible: false });
        report.reflection = {
          state: reflection.getState(), imageChange: compare(reflected, withoutReflection), texture: reflectionTexture.statistics,
          captureBefore, captureAfterReuse, throttleStart, throttled, flushed, scaled, relit, stateRestoration,
          hidden: { before: hiddenBefore, after: reflection.getState().captures, needsFrame: reflection.needsFrame() },
          cameraBefore, cameraAfter: { world: camera.matrixWorld.toArray(), projection: camera.projectionMatrix.toArray(), inverse: camera.projectionMatrixInverse.toArray() }
        };
      }
      if (spectrum?.getState().active) {
        const targetBefore = renderer.getRenderTarget();
        const originalState = rendererSnapshot();
        const sentinel = new THREE.WebGLRenderTarget(24, 24, { depthBuffer: false });
        try {
          renderer.setRenderTarget(sentinel);
          renderer.setViewport(1, 2, 18, 17);
          renderer.setScissor(3, 4, 12, 11);
          renderer.setScissorTest(true);
          renderer.setClearColor(0x123456, 0.4);
          renderer.autoClear = false;
          renderer.shadowMap.autoUpdate = false;
          renderer.shadowMap.needsUpdate = true;
          motion.advance(0.1);
          const before = rendererSnapshot();
          spectrum.update(motion.getState().time);
          report.rendererState = { before, after: rendererSnapshot(), sameTarget: renderer.getRenderTarget() === sentinel };
        } finally {
          renderer.setRenderTarget(targetBefore);
          renderer.setViewport(...originalState.viewport);
          renderer.setScissor(...originalState.scissor);
          renderer.setScissorTest(originalState.scissorTest);
          renderer.setClearColor(new THREE.Color().fromArray(originalState.clearColor), originalState.clearAlpha);
          renderer.autoClear = originalState.autoClear;
          renderer.shadowMap.autoUpdate = originalState.shadowAutoUpdate;
          renderer.shadowMap.needsUpdate = originalState.shadowNeedsUpdate;
          sentinel.dispose();
        }
      }
      if (window.NotoOceanSpectrum) {
        const actualGL = renderer.getContext();
        const unsupportedContext = new Proxy(actualGL, { get(target, property) {
          if (property === 'getExtension') return name => name === 'EXT_color_buffer_float' ? null : target.getExtension(name);
          const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
        } });
        const unsupportedRenderer = new Proxy(renderer, { get(target, property) {
          if (property === 'getContext') return () => unsupportedContext;
          const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
        } });
        const unsupported = window.NotoOceanSpectrum.create({ THREE, renderer: unsupportedRenderer });
        try {
          unsupported.update(motion.getState().time);
          report.spectrumFallback = { state: unsupported.getState(), enabled: unsupported.uniforms.uOceanSpectrumEnabled.value };
        } finally { unsupported.dispose(); }
      }
      if (atmosphere) {
        temporal.setEnabled(false);
        setScale(1);
        camera.position.set(650, 14, 650);
        controls.target.set(650, 30, -2000);
        camera.lookAt(controls.target);
        camera.updateMatrixWorld();
        const skyRegion = [0.12, 0.63, 0.88, 0.95];
        const waterRegion = [0.15, 0.10, 0.88, 0.38];
        const horizonDirections = [[0, 0.055, -1], [0, 0.22, -1], [0, 1, 0], [0.8, 0.12, -0.6]];
        solarLighting(50);
        skyTime = 100;
        frame();
        const noon = snapshot();
        capture('atmosphere-noon');
        const noonProbes = skyProbes(horizonDirections);
        const beforeTimeChange = atmosphere.getState().updates;
        skyTime += 60;
        frame();
        const afterTimeChange = atmosphere.getState().updates;
        const beforeSameTime = atmosphere.getState().updates;
        frame();
        const afterSameTime = atmosphere.getState().updates;
        const frozenImage = snapshot(), frozenState = atmosphere.getState();
        await new Promise(resolve => setTimeout(resolve, 150));
        const idleSkyState = atmosphere.getState();
        const idleSkyImage = snapshot();
        const sunriseDirection = solarLighting(3, 'clear', -0.1);
        frame();
        const sunrise = snapshot();
        const sunriseProbes = skyProbes(horizonDirections);
        capture('atmosphere-sunrise');
        const sunsetDirection = solarLighting(3, 'clear', 0.1);
        frame();
        const sunset = snapshot();
        const sunsetProbes = skyProbes(horizonDirections);
        capture('atmosphere-sunset');
        solarLighting(-20);
        frame();
        const nightSky = snapshot();
        capture('atmosphere-night');
        const priorTarget = renderer.getRenderTarget(), originalState = rendererSnapshot();
        const sentinel = new THREE.WebGLRenderTarget(24, 24, { depthBuffer: false });
        let stateRestoration;
        try {
          renderer.setRenderTarget(sentinel);
          renderer.setViewport(1, 2, 18, 17);
          renderer.setScissor(3, 4, 12, 11);
          renderer.setScissorTest(true);
          renderer.setClearColor(0x135724, 0.35);
          renderer.autoClear = false;
          renderer.shadowMap.autoUpdate = false;
          renderer.shadowMap.needsUpdate = true;
          atmosphere.setLighting({ direction: [0.2, 0.1, -0.97], elevation: 6, weather: 'cloudy', sunColor: [1, 0.7, 0.4] });
          const before = rendererSnapshot();
          atmosphere.update(skyTime + 1);
          stateRestoration = { before, after: rendererSnapshot(), sameTarget: renderer.getRenderTarget() === sentinel };
        } finally {
          renderer.setRenderTarget(priorTarget);
          renderer.setViewport(...originalState.viewport);
          renderer.setScissor(...originalState.scissor);
          renderer.setScissorTest(originalState.scissorTest);
          renderer.setClearColor(new THREE.Color().fromArray(originalState.clearColor), originalState.clearAlpha);
          renderer.autoClear = originalState.autoClear;
          renderer.shadowMap.autoUpdate = originalState.shadowAutoUpdate;
          renderer.shadowMap.needsUpdate = originalState.shadowNeedsUpdate;
          sentinel.dispose();
        }
        report.atmosphere = {
          state: atmosphere.getState(), backdrop: backdrop?.getState(), noonProbes, sunriseProbes, sunsetProbes,
          timeOnly: { before: beforeTimeChange, after: afterTimeChange },
          sameTime: { before: beforeSameTime, after: afterSameTime },
          idle: { before: frozenState, after: idleSkyState, difference: regionDifference(frozenImage, idleSkyImage, skyRegion) },
          sunrise: { direction: sunriseDirection.toArray(), skyRGB: imageRegion(sunrise, skyRegion).rgb, waterRGB: imageRegion(sunrise, waterRegion).rgb },
          sunset: { direction: sunsetDirection.toArray(), skyRGB: imageRegion(sunset, skyRegion).rgb, waterRGB: imageRegion(sunset, waterRegion).rgb },
          noon: { skyRGB: imageRegion(noon, skyRegion).rgb, waterRGB: imageRegion(noon, waterRegion).rgb },
          night: { skyRGB: imageRegion(nightSky, skyRegion).rgb, waterRGB: imageRegion(nightSky, waterRegion).rgb },
          stateRestoration
        };
        report.atmosphere.seam = checkLongitudeSeam();
        capture('atmosphere-west-longitude-seam');
      }
      if (clouds) {
        temporal.setEnabled(false);
        setView(0);
        applyLighting('cloudy', true);
        clouds.setLighting({ direction: [0.42, 0.39, -0.8], elevation: 23, weather: 'cloudy', sunColor: sun.color.toArray() });
        frame();
        const clearWater = snapshot();
        const fixedWaveTime = motion.getState().time;
        clouds.setTime(20); clouds.update(20);
        frame();
        const reflectedClouds = snapshot();
        capture('world-cloud-reflection');
        clouds.setTime(80); clouds.update(80);
        frame();
        report.worldCloudReflection = {
          state: clouds.getState(), effect: compare(clearWater, reflectedClouds), drift: compare(reflectedClouds, snapshot()),
          waveTimeBefore: fixedWaveTime, waveTimeAfter: motion.getState().time
        };
      }
      window.oceanStressImages = images;
      window.oceanStressReport = report;
      return report;
    }
    window.oceanStress = { THREE, renderer, scene, camera, motion, spectrum, reflection, atmosphere, clouds, backdrop, temporal, setView, setScale, applyLighting, frame, snapshot, checkLongitudeSeam, runChecks };
    applyLighting(); setScale(1); setView(0); frame();
    for (const button of document.querySelectorAll('button')) button.disabled = false;
    document.querySelector('#advance').onclick = () => frame(1);
    document.querySelector('#view').onclick = () => { setView(viewIndex + 1); frame(); };
    document.querySelector('#weather').onclick = () => { weatherIndex = (weatherIndex + 1) % 3; applyLighting(['clear', 'cloudy', 'rainy'][weatherIndex]); frame(); };
    document.querySelector('#temporal').onclick = () => { temporal.setEnabled(!temporal.getState().enabled); frame(); };
  } catch (error) {
    document.querySelector('#state').textContent = error.stack;
    window.oceanStressError = error.stack;
    throw error;
  }
})();
