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
  let heat = 1;

  const make = (node, index, count) => {
    const angle = (index / Math.max(count, 1)) * Math.PI * 2;
    return {
      ...node,
      r: node.written ? 10 + Math.min(10, node.weight * 1.6) : 8,
      x: node.slug === focus ? 0 : Math.cos(angle) * 160 + Math.random() * 4,
      y: node.slug === focus ? 0 : Math.sin(angle) * 160 + Math.random() * 4,
      vx: 0,
      vy: 0,
    };
  };

  function step() {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      a.vx -= a.x * 0.01;
      a.vy -= a.y * 0.01;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d = Math.sqrt(d2);
        const push = 6400 / d2;
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
      const pull = (d - 120) * 0.025;
      a.vx += (dx / d) * pull;
      a.vy += (dy / d) * pull;
      b.vx -= (dx / d) * pull;
      b.vy -= (dy / d) * pull;
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
      node.vx *= 0.8;
      node.vy *= 0.8;
      node.x += node.vx * heat;
      node.y += node.vy * heat;
    }
    heat = Math.max(0.02, heat * 0.99);
  }

  /** Until a person moves the map, keep every node in view. */
  function fit() {
    if (fitted || nodes.length === 0) return;
    const pad = 48;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x - node.r - 60);
      maxX = Math.max(maxX, node.x + node.r + 60);
      minY = Math.min(minY, node.y - node.r);
      maxY = Math.max(maxY, node.y + node.r + 28);
    }
    const width = canvas.clientWidth - pad;
    const height = canvas.clientHeight - pad;
    view.k = Math.max(0.4, Math.min(1.6, width / (maxX - minX), height / (maxY - minY)));
    view.x = -((minX + maxX) / 2) * view.k;
    view.y = -((minY + maxY) / 2) * view.k;
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
    const label = 13 / Math.min(Math.max(view.k, 0.75), 1.4);
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
      context.font = `${node.written ? 700 : 400} ${label}px DIN, system-ui, sans-serif`;
      context.fillStyle = node.written ? ink : soft;
      const title = node.title.length > 28 ? `${node.title.slice(0, 27)}…` : node.title;
      context.fillText(title, node.x, node.y + node.r + label * 1.3);
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
    if (heat > 0.021 || drag) {
      step();
      draw();
      requestAnimationFrame(loop);
    } else running = false;
  }
  const wake = (amount) => {
    heat = Math.max(heat, amount);
    if (!running) {
      running = true;
      requestAnimationFrame(loop);
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
        wake(0.3);
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
    const made = make(node, index, graph.nodes.length);
    bySlug.set(node.slug, made);
    return made;
  });
  edges = graph.edges.map(([from, to]) => [bySlug.get(from), bySlug.get(to)]).filter(([a, b]) => a && b);
  canvas.dataset.nodes = String(nodes.length);
  if (reduced) {
    for (let i = 0; i < 400; i += 1) step();
    heat = 0.02;
  }
  size();
  wake(1);

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
      node = make({ slug, title, hue: null, written: false, playable: false, weight: 0 }, nodes.length, nodes.length + 1);
      node.from = focus;
      node.typed = true;
      if (parent) {
        node.x = parent.x + 40;
        node.y = parent.y + 40;
        edges.push([parent, node]);
      }
      nodes.push(node);
      bySlug.set(slug, node);
      canvas.dataset.nodes = String(nodes.length);
      wake(0.6);
    }
    hover = node;
    draw();
    input.value = "";
    document.dispatchEvent(new CustomEvent("vz:write", { detail: { slug, title, from: node.from ?? linkedFrom(node), typed: true } }));
  });
}

for (const canvas of document.querySelectorAll("canvas.graph")) mount(canvas);
