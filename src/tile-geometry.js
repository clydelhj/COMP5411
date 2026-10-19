/*
 * Native-resolution tile geometry. Raster indices map to global metric X/Z coordinates. This module
 * classifies land/water, samples edges and groups surfaces; NotoVolume closes the meshes.
 */
(function registerNotoTileGeometry(global) {
  'use strict';

  // BASE_ELEVATION: physical model-base elevation, in metres.
  const BASE_ELEVATION = -100;
  // NODATA: missing-data sentinel in the quantized Uint16 array, not an elevation.
  const NODATA = 65535;
  // HEIGHT_QUANTUM: quantization steps per metre; decode as value / 100 - 100.
  const HEIGHT_QUANTUM = 100;
  // Cache classifications of original nodes only. WeakMap entries can be released with their height arrays.
  const surfaceOwnershipCache = new WeakMap();
  function finiteNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }
  function integer(value, fallback) {
    const result = Math.floor(Number(value));
    return Number.isFinite(result) ? result : fallback;
  }
  function tileKey(tile) {
    return String(tile && tile.key !== undefined ? tile.key : '');
  }
  function levelOf(tile) {
    return finiteNumber(tile && tile.level, 0);
  }
  function globalMetadata(tileset) {
    /*
     * Validate global bounds and native spacing from tileset.metadata. Require positive dimensions
     * and X/Z spacing. Return metric extents, spacing and source raster dimensions.
     */

    const metadata = tileset && tileset.metadata || {};
    const dx = finiteNumber(metadata.source_spacing_m && metadata.source_spacing_m[0], 0);
    const dz = finiteNumber(metadata.source_spacing_m && metadata.source_spacing_m[1], 0);
    const width = finiteNumber(metadata.width_m, 0);
    const height = finiteNumber(metadata.height_m, 0);
    if (!(dx > 0 && dz > 0 && width > 0 && height > 0)) {
      throw new Error('Native tile geometry requires positive source spacing and extent');
    }
    return {
      width,
      height,
      dx,
      dz,
      sourceWidth: integer(metadata.source_width, 0),
      sourceHeight: integer(metadata.source_height, 0)
    };
  }
  function tileGridSize(tile, heights) {
    /*
     * Validate row-major node heights against tile.rows and tile.cols. Require at least two nodes
     * per axis and exactly rows*cols values. Return validated dimensions.
     */

    const rows = Math.max(2, integer(tile && tile.rows, 0));
    const cols = Math.max(2, integer(tile && tile.cols, 0));
    if (rows < 2 || cols < 2 || !heights || heights.length !== rows * cols) {
      throw new Error(`Tile height array mismatch for ${tileKey(tile) || 'unnamed tile'}`);
    }
    return {
      rows,
      cols
    };
  }
  function axesFor(tile, rows, cols) {
    /*
     * Construct native row/column axes from tile bounds and pixel step. Clamp the final interval
     * and force the last nodes to r1/c1. Return bounds, step and Int32Array axes in pixel indices,
     * not metres.
     */

    const r0 = integer(tile.r0, 0);
    const c0 = integer(tile.c0, 0);
    const r1 = integer(tile.r1, r0);
    const c1 = integer(tile.c1, c0);
    const step = Math.max(1, integer(tile.step, 1));
    if (!(r1 > r0 && c1 > c0)) throw new Error(`Invalid native tile extent for ${tileKey(tile)}`);
    const rowsAxis = new Int32Array(rows);
    const colsAxis = new Int32Array(cols);
    for (let i = 0; i < rows; i++) rowsAxis[i] = Math.min(r0 + i * step, r1);
    for (let i = 0; i < cols; i++) colsAxis[i] = Math.min(c0 + i * step, c1);
    // The descriptor includes a shortened last interval where needed.
    rowsAxis[rows - 1] = r1;
    colsAxis[cols - 1] = c1;
    return {
      r0,
      c0,
      r1,
      c1,
      step,
      rowsAxis,
      colsAxis
    };
  }
  function nativeCellCenter(axis, index) {
    return Math.floor((axis[index] + axis[index + 1]) * 0.5);
  }
  function rawHeight(raw) {
    /*
     * Decode a quantized height to metres using HEIGHT_QUANTUM and BASE_ELEVATION. Return null for
     * the 65535 NoData sentinel.
     */

    return Number(raw) === NODATA ? null : Number(raw) / HEIGHT_QUANTUM + BASE_ELEVATION;
  }
  function rawIsValid(raw) {
    /* Return whether a quantized value is finite and differs from the NoData sentinel. */

    return Number(raw) !== NODATA && Number.isFinite(Number(raw));
  }
  function rawAt(heights, index) {
    /* Safely read a row-major quantized height by flat index. Convert nonfinite values to NODATA. */

    const value = Number(heights[index]);
    return Number.isFinite(value) ? value : NODATA;
  }
  function cellIndex(row, col, cols) {
    return row * (cols - 1) + col;
  }
  function nodeIndex(row, col, cols) {
    return row * cols + col;
  }
  function isBoundaryCell(row, col, rows, cols) {
    return row === 0 || col === 0 || row === rows - 2 || col === cols - 2;
  }

  /*
   * A boundaryForcedSea value has appeared in both scalar and cell-mask
   * forms in the tile builders.  Supporting both keeps the geometry contract
   * explicit while retaining a false default for ordinary tiles.
   */
  function forcedSeaAt(tile, row, col, rows, cols) {
    /*
     * Read tile.boundaryForcedSea or tile.forceSea as a callback, scalar or cell mask. A true
     * scalar applies only to boundary cells. Return whether the specified cell is explicitly sea.
     */

    const value = tile && (tile.boundaryForcedSea ?? tile.forceSea);
    if (!value) return false;
    if (typeof value === 'function') return Boolean(value(row, col, tile));
    if (value === true) return isBoundaryCell(row, col, rows, cols);
    const mask = value.cells || value.mask || value;
    if (typeof mask.length === 'number') {
      const index = cellIndex(row, col, cols);
      return Boolean(mask[index]);
    }
    return false;
  }
  function callOcean(oceanAt, row, col) {
    return typeof oceanAt === 'function' && Boolean(oceanAt(row, col));
  }
  function cellOcean(oceanAt, axes, row, col, tile) {
    /*
     * Query shared cell ownership. Prefer oceanAt.cellOcean when available; otherwise query the
     * native-coordinate cell centre. Return a boolean.
     */

    if (typeof oceanAt?.cellOcean === 'function') return oceanAt.cellOcean(tile, row, col);
    return callOcean(oceanAt, nativeCellCenter(axes.rowsAxis, row), nativeCellCenter(axes.colsAxis, col));
  }
  function oceanIntersectsCell(oceanAt, maskStep, axes, row, col) {
    /*
     * Check the complete closed cell footprint for confirmed sea. Test the centre, then every
     * intersecting ocean-mask cell using maskStep in native pixels. Without a known mask step, also
     * test corners. Return false until sea is confirmed.
     */

    if (callOcean(oceanAt, nativeCellCenter(axes.rowsAxis, row), nativeCellCenter(axes.colsAxis, col))) return true;
    const r0 = axes.rowsAxis[row],
      r1 = axes.rowsAxis[row + 1];
    const c0 = axes.colsAxis[col],
      c1 = axes.colsAxis[col + 1];
    if (maskStep > 0) {
      for (let r = Math.floor(r0 / maskStep); r <= Math.floor(r1 / maskStep); r++) {
        for (let c = Math.floor(c0 / maskStep); c <= Math.floor(c1 / maskStep); c++) {
          if (callOcean(oceanAt, r * maskStep, c * maskStep)) return true;
        }
      }
      return false;
    }
    return callOcean(oceanAt, r0, c0) || callOcean(oceanAt, r0, c1) || callOcean(oceanAt, r1, c0) || callOcean(oceanAt, r1, c1);
  }
  function floodMissingCells(owners, rows, cols) {
    /*
     * Flood unresolved cells from four-connected sea within a tile. owners is a row-major
     * Uint8Array: 0 unknown, 1 land, 2 sea. Never cross valid land; enclosed unknown regions
     * without a sea seed remain zero. Updates owners in place.
     */

    const queue = [];
    const neighbors = index => {
      /* Return the four neighboring flat cell indices without wrapping across rows. Use -1 outside the grid. */

      const row = Math.floor(index / cols),
        col = index % cols;
      return [row > 0 ? index - cols : -1, row < rows - 1 ? index + cols : -1, col > 0 ? index - 1 : -1, col < cols - 1 ? index + 1 : -1];
    };
    for (let i = 0; i < owners.length; i++) {
      if (owners[i] === 0 && neighbors(i).some(n => n >= 0 && owners[n] === 2)) {
        owners[i] = 2;
        queue.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      for (const next of neighbors(queue[head])) {
        if (next >= 0 && owners[next] === 0) {
          owners[next] = 2;
          queue.push(next);
        }
      }
    }
  }
  function rawSurfaceOwnership(tile, heights, oceanAt, maskStep, cache) {
    /*
     * Classify original DEM cells without changing elevations. Four valid corners mean land; ocean
     * coverage or explicit flags seed water in remaining cells. Flood connected missing cells and
     * retain unresolved indices. Cache ordinary tiles by their height array; custom sea rules are
     * reclassified. Return axes, dimensions, owners and unresolved indices.
     */

    const {
      rows,
      cols
    } = tileGridSize(tile, heights);
    const signature = [tile.r0, tile.c0, tile.r1, tile.c1, tile.step, rows, cols, maskStep].join('/');
    const cacheable = !tile.boundaryForcedSea && !tile.forceSea;
    const cached = cache.get(heights);
    if (cacheable && cached?.signature === signature) return cached;
    const axes = axesFor(tile, rows, cols);
    const owners = new Uint8Array((rows - 1) * (cols - 1));
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const a = nodeIndex(row, col, cols);
        const allValid = [a, a + 1, a + cols, a + cols + 1].every(i => rawIsValid(rawAt(heights, i)));
        owners[cellIndex(row, col, cols)] = allValid ? 1 : oceanIntersectsCell(oceanAt, maskStep, axes, row, col) || forcedSeaAt(tile, row, col, rows, cols) ? 2 : 0;
      }
    }
    floodMissingCells(owners, rows - 1, cols - 1);
    const unresolved = [];
    for (let i = 0; i < owners.length; i++) if (!owners[i]) unresolved.push(i);
    const result = {
      signature,
      axes,
      rows,
      cols,
      owners,
      unresolved
    };
    if (cacheable) cache.set(heights, result);
    return result;
  }
  function resolveOceanOwnership(tileset, tile, heights, selected, oceanAt) {
    /*
     * Create a consistent ocean query for one build, resolving missing regions across loaded
     * same-level neighbors. Reuse local classifications, copy unresolved masks, and flood from
     * confirmed neighboring sea. Ordinary tile edges are not sea seeds. Return a native point
     * callback with cellOcean(tile,row,col).
     */

    let cache = typeof oceanAt === 'function' ? surfaceOwnershipCache.get(oceanAt) : null;
    if (!cache) {
      cache = new WeakMap();
      if (typeof oceanAt === 'function') surfaceOwnershipCache.set(oceanAt, cache);
    }
    const keyFor = candidate => tileKey(candidate) || [levelOf(candidate), candidate.r0, candidate.c0, candidate.r1, candidate.c1].join('/');
    const entries = new Map((Array.isArray(selected) ? selected : []).filter(entry => entry?.tile && entry.heights).map(entry => [keyFor(entry.tile), entry]));
    entries.set(keyFor(tile), {
      tile,
      heights
    });
    const records = new Map();
    const maskStep = finiteNumber(tileset?.oceanMask?.step, 0);
    for (const [key, entry] of entries) {
      const base = rawSurfaceOwnership(entry.tile, entry.heights, oceanAt, maskStep, cache);
      records.set(key, {
        ...base,
        tile: entry.tile,
        owners: base.unresolved.length ? base.owners.slice() : base.owners
      });
    }
    const candidates = [...entries.values()];
    let changed;
    do {
      changed = false;
      for (const record of records.values()) {
        const {
          tile: current,
          axes,
          rows,
          cols,
          owners,
          unresolved
        } = record;
        let seeded = false;
        for (const index of unresolved) {
          if (owners[index]) continue;
          const row = Math.floor(index / (cols - 1)),
            col = index % (cols - 1);
          if (!isBoundaryCell(row, col, rows, cols)) continue;
          const outside = [];
          if (row === 0) outside.push([-1, col]);
          if (row === rows - 2) outside.push([rows - 1, col]);
          if (col === 0) outside.push([row, -1]);
          if (col === cols - 2) outside.push([row, cols - 1]);
          for (const [neighborR, neighborC] of outside) {
            const neighbor = findExternalEntry(current, axes, row, col, neighborR, neighborC, candidates);
            const owner = neighbor && records.get(keyFor(neighbor.tile));
            if (owner?.owners[cellIndex(neighbor.row, neighbor.col, neighbor.cols)] === 2) {
              owners[index] = 2;
              seeded = changed = true;
              break;
            }
          }
        }
        if (seeded) floodMissingCells(owners, rows - 1, cols - 1);
      }
    } while (changed);
    const query = (row, col) => callOcean(oceanAt, row, col);
    query.cellOcean = (candidate, row, col) => {
      /*
       * Read cell ownership from the current build records using the tile key, including compact
       * water grids. Return true only for owner 2; absent, land and unresolved cells return false.
       */

      const record = records.get(keyFor(candidate));
      return Boolean(record && record.owners[cellIndex(row, col, record.cols)] === 2);
    };
    return query;
  }
  function surfaceIndices(mask, rows, cols) {
    /*
     * Expand a row-major cell mask into triangle indices. rows/cols count nodes; each valid quad
     * uses a fixed diagonal and six Uint32 indices.
     */

    let cells = 0;
    for (const value of mask) cells += value ? 1 : 0;
    const indices = new Uint32Array(cells * 6);
    let offset = 0;
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        if (!mask[cellIndex(row, col, cols)]) continue;
        const a = nodeIndex(row, col, cols);
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        indices.set([a, d, b, b, d, e], offset);
        offset += 6;
      }
    }
    return indices;
  }
  function makeGeometry(THREE, positions, indices) {
    /*
     * Create a Three.js BufferGeometry from flat XYZ positions and optional triangle indices. Set
     * attributes and compute normals and the bounding sphere.
     */

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (indices && indices.length) geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }
  function interpolate(a, b, amount) {
    return a + (b - a) * amount;
  }
  function locateCell(start, end, step, count, coordinate) {
    /*
     * Locate a native pixel coordinate within an axis cell. Clamp the estimated index and compute
     * its fraction using actual endpoints, including a short last interval. Return {index,amount},
     * with amount in [0,1].
     */

    let index = Math.floor((coordinate - start) / step);
    index = Math.max(0, Math.min(count - 2, index));
    const left = Math.min(start + index * step, end);
    const right = Math.min(start + (index + 1) * step, end);
    const amount = right > left ? Math.max(0, Math.min(1, (coordinate - left) / (right - left))) : 0;
    return {
      index,
      amount
    };
  }
  function descriptorFor(tile, heights, cache) {
    /*
     * Get a validated sampling descriptor for a tile and quantized heights, optionally cached by
     * tile object. Return dimensions, native bounds, step and axes.
     */

    let descriptor = cache && cache.get(tile);
    if (!descriptor) {
      const {
        rows,
        cols
      } = tileGridSize(tile, heights);
      descriptor = Object.assign({
        rows,
        cols
      }, axesFor(tile, rows, cols));
      if (cache) cache.set(tile, descriptor);
    }
    return descriptor;
  }
  function sampleTileAt(tile, heights, nativeRow, nativeCol, oceanAt, cache, resolveNode) {
    /*
     * Sample a tile at native row/column coordinates using its fixed triangle diagonal. Check cell
     * ownership, optionally resolve shared LOD endpoints, then interpolate. Return {owner,height}:
     * owner is land/water/hole; height is metres and zero for nonland.
     */

    const descriptor = descriptorFor(tile, heights, cache);
    const {
      rows,
      cols,
      ...axes
    } = descriptor;
    const rowLocation = locateCell(axes.r0, axes.r1, axes.step, rows, nativeRow);
    const colLocation = locateCell(axes.c0, axes.c1, axes.step, cols, nativeCol);
    const row = rowLocation.index;
    const col = colLocation.index;
    const a = nodeIndex(row, col, cols);
    const b = a + 1;
    const d = a + cols;
    const e = d + 1;
    const rawA = rawAt(heights, a);
    const rawB = rawAt(heights, b);
    const rawD = rawAt(heights, d);
    const rawE = rawAt(heights, e);
    const allValid = rawIsValid(rawA) && rawIsValid(rawB) && rawIsValid(rawD) && rawIsValid(rawE);
    if (!allValid && !resolveNode) {
      // An invalid owner is either boundary-connected water or an interior
      // hole.  Both are non-land for stitching, but preserve the distinction
      // for callers and invoke oceanAt only for this invalid cell.
      const ocean = cellOcean(oceanAt, axes, row, col, tile) || forcedSeaAt(tile, row, col, rows, cols);
      return {
        owner: ocean ? 'water' : 'hole',
        height: 0
      };
    }
    const samples = resolveNode ? [resolveNode(axes.rowsAxis[row], axes.colsAxis[col]), resolveNode(axes.rowsAxis[row], axes.colsAxis[col + 1]), resolveNode(axes.rowsAxis[row + 1], axes.colsAxis[col]), resolveNode(axes.rowsAxis[row + 1], axes.colsAxis[col + 1])] : [{
      owner: 'land',
      height: rawHeight(rawA)
    }, {
      owner: 'land',
      height: rawHeight(rawB)
    }, {
      owner: 'land',
      height: rawHeight(rawD)
    }, {
      owner: 'land',
      height: rawHeight(rawE)
    }];
    if (samples.some(sample => !sample || sample.owner !== 'land')) {
      const water = samples.some(sample => sample && sample.owner === 'water');
      return {
        owner: water ? 'water' : 'hole',
        height: 0
      };
    }
    const hA = samples[0].height;
    const hB = samples[1].height;
    const hD = samples[2].height;
    const hE = samples[3].height;
    const u = colLocation.amount;
    const v = rowLocation.amount;
    const height = u + v <= 1 ? hA * (1 - u - v) + hD * v + hB * u : hB * (1 - v) + hD * (1 - u) + hE * (u + v - 1);
    return Number.isFinite(height) ? {
      owner: 'land',
      height
    } : {
      owner: 'hole',
      height: 0
    };
  }
  function sampleOriginalTile(tile, heights, nativeRow, nativeCol, oceanAt, cache) {
    return sampleTileAt(tile, heights, nativeRow, nativeCol, oceanAt, cache, null);
  }
  function touchingCoarserTile(currentTile, nativeRow, nativeCol, selected) {
    /*
     * Find a selected coarser tile covering a native row/column position. Prefer the largest level,
     * then key order. Return the matching entry or null.
     */

    let best = null;
    for (const entry of Array.isArray(selected) ? selected : []) {
      const candidate = entry && entry.tile;
      if (!candidate || candidate === currentTile) continue;
      if (tileKey(candidate) === tileKey(currentTile) && tileKey(currentTile)) continue;
      if (levelOf(candidate) <= levelOf(currentTile)) continue;
      if (nativeRow < integer(candidate.r0, 0) || nativeRow > integer(candidate.r1, -1)) continue;
      if (nativeCol < integer(candidate.c0, 0) || nativeCol > integer(candidate.c1, -1)) continue;
      if (!best || levelOf(candidate) > levelOf(best.tile) || levelOf(candidate) === levelOf(best.tile) && tileKey(candidate) < tileKey(best.tile)) {
        best = entry;
      }
    }
    return best;
  }
  function markWaterNeighbors(flags, row, col, rows, cols) {
    /*
     * Mark existing cells adjoining one node as water-owned. flags has (rows-1)*(cols-1) entries.
     * Update in place without crossing grid bounds.
     */

    // A node has up to four incident cells.  Check both coordinates before
    // indexing: the last row/column is a node boundary, not a cell index.
    if (row > 0 && col > 0) flags[cellIndex(row - 1, col - 1, cols)] = 1;
    if (row > 0 && col < cols - 1) flags[cellIndex(row - 1, col, cols)] = 1;
    if (row < rows - 1 && col > 0) flags[cellIndex(row, col - 1, cols)] = 1;
    if (row < rows - 1 && col < cols - 1) flags[cellIndex(row, col, cols)] = 1;
  }

  /*
   * Resolve a stitched sample through the selected LOD chain.  A coarse
   * tile can itself share this vertex with an even coarser tile; following
   * the chain makes the common corner use the same final owner and height.
   * The level ordering makes cycles impossible, while `visited` protects
   * against malformed duplicate descriptors.
   */
  function sampleResolvedTile(tile, heights, nativeRow, nativeCol, oceanAt, selected, cache, visited) {
    /*
     * Resolve a sample along the selected LOD chain so shared edges have one final owner and
     * elevation. Follow covering coarser tiles, then interpolate resolved endpoints. Use a visited
     * set to break cycles and fall back to current raw values.
     */

    const seen = visited || new Set();
    if (seen.has(tile)) {
      return sampleOriginalTile(tile, heights, nativeRow, nativeCol, oceanAt, cache);
    }
    seen.add(tile);
    const next = touchingCoarserTile(tile, nativeRow, nativeCol, selected);
    if (next && next.tile && next.heights && !seen.has(next.tile)) {
      return sampleResolvedTile(next.tile, next.heights, nativeRow, nativeCol, oceanAt, selected, cache, seen);
    }
    // Resolve each endpoint of the owner cell as well.  This matters when
    // the requested point is halfway along an edge whose endpoint was moved
    // by a still coarser selected tile.
    return sampleTileAt(tile, heights, nativeRow, nativeCol, oceanAt, cache, (nodeRow, nodeCol) => sampleResolvedNode(tile, heights, nodeRow, nodeCol, oceanAt, selected, cache, seen));
  }
  function sampleResolvedNode(tile, heights, nativeRow, nativeCol, oceanAt, selected, cache, visited) {
    /*
     * Resolve an exact LOD endpoint while distinguishing sea from inland NoData. Prefer a covering
     * coarser tile; otherwise read the local node and shared ocean classification. Return
     * {owner,height}; water and hole heights are zero.
     */

    const seen = visited || new Set();
    const ownerEntry = touchingCoarserTile(tile, nativeRow, nativeCol, selected);
    if (ownerEntry && ownerEntry.tile && ownerEntry.heights && !seen.has(ownerEntry.tile)) {
      const branch = new Set(seen);
      branch.add(tile);
      return sampleResolvedTile(ownerEntry.tile, ownerEntry.heights, nativeRow, nativeCol, oceanAt, selected, cache, branch);
    }

    // The containing cell was already checked by sampleTileAt.  Reading the
    // node directly therefore preserves its exact raw value and avoids
    // re-interpolating the same cell while resolving its endpoints.
    const descriptor = descriptorFor(tile, heights, cache);
    const {
      rows,
      cols,
      ...axes
    } = descriptor;
    const rowLocation = locateCell(axes.r0, axes.r1, axes.step, rows, nativeRow);
    const colLocation = locateCell(axes.c0, axes.c1, axes.step, cols, nativeCol);
    const nodeRow = nativeRow === axes.r1 ? rows - 1 : rowLocation.index;
    const nodeCol = nativeCol === axes.c1 ? cols - 1 : colLocation.index;
    const index = nodeIndex(nodeRow, nodeCol, cols);
    const raw = rawAt(heights, index);
    if (rawIsValid(raw)) return {
      owner: 'land',
      height: rawHeight(raw)
    };
    const ocean = cellOcean(oceanAt, axes, rowLocation.index, colLocation.index, tile) || forcedSeaAt(tile, rowLocation.index, colLocation.index, rows, cols);
    return {
      owner: ocean ? 'water' : 'hole',
      height: 0
    };
  }
  function applyLODStitch(tile, heights, selected, axes, nodeHeights, nodeValid, waterOwnerFlags, oceanAt, cache) {
    /*
     * Align current boundary nodes with selected coarser LOD tiles. Write land heights, mark
     * adjacent water cells and leave inland holes invalid. Mutate nodeHeights, nodeValid and
     * waterOwnerFlags only along the perimeter.
     */

    const rows = axes.rowsAxis.length;
    const cols = axes.colsAxis.length;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (row !== 0 && row !== rows - 1 && col !== 0 && col !== cols - 1) continue;
        const nativeRow = axes.rowsAxis[row];
        const nativeCol = axes.colsAxis[col];
        const ownerEntry = touchingCoarserTile(tile, nativeRow, nativeCol, selected);
        if (!ownerEntry || !ownerEntry.heights) continue;
        const sample = sampleResolvedTile(ownerEntry.tile, ownerEntry.heights, nativeRow, nativeCol, oceanAt, selected, cache);
        const index = nodeIndex(row, col, cols);
        if (sample.owner === 'land') {
          nodeHeights[index] = sample.height;
          nodeValid[index] = 1;
        } else {
          nodeHeights[index] = 0;
          nodeValid[index] = 0;
          // A hole is intentionally left as a hole.  It becomes water only
          // when the boundary-connected ocean classification confirms it.
          if (sample.owner === 'water') {
            markWaterNeighbors(waterOwnerFlags, row, col, rows, cols);
          }
        }
      }
    }
  }
  function classifyCells(tile, axes, nodeValid, waterOwnerFlags, oceanAt) {
    /*
     * Build land/water cell masks from node validity and ownership. Land requires four valid
     * corners and no water override; other cells become water only with confirmed ownership.
     * Unclassified holes remain zero in both Uint8Array masks.
     */

    const rows = axes.rowsAxis.length;
    const cols = axes.colsAxis.length;
    const land = new Uint8Array((rows - 1) * (cols - 1));
    const water = new Uint8Array(land.length);
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const index = cellIndex(row, col, cols);
        const a = nodeIndex(row, col, cols);
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        const allValid = nodeValid[a] && nodeValid[b] && nodeValid[d] && nodeValid[e];
        if (allValid && !waterOwnerFlags[index]) {
          land[index] = 1;
        } else if (waterOwnerFlags[index] || cellOcean(oceanAt, axes, row, col, tile) || forcedSeaAt(tile, row, col, rows, cols)) {
          water[index] = 1;
        }
      }
    }
    return {
      land,
      water
    };
  }
  function createPositions(axes, global, nodeHeights, waterSurface) {
    /*
     * Map native raster axes to centred XYZ positions in metres. Columns map to X and rows to Z.
     * Land uses node heights; waterSurface fixes Y at sea level zero. Return a flat Float32Array.
     */

    const rows = axes.rowsAxis.length;
    const cols = axes.colsAxis.length;
    const positions = new Float32Array(rows * cols * 3);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = nodeIndex(row, col, cols);
        positions[index * 3] = -global.width * 0.5 + axes.colsAxis[col] * global.dx;
        positions[index * 3 + 1] = waterSurface ? 0 : nodeHeights[index];
        positions[index * 3 + 2] = -global.height * 0.5 + axes.rowsAxis[row] * global.dz;
      }
    }
    return positions;
  }
  function tileEntryKey(entry) {
    return tileKey(entry && entry.tile ? entry.tile : entry);
  }
  function sameLevel(a, b) {
    return levelOf(a) === levelOf(b);
  }
  function findAxisCell(axis, coordinate) {
    for (let index = 0; index < axis.length - 1; index++) {
      if (coordinate >= axis[index] && coordinate <= axis[index + 1]) return index;
    }
    return -1;
  }
  function findExternalEntry(currentTile, axes, row, col, neighborR, neighborC, selected) {
    /*
     * Find a same-level tile sharing the current outer edge and covering the adjacent cell centre.
     * Return its descriptor, axes and neighbor-cell indices, or null.
     */

    const rows = axes.rowsAxis.length;
    const cols = axes.colsAxis.length;
    const outsideRow = neighborR < 0 || neighborR >= rows - 1;
    const outsideCol = neighborC < 0 || neighborC >= cols - 1;
    if (outsideRow === outsideCol) return null;
    let rowBoundary = null;
    let colBoundary = null;
    let rowMid = null;
    let colMid = null;
    if (outsideRow) {
      const currentRow = neighborR < 0 ? 0 : rows - 2;
      rowBoundary = axes.rowsAxis[neighborR < 0 ? 0 : rows - 1];
      const width = axes.rowsAxis[currentRow + 1] - axes.rowsAxis[currentRow];
      rowMid = rowBoundary + (neighborR < 0 ? -0.5 : 0.5) * width;
      colMid = (axes.colsAxis[col] + axes.colsAxis[col + 1]) * 0.5;
    } else {
      const currentCol = neighborC < 0 ? 0 : cols - 2;
      colBoundary = axes.colsAxis[neighborC < 0 ? 0 : cols - 1];
      const width = axes.colsAxis[currentCol + 1] - axes.colsAxis[currentCol];
      colMid = colBoundary + (neighborC < 0 ? -0.5 : 0.5) * width;
      rowMid = (axes.rowsAxis[row] + axes.rowsAxis[row + 1]) * 0.5;
    }
    const candidates = Array.isArray(selected) ? selected : [];
    for (const entry of candidates) {
      const candidate = entry && entry.tile;
      if (!candidate || candidate === currentTile || tileEntryKey(entry) === tileKey(currentTile)) continue;
      if (!sameLevel(candidate, currentTile)) continue;
      const heights = entry.heights;
      if (!heights) continue;
      let size;
      try {
        size = tileGridSize(candidate, heights);
      } catch {
        continue;
      }
      const candidateAxes = axesFor(candidate, size.rows, size.cols);
      if (outsideRow) {
        const sharesBoundary = neighborR < 0 ? candidateAxes.r1 === rowBoundary : candidateAxes.r0 === rowBoundary;
        if (!sharesBoundary) continue;
        if (colMid < candidateAxes.c0 || colMid > candidateAxes.c1) continue;
      } else {
        const sharesBoundary = neighborC < 0 ? candidateAxes.c1 === colBoundary : candidateAxes.c0 === colBoundary;
        if (!sharesBoundary) continue;
        if (rowMid < candidateAxes.r0 || rowMid > candidateAxes.r1) continue;
      }
      const candidateRow = outsideRow ? neighborR < 0 ? size.rows - 2 : 0 : findAxisCell(candidateAxes.rowsAxis, rowMid);
      const candidateCol = outsideRow ? findAxisCell(candidateAxes.colsAxis, colMid) : neighborC < 0 ? size.cols - 2 : 0;
      if (candidateRow < 0 || candidateCol < 0) continue;
      return {
        entry,
        tile: candidate,
        heights,
        axes: candidateAxes,
        rows: size.rows,
        cols: size.cols,
        row: candidateRow,
        col: candidateCol
      };
    }
    return null;
  }
  function classifyNeighbor(neighbor, oceanAt) {
    /*
     * Classify an external adjacent cell as land or confirmed sea. Four valid corners mean land;
     * otherwise use shared coverage/connectivity. Return the candidate with its raw heights, or
     * null if unresolved.
     */

    if (!neighbor) return null;
    const {
      entry,
      tile,
      heights,
      axes,
      rows,
      cols,
      row,
      col
    } = neighbor;
    const nodeIds = [nodeIndex(row, col, cols), nodeIndex(row, col + 1, cols), nodeIndex(row + 1, col, cols), nodeIndex(row + 1, col + 1, cols)];
    const raw = nodeIds.map(index => rawAt(heights, index));
    const allValid = raw.every(rawIsValid);
    if (allValid) {
      return {
        kind: 'land',
        entry,
        tile,
        axes,
        // Keep the source quantized array for exact shared-endpoint lookup.
        // `heights` is intentionally not replaced by the four decoded cell
        // values: endpoint lookup uses the candidate tile's full node grid.
        rawHeights: heights,
        rows,
        cols
      };
    }
    const water = cellOcean(oceanAt, axes, row, col, tile) || forcedSeaAt(tile, row, col, rows, cols);
    if (!water) return null;
    return {
      kind: 'water',
      entry,
      tile,
      axes,
      rawHeights: heights,
      rows,
      cols
    };
  }
  function nodeHeightAtCandidate(candidate, nativeRow, nativeCol, oceanAt) {
    /*
     * Read a shared endpoint elevation from a classified external candidate. Water is zero; land
     * uses raw nodes, with NoData resolved to sea level or model-base elevation.
     */

    if (candidate.kind === 'water') return 0;
    const {
      axes,
      rawHeights,
      rows,
      cols
    } = candidate;
    const row = axes.rowsAxis.indexOf(nativeRow);
    const col = axes.colsAxis.indexOf(nativeCol);
    if (row < 0 || col < 0) return 0;
    const raw = rawAt(rawHeights, nodeIndex(row, col, cols));
    if (rawIsValid(raw)) return rawHeight(raw);
    return callOcean(oceanAt, nativeRow, nativeCol) ? 0 : BASE_ELEVATION;
  }
  function externalSurface(currentTile, axes, selected, shellKind, oceanAt) {
    /*
     * Create the outer-edge query passed to the closed-volume builder. Use same-level candidates
     * and return shared endpoint elevations where shell ownership differs. Return compactBottom and
     * externalEdge.
     */

    const candidates = Array.isArray(selected) ? selected.filter(entry => entry && entry.tile && sameLevel(entry.tile, currentTile)) : [];
    const sampleCache = new Map();
    return {
      compactBottom: true,
      externalEdge({
        a,
        b,
        neighborR,
        neighborC,
        topPositions,
        rows,
        cols
      }) {
        const minNode = Math.min(a, b);
        const nodeRow = Math.floor(minNode / cols);
        const nodeCol = minNode % cols;
        const outsideRow = neighborR < 0 || neighborR >= rows - 1;
        const outsideCol = neighborC < 0 || neighborC >= cols - 1;
        const row = outsideRow && neighborR >= rows - 1 ? nodeRow - 1 : nodeRow;
        const col = outsideCol && neighborC >= cols - 1 ? nodeCol - 1 : nodeCol;
        if (currentTile.virtual) {
          // Display leaves may neighbor different levels. Determine actual ownership just outside each edge; cap only genuinely exposed edges.
          const ar = axes.rowsAxis[Math.floor(a / cols)],
            ac = axes.colsAxis[a % cols];
          const br = axes.rowsAxis[Math.floor(b / cols)],
            bc = axes.colsAxis[b % cols];
          const r = (ar + br) / 2 + (outsideRow ? neighborR < 0 ? -0.001 : 0.001 : 0);
          const c = (ac + bc) / 2 + (outsideCol ? neighborC < 0 ? -0.001 : 0.001 : 0);
          const neighbor = selected.find(entry => entry.tile.key !== currentTile.key && r >= entry.tile.r0 && r <= entry.tile.r1 && c >= entry.tile.c0 && c <= entry.tile.c1);
          if (!neighbor) return null;
          const sample = sampleResolvedTile(neighbor.tile, neighbor.heights, r, c, oceanAt, selected, sampleCache);
          if (sample.owner === shellKind) return {
            same: true
          };
          if (sample.owner === 'hole') return null;
          return {
            heights: [sampleResolvedTile(neighbor.tile, neighbor.heights, ar, ac, oceanAt, selected, sampleCache).height, sampleResolvedTile(neighbor.tile, neighbor.heights, br, bc, oceanAt, selected, sampleCache).height]
          };
        }
        const neighbor = findExternalEntry(currentTile, axes, row, col, neighborR, neighborC, candidates);
        const classified = classifyNeighbor(neighbor, oceanAt);
        if (!classified) return null;
        if (classified.kind === shellKind) return {
          same: true
        };
        const aRow = axes.rowsAxis[Math.floor(a / cols)];
        const aCol = axes.colsAxis[a % cols];
        const bRow = axes.rowsAxis[Math.floor(b / cols)];
        const bCol = axes.colsAxis[b % cols];
        return {
          heights: [nodeHeightAtCandidate(classified, aRow, aCol, oceanAt), nodeHeightAtCandidate(classified, bRow, bCol, oceanAt)]
        };
      }
    };
  }
  function makeShell(THREE, volume, positions, mask, rows, cols, adjacent, boundaryBounds) {
    /*
     * Build a closed top, wall and bottom shell from XYZ positions and a valid-cell mask. Generate
     * indices, close the surface, and retain perimeter indices/build normals for cross-tile
     * synchronization. Return shell geometries, or null for no triangles.
     */

    const indices = surfaceIndices(mask, rows, cols);
    if (!indices.length) return null;
    const shell = volume.closeSurface(THREE, positions, indices, mask, rows, cols, adjacent);
    // closeSurface may split the top along the land/water boundary so that
    // its side walls share exact vertices.  Always use that conforming top;
    // the fallback is for the legacy helper contract only.
    const top = shell && shell.top ? shell.top : typeof volume.makeGeometry === 'function' ? volume.makeGeometry(THREE, positions, indices) : makeGeometry(THREE, positions, indices);
    if (top) {
      if (!top.userData) top.userData = {};
      top.userData.notoBoundaryBounds = boundaryBounds;
      const normal = top.attributes && top.attributes.normal;
      const position = top.attributes && top.attributes.position;
      if (normal && position && boundaryBounds) {
        // Cache only perimeter vertices; dense tiles can contain tens of
        // thousands of interior nodes whose normals never participate in a
        // cross-tile synchronization pass.
        const indices = [];
        const epsilon = 1e-4;
        for (let i = 0; i < position.array.length; i += 3) {
          const x = position.array[i],
            z = position.array[i + 2];
          if (Math.abs(x - boundaryBounds.minX) <= epsilon || Math.abs(x - boundaryBounds.maxX) <= epsilon || Math.abs(z - boundaryBounds.minZ) <= epsilon || Math.abs(z - boundaryBounds.maxZ) <= epsilon) indices.push(i / 3);
        }
        top.userData.notoBoundaryVertexIndices = Uint32Array.from(indices);
        const original = new Float32Array(indices.length * 3);
        for (let i = 0; i < indices.length; i++) {
          original.set(normal.array.slice(indices[i] * 3, indices[i] * 3 + 3), i * 3);
        }
        top.userData.notoOriginalBoundaryNormals = original;
      }
    }
    return {
      top,
      walls: shell.walls,
      bottom: shell.bottom
    };
  }
  function disposeGeometry(piece) {
    /* Dispose available top, wall and bottom geometries in a shell without changing the input object's structure. */

    if (!piece) return;
    for (const key of ['top', 'walls', 'bottom']) {
      if (piece[key] && typeof piece[key].dispose === 'function') piece[key].dispose();
    }
  }
  function tileMetadata(axes, global, pureWater) {
    /*
     * Build material-projection metadata from native axes and metric source spacing. Return sample
     * dimensions, step, origin and extent, including compact pure-water sampling rules.
     */

    const width = (axes.c1 - axes.c0) * global.dx;
    const height = (axes.r1 - axes.r0) * global.dz;
    return {
      sample_rows: axes.rowsAxis.length,
      sample_cols: axes.colsAxis.length,
      step: [axes.step * global.dx, axes.step * global.dz],
      source_spacing_m: [global.dx, global.dz],
      heightOrigin: [-global.width * 0.5 + axes.c0 * global.dx, -global.height * 0.5 + axes.r0 * global.dz],
      heightExtent: [width, height]
    };
  }
  function pureWaterGrid(tile, rawHeights, global, oceanAt) {
    /*
     * Build a water mesh matching the display level for a tile with no valid land and confirmed
     * sea. Use resolved cell ownership and point queries; return a compact grid, a skip marker if
     * unconfirmed, or null when inapplicable.
     */

    if (!(tile && tile.kind === 'water' && tile.hasLand === false)) return null;
    const {
      rows,
      cols
    } = tileGridSize(tile, rawHeights);
    let hasValid = false;
    for (let i = 0; i < rows * cols; i++) {
      if (rawIsValid(rawAt(rawHeights, i))) {
        hasValid = true;
        break;
      }
    }
    if (hasValid) return null;
    const axes = axesFor(tile, rows, cols);
    const rowMid = Math.floor((axes.r0 + axes.r1) * 0.5);
    const colMid = Math.floor((axes.c0 + axes.c1) * 0.5);
    const ocean = cellOcean(oceanAt, axes, 0, 0, tile) || callOcean(oceanAt, rowMid, colMid) || callOcean(oceanAt, axes.r0, axes.c0) || callOcean(oceanAt, axes.r0, axes.c1) || callOcean(oceanAt, axes.r1, axes.c0) || callOcean(oceanAt, axes.r1, axes.c1) || forcedSeaAt(tile, 0, 0, 2, 2);
    if (!ocean) {
      return {
        skip: true,
        axes: {
          r0: axes.r0,
          c0: axes.c0,
          r1: axes.r1,
          c1: axes.c1,
          step: Math.max(axes.r1 - axes.r0, axes.c1 - axes.c0),
          rowsAxis: new Int32Array([axes.r0, axes.r1]),
          colsAxis: new Int32Array([axes.c0, axes.c1])
        }
      };
    }
    // Neighboring mixed tiles use the same native step. Shared wave nodes prevent cracks against a large four-corner plane.
    const waterStep = Math.max(1, tile.step);
    const axis = (start, end) => {
      const count = Math.ceil((end - start) / waterStep) + 1;
      return Int32Array.from({
        length: count
      }, (_, i) => Math.min(end, start + i * waterStep));
    };
    const rowsAxis = axis(axes.r0, axes.r1),
      colsAxis = axis(axes.c0, axes.c1);
    const reducedTile = Object.assign({}, tile, {
      r0: axes.r0,
      c0: axes.c0,
      r1: axes.r1,
      c1: axes.c1,
      rows: rowsAxis.length,
      cols: colsAxis.length,
      step: waterStep
    });
    return {
      tile: reducedTile,
      axes: {
        r0: axes.r0,
        c0: axes.c0,
        r1: axes.r1,
        c1: axes.c1,
        step: waterStep,
        rowsAxis,
        colsAxis
      },
      nodeHeights: new Float32Array(rowsAxis.length * colsAxis.length),
      nodeValid: new Uint8Array(rowsAxis.length * colsAxis.length)
    };
  }
  function build(THREE, tileset, tile, heights, selected, oceanAt) {
    /*
     * Build closed land and water meshes from a quantized height tile. Decode nodes, stitch LOD
     * endpoints, classify cells and map to metric coordinates. Return land/water shells, metric
     * heights, metadata and a dispose method. selected supplies loaded neighbors; oceanAt is
     * optional.
     */

    if (!THREE || !tile || !heights) throw new Error('NotoTileGeometry.build requires THREE, tile, and heights');
    const volume = global.NotoVolume;
    if (!volume || typeof volume.closeSurface !== 'function') {
      throw new Error('NotoVolume.closeSurface is required for native tile geometry');
    }
    const coastalField = oceanAt?.coast;
    oceanAt = resolveOceanOwnership(tileset, tile, heights, selected, oceanAt);
    const globalSize = globalMetadata(tileset);
    const originalSize = tileGridSize(tile, heights);
    const originalAxes = axesFor(tile, originalSize.rows, originalSize.cols);
    const reduced = pureWaterGrid(tile, heights, globalSize, oceanAt);
    if (reduced && reduced.skip) {
      return {
        land: null,
        water: null,
        heights: new Float32Array(4),
        metadata: tileMetadata(reduced.axes, globalSize, true),
        dispose() {}
      };
    }
    const axes = reduced ? reduced.axes : originalAxes;
    const activeTile = reduced ? reduced.tile : tile;
    const rows = axes.rowsAxis.length;
    const cols = axes.colsAxis.length;
    const nodeHeights = reduced ? reduced.nodeHeights : new Float32Array(rows * cols);
    const nodeValid = reduced ? reduced.nodeValid : new Uint8Array(rows * cols);
    if (!reduced) {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const raw = rawAt(heights, nodeIndex(row, col, cols));
          nodeValid[nodeIndex(row, col, cols)] = rawIsValid(raw) ? 1 : 0;
          nodeHeights[nodeIndex(row, col, cols)] = rawIsValid(raw) ? rawHeight(raw) : 0;
        }
      }
    }
    const waterOwnerFlags = new Uint8Array((rows - 1) * (cols - 1));
    const selectedCache = new Map();
    // A completely NoData tile that was confirmed ocean is represented by
    // one exact water patch.  Do not let a neighbouring coarse land tile
    // promote its four corner nodes and turn that patch into a land polygon.
    const hasCoarserSelection = Array.isArray(selected) && selected.some(entry => entry?.tile && levelOf(entry.tile) > levelOf(activeTile));
    if (!reduced && hasCoarserSelection) {
      applyLODStitch(activeTile, heights, selected, axes, nodeHeights, nodeValid, waterOwnerFlags, oceanAt, selectedCache);
    }
    const masks = classifyCells(activeTile, axes, nodeValid, waterOwnerFlags, oceanAt);
    if (reduced) {
      // `pureWaterGrid` only returns a reduced tile after an ocean sample was
      // confirmed.  Its entire native extent is therefore water, including
      // corners that happen to sit beside a land tile.
      masks.land.fill(0);
      masks.water.fill(1);
    }
    const landPositions = createPositions(axes, globalSize, nodeHeights, false);
    const waterPositions = createPositions(axes, globalSize, nodeHeights, true);
    const boundaryBounds = {
      minX: landPositions[0],
      maxX: landPositions[(cols - 1) * 3],
      minZ: landPositions[2],
      maxZ: landPositions[(rows - 1) * cols * 3 + 2]
    };
    const coastal = global.NotoCoastalGeometry?.build(THREE, {
      field: coastalField,
      axes,
      globalSize,
      nodeHeights,
      nodeValid,
      masks,
      bounds: boundaryBounds
    });
    if (coastal) {
      return {
        ...coastal,
        metadata: tileMetadata(axes, globalSize, Boolean(reduced)),
        dispose() {
          disposeGeometry(coastal.land);
          disposeGeometry(coastal.water);
        }
      };
    }
    const landAdjacent = Object.assign({
      cells: masks.water,
      positions: waterPositions,
      waterOwnerFlags
    }, externalSurface(activeTile, axes, selected, 'land', oceanAt));
    const waterAdjacent = Object.assign({
      cells: masks.land,
      positions: landPositions,
      waterOwnerFlags
    }, externalSurface(activeTile, axes, selected, 'water', oceanAt));
    const land = makeShell(THREE, volume, landPositions, masks.land, rows, cols, landAdjacent, boundaryBounds);
    const water = makeShell(THREE, volume, waterPositions, masks.water, rows, cols, waterAdjacent, boundaryBounds);
    const result = {
      land,
      water,
      heights: nodeHeights,
      // Share the actual surface topology's land-cell mask with vegetation; plants cannot occupy water or invalid cells.
      landCells: masks.land,
      metadata: tileMetadata(axes, globalSize, Boolean(reduced)),
      dispose() {
        disposeGeometry(land);
        disposeGeometry(water);
      }
    };
    return result;
  }
  global.NotoTileGeometry = {
    build,
    conformEdges(THREE, tile, result, coarser, metadata, kind = 'land') {
      // Continuous coasts refine beyond the base grid. Constrain fine edges to completed coarse boundary polylines,
      // and insert coarse-edge breakpoints so the contact profile and NoData-filled final surfaces meet exactly.
      if (!result[kind] || !coarser.length) return;
      const dx = metadata.source_spacing_m[0],
        dz = metadata.source_spacing_m[1];
      const x0 = tile.c0 * dx - metadata.width_m / 2,
        x1 = tile.c1 * dx - metadata.width_m / 2;
      const z0 = tile.r0 * dz - metadata.height_m / 2,
        z1 = tile.r1 * dz - metadata.height_m / 2;
      const profiles = [];
      for (const item of coarser) {
        const other = item.tile,
          mesh = item.geometry[kind]?.top;
        if (!mesh || other.step <= tile.step) continue;
        let axis, coordinate, lo, hi;
        if ((other.c1 === tile.c0 || other.c0 === tile.c1) && Math.max(other.r0, tile.r0) < Math.min(other.r1, tile.r1)) {
          axis = 0;
          coordinate = other.c1 === tile.c0 ? x0 : x1;
          lo = Math.max(other.r0, tile.r0) * dz - metadata.height_m / 2;
          hi = Math.min(other.r1, tile.r1) * dz - metadata.height_m / 2;
        } else if ((other.r1 === tile.r0 || other.r0 === tile.r1) && Math.max(other.c0, tile.c0) < Math.min(other.c1, tile.c1)) {
          axis = 2;
          coordinate = other.r1 === tile.r0 ? z0 : z1;
          lo = Math.max(other.c0, tile.c0) * dx - metadata.width_m / 2;
          hi = Math.min(other.c1, tile.c1) * dx - metadata.width_m / 2;
        } else continue;
        const along = axis === 0 ? 2 : 0,
          segments = [],
          knots = new Set();
        const p = mesh.attributes.position.array,
          ids = mesh.index.array;
        for (let i = 0; i < ids.length; i += 3) for (let j = 0; j < 3; j++) {
          let a = ids[i + j] * 3,
            b = ids[i + (j + 1) % 3] * 3;
          if (Math.abs(p[a + axis] - coordinate) > 0.002 || Math.abs(p[b + axis] - coordinate) > 0.002) continue;
          if (p[a + along] > p[b + along]) [a, b] = [b, a];
          if (p[b + along] - p[a + along] < 1e-6 || p[b + along] < lo || p[a + along] > hi) continue;
          segments.push([p[a + along], p[b + along], p[a + 1], p[b + 1]]);
          knots.add(p[a + along]);
          knots.add(p[b + along]);
        }
        const height = t => {
          const edge = segments.find(s => t >= s[0] - 1e-4 && t <= s[1] + 1e-4);
          if (!edge) return null;
          const u = (t - edge[0]) / (edge[1] - edge[0]);
          return edge[2] * (1 - u) + edge[3] * u;
        };
        if (segments.length) profiles.push({
          axis,
          along,
          coordinate,
          lo,
          hi,
          segments,
          knots: [...knots].sort((a, b) => a - b),
          height
        });
      }
      if (!profiles.length) return;
      const top = result[kind].top,
        positions = Array.from(top.attributes.position.array),
        original = top.index.array;
      const on = (p, i) => Math.abs(positions[i * 3 + p.axis] - p.coordinate) < 0.002 && positions[i * 3 + p.along] >= p.lo - 1e-4 && positions[i * 3 + p.along] <= p.hi + 1e-4;
      for (let i = 0; i < positions.length / 3; i++) for (const p of profiles) {
        if (!on(p, i)) continue;
        const y = p.height(positions[i * 3 + p.along]);
        if (y !== null) positions[i * 3 + 1] = y;
      }
      const indices = [],
        offsets = new Uint32Array(original.length + 1),
        inserted = new Map();
      function vertex(point) {
        const key = `${point[0]},${point[2]}`;
        if (inserted.has(key)) return inserted.get(key);
        const id = positions.length / 3;
        positions.push(...point);
        inserted.set(key, id);
        return id;
      }
      for (let i = 0; i < original.length; i += 3) {
        offsets[i] = indices.length;
        const ids = [original[i], original[i + 1], original[i + 2]],
          polygon = [];
        for (let j = 0; j < 3; j++) {
          const a = ids[j],
            b = ids[(j + 1) % 3];
          polygon.push(a);
          for (const p of profiles) {
            if (!on(p, a) || !on(p, b)) continue;
            const from = positions[a * 3 + p.along],
              to = positions[b * 3 + p.along];
            const knots = p.knots.filter(t => t > Math.min(from, to) + 1e-4 && t < Math.max(from, to) - 1e-4);
            if (to < from) knots.reverse();
            for (const t of knots) {
              const y = p.height(t);
              if (y === null) continue;
              const point = [0, y, 0];
              point[p.axis] = p.coordinate;
              point[p.along] = t;
              polygon.push(vertex(point));
            }
          }
        }
        if (polygon.length === 3) indices.push(...ids);else {
          const center = [0, 0, 0];
          for (const id of ids) for (let axis = 0; axis < 3; axis++) center[axis] += positions[id * 3 + axis] / 3;
          const mid = vertex(center);
          for (let j = 0; j < polygon.length; j++) indices.push(mid, polygon[j], polygon[(j + 1) % polygon.length]);
        }
      }
      offsets[original.length] = indices.length;
      // Coastal height queries store triangle ranges per original cell; remap those ranges after topology insertion.
      if (kind === 'land' && result.shoreQueryRanges) for (let i = 0; i < result.shoreQueryRanges.length; i++) result.shoreQueryRanges[i] = offsets[result.shoreQueryRanges[i]];
      top.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(positions), 3));
      top.setIndex(new THREE.BufferAttribute(Uint32Array.from(indices), 1));
      top.computeVertexNormals();
      top.computeBoundingBox();
      top.computeBoundingSphere();
      delete top.userData.notoBoundaryVertexIndices;
      delete top.userData.notoOriginalBoundaryNormals;
      if (kind === 'water') {
        // At each boundary, the GPU interpolates the same two coarse-edge wave displacements; static alignment alone cannot seal animated water.
        const edges = new Float32Array(positions.length / 3 * 4);
        for (let i = 0; i < positions.length / 3; i++) for (const p of profiles) {
          if (!on(p, i)) continue;
          const t = positions[i * 3 + p.along];
          const segment = p.segments.find(s => t >= s[0] - 1e-4 && t <= s[1] + 1e-4);
          if (!segment) continue;
          const a = [0, 0],
            b = [0, 0];
          a[p.axis / 2] = b[p.axis / 2] = p.coordinate;
          a[p.along / 2] = segment[0];
          b[p.along / 2] = segment[1];
          edges.set([...a, ...b], i * 4);
        }
        top.setAttribute('notoSeaEdge', new THREE.BufferAttribute(edges, 4));
        return;
      }
      // Ordinary plant/collision queries still use regular height grids; synchronize boundary nodes without changing interior DEM samples.
      const rows = result.metadata.sample_rows,
        cols = result.metadata.sample_cols;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (r !== 0 && r !== rows - 1 && c !== 0 && c !== cols - 1) continue;
        const point = [Math.min(tile.c1, tile.c0 + c * tile.step) * dx - metadata.width_m / 2, 0, Math.min(tile.r1, tile.r0 + r * tile.step) * dz - metadata.height_m / 2];
        for (const p of profiles) if (Math.abs(point[p.axis] - p.coordinate) < 0.002 && point[p.along] >= p.lo && point[p.along] <= p.hi) {
          const y = p.height(point[p.along]);
          if (y !== null && !result.sampleHeight) result.heights[r * cols + c] = y;
        }
      }
    },
    synchronizeNormals(results) {
      return global.NotoVolume && typeof global.NotoVolume.synchronizeNormals === 'function' ? global.NotoVolume.synchronizeNormals(results) : undefined;
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
