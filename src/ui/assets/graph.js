// The wiki as a graph: pages are nodes in their own color, [[links]] are edges.
// A small force layout on a canvas; drag to pan or move a node, wheel to zoom, click to open.
const canvas = document.getElementById("graph");
const context = canvas.getContext("2d");
const base = document.body.dataset.base ?? "";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const view = { x: 0, y: 0, k: 1 };
let nodes = [];
let edges = [];
let hover = null;
let drag = null;
let moved = false;
let heat = 1;

function step() {
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    a.vx -= a.x * 0.012;
    a.vy -= a.y * 0.012;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy + 0.01;
      const d = Math.sqrt(d2);
      const push = 5200 / d2;
      a.vx += (dx / d) * push;
      a.vy += (dy / d) * push;
      b.vx -= (dx / d) * push;
      b.vy -= (dy / d) * push;
    }
  }
  for (const [a, b] of edges) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const pull = (d - 110) * 0.03;
    a.vx += (dx / d) * pull;
    a.vy += (dy / d) * pull;
    b.vx -= (dx / d) * pull;
    b.vy -= (dy / d) * pull;
  }
  for (const node of nodes) {
    if (node === drag?.node) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx *= 0.82;
    node.vy *= 0.82;
    node.x += node.vx * heat;
    node.y += node.vy * heat;
  }
  heat = Math.max(0.02, heat * 0.992);
}

function draw() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const label = 13 / Math.max(view.k, 0.7);
  context.clearRect(0, 0, width, height);
  context.save();
  context.translate(width / 2 + view.x, height / 2 + view.y);
  context.scale(view.k, view.k);
  context.lineWidth = 1.2 / view.k;
  for (const [a, b] of edges) {
    context.strokeStyle = hover && (a === hover || b === hover) ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.16)";
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  context.textAlign = "center";
  for (const node of nodes) {
    context.beginPath();
    context.arc(node.x, node.y, node.r, 0, Math.PI * 2);
    if (node.written) {
      context.fillStyle = `oklch(0.8 0.16 ${node.hue})`;
      context.shadowColor = `oklch(0.7 0.2 ${node.hue})`;
      context.shadowBlur = node === hover ? 28 : 12;
      context.fill();
      context.shadowBlur = 0;
    } else {
      // A page that is asked for and not written: a hollow, dashed node.
      context.setLineDash([3 / view.k, 3 / view.k]);
      context.strokeStyle = node === hover ? "#fff" : "rgba(255,255,255,0.5)";
      context.stroke();
      context.setLineDash([]);
    }
    const near = node === hover || (hover && edges.some(([a, b]) => (a === hover && b === node) || (b === hover && a === node)));
    if (!node.written && !near && view.k < 1.3) continue;
    context.font = `${node.written ? 600 : 400} ${node.written ? label : label * 0.85}px ui-sans-serif, system-ui, sans-serif`;
    context.fillStyle = node === hover || node.written ? "#fff" : "rgba(255,255,255,0.72)";
    context.fillText(node.title, node.x, node.y + node.r + label * 1.25);
  }
  context.restore();
}

function size() {
  const ratio = devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * ratio;
  canvas.height = canvas.clientHeight * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function loop() {
  if (heat > 0.021 || drag) {
    step();
    draw();
  }
  requestAnimationFrame(loop);
}

function at(event) {
  const box = canvas.getBoundingClientRect();
  const x = (event.clientX - box.left - box.width / 2 - view.x) / view.k;
  const y = (event.clientY - box.top - box.height / 2 - view.y) / view.k;
  const node = nodes.findLast((candidate) => (candidate.x - x) ** 2 + (candidate.y - y) ** 2 < (candidate.r + 8) ** 2) ?? null;
  return { x, y, node };
}

canvas.addEventListener("pointerdown", (event) => {
  drag = { node: at(event).node, px: event.clientX, py: event.clientY };
  moved = false;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  const hit = at(event);
  if (drag) {
    const dx = event.clientX - drag.px;
    const dy = event.clientY - drag.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (drag.node) {
      drag.node.x = hit.x;
      drag.node.y = hit.y;
      heat = Math.max(heat, 0.3);
    } else {
      view.x += dx;
      view.y += dy;
    }
    drag.px = event.clientX;
    drag.py = event.clientY;
    draw();
  } else if (hit.node !== hover) {
    hover = hit.node;
    canvas.style.cursor = hover ? "pointer" : "grab";
    draw();
  }
});
canvas.addEventListener("pointerup", (event) => {
  const hit = at(event);
  if (!moved && hit.node) location.href = `${base}/${hit.node.slug}`;
  drag = null;
});
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    view.k = Math.max(0.35, Math.min(3, view.k * (event.deltaY < 0 ? 1.1 : 0.9)));
    draw();
  },
  { passive: false },
);
canvas.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !hover) return;
  location.href = `${base}/${hover.slug}`;
});
addEventListener("resize", size);

const graph = await (await fetch(canvas.dataset.src)).json();
const bySlug = new Map();
nodes = graph.nodes.map((node, index) => {
  const angle = (index / Math.max(graph.nodes.length, 1)) * Math.PI * 2;
  const made = {
    slug: node.slug,
    title: node.title,
    hue: node.hue,
    written: node.written,
    r: node.written ? 9 + Math.min(14, Math.sqrt(node.weight) * 2.2) : 5,
    x: Math.cos(angle) * 220,
    y: Math.sin(angle) * 220,
    vx: 0,
    vy: 0,
  };
  bySlug.set(node.slug, made);
  return made;
});
edges = graph.edges.map(([from, to]) => [bySlug.get(from), bySlug.get(to)]).filter(([a, b]) => a && b);
if (reduced) {
  for (let i = 0; i < 400; i += 1) step();
  heat = 0.02;
}
size();
loop();
