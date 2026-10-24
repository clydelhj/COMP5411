# Maintenance handoff

Baseline date: October 24, 2026. Project: **Noto Peninsula: An Interactive 3D Landscape**, COMP5411 Group 12, LEE Hyunjin and TAN Jiming.

## Entry and documentation

- `index-1m.html`: current viewer, using the post-earthquake 1 m DEM and a default finest display spacing of 5 m.
- `start-viewer.cmd` or `python scripts/serve.py`: optional local HTTP launch. The server uses loopback and an available port; Ctrl+C stops it.
- `CODE_GUIDE.md`: current architecture, data flow, constraints and modification locations.
- `REBUILD.md`: offline dependencies and regeneration commands.
- `TEXTURE-SOURCES.md`, `LICENSES-AND-SOURCES.md`: asset sources, channel conventions and terms.
- `docs/COMP5411_Proposal.pdf`: proposal and course-week milestones.
- `docs/COMP5411_Progress_Report_EN.md`: dated October 18 progress report, including then-current measurements and figures. Current architecture is described in `CODE_GUIDE.md`.

Keep runtime paths relative to the root. Asset distribution instructions govern any large files outside Git. Running the viewer does not require opening or processing the original TIFF, contacting external services, or installing npm dependencies.

## Current integrated features

- Local distance-adaptive terrain patches, dedicated Worker geometry construction and boundary-normal averaging, retained coverage, mixed-detail stitching, bounded caches and camera safety.
- Continuous coastline clipping independent of display spacing, closed exposed walls and a −100 m model bottom.
- Geological PBR categories with triplanar projection, continuous boundary blending and randomized texture sampling.
- Real-classification-driven representative plants, deterministic locations and tree-shape variants; soil grass texture and nearby instanced blades, with independent grass/tree visibility settings and cooperative placement preparation.
- Geometric waves, nearshore crests, foam/wetness and GPU spray with a shared clock.
- GMT+9 date/time, clear/cloudy/rainy presets, day/night lights, local shadows, GPU rain and pointer flashlight.
- Performance-based terrain/canvas/plant budgets and default 30-second idle animation followed by sleep.

## Conventions to preserve

The English interface shows title, one-line two-decimal latitude/longitude bounds and one author per line. The time slider is at the upper right and the vertical-scale slider is at the bottom. Vertical exaggeration defaults to 1:5 and ranges from 1:1 to 1:10. It changes display height, not source elevation or natural plant dimensions. Model coordinates are metres: X east, Y up, Z south.

The terrain setting limits the finest permitted spacing, default 5 m, with 1–8 m and 16/32/64/128 m choices. It is not a resolution lock. `Near grid` reports the finest visible land patch. Window render resolution and plant detail default to Auto; their manual modes remain under user control. Settings are session-only.

`Show grass` and `Show trees` both default to enabled. Grass visibility includes ground-cover shading, blades and herb/fern models; tree visibility applies to every mesh/card detail level. Vegetation detail Off hides all 3D plants without overriding the ground-cover visibility setting.

Forest broadleaf trees use 12–22 m heights and conifers 18–30 m; orchard and other low woody forms use 4–8 m and 6–11 m. Preserve deterministic placement and crown variation. Each shape aligns all mesh levels to the root derived from the bottom 0.1 m of its near-detail trunk, then bakes its cards from that alignment. Root placement uses the active displayed surface with 0.12 m embedding. Do not attach trees by the crown-centered source origin or multiply natural plant dimensions by terrain exaggeration.

`terrain-lod.js` selects complete, nonoverlapping nested display patches with up to 128 cells per edge, using a doubling sequence from the selected detail limit. Near terrain receives priority; far terrain can be coarser. Selection has split/merge hysteresis, a view buffer and a camera neighborhood. Keep the previous complete set visible until the replacement and its seam constraints are ready. Input tile levels and display patch levels have distinct roles; do not combine nonaligned source-file rectangles as display leaves.

Mixed-detail land edges match the actual coarse surface, including shoreline subdivisions. Animated water edges interpolate the same coarse endpoint wave displacements. Plant roots and collision queries use the displayed surface. Water-wave filtering follows the user detail setting, rather than changing its global parameters whenever patch arrangement changes.

Keep shared material arrays, water resources and plant resources owned by their factories. Evict only independent per-patch resources. Cached resources remain allocated during sleep. `geometry-worker.js` owns background construction, with compact transferable outputs and explicit fallback diagnostics. Do not transfer buffers owned by visible meshes or the raw cache. Plant preparation uses the existing frame scheduler with a 3 ms target slice; retain old instances until a complete, current replacement is ready. No module should introduce a separate animation loop or polling timer for effects; the main scheduler controls shared time, visibility, dialogs and idle sleep.

The renderer requests high performance, but browser/driver/system policy chooses the device. Do not describe this request as a forced GPU switch. Use `terrainViewer.getState().graphics.renderer` when the browser exposes it.

## Sources and visual interpretation

The displayed region spans 33,225 × 23,135 m and approximately 37.33–37.54° N, 137.00–137.38° E. The DEM has 1 m source spacing; geological categories have roughly 150 m horizontal display spacing, and real vegetation classification is approximately 10 m for 2024. These resolutions are not interchangeable.

The coast comes from an 8 m sampled/smoothed distance field. A 64 m display profile joins land to mean sea level, with the nearest 16 m held at sea level. This is a visual contact treatment, not a surveyed shore profile. The bottom is a truncation surface, not real seabed. Geological extrapolation, borehole influence areas, blended boundaries, representative plants, extra soil grass and water/weather effects are visualization approximations. Original DEM and source GIS categories remain unchanged.

Asset terms differ: CC0 material/model assets do not make the complete project CC0. Consult the supplied source records before distribution beyond the course context.

## Proposal status and remaining scope

| Proposal stage | Integrated work | Remaining acceptance |
| --- | --- | --- |
| Terrain and camera | DEM mesh, navigation and camera safety | Extended route/loading coverage |
| Week 4: materials | Geological PBR, blending and filtering | Wider view/lighting inspection |
| Week 5: vegetation/progress | Real classification, instancing, tree variation and grass | Representation transitions and progress video |
| Week 6: water | Waves, foam, wetness and spray | More coastline/weather combinations |
| Weeks 7–8: sun/weather | Time/date, light, shadows and rain | Long sessions and device comparisons |
| Week 9: adaptive detail | Local LOD, caches, GPU/frame feedback and sleep | Sustained performance/memory evaluation |
| Week 10: final integration | Targeted integration checks available | Final demo, report and comprehensive acceptance |

October 20 targeted checks covered tree attachment at representative detail limits and 1/5/10 height scales, grass/tree visibility combinations, sleep and file/HTTP entries. October 19 checks covered all 12 detail limits for selection coverage, overlap, budget and fallback; representative mixed-detail land/water seams; five small camera turns retaining 5 m without new builds; grass surface attachment; and idle wake-up feedback. October 18 scene checks covered geometric coast contact, CPU/GPU wave agreement, time/weather, pointer light and the default 30-second freeze. These checks do not guarantee fixed frame rate or finest detail in every view on every device.

An unavailable fine input remains in the terrain manifest. Do not restore or read quarantined content or change security settings as part of ordinary maintenance. Affected display patches must use available coarser source data. Full fine-source coverage, long-duration performance and final submission materials remain open.
