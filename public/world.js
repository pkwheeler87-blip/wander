// Shared world generation for Wander — used by both the game page and the server,
// so everyone agrees where the trees, rocks and gems are.
(function (root) {
  function mkRand(seed) {
    let s = seed | 0;
    return function () {
      s |= 0; s = s + 0x6D2B79F5 | 0;
      let t = Math.imul(s ^ s >>> 15, 1 | s);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const POND = { x: 20, z: -16, r: 11 }, WATER = -0.7, BOUND = 86, GEMS = 12;
  const smooth = t => t * t * (3 - 2 * t);

  function baseHeight(x, z) {
    let h = Math.sin(x * 0.05) * Math.cos(z * 0.04) * 3 + Math.sin(x * 0.13 + 1.3) * Math.sin(z * 0.11) * 1.2 + Math.sin((x + z) * 0.02) * 2;
    const d = Math.hypot(x, z);
    h *= Math.min(1, Math.max(0, (d - 6) / 18));
    const pd = Math.hypot(x - POND.x, z - POND.z);
    if (pd < POND.r * 1.7) { const s = smooth(1 - pd / (POND.r * 1.7)); h = h * (1 - s) + (-2.2) * s; }
    const e = Math.max(0, d - 68); h += e * e * 0.012;
    return h;
  }

  function freeSpot(rand, colliders, minD, maxD, pad) {
    for (let k = 0; k < 200; k++) {
      const a = rand() * Math.PI * 2, d = minD + rand() * (maxD - minD), x = Math.cos(a) * d, z = Math.sin(a) * d;
      if (Math.hypot(x - POND.x, z - POND.z) < POND.r * 1.45 + pad) continue;
      if (colliders.some(o => Math.hypot(o.x - x, o.z - z) < o.r + pad)) continue;
      return { x, z };
    }
    return null;
  }

  // Fixed scenery: cabin, standing stones, trees, rocks.
  function generate() {
    const rand = mkRand(1337), rr = (a, b) => a + rand() * (b - a);
    const colliders = [], props = [];
    const add = (p, r) => { if (r) { p.ci = colliders.length; colliders.push({ x: p.x, z: p.z, r }); } props.push(p); };
    add({ type: 'cabin', x: -24, z: 18 }, 3.2);
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * Math.PI * 2, x = -6 + Math.cos(a) * 6, z = -34 + Math.sin(a) * 6;
      add({ type: 'stone', x, z, h: rr(2.4, 3.4), rx: rr(-.06, .06), ry: -a, rz: rr(-.06, .06) }, .7);
    }
    for (let i = 0; i < 140; i++) {
      const p = freeSpot(rand, colliders, 9, BOUND + 6, 1.6); if (!p) continue;
      const s = rr(.8, 1.5), pine = rand() < .5, leaf = pine ? 0 : (rand() * 4) | 0, rot = rand() * 6.28;
      add({ type: 'tree', x: p.x, z: p.z, s, pine, leaf, rot }, .45 * s);
    }
    for (let i = 0; i < 45; i++) {
      const p = freeSpot(rand, colliders, 8, BOUND, 1.2); if (!p) continue;
      const s = rr(.4, 1.4);
      add({ type: 'rock', x: p.x, z: p.z, s, sx: s * rr(.8, 1.4), sy: s * rr(.5, .9), sz: s * rr(.8, 1.3), rx: rand() * 3, ry: rand() * 3, rz: rand() * 3 }, s > .7 ? s : 0);
    }
    return { colliders, props };
  }

  // Gem positions for a given round.
  function gemSpots(seed, colliders) {
    const rand = mkRand(seed), spots = [];
    for (let i = 0; i < GEMS; i++) {
      let p = null;
      for (let k = 0; k < 50 && !p; k++) { p = freeSpot(rand, colliders, 10, BOUND - 4, 1); if (p && spots.some(g => Math.hypot(g.x - p.x, g.z - p.z) < 12)) p = null; }
      if (!p) p = freeSpot(rand, colliders, 10, BOUND - 4, 1) || { x: 10 + i, z: 10 };
      spots.push({ x: p.x, z: p.z, phase: rand() * 6 });
    }
    return spots;
  }

  const api = { mkRand, baseHeight, generate, gemSpots, freeSpot, POND, WATER, BOUND, GEMS,
    MATERIALS: ['brick', 'wood', 'stone', 'glass', 'leaves'] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WorldGen = api;
})(typeof self !== 'undefined' ? self : this);
