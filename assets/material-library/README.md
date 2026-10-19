# Rock, soil and vegetation texture library

Collected on 2026-09-23: 30 CC0 assets with original source images and derived runtime textures.

![Material overview](contact-sheet.jpg)

## Source assets

| Category | Asset | Intended appearance | Source |
| --- | --- | --- | --- |
| rock | [Rock Boulder Dry](rock/rock_boulder_dry/) | Dry weathered rock | [Source page](https://polyhaven.com/a/rock_boulder_dry) |
| rock | [Sandstone Cracks](rock/sandstone_cracks/) | Sandstone grains and fine cracks | [Source page](https://polyhaven.com/a/sandstone_cracks) |
| rock | [Dark Rock](rock/dark_rock/) | Dark-rock visual proxy | [Source page](https://polyhaven.com/a/dark_rock) |
| soil | [Brown Mud 03](soil/brown_mud_03/) | Brown topsoil and mud | [Source page](https://polyhaven.com/a/brown_mud_03) |
| soil | [Sandy Gravel](soil/sandy_gravel/) | Mixed sand/gravel ground | [Source page](https://polyhaven.com/a/sandy_gravel) |
| coast | [Coast Sand 01](coast/coast_sand_01/) | Coastal sand | [Source page](https://polyhaven.com/a/coast_sand_01) |
| grass | [Grass Ground](grass/grass_ground/) | Grass ground | [Source page](https://polyhaven.com/a/grass_ground) |
| grass | [Sparse Grass](grass/sparse_grass/) | Sparse grass and bare-soil transition | [Source page](https://polyhaven.com/a/sparse_grass) |
| grass | [Aerial Grass Rock](grass/aerial_grass_rock/) | Grassy rocky slope | [Source page](https://polyhaven.com/a/aerial_grass_rock) |
| forest | [Forest Ground 01](forest/forrest_ground_01/) | Forest litter and dry grass | [Source page](https://polyhaven.com/a/forrest_ground_01) |
| forest | [Leaves Forest Ground](forest/leaves_forest_ground/) | Forest leaf litter | [Source page](https://polyhaven.com/a/leaves_forest_ground) |
| bark | [Japanese Cedar Bark](bark/japanese_cedar_bark/) | Japanese cedar bark visual proxy | [Source page](https://polyhaven.com/a/japanese_cedar_bark) |
| bark | [Pine Bark](bark/pine_bark/) | Pine bark visual proxy | [Source page](https://polyhaven.com/a/pine_bark) |
| foliage | [Leaf Set 001](foliage/LeafSet001/) | Leaf-card atlas with an opacity mask | [Source page](https://ambientcg.com/view?id=LeafSet001) |
| rock | [Rock 01](rock/rock_01/) | Smooth fine-grained gray rock; mudstone proxy | [Source page](https://polyhaven.com/a/rock_01) |
| rock | [Rock 05](rock/rock_05/) | Pitted weathered rock; tuff proxy | [Source page](https://polyhaven.com/a/rock_05) |
| rock | [Rock 06](rock/rock_06/) | Banded rock; sandstone/mudstone proxy | [Source page](https://polyhaven.com/a/rock_06) |
| rock | [Rock 08](rock/rock_08/) | Rough light blocky rock; volcaniclastic proxy | [Source page](https://polyhaven.com/a/rock_08) |
| rock | [Rock 2](rock/rock_2/) | Coarse sandy rock; tuffaceous-sandstone proxy | [Source page](https://polyhaven.com/a/rock_2) |
| rock | [Rock Surface](rock/rock_surface/) | Eroded granular rock; crystalline-rock proxy | [Source page](https://polyhaven.com/a/rock_surface) |
| rock | [Dry Riverbed Rock](rock/dry_riverbed_rock/) | Fine striations and cracks; siliceous-mudstone proxy | [Source page](https://polyhaven.com/a/dry_riverbed_rock) |
| rock | [Dark Rock 02](rock/dark_rock_02/) | Dark flaky layered rock; carbonaceous-shale proxy | [Source page](https://polyhaven.com/a/dark_rock_02) |
| rock | [Cliff Side](rock/cliff_side/) | Sedimentary cliff; layered-rock proxy | [Source page](https://polyhaven.com/a/cliff_side) |
| rock | [Rock Boulder Cracked](rock/rock_boulder_cracked/) | Large fractured blocks; tuff-breccia proxy | [Source page](https://polyhaven.com/a/rock_boulder_cracked) |
| rock | [Rock Face 03](rock/rock_face_03/) | Eroded broken rock; weathered-mudstone proxy | [Source page](https://polyhaven.com/a/rock_face_03) |
| soil | [Brown Mud Dry](soil/brown_mud_dry/) | Dry crumbly soil | [Source page](https://polyhaven.com/a/brown_mud_dry) |
| soil | [Brown Mud Rocks 01](soil/brown_mud_rocks_01/) | Stony clay and mixed colluvial-soil appearance | [Source page](https://polyhaven.com/a/brown_mud_rocks_01) |
| soil | [Brown Mud](soil/brown_mud/) | Bare topsoil with plant debris | [Source page](https://polyhaven.com/a/brown_mud) |
| soil | [Dense Sand](soil/dense_sand/) | Dense sand and fine-soil appearance | [Source page](https://polyhaven.com/a/dense_sand) |
| soil | [Gravelly Sand](soil/gravelly_sand/) | Gravelly sand and sandy-soil appearance | [Source page](https://polyhaven.com/a/gravelly_sand) |

## Files and conventions

Poly Haven sets retain official 4K JPEG Diffuse, OpenGL Normal, Roughness, AO and Displacement channels. 4K is the provider's resolution tier; the other dimension of a nonsquare image may be smaller than 4096. Leaf Set 001 retains its 4K PNG archive and extracted files; it is an opacity-masked leaf atlas, not a seamless grass texture.

`catalog.json` records authors, source pages, categories and uses. Each asset retains `source-info.json`; Poly Haven assets also retain `source-files.json`. `download-manifest.json` records download URLs, relative paths, expected byte counts and provider MD5 values where available. Licenses are [Poly Haven CC0](https://polyhaven.com/license) and [ambientCG CC0](https://docs.ambientcg.com/license/).

Color is sRGB; normal, roughness, AO and height are linear data. Use OpenGL normals for this viewer. Leaf atlases need appropriate UVs and alpha testing; bark textures use trunk UVs. Height images are retained but do not displace the DEM.

The runtime uses 2048-square color images and 1024-square detail images, with RGB normals and alpha roughness. All tiles share the arrays. Physical display repeats of 8-24 m are visualization scales, not measured grain or joint spacing. Grass, forest, bark and leaf textures are retained as source assets; live vegetation uses the separate plant model library.

See [class mapping](MATERIAL-MAPPING.md) for all 27 land recipes and limitations, and [the additional rock/soil overview](rock-soil-expansion.jpg) for the supplementary assets. The same category always uses the same recipe, independent of location. Water uses procedural textures described in [TEXTURE-SOURCES.md](../../TEXTURE-SOURCES.md).

File pages load per-class `runtime/class-XX-embedded.js` data URLs. HTTP pages load the same image bytes directly. Temporary globals/script nodes are released after loading. Regenerate wrappers with `python scripts/package_material_images.py` from the project root.

These textures are visual assets, not Noto field samples or evidence of local lithology or plant distribution.
