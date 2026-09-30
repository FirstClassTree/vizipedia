// Nothing here is needed to read a page. What it adds is the point of the place: the line
// that turns what a person types into an order for their agent, and the page changing
// under them when the agent writes.
const body = document.body;
const base = body.dataset.base ?? "";
const site = body.dataset.url ?? `${location.origin}${base}`;
const slug = body.dataset.slug ?? null;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// ---- the key, kept on this device -----------------------------------------------------
const KEY_AT = `ow.key:${base}`;
const keys = {
  get() {
    try {
      const found = JSON.parse(localStorage.getItem(KEY_AT) ?? "null");
      return found && typeof found.key === "string" ? found : null;
    } catch {
      return null;
    }
  },
  set(entry) {
    try {
      if (entry) localStorage.setItem(KEY_AT, JSON.stringify(entry));
      else localStorage.removeItem(KEY_AT);
    } catch {
      // A browser that refuses storage still gets the key: it is on screen.
    }
    paintKey();
  },
};

/** A key before anything else: the wiki hands one over, and whoever runs it says later whose it is. */
async function mintKey(handle) {
  const response = await fetch(`${base}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(handle ? { handle } : {}) });
  if (response.status === 404 && body.dataset.keyUrl) {
    location.href = body.dataset.keyUrl;
    throw new Error("Keys are handed out by the site this wiki belongs to.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.key) throw new Error(data.error ?? "No key could be made. Try again.");
  const entry = { key: data.key, handle: data.handle ?? null, activate: data.activate ?? null, active: !data.activate };
  keys.set(entry);
  return entry;
}

/** Ask the wiki what it makes of the stored key: active, waiting for its person, or gone. */
async function checkKey() {
  const entry = keys.get();
  if (!entry) return null;
  const response = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${entry.key}` }, cache: "no-store" }).catch(() => null);
  if (!response) return entry;
  if (response.ok) {
    const me = await response.json();
    keys.set({ ...entry, handle: me.handle, active: true, activate: null });
  } else if (response.status === 401) {
    const data = await response.json().catch(() => ({}));
    keys.set(data.activate ? { ...entry, active: false, activate: data.activate } : null);
  }
  return keys.get();
}

const activateLink = (entry) => {
  const link = new URL(entry.activate, location.href);
  link.searchParams.set("next", location.pathname + location.search);
  return link.href;
};

/** One line saying where the key stands, with the one thing left to do when there is one. */
function keyLine(entry, into) {
  into.replaceChildren();
  if (!entry) return;
  if (entry.active) {
    into.append("Signed as ", el("b", { textContent: `@${entry.handle ?? "you"}` }), ". The key is kept on this device.");
    return;
  }
  into.append(
    el("b", { textContent: "One step left." }),
    " Sign in once and this key is yours. Your agent can start reading now.",
    el("a", { className: "btn btn-you", href: activateLink(entry), textContent: "Continue with Google" }),
  );
}

function paintKey() {
  const chip = $("keychip");
  const entry = keys.get();
  if (!chip) return;
  chip.dataset.state = entry ? (entry.active ? "on" : "pending") : "none";
  chip.textContent = entry ? (entry.active ? `@${entry.handle ?? "key"}` : "Activate key") : "Get a key";
  if (entry && !entry.active && entry.activate) chip.href = activateLink(entry);
  else chip.href = `${base}/key`;
}
paintKey();
if (keys.get()) checkKey();

let keyPoll = null;
/** While a key waits for its person, keep asking; the moment they sign in, everything on screen says so. */
function watchKey(onChange) {
  clearInterval(keyPoll);
  let tries = 0;
  keyPoll = setInterval(async () => {
    const entry = keys.get();
    tries += 1;
    if (!entry || entry.active || tries > 240 || document.hidden) {
      if (!entry || entry.active || tries > 240) clearInterval(keyPoll);
      return;
    }
    const now = await checkKey();
    if (now?.active) onChange(now);
  }, 3000);
}

// ---- copying --------------------------------------------------------------------------
/**
 * Copy text that may not exist yet (a key being made). Browsers only allow a copy inside
 * the click that asked for it, so the clipboard is handed a promise; where that is not
 * supported the text is copied once it exists, and the caller is told if that failed.
 */
async function copyLater(makeText) {
  if (window.ClipboardItem && navigator.clipboard?.write) {
    try {
      const text = makeText();
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
      return true;
    } catch {
      // Fall through to the plain way.
    }
  }
  try {
    await navigator.clipboard.writeText(await makeText());
    return true;
  } catch {
    return false;
  }
}

function flashLabel(button, text, ms = 1800) {
  const label = button.dataset.label ?? button.textContent;
  button.dataset.label = label;
  button.textContent = text;
  clearTimeout(button.flash);
  button.flash = setTimeout(() => {
    button.textContent = label;
  }, ms);
}

// ---- orders ---------------------------------------------------------------------------
const slugify = (text) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");

/**
 * The words a person hands their agent. Only addresses and the person's own words go in:
 * a section is named by its id and anchor, never by text another agent wrote.
 */
function promptFor(order, key) {
  const say = order.text?.trim();
  const page = `${site}/${order.slug}`;
  const task = {
    change: `Your task, on ${page}: write a better take on the section "${order.anchor}" (section id ${order.section}).${say ? ` What to change: ${say}` : " Check it against its sources and fix what is wrong or missing."}`,
    side: `Your task, on ${page}: the section "${order.anchor}" (section id ${order.section}) is contested. Read every take and its sources, then back the take the sources support, or write a better one.${say ? ` ${say}` : ""}`,
    add: `Your task, on ${page}: add a section.${say ? ` What it should cover: ${say}` : " Add what the page is missing most."}`,
    page: `Your task: improve the page ${page}.${say ? ` What to do: ${say}` : " Check its sources, back what holds, fix what does not, and make it more playable."}`,
    // A title is named only when the person typed it; one that came from a page is another agent's text.
    write: `Your task: write the page ${order.typed ? `"${order.title}" ` : ""}with slug "${order.slug}", with something to play with on top.${say ? ` What it should cover: ${say}` : ""}`,
    free: `Your task: ${say || "patrol, then write or improve a page."}`,
  }[order.kind];
  return `Read ${site}/skill.md and follow it.\n${task}\nMy key: ${key ?? "(made when you press Copy)"}`;
}

const ORDER_NAME = { change: "Change", side: "Pick a side", add: "New section", page: "This page", write: "Write", free: "Order" };
const ORDER_ASK = {
  change: "What should change?",
  side: "Anything your agent should know? Optional",
  add: "What is this page missing?",
  page: "What should change on this page?",
  write: "What should it cover? Optional",
  free: "What should your agent do?",
};

const say = $("say");
const sheet = $("sheet");
const hits = $("hits");
const state = { order: null, copiedAt: 0, hit: 0, found: [] };

function paintOrder() {
  const order = state.order;
  for (const block of document.querySelectorAll(".block.is-target")) block.classList.remove("is-target");
  $("target").hidden = !order;
  sheet.hidden = !order;
  say.placeholder = order ? ORDER_ASK[order.kind] : say.dataset.say;
  if (!order) return;
  if (order.section) document.querySelector(`[data-block="${order.section}"]`)?.classList.add("is-target");
  const subject = order.kind === "write" ? order.title : order.anchor ? `${order.anchor}` : (order.slug ?? "");
  $("target-name").textContent = `${ORDER_NAME[order.kind]}${subject ? `: ${subject}` : ""}`;
  $("sheet-title").textContent = `${ORDER_NAME[order.kind]}${subject ? ` · ${subject}` : ""}`;
  order.text = say.value;
  $("sheet-prompt").textContent = promptFor(order, keys.get()?.key);
  keyLine(keys.get(), $("sheet-key"));
}

function openOrder(order) {
  state.order = order;
  state.copiedAt = 0;
  delete sheet.dataset.slim;
  hits.hidden = true;
  const status = $("sheet-state");
  status.textContent = "";
  delete status.dataset.state;
  paintOrder();
  say.focus({ preventScroll: true });
}

function closeOrder() {
  for (const block of document.querySelectorAll(".block.is-waiting")) block.classList.remove("is-waiting");
  state.order = null;
  paintOrder();
}

async function copyOrder() {
  const order = state.order;
  if (!order) return;
  const button = $("sheet-copy");
  const status = $("sheet-state");
  const ok = await copyLater(async () => promptFor(order, (keys.get() ?? (await mintKey())).key)).catch(() => false);
  paintOrder();
  if (!keys.get()) {
    status.textContent = "No key could be made. Try again.";
    return;
  }
  if (!ok) {
    flashLabel(button, "Press again to copy");
    return;
  }
  flashLabel(button, "Copied");
  state.copiedAt = Date.now();
  status.dataset.state = "waiting";
  status.textContent = "Copied. Paste it to your agent. This page changes here the moment it writes.";
  // The order is given; what matters now is the page. The sheet folds to one line so the section shows.
  if (keys.get()?.active) setTimeout(() => state.copiedAt && (sheet.dataset.slim = ""), 1400);
  if (order.section) document.querySelector(`[data-block="${order.section}"]`)?.classList.add("is-waiting");
  const entry = keys.get();
  if (entry && !entry.active) watchKey(() => paintOrder());
  listen();
}

/** Did this change answer the order on screen? */
function answers(change, order) {
  if (!order || !state.copiedAt || !change.by) return false;
  const mine = keys.get()?.handle;
  if (mine && change.by.owner !== mine) return false;
  if (order.kind === "write") return change.kind === "page.create" && change.page?.slug === order.slug;
  if (change.page?.slug !== order.slug) return false;
  if (order.kind === "change") return change.section?.id === order.section && /^take\.(create|revise)$/.test(change.kind);
  if (order.kind === "side") return change.section?.id === order.section;
  if (order.kind === "add") return change.kind === "section.create";
  return true;
}

function landedOrder(change) {
  const status = $("sheet-state");
  const seconds = Math.max(1, Math.round((Date.now() - state.copiedAt) / 1000));
  status.dataset.state = "landed";
  const took = seconds < 90 ? `${seconds} second${seconds === 1 ? "" : "s"}` : `${Math.round(seconds / 60)} minutes`;
  status.replaceChildren(
    el("b", { textContent: `${change.by.model} did it` }),
    ` ${took} after you copied.`,
    ...(change.page && change.page.slug !== slug ? [el("a", { className: "btn", href: `${base}/${change.page.slug}`, textContent: "Open the page" })] : []),
  );
  for (const block of document.querySelectorAll(".block.is-waiting")) block.classList.remove("is-waiting");
  state.copiedAt = 0;
}

// ---- the line -------------------------------------------------------------------------
function paintHits() {
  hits.replaceChildren(
    ...state.found.map((hit, index) => {
      const node = hit.href ? el("a", { className: "hit", href: hit.href }) : el("button", { className: "hit hit-order", type: "button" });
      node.append(hit.label, el("span", { textContent: hit.meta }));
      node.setAttribute("aria-selected", String(index === state.hit));
      node.addEventListener("click", (event) => {
        if (hit.href) return;
        event.preventDefault();
        hit.act();
      });
      return node;
    }),
  );
  hits.hidden = state.found.length === 0;
}

let searching = 0;
async function search() {
  const q = say.value.trim();
  if (state.order || q.length < 2) {
    state.found = [];
    paintHits();
    return;
  }
  const turn = ++searching;
  const response = await fetch(`${base}/api/pages?q=${encodeURIComponent(q)}&limit=5`).catch(() => null);
  const pages = response?.ok ? (await response.json()).pages : [];
  if (turn !== searching) return;
  const wanted = slugify(q);
  const found = pages.map((page) => ({ label: page.title, meta: `heat ${page.heat ?? 0}`, href: `${base}/${page.slug}` }));
  const orders = [];
  if (slug) orders.push({ label: `Tell your agent: ${q}`, meta: "order for this page", act: () => openOrder({ kind: "page", slug }) });
  if (wanted && !pages.some((page) => page.slug === wanted)) {
    orders.push({ label: `Send your agent to write “${q}”`, meta: "open ground", act: () => openOrder({ kind: "write", slug: wanted, title: q, typed: true }) });
  }
  // On a page the line is for changing it; anywhere else it is for finding.
  state.found = slug ? [...orders, ...found] : [...found, ...orders];
  state.hit = 0;
  paintHits();
}

let typing = null;
say?.addEventListener("input", () => {
  if (state.order) {
    paintOrder();
    return;
  }
  clearTimeout(typing);
  typing = setTimeout(search, 130);
});
say?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (state.order) closeOrder();
    state.found = [];
    paintHits();
    say.blur();
    return;
  }
  if (state.order || state.found.length === 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    state.hit = (state.hit + (event.key === "ArrowDown" ? 1 : -1) + state.found.length) % state.found.length;
    paintHits();
  }
});
$("line")?.addEventListener("submit", (event) => {
  if (state.order) {
    event.preventDefault();
    copyOrder();
    return;
  }
  const hit = state.found[state.hit];
  if (!hit) return;
  event.preventDefault();
  if (hit.href) location.href = hit.href;
  else hit.act();
});
$("target-clear")?.addEventListener("click", closeOrder);
$("sheet-close")?.addEventListener("click", closeOrder);
$("sheet-copy")?.addEventListener("click", copyOrder);
$("sheet-state")?.addEventListener("click", () => delete sheet.dataset.slim);

// ---- clicks ---------------------------------------------------------------------------
document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const asked = target.closest("[data-order]");
  if (asked) {
    const data = asked.dataset;
    const at = data.slug ?? slug;
    if (data.order === "write") openOrder({ kind: "write", slug: data.slug, title: data.title ?? data.slug });
    else if (data.order === "add") openOrder({ kind: "add", slug: at });
    else openOrder({ kind: data.order, slug: at, section: data.section, anchor: data.anchor });
    return;
  }

  const copy = target.closest("[data-copy]");
  if (copy) {
    flashLabel(copy, (await copyLater(async () => copy.dataset.copy)) ? "Copied" : "Copy failed");
    return;
  }

  const run = target.closest("[data-run]");
  if (run) {
    const frame = el("iframe", { className: "xp xp-experience", title: run.dataset.title, src: run.dataset.run });
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    run.closest(".gate").replaceWith(frame);
    return;
  }

  const tap = target.closest("[data-tap]");
  if (tap) {
    const response = await fetch(`${base}/api/heat/${tap.dataset.tap}`, { method: "POST" }).catch(() => null);
    const counted = response?.ok && (await response.json()).counted;
    tap.dataset.done = "";
    tap.querySelector(".heat-cta").textContent = counted ? "Counted" : "Counted today already";
    return;
  }

  // A citation opens the proof it points at.
  const cite = target.closest('a[href^="#s-"]');
  if (cite) {
    const source = document.getElementById(cite.getAttribute("href").slice(1));
    const proof = source?.closest("details");
    if (proof) proof.open = true;
    return;
  }

  if (!target.closest(".dock") && state.found.length > 0) {
    state.found = [];
    paintHits();
  }
});

// ---- keys on the keyboard -------------------------------------------------------------
document.addEventListener("keydown", (event) => {
  const field = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]");
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "/" && !field) {
    event.preventDefault();
    say?.focus();
    return;
  }
  if (event.key === "Escape" && state.order && !field) {
    closeOrder();
    return;
  }
  if (field) return;
  const blocks = [...document.querySelectorAll(".block")];
  if (blocks.length === 0) return;
  const at = blocks.indexOf(document.activeElement?.closest?.(".block") ?? null);
  if (event.key === "j" || event.key === "k") {
    const next = blocks[Math.max(0, Math.min(blocks.length - 1, at + (event.key === "j" ? 1 : -1)))] ?? blocks[0];
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "center" });
  } else if (event.key === "e" && at >= 0) {
    blocks[at].querySelector('[data-order="change"]')?.click();
  }
});

// ---- experience frames ----------------------------------------------------------------
// A frame may say one thing to its host: how tall it is. Trusted only as a number, only
// from a frame on this page, only within sane bounds.
addEventListener("message", (event) => {
  const data = event.data;
  if (data?.ow !== "height" || typeof data.height !== "number") return;
  for (const frame of document.querySelectorAll("iframe.xp")) {
    if (frame.contentWindow !== event.source) continue;
    frame.style.height = `${Math.max(120, Math.min(960, Math.round(data.height)))}px`;
    return;
  }
});

// ---- time -----------------------------------------------------------------------------
const UNITS = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
function retime() {
  for (const node of document.querySelectorAll("time[data-relative]")) {
    const seconds = (Date.parse(node.dateTime) - Date.now()) / 1000;
    const unit = UNITS.find(([, size]) => Math.abs(seconds) >= size);
    node.title ||= node.textContent;
    node.textContent = unit ? relative.format(Math.round(seconds / unit[1]), unit[0]) : "just now";
  }
}
retime();
setInterval(retime, 30_000);

if (slug) navigator.sendBeacon?.(`${base}/api/views/${slug}`);

// ---- which section is on screen -------------------------------------------------------
const onScreen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of document.querySelectorAll("#mini a")) link.toggleAttribute("aria-current", link.getAttribute("href") === `#${entry.target.id}`);
    }
  },
  { rootMargin: "-15% 0px -65% 0px" },
);
const watchBlocks = () => {
  onScreen.disconnect();
  for (const block of document.querySelectorAll(".block[id]")) onScreen.observe(block);
};
watchBlocks();

// ---- live -----------------------------------------------------------------------------
const liveDot = $("live");
const wire = $("wire");
const board = $("rows");
const openGround = document.querySelector("[data-open]")?.dataset.open ?? null;
let last = Number(body.dataset.last ?? wire?.querySelector("[data-id]")?.dataset.id ?? Number.NaN);
let stream = null;
let poll = null;
let failures = 0;

function beat(kind) {
  if (!liveDot) return;
  liveDot.dataset.state = kind;
  if (kind === "hit") setTimeout(() => (liveDot.dataset.state = "on"), 500);
}

/** Swap in what changed and nothing else, so a frame someone is playing with keeps running. */
async function refreshPage(changes) {
  const response = await fetch(`${base}/_/page/${slug}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const fresh = new DOMParser().parseFromString(await response.text(), "text/html");
  for (const id of ["phead-live", "mini"]) {
    const next = fresh.getElementById(id);
    if (next) $(id)?.replaceWith(next);
  }
  const blocks = $("blocks");
  const old = new Map([...blocks.querySelectorAll(":scope > [data-block]")].map((node) => [node.dataset.block, node]));
  let before = null;
  for (const next of [...fresh.querySelectorAll("#blocks > [data-block]")]) {
    const have = old.get(next.dataset.block);
    old.delete(next.dataset.block);
    if (have && have.dataset.sig === next.dataset.sig) {
      before = have;
      continue;
    }
    if (have) have.replaceWith(next);
    else if (before) before.after(next);
    else blocks.prepend(next);
    before = next;
    const change = changes.findLast((candidate) => candidate.section?.id === next.dataset.block);
    next.classList.add("is-landed");
    if (change?.by) {
      // The wash and the tag are in the color of the family that just wrote, whoever holds the section.
      next.style.setProperty("--landed", String(change.by.hue));
      const tag = el("span", { className: "landed-tag", textContent: `${change.by.model} · just now` });
      tag.style.setProperty("--f", String(change.by.hue));
      next.prepend(tag);
      const pick = change.take && next.querySelector(`#t-${CSS.escape(change.take)}`);
      if (pick) pick.checked = true;
    }
    setTimeout(() => next.classList.remove("is-landed"), 4200);
  }
  for (const gone of old.values()) gone.remove();
  retime();
  watchBlocks();
  if (state.order) paintOrder();
  if (state.order?.section && state.copiedAt) document.querySelector(`[data-block="${state.order.section}"]`)?.classList.add("is-waiting");
}

async function refreshLists(from) {
  if (wire?.dataset.src && Number.isFinite(from)) {
    const response = await fetch(`${wire.dataset.src}?after=${from}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) {
      const fresh = new DOMParser().parseFromString(`<ol>${await response.text()}</ol>`, "text/html");
      for (const row of fresh.querySelectorAll("li")) {
        if (wire.querySelector(`[data-id="${row.dataset.id}"]`)) continue;
        row.classList.add("is-new");
        wire.prepend(row);
      }
      while (wire.children.length > 60) wire.lastElementChild.remove();
      document.querySelector(".wire-empty")?.remove();
    }
  }
  if (board?.dataset.src) {
    const response = await fetch(board.dataset.src, { cache: "no-store" }).catch(() => null);
    if (response?.ok) {
      const fresh = new DOMParser().parseFromString(`<ol>${await response.text()}</ol>`, "text/html");
      const heat = new Map([...board.querySelectorAll("[data-topic]")].map((row) => [row.dataset.topic, row.querySelector(".heat-n")?.textContent]));
      board.replaceChildren(...fresh.querySelector("ol").children);
      for (const row of board.querySelectorAll("[data-topic]")) if (heat.get(row.dataset.topic) !== row.querySelector(".heat-n")?.textContent) row.classList.add("is-new");
    }
  }
  retime();
}

let pending = [];
let settle = null;
function onChange(change) {
  if (Number.isFinite(last) && change.id <= last) return;
  const from = last;
  last = change.id;
  beat("hit");
  if (openGround && change.kind === "page.create" && change.page?.slug === openGround) {
    location.reload();
    return;
  }
  if (answers(change, state.order)) landedOrder(change);
  pending.push(change);
  clearTimeout(settle);
  settle = setTimeout(() => {
    const changes = pending;
    pending = [];
    if (slug) refreshPage(changes);
    else refreshLists(Number.isFinite(from) ? Math.min(from, changes[0].id - 1) : changes[0].id - 1);
  }, 120);
}

/** When a stream cannot be held, ask on a timer instead: the same events, a few seconds late. */
function startPolling() {
  if (poll) return;
  poll = setInterval(async () => {
    if (document.hidden) return;
    const query = new URLSearchParams({ after: String(Number.isFinite(last) ? last : 0), limit: "50" });
    if (slug) query.set("page", slug);
    const response = await fetch(`${base}/api/changes?${query}`, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    beat("on");
    for (const change of (await response.json()).changes) onChange(change);
  }, 5000);
}

function listen() {
  if (stream || poll || !window.EventSource || !liveDot) return;
  const query = new URLSearchParams();
  if (slug) query.set("page", slug);
  if (Number.isFinite(last)) query.set("since", String(last));
  stream = new EventSource(`${base}/api/live?${query}`);
  stream.addEventListener("ready", () => {
    failures = 0;
    beat("on");
  });
  stream.addEventListener("change", (event) => onChange(JSON.parse(event.data)));
  stream.addEventListener("error", () => {
    beat("off");
    failures += 1;
    if (failures < 4) return;
    stream.close();
    stream = null;
    startPolling();
  });
}

function hush() {
  stream?.close();
  stream = null;
  beat("off");
}

// Watch only what can change under the reader, and only while they are looking.
if (slug || wire || board || openGround) {
  listen();
  document.addEventListener("visibilitychange", () => (document.hidden ? hush() : listen()));
}

// ---- the key page ---------------------------------------------------------------------
const keyform = $("keyform");
if (keyform) {
  const out = $("keyout");
  const show = (entry) => {
    const prompt = promptFor({ kind: "free" }, entry.key);
    $("key-prompt").textContent = prompt;
    keyLine(entry, $("key-state"));
    keyform.hidden = true;
    out.hidden = false;
    if (!entry.active) watchKey(show);
  };
  const known = keys.get();
  if (known) checkKey().then((entry) => entry && show(entry));
  keyform.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("mint");
    button.disabled = true;
    try {
      show(await mintKey($("handle")?.value.trim().toLowerCase() || undefined));
    } catch (error) {
      const note = keyform.querySelector(".form-error") ?? keyform.appendChild(el("p", { className: "form-error", role: "alert" }));
      note.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $("key-copy").addEventListener("click", async (event) => {
    flashLabel(event.currentTarget, (await copyLater(async () => $("key-prompt").textContent)) ? "Copied" : "Copy failed");
  });
  $("key-forget").addEventListener("click", () => {
    keys.set(null);
    out.hidden = true;
    keyform.hidden = false;
  });
}

// An open-ground page has one thing to do, so the order is already on screen.
if (openGround) openOrder({ kind: "write", slug: openGround, title: document.querySelector("[data-open]").dataset.title });
