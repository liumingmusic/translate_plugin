import { LANGS, DEFAULT_SETTINGS, ENGINE_NAMES, normalizeSettings } from './translators.js';

const $ = s => document.querySelector(s);

init();

async function init() {
  const s = await chrome.storage.sync.get(null);
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...s });

  const engine = $('#engine');
  engine.innerHTML = '';
  for (const [k, v] of Object.entries(ENGINE_NAMES)) engine.add(new Option(v, k));
  (settings.llmProfiles || []).forEach(p => {
    const label = (p.name && p.name.trim() ? p.name : 'AI 大模型') + (p.model ? ' · ' + p.model : '');
    engine.add(new Option(label, p.id));
  });
  engine.value = settings.engine;

  fillSelect($('#from'), true);
  fillSelect($('#to'), false);
  $('#from').value = settings.from;
  $('#to').value = settings.to;

  document.querySelectorAll('.seg button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === settings.displayMode);
  });

  $('#dictToggle').checked = settings.dict !== false;
  $('#vocabAuto').checked = !!settings.vocabAuto;
  $('#autoTranslate').checked = !!settings.autoTranslate;
  $('#instantToggle').checked = settings.instantTranslate !== false;

  $('#dictToggle').addEventListener('change', () => chrome.storage.sync.set({ dict: $('#dictToggle').checked }));
  $('#vocabAuto').addEventListener('change', () => chrome.storage.sync.set({ vocabAuto: $('#vocabAuto').checked }));
  $('#autoTranslate').addEventListener('change', () => chrome.storage.sync.set({ autoTranslate: $('#autoTranslate').checked }));
  $('#instantToggle').addEventListener('change', () => chrome.storage.sync.set({ instantTranslate: $('#instantToggle').checked }));

  engine.addEventListener('change', () => chrome.storage.sync.set({ engine: engine.value }));
  $('#from').addEventListener('change', () => chrome.storage.sync.set({ from: $('#from').value }));
  $('#to').addEventListener('change', () => chrome.storage.sync.set({ to: $('#to').value }));

  document.querySelectorAll('.seg button').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      chrome.storage.sync.set({ displayMode: b.dataset.v });
    });
  });

  $('#swap').addEventListener('click', () => {
    if ($('#from').value === 'auto') return;
    const f = $('#from').value;
    $('#from').value = $('#to').value;
    $('#to').value = f;
    chrome.storage.sync.set({ from: $('#from').value, to: $('#to').value });
  });

  $('#optionsLink').addEventListener('click', e => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  $('#vocabLink').addEventListener('click', e => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    chrome.storage.local.set({ ety_open_tab: 'vocab' });
  });

  $('#translateBtn').addEventListener('click', () => withTab('ety-translate-page'));
  $('#restoreBtn').addEventListener('click', () => withTab('ety-restore-page'));

  // 历史与听写（B4 / C1）
  $('#historyLink').addEventListener('click', e => { e.preventDefault(); openHistory(); });
  $('#historyBtn').addEventListener('click', () => openHistory());
  $('#histBack').addEventListener('click', () => { $('#historyView').hidden = true; $('#mainView').hidden = false; initReview(); });
  $('#histClear').addEventListener('click', async () => { if (confirm('清空翻译历史？')) { await chrome.storage.local.set({ ety_history: [] }); renderHistory(); } });
  $('#spellBtn').addEventListener('click', startSpell);
  $('#spPlay').addEventListener('click', spellPlay);
  $('#spSubmit').addEventListener('click', spellSubmit);
  document.querySelectorAll('#spActions .rv-g').forEach(b => b.addEventListener('click', () => gradeCurrent(Number(b.dataset.grade))));
  $('#spInput').addEventListener('keydown', e => { if (e.key === 'Enter') spellSubmit(); });

  await initReview();
  setupReviewEvents();
}

function fillSelect(sel, withAuto) {
  LANGS.filter(l => withAuto || l.code !== 'auto').forEach(l => sel.add(new Option(l.name, l.code)));
}

async function withTab(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type });
  } catch (e) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type });
    } catch (e2) {
      alert('当前页面暂不支持翻译（浏览器内置页面或应用商店页面）');
      return;
    }
  }
  if (type === 'ety-translate-page') window.close();
}

/* ==================== 生词本复习（轻量记忆曲线） ==================== */
const RV_INTERVAL = [0, 1, 3, 7, 16, 30, 60]; // 复习间隔（天），索引 = reviews 次数
let reviewQueue = [], reviewIdx = 0, reviewList = [];

async function getVocabLocal() {
  const v = await chrome.storage.local.get('ety_vocab').catch(() => ({}));
  return Array.isArray(v.ety_vocab) ? v.ety_vocab : [];
}
function dueVocab(list) {
  const now = Date.now();
  return list.filter(v => (v.nextReview == null ? true : v.nextReview <= now));
}
function scheduleReview(v, grade) {
  if (grade === 0) v.reviews = 0;                                  // 忘记：归零
  else if (grade === 2) v.reviews = Math.min((v.reviews || 0) + 1, RV_INTERVAL.length - 1); // 认识：进阶
  const idx = v.reviews || 0;
  const days = grade === 1 ? 1 : (RV_INTERVAL[idx] || 60);          // 模糊：隔天再见面
  v.nextReview = Date.now() + days * 86400000;
}
async function initReview() {
  const list = await getVocabLocal();
  const due = dueVocab(list);
  $('#dueCount').textContent = due.length;
  $('#reviewBtn').disabled = due.length === 0;
}
function setupReviewEvents() {
  $('#reviewBtn').addEventListener('click', startReview);
  $('#rvExit').addEventListener('click', exitReview);
  $('#rvDoneClose').addEventListener('click', exitReview);
  $('#rvReveal').addEventListener('click', () => {
    $('#rvReveal').hidden = true;
    $('#rvDefs').hidden = false;
    $('#rvActions').hidden = false;
  });
  document.querySelectorAll('.rv-g').forEach(b => b.addEventListener('click', () => gradeCurrent(Number(b.dataset.grade))));
}
async function startReview() {
  reviewList = await getVocabLocal();
  reviewQueue = dueVocab(reviewList);
  if (!reviewQueue.length) return;
  reviewIdx = 0;
  $('#mainView').hidden = true;
  $('#reviewView').hidden = false;
  $('#rvDone').hidden = true;
  $('#rvCard').hidden = false;
  showReviewCard();
}
function showReviewCard() {
  if (reviewIdx >= reviewQueue.length) return finishReview();
  const v = reviewQueue[reviewIdx];
  $('#rvProgress').textContent = (reviewIdx + 1) + ' / ' + reviewQueue.length;
  $('#rvWord').textContent = v.word;
  $('#rvPhon').textContent = v.phone || '';
  $('#rvDefs').hidden = true;
  $('#rvDefs').textContent = '';
  (v.defs || []).forEach(d => {
    const p = document.createElement('div');
    p.className = 'rv-def';
    p.textContent = (typeof d === 'string') ? d : ((d.pos ? '【' + d.pos + '】' : '') + (d.tran || d.trans || ''));
    $('#rvDefs').appendChild(p);
  });
  $('#rvReveal').hidden = false;
  $('#rvActions').hidden = true;
}
function gradeCurrent(grade) {
  const v = reviewQueue[reviewIdx];
  if (!v) return;
  scheduleReview(v, grade);
  const i = reviewList.findIndex(x => x.word === v.word && x.isZh === v.isZh);
  if (i >= 0) reviewList[i] = v;
  chrome.storage.local.set({ ety_vocab: reviewList });
  reviewIdx++;
  showReviewCard();
}
function finishReview() {
  $('#rvCard').hidden = true;
  $('#rvDone').hidden = false;
  $('#rvDoneText').textContent = '本次复习完成，共 ' + reviewQueue.length + ' 词';
  $('#dueCount').textContent = '0';
  $('#reviewBtn').disabled = true;
}
function exitReview() {
  $('#reviewView').hidden = true;
  $('#mainView').hidden = false;
  initReview();
}

/* ==================== 翻译历史（B4） ==================== */
async function openHistory() {
  $('#mainView').hidden = true;
  $('#historyView').hidden = false;
  await renderHistory();
}
async function renderHistory() {
  const h = await chrome.storage.local.get('ety_history').catch(() => ({}));
  const list = Array.isArray(h.ety_history) ? h.ety_history : [];
  const box = $('#histList');
  box.textContent = '';
  if (!list.length) { box.innerHTML = '<div class="empty">还没有翻译记录</div>'; return; }
  list.forEach(it => {
    const row = document.createElement('div');
    row.className = 'hist-item';
    const src = document.createElement('div'); src.className = 'hs'; src.textContent = it.src || '';
    const dst = document.createElement('div'); dst.className = 'hd'; dst.textContent = it.dst || '';
    const meta = document.createElement('div'); meta.className = 'hm';
    const en = ENGINE_NAMES[it.engine] || it.engine || '';
    const t = it.ts ? new Date(it.ts).toLocaleString() : '';
    meta.textContent = (en ? en + ' · ' : '') + t;
    row.append(src, dst, meta);
    box.appendChild(row);
  });
}

/* ==================== 听写测试（C1） ==================== */
async function startSpell() {
  reviewList = await getVocabLocal();
  reviewQueue = dueVocab(reviewList);
  if (!reviewQueue.length) { alert('没有到期待复习的单词'); return; }
  reviewIdx = 0;
  $('#mainView').hidden = true;
  $('#reviewView').hidden = false;
  $('#rvDone').hidden = true;
  $('#rvCard').hidden = true;
  $('#rvSpell').hidden = false;
  showSpellCard();
}
function showSpellCard() {
  if (reviewIdx >= reviewQueue.length) return finishReview();
  const v = reviewQueue[reviewIdx];
  $('#spPhon').textContent = v.phone || '';
  $('#spInput').value = '';
  $('#spInput').disabled = false;
  $('#spDefs').hidden = true;
  $('#spDefs').textContent = '';
  $('#spActions').hidden = true;
  try { $('#spInput').focus(); } catch (e) {}
}
function spellPlay() {
  const v = reviewQueue[reviewIdx];
  if (!v) return;
  try {
    const u = new SpeechSynthesisUtterance(v.word);
    u.lang = v.isZh ? 'zh-CN' : 'en-US';
    u.rate = 0.9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) {}
}
function spellSubmit() {
  const v = reviewQueue[reviewIdx];
  if (!v) return;
  const norm = s => (s || '').trim().toLowerCase().replace(/[^a-z\u4e00-\u9fff]/g, '');
  const correct = norm($('#spInput').value) === norm(v.word);
  $('#spInput').disabled = true;
  $('#spDefs').hidden = false;
  $('#spDefs').textContent = '';
  const head = document.createElement('div');
  head.className = 'rv-def';
  head.style.fontWeight = '700';
  head.textContent = (correct ? '✓ 正确：' : '✗ 应为：') + v.word + (v.phone ? '  ' + v.phone : '');
  $('#spDefs').appendChild(head);
  (v.defs || []).forEach(d => {
    const x = document.createElement('div');
    x.className = 'rv-def';
    x.textContent = (typeof d === 'string') ? d : ((d.pos ? '【' + d.pos + '】' : '') + (d.tran || d.trans || ''));
    $('#spDefs').appendChild(x);
  });
  $('#spActions').hidden = false;
}
