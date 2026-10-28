# Code guide

Current runtime baseline: October 28, 2026. All paths below are relative to the directory containing `index-1m.html`.

## Structure

```text
./
├── index-1m.html
├── start-viewer.cmd
├── src/
│   ├── terrain.js
│   ├── terrain-lod.js
│   ├── terrain-refinement.js
│   ├── temporal-reconstruction.js
│   ├── geometry-worker.js
│   ├── tile-geometry.js
│   ├── coastal-geometry.js
│   ├── model-volume.js
│   ├── material-textures.js
│   ├── rock-materials.js
│   ├── water-materials.js
│   ├── water-motion.js
│   ├── scene-effects.js
│   ├── environment.js
│   ├── ground-grass.js
│   ├── vegetation.js
│   └── styles.css
├── scripts/
├── data/
│   ├── terrain-1m/manifest.js
│   ├── terrain-1m/L0/ ... L7/
│   ├── terrain-1m/S3/ ... S7/
│   ├── shoreline-data.js
│   ├── strata-data.js
│   ├── vegetation-data.js
│   └── material-texture-config.js
├── assets/
│   ├── material-library/
│   └── vegetation/
├── gis/vegetation/
├── noto_terrain_materials_package/
├── source-data/terrain/
├── vendor/
└── docs/
```

Large runtime/source assets may be distributed separately; their paths after installation remain as shown. `S3` through `S7` is shorthand here for the additional `S3`, `S5`, `S6` and `S7` directories; native 4 m data already exists in `L2`.

| Module | Responsibility |
| --- | --- |
| `terrain.js` | Scene setup, asynchronous loads, caches, camera safety, settings, performance feedback and frame scheduling |
| `terrain-lod.js` | Distance-based nested display patches, selection hysteresis, source resampling and display-patch lookup |
| `terrain-refinement.js` | Progressive local split/merge transactions, near-region priority and displayed-topology validation |
| `temporal-reconstruction.js` | Jittered image reconstruction, static-surface reprojection, history rejection and bounded GPU targets |
| `geometry-worker.js` | Dedicated Worker, transferable geometry buffers, compact seam/normal messages and main-thread reconstruction |
| `tile-geometry.js` | Land/water classification, terrain triangles, mixed-detail edges and shared normals |
| `coastal-geometry.js` | Continuous shoreline clipping, coastal refinement and display contact profile |
| `model-volume.js` | Exposed outer walls and the −100 m bottom |
| `material-textures.js` | Shared color/detail texture arrays and file/HTTP loading |
| `rock-materials.js` | Geological queries, triplanar PBR, categorical blending and ground cover |
| `water-materials.js`, `water-motion.js` | Procedural water textures, geometric waves, normals, reflection approximation and foam |
| `scene-effects.js` | Pointer flashlight and bounded GPU coastal spray |
| `environment.js` | GMT+9 sun position, day/night lighting, weather, shadows and GPU rain |
| `vegetation.js`, `ground-grass.js` | Stable plant locations, shape/detail variants, grass, surface attachment and shared wind animation |
| `styles.css` | Panels, controls, dialogs and narrow-window layout |

## Startup and resource flow

The HTML uses deferred ordinary scripts. Third-party libraries and the terrain manifest load first; geological configuration precedes material factories. Shared water/shoreline and environment modules precede geometry. Vegetation data and model/grass payloads precede the vegetation runtime. `geometry-worker.js` loads after its geometry dependencies. `terrain-lod.js` and `terrain-refinement.js` load before the final orchestrator, `terrain.js`.

`temporal-reconstruction.js` loads before the final orchestrator. `terrain.js` decompresses the bundled Three.js modules, prepares the shared classification and texture resources, creates the scene and loads terrain input. Input files call `window.NOTO_TILE_RECEIVE(key, payload)` with compressed height arrays. Heights decode as `uint16 / 100 - 100` metres, with 65535 reserved for NoData.

Geometric and material resources are prepared off the active set. A local split/merge transaction replaces one parent or its displayed descendants, together with neighbors whose seam context changes. Existing coverage remains visible while that transaction builds; unrelated regions do not wait for the full final selection. Independent patch resources are released on cache eviction; shared material arrays, water textures and vegetation resources belong to their factories, not individual terrain patches.

## Background geometry and bounded plant updates

`geometry-worker.js` builds a named dedicated Worker from local module initializer sources and a Blob URL. It imports its own encoded copy of the already decoded Three.js core source, avoiding cross-realm opaque-origin Blob imports. This avoids fetching local source scripts from a `file://` page; both direct-file and localhost entry modes use the same geometry implementation. The Worker has no renderer or WebGL context.

The ocean mask and shoreline inputs are copied once during initialization. Each build receives only its patch, loaded neighbor heights and compact completed coarse-edge geometry. Terrain topology, coastal refinement, mixed-detail constraints, vertex normals and bounds are computed in the Worker. Newly owned output ArrayBuffers are transferred back; live height caches and visible geometry are never transferred or detached. The main thread restores BufferGeometry wrappers, reattaches displayed-surface height queries and creates materials/scene objects.

Boundary vertex indices, positions and original normals are prepared in the Worker. Before each local commit, compact boundary data for the display frontier is averaged there; the main thread applies the returned values and uploads only changed normal buffers. A displayed-topology and user-grid check rejects stale commits, while ordinary camera changes allow useful local work to complete. Existing complete coverage stays visible throughout construction. Worker startup/runtime failure selects an explicit compatibility fallback, exposed with its reason in `terrainViewer.getState().geometryWorker`; the fallback uses the original main-thread geometry algorithm.

Plant and grass placement use cooperative generators with a 3 ms target slice. Candidate scans, distance sorting and instance preparation span multiple requested frames. A completed snapshot replaces the old instance set atomically. Camera motion schedules a later snapshot without continually restarting the current one; terrain/settings invalidation cancels stale work. Shared GPU attributes retain their identities and upload only populated ranges. This is bounded main-thread scheduling, not a plant Worker or a guarantee that every individual operation completes within 3 ms.

## Terrain data and local LOD

The 1 m source crop contains 33,226 × 23,136 nodes over 33,225 × 23,135 m. Native input tiles have at most 256 cells per side. Input steps are 1–8 m plus 16/32/64/128 m; the 3/5/6/7 m inputs use exact native node samples. Display sorting indices and input callback keys are separate fields.

The default finest display spacing is 5 m. `terrain-lod.js` uses a nested doubling sequence derived from that setting, such as 5/10/20/40/80/160 m. Display patches contain at most 128 cells per side and form complete, nonoverlapping coverage. They are independent of input-file rectangles. Nodes are sampled from the nearest suitable available input through triangle interpolation, preserving NoData rather than inventing elevations across gaps.

The selection budget prioritizes projected error near the camera. A 30% view buffer and a 1 km camera neighborhood reduce sensitivity to small orientation changes. Split and merge thresholds are 2.4 and 1.5 pixels; committed splits receive priority. Selection requests are coalesced at 80 ms without resetting the timer on every movement. These rules reduce oscillation but do not promise unchanged geometry during large movement or sustained overload.

Fine boundary nodes first follow coarse triangle interpolation. The final fine land/water edges then match the actual coarse edges, including coastal subdivisions. Water edge attributes identify coarse endpoints so the vertex shader interpolates their wave displacements. This keeps mixed-detail water edges together while they animate. Collision and plant placement query the active display patches rather than assuming one scene-wide level.

A coarse 128 m starting surface provides initial coverage; inputs at 16 m and coarser are preloaded. Missing inputs affect only patches that need them, which select a coarser available source. Geometry cache keys include neighboring edge context. A coastal patch may ignore same/finer neighbors only when its original local ownership has no unresolved cells and there is no coarser context. Such a patch bypasses neighbor-dependent interior walls, so its geometry remains valid as finer neighbors change. All other patches retain the full context. Equivalent cache entries own their resources only once. Active, building, pending and in-progress transaction resources are protected from eviction.

`terrain-refinement.js` turns the final selection into local transactions. It prioritizes desired nearby descendants, refines a bounded subtree inside one displayed parent (up to three levels along the highest-priority branch) and merges complete descendant sets when coarser detail is needed. Actual allocated cell/object budgets control whether a merge must precede nearby refinement; a smaller final target alone does not force a distant merge first. Incompatible startup/user grids first establish aligned coarse coverage. Within a transaction, completed unchanged patches are reused and changed coarse endpoint owners build before fine patches. Up to 12 nearby patch sample reads start ahead of those builds. A complete local group commits immediately; the remaining target continues in the background. Camera movement updates the next target without discarding valid current work. User grid changes invalidate incompatible work. `terrainViewer.getState().refinement` exposes commit count/type, pending group size and target size.

The initial base-cell budget is approximately 2 × 1024² on the higher starting tier, or 1 × 1024² otherwise. At most 384 display patches are selected. Cache targets and the memory-limited effective budget may further constrain detail; coastal subdivisions add geometry beyond the base-cell count. These are estimates and soft budgets, not measured VRAM limits.

## Coast and volume

Land and sea are clipped against the same zero contour of an 8 m sampled and smoothed shoreline-distance field. Shared edge intersection rules prevent independent boundary estimates from opening gaps. Coastal contour segments are refined to at most 8 m, with a 0.03 m distance-field residual target and a 0.5 m recursion floor. These values describe approximation to the display field, not survey accuracy.

Inside the coast, the nearest 16 m is held at mean sea level. A smooth transition restores the original displayed height over the following 48 m. A 72 m coastal band retains fine triangles for local wave/contact effects. This display contact profile is separate from the unchanged source DEM. The outer model boundary closes at −100 m; no real seabed bathymetry is inferred.

## Geological shading and grass

`strata-data.js` contains a preliminary 223 × 13 × 156 categorical field with roughly 150 m horizontal spacing. It combines registered reference sections, regional geological polygons and local borehole templates. Category IDs are discrete; the shader blends appearance weights instead of interpolating identifiers. The 1 m DEM does not imply 1 m geological confidence.

There are 27 land categories and shared 29-layer color/detail arrays. Color images use sRGB; detail RGB stores OpenGL normals and A stores roughness. Triplanar projection covers slopes and cuts. Deterministic rotations/offsets and continuous noise mixing reduce repetition; explicit derivatives, mipmaps and anisotropic filtering limit minification artifacts. Materials do not displace geometry.

Boundary appearance uses a 3 × 3 × 3 classification neighborhood. Nominal horizontal/vertical blending half-widths are 192/9.6 m, limited by classification spacing and thin-layer constraints. Homogeneous neighborhoods use a cheaper equivalent path. Blending widths are visual parameters, not measured geological contact widths.

Real 2024 vegetation classes control forest/herb cover. Soil-family bare-ground pixels also receive illustrative grass through a separate smoothed mask. Urban, water, facilities, NoData and reef classes remain excluded. Steep slopes expose underlying geological PBR; walls and bottom do not receive grass.

`ground-grass.js` uses fixed 0.8 m candidate spacing, deterministic variation and shared instanced geometry containing 12/6/3 blades per tuft. Grass fades over 55–80 m; the ground texture remains farther away. Detail changes blade count while keeping tuft positions. Root positions follow actual displayed triangles, and natural plant height is independent of vertical exaggeration.

## Plants, water and environment

Trees use a stable 12 m placement grid and four broadleaf/four conifer shape variants derived from shared source assets. Near/middle meshes and distant cards share deterministic shape, size and orientation choices. Instances fade over 1200–1500 m. Geometry budgets can switch representation without randomly thinning the forest. Nearby herb/fern models and grass have separate bounded pools.

Forest broadleaf height ranges from 12–22 m and conifer height from 18–30 m; orchard and low woody forms use 4–8 m and 6–11 m respectively. Height and crown-width variation follow stable instance seeds. To keep the trunk attached, each shape derives one root origin from its near-detail trunk: the minimum Y and the mean X/Z of vertices in the bottom 0.1 m band. Every material and mesh detail level shares this translation, and cards are baked from the aligned prototype. Placement samples the active displayed surface at the original plant location and embeds the root by 0.12 m. Plant size stays in natural metres as terrain exaggeration changes.

The independent `Show grass` and `Show trees` settings default to enabled. Grass visibility gates instanced blades, herb/fern models and ground-cover shading; tree visibility gates all tree mesh/card levels. The vegetation detail setting still determines geometry quality, and Off hides all 3D plants. Visibility changes reuse the shared resources and request an update through the main scheduler.

Water combines three Gerstner components with wavelengths of 512/192/72 m, matching normals, four-scale scrolling detail, a sky-gradient reflection approximation, shore crests, foam and wetness. Wave amplitude remains in physical metres when terrain height is exaggerated. Coarse-grid filtering suppresses undersampled geometric waves; small ripples continue through normals. Nearshore GPU spray has a bounded particle pool. These effects are parameterized visual animation, not fluid simulation.

The environment uses a NOAA-style solar approximation at the model center, selected date and fixed GMT+9 time. Clear/cloudy/rainy presets affect sky, fog, lights, waves and rain. Local PCF shadows follow the view and reuse their map when possible. The pointer flashlight ray-tests the displayed height field instead of traversing every terrain triangle. Rain, spray and wind use GPU animation and the shared scene clock.

## Rendering and adaptation

Only one frame request can be pending. Inputs, settings and completed resources request scene updates. Animation-only frames advance shared uniforms and draw, without repeating terrain selection or vegetation distribution. By default, visible animation continues for 30 seconds after the last interaction; then time and drawing stop. Image reconstruction can finish a bounded settling sequence without advancing sleeping water, rain or wind clocks. Hidden pages and open dialogs pause idle animation. Cached resources remain allocated during sleep.

### Temporal reconstruction and history rejection

The settings checkbox enables a local GPU reconstruction pass when float color targets and multiple render attachments are supported. The scene is shaded at 75% of the output width and height with a short subpixel jitter sequence. Two full-output ping-pong targets retain linear-light color and surface metadata. The final pass applies the renderer's output color conversion. UI text remains ordinary HTML. Direct rendering remains available through the checkbox and is the fallback for unsupported devices, excessive target sizes or setup failures.

For a static opaque surface, the current depth reconstructs its world position. The previous view-projection matrix finds its history location. History is rejected behind the camera, outside the previous image, or when previous depth or depth-derived world normal disagrees. All four metadata taps associated with the bilinear color lookup must pass, so a thin foreground edge cannot contaminate a newly revealed background through interpolation. Accepted history is clamped to the current 3 × 3 color neighborhood; luminance disagreement reduces its weight. This is geometric normal validation, not storage of PBR normal-map details.

Regional views use a near plane between 0.5 and 16 m, derived only from camera clearance outside the model bounding box with a 64 m plant/wave allowance. Inside or near the model it remains 0.5 m. This improves depth precision over tens of kilometres without clipping bounded terrain; the nearest camera-local rain can be clipped in remote views. Reprojection retains the previous matrices and fixed-scale linear-depth metadata, so ordinary near/far updates do not reset history.

Water, instanced plants, transparent content and custom shader effects are reactive: a temporary separate-alpha blend marks them as current-frame-only without changing their RGB blend. Coastal land patches are also reactive because their foam and wetness animate. Material state and the camera's unjittered projection/inverse are restored after each render. The implementation deliberately does not reuse dynamic-surface history or claim per-object motion-vector reconstruction.

Explicit resets cover time/date/weather changes, pointer-light changes, committed terrain/plant geometry, vertical scale, plant visibility/detail, canvas changes and hidden-page transitions. Camera cuts and long gaps also discard history; ordinary camera motion uses reprojection instead of globally clearing every frame. The existing scheduler supplies at most eight settling attempts. Long-frame gaps do not rearm that budget indefinitely. There is no separate render loop, polling timer or per-frame CPU pixel readback.

`terrainViewer.getState().temporal` reports requested/active state, fallback reason, dimensions, history age and reset counters. `renderedFrames` counts presented viewer frames; draw/triangle counters include the scene and reconstruction passes. Lower input resolution is a deliberate shading-cost tradeoff: newly revealed and reactive surfaces cannot gain missing samples from old frames. Disable reconstruction when comparing native direct detail. This is a small WebGL reconstruction implementation, not DLSS/FSR or a promise of ghost-free output in every scene.

Performance feedback uses consecutive rendered-frame intervals and asynchronous GPU timing where available. Loading/building intervals and the first wake-up frame are excluded. Sustained slow windows reduce local terrain budgets and automatic canvas/plant detail; sustained fast windows restore them gradually. Both adjustment directions have a 6-second cooldown. Manual canvas and vegetation settings are not overwritten. Hardware hints choose the initial tier, while measured load drives later adaptation.

`terrainViewer.getState()` exposes Worker mode/build/attachment timings, pending plant placement and accumulated placement CPU time, actual grid spacings, `lodMode: "distance-adaptive"`, cache/build counters, estimated geometry memory, frame/GPU timing, graphics-device information, vegetation/grass counts and environment/water state. Estimated memory is not a VRAM measurement; `powerPreference` is a request rather than proof of discrete-GPU selection.

## Maintenance and rebuilding

Use two-space indentation for JavaScript/HTML/CSS and four spaces for Python. Explain coordinates, units, boundary constraints and ownership in comments. Do not manually format compressed payloads, original assets or third-party code. Routine viewer edits do not require DEM regeneration.

| Change | Primary files |
| --- | --- |
| Interface text/layout | `index-1m.html`, `src/styles.css` |
| Navigation, caches or performance feedback | `src/terrain.js` |
| Image reconstruction and history validation | `src/temporal-reconstruction.js`, scheduler hooks in `src/terrain.js` |
| Distance detail, coverage or input sampling | `src/terrain-lod.js` |
| Surface topology and mixed-detail edges | `src/tile-geometry.js`, `src/coastal-geometry.js`, `src/model-volume.js` |
| Geological appearance | `src/rock-materials.js`, `data/material-texture-config.js` |
| Water and surf | `src/water-materials.js`, `src/water-motion.js`, `src/scene-effects.js` |
| Plant coverage/detail and soil grass | `src/vegetation.js`, `src/ground-grass.js` |
| Sun, weather and shadows | `src/environment.js` |

See [REBUILD.md](REBUILD.md) for source locations, dependencies and portable rebuild commands. `scripts/build_grass_ground.py` adds the current grass texture payload from the retained `grass_ground` source images. Ordinary source changes should be checked in the browser without regenerating unrelated datasets.

The dated [progress report](docs/COMP5411_Progress_Report_EN.md) preserves October 18 measurements. Its uniform-visible-LOD description is historical; this guide describes the current local selection. Targeted October 19 checks covered all 12 detail limits, selection coverage/budget/fallback, mixed land/water edges, stable small camera turns, grass attachment, sleep and file/HTTP loading. October 20 checks covered tree attachment across representative detail limits and 1/5/10 height scales, independent grass/tree visibility combinations, sleep and both entry modes. Full device coverage, long navigation sessions and final presentation acceptance remain incomplete.

## Focused regression tests

Run `node --test tests/geometry-worker.test.cjs tests/terrain-refinement.test.cjs tests/terrain-refinement-geometry.test.cjs` with Node.js 22 or newer. Tests use real worker threads, the bundled Three.js core and generated terrain/coast fixtures. They cover transferred topology and attribute parity, height queries, mixed-detail water edges, boundary normals, caller buffer ownership, stale commits and compatibility fallback. No DEM download or npm installation is required. Progressive tests also check full coverage throughout local transitions, selection priority, merging and stale-topology rejection. Browser rendering and interaction still need separate checks.

For the synthetic WebGL history test, install Playwright in a separate test environment and run `node --test tests/temporal-browser.test.cjs`. Set `REQUIRE_TEMPORAL_GPU=1` to treat a missing browser dependency as a failure, and `TEMPORAL_BROWSER_CHANNEL=msedge` to use installed Edge. Without Playwright this optional test is explicitly skipped; the viewer itself gains no dependency. `tests/temporal-scene.html` can also be opened through the local server. The fixture checks a camera pan across a thin contrasting occluder, lighting changes, reactive surfaces, static accumulation, camera matrix restoration, resize, disable/fallback and finite settling. It uses generated geometry and the bundled Three.js library, with no DEM or model download.
