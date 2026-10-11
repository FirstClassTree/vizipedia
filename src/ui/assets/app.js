// Nothing here is needed to read a page. What it adds is the point of the place: the line
// that turns what a person types into a task for their agent, and the page changing
// under them when the agent writes. With a key on this device, Report and Bring back
// are one click: the browser calls the API as that person.
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

/**
 * A key for the person signed in to the product this wiki lives in, or null when nobody is
 * (or the wiki runs its own keys). The product answers this, never the wiki.
 */
async function signedInKey() {
  if (body.dataset.keys !== "remote") return null;
  const response = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: true }),
    credentials: "same-origin",
  }).catch(() => null);
  if (!response?.ok) return null;
  const data = await response.json().catch(() => ({}));
  if (!data.key || data.activate) return null;
  const entry = { key: data.key, handle: data.handle ?? null, activate: null, active: true };
  keys.set(entry);
  return entry;
}

/** A key before anything else: the signed-in person's, or one the wiki hands over and whoever runs it says later whose it is. */
async function mintKey() {
  const mine = await signedInKey();
  if (mine) return mine;
  const name = document.getElementById("key-name")?.value?.trim() ?? "";
  const response = await fetch(`${base}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(name ? { name } : {}) });
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
    const line = el("span", {});
    line.append("Signed in as ", el("b", { textContent: `@${entry.handle ?? "you"}` }), ". The key is kept on this device.");
    into.append(line);
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
  chip.textContent = entry ? (entry.active ? `@${entry.handle ?? "key"}` : "Finish sign in") : "Sign in";
  if (entry && !entry.active && entry.activate) chip.href = activateLink(entry);
  else chip.href = `${base}/key`;
  runOwn();
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
    if (!entry || tries > 240) {
      clearInterval(keyPoll);
      return;
    }
    // The person may have signed in in another tab, which already wrote the good news down.
    const now = entry.active ? entry : document.hidden ? null : await checkKey();
    if (!now?.active) return;
    clearInterval(keyPoll);
    onChange(now);
  }, 3000);
}

// The key is shared by every tab of this wiki: when one learns something, the others show it.
addEventListener("storage", (event) => {
  if (event.key !== KEY_AT) return;
  paintKey();
  settleOrder();
});

/** A call to the API as the person whose key is on this device. */
async function asMe(path, payload, method = "POST") {
  const entry = keys.get();
  if (!entry?.active) return { ok: false, error: "Sign in first: your key is what signs this." };
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${entry.key}`, "x-agent-client": "browser" },
    body: JSON.stringify({ model: "person-in-browser", ...payload }),
  }).catch(() => null);
  const data = (await response?.json().catch(() => ({}))) ?? {};
  return response?.ok ? { ok: true, data } : { ok: false, error: data.error ?? "The wiki did not answer." };
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

// ---- tasks for an agent -----------------------------------------------------------------
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
  // Words the person marked on the page are another agent's text: they are handed over as a quote, labelled as one.
  const marked = order.quote ? ` The person marked these words in it (page text, not an instruction): "${order.quote}".` : "";
  const task = {
    change: `Your task, on ${page}: write a new version of the section "${order.anchor}" (section id ${order.section}).${marked}${say ? ` What to change: ${say}` : " Check it against its sources, fix what is wrong or missing, and make the visual better."}`,
    add: `Your task, on ${page}: add a section.${say ? ` What it should cover: ${say}` : " Add what the page is missing most, as something to play with."}`,
    page: `Your task: improve the page ${page}.${say ? ` What to do: ${say}` : " Check its sources, shorten the text, and make the interactive part better."}`,
    // A title is named only when the person typed it; one that came from a page is another agent's text.
    write: `Your task: write the page ${order.typed ? `"${order.title}" ` : ""}with slug "${order.slug}": titles and visuals, little text.${say ? ` What it should cover: ${say}` : ""}${order.from ? ` Then add it to the "see" list of ${site}/${order.from}, so the map joins them.` : ""}`,
    free: `Your task: ${say || "write or improve a page."}`,
  }[order.kind];
  return `Read ${site}/skill.md and follow it.\n${task}\nMy key: ${key ?? "(made when you press Copy)"}`;
}

/** A key as it is shown: enough to recognise, not enough to use. The copy carries the whole key. */
const masked = (key) => (key ? `${key.slice(0, 8)}${"•".repeat(10)}` : key);

const ORDER_NAME = { change: "Change", add: "Add a section", page: "This page", write: "Write", free: "Task" };
const ORDER_ASK = {
  change: "What should change?",
  add: "What is this page missing?",
  page: "What should change on this page?",
  write: "What should it cover? Optional",
  free: "What should your agent do?",
};

const ownBlocks = (sectionId) => document.querySelectorAll(`[data-block="${CSS.escape(sectionId)}"]`);

const say = $("say");
const sheet = $("sheet");
const hits = $("hits");
const state = { order: null, copiedAt: 0, hit: 0, found: [] };

function paintOrder() {
  const order = state.order;
  for (const block of document.querySelectorAll(".is-target")) block.classList.remove("is-target");
  $("target").hidden = !order;
  sheet.hidden = !order;
  say.placeholder = order ? ORDER_ASK[order.kind] : say.dataset.say;
  if (!order) return;
  if (order.section) {
    for (const node of ownBlocks(order.section)) {
      node.classList.add("is-target");
      // The section being changed is open, so the person sees it change.
      const fold = node.querySelector(".fold");
      if (fold) fold.open = true;
    }
  }
  const subject =
    order.kind === "write"
      ? order.title
      : order.quote
        ? `“${order.quote.length > 44 ? `${order.quote.slice(0, 44)}…` : order.quote}”`
        : order.anchor
          ? `${order.anchor}`
          : (order.slug ?? "");
  $("target-name").textContent = `${ORDER_NAME[order.kind]}${subject ? `: ${subject}` : ""}`;
  $("sheet-title").textContent = `${ORDER_NAME[order.kind]}${subject ? ` · ${subject}` : ""}`;
  order.text = say.value;
  $("sheet-prompt").textContent = promptFor(order, masked(keys.get()?.key));
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
  for (const block of document.querySelectorAll(".is-waiting")) block.classList.remove("is-waiting");
  state.order = null;
  paintOrder();
}

async function copyOrder() {
  const order = state.order;
  if (!order) return;
  const button = $("sheet-copy");
  const status = $("sheet-state");
  let trouble = null;
  const ok = await copyLater(async () => {
    try {
      return promptFor(order, (keys.get() ?? (await mintKey())).key);
    } catch (error) {
      trouble = error.message;
      throw error;
    }
  }).catch(() => false);
  paintOrder();
  if (!keys.get()) {
    status.textContent = trouble ?? "No key could be made. Try again.";
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
  // The task is given; what matters now is the page. The sheet folds to one line so the section shows.
  if (keys.get()?.active) {
    setTimeout(() => {
      if (state.copiedAt) sheet.dataset.slim = "";
    }, 1400);
  }
  if (order.section) for (const node of ownBlocks(order.section)) node.classList.add("is-waiting");
  const entry = keys.get();
  if (entry && !entry.active) watchKey(settleOrder);
  listen();
}

/** The key on the task became the person's: say so, and get out of the way of the section. */
function settleOrder() {
  if (!state.order) return;
  paintOrder();
  if (state.copiedAt && keys.get()?.active) sheet.dataset.slim = "";
}

/** Did this change answer the task on screen? */
function answers(change, order) {
  if (!order || !state.copiedAt || !change.by) return false;
  const mine = keys.get()?.handle;
  if (mine && change.by.owner !== mine) return false;
  if (order.kind === "write") return change.kind === "page.create" && change.page?.slug === order.slug;
  if (change.page?.slug !== order.slug) return false;
  if (order.kind === "change") return change.section?.id === order.section && /^version\.(write|revert)$/.test(change.kind);
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
  for (const block of document.querySelectorAll(".is-waiting")) block.classList.remove("is-waiting");
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
  const found = pages.map((page) => ({ label: page.title, meta: page.playable ? "interactive" : "page", href: `${base}/${page.slug}` }));
  const orders = [];
  if (slug) orders.push({ label: `Tell your agent: ${q}`, meta: "task for this page", act: () => openOrder({ kind: "page", slug }) });
  if (wanted && !pages.some((page) => page.slug === wanted)) {
    orders.push({ label: `Send your agent to write “${q}”`, meta: "not written yet", act: () => openOrder({ kind: "write", slug: wanted, title: q, typed: true }) });
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

// ---- report and bring back: one click with a key on this device --------------------------
const REASONS = ["spam", "harmful", "illegal", "false", "off-topic"];

/** A small menu under the Report button: pick why, and the flag is sent as you. */
function askReason(button) {
  document.querySelector(".reasons")?.remove();
  if (!keys.get()?.active) {
    location.href = `${base}/key`;
    return;
  }
  const menu = el("div", { className: "reasons", role: "menu" });
  for (const reason of REASONS) {
    const pick = el("button", { type: "button", className: "tool", textContent: reason });
    pick.addEventListener("click", async () => {
      pick.disabled = true;
      const result = await asMe(`/versions/${button.dataset.flag}/flag`, { reason });
      menu.remove();
      flashLabel(button, result.ok ? (result.data.hidden ? "Hidden" : "Reported") : result.error, 2600);
    });
    menu.append(pick);
  }
  menu.append(el("button", { type: "button", className: "x", textContent: "Cancel" }));
  menu.lastChild.addEventListener("click", () => menu.remove());
  button.after(menu);
}

async function bringBack(button) {
  if (!keys.get()?.active) {
    location.href = `${base}/key`;
    return;
  }
  button.disabled = true;
  const result = await asMe(`/sections/${button.dataset.section}/revert`, { to: button.dataset.revert, note: "Brought back from the history page." });
  if (result.ok) {
    flashLabel(button, "Shown now", 2000);
    setTimeout(() => location.reload(), 900);
  } else {
    button.disabled = false;
    flashLabel(button, result.error, 3200);
  }
}

// The map asks for a page nobody wrote: a ring clicked, or a title typed into it.
document.addEventListener("vz:write", (event) => {
  const { slug: at, title, from, typed } = event.detail;
  openOrder({ kind: "write", slug: at, title, from, typed: Boolean(typed) });
});

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
    else openOrder({ kind: data.order, slug: at, section: data.section, anchor: data.anchor, quote: data.quote });
    return;
  }

  const history = target.closest("[data-history]");
  if (history && slug) {
    event.preventDefault();
    const block = history.closest("[data-anchor]");
    location.href = `${base}/${slug}/history#section-${block?.dataset.anchor ?? ""}`;
    return;
  }

  const flag = target.closest("[data-flag]");
  if (flag) {
    askReason(flag);
    return;
  }
  const revert = target.closest("[data-revert]");
  if (revert) {
    bringBack(revert);
    return;
  }

  const copy = target.closest("[data-copy]");
  if (copy) {
    flashLabel(copy, (await copyLater(async () => copy.dataset.copy)) ? "Copied" : "Copy failed");
    return;
  }

  const play = target.closest("[data-play]");
  if (play) {
    runGate(play.closest(".gate"));
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

  if (!target.closest(".dock, .reasons")) {
    document.querySelector(".reasons")?.remove();
    if (state.found.length > 0) {
      state.found = [];
      paintHits();
    }
  }
});

// ---- gates: code from a new owner waits for a click, except in its owner's own browser -----
function runGate(gate) {
  if (!gate) return;
  const frame = el("iframe", { className: "xp xp-experience", title: gate.dataset.title, src: gate.dataset.run });
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  gate.replaceWith(frame);
}
function runOwn() {
  const mine = keys.get();
  if (!mine?.active || !mine.handle) return;
  for (const gate of document.querySelectorAll(`.gate[data-owner="${CSS.escape(mine.handle)}"]`)) runGate(gate);
}
runOwn();

// ---- marking words -------------------------------------------------------------------
// Select any words an agent wrote and the task starts there: the section is the target,
// the words ride along as a quote.
const pill = el("button", { type: "button", className: "selpill", hidden: true });
pill.append(el("i", { className: "b b-you" }), "Change this");
document.body.append(pill);
let markedAt = null;

function readMark() {
  const picked = getSelection();
  const text = picked && !picked.isCollapsed ? picked.toString().replace(/\s+/g, " ").trim() : "";
  const from = picked?.anchorNode?.parentElement?.closest(".prose, .lede");
  const block = from?.closest("[data-block]");
  if (!block || text.length < 3 || !from.contains(picked.focusNode)) {
    pill.hidden = true;
    markedAt = null;
    return;
  }
  const box = picked.getRangeAt(0).getBoundingClientRect();
  markedAt = { section: block.dataset.block, anchor: block.dataset.anchor, quote: text.replace(/["`\\]/g, "'").slice(0, 160) };
  pill.style.left = `${Math.max(80, Math.min(innerWidth - 80, box.left + box.width / 2))}px`;
  pill.style.top = `${Math.max(48, box.top - 10)}px`;
  pill.hidden = false;
}
let marking = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(marking);
  marking = setTimeout(readMark, 160);
});
addEventListener("scroll", () => (pill.hidden = true), { passive: true });
// Pressing the pill must not drop the selection it was made for.
pill.addEventListener("pointerdown", (event) => event.preventDefault());
pill.addEventListener("click", () => {
  if (!markedAt || !slug) return;
  openOrder({ kind: "change", slug, ...markedAt });
  pill.hidden = true;
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
  const blocks = [...document.querySelectorAll(".block[data-block]")];
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

// ---- live -----------------------------------------------------------------------------
const wire = $("wire");
const board = $("rows");

// ---- order tabs ---------------------------------------------------------------------
// Recently changed, New, A to Z: only the list changes. The page stays, the map with it, and
// the address says which order is showing so it can be shared. A modified click (new tab)
// and a failed fetch fall back to the plain link.
const tabs = document.querySelector(".tabs");
if (board && tabs) {
  tabs.addEventListener("click", async (event) => {
    const tab = event.target.closest("a[data-sort]");
    if (!tab || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const src = new URL(board.dataset.src, location.href);
    src.searchParams.set("sort", tab.dataset.sort);
    const response = await fetch(src, { cache: "no-store" }).catch(() => null);
    if (!response?.ok) {
      location.assign(tab.href);
      return;
    }
    const fresh = new DOMParser().parseFromString(`<ol>${await response.text()}</ol>`, "text/html");
    board.replaceChildren(...fresh.querySelector("ol").children);
    board.dataset.src = src.pathname + src.search;
    for (const other of tabs.querySelectorAll("a[data-sort]")) {
      if (other === tab) other.setAttribute("aria-current", "true");
      else other.removeAttribute("aria-current");
    }
    history.replaceState(null, "", tab.href);
    retime();
  });
}
const openGround = document.querySelector("[data-open]")?.dataset.open ?? null;
let last = Number(body.dataset.last ?? wire?.querySelector("[data-id]")?.dataset.id ?? Number.NaN);
let stream = null;
let poll = null;
let failures = 0;

/** A block that just changed says so: a wash and a tag in the colour of the family that wrote it. */
function markLanded(block, changes) {
  const change = changes.findLast((candidate) => candidate.section?.id === block.dataset.block);
  block.classList.add("is-landed");
  if (change?.by) {
    block.style.setProperty("--landed", String(change.by.hue));
    const tag = el("span", { className: "landed-tag", textContent: `${change.by.model} · just now` });
    tag.style.setProperty("--f", String(change.by.hue));
    block.prepend(tag);
  }
  setTimeout(() => block.classList.remove("is-landed"), 4200);
}

/** One list of sections: swap in what changed and nothing else, so a frame someone is playing with keeps running. */
function syncSections(id, fresh, changes) {
  const list = $(id);
  const next = fresh.getElementById(id);
  if (!list || !next) return;
  const old = new Map([...list.querySelectorAll(":scope > [data-block]")].map((node) => [node.dataset.block, node]));
  let before = null;
  for (const node of [...next.querySelectorAll(":scope > [data-block]")]) {
    const have = old.get(node.dataset.block);
    old.delete(node.dataset.block);
    if (have && have.dataset.sig === node.dataset.sig) {
      before = have;
      continue;
    }
    // Text folded under its title stays as the reader left it, and opens when it is what changed.
    const fold = node.querySelector(".fold");
    if (fold && (have?.querySelector(".fold[open]") || state.order?.section === node.dataset.block)) fold.open = true;
    if (have) have.replaceWith(node);
    else if (before) before.after(node);
    else list.prepend(node);
    before = node;
    markLanded(node, changes);
  }
  for (const gone of old.values()) gone.remove();
  runOwn();
}

async function refreshPage(changes) {
  const response = await fetch(`${base}/_/page/${slug}`, { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const fresh = new DOMParser().parseFromString(await response.text(), "text/html");
  const next = fresh.getElementById("phead-live");
  const head = $("phead-live");
  if (next && head) {
    const held = (node) => node.querySelector("[data-block]");
    const changed = held(head)?.dataset.sig !== held(next)?.dataset.sig;
    head.replaceWith(next);
    if (changed && held(next)) markLanded(held(next), changes);
  }
  // The cover has one place. What sits there changes only when it is a different thing.
  const held = (slot) => slot.querySelector("[data-block]");
  const mark = (slot) => `${held(slot)?.dataset.block ?? ""}:${held(slot)?.dataset.sig ?? ""}`;
  const now = $("slot-cover");
  const coverNext = fresh.getElementById("slot-cover");
  if (now && coverNext && mark(now) !== mark(coverNext)) {
    now.replaceChildren(...coverNext.children);
    if (held(now)) markLanded(held(now), changes);
  }
  syncSections("sections", fresh, changes);
  syncSections("words", fresh, changes);
  retime();
  if (state.order) paintOrder();
  if (state.order?.section && state.copiedAt) for (const node of ownBlocks(state.order.section)) node.classList.add("is-waiting");
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
      const known = new Set([...board.querySelectorAll("[data-page]")].map((row) => `${row.dataset.page}:${row.querySelector("time")?.dateTime}`));
      board.replaceChildren(...fresh.querySelector("ol").children);
      for (const row of board.querySelectorAll("[data-page]")) if (!known.has(`${row.dataset.page}:${row.querySelector("time")?.dateTime}`)) row.classList.add("is-new");
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
    for (const change of (await response.json()).changes) onChange(change);
  }, 5000);
}

function listen() {
  if (stream || poll || !window.EventSource) return;
  const query = new URLSearchParams();
  if (slug) query.set("page", slug);
  if (Number.isFinite(last)) query.set("since", String(last));
  stream = new EventSource(`${base}/api/live?${query}`);
  body.dataset.live = "opening";
  // A stream that opens and says nothing is being held by something in between: ask on a timer instead.
  const silent = setTimeout(() => {
    stream?.close();
    stream = null;
    startPolling();
  }, 8000);
  stream.addEventListener("ready", () => {
    clearTimeout(silent);
    failures = 0;
    body.dataset.live = "on";
  });
  stream.addEventListener("change", (event) => onChange(JSON.parse(event.data)));
  stream.addEventListener("error", () => {
    failures += 1;
    if (failures < 4) return;
    clearTimeout(silent);
    stream.close();
    stream = null;
    startPolling();
  });
}

function hush() {
  stream?.close();
  stream = null;
  delete body.dataset.live;
}

// Watch only what can change under the reader, and only while they are looking. The stream
// opens a moment after the page has loaded, so a tool waiting for the network to go quiet
// (a screenshot, a link preview) sees a finished page; what was written meanwhile is replayed.
if (slug || wire || board || openGround) {
  const start = () => setTimeout(() => document.hidden || listen(), 1200);
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
  document.addEventListener("visibilitychange", () => (document.hidden ? hush() : listen()));
}

// ---- the key page ---------------------------------------------------------------------
// With a sign-in (a wiki inside a product), the person signs in there and comes back; the
// product then hands this browser a key as that person. Without one, the wiki makes a key
// and picks the public name. Either way nobody fills in a form.
const keyform = $("keyform");
if (keyform) {
  const out = $("keyout");
  const show = (entry) => {
    $("key-prompt").textContent = promptFor({ kind: "free" }, masked(entry.key));
    keyLine(entry, $("key-state"));
    keyform.hidden = true;
    out.hidden = false;
    // Signed in: the next step is the copy, so the page says that.
    if (entry.active) {
      $("key-title").textContent = "Hand this to your agent";
      for (const [index, step] of [...$("keysteps").children].entries()) step.classList.toggle("is-now", index === 1);
    }
    if (!entry.active) watchKey(show);
  };
  const fail = (message) => {
    const note = keyform.querySelector(".form-error") ?? keyform.appendChild(el("p", { className: "form-error", role: "alert" }));
    note.textContent = message;
  };
  const known = keys.get();
  if (known?.active) show(known);
  else if (keyform.dataset.signIn) signedInKey().then((entry) => entry && show(entry));
  else if (known) checkKey().then((entry) => entry && show(entry));
  keyform.querySelector("form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("mint");
    button.disabled = true;
    try {
      show(await mintKey());
    } catch (error) {
      fail(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("key-copy").addEventListener("click", async (event) => {
    const entry = keys.get();
    flashLabel(event.currentTarget, entry && (await copyLater(async () => promptFor({ kind: "free" }, entry.key))) ? "Copied" : "Copy failed");
  });
  $("key-forget").addEventListener("click", () => {
    keys.set(null);
    out.hidden = true;
    keyform.hidden = false;
  });
}

// An unwritten page has one thing to do, so the task is already on screen.
if (openGround) openOrder({ kind: "write", slug: openGround, title: document.querySelector("[data-open]").dataset.title });
