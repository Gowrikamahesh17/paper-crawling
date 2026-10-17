// crawler.js - the spider's brain and body.
//
//   WORLD SPACE   Everything lives in *document* coordinates (page x, page y), so the
//                 spider stays put on the paper when the page scrolls. spider-draw.js
//                 gets viewport coordinates (doc minus camera).
//   FRAME RULES   update() and render() only READ the DOM. Every DOM write (classes,
//                 scrolling, canvas resize) is pushed to `writeQ` and applied once per
//                 frame in commit(). That keeps layout thrash out of the 60fps loop.
//
//   Sections in this file:  1 math+noise  2 state  3 IK  4 foot anchoring  5 gait
//                           6 brain (wander/steer)  7 thread drop  8 camera
//                           9 markup effects + smart targeting  10 render  11 loop/API
import { log } from './logger.js';
import { drawFrame } from './spider-draw.js';
import { measureSections } from './loader.js';

// ---------------------------------------------------------------- 1. math + noise
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
// 1-D value noise in [0,1]: smooth random wandering without any library.
const hash = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
const noise = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash(i) * (1 - u) + hash(i + 1) * u; };

// ---------------------------------------------------------------- 2. constants + state
const K = 1;                       // overall spider scale
const L1 = 30 * K, L2 = 44 * K;    // thigh + shin length -> max reach 74px
const MAX_REACH = L1 + L2;
const STEP_DIST = 24 * K;          // foot drifts this far from its rest pose -> take a step
// Hip positions on the thorax and rest-pose foot positions, in BODY space:
// (forward, lateral). Left legs mirror these with a negative lateral.
const HIPS = [[9, 4], [3, 5], [-3, 5], [-9, 4]];
const REST = [[44, 46], [20, 64], [-8, 66], [-42, 52]];
const PROBES = [[0, 0], [12, 0], [-12, 0], [0, 8], [0, -8], [26, 0], [-26, 0], [0, 16], [0, -16]];
const SNAP_THREAD_LEN = 560;       // thread breaks when the spider gets this far from its anchor

export function createCrawler({ canvas, debug = false }) {
  const ctx = canvas.getContext('2d');
  const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach((f) => f(data));

  let paper = null;
  let W = innerWidth, H = innerHeight, dpr = devicePixelRatio || 1, resizeDirty = true;
  let sx = 0, sy = 0;                               // scroll, read once per frame
  let docH = 10000, col = { left: 100, right: 800 };
  const cam = { y: 0, vel: 0, follow: true, manualUntil: 0 };
  let pendingScroll = null;

  let mode = 'idle';                                // idle | drop | land | roam
  let paused = false, now = 0, fps = 60;
  // 'reader' = thesis mode: no random markup, no auto-scroll, the spider shadows where YOU are reading.
  // 'show'   = the original crawling performance (random markup, auto-scroll top to bottom).
  let readerMode = true, hidden = false;
  const body = { x: 400, y: 100, heading: Math.PI / 2, speed: 0, vx: 0, vy: 0 };
  const brain = { roam: null, pauseUntil: 0, nextPause: 0, override: null, mouse: { x: 0, y: 0, t: -1e9, has: false }, chase: true };
  const drop = { t: 0, landX: 0, landY: 0, landAt: 0, thread: null };
  let intensity = 'normal';
  const INTENSITY = {          // dramatic = weight of loud effects, extra = neighbour/line markups
    calm:   { speed: 0.8,  extra: 0.05, line: 0.02, dramatic: 0.4, big: 0,    rot: 0.3 },
    normal: { speed: 1,    extra: 0.16, line: 0.06, dramatic: 1,   big: 0.12, rot: 1 },
    wild:   { speed: 1.25, extra: 0.4,  line: 0.14, dramatic: 1.9, big: 0.3,  rot: 1.6 },
  };

  // 8 legs. Alternating tetrapod: group 0 = L1,R2,L3,R4 ; group 1 = the rest.
  const legs = [];
  for (const side of [-1, 1]) {
    for (let pair = 0; pair < 4; pair++) {
      legs.push({
        name: (side < 0 ? 'L' : 'R') + (pair + 1), side, pair,
        group: (side < 0) === (pair % 2 === 0) ? 0 : 1,
        // Fixed knee direction per side: front legs bow forward, back legs bow backward,
        // mirrored on the left/right (sign of the IK elbow angle).
        bend: pair < 2 ? -side : side,
        hipB: [HIPS[pair][0], side * HIPS[pair][1]],
        restB: [REST[pair][0], side * REST[pair][1]],
        hip: { x: 0, y: 0 }, knee: { x: 0, y: 0 }, foot: { x: 0, y: 0 },     // world (doc) space
        fd: { x: 0, y: 0 },                                                    // foot as drawn (IK-clamped to reach)
        rest: { x: 0, y: 0 },
        planted: false, stepping: false, el: null, off: null,
        from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, toEl: null, toOff: null, t: 0, dur: 0.15, lift: 0, holdUntil: 0,
      });
    }
  }

  // ---------------------------------------------------------------- 3. inverse kinematics
  const toWorld = (f, l, out) => {
    const c = Math.cos(body.heading), s = Math.sin(body.heading);
    out.x = body.x + (c * f - s * l) * K;
    out.y = body.y + (s * f + c * l) * K;
    return out;
  };

  /** Two-bone IK via the law of cosines.
   *  Hip H, target T, bones L1 (hip->knee) and L2 (knee->foot).
   *  d = |HT| (clamped to what the bones can reach). The angle at the hip between
   *  the line HT and the first bone is  a = acos((L1^2 + d^2 - L2^2) / (2*L1*d)).
   *  Knee = H + L1 * direction(angle(HT) + bend*a); `bend` (+1/-1) picks which side
   *  the knee pops out, fixed per leg so it never flips. Writes knee + the clamped foot (fd). */
  function solveIK(leg) {
    const dx = leg.foot.x - leg.hip.x, dy = leg.foot.y - leg.hip.y;
    const d = Math.hypot(dx, dy) || 0.001;
    const dc = clamp(d, Math.abs(L1 - L2) + 0.5, MAX_REACH - 0.5);
    const a = Math.acos(clamp((L1 * L1 + dc * dc - L2 * L2) / (2 * L1 * dc), -1, 1));
    const ang = Math.atan2(dy, dx) + leg.bend * a;
    let kx = leg.hip.x + Math.cos(ang) * L1, ky = leg.hip.y + Math.sin(ang) * L1;
    // lifted feet pull the knee up/out a little so a step reads as a lift in top-down view
    if (leg.lift > 0) {
      const mx = (leg.hip.x + leg.foot.x) / 2, my = (leg.hip.y + leg.foot.y) / 2;
      const ox = kx - mx, oy = ky - my, ol = Math.hypot(ox, oy) || 1;
      kx += (ox / ol) * leg.lift * 7; ky += (oy / ol) * leg.lift * 7;
    }
    leg.knee.x = kx; leg.knee.y = ky;
    leg.fd.x = leg.hip.x + (dx / d) * dc; leg.fd.y = leg.hip.y + (dy / d) * dc;
  }

  // ---------------------------------------------------------------- 4. foot anchoring
  /** Find the word under (or near) a viewport point. Reads only. */
  function pickWord(vx, vy) {
    let cell = null;
    for (const [ox, oy] of PROBES) {
      const e = document.elementFromPoint(vx + ox, vy + oy);
      if (!e) continue;
      if (e.closest('#analyst')) return null;
      if (e.classList.contains('w')) return e;
      if (!cell && paper && paper.root.contains(e)) { const c = e.closest('td, th, a'); if (c) cell = c; }
    }
    return cell;
  }

  /** Snap a doc-space point to the nearest word: returns {x,y,el,off}. el=null if nothing to grip. */
  function snapDoc(x, y) {
    const raw = { x, y, el: null, off: null };
    const vx = x - sx, vy = y - sy;
    if (vx < 2 || vy < 2 || vx > W - 2 || vy > H - 2) return raw;
    const el = pickWord(vx, vy);
    if (!el) return raw;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return raw;
    const off = { dx: r.width * rand(0.3, 0.7), dy: r.height * 0.55 };
    return { x: r.left + sx + off.dx, y: r.top + sy + off.dy, el, off };
  }

  /** Where an anchored element is now (doc space), or null if it vanished. */
  function anchorPos(el, off) {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return null;
    return { x: r.left + sx + off.dx, y: r.top + sy + off.dy };
  }

  // ---------------------------------------------------------------- 5. gait
  const tuckedFoot = (leg, out) => {
    const w = Math.sin(now * 0.004 + leg.pair * 1.7 + leg.side) * 3;
    return toWorld(leg.restB[0] * 0.2 + w, leg.restB[1] * 0.26, out);
  };

  function startStep(leg, forced) {
    toWorld(leg.restB[0], leg.restB[1], leg.rest);
    const look = 0.17;                                     // aim a bit ahead of where we're walking
    let hit = forced || snapDoc(leg.rest.x + body.vx * look + rand(-5, 5), leg.rest.y + body.vy * look + rand(-5, 5));
    if (Math.hypot(hit.x - leg.hip.x, hit.y - leg.hip.y) > MAX_REACH * 0.94) {
      hit = { x: leg.rest.x, y: leg.rest.y, el: null, off: null };            // out of reach: just stand at rest
    }
    leg.from.x = leg.foot.x; leg.from.y = leg.foot.y;
    leg.to.x = hit.x; leg.to.y = hit.y; leg.toEl = hit.el; leg.toOff = hit.off;
    leg.t = 0;
    leg.dur = rand(0.12, 0.18) * (body.speed > 160 ? 0.85 : 1);              // eased lift-swing-plant, 120-180ms
    leg.stepping = true; leg.planted = false; leg.el = null;
  }

  function advanceStep(leg, dt) {
    leg.t += dt / leg.dur;
    if (leg.toEl) {                                         // target word may scroll/reflow mid-swing
      const p = anchorPos(leg.toEl, leg.toOff);
      if (p) { leg.to.x = p.x; leg.to.y = p.y; } else { leg.toEl = null; leg.toOff = null; }
    }
    const t = Math.min(leg.t, 1), e = easeInOutCubic(t);
    leg.foot.x = lerp(leg.from.x, leg.to.x, e);
    leg.foot.y = lerp(leg.from.y, leg.to.y, e);
    leg.lift = Math.sin(Math.PI * t);
    if (leg.t >= 1) {                                       // plant!
      leg.stepping = false; leg.planted = true; leg.lift = 0;
      leg.foot.x = leg.to.x; leg.foot.y = leg.to.y;
      leg.el = leg.toEl; leg.off = leg.toOff;
      if (leg.el) onPlant(leg.el);
    }
  }

  /** Planted feet ride their word through scroll/reflow; if it jumped away, let go and re-step. */
  function followAnchor(leg) {
    if (!leg.el) return;
    const p = anchorPos(leg.el, leg.off);
    if (!p || Math.hypot(p.x - leg.foot.x, p.y - leg.foot.y) > 70) { leg.el = null; leg.planted = false; leg.holdUntil = 0; return; }
    leg.foot.x = p.x; leg.foot.y = p.y;
  }

  function gait(dt) {
    for (const leg of legs) {
      toWorld(leg.hipB[0], leg.hipB[1], leg.hip);
      toWorld(leg.restB[0], leg.restB[1], leg.rest);
      if (leg.stepping) advanceStep(leg, dt);
      else if (leg.planted) followAnchor(leg);
      else if (mode === 'drop' || now < leg.holdUntil) tuckedFoot(leg, leg.foot);    // dangling / waiting to splay
    }
    if (mode === 'drop') return;

    // Which legs want to step? Over-extended = urgent; drifted past threshold = normal.
    const cands = [];
    for (const leg of legs) {
      if (leg.stepping) continue;
      const reach = Math.hypot(leg.foot.x - leg.hip.x, leg.foot.y - leg.hip.y);
      const drift = Math.hypot(leg.foot.x - leg.rest.x, leg.foot.y - leg.rest.y);
      const over = reach > MAX_REACH * 0.96;
      if (!leg.planted) { if (now >= leg.holdUntil) cands.push({ leg, u: 100 }); }
      else if (over) cands.push({ leg, u: 99 });
      else if (drift > STEP_DIST) cands.push({ leg, u: drift });
    }
    cands.sort((a, b) => b.u - a.u);
    for (const { leg, u } of cands) {
      // alternating tetrapod: don't start a step while the *other* group is mid-swing (unless urgent)
      const blocked = legs.some((l) => l.stepping && l.group !== leg.group);
      if (!blocked || u >= 99) startStep(leg);
    }
  }

  // ---------------------------------------------------------------- 6. brain: wander, pause, steer
  function pickRoamGoal() {
    const t = now / 1000;
    const L = col.left + 20, R = col.right - 20;
    const nx = clamp((noise(t * 0.33 + 17) - 0.5) * 1.9 + 0.5, 0, 1);       // noise-driven left/right sweep
    let y = body.y + 45 + noise(t * 0.21 + 3) * 110;
    const sec = currentSection();
    if (sec?.isRefs) y = clamp(y, cam.y + 70, cam.y + H - 110);              // stay on screen in References
    return { x: lerp(L, R, nx), y: Math.min(y, docH - 160), until: now + rand(1400, 2800) };
  }

  function overrideGoal() {
    const o = brain.override;
    if (o.el) {
      const r = o.el.getBoundingClientRect();
      o.x = r.left + sx + r.width / 2; o.y = r.top + sy + r.height / 2;
    }
    return o;
  }

  function think(dt) {
    if (mode === 'land') {                                   // legs splay, body waits
      body.speed = 0; body.vx = body.vy = 0;
      if (now - drop.landAt > 900) { mode = 'roam'; log.debug('crawler', 'roam'); }
      return;
    }
    let goal, kind = 'roam', boost = 1;
    if (brain.override) { goal = overrideGoal(); kind = 'override'; boost = 2.3; }
    else if (brain.chase && brain.mouse.has && now - brain.mouse.t < 1800) {
      goal = { x: clamp(brain.mouse.x + sx, col.left, col.right + 40), y: brain.mouse.y + sy }; kind = 'mouse'; boost = 1.5;
    } else if (readerMode) {                                 // shadow the reader's viewport
      const t = now / 1000;
      goal = { x: lerp(col.left + 40, col.right - 40, clamp((noise(t * 0.25 + 9) - 0.5) * 1.8 + 0.5, 0, 1)),
               y: clamp(cam.y + H * 0.45 + (noise(t * 0.18 + 5) - 0.5) * H * 0.3, 20, docH - 40) };
      boost = Math.hypot(goal.x - body.x, goal.y - body.y) > 250 ? 3 : 1.1;
    } else {
      if (!brain.roam || now > brain.roam.until || Math.hypot(brain.roam.x - body.x, brain.roam.y - body.y) < 28) brain.roam = pickRoamGoal();
      goal = brain.roam;
    }
    const dx = goal.x - body.x, dy = goal.y - body.y, dist = Math.hypot(dx, dy);

    // arrived at an override target -> fire its callback, then linger
    if (kind === 'override' && dist < 30) {
      const o = brain.override; brain.override = null;
      brain.pauseUntil = now + 1700;
      try { o.onArrive?.(); } catch (e) { log.error('crawler', 'onArrive failed', String(e)); }
    } else if (kind === 'override' && now - brain.override.since > 30000) brain.override = null;

    // "reading" pauses
    if (kind === 'roam' && now > brain.nextPause) {
      brain.pauseUntil = now + rand(500, 1400);
      brain.nextPause = brain.pauseUntil + rand(3000, 8000);
    }
    const pausing = now < brain.pauseUntil && kind !== 'override' && !(readerMode && dist > 150);

    const want = Math.atan2(dy, dx);
    const diff = angDiff(want, body.heading);
    body.heading += clamp(diff, -3.4 * dt, 3.4 * dt);

    const cruise = (95 + 55 * noise(now * 0.0005 + 40)) * INTENSITY[intensity].speed * boost;
    let target = pausing ? 0 : cruise;
    if (kind !== 'roam') target *= clamp(dist / 90, 0.1, 1);               // ease into targets
    target *= Math.max(0.15, Math.cos(Math.min(Math.abs(diff), 1.4)));     // slow down in tight turns
    body.speed += clamp(target - body.speed, -420 * dt, 280 * dt);
    body.vx = Math.cos(body.heading) * body.speed;
    body.vy = Math.sin(body.heading) * body.speed;
    body.x = clamp(body.x + body.vx * dt, col.left - 30, col.right + 30);
    body.y = clamp(body.y + body.vy * dt, 20, docH - 40);
  }

  // ---------------------------------------------------------------- 7. thread drop entrance
  const thread = { ax: 0, ay: 0, alive: false, snapped: false, snapAt: 0, bx0: 0, by0: 0 };

  function startDrop() {
    if (!paper) return;
    mode = 'drop';
    brain.override = null; brain.roam = null;
    const p = paper.root.querySelector('.ltx_abstract p, .ltx_abstract, p');
    const r = p ? p.getBoundingClientRect() : { top: 300, left: col.left, width: 600 };
    const docTop = r.top + window.scrollY;
    drop.landX = col.left + (col.right - col.left) * 0.5;
    drop.landY = clamp(docTop + 36, H * 0.3, H * 0.62);           // land on the title/abstract
    drop.t = 0;
    window.scrollTo(0, 0);                                        // one-off write, outside the frame loop
    cam.y = 0; cam.vel = 0; pendingScroll = null; sy = 0;
    thread.ax = drop.landX; thread.ay = -14; thread.alive = true; thread.snapped = false;
    body.heading = Math.PI / 2; body.speed = 0; body.vx = body.vy = 0;
    for (const l of legs) { l.planted = false; l.stepping = false; l.el = null; l.lift = 0; }
    log.info('crawler', 'dropping in');
  }

  function dropStep(dt) {
    drop.t += dt / 2.9;
    const p = easeInOutSine(clamp(drop.t, 0, 1));
    const sway = Math.sin(now * 0.0021) * 14 * (1 - p);
    body.x = drop.landX + sway;
    body.y = lerp(-90, drop.landY, p);
    body.heading = Math.PI / 2 + sway * 0.006;                    // hanging head-down
    if (drop.t >= 1) {                                            // touchdown: splay legs one after another
      mode = 'land'; drop.landAt = now;
      legs.forEach((l, i) => { l.holdUntil = now + 80 + ((i % 4) * 2 + (i >> 2)) * 55; });
      emit('landed');
    }
  }

  /** Slack, swaying dragline; snaps once the spider is far from the anchor. */
  function updateThread() {
    if (!thread.alive) return;
    const tipX = body.x - Math.cos(body.heading) * 32 * K, tipY = body.y - Math.sin(body.heading) * 32 * K;
    if (!thread.snapped && mode === 'roam' && Math.hypot(tipX - thread.ax, tipY - thread.ay) > SNAP_THREAD_LEN) {
      thread.snapped = true; thread.snapAt = now; thread.bx0 = tipX; thread.by0 = tipY;
      log.debug('crawler', 'thread snapped');
    }
    if (thread.snapped && now - thread.snapAt > 800) thread.alive = false;
  }

  // ---------------------------------------------------------------- 8. camera
  let lastSecCheck = 0, curIdx = -1, lastMeasure = 0;
  const walked = new Set();                                      // paragraphs the spider's feet touched

  const currentSection = () => (paper && curIdx >= 0 ? paper.sections[curIdx] : null);

  function cameraStep(dt) {
    if (Math.abs(sy - cam.y) > 4) { cam.y = sy; cam.vel = 0; cam.manualUntil = now + 2500; }   // user scrolled
    const sec = currentSection();
    const stop = sec?.isRefs && !brain.override;                // auto-scroll stops at References
    let targetVel = 0;
    if (cam.follow && !readerMode && now > cam.manualUntil && mode !== 'drop' && !stop) {
      const want = clamp(body.y - H * 0.42, 0, Math.max(0, docH - H));
      const d = want - cam.y, dead = 55;
      if (Math.abs(d) > dead) targetVel = Math.sign(d) * Math.min((Math.abs(d) - dead) * 1.8, brain.override ? 900 : 130);
    }
    cam.vel += (targetVel - cam.vel) * Math.min(1, dt * 6);     // smooth accel/decel
    if (Math.abs(cam.vel) < 0.2) cam.vel = 0;
    if (mode === 'drop') { cam.y = 0; return; }
    const ny = clamp(cam.y + cam.vel * dt, 0, Math.max(0, docH - H));
    if (ny !== cam.y) { cam.y = ny; pendingScroll = ny; }
  }

  function trackSection() {
    if (!paper || now - lastSecCheck < 150) return;
    lastSecCheck = now;
    if (now - lastMeasure > 1500) { measureSections(paper); lastMeasure = now; }
    let idx = 0;
    paper.sections.forEach((s, i) => { if (s.top <= body.y + 8) idx = i; });
    if (idx !== curIdx && mode !== 'drop') {
      curIdx = idx;
      emit('section', paper.sections[idx]);
    }
  }

  function readLayout() {                                       // occasional, cheap reads
    if (!paper) return;
    docH = document.documentElement.scrollHeight;
    const r = paper.root.getBoundingClientRect();
    col.left = r.left + window.scrollX; col.right = r.right + window.scrollX;
  }

  // ---------------------------------------------------------------- 9. markup effects
  const writeQ = [];
  const marked = new Set();            // every element we touched (for clear)
  const wrappers = [];                 // rotate wrappers (to unwrap on clear)
  const purpleHeads = new Set();
  const recent = [];                   // recently touched words -> silk threads
  const notesSeen = new Set();
  const queueW = (fn) => writeQ.push(fn);

  const BOX = ['teal', 'purple', 'orange', 'red', 'green'];
  const TEXT_COLORS = ['#0a97a8', '#7b2cff', '#d9480f', '#c2185b', '#1b7f3b'];
  const NUM_RE = /^[+\-−±]?\d+(?:[.,]\d+)?%?$/;
  const UNIT_RE = /^(BLEU|F1|accuracy|acc\.?|perplexity|ppl|AUC|mAP|EM|ROUGE|top-?\d|FLOPs?|params?|parameters|M|B|K|×|x|points?|pts|percent|%|seconds|hours|days|GPUs?)[,.;)]?$/i;
  const MODEL_KNOWN = /^(Transformer|BERT|RoBERTa|ALBERT|GPT(-?\d+(\.\d+)?)?|LoRA|QLoRA|ResNet\d*|VGG\d*|ViT|CLIP|LSTM|GRU|CNN|RNN|T5|LLaMA|Llama\d*|Mistral|PaLM|BART|ELMo|Adam|AdamW|Seq2Seq|U-Net|YOLO\w*|Whisper|Gemini|Mamba|MoE|RLHF|ReLU|GELU|Softmax)s?$/;
  const DATASET = /^(ImageNet|CIFAR-?\d*|COCO|MNIST|GLUE|SuperGLUE|SQuAD\d*|MMLU|WMT|WMT\d*|Wikipedia|BookCorpus|WikiText-?\d*|LAMBADA|HellaSwag|GSM8K|HumanEval|MATH|PubMed|CommonCrawl|C4|Treebank|LibriSpeech|VQA|Cityscapes|ADE20K|SNLI|MNLI|QQP|SST-?\d*|CoNLL\w*|WinoGrande|TriviaQA|OpenWebText|WebText|Kinetics)s?$/;
  const STOP_CAPS = new Set(['THE', 'AND', 'FOR', 'NOT', 'ARE', 'WITH', 'FROM', 'THIS', 'THAT', 'ALL', 'ONE', 'TWO', 'NEW']);
  const CLAIM = /^(propose[sd]?|introduce[sd]?|outperform(s|ed)?|novel|state-of-the-art|SOTA|surpass(es|ed)?)$/i;

  /** Does this word matter? 'metric'|'model'|'dataset'|'citation'|'eqnum'|'claim'|null  (text = best label) */
  function classify(el) {
    const raw = el.textContent.trim();
    const t = raw.replace(/^[("'\[]+|[)"'\],.;:]+$/g, '');
    if (!t) return null;
    if (el.closest('.ltx_tag_equation, .ltx_eqn_eqno') || /^\(\d+(\.\d+)?\)$/.test(raw)) return { cat: 'eqnum', text: raw };
    if (el.closest('cite, .ltx_cite') || /^\[\d+(?:[,–-]\s*\d+)*\]$/.test(raw)) return { cat: 'citation', text: raw };
    const prev = el.previousElementSibling?.textContent.trim() || '';
    const next = el.nextElementSibling?.classList.contains('w') ? el.nextElementSibling.textContent.trim() : '';
    if (/^\(?[A-Z][a-z]+$/.test(raw) && /^et$/i.test(next)) return { cat: 'citation', text: raw };           // (Vaswani et al., 2017)
    if (/^\(?\d{4}[a-z]?\)?[;,.]?$/.test(raw) && /al\.?,?$/.test(prev)) return { cat: 'citation', text: raw };
    if (NUM_RE.test(t)) {
      const unit = UNIT_RE.test(next);
      if (unit || /%$/.test(t) || /^[+\-−]\d/.test(t) || (/[.,]\d/.test(t) && !/^(19|20)\d\d$/.test(t))) {
        return { cat: 'metric', text: unit ? `${t} ${next.replace(/[,.;)]$/, '')}` : t };
      }
      return { cat: 'number', text: t };
    }
    if (DATASET.test(t)) return { cat: 'dataset', text: t };
    if (MODEL_KNOWN.test(t) || /^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+$/.test(t) || /^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t)
        || (/^[A-Z][A-Z0-9-]{2,}s?$/.test(t) && !STOP_CAPS.has(t))) return { cat: 'model', text: t };
    if (CLAIM.test(t)) return { cat: 'claim', text: t };
    return null;
  }

  function sentenceAround(el, word) {
    const blk = el.closest('p, li, .ltx_p, td, figcaption, .ltx_caption');
    const full = (blk || el).textContent.replace(/\s+/g, ' ').trim();
    const sents = full.split(/(?<=[.!?])\s+(?=[A-Z(\[])/);
    return (sents.find((s) => s.includes(word)) || full).slice(0, 320);
  }

  function logNote(el, c) {
    const sec = currentSection();
    const key = `${c.cat}|${c.text}|${sec?.id}`;
    if (notesSeen.has(key)) return;
    notesSeen.add(key);
    emit('note', { type: c.cat, text: c.text, section: sec ? sec.title : '', sentence: sentenceAround(el, c.text.split(' ')[0]) });
  }

  // --- tiny DOM-write helpers (always run inside commit) ---
  const stripCls = (el, prefixes) => { for (const c of [...el.classList]) if (prefixes.some((p) => c.startsWith(p))) el.classList.remove(c); };
  function style(el, cls, { strip = [], css = null } = {}) {
    queueW(() => {
      if (el.classList.contains('m-hl-purple') || el.__locked) return;
      if (strip.length) stripCls(el, strip);
      el.classList.add(...cls);
      if (css) for (const k in css) k.startsWith('--') ? el.style.setProperty(k, css[k]) : (el.style[k] = css[k]);
      marked.add(el);
    });
  }
  const LOUD = ['m-hl', 'm-blowup', 'm-color', 'm-big', 'm-wide'];

  function lineWords(el) {                                       // other .w on the same visual line (reads rects)
    const out = [el], top = el.getBoundingClientRect().top;
    for (const dir of ['previousElementSibling', 'nextElementSibling']) {
      let n = el[dir], guard = 0;
      while (n && guard++ < 40) {
        if (n.classList.contains('w')) { if (Math.abs(n.getBoundingClientRect().top - top) > 6) break; out.push(n); }
        n = n[dir];
      }
    }
    return out;
  }
  function phraseFrom(el, n) {
    const out = [el]; let x = el.nextElementSibling;
    while (out.length < n && x && x.classList.contains('w')) { out.push(x); x = x.nextElementSibling; }
    return out;
  }
  function neighbours(el) {
    const out = []; let a = el, b = el;
    for (let i = 0; i < 3; i++) { a = a?.previousElementSibling; b = b?.nextElementSibling;
      if (a?.classList.contains('w')) out.push(a); if (b?.classList.contains('w')) out.push(b); }
    return out;
  }

  // Effect table. `dramatic` effects are the loud ones that get 3x weight on smart targets.
  const FX = [
    { k: 'box', w: 3 }, { k: 'color', w: 2 }, { k: 'hl-green', w: 1.5 },
    { k: 'hl-orange', w: 1, loud: true }, { k: 'hl-magenta', w: 1, loud: true }, { k: 'hl-cyan', w: 0.3, loud: true },
    { k: 'blowup', w: 1, loud: true }, { k: 'rotate', w: 0.25, loud: true },
  ];

  function chooseFx(el, c) {
    const I = INTENSITY[intensity];
    const smart = !!c && c.cat !== 'number';
    const isNum = NUM_RE.test(el.textContent.trim().replace(/^[("'\[]+|[)"'\],.;:]+$/g, ''));
    const canRotate = phraseFrom(el, 2).length > 1 && !el.closest('td, th, h1, h2, h3, h4, h5, h6, .ltx_title, li');
    const ws = FX.map((f) => {
      let w = f.w;
      if (f.k === 'blowup') w = isNum ? (c?.cat === 'metric' ? 2 : 0.8) : 0;
      if (f.k === 'rotate' && !canRotate) return 0;
      if (f.loud) w *= I.dramatic * (smart ? 3 : 1);                  // "hunt for what matters"
      if (f.k === 'rotate') w *= I.rot;
      return w;
    });
    let r = Math.random() * ws.reduce((a, b) => a + b, 0);
    for (let i = 0; i < FX.length; i++) { r -= ws[i]; if (r <= 0) return FX[i].k; }
    return 'box';
  }

  function applyFx(el, k, c) {
    const I = INTENSITY[intensity];
    switch (k) {
      case 'box': style(el, ['m-box-' + pick(BOX)], { strip: ['m-box'] }); break;
      case 'color': style(el, ['m-color-text'], { strip: LOUD, css: { '--tc': pick(TEXT_COLORS) } }); break;
      case 'hl-green': style(el, ['m-hl-green'], { strip: LOUD }); break;
      case 'hl-orange': {
        const big = Math.random() < I.big * (c && c.cat !== 'number' ? 2 : 1);
        style(el, big ? ['m-hl-orange', 'm-big'] : ['m-hl-orange'], { strip: LOUD }); break;
      }
      case 'hl-magenta': style(el, Math.random() < 0.4 ? ['m-hl-magenta', 'm-wide'] : ['m-hl-magenta'], { strip: LOUD }); break;
      case 'hl-cyan': lineWords(el).forEach((w) => style(w, ['m-hl-cyan'], { strip: LOUD })); break;
      case 'blowup':
        style(el, ['m-blowup', Math.random() < 0.5 ? 'm-blowup-orange' : 'm-blowup-red'], { strip: LOUD, css: { fontSize: rand(2, 3).toFixed(2) + 'em' } });
        break;
      case 'rotate': {
        const grp = phraseFrom(el, 3);
        queueW(() => {
          const first = grp[0], last = grp[grp.length - 1];
          if (!first.isConnected || first.closest('.m-rotate-green') || !first.parentNode) return;
          const wrap = document.createElement('span');
          wrap.className = 'm-rotate-green';
          first.parentNode.insertBefore(wrap, first);
          for (let n = first; n;) { const nx = n.nextSibling; wrap.appendChild(n); if (n === last) break; n = nx; }
          wrappers.push(wrap); marked.add(wrap);
        });
        break;
      }
    }
  }

  function markHeading(head) {
    if (purpleHeads.has(head)) return;
    purpleHeads.add(head);
    head.querySelectorAll('.w').forEach((w) => style(w, ['m-hl-purple'], { strip: LOUD.concat(['m-box']) }));
  }

  /** Every foot plant lands here. */
  function onPlant(el) {
    if (!el.classList.contains('w')) {                         // table cell / link without wrapped words
      style(el, ['m-box-' + pick(BOX)], { strip: ['m-box'] });
      return;
    }
    if (el.__locked) return;
    recent.push({ el, t: now }); if (recent.length > 5) recent.shift();
    const blk = el.closest('p, li, .ltx_p, td, figcaption, .ltx_caption');
    if (blk) walked.add(blk);

    if (readerMode) {                                          // reader mode: only log notes, never mark up
      const rc = classify(el);
      if (rc && ['metric', 'model', 'dataset'].includes(rc.cat)) logNote(el, rc);
      return;
    }
    const head = el.closest('h1, h2, h3, h4, h5, h6, .ltx_title');
    if (head && !head.closest('figure, table, .ltx_figure, .ltx_table')) { markHeading(head); return; }   // purple for section headings

    const c = classify(el);
    if (c && ['metric', 'model', 'dataset'].includes(c.cat)) logNote(el, c);
    applyFx(el, chooseFx(el, c), c);

    const I = INTENSITY[intensity];
    if (Math.random() < I.extra) {                              // sometimes mark a nearby word too
      const nb = pick(neighbours(el));
      if (nb) applyFx(nb, pick(['box', 'color', 'hl-green']), null);
    }
    if (Math.random() < I.line) applyFx(el, pick(['hl-cyan', 'hl-green', 'hl-green']), null);   // ...or the whole line
  }

  /** The biggest markup (orange blow-up + box) - used when the AI points at its KEY phrase. */
  function biggestMarkup(spans) {
    spans.forEach((el) => {
      el.__locked = false;
      if (readerMode) style(el, ['m-key'], { strip: LOUD.concat(['m-box', 'm-key']) });          // calm evidence highlight, no reflow
      else style(el, ['m-blowup', 'm-blowup-orange', 'm-box-orange'], { strip: LOUD.concat(['m-box']), css: { fontSize: '2.6em' } });
      queueW(() => { el.__locked = true; });
    });
  }

  function clearMarkup() {
    queueW(() => {
      for (const w of wrappers) { while (w.firstChild) w.parentNode?.insertBefore(w.firstChild, w); w.remove(); }
      wrappers.length = 0;
      for (const el of marked) {
        for (const c of [...el.classList]) if (c.startsWith('m-')) el.classList.remove(c);
        el.style.removeProperty('--tc'); el.style.fontSize = ''; el.__locked = false;
      }
      marked.clear(); purpleHeads.clear();
    });
    notesSeen.clear();
  }

  // ---------------------------------------------------------------- 10. render state
  const st = {
    w: 0, h: 0, scale: K, time: 0, debug, palpWiggle: 0.6, stepDist: STEP_DIST, debugLines: [],
    body: { x: 0, y: 0, heading: 0 }, abd: { x: 0, y: 0 }, silk: [], thread: { alpha: 0 },
    legs: legs.map((l) => ({ name: l.name, hip: { x: 0, y: 0 }, knee: { x: 0, y: 0 }, foot: { x: 0, y: 0 }, rest: { x: 0, y: 0 }, target: null, lift: 0, planted: false })),
  };

  function buildRenderState() {
    const cy = cam.y;
    st.w = W; st.h = H; st.time = now / 1000;
    st.body.x = body.x - sx; st.body.y = body.y - cy; st.body.heading = body.heading;
    st.palpWiggle = 0.4 + Math.min(body.speed / 160, 1);
    const ca = Math.cos(body.heading), sa = Math.sin(body.heading);
    st.abd.x = st.body.x - ca * 15 * K; st.abd.y = st.body.y - sa * 15 * K;
    legs.forEach((l, i) => {
      const o = st.legs[i];
      o.hip.x = l.hip.x - sx; o.hip.y = l.hip.y - cy;
      o.foot.x = l.fd.x - sx; o.foot.y = l.fd.y - cy;
      o.knee.x = l.knee.x - sx; o.knee.y = l.knee.y - cy;
      o.rest.x = l.rest.x - sx; o.rest.y = l.rest.y - cy;
      o.lift = l.lift; o.planted = l.planted;
      o.target = l.stepping ? { x: l.to.x - sx, y: l.to.y - cy } : null;
    });
    // faint silk from the abdomen to recently touched words (reads rects)
    st.silk.length = 0;
    for (const r of recent) {
      if (!r.el.isConnected) continue;
      const b = r.el.getBoundingClientRect();
      st.silk.push({ x: b.left + b.width / 2, y: b.top + b.height / 2 + sy - cy, a: clamp(1 - (now - r.t) / 7000, 0.1, 1) });
    }
    // dragline thread: slack curve from the anchor to the abdomen tip
    const th = st.thread;
    th.alpha = 0;
    if (thread.alive) {
      const tipX = st.body.x - ca * 32 * K, tipY = st.body.y - sa * 32 * K;
      let bx = tipX, by = tipY, alpha = 1;
      if (thread.snapped) {                                       // free end whips back up to the anchor and fades
        const p = clamp((now - thread.snapAt) / 800, 0, 1), e = p * p;
        bx = lerp(thread.bx0 - sx, thread.ax - sx, e); by = lerp(thread.by0 - cy, thread.ay - cy, e); alpha = 1 - p;
      }
      th.ax = thread.ax - sx; th.ay = thread.ay - cy; th.bx = bx; th.by = by; th.alpha = alpha;
      const len = Math.hypot(bx - th.ax, by - th.ay);
      const slack = clamp(1 - len / SNAP_THREAD_LEN, 0.05, 1);
      const sway = Math.sin(now * 0.0017) * 22 * slack;
      th.cx = (th.ax + bx) / 2 + sway; th.cy = (th.ay + by) / 2 + slack * 10;
    }
    if (debug) {
      const sec = currentSection();
      st.debugLines = [`fps ${fps.toFixed(0)}  mode ${mode}  speed ${body.speed.toFixed(0)}  cam ${cam.y.toFixed(0)}${cam.follow ? ' follow' : ''}`,
        `section ${sec ? sec.title : '-'}  markups ${marked.size}  intensity ${intensity}`,
        `planted ${legs.filter((l) => l.planted).length}/8  stepping ${legs.filter((l) => l.stepping).length}`];
    }
  }

  // ---------------------------------------------------------------- 11. loop + public API
  function update(dt) {
    sx = window.scrollX; sy = window.scrollY;
    if (!paper) return;
    if (mode === 'drop') dropStep(dt);
    else if (mode !== 'idle') think(dt);
    gait(dt);
    for (const leg of legs) solveIK(leg);                           // IK for every leg (clamps over-extended feet)
    updateThread();
    cameraStep(dt);
    trackSection();
  }

  /** Apply every queued DOM/canvas write. The ONLY place the DOM is mutated. */
  function commit() {
    if (writeQ.length) { const q = writeQ.splice(0); for (const fn of q) { try { fn(); } catch (e) { log.warn('crawler', 'write failed', String(e)); } } }
    if (pendingScroll != null) { window.scrollTo({ top: pendingScroll, left: window.scrollX, behavior: 'instant' }); pendingScroll = null; }
    if (resizeDirty) {
      dpr = devicePixelRatio || 1; W = innerWidth; H = innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      resizeDirty = false;
    }
  }

  let last = 0, frameNo = 0, rafId = 0;
  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min((ts - last) / 1000 || 0.016, 0.05);
    last = ts; now = ts;
    fps += (1 / Math.max(dt, 0.001) - fps) * 0.05;
    if (!paused) {
      if (frameNo++ % 40 === 0) readLayout();
      update(dt);
    }
    if (mode === 'idle' || hidden) ctx.clearRect(0, 0, W, H);
    else { buildRenderState(); drawFrame(ctx, st); }
    commit();
  }

  // --- input
  addEventListener('resize', () => { resizeDirty = true; });
  addEventListener('mousemove', (e) => {
    const over = e.target.closest?.('#analyst');
    brain.mouse.has = !over; brain.mouse.x = e.clientX; brain.mouse.y = e.clientY; brain.mouse.t = now;
  }, { passive: true });
  addEventListener('click', (e) => {
    if (e.target.closest?.('#analyst, a, select, button, input')) return;
    if (mode === 'drop' || !paper) return;
    brain.override = { x: e.clientX + window.scrollX, y: e.clientY + window.scrollY, since: now };
  });
  const manual = () => { cam.manualUntil = now + 2500; };            // manual scroll overrides auto-scroll for 2.5s
  addEventListener('wheel', manual, { passive: true });
  addEventListener('touchmove', manual, { passive: true });
  addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) manual(); });

  const api = {
    /** Hand the crawler a freshly loaded paper (resets annotations + notes). */
    setPaper(p) {
      paper = p; curIdx = -1; walked.clear(); recent.length = 0; notesSeen.clear();
      marked.clear(); wrappers.length = 0; purpleHeads.clear(); brain.override = null;
      readLayout();
    },
    start() { if (!rafId) rafId = requestAnimationFrame(frame); },
    drop() { readLayout(); startDrop(); },
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    togglePause() { paused = !paused; return paused; },
    toggleFollow() { cam.follow = !cam.follow; return cam.follow; },
    toggleChase() { brain.chase = !brain.chase; return brain.chase; },
    setIntensity(name) { if (INTENSITY[name]) { intensity = name; log.info('crawler', 'intensity ' + name); } return intensity; },
    getIntensity: () => intensity,
    clearMarkup,
    /** Walk to a word (element). onArrive fires once the body gets there. */
    goTo(el, onArrive) {
      if (!el || mode === 'drop') return;
      if (readerMode) {                                         // never scroll the reader's page: off-screen targets just fire
        const r = el.getBoundingClientRect();
        if (r.bottom < -80 || r.top > H + 80) { try { onArrive?.(); } catch { /* ignore */ } return; }
      }
      brain.override = { el, x: 0, y: 0, since: now, onArrive };
    },
    /** Spider "points" at the AI's KEY phrase: walk there, biggest markup, tap it with the front feet. */
    pointAt(spans) {
      if (!spans.length) return;
      api.goTo(spans[0], () => {
        biggestMarkup(spans);
        const target = (leg) => { const off = { dx: 4, dy: 8 }; const p = anchorPos(spans[0], off); if (p) startStep(leg, { x: p.x, y: p.y, el: spans[0], off }); };
        target(legs[0]); target(legs[4]);
      });
    },
    biggestMarkup,
    /** Scroll a phrase into view (the reader asked to see it), mark it, and walk the spider over. */
    reveal(spans) {
      if (!spans.length) return;
      const r = spans[0].getBoundingClientRect();
      const y = clamp(r.top + window.scrollY - H * 0.3, 0, Math.max(0, docH - H));
      cam.y = y; cam.vel = 0; pendingScroll = y; cam.manualUntil = now + 2500;
      biggestMarkup(spans);
      if (mode !== 'drop') brain.override = { el: spans[0], x: 0, y: 0, since: now };
    },
    setReaderMode(on) { readerMode = !!on; brain.roam = null; log.info('crawler', readerMode ? 'reader mode' : 'show mode'); return readerMode; },
    get readerMode() { return readerMode; },
    toggleVisible() { hidden = !hidden; return !hidden; },
    walked,
    get state() { return { mode, paused, intensity, follow: cam.follow, readerMode, hidden, body, cam, legs, markups: marked.size, section: currentSection()?.title }; },
    destroy() { cancelAnimationFrame(rafId); rafId = 0; },
  };
  return api;
}
