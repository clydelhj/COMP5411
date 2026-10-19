// Build near/middle instance meshes while preserving original 4K glTF files.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const {
  MeshoptSimplifier: S
} = await import(pathToFileURL(path.join(root, 'vendor/meshopt/meshopt_simplifier.js')));
await S.ready;
const input = path.join(root, 'assets/vegetation/.build');
const models = JSON.parse(fs.readFileSync(path.join(input, 'models.json'), 'utf8'));
const array = (prefix, name, Type) => {
  const b = fs.readFileSync(path.join(input, `${prefix}-${name}.bin`));
  return new Type(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const pack = value => zlib.gzipSync(Buffer.from(value.buffer, value.byteOffset, value.byteLength), {
  level: 9,
  mtime: 0
}).toString('base64');
const stats = [];
function foliageComponents(indices, positions) {
  /*
   * Find connected leaf components from Uint32 indices and metric positions. Merge exactly
   * coincident vertices, union triangle connectivity and measure component areas. Return component
   * indices and statistics for whole-leaf sampling.
   */
  const vertices = positions.length / 3;
  const remap = S.generatePositionRemap(positions, 3);
  const parent = Uint32Array.from({
    length: vertices
  }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  function union(a, b) {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  }
  for (let i = 0; i < indices.length; i += 3) {
    union(remap[indices[i]], remap[indices[i + 1]]);
    union(remap[indices[i]], remap[indices[i + 2]]);
  }
  const roots = new Uint32Array(vertices),
    counts = new Uint32Array(vertices);
  for (let i = 0; i < vertices; i++) roots[i] = find(remap[i]);
  const triangles = new Uint32Array(indices.length / 3);
  for (let i = 0; i < triangles.length; i++) {
    triangles[i] = roots[indices[i * 3]];
    counts[triangles[i]]++;
  }
  console.log('Foliage components', counts.filter(v => v > 0).length, 'small triangles', counts.reduce((sum, count) => sum + (count <= 128 ? count : 0), 0));
  return {
    roots,
    counts,
    triangles
  };
}
function representativeFoliage(original, positions, components, budget, level, modelKey) {
  /*
   * Select spatially distributed whole leaf components using a stable hash and a target triangle
   * budget. Preserve source UVs/normals and expand retained small components about their centres to
   * maintain coverage. Keep trunks and major branches. Return Uint32 indices; foliage remains a
   * visual approximation.
   */
  const {
    roots,
    counts,
    triangles
  } = components;
  const total = counts.reduce((sum, count) => sum + (count <= 128 ? count : 0), 0);
  const fraction = Math.min(1, budget / Math.max(total, 1));
  const selected = new Uint8Array(counts.length);
  for (let i = 0; i < counts.length; i++) {
    const hash = (Math.imul(i ^ i >>> 13, 1274126177) >>> 0) / 4294967296;
    if (counts[i] > 0 && counts[i] <= 128 && hash < fraction) selected[i] = 1;
  }
  const small = [],
    large = [];
  for (let i = 0; i < triangles.length; i++) {
    const id = triangles[i];
    if (counts[id] > 128) large.push(original[i * 3], original[i * 3 + 1], original[i * 3 + 2]);else if (selected[id]) small.push(original[i * 3], original[i * 3 + 1], original[i * 3 + 2]);
  }
  // Apply mesh-error simplification to connected trunks and branches; retain whole leaf components to preserve silhouettes and texture coordinates.
  let skeleton = new Uint32Array(large);
  if (skeleton.length > 6000) skeleton = S.simplify(skeleton, positions, 3, 6000, 0.012)[0];
  const centers = new Map();
  for (let i = 0; i < roots.length; i++) if (selected[roots[i]]) {
    const value = centers.get(roots[i]) ?? [0, 0, 0, 0];
    value[0] += positions[i * 3];
    value[1] += positions[i * 3 + 1];
    value[2] += positions[i * 3 + 2];
    value[3]++;
    centers.set(roots[i], value);
  }
  // Expanded fine leaves are a visualization approximation, not measured leaf dimensions.
  const expansion = modelKey === 'conifer' ? level === 'near' ? 4 : 7 : level === 'near' ? 2.5 : 5;
  for (let i = 0; i < roots.length; i++) if (selected[roots[i]]) {
    const value = centers.get(roots[i]);
    for (let j = 0; j < 3; j++) {
      const center = value[j] / value[3];
      positions[i * 3 + j] = center + (positions[i * 3 + j] - center) * expansion;
    }
  }
  return new Uint32Array([...skeleton, ...small]);
}
for (const model of models) {
  const parts = [];
  for (const part of model.parts) {
    const p = array(part.prefix, 'position', Float32Array),
      n = array(part.prefix, 'normal', Float32Array),
      uv = array(part.prefix, 'uv', Float32Array),
      original = array(part.prefix, 'index', Uint32Array);
    // Centre each prototype on its root, compensating for the source scene translation.
    const minimum = [Infinity, Infinity, Infinity],
      maximum = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let j = 0; j < 3; j++) {
      minimum[j] = Math.min(minimum[j], p[i + j]);
      maximum[j] = Math.max(maximum[j], p[i + j]);
    }
    const center = [(minimum[0] + maximum[0]) / 2, minimum[1], (minimum[2] + maximum[2]) / 2];
    // Use one root anchor for all parts of a tree so trunk and foliage remain aligned; grass and ferns follow the same rule.
    const origin = ['broadleaf', 'conifer'].includes(model.key) ? [(model.bounds[0][0] + model.bounds[1][0]) / 2, model.bounds[0][1], (model.bounds[0][2] + model.bounds[1][2]) / 2] : center;
    for (let i = 0; i < p.length; i += 3) for (let j = 0; j < 3; j++) p[i + j] -= origin[j];
    const levels = [];
    const foliageData = ['conifer', 'broadleaf'].includes(model.key) && model.materials[part.material].leaf ? foliageComponents(original, p) : null;
    for (const level of ['near', 'middle']) {
      let idx = original.slice(),
        positions = p.slice();
      const attributes = new Float32Array(p.length / 3 * 5);
      for (let i = 0; i < p.length / 3; i++) attributes.set([n[i * 3], n[i * 3 + 1], n[i * 3 + 2], uv[i * 2], uv[i * 2 + 1]], i * 5);
      const leaf = model.materials[part.material].leaf;
      const limit = (level === 'near' ? leaf ? 60000 : 9000 : leaf ? 5000 : 1500) * 3;
      let error = 0;
      if (foliageData) {
        error = null; // Whole-leaf selection uses no edge-collapse error threshold and cannot be reported as that error bound.
        idx = representativeFoliage(original, positions, foliageData, level === 'near' ? 60000 : 9000, level, model.key);
      } else if (idx.length > limit) {
        const result = S.simplifyWithUpdate(idx, positions, 3, attributes, 5, [.1, .1, .1, .35, .35], null, limit, level === 'near' ? .018 : .09, ['Permissive', 'Regularize']);
        idx = idx.slice(0, result[0]);
        error = result[1];
      }
      const used = [...new Set(idx)].sort((a, b) => a - b),
        remap = new Uint32Array(p.length / 3);
      const cp = new Float32Array(used.length * 3),
        cn = new Float32Array(cp.length),
        cu = new Float32Array(used.length * 2);
      used.forEach((old, i) => {
        remap[old] = i;
        cp.set(positions.subarray(old * 3, old * 3 + 3), i * 3);
        cn.set(attributes.subarray(old * 5, old * 5 + 3), i * 3);
        cu.set(attributes.subarray(old * 5 + 3, old * 5 + 5), i * 2);
      });
      for (let i = 0; i < idx.length; i++) idx[i] = remap[idx[i]];
      levels.push({
        level,
        vertices: used.length,
        triangles: idx.length / 3,
        position: pack(cp),
        normal: pack(cn),
        uv: pack(cu),
        index: pack(idx)
      });
      stats.push({
        model: model.key,
        variant: part.variant,
        material: part.material,
        level,
        sourceTriangles: part.triangles,
        triangles: idx.length / 3,
        relativeError: error,
        displayLeafLinearScale: foliageData ? model.key === 'conifer' ? level === 'near' ? 4 : 7 : level === 'near' ? 2.5 : 5 : 1,
        method: foliageData ? 'whole-foliage-components with display-area compensation' : 'attribute-aware edge collapse'
      });
      console.log(model.key, part.variant, part.material, level, part.triangles, '->', idx.length / 3);
    }
    parts.push({
      material: part.material,
      variant: part.variant,
      levels
    });
  }
  model.parts = parts;
}
const out = path.join(root, 'assets/vegetation/runtime');
fs.writeFileSync(path.join(out, 'vegetation-models.js'), '// Generated from Poly Haven CC0 models: gzip geometry with 2K color and 1K PBR textures.\nwindow.NOTO_VEGETATION_MODELS = ' + JSON.stringify(models) + ';\n');
fs.writeFileSync(path.join(out, 'model-lod-metadata.json'), JSON.stringify(stats, null, 2));
