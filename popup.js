// popup.js — мультивыбор открытых вкладок (Shift-диапазон) + сохранение в группу.
import { getData, addGroup, addSavedTab } from "./storage.js";

const groupSelect = document.getElementById("group-select");
const listEl = document.getElementById("tab-list");
const selectAll = document.getElementById("select-all");
const selCount = document.getElementById("sel-count");
const saveBtn = document.getElementById("save-btn");
const saveCloseBtn = document.getElementById("save-close-btn");
const statusEl = document.getElementById("status");
const openDashboardBtn = document.getElementById("open-dashboard");

const MAX_PREVIEW_BYTES = 12 * 1024;
const PREVIEW_MAX_WIDTH = 360;

let tabsArr = []; // { id, title, url, favIconUrl, active, windowId }
const selected = new Set(); // выбранные chrome tab id
let lastIndex = null; // для Shift-диапазона
let prevGroupValue = ""; // чтобы откатить выбор при отмене создания группы

init();

async function init() {
  await loadGroups();
  await loadTabs();

  groupSelect.addEventListener("change", onGroupChange);
  selectAll.addEventListener("change", onSelectAll);
  saveBtn.addEventListener("click", () => handleSave(false));
  saveCloseBtn.addEventListener("click", () => handleSave(true));
  openDashboardBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  });
}

// ---------- группы ----------
async function loadGroups(selectId = "") {
  const data = await getData();
  groupSelect.innerHTML = "";
  const none = new Option("Без группы", "");
  groupSelect.add(none);
  for (const g of data.groups) groupSelect.add(new Option(g.name, g.id));
  groupSelect.add(new Option("➕ Новая группа…", "__new__"));
  groupSelect.value = selectId;
  prevGroupValue = selectId;
}

async function onGroupChange() {
  if (groupSelect.value === "__new__") {
    const name = prompt("Название новой группы:", "Новая группа");
    if (name === null || !name.trim()) {
      groupSelect.value = prevGroupValue; // отмена — вернуть прежнее
      return;
    }
    const g = await addGroup(name.trim());
    await loadGroups(g.id); // перестроить и выбрать созданную
  } else {
    prevGroupValue = groupSelect.value;
  }
}

// ---------- список вкладок ----------
async function loadTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  tabsArr = tabs.map((t) => ({
    id: t.id,
    title: t.title || t.url,
    url: t.url || "",
    favIconUrl: t.favIconUrl || "",
    active: t.active,
    windowId: t.windowId,
  }));
  // по умолчанию выбрана активная вкладка
  const active = tabsArr.find((t) => t.active);
  if (active) {
    selected.add(active.id);
    lastIndex = tabsArr.indexOf(active);
  }
  renderList();
}

function renderList() {
  listEl.innerHTML = "";
  tabsArr.forEach((t, idx) => {
    const li = document.createElement("li");
    li.className = "tab-row" + (selected.has(t.id) ? " selected" : "");
    li.dataset.index = idx;

    const box = document.createElement("span");
    box.className = "checkbox";

    const fav = document.createElement("img");
    fav.className = "fav";
    fav.src = t.favIconUrl || "";
    fav.alt = "";
    fav.onerror = () => {
      fav.replaceWith(Object.assign(document.createElement("span"), {
        className: "fav-fallback",
        textContent: "🌐",
      }));
    };

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = t.title;
    title.title = t.url;

    li.append(box, fav, title);
    li.addEventListener("click", (e) => onRowClick(e, idx));
    listEl.appendChild(li);
  });
  updateCount();
}

function onRowClick(e, idx) {
  if (e.shiftKey && lastIndex !== null) {
    const [a, b] = [Math.min(lastIndex, idx), Math.max(lastIndex, idx)];
    for (let i = a; i <= b; i++) selected.add(tabsArr[i].id);
  } else {
    const id = tabsArr[idx].id;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    lastIndex = idx;
  }
  renderList();
}

function onSelectAll() {
  if (selectAll.checked) tabsArr.forEach((t) => selected.add(t.id));
  else selected.clear();
  renderList();
}

function updateCount() {
  const n = selected.size;
  selCount.textContent = `${n} выбрано`;
  saveBtn.textContent = n > 1 ? `Сохранить выбранные (${n})` : "Сохранить вкладку";
  saveCloseBtn.textContent = n > 1 ? `Сохранить и закрыть (${n})` : "Сохранить и закрыть";
  saveBtn.disabled = n === 0;
  saveCloseBtn.disabled = n === 0;
  selectAll.checked = n > 0 && n === tabsArr.length;
  selectAll.indeterminate = n > 0 && n < tabsArr.length;
}

// ---------- превью (только для активной вкладки) ----------
async function capturePreview(tab) {
  const restricted =
    !tab.url || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url);
  if (restricted) return null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const m = document.querySelector(
          'meta[property="og:image"], meta[name="og:image"], meta[property="og:image:url"]'
        );
        const href = m && m.content ? m.content : null;
        try {
          return href ? new URL(href, location.href).href : null;
        } catch {
          return href;
        }
      },
    });
    if (res && res.result) return res.result;
  } catch {
    /* нет доступа */
  }
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 70,
    });
    return await compressToWebp(shot);
  } catch {
    return null;
  }
}

function compressToWebp(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, PREVIEW_MAX_WIDTH / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      let q = 0.5;
      let out = canvas.toDataURL("image/webp", q);
      while (out.length * 0.75 > MAX_PREVIEW_BYTES && q > 0.2) {
        q -= 0.1;
        out = canvas.toDataURL("image/webp", q);
      }
      resolve(out.length * 0.75 > MAX_PREVIEW_BYTES ? null : out);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ---------- сохранение ----------
function showStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.hidden = false;
}

async function handleSave(alsoClose) {
  const chosen = tabsArr.filter((t) => selected.has(t.id));
  if (!chosen.length) return;
  saveBtn.disabled = true;
  saveCloseBtn.disabled = true;
  showStatus("Сохраняю…");

  const groupId = groupSelect.value && groupSelect.value !== "__new__"
    ? groupSelect.value
    : null;

  try {
    let withPreview = 0;
    for (const t of chosen) {
      // превью только для активной вкладки (ограничение Chrome)
      const preview = t.active ? await capturePreview(t) : null;
      if (preview) withPreview++;
      await addSavedTab(
        { title: t.title, url: t.url, favIconUrl: t.favIconUrl },
        groupId,
        preview
      );
    }

    const n = chosen.length;
    showStatus(
      n === 1 ? "Сохранено ✓" : `Сохранено вкладок: ${n} ✓`,
      "ok"
    );

    if (alsoClose) {
      const ids = chosen.map((t) => t.id).filter((id) => id != null);
      setTimeout(() => chrome.tabs.remove(ids), 250);
      setTimeout(() => window.close(), 320);
    } else {
      // сбросить выбор, обновить список (вкладки могли остаться)
      selected.clear();
      lastIndex = null;
      renderList();
      saveBtn.disabled = false;
      saveCloseBtn.disabled = false;
    }
  } catch (e) {
    showStatus("Ошибка: " + e.message, "err");
    saveBtn.disabled = false;
    saveCloseBtn.disabled = false;
  }
}
