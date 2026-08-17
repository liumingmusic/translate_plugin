/**
 * 逸译 · 后台 Service Worker
 * 右键菜单 + 消息路由（翻译请求统一在此处理，内容脚本不直接请求外部接口）
 */
import { DEFAULT_SETTINGS, translateSegments, langName, ENGINE_NAMES, lookupDict, normalizeSettings, engineLabel, isLlmId } from './translators.js';

/* ============ 翻译结果本地缓存（跨 SW 重启持久化，二次访问秒出） ============ */
let memCache = null;
let cacheDirty = false;
let flushTimer = null;
async function loadCache() {
  if (memCache) return;
  const s = await chrome.storage.local.get('ety_cache').catch(() => ({}));
  memCache = (s.ety_cache && typeof s.ety_cache === 'object') ? s.ety_cache : {};
}
async function cacheGet(key) {
  await loadCache();
  return Object.prototype.hasOwnProperty.call(memCache, key) ? memCache[key] : undefined;
}
async function cacheSet(key, val) {
  await loadCache();
  memCache[key] = val;
  cacheDirty = true;
  const ks = Object.keys(memCache);
  if (ks.length > 3000) delete memCache[ks[0]]; // 简单 FIFO 上限
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (cacheDirty && memCache) { chrome.storage.local.set({ ety_cache: memCache }); cacheDirty = false; }
  }, 1500);
}

async function getSettings() {
  const s = await chrome.storage.sync.get(null);
  return normalizeSettings(s);
}

// 多引擎对比：并行查询多个引擎，返回每个引擎的译文/错误
async function compareTranslate(settings, text) {
  let engines = (settings.engines && Array.isArray(settings.engines) && settings.engines.length)
    ? settings.engines : [settings.engine];
  // 去重、保序，主引擎前置
  const seen = new Set();
  const list = [];
  for (const e of [settings.engine, ...engines]) {
    if (e && !seen.has(e)) { seen.add(e); list.push(e); }
  }
  const results = await Promise.all(list.map(async engine => {
    const r = await translateSegments({ ...settings, engine }, [text], settings.from, settings.to);
    const item = { engine, engineLabel: engineLabel(settings, engine) };
    if (r.ok) {
      item.translation = r.translations[0];
      if (r.usedEngine && r.usedEngine !== engine) item.fallback = r.usedEngine;
      const fromPart = r.detected && r.detected !== 'auto' ? langName(r.detected) : '';
      item.hint = (fromPart ? fromPart + ' → ' : '') + langName(settings.to);
    } else {
      item.error = r.error;
    }
    return item;
  }));
  return { ok: results.some(x => x.translation != null), results };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'ety-selection', title: '翻译 “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ety-compare', title: '多引擎对比 “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ety-page', title: '翻译整个页面', contexts: ['page'] });
  });
  try { chrome.alarms.create('ety-review', { periodInMinutes: 1440 }); } catch (e) {}
});

// 确保内容脚本已注入（安装/更新前打开的标签页不会自动注入）
async function ensureInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ety-ping' });
    return true;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, files: ['content.css'] });
      return true;
    } catch (e2) { return false; }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;

  // 关键修复：扩展安装/更新前就已打开的标签页不会自动注入内容脚本，
  // 先 ping 一下，不通则主动注入后再发消息，避免“点了没反应”（详见模块级 ensureInjected）
  if (info.menuItemId === 'ety-page') {
    if (await ensureInjected(tab.id)) {
      chrome.tabs.sendMessage(tab.id, { type: 'ety-translate-page' }).catch(() => {});
    }
    return;
  }
  if (info.menuItemId === 'ety-compare') {
    const text = (info.selectionText || '').trim();
    if (!text) return;
    if (!(await ensureInjected(tab.id))) return;
    chrome.tabs.sendMessage(tab.id, { type: 'ety-selection-start', text, compare: true }).catch(() => {});
    const settings = await getSettings();
    const r = await compareTranslate(settings, text);
    await chrome.tabs.sendMessage(tab.id, {
      type: 'ety-selection-compare',
      text,
      results: r.results,
      dict: settings.dict ? await lookupDict(text) : { ok: false },
    }).catch(() => {});
    return;
  }

  if (info.menuItemId === 'ety-selection') {
    const text = (info.selectionText || '').trim();
    if (!text) return;
    if (!(await ensureInjected(tab.id))) return;
    // 先发“开始翻译”，让页面立即显示加载中卡片（而不是无声等待）
    chrome.tabs.sendMessage(tab.id, { type: 'ety-selection-start', text }).catch(() => {});

    const settings = await getSettings();
    const r = await translateSegments(settings, [text], settings.from, settings.to);
    if (r.ok) {
      const fromPart = r.detected && r.detected !== 'auto' ? langName(r.detected) : '';
      const hint = (fromPart ? fromPart + ' → ' : '') + langName(settings.to);
      await chrome.tabs.sendMessage(tab.id, {
        type: 'ety-selection-result',
        text,
        result: r.translations[0],
        engineName: ENGINE_NAMES[r.usedEngine || settings.engine],
        hint,
        dict: settings.dict ? await lookupDict(text) : { ok: false },
      }).catch(() => {});
    } else {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'ety-selection-error',
        text,
        error: r.error,
      }).catch(() => {});
    }
  }
});

/* ============ 快捷键（D2） ============ */
chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  if (cmd === 'ets-translate-page') {
    if (await ensureInjected(tab.id)) chrome.tabs.sendMessage(tab.id, { type: 'ety-translate-page' }).catch(() => {});
  } else if (cmd === 'ets-translate-selection') {
    if (await ensureInjected(tab.id)) chrome.tabs.sendMessage(tab.id, { type: 'ety-translate-selection-hotkey' }).catch(() => {});
  }
});

/* ============ 复习到期提醒（C4） ============ */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'ety-review') return;
  try {
    const s = await chrome.storage.sync.get(null);
    if (!s.notifyOnDue) return;
    const v = await chrome.storage.local.get('ety_vocab');
    const list = Array.isArray(v.ety_vocab) ? v.ety_vocab : [];
    const now = Date.now();
    const due = list.filter(x => (x.nextReview != null && x.nextReview <= now)).length;
    if (due > 0) {
      chrome.notifications.create('ety-review-' + now, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '逸译 · 复习提醒',
        message: '你有 ' + due + ' 个单词到期待复习，点击开始复习',
        priority: 2,
      });
    }
  } catch (e) { /* ignore */ }
});
chrome.notifications.onClicked.addListener((id) => {
  if (id && id.indexOf('ety-review') === 0) { try { chrome.action.openPopup && chrome.action.openPopup(); } catch (e) {} }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ety-translate') {
    (async () => {
      const settings = await getSettings();
      const from = msg.from || settings.from;
      const to = msg.to || settings.to;
      const segs = msg.segments || [];
      const reqEngine = msg.engine || settings.engine;
      const key = (reqEngine || 'auto') + '|' + from + '|' + to + '|' + segs.join('');
      const hit = await cacheGet(key);
      if (hit) { sendResponse({ ok: true, translations: hit, fromCache: true }); return; }
      const r = await translateSegments({ ...settings, engine: reqEngine }, segs, from, to, msg.fullText);
      if (r.ok) {
        const used = r.usedEngine || reqEngine;
        r.engineName = engineLabel(settings, used);
        const fromPart = r.detected && r.detected !== 'auto' ? langName(r.detected) : '';
        r.langHint = (fromPart ? fromPart + ' → ' : '') + langName(settings.to);
        cacheSet(key, r.translations);
        // 翻译历史（最近 50 条，本地保存，可回看/再听）
        try {
          const h = await chrome.storage.local.get('ety_history');
          const arr = Array.isArray(h.ety_history) ? h.ety_history : [];
          arr.unshift({ src: segs.join(' ').slice(0, 300), dst: (r.translations || []).join(' ').slice(0, 300), engine: used, ts: Date.now() });
          if (arr.length > 50) arr.length = 50;
          await chrome.storage.local.set({ ety_history: arr });
        } catch (e) { /* ignore */ }
      }
      sendResponse(r);
    })();
    return true; // 异步响应
  }

  if (msg.type === 'ety-compare') {
    (async () => {
      const settings = await getSettings();
      sendResponse(await compareTranslate(settings, String(msg.text || '')));
    })();
    return true;
  }

  if (msg.type === 'ety-dict') {
    (async () => {
      const settings = await getSettings();
      if (!settings.dict) { sendResponse({ ok: false }); return; }
      sendResponse(await lookupDict(String(msg.q || '')));
    })();
    return true;
  }

  if (msg.type === 'ety-test') {
    (async () => {
      const settings = await getSettings();
      const eng = msg.engine;
      // 大模型测试：把临时配置合并进对应 profile（支持多配置互比）
      if (isLlmId(eng) && msg.cfg && msg.cfg.llmProfile) {
        const arr = (settings.llmProfiles || []).map(p => p.id === eng ? { ...p, ...msg.cfg.llmProfile } : p);
        if (!arr.some(p => p.id === eng)) arr.push({ id: eng, name: 'AI 大模型', ...msg.cfg.llmProfile });
        settings.llmProfiles = arr;
      } else if (msg.cfg && msg.cfg[eng]) {
        settings[eng] = { ...(settings[eng] || {}), ...msg.cfg[eng] };
      }
      const to = settings.to === 'auto' ? 'zh-CN' : settings.to;
      const r = await translateSegments({ ...settings, engine: eng }, ['Hello, world! This is a translation test.'], 'auto', to);
      if (r.ok) r.sample = r.translations[0];
      r.testEngineName = r.ok ? (r.usedEngine || eng) : eng;
      sendResponse(r);
    })();
    return true;
  }
});
