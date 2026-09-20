// dashboard.js — список карточек, группы, синхронизация с файлом на диске.
import {
  getData,
  getPreviews,
  getMeta,
  setLastSyncedAt,
  addGroup,
  renameGroup,
  removeGroup,
  removeSavedTab,
  moveTabBefore,
  buildExportPayload,
  importPayload,
} from "./storage.js";

// ---------- элементы ----------
const board = document.getElementById("board");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const searchEl = document.getElementById("search");
const tagsEl = document.getElementById("tags");
const syncDot = document.getElementById("sync-dot");
const syncText = document.getElementById("sync-text");

document.getElementById("add-group-btn").addEventListener("click", onAddGroup);
document.getElementById("sync-btn").addEventListener("click", onSyncToFile);
document.getElementById("load-btn").addEventListener("click", onLoadFromFile);
document.getElementById("download-btn").addEventListener("click", onDownloadCopy);
searchEl.addEventListener("input", render);

const fsaSupported = "showSaveFilePicker" in window;

// ---------- режим отображения (карточки / список) ----------
const VIEW_KEY = "tabsaver_view";
let viewMode = "cards";
try {
  const saved = localStorage.getItem(VIEW_KEY);
  if (saved === "list" || saved === "cards") viewMode = saved;
} catch {
  /* localStorage может быть недоступен */
}
const viewCardsBtn = document.getElementById("view-cards");
const viewListBtn = document.getElementById("view-list");
viewCardsBtn.addEventListener("click", () => setView("cards"));
viewListBtn.addEventListener("click", () => setView("list"));

function isListMode() {
  return viewMode === "list";
}
function applyView() {
  board.classList.toggle("view-list", viewMode === "list");
  viewCardsBtn.classList.toggle("active", viewMode === "cards");
  viewListBtn.classList.toggle("active", viewMode === "list");
}
function setView(mode) {
  viewMode = mode;
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    /* игнор */
  }
  applyView();
}

// ---------- фильтр по группам (теги-чипы) ----------
const UNGROUPED = "__ungrouped__";
let activeFilter = "all"; // "all" | groupId | UNGROUPED

function renderTags(data, visibleTabs) {
  tagsEl.innerHTML = "";
  const countIn = (id) =>
    visibleTabs.filter((t) => (t.groupId || null) === id).length;

  const chips = [
    { key: "all", name: "Все", count: visibleTabs.length },
    ...data.groups.map((g) => ({ key: g.id, name: g.name, count: countIn(g.id) })),
  ];
  const ungroupedCount = countIn(null);
  if (ungroupedCount > 0 || data.groups.length) {
    chips.push({ key: UNGROUPED, name: "Без группы", count: ungroupedCount });
  }

  for (const c of chips) {
    const chip = document.createElement("button");
    chip.className = "tag" + (activeFilter === c.key ? " active" : "");
    chip.innerHTML = `${escapeHtml(c.name)}<span class="tag-count">${c.count}</span>`;
    chip.addEventListener("click", () => {
      activeFilter = c.key;
      render();
    });
    tagsEl.appendChild(chip);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch])
  );
}

function sectionMatchesFilter(sectionId) {
  if (activeFilter === "all") return true;
  if (activeFilter === UNGROUPED) return sectionId === null;
  return sectionId === activeFilter;
}

// ---------- порог «давно не синхронизировали» ----------
const DAY = 86400000;
function syncLevel(lastSyncedAt) {
  if (!lastSyncedAt) return { cls: "red", text: "Синхронизация ни разу не выполнялась" };
  const ageDays = (Date.now() - lastSyncedAt) / DAY;
  const ago = humanAgo(lastSyncedAt);
  if (ageDays > 7) return { cls: "red", text: `Давно не синхронизировали · ${ago}` };
  if (ageDays > 3) return { cls: "yellow", text: `Стоит синхронизировать · ${ago}` };
  return { cls: "green", text: `Синхронизировано · ${ago}` };
}
function humanAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "только что";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

async function updateSyncIndicator() {
  const meta = await getMeta();
  const lvl = syncLevel(meta.lastSyncedAt);
  syncDot.className = "dot " + lvl.cls;
  syncText.textContent = lvl.text;
}

// ---------- IndexedDB: храним ссылку на файл между перезагрузками ----------
const IDB_NAME = "tabsaver-fs";
const IDB_STORE = "handles";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(val, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const r = tx.objectStore(IDB_STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

let fileHandle = null;

async function ensurePermission(handle, mode) {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

// ---------- синхронизация в файл ----------
async function onSyncToFile() {
  try {
    if (!fsaSupported) {
      alert(
        "Ваш браузер не поддерживает запись в файл напрямую. Используйте «Скачать копию»."
      );
      return;
    }
    if (!fileHandle) {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: "tabsaver.json",
        types: [
          { description: "TabSaver JSON", accept: { "application/json": [".json"] } },
        ],
      });
      await idbSet("fileHandle", fileHandle);
    }
    if (!(await ensurePermission(fileHandle, "readwrite"))) {
      alert("Нет разрешения на запись в файл.");
      return;
    }
    const payload = await buildExportPayload();
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
    await setLastSyncedAt(Date.now());
    await updateSyncIndicator();
    flashSyncText("Записано в " + (fileHandle.name || "файл"));
  } catch (e) {
    if (e.name !== "AbortError") alert("Ошибка записи: " + e.message);
  }
}

// ---------- загрузка из файла ----------
async function onLoadFromFile() {
  try {
    let handle;
    if (fsaSupported) {
      [handle] = await window.showOpenFilePicker({
        types: [
          { description: "TabSaver JSON", accept: { "application/json": [".json"] } },
        ],
      });
      const file = await handle.getFile();
      const text = await file.text();
      await applyImport(text);
      fileHandle = handle;
      await idbSet("fileHandle", fileHandle);
    } else {
      // запасной путь: обычный input[type=file]
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = async () => {
        const f = input.files[0];
        if (f) await applyImport(await f.text());
      };
      input.click();
    }
  } catch (e) {
    if (e.name !== "AbortError") alert("Ошибка загрузки: " + e.message);
  }
}

async function applyImport(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    alert("Файл не является корректным JSON.");
    return;
  }
  if (
    !confirm(
      "Загрузка заменит текущий список сохранённых вкладок содержимым файла. Продолжить?"
    )
  )
    return;
  try {
    await importPayload(payload);
    await render();
    flashSyncText("Загружено из файла");
  } catch (e) {
    alert(e.message);
  }
}

// ---------- запасной путь: скачать копию ----------
async function onDownloadCopy() {
  const payload = await buildExportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tabsaver.json";
  a.click();
  URL.revokeObjectURL(url);
}

function flashSyncText(msg) {
  const prev = syncText.textContent;
  syncText.textContent = msg;
  setTimeout(() => updateSyncIndicator(), 2500);
}

// ---------- группы ----------
async function onAddGroup() {
  const name = prompt("Название группы:", "Новая группа");
  if (name === null) return;
  await addGroup(name.trim() || "Новая группа");
  await render();
}

// ---------- рендер ----------
async function render() {
  const [data, previews] = await Promise.all([getData(), getPreviews()]);
  const q = searchEl.value.trim().toLowerCase();

  const matches = (t) =>
    !q ||
    (t.title || "").toLowerCase().includes(q) ||
    (t.url || "").toLowerCase().includes(q);

  const visibleTabs = data.tabs.filter(matches);
  countEl.textContent = `${data.tabs.length} вкладок · ${data.groups.length} групп`;

  // сбросить фильтр, если выбранная группа была удалена
  if (
    activeFilter !== "all" &&
    activeFilter !== UNGROUPED &&
    !data.groups.some((g) => g.id === activeFilter)
  ) {
    activeFilter = "all";
  }
  renderTags(data, visibleTabs);

  emptyEl.hidden = data.tabs.length !== 0;
  board.innerHTML = "";

  // секции: каждая группа + «Без группы»
  const sections = [
    ...data.groups.map((g) => ({ id: g.id, name: g.name, isReal: true })),
    { id: null, name: "Без группы", isReal: false },
  ];

  for (const section of sections) {
    if (!sectionMatchesFilter(section.id)) continue;
    const tabs = visibleTabs.filter((t) => (t.groupId || null) === section.id);
    if (tabs.length === 0) {
      if (q) continue; // при поиске пустые секции прячем
      // «Без группы» показываем как drop-цель, только если есть группы
      if (section.id === null && data.groups.length === 0) continue;
    }
    board.appendChild(renderGroup(section, tabs, previews));
  }
}

function renderGroup(section, tabs, previews) {
  const el = document.createElement("section");
  el.className = "group";

  const head = document.createElement("div");
  head.className = "group-head";

  const title = document.createElement("input");
  title.className = "group-title";
  title.value = section.name;
  title.readOnly = !section.isReal;
  if (section.isReal) {
    title.addEventListener("change", async () => {
      await renameGroup(section.id, title.value.trim() || "Группа");
    });
  }

  const badge = document.createElement("span");
  badge.className = "group-badge";
  badge.textContent = tabs.length;

  head.appendChild(title);
  head.appendChild(badge);

  if (section.isReal) {
    const actions = document.createElement("div");
    actions.className = "group-actions";
    const del = document.createElement("button");
    del.className = "btn icon danger";
    del.textContent = "Удалить";
    del.addEventListener("click", async () => {
      if (confirm(`Удалить группу «${section.name}»? Вкладки станут «без группы».`)) {
        await removeGroup(section.id);
        await render();
      }
    });
    actions.appendChild(del);
    head.appendChild(actions);
  }
  el.appendChild(head);

  const cards = document.createElement("div");
  cards.className = "cards" + (tabs.length === 0 ? " empty-drop" : "");
  cards.dataset.groupId = section.id || "";
  attachDropZone(cards);
  for (const t of tabs) cards.appendChild(renderCard(t, previews));
  el.appendChild(cards);
  return el;
}

// ---------- drag & drop ----------
function attachDropZone(container) {
  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const dragging = document.querySelector(".card.dragging");
    if (!dragging) return;
    container.classList.add("drag-over");
    const before = getInsertBefore(container, e.clientX, e.clientY);
    if (before == null) container.appendChild(dragging);
    else container.insertBefore(dragging, before);
  });
  container.addEventListener("dragleave", (e) => {
    if (!container.contains(e.relatedTarget)) container.classList.remove("drag-over");
  });
  container.addEventListener("drop", (e) => {
    e.preventDefault();
    container.classList.remove("drag-over");
  });
}

function getInsertBefore(container, x, y) {
  const els = [...container.querySelectorAll(".card:not(.dragging)")];
  if (!els.length) return null;

  if (isListMode()) {
    for (const el of els) {
      const b = el.getBoundingClientRect();
      if (y < b.top + b.height / 2) return el;
    }
    return null;
  }

  // режим карточек (сетка): ближайшая карточка + до/после по позиции
  let best = null;
  let bestDist = Infinity;
  for (const el of els) {
    const b = el.getBoundingClientRect();
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = el;
    }
  }
  const b = best.getBoundingClientRect();
  const cx = b.left + b.width / 2;
  const after = y > b.bottom ? true : y < b.top ? false : x > cx;
  if (after) {
    let n = best.nextElementSibling;
    while (n && !n.classList.contains("card")) n = n.nextElementSibling;
    return n;
  }
  return best;
}

async function persistDrag(card) {
  const container = card.closest(".cards");
  if (!container) {
    await render();
    return;
  }
  const groupId = container.dataset.groupId || null;
  let before = card.nextElementSibling;
  while (before && !before.classList.contains("card"))
    before = before.nextElementSibling;
  const beforeTabId = before ? before.dataset.tabId : null;
  await moveTabBefore(card.dataset.tabId, groupId, beforeTabId);
  await render();
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "";
  }
}

function renderCard(tab, previews) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.tabId = tab.id;
  card.addEventListener("dragstart", (e) => {
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", tab.id);
  });
  card.addEventListener("dragend", async () => {
    card.classList.remove("dragging");
    document
      .querySelectorAll(".cards.drag-over")
      .forEach((c) => c.classList.remove("drag-over"));
    await persistDrag(card);
  });

  // превью
  const prev = document.createElement("div");
  prev.className = "card-preview";
  const previewSrc = tab.previewRef ? previews[tab.previewRef] : null;
  if (previewSrc) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = previewSrc;
    img.alt = "";
    img.onerror = () => {
      prev.innerHTML = '<span class="fallback">🌐</span>';
    };
    prev.appendChild(img);
  } else {
    prev.innerHTML = '<span class="fallback">🌐</span>';
  }
  card.appendChild(prev);

  const body = document.createElement("div");
  body.className = "card-body";

  const titlerow = document.createElement("div");
  titlerow.className = "card-titlerow";

  const handle = document.createElement("span");
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Перетащите, чтобы переместить";
  titlerow.appendChild(handle);

  if (tab.favIconUrl) {
    const fav = document.createElement("img");
    fav.className = "card-favicon";
    fav.src = tab.favIconUrl;
    fav.alt = "";
    fav.onerror = () => fav.remove();
    titlerow.appendChild(fav);
  }
  const titleText = document.createElement("div");
  titleText.className = "card-title";
  titleText.textContent = tab.title || tab.url;
  titleText.title = tab.title || "";
  titlerow.appendChild(titleText);
  body.appendChild(titlerow);

  const domain = document.createElement("div");
  domain.className = "card-domain";
  domain.textContent = domainOf(tab.url);
  domain.title = tab.url;
  body.appendChild(domain);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const open = document.createElement("a");
  open.className = "card-open";
  open.textContent = "Открыть";
  open.href = tab.url;
  open.target = "_blank";
  open.rel = "noopener";
  actions.appendChild(open);

  const del = document.createElement("button");
  del.className = "card-del";
  del.textContent = "✕";
  del.title = "Удалить";
  del.addEventListener("click", async () => {
    await removeSavedTab(tab.id);
    await render();
  });
  actions.appendChild(del);

  body.appendChild(actions);
  card.appendChild(body);
  return card;
}

// ---------- старт ----------
(async function init() {
  // восстановим ссылку на файл (без запроса разрешения — оно попросится при записи)
  try {
    const saved = await idbGet("fileHandle");
    if (saved) fileHandle = saved;
  } catch {
    /* игнор */
  }
  applyView();
  await updateSyncIndicator();
  await render();
})();
