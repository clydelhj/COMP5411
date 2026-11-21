/* Asset-free sky-background and foreground visibility checks. Readback and diagnostic controls exist only in this fixture. */
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
    const camera = new THREE.PerspectiveCamera(55, 720 / 480, 1, 700000);
    const sky = window.NotoSkyAtmosphere.create({ THREE, renderer });
    const temporal = window.NotoTemporalReconstruction.create({ THREE, renderer });
    const subject = new THREE.Mesh(new THREE.PlaneGeometry(900, 600), new THREE.MeshBasicMaterial({ color: 0x39552a }));
    scene.add(subject);

    // Exercise the production sky triangle without adding the offshore water strips.
    const skyOnly = {
      shoreAt: (_x,z) => z < 0 ? 512 : -512,
      uniforms: {
        ...sky.uniforms,
        uSeaSunDirection: sky.uniforms.uAtmosphereSunDirection,
        uSeaSunColor: { value: new THREE.Color(1,1,1) }, uSeaSunIntensity: { value: 1 }
      },
      skyShaderDeclarations: window.NotoSkyAtmosphere.shaderDeclarations
        + '\nuniform vec3 uSeaSunDirection;\nvec3 seaSkyColor(vec3 d){return atmosphereSkyColor(d);}'
    };
    const backdrop = window.NotoOceanBackdrop.create({
      THREE, scene, terrain: new THREE.Group(), camera, controls: { target: new THREE.Vector3() },
      metadata: { width_m: 30000, height_m: 20000 }, motion: skyOnly,
      materials: { top: new THREE.MeshBasicMaterial() }
    });
    const forward = new THREE.Vector3(0, 0.38, -1).normalize();
    function setAltitude(y) {
      camera.position.set(0,y,0);
      camera.lookAt(camera.position.clone().add(forward));
      subject.position.copy(camera.position).addScaledVector(forward, 1200);
      subject.quaternion.copy(camera.quaternion);
    }
    function frame(time) {
      sky.update(time);
      temporal.render(scene, camera, { now: 1000 + time * 1000 });
    }
    function weather(preset) {
      sky.setLighting({ direction: [0.2,0.7,-0.68], elevation: 44, weather: preset, sunColor: [1,0.93,0.84] });
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


    function runChecks() {
      temporal.setEnabled(false);
      setAltitude(35);
      weather('clear');
      frame(0);
      const clear = snapshot();
      weather('rainy');
      frame(0);
      const rainy = snapshot();
      const foreground = [0.37,0.39,0.63,0.61];
      const background = [0,0.80,1,1];
      const report = {
        weatherSky: difference(clear,rainy,background),
        foreground: difference(clear,rainy,foreground),
        altitudes: []
      };
      capture('rainy');
      for (const altitude of [2600,11000,40000,100000]) {
        setAltitude(altitude);
        frame(0);
        const current = snapshot();
        report.altitudes.push({ altitude,
          sky: difference(rainy,current,background),
          foreground: difference(rainy,current,foreground) });
      }
      weather('cloudy');
      frame(0);
      const cloudy = snapshot();
      const initial = sky.getState().updates;
      frame(0.1);
      report.cached = sky.getState().updates === initial;
      frame(40);
      const drift = snapshot();
      report.drift = difference(cloudy,drift,background);
      report.foregroundDrift = difference(cloudy,drift,foreground);
      capture('cloudy');
      temporal.setEnabled(true);
      frame(40);
      const temporalFirst = snapshot();
      frame(80);
      const temporalSecond = snapshot();
      report.temporal = { active: temporal.getState().active,
        sky: difference(temporalFirst,temporalSecond,background),
        foreground: difference(temporalFirst,temporalSecond,foreground) };
      // The measured crop ends 10 km north of this camera. Water near the
      // horizon must still be visible when the scene far plane is only 2 km.
      temporal.setEnabled(false);
      subject.visible = false;
      camera.position.set(0, 1000, 0);
      camera.lookAt(0, 1000, -20000);
      camera.far = 2000;
      camera.updateProjectionMatrix();
      frame(80);
      const skyAlone = snapshot();
      backdrop.update();
      frame(80);
      const coastView = snapshot();
      report.horizon = {
        water: difference(skyAlone, coastView, [0.05, 0.45, 0.95, 0.49]),
        sky: difference(skyAlone, coastView, [0.05, 0.51, 0.95, 0.55])
      };
      camera.position.set(0, 19000, 22000);
      camera.lookAt(0, 0, 0);
      backdrop.update();
      report.horizon.overviewOpacity = backdrop.getState().horizonOpacity;
      camera.position.set(0, 1000, 0);
      camera.lookAt(0, 1000, 20000);
      frame(80);
      const landSky = snapshot();
      backdrop.update();
      frame(80);
      report.horizon.inland = difference(landSky, snapshot(), [0.05, 0.45, 0.95, 0.49]);
      const dryScene = new THREE.Scene();
      const dryBackdrop = window.NotoOceanBackdrop.create({
        THREE, scene: dryScene, terrain: new THREE.Group(), camera, hasOcean: false,
        metadata: {width_m: 30000, height_m: 20000}, motion: skyOnly,
        materials: {top: new THREE.MeshBasicMaterial()}
      });
      dryBackdrop.update();
      report.horizon.landOnlyOpacity = dryBackdrop.getState().horizonOpacity;
      dryBackdrop.dispose();
      report.final = sky.getState();
      document.querySelector('#state').textContent = JSON.stringify(report,null,2);
      return report;
    }
    weather('clear'); setAltitude(35); frame(0);
    window.cloudVolumeStress = { runChecks };
  } catch (error) {
    document.querySelector('#state').textContent = error.stack;
    window.cloudVolumeError = error.stack;
    throw error;
  }
})();
