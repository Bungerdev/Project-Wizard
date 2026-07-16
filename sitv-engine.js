// Name: SITV Engine — Co-op Bullet-Hell Boss Rush Roguelike
// ID: sitvengine
// Description: Self-contained deterministic bullet-hell engine. Uses PacketPigeon as transport.
// License: MPL-2.0
//
// DESIGN
//  - All game logic + rendering live here (canvas overlay on the Scratch stage),
//    so there is NO 300-clone ceiling and thousands of bullets are cheap.
//  - Networking is DETERMINISTIC. When an enemy/boss fires, the host emits one
//    tiny event: { type, x, y, dir, seed, pattern }. Every client re-simulates
//    that pattern locally with a seeded PRNG, so all clients see identical
//    bullets from identical inputs. No per-bullet streaming, no lossy decimal
//    packing. Enemy/boss *positions* are host-authoritative and sent as a
//    compact snapshot; each client resolves damage to its OWN player locally.
//  - Requires the PacketPigeon extension to be loaded (it is the transport).

(function (Scratch) {
  "use strict";
  if (!Scratch.extensions.unsandboxed) {
    throw new Error("SITV Engine must run unsandboxed.");
  }
  const vm = Scratch.vm;
  const runtime = vm.runtime;

  // ── World constants (Scratch stage coordinate space) ──────────────────────
  const W = 480, H = 360, HALFW = W / 2, HALFH = H / 2;
  const TICK = 1 / 60;                 // fixed sim step (seconds)
  const RAD = Math.PI / 180;

  // ══════════════════════════════════════════════════════════════════════════
  // DETERMINISTIC RNG  (mulberry32 — same seed => same stream on every client)
  // ══════════════════════════════════════════════════════════════════════════
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rrange = (rng, lo, hi) => lo + rng() * (hi - lo);
  const hashSeed = (a, b) => (Math.imul(a | 0, 2654435761) ^ Math.imul(b | 0, 40503) ^ 0x9e3779b9) >>> 0;

  // ── math helpers ──────────────────────────────────────────────────────────
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
  // Scratch-style direction: 0 = up, 90 = right (clockwise)
  const dirVX = (deg) => Math.sin(deg * RAD);
  const dirVY = (deg) => Math.cos(deg * RAD);
  const angTo = (fromx, fromy, tox, toy) => {
    const dx = tox - fromx, dy = toy - fromy;
    return Math.atan2(dx, dy) / RAD; // returns 0=up,90=right
  };

  // ══════════════════════════════════════════════════════════════════════════
  // BULLET PATTERNS  — pure & deterministic: (cx,cy,dir,rng,tier,dmg) -> bullets
  // Speeds are in stage-units/second. Every enemy/boss "fire" is exactly one of
  // these, keyed by id, so the network only carries the pattern id + seed.
  // ══════════════════════════════════════════════════════════════════════════
  function mkBullet(x, y, deg, spd, r, hue, dmg, life) {
    return { x, y, vx: dirVX(deg) * spd, vy: dirVY(deg) * spd, r, hue, dmg, life: life || 5, spin: 0 };
  }
  const PATTERNS = {
    // 0: single aimed shot
    aimed(cx, cy, dir, rng, tier, dmg) {
      return [mkBullet(cx, cy, dir, 150 + tier * 40, 5, 5, dmg)];
    },
    // 1: full radial ring
    ring(cx, cy, dir, rng, tier, dmg) {
      const n = 12 + tier * 6, out = [];
      for (let i = 0; i < n; i++) out.push(mkBullet(cx, cy, dir + (360 / n) * i, 130 + tier * 30, 5, 195, dmg));
      return out;
    },
    // 2: tight aimed spread (shotgun)
    spread(cx, cy, dir, rng, tier, dmg) {
      const n = 5 + tier, out = [], arc = 34;
      for (let i = 0; i < n; i++) out.push(mkBullet(cx, cy, dir - arc / 2 + (arc / (n - 1)) * i, 210, 4, 30, dmg));
      return out;
    },
    // 3: rotating spiral arm (dir already advanced by caller each fire)
    spiral(cx, cy, dir, rng, tier, dmg) {
      const arms = 3, out = [];
      for (let i = 0; i < arms; i++) out.push(mkBullet(cx, cy, dir + (360 / arms) * i, 160, 5, 300, dmg));
      return out;
    },
    // 4: cross wall — 4 dirs, each a short stream offset outward
    cross(cx, cy, dir, rng, tier, dmg) {
      const out = [];
      for (let a = 0; a < 4; a++) {
        const deg = dir + a * 90;
        for (let j = 0; j < 3 + tier; j++)
          out.push(mkBullet(cx + dirVX(deg) * j * 14, cy + dirVY(deg) * j * 14, deg, 150, 5, 55, dmg));
      }
      return out;
    },
    // 5: scatter burst — uses rng but still deterministic (seed is shared!)
    scatter(cx, cy, dir, rng, tier, dmg) {
      const n = 7 + tier * 2, out = [];
      for (let i = 0; i < n; i++)
        out.push(mkBullet(cx, cy, dir + rrange(rng, -22, 22), rrange(rng, 120, 210), 4, 90, dmg));
      return out;
    },
    // 6: dense wide ring (boss)
    bigring(cx, cy, dir, rng, tier, dmg) {
      const n = 26 + tier * 8, out = [];
      for (let i = 0; i < n; i++) out.push(mkBullet(cx, cy, dir + (360 / n) * i, 115, 6, 260, dmg));
      return out;
    },
    // 7: twin counter-rotating spirals (boss)
    twin(cx, cy, dir, rng, tier, dmg) {
      return [
        mkBullet(cx, cy, dir, 150, 6, 330, dmg),
        mkBullet(cx, cy, -dir, 150, 6, 20, dmg),
        mkBullet(cx, cy, dir + 180, 150, 6, 330, dmg),
        mkBullet(cx, cy, -dir + 180, 150, 6, 20, dmg),
      ];
    },
    // 8: aimed 3-lane wall that expands (boss)
    wall(cx, cy, dir, rng, tier, dmg) {
      const out = [];
      for (let i = -6; i <= 6; i++) {
        const perp = dir + 90;
        out.push(mkBullet(cx + dirVX(perp) * i * 16, cy + dirVY(perp) * i * 16, dir, 130, 6, 0, dmg));
      }
      return out;
    },
  };
  const PATTERN_IDS = Object.keys(PATTERNS);
  const patIndex = (name) => PATTERN_IDS.indexOf(name);

  function runPattern(patId, cx, cy, dir, seed, tier, dmg) {
    const name = PATTERN_IDS[patId] || "aimed";
    return PATTERNS[name](cx, cy, dir, makeRng(seed), tier | 0, dmg || 6);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ENEMY TYPES  — distinct AI + fire behaviour (host runs these)
  //   update(e, dt, ctx) mutates position; may call ctx.fire(patName, dir, tier)
  // ══════════════════════════════════════════════════════════════════════════
  const ENEMIES = {
    // 0 DRIFTER: wanders, bounces walls, occasional radial burst
    drifter: {
      hp: 30, r: 12, color: 130, score: 10,
      init(e, rng) { e.dir = rrange(rng, 0, 360); e.cd = rrange(rng, 1.2, 2.4); },
      update(e, dt, ctx) {
        e.dir += Math.sin(ctx.time * 0.7 + e.id) * 40 * dt;
        e.x += dirVX(e.dir) * 55 * dt; e.y += dirVY(e.dir) * 55 * dt;
        if (e.x < -HALFW + 16 || e.x > HALFW - 16) { e.dir = -e.dir; e.x = clamp(e.x, -HALFW + 16, HALFW - 16); }
        if (e.y < -HALFH + 16 || e.y > HALFH - 16) { e.dir = 180 - e.dir; e.y = clamp(e.y, -HALFH + 16, HALFH - 16); }
        e.cd -= dt;
        if (e.cd <= 0) { e.cd = 1.8; ctx.fire("ring", 0, ctx.tier); }
      },
    },
    // 1 HUNTER: chases nearest player, fires aimed spreads
    hunter: {
      hp: 40, r: 12, color: 0, score: 15,
      init(e, rng) { e.cd = rrange(rng, 1.0, 2.0); },
      update(e, dt, ctx) {
        const p = ctx.nearestPlayer(e.x, e.y);
        if (p) {
          const a = angTo(e.x, e.y, p.x, p.y);
          const far = dist2(e.x, e.y, p.x, p.y) > 120 * 120;
          const spd = far ? 70 : -30;
          e.x += dirVX(a) * spd * dt; e.y += dirVY(a) * spd * dt;
          e.dir = a;
          e.cd -= dt;
          if (e.cd <= 0) { e.cd = 1.4; ctx.fire("spread", a, ctx.tier); }
        }
      },
    },
    // 2 WEAVER: sine-wave horizontal drift, continuous spiral
    weaver: {
      hp: 34, r: 12, color: 300, score: 15,
      init(e, rng) { e.phase = rrange(rng, 0, 6.28); e.spin = rrange(rng, 0, 360); e.cd = 0.35; e.baseY = e.y; e.vx = rng() < 0.5 ? -60 : 60; },
      update(e, dt, ctx) {
        e.x += e.vx * dt;
        if (e.x < -HALFW + 20 || e.x > HALFW - 20) e.vx = -e.vx;
        e.y = e.baseY + Math.sin(ctx.time * 2 + e.phase) * 40;
        e.spin += 26; e.dir = e.spin;
        e.cd -= dt;
        if (e.cd <= 0) { e.cd = 0.28; ctx.fire("spiral", e.spin % 360, ctx.tier); }
      },
    },
    // 3 TURRET: slow, tanky, periodic dense rings + scatter
    turret: {
      hp: 70, r: 15, color: 40, score: 25,
      init(e, rng) { e.cd = rrange(rng, 0.8, 1.6); e.t = 0; e.tgtY = e.y; },
      update(e, dt, ctx) {
        e.y += (e.tgtY - e.y) * dt * 1.5;
        e.dir += 20 * dt;
        e.cd -= dt; e.t += dt;
        if (e.cd <= 0) {
          e.cd = 1.5;
          if (Math.floor(e.t / 3) % 2 === 0) ctx.fire("bigring", e.dir % 360, ctx.tier);
          else ctx.fire("scatter", 180, ctx.tier);
        }
      },
    },
  };
  const ENEMY_IDS = Object.keys(ENEMIES);

  // ══════════════════════════════════════════════════════════════════════════
  // BOSSES  — multi-phase, unique attacks. Host runs update(b, dt, ctx).
  // ══════════════════════════════════════════════════════════════════════════
  const BOSSES = {
    // WARDEN — disciplined gunline. Phases by HP.
    warden: {
      name: "THE WARDEN", hp: 900, r: 26, color: 210,
      init(b) { b.spin = 0; b.cd = 1; b.x = 0; b.y = 110; b.vx = 70; },
      update(b, dt, ctx) {
        b.x += b.vx * dt; if (b.x < -150 || b.x > 150) b.vx = -b.vx;
        const ph = b.hp / b.max;
        b.spin += (ph < 0.5 ? 9 : 6);
        b.cd -= dt;
        if (b.cd <= 0) {
          if (ph > 0.66) { b.cd = 1.1; const p = ctx.nearestPlayer(b.x, b.y); ctx.fire("spread", p ? angTo(b.x, b.y, p.x, p.y) : 180, ctx.tier + 1); }
          else if (ph > 0.33) { b.cd = 0.5; ctx.fire("spiral", b.spin % 360, ctx.tier + 1); }
          else { b.cd = 0.85; ctx.fire("bigring", b.spin % 360, ctx.tier + 2); if (Math.random() < 0) {} }
        }
      },
    },
    // HIVE — spawns minions, radial pressure. Phase adds twin spirals.
    hive: {
      name: "THE HIVE", hp: 1100, r: 30, color: 110,
      init(b) { b.cd = 0.6; b.spawnCd = 3; b.spin = 0; b.x = 0; b.y = 100; b.t = 0; },
      update(b, dt, ctx) {
        b.t += dt;
        b.x = Math.sin(b.t * 0.8) * 140; b.y = 100 + Math.cos(b.t * 1.3) * 30;
        b.spin += 7;
        const ph = b.hp / b.max;
        b.cd -= dt;
        if (b.cd <= 0) { b.cd = ph < 0.5 ? 0.4 : 0.7; ctx.fire(ph < 0.5 ? "twin" : "bigring", b.spin % 360, ctx.tier + 1); }
        b.spawnCd -= dt;
        if (b.spawnCd <= 0 && ctx.enemyCount() < 8) { b.spawnCd = ph < 0.5 ? 2.2 : 3.5; ctx.spawnMinion("hunter", b.x, b.y); }
      },
    },
    // NOVA — expanding ring walls + aimed walls, enrages at low HP.
    nova: {
      name: "NOVA PRIME", hp: 1400, r: 30, color: 20,
      init(b) { b.cd = 1.2; b.spin = 0; b.x = 0; b.y = 105; b.t = 0; b.mode = 0; },
      update(b, dt, ctx) {
        b.t += dt; b.x = Math.sin(b.t * 0.6) * 120;
        const ph = b.hp / b.max;
        b.spin += ph < 0.35 ? 13 : 8;
        b.cd -= dt;
        if (b.cd <= 0) {
          b.mode = (b.mode + 1) % 3;
          if (b.mode === 0) { b.cd = 0.9; const p = ctx.nearestPlayer(b.x, b.y); ctx.fire("wall", p ? angTo(b.x, b.y, p.x, p.y) : 180, ctx.tier + 2); }
          else if (b.mode === 1) { b.cd = 0.5; ctx.fire("twin", b.spin % 360, ctx.tier + 2); }
          else { b.cd = ph < 0.35 ? 0.55 : 0.9; ctx.fire("bigring", b.spin % 360, ctx.tier + (ph < 0.35 ? 3 : 2)); }
        }
      },
    },
  };
  const BOSS_ORDER = ["warden", "hive", "nova"];

  // ══════════════════════════════════════════════════════════════════════════
  // ROGUELIKE UPGRADES  — applied to the LOCAL player's stats
  // ══════════════════════════════════════════════════════════════════════════
  const UPGRADES = [
    { id: "rapid", name: "Overclock", desc: "+25% fire rate", apply: (s) => { s.fireCd *= 0.8; } },
    { id: "power", name: "Hollowpoint", desc: "+30% damage", apply: (s) => { s.dmg *= 1.3; } },
    { id: "speed", name: "Thrusters", desc: "+18% move speed", apply: (s) => { s.speed *= 1.18; } },
    { id: "hp", name: "Plating", desc: "+2 max hull, heal 2", apply: (s) => { s.maxhp += 2; s.hp += 2; } },
    { id: "multi", name: "Split Barrel", desc: "+1 projectile", apply: (s) => { s.shots += 1; } },
    { id: "pierce", name: "Railgun", desc: "shots pierce +1", apply: (s) => { s.pierce += 1; } },
    { id: "big", name: "Heavy Rounds", desc: "+40% shot size & dmg, -10% rate", apply: (s) => { s.bulletR *= 1.4; s.dmg *= 1.4; s.fireCd *= 1.1; } },
    { id: "regen", name: "Nanoweave", desc: "slowly regen hull", apply: (s) => { s.regen += 0.25; } },
    { id: "homing", name: "Seeker Chips", desc: "shots curve to enemies", apply: (s) => { s.homing += 0.6; } },
    { id: "dash", name: "Phase Drive", desc: "-35% dash cooldown", apply: (s) => { s.dashCd *= 0.65; } },
  ];

  function baseStats() {
    return { hp: 10, maxhp: 10, dmg: 6, fireCd: 0.16, speed: 180, shots: 1, pierce: 0,
      bulletR: 4, regen: 0, homing: 0, dashCd: 1.2 };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // NET  — thin adapter over PacketPigeon (the transport). All game packets go
  // through broadcastEvent / net events, plus a couple of compact host fields.
  // ══════════════════════════════════════════════════════════════════════════
  const Net = {
    pp: null, _q: null,
    ready() { return !!(this.pp && this.pp.engine); },
    tryBind() {
      if (!this.pp && Scratch.packetpigeon) {
        this.pp = Scratch.packetpigeon;
        // Own our own event queue: mirror every incoming net event as it is
        // pushed, so PacketPigeon's 1-event-per-tick hat dispatch (which shifts
        // from engine.inEvents) can never steal a bullet-spawn event from us.
        this._q = [];
        const q = this._q, arr = this.pp.engine.inEvents;
        if (arr && !arr.__sitvHooked) {
          const orig = arr.push.bind(arr);
          arr.push = function (ev) { q.push(ev); return orig(ev); };
          arr.__sitvHooked = true;
        }
      }
      return this.ready();
    },
    e() { return this.pp.engine; },
    connected() { return this.ready() && this.e().connected; },
    connect(room) { return this.ready() ? this.e().connect(room) : Promise.resolve(false); },
    disconnect() { if (this.ready()) this.e().disconnect(); },
    isHost() { return this.connected() && this.e().mySlot === this.e().hostSlot(); },
    mySlot() { return this.ready() ? this.e().mySlot : 0; },
    maxPlayers() { return this.ready() ? this.e().maxPlayers : 1; },
    hostSlot() { return this.ready() ? this.e().hostSlot() : 0; },
    slotActive(s) { return this.ready() && this.e().isActive(s); },
    slotMine(s) { return this.ready() && s === this.e().mySlot; },
    slotName(s) { if (!this.ready()) return ""; const sl = this.e().slots[s]; return sl ? sl.username : ""; },
    setField(k, v) { if (this.ready()) this.e().setMyField(k, v); },
    getField(slot, k) { return this.ready() ? this.e().getPlayerField(slot, k) : ""; },
    smooth(slot, k) { return this.ready() ? this.e().smoothField(slot, k) : 0; },
    smoothAng(slot, k) { return this.ready() ? this.e().smoothAngle(slot, k) : 0; },
    broadcast(name, value) { if (this.ready()) this.e().sendEvent(name, 0, value); },
    // drain ALL queued net events this frame (from our own mirror queue)
    drain(handler) {
      const q = this._q;
      if (!q || !q.length) return;
      while (q.length) { const ev = q.shift(); handler(ev.from, ev.name, ev.value); }
    },
  };

  // Compact codecs (replaces the old lossy `PAT*1e9+CX*1e6+...` packing).
  const F1 = ";", F2 = ",";
  const encSpawn = (a) => a.join(F2);                 // [pat,x,y,dir,seed,tier,dmg]
  const decSpawn = (s) => String(s).split(F2);
  function encEnemies(list) {
    // id,type,x,y  (positions rounded to ints — plenty for rendering/collision)
    let out = "";
    for (const e of list) out += (out ? F1 : "") + e.id + F2 + e.t + F2 + Math.round(e.x) + F2 + Math.round(e.y);
    return out;
  }
  function decEnemies(str) {
    const out = [];
    if (!str) return out;
    for (const chunk of String(str).split(F1)) {
      const p = chunk.split(F2); if (p.length < 4) continue;
      out.push({ id: +p[0], t: +p[1], x: +p[2], y: +p[3] });
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GAME WORLD
  // ══════════════════════════════════════════════════════════════════════════
  const STATE = { MENU: 0, LOBBY: 1, PLAY: 2, UPGRADE: 3, DEAD: 4, WIN: 5 };

  class Game {
    constructor(opts) {
      opts = opts || {};
      this.headless = !!opts.headless;
      this.state = STATE.MENU;
      this.room = "sitv";
      this.time = 0;
      this.frame = 0;
      this.reset();
      this.input = { up: 0, down: 0, left: 0, right: 0, dash: 0, mx: 0, my: 0, fire: 1 };
      this._eventSeq = 0;
    }

    reset() {
      this.enemyBullets = [];   // simulated on ALL clients
      this.playerShots = [];    // local player's shots only
      this.enemies = [];        // host-authoritative; clients hold render mirror
      this.enemyMirror = [];    // decoded snapshot for non-hosts
      this.boss = null;
      this.bossMirror = null;
      this.particles = [];
      this.floaters = [];
      this.wave = 0;
      this.bossIndex = 0;
      this.stats = baseStats();
      this.player = { x: 0, y: -110, dir: 0, alive: true, iframe: 0, dashTimer: 0, dashing: 0, fireTimer: 0, respawn: 0 };
      this.score = 0;
      this._enemyIdCounter = 1;
      this._pendingUpgrades = null;
      this._upgReady = {};
      this._spawnedWaveEnemies = false;
      this._bossAnnounced = false;
      this._deathReported = {};
      this._fireBatch = [];
    }

    // ── lifecycle ────────────────────────────────────────────────────────────
    async startCoop(room) {
      this.room = room || "sitv";
      this.state = STATE.LOBBY;
      await Net.connect(this.room);
      // fast, frequent sends: spawn events are batched 1/frame, so a high send
      // rate keeps them flowing without overrunning the event ring.
      try { if (Net.ready()) Net.e().sendRate = 30; } catch (e) {}
      // host initializes the run
      this.wave = 1; this.bossIndex = 0;
      this.state = STATE.PLAY;
      this._spawnedWaveEnemies = false;
    }

    quitToMenu() { Net.disconnect(); this.reset(); this.state = STATE.MENU; }

    // ── per-frame update (fixed dt) ──────────────────────────────────────────
    step(dt) {
      this.time += dt; this.frame++;
      // publish local player + read net regardless of state
      this._pubPlayer();
      Net.drain((from, name, value) => this._onNet(from, name, value));

      if (this.state === STATE.PLAY) this._stepPlay(dt);
      else if (this.state === STATE.UPGRADE) this._stepUpgrade(dt);
      else if (this.state === STATE.DEAD) { /* wait for revive / all-dead */ this._stepPlay(dt); }

      this._stepBullets(dt);
      this._stepParticles(dt);
    }

    _pubPlayer() {
      const p = this.player;
      Net.setField("x", Math.round(p.x));
      Net.setField("y", Math.round(p.y));
      Net.setField("direction", Math.round(p.dir));
      Net.setField("hp", Math.max(0, Math.round(this.stats.hp)));
      Net.setField("st", this.state);
    }

    // list of all players (local + active remote) in world coords
    players() {
      const out = [];
      const me = this.mySlot();
      out.push({ slot: me, x: this.player.x, y: this.player.y, local: true, alive: this.player.alive });
      const max = Net.maxPlayers();
      for (let s = 1; s <= max; s++) {
        if (s === me) continue;
        if (!Net.slotActive(s)) continue;
        out.push({ slot: s, x: +Net.smooth(s, "x") || 0, y: +Net.smooth(s, "y") || 0, local: false,
          alive: (+Net.getField(s, "hp") || 0) > 0 });
      }
      return out;
    }
    mySlot() { return Net.mySlot() || 1; }

    nearestPlayer(x, y) {
      let best = null, bd = Infinity;
      for (const p of this.players()) { if (!p.alive) continue; const d = dist2(x, y, p.x, p.y); if (d < bd) { bd = d; best = p; } }
      return best;
    }

    // ── PLAY state ───────────────────────────────────────────────────────────
    _stepPlay(dt) {
      const host = Net.isHost() || this.headlessHost;
      this._updatePlayer(dt);

      if (host) {
        this._fireBatch = this._fireBatch || [];
        if (!this._spawnedWaveEnemies) this._spawnWave();
        this._hostUpdateEnemies(dt);
        this._hostUpdateBoss(dt);
        this._flushFires();
        this._publishHostState();
        this._checkWaveProgress();
      } else {
        this.enemyMirror = decEnemies(Net.getField(Net.hostSlot(), "E"));
        this._readBossMirror();
      }
      this._updatePlayerShots(dt, host);
    }

    _spawnWave() {
      this.enemies = [];
      const count = 4 + this.wave * 2;
      const rng = makeRng(hashSeed(this.wave, 777));
      for (let i = 0; i < count; i++) {
        const typeName = ENEMY_IDS[Math.floor(rng() * (ENEMY_IDS.length - (this.wave < 2 ? 1 : 0)))];
        this._spawnEnemy(typeName, rrange(rng, -HALFW + 40, HALFW - 40), rrange(rng, 30, HALFH - 30), rng);
      }
      this._spawnedWaveEnemies = true;
      this._bossAnnounced = false;
    }

    _spawnEnemy(typeName, x, y, rng) {
      const def = ENEMIES[typeName]; if (!def) return;
      const e = { id: this._enemyIdCounter++, t: ENEMY_IDS.indexOf(typeName), x, y, dir: 0,
        hp: def.hp + this.wave * 4, max: def.hp + this.wave * 4, r: def.r, alive: true };
      def.init(e, rng || makeRng(hashSeed(e.id, this.wave)));
      this.enemies.push(e);
      return e;
    }
    spawnMinion(typeName, x, y) { this._spawnEnemy(typeName, x, y, makeRng(hashSeed(this._enemyIdCounter, this.frame))); }
    enemyCount() { return this.enemies.filter((e) => e.alive).length; }

    _fireCtx(tierBonus) {
      const self = this;
      return {
        time: this.time, tier: Math.min(3, Math.floor(this.wave / 2)) + (tierBonus || 0),
        nearestPlayer: (x, y) => self.nearestPlayer(x, y),
        enemyCount: () => self.enemyCount(),
        spawnMinion: (t, x, y) => self.spawnMinion(t, x, y),
        fire: null, // set per-entity
      };
    }

    _hostUpdateEnemies(dt) {
      for (const e of this.enemies) {
        if (!e.alive) continue;
        const def = ENEMIES[ENEMY_IDS[e.t]];
        const ctx = this._fireCtx(0);
        ctx.fire = (patName, dir, tier) => this._netFire(e.x, e.y, patName, dir, tier);
        def.update(e, dt, ctx);
        e.x = clamp(e.x, -HALFW + 8, HALFW - 8); e.y = clamp(e.y, -HALFH + 8, HALFH - 8);
      }
      this.enemies = this.enemies.filter((e) => e.alive);
    }

    _hostUpdateBoss(dt) {
      if (!this.boss) return;
      const def = BOSSES[this.boss.type];
      const ctx = this._fireCtx(0);
      ctx.fire = (patName, dir, tier) => this._netFire(this.boss.x, this.boss.y, patName, dir, tier);
      def.update(this.boss, dt, ctx);
    }

    // Host spawns locally immediately (so it matches clients) and queues the
    // tiny payload; all of a frame's fires are flushed as ONE batched event so
    // PacketPigeon's 4-slot event ring can never drop a spawn.
    _netFire(x, y, patName, dir, tier) {
      const pat = patIndex(patName);
      const seed = hashSeed(hashSeed(this.frame, Math.round(x * 7 + y * 13)), ++this._eventSeq);
      const dmg = 1;
      const payload = encSpawn([pat, Math.round(x), Math.round(y), Math.round(dir), seed, tier | 0, dmg]);
      this._fireBatch.push(payload);
      this._spawnFromPayload(payload);
    }
    _flushFires() {
      if (this._fireBatch.length) { Net.broadcast("f", this._fireBatch.join("|")); this._fireBatch.length = 0; }
    }

    _spawnFromPayload(batch) {
      for (const payload of String(batch).split("|")) {
        if (!payload) continue;
        const p = decSpawn(payload);
        const bs = runPattern(+p[0], +p[1], +p[2], +p[3], +p[4], +p[5], +p[6]);
        for (const b of bs) this.enemyBullets.push(b);
      }
    }

    _publishHostState() {
      Net.setField("E", encEnemies(this.enemies));
      if (this.boss) Net.setField("B", [BOSS_ORDER.indexOf(this.boss.type), Math.round(this.boss.x), Math.round(this.boss.y), Math.round(this.boss.hp), Math.round(this.boss.max)].join(F2));
      else Net.setField("B", "");
      Net.setField("wv", this.wave);
    }

    _readBossMirror() {
      const raw = Net.getField(Net.hostSlot(), "B");
      if (!raw) { this.bossMirror = null; return; }
      const p = String(raw).split(F2);
      this.bossMirror = { type: BOSS_ORDER[+p[0]], x: +p[1], y: +p[2], hp: +p[3], max: +p[4] };
    }

    _checkWaveProgress() {
      // when wave enemies are cleared -> spawn boss; when boss dead -> upgrades
      if (this.boss) {
        if (this.boss.hp <= 0) {
          this._boom(this.boss.x, this.boss.y, 3);
          Net.broadcast("bd", "1"); // boss dead
          this.boss = null;
          this._beginUpgrades();
        }
      } else if (this._spawnedWaveEnemies && this.enemyCount() === 0) {
        // spawn boss
        const type = BOSS_ORDER[this.bossIndex % BOSS_ORDER.length];
        const def = BOSSES[type];
        this.boss = { type, hp: def.hp * (1 + 0.2 * Math.floor(this.bossIndex / BOSS_ORDER.length)), max: 0, r: def.r, x: 0, y: 100 };
        this.boss.max = this.boss.hp;
        def.init(this.boss);
        Net.broadcast("bs", String(this.bossIndex));
      }
    }

    // ── upgrades (roguelike) ──────────────────────────────────────────────────
    _beginUpgrades() {
      const seed = hashSeed(this.bossIndex + 1, 424242);
      Net.broadcast("up", String(seed));
      this._openUpgrades(seed);
    }
    _openUpgrades(seed) {
      const rng = makeRng(seed);
      const pool = UPGRADES.slice();
      const choices = [];
      for (let i = 0; i < 3 && pool.length; i++) choices.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
      this._pendingUpgrades = choices;
      this._upgReady = {};
      this.state = STATE.UPGRADE;
    }
    pickUpgrade(index) {
      if (this.state !== STATE.UPGRADE || !this._pendingUpgrades) return;
      const u = this._pendingUpgrades[index]; if (!u) return;
      u.apply(this.stats);
      this.stats.hp = Math.min(this.stats.maxhp, this.stats.hp + 1);
      Net.setField("rdy", "1");
      this._pendingUpgrades = null; // locally chosen
      this.player.pickedThisRound = u.id;
    }
    _stepUpgrade(dt) {
      // host waits until all active players are ready, then advances
      if (Net.isHost() || this.headlessHost) {
        let allReady = (+Net.getField(this.mySlot(), "rdy") || 0) === 1 || !this._pendingUpgrades;
        const max = Net.maxPlayers();
        for (let s = 1; s <= max; s++) { if (s === this.mySlot()) continue; if (!Net.slotActive(s)) continue; if ((+Net.getField(s, "rdy") || 0) !== 1) allReady = false; }
        if (allReady) {
          Net.broadcast("nw", "1");
          this._advanceWave();
        }
      }
    }
    _advanceWave() {
      this.wave++; this.bossIndex++;
      this._spawnedWaveEnemies = false;
      this.enemyBullets = [];
      this.state = STATE.PLAY;
      Net.setField("rdy", "0");
      this.player.hp = this.stats.hp;
      if (this.bossIndex >= BOSS_ORDER.length * 2) { this.state = STATE.WIN; }
    }

    // ── player ────────────────────────────────────────────────────────────────
    _updatePlayer(dt) {
      const p = this.player, s = this.stats;
      if (!p.alive) {
        p.respawn -= dt;
        if (p.respawn <= 0) { p.alive = true; s.hp = Math.max(3, s.maxhp * 0.5); p.iframe = 2; p.x = 0; p.y = -110; }
        return;
      }
      const inx = this.input.right - this.input.left, iny = this.input.up - this.input.down;
      let sp = s.speed;
      p.dashTimer -= dt;
      if (this.input.dash && p.dashTimer <= 0) { p.dashing = 0.16; p.dashTimer = s.dashCd; p.iframe = Math.max(p.iframe, 0.22); }
      if (p.dashing > 0) { p.dashing -= dt; sp *= 3.2; }
      const mag = Math.hypot(inx, iny) || 1;
      p.x = clamp(p.x + (inx / mag) * sp * dt, -HALFW + 8, HALFW - 8);
      p.y = clamp(p.y + (iny / mag) * sp * dt, -HALFH + 8, HALFH - 8);
      if (s.regen) { s.hp = Math.min(s.maxhp, s.hp + s.regen * dt); }
      if (p.iframe > 0) p.iframe -= dt;

      // aim: toward mouse if provided else nearest enemy else up
      let aim = 0;
      if (this.input.mx || this.input.my) aim = angTo(p.x, p.y, this.input.mx, this.input.my);
      else { const t = this._nearestEnemyPos(p.x, p.y); aim = t ? angTo(p.x, p.y, t.x, t.y) : 0; }
      p.dir = aim;

      // auto-fire
      p.fireTimer -= dt;
      if (this.input.fire && p.fireTimer <= 0) {
        p.fireTimer = s.fireCd;
        const n = s.shots, arc = (n - 1) * 8;
        for (let i = 0; i < n; i++) {
          const d = aim - arc / 2 + (n > 1 ? (arc / (n - 1)) * i : 0);
          this.playerShots.push({ x: p.x, y: p.y, vx: dirVX(d) * 420, vy: dirVY(d) * 420, r: s.bulletR, dmg: s.dmg, pierce: s.pierce, life: 1.2, hit: {} });
        }
      }
    }

    _nearestEnemyPos(x, y) {
      const list = this._enemyList();
      let best = null, bd = Infinity;
      for (const e of list) { const d = dist2(x, y, e.x, e.y); if (d < bd) { bd = d; best = e; } }
      if (this.boss || this.bossMirror) { const b = this.boss || this.bossMirror; const d = dist2(x, y, b.x, b.y); if (d < bd * 1.5) best = b; }
      return best;
    }
    _enemyList() { return (Net.isHost() || this.headlessHost) ? this.enemies.filter((e) => e.alive) : this.enemyMirror; }

    _updatePlayerShots(dt, host) {
      const list = this._enemyList();
      const boss = this.boss || this.bossMirror;
      for (const s of this.playerShots) {
        s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt;
        // homing
        if (this.stats.homing) {
          const t = this._nearestEnemyPos(s.x, s.y);
          if (t) { const a = angTo(s.x, s.y, t.x, t.y); const cur = Math.atan2(s.vx, s.vy) / RAD; let da = ((a - cur + 540) % 360) - 180; const na = cur + clamp(da, -1, 1) * this.stats.homing * 60 * dt; const sp = Math.hypot(s.vx, s.vy); s.vx = dirVX(na) * sp; s.vy = dirVY(na) * sp; }
        }
        if (s.x < -HALFW || s.x > HALFW || s.y < -HALFH || s.y > HALFH) s.life = 0;
        // collisions vs enemies (report to host)
        for (const e of list) {
          const rr = (e.r || 12) + s.r;
          if (!s.hit[e.id] && dist2(s.x, s.y, e.x, e.y) < rr * rr) {
            s.hit[e.id] = 1;
            this._damageEnemy(e.id, s.dmg, host);
            this._spark(s.x, s.y, e.color || 60);
            if (s.pierce > 0) s.pierce--; else s.life = 0;
          }
        }
        if (boss) {
          const rr = boss.r + s.r;
          if (!s.hit.boss && dist2(s.x, s.y, boss.x, boss.y) < rr * rr) {
            s.hit.boss = 1;
            this._damageBoss(s.dmg, host);
            this._spark(s.x, s.y, 200);
            if (s.pierce > 0) s.pierce--; else s.life = 0;
          }
        }
      }
      this.playerShots = this.playerShots.filter((s) => s.life > 0);
    }

    _damageEnemy(id, dmg, host) {
      if (host) {
        const e = this.enemies.find((e) => e.id === id && e.alive);
        if (!e) return;
        e.hp -= dmg;
        if (e.hp <= 0) { e.alive = false; this.score += 10; this._boom(e.x, e.y, 1); }
      } else {
        Net.broadcast("ed", id + F2 + dmg.toFixed(1));
      }
    }
    _damageBoss(dmg, host) {
      if (host) { if (this.boss) this.boss.hp -= dmg; }
      else Net.broadcast("bh", dmg.toFixed(1));
    }

    // ── enemy bullets (deterministic sim on every client) ─────────────────────
    _stepBullets(dt) {
      const p = this.player;
      const arr = this.enemyBullets;
      let w = 0;
      for (let i = 0; i < arr.length; i++) {
        const b = arr[i];
        b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
        if (b.life <= 0 || b.x < -HALFW - 20 || b.x > HALFW + 20 || b.y < -HALFH - 20 || b.y > HALFH + 20) continue;
        // local damage to own player only
        if (p.alive && p.iframe <= 0 && this.state !== STATE.UPGRADE) {
          const rr = b.r + 6;
          if (dist2(b.x, b.y, p.x, p.y) < rr * rr) {
            this.stats.hp -= 1; p.iframe = 0.9; this._spark(p.x, p.y, 0);
            if (this.stats.hp <= 0) this._playerDown();
            continue; // consume bullet
          }
        }
        arr[w++] = b;
      }
      arr.length = w;
    }

    _playerDown() {
      this.player.alive = false; this.player.respawn = 4; this.stats.hp = 0;
      this._boom(this.player.x, this.player.y, 2);
      // if all players down -> game over (host decides, simple local check)
      const anyAlive = this.players().some((p) => p.alive);
      if (!anyAlive) this.state = STATE.DEAD;
    }

    // ── net event handler ─────────────────────────────────────────────────────
    _onNet(from, name, value) {
      switch (name) {
        case "f": this._spawnFromPayload(value); break;             // enemy/boss fired
        case "ed": { if (Net.isHost() || this.headlessHost) { const p = String(value).split(F2); this._damageEnemy(+p[0], +p[1], true); } break; }
        case "bh": { if (Net.isHost() || this.headlessHost) this._damageBoss(+value, true); break; }
        case "bs": { this._bossAnnounced = true; if (!(Net.isHost() || this.headlessHost)) { /* client: boss shown via mirror */ } break; }
        case "bd": break;
        case "up": { if (!(Net.isHost() || this.headlessHost)) this._openUpgrades(+value); break; }
        case "nw": { if (!(Net.isHost() || this.headlessHost)) this._advanceWave(); break; }
        default: break;
      }
    }

    // ── fx ────────────────────────────────────────────────────────────────────
    _boom(x, y, scale) {
      for (let i = 0; i < 12 * scale; i++) {
        const a = Math.random() * 360, sp = (40 + Math.random() * 120) * scale;
        this.particles.push({ x, y, vx: dirVX(a) * sp, vy: dirVY(a) * sp, life: 0.3 + Math.random() * 0.4, hue: 30 });
      }
    }
    _spark(x, y, hue) { for (let i = 0; i < 4; i++) { const a = Math.random() * 360; this.particles.push({ x, y, vx: dirVX(a) * 60, vy: dirVY(a) * 60, life: 0.25, hue }); } }
    _stepParticles(dt) {
      let w = 0;
      for (const pt of this.particles) { pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vx *= 0.9; pt.vy *= 0.9; pt.life -= dt; if (pt.life > 0) this.particles[w++] = pt; }
      this.particles.length = w;
    }

    // debug/state snapshot for tests
    bulletDigest() {
      // rounded to stabilise fp noise across independent integrations
      let h = 2166136261 >>> 0;
      for (const b of this.enemyBullets) {
        const v = (Math.round(b.x) * 131 + Math.round(b.y) * 17 + Math.round(b.vx) * 7 + Math.round(b.vy)) | 0;
        h = Math.imul(h ^ (v >>> 0), 16777619) >>> 0;
      }
      return (this.enemyBullets.length + ":" + h);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDERER (canvas overlay aligned to the Scratch stage)
  // ══════════════════════════════════════════════════════════════════════════
  const View = {
    canvas: null, ctx: null, game: null, stars: null,
    init(game) {
      this.game = game;
      if (typeof document === "undefined") return;
      const cv = document.createElement("canvas");
      cv.id = "sitv-canvas";
      cv.style.position = "absolute"; cv.style.pointerEvents = "auto"; cv.style.zIndex = 60;
      cv.width = W * 2; cv.height = H * 2;
      this.canvas = cv; this.ctx = cv.getContext("2d");
      this._attach();
      this._stars();
      this._bindInput();
      const loop = () => { this._sync(); this.draw(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    },
    _stageCanvas() { try { return runtime.renderer && runtime.renderer.canvas; } catch (e) { return null; } },
    _attach() {
      const host = this._stageCanvas();
      if (host && host.parentElement && !this.canvas.parentElement) host.parentElement.appendChild(this.canvas);
      else if (!this.canvas.parentElement) document.body.appendChild(this.canvas);
    },
    _sync() {
      const host = this._stageCanvas(); if (!host) return;
      if (!this.canvas.parentElement) this._attach();
      const r = host.getBoundingClientRect(), pr = host.parentElement.getBoundingClientRect();
      this.canvas.style.left = (host.offsetLeft) + "px";
      this.canvas.style.top = (host.offsetTop) + "px";
      this.canvas.style.width = r.width + "px";
      this.canvas.style.height = r.height + "px";
    },
    _stars() { const s = []; for (let i = 0; i < 90; i++) s.push({ x: Math.random() * W, y: Math.random() * H, z: Math.random() * 2 + 0.4 }); this.stars = s; },
    // world(-240..240,-180..180) -> canvas px (2x)
    tx(x) { return (x + HALFW) * 2; }, ty(y) { return (HALFH - y) * 2; },
    draw() {
      const c = this.ctx, g = this.game; if (!c) return;
      c.clearRect(0, 0, W * 2, H * 2);
      c.fillStyle = "#05060f"; c.fillRect(0, 0, W * 2, H * 2);
      // starfield
      for (const st of this.stars) { st.y += st.z * 0.6; if (st.y > H) { st.y = 0; st.x = Math.random() * W; } c.globalAlpha = st.z / 2.4; c.fillStyle = "#8fb2ff"; c.fillRect(st.x * 2, st.y * 2, st.z, st.z); }
      c.globalAlpha = 1;
      if (g.state === STATE.MENU) return this._menu();
      if (g.state === STATE.LOBBY) return this._center("CONNECTING…", "#9fe");
      this._particles(); this._enemies(); this._boss(); this._playerShots(); this._enemyBullets(); this._players(); this._hud();
      if (g.state === STATE.UPGRADE) this._upgrades();
      if (g.state === STATE.DEAD) this._center("RUN ENDED", "#f66", "click to return to menu");
      if (g.state === STATE.WIN) this._center("VICTORY", "#6f9", "all bosses cleared!");
    },
    _particles() { const c = this.ctx; for (const p of this.game.particles) { c.globalAlpha = clamp(p.life * 2, 0, 1); c.fillStyle = `hsl(${p.hue},90%,60%)`; c.beginPath(); c.arc(this.tx(p.x), this.ty(p.y), 3, 0, 6.28); c.fill(); } c.globalAlpha = 1; },
    _enemies() {
      const c = this.ctx; const list = (Net.isHost() || this.game.headlessHost) ? this.game.enemies : this.game.enemyMirror;
      for (const e of list) { if (e.alive === false) continue; const def = ENEMIES[ENEMY_IDS[e.t]]; const hue = def ? def.color : 130; const r = (def ? def.r : 12) * 2;
        c.save(); c.translate(this.tx(e.x), this.ty(e.y)); c.rotate((e.dir || 0) * RAD);
        c.fillStyle = `hsl(${hue},70%,55%)`; c.strokeStyle = `hsl(${hue},80%,75%)`; c.lineWidth = 2;
        c.beginPath(); for (let k = 0; k < 5; k++) { const a = (k / 5) * 6.283 - 1.57; const rr = k % 2 ? r * 0.6 : r; c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } c.closePath(); c.fill(); c.stroke(); c.restore(); }
    },
    _boss() {
      const c = this.ctx; const b = (Net.isHost() || this.game.headlessHost) ? this.game.boss : this.game.bossMirror; if (!b) return;
      const def = BOSSES[b.type]; const hue = def ? def.color : 210; const r = (def ? def.r : 28) * 2;
      c.save(); c.translate(this.tx(b.x), this.ty(b.y));
      c.shadowColor = `hsl(${hue},90%,60%)`; c.shadowBlur = 20; c.fillStyle = `hsl(${hue},70%,50%)`;
      c.beginPath(); c.arc(0, 0, r, 0, 6.28); c.fill();
      c.shadowBlur = 0; c.fillStyle = "#fff"; c.beginPath(); c.arc(0, 0, r * 0.4, 0, 6.28); c.fill(); c.restore();
      // health bar
      const w = W * 2 * 0.8, x0 = W * 2 * 0.1;
      c.fillStyle = "#222"; c.fillRect(x0, 16, w, 12);
      c.fillStyle = `hsl(${hue},80%,55%)`; c.fillRect(x0, 16, w * clamp(b.hp / b.max, 0, 1), 12);
      c.fillStyle = "#fff"; c.font = "bold 16px system-ui"; c.textAlign = "center"; c.fillText(def ? def.name : "BOSS", W, 44);
    },
    _enemyBullets() { const c = this.ctx; for (const b of this.game.enemyBullets) { c.fillStyle = `hsl(${b.hue},95%,62%)`; c.beginPath(); c.arc(this.tx(b.x), this.ty(b.y), b.r * 2, 0, 6.28); c.fill(); c.globalAlpha = 0.4; c.beginPath(); c.arc(this.tx(b.x), this.ty(b.y), b.r * 3, 0, 6.28); c.fill(); c.globalAlpha = 1; } },
    _playerShots() { const c = this.ctx; c.fillStyle = "#bfe9ff"; for (const s of this.game.playerShots) { c.fillRect(this.tx(s.x) - s.r, this.ty(s.y) - s.r * 3, s.r * 2, s.r * 6); } },
    _players() {
      const c = this.ctx;
      for (const p of this.game.players()) {
        c.save(); c.translate(this.tx(p.x), this.ty(p.y));
        const hue = p.local ? 200 : 150;
        if (p.local && this.game.player.iframe > 0 && Math.floor(this.game.time * 20) % 2) c.globalAlpha = 0.4;
        c.fillStyle = p.alive ? `hsl(${hue},90%,60%)` : "#555";
        c.beginPath(); c.moveTo(0, -14); c.lineTo(10, 12); c.lineTo(0, 6); c.lineTo(-10, 12); c.closePath(); c.fill();
        c.restore(); c.globalAlpha = 1;
      }
    },
    _hud() {
      const c = this.ctx, g = this.game, s = g.stats;
      c.textAlign = "left"; c.font = "bold 15px system-ui";
      // hull pips
      for (let i = 0; i < s.maxhp; i++) { c.fillStyle = i < s.hp ? "#4fd1ff" : "#333"; c.fillRect(12 + i * 12, H * 2 - 24, 9, 14); }
      c.fillStyle = "#fff"; c.fillText("WAVE " + g.wave, 12, 26); c.fillText("SCORE " + g.score, 12, 46);
      // co-op roster
      c.textAlign = "right"; let yy = 26;
      const max = Net.maxPlayers();
      for (let sl = 1; sl <= max; sl++) { if (!Net.slotActive(sl)) continue; const me = sl === g.mySlot(); c.fillStyle = me ? "#4fd1ff" : "#9f9"; c.fillText((Net.slotName(sl) || ("P" + sl)) + (me ? " (you)" : ""), W * 2 - 12, yy); yy += 20; }
    },
    _menu() {
      const c = this.ctx;
      c.textAlign = "center"; c.fillStyle = "#fff"; c.font = "bold 40px system-ui";
      c.fillText("VOID RUSH", W, H * 0.7);
      c.font = "16px system-ui"; c.fillStyle = "#8ad";
      c.fillText("co-op bullet-hell boss rush", W, H * 0.7 + 28);
      c.fillStyle = "#4fd1ff"; c.font = "bold 20px system-ui";
      this._button("PLAY CO-OP", W, H * 1.25, () => this.game._menuPlay());
      c.fillStyle = "#789"; c.font = "13px system-ui";
      c.fillText("WASD/arrows move · auto-fire · Shift to dash", W, H * 2 - 24);
    },
    _button(label, x, y, cb) {
      const c = this.ctx; const w = 220, h = 44; const bx = x - w / 2, by = y - h / 2;
      this._buttons = this._buttons || []; this._buttons.push({ x: bx, y: by, w, h, cb });
      c.fillStyle = "rgba(79,209,255,0.15)"; c.strokeStyle = "#4fd1ff"; c.lineWidth = 2;
      c.fillRect(bx, by, w, h); c.strokeRect(bx, by, w, h);
      c.fillStyle = "#eaf6ff"; c.textAlign = "center"; c.font = "bold 20px system-ui"; c.fillText(label, x, y + 7);
    },
    _upgrades() {
      const c = this.ctx; this._buttons = [];
      c.fillStyle = "rgba(0,0,10,0.72)"; c.fillRect(0, 0, W * 2, H * 2);
      c.fillStyle = "#fff"; c.textAlign = "center"; c.font = "bold 26px system-ui";
      c.fillText("CHOOSE AN UPGRADE", W, 70);
      const ch = this.game._pendingUpgrades;
      if (!ch) { c.font = "16px system-ui"; c.fillStyle = "#8ad"; c.fillText("waiting for other players…", W, H); return; }
      const cw = 250, gap = 30, total = ch.length * cw + (ch.length - 1) * gap, x0 = W - total / 2;
      for (let i = 0; i < ch.length; i++) {
        const u = ch[i], x = x0 + i * (cw + gap), y = H - 90;
        this._buttons.push({ x, y, w: cw, h: 180, cb: () => this.game.pickUpgrade(i) });
        c.fillStyle = "rgba(79,209,255,0.10)"; c.strokeStyle = "#4fd1ff"; c.lineWidth = 2; c.fillRect(x, y, cw, 180); c.strokeRect(x, y, cw, 180);
        c.fillStyle = "#4fd1ff"; c.font = "bold 22px system-ui"; c.fillText(u.name, x + cw / 2, y + 60);
        c.fillStyle = "#cde"; c.font = "16px system-ui"; this._wrap(u.desc, x + cw / 2, y + 100, cw - 30);
      }
    },
    _wrap(text, x, y, maxw) { const c = this.ctx; const words = text.split(" "); let line = "", yy = y; for (const w of words) { if (c.measureText(line + w).width > maxw) { c.fillText(line, x, yy); line = w + " "; yy += 22; } else line += w + " "; } c.fillText(line, x, yy); },
    _center(title, color, sub) { const c = this.ctx; c.textAlign = "center"; c.fillStyle = color || "#fff"; c.font = "bold 34px system-ui"; c.fillText(title, W, H - 10); if (sub) { c.fillStyle = "#9ab"; c.font = "16px system-ui"; c.fillText(sub, W, H + 24); } },
    _bindInput() {
      const g = this.game, cv = this.canvas;
      const keys = {};
      const setk = (e, v) => {
        const k = e.key.toLowerCase();
        if (k === "arrowup" || k === "w") g.input.up = v;
        else if (k === "arrowdown" || k === "s") g.input.down = v;
        else if (k === "arrowleft" || k === "a") g.input.left = v;
        else if (k === "arrowright" || k === "d") g.input.right = v;
        else if (k === "shift") g.input.dash = v;
        else return;
        e.preventDefault();
      };
      window.addEventListener("keydown", (e) => setk(e, 1));
      window.addEventListener("keyup", (e) => setk(e, 0));
      cv.addEventListener("mousemove", (e) => {
        const r = cv.getBoundingClientRect();
        g.input.mx = ((e.clientX - r.left) / r.width) * W - HALFW;
        g.input.my = HALFH - ((e.clientY - r.top) / r.height) * H;
      });
      cv.addEventListener("mousedown", (e) => {
        const r = cv.getBoundingClientRect(); const mx = (e.clientX - r.left) / r.width * W * 2, my = (e.clientY - r.top) / r.height * H * 2;
        if (g.state === STATE.MENU || g.state === STATE.UPGRADE) {
          const btns = this._buttons || [];
          for (const b of btns) if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) { b.cb(); return; }
        }
        if (g.state === STATE.DEAD || g.state === STATE.WIN) g.quitToMenu();
      });
    },
  };

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN LOOP (fixed timestep, independent of frame rate)
  // ══════════════════════════════════════════════════════════════════════════
  const game = new Game({});
  game._menuPlay = function () {
    const room = (typeof prompt === "function" ? prompt("Room / server name:", "sitv") : "sitv") || "sitv";
    game.startCoop(room);
  };

  let _acc = 0, _last = 0;
  function tickLoop(now) {
    if (!_last) _last = now;
    let dtms = now - _last; _last = now; if (dtms > 250) dtms = 250;
    _acc += dtms / 1000;
    let guard = 0;
    while (_acc >= TICK && guard++ < 6) { game.step(TICK); _acc -= TICK; }
    requestAnimationFrame(tickLoop);
  }

  function boot() {
    if (!Net.tryBind()) { setTimeout(boot, 200); return; } // wait for PacketPigeon
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(tickLoop);
    View.init(game);
  }
  boot();

  // Expose internals for the Node determinism test + power users
  Scratch.sitv = { Game, PATTERNS, PATTERN_IDS, ENEMIES, BOSSES, UPGRADES, runPattern, makeRng, hashSeed, encSpawn, decSpawn, encEnemies, decEnemies, game, View, Net, STATE };

  // ══════════════════════════════════════════════════════════════════════════
  // BLOCKS  (thin control surface; the game mostly drives itself)
  // ══════════════════════════════════════════════════════════════════════════
  const T = Scratch.ArgumentType, B = Scratch.BlockType;
  class SITVEngine {
    getInfo() {
      return {
        id: "sitvengine", name: "SITV Engine", color1: "#4fd1ff", color2: "#2a9fd6", color3: "#1c7fb0",
        blocks: [
          { opcode: "start", blockType: B.COMMAND, text: "start co-op in room [ROOM]", arguments: { ROOM: { type: T.STRING, defaultValue: "sitv" } } },
          { opcode: "menu", blockType: B.COMMAND, text: "return to main menu" },
          { opcode: "state", blockType: B.REPORTER, text: "game state" },
          { opcode: "wave", blockType: B.REPORTER, text: "wave" },
          { opcode: "score", blockType: B.REPORTER, text: "score" },
          { opcode: "hp", blockType: B.REPORTER, text: "my hull" },
          { opcode: "isHost", blockType: B.BOOLEAN, text: "am I host?" },
          { opcode: "bulletCount", blockType: B.REPORTER, text: "on-screen bullets" },
        ],
      };
    }
    start(args) { return game.startCoop(String(args.ROOM || "sitv")); }
    menu() { game.quitToMenu(); }
    state() { return ["menu", "lobby", "playing", "upgrade", "dead", "win"][game.state] || "menu"; }
    wave() { return game.wave; }
    score() { return game.score; }
    hp() { return Math.max(0, Math.round(game.stats.hp)); }
    isHost() { return Net.isHost(); }
    bulletCount() { return game.enemyBullets.length; }
  }
  Scratch.extensions.register(new SITVEngine());
})(Scratch);
