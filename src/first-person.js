/* Surface-following camera for travel over the displayed terrain and sea. */
(function registerFirstPerson(global) {
  'use strict';

  // Illustrative drivetrain and resistance coefficients for land travel and marine propulsion.
  const massKg = 7800, gravity = 9.81;
  const road = { powerW: 210000, tractionN: 27000, rolling: 0.025, linearDrag: 0, quadraticDrag: 3.8 };
  const sea = { powerW: 135000, tractionN: 15200, rolling: 0.004, linearDrag: 160, quadraticDrag: 54 };

  function create({ THREE, camera, controls, canvas, metadata, sampleLand, shore, water, verticalScale = () => 1, changed }) {
    const eyeHeight = 1.8;
    // Stay inside the last renderable DEM cell, including at the positive map edges.
    const halfWidth = metadata.width_m / 2, halfDepth = metadata.height_m / 2;
    const inset = Math.min(metadata.source_spacing_m[0] / 2, halfWidth / 2, halfDepth / 2);
    const savedEye = new THREE.Vector3(), savedTarget = new THREE.Vector3();
    let active = false, onWater = false, yaw = 0, lookYaw = 0, pitch = 0;
    let velocity = 0, reverseDelay = 0;
    let drag = null;

    function aim() {
      const horizontal = 24 * Math.cos(pitch);
      const bearing = yaw + lookYaw;
      controls.target.set(camera.position.x + Math.sin(bearing) * horizontal,
        camera.position.y + 24 * Math.sin(pitch), camera.position.z - Math.cos(bearing) * horizontal);
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
      lookYaw = 0;
      pitch = 0;
      park();
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
      park();
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
    function park() {
      velocity = 0;
      reverseDelay = 0;
    }
    function roadGrade(east, south) {
      if (onWater) return 0;
      // A four-metre wheelbase samples slope along the vehicle, in physical DEM metres.
      const { x, z, y } = camera.position;
      const front = sampleLand(x + 2 * east, z + 2 * south);
      const rear = sampleLand(x - 2 * east, z - 2 * south);
      if (front === null && rear === null) return 0;
      const span = front === null || rear === null ? 2 : 4;
      return ((front ?? (y - eyeHeight)) - (rear ?? (y - eyeHeight))) / (span * verticalScale());
    }
    function driveStep(input, brake, dt) {
      if (reverseDelay > 0) {
        reverseDelay = Math.max(0, reverseDelay - dt);
        return;
      }
      if (velocity === 0 && (!input || brake)) return;
      const east = Math.sin(yaw), south = -Math.cos(yaw);
      const grade = roadGrade(east, south);
      const cosSlope = 1 / Math.hypot(1, grade);
      const normalLoad = massKg * gravity * cosSlope;
      const profile = onWater ? sea : road;
      const speed = Math.abs(velocity);
      const braking = brake || input * velocity < 0;
      const gripN = onWater ? profile.tractionN : 0.65 * normalLoad;
      const thrustN = braking ? 0 : input * Math.min(profile.tractionN, gripN, profile.powerW / Math.max(speed, 0.1));
      const brakeN = braking ? (onWater ? 19500 : Math.min(52000, gripN)) : 0;
      const resistanceN = profile.rolling * normalLoad + profile.linearDrag * speed + profile.quadraticDrag * speed * speed;
      const direction = Math.sign(velocity) || input;
      const netN = thrustN - normalLoad * grade - direction * (resistanceN + brakeN);
      let next = THREE.MathUtils.clamp(velocity + netN / massKg * dt, -7, 160 / 3.6);
      if (velocity === 0 && next * input <= 0) next = 0; // Hill hold if drive force cannot start the climb.
      if (velocity * next <= 0 && velocity !== 0) {
        next = 0;
        if (braking && input) reverseDelay = 0.3;
      }
      const distance = 0.5 * (velocity + next) * dt * cosSlope;
      velocity = next;
      if (!distance) return;
      const x = camera.position.x + east * distance, z = camera.position.z + south * distance;
      if (!follow(x, z) || camera.position.x !== x || camera.position.z !== z) park();
    }
    function move(actions, dt) {
      if (!active || !Number.isFinite(dt) || dt <= 0) return;
      const forward = actions.has('forward'), back = actions.has('back');
      const input = Number(forward) - Number(back);
      const brake = actions.has('brake') || (forward && back);
      const left = actions.has('left') || actions.has('turnLeft');
      const right = actions.has('right') || actions.has('turnRight');
      const turn = Number(right) - Number(left);
      const wasMoving = velocity !== 0;
      // Bound each integration step so steering and shore crossings behave consistently at low frame rates.
      const steps = Math.ceil(dt / 0.025), step = dt / steps;
      for (let i = 0; i < steps; i++) {
        yaw += turn * step / (1 + Math.abs(velocity) / 18);
        driveStep(input, brake, step);
      }
      if (turn) aim();
      if (turn || wasMoving || velocity !== 0) changed();
    }
    canvas.addEventListener('pointerdown', event => {
      if (!active || drag || event.button !== 0 || !event.isPrimary) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointermove', event => {
      if (event.pointerId !== drag?.id) return;
      lookYaw += (event.clientX - drag.x) * 0.004;
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
      get needsMotion() { return velocity !== 0 || reverseDelay > 0; },
      get speedMps() { return Math.abs(velocity); },
      get heading() { return yaw * 180 / Math.PI; },
      enter, exit, move, park, cancelDrag,
      refresh: () => follow(camera.position.x, camera.position.z),
      followWaves() {
        if (!onWater) return;
        camera.position.y = water.sample(camera.position.x, camera.position.z)[1] + eyeHeight;
        aim();
      }
    };
  }
  function createDashboard(metadata) {
    const cluster = document.querySelector('#first-person-hud');
    const speed = document.querySelector('#fp-speed');
    const heading = document.querySelector('#fp-heading');
    const date = document.querySelector('#fp-date');
    const time = document.querySelector('#fp-time');
    const position = document.querySelector('#fp-position');
    const weather = document.querySelector('#fp-weather');
    const metres = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    position.title = metadata.crs || metadata.sourceDatum || 'Projected easting and northing in metres';
    let visible = false, conditions;
    const bearings = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    let lastEast, lastNorth, lastSpeedAngle, lastHeadingAngle;

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
      position.textContent = `E ${metres.format(east)} m\nN ${metres.format(north)} m`;
    }
    function show(active, point, headingDegrees) {
      visible = active;
      document.body.classList.toggle('first-person-view', active);
      if (!visible) return;
      updateMotion(point, 0, headingDegrees);
      setConditions(conditions);
    }
    function updateMotion(point, speedMps, headingDegrees) {
      const kmh = speedMps * 3.6;
      write(speed, String(Math.round(kmh)));
      const speedAngle = Math.round((-135 + Math.min(kmh, 160) * 270 / 160) * 10) / 10;
      if (speedAngle !== lastSpeedAngle) {
        cluster.style.setProperty('--speed-angle', speedAngle + 'deg');
        lastSpeedAngle = speedAngle;
      }
      const bearing = ((Math.round(headingDegrees) % 360) + 360) % 360;
      if (bearing !== lastHeadingAngle) {
        cluster.style.setProperty('--heading-angle', bearing + 'deg');
        write(heading, String(bearing).padStart(3, '0') + '° ' + bearings[Math.round(bearing / 45) % 8]);
        lastHeadingAngle = bearing;
      }
      locate(point);
    }
    return { show, setConditions, updateMotion };
  }
  global.NotoFirstPerson = { create, createDashboard };
})(window);
