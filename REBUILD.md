# Offline rebuilding

Run commands from the project root. The viewer uses delivered runtime data; rebuilding is optional. Download source inputs before invoking generators:

```sh
python scripts/fetch_assets.py --sources
```

The pinned Release has one required runtime group and separate source-input archives. `assets-manifest.json` records their URLs, byte counts and SHA-256 digests. The helper uses only the Python standard library, retains downloaded ZIPs in `.asset-cache/`, and installs only the permitted data/asset/input trees. It does not execute archive contents or overwrite viewer source code.

For a machine without internet, retain the exact Release filenames in one directory and run:

```sh
python scripts/fetch_assets.py --sources --archives-dir /path/to/downloaded-zips
```

All selected archives must already be present in offline mode. Omitting `--sources` installs only what is needed to run the viewer.

## Generator dependencies

Use Python 3.11 or newer for rebuilding. Install the scientific/GIS/image dependencies from `requirements-rebuild.txt`:

```sh
python -m pip install -r requirements-rebuild.txt
```

The coastline generator also requires SciPy. Node.js with ES modules and WebAssembly is needed only for plant-model generation; meshoptimizer is provided under `vendor/meshopt/`, so no npm installation is required. The local server and asset helper do not require these generator packages. Different compression-library versions can change encoded bytes even when decoded data agrees.

Use a separate work copy or fresh output paths for large regeneration. Source files are inputs and should remain unchanged. Do not manually edit generated Base64 payloads or format their long strings.

## Terrain and coast

The original 1 m DEM is installed under `source-data/terrain/`. A complete terrain rebuild needs several gigabytes of temporary disk space and a fresh output directory:

```sh
python scripts/build_native_tiles.py --source source-data/terrain/DEM1A_20250509_JGD2024_EPSG6675alias_1m_COG.tif --spacing 1 --output rebuilt/terrain-1m --name terrain-1m
python scripts/add_display_levels.py --dataset rebuilt/terrain-1m --steps 3 5 6 7
python scripts/build_coastline_field.py --dataset rebuilt/terrain-1m --output rebuilt/shoreline-data.js
```

The first command writes native 1/2/4/8/16/32/64/128 m input tiles and their manifest. The second adds exact-node 3/5/6/7 m inputs. `height = uint16 / 100 - 100` metres; 65535 is NoData. Input tiles are distinct from the runtime's nested distance-adaptive display patches.

`build_coastline_field.py` reads the DEM identified by the selected manifest and creates the shared smoothed distance and coastal-height fields. `build_shoreline_assets.py` is a compatibility entry point for the same generator. `--sample-cache`, `--sample-only`, `--manifest` and `--output` support separating DEM sampling from field processing. Do not include temporary sample caches in runtime assets. The coast and contact profile are display approximations; neither replaces the DEM.

Validate new outputs in a work copy before replacing delivered `data/`. An unavailable fine payload must continue to fall back to coarser input; do not automatically restore quarantined content or change security settings.

## Geological categories and material textures

```sh
python scripts/build_material_assets.py
python scripts/build_runtime_materials.py
```

The classification generator reads the local reference model, geological map and borehole summaries, then writes `data/strata-data.js`. The material generator reads retained source channels and class recipes, writes runtime color/detail images and configuration, and invokes the file-protocol image packager. To rebuild only image wrappers:

```sh
python scripts/package_material_images.py
```

These commands do not rebuild terrain. Category interpolation, borehole influence areas and material blend widths are visualization assumptions, documented in `CODE_GUIDE.md` and asset source records.

## Vegetation and soil grass

Aligned classification rasters, QGIS styles, source tiles and satellite reference imagery are installed under `gis/vegetation/`. Preserve their recorded coordinate systems, years and licenses. The original DEM is not a vegetation drawing layer and must not be overwritten.

Repackage the real classification for the browser, or also rebuild model geometry from the retained source glTF inputs:

```sh
python scripts/build_vegetation_assets.py
python scripts/build_vegetation_assets.py --models --node node
```

Model generation calls `prepare_vegetation_models.py`, `simplify_vegetation_models.mjs` and `vary_vegetation_models.mjs`. It derives shared near/middle meshes and deterministic tree-shape variants. Runtime payloads belong under `assets/vegetation/runtime/`; source models belong under `assets/vegetation/source/`.

The additional grass texture resource is generated independently:

```sh
python scripts/build_grass_ground.py
```

This reads the retained CC0 `grass_ground` 4K color/normal images and writes the 1K embedded texture payload `assets/vegetation/runtime/grass-ground.js`. `src/ground-grass.js` handles the runtime mask, fixed positions and instanced blades. The extra grass on suitable soil-class bare ground is illustrative and does not modify the GIS or geology categories.

## Check a regenerated work copy

Start `python scripts/serve.py` and verify representative inland/coastal views, material boundaries, mixed-detail seams, plant attachment, date/time/weather, flashlight and idle freeze. Check both fine and coarse limits and compare decoded data when changing generators. Repeating unrelated full DEM generation is unnecessary for normal source, comment, interface or shader edits.

Source assets carry different licenses; keep their records with regenerated distributions. The whole project must not be labelled CC0.
