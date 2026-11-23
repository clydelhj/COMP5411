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
      const side = Number(actions.has('right')) - Number(actions.has('left'));
      const turn = Number(actions.has('turnRight')) - Number(actions.has('turnLeft'));
      yaw += turn * dt;
      const length = Math.hypot(forward, side);
      if (length) {
        const step = speed * dt / length;
        const dx = (Math.sin(yaw) * forward + Math.cos(yaw) * side) * step;
        const dz = (-Math.cos(yaw) * forward + Math.sin(yaw) * side) * step;
        follow(camera.position.x + dx, camera.position.z + dz);
      }
      if (turn) aim();
      if (length || turn) changed();
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
  global.NotoFirstPerson = { create };
})(window);
