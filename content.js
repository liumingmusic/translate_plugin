/**
 * 逸译 · 内容脚本
 * 1) 划词翻译：选中文本 → “译”气泡 → 结果卡片（也支持右键菜单触发）
 * 2) 全文翻译：逐段对照/仅译文，保留原排版，可随时还原
 */
(() => {
  if (window.__ETY_LOADED__) return;
  window.__ETY_LOADED__ = true;

  const IS_TOP = window === window.top;
  const MODES = ['bilingual', 'trans', 'orig', 'immersive'];
  const MAX_SEGMENTS = 1500;

  const defaults = () => ({
    engine: 'google',
    engines: ['google'],      // 多选：参与对比的翻译器（含大模型配置 id）
    fullPageEngine: 'google', // 全文翻译固定使用的单一翻译器
    from: 'auto',
    to: 'zh-CN',
    displayMode: 'bilingual',
    selectionBubble: true,
    instantTranslate: false, // 选中即自动翻译（默认关：避免每次划词都翻，烦）
    transColor: '#3b5bdb',
    dict: true,
    vocabAuto: false,
    glossaryEnabled: false,
    autoTranslate: false,
    siteBlock: [],
    accent: 'us',        // 发音口音：us 美音 / uk 英音
    slowSpeech: false,   // 慢速朗读
  });

  let settings = defaults();
  let cardPos = null; // 记忆的浮窗位置（chrome.storage.local ety_card_pos）
  let activeEngine = 'google'; // 当前（全文）实际生效的引擎，用于缓存键与批量策略

  const cache = new Map();
  const ckey = t => activeEngine + '|' + settings.from + '|' + settings.to + '|' + t;
  const ENGINE_LABELS = { google: 'Google 翻译', lingva: 'Lingva', simplytranslate: 'SimplyTranslate', mymemory: 'MyMemory', baidu: '百度翻译', llm: 'AI 大模型' };
  const isLlmId = id => typeof id === 'string' && id.startsWith('llm');
  function engineLabel(id) {
    if (isLlmId(id)) {
      const p = (settings.llmProfiles || []).find(x => x.id === id);
      if (p) return (p.name && p.name.trim() ? p.name : 'AI 大模型') + (p.model ? ' · ' + p.model : '');
      return 'AI 大模型';
    }
    return ENGINE_LABELS[id] || String(id || '');
  }
  const TO_NAMES = { 'zh-CN': '简体中文', 'zh-TW': '繁体中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', es: '西班牙语', de: '德语', ru: '俄语', it: '意大利语', pt: '葡萄牙语', ar: '阿拉伯语', th: '泰语', vi: '越南语', id: '印尼语', nl: '荷兰语', tr: '土耳其语' };

  loadSettings();
  chrome.storage.onChanged.addListener((_ch, area) => {
    if (area === 'sync') loadSettings();
  });

  async function loadSettings() {
    const s = await chrome.storage.sync.get(null).catch(() => ({}));
    const prevMode = settings.displayMode;
    settings = Object.assign(defaults(), s);
    // 规范化多选/全文引擎与大模型多配置（兼容旧版单 llm）
    if (!Array.isArray(settings.llmProfiles) || !settings.llmProfiles.length) {
      const legacy = settings.llm || {};
      settings.llmProfiles = [{ id: 'llm0', name: 'AI 大模型', baseUrl: legacy.baseUrl || 'https://api.openai.com/v1', apiKey: legacy.apiKey || '', model: legacy.model || 'gpt-4o-mini', sysPrompt: legacy.sysPrompt || '' }];
    }
    settings.llmProfiles.forEach((p, i) => { if (!p.id) p.id = 'llm' + i; });
    if (settings.engine === 'llm') settings.engine = settings.llmProfiles[0].id;
    if (!Array.isArray(settings.engines) || !settings.engines.length) settings.engines = [settings.engine];
    if (!settings.fullPageEngine || !settings.engines.includes(settings.fullPageEngine)) settings.fullPageEngine = settings.engine;
    activeEngine = settings.fullPageEngine || settings.engine;
    // 载入术语库（local）
    const gl = await chrome.storage.local.get('ety_glossary').catch(() => ({}));
    glossary = Array.isArray(gl.ety_glossary) ? gl.ety_glossary : [];
    document.documentElement.style.setProperty('--ety-color', settings.transColor || '#1a73e8');
    if (page.items.length && settings.displayMode !== prevMode) setMode(settings.displayMode);
    try { const cp = await chrome.storage.local.get('ety_card_pos'); if (cp.ety_card_pos) cardPos = cp.ety_card_pos; } catch (e) {}
  }

  /* ==================== 划词翻译 ==================== */

  let bubble = null;
  let card = null;

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onGlobalMouseDown, true);
  document.addEventListener('touchend', onTouchEnd, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { hideBubble(); hideCard(); }
  }, true);

  function onGlobalMouseDown(e) {
    const t = e.target;
    if (bubble && !(t.closest && t.closest('.ety-bubble'))) hideBubble();
    if (card && !(t.closest && t.closest('.ety-card'))) hideCard();
  }

  function onMouseUp(e) {
    if (!settings.selectionBubble) return;
    if (e.target.closest && e.target.closest('.ety-bubble,.ety-card,.ety-toolbar')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : '';
      if (!sel || !sel.rangeCount || !text || text.length > 1500) return hideBubble();
      const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      if (anchorEl && anchorEl.closest('input,textarea,[contenteditable],.ety-card,.ety-bubble,.ety-toolbar')) {
        return hideBubble();
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) return hideBubble();
      // 即时翻译（默认开启）：选中即弹卡片，免去点击气泡；关闭时回退到气泡点击
      if (settings.instantTranslate) {
        translateSelection(text, rect);
      } else {
        showBubble(rect, text);
      }
    }, 220);
  }

  // 触屏划词（D4）：桌面触屏设备可用；移动端 Android Chrome 不注入扩展内容脚本，故手机端不生效
  function onTouchEnd(e) {
    if (!settings.selectionBubble) return;
    if (e.target.closest && e.target.closest('.ety-bubble,.ety-card,.ety-toolbar')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : '';
      if (!sel || !sel.rangeCount || !text || text.length > 1500) return;
      const anchorEl = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
      if (anchorEl && anchorEl.closest('input,textarea,[contenteditable],.ety-card,.ety-bubble,.ety-toolbar')) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      if (settings.instantTranslate) translateSelection(text, rect);
      else showBubble(rect, text);
    }, 60);
  }

  function showBubble(rect, text) {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'ety-bubble';
      bubble.textContent = '译';
      bubble.title = '翻译选中文字';
      bubble.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
      bubble.addEventListener('click', e => {
        e.stopPropagation();
        hideBubble();
        translateSelection(text, rect);
      });
      document.documentElement.appendChild(bubble);
    }
    bubble.style.left = Math.max(6, Math.min(rect.left + rect.width + 6, window.innerWidth - 34)) + 'px';
    bubble.style.top = Math.max(6, rect.top - 34) + 'px';
    bubble.style.display = 'flex';
  }

  function hideBubble() {
    if (bubble) bubble.style.display = 'none';
  }
  function hideCard() {
    if (card) card.style.display = 'none';
  }

  // 可查词典的文本：单个英文单词（允许连字符/撇号/所有格）或 1~6 个汉字
  const isWordLike = t =>
    /^[A-Za-z][A-Za-z''-]{0,39}$/.test(t) || /^[\u4e00-\u9fff]{1,6}$/.test(t);

  async function translateSelection(text, rect) {
    placeCard(rect);
    // 查词模式（单词 + 开启了词典）：标题先标"词典"，避免加载中闪过默认引擎名
    const dictMode = settings.dict && isWordLike(text);
    renderCard({ loading: true, engineName: dictMode ? '词典' : undefined });

    // 查词模式：直接走词典，不显示引擎翻译
    if (dictMode && await tryDictFirst(text)) return;

    const multiOn = settings.engines && settings.engines.length > 1;
    showCompareBtn(multiOn);

    const resp = await chrome.runtime.sendMessage({
      type: 'ety-translate',
      segments: [text],
      from: settings.from,
      to: settings.to,
    }).catch(e => ({ ok: false, error: '后台服务异常：' + (e && e.message) }));
    if (resp && resp.ok) {
      renderCard({ ok: true, source: text, translation: resp.translations[0], engineName: resp.engineName, hint: resp.langHint });
      if (settings.dict && isWordLike(text)) attachDict(text);
    } else {
      renderCard({ error: (resp && resp.error) || '翻译失败' });
    }
  }

  // 查词模式：仅渲染词典面板，不显示引擎译文。返回 true 表示已渲染，false 让调用方继续走引擎。
  async function tryDictFirst(word) {
    const d = await chrome.runtime.sendMessage({ type: 'ety-dict', q: word }).catch(() => null);
    if (!d || !d.ok) return false;
    renderDictOnly(word, d);
    return true;
  }

  // 把卡片重置为纯词典视图：清掉引擎块/原文/复制按钮，标题改为"词典"
  function renderDictOnly(text, d) {
    const c = ensureCard();
    const eng = c.querySelector('.ety-card-eng');
    const lang = c.querySelector('.ety-card-lang');
    const src = c.querySelector('.ety-card-src');
    const body = c.querySelector('.ety-card-body');
    const foot = c.querySelector('.ety-card-foot');
    eng.textContent = '词典';
    lang.textContent = '';
    src.style.display = 'none';
    body.textContent = '';
    body.style.display = 'none'; // 查词模式不用译文区，整个隐藏而非留空壳
    foot.style.display = 'none';
    c.dataset.forWord = text || '';
    renderDictPanel(d);
  }

  // 异步附加词典面板（回来时卡片若已切换为别的内容则丢弃）
  async function attachDict(word) {
    const d = await chrome.runtime.sendMessage({ type: 'ety-dict', q: word }).catch(() => null);
    if (!d || !d.ok || !card || card.style.display === 'none') return;
    if (card.dataset.forWord !== word) return;
    await renderDictPanel(d);
    // 自动收藏：开启后查词自动入生词本（去重）
    if (settings.vocabAuto && !await isVocab(d.word, d.isZh)) {
      await saveVocabItem({
        word: d.word, isZh: d.isZh, phone: d.phone || d.usphone || d.ukphone || '',
        defs: d.defs || [], context: selectionContext(),
        url: location.href, ts: Date.now(),
      });
    }
  }

  // 浮窗拖拽：按住头部移动，松手记忆位置（D1）
  function startDrag(e) {
    if (e.target.closest && e.target.closest('button')) return; // 按钮（关闭/对比/设置）不触发拖拽
    const c = card;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const move = (ev) => {
      let x = ev.clientX - offX;
      let y = ev.clientY - offY;
      x = Math.max(0, Math.min(x, window.innerWidth - c.offsetWidth));
      y = Math.max(0, Math.min(y, window.innerHeight - c.offsetHeight));
      c.style.left = x + 'px';
      c.style.top = y + 'px';
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { chrome.storage.local.set({ ety_card_pos: { x: parseInt(c.style.left, 10) || 0, y: parseInt(c.style.top, 10) || 0 } }); } catch (er) {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    e.preventDefault();
  }

  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.className = 'ety-card';
    const head = document.createElement('div');
    head.className = 'ety-card-head';
    const eng = document.createElement('span'); eng.className = 'ety-card-eng';
    const lang = document.createElement('span'); lang.className = 'ety-card-lang';
    const cmpBtn = document.createElement('button');
    cmpBtn.className = 'ety-card-cmp'; cmpBtn.title = '多引擎对比'; cmpBtn.textContent = '⇄';
    cmpBtn.style.display = 'none';
    cmpBtn.addEventListener('click', e => { e.stopPropagation(); doCompare(); });
    const setBtn = document.createElement('button');
    setBtn.className = 'ety-card-set'; setBtn.title = '快捷设置'; setBtn.textContent = '⚙';
    setBtn.addEventListener('click', e => { e.stopPropagation(); if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage(); });
    const close = document.createElement('button');
    close.className = 'ety-card-close'; close.title = '关闭'; close.textContent = '×';
    close.addEventListener('click', hideCard);
    head.append(eng, lang, cmpBtn, setBtn, close);
    head.addEventListener('mousedown', startDrag);

    const src = document.createElement('div'); src.className = 'ety-card-src';
    const body = document.createElement('div'); body.className = 'ety-card-body';
    const dictBox = document.createElement('div'); dictBox.className = 'ety-dict';
    dictBox.style.display = 'none';

    const foot = document.createElement('div'); foot.className = 'ety-card-foot';
    const copy = document.createElement('button');
    copy.className = 'ety-btn'; copy.textContent = '复制译文';
    copy.addEventListener('click', () => {
      let t = '';
      const blocks = body.querySelectorAll('.ety-mblock');
      if (blocks.length) {
        // 多引擎对比：按“引擎：译文”逐块复制
        blocks.forEach(b => {
          const n = b.querySelector('.ety-mname');
          const x = b.querySelector('.ety-mbody');
          if (x) t += (n ? n.textContent + '：' : '') + x.textContent + '\n';
        });
      } else {
        t = body.textContent;
      }
      if (navigator.clipboard) {
        navigator.clipboard.writeText(t.trim()).then(() => toast('已复制译文')).catch(() => {});
      }
    });
    foot.appendChild(copy);

    card.append(head, src, body, dictBox, foot);
    document.documentElement.appendChild(card);
    return card;
  }

  function placeCard(rect) {
    const c = ensureCard();
    c.style.display = 'block';
    let x, y;
    const w = Math.min(380, window.innerWidth - 24);
    if (cardPos) {
      x = cardPos.x; y = cardPos.y;
    } else if (rect && rect.width + rect.height > 0) {
      x = Math.min(rect.left, window.innerWidth - w - 10);
      y = rect.bottom + 8;
      if (y + 250 > window.innerHeight) y = Math.max(6, rect.top - 258);
    } else {
      x = (window.innerWidth - w) / 2;
      y = Math.max(60, window.innerHeight * 0.2);
    }
    c.style.left = Math.max(8, x) + 'px';
    c.style.top = Math.max(6, y) + 'px';
  }

  /* ---- 发音 ---- */
  let lastAudio = null;
  function synthSpeak(text, lang) {
    try {
      if (!('speechSynthesis' in window)) return false;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang || (/[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US');
      u.rate = settings.slowSpeech ? 0.8 : 0.95;
      // 尽量挑选匹配语种的音色，避免用中文音色读英文
      try {
        const vl = speechSynthesis.getVoices();
        const v = vl.find(x => x.lang && x.lang.replace('_', '-').toLowerCase().indexOf(u.lang.slice(0, 2).toLowerCase()) === 0);
        if (v) u.voice = v;
      } catch (e) { /* ignore */ }
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  // 清洗朗读文本：去零宽字符/软连字符、压缩空白、剥离首尾标点
  // （网页选区常带不可见脏字符，会让真人发音接口拿到乱码而不出声）
  function cleanSpeechText(raw) {
    return String(raw || '')
      .replace(/[\u200b\u200c\u200d\uFEFF\u00ad]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[\s"'「」『』“”‘’()（）[\]【】.,、，。;；:：!！?？·-]+|[\s"'「」『』“”‘’()（）[\]【】.,、，。;；:：!！?？·-]+$/g, '')
      .trim();
  }

  function speak(rawText, lang, btn) {
    const text = cleanSpeechText(rawText);
    if (!text) return;
    if (btn) {
      btn.classList.add('ety-spk-on');
      setTimeout(() => btn.classList.remove('ety-spk-on'), 2500);
    }
    try { if (lastAudio) { lastAudio.pause(); lastAudio.onended = lastAudio.onerror = null; lastAudio = null; } } catch (e) { /* ignore */ }
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) { /* ignore */ }

    const isZh = /[\u4e00-\u9fff]/.test(text);
    const isEn = /^[A-Za-z]/.test(text);
    if (isZh || isEn) {
      // 英文发音按口音偏好选 type：美音 2 / 英音 1；中文固定 1
      const typeNum = isZh ? 1 : (settings.accent === 'uk' ? 1 : 2);
      const a = new Audio('https://dict.youdao.com/dictvoice?type=' + typeNum + '&audio=' + encodeURIComponent(text.slice(0, 200)));
      lastAudio = a;
      let settled = false;
      const fallbackTTS = () => {
        if (settled) return;
        settled = true;
        if (lastAudio === a) lastAudio = null;
        synthSpeak(text, lang);
      };
      a.onerror = fallbackTTS;
      a.play().then(() => {
        a.onended = () => { settled = true; };
        // 静默失败看门狗：2.2s 内没有实际进度（被页面策略拦截等）则转系统 TTS
        setTimeout(() => { if (!settled && (a.paused || a.currentTime <= 0)) fallbackTTS(); }, 2200);
      }).catch(fallbackTTS);
      return;
    }
    synthSpeak(text, lang);
  }

  function spkBtn(text, lang, title, cn) {
    const b = document.createElement('button');
    b.className = 'ety-spk';
    b.title = title || '朗读';
    b.textContent = '▸';
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (cn !== undefined) speakExample(text, cn, b);
      else speak(text, lang, b);
    });
    return b;
  }

  // 例句连续朗读：真人发音读英文，间隔后用系统 TTS 读中文（可慢速），回应“读音很快”反馈
  function speakExample(en, cn, btn) {
    const e = cleanSpeechText(en);
    if (!e) return;
    if (btn) { btn.classList.add('ety-spk-on'); setTimeout(() => btn.classList.remove('ety-spk-on'), 3200); }
    try { if (lastAudio) { lastAudio.pause(); lastAudio.onended = lastAudio.onerror = null; lastAudio = null; } } catch (er) {}
    try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (er) {}
    const isZh = /[\u4e00-\u9fff]/.test(e);
    const typeNum = isZh ? 1 : (settings.accent === 'uk' ? 1 : 2);
    const a = new Audio('https://dict.youdao.com/dictvoice?type=' + typeNum + '&audio=' + encodeURIComponent(e.slice(0, 200)));
    lastAudio = a;
    let settled = false;
    const readCn = () => { const c = cleanSpeechText(cn); if (c) synthSpeak(c, 'zh-CN'); };
    const fallback = () => { if (settled) return; settled = true; synthSpeak(e, isZh ? 'zh-CN' : 'en-US'); };
    a.onerror = fallback;
    a.play().then(() => {
      a.onended = () => { settled = true; if (cleanSpeechText(cn)) setTimeout(readCn, 350); };
      setTimeout(() => { if (!settled && (a.paused || a.currentTime <= 0)) fallback(); }, 2200);
    }).catch(fallback);
  }

  // 联动查词：点击词组/近义词中的单词，重新查询该词并替换卡片
  async function lookupWord(word) {
    const w = String(word || '').trim();
    if (!w) return;
    if (card && card.style.display !== 'none') {
      renderDictOnly(w, { loading: true });
    }
    const d = await chrome.runtime.sendMessage({ type: 'ety-dict', q: w }).catch(() => null);
    if (!card || card.style.display === 'none') return;
    if (d && d.ok) renderDictOnly(w, d);
    else renderCard({ error: '未查询到「' + w + '」的词典数据' });
  }

  function showCompareBtn(on) {
    const c = card && card.querySelector('.ety-card-cmp');
    if (c) c.style.display = on ? '' : 'none';
  }

  async function doCompare() {
    const text = (card && card.dataset.forWord) || '';
    if (!text) { toast('暂无可对比的文本'); return; }
    renderCard({ loading: true, source: text, engineName: '多引擎对比' });
    const resp = await chrome.runtime.sendMessage({ type: 'ety-compare', text })
      .catch(e => ({ ok: false, error: '后台服务异常：' + (e && e.message) }));
    if (resp && Array.isArray(resp.results)) {
      renderCard({ multi: resp.results, source: text });
      if (settings.dict && isWordLike(text)) attachDict(text);
    } else {
      renderCard({ error: (resp && resp.error) || '对比失败' });
    }
  }

  function renderCard(state) {
    const c = ensureCard();
    const eng = c.querySelector('.ety-card-eng');
    const lang = c.querySelector('.ety-card-lang');
    const src = c.querySelector('.ety-card-src');
    const body = c.querySelector('.ety-card-body');
    const foot = c.querySelector('.ety-card-foot');
    const dictBox = c.querySelector('.ety-dict');

    eng.textContent = state.engineName || (state.multi ? '多引擎对比' : engineLabel(settings.engine));
    c.dataset.forWord = state.source || '';
    c.classList.remove('ety-rich');
    body.style.display = 'block'; // 复位：查词模式隐藏过，切回引擎模式要恢复
    dictBox.style.display = 'none';
    dictBox.textContent = '';

    if (state.loading) {
      lang.textContent = '';
      src.style.display = 'none';
      foot.style.display = 'none';
      body.textContent = '';
      const dots = document.createElement('span');
      dots.className = 'ety-loading';
      for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
      body.appendChild(dots);
    } else if (state.multi) {
      // 多引擎对比：每个引擎一个独立分组块，清晰的“引擎名 → 译文”结构
      lang.textContent = (settings.from === 'auto' ? '自动检测' : settings.from.toUpperCase()) + ' → ' + (TO_NAMES[settings.to] || settings.to);
      src.textContent = '';
      src.append(Object.assign(document.createElement('span'), { textContent: state.source || '' }));
      if (state.source) src.appendChild(spkBtn(state.source, null, '朗读原文'));
      src.style.display = state.source ? 'flex' : 'none';
      foot.style.display = 'flex';
      body.textContent = '';
      const items = state.multi.slice();
      items.sort((a, b) => ((a.translation != null) ? 0 : 1) - ((b.translation != null) ? 0 : 1)); // 失败的排后面
      items.forEach(item => {
        const block = document.createElement('div');
        block.className = 'ety-mblock' + (item.translation != null ? '' : ' ety-mfail');
        const mh = document.createElement('div');
        mh.className = 'ety-mhead';
        const name = document.createElement('span');
        name.className = 'ety-mname';
        name.textContent = engineLabel(item.engine);
        mh.appendChild(name);
        if (item.fallback) {
          const fb = document.createElement('span');
          fb.className = 'ety-mfb';
          fb.title = '原引擎不可达，译文实际来自该备用引擎';
          fb.textContent = '（由 ' + engineLabel(item.fallback) + ' 提供）';
          mh.appendChild(fb);
        }
        const txt = document.createElement('div');
        txt.className = 'ety-mbody';
        if (item.translation != null) {
          txt.textContent = item.translation;
          mh.appendChild(spkBtn(item.translation, null, '朗读译文'));
        } else {
          txt.textContent = '⚠ ' + (item.error || '翻译失败');
        }
        block.append(mh, txt);
        body.appendChild(block);
      });
    } else if (state.ok) {
      lang.textContent = state.hint || '';
      src.textContent = '';
      src.append(Object.assign(document.createElement('span'), { textContent: state.source || '' }));
      if (state.source) src.appendChild(spkBtn(state.source, null, '朗读原文'));
      src.style.display = state.source ? 'flex' : 'none';
      foot.style.display = 'flex';
      body.textContent = '';
      const txt = document.createElement('div');
      txt.textContent = state.translation || '（无返回内容）';
      body.appendChild(txt);
      if (state.translation) body.appendChild(spkBtn(state.translation, null, '朗读译文'));
    } else {
      lang.textContent = '';
      src.style.display = 'none';
      foot.style.display = 'none';
      body.textContent = '';
      const err = document.createElement('div');
      err.className = 'ety-error';
      err.textContent = '⚠ ' + (state.error || '未知错误');
      body.appendChild(err);
    }
  }

  /* ---- 词典详情面板 ---- */
  async function renderDictPanel(d) {
    const c = ensureCard();
    const box = c.querySelector('.ety-dict');
    box.textContent = '';
    box.style.display = 'block';
    box.onclick = (e) => {
      const wl = e.target.closest('.ety-wlink');
      if (wl && wl.dataset.w) { e.stopPropagation(); lookupWord(wl.dataset.w); }
    };
    c.classList.add('ety-rich');

    // 头部：单词 + 发音按钮 + 音标 + 考试标签
    const head = document.createElement('div');
    head.className = 'ety-dhead';
    const word = document.createElement('span');
    word.className = 'ety-dword';
    word.textContent = d.word;
    head.appendChild(word);
    // 单词旁主发音按钮：中英文都可用（文本已在 speak 内清洗）
    head.appendChild(spkBtn(d.word, d.isZh ? 'zh-CN' : (settings.accent === 'uk' ? 'en-GB' : 'en-US'), '朗读单词'));
    if (d.phone) {
      const p = document.createElement('span');
      p.className = 'ety-dphon';
      p.textContent = d.phone;
      head.appendChild(p);
    }
    if (d.usphone) {
      const p = document.createElement('span');
      p.className = 'ety-dphon';
      p.textContent = (d.ukphone ? 'US ' : '') + d.usphone;
      head.appendChild(p);
      head.appendChild(spkBtn(d.word, 'en-US', '美音'));
    }
    if (d.ukphone) {
      const p = document.createElement('span');
      p.className = 'ety-dphon';
      p.textContent = 'UK ' + d.ukphone;
      head.appendChild(p);
      head.appendChild(spkBtn(d.word, 'en-GB', '英音'));
    }
    box.appendChild(head);
    if (Array.isArray(d.tags) && d.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'ety-dtags';
      d.tags.forEach(t => {
        const s = document.createElement('span');
        s.className = 'ety-dtag';
        s.textContent = t;
        tags.appendChild(s);
      });
      box.appendChild(tags);
    }

    const addSec = (title) => {
      const sec = document.createElement('div');
      sec.className = 'ety-dsec';
      const h = document.createElement('h4');
      h.textContent = title;
      sec.appendChild(h);
      box.appendChild(sec);
      return sec;
    };

    if (Array.isArray(d.defs) && d.defs.length) {
      const sec = addSec('释义');
      d.defs.forEach(t => {
        const p = document.createElement('div');
        p.className = 'ety-ddef';
        p.textContent = t;
        sec.appendChild(p);
      });
    }
    if (Array.isArray(d.forms) && d.forms.length) {
      const sec = addSec('词形变化');
      d.forms.forEach(f => {
        const p = document.createElement('div');
        p.className = 'ety-dline';
        p.textContent = f.pos + '  ' + f.words.join('、');
        sec.appendChild(p);
      });
    }
    if (Array.isArray(d.phrases) && d.phrases.length) {
      const sec = addSec('常用词组');
      d.phrases.forEach(ph => {
        const p = document.createElement('div');
        p.className = 'ety-dline';
        const b = document.createElement('b');
        b.textContent = ph.w;
        b.className = 'ety-wlink';
        b.dataset.w = ph.w;
        p.appendChild(b);
        if (ph.t) p.appendChild(document.createTextNode('  ' + ph.t));
        sec.appendChild(p);
      });
    }
    if (Array.isArray(d.syno) && d.syno.length) {
      const sec = addSec('近义词');
      d.syno.forEach(s => {
        const p = document.createElement('div');
        p.className = 'ety-dline';
        p.textContent = (s.pos ? s.pos + ' ' : '') + (s.tran ? s.tran + '：' : '');
        (s.words || []).forEach((w, i) => {
          const sp = document.createElement('span');
          sp.className = 'ety-wlink';
          sp.dataset.w = w;
          sp.textContent = w;
          p.appendChild(sp);
          if (i < s.words.length - 1) p.appendChild(document.createTextNode('、'));
        });
        sec.appendChild(p);
      });
    }
    if (Array.isArray(d.sents) && d.sents.length) {
      const sec = addSec('双语例句');
      d.sents.forEach(s => {
        const p = document.createElement('div');
        p.className = 'ety-dsent';
        const en = document.createElement('div');
        en.className = 'ety-dsent-en';
        const b = document.createElement('b');
        b.textContent = s.en;
        en.appendChild(b);
        en.appendChild(spkBtn(s.en, d.isZh ? 'zh-CN' : 'en-US', '朗读例句', s.cn));
        const cn = document.createElement('div');
        cn.className = 'ety-dsent-cn' + (s.cn ? '' : ' ety-dsent-cn-empty');
        cn.textContent = s.cn || '暂无中文译例';
        p.append(en, cn);
        sec.appendChild(p);
      });
    }

    // 底部操作条：收藏到生词本
    const foot = document.createElement('div');
    foot.className = 'ety-dfoot';
    const saved = await isVocab(d.word, d.isZh);
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ety-save' + (saved ? ' ety-saved' : '');
    saveBtn.textContent = saved ? '✓ 已收藏' : '☆ 收藏';
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.classList.contains('ety-saved')) {
        await removeVocabItem(d.word, d.isZh);
        saveBtn.classList.remove('ety-saved');
        saveBtn.textContent = '☆ 收藏';
        toast('已从生词本移除');
        return;
      }
      await saveVocabItem({
        word: d.word, isZh: d.isZh, phone: d.phone || d.usphone || d.ukphone || '',
        defs: d.defs || [], context: selectionContext(),
        url: location.href, ts: Date.now(),
      });
      saveBtn.classList.add('ety-saved');
      saveBtn.textContent = '✓ 已收藏';
      toast('已加入生词本');
    });
    const copyDef = document.createElement('button');
    copyDef.className = 'ety-save';
    copyDef.textContent = '复制释义';
    copyDef.addEventListener('click', () => {
      const defs = (d.defs || []).join('\n');
      if (navigator.clipboard) navigator.clipboard.writeText(defs).then(() => toast('已复制释义')).catch(() => {});
    });
    const link = document.createElement('a');
    link.className = 'ety-dlink';
    link.target = '_blank';
    link.rel = 'noopener';
    link.href = 'https://dict.youdao.com/search?q=' + encodeURIComponent(d.word);
    link.textContent = '有道网页 ↗';
    foot.append(copyDef, link, saveBtn);
    box.appendChild(foot);
  }

  /* ==================== 生词本 + 术语库 ==================== */

  // 生词本（local 存储，可离线、容量大）
  async function getVocab() {
    const v = await chrome.storage.local.get('ety_vocab').catch(() => ({}));
    return Array.isArray(v.ety_vocab) ? v.ety_vocab : [];
  }
  async function saveVocabItem(item) {
    const list = await getVocab();
    const i = list.findIndex(x => x.word === item.word && x.isZh === item.isZh);
    if (i >= 0) {
      list[i] = Object.assign(list[i], item);
    } else {
      // 新建生词：初始化记忆曲线字段（nextReview=0 表示立即可复习）
      list.unshift(Object.assign({ reviews: 0, nextReview: 0 }, item));
    }
    list.sort((a, b) => b.ts - a.ts);
    if (list.length > 2000) list.length = 2000;
    await chrome.storage.local.set({ ety_vocab: list });
  }
  async function removeVocabItem(word, isZh) {
    const list = await getVocab();
    const next = list.filter(x => !(x.word === word && x.isZh === isZh));
    await chrome.storage.local.set({ ety_vocab: next });
  }
  async function isVocab(word, isZh) {
    const list = await getVocab();
    return list.some(x => x.word === word && x.isZh === isZh);
  }

  // 取选中词在页面中的上下文片段（用于生词本回忆）
  function selectionContext() {
    const sel = window.getSelection();
    const node = sel && sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const block = el && el.closest('p,li,td,h1,h2,h3,h4,blockquote,div');
    const txt = block ? block.textContent : (el ? el.textContent : '');
    return txt ? txt.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  }

  // 术语库（用户自定义固定译法），loadSettings 时载入
  let glossary = [];

  // 术语库智能匹配：英文用词边界 \b 避免 "React" 在 "reactive" 中被误替；中文用普通包含；
  // 大小写还原：原文首字母大写则译文首字母也大写
  function applyGlossary(text) {
    if (!settings.glossaryEnabled || !glossary.length) return text;
    let t = text;
    for (const g of glossary) {
      if (!g.src || !g.dst) continue;
      try {
        const escaped = g.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hasCJK = /[\u4e00-\u9fff]/.test(g.src);
        const re = hasCJK ? new RegExp(escaped, 'gi') : new RegExp('\\b' + escaped + '\\b', 'gi');
        t = t.replace(re, (m) => {
          let dst = g.dst;
          if (m.length && m[0] === m[0].toUpperCase() && m.slice(1) === m.slice(1).toLowerCase() && dst) {
            dst = dst.charAt(0).toUpperCase() + dst.slice(1);
          }
          return dst;
        });
      } catch (e) { /* 忽略非法正则 */ }
    }
    return t;
  }

  /* ==================== 全文翻译 ==================== */

  const page = { items: [], translating: false, toolbar: null, mode: 'bilingual', statusEl: null, modeBtns: [], lastFailed: 0 };

  // 块级对照 + 双向高亮：pairMap[id] = { o: 原文块元素, t: 译文块元素 }
  let pairMap = {};
  let pairSeq = 0;
  let pairListenersOn = false;

  const SKIP_SELECTOR = 'script,style,noscript,template,textarea,select,code,pre,xmp,svg,math,iframe,object,canvas,[contenteditable]';

  // 块级判断：最近的“块级祖先”作为一段译文的单位，保证原文一段→译文一段的对照
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'CAPTION', 'ARTICLE', 'SECTION', 'ASIDE',
    'HEADER', 'FOOTER', 'MAIN', 'NAV', 'FORM', 'FIELDSET', 'TABLE', 'UL', 'OL', 'DL']);
  function isBlockEl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (BLOCK_TAGS.has(el.tagName)) return true;
    try {
      const d = getComputedStyle(el).display;
      return d === 'block' || d === 'flow-root' || d === 'flex' || d === 'grid'
        || d === 'list-item' || d === 'table' || d === 'table-cell' || d === 'table-row' || d === 'inline-block';
    } catch (e) { return false; }
  }
  function nearestBlock(node) {
    let el = node.parentElement;
    while (el) {
      if (isBlockEl(el)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  // 按块聚合文本节点：同一块内的多个文本节点合并为一段（解决逐节点换行导致的对照混乱）
  function collectBlocks() {
    const items = [];
    const byBlock = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(SKIP_SELECTOR) || p.closest('.ety-toolbar,.ety-card,.ety-bubble,.ety-toast,.ety-t-block,.ety-orig')) {
          return NodeFilter.FILTER_REJECT;
        }
        const v = node.nodeValue;
        if (!v || !v.trim()) return NodeFilter.FILTER_REJECT;
        if (!/[\p{L}\p{N}]/u.test(v)) return NodeFilter.FILTER_REJECT;
        let st;
        try { st = getComputedStyle(p); } catch (e) { return NodeFilter.FILTER_REJECT; }
        if (st.display === 'none' || st.visibility === 'hidden' || st.fontSize === '0px') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n, count = 0;
    while ((n = walker.nextNode()) && count < MAX_SEGMENTS) {
      const bk = nearestBlock(n);
      let it = byBlock.get(bk);
      if (!it) {
        it = { blockEl: bk, raw: '', t: null };
        byBlock.set(bk, it);
        items.push(it);
      }
      it.raw += n.nodeValue;
      count++;
    }
    items.forEach(it => { it.text = (it.raw || '').replace(/\s+/g, ' ').trim(); it.raw = null; });
    return items.filter(it => it.text);
  }

  // 全文翻译：原文块保持原样（不拆分、保留加粗/链接等格式），译文作为独立块紧跟其后
  function wrapBlock(it) {
    const blockEl = it.blockEl;
    if (!blockEl || !blockEl.isConnected) return;
    const id = 'ety-b' + (++pairSeq);
    blockEl.dataset.etyId = id;
    const tEl = document.createElement('div');
    tEl.className = 'ety-t-block ety-loading-t';
    tEl.dataset.etyPair = id;
    tEl.title = it.text;
    tEl.innerHTML = '<i></i><i></i><i></i>';
    // 受限父容器（tr/ul/ol 只允许特定子元素）：afterend 插入 div 兄弟是非法 HTML，
    // 会被浏览器游离到表格/列表外。改为把原文包裹进 .ety-orig，译文放内部末尾。
    if (blockEl.tagName === 'TD' || blockEl.tagName === 'TH' || blockEl.tagName === 'LI') {
      blockEl.classList.add('ety-inner-pair');
      const origWrap = document.createElement('div');
      origWrap.className = 'ety-orig';
      while (blockEl.firstChild) origWrap.appendChild(blockEl.firstChild);
      blockEl.appendChild(origWrap);
      blockEl.appendChild(tEl);
    } else {
      blockEl.insertAdjacentElement('afterend', tEl);
    }
    it.t = tEl;
    pairMap[id] = { o: blockEl, t: tEl };
  }

  async function startPageTranslation() {
    if (page.translating) { toast('正在翻译中，请稍候'); return; }
    if (settings.from !== 'auto' && settings.from === settings.to) { toast('源语言与目标语言相同，无需翻译'); return; }
    let items;
    try { items = collectBlocks(); } catch (e) { toast('页面结构异常：' + e.message); return; }
    if (!items.length) { toast('未找到可翻译的文本'); return; }
    page.items = items;
    page.translating = true;
    page.aborted = false;
    pairMap = {};
    pairSeq = 0;
    page.mode = settings.displayMode || 'bilingual';
    if (IS_TOP) buildToolbar();
    setMode(page.mode);
    for (const it of items) wrapBlock(it);
    addPairListeners();
    await runTranslation(items);
    page.translating = false;
    if (!page.lastFailed) toast('翻译完成 · 选中原文或译文可高亮对应句');
  }

  async function runTranslation(items) {
    activeEngine = settings.fullPageEngine || settings.engine; // 全文翻译固定用 fullPageEngine
    const segsAll = items.map(x => x.text);
    const BATCH = isLlmId(activeEngine) ? 1e9 : 20; // LLM 整页一次送，带全文上下文
    const CONC = activeEngine === 'baidu' ? 1 : 2;
    const batches = [];
    for (let i = 0; i < items.length; i += BATCH) batches.push(items.slice(i, i + BATCH));

    let done = 0, failed = 0, bi = 0, lastErr = null;
    const setStatus = (s, ratio) => {
      if (page.statusEl) page.statusEl.textContent = s;
      if (page.progressEl) {
        if (ratio == null) {
          page.progressEl.parentElement.classList.add('ety-done');
        } else {
          page.progressEl.parentElement.classList.remove('ety-done');
          page.progressEl.style.width = Math.max(0, Math.min(100, Math.round(ratio * 100))) + '%';
        }
      }
    };

    const workers = Array.from({ length: Math.min(CONC, batches.length) }, async () => {
      while (bi < batches.length) {
        if (page.aborted) return;
        const batch = batches[bi++];
        const need = batch.filter(x => !cache.has(ckey(x.text)));
        if (need.length) {
          const payload = { type: 'ety-translate', segments: need.map(x => x.text) };
          payload.engine = activeEngine; // 全文翻译用 fullPageEngine 指定的单一引擎
          if (isLlmId(activeEngine)) payload.fullText = segsAll.join('\n'); // 文档级上下文
          const resp = await chrome.runtime.sendMessage(payload)
            .catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
          if (resp && resp.ok) {
            need.forEach((x, k) => cache.set(ckey(x.text), resp.translations[k] != null ? resp.translations[k] : x.text));
          } else {
            lastErr = (resp && resp.error) || '翻译请求失败';
          }
        }
        for (const x of batch) {
          const t = cache.get(ckey(x.text));
          x.t.classList.remove('ety-loading-t'); // 停止跳动三点，准备填译文
          if (t == null) {
            x.t.textContent = x.text;
            x.t.classList.add('ety-fail');
            // 失败段：附加重试按钮（再走一次降级链）
            const retry = document.createElement('button');
            retry.className = 'ety-retry';
            retry.type = 'button';
            retry.textContent = '⟳ 重试';
            retry.title = '重新翻译该段';
            retry.addEventListener('click', ev => {
              ev.stopPropagation();
              retry.remove();
              x.t.classList.remove('ety-fail');
              x.t.classList.add('ety-loading-t');
              x.t.textContent = '';
              x.t.innerHTML = '<i></i><i></i><i></i>';
              chrome.runtime.sendMessage({ type: 'ety-translate', segments: [x.text], engine: activeEngine })
                .then(r => {
                  if (r && r.ok) {
                    x.t.classList.remove('ety-loading-t');
                    const tt = applyGlossary(r.translations[0]);
                    x.t.textContent = tt;
                    x.t.title = x.text;
                  } else {
                    x.t.classList.remove('ety-loading-t');
                    x.t.textContent = x.text;
                    x.t.classList.add('ety-fail');
                    x.t.appendChild(retry);
                    toast('重试失败：' + ((r && r.error) || '未知错误'));
                  }
                })
                .catch(() => {
                  x.t.classList.remove('ety-loading-t');
                  x.t.textContent = x.text;
                  x.t.classList.add('ety-fail');
                  x.t.appendChild(retry);
                });
            });
            x.t.appendChild(retry);
            failed++;
          } else {
            const tt = applyGlossary(t);
            x.t.textContent = tt;
            x.t.title = x.text; // 悬浮原文
          }
          done++;
        }
        setStatus('翻译中 ' + done + '/' + items.length, done / items.length);
      }
    });

    await Promise.all(workers);
    page.lastFailed = failed;
    setStatus(failed ? '完成 · ' + failed + ' 段失败' : '翻译完成', 1);
    setTimeout(() => { if (page.progressEl) page.progressEl.parentElement.classList.add('ety-done'); }, 1200);
    if (failed === items.length && lastErr) toast('翻译失败：' + lastErr);
  }

  function setMode(m) {
    page.mode = m;
    const cl = document.documentElement.classList;
    MODES.forEach(x => cl.remove('ety-mode-' + x));
    cl.add('ety-mode-' + m);
    page.modeBtns.forEach(b => b.classList.toggle('ety-active', b.dataset.m === m));
  }

  function buildToolbar() {
    if (page.toolbar) { page.toolbar.style.display = 'flex'; return; }
    const tb = document.createElement('div');
    tb.className = 'ety-toolbar';

    const status = document.createElement('span');
    status.className = 'ety-status';
    status.textContent = '准备中…';

    const progress = document.createElement('span');
    progress.className = 'ety-progress ety-done';
    const progressBar = document.createElement('i');
    progress.appendChild(progressBar);

    const modes = document.createElement('span');
    modes.className = 'ety-modes';
    [['bilingual', '对照'], ['trans', '仅译文'], ['orig', '原文']].forEach(([m, label]) => {
      const b = document.createElement('button');
      b.dataset.m = m;
      b.textContent = label;
      b.addEventListener('click', () => setMode(m));
      modes.appendChild(b);
    });

    const restore = document.createElement('button');
    restore.className = 'ety-restore';
    restore.textContent = '✕ 关闭';
    restore.title = '关闭翻译，恢复原网页';
    restore.addEventListener('click', restorePage);

    const saveTerm = document.createElement('button');
    saveTerm.className = 'ety-term-btn';
    saveTerm.textContent = '☆ 存术语';
    saveTerm.title = '选中任意文本后点击，保存为固定译法（术语库）';
    saveTerm.addEventListener('click', async () => {
      const sel = window.getSelection();
      const txt = sel ? String(sel).trim() : '';
      if (!txt) { toast('请先选中要保存的译文或原文片段'); return; }
      const src = prompt('为该片段指定固定译法：\n请填写「原文」（应被替换的词/短语），留空则直接用选中文本作为术语', '');
      if (src === null) return;
      const list = await chrome.storage.local.get('ety_glossary').catch(() => ({}));
      const arr = Array.isArray(list.ety_glossary) ? list.ety_glossary : [];
      arr.push({ src: (src || '').trim() || txt, dst: txt });
      await chrome.storage.local.set({ ety_glossary: arr });
      const sg = await chrome.storage.sync.get('glossaryEnabled').catch(() => ({}));
      if (!sg.glossaryEnabled) await chrome.storage.sync.set({ glossaryEnabled: true });
      toast('已保存术语，翻译时将优先采用');
    });

    tb.append(status, progress, modes, saveTerm, restore);
    document.documentElement.appendChild(tb);
    tb.style.display = 'flex';

    page.toolbar = tb;
    page.statusEl = status;
    page.progressEl = progressBar;
    page.modeBtns = Array.from(modes.querySelectorAll('button'));
  }

  /* ==================== 双向高亮（选中/悬停原文↔译文） ==================== */
  function pairOf(el) {
    if (!el) return null;
    if (el.nodeType === 3) el = el.parentElement; // 文本节点（选区锚点）→ 取其元素
    if (!el || !el.closest) return null;
    const t = el.closest('.ety-t-block');
    if (t && t.dataset.etyPair) return pairMap[t.dataset.etyPair] || null;
    const o = el.closest('[data-ety-id]');
    if (o && o.dataset.etyId) return pairMap[o.dataset.etyId] || null;
    return null;
  }

  // 记录当前高亮元素，避免每次 clearPairCls 全文档 querySelectorAll（大页面性能）
  let curHl = [];   // 选中强高亮
  let curHov = [];  // 悬停弱高亮
  function setPair(cls, els) {
    const prev = cls === 'ety-pair-hl' ? curHl : curHov;
    if (prev.length) prev.forEach(e => e.classList.remove(cls));
    if (els && els.length) els.forEach(e => e.classList.add(cls));
    if (cls === 'ety-pair-hl') curHl = els || []; else curHov = els || [];
  }
  function clearPairCls(cls) { setPair(cls, []); }

  // 选区与某个元素是否相交（兼容无 intersectsNode 的环境，用包围盒兜底）
  function rangeIntersectsEl(range, el) {
    try {
      if (range.intersectsNode) return range.intersectsNode(el);
    } catch (e) {}
    const er = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const rr = range.getBoundingClientRect ? range.getBoundingClientRect() : null;
    if (er && rr) {
      return !(rr.right < er.left || rr.left > er.right || rr.bottom < er.top || rr.top > er.bottom);
    }
    return el.contains(range.startContainer) || el.contains(range.endContainer);
  }

  // 收集与选区相交的所有“块对”，返回需要高亮的 [o,t] 列表（去重）
  function pairsInSelection(sel) {
    const out = [];
    const seen = new Set();
    if (!sel || !sel.rangeCount) return out;
    const range = sel.getRangeAt(0);
    document.querySelectorAll('[data-ety-id], .ety-t-block').forEach(el => {
      if (!rangeIntersectsEl(range, el)) return;
      const p = pairOf(el);
      if (p && p.o && p.t) {
        const k = p.o.dataset.etyId;
        if (!seen.has(k)) { seen.add(k); out.push(p.o, p.t); }
      }
    });
    return out;
  }

  // 选中文本：高亮所有与选区相交的“原文↔译文”块对（不再只亮锚点块）
  function onPairSelect(e) {
    // 在卡片/气泡/工具栏内操作不触发高亮
    if (e && e.target && e.target.closest && e.target.closest('.ety-card,.ety-bubble,.ety-toolbar')) { clearPairCls('ety-pair-hl'); return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { clearPairCls('ety-pair-hl'); return; }
    setPair('ety-pair-hl', pairsInSelection(sel));
  }
  // 悬停：高亮“当前块”对应的另一块（轻量）
  function onPairHover(e) {
    if (!e || !e.target) return;
    if (e.target.closest && e.target.closest('.ety-card,.ety-bubble,.ety-toolbar')) { clearPairCls('ety-pair-hov'); return; }
    if (window.getSelection && !window.getSelection().isCollapsed) return; // 选区优先，悬停不抢
    clearPairCls('ety-pair-hov');
    const p = pairOf(e.target);
    if (p && p.o && p.t) setPair('ety-pair-hov', [p.o, p.t]);
  }
  function addPairListeners() {
    if (pairListenersOn) return;
    // 捕获阶段注册：避免页面元素 stopPropagation 把冒泡事件吞掉，导致 document 收不到
    document.addEventListener('mouseup', onPairSelect, true);
    document.addEventListener('mouseover', onPairHover, true);
    pairListenersOn = true;
  }
  function removePairListeners() {
    if (!pairListenersOn) return;
    document.removeEventListener('mouseup', onPairSelect, true);
    document.removeEventListener('mouseover', onPairHover, true);
    clearPairCls('ety-pair-hl');
    clearPairCls('ety-pair-hov');
    pairListenersOn = false;
  }

  function restorePage() {
    page.aborted = true;
    page.translating = false;
    document.querySelectorAll('.ety-t-block').forEach(el => el.remove());
    // 解包裹：把 .ety-orig 内的原文节点移回原容器，再删除 .ety-orig
    document.querySelectorAll('.ety-orig').forEach(el => {
      const p = el.parentNode;
      if (!p) return;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
    });
    document.querySelectorAll('[data-ety-id]').forEach(el => { delete el.dataset.etyId; el.classList.remove('ety-inner-pair'); });
    pairMap = {};
    pairSeq = 0;
    removePairListeners();
    const cl = document.documentElement.classList;
    MODES.forEach(x => cl.remove('ety-mode-' + x));
    page.items = [];
    if (page.toolbar) page.toolbar.style.display = 'none';
  }

  /* ==================== 轻提示 ==================== */

  let toastTimer = null;
  function toast(msg) {
    if (!IS_TOP) return;
    let el = document.querySelector('.ety-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ety-toast';
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('ety-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('ety-show'), 2600);
  }

  /* ==================== 自动翻译外语页面 ==================== */

  // 命中设置 + 站点不在黑名单 + 页面语言非目标语言时，加载后自动逐段翻译
  if (IS_TOP) {
    setTimeout(async () => {
      const s = await chrome.storage.sync.get(null).catch(() => ({}));
      const st = Object.assign(defaults(), s);
      if (!st.autoTranslate) return;
      const host = location.hostname;
      if (Array.isArray(st.siteBlock) && st.siteBlock.some(b => host === b || host.endsWith('.' + b))) return;
      const langAttr = (document.documentElement.lang || '').toLowerCase();
      if (!langAttr) return; // 无法判断语言，不自动翻
      const target = (st.to || 'zh-CN').split('-')[0];
      if (langAttr.split('-')[0] === target) return; // 已是目标语言
      startPageTranslation();
    }, 900);
  }

  /* ==================== 消息入口 ==================== */

  // 右键菜单翻译：当前帧的选区是否就是要翻译的文本（忽略空白差异，兼容 selectionText 的换行/空格归一）
  function matchSelectionRect(text) {
    const sel = window.getSelection();
    const cur = sel ? String(sel) : '';
    if (!cur.trim() || !text) return null;
    const norm = s => String(s || '').replace(/\s+/g, '');
    if (norm(cur) !== norm(text)) return null;
    return sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ety-ping') {
      sendResponse({ ok: true });
      return;
    }

    // 快捷键翻译选中文字（D2）：取当前选区直接翻译
    if (msg.type === 'ety-translate-selection-hotkey') {
      const sel = window.getSelection();
      const text = sel ? String(sel).trim() : '';
      if (text) {
        const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
        translateSelection(text, rect);
      }
      return;
    }

    if (msg.type === 'ety-translate-page') {
      startPageTranslation();
      return;
    }
    if (msg.type === 'ety-restore-page') {
      restorePage();
      return;
    }

    if (msg.type === 'ety-selection-start') {
      const rect = matchSelectionRect(msg.text);
      if (rect) {
        placeCard(rect);
        hideBubble();
        // 查词模式：标题先标"词典"，避免加载中闪过默认引擎名
        const headerEngine = (settings.dict && isWordLike(msg.text)) ? '词典' : undefined;
        renderCard({ loading: true, source: msg.text, engineName: headerEngine });
        showCompareBtn(settings.engines && settings.engines.length > 1);
        sendResponse({ shown: true });
      }
      return;
    }

    // 右键菜单：多引擎对比结果
    if (msg.type === 'ety-selection-compare') {
      const rect = matchSelectionRect(msg.text);
      if (rect) {
        placeCard(rect);
      } else {
        if (!IS_TOP || String(window.getSelection() || '').trim() || document.querySelector('iframe')) return;
        placeCard(null);
      }
      hideBubble();
      // 查词模式：词典有数据就只渲染词典，不显示多引擎
      if (msg.dict && msg.dict.ok && isWordLike(msg.text)) {
        renderDictOnly(msg.text, msg.dict);
        sendResponse({ shown: true });
        return;
      }
      renderCard({ multi: msg.results || [], source: msg.text });
      if (msg.dict && msg.dict.ok) {
        card.dataset.forWord = msg.text;
        renderDictPanel(msg.dict);
      }
      sendResponse({ shown: true });
      return;
    }

    // 右键菜单翻译结果：优先在持有选区的帧展示；选区已丢失时顶层页面居中兜底
    if (msg.type === 'ety-selection-result' || msg.type === 'ety-selection-error') {
      const rect = matchSelectionRect(msg.text);
      if (rect) {
        placeCard(rect);
      } else {
        // 选区已丢失（右键点击可能清空选区）：仅顶层页面居中兜底，且页面含 iframe 时跳过以免与子帧卡片重复
        if (!IS_TOP || String(window.getSelection() || '').trim() || document.querySelector('iframe')) return;
        placeCard(null); // 居中
      }
      hideBubble();
      if (msg.type === 'ety-selection-result') {
        // 查词模式：词典有数据就只渲染词典，不显示引擎译文
        if (msg.dict && msg.dict.ok && isWordLike(msg.text)) {
          renderDictOnly(msg.text, msg.dict);
        } else {
          renderCard({ ok: true, source: msg.text, translation: msg.result, engineName: msg.engineName, hint: msg.hint });
          if (msg.dict && msg.dict.ok) {
            card.dataset.forWord = msg.text;
            renderDictPanel(msg.dict);
          }
        }
      } else {
        renderCard({ error: msg.error });
      }
      sendResponse({ shown: true });
    }
  });
})();
