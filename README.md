# Noto Peninsula: An Interactive 3D Landscape

HKUST COMP5411, Fall 2026, Group 12. Authors: TAN Jiming and LEE Hyunjin.

This browser-based landscape combines a real 1 m elevation dataset, geological rendering categories and vegetation distribution with animated water, sunlight and weather. The displayed region covers approximately 33.225 × 23.135 km, within 37.33–37.54° N and 137.00–137.38° E.

## Run

The Git repository contains source code and documentation. Large assets are attached to the pinned GitHub Release listed in `assets-manifest.json`. After cloning, install the required runtime assets from the project root using Python 3.9 or newer:

```sh
python scripts/fetch_assets.py
```

This downloads the runtime archive, checks its exact byte count and SHA-256, and installs `data/` and the runtime asset subdirectories. Archives stay in the ignored `.asset-cache/` folder for reuse. To also obtain original DEM, material/model sources, GIS and reference inputs, use `python scripts/fetch_assets.py --sources`. No scientific Python packages are needed for downloading or viewing.

For offline installation, download the Release ZIP files on another connection and retain their filenames:

```sh
python scripts/fetch_assets.py --archives-dir /path/to/downloaded-zips
```

Add `--sources` to install all source-input archives as well. Offline mode never attempts a download. Keep `index.html`, `src/`, `data/`, `assets/` and `vendor/` together after installation.

With Python 3 installed, run from the project root:

```sh
python scripts/serve.py
```

The server binds to `127.0.0.1` on an available port and opens `index.html`. Keep its terminal open; press Ctrl+C to stop it. On Windows, `start-viewer.cmd` provides the same entry point. Directly opening `index.html` is also supported.

Viewing requires WebGL2, Gzip `DecompressionStream` and hardware acceleration. Runtime resources are local; there is no npm installation, compilation step or external runtime service. Shared texture arrays are substantial: roughly 580 MiB of CPU pixels and 773 MiB of theoretical GPU texture storage with mipmaps, before terrain and other resources. Actual usage depends on the browser.

## Use another dataset

Prepare three georeferenced, single-band GeoTIFFs. The DEM must be north-up with square pixels in a projected metre-based CRS and unscaled elevations from −100.00 to 555.34 m. Set ocean cells to NoData where they connect to the outer edge of the raster. The other two bands contain integer classes: rock and soil use IDs 0–28, and vegetation uses IDs 0–30. Reclassify source legends to the project IDs before conversion. Run `python scripts/classification_grids.py --list-codes` to list both legends.

From the project root, use Python with NumPy, Rasterio and SciPy to build a new local folder:

```sh
python scripts/prepare_data_folder.py --dem dem.tif --geology geology.tif --vegetation cover.tif --output my-data
```

Open `index.html` in Edge or Chrome. Under **Settings → Data source**, click **Choose data folder**, select `my-data` and grant read access. The viewer reloads with the new terrain, shoreline and distributions. **Use bundled data** restores the Noto dataset. To change one classification, copy a prepared folder and run the following command on the copy. Use `--geology geology.tif` for rock and soil.

```sh
python scripts/classification_grids.py --data my-data-copy --vegetation cover.tif
```

Select the updated folder in Settings. Both category maps are sampled by nearest neighbour in the DEM's CRS. A surface geology map supplies the same class down to the display base. The viewer uses the new location for solar position and displays time in UTC+9.

## Controls

- Drag with the left mouse button to orbit or the right button to pan. Scroll up to zoom in quickly, or click + for a finer step. Scroll down or click − to zoom out.
- W/S or up/down arrows move forward and backward. A/D or left/right arrows move sideways. In orbit view, horizontal speed scales with height above the ground, from 10 to 5,000 m/s.
- Select the eye button for **first-person view** at the current orbit target. Use WASD to travel at 24 m/s and drag to look around. The camera follows slopes at a height of 1.8 m and rides the waves offshore. Select the eye again to restore your orbit view.
- Select **Enter full screen** in the right toolbar to expand the entire viewer. Select the button again or press Esc to return to the window.
- Q/E turns the view. R/F moves vertically in orbit view. Additional bindings appear in the ? dialog.
- The bottom slider changes display height from 1:1 to 1:10; default 1:5.
- The upper-right slider controls time in GMT+9. Select **Play** to advance one day every 10 seconds, starting at the displayed time. The date advances at midnight. Select **Pause** to hold the current view. Dragging the slider, opening a dialog, or hiding the tab also pauses playback.
- In settings, choose a date from the English calendar or enter it as YYYY-MM-DD. Today uses the date in Japan. The weather options are clear, cloudy and rainy.
- The Moon follows the selected date, time and map location. For a view from the Noto coast, select Clear and set 24 November 2026 at 17:00 GMT+9. The nearly full Moon is about 11° above the east-northeastern horizon.
- The flashlight button illuminates the surface under the pointer, including at night.

## Detail and animation settings

The finest permitted terrain spacing defaults to **5 m**. Settings offer 1–8 m in 1 m increments and 16/32/64/128 m. This is a detail limit: nearby terrain receives priority while distant patches can remain coarser. `Near grid` reports the finest visible land spacing, rather than a uniform whole-scene spacing. Nearby refinement is displayed as complete local groups become ready. Camera motion updates the target without repeatedly discarding valid current work; adjacent seams update with each group.

Window render resolution and 3D vegetation detail default to Auto. Manual settings remain under user control. Tree locations and shape variants are deterministic; distance changes representation, with a fade over 1200–1500 m. Suitable soil and selected weatherable/unclassified bare ground receive irregular green/dry grass patches and nearby instanced blades. Matching deterministic patches control both ground shading and tuft placement; grass positions stay fixed when geometric detail changes. Randomized texture orientation, scale and broad soil tones reduce repeated patterns.

`Show grass` and `Show trees` are independent settings, both enabled by default. `Show grass` controls grass blades, herb/fern models and ground-cover shading; `Show trees` controls every tree detail level. Setting vegetation detail to Off hides all 3D plants, while ground-cover shading still follows `Show grass`.

Forest broadleaf trees are 12–22 m tall and conifers 18–30 m; orchard trees are 4–8 m and other low woody forms 6–11 m. Crown width varies with each stable shape and size seed. Tree roots follow the displayed terrain at every detail level and height scale; their natural dimensions are not exaggerated with the terrain.

After the last interaction, visible clouds, waves, rain and vegetation wind continue for **30 seconds** by default, then freeze. Settings offer immediate sleep, 15/30 seconds, 1/5 minutes or Never. Dialogs and hidden pages pause idle animation. Ordinary animation frames do not rebuild terrain or redistribute vegetation.

The sea uses two GPU FFT wind-wave fields, geometric long swells and nearshore breakers. Spectral slopes, irregular whitecaps, shore foam, Fresnel reflection, absorption and sun glints provide its appearance. A 512 × 288 terrain-only reflection uses a capped coarse proxy and reuses stationary captures; the full detailed scene is not rendered twice. The visible sky and its water reflection share the same lighting. At low coastal viewpoints, water continues beyond the ocean edge of the DEM to a horizon drawn in the sky background. The terrain crop remains visible from above. All effects use the existing sleep clock. Devices without the required float render targets retain analytic waves and optical shading.

Clouds drift across the sky background. Clear, cloudy and rainy presets change their coverage and color, while the time of day controls their illumination. The sky and the sea surface use the same cloud pattern for reflections and for the sun's visibility. The landscape remains visible when the camera rises above the peninsula. Distance fog follows the weather at the coast and adjusts to longer viewing distances in regional views.

Water detail blends continuously rotated/offset sampling regions to reduce short repeated patterns. Pixel-footprint filtering moves unresolved wave-normal energy into roughness and filters fine foam. Nearby resolved waves remain visible. Offscreen effects use physical render-target dimensions independently of the canvas pixel ratio.

Material shader detail follows the projected pixel footprint independently of terrain grid spacing. Distant geological textures blend toward their mipmap average, and unresolved normal maps stop sampling after their influence fades out. Water skips fine-normal sampling when it becomes unresolved and evaluates breaker-only shading inside the surf band. These paths reduce unnecessary shading while retaining nearby material detail and continuous transitions.

Temporal reconstruction runs automatically on supported WebGL2 devices. It shades the scene at 75% of the output width/height, then reuses validated static-surface history. Depth/normal checks reject newly exposed or incompatible surfaces; local color clamping limits stale shading. Lighting changes and committed geometry reset history. Moving water, coastal wetness, plants, rain and spray use current-frame samples. A bounded settling sequence can refine a still image without keeping the viewer awake. Unsupported devices and oversized buffers use direct rendering. This is a quality/performance tradeoff, not a guarantee of higher frame rate or native detail on every pixel.

Terrain mesh generation, shoreline subdivision, mixed-detail stitching and boundary-normal averaging run in a dedicated Worker. The main thread retains interaction and rendering. Tree/grass placement is prepared in short cooperative slices, then committed as a complete set. Worker diagnostics are available through `terrainViewer.getState().geometryWorker`; a browser that cannot start the Worker uses an explicit compatibility fallback. These changes reduce CPU blocking; pixel shading, shadows and GPU uploads still have a rendering cost.

Eligible terrain meshes use compact 16-bit indices to reduce index-buffer storage and transfer, while larger meshes retain 32-bit indices. Vertex positions, triangle order and shoreline detail are preserved.

The renderer requests `powerPreference: "high-performance"`. The browser, operating system and driver select the actual device; JavaScript cannot force a GPU number.

## Files

| Relative path | Purpose |
| --- | --- |
| `index.html`, `src/` | Entry point, interface and hand-maintained runtime code |
| `data/terrain-1m/` | Terrain manifest and multiresolution input tiles |
| `data/` | Generated shoreline, geology, vegetation and material configuration |
| `assets/material-library/`, `assets/vegetation/` | Source assets, derived runtime assets and source records |
| `gis/vegetation/` | Aligned classification and satellite-reference rasters, QGIS styles and metadata |
| `noto_terrain_materials_package/` | Geological sources, borehole summaries and reference model |
| `tests/` | Synthetic geometry/Worker tests and optional WebGL ocean/history tests; see `CODE_GUIDE.md` |
| `scripts/`, `vendor/` | Offline generators, local server and third-party code |
| `source-data/terrain/` | Original DEM location when the source-data bundle is installed |
| `docs/` | Proposal and dated English progress report |
| `CODE_GUIDE.md`, `HANDOFF.md` | Current architecture and maintenance baseline |
| `REBUILD.md` | Offline rebuilding dependencies and commands |

See [CODE_GUIDE.md](CODE_GUIDE.md) for the current implementation, [HANDOFF.md](HANDOFF.md) for the maintenance baseline and [REBUILD.md](REBUILD.md) for offline generators. The [progress report](docs/COMP5411_Progress_Report_EN.md) is dated October 18, 2026; its measured results and implementation snapshot precede the current runtime baseline.

The [progress presentation](docs/COMP5411_Project_Progress.pptx) and [timed narration](docs/COMP5411_Progress_Video_Script_EN.txt) describe the October 20 viewer. The recording plan targets 3:50, including a 70-second recap and 115 seconds of actual application footage. Slides 4–6 provide still-image cues; demonstrate animation and interaction in the running viewer when recording the video.

## Data interpretation and licensing

Local coordinates use metres: X east, Y up and Z south. Mean sea level is 0 m and the closed model base is −100 m. The base is a visualization boundary, not measured bathymetry. Vertical exaggeration changes display height without modifying the source DEM.

Geological categories and texture transitions are preliminary visualization, not 1 m geological measurements. Plant coverage uses real 2024 classifications, but species proxies and individual positions are illustrative. Additional grass on suitable soil and selected weatherable/unclassified bare ground is illustrative thin-soil cover, not a vegetation survey. Loose beaches, fresh igneous bare ground and steep exposed slopes retain their geological appearance. The smoothed coastline, nearshore contact profile, waves, foam, spray, rain and reflections are visual approximations. Shallow-water absorption uses shore distance rather than measured bathymetry. Offshore extension is a visual backdrop outside the DEM crop. This viewer is not a physical prediction or engineering measurement tool.

One fine input payload remains unavailable in the distributed terrain data. Its affected display patch uses a coarser available input; the rest of the scene can retain fine detail. Source data and browser security settings are not modified to restore it.

The complete project is not uniformly CC0. Materials and plant models, satellite imagery, vegetation and geoscience datasets have different terms. Consult [LICENSES-AND-SOURCES.md](LICENSES-AND-SOURCES.md), [TEXTURE-SOURCES.md](TEXTURE-SOURCES.md) and the asset source records before redistribution.
