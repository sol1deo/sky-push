/* =============================================================================
 * SKY PUSH — depth of field (replay editor only)
 * A tiny hand-rolled post pass — no EffectComposer, no external shaders:
 *   1. render the scene into an offscreen target with a depth texture
 *   2. composite full-screen: per-pixel circle-of-confusion from depth vs the
 *      focus distance, 16-tap poisson disc blur scaled by the CoC
 * Foreground and background both defocus; neighbours sharper than the center
 * pixel are down-weighted so crisp edges don't bleed into the bokeh.
 * Costs one extra scene pass — only ever active inside the replay editor.
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.DoF = (function () {
  let rt = null, postScene = null, postCam = null, mat = null;
  let W = 0, H = 0;
  const _size = new THREE.Vector2();

  const FRAG = `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float uNear, uFar, uFocus, uAperture, uMaxCoc, uAspect;
    varying vec2 vUv;

    float viewDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // perspective depth -> positive view-space distance
      return (uNear * uFar) / (uFar - d * (uFar - uNear));
    }
    float cocAt(vec2 uv) {
      float z = viewDepth(uv);
      return clamp(uAperture * abs(z - uFocus) / max(z, 0.2), 0.0, uMaxCoc);
    }
    void main() {
      float c = cocAt(vUv);
      vec3 acc = texture2D(tDiffuse, vUv).rgb;
      float wsum = 1.0;
      // bright samples weigh more, so highlights bloom into bokeh discs
      #define TAP(ox, oy) { \
        vec2 off = vec2(ox, oy * uAspect) * c; \
        float cd = cocAt(vUv + off); \
        float w = clamp(cd / max(c, 1e-5), 0.15, 1.0); \
        vec3 smp = texture2D(tDiffuse, vUv + off).rgb; \
        float lum = dot(smp, vec3(0.299, 0.587, 0.114)); \
        w *= 1.0 + lum * lum * 1.6; \
        acc += smp * w; \
        wsum += w; }
      TAP( 0.9435,  0.2793) TAP(-0.8320,  0.4384) TAP( 0.2170, -0.9296)
      TAP(-0.2493, -0.6152) TAP( 0.6262,  0.6459) TAP(-0.5698, -0.2263)
      TAP( 0.4562, -0.4776) TAP(-0.1580,  0.8340) TAP( 0.1327,  0.4142)
      TAP(-0.9251, -0.1085) TAP( 0.7386, -0.1263) TAP(-0.4249,  0.1442)
      TAP( 0.0940, -0.2280) TAP(-0.1197, -0.9836) TAP( 0.3486,  0.9096)
      TAP(-0.6641,  0.7325)
      gl_FragColor = vec4(acc / wsum, 1.0);
    }`;

  const VERT = `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

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
    rt.texture.encoding = THREE.sRGBEncoding;   // byte-identical pass-through
    if (!postScene) {
      mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        uniforms: {
          tDiffuse: { value: null }, tDepth: { value: null },
          uNear: { value: 0.08 }, uFar: { value: 500 },
          uFocus: { value: 10 }, uAperture: { value: 0.5 }, uMaxCoc: { value: 0.02 },
          uAspect: { value: 1 },
        },
        depthTest: false, depthWrite: false, toneMapped: false,
      });
      postScene = new THREE.Scene();
      postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    mat.uniforms.tDiffuse.value = rt.texture;
    mat.uniforms.tDepth.value = rt.depthTexture;
    mat.uniforms.uAspect.value = w / h;
  }

  return {
    /* renders scene->target->screen with DoF. focus in meters,
       strength 0..1 (aperture feel), bokeh scales the max blur disc,
       camera supplies near/far. */
    render(renderer, scene, camera, focus, strength, bokeh) {
      ensure(renderer);
      mat.uniforms.uNear.value = camera.near;
      mat.uniforms.uFar.value = camera.far;
      mat.uniforms.uFocus.value = Math.max(0.3, focus);
      mat.uniforms.uAperture.value = strength * 0.09;
      mat.uniforms.uMaxCoc.value = (0.012 + strength * 0.014) * (bokeh || 1);
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    },
  };
})();
