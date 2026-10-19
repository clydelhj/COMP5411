/* Continuous coast shared by every terrain LOD. Source DEM samples stay intact. */
(function registerCoastalGeometry(global) {
  'use strict';

  const BASE = -100;
  const MAX_EDGE = 8;
  const CONTOUR_ERROR = 0.03;
  const BEACH_WIDTH = 64;
  // Visual contact profile only: the original DEM is never edited. The inner
  // 16 m is flat so extra contour subdivision cannot open nonlinear-height seams;
  // 16–64 m transitions smoothly to the original displayed ground height.
  function contactHeight(height, distance) {
    if (distance <= -BEACH_WIDTH) return height;
    const u = Math.max(0, Math.min(1, (-distance - 16) / (BEACH_WIDTH - 16)));
    return Math.max(0, height) * u * u * (3 - 2 * u);
  }
  async function prepare(source) {
    if (!source?.coastalHeights) throw new Error('Missing continuous coastline data; reload the complete project');
    const decode = async text => {
      const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
      return new Uint16Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    };
    const [distances, heights] = await Promise.all([decode(source.distances), decode(source.coastalHeights)]);
    if (distances.length !== source.rows * source.cols || heights.length !== distances.length) throw new Error('Invalid continuous coastline field');
    function sample(values, x, z) {
      const u = Math.max(0, Math.min(source.cols - 1, (x + source.widthM / 2) / source.cellM - 0.5));
      const v = Math.max(0, Math.min(source.rows - 1, (z + source.heightM / 2) / source.cellM - 0.5));
      const c = Math.floor(u),
        r = Math.floor(v),
        tx = u - c,
        tz = v - r;
      const c1 = Math.min(c + 1, source.cols - 1),
        r1 = Math.min(r + 1, source.rows - 1);
      return (values[r * source.cols + c] * (1 - tx) + values[r * source.cols + c1] * tx) * (1 - tz) + (values[r1 * source.cols + c] * (1 - tx) + values[r1 * source.cols + c1] * tx) * tz;
    }
    const distance = (x, z) => (sample(distances, x, z) - 32768) / 8;
    const height = (x, z) => sample(heights, x, z) / 100 - 100;
    function touches(bounds, margin) {
      const index = (x, extent, count) => Math.max(0, Math.min(count - 1, Math.floor((x + extent / 2) / source.cellM - 0.5)));
      const c0 = index(bounds.minX, source.widthM, source.cols),
        c1 = Math.min(source.cols - 1, index(bounds.maxX, source.widthM, source.cols) + 1);
      const r0 = index(bounds.minZ, source.heightM, source.rows),
        r1 = Math.min(source.rows - 1, index(bounds.maxZ, source.heightM, source.rows) + 1);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        if (Math.abs(distances[r * source.cols + c] - 32768) / 8 < margin + source.cellM * 2) return true;
      }
      return false;
    }
    return {
      distance,
      height,
      touches,
      distances,
      source
    };
  }
  function build(THREE, options) {
    const {
      field,
      axes,
      globalSize,
      nodeHeights,
      nodeValid,
      masks,
      bounds
    } = options;
    if (!field) return null;
    // Mixed ocean tiles also use the shared display contour when isolated DEM
    // samples are smaller than its spatial resolution. Never revive a separate
    // square coastline from the original cell mask at a finer terrain LOD.
    const mixedOcean = masks.land.some(Boolean) && masks.water.some(Boolean);
    if (!field.touches(bounds, axes.step * 2 + 80) && !mixedOcean) return null;
    const rows = axes.rowsAxis.length,
      cols = axes.colsAxis.length;
    const xs = Array.from(axes.colsAxis, c => c * globalSize.dx - globalSize.width / 2);
    const zs = Array.from(axes.rowsAxis, r => r * globalSize.dz - globalSize.height / 2);
    // Only displayed extensions of missing coastal samples are filled. The raw
    // uint16 DEM and the source TIFF remain unchanged.
    const heights = nodeHeights.slice();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (!nodeValid[k]) heights[k] = field.height(xs[c], zs[r]);
      if (Math.abs(field.distance(xs[c], zs[r])) < axes.step * 2 + 32) heights[k] = Math.max(0.02, heights[k]);
    }
    const landCells = new Uint8Array(masks.land.length);
    const pieces = [newBuilder(), newBuilder()];
    const wallBuilders = [newBuilder(), newBuilder()];
    const coastSegments = [];
    const shoreQueryRanges = new Uint32Array(masks.land.length * 2);
    let cell = 0;
    function newBuilder() {
      return {
        positions: [],
        indices: [],
        vertices: new Map()
      };
    }
    // Canonical X/Z order gives both owners exactly the same intersection, even
    // when the adjacent triangle visits its edge in the opposite direction.
    function crossing(a, b) {
      if (a[0] > b[0] || a[0] === b[0] && a[2] > b[2]) [a, b] = [b, a];
      if (Math.abs(a[3]) < 1e-10) return a;
      if (Math.abs(b[3]) < 1e-10) return b;
      let lo = 0,
        hi = 1;
      for (let i = 0; i < 22; i++) {
        const t = (lo + hi) / 2;
        const d = field.distance(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t);
        if (d < 0 === a[3] < 0) lo = t;else hi = t;
      }
      const t = (lo + hi) / 2;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 0];
    }
    function clip(points, sea) {
      const output = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i],
          b = points[(i + 1) % points.length];
        const ai = sea ? a[3] >= 0 : a[3] <= 0,
          bi = sea ? b[3] >= 0 : b[3] <= 0;
        if (ai) output.push(a);
        if (ai !== bi) output.push(crossing(a, b));
      }
      return output;
    }
    function vertex(builder, p, sea) {
      const key = `${p[0].toFixed(6)},${p[2].toFixed(6)}`;
      let id = builder.vertices.get(key);
      if (id === undefined) {
        id = builder.positions.length / 3;
        builder.vertices.set(key, id);
        builder.positions.push(p[0], sea ? 0 : contactHeight(p[1], p[3]), p[2]);
      }
      return id;
    }
    function addWall(a, b, lowerA, lowerB, water = false) {
      const {
        positions: wallPositions,
        indices: wallIndices,
        vertices: wallMap
      } = wallBuilders[water ? 1 : 0];
      const points = [[a[0], water ? 0 : contactHeight(a[1], a[3]), a[2]], [b[0], water ? 0 : contactHeight(b[1], b[3]), b[2]], [b[0], lowerB, b[2]], [a[0], lowerA, a[2]]];
      const ids = points.map(p => {
        const key = p.map(v => v.toFixed(6)).join(',');
        let id = wallMap.get(key);
        if (id === undefined) {
          id = wallPositions.length / 3;
          wallMap.set(key, id);
          wallPositions.push(...p);
        }
        return id;
      });
      wallIndices.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
    function modelEdge(a, b) {
      return Math.abs(a[0] + globalSize.width / 2) < 1e-6 && Math.abs(b[0] + globalSize.width / 2) < 1e-6 || Math.abs(a[0] - globalSize.width / 2) < 1e-6 && Math.abs(b[0] - globalSize.width / 2) < 1e-6 || Math.abs(a[2] + globalSize.height / 2) < 1e-6 && Math.abs(b[2] + globalSize.height / 2) < 1e-6 || Math.abs(a[2] - globalSize.height / 2) < 1e-6 && Math.abs(b[2] - globalSize.height / 2) < 1e-6;
    }
    function emit(poly, sea, clipped) {
      if (poly.length < 3) return;
      const builder = pieces[sea ? 1 : 0];
      const ids = poly.map(p => vertex(builder, p, sea));
      for (let i = 1; i + 1 < ids.length; i++) {
        const a = poly[0],
          b = poly[i],
          c = poly[i + 1];
        if (Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0])) < 1e-10) continue;
        builder.indices.push(ids[0], ids[i], ids[i + 1]);
        if (!sea) landCells[cell] = 1;
      }
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i],
          b = poly[(i + 1) % poly.length];
        if (clipped && !sea && a[3] === 0 && b[3] === 0 && Math.hypot(a[0] - b[0], a[2] - b[2]) > 1e-6) {
          // The contact profile meets sea level, so no vertical coastal cap is needed.
          coastSegments.push(a[0], a[2], b[0], b[2]);
        } else if (modelEdge(a, b)) {
          addWall(a, b, BASE, BASE, sea);
        } else {
          // Preserve exposed walls around enclosed NoData holes. Internal tile
          // edges are never capped; the neighbouring tile supplies the surface.
          const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
          if (len < 1e-9) continue;
          const x = (a[0] + b[0]) / 2 - (b[2] - a[2]) / len * 0.001;
          const z = (a[2] + b[2]) / 2 + (b[0] - a[0]) / len * 0.001;
          if (x <= xs[0] || x >= xs[cols - 1] || z <= zs[0] || z >= zs[rows - 1]) continue;
          const c = Math.min(cols - 2, Math.floor((x - xs[0]) / (axes.step * globalSize.dx)));
          const r = Math.min(rows - 2, Math.floor((z - zs[0]) / (axes.step * globalSize.dz)));
          const neighbor = r * (cols - 1) + c;
          if (neighbor !== cell && !masks.land[neighbor] && !masks.water[neighbor] && field.distance(x, z) < 0) addWall(a, b, BASE, BASE, sea);
        }
      }
    }
    function mid(a, b) {
      const x = (a[0] + b[0]) / 2,
        z = (a[2] + b[2]) / 2;
      return [x, (a[1] + b[1]) / 2, z, field.distance(x, z)];
    }
    function triangle(a, b, c) {
      const edge = Math.max(Math.hypot(a[0] - b[0], a[2] - b[2]), Math.hypot(b[0] - c[0], b[2] - c[2]), Math.hypot(c[0] - a[0], c[2] - a[2]));
      const center = field.distance((a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3);
      const mixed = Math.min(a[3], b[3], c[3]) < 0 && Math.max(a[3], b[3], c[3]) > 0;
      // Refine a narrow band only. The bound also detects islands whose contour
      // passes through a coarse triangle without touching its three vertices.
      let landPolygon, seaPolygon;
      // Keep a narrow, fine surf/contact band even when the terrain uses
      // 32–128 m base cells. Only this strip needs short geometric wave crests.
      const bandEdge = MAX_EDGE;
      let refine = edge > bandEdge && (mixed || Math.abs(center) < 72 + edge * 0.75);
      if (!refine && (mixed || [a, b, c].filter(p => p[3] === 0).length === 2)) {
        landPolygon = clip([a, b, c], false);
        seaPolygon = clip([a, b, c], true);
        const ends = landPolygon.filter((p, i, points) => p[3] === 0 && points.findIndex(q => q[0] === p[0] && q[2] === p[2]) === i);
        if (ends.length === 2 && edge > 0.5) {
          refine = [0.25, 0.5, 0.75].some(t => Math.abs(field.distance(ends[0][0] * (1 - t) + ends[1][0] * t, ends[0][2] * (1 - t) + ends[1][2] * t)) > CONTOUR_ERROR);
        }
      } else if (!refine && edge > 2 && Math.abs(center) < edge * 0.75 + 0.25) {
        refine = true;
      }
      if (refine) {
        const ab = mid(a, b),
          bc = mid(b, c),
          ca = mid(c, a);
        triangle(a, ab, ca);
        triangle(ab, b, bc);
        triangle(ca, bc, c);
        triangle(ab, bc, ca);
      } else if (mixed) {
        emit(landPolygon, false, true);
        emit(seaPolygon, true, true);
      } else {
        emit([a, b, c], center > 0, true);
      }
    }
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
      cell = r * (cols - 1) + c;
      const center = field.distance((xs[c] + xs[c + 1]) / 2, (zs[r] + zs[r + 1]) / 2);
      const near = Math.abs(center) < Math.hypot(xs[c + 1] - xs[c], zs[r + 1] - zs[r]) + 80;
      if (!masks.land[cell] && !masks.water[cell] && (!near || center < 0)) continue;
      shoreQueryRanges[cell * 2] = pieces[0].indices.length;
      const point = (rr, cc) => [xs[cc], heights[rr * cols + cc], zs[rr], field.distance(xs[cc], zs[rr])];
      const a = point(r, c),
        b = point(r + 1, c),
        d = point(r, c + 1),
        e = point(r + 1, c + 1);
      if (near) {
        triangle(a, b, d);
        triangle(d, b, e);
      } else {
        emit([a, b, d], center > 0, false);
        emit([d, b, e], center > 0, false);
      }
      shoreQueryRanges[cell * 2 + 1] = pieces[0].indices.length;
    }
    function geometry(positions, indices) {
      if (!indices.length) return null;
      return global.NotoVolume.makeGeometry(THREE, Float32Array.from(positions), Uint32Array.from(indices));
    }
    function finish(builder) {
      if (!builder.indices.length) return null;
      const top = geometry(builder.positions, builder.indices);
      top.userData.notoBoundaryBounds = bounds;
      const bottom = builder.positions.slice();
      for (let i = 1; i < bottom.length; i += 3) bottom[i] = BASE;
      const indices = builder.indices.slice();
      for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      return {
        top,
        walls: null,
        bottom: geometry(bottom, indices)
      };
    }
    const land = finish(pieces[0]),
      water = finish(pieces[1]);
    // Outer crop walls use the existing cut materials. Water displacement is
    // zero here; the sea-level shoreline itself needs no vertical wall.
    if (land) land.walls = geometry(wallBuilders[0].positions, wallBuilders[0].indices);
    if (water) water.walls = geometry(wallBuilders[1].positions, wallBuilders[1].indices);
    // Plants follow the displayed triangles. Collision uses their highest corner
    // near shore, and the original four-corner ceiling farther inland.
    const sampleHeight = (x, z, conservative = false) => {
      const c = Math.max(0, Math.min(cols - 2, Math.floor((x - xs[0]) / (axes.step * globalSize.dx))));
      const r = Math.max(0, Math.min(rows - 2, Math.floor((z - zs[0]) / (axes.step * globalSize.dz))));
      if (!landCells[r * (cols - 1) + c] || field.distance(x, z) > 0) return null;
      // In the curved contact strip, query the actual subdivided triangles.
      // The range is local to one original cell, so no whole-mesh raycast runs.
      if (field.distance(x, z) > -BEACH_WIDTH - axes.step * 2 && land) {
        const start = shoreQueryRanges[(r * (cols - 1) + c) * 2];
        const end = shoreQueryRanges[(r * (cols - 1) + c) * 2 + 1];
        const positions = land.top.attributes.position.array;
        const indices = land.top.index.array;
        for (let i = start; i < end; i += 3) {
          const a = indices[i] * 3,
            b = indices[i + 1] * 3,
            q = indices[i + 2] * 3;
          const ax = positions[a],
            az = positions[a + 2];
          const bx = positions[b] - ax,
            bz = positions[b + 2] - az;
          const cx = positions[q] - ax,
            cz = positions[q + 2] - az;
          const determinant = bx * cz - bz * cx;
          if (Math.abs(determinant) < 1e-10) continue;
          const u = ((x - ax) * cz - (z - az) * cx) / determinant;
          const v = (bx * (z - az) - bz * (x - ax)) / determinant;
          if (u >= -1e-5 && v >= -1e-5 && u + v <= 1.00001) {
            if (conservative) return Math.max(positions[a + 1], positions[b + 1], positions[q + 1]);
            return positions[a + 1] * (1 - u - v) + positions[b + 1] * u + positions[q + 1] * v;
          }
        }
        return null;
      }
      const u = (x - xs[c]) / (xs[c + 1] - xs[c]),
        v = (z - zs[r]) / (zs[r + 1] - zs[r]);
      const k = r * cols + c;
      if (conservative) return Math.max(heights[k], heights[k + 1], heights[k + cols], heights[k + cols + 1]);
      return u + v <= 1 ? heights[k] * (1 - u - v) + heights[k + 1] * u + heights[k + cols] * v : heights[k + 1] * (1 - v) + heights[k + cols] * (1 - u) + heights[k + cols + 1] * (u + v - 1);
    };
    return {
      land,
      water,
      heights,
      landCells,
      sampleHeight,
      shoreQueryRanges,
      coastSegments: Float32Array.from(coastSegments)
    };
  }
  global.NotoCoastalGeometry = {
    prepare,
    contactHeight,
    build
  };
})(window);
