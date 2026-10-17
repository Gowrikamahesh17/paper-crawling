// spider-draw.js - pure rendering. crawler.js computes a "render state" in viewport
// coordinates every frame; this file only paints it on the overlay canvas.
//
// Look: glossy black thorax + abdomen, tiny white eye, 8 long thin teal legs
// (2 segments each) with red dots at knees and feet, 2 short palps.
const TEAL = '#19c3d6';
const RED = '#e0303a';

export function drawFrame(ctx, st) {
  ctx.clearRect(0, 0, st.w, st.h);
  drawThread(ctx, st);
  drawSilk(ctx, st);
  if (st.debug) drawDebug(ctx, st);
  drawLegs(ctx, st);
  drawBody(ctx, st);
}

// ---- silk: the dragline from the sky + faint lines to recently touched words
function drawThread(ctx, st) {
  const t = st.thread;
  if (!t || t.alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = t.alpha;
  ctx.strokeStyle = 'rgba(70,80,92,.85)';
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(t.ax, t.ay);
  ctx.quadraticCurveTo(t.cx, t.cy, t.bx, t.by);   // slack curve; a sway offset is baked into (cx,cy)
  ctx.stroke();
  ctx.restore();
}

function drawSilk(ctx, st) {
  if (!st.silk.length) return;
  ctx.save();
  ctx.lineWidth = 0.8;
  for (const s of st.silk) {
    ctx.strokeStyle = `rgba(25,195,214,${(0.38 * s.a).toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(st.abd.x, st.abd.y);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  ctx.restore();
}

// ---- legs: hip -> knee -> foot
function drawLegs(ctx, st) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 1.7 * st.scale;
  ctx.beginPath();
  for (const l of st.legs) {
    ctx.moveTo(l.hip.x, l.hip.y);
    ctx.lineTo(l.knee.x, l.knee.y);
    ctx.lineTo(l.foot.x, l.foot.y);
  }
  ctx.stroke();
  ctx.fillStyle = RED;
  for (const l of st.legs) {
    dot(ctx, l.knee.x, l.knee.y, 2.1 * st.scale);
    dot(ctx, l.foot.x, l.foot.y, (2.5 + l.lift * 1.2) * st.scale);   // lifted feet look slightly bigger
  }
}

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// ---- body, drawn in its own frame: +x is "forward" (head), origin = thorax centre
function drawBody(ctx, st) {
  const b = st.body, k = st.scale;
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.heading);
  ctx.scale(k, k);

  // soft contact shadow
  ctx.fillStyle = 'rgba(0,0,0,.16)';
  ctx.beginPath(); ctx.ellipse(-14, 3, 17, 10, 0, 0, Math.PI * 2); ctx.fill();

  // palps (two short stubby appendages by the mouth)
  ctx.strokeStyle = TEAL; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
  const pw = Math.sin(st.time * 5) * st.palpWiggle;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(11, s * 2.5);
    ctx.lineTo(18, s * (4.2 + pw * s));
    ctx.lineTo(22, s * (2.6 + pw * s));
    ctx.stroke();
  }

  // abdomen (big, rear) + thorax (front): glossy radial gradients
  gloss(ctx, -15, 0, 17, 10.5);
  gloss(ctx, 4, 0, 9.5, 6.6);
  ctx.beginPath(); ctx.ellipse(12, 0, 4.2, 3.6, 0, 0, Math.PI * 2);        // head
  ctx.fillStyle = '#07090c'; ctx.fill();

  // highlight streak on the abdomen
  ctx.fillStyle = 'rgba(255,255,255,.22)';
  ctx.beginPath(); ctx.ellipse(-17, -4.2, 8, 2.1, -0.12, 0, Math.PI * 2); ctx.fill();

  // eye
  ctx.fillStyle = '#fff';
  dot(ctx, 13.4, -1.1, 1.25);
  ctx.restore();
}

function gloss(ctx, cx, cy, rx, ry) {
  const g = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.45, 1, cx, cy, rx * 1.1);
  g.addColorStop(0, '#4b525e');
  g.addColorStop(0.35, '#15181e');
  g.addColorStop(1, '#030405');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

// ---- ?debug overlay: IK chains, foot targets, step thresholds
function drawDebug(ctx, st) {
  ctx.save();
  ctx.lineWidth = 1;
  for (const l of st.legs) {
    ctx.strokeStyle = 'rgba(255,0,200,.55)';                    // hip -> foot (IK reach line)
    ctx.beginPath(); ctx.moveTo(l.hip.x, l.hip.y); ctx.lineTo(l.foot.x, l.foot.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(40,160,40,.8)';                     // rest pose + step-threshold circle
    ctx.beginPath(); ctx.arc(l.rest.x, l.rest.y, st.stepDist, 0, Math.PI * 2); ctx.stroke();
    if (l.target) {                                             // where a stepping foot is heading
      ctx.strokeStyle = 'rgba(255,140,0,.95)';
      ctx.beginPath(); ctx.arc(l.target.x, l.target.y, 5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = l.planted ? 'rgba(0,150,0,.9)' : 'rgba(255,140,0,.9)';
    ctx.font = '10px monospace';
    ctx.fillText(l.name, l.foot.x + 6, l.foot.y - 6);
  }
  ctx.fillStyle = '#000';
  ctx.font = '12px monospace';
  st.debugLines.forEach((t, i) => ctx.fillText(t, 12, 20 + i * 14));
  ctx.restore();
}
