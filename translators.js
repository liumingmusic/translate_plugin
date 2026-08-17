/**
 * 逸译 · 翻译引擎层
 * 统一接口：translateSegments(settings, segments, from, to) -> { ok, translations, detected, error }
 * 引擎：google（免费）/ baidu（AppID+密钥）/ llm（OpenAI 兼容接口）
 */

export const LANGS = [
  { code: 'auto',   name: '自动检测', baidu: 'auto' },
  { code: 'zh-CN',  name: '简体中文', baidu: 'zh' },
  { code: 'zh-TW',  name: '繁体中文', baidu: 'cht' },
  { code: 'en',     name: '英语',     baidu: 'en' },
  { code: 'ja',     name: '日语',     baidu: 'jp' },
  { code: 'ko',     name: '韩语',     baidu: 'kor' },
  { code: 'fr',     name: '法语',     baidu: 'fra' },
  { code: 'es',     name: '西班牙语', baidu: 'spa' },
  { code: 'de',     name: '德语',     baidu: 'de' },
  { code: 'ru',     name: '俄语',     baidu: 'ru' },
  { code: 'it',     name: '意大利语', baidu: 'it' },
  { code: 'pt',     name: '葡萄牙语', baidu: 'pt' },
  { code: 'ar',     name: '阿拉伯语', baidu: 'ara' },
  { code: 'th',     name: '泰语',     baidu: 'th' },
  { code: 'vi',     name: '越南语',   baidu: 'vie' },
  { code: 'id',     name: '印尼语',   baidu: 'id' },
  { code: 'nl',     name: '荷兰语',   baidu: 'nl' },
  { code: 'tr',     name: '土耳其语', baidu: 'tr' },
];

export const ENGINE_NAMES = {
  google: 'Google 翻译（免费）',
  lingva: 'Lingva（免费 · Google 镜像）',
  simplytranslate: 'SimplyTranslate（免费 · Google 镜像）',
  mymemory: 'MyMemory（免费）',
  baidu: '百度翻译',
  llm: 'AI 大模型',
};

export const DEFAULT_SETTINGS = {
  engine: 'google',
  from: 'auto',
  to: 'zh-CN',
  displayMode: 'bilingual',
  selectionBubble: true,
  instantTranslate: false,       // 选中即自动翻译（默认关：避免每次划词都翻，烦）
  transColor: '#1a73e8',
  engines: ['google'],          // 多选：参与对比的翻译器（含大模型配置 id，如 llm0）
  fullPageEngine: 'google',     // 全文翻译固定使用的单一翻译器
  dict: true,
  accent: 'us',            // 默认发音口音：us 美音 / uk 英音
  slowSpeech: false,       // 朗读慢速
  notifyOnDue: false,      // 复习到期桌面提醒
  baidu: { appid: '', secret: '' },
  llmProfiles: [
    { id: 'llm0', name: 'AI 大模型', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini', sysPrompt: '' },
  ],
};

export function langName(code) {
  const l = LANGS.find(x => x.code === code);
  return l ? l.name : String(code || '');
}

/* 大模型配置以 profile 形式存在（支持多个互比），引擎 id 形如 llm0/llm1… */
export const isLlmId = id => typeof id === 'string' && id.startsWith('llm');

export function getLlmProfile(settings, id) {
  const list = (settings && settings.llmProfiles) || [];
  return list.find(p => p.id === id) || list[0] || null;
}

// 统一引擎显示名：免费引擎走 ENGINE_NAMES，大模型拼 “名称 · 模型”
export function engineLabel(settings, id) {
  if (isLlmId(id)) {
    const p = getLlmProfile(settings, id);
    if (p) return (p.name && p.name.trim() ? p.name : 'AI 大模型') + (p.model ? ' · ' + p.model : '');
    return 'AI 大模型';
  }
  return ENGINE_NAMES[id] || String(id || '');
}

function engineExists(s, id) {
  if (isLlmId(id)) return (s.llmProfiles || []).some(p => p.id === id);
  return !!ENGINE_NAMES[id];
}

// 规范化设置：兼容旧版单 llm 配置，补全 engines/fullPageEngine/llmProfiles
export function normalizeSettings(s) {
  s = Object.assign({}, DEFAULT_SETTINGS, s || {});
  if (!Array.isArray(s.llmProfiles) || !s.llmProfiles.length) {
    const legacy = (s && s.llm && typeof s.llm === 'object') ? s.llm : {};
    const def = DEFAULT_SETTINGS.llmProfiles[0];
    s.llmProfiles = [{
      id: 'llm0', name: 'AI 大模型',
      baseUrl: legacy.baseUrl || def.baseUrl,
      apiKey: legacy.apiKey || '',
      model: legacy.model || def.model,
      sysPrompt: legacy.sysPrompt || '',
    }];
  }
  s.llmProfiles.forEach((p, i) => { if (!p.id) p.id = 'llm' + i; });
  if (s.engine === 'llm' || !engineExists(s, s.engine)) s.engine = s.llmProfiles[0].id;
  if (!Array.isArray(s.engines) || !s.engines.length) s.engines = [s.engine];
  if (!s.fullPageEngine || !s.engines.includes(s.fullPageEngine)) s.fullPageEngine = s.engine;
  return s;
}

function langEntry(code) {
  return LANGS.find(x => x.code === code) || LANGS[0];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================== 总入口 ============================== */

export async function translateSegments(settings, segments, from, to, fullText) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: true, translations: [] };
  }
  from = from || settings.from || 'auto';
  to = to || settings.to || 'zh-CN';

  // 免费引擎多级降级链：依次尝试直到成功（例如无代理环境下 Google 不可达 → 自动切 Lingva/SimplyTranslate/MyMemory）
  const FREE_CHAIN = ['google', 'lingva', 'simplytranslate', 'mymemory'];
  const chainIdx = e => FREE_CHAIN.indexOf(e);
  let order;
  if (chainIdx(settings.engine) < 0) {
    order = [settings.engine]; // 百度/大模型等付费或自备 Key 引擎不参与降级
  } else if (activeFreeEngine && chainIdx(activeFreeEngine) >= 0) {
    order = [activeFreeEngine, ...FREE_CHAIN.filter(e => e !== activeFreeEngine)];
  } else {
    const sel = settings.engine;
    order = [sel, ...FREE_CHAIN.filter(e => e !== sel)];
  }

  let firstErr = null;
  for (const engine of order) {
    try {
      const r = await runEngine(engine, segments, from, to, settings, fullText);
      if (chainIdx(engine) >= 0) activeFreeEngine = engine;
      r.usedEngine = engine;
      return r;
    } catch (e) {
      if (!firstErr) firstErr = e;
    }
  }
  return { ok: false, error: (firstErr && firstErr.message) ? String(firstErr.message) : String(firstErr) };
}

// 记忆最近可用的免费引擎（Service Worker 生命周期内）
let activeFreeEngine = null;

async function runEngine(engine, segments, from, to, settings, fullText) {
  if (from !== 'auto' && from === to) {
    return { ok: true, translations: segments.slice(), detected: from };
  }
  let result;
  if (engine === 'baidu') {
    result = await baiduTranslate(segments, from, to, settings.baidu || {});
  } else if (isLlmId(engine)) {
    const profile = getLlmProfile(settings, engine);
    result = await llmTranslate(segments, from, to, profile || {}, fullText);
  } else if (engine === 'mymemory') {
    result = await myMemoryTranslate(segments, from, to);
  } else if (engine === 'lingva') {
    result = await lingvaTranslate(segments, from, to);
  } else if (engine === 'simplytranslate') {
    result = await simplyTranslate(segments, from, to);
  } else {
    result = await googleTranslate(segments, from, to);
  }
  return { ok: true, translations: result.translations, detected: result.detected };
}

/* ============================== Google 免费接口 ============================== */

const GOOGLE_ENDPOINTS = [
  'https://translate.googleapis.com/translate_a/single',
  'https://clients5.google.com/translate_a/single',
];

function gCode(code) {
  if (code === 'zh-CN' || code === 'zh-TW' || code === 'auto') return code;
  return langEntry(code).code;
}

async function gtxFetch(text, from, to, endpointIdx = 0) {
  if (endpointIdx >= GOOGLE_ENDPOINTS.length) {
    throw new Error('Google 免费接口暂不可用，请稍后重试或在设置中切换引擎');
  }
  const url = GOOGLE_ENDPOINTS[endpointIdx] +
    '?client=gtx&dt=t&sl=' + encodeURIComponent(gCode(from)) +
    '&tl=' + encodeURIComponent(gCode(to)) +
    '&q=' + encodeURIComponent(text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('响应格式异常');
    return { text: data[0].map(p => (p && p[0]) || '').join(''), detected: data[2] };
  } catch (e) {
    // 网络级错误（不可达/超时）：标记致命，直接失败以便快速降级
    if (e.name === 'AbortError' || e instanceof TypeError) {
      const err = new Error(e.name === 'AbortError' ? 'Google 接口请求超时' : 'Google 接口不可达（可能需要代理）');
      err.fatal = true;
      throw err;
    }
    return gtxFetch(text, from, to, endpointIdx + 1);
  } finally {
    clearTimeout(timer);
  }
}

async function googleTranslate(segments, from, to) {
  const out = new Array(segments.length).fill(null);
  let detected = null;

  // 短句合并成批，减少请求数
  const batches = [];
  let cur = [], curLen = 0;
  segments.forEach((s, i) => {
    const item = { s, i };
    if (s.length > 600 || cur.length >= 8 || curLen + s.length > 900) {
      if (cur.length) batches.push(cur);
      cur = []; curLen = 0;
      if (s.length > 600) { batches.push([item]); return; }
    }
    cur.push(item);
    curLen += s.length;
  });
  if (cur.length) batches.push(cur);

  let idx = 0;
  let okCount = 0, lastErr = null;
  const worker = async () => {
    while (idx < batches.length) {
      const batch = batches[idx++];
      try {
        const joined = batch.map(x => x.s).join('\n');
        const r = await gtxFetch(joined, from, to);
        if (!detected && r.detected) detected = r.detected;
        const parts = r.text.split('\n');
        if (parts.length === batch.length) {
          batch.forEach((x, k) => { out[x.i] = parts[k]; });
          okCount++;
        } else {
          for (const x of batch) {
            const r2 = await gtxFetch(x.s, from, to);
            if (!detected && r2.detected) detected = r2.detected;
            out[x.i] = r2.text;
          }
          okCount++;
        }
      } catch (e) {
        lastErr = e;
        if (e && e.fatal) throw e; // 网络不可达，快速失败触发降级
        for (const x of batch) {
          try {
            const r2 = await gtxFetch(x.s, from, to);
            if (!detected && r2.detected) detected = r2.detected;
            out[x.i] = r2.text;
            okCount++;
          } catch (e2) {
            if (e2 && e2.fatal) throw e2;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, batches.length) }, worker));
  if (okCount === 0 && batches.length > 0) {
    throw lastErr || new Error('Google 免费接口不可达');
  }
  return { translations: out.map((t, i) => (t == null ? segments[i] : t)), detected };
}

/* ============================== MyMemory 免费接口 ============================== */

// 无需任何配置；单次请求限长，用字符集粗略实现“自动检测”
function detectLangScript(text) {
  const t = String(text).slice(0, 500);
  if (/[\u3040-\u30ff]/.test(t)) return 'ja';
  if (/[\uac00-\ud7af]/.test(t)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(t)) return 'zh-CN';
  if (/[\u0400-\u04ff]/.test(t)) return 'ru';
  if (/[\u0600-\u06ff]/.test(t)) return 'ar';
  if (/[\u0e00-\u0e7f]/.test(t)) return 'th';
  if (/[\u1ea0-\u1eff]/.test(t)) return 'vi';
  return 'en';
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function mmOne(text, from, to) {
  const url = 'https://api.mymemory.translated.net/get?mt=1&q=' + encodeURIComponent(text) +
    '&langpair=' + encodeURIComponent(from + '|' + to);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let data;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const t = data && data.responseData && data.responseData.translatedText;
  if (data && data.responseStatus !== 200) {
    throw new Error('MyMemory：' + (data.responseDetails || ('状态 ' + data.responseStatus)));
  }
  if (typeof t !== 'string' || !t) throw new Error('MyMemory 未返回译文');
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID (SOURCE|TARGET) LANGUAGE/i.test(t)) {
    throw new Error('MyMemory：' + t.slice(0, 100));
  }
  return decodeEntities(t);
}

async function myMemoryTranslate(segments, from, to) {
  // MyMemory 不支持自动检测：用字符集启发式判定
  const src = from === 'auto' ? detectLangScript(segments.join(' ')) : from;
  const out = new Array(segments.length).fill(null);
  let detected = from === 'auto' ? src : from;

  // 长文本切分（单次请求约 500 字符上限）
  const jobs = []; // { text, i, part, parts }
  segments.forEach((s, i) => {
    if (s.length <= 450) { jobs.push({ text: s, i, part: 0, parts: 1 }); return; }
    const chunks = splitLong(s, 450);
    chunks.forEach((c, k) => jobs.push({ text: c, i, part: k, parts: chunks.length }));
  });

  let idx = 0, okCount = 0, lastErr = null;
  const worker = async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      try {
        const r = await mmOne(job.text, src, to);
        if (job.parts === 1) out[job.i] = r;
        else {
          if (!out[job.i]) out[job.i] = new Array(job.parts).fill('');
          out[job.i][job.part] = r;
        }
        okCount++;
      } catch (e) { lastErr = e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  if (okCount === 0 && jobs.length > 0) throw lastErr || new Error('MyMemory 接口不可达');
  return {
    translations: out.map((t, i) => {
      if (Array.isArray(t)) return t.join('');
      return t == null ? segments[i] : t;
    }),
    detected,
  };
}

function splitLong(s, max) {
  const chunks = [];
  let rest = s;
  while (rest.length > max) {
    let cut = -1;
    for (const sep of ['。', '！', '？', '. ', '! ', '? ', '; ', '；', '\u00a0']) {
      const p = rest.lastIndexOf(sep, max);
      if (p > max * 0.4) { cut = p + sep.length; break; }
    }
    if (cut < 0) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/* ============================== Lingva 免费接口（Google 镜像） ============================== */

// 开源 Google 翻译代理前端，国内网络通常可直连，无需任何配置
const LINGVA_HOST = 'https://lingva.ml';

function lingvaCode(code) {
  if (code === 'zh-CN') return 'zh';
  if (code === 'zh-TW') return 'zh_HANT';
  if (code === 'auto') return 'auto';
  return langEntry(code).code;
}

async function lingvaOne(text, from, to) {
  const url = LINGVA_HOST + '/api/v1/' + lingvaCode(from) + '/' + lingvaCode(to) + '/' + encodeURIComponent(text);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error('Lingva HTTP ' + res.status);
      // 403（Cloudflare 拦截）/ 429（限流）属于整站级错误，快速失败交给降级链
      if (res.status === 403 || res.status === 429 || res.status === 503) err.fatal = true;
      throw err;
    }
    const data = await res.json();
    if (typeof data.translation !== 'string' || !data.translation) throw new Error('Lingva 未返回译文');
    const det = data.info && data.info.detectedSource;
    return { text: data.translation, detected: det || null };
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof TypeError) {
      const err = new Error(e.name === 'AbortError' ? 'Lingva 请求超时' : 'Lingva 接口不可达');
      err.fatal = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function lingvaTranslate(segments, from, to) {
  const out = new Array(segments.length).fill(null);
  let detected = null;
  let idx = 0, okCount = 0, lastErr = null;
  const worker = async () => {
    while (idx < segments.length) {
      const i = idx++;
      try {
        const r = await lingvaOne(segments[i], from, to);
        if (!detected && r.detected) detected = r.detected;
        out[i] = r.text;
        okCount++;
      } catch (e) {
        lastErr = e;
        if (e && e.fatal) throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, segments.length) }, worker));
  if (okCount === 0 && segments.length > 0) throw lastErr || new Error('Lingva 接口不可达');
  return { translations: out.map((t, i) => (t == null ? segments[i] : t)), detected };
}

/* ============================== SimplyTranslate 免费接口（Google 镜像） ============================== */

// 同样是 Google 翻译的开源代理，作为 Lingva 的平行备选
const SIMPLY_HOST = 'https://simplytranslate.org';

function stCode(code) {
  if (code === 'auto') return 'auto';
  return langEntry(code).code;
}

async function simplyOne(text, from, to) {
  const body = new URLSearchParams({ engine: 'google', from: stCode(from), to: stCode(to), text });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(SIMPLY_HOST + '/api/translate/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error('SimplyTranslate HTTP ' + res.status);
      if (res.status === 403 || res.status === 429 || res.status === 503) err.fatal = true;
      throw err;
    }
    const data = await res.json();
    if (typeof data.translated_text !== 'string' || !data.translated_text) throw new Error('SimplyTranslate 未返回译文');
    return { text: data.translated_text, detected: data.source_language || null };
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof TypeError) {
      const err = new Error(e.name === 'AbortError' ? 'SimplyTranslate 请求超时' : 'SimplyTranslate 接口不可达');
      err.fatal = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function simplyTranslate(segments, from, to) {
  const out = new Array(segments.length).fill(null);
  let detected = null;
  let idx = 0, okCount = 0, lastErr = null;
  const worker = async () => {
    while (idx < segments.length) {
      const i = idx++;
      try {
        const r = await simplyOne(segments[i], from, to);
        if (!detected && r.detected) detected = r.detected;
        out[i] = r.text;
        okCount++;
      } catch (e) {
        lastErr = e;
        if (e && e.fatal) throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, segments.length) }, worker));
  if (okCount === 0 && segments.length > 0) throw lastErr || new Error('SimplyTranslate 接口不可达');
  return { translations: out.map((t, i) => (t == null ? segments[i] : t)), detected };
}


/* ============================== 百度翻译 ============================== */

function bCode(code) {
  return langEntry(code).baidu || 'auto';
}

const BAIDU_ERRORS = {
  52001: '请求超时', 52002: '系统错误', 52003: '未授权的 AppID',
  54000: '缺少参数', 54001: '签名错误', 54003: '访问频率过高（免费版 QPS=1）',
  54004: '账户余额不足', 54005: '长 query 请求过于频繁',
  58000: '客户端 IP 非法', 58001: '译文语言方向不支持',
};

// 百度免费版 QPS=1，全局串行 + 限速
let baiduLast = 0;
async function baiduGate() {
  const wait = Math.max(0, baiduLast + 1050 - Date.now());
  if (wait) await sleep(wait);
  baiduLast = Date.now();
}

async function baiduRequest(q, from, to, cfg) {
  await baiduGate();
  const salt = Date.now().toString();
  const sign = md5(cfg.appid + q + salt + cfg.secret);
  const params = new URLSearchParams({
    q, from: bCode(from), to: bCode(to), appid: cfg.appid, salt, sign,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let data;
  try {
    const res = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate?' + params.toString(), {
      signal: ctrl.signal,
    });
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (data.error_code) {
    const msg = '百度翻译错误 ' + data.error_code + '：' + (BAIDU_ERRORS[data.error_code] || data.error_msg || '未知错误');
    const err = new Error(msg);
    err.code = data.error_code;
    throw err;
  }
  if (!Array.isArray(data.trans_result)) throw new Error('百度翻译响应格式异常');
  return data.trans_result.map(x => x.dst);
}

async function baiduTranslate(segments, from, to, cfg) {
  if (!cfg.appid || !cfg.secret) {
    throw new Error('请先在设置页填写百度翻译 AppID 与密钥');
  }
  const out = new Array(segments.length).fill(null);

  // 百度接口按行返回，天然支持批量
  const batches = [];
  let cur = [], curLen = 0;
  segments.forEach((s, i) => {
    const clean = s.replace(/[\r\n]+/g, ' ');
    if (cur.length >= 12 || curLen + clean.length > 1500) {
      if (cur.length) batches.push(cur);
      cur = []; curLen = 0;
    }
    cur.push({ s: clean, i });
    curLen += clean.length;
  });
  if (cur.length) batches.push(cur);

  for (const batch of batches) {
    let dsts = null;
    for (let attempt = 0; attempt < 3 && !dsts; attempt++) {
      try {
        dsts = await baiduRequest(batch.map(x => x.s).join('\n'), from, to, cfg);
      } catch (e) {
        if (e.code === '54003' || e.code === '54005') { await sleep(1600); continue; }
        throw e;
      }
    }
    if (!dsts) throw new Error('百度翻译频繁限流，请稍后再试');
    if (dsts.length === batch.length) {
      batch.forEach((x, k) => { out[x.i] = dsts[k]; });
    } else {
      for (const x of batch) {
        const d = await baiduRequest(x.s, from, to, cfg);
        out[x.i] = d[0];
      }
    }
  }
  return { translations: out.map((t, i) => (t == null ? segments[i] : t)), detected: from };
}

/* ============================== AI 大模型（OpenAI 兼容） ============================== */

function stripFences(s) {
  let t = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  return t;
}

async function llmTranslate(segments, from, to, cfg, fullText) {
  if (!cfg.apiKey) throw new Error('请先在设置页填写大模型 API Key');
  if (!cfg.baseUrl) throw new Error('请先在设置页填写大模型 API 地址');
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const fromName = from === 'auto' ? '自动识别的源语言' : langName(from);
  const toName = langName(to);
  let sys = (cfg.sysPrompt && cfg.sysPrompt.trim()) ||
    ('你是专业的网页翻译引擎。请把用户消息中 JSON 数组里的每段文本从' + fromName + '翻译成' + toName +
      '。要求：译文准确、流畅、符合目标语言表达习惯；保留专有名词、数字、代码、标点与换行格式；' +
      '不要增删内容，不要解释；严格只输出一个 JSON 字符串数组，长度必须与输入数组完全一致。');
  // 文档级上下文：把整页原文作为语境提供给模型，缓解逐段翻译丢失上下文的问题
  if (fullText && fullText.length) {
    sys += '\n\n【完整文章上下文，用于理解术语与前后语境】\n' + fullText.slice(0, 8000);
  }

  const CHUNK = 12;
  const chunks = [];
  for (let i = 0; i < segments.length; i += CHUNK) chunks.push(segments.slice(i, i + CHUNK));
  const out = new Array(segments.length).fill(null);

  let idx = 0;
  const worker = async () => {
    while (idx < chunks.length) {
      const start = idx * CHUNK;
      const c = chunks[idx];
      idx++;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      let data;
      try {
        const res = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
          body: JSON.stringify({
            model: cfg.model || 'gpt-4o-mini',
            temperature: 0.2,
            stream: false,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: JSON.stringify(c) },
            ],
          }),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error('大模型接口 HTTP ' + res.status + '：' + text.slice(0, 200));
        data = JSON.parse(text);
      } finally {
        clearTimeout(timer);
      }
      const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('大模型未返回内容');
      let arr = null;
      try { arr = JSON.parse(stripFences(content)); } catch (e) { arr = null; }
      if (!Array.isArray(arr) || arr.length !== c.length) {
        throw new Error('大模型返回格式异常，无法对齐段落（可重试或更换模型）');
      }
      arr.forEach((t, k) => { out[start + k] = String(t == null ? c[k] : t); });
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, worker));
  return { translations: out.map((t, i) => (t == null ? segments[i] : t)), detected: from };
}

/* ============================== 单词词典（有道词典 jsonapi，免费） ============================== */

// 真人发音：英文 type=2(US)/1(UK)，中文 type=1
export function dictVoiceUrl(text, us = true) {
  const isZh = /[\u4e00-\u9fff]/.test(text);
  const type = isZh ? 1 : (us ? 2 : 1);
  return 'https://dict.youdao.com/dictvoice?type=' + type + '&audio=' + encodeURIComponent(text);
}

// 清洗有道 jsonapi 文本字段：去 HTML 标签、HTML 实体、零宽字符，再 trim
const stripTags = s => String(s || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
  .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
  .trim();
const flatTrItem = x => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'object') return x['#f'] || x.f || '';
  return String(x);
};

// 查询一个单词/短词的词典详情（音标、释义、词形、词组、近义词、双语例句）
export async function lookupDict(query) {
  const q = String(query || '').trim();
  if (!q || q.length > 48) return { ok: false };
  // 仅接受单词级查询：单个英文单词或 1~6 个汉字（句子交给翻译引擎）
  const wordLike = /^[A-Za-z][A-Za-z''-]{0,39}$/.test(q) || /^[\u4e00-\u9fff]{1,6}$/.test(q);
  if (!wordLike) return { ok: false };
  const isZh = /[\u4e00-\u9fff]/.test(q) && !/[a-zA-Z]/.test(q);

  // 本地缓存：命中且 7 天内直接返回，减少重复请求与偶发零宽字符脏数据
  const cacheKey = 'ety_dict_' + q.toLowerCase();
  try {
    const c = await chrome.storage.local.get(cacheKey);
    const hit = c[cacheKey];
    if (hit && hit.data && hit.ts && Date.now() - hit.ts < 7 * 86400000) return hit.data;
  } catch (e) { /* ignore */ }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let d;
  try {
    const res = await fetch('https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(q), { signal: ctrl.signal });
    if (!res.ok) { d = null; }
    else d = await res.json();
  } catch (e) {
    d = null;
  } finally {
    clearTimeout(timer);
  }

  // 有道无数据（接口挂/无词条）：英文单词尝试 Wiktionary 公开接口兜底
  if (!d) {
    if (!isZh) {
      const wk = await lookupDictWiktionary(q);
      if (wk.ok) return wk;
    }
    return { ok: false, error: '词典服务不可达' };
  }

  const out = { ok: true, word: q, isZh };
  const ecWord = (!isZh && d.ec && Array.isArray(d.ec.word)) ? (d.ec.word[0] || {}) : {};
  const cnWord = (isZh && d.ce_new && Array.isArray(d.ce_new.word)) ? (d.ce_new.word[0] || {}) : {};
  const simple = (d.simple && Array.isArray(d.simple.word)) ? (d.simple.word[0] || {}) : {};

  // 音标与发音
  if (isZh) {
    const py = cnWord.phone || simple.ukphone || '';
    if (py) out.phone = py;
    out.audioUs = dictVoiceUrl(q);
  } else {
    const usPh = (ecWord.us && ecWord.us.phonetic) || simple.usphone || '';
    const ukPh = (ecWord.uk && ecWord.uk.phonetic) || simple.ukphone || '';
    if (usPh) out.usphone = '/' + String(usPh).replace(/^\/|\/$/g, '') + '/';
    if (ukPh) out.ukphone = '/' + String(ukPh).replace(/^\/|\/$/g, '') + '/';
    if (out.usphone || out.ukphone || simple.return_phrase || simple['return-phrase']) out.audioUs = dictVoiceUrl(q);
    if (out.usphone || out.ukphone) out.audioUk = dictVoiceUrl(q, false);
  }

  // 考试标签（CET4 / 考研…）
  if (d.ec && Array.isArray(d.ec.exam_type) && d.ec.exam_type.length) {
    out.tags = d.ec.exam_type.slice(0, 4);
  }

  // 释义
  out.defs = [];
  if (!isZh && Array.isArray(ecWord.trs)) {
    for (const tr of ecWord.trs.slice(0, 6)) {
      const t = tr && tr.tr && tr.tr[0] && tr.tr[0].l && tr.tr[0].l.i;
      if (Array.isArray(t)) {
        const line = t.map(flatTrItem).join('').trim();
        if (line) out.defs.push(line);
      }
    }
  }
  if (isZh && Array.isArray(cnWord.trs)) {
    // 中文词条：tr[0].l.i 是核心译文；exam 是搭配用法 {f: 英文搭配, n: 中文说明}
    for (const tr of cnWord.trs.slice(0, 3)) {
      const t = tr && tr.tr && tr.tr[0];
      if (!t) continue;
      if (t.l && Array.isArray(t.l.i)) {
        const line = t.l.i.map(flatTrItem).join('').trim();
        if (line) out.defs.push(line);
      }
      const exams = t.exam;
      if (Array.isArray(exams)) {
        for (const ex of exams.slice(0, 3)) {
          const f = ex && ex.i && ex.i.f && ex.i.f.l && ex.i.f.l.i;
          const n = ex && ex.i && ex.i.n && ex.i.n.l && ex.i.n.l.i;
          if (f || n) out.defs.push((n ? n + ' ' : '') + (f || ''));
        }
      }
    }
  }

  // 词形变化（结构：rels[].rel = {pos, words:[{word, tran}]}）
  out.forms = [];
  const rels = d.rel_word && Array.isArray(d.rel_word.rels) ? d.rel_word.rels : [];
  for (const r0 of rels.slice(0, 4)) {
    const r = r0 && r0.rel ? r0.rel : r0;
    const ws = Array.isArray(r.words) ? r.words : [];
    const words = ws.map(w => w && (w.word || w.w)).filter(Boolean).slice(0, 5);
    if (r.pos && words.length) out.forms.push({ pos: r.pos, words });
  }

  // 常用词组
  out.phrases = [];
  if (!isZh) {
    const phrs = d.phrs && Array.isArray(d.phrs.phrs) ? d.phrs.phrs : [];
    for (const p of phrs.slice(0, 6)) {
      const h = p && p.phr;
      if (!h || !h.headword || !h.headword.l) continue;
      const w = h.headword.l.i;
      const t = Array.isArray(h.transword) && h.transword[0] && h.transword[0].l ? h.transword[0].l.i : '';
      if (w) out.phrases.push({ w, t });
    }
  } else if (Array.isArray(cnWord.phrs)) {
    // 中文词条的词组是扁平文本行：[{i: [{phr: {l: {i: "世界霸权 world domination;"}}}]}]
    for (const p of cnWord.phrs.slice(0, 3)) {
      const items = p && Array.isArray(p.i) ? p.i : [];
      for (const it of items.slice(0, 6)) {
        const line = it && it.phr && it.phr.l && it.phr.l.i;
        if (line) out.phrases.push({ w: String(line).replace(/;\s*$/, ''), t: '' });
      }
    }
  }

  // 近义词
  out.syno = [];
  const synos = d.syno && Array.isArray(d.syno.synos) ? d.syno.synos : [];
  for (const s of synos.slice(0, 3)) {
    const x = s && s.syno;
    if (!x) continue;
    const words = Array.isArray(x.ws) ? x.ws.map(w => w && w.w).filter(Boolean).slice(0, 5) : [];
    if (words.length) out.syno.push({ pos: x.pos || '', tran: x.tran || '', words });
  }

  // 双语例句（中文词条的 sentence-eng/cn 方向相反，需对调）
  // cn 可能为空（如服务端只给英文译例），保留英文不丢数据，前端显示占位
  out.sents = [];
  const pairs = d.blng_sents_part && Array.isArray(d.blng_sents_part['sentence-pair']) ? d.blng_sents_part['sentence-pair'] : [];
  for (const s of pairs.slice(0, 3)) {
    let en = stripTags(s['sentence-eng']);
    let cn = stripTags(s['sentence-translation']);
    // 中文词条查询时两个字段方向相反（sentence-eng 是中文）
    if (/[\u4e00-\u9fff]/.test(en) && !/[\u4e00-\u9fff]/.test(cn)) { const tmp = en; en = cn; cn = tmp; }
    if (en) out.sents.push({ en, cn });
  }

  if (!out.defs.length && !out.phrases.length && !out.sents.length) {
    if (!isZh) {
      const wk = await lookupDictWiktionary(q);
      if (wk.ok) { try { await chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), data: wk } }); } catch (e) {} return wk; }
    }
    return { ok: false };
  }
  try { await chrome.storage.local.set({ [cacheKey]: { ts: Date.now(), data: out } }); } catch (e) {}
  return out;
}

// Wiktionary 公开 REST 接口兜底（无需 Key，仅英文单词）：提供释义与例句，无音标
async function lookupDictWiktionary(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(q.toLowerCase()), { signal: ctrl.signal });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    const defs = [];
    const sents = [];
    const groups = Array.isArray(data.definitions) ? data.definitions : [];
    for (const g of groups.slice(0, 4)) {
      const pos = g.partOfSpeech || '';
      const items = Array.isArray(g.definitions) ? g.definitions : [];
      for (const it of items.slice(0, 3)) {
        if (it.definition) {
          defs.push((pos ? '【' + pos + '】' : '') + stripTags(it.definition).trim());
        }
        if (Array.isArray(it.examples) && it.examples.length && sents.length < 3) {
          sents.push({ en: stripTags(it.examples[0]).trim(), cn: '' });
        }
      }
    }
    if (!defs.length) return { ok: false };
    return { ok: true, word: q, isZh: false, defs, sents, source: 'wiktionary' };
  } catch (e) {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================== MD5（百度签名用） ============================== */

function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
function cmn(q, a, b, x, s, t) {
  a = add32(add32(a, q), add32(x, t));
  return add32((a << s) | (a >>> (32 - s)), b);
}
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

function md5cycle(x, k) {
  let a = x[0], b = x[1], c = x[2], d = x[3];
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);

  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);

  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);

  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);

  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}

const HEX_CHR = '0123456789abcdef';
function rhex(n) {
  let s = '';
  for (let j = 0; j < 4; j++) {
    s += HEX_CHR.charAt((n >> (j * 8 + 4)) & 0x0F) + HEX_CHR.charAt((n >> (j * 8)) & 0x0F);
  }
  return s;
}

function md5blk(bytes) {
  const blks = new Array(16).fill(0);
  for (let i = 0; i < 64; i += 4) {
    blks[i >> 2] = bytes[i] + (bytes[i + 1] << 8) + (bytes[i + 2] << 16) + (bytes[i + 3] << 24);
  }
  return blks;
}

function md5(input) {
  const msg = new TextEncoder().encode(String(input));
  const n = msg.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(msg.subarray(i - 64, i)));
  const tail = new Array(16).fill(0);
  const rest = msg.subarray(i - 64);
  for (let j = 0; j < rest.length; j++) tail[j >> 2] |= rest[j] << ((j % 4) << 3);
  tail[rest.length >> 2] |= 0x80 << ((rest.length % 4) << 3);
  if (rest.length > 55) {
    md5cycle(state, tail);
    tail.fill(0);
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state.map(rhex).join('');
}
