/* =============================================================================
 * SKY PUSH — depth of field (replay editor only)
 * A tiny hand-rolled post pass — no EffectComposer, no external shaders:
 *   1. render the scene into an offscreen target with a depth texture
 *   2. composite full-screen: per-pixel circle-of-confusion from depth vs the
 *      focus distance, 24-tap spiral gather scaled by the CoC
 * Key properties:
 *   - a FOCUS RANGE dead zone: everything within ±range meters of the focus
 *     distance is left TACK SHARP (zero CoC) — a whole person fits in focus
 *   - ANAMORPHIC bokeh: the gather kernel is squeezed in X and stretched in
 *     Y, so highlights smear into the vertical ovals of anamorphic glass
 *   - color-managed: the sRGB render target is hardware-decoded to LINEAR on
 *     sampling, blur happens in linear light (physically nicer bokeh), and
 *     the final write re-encodes with the exact sRGB curve — enabling DoF no
 *     longer shifts the image darker/saturated
 * Also exposes renderDepth() — a linearized depth-map visual for compositing.
 * Costs one extra scene pass — only ever active inside the replay editor.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.DoF = (function () {
  let rt = null, postScene = null, postCam = null, mat = null, depthMat = null;
  let W = 0, H = 0;
  const _size = new THREE.Vector2();

  const COMMON = `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float uNear, uFar, uFocus, uRange, uAperture, uMaxCoc, uAspect;
    varying vec2 vUv;

    float viewDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // perspective depth -> positive view-space distance
      return (uNear * uFar) / (uFar - d * (uFar - uNear));
    }
    // exact sRGB encode — matches three's LinearTosRGB, so the DoF frame is
    // byte-identical to the direct render wherever CoC is zero
    vec3 lin2srgb(vec3 c) {
      c = clamp(c, 0.0, 1.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
                 step(vec3(0.0031308), c));
    }`;

  const FRAG = COMMON + `
    float cocAt(vec2 uv) {
      float z = viewDepth(uv);
      float d = max(0.0, abs(z - uFocus) - uRange);   // dead zone = sharp band
      return clamp(uAperture * d / max(z, 0.2), 0.0, uMaxCoc);
    }
    void main() {
      float c = cocAt(vUv);
      vec3 center = texture2D(tDiffuse, vUv).rgb;
      if (c < 1e-5) {                                  // in focus: untouched
        gl_FragColor = vec4(lin2srgb(center), 1.0);
        return;
      }
      vec3 acc = center;
      float wsum = 1.0;
      // anamorphic kernel: squeezed X, stretched Y (vertical oval bokeh);
      // bright samples weigh more so highlights bloom into discs
      #define TAP(ox, oy) { \\
        vec2 off = vec2(ox * 0.5, oy * uAspect * 1.45) * c; \\
        float cd = cocAt(vUv + off); \\
        float w = clamp(cd / c, 0.06, 1.0); \\
        vec3 smp = texture2D(tDiffuse, vUv + off).rgb; \\
        float lum = dot(smp, vec3(0.299, 0.587, 0.114)); \\
        w *= 1.0 + lum * lum * 2.2; \\
        acc += smp * w; \\
        wsum += w; }
      TAP(0.1443, 0.0000) TAP(-0.1843, 0.1689) TAP(0.0282, -0.3215)
      TAP(0.2324, 0.3031) TAP(-0.4264, -0.0754) TAP(0.4039, -0.2569)
      TAP(-0.1351, 0.5026) TAP(-0.2577, -0.4961) TAP(0.5590, 0.2041)
      TAP(-0.5816, 0.2401) TAP(0.2803, -0.5991) TAP(0.2072, 0.6605)
      TAP(-0.6244, -0.3619) TAP(0.7325, -0.1610) TAP(-0.4470, 0.6359)
      TAP(-0.1033, -0.7970) TAP(0.6340, 0.5343) TAP(-0.8532, 0.0353)
      TAP(0.6223, -0.6193) TAP(-0.0416, 0.9004) TAP(-0.5922, -0.7096)
      TAP(0.9380, 0.1262) TAP(-0.7948, 0.5530) TAP(0.2172, -0.9654)
      gl_FragColor = vec4(lin2srgb(acc / wsum), 1.0);
    }`;

  /* linearized-depth visual: near = white, far = black. uK sets how far the
     ramp reaches (the editor's Range slider). Raw grayscale for compositing. */
  const DEPTH_FRAG = COMMON + `
    uniform float uK;
    void main() {
      float z = viewDepth(vUv);
      float g = exp(-z * uK);
      gl_FragColor = vec4(vec3(g), 1.0);
    }`;

  const VERT = `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  function makeUniforms() {
    return {
      tDiffuse: { value: null }, tDepth: { value: null },
      uNear: { value: 0.08 }, uFar: { value: 500 },
      uFocus: { value: 10 }, uRange: { value: 1.6 },
      uAperture: { value: 0.5 }, uMaxCoc: { value: 0.02 },
      uAspect: { value: 1 }, uK: { value: 0.028 },
    };
  }

  function ensure(renderer) {
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(2, _size.x | 0), h = Math.max(2, _size.y | 0);
    if (rt && w === W && h === H) return;
    W = w; H = h;
    if (rt) { rt.dispose(); }
    const depthTex = new THREE.DepthTexture(w, h);
    depthTex.type = THREE.UnsignedIntType;
    rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthTexture: depthTex, depthBuffer: true,
    });
    // sRGB target: stores display-ready bytes, hardware DECODES to linear on
    // sampling — the shaders re-encode on output (lin2srgb) for a clean loop
    rt.texture.encoding = THREE.sRGBEncoding;
    if (!postScene) {
      mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, uniforms: makeUniforms(),
        depthTest: false, depthWrite: false, toneMapped: false,
      });
      depthMat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: DEPTH_FRAG, uniforms: makeUniforms(),
        depthTest: false, depthWrite: false, toneMapped: false,
      });
      postScene = new THREE.Scene();
      postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    for (const m of [mat, depthMat]) {
      m.uniforms.tDiffuse.value = rt.texture;
      m.uniforms.tDepth.value = rt.depthTexture;
      m.uniforms.uAspect.value = w / h;
    }
  }

  function pass(renderer, scene, camera, material) {
    material.uniforms.uNear.value = camera.near;
    material.uniforms.uFar.value = camera.far;
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    postScene.children[0].material = material;
    renderer.render(postScene, postCam);
  }

  return {
    /* renders scene->target->screen with DoF. focus in meters, strength 0..1
       (aperture feel), bokeh scales the max blur disc, range = the ±meters
       around focus that stay perfectly sharp. */
    render(renderer, scene, camera, focus, strength, bokeh, range) {
      ensure(renderer);
      mat.uniforms.uFocus.value = Math.max(0.3, focus);
      mat.uniforms.uRange.value = Math.max(0, range === undefined ? 1.6 : range);
      mat.uniforms.uAperture.value = strength * 0.11;
      mat.uniforms.uMaxCoc.value = (0.012 + strength * 0.014) * (bokeh || 1);
      pass(renderer, scene, camera, mat);
    },

    /* depth-map layer (replay "Depth" mode); range = meters to near-black */
    renderDepth(renderer, scene, camera, range) {
      ensure(renderer);
      depthMat.uniforms.uK.value = 2.8 / Math.max(10, range || 100);
      pass(renderer, scene, camera, depthMat);
    },
  };
})();
