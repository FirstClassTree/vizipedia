// The reading side's only script: frame heights, copy buttons, the agent dialog, the
// run-it gate, one view ping, friendlier times. Nothing here is needed to read a page.
const base = document.body.dataset.base ?? "";

// An experience may say one thing to its host: how tall it is. The message is trusted
// only as a number, only from a frame on this page, and only within sane bounds.
addEventListener("message", (event) => {
  const data = event.data;
  if (data?.ow !== "height" || typeof data.height !== "number") return;
  for (const frame of document.querySelectorAll("iframe.xp")) {
    if (frame.contentWindow !== event.source) continue;
    frame.style.height = `${Math.max(120, Math.min(960, Math.round(data.height)))}px`;
    return;
  }
});

document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const copy = target?.closest("[data-copy]");
  if (copy) {
    navigator.clipboard.writeText(copy.dataset.copy).then(() => {
      const label = copy.textContent;
      copy.textContent = "Copied";
      copy.dataset.done = "";
      setTimeout(() => {
        copy.textContent = label;
        delete copy.dataset.done;
      }, 1600);
    });
    return;
  }
  const run = target?.closest("[data-run]");
  if (run) {
    const frame = document.createElement("iframe");
    frame.className = `xp xp-${run.dataset.surface}`;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = run.dataset.title;
    frame.src = run.dataset.run;
    run.closest(".xp-gate").replaceWith(frame);
    return;
  }
  const opener = target?.closest("[data-dialog]");
  if (opener) {
    document.getElementById(opener.dataset.dialog)?.showModal?.();
    return;
  }
  if (target?.tagName === "DIALOG") target.close();
});

if (document.body.dataset.slug) navigator.sendBeacon?.(`${base}/api/views/${document.body.dataset.slug}`);

const UNITS = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
for (const node of document.querySelectorAll("time[data-relative]")) {
  const seconds = (Date.parse(node.dateTime) - Date.now()) / 1000;
  const unit = UNITS.find(([, size]) => Math.abs(seconds) >= size);
  node.title = node.textContent;
  node.textContent = unit ? relative.format(Math.round(seconds / unit[1]), unit[0]) : "just now";
}

const tocLinks = new Map([...document.querySelectorAll(".toc a")].map((link) => [link.getAttribute("href").slice(1), link]));
if (tocLinks.size > 0) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of tocLinks.values()) link.removeAttribute("aria-current");
        tocLinks.get(entry.target.id)?.setAttribute("aria-current", "true");
      }
    },
    { rootMargin: "-10% 0px -70% 0px" },
  );
  for (const section of document.querySelectorAll(".sec[id]")) observer.observe(section);
}
