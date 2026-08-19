import { LANGS, DEFAULT_SETTINGS, normalizeSettings } from './translators.js';

const $ = s => document.querySelector(s);
let segButtons = [];

// 大模型服务商预设：选中后自动填好 Base URL 与默认模型（Key 仍需自备）
const LLM_PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    keyHint: '申请 Key：platform.deepseek.com → API Keys。可用模型 deepseek-chat / deepseek-reasoner。' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    keyHint: '申请 Key：platform.openai.com → API keys。可用模型 gpt-4o / gpt-4o-mini 等。' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
    keyHint: '申请 Key：open.bigmodel.cn → 接口密钥。glm-4-flash 有免费额度，glm-4-plus 更准。' },
  { id: 'moonshot', name: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
    keyHint: '申请 Key：platform.moonshot.cn → API Key（Kimi）。可用模型 moonshot-v1-8k / 32k / 128k。' },
  { id: 'qwen', name: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
    keyHint: '申请 Key：dashscope.console.aliyun.com → API KEY。可用模型 qwen-plus / qwen-max / qwen-turbo。' },
  { id: 'ollama', name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b',
    keyHint: '本地运行 Ollama，默认无需 Key（留空即可）。请先 `ollama pull qwen2.5:7b` 拉好模型。' },
  { id: 'custom', name: '自定义', baseUrl: 'https://api.openai.com/v1', model: '',
    keyHint: '任意兼容 OpenAI 接口的端点，手动填写地址与模型即可。' },
];

let llmProfiles = [];   // 大模型多配置
let curLlm = 0;         // 当前编辑的配置下标
let loadedEngines = []; // 已勾选的翻译器（多选）

init();

async function init() {
  const s = await chrome.storage.sync.get(null);
  const st = normalizeSettings({ ...DEFAULT_SETTINGS, ...s });
  llmProfiles = st.llmProfiles.map(p => ({ ...p }));
  loadedEngines = st.engines.slice();
  curLlm = 0;

  $('#baiduAppid').value = st.baidu.appid || '';
  $('#baiduSecret').value = st.baidu.secret || '';

  buildEngineList();
  refreshEngineSelects();
  buildLlmManager();
  loadLlmFields();
  $('#engineList').addEventListener('change', () => onEngineToggle());

  fillSelect($('#from'), true);
  fillSelect($('#to'), false);
  $('#from').value = st.from;
  $('#to').value = st.to;

  segButtons = Array.from(document.querySelectorAll('.seg button'));
  segButtons.forEach(b => {
    b.classList.toggle('on', b.dataset.v === st.displayMode);
    b.addEventListener('click', () => {
      segButtons.forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
  });

  $('#selectionBubble').checked = !!st.selectionBubble;
  $('#instantTranslate').checked = !!st.instantTranslate;
  $('#translateScope').checked = st.translateScope !== 'all';
  $('#transColor').value = st.transColor || '#3b5bdb';
  $('#dictEnabled').checked = st.dict !== false;

  // 全文译文显示设置
  $('#trColorInherit').checked = !st.trColor;
  $('#trColor').value = st.trColor || '#1a73e8';
  $('#trColor').disabled = !st.trColor;
  $('#trScale').value = st.trScale || 1;
  $('#trScaleVal').textContent = (Number(st.trScale) || 1).toFixed(2) + '×';
  $('#trBox').checked = st.trBox !== false;
  $('#trColorInherit').addEventListener('change', e => {
    $('#trColor').disabled = e.target.checked;
    $('#trColorHint').textContent = e.target.checked ? '跟随原文' : '自定义';
  });
  $('#trScale').addEventListener('input', e => {
    $('#trScaleVal').textContent = (Number(e.target.value) || 1).toFixed(2) + '×';
  });

  // 新设置
  $('#vocabAuto').checked = !!st.vocabAuto;
  $('#glossaryEnabled').checked = !!st.glossaryEnabled;
  $('#autoTranslate').checked = !!st.autoTranslate;
  $('#siteBlock').value = Array.isArray(st.siteBlock) ? st.siteBlock.join('\n') : '';
  $('#slowSpeech').checked = !!st.slowSpeech;
  $('#notifyOnDue').checked = !!st.notifyOnDue;
  document.querySelectorAll('#accentSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === (st.accent || 'us')));

  syncBaiduPanel();
  initTabs();
  await renderVocab();
  await renderGlossary();

  $('#saveBtn').addEventListener('click', save);
  document.querySelectorAll('.test').forEach(b => {
    if (!b.dataset.engine) return; // 大模型测试由 buildLlmManager 单独绑定
    b.addEventListener('click', () => testEngine(b.dataset.engine, b));
  });
  $('#exportCsv').addEventListener('click', exportVocabCsv);
  $('#exportAnki').addEventListener('click', exportVocabAnki);
  $('#clearVocab').addEventListener('click', clearVocab);
  $('#glAdd').addEventListener('click', addGlossary);
  $('#exportJson').addEventListener('click', exportVocabJson);
  $('#importJson').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', importVocabJson);
}

function fillSelect(sel, withAuto) {
  LANGS.filter(l => withAuto || l.code !== 'auto').forEach(l => sel.add(new Option(l.name, l.code)));
}

function syncBaiduPanel() {
  const baiduOn = !!document.querySelector('.eng-cb[value=baidu]')?.checked;
  $('#panel-baidu').style.display = baiduOn ? 'flex' : 'none';
}

/* ---- 大模型服务商预设 ---- */
function buildLlmProviders(llm) {
  const wrap = $('#llmProviders');
  if (!wrap) return;
  wrap.innerHTML = '';
  const curBase = String(llm.baseUrl || '').replace(/\/+$/, '');
  let matched = 'custom';
  LLM_PROVIDERS.forEach(p => {
    if (p.id !== 'custom' && p.baseUrl.replace(/\/+$/, '') === curBase) matched = p.id;
  });
  LLM_PROVIDERS.forEach(p => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.name;
    b.dataset.id = p.id;
    b.classList.toggle('on', p.id === matched);
    b.addEventListener('click', () => {
      $('#llmBaseUrl').value = p.baseUrl;
      if (p.model) $('#llmModel').value = p.model;
      wrap.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $('#llmKeyHint').textContent = p.keyHint;
    });
    wrap.appendChild(b);
  });
  $('#llmKeyHint').textContent = (LLM_PROVIDERS.find(p => p.id === matched) || {}).keyHint || '';
}

/* ---- 翻译器多选 + 主/全文下拉 ---- */
function buildEngineList() {
  const list = $('#engineList');
  if (!list) return;
  // 移除旧的大模型复选项（保留免费引擎静态项）
  list.querySelectorAll('.eng-cb.llm').forEach(n => n.remove());
  llmProfiles.forEach(p => {
    const lab = document.createElement('label');
    lab.className = 'engine';
    const name = (p.name && p.name.trim()) ? p.name : 'AI 大模型';
    lab.innerHTML = '<input type="checkbox" class="eng-cb llm" value="' + p.id + '"><div><b>' + name +
      (p.model ? ' · ' + p.model : '') + '</b><span>大模型 · ' + (p.baseUrl || '') + '</span></div>';
    list.appendChild(lab);
  });
  list.querySelectorAll('.eng-cb').forEach(cb => {
    cb.checked = Array.isArray(loadedEngines) && loadedEngines.includes(cb.value);
  });
  syncBaiduPanel();
}

function onEngineToggle() {
  loadedEngines = Array.from(document.querySelectorAll('.eng-cb:checked')).map(cb => cb.value);
  // 主翻译器/全文翻译下拉随勾选刷新
  refreshEngineSelects();
  syncBaiduPanel();
  buildEngineList(); // 刷新大模型项显示名
}

function refreshEngineSelects() {
  const opts = Array.from(document.querySelectorAll('.eng-cb:checked')).map(cb => {
    let label = cb.parentElement.querySelector('b').textContent;
    return { value: cb.value, label };
  });
  if (!opts.length) opts.push({ value: 'google', label: 'Google 翻译' });
  const fill = sel => {
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '';
    opts.forEach(o => {
      const op = document.createElement('option');
      op.value = o.value; op.textContent = o.label;
      sel.appendChild(op);
    });
    if (opts.some(o => o.value === prev)) sel.value = prev;
  };
  fill($('#primaryEngine'));
  fill($('#fullPageEngine'));
}

/* ---- 大模型多配置管理 ---- */
function buildLlmManager() {
  const sel = $('#llmProfileSel');
  sel.innerHTML = '';
  llmProfiles.forEach((p, i) => {
    const op = document.createElement('option');
    op.value = String(i);
    op.textContent = (p.name && p.name.trim()) ? p.name : ('AI 大模型 ' + (i + 1)) + (p.model ? ' · ' + p.model : '');
    sel.appendChild(op);
  });
  sel.value = String(curLlm);
  sel.onchange = () => { saveLlmFields(); curLlm = parseInt(sel.value, 10) || 0; loadLlmFields(); };
  $('#llmAdd').onclick = () => {
    saveLlmFields();
    const n = llmProfiles.length;
    llmProfiles.push({ id: 'llm' + n, name: 'AI 大模型', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', sysPrompt: '' });
    curLlm = llmProfiles.length - 1;
    buildLlmManager(); buildEngineList(); loadLlmFields();
  };
  $('#llmDel').onclick = () => {
    if (llmProfiles.length <= 1) { alert('至少保留一个大模型配置'); return; }
    llmProfiles.splice(curLlm, 1);
    curLlm = Math.max(0, curLlm - 1);
    buildLlmManager(); buildEngineList(); loadLlmFields();
  };
  $('#llmName').oninput = () => { saveLlmFields(); buildLlmManager(); buildEngineList(); };
  $('#llmTest').onclick = () => testEngine(llmProfiles[curLlm].id, $('#llmTest'));
}

function loadLlmFields() {
  const p = llmProfiles[curLlm] || {};
  $('#llmName').value = p.name || '';
  $('#llmBaseUrl').value = p.baseUrl || '';
  $('#llmApiKey').value = p.apiKey || '';
  $('#llmModel').value = p.model || '';
  $('#llmPrompt').value = p.sysPrompt || '';
  buildLlmProviders(p);
}

function saveLlmFields() {
  const p = llmProfiles[curLlm];
  if (!p) return;
  p.name = $('#llmName').value.trim();
  p.baseUrl = $('#llmBaseUrl').value.trim() || 'https://api.openai.com/v1';
  p.apiKey = $('#llmApiKey').value.trim();
  p.model = $('#llmModel').value.trim() || 'gpt-4o-mini';
  p.sysPrompt = $('#llmPrompt').value;
}

/* ---- 标签页 ---- */
function initTabs() {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.remove('on'));
    t.classList.add('on');
    document.querySelectorAll('.panel').forEach(p => {
      p.hidden = p.dataset.panel !== t.dataset.tab;
    });
  }));
  chrome.storage.local.get('ety_open_tab').then(r => {
    const tab = r.ety_open_tab;
    if (tab) {
      const target = tabs.find(x => x.dataset.tab === tab);
      if (target) target.click();
      chrome.storage.local.remove('ety_open_tab');
    }
  });
}

/* ---- 生词本 ---- */
async function renderVocab() {
  const list = await getLocal('ety_vocab');
  $('#vocabCount').textContent = (list ? list.length : 0) + ' 个';
  const box = $('#vocabList');
  box.textContent = '';
  if (!list || !list.length) {
    box.innerHTML = '<div class="empty">还没有收藏的单词，去网页上划词查词试试吧</div>';
    return;
  }
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'vocab-item';
    const w = document.createElement('div'); w.className = 'w'; w.textContent = item.word;
    const ph = document.createElement('div'); ph.className = 'ph'; ph.textContent = item.phone || '';
    const df = document.createElement('div'); df.className = 'df';
    df.textContent = (item.defs && item.defs.length) ? item.defs[0] : (item.context || '');
    const edit = document.createElement('button'); edit.className = 'del'; edit.textContent = '✎'; edit.title = '编辑释义';
    edit.addEventListener('click', async () => {
      const cur = await getLocal('ety_vocab');
      const it = (cur || []).find(x => x.word === item.word && x.isZh === item.isZh);
      if (!it) return;
      const nd = prompt('编辑释义（多个用 / 分隔）', (it.defs || []).join(' / '));
      if (nd === null) return;
      it.defs = nd.split('/').map(s => s.trim()).filter(Boolean);
      await setLocal('ety_vocab', cur);
      renderVocab();
    });
    const fam = document.createElement('button'); fam.className = 'del'; fam.textContent = '✓'; fam.title = '标为熟悉（延后 30 天复习）';
    fam.addEventListener('click', async () => {
      const cur = await getLocal('ety_vocab');
      const it = cur.find(x => x.word === item.word && x.isZh === item.isZh);
      if (!it) return;
      it.reviews = Math.min((it.reviews || 0) + 2, 6);
      it.nextReview = Date.now() + 30 * 86400000;
      await setLocal('ety_vocab', cur);
      renderVocab();
    });
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.title = '删除';
    del.addEventListener('click', async () => {
      const cur = await getLocal('ety_vocab');
      await setLocal('ety_vocab', (cur || []).filter(x => !(x.word === item.word && x.isZh === item.isZh)));
      renderVocab();
    });
    row.append(w, ph, df, edit, fam, del);
    box.appendChild(row);
  });
}

async function exportVocabCsv() {
  const list = await getLocal('ety_vocab');
  if (!list || !list.length) { alert('生词本为空'); return; }
  const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = ['word,phonetic,definition,context,url,time'];
  list.forEach(x => lines.push([x.word, x.phone || '', (x.defs || []).join(' / '), x.context || '', x.url || '', new Date(x.ts || 0).toISOString()].map(esc).join(',')));
  download(lines.join('\n'), 'ety-vocab.csv', 'text/csv');
}

async function exportVocabAnki() {
  const list = await getLocal('ety_vocab');
  if (!list || !list.length) { alert('生词本为空'); return; }
  // Anki 制卡：Tab 分隔，字段 = 单词 \t 音标 \t 释义 \t 语境
  const lines = list.map(x => [x.word, x.phone || '', (x.defs || []).join(' / '), x.context || ''].join('\t'));
  download(lines.join('\n'), 'ety-vocab-anki.txt', 'text/plain');
}

// 生词本 JSON 备份导出 / 导入（多设备迁移，因 sync 仅同步设置不含生词本）
async function exportVocabJson() {
  const list = await getLocal('ety_vocab');
  if (!list || !list.length) { alert('生词本为空'); return; }
  download(JSON.stringify(list, null, 2), 'ety-vocab.json', 'application/json');
}
async function importVocabJson(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) { alert('文件格式不正确'); return; }
    const cur = await getLocal('ety_vocab') || [];
    let added = 0;
    for (const x of arr) {
      if (x && x.word && !cur.some(m => m.word === x.word && m.isZh === x.isZh)) { cur.push(x); added++; }
    }
    await setLocal('ety_vocab', cur);
    alert('已导入 ' + arr.length + ' 条（新增 ' + added + ' 条，已自动去重）');
    renderVocab();
  } catch (err) { alert('导入失败：' + ((err && err.message) || err)); }
  e.target.value = '';
}

async function clearVocab() {
  if (!confirm('确定清空生词本？此操作不可恢复')) return;
  await setLocal('ety_vocab', []);
  renderVocab();
}

/* ---- 术语库 ---- */
async function renderGlossary() {
  const list = await getLocal('ety_glossary');
  const box = $('#glossaryList');
  box.textContent = '';
  if (!list || !list.length) {
    box.innerHTML = '<div class="empty">还没有术语，添加后翻译时会优先采用你的指定译法</div>';
    return;
  }
  list.forEach(g => {
    const row = document.createElement('div');
    row.className = 'gloss-item';
    const a = document.createElement('span'); a.textContent = g.src;
    const arr = document.createElement('span'); arr.className = 'arrow'; arr.textContent = '→';
    const b = document.createElement('span'); b.textContent = g.dst;
    const del = document.createElement('button'); del.className = 'del'; del.textContent = '×'; del.title = '删除';
    del.addEventListener('click', async () => {
      const cur = await getLocal('ety_glossary');
      await setLocal('ety_glossary', (cur || []).filter(x => !(x.src === g.src && x.dst === g.dst)));
      renderGlossary();
    });
    row.append(a, arr, b, del);
    box.appendChild(row);
  });
}

async function addGlossary() {
  const src = $('#glSrc').value.trim();
  const dst = $('#glDst').value.trim();
  if (!src || !dst) { alert('请填写原文与固定译法'); return; }
  const list = await getLocal('ety_glossary');
  const cur = list || [];
  if (cur.some(x => x.src === src && x.dst === dst)) { alert('已存在相同术语'); return; }
  cur.push({ src, dst });
  await setLocal('ety_glossary', cur);
  $('#glSrc').value = ''; $('#glDst').value = '';
  renderGlossary();
}

/* ---- 工具 ---- */
async function getLocal(key) {
  const r = await chrome.storage.local.get(key).catch(() => ({}));
  return r[key];
}
async function setLocal(key, val) { await chrome.storage.local.set({ [key]: val }); }

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---- 保存 ---- */
function collect() {
  saveLlmFields();
  const engines = Array.from(document.querySelectorAll('.eng-cb:checked')).map(cb => cb.value);
  if (!engines.length) engines.push('google');
  let primary = $('#primaryEngine').value;
  if (!engines.includes(primary)) primary = engines[0];
  let fullPage = $('#fullPageEngine').value;
  if (!engines.includes(fullPage)) fullPage = primary;
  return {
    engine: primary,
    engines,
    fullPageEngine: fullPage,
    baidu: {
      appid: $('#baiduAppid').value.trim(),
      secret: $('#baiduSecret').value.trim(),
    },
    llmProfiles: llmProfiles.map(p => ({ ...p })),
    from: $('#from').value,
    to: $('#to').value,
    displayMode: (document.querySelector('.seg button.on') || {}).dataset.v || 'bilingual',
    selectionBubble: $('#selectionBubble').checked,
    instantTranslate: $('#instantTranslate').checked,
    translateScope: $('#translateScope').checked ? 'auto' : 'all',
    transColor: $('#transColor').value,
    trColor: $('#trColorInherit').checked ? '' : $('#trColor').value,
    trScale: Number($('#trScale').value) || 1,
    trBox: $('#trBox').checked,
    dict: $('#dictEnabled').checked,
    vocabAuto: $('#vocabAuto').checked,
    glossaryEnabled: $('#glossaryEnabled').checked,
    autoTranslate: $('#autoTranslate').checked,
    siteBlock: $('#siteBlock').value.split('\n').map(x => x.trim()).filter(Boolean),
    accent: (document.querySelector('#accentSeg button.on') || {}).dataset?.v || 'us',
    slowSpeech: $('#slowSpeech').checked,
    notifyOnDue: $('#notifyOnDue').checked,
  };
}

async function save() {
  await chrome.storage.sync.set(collect());
  const el = $('#saveStatus');
  el.textContent = '已保存 ✓';
  setTimeout(() => { el.textContent = ''; }, 2000);
}

async function testEngine(engine, btn) {
  const original = btn.textContent;
  btn.textContent = '测试中…';
  btn.disabled = true;
  saveLlmFields();
  const cfg = {};
  if (engine === 'baidu') {
    cfg.baidu = { appid: $('#baiduAppid').value.trim(), secret: $('#baiduSecret').value.trim() };
  } else if (engine && String(engine).startsWith('llm')) {
    const p = llmProfiles.find(x => x.id === engine) || llmProfiles[curLlm];
    cfg.llmProfile = {
      baseUrl: (p.baseUrl || '').trim() || 'https://api.openai.com/v1',
      apiKey: (p.apiKey || '').trim(),
      model: (p.model || '').trim() || 'gpt-4o-mini',
      sysPrompt: p.sysPrompt || '',
    };
  }
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'ety-test', engine, cfg });
  } catch (e) {
    resp = { ok: false, error: (e && e.message) || String(e) };
  }
  btn.disabled = false;
  if (resp && resp.ok) {
    const sample = String(resp.sample || '').slice(0, 24);
    btn.textContent = '通过 ✓ ' + sample;
  } else {
    btn.textContent = '失败';
    alert('测试失败：' + ((resp && resp.error) || '未知错误'));
  }
  setTimeout(() => { btn.textContent = original; }, 4000);
}
