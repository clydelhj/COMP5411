/* Prepare new terrain GPU resources in small tasks before publishing a complete LOD replacement. */
(function registerTerrainUploadQueue(global) {
  'use strict';

  function create({ THREE, renderer, camera, paused = () => false,
    schedule = callback => requestAnimationFrame(() => setTimeout(callback, 0)),
    now = () => performance.now(), budgetMs = 4, maxJobs = 4 }) {
    const scene = new THREE.Scene();
    const placeholder = new THREE.BufferGeometry();
    placeholder.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(placeholder, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const owners = new WeakMap(), prepared = new WeakMap();
    const state = { pending: 0, completed: 0, cancelled: 0, batches: 0, lastMs: 0, maxMs: 0, maxJobMs: 0, error: null };
    let jobs = [], scheduled = false, disposed = false;

    function withTarget(action) {
      const previous = { target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
        viewport: renderer.getViewport(new THREE.Vector4()), scissor: renderer.getScissor(new THREE.Vector4()),
        scissorTest: renderer.getScissorTest(), autoClear: renderer.autoClear,
        shadowAuto: renderer.shadowMap.autoUpdate, shadowNeeds: renderer.shadowMap.needsUpdate };
      try {
        renderer.setRenderTarget(target);
        renderer.setScissorTest(false);
        renderer.autoClear = false;
        renderer.shadowMap.autoUpdate = false;
        renderer.shadowMap.needsUpdate = false;
        return action();
      } finally {
        renderer.setRenderTarget(previous.target, previous.face, previous.mip);
        renderer.setViewport(previous.viewport);
        renderer.setScissor(previous.scissor);
        renderer.setScissorTest(previous.scissorTest);
        renderer.autoClear = previous.autoClear;
        renderer.shadowMap.autoUpdate = previous.shadowAuto;
        renderer.shadowMap.needsUpdate = previous.shadowNeeds;
      }
    }
    function version(resource) {
      if (resource.isTexture) return resource.version;
      return [resource.index?.version ?? -1, ...Object.values(resource.attributes).map(attribute => attribute.version)].join(':');
    }
    function upload(resource) {
      if (resource.isTexture) {
        renderer.initTexture(resource);
        return;
      }
      // Three uploads every geometry attribute and its index before drawing. Limit
      // this preparation draw to one triangle; no full extra terrain pass is needed.
      const { start, count } = resource.drawRange;
      try {
        mesh.geometry = resource;
        resource.setDrawRange(start, Math.min(3, count));
        withTarget(() => renderer.render(scene, camera));
      } finally {
        resource.setDrawRange(start, count);
        mesh.geometry = placeholder;
      }
    }
    function request() {
      if (scheduled || disposed || !jobs.length || paused()) return;
      scheduled = true;
      schedule(pump);
    }
    function finish(job, success) {
      state.pending--;
      job.owner.pending.delete(job.resource);
      job.resolve(success);
    }
    function pump() {
      scheduled = false;
      if (disposed || paused()) return;
      if (renderer.getContext().isContextLost()) {
        state.error = 'WebGL context was lost during terrain upload';
        for (const job of jobs.splice(0)) finish(job, false);
        return;
      }
      const started = now();
      let count = 0;
      while (jobs.length && count < maxJobs && (count === 0 || now() - started < budgetMs)) {
        const job = jobs.shift(), jobStarted = now();
        try {
          upload(job.resource);
          prepared.set(job.resource, version(job.resource));
          state.completed++;
          finish(job, true);
        } catch (error) {
          state.error = error.message;
          finish(job, false);
        }
        state.maxJobMs = Math.max(state.maxJobMs, now() - jobStarted);
        count++;
      }
      state.lastMs = now() - started;
      state.maxMs = Math.max(state.maxMs, state.lastMs);
      state.batches++;
      request();
    }
    function prepare(item, resources) {
      if (disposed) return Promise.resolve(false);
      let owner = owners.get(item);
      if (!owner) owners.set(item, owner = { pending: new Map() });
      const promises = [];
      for (const resource of new Set(resources.filter(Boolean))) {
        const currentVersion = version(resource);
        if (prepared.get(resource) === currentVersion) continue;
        let job = owner.pending.get(resource);
        if (!job) {
          job = { owner, resource };
          job.promise = new Promise(resolve => { job.resolve = resolve; });
          owner.pending.set(resource, job);
          jobs.push(job); state.pending++;
        }
        promises.push(job.promise);
      }
      request();
      return Promise.all(promises).then(results => results.every(Boolean));
    }
    function cancel(item) {
      const owner = owners.get(item);
      if (!owner) return;
      jobs = jobs.filter(job => {
        if (job.owner !== owner) return true;
        state.cancelled++;
        finish(job, false);
        return false;
      });
      owners.delete(item);
    }
    return {
      // The one shared preparation shader is compiled during loading, before any queued draw.
      warmup: () => withTarget(() => renderer.compileAsync(scene, camera)),
      prepare, cancel, resume: request, getState: () => ({ ...state }),
      dispose() {
        disposed = true;
        for (const job of jobs.splice(0)) finish(job, false);
        placeholder.dispose(); material.dispose(); target.dispose();
      }
    };
  }
  global.NotoTerrainUploadQueue = { create };
})(typeof window !== 'undefined' ? window : globalThis);
