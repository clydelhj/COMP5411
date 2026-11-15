/* Allocate GPU instance storage for actual populations, not the maximum display limit. */
(function registerInstanceBuffers(global) {
  'use strict';

  function create(THREE, geometry, material, limit) {
    const capacity = Math.min(256, limit);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Keep the color shader variant stable before the first population becomes visible.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    mesh.userData.notoInstanceGrowths = 0;
    return mesh;
  }

  function reserve(THREE, mesh, required, limit, extraAttributes = {}) {
    if (!Number.isInteger(required) || required < 0 || required > limit) throw new RangeError('Invalid instance population');
    const current = mesh.instanceMatrix.count;
    if (required <= current) return false;
    const capacity = Math.min(limit, Math.max(required, current * 2));
    // Three releases this mesh's instance VBOs and VAOs through its public dispose
    // event. The mesh, shared material and static prototype remain owned here.
    mesh.dispose();
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 16), 16).setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    if (Object.keys(extraAttributes).length) {
      // Grass owns this tiny prototype. Release replaced slope VBOs before replacing
      // attributes; the unchanged CPU positions/normals are retained and reuploaded.
      mesh.geometry.dispose();
      for (const [name, size] of Object.entries(extraAttributes)) {
        mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size).setUsage(THREE.DynamicDrawUsage));
      }
    }
    mesh.userData.notoInstanceGrowths++;
    return true;
  }

  global.NotoInstanceBuffers = { create, reserve };
})(typeof window !== 'undefined' ? window : globalThis);
