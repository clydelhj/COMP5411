# Code guide

Current runtime baseline: November 15, 2026. All paths below are relative to the directory containing `index.html`.

## Structure

```text
./
├── index.html
├── start-viewer.cmd
├── src/
│   ├── terrain.js
│   ├── first-person.js
│   ├── view-fullscreen.js
│   ├── data-source.js
│   ├── terrain-lod.js
│   ├── terrain-refinement.js
│   ├── terrain-upload-queue.js
│   ├── temporal-reconstruction.js
│   ├── geometry-worker.js
│   ├── tile-geometry.js
│   ├── coastal-geometry.js
│   ├── model-volume.js
│   ├── material-textures.js
│   ├── rock-materials.js
│   ├── water-materials.js
│   ├── ocean-spectrum.js
│   ├── sky-atmosphere.js
│   ├── cloud-layers.js
│   ├── water-motion.js
│   ├── ocean-reflection.js
│   ├── ocean-backdrop.js
│   ├── scene-effects.js
│   ├── environment.js
│   ├── ground-grass.js
│   ├── instance-buffers.js
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
| `first-person.js` | Surface-following driving, steering, independent camera look, orbit pose restoration and instrument dials. Land acceleration combines traction and power limits with braking, resistance and the gravity component along the physical terrain slope. Marine propulsion and drag apply offshore. |
| `view-fullscreen.js` | Fullscreen API control for the canvas and viewer interface |
| `data-source.js` | Read-only selection, validation and loading of local data folders |
| `terrain-lod.js` | Distance-based nested display patches, selection hysteresis, source resampling and display-patch lookup |
| `terrain-refinement.js` | Progressive local split/merge transactions, near-region priority and displayed-topology validation |
| `terrain-upload-queue.js` | Bounded preparation of new GPU buffers and patch textures before a local replacement |
| `temporal-reconstruction.js` | Jittered image reconstruction, static-surface reprojection, history rejection and bounded GPU targets |
| `geometry-worker.js` | Dedicated Worker, transferable geometry buffers, compact seam/normal messages and main-thread reconstruction |
| `tile-geometry.js` | Land/water classification, terrain triangles, mixed-detail edges and shared normals |
| `coastal-geometry.js` | Continuous shoreline clipping, coastal refinement and display contact profile |
| `model-volume.js` | Exposed outer walls, the −100 m bottom and compact index storage |
| `material-textures.js` | Shared color/detail texture arrays and file/HTTP loading |
| `rock-materials.js` | Geological queries, triplanar PBR, categorical blending and ground cover |
| `water-materials.js`, `water-motion.js` | Filtered micro normals, geometric waves, spectral shading, Fresnel/absorption and foam |
| `ocean-spectrum.js` | Two bounded GPU FFT wind-wave fields, gradients and crest/compression data |
| `sky-atmosphere.js` | Atmospheric gradient, sun and moon disks, and the directional sky cache |
| `cloud-layers.js` | Directional procedural cloud color and coverage used in the sky texture |
| `ocean-reflection.js` | Cached low-resolution reflection of an owned coarse terrain proxy |
| `ocean-backdrop.js` | Sky background, offshore water and the distant sea horizon |
| `scene-effects.js` | Flashlight for orbit and driving views, and bounded GPU coastal spray |
| `environment.js` | Sun and moon positions for the selected date, JST and map location, lunar phase, lighting, weather, shadows and GPU rain |
| `vegetation.js`, `ground-grass.js` | Stable plant locations, shape/detail variants, grass, surface attachment and shared wind animation |
| `styles.css` | Panels, controls, dialogs and narrow-window layout |

## Startup and resource flow

The HTML uses deferred ordinary scripts. Third-party libraries and the terrain manifest load first; geological configuration precedes material factories. Shared water/shoreline and environment modules precede geometry. Vegetation data and model/grass payloads precede the vegetation runtime, and `instance-buffers.js` precedes both grass and vegetation. `geometry-worker.js` loads after its geometry dependencies. `terrain-lod.js`, `terrain-refinement.js` and `terrain-upload-queue.js` load before the final orchestrator, `terrain.js`.

Load `sky-atmosphere.js` and `cloud-layers.js` before creating the sky and water materials. Bind the shared sky uniforms with `waterMotion.setAtmosphere()` before the first material compilation.

`temporal-reconstruction.js` loads before the final orchestrator. `terrain.js` decompresses the bundled Three.js modules, prepares the shared classification and texture resources, creates the scene and loads terrain input. Input files call `window.NOTO_TILE_RECEIVE(key, payload)` with compressed height arrays. Heights decode as `uint16 / 100 - 100` metres, with 65535 reserved for NoData.

Geometric and material resources are prepared off the active set. A local split/merge transaction replaces one parent or its displayed descendants, together with neighbors whose seam context changes. Existing coverage remains visible while that transaction builds; unrelated regions do not wait for the full final selection. Independent patch resources are released on cache eviction; shared material arrays, water textures and vegetation resources belong to their factories, not individual terrain patches.

`prepareShaderPrograms()` prepares the direct-output and linear offscreen material variants through Three.js `compileAsync()` before new terrain is published. Startup preparation includes colored plant instancing. On devices with parallel shader compilation, completion is awaited without holding a temporary render target or viewport across the wait. Without that extension, explicit preparation is restricted to loading coarse coverage. This prepares main material programs; it does not guarantee precompilation of every shadow/depth variant. `terrainViewer.getState().shaderWarmup` exposes completion and pending state.

`terrain-upload-queue.js` prepares patch GPU resources through public Three.js APIs. A shared simple material and a 1 × 1 target upload one mesh's buffers with a temporary one-triangle draw range; the range and caller render state are restored immediately. Patch height textures use separate `initTexture()` jobs. Preparation starts while subsequent Worker construction continues, and local replacement waits for the final seam-normal versions as well. A batch yields after a 4 ms target or four jobs, then resumes in a task after a browser frame. An individual driver call cannot be interrupted, so this is a cooperative budget rather than a hard frame-time guarantee. Spreading preparation can lengthen full-scene background convergence; existing near detail remains visible while the remaining work finishes. Hidden pages pause the queue; eviction cancels owned jobs before releasing resources. No queue work is scheduled once it is empty. `terrainViewer.getState().terrainUploads` exposes pending jobs, completion and measured batch/job durations.

### Alternative terrain and classification sources

`scripts/prepare_data_folder.py` derives the terrain manifest, tile pyramid and shoreline from the DEM and calls `scripts/classification_grids.py` to prepare the geology and vegetation. The DEM's outer sample centers define the displayed bounds [west, south, east, north]. The projected center maps to local (0, 0), with X increasing east and Z increasing south. The manifest also records a WGS84 center for solar position. Source elevations are quantized to centimetres and must fit the existing height encoding. Sea level is 0 m.

Geology and vegetation are reprojected by nearest neighbour. Source NoData, masks and uncovered parts of an overlapping raster receive category zero. Material nodes sample the full extent, including its endpoints, while vegetation cells partition the extent. Source resolution is preserved approximately until the geology grid reaches 256 nodes per axis or the vegetation texture reaches 4096 cells per axis. Material IDs are packed in row, depth, column order. A surface map produces two identical depth slices and an empty borehole list. The original Noto layered-model workflow remains documented in `REBUILD.md`.

The selected folder contains `terrain-1m/manifest.js`, its tile subdirectories, `shoreline-data.js`, `strata-data.js` and `vegetation-data.js`. The viewer reuses its installed material textures and plant models. `src/data-source.js` reads the selected folder with browser-granted read permission, validates grid compatibility and parses the generated data wrappers. Terrain tiles are read as needed. See the README for complete conversion and single-layer replacement commands.

## Background geometry and bounded plant updates

`geometry-worker.js` builds a named dedicated Worker from local module initializer sources and a Blob URL. It imports its own encoded copy of the already decoded Three.js core source, avoiding cross-realm opaque-origin Blob imports. This avoids fetching local source scripts from a `file://` page; both direct-file and localhost entry modes use the same geometry implementation. The Worker has no renderer or WebGL context.

The ocean mask and shoreline inputs are copied once during initialization. Each build receives only its patch, loaded neighbor heights and compact completed coarse-edge geometry. Terrain topology, coastal refinement, mixed-detail constraints, vertex normals and bounds are computed in the Worker. Newly owned output ArrayBuffers are transferred back; live height caches and visible geometry are never transferred or detached. The main thread restores BufferGeometry wrappers, reattaches displayed-surface height queries and creates materials/scene objects.

Boundary vertex indices, positions and original normals are prepared in the Worker. Before each local commit, compact boundary data for the display frontier is averaged there; the main thread applies the returned values and uploads only changed normal buffers. A displayed-topology and user-grid check rejects stale commits, while ordinary camera changes allow useful local work to complete. Existing complete coverage stays visible throughout construction. Worker startup/runtime failure selects an explicit compatibility fallback, exposed with its reason in `terrainViewer.getState().geometryWorker`; the fallback uses the original main-thread geometry algorithm.

Compact-edge extraction classifies each vertex against the four patch boundary planes once. A bitwise intersection rejects interior triangle edges before allocating deduplication keys. Accepted edges retain their original traversal order and endpoint values, including coastal subdivisions and mixed-detail boundaries.

Plant and grass placement use cooperative generators with a 3 ms target slice. Candidate scans, distance sorting and instance preparation span multiple requested frames. A completed snapshot replaces the old instance set atomically. Camera motion schedules a later snapshot without continually restarting the current one; terrain/settings invalidation cancels stale work. This is bounded main-thread scheduling, not a plant Worker or a guarantee that every individual operation completes within 3 ms.

`instance-buffers.js` starts each plant/grass pool at up to 256 instances, with instance colors present before shader preparation. Capacity grows to the required population or twice the previous capacity, bounded by the unchanged population limit. Growth releases the previous instance GPU buffers through `InstancedMesh.dispose()` and replaces their CPU arrays before the complete prepared snapshot is copied. Grass also renews its owned slope attribute. Between growth events, attribute identities are stable and populated update ranges restrict subsequent uploads. First allocation uploads the entire capacity, so keeping capacity proportional to population matters. Growth does not thin plants or change positions.

## Terrain data and local LOD

The 1 m source crop contains 33,226 × 23,136 nodes over 33,225 × 23,135 m. Native input tiles have at most 256 cells per side. Input steps are 1–8 m plus 16/32/64/128 m; the 3/5/6/7 m inputs use exact native node samples. Display sorting indices and input callback keys are separate fields.

The default finest display spacing is 5 m. `terrain-lod.js` uses a nested doubling sequence derived from that setting, such as 5/10/20/40/80/160 m. Display patches contain at most 128 cells per side and form complete, nonoverlapping coverage. They are independent of input-file rectangles. Nodes are sampled from the nearest suitable available input through triangle interpolation, preserving NoData rather than inventing elevations across gaps.

The selection budget prioritizes projected error near the camera. A 30% view buffer and a 1 km camera neighborhood reduce sensitivity to small orientation changes. Split and merge thresholds are 2.4 and 1.5 pixels; committed splits receive priority. Selection requests are coalesced at 80 ms without resetting the timer on every movement. These rules reduce oscillation but do not promise unchanged geometry during large movement or sustained overload.

Each selection evaluates a visited node's view-dependent score once and uses a priority heap with deterministic key tie-breaking. Scores are not reused across camera selections. An ordered adjacency table supplies the same transitive coarse-owner seam context without repeated whole-frontier scans. The optimized selection preserves the patch set, budgets, hysteresis and geometry cache signatures.

Fine boundary nodes first follow coarse triangle interpolation. The final fine land/water edges then match the actual coarse edges, including coastal subdivisions. Water edge attributes identify coarse endpoints so the vertex shader interpolates their wave displacements. This keeps mixed-detail water edges together while they animate. Collision and plant placement query the active display patches rather than assuming one scene-wide level.

A coarse 128 m starting surface provides initial coverage; inputs at 16 m and coarser are preloaded. Missing inputs affect only patches that need them, which select a coarser available source. Geometry cache keys include neighboring edge context. A coastal patch may ignore same/finer neighbors only when its original local ownership has no unresolved cells and there is no coarser context. Such a patch bypasses neighbor-dependent interior walls, so its geometry remains valid as finer neighbors change. All other patches retain the full context. Equivalent cache entries own their resources only once. Active, building, pending and in-progress transaction resources are protected from eviction.

`terrain-refinement.js` turns the final selection into local transactions. It prioritizes desired nearby descendants, refines a bounded subtree inside one displayed parent (up to three levels along the highest-priority branch) and merges complete descendant sets when coarser detail is needed. Actual allocated cell/object budgets control whether a merge must precede nearby refinement; a smaller final target alone does not force a distant merge first. Incompatible startup/user grids first establish aligned coarse coverage. Within a transaction, completed unchanged patches are reused and changed coarse endpoint owners build before fine patches. Up to 12 nearby patch sample reads start ahead of those builds. A complete local group commits immediately; the remaining target continues in the background. Camera movement updates the next target without discarding valid current work. User grid changes invalidate incompatible work. `terrainViewer.getState().refinement` exposes commit count/type, pending group size and target size.

The initial base-cell budget is approximately 2 × 1024² on the higher starting tier, or 1 × 1024² otherwise. At most 384 display patches are selected. Cache targets and the memory-limited effective budget may further constrain detail; coastal subdivisions add geometry beyond the base-cell count. These are estimates and soft budgets, not measured VRAM limits.

## Coast and volume

Land and sea are clipped against the same zero contour of an 8 m sampled and smoothed shoreline-distance field. Shared edge intersection rules prevent independent boundary estimates from opening gaps. Coastal contour segments are refined to at most 8 m, with a 0.03 m distance-field residual target and a 0.5 m recursion floor. These values describe approximation to the display field, not survey accuracy.

The contour uses convex cubic B-spline sampling inside a 16 m band, blending back to the original bilinear field between 16 and 32 m. This removes cell-boundary tangent jumps without changing the stored distance field or DEM. Worker geometry and CPU height/wave queries use the same sampler; water and wetness use matching GLSL with four additional base-level bilinear fetches in the narrow band. Distant samples retain the single-fetch path. The spline smooths the display coastline; it does not recover sub-grid surveyed features.

Inside the coast, the nearest 16 m is held at mean sea level. A smooth transition restores the original displayed height over the following 48 m. A 72 m coastal band retains fine triangles for local wave/contact effects. This display contact profile is separate from the unchanged source DEM. The outer model boundary closes at −100 m; no real seabed bathymetry is inferred.

## Compact geometry indices

Generated index buffers use `Uint16Array` only when the largest referenced index is at most 65534; 65535 is WebGL2's fixed primitive-restart value for unsigned-short indices. Larger references retain `Uint32Array`. Existing 16-bit buffers keep their original interpretation. Compaction preserves vertex arrays, index order, winding and triangle count, and runs again after seam conformity rebuilds indices. Worker transfer and reconstruction preserve the selected typed-array format. Index storage is halved for eligible buffers; overall geometry memory also includes vertex attributes and other data.

## Geological shading and grass

`strata-data.js` contains a preliminary 223 × 13 × 156 categorical field with roughly 150 m horizontal spacing. It combines registered reference sections, regional geological polygons and local borehole templates. Category IDs are discrete; the shader blends appearance weights instead of interpolating identifiers. The 1 m DEM does not imply 1 m geological confidence.

There are 27 land categories and shared 29-layer color/detail arrays. Color images use sRGB; detail RGB stores OpenGL normals and A stores roughness. Triplanar projection covers slopes and cuts. Deterministic rotations, offsets and scale variation with continuous noise mixing reduce repetition; explicit derivatives, mipmaps and anisotropic filtering limit minification artifacts. Soil tops also receive footprint-filtered 23/137 m color variation, independently of the photograph tile period. Materials do not displace geometry.

Material shader LOD uses model-position derivatives, separately from mesh LOD. Geological color blends to the coarsest mip average over 0.5–1 texture tiles per pixel; the fully unresolved path uses one array fetch and skips stochastic/triplanar sampling. Detail roughness blends to its average over 8–16 m per pixel. At 16 m per pixel the existing normal influence is zero, so geological and grass normal-map sampling stops. These transitions use smooth weights. Derivatives are computed before material branches and passed explicitly to texture sampling.

Boundary appearance uses a 3 × 3 × 3 classification neighborhood. Nominal horizontal/vertical blending half-widths are 192/9.6 m, limited by classification spacing and thin-layer constraints. Homogeneous neighborhoods use a cheaper equivalent path. Blending widths are visual parameters, not measured geological contact widths.

Real 2024 vegetation classes control forest/herb cover. A separate smoothed mask adds illustrative thin-soil grass to soil-family and selected weatherable/unclassified bare-ground categories. Loose sand/gravel, fresh igneous bare ground, urban, water, facilities, NoData and reef classes remain excluded. Steep slopes expose underlying geological PBR; walls and bottom do not receive grass. This appearance layer does not alter the source GIS or DEM.

A shared deterministic 84/23 m patch field varies grass coverage in both the ground shader and CPU tuft placement. Nine precomputed texture rotations/offsets provide continuously blended color/normal charts, using the existing grass assets. Green/dry grading retains the source texture structure while revealing earth between patches.

`ground-grass.js` uses fixed 0.8 m candidate spacing, deterministic variation and shared instanced geometry containing 12/6/3 blades per tuft. The 80 m placement radius and 34,000-instance cap per detail pool bound geometry. Grass fades over 55–80 m; the ground texture remains farther away. Detail changes blade count while keeping tuft positions. Root positions follow actual displayed triangles, and natural plant height is independent of vertical exaggeration.

## Plants, water and environment

Trees use a stable 12 m placement grid and four broadleaf/four conifer shape variants derived from shared source assets. Near/middle meshes and distant cards share deterministic shape, size and orientation choices. Instances fade over 1200–1500 m. Geometry budgets can switch representation without randomly thinning the forest. Nearby herb/fern models and grass have separate bounded pools.

Forest broadleaf height ranges from 12–22 m and conifer height from 18–30 m; orchard and low woody forms use 4–8 m and 6–11 m respectively. Height and crown-width variation follow stable instance seeds. To keep the trunk attached, each shape derives one root origin from its near-detail trunk: the minimum Y and the mean X/Z of vertices in the bottom 0.1 m band. Every material and mesh detail level shares this translation, and cards are baked from the aligned prototype. Placement samples the active displayed surface at the original plant location and embeds the root by 0.12 m. Plant size stays in natural metres as terrain exaggeration changes.

The independent `Show grass` and `Show trees` settings default to enabled. Grass visibility gates instanced blades, herb/fern models and ground-cover shading; tree visibility gates all tree mesh/card levels. The vegetation detail setting still determines geometry quality, and Off hides all 3D plants. Visibility changes reuse the shared resources and request an update through the main scheduler.

Water is a hybrid geometric/spectral renderer. Three Gerstner components at 373/131/43 m and nearshore breakers displace existing vertices. Their CPU sampler and mixed-detail endpoint rules use the same displacement, preserving shore contact and water seams. Wave heights remain physical metres when terrain height is exaggerated. Coarse-grid filtering suppresses undersampled geometric waves. Spectral wind waves enrich shading without requiring the complete regional sea to acquire metre-scale triangles.

`ocean-spectrum.js` generates two independent deterministic 128 × 128 wind-wave fields over 1024 m and 67 m periods. Gaussian initial frequencies evolve with deep-water dispersion; inverse Stockham transforms run in float render targets. Choppy tangent derivatives produce surface slopes, physical height and a crest/compression proxy. The two cascades require 32 small passes per update, capped at 20 Hz and driven only by the visible-water clock. Float32 transform buffers avoid accumulated half-float error; the final mipmapped RGBA16F fields filter distant detail. Estimated texture storage is about 1.33 MiB. Unsupported capabilities or shader failures select neutral fields and analytic shading. There is no runtime CPU FFT, pixel readback or independent loop. The adapted transform organization and retained MIT notice are documented in `LICENSES-AND-SOURCES.md`.

`water-motion.js` combines the spectral slopes with analytic geometric tangents and independent capillary normals. Open-water tangents avoid four repeated displacement evaluations per vertex; additional shore-gradient samples run only in transition/breaker bands. Low water reflectance (F0 = 0.0204), slope-variance roughness filtering, the PBR sun highlight, shadow attenuation and crest scattering shape the reflected light. Beer-Lambert absorption uses a shore-distance optical-depth proxy, not surveyed bathymetry. Advected irregular foam follows nearshore breakers and sparse compression whitecaps. A bounded GPU particle pool supplies spray. Sky reflection samples the same cloud environment as the visible sky; only the matching directional sun is cloud-attenuated, leaving pointer lights intact.

The shorter spectral field has a broader directional distribution than the longer field. Bounded slope gains retain cross-wave detail without excessive alternating bright/dark facets. Sky reflections use explicit mip levels derived from material roughness and the reflected ray's pixel footprint. The visible sky retains its analytic sun disk; water's direct GGX lobe supplies solar glint without sampling a second sharp disk in the reflected environment. Breaking foam has a narrow advancing front and phase-aged residue that fades after passage. These changes reuse the existing two FFT fields and reflection targets; they add no scene draw or independent clock.

`water-materials.js` bakes 24 deterministic directional wavelets into a 512-square RGBA16F normal/roughness texture once at startup. Integer Fourier modes are periodic; analytic gradients and a weak second harmonic retain continuous fine-wave slopes. Row/column trigonometry is precomputed, and normal variance is retained before encoding for distant roughness filtering. Compared with RGBA8, the half-float field costs approximately 1.33 MiB more including mipmaps; its shader sample count is unchanged. The water body uses a daylight/sky-driven Beer-Lambert scattering approximation while retaining direct light and flashlight contributions. Foam concentrates on a narrow breaking front, with filtered submeter pores, continuous opacity and faint decaying residue. Its partial normal attenuation preserves ripples under thinning foam. Smaller variable spray particles fade by projected pixel coverage instead of becoming uniformly bright distant dots.

`sky-atmosphere.js` caches sky radiance in a 1024 × 256 mipmapped directional texture. RGB stores the atmosphere and cloud color. Alpha stores cloud transmittance in each direction. The sky shader uses it for the solar disk and the illuminated portion of the lunar disk. The sea shader samples it for solar glint and filters the reflected Moon according to wave roughness. The texture takes approximately 2.67 MiB in RGBA16F.

`cloud-layers.js` samples a two-dimensional noise field using sky direction and the animation clock. Weather changes coverage and color. Color also responds to daylight and twilight. The cloud contribution fades toward the horizon, and translating the camera leaves the pattern fixed for any given viewing direction.

Changing the lighting or weather refreshes the texture immediately. During animation, the viewer refreshes it at most four times per second when the sky or water is visible. The shared clock freezes during sleep and while a dialog or hidden tab pauses the viewer. The weather is procedural.

Water sampling uses smoothly blended rotation/offset regions for each spectral and micro-normal scale. Gradients rotate back to model coordinates; explicit texture derivatives retain mip filtering without discrete region boundaries. Forty-four deterministic phase-chart vectors are prepared once in 704 bytes of uniforms. Pixel-footprint, normal-variance and foam filtering reduce minification artifacts while retaining nearby detail. Wave geometry and CPU/mixed-detail displacement rules are unchanged.

Fine micro-normal slopes fade out by 12 m per pixel, where their texture fetches stop. Their variance blends over 8–12 m per pixel to a mean computed once from the existing CPU texture, preserving unresolved angular energy in roughness without a GPU readback. Wide micro normals remain available for the analytic fallback. Breaker phase, crest, residue and lace computations run only where the surf-band weight is nonzero; offshore whitecap noise remains active. Coordinate and shore-distance derivatives are evaluated before these branches, and zero-weight phase charts skip their texture fetch.

The sky lookup unwraps longitude derivatives before mip selection and uses `textureGrad`, preserving filtering across the panoramic azimuth boundary. Visible and reflected atmospheric color share this sampler.

Owned render-target dimensions are physical pixels. Binding a target selects its physical viewport; calling `renderer.setViewport()` with those dimensions would apply the canvas pixel ratio again. Preserve the caller's logical viewport when restoring state. Fractional ratios above and below one are covered by the GPU fixture.

`ocean-reflection.js` mirrors an owned camera across mean sea level into a 512 × 288 mipmapped linear-color target, approximately 1.31 MiB including estimated depth storage. Its owned front-facing terrain proxy reads original coarse `heights` and `landCells`, never the heavily subdivided coastal mesh, and is capped at 150,000 triangles. Proxy heights follow the shared coastal contact profile. Vertex colors use stratified, linear-RGB means of the source material photographs with the classification blend kernel; the small proxy pass also samples the shared ground cover and grass masks. Sun and hemisphere illumination match the main scene. This keeps a bright bare coast distinct from forest in its reflection. Empty texels retain the analytic sky. Projective sampling distorts the reflected silhouette with the water normal and filters it according to roughness. Filtered coverage composites the land once and attenuates the reflected sun. Captures occur only after camera, terrain-scale, lighting or ground-cover visibility changes, throttled to 10 Hz with at most eight settling attempts. Animated waves alone reuse the capture. Detailed plant silhouettes, geological normal maps and dynamic shadows are absent from this coarse reflection. Renderer state is restored after capture.

`ocean-backdrop.js` continues water beyond the ocean edges of the DEM and blends it into a distant sea horizon drawn from the viewing direction. Visibility depends on camera height and pitch, preserving the cut edges in overhead views. The offshore water uses the shared sky lighting. Sky and water remain reactive to temporal reconstruction. These water effects are parameterized visual animation, not a fluid solver or validated ocean prediction.

Nearshore breaker height uses a deterministic moving wave-group envelope in the range 0.25-1. The same envelope modulates foam formation and wet wash. Its analytic gradient contributes to water normals, and CPU height queries share the coefficient table used to generate GLSL. Spray samples wave strength at emission time and keeps it constant during flight. This varies successive crests without increasing the existing displacement bound or moving the exact shoreline contact; it is an illustrative surf treatment.

The narrow foam front has a soft, advected metre-scale envelope and leaves a short decaying wake. `water-materials.js` bakes a periodic 512-square RG8 cellular coverage texture once at startup. Its channels store thin and thick aerated films with warped, irregular pores, so mipmaps average coverage rather than thresholding a blurred distance field. Two rotated samples at 8.3 m and 17.9 m repeats supply resolved thickness variation within the nearshore band. The texture uses approximately 0.67 MiB including mipmaps and adds no scene pass. The crest's phase average replaces unresolved fronts at a distance.

Clear water and aerated foam resolve their radiance separately, applying coverage once. Fresnel weights the water's reflected and transmitted light. Foam retains actual direct illumination, terrain/cloud attenuation and pointer lighting, while its ambient response takes the larger of the scene's indirect diffuse light and the existing daylight-scaled water-column sky approximation. This supplies scattered environment light when clouds block the sun without doubling the ambient terms. The sky contribution fades out at night. It is an illustrative scattering approximation, not a multiple-scattering fluid simulation.

The environment uses a NOAA-style solar approximation at the model center, selected date and fixed GMT+9 time. Clear/cloudy/rainy presets affect sky, fog, lights, waves and rain. Local PCF shadows follow the view and reuse their map when possible. In orbit view, the flashlight ray-tests the displayed height field and lights the hit point. In first-person view, an eye-level spotlight follows the vehicle heading. Its 80° cone tilts down 4° and fades to zero at 180 m. Rain, spray and wind use GPU animation and the shared scene clock.

Rain has a fixed 1200/2200-drop population. World-space trajectories wrap into a 180 by 130 by 180 m volume centered on the camera: subtract the anchor before modulo and add it afterward, so camera motion does not translate an existing drop between wraps. Stable per-drop attributes vary fall speed (9-15 m/s), exposure (0.035-0.055 s) and wind response. Radial and vertical fades hide wrap boundaries; streak tails taper. Camera/clock updates change uniforms without rewriting particle buffers. Weather presets remain immediate, and rain does not simulate terrain/water impacts.

## Rendering and adaptation

Only one frame request can be pending. Inputs, settings and completed resources request scene updates. Animation-only frames advance shared uniforms and draw, without repeating terrain selection or vegetation distribution. By default, visible animation continues for 30 seconds after the last interaction; then time and drawing stop. Image reconstruction can finish a bounded settling sequence without advancing sleeping cloud, water, rain or wind clocks. Hidden pages and open dialogs pause idle animation. Cached resources remain allocated during sleep.

The closed land/water bases lie on the flat -100 m plane. Above that plane their back faces are hidden by the opaque closed volume, so their meshes are not submitted. At or below the scaled base, they become visible again. Top surfaces, cut walls, stored geometry, draw ordering and shared material state remain unchanged. Visibility is cached until the active patch set changes or the camera crosses the scaled base plane. `terrainViewer.getState().baseCulling` counts omitted meshes/triangles across the active set; these are not frustum-visible triangle measurements.

### Temporal reconstruction and history rejection

The viewer automatically uses a local GPU reconstruction pass when float color targets and multiple render attachments are supported. The scene is shaded at 75% of the output width and height with a short subpixel jitter sequence. Two full-output ping-pong targets retain linear-light color and surface metadata. The final pass applies the renderer's output color conversion. UI text remains ordinary HTML. The viewer falls back to direct rendering for unsupported devices, excessive target sizes or setup failures.

For a static opaque surface, the current depth reconstructs its world position. The previous view-projection matrix finds its history location. History is rejected behind the camera, outside the previous image, or when previous depth or depth-derived world normal disagrees. All four metadata taps associated with the bilinear color lookup must pass, so a thin foreground edge cannot contaminate a newly revealed background through interpolation. Accepted history is clamped to the current 3 × 3 color neighborhood; luminance disagreement reduces its weight. This is geometric normal validation, not storage of PBR normal-map details.

Regional views use a near plane between 0.5 and 16 m, derived only from camera clearance outside the model bounding box with a 64 m plant/wave allowance. Inside or near the model it remains 0.5 m. This improves depth precision over tens of kilometres without clipping bounded terrain; the nearest camera-local rain can be clipped in remote views. Reprojection retains the previous matrices and fixed-scale linear-depth metadata, so ordinary near/far updates do not reset history.

Water, instanced plants, transparent content and custom shader effects are reactive: a temporary separate-alpha blend marks them as current-frame-only without changing their RGB blend. Coastal land patches are also reactive because their foam and wetness animate. Material state and the camera's unjittered projection/inverse are restored after each render. The implementation deliberately does not reuse dynamic-surface history or claim per-object motion-vector reconstruction.

Explicit resets cover time/date/weather changes, pointer-light changes, committed terrain/plant geometry, vertical scale, plant visibility/detail, canvas changes and hidden-page transitions. Camera cuts and long gaps also discard history; ordinary camera motion uses reprojection instead of globally clearing every frame. The existing scheduler supplies at most eight settling attempts. Long-frame gaps do not rearm that budget indefinitely. There is no separate render loop, polling timer or per-frame CPU pixel readback.

The sky backdrop is drawn before opaque terrain in both direct and temporal modes. It is marked reactive so moving sky pixels use the current frame. Water samples the same directional texture along its reflection rays. Distance fog retains the weather preset near the coast and shifts outward with orbit distance to keep the peninsula legible in regional views.

`terrainViewer.getState().temporal` reports requested/active state, fallback reason, dimensions, history age and reset counters. `renderedFrames` counts presented viewer frames; draw/triangle counters include the scene and reconstruction passes. Lower input resolution is a deliberate shading-cost tradeoff: newly revealed and reactive surfaces cannot gain missing samples from old frames. This is a small WebGL reconstruction implementation, not DLSS/FSR or a promise of ghost-free output in every scene.

Performance feedback uses consecutive rendered-frame intervals and asynchronous GPU timing where available. Loading/building intervals and the first wake-up frame are excluded. Sustained slow windows reduce local terrain budgets and automatic canvas/plant detail; sustained fast windows restore them gradually. Both adjustment directions have a 6-second cooldown. Manual canvas and vegetation settings are not overwritten. Hardware hints choose the initial tier, while measured load drives later adaptation.

`terrainViewer.getState()` exposes Worker mode/build/attachment timings, pending plant placement and accumulated placement CPU time, actual grid spacings, `lodMode: "distance-adaptive"`, cache/build counters, estimated geometry memory, frame/GPU timing, graphics-device information, vegetation/grass counts and environment/water state. `oceanSpectrum`, `oceanReflection`, `oceanBackdrop` and `skyAtmosphere` report capability/fallback, update/capture counts and resource budgets. `skyAtmosphere.clockTime` and `skyInView` expose the shared scheduler integration. Estimated memory is not a VRAM measurement; `powerPreference` is a request rather than proof of discrete-GPU selection.

## Maintenance and rebuilding

Use two-space indentation for JavaScript/HTML/CSS and four spaces for Python. Explain coordinates, units, boundary constraints and ownership in comments. Do not manually format compressed payloads, original assets or third-party code. Routine viewer edits do not require DEM regeneration.

| Change | Primary files |
| --- | --- |
| Interface text/layout | `index.html`, `src/styles.css` |
| Navigation, caches or performance feedback | `src/terrain.js` |
| Image reconstruction and history validation | `src/temporal-reconstruction.js`, scheduler hooks in `src/terrain.js` |
| Distance detail, coverage or input sampling | `src/terrain-lod.js` |
| Surface topology and mixed-detail edges | `src/tile-geometry.js`, `src/coastal-geometry.js`, `src/model-volume.js` |
| Geological appearance | `src/rock-materials.js`, `data/material-texture-config.js` |
| Water and surf | `src/water-materials.js`, `src/water-motion.js`, `src/ocean-spectrum.js`, `src/ocean-reflection.js`, `src/ocean-backdrop.js`, `src/scene-effects.js` |
| Plant coverage/detail and soil grass | `src/vegetation.js`, `src/ground-grass.js` |
| Sky, clouds, sun and weather | `src/cloud-layers.js`, `src/sky-atmosphere.js`, `src/ocean-backdrop.js`, `src/environment.js` |

See [REBUILD.md](REBUILD.md) for source locations, dependencies and portable rebuild commands. `scripts/build_grass_ground.py` adds the current grass texture payload from the retained `grass_ground` source images. Ordinary source changes should be checked in the browser without regenerating unrelated datasets.

The dated [progress report](docs/COMP5411_Progress_Report_EN.md) preserves October 18 measurements. Its uniform-visible-LOD description is historical; this guide describes the current local selection. Targeted October 19 checks covered all 12 detail limits, selection coverage/budget/fallback, mixed land/water edges, stable small camera turns, grass attachment, sleep and file/HTTP loading. October 20 checks covered tree attachment across representative detail limits and 1/5/10 height scales, independent grass/tree visibility combinations, sleep and both entry modes. Full device coverage, long navigation sessions and final presentation acceptance remain incomplete.

## Focused regression tests

Run `node --test tests/terrain-base-culling.test.cjs` for top/wall/material preservation, cached same-side updates and base restoration above/at/below the plane at different height scales. Browser image and GPU comparisons remain necessary to verify the actual render result.

Run `node --test tests/water-materials.test.cjs` for deterministic half-float wavelet normals, bounded slopes, retained variance, periodic edge continuity and bounded thin/thick RG8 foam coverage. This checks generated CPU texture data; actual texture filtering, shader output and motion require the ocean browser fixture.

Run `node --test tests/coastal-field.test.cjs tests/ocean-reflection.test.cjs` for shared coastline tangent continuity, far-field preservation, bounded source-albedo proxy colors, contact heights and lighting/cache behavior. The ocean browser fixture additionally checks actual grass/cover reflection shader compilation and CPU/GPU coastline-distance parity.

Run `node --test tests/instance-buffers.test.cjs tests/shader-preparation.test.cjs tests/terrain-upload-queue.test.cjs` for population-preserving buffer growth/disposal, asynchronous renderer-state restoration, terrain-cache ownership, upload budgets/cancellation and retained coverage during preparation. Input latency and first-use GPU stalls require an actual browser trace; these CPU tests do not establish frame rate.

Run `node --test tests/environment.test.cjs` for deterministic rain variation, shared endpoint parameters, fixed buffers and clock freezing. Real-browser checks are still required for shader compilation and camera-independent world trajectories. Ocean browser fixtures also probe eight successive grouped crests, CPU/GPU displacement and normals, amplitude bounds and stationary coast contact.

Run `node --test tests/model-volume.test.cjs` for index-storage fixtures. They cover the 65534/65535/65536 index boundary, existing restart values and invalid generated references, plus exact triangle winding, holes and computed normals. The Worker tests also check small-index transfer and preservation of vertex 65535 in a large mesh.

Run `node --test tests/geometry-worker.test.cjs tests/terrain-refinement.test.cjs tests/terrain-refinement-geometry.test.cjs` with Node.js 22 or newer. Tests use real worker threads, the bundled Three.js core and generated terrain/coast fixtures. They cover transferred topology and attribute parity, height queries, mixed-detail water edges, boundary normals, caller buffer ownership, stale commits and compatibility fallback. No DEM download or npm installation is required. Progressive tests also check full coverage throughout local transitions, selection priority, merging and stale-topology rejection. Browser rendering and interaction still need separate checks.

Run `node --test tests/ground-grass.test.cjs` for generated grass coverage and placement fixtures. They check class/material exclusions, patch continuity, deterministic locations, visibility, steep slopes and root attachment at 1/5/10 vertical scales. No vegetation images or terrain download is required; visual appearance and shader compilation still need a browser check.

For the synthetic WebGL history test, install Playwright in a separate test environment and run `node --test tests/temporal-browser.test.cjs`. Set `REQUIRE_TEMPORAL_GPU=1` to treat a missing browser dependency as a failure, and `TEMPORAL_BROWSER_CHANNEL=msedge` to use installed Edge. Without Playwright this optional test is explicitly skipped; the viewer itself gains no dependency. `tests/temporal-scene.html` can also be opened through the local server. The fixture checks a camera pan across a thin contrasting occluder, lighting changes, reactive surfaces, static accumulation, camera matrix restoration, resize, disable/fallback and finite settling. It uses generated geometry and the bundled Three.js library, with no DEM or model download.

For the asset-free ocean fixture, run `node --test tests/ocean-browser.test.cjs` in the same separate Playwright environment. `OCEAN_BROWSER_CHANNEL=msedge` selects installed Edge; `REQUIRE_OCEAN_GPU=1` requires the browser and `REQUIRE_OCEAN_SPECTRUM=1` additionally requires the float-target FFT path. `OCEAN_ARTIFACT_DIR` optionally saves screenshots and the diagnostic report. The fixture checks evolving deterministic fields, gradient/crest consistency, CPU/GPU wave agreement, height-scale independence, weather/day/night shading, renderer-state restoration, reflection caching, temporal compatibility and stopped idle clocks. `tests/ocean-scene.html` is available through the local server. Pixel readback is restricted to tests.

`REQUIRE_SKY_ATMOSPHERE=1` requires the clear-atmosphere path, including sunrise/sunset/night colors, lighting-driven caching, the panoramic sampling seam and renderer restoration. The fixture uses the actual sky backdrop module.

Run `node --test tests/cloud-volume-browser.test.cjs` with `REQUIRE_SKY_CLOUDS=1` and `OCEAN_BROWSER_CHANNEL=msedge` to check background clouds on a real WebGL2 device. The fixture compares the sky and an opaque foreground at multiple camera heights, changes weather and animation time, and checks the direct and temporal paths. Set `CLOUD_VOLUME_ARTIFACT_DIR` to save diagnostic images and measurements.
