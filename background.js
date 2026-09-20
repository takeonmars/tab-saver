// background.js — service worker TabSaver.
// Основную работу делает popup (у него есть activeTab при клике на иконку).
// Здесь — установка и открытие dashboard по запросу.

chrome.runtime.onInstalled.addListener(() => {
  console.log("TabSaver установлен.");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "open-dashboard") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    sendResponse({ ok: true });
  }
  return false;
});
