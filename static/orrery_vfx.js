/**
 * ORCHESTRA AI — 100% 3D Planetary & Implied CAD Drafting VFX Engine
 * True 3D perspective camera (drag orbit + scroll zoom + blueprint presets),
 * rotating 3D shaded planets + rings + moons, tilted elliptical CAD tracks,
 * 3D orbital energy arcs, and live drafting leader-lines tethering HUD pods.
 */
function initOrreryVfxEngine() {
  if (typeof window !== "undefined" && window.__orchestraOrrery && typeof window.__orchestraOrrery.destroy === "function") {
    window.__orchestraOrrery.destroy();
  }

  const canvas = document.getElementById("orrery-canvas");
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const state = {
    enabled: true,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false,
    stage: "idle",
    activeWorkers: new Set(),
    elapsed: 0,
    lastTime: 0,
    rafId: 0,
    destroyed: false,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    w: 1,
    h: 1,
    camYaw: 0.28,
    camPitch: 0.42,
    camDist: 780,
    targetYaw: 0.28,
    targetPitch: 0.42,
    targetDist: 780,
    dragging: false,
    dragX: 0,
    dragY: 0,
    pointerX: 0,
    pointerY: 0,
    shockwaves: [],
    podSpikes: { worker_1: 0, worker_2: 0, worker_3: 0, boss: 0 },
  };

  const STARS = Array.from({ length: 170 }, () => ({
    x: (Math.random() - 0.5) * 2400,
    y: (Math.random() - 0.5) * 1600,
    z: (Math.random() - 0.5) * 2400,
    r: 0.6 + Math.random() * 1.4,
    a: 0.15 + Math.random() * 0.5,
  }));

  const PLANETS = [
    {
      id: "worker_1",
      podId: "worker-card-worker_1",
      code: "T1 · ARCH",
      rx: 205,
      rz: 178,
      inclination: 0.28,
      tiltAzimuth: 0.4,
      speed: 0.42,
      phase: 0.4,
      radius: 21,
      rgb: [84, 217, 255],
      hasRing: true,
      hasMoon: true,
      wireSegments: 10,
    },
    {
      id: "worker_2",
      podId: "worker-card-worker_2",
      code: "T2 · BUILD",
      rx: 285,
      rz: 235,
      inclination: -0.36,
      tiltAzimuth: 2.2,
      speed: 0.31,
      phase: 2.5,
      radius: 24,
      rgb: [155, 131, 255],
      hasRing: false,
      hasMoon: true,
      wireSegments: 12,
    },
    {
      id: "worker_3",
      podId: "worker-card-worker_3",
      code: "T3 · CRITIC",
      rx: 355,
      rz: 315,
      inclination: 0.52,
      tiltAzimuth: 4.1,
      speed: 0.23,
      phase: 4.5,
      radius: 19,
      rgb: [57, 139, 255],
      accentRgb: [229, 185, 108],
      hasRing: true,
      hasMoon: false,
      wireSegments: 8,
    },
  ];

  const BOSS = {
    id: "boss",
    code: "BOSS · CORE",
    radius: 46,
    rgb: [229, 185, 108],
    cyanRgb: [84, 217, 255],
    emeraldRgb: [52, 211, 153],
  };

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${clamp(a, 0, 1).toFixed(3)})`;
  const mixRgb = (a, b, t) => [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];

  function resize() {
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.w = Math.max(1, window.innerWidth);
    state.h = Math.max(1, window.innerHeight);
    canvas.width = Math.floor(state.w * state.dpr);
    canvas.height = Math.floor(state.h * state.dpr);
  }

  // 3D Camera Rotation & Perspective Projection
  function project3D(wx, wy, wz) {
    const cy = Math.cos(state.camYaw);
    const sy = Math.sin(state.camYaw);
    const cp = Math.cos(state.camPitch);
    const sp = Math.sin(state.camPitch);

    // Yaw around Y
    const x1 = wx * cy - wz * sy;
    const z1 = wx * sy + wz * cy;
    // Pitch around X
    const y2 = wy * cp - z1 * sp;
    const z2 = wy * sp + z1 * cp;

    const fov = 760;
    const depth = state.camDist + z2;
    if (depth < 40) return null;
    const scale = fov / depth;
    return {
      x: state.w * 0.5 + x1 * scale,
      y: state.h * 0.46 + y2 * scale,
      z: z2,
      depth,
      scale,
    };
  }

  function orbitPoint(p, theta) {
    // Local ellipse in XZ
    const lx = p.rx * Math.cos(theta);
    const lz = p.rz * Math.sin(theta);
    // Tilt around local X by inclination
    const ci = Math.cos(p.inclination);
    const si = Math.sin(p.inclination);
    const y1 = -lz * si;
    const z1 = lz * ci;
    // Rotate plane around Y by tiltAzimuth
    const ca = Math.cos(p.tiltAzimuth);
    const sa = Math.sin(p.tiltAzimuth);
    return {
      x: lx * ca - z1 * sa,
      y: y1,
      z: lx * sa + z1 * ca,
    };
  }

  function drawDraftingGrid(t) {
    const yFloor = 135;
    const gridExtent = 520;
    const step = 65;

    ctx.save();
    ctx.lineWidth = 0.8;
    for (let g = -gridExtent; g <= gridExtent; g += step) {
      const a = project3D(g, yFloor, -gridExtent);
      const b = project3D(g, yFloor, gridExtent);
      if (a && b) {
        ctx.strokeStyle = g === 0 ? "rgba(84,217,255,0.14)" : "rgba(148,163,184,0.06)";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const c = project3D(-gridExtent, yFloor, g);
      const d = project3D(gridExtent, yFloor, g);
      if (c && d) {
        ctx.strokeStyle = g === 0 ? "rgba(84,217,255,0.14)" : "rgba(148,163,184,0.06)";
        ctx.beginPath();
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
        ctx.stroke();
      }
    }

    // Outer calibrated compass ring on floor
    ctx.strokeStyle = "rgba(84,217,255,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= 72; i++) {
      const ang = (i / 72) * Math.PI * 2;
      const pt = project3D(Math.cos(ang) * 400, yFloor, Math.sin(ang) * 400);
      if (!pt) continue;
      if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();

    // 30-degree CAD azimuth ticks
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180 + t * 0.02;
      const p1 = project3D(Math.cos(rad) * 392, yFloor, Math.sin(rad) * 392);
      const p2 = project3D(Math.cos(rad) * 412, yFloor, Math.sin(rad) * 412);
      if (p1 && p2) {
        ctx.strokeStyle = deg % 90 === 0 ? "rgba(229,185,108,0.34)" : "rgba(148,163,184,0.18)";
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }

    // Polar axis line through Boss Core
    const topAxis = project3D(0, -145, 0);
    const botAxis = project3D(0, yFloor, 0);
    if (topAxis && botAxis) {
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = "rgba(229,185,108,0.22)";
      ctx.beginPath();
      ctx.moveTo(topAxis.x, topAxis.y);
      ctx.lineTo(botAxis.x, botAxis.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function draw3DSphere(proj, worldPos, radius, rgb, accentRgb, rotY, wireSegs, isBoss, pulse) {
    if (!proj) return;
    const r = radius * proj.scale;
    if (r < 2) return;

    ctx.save();
    // Volumetric atmospheric corona
    const coronaR = r * (isBoss ? 2.6 + pulse * 0.5 : 1.9 + pulse * 0.35);
    const corona = ctx.createRadialGradient(proj.x, proj.y, r * 0.4, proj.x, proj.y, coronaR);
    corona.addColorStop(0, rgba(rgb, isBoss ? 0.36 + pulse * 0.2 : 0.24 + pulse * 0.16));
    corona.addColorStop(0.45, rgba(accentRgb || rgb, 0.09));
    corona.addColorStop(1, rgba(rgb, 0));
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, coronaR, 0, Math.PI * 2);
    ctx.fill();

    // 3D Lit Sphere Body (Obsidian core + off-center specular + Fresnel rim)
    ctx.globalCompositeOperation = "source-over";
    const lx = proj.x - r * 0.34;
    const ly = proj.y - r * 0.34;
    const bodyGrad = ctx.createRadialGradient(lx, ly, r * 0.08, proj.x, proj.y, r);
    bodyGrad.addColorStop(0, rgba([241, 245, 252], isBoss ? 0.92 : 0.72));
    bodyGrad.addColorStop(0.28, rgba(rgb, isBoss ? 0.85 : 0.75));
    bodyGrad.addColorStop(0.76, rgba(mixRgb(rgb, [10, 14, 24], 0.76), 0.96));
    bodyGrad.addColorStop(1, "rgba(6,9,16,0.98)");
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Clip to sphere for rotating 3D CAD latitude/longitude wireframe
    ctx.save();
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, r, 0, Math.PI * 2);
    ctx.clip();

    ctx.strokeStyle = rgba(accentRgb || rgb, isBoss ? 0.42 : 0.36);
    ctx.lineWidth = isBoss ? 1.05 : 0.85;

    // Rotating longitude meridians
    for (let m = 0; m < wireSegs; m++) {
      const phi = (m / wireSegs) * Math.PI + rotY;
      ctx.beginPath();
      for (let s = 0; s <= 20; s++) {
        const lat = (s / 20) * Math.PI - Math.PI * 0.5;
        const px = Math.cos(lat) * Math.sin(phi) * r;
        const py = Math.sin(lat) * r;
        const pz = Math.cos(lat) * Math.cos(phi);
        if (pz < -0.15) continue;
        const sx = proj.x + px;
        const sy = proj.y + py;
        if (s === 0 || pz < -0.1) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }

    // Latitude rings
    for (let latIdx = -2; latIdx <= 2; latIdx++) {
      const lat = (latIdx / 3) * (Math.PI * 0.45);
      const yOff = Math.sin(lat) * r;
      const ringR = Math.cos(lat) * r;
      ctx.beginPath();
      ctx.ellipse(proj.x, proj.y + yOff, ringR, ringR * Math.max(0.18, Math.abs(Math.sin(state.camPitch))), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Crisp Fresnel specular rim
    ctx.strokeStyle = rgba(rgb, 0.65 + pulse * 0.25);
    ctx.lineWidth = isBoss ? 1.6 : 1.15;
    ctx.beginPath();
    ctx.arc(proj.x, proj.y, r, 0, Math.PI * 2);
    ctx.stroke();

    // CAD calibration reticle brackets around active sphere
    const br = r + 7;
    const bLen = Math.max(5, r * 0.28);
    ctx.strokeStyle = rgba(accentRgb || rgb, 0.42 + pulse * 0.4);
    ctx.lineWidth = 1;
    [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].forEach(([sx, sy]) => {
      const cx = proj.x + sx * br;
      const cy = proj.y + sy * br;
      ctx.beginPath();
      ctx.moveTo(cx - sx * bLen, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy - sy * bLen);
      ctx.stroke();
    });

    ctx.restore();
  }

  function drawPlanetRing(worldPos, radius, rgb, rotAngle, tilt) {
    ctx.save();
    ctx.strokeStyle = rgba(rgb, 0.45);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2 + rotAngle;
      const rx = Math.cos(a) * radius * 1.75;
      const rz = Math.sin(a) * radius * 1.75;
      const ry = Math.sin(a) * radius * tilt;
      const p = project3D(worldPos.x + rx, worldPos.y + ry, worldPos.z + rz);
      if (!p) continue;
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawEnergyArc3D(posA, posB, colA, colB, t, intensity, dir, arcLift) {
    const mid = {
      x: (posA.x + posB.x) * 0.5,
      y: (posA.y + posB.y) * 0.5 - arcLift,
      z: (posA.z + posB.z) * 0.5,
    };
    const steps = 28;
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const mt = 1 - u;
      const wx = mt * mt * posA.x + 2 * mt * u * mid.x + u * u * posB.x;
      const wy = mt * mt * posA.y + 2 * mt * u * mid.y + u * u * posB.y;
      const wz = mt * mt * posA.z + 2 * mt * u * mid.z + u * u * posB.z;
      const pr = project3D(wx, wy, wz);
      if (pr) pts.push({ ...pr, u });
    }
    if (pts.length < 2) return;

    const grad = ctx.createLinearGradient(pts[0].x, pts[0].y, pts[pts.length - 1].x, pts[pts.length - 1].y);
    grad.addColorStop(0, rgba(colA, 0.85));
    grad.addColorStop(1, rgba(colB, 0.85));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = grad;
    ctx.globalAlpha = 0.22 + 0.52 * intensity;
    ctx.lineWidth = 1.4 + intensity * 1.4;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();

    // Traveling plasma packets along the 3D arc
    const packets = intensity > 0.65 ? 3 : 1;
    for (let pi = 0; pi < packets; pi++) {
      const dSign = dir === 0 ? (pi % 2 === 0 ? 1 : -1) : dir;
      const phase = (t * (0.55 + 0.4 * intensity) + pi / packets) % 1;
      const u = dSign > 0 ? phase : 1 - phase;
      const idx = clamp(Math.floor(u * (pts.length - 1)), 0, pts.length - 1);
      const pt = pts[idx];
      const pCol = mixRgb(colA, colB, u);
      const g = ctx.createRadialGradient(pt.x, pt.y, 0.5, pt.x, pt.y, 9);
      g.addColorStop(0, rgba([255, 255, 255], 0.95 * intensity));
      g.addColorStop(0.4, rgba(pCol, 0.65 * intensity));
      g.addColorStop(1, rgba(pCol, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawPodTether(planetProj, podId, code, rgb, thetaDeg, radiusAu) {
    if (!planetProj) return;
    // CAD leader callout tag next to the 3D planet
    const labelX = planetProj.x + (planetProj.x > state.w * 0.5 ? 48 : -148);
    const labelY = planetProj.y - 34;

    ctx.save();
    ctx.strokeStyle = rgba(rgb, 0.52);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(planetProj.x, planetProj.y);
    ctx.lineTo(planetProj.x + (planetProj.x > state.w * 0.5 ? 24 : -24), labelY);
    ctx.lineTo(labelX + (planetProj.x > state.w * 0.5 ? 0 : 102), labelY);
    ctx.stroke();

    ctx.font = "600 10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = rgba(rgb, 0.92);
    ctx.fillText(`${code} · ${thetaDeg}°`, labelX + 4, labelY - 4);
    ctx.fillStyle = "rgba(170,182,200,0.68)";
    ctx.fillText(`R=${radiusAu} AU`, labelX + 4, labelY + 11);

    // Subtle dashed drafting tether to the planet's floating HUD pod
    const podEl = document.getElementById(podId);
    if (podEl && podEl.offsetParent !== null) {
      const r = podEl.getBoundingClientRect();
      const targetX = r.left + (planetProj.x < r.left ? 0 : planetProj.x > r.right ? r.width : r.width * 0.5);
      const targetY = r.top + (planetProj.y < r.top ? 0 : planetProj.y > r.bottom ? r.height : r.height * 0.5);
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = rgba(rgb, 0.22);
      ctx.beginPath();
      ctx.moveTo(planetProj.x, planetProj.y);
      ctx.lineTo(targetX, targetY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function render(dt) {
    if (!state.enabled) return;
    const speedScale = state.reducedMotion ? 0.18 : 1.0;
    state.elapsed += dt * speedScale;
    const t = state.elapsed;

    // Smooth camera easing
    const ck = 1 - Math.exp(-dt * 7);
    state.camYaw = lerp(state.camYaw, state.targetYaw, ck);
    state.camPitch = lerp(state.camPitch, state.targetPitch, ck);
    state.camDist = lerp(state.camDist, state.targetDist, ck);

    // Gentle idle drift if not dragging
    if (!state.dragging && !state.reducedMotion) {
      state.targetYaw += dt * 0.035;
    }

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.w, state.h);

    // Deep obsidian radial sky gradient
    const bg = ctx.createRadialGradient(state.w * 0.5, state.h * 0.45, 30, state.w * 0.5, state.h * 0.45, Math.max(state.w, state.h) * 0.78);
    bg.addColorStop(0, "#101728");
    bg.addColorStop(0.5, "#090d16");
    bg.addColorStop(1, "#05070c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, state.w, state.h);

    // 3D Starfield parallax
    for (const s of STARS) {
      const p = project3D(s.x, s.y, s.z);
      if (!p) continue;
      ctx.fillStyle = `rgba(226,236,255,${(s.a * clamp(1400 / p.depth, 0.1, 0.9)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, s.r * p.scale * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }

    drawDraftingGrid(t);

    const st = state.stage;
    const orbitBoost = st === "worker_draft" ? 1.45 : st === "worker_crosstalk" ? 1.8 : st === "boss_merge" ? 1.25 : 1.0;

    // Compute 3D positions & draw tilted elliptical CAD orbital tracks
    const planetWorld = {};
    const planetProj = {};
    const planetAngles = {};

    for (const p of PLANETS) {
      const spike = state.podSpikes[p.id] || 0;
      state.podSpikes[p.id] = Math.max(0, spike - dt * 1.6);

      // Draw tilted elliptical orbit track
      ctx.save();
      ctx.strokeStyle = rgba(p.rgb, st === "worker_crosstalk" || st === "worker_draft" ? 0.34 : 0.19);
      ctx.lineWidth = 1.05;
      ctx.setLineDash([5, 6]);
      ctx.lineDashOffset = -t * 16;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= 72; i++) {
        const wp = orbitPoint(p, (i / 72) * Math.PI * 2);
        const sp = project3D(wp.x, wp.y, wp.z);
        if (!sp) continue;
        if (!started) { ctx.moveTo(sp.x, sp.y); started = true; }
        else ctx.lineTo(sp.x, sp.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      const theta = p.phase + t * p.speed * orbitBoost;
      planetAngles[p.id] = theta;
      const wp = orbitPoint(p, theta);
      planetWorld[p.id] = wp;
      planetProj[p.id] = project3D(wp.x, wp.y, wp.z);
    }

    const bossWorld = { x: 0, y: 0, z: 0 };
    const bossProj = project3D(0, 0, 0);
    state.podSpikes.boss = Math.max(0, (state.podSpikes.boss || 0) - dt * 1.4);

    // 3D Energy Arcs between Boss <-> Thinkers and Thinker <-> Thinker
    const hubInt = st === "boss_plan" ? 0.95 : st === "worker_draft" ? 0.85 : st === "worker_crosstalk" ? 0.68 : st === "boss_merge" ? 1.0 : 0.25;
    const hubDir = st === "boss_merge" ? -1 : st === "worker_crosstalk" ? 0 : 1;
    const talkInt = st === "worker_crosstalk" ? 1.0 : st === "worker_draft" ? 0.42 : 0.22;

    for (const p of PLANETS) {
      drawEnergyArc3D(
        bossWorld,
        planetWorld[p.id],
        st === "boss_merge" ? BOSS.emeraldRgb : BOSS.rgb,
        p.rgb,
        t,
        hubInt,
        hubDir,
        35
      );
    }

    drawEnergyArc3D(planetWorld.worker_1, planetWorld.worker_2, PLANETS[0].rgb, PLANETS[1].rgb, t, talkInt, 0, 55);
    drawEnergyArc3D(planetWorld.worker_2, planetWorld.worker_3, PLANETS[1].rgb, PLANETS[2].rgb, t, talkInt, 0, 55);
    drawEnergyArc3D(planetWorld.worker_1, planetWorld.worker_3, PLANETS[0].rgb, PLANETS[2].rgb, t, talkInt * 0.9, 0, 75);

    // Depth-sort Boss + 3 Planets (+ Moons) back-to-front for true 3D occlusion
    const bodies = [
      { type: "boss", z: bossProj ? bossProj.depth : 9999, proj: bossProj, world: bossWorld },
      ...PLANETS.map((p) => ({
        type: "planet",
        planet: p,
        z: planetProj[p.id] ? planetProj[p.id].depth : 9999,
        proj: planetProj[p.id],
        world: planetWorld[p.id],
      })),
    ].sort((a, b) => b.z - a.z);

    for (const item of bodies) {
      if (item.type === "boss") {
        // Boss dual CAD gyroscope rings
        drawPlanetRing(bossWorld, BOSS.radius * 1.15, BOSS.cyanRgb, t * 0.4, 0.45);
        drawPlanetRing(bossWorld, BOSS.radius * 1.35, BOSS.rgb, -t * 0.3, -0.55);
        const bossPulse = st === "boss_plan" || st === "boss_merge" ? 0.65 + 0.35 * Math.sin(t * 4) : 0.2 + state.podSpikes.boss * 0.5;
        draw3DSphere(item.proj, bossWorld, BOSS.radius, BOSS.rgb, BOSS.cyanRgb, t * 0.28, 14, true, bossPulse);
      } else {
        const p = item.planet;
        const pulse = (st === "worker_draft" || st === "worker_crosstalk" ? 0.55 : 0.15) + (state.podSpikes[p.id] || 0) * 0.5;
        if (p.hasRing) {
          drawPlanetRing(item.world, p.radius, p.accentRgb || p.rgb, t * 0.6 + p.phase, 0.42);
        }
        draw3DSphere(item.proj, item.world, p.radius, p.rgb, p.accentRgb, t * 0.55 + p.phase, p.wireSegments, false, pulse);

        // Orbiting telemetry moon
        if (p.hasMoon) {
          const ma = t * 1.8 + p.phase;
          const mw = {
            x: item.world.x + Math.cos(ma) * (p.radius * 2.1),
            y: item.world.y + Math.sin(ma) * (p.radius * 0.7),
            z: item.world.z + Math.sin(ma) * (p.radius * 2.1),
          };
          const mp = project3D(mw.x, mw.y, mw.z);
          if (mp) {
            ctx.fillStyle = rgba(p.rgb, 0.92);
            ctx.beginPath();
            ctx.arc(mp.x, mp.y, Math.max(2.2, 4.5 * mp.scale), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    // CAD leader callouts + tether lines for all 3 moving planets
    for (const p of PLANETS) {
      const deg = Math.round(((planetAngles[p.id] % (Math.PI * 2)) * 180) / Math.PI);
      const au = (p.rx / 65).toFixed(1);
      drawPodTether(planetProj[p.id], p.podId, p.code, p.rgb, deg < 0 ? deg + 360 : deg, au);
    }

    // Gravitational shockwaves on stage transition / Boss Verdict merge
    for (let i = state.shockwaves.length - 1; i >= 0; i--) {
      const sw = state.shockwaves[i];
      sw.p += dt / sw.dur;
      if (sw.p >= 1) {
        state.shockwaves.splice(i, 1);
        continue;
      }
      const ease = 1 - Math.pow(1 - sw.p, 3);
      const rad = 50 + ease * 460;
      const fade = Math.pow(1 - sw.p, 1.5);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = rgba(sw.rgb, fade * 0.75);
      ctx.lineWidth = 2.4 * (1 - sw.p * 0.6);
      ctx.beginPath();
      let started = false;
      for (let k = 0; k <= 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const pt = project3D(Math.cos(a) * rad, 0, Math.sin(a) * rad);
        if (!pt) continue;
        if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  function tick(now) {
    if (state.destroyed) return;
    if (!document.hidden && state.enabled) {
      if (!state.lastTime) state.lastTime = now;
      const dt = clamp((now - state.lastTime) * 0.001, 0.001, 0.05);
      state.lastTime = now;
      render(dt);
    }
    state.rafId = requestAnimationFrame(tick);
  }

  // Interactive Mouse Drag Orbit & Wheel Zoom
  function onPointerDown(e) {
    if (e.target !== canvas && e.target !== document.getElementById("orrery-stage")) return;
    state.dragging = true;
    state.dragX = e.clientX;
    state.dragY = e.clientY;
  }
  function onPointerMove(e) {
    state.pointerX = e.clientX;
    state.pointerY = e.clientY;
    if (!state.dragging) return;
    const dx = e.clientX - state.dragX;
    const dy = e.clientY - state.dragY;
    state.dragX = e.clientX;
    state.dragY = e.clientY;
    state.targetYaw += dx * 0.0055;
    state.targetPitch = clamp(state.targetPitch + dy * 0.0045, -1.15, 1.35);
  }
  function onPointerUp() {
    state.dragging = false;
  }
  function onWheel(e) {
    if (e.target !== canvas && e.target !== document.getElementById("orrery-stage")) return;
    state.targetDist = clamp(state.targetDist + e.deltaY * 0.55, 420, 1280);
  }

  window.addEventListener("resize", resize);
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("wheel", onWheel, { passive: true });

  resize();
  state.rafId = requestAnimationFrame(tick);

  const controller = {
    setStage(stageName) {
      const next = stageName || "idle";
      if (next !== state.stage) {
        state.stage = next;
        const col = next === "boss_merge" ? BOSS.emeraldRgb : next === "worker_crosstalk" ? [155, 131, 255] : BOSS.cyanRgb;
        if (next !== "idle") state.shockwaves.push({ p: 0, dur: 1.4, rgb: col });
      }
    },
    spikeNode(roleId) {
      if (roleId in state.podSpikes) state.podSpikes[roleId] = 1.0;
    },
    triggerMergeShockwave() {
      state.shockwaves.push({ p: 0, dur: 1.9, rgb: BOSS.emeraldRgb });
      state.shockwaves.push({ p: 0, dur: 2.3, rgb: BOSS.rgb });
    },
    setCameraPreset(preset) {
      if (preset === "blueprint") {
        state.targetPitch = 1.32;
        state.targetDist = 860;
      } else if (preset === "side") {
        state.targetPitch = 0.08;
        state.targetDist = 740;
      } else {
        state.targetYaw = 0.28;
        state.targetPitch = 0.42;
        state.targetDist = 780;
      }
    },
    setVfxEnabled(flag) {
      state.enabled = !!flag;
      canvas.style.display = state.enabled ? "block" : "none";
    },
    destroy() {
      state.destroyed = true;
      cancelAnimationFrame(state.rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("wheel", onWheel);
    },
  };

  window.__orchestraOrrery = controller;
  return controller;
}
