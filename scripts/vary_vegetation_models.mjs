// Preserve UVs/topology and generate fixed shape variants; all distance tiers share each variant's root anchor.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
const root = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const folder = path.join(root, 'assets/vegetation/runtime');
const filename = path.join(folder, 'vegetation-models.js');
const models = JSON.parse(fs.readFileSync(filename, 'utf8').split('window.NOTO_VEGETATION_MODELS = ')[1].trim().replace(/;$/, ''));
const metadataFile = path.join(folder, 'model-lod-metadata.json');
const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')).filter(entry => entry.variant === 0 || !['broadleaf', 'conifer'].includes(entry.model));
// SHAPES: bounded crown-width, height-dependent taper and slight-lean parameters (Object[]).
// wx: horizontal crown-width multiplier along X.
// wz: horizontal crown-width multiplier along Z.
// taper: crown-width factor varying with normalized height.
// bulge: sinusoidal expansion of the middle crown.
// leanX: top X displacement as a fraction of tree height; zero displacement at the root.
// leanZ: top Z displacement as a fraction of tree height; zero displacement at the root.
const SHAPES = [{
  name: 'source',
  wx: 1,
  wz: 1,
  taper: 0,
  bulge: 0,
  leanX: 0,
  leanZ: 0
}, {
  name: 'slender',
  wx: 0.82,
  wz: 0.9,
  taper: -0.1,
  bulge: 0.04,
  leanX: 0.015,
  leanZ: -0.01
}, {
  name: 'broad',
  wx: 1.12,
  wz: 1.06,
  taper: -0.04,
  bulge: 0.13,
  leanX: -0.02,
  leanZ: 0.012
}, {
  name: 'asymmetric',
  wx: 1.02,
  wz: 0.92,
  taper: 0.08,
  bulge: -0.04,
  leanX: 0.04,
  leanZ: 0.025
}];
function floats(value) {
  /*
   * Decompress a Base64 gzip channel into a Float32Array using only valid bytes, avoiding pooled
   * Buffer offsets and unused memory.
   */
  const bytes = gunzipSync(Buffer.from(value, 'base64'));
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
function pack(values) {
  /*
   * Compress the valid bytes of a Float32Array position/normal channel as Base64 gzip. Does not
   * include unrelated backing-buffer bytes.
   */
  return gzipSync(Buffer.from(values.buffer, values.byteOffset, values.byteLength), {
    level: 9
  }).toString('base64');
}
function deform(level, shape, height) {
  /*
   * Apply the same horizontal crown/lean transformation to each LOD. level contains positions,
   * normals, UVs and indices; shape gives parameters and height is metres. Preserve root/Y
   * coordinates, transform normals by the inverse-transpose Jacobian and retain UVs/indices. Return
   * a display variant, not a new scanned species.
   */
  const positions = floats(level.position),
    normals = floats(level.normal);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    const t = y / height,
      wave = Math.sin(Math.PI * t);
    const f = shape.wx * (1 + shape.taper * t + shape.bulge * wave);
    const g = shape.wz * (1 - shape.taper * t * 0.5 + shape.bulge * wave * 0.7);
    const df = shape.wx * (shape.taper + shape.bulge * Math.PI * Math.cos(Math.PI * t)) / height;
    const dg = shape.wz * (-shape.taper * 0.5 + shape.bulge * 0.7 * Math.PI * Math.cos(Math.PI * t)) / height;
    const nx = normals[i] / f,
      nz = normals[i + 2] / g;
    const ny = normals[i + 1] - (df * x + 2 * shape.leanX * t) * nx - (dg * z + 2 * shape.leanZ * t) * nz;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals.set([nx / length, ny / length, nz / length], i);
    positions[i] = f * x + shape.leanX * height * t * t;
    positions[i + 2] = g * z + shape.leanZ * height * t * t;
  }
  return {
    ...level,
    position: pack(positions),
    normal: pack(normals)
  };
}

// Load prototypes, generate four variants, and update bounds and traceable metadata.
for (const model of models) {
  if (!['broadleaf', 'conifer'].includes(model.key)) continue;
  const original = model.parts.filter(part => part.variant === 0);
  model.parts = original.slice();
  model.displayShapes = SHAPES;
  for (let variant = 1; variant < SHAPES.length; variant++) {
    for (const part of original) {
      model.parts.push({
        ...part,
        variant,
        levels: part.levels.map(level => deform(level, SHAPES[variant], model.height))
      });
    }
    for (const entry of metadata.filter(entry => entry.model === model.key && entry.variant === 0)) {
      metadata.push({
        ...entry,
        variant,
        relativeError: null,
        sourceLodRelativeError: entry.relativeError,
        method: entry.method + '; continuous display-shape transform',
        displayShape: SHAPES[variant].name
      });
    }
  }
}
fs.writeFileSync(filename, '// Generated from Poly Haven CC0 source geometry with display variants: gzip geometry and PBR textures.\nwindow.NOTO_VEGETATION_MODELS = ' + JSON.stringify(models) + ';\n');
fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
console.log('Generated four consistent crown shapes per tree type; UV and triangle counts retained.');
