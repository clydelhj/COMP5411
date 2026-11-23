/* Surface-following camera for travel over the displayed terrain and sea. */
(function registerFirstPerson(global) {
  'use strict';

  function create({ THREE, camera, controls, canvas, metadata, sampleLand, shore, water, changed }) {
    const eyeHeight = 1.8;
    const speed = 24;
    // Stay inside the last renderable DEM cell, including at the positive map edges.
    const halfWidth = metadata.width_m / 2, halfDepth = metadata.height_m / 2;
    const inset = Math.min(metadata.source_spacing_m[0] / 2, halfWidth / 2, halfDepth / 2);
    const savedEye = new THREE.Vector3(), savedTarget = new THREE.Vector3();
    let active = false, onWater = false, yaw = 0, pitch = 0;
    let drag = null;

    function aim() {
      const horizontal = 24 * Math.cos(pitch);
      controls.target.set(camera.position.x + Math.sin(yaw) * horizontal,
        camera.position.y + 24 * Math.sin(pitch), camera.position.z - Math.cos(yaw) * horizontal);
      camera.lookAt(controls.target);
    }
    function follow(x, z) {
      x = THREE.MathUtils.clamp(x, -halfWidth + inset, halfWidth - inset);
      z = THREE.MathUtils.clamp(z, -halfDepth + inset, halfDepth - inset);
      const ground = sampleLand(x, z);
      if (ground === null && shore.distance(x, z) < 0) return false;
      onWater = ground === null;
      camera.position.set(x, (onWater ? water.sample(x, z)[1] : ground) + eyeHeight, z);
      aim();
      return true;
    }
    function enter() {
      savedEye.copy(camera.position);
      savedTarget.copy(controls.target);
      yaw = Math.atan2(savedTarget.x - savedEye.x, savedEye.z - savedTarget.z);
      pitch = 0;
      if (!follow(savedTarget.x, savedTarget.z)) return false;
      controls.enabled = false;
      active = true;
      return true;
    }
    function cancelDrag() {
      if (!drag) return;
      const id = drag.id;
      drag = null;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    }
    function exit() {
      cancelDrag();
      active = false;
      onWater = false;
      // Flush any orbit damping left over from before entry, then restore the saved pose.
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      camera.position.copy(savedEye);
      controls.target.copy(savedTarget);
      controls.update();
      camera.position.copy(savedEye);
      controls.target.copy(savedTarget);
      controls.enableDamping = damping;
      controls.enabled = true;
      controls.update();
    }
    function move(actions, dt) {
      const forward = Number(actions.has('forward')) - Number(actions.has('back'));
      const left = actions.has('left') || actions.has('turnLeft');
      const right = actions.has('right') || actions.has('turnRight');
      const turn = Number(right) - Number(left);
      if (turn) {
        yaw += turn * dt;
        aim();
      }
      if (forward) {
        const step = forward * speed * dt;
        follow(camera.position.x + Math.sin(yaw) * step, camera.position.z - Math.cos(yaw) * step);
      }
      if (forward || turn) changed();
    }
    canvas.addEventListener('pointerdown', event => {
      if (!active || drag || event.button !== 0 || !event.isPrimary) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', event => {
      if (event.pointerId !== drag?.id) return;
      yaw += (event.clientX - drag.x) * 0.004;
      pitch = THREE.MathUtils.clamp(pitch - (event.clientY - drag.y) * 0.004, -1.4, 1.4);
      drag.x = event.clientX;
      drag.y = event.clientY;
      aim();
      changed();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, event => { if (event.pointerId === drag?.id) cancelDrag(); });
    }
    return {
      get active() { return active; },
      enter, exit, move, cancelDrag,
      refresh: () => follow(camera.position.x, camera.position.z),
      followWaves() {
        if (!onWater) return;
        camera.position.y = water.sample(camera.position.x, camera.position.z)[1] + eyeHeight;
        aim();
      }
    };
  }
  function createDashboard(metadata) {
    const speed = document.querySelector('#fp-speed');
    const date = document.querySelector('#fp-date');
    const time = document.querySelector('#fp-time');
    const position = document.querySelector('#fp-position');
    const weather = document.querySelector('#fp-weather');
    const metres = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    position.title = metadata.crs || metadata.sourceDatum || 'Projected easting and northing in metres';
    let visible = false, conditions;
    let lastX, lastZ, lastFrameMs, lastEast, lastNorth;
    let distanceM = 0, elapsedMs = 0;

    function write(element, value) {
      if (element.textContent !== value) element.textContent = value;
    }
    function setConditions(state) {
      conditions = state;
      if (!visible) return;
      write(date, state.date);
      write(time, state.time);
      write(weather, state.weather[0].toUpperCase() + state.weather.slice(1));
    }
    function locate(point) {
      const east = Math.round(metadata.origin_easting + point.x);
      const north = Math.round(metadata.origin_northing - point.z);
      if (east === lastEast && north === lastNorth) return;
      lastEast = east;
      lastNorth = north;
      position.textContent = `E ${metres.format(east)} · N ${metres.format(north)} m`;
    }
    function show(active, point, now) {
      visible = active;
      document.body.classList.toggle('first-person-view', active);
      if (!visible) return;
      lastX = point.x;
      lastZ = point.z;
      lastFrameMs = now;
      distanceM = elapsedMs = 0;
      write(speed, '0');
      locate(point);
      setConditions(conditions);
    }
    function updateMotion(point, now) {
      // Only horizontal travel contributes to ground speed, including while riding waves.
      const step = Math.hypot(point.x - lastX, point.z - lastZ);
      if (step > 0) {
        distanceM += step;
        elapsedMs += Math.max(0, now - lastFrameMs);
        if (elapsedMs >= 120) {
          write(speed, String(Math.round(3600 * distanceM / elapsedMs)));
          distanceM = elapsedMs = 0;
        }
      } else {
        distanceM = elapsedMs = 0;
        write(speed, '0');
      }
      lastFrameMs = now;
      lastX = point.x;
      lastZ = point.z;
      locate(point);
    }
    return { show, setConditions, updateMotion };
  }
  global.NotoFirstPerson = { create, createDashboard };
})(window);
