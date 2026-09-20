// storage.js — общий модуль работы с данными TabSaver.
// Рабочие данные живут в chrome.storage.local. Превью — отдельным блоком,
// чтобы tabs.json (текстовый бэкап) оставался лёгким и читаемым.

const KEY_DATA = "tabsaver_data"; // { groups: [...], tabs: [...] }
const KEY_PREVIEWS = "tabsaver_previews"; // { [tabId]: dataUrl }
const KEY_META = "tabsaver_meta"; // { lastSyncedAt: number|null }

// ---------- низкоуровневые обёртки ----------

function get(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (res) => {
      resolve(res[key] === undefined ? fallback : res[key]);
    });
  });
}

function set(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

// ---------- данные (группы + вкладки) ----------

const DEFAULT_DATA = { groups: [], tabs: [] };

export async function getData() {
  const data = await get(KEY_DATA, null);
  if (!data) return structuredClone(DEFAULT_DATA);
  // страховка от неполного объекта
  return {
    groups: Array.isArray(data.groups) ? data.groups : [],
    tabs: Array.isArray(data.tabs) ? data.tabs : [],
  };
}

export async function saveData(data) {
  await set(KEY_DATA, data);
  return data;
}

// ---------- превью ----------

export async function getPreviews() {
  return get(KEY_PREVIEWS, {});
}

export async function setPreview(tabId, dataUrl) {
  if (!dataUrl) return;
  const previews = await getPreviews();
  previews[tabId] = dataUrl;
  await set(KEY_PREVIEWS, previews);
}

export async function removePreview(tabId) {
  const previews = await getPreviews();
  if (previews[tabId] !== undefined) {
    delete previews[tabId];
    await set(KEY_PREVIEWS, previews);
  }
}

// ---------- метаданные / синхронизация ----------

export async function getMeta() {
  return get(KEY_META, { lastSyncedAt: null });
}

export async function setLastSyncedAt(ts) {
  const meta = await getMeta();
  meta.lastSyncedAt = ts;
  await set(KEY_META, meta);
  return meta;
}

// ---------- операции с вкладками ----------

// tabInfo: { title, url, favIconUrl }
export async function addSavedTab(tabInfo, groupId = null, previewDataUrl = null) {
  const data = await getData();
  const id = uid("t");
  const entry = {
    id,
    title: tabInfo.title || tabInfo.url || "Без названия",
    url: tabInfo.url || "",
    favIconUrl: tabInfo.favIconUrl || "",
    groupId: groupId || null,
    savedAt: Date.now(),
    previewRef: previewDataUrl ? id : null,
  };
  data.tabs.unshift(entry);
  await saveData(data);
  if (previewDataUrl) await setPreview(id, previewDataUrl);
  return entry;
}

export async function removeSavedTab(tabId) {
  const data = await getData();
  data.tabs = data.tabs.filter((t) => t.id !== tabId);
  await saveData(data);
  await removePreview(tabId);
}

export async function moveTabToGroup(tabId, groupId) {
  const data = await getData();
  const tab = data.tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.groupId = groupId || null;
    await saveData(data);
  }
  return data;
}

// Перенос вкладки в группу groupId и вставка перед вкладкой beforeTabId.
// Если beforeTabId == null — в конец группы. Один метод и для смены группы,
// и для изменения порядка внутри группы (drag & drop).
export async function moveTabBefore(tabId, groupId, beforeTabId) {
  const data = await getData();
  const idx = data.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return data;

  const [tab] = data.tabs.splice(idx, 1);
  tab.groupId = groupId || null;

  let insertAt;
  if (beforeTabId) {
    insertAt = data.tabs.findIndex((t) => t.id === beforeTabId);
    if (insertAt === -1) insertAt = data.tabs.length;
  } else {
    // после последней вкладки этой же группы; если группа пуста — в конец
    let last = -1;
    data.tabs.forEach((t, i) => {
      if ((t.groupId || null) === (groupId || null)) last = i;
    });
    insertAt = last === -1 ? data.tabs.length : last + 1;
  }
  data.tabs.splice(insertAt, 0, tab);
  await saveData(data);
  return data;
}

// ---------- операции с группами ----------

export async function addGroup(name) {
  const data = await getData();
  const group = { id: uid("g"), name: name || "Новая группа" };
  data.groups.push(group);
  await saveData(data);
  return group;
}

export async function renameGroup(groupId, name) {
  const data = await getData();
  const group = data.groups.find((g) => g.id === groupId);
  if (group) {
    group.name = name;
    await saveData(data);
  }
  return data;
}

// Удаляем группу; её вкладки становятся «без группы» (groupId=null).
export async function removeGroup(groupId) {
  const data = await getData();
  data.groups = data.groups.filter((g) => g.id !== groupId);
  data.tabs.forEach((t) => {
    if (t.groupId === groupId) t.groupId = null;
  });
  await saveData(data);
  return data;
}

// ---------- импорт / экспорт (для File System Access и файла) ----------

// В файл пишем только текстовые данные — превью туда не кладём.
export async function buildExportPayload() {
  const data = await getData();
  const meta = await getMeta();
  return {
    format: "tabsaver",
    version: 1,
    exportedAt: Date.now(),
    lastSyncedAt: meta.lastSyncedAt,
    groups: data.groups,
    tabs: data.tabs.map(({ previewRef, ...rest }) => rest), // previewRef не нужен в файле
  };
}

// Замена текущих данных содержимым файла (без превью — их в файле нет).
export async function importPayload(payload) {
  if (!payload || payload.format !== "tabsaver") {
    throw new Error("Неверный формат файла: ожидается TabSaver JSON.");
  }
  const data = {
    groups: Array.isArray(payload.groups) ? payload.groups : [],
    tabs: Array.isArray(payload.tabs)
      ? payload.tabs.map((t) => ({ ...t, previewRef: null }))
      : [],
  };
  await saveData(data);
  return data;
}
