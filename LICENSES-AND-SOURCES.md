# Licenses and sources

The course-project source and each external asset retain their respective rights. No blanket open-source license is asserted for the entire package.

| Component | Source and terms |
| --- | --- |
| Three.js runtime | Supplied MIT text in `THREE-LICENSE.txt`; bundled headers remain in `vendor/three-libraries.js` |
| GPU ocean transform organization | Adapted from David Li's MIT-licensed [dli/waves simulation.js](https://github.com/dli/waves/blob/1313f464c2df7d1c69852577248b58fa29074c38/simulation.js), pinned commit `1313f464c2df7d1c69852577248b58fa29074c38`; full notice retained in `src/ocean-spectrum.js` and `vendor/ocean/dli-waves-LICENSE.txt` |
| Water/reflection implementation references | Three.js r186 [Water.js](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/Water.js) optical conventions and [Reflector.js](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/objects/Reflector.js) reflected-camera/projective math; retained MIT notice in `THREE-LICENSE.txt` |
| Offline meshoptimizer | Version recorded in `vendor/meshopt/package.json`; MIT text in `vendor/meshopt/LICENSE.md` |
| Reference Plotly viewer | Embedded Plotly license headers retained in `noto_terrain_materials_package/visualization/model_view.html` |
| 29 texture sets and four plant assets | [Poly Haven CC0](https://polyhaven.com/license); per-asset authors, source pages and download records accompany the assets |
| Leaf Set 001 | [ambientCG CC0](https://docs.ambientcg.com/license/); original source metadata accompanies the atlas |
| Satellite imagery | EOxCloudless by EOX IT Services GmbH; contains modified Copernicus Sentinel data 2024; [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); source WMTS and tile coordinates in `gis/vegetation/SOURCE-MANIFEST.json` |
| Vegetation classification | University of Tsukuba [2024JPN_v26.03_vegetation](https://pen.envr.tsukuba.ac.jp/~utlulc/archive/Japan/2024JPN_v26.03_vegetation.html); supplied publisher README specifies research/academic-use context |
| Terrain DEM | [GSI Fundamental Geospatial Data service](https://service.gsi.go.jp/kiban/app/map/?search=dem); retained original GeoTIFF and metadata in `source-data/terrain/` |
| Geology and geotechnical reference inputs | [GSJ map](https://www.gsj.jp/Map/EN/docs/5man_doc/10/10_003.htm), [NIED K-NET/KiK-net](https://www.kyoshin.bosai.go.jp/en/), [MLIT Noto Reconstruction Office](https://www.hrr.mlit.go.jp/notofukkou/) and [J-SHIS](https://www.j-shis.bosai.go.jp/en/downloads); source records remain in `noto_terrain_materials_package/` |

EOX imagery is not CC0 and is included for noncommercial course use with attribution. Retain source notices and check the original data terms for other distribution contexts. Geotechnical CSVs and the material palette are project-curated summaries, not substitutes for site investigations.

The English package translates project comments, documentation and display metadata. The reference viewer's unused lunar-calendar text labels use ASCII numeric month notation (`1m` through `12m`, prefix `i` for intercalary months), with matching parsing; plotted scientific arrays and license headers are retained. Raw scientific rasters and binary model geometry are preserved.

## Ocean code contributions

The project uses Three.js/WebGL and custom JavaScript/GLSL, without adding a game engine or importing a complete external ocean application. The inverse Stockham transform organization is adapted from the pinned `dli/waves` code. Its source and MIT notice are identified above. Gaussian initialization, two-scale integration, choppy gradient/crest outputs, capability fallback, scheduler/state handling and the project water shading/reflection integration were developed for this viewer with Codex assistance. The coarse reflection camera follows the attributed Three.js reference; its proxy construction and capture budget are project-specific. These AI-assisted additions must be identified separately from independently student-written work in the final course report.

`src/sky-atmosphere.js`, `src/cloud-layers.js`, their procedural density/lighting, depth-aware integration, optical-column reflections, twilight grading and corresponding ocean sampling refinements were developed for this project with Codex assistance. They use generated noise and custom shaders rather than an external cloud-image asset or atmosphere engine. The existing Three.js runtime retains its MIT notice. These additions belong in the AI-assistance disclosure of the final report.
