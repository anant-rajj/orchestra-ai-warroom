/**
 * ORCHESTRA AI — Procedural WebGL2 + CFX War-Room Graphics Engine
 * Zero external dependencies. Vanilla WebGL2 / HTML5 Canvas 2D / DOM Observers.
 */
function initProVfxEngine(options = {}) {
  // Idempotent teardown if re-initialized
  if (typeof window !== 'undefined' && window.__orchestraProVfx && typeof window.__orchestraProVfx.destroy === 'function') {
    window.__orchestraProVfx.destroy();
  }

  const MAX_DPR = Math.min(options.maxDpr || 2, 2);
  const STAGES = ['idle', 'boss_plan', 'worker_draft', 'worker_crosstalk', 'boss_merge'];

  const PALETTE = {
    obsidian0: [8 / 255, 10 / 255, 16 / 255],
    cyan: { hex: '#54D9FF', rgb: [84, 217, 255] },
    violet: { hex: '#9B83FF', rgb: [155, 131, 255] },
    ice: { hex: '#398BFF', rgb: [57, 139, 255] },
    amber: { hex: '#E5B96C', rgb: [229, 185, 108] },
    emerald: { hex: '#34D399', rgb: [52, 211, 153] },
    white: { hex: '#F1F5FC', rgb: [241, 245, 252] },
    slate: { hex: '#AAB6C8', rgb: [170, 182, 200] },
  };

  // =========================================================================
  // COHERENT PROCEDURAL NOISE & MATH UTILITIES (CFD / TURBULENCE)
  // =========================================================================
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function hash2(x, y) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return n - Math.floor(n);
  }

  function valueNoise2D(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy);
    const b = hash2(ix + 1, iy);
    const c = hash2(ix, iy + 1);
    const d = hash2(ix + 1, iy + 1);
    return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
  }

  function fbm2D(x, y) {
    let val = 0;
    let amp = 0.55;
    let freq = 1.0;
    for (let i = 0; i < 3; i++) {
      val += amp * (valueNoise2D(x * freq, y * freq) * 2 - 1);
      freq *= 2.07;
      amp *= 0.48;
    }
    return val;
  }

  function rgbaStr(rgb, a) {
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(a, 0, 1).toFixed(3)})`;
  }

  function mixRgb(a, b, t) {
    return [
      Math.round(lerp(a[0], b[0], t)),
      Math.round(lerp(a[1], b[1], t)),
      Math.round(lerp(a[2], b[2], t)),
    ];
  }

  // =========================================================================
  // ENGINE STATE & ACCESSIBILITY / STAGE DETECTION
  // =========================================================================
  const reducedMotionQuery = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: () => {}, removeEventListener: () => {} };

  const state = {
    stage: 'idle',
    prevStage: 'idle',
    forcedStage: null,
    enabled: true,
    reducedMotion: !!reducedMotionQuery.matches,
    destroyed: false,
    rafId: 0,
    lastTime: 0,
    elapsed: 0,
    pointer: { x: 0, y: 0, tx: 0, ty: 0, px: 0, py: 0 },
    dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
    mergeShockwave: { active: false, progress: 0, duration: 2.35 },
    topologyPulse: { active: false, progress: 0, duration: 1.8 },
  };

  const cleanupCallbacks = [];
  const injectedElements = [];

  function isVfxOffDom() {
    const html = document.documentElement;
    const body = document.body;
    return (
      !state.enabled ||
      html.classList.contains('vfx-off') ||
      html.dataset.vfx === 'off' ||
      (body && (body.classList.contains('vfx-off') || body.dataset.vfx === 'off'))
    );
  }

  function detectStageFromDom() {
    if (state.forcedStage) return state.forcedStage;
    const targets = [
      document.getElementById('comms-topology'),
      document.body,
      document.documentElement,
    ].filter(Boolean);

    for (const el of targets) {
      for (let i = STAGES.length - 1; i >= 1; i--) {
        if (el.classList.contains(`stage-${STAGES[i]}`)) {
          return STAGES[i];
        }
      }
      if (el.dataset && el.dataset.stage && STAGES.includes(el.dataset.stage)) {
        return el.dataset.stage;
      }
    }
    return 'idle';
  }

  function syncStage(forceTrigger) {
    const next = detectStageFromDom();
    if (next !== state.stage || forceTrigger) {
      state.prevStage = state.stage;
      state.stage = next;
      if (next === 'boss_merge' && (state.prevStage !== 'boss_merge' || forceTrigger)) {
        triggerMergeShockwave();
      }
      if (topologyEngine) topologyEngine.markDirty();
    }
  }

  function triggerMergeShockwave() {
    state.mergeShockwave.active = true;
    state.mergeShockwave.progress = 0;
    state.topologyPulse.active = true;
    state.topologyPulse.progress = 0;
    const mergeCard = document.getElementById('boss-merge-card');
    if (mergeCard) {
      mergeCard.classList.add('vfx-merge-converged');
    }
  }

  // =========================================================================
  // SUBSYSTEM A: #vfx-canvas WEBGL2 VOLUMETRIC OBSIDIAN VOID + ORBITAL RINGS
  //              + DEPTH-PROJECTED INTELLIGENCE PARTICLES (2D FALLBACK SAFE)
  // =========================================================================
  function createVoidBackgroundEngine() {
    const canvas = document.getElementById('vfx-canvas');
    if (!canvas) return null;

    let width = 1;
    let height = 1;
    const stageEnergy = { current: 0.25, tint: [0.33, 0.85, 1.0] };

    const stageTargets = {
      idle: { energy: 0.22, tint: [0.33, 0.72, 0.96] },
      boss_plan: { energy: 0.58, tint: [0.33, 0.85, 1.0] },
      worker_draft: { energy: 0.64, tint: [0.45, 0.74, 1.0] },
      worker_crosstalk: { energy: 0.78, tint: [0.61, 0.51, 1.0] },
      boss_merge: { energy: 0.84, tint: [0.90, 0.73, 0.42] },
    };

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      // Lightweight 2D Canvas atmospheric fallback if WebGL2 is unavailable
      const ctx = canvas.getContext('2d');
      const particles = Array.from({ length: 72 }, (_, i) => ({
        ang: (i / 72) * Math.PI * 2,
        rad: 0.18 + hash2(i, 1.3) * 0.55,
        y: (hash2(i, 4.7) - 0.5) * 0.7,
        spd: 0.04 + hash2(i, 8.1) * 0.08,
        sz: 1 + hash2(i, 2.9) * 1.4,
      }));

      function resize2d() {
        state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        width = window.innerWidth;
        height = window.innerHeight;
        canvas.width = Math.max(1, Math.floor(width * state.dpr));
        canvas.height = Math.max(1, Math.floor(height * state.dpr));
      }

      function render2d(t) {
        if (!ctx) return;
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        const grad = ctx.createRadialGradient(
          width * (0.5 + state.pointer.x * 0.03),
          height * (0.34 + state.pointer.y * 0.03),
          20,
          width * 0.5,
          height * 0.45,
          Math.max(width, height) * 0.78
        );
        grad.addColorStop(0, '#101522');
        grad.addColorStop(0.5, '#0B0E15');
        grad.addColorStop(1, '#080A10');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        const cx = width * 0.5;
        const cy = height * 0.48;
        const baseR = Math.min(width, height) * 0.42;
        ctx.strokeStyle = 'rgba(84,217,255,0.09)';
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, baseR * (0.45 + i * 0.24), baseR * (0.16 + i * 0.085), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const p of particles) {
          const a = p.ang + t * p.spd;
          const z = Math.sin(a) * p.rad;
          const scale = 1 / (1.4 - z * 0.5);
          const x = cx + Math.cos(a) * p.rad * width * 0.75 * scale;
          const y = cy + (p.y * height * 0.55 + z * height * 0.14) * scale;
          ctx.fillStyle = `rgba(170,210,255,${(0.12 + 0.25 * scale).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, p.sz * scale, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      resize2d();
      return { resize: resize2d, render: render2d, destroy: () => {} };
    }

    // --- WebGL2 Shaders ---
    const bgVertSrc = `#version 300 es
precision highp float;
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

    const bgFragSrc = `#version 300 es
precision highp float;

uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse;
uniform float u_energy;
uniform vec3 u_tint;

out vec4 fragColor;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = rot * p * 2.04 + vec2(11.3, 7.1);
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);

  // 1. Deep OLED Obsidian Atmospheric Gradient (#080A10 -> #0B0E15 -> #101522)
  vec3 c0 = vec3(0.031, 0.039, 0.063);
  vec3 c1 = vec3(0.043, 0.055, 0.082);
  vec3 c2 = vec3(0.063, 0.082, 0.133);

  float radial = length((uv - vec2(0.5 + u_mouse.x * 0.035, 0.64 - u_mouse.y * 0.035)) * vec2(1.15, 1.0));
  vec3 col = mix(c2, c1, smoothstep(0.0, 0.58, radial));
  col = mix(col, c0, smoothstep(0.42, 1.05, radial));

  // 2. Domain-Warped Procedural fBm Volumetric Depth (Restrained OLED Mist)
  float t = u_time * 0.055;
  vec2 fp = p * 1.45 + vec2(u_mouse.x * 0.09, -u_mouse.y * 0.07);
  vec2 warp = vec2(
    fbm(fp + vec2(t, -t * 0.7)),
    fbm(fp + vec2(-t * 0.6 + 4.1, t * 0.8 + 2.3))
  );
  float cloud = fbm(fp * 1.25 + warp * 1.15 - vec2(0.0, t * 0.45));
  float mistMask = smoothstep(0.26, 0.82, cloud) * exp(-dot(p, p) * 0.68);
  vec3 mistColor = mix(vec3(0.08, 0.13, 0.22), u_tint * 0.22, 0.34 + 0.26 * u_energy);
  col += mistColor * mistMask * (0.28 + 0.14 * u_energy);

  // 3. 3D Ray-Plane Projected Architectural Orbital Rings
  vec3 ro = vec3(u_mouse.x * 0.22, 1.08 + u_mouse.y * 0.14, 3.05);
  vec3 target = vec3(0.0, -0.08, 0.0);
  vec3 fwd = normalize(target - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  vec3 rd = normalize(fwd * 1.65 + right * p.x + up * p.y);

  // Intersect slightly tilted architectural plane
  vec3 planeN = normalize(vec3(0.03 * sin(u_time * 0.08), 1.0, 0.04));
  float denom = dot(rd, planeN);
  if (abs(denom) > 0.001) {
    float dist = -dot(ro, planeN) / denom;
    if (dist > 0.2 && dist < 14.0) {
      vec3 hit = ro + rd * dist;
      float r = length(hit.xz);
      float ang = atan(hit.z, hit.x);
      float fw = max(fwidth(r), 0.0022);
      float fade = exp(-dist * 0.20) * smoothstep(0.35, 1.0, r) * smoothstep(5.4, 2.2, r);

      // Ring 1: Inner precision ring with slow dashed arc segments
      float r1 = abs(r - 1.32);
      float dash1 = smoothstep(0.15, 0.35, sin(ang * 4.0 + u_time * 0.14));
      float line1 = (1.0 - smoothstep(0.0, fw * 1.75, r1)) * (0.35 + 0.65 * dash1);

      // Ring 2: Mid architectural ring + fine vernier ticks
      float r2 = abs(r - 2.18);
      float line2 = 1.0 - smoothstep(0.0, fw * 1.55, r2);
      float ticks = (1.0 - smoothstep(0.0, 0.045, abs(r - 2.24))) *
                    smoothstep(0.86, 0.96, cos(ang * 48.0 - u_time * 0.09));

      // Ring 3: Outer sweeping telemetry perimeter
      float r3 = abs(r - 3.22);
      float arc3 = smoothstep(-0.2, 0.55, sin(ang * 2.0 - u_time * 0.08 + 1.2));
      float line3 = (1.0 - smoothstep(0.0, fw * 2.0, r3)) * (0.25 + 0.75 * arc3);

      // Subtle cardinal axis hairlines
      float axisX = (1.0 - smoothstep(0.0, fw * 1.6, abs(hit.x))) * smoothstep(1.2, 1.5, r) * smoothstep(3.4, 2.9, r);
      float axisZ = (1.0 - smoothstep(0.0, fw * 1.6, abs(hit.z))) * smoothstep(1.2, 1.5, r) * smoothstep(3.4, 2.9, r);

      float arch = line1 * 0.65 + line2 * 0.52 + ticks * 0.42 + line3 * 0.38 + (axisX + axisZ) * 0.18;
      vec3 ringCol = mix(vec3(0.42, 0.56, 0.76), u_tint, 0.45 + 0.3 * u_energy);
      col += ringCol * arch * fade * (0.14 + 0.10 * u_energy);
    }
  }

  // 4. OLED Vignette & Anti-Banding Micro-Dither
  float vig = smoothstep(1.45, 0.25, length(p));
  col *= mix(0.76, 1.0, vig);
  col += (hash21(gl_FragCoord.xy + fract(u_time) * 19.0) - 0.5) / 255.0;

  fragColor = vec4(col, 1.0);
}`;

    const ptVertSrc = `#version 300 es
precision highp float;

layout(location = 0) in vec4 a_seed; // x: radius, y: angle, z: yOffset, w: speed/size

uniform vec2 u_res;
uniform float u_time;
uniform float u_dpr;
uniform vec2 u_mouse;
uniform float u_energy;
uniform vec3 u_tint;

out float v_alpha;
out vec3 v_col;

void main() {
  float rad = a_seed.x;
  float spd = (0.045 + fract(a_seed.w * 3.17) * 0.075) * (0.75 + 0.65 * u_energy);
  float ang = a_seed.y + u_time * spd;
  float y = a_seed.z + sin(u_time * 0.45 + a_seed.y * 3.0) * 0.08;

  vec3 pos = vec3(cos(ang) * rad, y, sin(ang) * rad);

  // Match camera basis from background shader
  vec3 ro = vec3(u_mouse.x * 0.22, 1.08 + u_mouse.y * 0.14, 3.05);
  vec3 target = vec3(0.0, -0.08, 0.0);
  vec3 fwd = normalize(target - ro);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);

  vec3 rel = pos - ro;
  float z = dot(rel, fwd);
  float x = dot(rel, right);
  float yy = dot(rel, up);

  float aspect = u_res.x / max(u_res.y, 1.0);
  float fov = 1.65;
  vec2 ndc = vec2((x * fov) / (z * aspect), (yy * fov) / z);

  gl_Position = vec4(ndc, 0.0, 1.0);

  float sizeBase = 1.6 + fract(a_seed.w * 7.13) * 2.4;
  float depthAtten = clamp(2.6 / max(z, 0.6), 0.35, 1.85);
  gl_PointSize = sizeBase * depthAtten * u_dpr;

  float twinkle = 0.65 + 0.35 * sin(u_time * (1.1 + fract(a_seed.w * 5.3)) + a_seed.y * 7.0);
  float zFade = smoothstep(0.7, 1.6, z) * smoothstep(7.2, 2.4, z);
  v_alpha = zFade * twinkle * (0.20 + 0.24 * u_energy);

  // Accent palette split: cyan / violet / ice / stage tint
  float bucket = fract(a_seed.w * 11.7);
  vec3 accent = bucket < 0.35
    ? vec3(0.329, 0.851, 1.0)
    : (bucket < 0.65 ? vec3(0.608, 0.514, 1.0) : vec3(0.224, 0.545, 1.0));
  v_col = mix(accent, u_tint, 0.38);
}`;

    const ptFragSrc = `#version 300 es
precision highp float;

in float v_alpha;
in vec3 v_col;
out vec4 fragColor;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float core = smoothstep(0.5, 0.04, r);
  float hot = smoothstep(0.24, 0.0, r) * 0.45;
  vec3 col = v_col + vec3(hot);
  fragColor = vec4(col, core * core * v_alpha);
}`;

    function compileShader(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
      }
      return s;
    }

    function createProgram(vsSrc, fsSrc) {
      const vs = compileShader(gl.VERTEX_SHADER, vsSrc);
      const fs = compileShader(gl.FRAGMENT_SHADER, fsSrc);
      if (!vs || !fs) return null;
      const prog = gl.createProgram();
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        gl.deleteProgram(prog);
        return null;
      }
      return prog;
    }

    const bgProg = createProgram(bgVertSrc, bgFragSrc);
    const ptProg = createProgram(ptVertSrc, ptFragSrc);
    if (!bgProg || !ptProg) return null;

    const bgVao = gl.createVertexArray();
    const bgLoc = {
      res: gl.getUniformLocation(bgProg, 'u_res'),
      time: gl.getUniformLocation(bgProg, 'u_time'),
      mouse: gl.getUniformLocation(bgProg, 'u_mouse'),
      energy: gl.getUniformLocation(bgProg, 'u_energy'),
      tint: gl.getUniformLocation(bgProg, 'u_tint'),
    };

    const PARTICLE_COUNT = 180;
    const ptData = new Float32Array(PARTICLE_COUNT * 4);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      ptData[i * 4 + 0] = 0.85 + hash2(i, 1.1) * 3.15; // radius
      ptData[i * 4 + 1] = hash2(i, 2.7) * Math.PI * 2; // angle
      ptData[i * 4 + 2] = (hash2(i, 5.3) - 0.5) * 1.45; // elevation
      ptData[i * 4 + 3] = hash2(i, 9.1); // seed
    }

    const ptVao = gl.createVertexArray();
    const ptBuf = gl.createBuffer();
    gl.bindVertexArray(ptVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ptData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const ptLoc = {
      res: gl.getUniformLocation(ptProg, 'u_res'),
      time: gl.getUniformLocation(ptProg, 'u_time'),
      dpr: gl.getUniformLocation(ptProg, 'u_dpr'),
      mouse: gl.getUniformLocation(ptProg, 'u_mouse'),
      energy: gl.getUniformLocation(ptProg, 'u_energy'),
      tint: gl.getUniformLocation(ptProg, 'u_tint'),
    };

    function resize() {
      state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      width = Math.max(1, Math.floor(window.innerWidth * state.dpr));
      height = Math.max(1, Math.floor(window.innerHeight * state.dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
    }

    function render(t, dt) {
      const target = stageTargets[state.stage] || stageTargets.idle;
      const k = 1 - Math.exp(-dt * 2.8);
      stageEnergy.current = lerp(stageEnergy.current, target.energy, k);
      stageEnergy.tint[0] = lerp(stageEnergy.tint[0], target.tint[0], k);
      stageEnergy.tint[1] = lerp(stageEnergy.tint[1], target.tint[1], k);
      stageEnergy.tint[2] = lerp(stageEnergy.tint[2], target.tint[2], k);

      // Pass 1: Volumetric Obsidian Void + Orbital Architectural Rings
      gl.disable(gl.BLEND);
      gl.useProgram(bgProg);
      gl.bindVertexArray(bgVao);
      gl.uniform2f(bgLoc.res, width, height);
      gl.uniform1f(bgLoc.time, t);
      gl.uniform2f(bgLoc.mouse, state.pointer.x, state.pointer.y);
      gl.uniform1f(bgLoc.energy, stageEnergy.current);
      gl.uniform3f(bgLoc.tint, stageEnergy.tint[0], stageEnergy.tint[1], stageEnergy.tint[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Pass 2: Depth-Projected Intelligence Particles
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.useProgram(ptProg);
      gl.bindVertexArray(ptVao);
      gl.uniform2f(ptLoc.res, width, height);
      gl.uniform1f(ptLoc.time, t);
      gl.uniform1f(ptLoc.dpr, state.dpr);
      gl.uniform2f(ptLoc.mouse, state.pointer.x, state.pointer.y);
      gl.uniform1f(ptLoc.energy, stageEnergy.current);
      gl.uniform3f(ptLoc.tint, stageEnergy.tint[0], stageEnergy.tint[1], stageEnergy.tint[2]);
      gl.drawArrays(gl.POINTS, 0, PARTICLE_COUNT);
      gl.bindVertexArray(null);
    }

    function destroy() {
      gl.deleteBuffer(ptBuf);
      gl.deleteVertexArray(ptVao);
      gl.deleteVertexArray(bgVao);
      gl.deleteProgram(bgProg);
      gl.deleteProgram(ptProg);
    }

    resize();
    return { resize, render, destroy };
  }

  // =========================================================================
  // SUBSYSTEM B: #comms-topology PROCEDURAL PLASMA ENERGY FILAMENTS ENGINE
  //   Base trajectory + Primary turbulent filament + Secondary wisps
  //   + Traveling energy packets + Micro-pulses
  // =========================================================================
  function createTopologyFilamentEngine() {
    const stageEl = document.getElementById('comms-topology');
    if (!stageEl) return null;

    const canvas = document.createElement('canvas');
    canvas.className = 'vfx-topology-canvas vfx-layer';
    canvas.setAttribute('aria-hidden', 'true');
    stageEl.insertBefore(canvas, stageEl.firstChild);
    injectedElements.push(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let w = 1;
    let h = 1;
    let anchorsDirty = true;
    let lastAnchorSync = 0;

    const anchors = {
      boss: null,
      w1: null,
      w2: null,
      w3: null,
    };

    const links = [
      { id: 'b-w1', from: 'boss', to: 'w1', cA: PALETTE.amber.rgb, cB: PALETTE.cyan.rgb, type: 'hub', bend: -0.18, seed: 1.7, intensity: 0.18, dir: 1 },
      { id: 'b-w2', from: 'boss', to: 'w2', cA: PALETTE.amber.rgb, cB: PALETTE.violet.rgb, type: 'hub', bend: 0.02, seed: 4.3, intensity: 0.18, dir: 1 },
      { id: 'b-w3', from: 'boss', to: 'w3', cA: PALETTE.amber.rgb, cB: PALETTE.ice.rgb, type: 'hub', bend: 0.18, seed: 7.9, intensity: 0.18, dir: 1 },
      { id: 'w1-w2', from: 'w1', to: 'w2', cA: PALETTE.cyan.rgb, cB: PALETTE.violet.rgb, type: 'mesh', bend: 0.22, seed: 11.4, intensity: 0.08, dir: 0 },
      { id: 'w2-w3', from: 'w2', to: 'w3', cA: PALETTE.violet.rgb, cB: PALETTE.ice.rgb, type: 'mesh', bend: 0.22, seed: 15.8, intensity: 0.08, dir: 0 },
      { id: 'w1-w3', from: 'w1', to: 'w3', cA: PALETTE.cyan.rgb, cB: PALETTE.ice.rgb, type: 'mesh', bend: 0.34, seed: 21.2, intensity: 0.06, dir: 0 },
    ];

    function syncAnchors() {
      const sr = stageEl.getBoundingClientRect();
      if (sr.width < 2 || sr.height < 2) return;
      const map = [
        ['boss', 'topo-boss'],
        ['w1', 'topo-w1'],
        ['w2', 'topo-w2'],
        ['w3', 'topo-w3'],
      ];
      for (const [key, id] of map) {
        const el = document.getElementById(id);
        if (!el) {
          anchors[key] = null;
          continue;
        }
        const r = el.getBoundingClientRect();
        anchors[key] = {
          x: r.left - sr.left + r.width * 0.5,
          y: r.top - sr.top + r.height * 0.5,
          rx: r.width * 0.5,
          ry: r.height * 0.5,
        };
      }
      anchorsDirty = false;
    }

    function resize() {
      const sr = stageEl.getBoundingClientRect();
      w = Math.max(1, sr.width);
      h = Math.max(1, sr.height);
      const dpr = state.dpr;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      syncAnchors();
    }

    function getBezierControlPoints(p0, p3, link) {
      const dx = p3.x - p0.x;
      const dy = p3.y - p0.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = -dy / dist;
      const ny = dx / dist;

      if (link.type === 'hub') {
        // Architectural curved conduit fanning out smoothly from Boss to Thinkers
        const offset = dist * link.bend;
        return {
          p1: { x: p0.x + dx * 0.28 + nx * offset * 0.65, y: p0.y + dy * 0.52 + ny * offset * 0.65 },
          p2: { x: p0.x + dx * 0.72 + nx * offset * 0.85, y: p0.y + dy * 0.48 + ny * offset * 0.85 },
        };
      }
      // Crosstalk mesh arc curving cleanly upward inside #comms-topology (never clipped at bottom)
      const sign = link.id === 'w1-w3' ? 1 : 0.72;
      const arc = Math.min(dist * link.bend, 30) * sign;
      const pushY = Math.abs(dy) < 30 ? -arc : 0;
      return {
        p1: { x: p0.x + dx * 0.30 + nx * arc * 0.25, y: p0.y + dy * 0.30 + pushY },
        p2: { x: p0.x + dx * 0.70 + nx * arc * 0.25, y: p0.y + dy * 0.70 + pushY },
      };
    }

    function evalCubic(p0, p1, p2, p3, t) {
      const mt = 1 - t;
      const mt2 = mt * mt;
      const t2 = t * t;
      const x = mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x;
      const y = mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y;
      const tx = 3 * mt2 * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t2 * (p3.x - p2.x);
      const ty = 3 * mt2 * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t2 * (p3.y - p2.y);
      const len = Math.hypot(tx, ty) || 1;
      return { x, y, nx: -ty / len, ny: tx / len };
    }

    function sampleDisplacedSpline(p0, p1, p2, p3, steps, time, seed, amp, freq) {
      const pts = new Array(steps + 1);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const b = evalCubic(p0, p1, p2, p3, u);
        const env = Math.sin(u * Math.PI);
        const turb = fbm2D(u * freq - time * 1.35, seed + time * 0.32);
        const disp = turb * amp * env;
        pts[i] = { x: b.x + b.nx * disp, y: b.y + b.ny * disp };
      }
      return pts;
    }

    function strokePolyline(pts) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    }

    function render(t, dt) {
      if (anchorsDirty || t - lastAnchorSync > 0.35) {
        syncAnchors();
        lastAnchorSync = t;
      }

      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const st = state.stage;
      const k = 1 - Math.exp(-dt * 4.5);

      for (const link of links) {
        const a = anchors[link.from];
        const b = anchors[link.to];
        if (!a || !b) continue;

        let targetIntensity = 0.32;
        let targetDir = 1; // 1 = from->to, -1 = to->from, 0 = bidirectional
        if (link.type === 'hub') {
          if (st === 'boss_plan') { targetIntensity = 0.95; targetDir = 1; }
          else if (st === 'worker_draft') { targetIntensity = 0.78; targetDir = 1; }
          else if (st === 'worker_crosstalk') { targetIntensity = 0.72; targetDir = 0; }
          else if (st === 'boss_merge') { targetIntensity = 1.0; targetDir = -1; }
          else { targetIntensity = 0.38; targetDir = 1; }
        } else {
          if (st === 'worker_crosstalk') { targetIntensity = 1.0; targetDir = 0; }
          else if (st === 'worker_draft') { targetIntensity = 0.45; targetDir = 0; }
          else if (st === 'boss_merge') { targetIntensity = 0.38; targetDir = 0; }
          else { targetIntensity = 0.30; targetDir = 0; }
        }

        link.intensity = lerp(link.intensity, targetIntensity, k);
        link.dir = targetDir;

        const { p1, p2 } = getBezierControlPoints(a, b, link);
        const colA = st === 'boss_merge' && link.type === 'hub' ? PALETTE.emerald.rgb : link.cA;
        const colB = st === 'boss_merge' && link.type === 'hub' ? PALETTE.amber.rgb : link.cB;

        const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        grad.addColorStop(0, rgbaStr(colA, 0.92));
        grad.addColorStop(1, rgbaStr(colB, 0.92));

        // 1. Base Architectural Trajectory Guide
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = grad;
        ctx.globalAlpha = 0.10 + 0.16 * link.intensity;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 6]);
        ctx.lineDashOffset = -t * 14 * (link.dir === -1 ? -1 : 1);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        if (link.intensity < 0.06) continue;

        const steps = 34;
        const amp = (4.5 + 11.5 * link.intensity) * (state.reducedMotion ? 0.25 : 1);
        const primaryPts = sampleDisplacedSpline(a, p1, p2, b, steps, t * (link.dir === -1 ? -1 : 1), link.seed, amp, 3.4);

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 2. Restrained Volumetric Plasma Sheath
        ctx.strokeStyle = grad;
        ctx.globalAlpha = 0.12 * link.intensity;
        ctx.lineWidth = 6.2;
        strokePolyline(primaryPts);

        // 3. Primary Displaced Plasma Filament
        ctx.globalAlpha = 0.36 + 0.44 * link.intensity;
        ctx.lineWidth = 1.65;
        strokePolyline(primaryPts);

        // 4. Secondary Turbulent Wisps (2 phase-shifted harmonic tendrils)
        if (!state.reducedMotion && link.intensity > 0.22) {
          for (let wIdx = 0; wIdx < 2; wIdx++) {
            const wispPts = sampleDisplacedSpline(
              a, p1, p2, b, 26,
              t * (wIdx === 0 ? 1.25 : -1.12),
              link.seed + 31.7 * (wIdx + 1),
              amp * (1.28 + wIdx * 0.22),
              4.8 + wIdx * 1.4
            );
            ctx.globalAlpha = (0.16 + 0.14 * link.intensity) * (wIdx === 0 ? 1 : 0.72);
            ctx.lineWidth = 0.9;
            strokePolyline(wispPts);
          }
        }

        // 5. Traveling Energy Packets + Micro-Pulses Along Displaced Filament
        const packetCount = link.intensity > 0.65 ? 3 : 2;
        const pktSpeed = 0.42 + 0.34 * link.intensity;
        for (let pi = 0; pi < packetCount; pi++) {
          const dirSign = link.dir === 0 ? (pi % 2 === 0 ? 1 : -1) : link.dir;
          const phase = (t * pktSpeed + pi / packetCount + link.seed * 0.13) % 1;
          const u = dirSign > 0 ? phase : 1 - phase;
          const idxF = u * steps;
          const idx0 = clamp(Math.floor(idxF), 0, steps - 1);
          const frac = idxF - idx0;
          const px = lerp(primaryPts[idx0].x, primaryPts[idx0 + 1].x, frac);
          const py = lerp(primaryPts[idx0].y, primaryPts[idx0 + 1].y, frac);

          // Tail sample slightly behind packet
          const uTail = clamp(u - dirSign * 0.065, 0, 1);
          const tIdxF = uTail * steps;
          const tIdx0 = clamp(Math.floor(tIdxF), 0, steps - 1);
          const tFrac = tIdxF - tIdx0;
          const tx = lerp(primaryPts[tIdx0].x, primaryPts[tIdx0 + 1].x, tFrac);
          const ty = lerp(primaryPts[tIdx0].y, primaryPts[tIdx0 + 1].y, tFrac);

          const pCol = mixRgb(colA, colB, u);
          const edgeEnv = Math.sin(u * Math.PI);
          const pAlpha = (0.45 + 0.50 * link.intensity) * smoothstep(0.0, 0.14, edgeEnv);

          const tailGrad = ctx.createLinearGradient(tx, ty, px, py);
          tailGrad.addColorStop(0, rgbaStr(pCol, 0));
          tailGrad.addColorStop(0.65, rgbaStr(pCol, pAlpha * 0.72));
          tailGrad.addColorStop(1, rgbaStr(PALETTE.white.rgb, pAlpha * 0.92));

          ctx.strokeStyle = tailGrad;
          ctx.globalAlpha = 1;
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(px, py);
          ctx.stroke();

          // Hot Plasma Core Dot
          const glow = ctx.createRadialGradient(px, py, 0.5, px, py, 8.5);
          glow.addColorStop(0, rgbaStr(PALETTE.white.rgb, pAlpha * 0.92));
          glow.addColorStop(0.35, rgbaStr(pCol, pAlpha * 0.55));
          glow.addColorStop(1, rgbaStr(pCol, 0));
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(px, py, 8.5, 0, Math.PI * 2);
          ctx.fill();

          // Micro-Pulse Arrival Ring on Target Anchor
          if ((dirSign > 0 && u > 0.90) || (dirSign < 0 && u < 0.10)) {
            const arrivalT = dirSign > 0 ? (u - 0.90) / 0.10 : (0.10 - u) / 0.10;
            const targetAnchor = dirSign > 0 ? b : a;
            const ringR = Math.max(targetAnchor.rx, targetAnchor.ry) * (0.85 + arrivalT * 0.55);
            ctx.strokeStyle = rgbaStr(pCol, (1 - arrivalT) * 0.34 * link.intensity);
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.arc(targetAnchor.x, targetAnchor.y, ringR, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // Convergence Shockwave Pulse Centered on #topo-boss on boss_merge
      if (state.topologyPulse.active && anchors.boss) {
        state.topologyPulse.progress += dt / state.topologyPulse.duration;
        const p = state.topologyPulse.progress;
        if (p >= 1) {
          state.topologyPulse.active = false;
        } else {
          const ease = 1 - Math.pow(1 - p, 3);
          const maxR = Math.hypot(w, h) * 0.58;
          const r = 18 + ease * maxR;
          const fade = Math.pow(1 - p, 1.7);
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = rgbaStr(PALETTE.emerald.rgb, fade * 0.42);
          ctx.lineWidth = 2.4 * (1 - p * 0.5);
          ctx.beginPath();
          ctx.arc(anchors.boss.x, anchors.boss.y, r, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = rgbaStr(PALETTE.amber.rgb, fade * 0.32);
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(anchors.boss.x, anchors.boss.y, r * 0.84, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(stageEl);

    resize();
    return {
      resize,
      render,
      markDirty: () => { anchorsDirty = true; },
      destroy: () => { if (ro) ro.disconnect(); },
    };
  }

  // =========================================================================
  // SUBSYSTEM C: #boss-plan-card HOLOGRAPHIC SPHERICAL INTELLIGENCE CORE
  // =========================================================================
  function createBossCoreEngine() {
    const bossCard = document.getElementById('boss-plan-card');
    if (!bossCard) return null;

    const wrap = document.createElement('div');
    wrap.className = 'vfx-boss-core-wrap vfx-layer';
    wrap.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    canvas.className = 'vfx-boss-core-canvas';
    wrap.appendChild(canvas);
    bossCard.insertBefore(wrap, bossCard.firstChild);
    injectedElements.push(wrap);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Precompute Fibonacci Sphere Lattice Nodes
    const NODE_COUNT = 54;
    const sphereNodes = [];
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NODE_COUNT; i++) {
      const y = 1 - (i / (NODE_COUNT - 1)) * 2;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = goldenAngle * i;
      sphereNodes.push({ x: Math.cos(theta) * r, y, z: Math.sin(theta) * r });
    }

    let size = 168;
    const dyn = { speed: 0.35, pulse: 0.3, col: [...PALETTE.cyan.rgb], ringCol: [...PALETTE.amber.rgb] };

    const stageConfigs = {
      idle: { speed: 0.28, pulse: 0.25, col: PALETTE.cyan.rgb, ringCol: PALETTE.slate.rgb },
      boss_plan: { speed: 0.92, pulse: 0.85, col: PALETTE.cyan.rgb, ringCol: PALETTE.amber.rgb },
      worker_draft: { speed: 0.56, pulse: 0.55, col: PALETTE.ice.rgb, ringCol: PALETTE.cyan.rgb },
      worker_crosstalk: { speed: 0.74, pulse: 0.72, col: PALETTE.violet.rgb, ringCol: PALETTE.cyan.rgb },
      boss_merge: { speed: 1.05, pulse: 0.96, col: PALETTE.amber.rgb, ringCol: PALETTE.emerald.rgb },
    };

    function resize() {
      const r = wrap.getBoundingClientRect();
      size = Math.max(80, Math.round(r.width || 168));
      canvas.width = Math.floor(size * state.dpr);
      canvas.height = Math.floor(size * state.dpr);
    }

    let rotY = 0;
    let rotX = 0.35;

    function render(t, dt) {
      const cfg = stageConfigs[state.stage] || stageConfigs.idle;
      const k = 1 - Math.exp(-dt * 3.5);
      dyn.speed = lerp(dyn.speed, cfg.speed, k);
      dyn.pulse = lerp(dyn.pulse, cfg.pulse, k);
      for (let i = 0; i < 3; i++) {
        dyn.col[i] = lerp(dyn.col[i], cfg.col[i], k);
        dyn.ringCol[i] = lerp(dyn.ringCol[i], cfg.ringCol[i], k);
      }

      rotY += dt * dyn.speed * (state.reducedMotion ? 0.15 : 1);
      rotX = 0.34 + Math.sin(t * 0.35) * 0.16 + state.pointer.y * 0.12;

      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      const cx = size * 0.5;
      const cy = size * 0.5;
      const radius = size * 0.27;
      const breath = 1 + Math.sin(t * 2.2) * 0.03 * dyn.pulse;
      const R = radius * breath;

      const cRGB = dyn.col.map(Math.round);
      const rRGB = dyn.ringCol.map(Math.round);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Inner Volumetric Core Glow (Restrained OLED Luminance)
      const coreGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, R * 1.48);
      coreGrad.addColorStop(0, rgbaStr(PALETTE.white.rgb, 0.24 * dyn.pulse));
      coreGrad.addColorStop(0.28, rgbaStr(cRGB, 0.22 + 0.14 * dyn.pulse));
      coreGrad.addColorStop(0.68, rgbaStr(rRGB, 0.07));
      coreGrad.addColorStop(1, rgbaStr(cRGB, 0));
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.48, 0, Math.PI * 2);
      ctx.fill();

      // 3 Tilted Gyroscopic Orbital Rings
      for (let i = 0; i < 3; i++) {
        const tilt = rotY * (i === 1 ? -0.65 : 0.45) + i * 1.05;
        const rr = R * (1.14 + i * 0.13);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(tilt);
        ctx.strokeStyle = rgbaStr(i === 2 ? rRGB : cRGB, 0.16 + 0.16 * dyn.pulse);
        ctx.lineWidth = i === 0 ? 1.15 : 0.85;
        ctx.beginPath();
        ctx.ellipse(0, 0, rr, rr * (0.34 + i * 0.09), 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // 3D Projected Geodesic Lattice Nodes + Subtle Nearest-Neighbor Arcs
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      const projected = sphereNodes.map((n) => {
        const x1 = n.x * cosY - n.z * sinY;
        const z1 = n.x * sinY + n.z * cosY;
        const y2 = n.y * cosX - z1 * sinX;
        const z2 = n.y * sinX + z1 * cosX;
        const persp = 2.6 / (2.6 - z2 * 0.8);
        return {
          x: cx + x1 * R * persp,
          y: cy + y2 * R * persp,
          z: z2,
          scale: persp,
        };
      });

      // Connect nearby front-facing lattice nodes
      ctx.lineWidth = 0.65;
      for (let i = 0; i < projected.length; i++) {
        const a = projected[i];
        if (a.z < -0.25) continue;
        for (let j = i + 1; j < projected.length; j++) {
          const b = projected[j];
          if (b.z < -0.25) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < R * 0.68) {
            const depthAlpha = ((a.z + b.z) * 0.5 + 0.4) * 0.18 * (0.6 + 0.5 * dyn.pulse);
            ctx.strokeStyle = rgbaStr(cRGB, depthAlpha);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Render Depth-Sorted Sphere Nodes
      for (const p of projected) {
        const depthNorm = (p.z + 1) * 0.5;
        const alpha = (0.14 + depthNorm * 0.58) * (0.65 + 0.45 * dyn.pulse);
        const nr = (0.75 + depthNorm * 1.15) * p.scale;
        ctx.fillStyle = rgbaStr(depthNorm > 0.72 ? PALETTE.white.rgb : cRGB, alpha);
        ctx.beginPath();
        ctx.arc(p.x, p.y, nr, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }

    resize();
    return { resize, render, destroy: () => {} };
  }

  // =========================================================================
  // SUBSYSTEM D: ACTIVE THINKER STREAMING WAVEFORM BARS (WORKERS 1 / 2 / 3)
  // =========================================================================
  function createWorkerWaveformEngines() {
    const specs = [
      { id: 'worker-card-worker_1', rgb: PALETTE.cyan.rgb, seed: 1.3 },
      { id: 'worker-card-worker_2', rgb: PALETTE.violet.rgb, seed: 5.7 },
      { id: 'worker-card-worker_3', rgb: PALETTE.ice.rgb, seed: 9.4 },
    ];

    const workers = [];
    const observers = [];

    for (const spec of specs) {
      const card = document.getElementById(spec.id);
      if (!card) continue;

      const host = document.createElement('div');
      host.className = 'vfx-waveform-host vfx-layer';
      host.setAttribute('aria-hidden', 'true');

      const canvas = document.createElement('canvas');
      canvas.className = 'vfx-waveform-canvas';
      host.appendChild(canvas);
      card.insertBefore(host, card.firstChild);
      injectedElements.push(host);

      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      const item = {
        card,
        host,
        canvas,
        ctx,
        rgb: spec.rgb,
        seed: spec.seed,
        w: 240,
        h: 24,
        activity: 0.12,
        streamSpike: 0,
      };

      // React in real time to streaming tokens appended to .worker-chatlog
      const chatlog = card.querySelector('.worker-chatlog');
      if (chatlog && typeof MutationObserver !== 'undefined') {
        const mo = new MutationObserver(() => {
          item.streamSpike = 1.0;
          card.classList.add('vfx-worker-active');
        });
        mo.observe(chatlog, { childList: true, subtree: true, characterData: true });
        observers.push(mo);
      }

      workers.push(item);
    }

    if (!workers.length) return null;

    function resize() {
      for (const w of workers) {
        const r = w.host.getBoundingClientRect();
        w.w = Math.max(60, r.width || 240);
        w.h = Math.max(16, r.height || 24);
        w.canvas.width = Math.floor(w.w * state.dpr);
        w.canvas.height = Math.floor(w.h * state.dpr);
      }
    }

    function render(t, dt) {
      const st = state.stage;
      const stageBase =
        st === 'worker_draft' ? 0.82 :
        st === 'worker_crosstalk' ? 0.94 :
        st === 'boss_plan' ? 0.24 :
        st === 'boss_merge' ? 0.18 : 0.10;

      for (const item of workers) {
        item.streamSpike = Math.max(0, item.streamSpike - dt * 0.72);
        if (item.streamSpike <= 0.02 && st !== 'worker_draft' && st !== 'worker_crosstalk') {
          item.card.classList.remove('vfx-worker-active');
        }
        const target = Math.min(1, Math.max(stageBase, item.streamSpike));
        item.activity = lerp(item.activity, target, 1 - Math.exp(-dt * 5.0));

        const { ctx, w, h, rgb, seed, activity } = item;
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const midY = h * 0.56;
        const speed = state.reducedMotion ? 0.35 : 2.6 + activity * 2.2;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';

        // Subtle Spectral Micro-Bars
        const bars = Math.min(44, Math.max(20, Math.floor(w / 9)));
        const step = w / bars;
        for (let i = 0; i < bars; i++) {
          const u = i / (bars - 1);
          const env = Math.sin(u * Math.PI);
          const n = Math.abs(fbm2D(u * 5.2 - t * speed * 0.35, seed + t * 0.45));
          const barH = (1.2 + n * (h * 0.68) * activity) * env;
          const x = i * step + step * 0.35;
          ctx.fillStyle = rgbaStr(rgb, (0.12 + 0.36 * activity) * env);
          ctx.fillRect(x, midY - barH * 0.5, 1.6, barH);
        }

        // Smooth Fluid Harmonic Ribbon Overlay
        ctx.beginPath();
        const segs = 48;
        for (let i = 0; i <= segs; i++) {
          const u = i / segs;
          const env = Math.sin(u * Math.PI);
          const wave =
            Math.sin(u * 14.0 - t * speed + seed) * 0.55 +
            Math.sin(u * 27.0 + t * speed * 1.3 + seed * 2.1) * 0.30 +
            fbm2D(u * 4.5 - t * 1.1, seed) * 0.45;
          const y = midY + wave * (h * 0.30) * activity * env;
          if (i === 0) ctx.moveTo(0, y);
          else ctx.lineTo(u * w, y);
        }
        ctx.strokeStyle = rgbaStr(rgb, 0.24 + 0.56 * activity);
        ctx.lineWidth = 1.25;
        ctx.stroke();
        ctx.restore();
      }
    }

    resize();
    return {
      resize,
      render,
      destroy: () => {
        for (const mo of observers) mo.disconnect();
      },
    };
  }

  // =========================================================================
  // SUBSYSTEM E: #boss-merge-card RADIAL CONVERGENCE SHOCKWAVE (GOLD + EMERALD)
  // =========================================================================
  function createMergeShockwaveEngine() {
    const card = document.getElementById('boss-merge-card');
    if (!card) return null;

    const layer = document.createElement('div');
    layer.className = 'vfx-shockwave-layer vfx-layer';
    layer.setAttribute('aria-hidden', 'true');

    const canvas = document.createElement('canvas');
    canvas.className = 'vfx-shockwave-canvas';
    layer.appendChild(canvas);
    card.insertBefore(layer, card.firstChild);
    injectedElements.push(layer);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let w = 320;
    let h = 160;

    const sparks = Array.from({ length: 28 }, (_, i) => ({
      ang: (i / 28) * Math.PI * 2 + hash2(i, 3.1) * 0.25,
      speed: 0.55 + hash2(i, 7.2) * 0.75,
      size: 1.0 + hash2(i, 1.9) * 1.5,
      isEmerald: i % 2 === 0,
    }));

    // Trigger shockwave if final verdict content is injected into #boss-merge-card
    let lastContentLen = (card.textContent || '').trim().length;
    let contentMo = null;
    if (typeof MutationObserver !== 'undefined') {
      contentMo = new MutationObserver(() => {
        const nextLen = (card.textContent || '').trim().length;
        if (nextLen > lastContentLen + 24 && state.stage === 'boss_merge') {
          triggerMergeShockwave();
        }
        lastContentLen = nextLen;
      });
      contentMo.observe(card, { childList: true, subtree: true, characterData: true });
    }

    function resize() {
      const r = card.getBoundingClientRect();
      w = Math.max(80, r.width || 320);
      h = Math.max(60, r.height || 160);
      canvas.width = Math.floor(w * state.dpr);
      canvas.height = Math.floor(h * state.dpr);
    }

    function render(t, dt) {
      const sw = state.mergeShockwave;
      if (!sw.active && state.stage !== 'boss_merge') {
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        return;
      }

      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w * 0.5;
      const cy = Math.min(h * 0.34, 72);
      const maxR = Math.hypot(w * 0.62, h * 0.85);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // Subtle Ambient Golden Verdict Horizon Glow When Converged
      if (state.stage === 'boss_merge') {
        const pulse = 0.08 + 0.03 * Math.sin(t * 1.8);
        const amb = ctx.createRadialGradient(cx, 0, 4, cx, 0, w * 0.55);
        amb.addColorStop(0, rgbaStr(PALETTE.amber.rgb, pulse));
        amb.addColorStop(0.55, rgbaStr(PALETTE.emerald.rgb, pulse * 0.35));
        amb.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = amb;
        ctx.fillRect(0, 0, w, h);
      }

      if (sw.active) {
        sw.progress += dt / sw.duration;
        const p = sw.progress;
        if (p >= 1) {
          sw.active = false;
        } else if (p < 0.24) {
          // Phase 1: Inward Amber-Gold Convergence Collapse
          const ip = p / 0.24;
          const r = maxR * 0.42 * (1 - ip * ip);
          const alpha = Math.sin(ip * Math.PI) * 0.42;
          ctx.strokeStyle = rgbaStr(PALETTE.amber.rgb, alpha);
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(4, r), 0, Math.PI * 2);
          ctx.stroke();
        } else {
          // Phase 2: Outward Emerald + Warm Amber-Gold Dual Convergence Shockwave
          const ep = (p - 0.24) / 0.76;
          const ease = 1 - Math.pow(1 - ep, 3);
          const fade = Math.pow(1 - ep, 1.55);

          const rEmerald = 8 + ease * maxR;
          const rAmber = 6 + Math.pow(ease, 1.15) * maxR * 0.86;

          // Soft Shockwave Band Fill
          const ringGrad = ctx.createRadialGradient(cx, cy, Math.max(1, rEmerald - 32), cx, cy, rEmerald + 6);
          ringGrad.addColorStop(0, rgbaStr(PALETTE.emerald.rgb, 0));
          ringGrad.addColorStop(0.75, rgbaStr(PALETTE.emerald.rgb, fade * 0.20));
          ringGrad.addColorStop(0.92, rgbaStr(PALETTE.amber.rgb, fade * 0.28));
          ringGrad.addColorStop(1, rgbaStr(PALETTE.emerald.rgb, 0));
          ctx.fillStyle = ringGrad;
          ctx.beginPath();
          ctx.arc(cx, cy, rEmerald + 6, 0, Math.PI * 2);
          ctx.fill();

          // Primary Emerald Leading Wavefront
          ctx.strokeStyle = rgbaStr(PALETTE.emerald.rgb, fade * 0.62);
          ctx.lineWidth = 2.2 * (1 - ep * 0.45);
          ctx.beginPath();
          ctx.arc(cx, cy, rEmerald, 0, Math.PI * 2);
          ctx.stroke();

          // Secondary Amber-Gold Trailing Harmonic Ring
          ctx.strokeStyle = rgbaStr(PALETTE.amber.rgb, fade * 0.48);
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.arc(cx, cy, rAmber, 0, Math.PI * 2);
          ctx.stroke();

          // Dispersing Emerald & Gold Convergence Sparks
          if (!state.reducedMotion) {
            for (const sp of sparks) {
              const dist = 10 + ease * maxR * 0.68 * sp.speed;
              const sx = cx + Math.cos(sp.ang) * dist;
              const sy = cy + Math.sin(sp.ang) * dist * 0.58;
              ctx.fillStyle = rgbaStr(sp.isEmerald ? PALETTE.emerald.rgb : PALETTE.amber.rgb, fade * 0.72);
              ctx.beginPath();
              ctx.arc(sx, sy, sp.size * (1 - ep * 0.4), 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      ctx.restore();
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(card);

    resize();
    return {
      resize,
      render,
      destroy: () => {
        if (ro) ro.disconnect();
        if (contentMo) contentMo.disconnect();
      },
    };
  }

  // =========================================================================
  // SUBSYSTEM F: SPECULAR GLASS POINTER TRACKING & OBSERVERS
  // =========================================================================
  const glassCardIds = [
    'boss-plan-card',
    'worker-card-worker_1',
    'worker-card-worker_2',
    'worker-card-worker_3',
    'boss-merge-card',
  ];

  function updateSpecularTracking() {
    if (state.reducedMotion) return;
    for (const id of glassCardIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const rx = clamp(((state.pointer.px - r.left) / r.width) * 100, -25, 125);
      const ry = clamp(((state.pointer.py - r.top) / r.height) * 100, -25, 125);
      el.style.setProperty('--mx', `${rx.toFixed(1)}%`);
      el.style.setProperty('--my', `${ry.toFixed(1)}%`);
    }
  }

  let pointerMoved = false;
  function onPointerMove(e) {
    state.pointer.px = e.clientX;
    state.pointer.py = e.clientY;
    state.pointer.tx = (e.clientX / Math.max(window.innerWidth, 1) - 0.5) * 2;
    state.pointer.ty = (e.clientY / Math.max(window.innerHeight, 1) - 0.5) * 2;
    pointerMoved = true;
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  cleanupCallbacks.push(() => window.removeEventListener('pointermove', onPointerMove));

  // =========================================================================
  // SUBSYSTEM B2: WAR-ROOM CARD-TO-CARD PLASMA CONDUITS (Boss <-> 3 Thinkers <-> Merge)
  // =========================================================================
  function createWarroomCardLinksEngine() {
    const ws = document.querySelector('.orchestra-workspace');
    if (!ws) return null;

    const canvas = document.createElement('canvas');
    canvas.className = 'vfx-warroom-links vfx-layer';
    canvas.setAttribute('aria-hidden', 'true');
    ws.insertBefore(canvas, ws.firstChild);
    injectedElements.push(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    let w = 1;
    let h = 1;

    function resize() {
      w = Math.max(1, ws.clientWidth);
      h = Math.max(1, ws.scrollHeight);
      const dpr = state.dpr;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }

    function boxAnchor(el, edge) {
      if (!el) return null;
      const wr = ws.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const scrollTop = ws.scrollTop || 0;
      const cx = r.left - wr.left + r.width * 0.5;
      const cy = r.top - wr.top + scrollTop + r.height * 0.5;
      if (edge === 'bottom') return { x: cx, y: r.bottom - wr.top + scrollTop };
      if (edge === 'top') return { x: cx, y: r.top - wr.top + scrollTop };
      if (edge === 'left') return { x: r.left - wr.left, y: cy };
      if (edge === 'right') return { x: r.right - wr.left, y: cy };
      return { x: cx, y: cy };
    }

    function drawConduit(a, b, colA, colB, t, intensity, dir, curveMode) {
      if (!a || !b) return;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const c1 = curveMode === 'horiz'
        ? { x: a.x + dx * 0.35, y: a.y - 12 }
        : { x: a.x, y: a.y + dy * 0.52 };
      const c2 = curveMode === 'horiz'
        ? { x: a.x + dx * 0.65, y: b.y - 12 }
        : { x: b.x, y: b.y - dy * 0.52 };

      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, rgbaStr(colA, 0.85));
      grad.addColorStop(1, rgbaStr(colB, 0.85));

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = grad;
      ctx.globalAlpha = 0.22 + 0.45 * intensity;
      ctx.lineWidth = 1.6 + intensity * 0.9;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
      ctx.stroke();

      // Traveling energy pulse along the conduit
      const count = 2;
      for (let i = 0; i < count; i++) {
        const dSign = dir === 0 ? (i % 2 === 0 ? 1 : -1) : dir;
        const phase = (t * (0.45 + 0.35 * intensity) + i / count) % 1;
        const u = dSign > 0 ? phase : 1 - phase;
        const mt = 1 - u;
        const px = mt * mt * mt * a.x + 3 * mt * mt * u * c1.x + 3 * mt * u * u * c2.x + u * u * u * b.x;
        const py = mt * mt * mt * a.y + 3 * mt * mt * u * c1.y + 3 * mt * u * u * c2.y + u * u * u * b.y;
        const pCol = mixRgb(colA, colB, u);
        const dot = ctx.createRadialGradient(px, py, 0.5, px, py, 7);
        dot.addColorStop(0, rgbaStr(PALETTE.white.rgb, 0.9 * intensity));
        dot.addColorStop(0.45, rgbaStr(pCol, 0.6 * intensity));
        dot.addColorStop(1, rgbaStr(pCol, 0));
        ctx.fillStyle = dot;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function render(t) {
      const targetH = Math.max(1, ws.scrollHeight);
      if (Math.abs(targetH - h) > 2) resize();

      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const plan = document.getElementById('boss-plan-card');
      const w1 = document.getElementById('worker-card-worker_1');
      const w2 = document.getElementById('worker-card-worker_2');
      const w3 = document.getElementById('worker-card-worker_3');
      const merge = document.getElementById('boss-merge-card');
      if (!plan || !w1 || !w2 || !w3 || !merge) return;

      const st = state.stage;
      const topInt = st === 'boss_plan' || st === 'worker_draft' ? 0.95 : 0.42;
      const talkInt = st === 'worker_crosstalk' ? 1.0 : 0.38;
      const botInt = st === 'boss_merge' ? 1.0 : st === 'worker_crosstalk' ? 0.58 : 0.35;

      // Boss Plan -> 3 Thinker Chatboxes
      const planBot = boxAnchor(plan, 'bottom');
      drawConduit(planBot, boxAnchor(w1, 'top'), PALETTE.amber.rgb, PALETTE.cyan.rgb, t, topInt, 1, 'vert');
      drawConduit(planBot, boxAnchor(w2, 'top'), PALETTE.amber.rgb, PALETTE.violet.rgb, t, topInt, 1, 'vert');
      drawConduit(planBot, boxAnchor(w3, 'top'), PALETTE.amber.rgb, PALETTE.ice.rgb, t, topInt, 1, 'vert');

      // Thinker 1 <-> Thinker 2 <-> Thinker 3 horizontal plasma lines
      drawConduit(boxAnchor(w1, 'right'), boxAnchor(w2, 'left'), PALETTE.cyan.rgb, PALETTE.violet.rgb, t, talkInt, 0, 'horiz');
      drawConduit(boxAnchor(w2, 'right'), boxAnchor(w3, 'left'), PALETTE.violet.rgb, PALETTE.ice.rgb, t, talkInt, 0, 'horiz');

      // 3 Thinkers -> Finalised Boss Merge
      const mergeTop = boxAnchor(merge, 'top');
      drawConduit(boxAnchor(w1, 'bottom'), mergeTop, PALETTE.cyan.rgb, PALETTE.emerald.rgb, t, botInt, 1, 'vert');
      drawConduit(boxAnchor(w2, 'bottom'), mergeTop, PALETTE.violet.rgb, PALETTE.emerald.rgb, t, botInt, 1, 'vert');
      drawConduit(boxAnchor(w3, 'bottom'), mergeTop, PALETTE.ice.rgb, PALETTE.amber.rgb, t, botInt, 1, 'vert');
    }

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    if (ro) ro.observe(ws);

    resize();
    return { resize, render, destroy: () => { if (ro) ro.disconnect(); } };
  }

  // Instantiate Subsystems
  const voidEngine = createVoidBackgroundEngine();
  const topologyEngine = createTopologyFilamentEngine();
  const warroomLinksEngine = createWarroomCardLinksEngine();
  const bossCoreEngine = createBossCoreEngine();
  const waveformEngine = createWorkerWaveformEngines();
  const mergeShockwaveEngine = createMergeShockwaveEngine();

  function resizeAll() {
    state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (voidEngine) voidEngine.resize();
    if (topologyEngine) topologyEngine.resize();
    if (warroomLinksEngine) warroomLinksEngine.resize();
    if (bossCoreEngine) bossCoreEngine.resize();
    if (waveformEngine) waveformEngine.resize();
    if (mergeShockwaveEngine) mergeShockwaveEngine.resize();
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeAll, 60);
  }
  window.addEventListener('resize', onResize, { passive: true });
  cleanupCallbacks.push(() => {
    clearTimeout(resizeTimer);
    window.removeEventListener('resize', onResize);
  });

  // Observe Stage Class Changes & vfx-off Toggles
  if (typeof MutationObserver !== 'undefined') {
    const classObserver = new MutationObserver(() => {
      syncStage(false);
      updateLoopState();
    });
    const targets = [
      document.documentElement,
      document.body,
      document.getElementById('comms-topology'),
    ].filter(Boolean);
    for (const t of targets) {
      classObserver.observe(t, { attributes: true, attributeFilter: ['class', 'data-vfx', 'data-stage'] });
    }
    cleanupCallbacks.push(() => classObserver.disconnect());
  }

  function onMotionChange(e) {
    state.reducedMotion = !!e.matches;
  }
  if (reducedMotionQuery.addEventListener) {
    reducedMotionQuery.addEventListener('change', onMotionChange);
    cleanupCallbacks.push(() => reducedMotionQuery.removeEventListener('change', onMotionChange));
  }

  function onVisibilityChange() {
    updateLoopState();
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  cleanupCallbacks.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

  // =========================================================================
  // MAIN 60FPS REQUESTANIMATIONFRAME LOOP
  // =========================================================================
  function tick(now) {
    if (state.destroyed) return;
    if (document.hidden || isVfxOffDom()) {
      state.rafId = 0;
      return;
    }

    if (!state.lastTime) state.lastTime = now;
    const rawDt = (now - state.lastTime) * 0.001;
    state.lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    const timeScale = state.reducedMotion ? 0.18 : 1.0;
    state.elapsed += dt * timeScale;

    // Smooth pointer parallax interpolation
    const pk = 1 - Math.exp(-dt * 5.0);
    state.pointer.x = lerp(state.pointer.x, state.pointer.tx, pk);
    state.pointer.y = lerp(state.pointer.y, state.pointer.ty, pk);

    if (pointerMoved) {
      updateSpecularTracking();
      pointerMoved = false;
    }

    const t = state.elapsed;
    if (voidEngine) voidEngine.render(t, dt);
    if (topologyEngine) topologyEngine.render(t, dt);
    if (warroomLinksEngine) warroomLinksEngine.render(t, dt);
    if (bossCoreEngine) bossCoreEngine.render(t, dt);
    if (waveformEngine) waveformEngine.render(t, dt);
    if (mergeShockwaveEngine) mergeShockwaveEngine.render(t, dt);

    state.rafId = requestAnimationFrame(tick);
  }

  function updateLoopState() {
    if (state.destroyed) return;
    if (document.hidden || isVfxOffDom()) {
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
        state.rafId = 0;
      }
      return;
    }
    if (!state.rafId) {
      state.lastTime = 0;
      state.rafId = requestAnimationFrame(tick);
    }
  }

  // Initial sync & kick off loop
  syncStage(false);
  updateLoopState();

  const controller = {
    setStage(stageName) {
      state.forcedStage = stageName && STAGES.includes(stageName) ? stageName : null;
      syncStage(stageName === 'boss_merge');
    },
    triggerMergeShockwave,
    setVfxEnabled(flag) {
      state.enabled = !!flag;
      document.documentElement.classList.toggle('vfx-off', !state.enabled);
      updateLoopState();
    },
    resize: resizeAll,
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      if (voidEngine) voidEngine.destroy();
      if (topologyEngine) topologyEngine.destroy();
      if (warroomLinksEngine) warroomLinksEngine.destroy();
      if (bossCoreEngine) bossCoreEngine.destroy();
      if (waveformEngine) waveformEngine.destroy();
      if (mergeShockwaveEngine) mergeShockwaveEngine.destroy();
      for (const fn of cleanupCallbacks) fn();
      for (const el of injectedElements) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }
      if (typeof window !== 'undefined' && window.__orchestraProVfx === controller) {
        delete window.__orchestraProVfx;
      }
    },
  };

  if (typeof window !== 'undefined') {
    window.__orchestraProVfx = controller;
    window.initProVfxEngine = initProVfxEngine;
  }

  return controller;
}