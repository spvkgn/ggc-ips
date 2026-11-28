"use strict";

/* ---------- State ---------- */

const state = {
  index: null,
  /** code -> country entry (O(1) lookup) */
  countriesByCode: new Map(),
  active: null,
  /** code -> string[] (resolved prefixes) */
  cache: new Map(),
  /** code -> Promise<string[]> (in-flight fetches) */
  pending: new Map(),
  /** rendered list entries: { li, btn, haystack } */
  listItems: [],
  noMatchesLi: null,
};

const el = {
  meta: document.getElementById("meta"),
  search: document.getElementById("search"),
  aside: document.querySelector("aside"),
  countries: document.getElementById("countries"),
  content: document.getElementById("content"),
  toast: document.getElementById("toast"),
};

/* ---------- Small utilities ---------- */

let toastTimer = 0;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 1600);
}

async function tryCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copy(text) {
  toast((await tryCopy(text)) ? "Copied" : "Copy failed");
}

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
}

/* ---------- Rendering ---------- */

function renderMeta() {
  if (!state.index) return;
  const n = state.index.countries.length;
  el.meta.textContent =
    `${n} ${n === 1 ? "country" : "countries"} · updated ${fmtDate(state.index.generated_at)}`;
}

function renderCountries() {
  const frag = document.createDocumentFragment();
  state.listItems = [];

  for (const c of state.index.countries) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.code = c.code;
    btn.setAttribute("aria-pressed", "false");

    const label = document.createElement("span");
    label.textContent = `${c.name} (${c.code})`;

    const count = document.createElement("span");
    count.className = "count";
    count.textContent = c.prefixes;

    btn.append(label, count);
    li.append(btn);
    frag.append(li);

    state.listItems.push({
      li,
      btn,
      haystack: `${c.name} ${c.code}`.toLowerCase(),
    });
  }

  const noMatches = document.createElement("li");
  noMatches.className = "placeholder";
  noMatches.textContent = "No matches";
  noMatches.hidden = true;
  frag.append(noMatches);

  el.countries.replaceChildren(frag);
  state.noMatchesLi = noMatches;
}

function applyFilter() {
  const filter = el.search.value.trim().toLowerCase();
  let visible = 0;
  for (const { li, haystack } of state.listItems) {
    const match = !filter || haystack.includes(filter);
    li.hidden = !match;
    if (match) visible++;
  }
  if (state.noMatchesLi) state.noMatchesLi.hidden = visible !== 0;
  // Reset scroll so the user sees filtered results from the top.
  el.aside.scrollTop = 0;
}

function setActive(code) {
  state.active = code;
  let activeBtn = null;
  for (const { btn } of state.listItems) {
    const isActive = btn.dataset.code === code;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
    if (isActive) activeBtn = btn;
  }
  if (activeBtn) activeBtn.scrollIntoView({ block: "nearest" });
}

function showPlaceholder(text) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.textContent = text;
  el.content.replaceChildren(div);
}

function showError(msg) {
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = msg;
  el.content.replaceChildren(div);
}

/* ---------- Data loading ---------- */

function loadCountry(code) {
  if (state.cache.has(code)) return Promise.resolve(state.cache.get(code));
  if (state.pending.has(code)) return state.pending.get(code);

  const entry = state.countriesByCode.get(code);
  if (!entry) return Promise.reject(new Error(`Unknown country ${code}`));

  const p = (async () => {
    const res = await fetch(entry.file);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${entry.file}`);
    const text = await res.text();
    const prefixes = text.split("\n").map(s => s.trim()).filter(Boolean);
    state.cache.set(code, prefixes);
    return prefixes;
  })();

  state.pending.set(code, p);
  p.finally(() => state.pending.delete(code)).catch(() => {});
  return p;
}

/* ---------- Selection ---------- */

async function select(code, opts = {}) {
  const entry = state.countriesByCode.get(code);
  if (!entry) return;

  // No-op when this country is already active. Two exceptions:
  // - opts.force: caller explicitly asks for a re-render
  // - previous attempt errored: cache/pending are empty, so allow a retry
  if (!opts.force && state.active === code &&
      (state.cache.has(code) || state.pending.has(code))) {
    return;
  }

  setActive(code);

  if (!opts.skipUrl) {
    const url = new URL(location.href);
    if (url.searchParams.get("c") !== code.toLowerCase()) {
      url.searchParams.set("c", code.toLowerCase());
      history.pushState({ code }, "", url);
    }
  }

  const head = document.createElement("div");
  head.className = "country-head";

  const title = document.createElement("h2");
  title.textContent = `${entry.name} · ${entry.code}`;

  const actions = document.createElement("div");
  actions.className = "actions";

  const dl = document.createElement("a");
  dl.href = entry.file;
  dl.textContent = "Download .txt";
  dl.setAttribute("download", "");

  const raw = document.createElement("a");
  raw.href = entry.file;
  raw.textContent = "Open raw ↗";
  raw.target = "_blank";
  raw.rel = "noopener";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.textContent = "Copy all";
  copyBtn.addEventListener("click", async () => {
    try {
      const prefixes = await loadCountry(code);
      await copy(prefixes.join("\n"));
    } catch (e) {
      toast(`Copy failed: ${e.message}`);
    }
  });

  actions.append(dl, raw, copyBtn);
  head.append(title, actions);

  const pre = document.createElement("pre");
  pre.textContent = "Loading…";

  el.content.replaceChildren(head, pre);

  try {
    const prefixes = await loadCountry(code);
    if (state.active !== code) return;
    pre.textContent = prefixes.join("\n");
    title.textContent = `${entry.name} · ${entry.code} · ${prefixes.length} prefixes`;
  } catch (e) {
    if (state.active !== code) return;
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = `Failed to load ${entry.file}: ${e.message}`;
    pre.replaceWith(err);
  }
}

/* ---------- Events ---------- */

el.countries.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-code]");
  if (btn) select(btn.dataset.code);
});

let searchRaf = 0;
el.search.addEventListener("input", () => {
  if (searchRaf) return;
  searchRaf = requestAnimationFrame(() => {
    searchRaf = 0;
    applyFilter();
  });
});

window.addEventListener("popstate", () => {
  if (!state.index) return;
  const code = (new URLSearchParams(location.search).get("c") || "").toUpperCase();
  if (code && state.countriesByCode.has(code)) {
    select(code, { skipUrl: true });
  } else {
    setActive(null);
    showPlaceholder("Select a country to view its prefixes.");
  }
});

/* ---------- Init ---------- */

async function init() {
  try {
    const res = await fetch("index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.index = await res.json();
  } catch (e) {
    el.meta.textContent = "Failed to load index.json";
    showError(`Failed to load index.json: ${e.message}`);
    return;
  }

  state.countriesByCode = new Map(state.index.countries.map(c => [c.code, c]));

  renderMeta();
  renderCountries();
  applyFilter();

  const code = (new URLSearchParams(location.search).get("c") || "").toUpperCase();
  if (code && state.countriesByCode.has(code)) {
    select(code, { skipUrl: true });
  }
}

init();