/* Plan one complete local LOD replacement while retaining coverage everywhere else. */
(function registerTerrainRefinement(global) {
  'use strict';

  function create({ lod, metadata }) {
    const width = metadata.source_width - 1;
    const height = metadata.source_height - 1;
    const contains = (outer, inner) => outer.c0 <= inner.c0 && outer.c1 >= inner.c1 && outer.r0 <= inner.r0 && outer.r1 >= inner.r1;
    const area = tile => (tile.c1 - tile.c0) * (tile.r1 - tile.r0);
    const cost = tile => Math.ceil((tile.c1 - tile.c0) / tile.step) * Math.ceil((tile.r1 - tile.r0) / tile.step);
    const baseOf = tile => tile?.virtual && tile.key.startsWith('patch/') ? Number(tile.key.split('/')[1]) : null;
    function tilesOf(items) {
      const values = items instanceof Map ? [...items.values()] : Array.from(items || []);
      return values.map(item => item.tile || item);
    }
    function signature(items) {
      return tilesOf(items).map(tile => tile.cacheKey || tile.key).sort().join('\n');
    }
    function transaction(type, previous, replacement, baseStep, changedRegion = null) {
      // Recompute every affected seam signature, including a coarse endpoint owner's context.
      const tiles = lod.decorate(replacement);
      const before = new Map(previous.map(tile => [tile.key, tile]));
      const after = new Map(tiles.map(tile => [tile.key, tile]));
      return {
        type,
        baseStep,
        tiles,
        region: changedRegion,
        beforeSignature: signature(previous),
        signature: signature(tiles),
        changedKeys: tiles.filter(tile => (before.get(tile.key)?.cacheKey || before.get(tile.key)?.key) !== (tile.cacheKey || tile.key)).map(tile => tile.key),
        addedKeys: tiles.filter(tile => !before.has(tile.key)).map(tile => tile.key),
        removedKeys: previous.filter(tile => !after.has(tile.key)).map(tile => tile.key)
      };
    }
    function next(liveItems, desiredTiles, priorityFn = () => 0, limits = {}) {
      const previous = tilesOf(liveItems);
      const desired = tilesOf(desiredTiles);
      if (!desired.length) return null;
      const baseStep = baseOf(desired[0]);
      if (!(baseStep > 0) || desired.some(tile => baseOf(tile) !== baseStep)) throw new Error('Progressive terrain requires one nested display grid');
      if (!previous.length || previous.some(tile => baseOf(tile) !== baseStep)) {
        // Native startup grids and user detail changes can have incompatible nodes. Establish
        // an aligned coarse cover first instead of waiting for the final fine frontier.
        return transaction('bootstrap', previous, lod.coarse(baseStep), baseStep);
      }
      const priority = tile => {
        const value = Number(priorityFn(tile));
        return Number.isFinite(value) ? value : 0;
      };
      const currentCost = previous.reduce((sum, tile) => sum + cost(tile), 0);
      const targetCost = desired.reduce((sum, tile) => sum + cost(tile), 0);
      // The final view can use less than the allocated budget. Nearby refinement may spend
      // that available capacity before reclaiming distant detail from the previous view.
      const budget = Number.isFinite(limits.budget) && limits.budget >= 0 ? limits.budget : targetCost;
      const limit = Number.isFinite(limits.limit) && limits.limit >= 0 ? Math.floor(limits.limit) : desired.length;
      const present = new Set(previous.map(tile => tile.key));
      const splits = [];
      const merges = [];
      for (const parent of previous) {
        const finer = desired.filter(tile => tile.step < parent.step && contains(parent, tile));
        if (!finer.length) continue;
        const children = lod.children(parent);
        if (!children.length) continue;
        splits.push({
          parent, children,
          score: Math.max(...finer.map(priority)),
          increase: children.reduce((sum, child) => sum + cost(child), 0) - cost(parent)
        });
      }
      for (const parent of desired) {
        if (present.has(parent.key)) continue;
        const children = previous.filter(tile => contains(parent, tile));
        if (!children.length || children.some(tile => tile.step >= parent.step)) continue;
        // A merge is legal only after every displayed descendant inside the parent is covered.
        // Integer source-grid rectangles make the area equality exact, including cropped edges.
        if (children.reduce((sum, child) => sum + area(child), 0) !== area(parent)) continue;
        merges.push({
          parent, children,
          score: priority(parent),
          saved: children.reduce((sum, child) => sum + cost(child), 0) - cost(parent)
        });
      }
      splits.sort((a, b) => b.score - a.score || a.parent.key.localeCompare(b.parent.key));
      merges.sort((a, b) => b.saved - a.saved || a.score - b.score || a.parent.key.localeCompare(b.parent.key));
      const split = splits[0];
      // Reclaim distant oversampling before a new split would exceed the requested cost/count.
      // Otherwise, spend the next construction job on the most important nearby region.
      const needsSpace = split && (currentCost + split.increase > budget || previous.length + split.children.length - 1 > limit);
      if (merges.length && (!split || needsSpace)) {
        const merge = merges[0];
        const removed = new Set(merge.children.map(tile => tile.key));
        return transaction('merge', previous, previous.filter(tile => !removed.has(tile.key)).concat(merge.parent), baseStep, merge.parent);
      }
      if (split && !needsSpace) {
        // Refine one short local branch together so expensive coarse coastal neighbors are
        // rebuilt once, rather than once per level. Three levels add at most ten local leaves.
        let replacement = split.children;
        let proposedCost = currentCost + split.increase;
        for (let depth = 1; depth < 3; depth++) {
          const branches = replacement.map(parent => ({
            parent,
            finer: desired.filter(tile => tile.step < parent.step && contains(parent, tile))
          })).filter(branch => branch.finer.length);
          branches.sort((a, b) => Math.max(...b.finer.map(priority)) - Math.max(...a.finer.map(priority)) || a.parent.key.localeCompare(b.parent.key));
          const branch = branches[0];
          if (!branch) break;
          const children = lod.children(branch.parent);
          if (!children.length) break;
          const increase = children.reduce((sum, child) => sum + cost(child), 0) - cost(branch.parent);
          if (proposedCost + increase > budget || previous.length - 1 + replacement.length + children.length - 1 > limit) break;
          proposedCost += increase;
          replacement = replacement.filter(tile => tile.key !== branch.parent.key).concat(children);
        }
        return transaction('split', previous, previous.filter(tile => tile.key !== split.parent.key).concat(replacement), baseStep, split.parent);
      }
      const refreshed = transaction('refresh', previous, previous, baseStep);
      if (refreshed.changedKeys.length) return refreshed;
      return null;
    }
    function isApplicable(candidate, liveItems, baseStep = candidate.baseStep) {
      // Camera movement may change the final target, but a valid local replacement must not
      // starve. Reject only a changed displayed prerequisite or a different user grid base.
      return Number(baseStep) === candidate.baseStep && signature(liveItems) === candidate.beforeSignature;
    }
    return { next, isApplicable, signature, width, height };
  }
  global.NotoTerrainRefinement = { create };
})(typeof window !== 'undefined' ? window : globalThis);
