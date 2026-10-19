/*
 * Select nested terrain patches by distance. Data tiles supply samples; display patches are
 * independent of file boundaries.
 */
(function registerTerrainLOD(global) {
  'use strict';

  const CELLS = 128;
  const NODATA = 65535;
  const overlaps = (a, b) => a.c0 < b.c1 && a.c1 > b.c0 && a.r0 < b.r1 && a.r1 > b.r0;
  const touches = (a, b) => a.c0 <= b.c1 && a.c1 >= b.c0 && a.r0 <= b.r1 && a.r1 >= b.r0;
  function create({
    metadata,
    levels,
    descriptors,
    unavailable
  }) {
    const width = metadata.source_width - 1;
    const height = metadata.source_height - 1;
    const nodes = new Map();
    let baseStep = 0;
    let root = null;
    let committedSplits = new Set();
    const lookupCache = new WeakMap();

    // Double display spacing from the user limit, for example 5/10/20/40 m. Adjacent levels have strictly nested nodes,
    // including limits of 3/5/6/7 m; do not directly mix misaligned source rectangles in one view.
    function node(step, x, z) {
      const key = `patch/${baseStep}/${step}/${x}/${z}`;
      if (nodes.has(key)) return nodes.get(key);
      const span = CELLS * step;
      const tile = {
        key,
        virtual: true,
        file: 'virtual',
        step,
        x,
        z,
        level: Math.log2(step / baseStep),
        c0: x * span,
        r0: z * span,
        c1: Math.min(width, (x + 1) * span),
        r1: Math.min(height, (z + 1) * span)
      };
      tile.cols = Math.ceil((tile.c1 - tile.c0) / step) + 1;
      tile.rows = Math.ceil((tile.r1 - tile.r0) / step) + 1;
      tile.interior = tile.c0 > 0 && tile.r0 > 0 && tile.c1 < width && tile.r1 < height;
      const sources = sourceTiles(tile);
      tile.hasLand = sources.some(t => t.hasLand !== false && t.file);
      tile.kind = tile.hasLand ? 'mixed' : 'water';
      tile.min = Math.min(0, ...sources.map(t => t.min ?? 0));
      tile.max = Math.max(0, ...sources.map(t => t.max ?? 0));
      nodes.set(key, tile);
      return tile;
    }
    function children(tile) {
      if (tile.step <= baseStep) return [];
      const result = [];
      for (let z = tile.z * 2; z < tile.z * 2 + 2; z++) {
        for (let x = tile.x * 2; x < tile.x * 2 + 2; x++) {
          if (x * CELLS * tile.step / 2 < width && z * CELLS * tile.step / 2 < height) result.push(node(tile.step / 2, x, z));
        }
      }
      return result;
    }
    function sourceTiles(tile) {
      let level = levels.findLastIndex(entry => entry.step <= tile.step);
      level = Math.max(0, level);
      // A missing file changes only this display patch's sampling source; retain detail in all other regions.
      for (; level < levels.length; level++) {
        const source = levels[level],
          span = 256 * source.step,
          result = [];
        for (let z = Math.floor(tile.r0 / span); z <= Math.floor(Math.min(height - 1e-6, tile.r1) / span); z++) {
          for (let x = Math.floor(tile.c0 / span); x <= Math.floor(Math.min(width - 1e-6, tile.c1) / span); x++) {
            const entry = descriptors[`${source.level}/${x}/${z}`];
            if (entry) result.push(entry);
          }
        }
        if (result.length && result.every(entry => !unavailable.has(entry.key))) return result;
      }
      throw new Error('No available terrain source for display patch');
    }
    function reset(step) {
      if (step === baseStep) return;
      baseStep = step;
      nodes.clear();
      committedSplits.clear();
      let top = step;
      while (top * CELLS < Math.max(width, height)) top *= 2;
      root = node(top, 0, 0);
    }
    function cells(tile) {
      return (tile.rows - 1) * (tile.cols - 1);
    }

    // Input score is projected screen error in pixels; spend the refinement budget where detail is most needed.
    // Separate 2.4/1.5-pixel thresholds and priority for existing splits suppress threshold oscillation.
    function select({
      step,
      budget,
      limit,
      score
    }) {
      reset(step);
      const leaves = new Map([[root.key, root]]);
      let cost = cells(root);
      const queue = [root];
      while (queue.length) {
        queue.sort((a, b) => priority(b) - priority(a) || a.key.localeCompare(b.key));
        const tile = queue.shift();
        const threshold = committedSplits.has(tile.key) ? 1.5 : 2.4;
        if (score(tile) <= threshold || tile.step <= step) continue;
        const next = children(tile);
        const increase = next.reduce((sum, child) => sum + cells(child), 0) - cells(tile);
        if (cost + increase > budget || leaves.size + next.length - 1 > limit) continue;
        cost += increase;
        leaves.delete(tile.key);
        for (const child of next) {
          leaves.set(child.key, child);
          queue.push(child);
        }
      }
      function priority(tile) {
        return score(tile) * (committedSplits.has(tile.key) ? 1.3 : 1);
      }
      // Geometry signatures include adjacent patches and coarser endpoint owners only, so local LOD changes do not invalidate the entire cache.
      const selected = [...leaves.values()].sort((a, b) => a.key.localeCompare(b.key));
      return selected.map(tile => {
        const context = new Map(selected.filter(other => touches(tile, other)).map(other => [other.key, other]));
        for (const entry of context.values()) {
          for (const other of selected) {
            if (other.step > entry.step && touches(entry, other)) context.set(other.key, other);
          }
        }
        const neighbors = [...context.values()];
        return {
          ...tile,
          neighbors,
          cacheKey: `${tile.key}|${neighbors.map(t => t.key).sort().join(';')}`
        };
      });
    }
    function commit(selected) {
      committedSplits = new Set();
      for (const leaf of selected) {
        let step = leaf.step,
          x = leaf.x,
          z = leaf.z;
        while (step < root.step) {
          step *= 2;
          x = Math.floor(x / 2);
          z = Math.floor(z / 2);
          committedSplits.add(node(step, x, z).key);
        }
      }
    }
    async function sample(tile, load) {
      const sources = sourceTiles(tile);
      const values = await Promise.all(sources.map(load));
      const lookup = new Map(sources.map((source, index) => [source.key, {
        source,
        data: values[index]
      }]));
      const sourceStep = sources[0].step,
        span = sourceStep * 256;
      const output = new Uint16Array(tile.rows * tile.cols);
      for (let r = 0; r < tile.rows; r++) for (let c = 0; c < tile.cols; c++) {
        const row = Math.min(tile.r1, tile.r0 + r * tile.step);
        const col = Math.min(tile.c1, tile.c0 + c * tile.step);
        const key = `${sources[0].levelKey}/${Math.floor(Math.min(width - 1e-6, col) / span)}/${Math.floor(Math.min(height - 1e-6, row) / span)}`;
        const entry = lookup.get(key);
        if (!entry?.source.file) {
          output[r * tile.cols + c] = NODATA;
          continue;
        }
        const {
          source: s,
          data
        } = entry;
        const cc = Math.min(s.cols - 2, Math.floor((col - s.c0) / s.step));
        const rr = Math.min(s.rows - 2, Math.floor((row - s.r0) / s.step));
        const u = (col - s.c0 - cc * s.step) / (Math.min(s.c1, s.c0 + (cc + 1) * s.step) - s.c0 - cc * s.step);
        const v = (row - s.r0 - rr * s.step) / (Math.min(s.r1, s.r0 + (rr + 1) * s.step) - s.r0 - rr * s.step);
        const k = rr * s.cols + cc;
        const ids = u + v <= 1 ? [k, k + 1, k + s.cols] : [k + 1, k + s.cols, k + s.cols + 1];
        const weights = u + v <= 1 ? [1 - u - v, u, v] : [1 - v, 1 - u, u + v - 1];
        // Ignore zero-weight NoData at exact valid source nodes; do not extrapolate across missing regions.
        output[r * tile.cols + c] = ids.some((id, i) => weights[i] > 1e-8 && data[id] === NODATA) ? NODATA : Math.round(ids.reduce((sum, id, i) => sum + data[id] * weights[i], 0));
      }
      return output;
    }
    function at(items, r, c) {
      let lookup = lookupCache.get(items);
      if (!lookup) {
        const first = items.values().next().value?.tile;
        if (!first) return null;
        lookup = {
          virtual: first.virtual,
          base: first.key.split('/')[1],
          steps: [...new Set([...items.values()].map(item => item.tile.step))].sort((a, b) => a - b)
        };
        lookupCache.set(items, lookup);
      }
      if (lookup.virtual) {
        for (const step of lookup.steps) {
          const x = Math.floor(Math.min(width - 1e-6, c) / (CELLS * step));
          const z = Math.floor(Math.min(height - 1e-6, r) / (CELLS * step));
          const item = items.get(`patch/${lookup.base}/${step}/${x}/${z}`);
          if (item) return item;
        }
      } else {
        for (const item of items.values()) {
          const t = item.tile;
          if (r >= t.r0 && r <= t.r1 && c >= t.c0 && c <= t.c1) return item;
        }
      }
      return null;
    }
    return {
      select,
      commit,
      sample,
      at,
      sourceTiles,
      overlaps,
      touches
    };
  }
  global.NotoTerrainLOD = {
    create
  };
})(window);
