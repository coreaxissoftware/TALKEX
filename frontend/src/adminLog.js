const STORAGE_KEY = "talkex_admin_log";
const MAX_ENTRIES = 200;

function loadLog() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
  catch { return []; }
}

function saveLog(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
}

export function logAdminAction(chatId, actorName, action, detail) {
  const entries = loadLog();
  entries.push({ chatId, actor: actorName, action, detail: detail || "", ts: Date.now() });
  saveLog(entries);
}

export function getAdminLog(chatId) {
  return loadLog().filter((e) => e.chatId === chatId).reverse();
}

export function clearAdminLog(chatId) {
  const entries = loadLog().filter((e) => e.chatId !== chatId);
  saveLog(entries);
}
