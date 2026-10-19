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

Add `--sources` to install all source-input archives as well. Offline mode never attempts a download. Keep `index-1m.html`, `src/`, `data/`, `assets/` and `vendor/` together after installation.

With Python 3 installed, run from the project root:

```sh
python scripts/serve.py
```

The server binds to `127.0.0.1` on an available port and opens `index-1m.html`. Keep its terminal open; press Ctrl+C to stop it. On Windows, `start-viewer.cmd` provides the same entry point. Directly opening `index-1m.html` is also supported.

Viewing requires WebGL2, Gzip `DecompressionStream` and hardware acceleration. Runtime resources are local; there is no npm installation, compilation step or external runtime service. Shared texture arrays are substantial: roughly 580 MiB of CPU pixels and 773 MiB of theoretical GPU texture storage with mipmaps, before terrain and other resources. Actual usage depends on the browser.

## Controls

- Left drag: orbit; right drag: pan; mouse wheel or + / −: zoom.
- W/S or up/down arrows: forward/backward; A/D or left/right arrows: strafe.
- Q/E: turn; R/F: move vertically. Additional bindings appear in the ? dialog.
- The bottom slider changes display height from 1:1 to 1:10; default 1:5.
- The upper-right slider controls time in GMT+9. Date and clear/cloudy/rainy weather are in settings.
- The flashlight button illuminates the surface under the pointer, including at night.

## Detail and animation settings

The finest permitted terrain spacing defaults to **5 m**. Settings offer 1–8 m in 1 m increments and 16/32/64/128 m. This is a detail limit: nearby terrain receives priority while distant patches can remain coarser. `Near grid` reports the finest visible land spacing, rather than a uniform whole-scene spacing. Changing the view does not replace the entire visible region with one coarse level.

Window render resolution and 3D vegetation detail default to Auto. Manual settings remain under user control. Tree locations and shape variants are deterministic; distance changes representation, with a fade over 1200–1500 m. Soil ground also has blended grass texture and nearby instanced grass blades. Grass positions stay fixed when geometric detail changes.

After the last interaction, visible waves, rain and vegetation wind continue for **30 seconds** by default, then freeze. Settings offer immediate sleep, 15/30 seconds, 1/5 minutes or Never. Dialogs and hidden pages pause idle animation. Ordinary animation frames do not rebuild terrain or redistribute vegetation.

The renderer requests `powerPreference: "high-performance"`. The browser, operating system and driver select the actual device; JavaScript cannot force a GPU number.

## Files

| Relative path | Purpose |
| --- | --- |
| `index-1m.html`, `src/` | Entry point, interface and hand-maintained runtime code |
| `data/terrain-1m/` | Terrain manifest and multiresolution input tiles |
| `data/` | Generated shoreline, geology, vegetation and material configuration |
| `assets/material-library/`, `assets/vegetation/` | Source assets, derived runtime assets and source records |
| `gis/vegetation/` | Aligned classification and satellite-reference rasters, QGIS styles and metadata |
| `noto_terrain_materials_package/` | Geological sources, borehole summaries and reference model |
| `scripts/`, `vendor/` | Offline generators, local server and third-party code |
| `source-data/terrain/` | Original DEM location when the source-data bundle is installed |
| `docs/` | Proposal and dated English progress report |
| `CODE_GUIDE.md`, `HANDOFF.md` | Current architecture and maintenance baseline |
| `REBUILD.md` | Offline rebuilding dependencies and commands |

See [CODE_GUIDE.md](CODE_GUIDE.md) for the current implementation, [HANDOFF.md](HANDOFF.md) for the maintenance baseline and [REBUILD.md](REBUILD.md) for offline generators. The [progress report](docs/COMP5411_Progress_Report_EN.md) is dated October 18, 2026; its measured results and implementation snapshot precede the October 19 grass and local LOD updates.

## Data interpretation and licensing

Local coordinates use metres: X east, Y up and Z south. Mean sea level is 0 m and the closed model base is −100 m. The base is a visualization boundary, not measured bathymetry. Vertical exaggeration changes display height without modifying the source DEM.

Geological categories and texture transitions are preliminary visualization, not 1 m geological measurements. Plant coverage uses real 2024 classifications, but species proxies and individual positions are illustrative. Additional grass on suitable soil-class bare ground is a visual addition, not a vegetation survey. The smoothed coastline, nearshore contact profile, waves, foam, spray, rain and sky reflection are visual approximations; this viewer is not a physical prediction or engineering measurement tool.

One fine input payload remains unavailable in the distributed terrain data. Its affected display patch uses a coarser available input; the rest of the scene can retain fine detail. Source data and browser security settings are not modified to restore it.

The complete project is not uniformly CC0. Materials and plant models, satellite imagery, vegetation and geoscience datasets have different terms. Consult [LICENSES-AND-SOURCES.md](LICENSES-AND-SOURCES.md), [TEXTURE-SOURCES.md](TEXTURE-SOURCES.md) and the asset source records before redistribution.
