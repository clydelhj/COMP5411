# Terrain, water and vegetation textures

## Geological materials

The [material library](assets/material-library/README.md) contains 29 Poly Haven 4K PBR sets and one ambientCG 4K leaf atlas, collected on 2026-09-23 under CC0. Authors, source pages and download records are retained. See the [class table](assets/material-library/MATERIAL-MAPPING.md) for lithological mappings and approximation limits.

The viewer uses 29 shared array layers: 27 land classes (1-19, 21-28), plus bedrock fallbacks at 0 and 20. The runtime color channel is 2048-square JPEG/sRGB; detail is 1024-square PNG with linear OpenGL normal in RGB and roughness in alpha. Original AO/displacement images are retained without adding DEM displacement. Arrays occupy approximately 580 MiB of CPU pixels and 773 MiB on the GPU with mipmaps, excluding other resources.

Triplanar projection covers top, cut and base surfaces. Adjacent categories blend color, normals and roughness continuously, with nominal horizontal/vertical half-widths of 192/9.6 m, capped by category-grid support and thin borehole intervals. Display repeats of 8-24 m and blend widths are visual parameters, not measured grains, joints or geological contacts. Source scans are not Noto samples.

`python scripts/build_runtime_materials.py` generates runtime images/configuration and embedded wrappers from local sources. `python scripts/package_material_images.py` updates wrappers alone. Embedded scripts avoid tainted-canvas pixel reads on file pages; HTTP uses equivalent same-origin images. No browser security settings need changing.

## Procedural water

`src/water-materials.js` generates two shared 512-square RGBA textures at startup. Color RGB is sRGB water color; its alpha contains linear foam noise, not transparency. Detail RGB contains normals in +X/+Z/+Y orientation; alpha contains roughness. Fixed seeded periodic noise and central differences make tileable patterns. Total CPU pixels are 2 MiB, with approximately 2.67 MiB GPU storage including mipmaps.

`src/water-motion.js` combines Gerstner wavelengths of 192/96/48 m with four independently moving normal scales of 7/31/96/576 m. Global X/Z sampling avoids tile resets. Shoreline distance drives attenuation and advancing, distorted, patchy foam; pixel-footprint filtering suppresses distant aliasing. Side walls and the base use separate blue materials.

`data/shoreline-data.js` derives from the approximately 25 m ocean mask. Sky reflection is a gradient approximation that follows sky color, without terrain reflections. Sunlight/weather come from `src/environment.js`; sleep settings control every animation. These are generated visual effects, not downloaded ocean images or measured Noto sea conditions.

## Vegetation

Four [Poly Haven model assets](assets/vegetation/README.md) retain glTF geometry and 4K source textures. Runtime color is 2K and normal/roughness is 1K; near/middle geometry is derived offline, while distant cards are baked at startup. Plant models are generic visual proxies with fixed shape variants.

Coverage is based on the University of Tsukuba 2024 vegetation classification, not texture photographs. EOX Sentinel-2 2024 cloudless RGB is a regional reference. Its CC BY-NC-SA 4.0 license differs from the models' CC0. Source details, QGIS instructions and interpretation limits are in the [GIS README](gis/vegetation/README.md).
