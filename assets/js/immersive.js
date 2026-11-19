// assets/js/immersive.js
// Igloo-style immersive layer: a fixed real-time WebGL "ice crystal" scene that
// reacts to scroll + pointer, plus a small HUD, loader and title scramble.
// Additive and self-contained: loaded as an ES module AFTER the existing scripts.
// If WebGL is unavailable (or this file fails), <html> never gets .im-on and the
// site renders exactly as before. Remove the <script type="module"> tag to revert.
import * as THREE from '../vendor/three/three.module.min.js';

const SECTIONS = ['#hero', '#about', '#services', '#work', '#contact'];
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOG_COLOR = new THREE.Color(0x050a14);
const FOG_DENSITY = 0.045;

const isMobile = () => window.innerWidth < 880;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* Shaders                                                            */
/* ------------------------------------------------------------------ */

// Shared ice fragment shader: flat facets via derivatives, fresnel rim,
// thin-film iridescence, a hard specular glint and exp2 fog.
const ICE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uDim;
  uniform float uIrid;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  varying vec3 vViewPos;
  varying float vRand;

  void main() {
    vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
    vec3 V = normalize(-vViewPos);
    float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);
    float fres = pow(1.0 - ndv, 3.0);

    vec3 L = normalize(vec3(0.45, 0.85, 0.55));
    float diff = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 80.0);

    vec3 deep = vec3(0.015, 0.05, 0.12);
    vec3 ice  = vec3(0.42, 0.78, 1.0);
    vec3 irid = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + fres * 1.4 + uTime * 0.04 + vRand));

    vec3 col = mix(deep, ice * 0.5, diff * 0.55 + vRand * 0.18);
    col += irid * fres * 0.85 * uIrid;
    col += vec3(0.65, 0.9, 1.0) * pow(fres, 1.6) * 0.3;
    col += spec * 1.3;
    col *= uDim;

    float d = length(vViewPos);
    float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
    gl_FragColor = vec4(mix(col, uFogColor, f), 1.0);
  }
`;

// Crystal shards: each shard drifts out along its face direction and tumbles
// as uExplode rises (scroll-driven), then reassembles when it falls.
const SHARD_VERT = /* glsl */ `
  attribute vec3 aDir;
  attribute vec3 aCenter;
  attribute float aRand;
  uniform float uExplode;
  uniform float uTime;
  varying vec3 vViewPos;
  varying float vRand;

  vec3 rotateAxis(vec3 p, vec3 axis, float angle) {
    float c = cos(angle), s = sin(angle);
    return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
  }

  void main() {
    float e = uExplode * (0.6 + aRand * 0.9);
    vec3 axis = normalize(cross(aDir, vec3(0.3, 1.0, 0.2)) + 1e-4);
    vec3 p = position - aCenter;
    p = rotateAxis(p, axis, e * (1.4 + aRand * 2.2) + uTime * 0.35 * uExplode * aRand);
    p += aCenter + aDir * e * 2.4;
    p.y += sin(uTime * 0.8 + aRand * 6.2831) * 0.09 * uExplode;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewPos = mv.xyz;
    vRand = aRand;
    gl_Position = projectionMatrix * mv;
  }
`;

// Instanced debris + static terrain share this one.
const BASIC_VERT = /* glsl */ `
  attribute float aRand;
  varying vec3 vViewPos;
  varying float vRand;
  void main() {
    vec4 p = vec4(position, 1.0);
    #ifdef USE_INSTANCING
      p = instanceMatrix * p;
      vRand = fract(instanceMatrix[3].x * 3.17 + instanceMatrix[3].z * 1.31);
    #else
      vRand = aRand;
    #endif
    vec4 mv = modelViewMatrix * p;
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

const SNOW_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aRand;
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uHeight;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    p.y = mod(p.y - uTime * (0.12 + aRand * 0.22) + uHeight * 0.5, uHeight) - uHeight * 0.5 + 3.0;
    p.x += sin(uTime * 0.45 + aRand * 20.0) * 0.35;
    p.z += cos(uTime * 0.35 + aRand * 12.0) * 0.25;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPixelRatio * (16.0 / -mv.z);
    vAlpha = smoothstep(40.0, 4.0, -mv.z) * smoothstep(0.2, 1.2, -mv.z) * (0.35 + aRand * 0.65);
    gl_Position = projectionMatrix * mv;
  }
`;

const SNOW_FRAG = /* glsl */ `
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.0, d) * vAlpha;
    gl_FragColor = vec4(0.82, 0.94, 1.0, a);
  }
`;

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Night sky gradient with a slow aurora band.
const SKY_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uFogColor;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    vec3 col = mix(uFogColor, vec3(0.012, 0.02, 0.05), smoothstep(0.0, 0.7, h));
    col = mix(vec3(0.01, 0.015, 0.03), col, smoothstep(-0.4, 0.0, h));
    float band = sin(d.x * 3.0 + uTime * 0.05) * 0.5 + sin(d.z * 4.0 - uTime * 0.07) * 0.35;
    float aur = smoothstep(0.16, 0.0, abs(h - 0.32 - band * 0.12));
    aur *= 0.55 + 0.45 * sin(d.x * 22.0 + d.z * 14.0 + uTime * 0.25);
    col += aur * vec3(0.08, 0.75, 0.65) * 0.3 + aur * aur * vec3(0.35, 0.45, 1.0) * 0.18;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/* Geometry builders                                                  */
/* ------------------------------------------------------------------ */

// Deterministic hash so shared icosahedron vertices jitter identically (no gaps).
const hash3 = (x, y, z) => {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

function buildCrystalGeometry(radius) {
  const base = new THREE.IcosahedronGeometry(radius, 1); // polyhedra are already non-indexed
  const src = base.attributes.position;
  const pos = [], dir = [], ctr = [], rnd = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();

  const shape = (v) => {
    const j = 1 + (hash3(v.x, v.y, v.z) - 0.5) * 0.28;
    v.multiplyScalar(j);
    v.y *= 1.3; // taller, crystal-like
    return v;
  };

  for (let i = 0; i < src.count; i += 3) {
    shape(a.fromBufferAttribute(src, i));
    shape(b.fromBufferAttribute(src, i + 1));
    shape(c.fromBufferAttribute(src, i + 2));
    const center = new THREE.Vector3().add(a).add(b).add(c).divideScalar(3);
    const d = center.clone().normalize();
    const apex = d.clone().multiplyScalar(radius * (0.15 + Math.random() * 0.2));
    const r = Math.random();
    const tris = [a, b, c, b, a, apex, c, b, apex, a, c, apex];
    for (const v of tris) {
      pos.push(v.x, v.y, v.z);
      dir.push(d.x, d.y, d.z);
      ctr.push(center.x, center.y, center.z);
      rnd.push(r);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 3));
  g.setAttribute('aCenter', new THREE.Float32BufferAttribute(ctr, 3));
  g.setAttribute('aRand', new THREE.Float32BufferAttribute(rnd, 1));
  g.computeBoundingSphere();
  g.boundingSphere.radius *= 4; // shards travel; avoid frustum-culling mid-explode
  base.dispose();
  return g;
}

// Small value-noise fbm for the low-poly ice field.
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (i, j) => hash3(xi + i, yi + j, 0.5);
  const u = smooth(xf), v = smooth(yf);
  return lerp(lerp(h(0, 0), h(1, 0), u), lerp(h(0, 1), h(1, 1), u), v);
}
const fbm = (x, y) => noise2(x, y) * 0.6 + noise2(x * 2.1, y * 2.1) * 0.28 + noise2(x * 4.3, y * 4.3) * 0.12;

function buildTerrainGeometry(segments) {
  const g = new THREE.PlaneGeometry(70, 70, segments, segments).toNonIndexed();
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const dist = Math.hypot(x, z);
    const ridge = Math.pow(fbm(x * 0.09 + 10, z * 0.09 + 10), 2.2) * 9;
    const basin = smooth(clamp((dist - 4) / 16, 0, 1)); // flat clearing under the crystal
    p.setY(i, ridge * basin);
  }
  const rnd = new Float32Array(p.count);
  for (let i = 0; i < p.count; i += 3) rnd[i] = rnd[i + 1] = rnd[i + 2] = Math.random();
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  return g;
}

function glowTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const grd = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(200,240,255,1)');
  grd.addColorStop(0.25, 'rgba(110,200,255,0.45)');
  grd.addColorStop(1, 'rgba(40,90,160,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

/* ------------------------------------------------------------------ */
/* Camera choreography per section                                    */
/* ------------------------------------------------------------------ */

// One keyframe per entry in SECTIONS. pos/look are camera position & target,
// explode drives the shard spread, spin is extra crystal rotation speed.
function keyframes() {
  const m = isMobile();
  return [
    { pos: m ? [0, 0.3, 10] : [-2.1, 0.3, 6.6], look: m ? [0, -2.2, 0] : [-2.1, 0.1, 0], explode: 0.0 },
    { pos: m ? [3.5, 2.2, 6.5] : [4.6, 1.4, 4.4], look: m ? [0, 1.2, 0] : [1.9, 0.2, 0], explode: 0.12 },
    { pos: [0, 2.6, 7.6], look: [0, 0.2, 0], explode: 0.75 },
    { pos: m ? [0.4, 0.6, 3.2] : [0.6, 0.5, 2.6], look: [0, 0, -6], explode: 1.5 },
    { pos: m ? [0, 9, 10] : [0, 7.5, 9], look: [0, -1.4, 0], explode: 0.08 },
  ];
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

function init() {
  const canvas = document.getElementById('im-canvas');
  if (!canvas) return false;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    console.warn('[immersive] WebGL unavailable, keeping the standard layout.', err);
    return false;
  }

  const maxDpr = isMobile() ? 1.5 : 1.75;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxDpr));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(FOG_COLOR, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);

  const shared = {
    uTime: { value: 0 },
    uFogColor: { value: FOG_COLOR },
    uFogDensity: { value: FOG_DENSITY },
  };

  // Sky
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(90, 32, 16),
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      uniforms: { uTime: shared.uTime, uFogColor: shared.uFogColor },
      side: THREE.BackSide, depthWrite: false,
    })
  );
  scene.add(sky);

  // Crystal
  const crystalGroup = new THREE.Group();
  scene.add(crystalGroup);

  const shardMat = new THREE.ShaderMaterial({
    vertexShader: SHARD_VERT, fragmentShader: ICE_FRAG,
    uniforms: { ...shared, uExplode: { value: 0 }, uDim: { value: 1 }, uIrid: { value: 1 } },
    side: THREE.DoubleSide,
  });
  const crystal = new THREE.Mesh(buildCrystalGeometry(1.35), shardMat);
  crystalGroup.add(crystal);

  const shell = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.3, 1)),
    new THREE.LineBasicMaterial({ color: 0x8fdcff, transparent: true, opacity: 0.14, depthWrite: false })
  );
  shell.scale.y = 1.25;
  crystalGroup.add(shell);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(), color: 0x9fe4ff, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
  }));
  glow.scale.setScalar(4.2);
  glow.renderOrder = 10;
  crystalGroup.add(glow);

  // Orbiting debris (one draw call)
  const DEBRIS = isMobile() ? 40 : 80;
  const debrisMat = new THREE.ShaderMaterial({
    vertexShader: BASIC_VERT, fragmentShader: ICE_FRAG,
    uniforms: { ...shared, uDim: { value: 0.9 }, uIrid: { value: 1 } }, side: THREE.DoubleSide,
  });
  const debris = new THREE.InstancedMesh(new THREE.TetrahedronGeometry(0.11, 0), debrisMat, DEBRIS);
  const debrisData = Array.from({ length: DEBRIS }, () => ({
    r: 2.6 + Math.random() * 4.2,
    a: Math.random() * Math.PI * 2,
    y: (Math.random() - 0.5) * 3.2,
    s: 0.5 + Math.random() * 1.6,
    speed: (0.04 + Math.random() * 0.09) * (Math.random() < 0.5 ? -1 : 1),
    spin: new THREE.Vector3(Math.random(), Math.random(), Math.random()),
  }));
  debris.frustumCulled = false;
  scene.add(debris);
  const dummy = new THREE.Object3D();

  // Ice field
  const terrain = new THREE.Mesh(
    buildTerrainGeometry(isMobile() ? 60 : 90),
    new THREE.ShaderMaterial({
      vertexShader: BASIC_VERT, fragmentShader: ICE_FRAG,
      uniforms: { ...shared, uDim: { value: 0.5 }, uIrid: { value: 0.18 } },
    })
  );
  terrain.position.y = -3.2;
  scene.add(terrain);

  // Snow
  const SNOW = isMobile() ? 900 : 2400;
  const SNOW_H = 16;
  const sPos = new Float32Array(SNOW * 3), sSize = new Float32Array(SNOW), sRand = new Float32Array(SNOW);
  for (let i = 0; i < SNOW; i++) {
    sPos[i * 3] = (Math.random() - 0.5) * 34;
    sPos[i * 3 + 1] = Math.random() * SNOW_H;
    sPos[i * 3 + 2] = (Math.random() - 0.5) * 34;
    sSize[i] = 0.6 + Math.random() * 1.8;
    sRand[i] = Math.random();
  }
  const snowGeo = new THREE.BufferGeometry();
  snowGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  snowGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
  snowGeo.setAttribute('aRand', new THREE.BufferAttribute(sRand, 1));
  const snowMat = new THREE.ShaderMaterial({
    vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG,
    uniforms: { uTime: shared.uTime, uPixelRatio: { value: renderer.getPixelRatio() }, uHeight: { value: SNOW_H } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  scene.add(snow);

  /* ---------------- scroll + pointer state ---------------- */

  let frames = keyframes();
  let anchors = [];
  const sectionEls = SECTIONS.map((s) => document.querySelector(s));

  const measure = () => {
    anchors = sectionEls.map((el) =>
      el ? el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.35 : 0
    );
    anchors[0] = 0;
  };

  // Returns a float: 0 = hero, 1 = about, ... (fractional between sections).
  const scrollProgress = () => {
    const y = window.scrollY;
    const maxY = document.documentElement.scrollHeight - window.innerHeight;
    if (y >= maxY - 2) return anchors.length - 1;
    for (let i = anchors.length - 1; i >= 0; i--) {
      if (y >= anchors[i]) {
        const next = anchors[i + 1];
        if (next === undefined) return i;
        return i + clamp((y - anchors[i]) / Math.max(1, next - anchors[i]), 0, 1);
      }
    }
    return 0;
  };

  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  window.addEventListener('pointermove', (e) => {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  const cur = { pos: new THREE.Vector3(...frames[0].pos), look: new THREE.Vector3(...frames[0].look), explode: 0 };
  const goal = { pos: new THREE.Vector3(), look: new THREE.Vector3(), explode: 0 };
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();

  const sampleGoal = (p) => {
    const i = Math.floor(p), t = smooth(p - i);
    const A = frames[i], B = frames[Math.min(i + 1, frames.length - 1)];
    goal.pos.lerpVectors(tmpA.fromArray(A.pos), tmpB.fromArray(B.pos), t);
    goal.look.lerpVectors(tmpA.fromArray(A.look), tmpB.fromArray(B.look), t);
    goal.explode = lerp(A.explode, B.explode, t);
  };

  /* ---------------- HUD ---------------- */
  const hud = buildHud();
  const navNames = SECTIONS.map((s) => {
    const a = document.querySelector(`#navbar a[href="${s}"]`);
    return a ? a.textContent.trim() : s.slice(1);
  });
  let lastIdx = -1;

  const updateHud = (p) => {
    const idx = Math.round(p);
    if (idx !== lastIdx) {
      lastIdx = idx;
      hud.idx.textContent = String(idx + 1).padStart(2, '0');
      hud.name.textContent = navNames[idx];
      hud.total.textContent = String(SECTIONS.length).padStart(2, '0');
    }
    hud.bar.style.transform = `scaleX(${(p / (SECTIONS.length - 1)).toFixed(4)})`;
    hud.root.classList.toggle('is-scrolled', window.scrollY > 40);
    hud.coords.textContent =
      `X ${camera.position.x.toFixed(2)}  Y ${camera.position.y.toFixed(2)}  Z ${camera.position.z.toFixed(2)}`;
  };

  /* ---------------- loop ---------------- */
  const clock = new THREE.Clock();
  let time = 0;
  let running = true;
  let firstFrame = true;

  const tick = () => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!REDUCED) time += dt;
    shared.uTime.value = time;

    const p = scrollProgress();
    sampleGoal(p);

    // Critically-damped-ish follow; instant when reduced motion is requested.
    const k = REDUCED || firstFrame ? 1 : 1 - Math.pow(0.0025, dt);
    cur.pos.lerp(goal.pos, k);
    cur.look.lerp(goal.look, k);
    cur.explode = lerp(cur.explode, goal.explode, k);

    const pk = REDUCED ? 0 : 1 - Math.pow(0.02, dt);
    pointer.sx = lerp(pointer.sx, pointer.x, pk);
    pointer.sy = lerp(pointer.sy, pointer.y, pk);

    camera.position.copy(cur.pos);
    camera.position.x += pointer.sx * 0.35;
    camera.position.y -= pointer.sy * 0.22;
    camera.lookAt(cur.look);

    shardMat.uniforms.uExplode.value = cur.explode;
    crystalGroup.rotation.y = time * 0.18 + p * 0.9;
    crystalGroup.rotation.x = pointer.sy * 0.12;
    crystalGroup.rotation.z = -pointer.sx * 0.08;
    crystalGroup.position.y = Math.sin(time * 0.9) * 0.08;
    shell.rotation.y = -time * 0.06;
    shell.material.opacity = 0.14 * (1 - clamp(cur.explode, 0, 1) * 0.7);
    glow.material.opacity = 0.42 + Math.sin(time * 1.6) * 0.08 + cur.explode * 0.1;

    for (let i = 0; i < DEBRIS; i++) {
      const d = debrisData[i];
      const a = d.a + time * d.speed;
      const r = d.r + cur.explode * 1.6;
      dummy.position.set(Math.cos(a) * r, d.y + Math.sin(time * 0.6 + i) * 0.15, Math.sin(a) * r);
      dummy.rotation.set(time * d.spin.x, time * d.spin.y, time * d.spin.z);
      dummy.scale.setScalar(d.s);
      dummy.updateMatrix();
      debris.setMatrixAt(i, dummy.matrix);
    }
    debris.instanceMatrix.needsUpdate = true;

    renderer.render(scene, camera);
    updateHud(p);

    if (firstFrame) {
      firstFrame = false;
      document.dispatchEvent(new CustomEvent('immersive:ready'));
    }
  };

  const start = () => { if (!running) { running = true; clock.getDelta(); renderer.setAnimationLoop(tick); } };
  const stop = () => { running = false; renderer.setAnimationLoop(null); };
  renderer.setAnimationLoop(tick);

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isMobile() ? 1.5 : 1.75));
    renderer.setSize(w, h, false);
    snowMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frames = keyframes();
    measure();
  };
  window.addEventListener('resize', onResize);
  // Section heights shift as images/fonts load; keep anchors accurate.
  if ('ResizeObserver' in window) new ResizeObserver(measure).observe(document.body);
  window.addEventListener('load', measure);

  measure();
  onResize();
  document.documentElement.classList.add('im-on');
  return true;
}

function buildHud() {
  const root = document.createElement('div');
  root.className = 'im-hud';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="im-hud-sec">
      <span class="im-hud-idx">01</span><span class="im-hud-sep">/</span><span class="im-hud-total">05</span>
      <span class="im-hud-bar"><i></i></span>
      <span class="im-hud-name">Home</span>
    </div>
    <div class="im-hud-coords"></div>
    <div class="im-hud-scroll"><span>Scroll</span><i></i></div>`;
  document.body.appendChild(root);
  return {
    root,
    idx: root.querySelector('.im-hud-idx'),
    total: root.querySelector('.im-hud-total'),
    name: root.querySelector('.im-hud-name'),
    bar: root.querySelector('.im-hud-bar i'),
    coords: root.querySelector('.im-hud-coords'),
  };
}

/* ------------------------------------------------------------------ */
/* Loader + text scramble (pure DOM)                                  */
/* ------------------------------------------------------------------ */

function runLoader(webglOk) {
  const loader = document.getElementById('im-loader');
  if (!loader) return;
  const count = loader.querySelector('.im-loader-count');
  const bar = loader.querySelector('.im-loader-bar i');
  const finish = () => {
    loader.classList.add('is-done');
    setTimeout(() => loader.remove(), 900);
  };
  if (!webglOk || REDUCED) { finish(); return; }

  const duration = 1300;
  let t0 = null;
  let ready = false;
  document.addEventListener('immersive:ready', () => { ready = true; }, { once: true });

  const step = (now) => {
    if (t0 === null) t0 = now;
    // Hold at 90% until the first WebGL frame is on screen.
    const raw = clamp((now - t0) / duration, 0, 1);
    const pct = ready ? raw : Math.min(raw, 0.9);
    const v = Math.round(smooth(pct) * 100);
    count.textContent = String(v).padStart(3, '0');
    bar.style.transform = `scaleX(${v / 100})`;
    if (v >= 100) finish();
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

const GLYPHS = '<>/\\_-=+*#[]{}01';
function scramble(el) {
  const original = el.textContent;
  if (!original.trim()) return;
  el.setAttribute('aria-label', original.trim());
  const len = original.length;
  const duration = 700; // time-based so slow devices still finish on time
  const t0 = performance.now();
  const run = (now) => {
    const t = clamp((now - t0) / duration, 0, 1);
    if (t >= 1) { el.textContent = original; return; }
    let out = '';
    for (let i = 0; i < len; i++) {
      const ch = original[i];
      const revealAt = 0.25 + (i / len) * 0.7;
      out += ch === ' ' || t >= revealAt ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    }
    el.textContent = out;
    requestAnimationFrame(run);
  };
  requestAnimationFrame(run);
}

function initScramble() {
  if (REDUCED || !('IntersectionObserver' in window)) return;
  // Only elements whose content is plain text (scrambling would strip child markup).
  const els = [...document.querySelectorAll('.title-a, .about-info h2, .about-info h3, .title-left, .s-title, .w-title')]
    .filter((el) => el.children.length === 0);
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { scramble(e.target); io.unobserve(e.target); }
    });
  }, { threshold: 0.6 });
  els.forEach((el) => io.observe(el));
}

const ok = init();
runLoader(ok);
if (ok) initScramble();
