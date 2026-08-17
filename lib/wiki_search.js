// ===== LLM Wiki 검색 코어 =====
// wiki_index.json + wiki_index.vec 로드 → 임베딩 코사인 검색 + 메타 부스트
// server.js(웹 API)와 wiki_mcp.js(Claude MCP) 양쪽에서 공유. 의존성 0.

const fs = require('fs');
const path = require('path');
const https = require('https');

const SCRIPT_DIR = path.join(__dirname, '..');
const VAULT = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki';
const INDEX_JSON = path.join(SCRIPT_DIR, 'wiki_index.json');
const INDEX_VEC = path.join(SCRIPT_DIR, 'wiki_index.vec');
const DIM = 768;

// ── .env 로드 (MCP 단독 실행 대비, 기존 값 우선) ──
(function loadEnv() {
  const envPath = path.join(SCRIPT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (k && !process.env[k]) process.env[k] = v;
  }
})();

const KEYS = (process.env.GEMINI_API_KEYS || '')
  .split(',').map(k => k.trim()).filter(Boolean);
if (KEYS.length === 0 && process.env.GEMINI_API_KEY) KEYS.push(process.env.GEMINI_API_KEY);
let keyIdx = 0;

// 403 suspended 감지 시 래치 — 프로세스 재시작 전까지 Gemini 호출 전면 중단
// (배치 스크립트의 process.exit 킬스위치와 달리, 서버는 재시작 루프를 유발하므로 래치 방식)
let geminiDisabled = false;
const isGeminiDisabled = () => geminiDisabled;

// wiki_config.py의 ENTITIES + CONCEPTS (부스트용 사전)
const KNOWN_TERMS = [
  'Claude', 'Claude Code', 'Gemini', 'Gemma', 'ChatGPT', 'GPT', 'Grok', 'Perplexity',
  'Copilot', 'Antigravity', 'Lovable', 'Replit', 'Cursor', 'Windsurf', 'OpenCode',
  'Codex', 'Cowork', 'n8n', 'Make', 'Zapier', 'Genspark', 'NotebookLM',
  'Google AI Studio', 'Obsidian', 'Seedance', 'Kling', 'Sora', 'Veo', 'Midjourney',
  'Stable Diffusion', 'Suno', 'Udio',
  '바이브코딩', 'RAG', 'MCP', 'Agent', 'AI 에이전트', '프롬프트 엔지니어링',
  'Fine-tuning', 'LoRA', 'LLM', '멀티모달', 'Function Calling', 'Tool Use',
  'Agentic Workflow', 'A2A', 'Context Window', 'AI 자동화', 'AI 수익화',
  'AI 생산성', 'Embedding', 'Vector DB', 'Knowledge Graph', 'Open Source AI',
  'On-device AI', 'Edge AI',
].map(s => s.normalize('NFC').toLowerCase());

// ── 인덱스 로드 (mtime 변경 시 리로드) ──
let cache = null; // { notes, vecs: Float32Array, mtime }
function loadIndex() {
  const stat = fs.statSync(INDEX_JSON);
  if (cache && cache.mtime === stat.mtimeMs) return cache;
  const meta = JSON.parse(fs.readFileSync(INDEX_JSON, 'utf8'));
  const buf = fs.readFileSync(INDEX_VEC);
  if (buf.length !== meta.notes.length * DIM * 4) {
    throw new Error(`인덱스 손상: vec 크기 불일치 (${buf.length} != ${meta.notes.length * DIM * 4})`);
  }
  cache = {
    notes: meta.notes,
    vecs: new Float32Array(buf.buffer, buf.byteOffset, meta.notes.length * DIM),
    mtime: stat.mtimeMs,
  };
  return cache;
}

// ── Gemini HTTPS 호출 (키 로테이션 + 래치) ──
function geminiRequest(pathname, body, attempt = 0) {
  return new Promise((resolve, reject) => {
    if (geminiDisabled) return reject(new Error('GEMINI_DISABLED'));
    if (KEYS.length === 0) return reject(new Error('GEMINI_API_KEYS 미설정'));
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/${pathname}?key=${KEYS[keyIdx % KEYS.length]}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          return;
        }
        if (res.statusCode === 403 || res.statusCode === 401) {
          // 킬스위치 래치: 이후 모든 Gemini 호출 차단 (연쇄 요청 방지)
          geminiDisabled = true;
          console.error(`[wiki_search] 🚨 HTTP ${res.statusCode} — Gemini 호출 전면 중단 (재시작 필요): ${data.slice(0, 200)}`);
          return reject(new Error('GEMINI_DISABLED'));
        }
        if (res.statusCode === 429 && attempt < KEYS.length) {
          keyIdx = (keyIdx + 1) % KEYS.length;
          console.error(`[wiki_search] 429 — Key #${keyIdx + 1}로 교체 후 재시도`);
          return resolve(geminiRequest(pathname, body, attempt + 1));
        }
        reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function embedQuery(text) {
  const result = await geminiRequest('models/gemini-embedding-001:embedContent', {
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text }] },
    taskType: 'RETRIEVAL_QUERY',
    outputDimensionality: DIM,
  });
  const v = result.embedding.values;
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map(x => x / norm);
}

// ── 검색 ──
const nfc = s => (s || '').normalize('NFC');
const tokenize = q => nfc(q).toLowerCase().split(/[\s,.?!'"()\[\]]+/).filter(t => t.length >= 2);

function metaBoost(note, tokens, queryLower, wantRecent) {
  let boost = 0;
  const title = nfc(note.title).toLowerCase();
  const tags = note.tags.map(t => nfc(t).toLowerCase());
  if (tokens.some(t => tags.some(tag => tag.includes(t)))) boost += 0.15;
  if (tokens.some(t => title.includes(t))) boost += 0.10;
  if (KNOWN_TERMS.some(term => queryLower.includes(term) && (title.includes(term) || tags.some(tag => tag.includes(term))))) boost += 0.10;
  if (wantRecent && note.upload_date) {
    const days = (Date.now() - new Date(note.upload_date).getTime()) / 86400000;
    boost += Math.max(0, 0.1 * (1 - days / 365));
  }
  return boost;
}

function rankAndFormat(scored, notes, limit) {
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ i, score }) => {
    const n = notes[i];
    return {
      title: n.title, channel: n.channel, topic: n.topic, tags: n.tags,
      upload_date: n.upload_date, view_count: n.view_count, video_url: n.video_url,
      path: n.path, score: Math.round(score * 1000) / 1000, snippet: n.snippet,
    };
  });
}

async function search(query, { topic = '', limit = 10 } = {}) {
  const { notes, vecs } = loadIndex();
  const tokens = tokenize(query);
  const queryLower = nfc(query).toLowerCase();
  const wantRecent = /최신|최근|요즘|올해|이번\s*달/.test(query);
  const topicFilter = topic ? nfc(topic) : '';

  let qv = null;
  try {
    qv = await embedQuery(query);
  } catch (e) {
    // 임베딩 실패(쿼터/래치) → 키워드 폴백. 검색은 죽지 않는다.
    return { results: keywordSearch(query, { topic, limit }), mode: 'keyword' };
  }

  const scored = [];
  for (let i = 0; i < notes.length; i++) {
    if (topicFilter && nfc(notes[i].topic) !== topicFilter) continue;
    let dot = 0;
    const off = i * DIM;
    for (let d = 0; d < DIM; d++) dot += vecs[off + d] * qv[d];
    scored.push({ i, score: dot + metaBoost(notes[i], tokens, queryLower, wantRecent) });
  }
  return { results: rankAndFormat(scored, notes, limit), mode: 'vector' };
}

function keywordSearch(query, { topic = '', limit = 10 } = {}) {
  const { notes } = loadIndex();
  const tokens = tokenize(query);
  const topicFilter = topic ? nfc(topic) : '';
  const scored = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (topicFilter && nfc(n.topic) !== topicFilter) continue;
    const title = nfc(n.title).toLowerCase();
    const tags = n.tags.map(t => nfc(t).toLowerCase()).join(' ');
    const snippet = nfc(n.snippet).toLowerCase();
    const channel = nfc(n.channel).toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (title.includes(t)) score += 3;
      if (tags.includes(t)) score += 2;
      if (channel.includes(t)) score += 2;
      if (snippet.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ i, score });
  }
  return rankAndFormat(scored, notes, limit);
}

// ── 토픽 목록 (필터 드롭다운용) ──
function listTopics() {
  const { notes } = loadIndex();
  const counts = {};
  for (const n of notes) counts[n.topic] = (counts[n.topic] || 0) + 1;
  return Object.entries(counts)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);
}

// ── 노트 읽기 (Vault 경로 탈출 방지) ──
function readNote(relPath) {
  const resolved = path.resolve(VAULT, relPath);
  if (!resolved.startsWith(VAULT + path.sep) || !resolved.endsWith('.md')) {
    throw new Error('허용되지 않은 경로입니다.');
  }
  return fs.readFileSync(resolved, 'utf8');
}

// ── RAG 답변 생성 (웹 UI 전용 — Gemini 2.5 Flash) ──
async function ask(question) {
  const { results } = await search(question, { limit: 8 });
  if (results.length === 0) return { answer: '관련 영상을 찾지 못했습니다.', sources: [] };

  const contexts = results.map((r, idx) => {
    let body = '';
    try {
      body = readNote(r.path).replace(/^---[\s\S]*?---\n/, '').slice(0, 4000);
    } catch (e) { body = r.snippet; }
    return `[${idx + 1}] 제목: ${r.title}\n채널: ${r.channel} | 날짜: ${r.upload_date}\n${body}`;
  }).join('\n\n────────\n\n');

  const prompt = `당신은 사용자의 개인 AI 영상 지식베이스 검색 비서입니다.
아래 영상 요약 자료만 근거로 질문에 한국어로 답하세요.
- 근거로 쓴 자료는 반드시 [1]~[${results.length}] 번호로 인용하세요.
- 자료에 없는 내용은 지어내지 말고 "자료에 없음"이라고 밝히세요.
- 실용적인 단계/팁 위주로 정리하세요.

## 질문
${question}

## 자료
${contexts}`;

  const result = await geminiRequest('models/gemini-2.5-flash:generateContent', {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4000,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  const answer = (((result.candidates || [])[0] || {}).content || {}).parts?.[0]?.text || '(응답 없음)';
  return {
    answer,
    sources: results.map((r, idx) => ({
      n: idx + 1, title: r.title, channel: r.channel,
      video_url: r.video_url, upload_date: r.upload_date, path: r.path,
    })),
  };
}

module.exports = { loadIndex, search, keywordSearch, readNote, ask, listTopics, isGeminiDisabled, VAULT };
