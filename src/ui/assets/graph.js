// The wiki as a map, like Obsidian's graph: a page is a dot in its own colour, a [[link]]
// or a "see" entry is a line, and a page somebody linked to and nobody wrote is a dashed
// ring with a plus. Click a page to open it; click a ring, or name a new page, and the task
// for your agent opens (app.js listens for "vz:write"). Drag to move, pinch to zoom.
// On a page (data-focus) the map shows that page and its neighbours.
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const base = document.body.dataset.base ?? "";

const slugify = (text) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");

function neighbourhood(graph, focus) {
  if (!focus) return graph;
  const keep = new Set([focus]);
  const grow = () => {
    for (const [a, b] of graph.edges) {
      if (keep.has(a)) keep.add(b);
      if (keep.has(b)) keep.add(a);
    }
  };
  grow();
  // A page with few neighbours shows the next ring too, so the map is never one lonely dot.
  if (keep.size < 6) grow();
  return { nodes: graph.nodes.filter((node) => keep.has(node.slug)), edges: graph.edges.filter(([a, b]) => keep.has(a) && keep.has(b)) };
}

async function mount(canvas) {
  const context = canvas.getContext("2d");
  const style = getComputedStyle(canvas);
  const ink = style.getPropertyValue("--ink").trim() || "#08090b";
  const soft = style.getPropertyValue("--soft").trim() || "#595f66";
  const action = style.getPropertyValue("--action").trim() || "#3c7df2";
  const focus = canvas.dataset.focus || null;
  const status = document.createElement("p");
  status.className = "map-status";
  status.setAttribute("role", "status");
  canvas.after(status);
  const view = { x: 0, y: 0, k: 1 };
  let fitted = false;
  let nodes = [];
  let edges = [];
  let hover = null;
  let drag = null;
  let moved = false;
  // The layout's temperature, as in d3-force: every force is scaled by it, and it cools to
  // nothing. The layout is settled before the map is first drawn, so a reader never sees it
  // being computed (2026-10-26: nodes started on one circle a few pixels apart, repulsion
  // threw them outward at a hundred pixels a frame and the camera re-fitted every frame:
  // the map shook violently for seconds on the home page). After that, only a drag or a new
  // node warms it, and every step is capped, so the map rearranges without jumping.
  let alpha = 0;
  const ALPHA_MIN = 0.004;
  const ALPHA_DECAY = 0.965;
  const MAX_STEP = 18;
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  /** Where a node starts: on a sunflower spiral, so no two begin on top of each other. */
  const make = (node, index) => {
    const r = 16 * Math.sqrt(index + 1);
    const angle = index * GOLDEN;
    return {
      ...node,
      r: node.written ? 10 + Math.min(10, node.weight * 1.6) : 8,
      x: node.slug === focus ? 0 : Math.cos(angle) * r,
      y: node.slug === focus ? 0 : Math.sin(angle) * r,
      vx: 0,
      vy: 0,
    };
  };

  /** The map is wide on a desktop and square on a phone: gravity pulls harder on the short axis, so the layout takes the canvas's shape. */
  const aspect = () => Math.min(3, Math.max(1, (canvas.clientWidth || 1) / (canvas.clientHeight || 1)));
  const degree = new Map();

  // The forces are d3-force's, by hand: charge between every pair, a spring on every link with
  // its strength shared out by degree (a hub is not torn apart by its many links), and a weak
  // gravity on each axis. Every one is scaled by alpha.
  const CHARGE = 360;
  const LINK = 90;
  const GRAVITY = 0.08;

  function step() {
    const n = nodes.length;
    const gy = GRAVITY * aspect() ** 1.5;
    for (let i = 0; i < n; i += 1) {
      const a = nodes[i];
      a.vx -= a.x * GRAVITY * alpha;
      a.vy -= a.y * gy * alpha;
      for (let j = i + 1; j < n; j += 1) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        // A floor on the distance keeps two nodes that happen to overlap from launching each other.
        const d2 = Math.max(dx * dx + dy * dy, 400);
        const push = (CHARGE * alpha) / d2;
        a.vx += dx * push;
        a.vy += dy * push;
        b.vx -= dx * push;
        b.vy -= dy * push;
      }
    }
    for (const [a, b] of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const da = degree.get(a) ?? 1;
      const db = degree.get(b) ?? 1;
      const want = LINK + 6 * Math.min(da, db);
      const pull = ((d - want) / d) * alpha * (1 / Math.min(da, db));
      const bias = da / (da + db);
      a.vx += dx * pull * (1 - bias);
      a.vy += dy * pull * (1 - bias);
      b.vx -= dx * pull * bias;
      b.vy -= dy * pull * bias;
    }
    for (const node of nodes) {
      if (node === drag?.node || (node.slug === focus && !drag)) {
        node.vx = 0;
        node.vy = 0;
        if (node.slug === focus && node !== drag?.node) {
          node.x *= 0.9;
          node.y *= 0.9;
        }
        continue;
      }
      node.vx *= 0.6;
      node.vy *= 0.6;
      const speed = Math.hypot(node.vx, node.vy);
      const cap = speed > MAX_STEP ? MAX_STEP / speed : 1;
      node.x += node.vx * cap;
      node.y += node.vy * cap;
    }
    alpha *= ALPHA_DECAY;
  }

  /** Run the layout to rest, off screen. Bounded so a very large wiki still opens at once. */
  function settle() {
    degree.clear();
    for (const [a, b] of edges) {
      degree.set(a, (degree.get(a) ?? 0) + 1);
      degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    alpha = 1;
    const steps = Math.max(40, Math.min(260, Math.floor(3_000_000 / (nodes.length * nodes.length + 1))));
    for (let i = 0; i < steps && alpha > ALPHA_MIN; i += 1) step();
    alpha = 0;
  }

  const LABEL = 13;
  const shown = (node) => (node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title);
  /**
   * On a big map the rings go unnamed until pointed at: a hundred names over a hundred dots
   * is a grey cloud nobody can read. A page's own neighbourhood is small, so there every
   * ring is named: those are the pages a reader can start from here.
   */
  const labelled = (node) => node === hover || node.slug === focus || nodes.length <= 40 || (node.written && view.k >= 0.45);

  /** Until a person moves the map, keep every node in view, its label included. */
  function fit() {
    if (fitted || nodes.length === 0) return;
    const pad = 48;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    context.font = `700 ${LABEL}px DIN, system-ui, sans-serif`;
    for (const node of nodes) {
      const half = node.written || nodes.length <= 40 ? context.measureText(shown(node)).width / 2 + 4 : 0;
      minX = Math.min(minX, node.x - Math.max(node.r, half));
      maxX = Math.max(maxX, node.x + Math.max(node.r, half));
      minY = Math.min(minY, node.y - node.r - 2);
      maxY = Math.max(maxY, node.y + node.r + LABEL * 1.3 + 4);
    }
    const width = canvas.clientWidth - pad;
    const height = canvas.clientHeight - pad;
    view.k = Math.max(0.3, Math.min(1.6, width / (maxX - minX), height / (maxY - minY)));
    view.x = -((minX + maxX) / 2) * view.k;
    view.y = -((minY + maxY) / 2) * view.k;
    // What the fit decided, readable from outside: the layout's size in map units and the zoom it got.
    canvas.dataset.extent = `${Math.round(maxX - minX)}x${Math.round(maxY - minY)}`;
    canvas.dataset.scale = view.k.toFixed(2);
  }

  const near = (node) => hover && (node === hover || edges.some(([a, b]) => (a === hover && b === node) || (b === hover && a === node)));

  function draw() {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    fit();
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width / 2 + view.x, height / 2 + view.y);
    context.scale(view.k, view.k);
    for (const [a, b] of edges) {
      const lit = hover && (a === hover || b === hover);
      context.strokeStyle = lit ? action : "rgba(8, 9, 11, 0.16)";
      context.lineWidth = (lit ? 2 : 1.3) / view.k;
      context.setLineDash(b.written ? [] : [4 / view.k, 4 / view.k]);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }
    context.setLineDash([]);
    const label = LABEL / Math.min(Math.max(view.k, 0.6), 1.4);
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    for (const node of nodes) {
      const dim = hover && !near(node);
      context.globalAlpha = dim ? 0.35 : 1;
      context.beginPath();
      context.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      if (node.written) {
        context.fillStyle = `oklch(0.7 0.15 ${node.hue ?? 262})`;
        context.fill();
        context.lineWidth = (node.slug === focus || node === hover ? 3 : 1.5) / view.k;
        context.strokeStyle = node.slug === focus || node === hover ? ink : "rgba(255, 255, 255, 0.9)";
        context.stroke();
      } else {
        context.fillStyle = "rgba(255, 255, 255, 0.85)";
        context.fill();
        context.setLineDash([3 / view.k, 3 / view.k]);
        context.lineWidth = 1.5 / view.k;
        context.strokeStyle = node === hover ? action : soft;
        context.stroke();
        context.setLineDash([]);
        // The plus says what a click does here: start this page.
        const arm = node.r * 0.45;
        context.beginPath();
        context.moveTo(node.x - arm, node.y);
        context.lineTo(node.x + arm, node.y);
        context.moveTo(node.x, node.y - arm);
        context.lineTo(node.x, node.y + arm);
        context.strokeStyle = node === hover ? action : soft;
        context.stroke();
      }
      if (labelled(node)) {
        context.font = `${node.written ? 700 : 400} ${label}px DIN, system-ui, sans-serif`;
        context.fillStyle = node.written ? ink : soft;
        context.fillText(shown(node), node.x, node.y + node.r + label * 1.3);
      }
    }
    context.globalAlpha = 1;
    context.restore();
  }

  function size() {
    const ratio = devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  let running = false;
  function loop() {
    if (alpha > ALPHA_MIN || drag) {
      step();
      draw();
      requestAnimationFrame(loop);
    } else {
      alpha = 0;
      running = false;
    }
  }
  /** Warm the layout a little: a drag or a new node moves its neighbours, gently, and then it rests again. */
  const wake = (amount) => {
    alpha = Math.max(alpha, reduced ? 0 : amount);
    if (!running && alpha > ALPHA_MIN) {
      running = true;
      requestAnimationFrame(loop);
    }
    if (reduced) {
      for (let i = 0; i < 30; i += 1) {
        alpha = amount;
        step();
      }
      alpha = 0;
      draw();
    }
  };

  function at(event) {
    const box = canvas.getBoundingClientRect();
    const x = (event.clientX - box.left - box.width / 2 - view.x) / view.k;
    const y = (event.clientY - box.top - box.height / 2 - view.y) / view.k;
    const node = nodes.findLast((candidate) => (candidate.x - x) ** 2 + (candidate.y - y) ** 2 < (candidate.r + 10) ** 2) ?? null;
    return { x, y, node };
  }

  /** The node under the pointer or the keyboard: lit, and named for the pointer and a screen reader alike. */
  const point = (node) => {
    hover = node;
    canvas.style.cursor = hover ? "pointer" : "grab";
    canvas.title = hover ? (hover.written ? `Open ${hover.title}` : `${hover.title}: not written yet. Click to send your agent.`) : "";
    status.textContent = canvas.title;
    draw();
  };

  /** Who links to a page that is not written: the task says where it will hang from. */
  const linkedFrom = (node) => edges.find(([, b]) => b === node)?.[0]?.slug ?? null;
  const write = (node) => document.dispatchEvent(new CustomEvent("vz:write", { detail: { slug: node.slug, title: node.title, from: node.from ?? linkedFrom(node) } }));
  const open = (node) => {
    if (node.written) location.assign(`${base}/${node.slug}`);
    else write(node);
  };

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
      if (Math.abs(dx) + Math.abs(dy) > 3) {
        moved = true;
        fitted = true;
      }
      if (drag.node) {
        drag.node.x = hit.x;
        drag.node.y = hit.y;
        wake(0.25);
      } else {
        view.x += dx;
        view.y += dy;
      }
      drag.px = event.clientX;
      drag.py = event.clientY;
      draw();
    } else if (hit.node !== hover) point(hit.node);
  });
  canvas.addEventListener("pointerup", (event) => {
    const hit = at(event);
    if (!moved && hit.node) open(hit.node);
    drag = null;
  });
  canvas.addEventListener("pointerleave", () => {
    if (drag || !hover) return;
    hover = null;
    draw();
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      // Scrolling the page over the map scrolls the page; a pinch, or ctrl and the wheel, zooms.
      if (!event.ctrlKey && !event.metaKey && document.activeElement !== canvas) return;
      event.preventDefault();
      fitted = true;
      view.k = Math.max(0.3, Math.min(3, view.k * (event.deltaY < 0 ? 1.1 : 0.9)));
      draw();
    },
    { passive: false },
  );
  // The keyboard reaches every node in turn; Enter opens it.
  canvas.addEventListener("keydown", (event) => {
    if (nodes.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      const at = nodes.indexOf(hover);
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      point(nodes[(at + (forward ? 1 : -1) + nodes.length) % nodes.length]);
    } else if (event.key === "Enter" && hover) open(hover);
  });
  new ResizeObserver(size).observe(canvas);

  const graph = neighbourhood(await (await fetch(canvas.dataset.src)).json(), focus);
  const bySlug = new Map();
  nodes = graph.nodes.map((node, index) => {
    const made = make(node, index);
    bySlug.set(node.slug, made);
    return made;
  });
  edges = graph.edges.map(([from, to]) => [bySlug.get(from), bySlug.get(to)]).filter(([a, b]) => a && b);
  settle();
  size();
  // Set last: a test that waits for it sees a map that is already still.
  canvas.dataset.nodes = String(nodes.length);

  // Naming a page that is not there puts it on the map, hung from this page if there is one, and opens the task.
  const form = canvas.closest(".map")?.querySelector(".map-add");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = form.querySelector("input");
    const title = input.value.trim();
    const slug = slugify(title);
    if (!slug) return;
    let node = bySlug.get(slug);
    if (node?.written) {
      location.href = `${base}/${slug}`;
      return;
    }
    if (!node) {
      const parent = focus ? bySlug.get(focus) : null;
      node = make({ slug, title, hue: null, written: false, playable: false, weight: 0 }, nodes.length);
      node.from = focus;
      node.typed = true;
      if (parent) {
        node.x = parent.x + 40;
        node.y = parent.y + 40;
        edges.push([parent, node]);
        degree.set(parent, (degree.get(parent) ?? 0) + 1);
        degree.set(node, 1);
      }
      nodes.push(node);
      bySlug.set(slug, node);
      canvas.dataset.nodes = String(nodes.length);
      wake(0.4);
    }
    hover = node;
    draw();
    input.value = "";
    document.dispatchEvent(new CustomEvent("vz:write", { detail: { slug, title, from: node.from ?? linkedFrom(node), typed: true } }));
  });
}

for (const canvas of document.querySelectorAll("canvas.graph")) mount(canvas);
