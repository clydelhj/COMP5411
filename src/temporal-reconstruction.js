/* Bounded GPU temporal reconstruction for static surfaces; the caller owns frame scheduling. */
(function registerTemporalReconstruction(global) {
  'use strict';

  const INTERNAL_SCALE = 0.75;
  const HISTORY_LIMIT = 8;
  const MAX_OUTPUT_PIXELS = 4 * 1024 * 1024;
  const STABLE_MEMBERSHIP_REASONS = new Set(['lighting', 'flashlight', 'vertical-scale', 'visibility', 'resize', 'vegetation-visibility']);
  // A fixed scale keeps previous depth independent of the camera's changing far plane.
  const DEPTH_SCALE = 65536;

  function halton(index, base) {
    let fraction = 1, value = 0;
    while (index > 0) {
      fraction /= base;
      value += fraction * (index % base);
      index = Math.floor(index / base);
    }
    return value;
  }

  const FULLSCREEN_VERTEX = `
    precision highp float;
    in vec3 position;
    out vec2 vUv;
    void main() {
      vUv = position.xy * 0.5 + 0.5;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  const RESOLVE_FRAGMENT = `
    precision highp float;
    precision highp sampler2D;
    in vec2 vUv;
    layout(location = 0) out vec4 resolvedColor;
    layout(location = 1) out vec4 surfaceMetadata;
    uniform sampler2D uCurrentColor;
    uniform sampler2D uCurrentDepth;
    uniform sampler2D uHistoryColor;
    uniform sampler2D uHistoryMetadata;
    uniform mat4 uInverseViewProjection;
    uniform mat4 uView;
    uniform mat4 uPreviousViewProjection;
    uniform mat4 uPreviousView;
    uniform vec2 uInputSize;
    uniform vec2 uOutputSize;
    uniform vec2 uJitterUv;
    uniform float uHistoryWeight;
    uniform bool uHasHistory;
    const float DEPTH_SCALE = ${DEPTH_SCALE.toFixed(1)};

    vec3 worldPositionAtUv(vec2 uv, float depth) {
      vec4 world = uInverseViewProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      return world.xyz / world.w;
    }

    vec3 worldPosition(ivec2 pixel, float depth) {
      return worldPositionAtUv((vec2(pixel) + 0.5) / uInputSize, depth);
    }

    ivec2 inputPixel(vec2 uv) {
      return clamp(ivec2(floor(uv * uInputSize)), ivec2(0), ivec2(uInputSize) - 1);
    }

    vec2 encodeNormal(vec3 normal) {
      normal /= abs(normal.x) + abs(normal.y) + abs(normal.z);
      vec2 folded = (1.0 - abs(normal.yx)) * mix(vec2(-1.0), vec2(1.0), greaterThanEqual(normal.xy, vec2(0.0)));
      return (normal.z >= 0.0 ? normal.xy : folded) * 0.5 + 0.5;
    }

    vec3 decodeNormal(vec2 encoded) {
      vec2 value = encoded * 2.0 - 1.0;
      vec3 normal = vec3(value, 1.0 - abs(value.x) - abs(value.y));
      float t = max(-normal.z, 0.0);
      normal.xy += mix(vec2(t), vec2(-t), greaterThanEqual(normal.xy, vec2(0.0)));
      return normalize(normal);
    }

    float luminance(vec3 color) {
      return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    // A bilinear color lookup uses four texels. Every corresponding surface sample must agree;
    // validating only the nearest one would leak a thin foreground object's old color into its wake.
    bool validHistoryTap(ivec2 pixel, vec3 normal, float expectedDepth, float tolerance) {
      vec4 old = texelFetch(uHistoryMetadata, pixel, 0);
      return old.w > 0.99 && abs(old.z * DEPTH_SCALE - expectedDepth) <= tolerance
        && dot(decodeNormal(old.xy), normal) >= 0.90;
    }

    void main() {
      vec2 currentUv = clamp(vUv + uJitterUv, 0.5 / uInputSize, 1.0 - 0.5 / uInputSize);
      vec4 current = texture(uCurrentColor, currentUv);
      ivec2 pixel = inputPixel(currentUv);
      float depth = texelFetch(uCurrentDepth, pixel, 0).r;
      vec3 currentRgb = max(current.rgb, vec3(0.0));
      resolvedColor = vec4(currentRgb, 1.0);
      surfaceMetadata = vec4(0.5, 0.5, 0.0, 0.0);
      // Reactive water, foliage and particles need only the current color, not surface reconstruction.
      if (current.a < 0.999 || depth >= 0.99999994 || depth <= 0.0) return;

      // Resolve color is at the actual subpixel UV, so its reprojection must use that same ray.
      // Native depth-texel centers are used separately to estimate a stable surface normal.
      vec3 world = worldPositionAtUv(currentUv, depth);
      vec3 nativeWorld = worldPosition(pixel, depth);
      float viewDepth = -(uView * vec4(world, 1.0)).z;
      ivec2 limit = ivec2(uInputSize) - 1;
      ivec2 left = max(pixel - ivec2(1, 0), ivec2(0));
      ivec2 right = min(pixel + ivec2(1, 0), limit);
      ivec2 down = max(pixel - ivec2(0, 1), ivec2(0));
      ivec2 up = min(pixel + ivec2(0, 1), limit);
      vec3 deltaLeft = nativeWorld - worldPosition(left, texelFetch(uCurrentDepth, left, 0).r);
      vec3 deltaRight = worldPosition(right, texelFetch(uCurrentDepth, right, 0).r) - nativeWorld;
      vec3 deltaDown = nativeWorld - worldPosition(down, texelFetch(uCurrentDepth, down, 0).r);
      vec3 deltaUp = worldPosition(up, texelFetch(uCurrentDepth, up, 0).r) - nativeWorld;
      // One-sided derivatives choose the closer surface, rather than spanning a depth silhouette.
      vec3 dx = dot(deltaLeft, deltaLeft) < dot(deltaRight, deltaRight) ? deltaLeft : deltaRight;
      vec3 dy = dot(deltaDown, deltaDown) < dot(deltaUp, deltaUp) ? deltaDown : deltaUp;
      vec3 crossNormal = cross(dx, dy);
      float normalLength = length(crossNormal);
      if (normalLength < 1e-12 || viewDepth <= 0.0) return;
      vec3 normal = crossNormal / normalLength;
      surfaceMetadata = vec4(encodeNormal(normal), viewDepth / DEPTH_SCALE, 1.0);
      if (!uHasHistory) return;

      vec4 previousClip = uPreviousViewProjection * vec4(world, 1.0);
      if (previousClip.w <= 0.0) return;
      vec3 previousNdc = previousClip.xyz / previousClip.w;
      vec2 historyUv = previousNdc.xy * 0.5 + 0.5;
      vec2 historyPixel = historyUv * uOutputSize - 0.5;
      ivec2 base = ivec2(floor(historyPixel));
      if (previousNdc.z < -1.0 || previousNdc.z > 1.0 || any(lessThan(base, ivec2(0)))
        || any(greaterThanEqual(base + 1, ivec2(uOutputSize)))) return;
      float expectedDepth = -(uPreviousView * vec4(world, 1.0)).z;
      float footprint = max(length(dx), length(dy));
      // Include a pixel footprint and RGBA16F depth quantization, but never an arbitrary coast-wide band.
      float tolerance = max(0.10, max(expectedDepth * 0.002, footprint * 1.5));
      if (!validHistoryTap(base, normal, expectedDepth, tolerance)
        || !validHistoryTap(base + ivec2(1, 0), normal, expectedDepth, tolerance)
        || !validHistoryTap(base + ivec2(0, 1), normal, expectedDepth, tolerance)
        || !validHistoryTap(base + ivec2(1, 1), normal, expectedDepth, tolerance)) return;

      vec3 minimumColor = currentRgb, maximumColor = currentRgb;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec3 nearby = texelFetch(uCurrentColor, clamp(pixel + ivec2(x, y), ivec2(0), limit), 0).rgb;
          minimumColor = min(minimumColor, nearby);
          maximumColor = max(maximumColor, nearby);
        }
      }
      vec3 history = texture(uHistoryColor, historyUv).rgb;
      float lightDelta = abs(luminance(history) - luminance(currentRgb))
        / max(0.05, max(luminance(history), luminance(currentRgb)));
      // Local shading changes are reactive even without an explicit global lighting invalidation.
      float weight = uHistoryWeight * (1.0 - smoothstep(0.04, 0.30, lightDelta));
      vec3 clippedHistory = clamp(history, minimumColor, maximumColor);
      resolvedColor.rgb = mix(currentRgb, clippedHistory, weight);
    }
  `;

  /*
   * Share the caller's Three.js renderer; own only reconstruction targets and full-screen resources.
   * render(scene,camera,{now}) takes a monotonic millisecond timestamp and draws one displayed frame.
   * invalidate(reason) clears history after scene changes; needsFrame() requests at most eight settling
   * attempts. The caller must schedule them and keep its normal sleep/visibility policy. Animated
   * surfaces are deliberately excluded from history rather than assigned inaccurate static motion.
   */
  function create({ THREE, renderer }) {
    /* Own only reconstruction targets and passes, using the caller's Three.js renderer.
     * The returned controller never schedules frames; needsFrame() requests finite settling
     * through the viewer's existing scheduler. Dimensions are drawing-buffer pixels.
     */
    const gl = renderer.getContext();
    let supportReason = null;
    if (!gl || typeof gl.drawBuffers !== 'function') supportReason = 'WebGL2 is required';
    else if (!gl.getExtension('EXT_color_buffer_float')) supportReason = 'Floating-point color targets are unavailable';
    else if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 2 || gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) < 2) supportReason = 'Two color attachments are required';
    else if (renderer.capabilities.logarithmicDepthBuffer || renderer.capabilities.reversedDepthBuffer) supportReason = 'This depth convention is not supported';
    const supported = supportReason === null;
    let enabled = true, active = false, disposed = false, failureReason = null, budgetReason = null;
    let currentTarget = null, historyTargets = [], readIndex = 0;
    let historyFrames = 0, settleRemaining = HISTORY_LIMIT, frames = 0, directFrames = 0;
    let resets = 0, lastResetReason = 'startup', sceneDirty = true, reactiveRecords = [], reactiveDiscoveries = 0;
    const resetCounts = {};
    const outputSize = new THREE.Vector2(), internalSize = new THREE.Vector2();
    const previousViewProjection = new THREE.Matrix4(), previousView = new THREE.Matrix4();
    const savedProjection = new THREE.Matrix4(), savedInverseProjection = new THREE.Matrix4();
    const currentViewProjection = new THREE.Matrix4(), inverseViewProjection = new THREE.Matrix4();
    const previousPosition = new THREE.Vector3(), previousDirection = new THREE.Vector3();
    const position = new THREE.Vector3(), direction = new THREE.Vector3();
    const previousProjection = new THREE.Matrix4();
    let hasPreviousCamera = false, lastNow = null, jitterIndex = 0;

    const resolveUniforms = {
      uCurrentColor: { value: null }, uCurrentDepth: { value: null },
      uHistoryColor: { value: null }, uHistoryMetadata: { value: null },
      uInverseViewProjection: { value: inverseViewProjection }, uView: { value: new THREE.Matrix4() },
      uPreviousViewProjection: { value: previousViewProjection }, uPreviousView: { value: previousView },
      uInputSize: { value: internalSize }, uOutputSize: { value: outputSize },
      uJitterUv: { value: new THREE.Vector2() }, uHistoryWeight: { value: 0 }, uHasHistory: { value: false }
    };
    const resolveMaterial = new THREE.RawShaderMaterial({
      name: 'NotoTemporalResolve', glslVersion: THREE.GLSL3, uniforms: resolveUniforms,
      vertexShader: FULLSCREEN_VERTEX, fragmentShader: RESOLVE_FRAGMENT,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending
    });
    const presentMaterial = new THREE.ShaderMaterial({
      name: 'NotoTemporalPresent', uniforms: { uResolved: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D uResolved; varying vec2 vUv;
        void main() {
          gl_FragColor = vec4(texture2D(uResolved, vUv).rgb, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending
    });
    const quadGeometry = new THREE.BufferGeometry();
    quadGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const quad = new THREE.Mesh(quadGeometry, resolveMaterial);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    function resetHistory(reason, rearm = true, rediscover = true) {
      historyFrames = 0;
      jitterIndex = 0;
      if (rearm) settleRemaining = HISTORY_LIMIT;
      if (rediscover) sceneDirty = true;
      lastResetReason = String(reason || 'scene');
      resets++;
      resetCounts[lastResetReason] = (resetCounts[lastResetReason] || 0) + 1;
    }

    function releaseTargets() {
      currentTarget?.dispose();
      for (const target of historyTargets) target.dispose();
      currentTarget = null;
      historyTargets = [];
      active = false;
    }

    function ensureTargets() {
      const width = Math.floor(outputSize.x), height = Math.floor(outputSize.y);
      if (!width || !height || width * height > MAX_OUTPUT_PIXELS) {
        budgetReason = `Temporal output exceeds the ${MAX_OUTPUT_PIXELS.toLocaleString('en-US')}-pixel budget`;
        releaseTargets();
        return false;
      }
      budgetReason = null;
      if (currentTarget && historyTargets[0].width === width && historyTargets[0].height === height) return true;
      releaseTargets();
      internalSize.set(Math.max(1, Math.round(width * INTERNAL_SCALE)), Math.max(1, Math.round(height * INTERNAL_SCALE)));
      const options = {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat, colorSpace: THREE.LinearSRGBColorSpace,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
        depthBuffer: false, stencilBuffer: false
      };
      currentTarget = new THREE.WebGLRenderTarget(internalSize.x, internalSize.y, { ...options, depthBuffer: true });
      currentTarget.texture.name = 'Temporal current linear color and reactive mask';
      currentTarget.depthTexture = new THREE.DepthTexture(internalSize.x, internalSize.y, THREE.UnsignedIntType);
      currentTarget.depthTexture.minFilter = currentTarget.depthTexture.magFilter = THREE.NearestFilter;
      for (let i = 0; i < 2; i++) {
        const target = new THREE.WebGLRenderTarget(width, height, { ...options, count: 2 });
        target.textures[0].name = `Temporal resolved linear color ${i}`;
        target.textures[1].name = `Temporal world normal, view depth and validity ${i}`;
        target.textures[1].minFilter = target.textures[1].magFilter = THREE.NearestFilter;
        historyTargets.push(target);
      }
      for (const target of [currentTarget, ...historyTargets]) {
        renderer.setRenderTarget(target);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('A temporal floating-point framebuffer is incomplete');
        }
        renderer.clear();
      }
      readIndex = 0;
      resetHistory('resize', true, false);
      return true;
    }

    function discoverReactiveMaterials(scene) {
      const materials = new Set();
      scene.traverse(object => {
        if (!object.material) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (material && !material.premultipliedAlpha
            && (material.blending === THREE.MultiplyBlending || material.blending === THREE.SubtractiveBlending)) {
            throw new Error('This Three.js blend mode requires premultiplied alpha');
          }
          // The auxiliary alpha channel cannot also represent physical destination opacity.
          // Fall back rather than changing a custom RGB equation that explicitly depends on it.
          if (material?.blending === THREE.CustomBlending && [material.blendSrc, material.blendDst].some(factor =>
            factor === THREE.DstAlphaFactor || factor === THREE.OneMinusDstAlphaFactor || factor === THREE.SrcAlphaSaturateFactor)) {
            throw new Error('Destination-alpha color blending requires direct rendering');
          }
          if (material && (object.isInstancedMesh || material.transparent || material.isShaderMaterial || material.userData?.temporalReactive)) materials.add(material);
        }
      });
      reactiveRecords = [...materials].map(material => ({ material }));
      reactiveDiscoveries++;
      sceneDirty = false;
    }

    function maskReactiveMaterials() {
      for (const record of reactiveRecords) {
        const material = record.material;
        for (const key of ['blending', 'blendEquation', 'blendSrc', 'blendDst', 'blendEquationAlpha', 'blendSrcAlpha', 'blendDstAlpha']) record[key] = material[key];
      }
      for (const record of reactiveRecords) {
        const material = record.material;
        let source = THREE.OneFactor, destination = THREE.ZeroFactor, equation = THREE.AddEquation;
        if (material.blending === THREE.CustomBlending) {
          source = material.blendSrc;
          destination = material.blendDst;
          equation = material.blendEquation;
        } else if (material.blending !== THREE.NoBlending && !(material.blending === THREE.NormalBlending && !material.transparent)) {
          if (material.blending === THREE.NormalBlending) {
            source = material.premultipliedAlpha ? THREE.OneFactor : THREE.SrcAlphaFactor;
            destination = THREE.OneMinusSrcAlphaFactor;
          } else if (material.blending === THREE.AdditiveBlending) {
            source = material.premultipliedAlpha ? THREE.OneFactor : THREE.SrcAlphaFactor;
            destination = THREE.OneFactor;
          } else if (material.blending === THREE.SubtractiveBlending) {
            source = THREE.ZeroFactor;
            destination = THREE.OneMinusSrcColorFactor;
          } else if (material.blending === THREE.MultiplyBlending) {
            source = THREE.DstColorFactor;
            destination = THREE.OneMinusSrcAlphaFactor;
          }
        }
        material.blending = THREE.CustomBlending;
        material.blendEquation = equation;
        material.blendSrc = source;
        material.blendDst = destination;
        material.blendEquationAlpha = THREE.AddEquation;
        material.blendSrcAlpha = THREE.ZeroFactor;
        material.blendDstAlpha = THREE.ZeroFactor;
      }
    }

    function restoreReactiveMaterials() {
      for (const record of reactiveRecords) {
        for (const key of ['blending', 'blendEquation', 'blendSrc', 'blendDst', 'blendEquationAlpha', 'blendSrcAlpha', 'blendDstAlpha']) record.material[key] = record[key];
      }
    }

    function render(scene, camera, context = {}) {
      // Preserve the caller's target and unjittered camera for navigation, picking and shadows.
      if (!enabled || !supported || disposed || failureReason) {
        active = false;
        directFrames++;
        renderer.render(scene, camera);
        return;
      }
      const savedTarget = renderer.getRenderTarget();
      const savedCubeFace = renderer.getActiveCubeFace?.() || 0;
      const savedMipmap = renderer.getActiveMipmapLevel?.() || 0;
      const savedAutoClear = renderer.autoClear;
      const savedInfoReset = renderer.info.autoReset;
      const savedFrame = renderer.info.render.frame;
      const savedShaderError = renderer.debug.onShaderError;
      let failure = null, rendered = false;
      savedProjection.copy(camera.projectionMatrix);
      savedInverseProjection.copy(camera.projectionMatrixInverse);
      try {
        renderer.getDrawingBufferSize(outputSize);
        if (savedTarget) outputSize.set(savedTarget.width, savedTarget.height);
        if (!ensureTargets()) {
          renderer.setRenderTarget(savedTarget, savedCubeFace, savedMipmap);
          directFrames++;
          renderer.render(scene, camera);
          rendered = true;
          return;
        }
        active = true;
        camera.updateMatrixWorld();
        camera.getWorldPosition(position);
        camera.getWorldDirection(direction);
        currentViewProjection.multiplyMatrices(savedProjection, camera.matrixWorldInverse);
        const now = Number.isFinite(context.now) ? context.now : (typeof performance !== 'undefined' ? performance.now() : 0);
        if (hasPreviousCamera) {
          const cameraCut = position.distanceTo(previousPosition) > Math.max(8, previousPosition.length() * 0.35)
            || direction.dot(previousDirection) < 0.85
            || Math.abs(savedProjection.elements[0] / previousProjection.elements[0] - 1) > 0.1
            || Math.abs(savedProjection.elements[5] / previousProjection.elements[5] - 1) > 0.1;
          if (cameraCut && historyFrames > 0) resetHistory('camera-cut', true, false);
          else if (!currentViewProjection.equals(previousViewProjection)) settleRemaining = HISTORY_LIMIT;
          // A slow GPU must not repeatedly rearm settling merely because its own frames exceed this gap.
          if (historyFrames > 0 && lastNow !== null && (now < lastNow || now - lastNow > 250)) resetHistory('frame-gap', false, false);
        }
        if (sceneDirty) discoverReactiveMaterials(scene);
        const jitter = jitterIndex % HISTORY_LIMIT + 1;
        const jitterX = halton(jitter, 2) - 0.5, jitterY = halton(jitter, 3) - 0.5;
        resolveUniforms.uJitterUv.value.set(jitterX / internalSize.x, jitterY / internalSize.y);
        if (camera.isPerspectiveCamera) {
          camera.projectionMatrix.elements[8] -= 2 * jitterX / internalSize.x;
          camera.projectionMatrix.elements[9] -= 2 * jitterY / internalSize.y;
        } else {
          camera.projectionMatrix.elements[12] += 2 * jitterX / internalSize.x;
          camera.projectionMatrix.elements[13] += 2 * jitterY / internalSize.y;
        }
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        inverseViewProjection.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
        resolveUniforms.uView.value.copy(camera.matrixWorldInverse);
        resolveUniforms.uHasHistory.value = historyFrames > 0;
        resolveUniforms.uHistoryWeight.value = Math.min(0.875, historyFrames / (historyFrames + 1));
        const read = historyTargets[readIndex], write = historyTargets[1 - readIndex];
        resolveUniforms.uCurrentColor.value = currentTarget.texture;
        resolveUniforms.uCurrentDepth.value = currentTarget.depthTexture;
        resolveUniforms.uHistoryColor.value = read.textures[0];
        resolveUniforms.uHistoryMetadata.value = read.textures[1];
        renderer.autoClear = true;
        if (savedInfoReset) renderer.info.reset();
        renderer.info.autoReset = false;
        // Three normally logs shader-link errors and keeps drawing. Convert them to a safe direct fallback.
        renderer.debug.onShaderError = (contextGl, program, vertex, fragment) => {
          if (savedShaderError) savedShaderError(contextGl, program, vertex, fragment);
          throw new Error('Temporal rendering encountered a shader compilation or link error');
        };
        renderer.setRenderTarget(currentTarget);
        // 1. Shade the scene once, storing static eligibility in alpha without changing RGB.
        try {
          maskReactiveMaterials();
          renderer.render(scene, camera);
        } finally {
          restoreReactiveMaterials();
        }
        quad.material = resolveMaterial;
        // 2. Validate/reproject static history and write this frame's color and metadata together.
        renderer.setRenderTarget(write);
        renderer.render(quadScene, quadCamera);
        quad.material = presentMaterial;
        // 3. Present linear history through the normal output color/tone conversion.
        presentMaterial.uniforms.uResolved.value = write.textures[0];
        renderer.setRenderTarget(savedTarget, savedCubeFace, savedMipmap);
        renderer.autoClear = savedAutoClear;
        renderer.render(quadScene, quadCamera);
        readIndex = 1 - readIndex;
        previousViewProjection.copy(currentViewProjection);
        previousView.copy(camera.matrixWorldInverse);
        previousPosition.copy(position);
        previousDirection.copy(direction);
        previousProjection.copy(savedProjection);
        hasPreviousCamera = true;
        lastNow = now;
        jitterIndex++;
        historyFrames = Math.min(HISTORY_LIMIT, historyFrames + 1);
        settleRemaining = Math.max(0, settleRemaining - 1);
        frames++;
        rendered = true;
      } catch (error) {
        failure = error;
      } finally {
        camera.projectionMatrix.copy(savedProjection);
        camera.projectionMatrixInverse.copy(savedInverseProjection);
        renderer.setRenderTarget(savedTarget, savedCubeFace, savedMipmap);
        renderer.autoClear = savedAutoClear;
        renderer.info.autoReset = savedInfoReset;
        renderer.debug.onShaderError = savedShaderError;
        // The two full-screen passes belong to one displayed frame, while draw/triangle totals include their real cost.
        if (rendered) renderer.info.render.frame = savedFrame + 1;
      }
      if (failure) {
        failureReason = failure.message || String(failure);
        releaseTargets();
        resetHistory('fallback', false);
        console.warn('Temporal reconstruction disabled; using direct rendering:', failureReason);
        directFrames++;
        renderer.render(scene, camera);
      }
    }

    return {
      render,
      invalidate(reason = 'scene') { resetHistory(reason, true, !STABLE_MEMBERSHIP_REASONS.has(reason)); },
      setEnabled(value) {
        const next = Boolean(value);
        if (next === enabled) return;
        enabled = next;
        if (next) failureReason = null;
        else releaseTargets();
        resetHistory(next ? 'enabled' : 'disabled');
        hasPreviousCamera = false;
        lastNow = null;
      },
      needsFrame: () => enabled && supported && active && !failureReason && settleRemaining > 0,
      getState: () => ({
        enabled, active, supported,
        reason: supportReason || failureReason || budgetReason,
        fallbackReason: supportReason || failureReason || budgetReason,
        frames, directFrames, historyFrames, settleRemaining, resets, lastResetReason,
        resetCounts: { ...resetCounts }, outputSize: outputSize.toArray(), internalSize: internalSize.toArray(),
        reactiveMaterials: reactiveRecords.length, reactiveDiscoveries, internalScale: INTERNAL_SCALE,
        estimatedTargetMiB: currentTarget ? (internalSize.x * internalSize.y * 12 + outputSize.x * outputSize.y * 32) / 1048576 : 0,
        maximumHistoryFrames: HISTORY_LIMIT, maximumOutputPixels: MAX_OUTPUT_PIXELS
      }),
      dispose() {
        releaseTargets();
        quadGeometry.dispose();
        resolveMaterial.dispose();
        presentMaterial.dispose();
        reactiveRecords = [];
        disposed = true;
        enabled = false;
      }
    };
  }

  global.NotoTemporalReconstruction = { create };
})(window);
