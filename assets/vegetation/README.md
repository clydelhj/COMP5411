# Vegetation models and runtime assets

## Retained sources

All four assets use [Poly Haven CC0](https://polyhaven.com/license). Original 4K color, OpenGL normal and ARM images are retained (ARM: R=AO, G=roughness, B=metalness).

| Asset | Author | Included source |
| --- | --- | --- |
| [tree_small_02](https://polyhaven.com/a/tree_small_02) | Rico Cilliers | Complete single-tree glTF, geometry and 4K textures |
| [fir_tree_01](https://polyhaven.com/a/fir_tree_01) | Rico Cilliers (model), Rob Tuytel (photography) | Self-contained original A/C tree extracts and required 4K images; extraction-a.json / extraction.json identify original buffer ranges; runtime uses A |
| [grass_medium_02](https://polyhaven.com/a/grass_medium_02) | Rico Cilliers | Five grass variants, original geometry and 4K textures |
| [fern_02](https://polyhaven.com/a/fern_02) | Rob Tuytel (scan), Rico Cilliers (model) | Four fern variants, original geometry and 4K textures |

Each `source/<asset>/files.json` retains provider URLs, sizes and MD5 records; `info.json` records metadata. Tree forms are proxies, not claims about native Noto species. See the [GIS README](../../gis/vegetation/README.md).

## Runtime representation

`runtime/vegetation-models.js` embeds gzip geometry and image data URLs for offline file/HTTP use. Runtime images are 2K color and 1K normal/roughness. Black background in RGB leaf atlases becomes a derived opacity mask for alpha testing. Color is sRGB; data channels are linear, retaining glTF UV transforms.

Near broadleaf/conifer prototypes contain approximately 82,488/81,895 triangles; middle prototypes approximately 14,292/14,616. Per-material counts and metadata are in `runtime/model-lod-metadata.json`. Bundled MIT meshoptimizer 1.1.1 is an offline tool, not a browser runtime dependency.

Branches use weighted normal/UV mesh simplification. Leaves use stable whole-component selection so narrow foliage does not disappear. Representative leaf components are enlarged around their centres: broadleaf near/middle multipliers 2.5/5 and conifer 4/7. This is a visual approximation, not a measurement of leaf size, area or biomass. Component sampling has no edge-collapse error estimate; `relativeError` is null.

Each tree has four display shapes: source, narrow crown, broad crown and offset crown. Horizontal deformation depends on normalized height; UVs/indices and root/Y positions remain unchanged, while normals use the inverse-transpose Jacobian. These are variants of one source tree, not four scanned species. Deformed `relativeError` is null; `sourceLodRelativeError` describes the source LOD only.

Side and overhead cards are baked per shape into shared WebGL render targets at startup. Stable spatial seeds control height, heading and subtle color variation. Positions use a 12 m grid for every distance tier; detail changes without random thinning. Plants fade at 1200-1500 m and stop drawing beyond 1500 m. Auto/high/medium/low/off controls 3D geometry; ground cover is independent.

Nearby foliage/herbs have subtle wind motion. Idle frames advance only the wind clock, not placement. Immediate/15 s/30 s/1 min/5 min/Never sleep settings apply; modal and hidden-page states pause the current pose. Resume steps are bounded, distant cards stay static, and no visible animated plants means no independent wind draw loop.

## Rebuild

From the project root, with dependencies from `requirements-rebuild.txt`:

```sh
python scripts/build_vegetation_assets.py
python scripts/build_vegetation_assets.py --models --node node
```

The first command packages local classification only. The second also rebuilds geometry, textures and shape variants using Node.js and the bundled meshoptimizer. Sources and DEM are unchanged. Successful runs clean their `.build` intermediates; failed runs retain them. Do not hand-format generated payloads.

## Low ground grass

The current viewer adds a continuous grass texture and nearby instanced blades to mapped grass/woodland and soil-family bare ground. A stable 0.8 m seed grid retains positions between detail tiers; 12/6/3-blade geometry fades between 55 and 80 m. The bare-soil extension is a visual approximation, not a change to the source vegetation classification. `runtime/grass-ground.js` contains the derived local texture channels.
