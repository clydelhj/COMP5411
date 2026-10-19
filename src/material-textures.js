/* Layered material loader for Noto Peninsula.
Each geological class uses one color layer and one detail layer. Images are assembled once into shared DataArrayTextures; terrain tiles reuse them without duplicating images or GPU textures. */
(function registerNotoMaterialTextures(global) {
  'use strict';

  // COLOR_SIZE: width and height of each color-array layer, in pixels (integer).
  const COLOR_SIZE = 2048;
  // DETAIL_SIZE: width and height of each normal/roughness layer, in pixels (integer).
  const DETAIL_SIZE = 1024;
  // DEFAULT_CONCURRENCY: maximum number of concurrent image decode workers (integer).
  const DEFAULT_CONCURRENCY = 2;

  // 1. Configuration and image preparation.
  function requireConfig(config) {
    /* Validate and sort the material configuration by contiguous class ID.
Parameter: config contains color/detail paths and physical texture scales.
Check dimensions and the layer array, require IDs starting at zero without gaps, and require both images for every layer.
Returns normalized dimensions and sorted layers. */
    if (!config || !Array.isArray(config.layers) || !config.layers.length) {
      throw new Error('NotoMaterialTextures.load requires NOTO_MATERIAL_CONFIG.layers');
    }
    const colorSize = Number(config.colorSize) || COLOR_SIZE;
    const detailSize = Number(config.detailSize) || DETAIL_SIZE;
    if (
      !Number.isInteger(colorSize) ||
      !Number.isInteger(detailSize) ||
      colorSize < 1 ||
      detailSize < 1
    ) {
      throw new Error('NotoMaterialTextures config requires positive integer colorSize and detailSize');
    }
    const layers = config.layers.slice().sort((left, right) => Number(left.id) - Number(right.id));
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index] || {};
      const id = Number(layer.id);
      if (!Number.isInteger(id) || id !== index) {
        throw new Error(`NotoMaterialTextures layer IDs must be contiguous from 0; received ${layer.id}`);
      }
      if (!layer.color || !layer.detail) {
        throw new Error(`NotoMaterialTextures layer ${id} requires color and detail paths`);
      }
    }
    return { colorSize, detailSize, layers };
  }

  function resolveUrl(value) {
    /* Resolve a relative or absolute resource path against the document URL.
Parameter: value is the configured path string.
If URL parsing fails, retain the original value so the loader can report it.
Returns a string suitable for Image.src. */
    try {
      return new URL(String(value), global.document && global.document.baseURI || undefined).href;
    } catch (_) {
      return String(value);
    }
  }

  function loadImage(url) {
    /* Decode an image asynchronously, retaining useful failure context.
Parameter: url is the absolute image URL.
Create a temporary Image, request asynchronous decoding, and report the page protocol and resource URL on failure.
Returns Promise<HTMLImageElement>. */
    return new Promise((resolve, reject) => {
      if (typeof global.Image !== 'function') {
        reject(new Error('NotoMaterialTextures requires a browser Image API'));
        return;
      }
      const image = new global.Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => {
        const protocol = global.location && global.location.protocol || 'unknown';
        reject(new Error(`Unable to load material image ${url} (page protocol: ${protocol}; serve the project over HTTP if file:// is blocked)`));
      };
      image.src = url;
    });
  }

  async function loadEmbeddedImages(layer) {
    /* Load embedded images through an ordinary script so file pages do not taint the pixel-reading canvas.
Parameter: layer contains a class ID and embedded-script path.
Load the class script, retrieve its two data URLs, then remove the temporary global entry and script. Missing or damaged data raises an error rather than silently creating a blank material.
Returns Promise<{color:string, detail:string}>. */
    if (!layer.embedded) {
      throw new Error(`Missing embedded material images for layer ${layer.id}. Run scripts/package_material_images.py.`);
    }
    const store = global.NOTO_MATERIAL_IMAGES || (global.NOTO_MATERIAL_IMAGES = Object.create(null));
    return new Promise((resolve, reject) => {
      const script = global.document.createElement('script');
      const cleanup = () => {
        delete store[layer.id];
        script.onload = null;
        script.onerror = null;
        script.remove();
      };
      script.onload = () => {
        const images = store[layer.id];
        cleanup();
        if (!images || !images.color?.startsWith('data:image/jpeg;base64,') ||
            !images.detail?.startsWith('data:image/png;base64,')) {
          reject(new Error(`Invalid embedded material images for layer ${layer.id}`));
          return;
        }
        resolve(images);
      };
      script.onerror = () => {
        cleanup();
        reject(new Error(`Unable to load embedded material layer ${layer.id}: ${layer.embedded}`));
      };
      script.src = resolveUrl(layer.embedded);
      global.document.head.appendChild(script);
    });
  }

  function createCanvas(size) {
    /* Create a reusable square pixel-reading canvas.
Parameter: size is its integer edge length in pixels.
Request a 2D context suited to frequent readback. Returns {canvas, context}. */
    if (!global.document || typeof global.document.createElement !== 'function') {
      throw new Error('NotoMaterialTextures requires document.createElement(canvas)');
    }
    const canvas = global.document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('NotoMaterialTextures could not create a 2D canvas context');
    return { canvas, context };
  }

  function drawPixels(image, targetSize, canvasState, label) {
    /* Convert a decoded image to RGBA8 pixels in array-texture orientation.
Parameters: image is an HTMLImageElement; targetSize is the square edge length in pixels; canvasState holds the reusable canvas/context; label identifies failures.
Clear the canvas, draw with a vertical flip, then read ImageData for DataArrayTexture.flipY=false.
Returns Uint8ClampedArray. */
    const { canvas, context } = canvasState;
    context.clearRect(0, 0, targetSize, targetSize);
    // ImageData starts at the upper-left; flipping the draw with DataArrayTexture.flipY=false
    // matches TextureLoader orientation. The OpenGL normal-map Y component is not changed here.
    context.save();
    context.translate(0, targetSize);
    context.scale(1, -1);
    context.drawImage(image, 0, 0, targetSize, targetSize);
    context.restore();
    try {
      return context.getImageData(0, 0, targetSize, targetSize).data;
    } catch (error) {
      throw new Error(`Unable to read ${label} pixels from canvas: ${error.message}`);
    }
  }

  async function loadLayer(layer, index, colorState, detailState, colorData, detailData, config) {
    /* Write one material class into the shared color/detail pixel buffers.
Parameters: layer supplies paths/scales; index selects the array layer; colorState/detailState are reusable canvases; colorData/detailData are Uint8Array buffers; config contains validated sizes.
Choose same-origin or embedded images by page protocol, then decode each image and write its layer. Returns Promise<void>. */
    const id = Number(layer.id);
    // HTTP uses same-origin images; file uses data URLs delivered by scripts. Both decode to identical pixels.
    const embedded = global.location?.protocol === 'file:' ? await loadEmbeddedImages(layer) : null;
    const colorUrl = embedded ? embedded.color : resolveUrl(layer.color);
    const detailUrl = embedded ? embedded.detail : resolveUrl(layer.detail);
    const colorImage = await loadImage(colorUrl);
    const colorPixels = drawPixels(colorImage, config.colorSize, colorState, `color layer ${id}`);
    colorData.set(colorPixels, index * config.colorSize * config.colorSize * 4);
    const detailImage = await loadImage(detailUrl);
    const detailPixels = drawPixels(detailImage, config.detailSize, detailState, `detail layer ${id}`);
    detailData.set(detailPixels, index * config.detailSize * config.detailSize * 4);
  }

  // 2. Bounded asynchronous work and GPU texture configuration.
  async function forEachLimited(items, concurrency, callback) {
    /* Run asynchronous callbacks with bounded concurrency and report the first failure after workers finish.
Parameters: items is the input array; concurrency is the worker count; callback(item,index) returns a Promise.
Workers claim unique indices and stop claiming new work after the first failure. Returns Promise<void>, rejecting with that failure after cleanup. */
    let nextIndex = 0;
    let firstError = null;
    async function worker() {
      /* Claim the next unique item synchronously, await its callback, and stop after the first error.
Uses shared items, nextIndex, firstError and callback; takes no arguments.
Returns Promise<void>; the outer function waits for other workers to finish. */
      while (nextIndex < items.length) {
        const index = nextIndex++;
        if (firstError) return;
        try {
          await callback(items[index], index);
        } catch (error) {
          firstError = firstError || error;
          return;
        }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
    await Promise.allSettled(workers);
    if (firstError) throw firstError;
  }

  function configureTexture(texture, THREE, colorSpace) {
    /* Configure a DataArrayTexture and return the same object.
Parameters: texture is the target; THREE provides constants; colorSpace specifies color interpretation.
Set repeat addressing, trilinear mipmap filtering, no Y flip, and mark the texture for upload. */
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.wrapR = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return texture;
  }

  // 3. Build and return the two shared texture arrays.
  async function load(THREE, suppliedConfig) {
    /* Load every material class into shared color and detail arrays.
Parameters: THREE is the library namespace; suppliedConfig is optional and defaults to the global configuration.
Decode layers with bounded concurrency, build sRGB color and linear normal/roughness DataArrayTextures, and return per-class physical scales for triplanar mapping.
Returns Promise<{color, detail, scales}>. */
    if (!THREE || typeof THREE.DataArrayTexture !== 'function') {
      throw new Error('NotoMaterialTextures.load requires a THREE build with DataArrayTexture');
    }
    const config = requireConfig(suppliedConfig || global.NOTO_MATERIAL_CONFIG);
    const colorData = new Uint8Array(config.layers.length * config.colorSize * config.colorSize * 4);
    const detailData = new Uint8Array(config.layers.length * config.detailSize * config.detailSize * 4);
    const colorState = createCanvas(config.colorSize);
    const detailState = createCanvas(config.detailSize);
    try {
      await forEachLimited(
        config.layers,
        Math.max(1, Number(suppliedConfig && suppliedConfig.concurrency) || DEFAULT_CONCURRENCY),
        (layer, index) => loadLayer(layer, index, colorState, detailState, colorData, detailData, config)
      );
    } finally {
      // Release temporary canvas bitmaps; each DataArrayTexture retains its own pixel buffer.
      colorState.canvas.width = 1;
      colorState.canvas.height = 1;
      detailState.canvas.width = 1;
      detailState.canvas.height = 1;
    }

    let colorTexture;
    let detailTexture;
    try {
      colorTexture = configureTexture(
        new THREE.DataArrayTexture(colorData, config.colorSize, config.colorSize, config.layers.length),
        THREE,
        THREE.SRGBColorSpace
      );
      detailTexture = configureTexture(
        new THREE.DataArrayTexture(detailData, config.detailSize, config.detailSize, config.layers.length),
        THREE,
        THREE.NoColorSpace
      );
    } catch (error) {
      if (colorTexture) colorTexture.dispose();
      if (detailTexture) detailTexture.dispose();
      throw error;
    }

    const scales = new Float32Array(config.layers.length);
    for (let index = 0; index < config.layers.length; index++) {
      const scale = Number(config.layers[index].scaleM);
      scales[index] = scale > 0 ? scale : 12;
    }
    return { color: colorTexture, detail: detailTexture, scales };
  }

  global.NotoMaterialTextures = { load };
})(window);
