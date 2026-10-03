// ===== LLM Wiki 집 안 전용 검색 서버 (읽기 전용, v3.2) =====
// 가족이 같은 집 네트워크에서 http://<맥이름>.local:3100/wiki 로 접속한다.
//
// server.js(3000)와 분리한 이유: 저쪽에는 Notion 쓰기 프록시·마스터 인제스트·Obsidian 동기화
// 엔드포인트가 있다. server.js 를 0.0.0.0 으로 열면 그 전부가 집 네트워크에 노출된다.
// 이 서버는 아래 라우트만 응답하고 그 외는 전부 404 다. 여기에 쓰기 엔드포인트를 추가하지 말 것.
//
// 안전장치 — 하나도 완화하지 말 것:
//   1) WIKI_LAN_ALLOW_CIDR 대역과 루프백에서 온 요청만 받는다.
//      미설정·형식 오류면 127.0.0.1 에만 바인딩한다 (fail-closed. 죽지 않으므로 launchd 재시작 루프도 없다).
//   2) 클라이언트 IP 는 소켓 주소만 본다. X-Forwarded-For 는 위조 가능하므로 읽지 않는다.
//   3) Host 헤더가 localhost / IPv4 / *.local 이 아니면 거부한다 (DNS 리바인딩 차단).
//   4) IP당 분당 60요청. AI 답변은 IP당 분당 5회 + 전체 24시간 WIKI_LAN_ASK_DAILY_MAX 회(기본 20).
//      AI 답변은 scheduler·wiki-ingest 와 같은 Gemini 무료 키를 쓴다. 한도를 풀면 본 파이프라인이 굶는다.
//   5) Gemini 401/403 은 lib/wiki_search.js 의 래치가 이후 호출을 전면 차단한다 (보안 원칙 1).
//
// 로그는 기동·차단·오류만 남긴다. 검색어는 기록하지 않는다(가족 사생활).
// 상주 프로세스 로그는 rename 회전 대상이 아니므로 요청마다 찍으면 무한히 자란다.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const wikiSearch = require('./lib/wiki_search');   // .env 는 이 모듈이 process.env 로 올린다

const PORT = Number(process.env.WIKI_LAN_PORT) || 3100;
const ASK_DAILY_MAX = Number(process.env.WIKI_LAN_ASK_DAILY_MAX) || 20;
const RATE_LIMIT = 60;         // IP당 분당 전체 요청
const ASK_RATE_LIMIT = 5;      // IP당 분당 AI 답변
const RATE_WINDOW = 60000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ASK_BODY = 4096;

// ── 허용 대역 ──
function ipToInt(ip) {
  if (!net.isIPv4(ip)) return null;
  return ip.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}

function isPrivate(n) {
  return (n >= 167772160 && n < 184549376)      // 10.0.0.0/8
      || (n >= 2886729728 && n < 2887778304)    // 172.16.0.0/12
      || (n >= 3232235520 && n < 3232301056);   // 192.168.0.0/16
}

// 사설 대역(RFC1918)이고 /16 이상으로 좁은 것만 받는다. 0.0.0.0/0 같은 실수를 막는다.
function parseCidrs(str) {
  const out = [];
  for (const raw of String(str || '').split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const [ip, bitsStr] = s.split('/');
    const base = ipToInt(ip);
    const bits = Number(bitsStr);
    if (base === null || !Number.isInteger(bits) || bits < 16 || bits > 32 || !isPrivate(base)) {
      throw new Error(`"${s}" — 사설 대역의 /16~/32 만 허용 (예: 192.168.0.0/24)`);
    }
    const size = 2 ** (32 - bits);
    out.push({ start: Math.floor(base / size) * size, size, label: s });
  }
  return out;
}

let CIDRS = [];
try {
  CIDRS = parseCidrs(process.env.WIKI_LAN_ALLOW_CIDR);
} catch (e) {
  console.error(`[wiki-lan] ⚠️ WIKI_LAN_ALLOW_CIDR 형식 오류: ${e.message}`);
  CIDRS = [];
}
const HOST = CIDRS.length ? '0.0.0.0' : '127.0.0.1';

// 가족이 쓰는 Bonjour(.local) 이름은 LocalHostName 이다. os.hostname() 은 다른 값일 수 있다
// (2026-10-03 실측: os.hostname() 이 준 이름은 .local 로 풀리지 않았다). 기동 로그 표시용.
function bonjourName() {
  try {
    const name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 3000 }).trim();
    if (name) return name;
  } catch (e) { /* scutil 실패 → 아래 대체값 */ }
  return os.hostname().replace(/\.local$/i, '');
}

function clientIp(req) {
  const a = req.socket.remoteAddress || '';
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

function isAllowed(ip) {
  if (ip === '::1') return true;
  const n = ipToInt(ip);
  if (n === null) return false;
  if (n >= 2130706432 && n < 2147483648) return true;   // 127.0.0.0/8
  return CIDRS.some(c => n >= c.start && n < c.start + c.size);
}

function hostOk(req) {
  const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || net.isIPv4(h) || /^[a-z0-9-]+\.local$/.test(h);
}

// ── 한도 ──
const buckets = new Map();   // key → { count, start }
function hit(key, max) {
  const now = Date.now();
  const e = buckets.get(key);
  if (!e || now - e.start > RATE_WINDOW) { buckets.set(key, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of buckets) if (now - e.start > RATE_WINDOW * 2) buckets.delete(k);
}, RATE_WINDOW).unref();

// 최근 24시간 이동 창. 날짜 키를 만들지 않으므로 일 경계(PT) 문제가 없다.
let askTimes = [];
function askBudgetOk() {
  const now = Date.now();
  askTimes = askTimes.filter(t => now - t < DAY_MS);
  if (askTimes.length >= ASK_DAILY_MAX) return false;
  askTimes.push(now);
  return true;
}

// ── 응답 ──
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function sendJson(res, status, obj, extra) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS, ...(extra || {}) });
  res.end(JSON.stringify(obj));
}

function sendFile(res, name, type) {
  fs.readFile(path.join(__dirname, name), (err, data) => {
    if (err) { sendJson(res, 404, { error: 'Not Found' }); return; }
    res.writeHead(200, { 'Content-Type': type, ...SEC_HEADERS });
    res.end(data);
  });
}

function collectBody(req, callback) {
  let body = '';
  let size = 0;
  let done = false;
  req.on('data', chunk => {
    if (done) return;
    size += chunk.length;
    if (size > MAX_ASK_BODY) { done = true; callback(new Error('too large'), null); return; }
    body += chunk;
  });
  req.on('end', () => { if (!done) { done = true; callback(null, body); } });
  req.on('error', err => { if (!done) { done = true; callback(err, null); } });
}

// ── HTTP 서버 ──
const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  if (!isAllowed(ip)) {
    if (hit('denylog:' + ip, 1)) console.error(`[wiki-lan] 차단: 허용 대역 밖 ${ip}`);
    res.writeHead(403, SEC_HEADERS);
    res.end();
    return;
  }
  if (!hostOk(req)) { sendJson(res, 403, { error: '허용되지 않은 주소로 접속했습니다.' }); return; }
  if (!hit('all:' + ip, RATE_LIMIT)) {
    sendJson(res, 429, { error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }, { 'Retry-After': '60' });
    return;
  }

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { sendJson(res, 400, { error: '잘못된 요청입니다.' }); return; }
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') {
    res.writeHead(302, { Location: '/wiki', ...SEC_HEADERS });
    res.end();
    return;
  }
  if (req.method === 'GET' && p === '/wiki') { sendFile(res, 'wiki.html', 'text/html; charset=utf-8'); return; }
  if (req.method === 'GET' && p === '/favicon.svg') { sendFile(res, 'favicon.svg', 'image/svg+xml'); return; }

  if (req.method === 'GET' && p === '/api/wiki-topics') {
    try {
      sendJson(res, 200, { topics: wikiSearch.listTopics() });
    } catch (e) {
      console.error('[wiki-lan] topics 오류:', e.message);
      sendJson(res, 500, { error: '토픽 목록을 불러오지 못했습니다.' });
    }
    return;
  }

  if (req.method === 'GET' && p === '/api/wiki-search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q || q.length > 500) { sendJson(res, 400, { error: '검색어(q)는 1~500자여야 합니다.' }); return; }
    const topic = (url.searchParams.get('topic') || '').trim();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10) || 10, 30);
    wikiSearch.search(q, { topic, limit })
      .then(({ results, mode }) => sendJson(res, 200, { results, mode }))
      .catch(e => {
        console.error('[wiki-lan] search 오류:', e.message);
        sendJson(res, 500, { error: '검색 중 오류가 발생했습니다.' });
      });
    return;
  }

  if (req.method === 'POST' && p === '/api/wiki-ask') {
    // 다른 사이트가 가족 브라우저를 시켜 보내는 요청 차단 (Origin 이 있으면 Host 와 같아야 한다)
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try { originHost = new URL(origin).host; } catch (e) { /* 형식 오류 → 불일치 처리 */ }
      if (originHost.toLowerCase() !== String(req.headers.host || '').toLowerCase()) {
        sendJson(res, 403, { error: '허용되지 않은 출처입니다.' });
        return;
      }
    }
    if (!hit('ask:' + ip, ASK_RATE_LIMIT)) {
      sendJson(res, 429, { error: 'AI 답변은 1분에 5번까지입니다. 잠시 후 다시 시도하세요.' }, { 'Retry-After': '60' });
      return;
    }
    collectBody(req, (err, body) => {
      if (err) { sendJson(res, 413, { error: '요청이 너무 큽니다.' }); return; }
      let question = '';
      try { question = String(JSON.parse(body || '{}').question || '').trim(); } catch (e) { /* 아래에서 400 */ }
      if (!question || question.length > 500) { sendJson(res, 400, { error: '질문(question)은 1~500자여야 합니다.' }); return; }
      if (!askBudgetOk()) {
        sendJson(res, 429, { error: `AI 답변은 하루 ${ASK_DAILY_MAX}회까지입니다. 일반 검색은 계속 쓸 수 있습니다.` });
        return;
      }
      wikiSearch.ask(question)
        .then(result => sendJson(res, 200, result))
        .catch(e => {
          console.error('[wiki-lan] ask 오류:', e.message);
          // 답변 생성 실패 시에도 검색 결과는 최대한 반환 (server.js 와 같은 규약: 503 + results)
          wikiSearch.search(question, { limit: 8 })
            .then(({ results }) => sendJson(res, 503, { error: 'AI 답변 생성 불가 (일일 한도 도달 또는 API 중단)', results }))
            .catch(() => sendJson(res, 500, { error: 'AI 답변 중 오류가 발생했습니다.' }));
        });
    });
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
});

server.on('error', (e) => {
  console.error(`[wiki-lan] 서버 오류: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('========================================');
  console.log('  LLM Wiki 집 안 전용 검색 서버 (읽기 전용)');
  console.log('========================================');
  if (CIDRS.length) {
    console.log(`  바인딩: ${HOST}:${PORT}`);
    console.log(`  허용 대역: ${CIDRS.map(c => c.label).join(', ')} + 루프백`);
    console.log(`  가족 접속: http://${bonjourName()}.local:${PORT}/wiki`);
  } else {
    console.log(`  바인딩: ${HOST}:${PORT} — WIKI_LAN_ALLOW_CIDR 미설정. 이 맥에서만 접속됩니다.`);
  }
  console.log(`  AI 답변 한도: 24시간 ${ASK_DAILY_MAX}회`);
  console.log('========================================');
});
