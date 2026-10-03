# 작업지시서 — 집 안 전용 Wiki 검색 서버 `wiki_lan_server.js` (v3.2)

작성일: 2026-10-03 · 대상: Claude Code · 영역: **Node (신규 `wiki_lan_server.js`, `wiki.html` 2줄)** + launchd + 문서
지시 번호: `[CC-1003-A]`

> 이 파일을 읽고 그대로 실행한다. 범위 밖 항목은 손대지 않는다.
> 이 문서에는 집 네트워크 대역·맥 이름·개인 절대경로를 적지 않는다(레포 공개). 실제 값은 지시문 본문과 명령 출력에서 얻는다.

---

## 1. 배경

Wiki 검색 화면(`wiki.html`)은 `server.js`(포트 3000)가 서빙하는데, `server.js`는 `127.0.0.1`에만 바인딩한다(`server.js:628`).
그래서 집 안의 다른 컴퓨터(가족)에서는 접속할 수 없다.

**`server.js`를 `0.0.0.0`으로 여는 방식은 쓰지 않는다.** 같은 서버에 아래가 함께 있기 때문이다.

| `server.js` 엔드포인트 | 집 네트워크에 열리면 |
|---|---|
| Notion API 프록시 (`ALLOWED_NOTION_PATHS`) | 누구나 Notion 페이지 생성·수정 |
| `POST /api/master-ingest` | 누구나 인제스트 실행 → YouTube quota 소모 |
| `POST /api/sync-obsidian` | 누구나 Vault 동기화·고아 격리 실행 |
| `GET /api/config` | 설정 노출 |

대신 **검색만 하는 읽기 전용 서버를 따로 하나** 띄운다. 검색 엔진(`lib/wiki_search.js`)과 화면(`wiki.html`)은 그대로 공유한다.

```
이 맥        http://localhost:3000/wiki         server.js           (기존, 127.0.0.1 전용 — 무변경)
가족 PC      http://<맥이름>.local:3100/wiki    wiki_lan_server.js  (신규, 집 대역 전용·읽기 전용)
Claude       MCP wiki-search                    wiki_mcp.js         (기존, stdio — 무변경)
                         └──────── 셋 다 lib/wiki_search.js + wiki_index.json/.vec 를 쓴다 ────────┘
```

착수 시점 실측(2026-10-03): 인덱스 2,881건·34토픽, 3100번 포트 비어 있음, `com.irichgreen.server` 기동 중(127.0.0.1:3000).

## 2. 설계 원칙 (지키지 않으면 되돌린다)

1. **읽기 전용.** 새 서버의 라우트는 `/`(→`/wiki`), `/wiki`, `/favicon.svg`, `/api/wiki-topics`, `/api/wiki-search`, `/api/wiki-ask` 뿐이다. 그 외는 404. 쓰기·실행 엔드포인트를 추가하지 않는다.
2. **집 대역만.** `.env`의 `WIKI_LAN_ALLOW_CIDR` 대역 + 루프백에서 온 요청만 받는다. 맥북은 밖으로 들고 나가므로, 다른 네트워크에 붙어도 그 네트워크의 기기는 대역 밖이라 403이다.
3. **fail-closed.** `WIKI_LAN_ALLOW_CIDR`가 없거나 형식이 틀리면 `127.0.0.1`에만 바인딩한다. 프로세스는 죽지 않는다(launchd 재시작 루프 방지).
4. **클라이언트 IP는 소켓 주소만.** `X-Forwarded-For`는 위조 가능하므로 읽지 않는다. (`server.js:185`는 읽지만 저쪽은 루프백 전용이라 사정이 다르다 — 따라 하지 말 것.)
5. **Gemini 무료 한도 보호.** AI 답변은 scheduler·wiki-ingest와 같은 키(`GEMINI_API_KEYS`)를 쓴다. IP당 분당 5회 + 전체 24시간 `WIKI_LAN_ASK_DAILY_MAX`회(기본 20). 401/403은 `lib/wiki_search.js`의 래치가 이후 호출을 전면 차단한다(보안 원칙 1) — 새 서버에서 재시도 로직을 만들지 않는다.
6. **`server.js`·`lib/wiki_search.js`·`wiki_mcp.js`는 한 줄도 고치지 않는다.**
7. **로그는 기동·차단·오류만.** 상주 프로세스 로그는 rename 회전 대상이 아니다(`~/Library/Scripts/rotate_extra_logs.sh` 주석). 요청마다 찍으면 무한히 자란다. 검색어는 기록하지 않는다.

## 3. 사전 확인 (하나라도 어긋나면 중단하고 보고)

```bash
git status --short
# 기대: " M CLAUDE.md" 와 "?? docs/tasks/2026-10-03-wiki-lan-server.md" 두 줄뿐
git diff --stat CLAUDE.md
# 기대: 1 file changed, 2 insertions(+)  ← 2026-09-19 Vault 경로 중첩 메모(미커밋 방치분)

lsof -nP -iTCP:3100 -sTCP:LISTEN || echo "3100 비어 있음"
# 기대: 3100 비어 있음

lsof -nP -iTCP:3000 -sTCP:LISTEN | tail -1
# 기대: ... TCP 127.0.0.1:3000 (LISTEN)

grep -c "WIKI_LAN" .env
# 기대: 0
```

**미커밋분 분리.** 기존 `CLAUDE.md` 변경 2줄은 이번 작업 커밋에 섞지 않는다. 먼저 따로 커밋한다.

```bash
git add CLAUDE.md && git commit -m "docs: Vault 경로 중첩 메모 추가 (2026-09-19 미커밋 방치분)"
```

**집 대역 값.** `WIKI_LAN_ALLOW_CIDR`에 넣을 값은 **지시문 본문에 적힌 것만** 쓴다. 본문에 없으면 중단하고 보고한다.
현재 붙어 있는 네트워크에서 추정하지 않는다 — 작업 시점에 맥이 집 밖이면 그 네트워크에 문을 열게 된다.

## 4. AS-IS → TO-BE

### 4-1. 신규 파일 `wiki_lan_server.js` (레포 루트, `server.js` 옆)

AS-IS: 없음. TO-BE: 아래 전문을 **그대로** 저장한다. 이 코드는 Cowork에서 스텁 검색 모듈로 실행 검증을 마쳤다(§9). 다듬지 않는다.

```js
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
    console.log(`  가족 접속: http://${os.hostname().replace(/\.local$/i, '')}.local:${PORT}/wiki`);
  } else {
    console.log(`  바인딩: ${HOST}:${PORT} — WIKI_LAN_ALLOW_CIDR 미설정. 이 맥에서만 접속됩니다.`);
  }
  console.log(`  AI 답변 한도: 24시간 ${ASK_DAILY_MAX}회`);
  console.log('========================================');
});
```

저장 직후:

```bash
node --check wiki_lan_server.js && echo "SYNTAX OK"
# 기대: SYNTAX OK
wc -l < wiki_lan_server.js
# 기대: 262
```

### 4-2. `wiki.html` — Obsidian 링크를 이 맥에서만 표시

가족 PC에는 Vault가 없으므로 `obsidian://` 링크가 동작하지 않는다. 호스트명이 로컬일 때만 보여 준다.

**(a) `esc` 정의 바로 아래에 2줄 추가**

AS-IS
```js
const esc = s => (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
```

TO-BE
```js
const esc = s => (s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Obsidian 링크는 Vault 가 있는 이 맥에서만 의미가 있다. 가족 PC(집 안 전용 서버 접속)에서는 숨긴다.
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
```

**(b) 결과 카드의 링크 1줄 교체**

AS-IS
```js
        <a href="${obsUrl}">📓 Obsidian에서 열기</a>
```

TO-BE
```js
        ${IS_LOCAL ? `<a href="${obsUrl}">📓 Obsidian에서 열기</a>` : ''}
```

```bash
grep -c "IS_LOCAL" wiki.html
# 기대: 2
git diff --stat wiki.html
# 기대: 1 file changed, 3 insertions(+), 1 deletion(-)
```

`server.js`와 새 서버 모두 요청마다 `wiki.html`을 읽으므로(`Cache-Control: no-store`) 이 변경에는 재기동이 필요 없다.

### 4-3. fail-closed 확인 — `.env`를 건드리기 **전에** 실행

```bash
WIKI_LAN_PORT=3199 node wiki_lan_server.js > /tmp/wiki-lan-test.log 2>&1 &
P=$!; sleep 1.5
cat /tmp/wiki-lan-test.log
lsof -nP -iTCP:3199 -sTCP:LISTEN | tail -1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3199/wiki
kill $P
```

기대:
```
  바인딩: 127.0.0.1:3199 — WIKI_LAN_ALLOW_CIDR 미설정. 이 맥에서만 접속됩니다.
... TCP 127.0.0.1:3199 (LISTEN)        ← "*:3199" 이면 실패. 중단하고 보고
200
```

### 4-4. `.env`에 2줄 추가 (gitignore 대상 — 커밋되지 않는다)

```bash
cp .env .env.bak.20261003
printf '\n# (v3.2) 집 안 전용 Wiki 검색 서버 — 이 대역 + 루프백만 접속 허용. 지우면 127.0.0.1 전용으로 떨어진다\nWIKI_LAN_ALLOW_CIDR=%s\nWIKI_LAN_ASK_DAILY_MAX=20\n' "<지시문 본문의 집 대역>" >> .env
grep "^WIKI_LAN_" .env
# 기대: WIKI_LAN_ALLOW_CIDR=<지시문 본문의 집 대역>  /  WIKI_LAN_ASK_DAILY_MAX=20   (2줄)
git check-ignore -q .env .env.bak.20261003 && echo "ignored OK"
# 기대: ignored OK
```

새 상태 파일은 만들지 않는다(한도 카운터는 메모리). `.gitignore`는 바꾸지 않는다.

### 4-5. launchd plist — 기존 `com.irichgreen.server.plist`에서 파생

경로를 손으로 쓰지 않는다. 검증된 기존 plist에서 4곳만 치환하고 `ThrottleInterval`을 넣는다.

```bash
sed -e 's|com\.irichgreen\.server|com.irichgreen.wiki-lan|' \
    -e 's|/server\.js|/wiki_lan_server.js|' \
    -e 's|ytnotion-server-err\.log|wiki-lan-err.log|' \
    -e 's|ytnotion-server\.log|wiki-lan.log|' \
    com.irichgreen.server.plist > com.irichgreen.wiki-lan.plist
plutil -insert ThrottleInterval -integer 60 com.irichgreen.wiki-lan.plist
plutil -lint com.irichgreen.wiki-lan.plist
# 기대: com.irichgreen.wiki-lan.plist: OK
diff <(plutil -convert xml1 -o - com.irichgreen.server.plist) <(plutil -convert xml1 -o - com.irichgreen.wiki-lan.plist) | grep -c '^[<>]'
# 기대: 10   (Label·server.js·로그 2개 = 바뀐 4쌍 8줄 + ThrottleInterval 추가 2줄)
```

`ThrottleInterval 60`: 포트 충돌(`EADDRINUSE`)로 `exit 1` 하면 `KeepAlive`가 재기동한다. 기본 10초 간격이면 오류 로그가 하루 8,640줄 쌓인다.

## 5. 데몬 기동

```bash
cp com.irichgreen.wiki-lan.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.irichgreen.wiki-lan.plist
sleep 2
launchctl list | grep irichgreen.wiki-lan
# 기대: <PID>  0  com.irichgreen.wiki-lan     ← PID 자리가 "-" 이면 실패
tail -8 ~/Library/Logs/irichgreen/wiki-lan.log
```

기대 로그:
```
  바인딩: 0.0.0.0:3100
  허용 대역: <집 대역> + 루프백
  가족 접속: http://<맥이름>.local:3100/wiki
  AI 답변 한도: 24시간 20회
```

기동 직후 macOS가 **node의 수신 연결을 허용할지 묻는 창**을 띄울 수 있다. 사람이 눌러야 하는 창이다 — 누르지 말고, 보고에 "방화벽 창이 떴는지"만 적는다(§8-5).

## 6. 검증 (기대 출력과 다르면 §7 롤백 후 보고)

```bash
B=http://localhost:3100
LAN=$(ipconfig getifaddr en0); NAME=$(scutil --get LocalHostName)

# 6-1 바인딩 — 새 서버는 전 인터페이스, 기존 서버는 그대로 루프백
lsof -nP -iTCP:3100 -sTCP:LISTEN | tail -1      # 기대: ... TCP *:3100 (LISTEN)
lsof -nP -iTCP:3000 -sTCP:LISTEN | tail -1      # 기대: ... TCP 127.0.0.1:3000 (LISTEN)   ← 바뀌었으면 실패

# 6-2 화면·토픽·검색 (실제 인덱스)
curl -s -o /dev/null -w "%{http_code}\n" $B/wiki                         # 기대: 200
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" $B/             # 기대: 302 http://localhost:3100/wiki
curl -s $B/api/wiki-topics | head -c 80                                  # 기대: {"topics":[{"topic":"...","count":...
curl -s "$B/api/wiki-search?q=%ED%81%B4%EB%A1%9C%EB%93%9C%20%EC%8A%A4%ED%82%AC&limit=2" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['mode'], len(d['results']))"
# 기대: vector 2      (임베딩 한도 도달 시 "keyword 2" 도 정상)

# 6-3 server.js 전용 경로가 새 서버에 없어야 한다 — 전부 404
chk() { printf '%-26s %s\n' "$1 $2" "$(curl -s -o /dev/null -w '%{http_code}' -X "$1" "$B$2")"; }
chk POST /api/master-ingest; chk POST /api/sync-obsidian; chk GET /api/config
chk POST /v1/pages; chk GET /index.html; chk GET /.env
# 기대: 6줄 모두 404

# 6-4 Host 검사 (DNS 리바인딩 차단)
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.example.com" $B/wiki     # 기대: 403

# 6-5 LAN 주소·맥 이름으로 접속 (맥이 지시문 본문의 집 대역에 붙어 있을 때만)
curl -s -o /dev/null -w "%{http_code}\n" http://$LAN:3100/wiki                   # 기대: 200
curl -s -o /dev/null -w "%{http_code}\n" http://$NAME.local:3100/wiki            # 기대: 200
# 맥이 집 밖이면 $LAN 이 대역 밖이라 403 이 정상이다. 그 경우 이 항목은 "집 밖이라 생략"으로 보고한다.

# 6-6 AI 답변 — 타 출처 거부 (Gemini 호출 없음) + 정상 1회만 (무료 한도 보호. 반복 호출 금지)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  -H "Origin: http://evil.example.com" -d '{"question":"테스트"}' $B/api/wiki-ask   # 기대: 403
curl -s -X POST -H "Content-Type: application/json" -d '{"question":"클로드 스킬 만드는 법"}' $B/api/wiki-ask \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('answer' in d, len(d.get('sources', d.get('results', []))))"
# 기대: True 8        (Gemini 일일 한도 도달 시 "False 8" = 503 폴백도 정상. 다시 호출하지 말 것)

# 6-7 오류 로그
cat ~/Library/Logs/irichgreen/wiki-lan-err.log
# 기대: 비어 있음 (6-6 이 503 폴백이었다면 "[wiki-lan] ask 오류: ..." 1줄)
```

대역 밖 차단(403)·`X-Forwarded-For` 위조 무시·분당/일일 한도는 이 맥 한 대로는 재현할 수 없다. Cowork 검증 결과(§9)로 갈음한다.

## 7. 롤백

```bash
launchctl unload ~/Library/LaunchAgents/com.irichgreen.wiki-lan.plist
mkdir -p ~/Library/LaunchAgents/_disabled
mv ~/Library/LaunchAgents/com.irichgreen.wiki-lan.plist ~/Library/LaunchAgents/_disabled/
lsof -nP -iTCP:3100 -sTCP:LISTEN || echo "3100 닫힘"        # 기대: 3100 닫힘
cp .env.bak.20261003 .env                                    # WIKI_LAN_* 2줄 제거
git checkout -- wiki.html                                    # 커밋 전
# 커밋 후라면: git revert <이 작업 커밋>   (push 전이므로 원격 영향 없음)
```

`server.js`(3000)는 이 작업에서 건드리지 않았으므로 롤백 대상이 아니다.

## 8. 문서 갱신 → 커밋 (push 는 하지 않는다)

검증이 전부 통과한 뒤에만 진행한다. 새로 쓰는 줄에는 개인 절대경로·맥 이름·집 대역을 적지 않는다(`<REPO_ROOT>`, `~`, `<맥이름>`, `192.168.0.0/24` 같은 예시값).

### 8-1. `CLAUDE.md`

| 위치 | 변경 |
|---|---|
| 머리 `**현재 버전: v3.0** (2026-09-06)` | `**현재 버전: v3.2** (2026-10-03)` — README는 09-10에 이미 v3.1이었다. 그때 못 맞춘 것을 함께 교정 |
| `## Commands` 코드 블록 끝 | 아래 "명령 블록" 추가 |
| `### 핵심 파일 역할` 표 끝 | 아래 "파일 표 추가 행" 추가 — 검색 계열 파일이 지금까지 표에 없었다 |
| `### 카카오톡 →「AI 꿀팁」→ Obsidian (v3.0)` 절 **앞** | 아래 "Wiki 검색 절" 신설 |
| `### launchd 데몬 3종` | 제목을 `### launchd 데몬`으로(개수 제거) + 표에 `wiki-lan` 행 + 아래 "launchd 주의" |
| `**Vault 경로 중첩 (2026-09-19)**` 문단의 `v3.1(2nd_Brain 2단계` | `v3.3(2nd_Brain 2단계` — v3.1은 09-10에 사용됐고 이번이 v3.2다. 번호만 고친다 |
| `## 변경 이력` 맨 위 | 2026-10-03 (v3.2) 항목 |

명령 블록:
```bash
# Wiki 검색 (v3.2) — 입구는 여럿, 엔진은 lib/wiki_search.js 하나
#   이 맥    http://localhost:3000/wiki          server.js (127.0.0.1 전용)
#   가족 PC  http://<맥이름>.local:3100/wiki     wiki_lan_server.js (집 대역 전용·읽기 전용)
#   Claude   MCP wiki-search                     wiki_mcp.js (stdio, 서버 불필요)
python3 build_search_index.py                    # 검색 인덱스 증분 갱신 (sync_obsidian.py 가 변경 시 자동 호출)
launchctl list | grep irichgreen.wiki-lan        # 집 안 전용 서버 상태
tail -20 ~/Library/Logs/irichgreen/wiki-lan.log  # 기동·차단 기록
```

파일 표 추가 행:
```
| `wiki.html` | Wiki 검색 화면. 의미 검색 + AI 답변, 토픽 필터·정렬. `server.js`와 `wiki_lan_server.js`가 같은 파일을 서빙한다. |
| `lib/wiki_search.js` | 검색 코어(의존성 0). `wiki_index.json`+`wiki_index.vec`(768차원) 로드, 임베딩 코사인 + 메타 부스트, 임베딩 실패 시 키워드 폴백, Gemini 401/403 래치. |
| `wiki_mcp.js` | 같은 코어를 Claude에 노출하는 stdio MCP(`search_wiki`, `read_note`). 웹 서버 없이 동작. |
| `build_search_index.py` | Obsidian 노트 → `gemini-embedding-001` → 인덱스 증분 빌드. `sync_obsidian.py`가 신규·변경·고아 격리·`--rebuild` 시 호출. |
| `wiki_lan_server.js` | (v3.2) 집 안 전용 읽기 전용 검색 서버(포트 3100). `WIKI_LAN_ALLOW_CIDR` 대역 + 루프백만 허용. |
```

Wiki 검색 절:
```markdown
### Wiki 검색 — 입구는 여럿, 엔진은 하나 (v3.2)

| 입구 | 프로세스 | 바인딩 | 용도 |
|---|---|---|---|
| `http://localhost:3000/wiki` | `server.js` | `127.0.0.1:3000` | 이 맥에서 직접 |
| `http://<맥이름>.local:3100/wiki` | `wiki_lan_server.js` | `0.0.0.0:3100` + 대역 필터 | 집 안 다른 컴퓨터(가족) |
| MCP `wiki-search` | `wiki_mcp.js` (stdio) | 없음 | Claude Code 대화 중 |

- **`server.js`를 `0.0.0.0`으로 열지 말 것.** Notion 쓰기 프록시·`/api/master-ingest`·`/api/sync-obsidian`이 같이 열린다. 집 안 공유는 `wiki_lan_server.js`가 전담한다.
- **`wiki_lan_server.js`에 쓰기·실행 엔드포인트를 추가하지 말 것.** 라우트는 `/`, `/wiki`, `/favicon.svg`, `/api/wiki-topics`, `/api/wiki-search`, `/api/wiki-ask` 뿐이다.
- `.env`의 `WIKI_LAN_ALLOW_CIDR`(사설 대역 `/16`~`/32`, 쉼표로 여러 개)가 없거나 틀리면 **`127.0.0.1` 전용으로 떨어진다(fail-closed).** 가족이 "갑자기 안 된다"고 하면 `wiki-lan.log`의 `바인딩:` 줄부터 본다.
- 클라이언트 IP는 **소켓 주소만** 본다. `X-Forwarded-For`를 읽는 코드를 넣지 말 것(위조 가능).
- AI 답변은 scheduler·wiki-ingest와 **같은 Gemini 무료 키**를 쓴다. IP당 분당 5회 + 전체 24시간 `WIKI_LAN_ASK_DAILY_MAX`회(기본 20, 메모리 카운터 — 재기동하면 0). 한도를 올리면 영상 요약·Wiki 합성이 429를 맞는다. 일반 검색은 임베딩 모델을 쓰므로 별개이고, 한도에 걸리면 키워드 검색으로 대체된다.
- 화면의 「Obsidian에서 열기」는 `location.hostname`이 `localhost`/`127.0.0.1`일 때만 나온다(`wiki.html:IS_LOCAL`). 가족 PC에는 Vault가 없다.
- **맥북이 집에 켜져 있을 때만 된다.** 덮개를 닫아 잠들거나 들고 나가면 가족은 접속할 수 없다. IPv6로는 열지 않는다(대역 검사가 IPv4 전제).
- `<맥이름>`은 `scutil --get LocalHostName`이다. macOS가 이름 충돌 시 끝 숫자를 올려 바꾸는 일이 있다 — 주소가 안 먹으면 이름부터 확인한다.
```

launchd 표 추가 행 + launchd 주의:
```
| `com.irichgreen.wiki-lan` | `wiki_lan_server.js` (포트 3100) | `KeepAlive`, `RunAtLoad`, `ThrottleInterval 60` — 상주 | `/opt/homebrew/bin/node` |
```
```markdown
- `com.irichgreen.wiki-lan`의 로그(`wiki-lan.log`)는 **`rotate_extra_logs.sh`에 넣지 않는다.** 상주형이라 rename 회전이 안전하지 않다. 대신 서버가 기동·차단·오류만 찍는다.
- **macOS 방화벽의 수신 허용은 node 실행 파일의 실제 경로(Cellar 버전 폴더)에 걸린다**(2026-10-03 실측: 허용 목록에 옛 버전 경로만 남아 있었다). `brew upgrade node` 후에는 경로가 바뀌므로 `wiki-lan`이 살아 있어도 가족 PC에서만 접속이 막힐 수 있다 — 이 맥에서의 `curl`은 정상으로 보일 수 있으니 판정은 다른 기기로 한다. 재기동 + 방화벽 재허용이 한 세트다.
```

### 8-2. `AGENTS.md`

`### launchd 데몬 3종` 표가 2곳(212행·294행 근처)에 있고 `wiki-ingest` 행이 `CLAUDE.md`와 어긋나 있다(`--full`, 03:00, `/usr/bin/python3`).
두 곳 모두 **`CLAUDE.md`의 갱신된 표로 통째 교체**하고 제목의 "3종"을 뗀다(어긋나면 `CLAUDE.md`가 이긴다). `AGENTS.md`의 그 밖의 내용은 건드리지 않는다.

### 8-3. `README.md`

| 위치 | 변경 |
|---|---|
| 머리 `**현재 버전: v3.1** (2026-09-10)` | `**현재 버전: v3.2** (2026-10-03)` |
| `## 📂 프로젝트 구조` | `wiki_lan_server.js`, `com.irichgreen.wiki-lan.plist` 추가. `wiki.html`·`lib/wiki_search.js`·`wiki_mcp.js`·`build_search_index.py`가 빠져 있으면 함께 추가 |
| `## 🔑 환경 변수 설정 (.env)` | `WIKI_LAN_ALLOW_CIDR=192.168.0.0/24`(예시값), `WIKI_LAN_ASK_DAILY_MAX=20` |
| `### 3. 카카오톡 링크 인제스트 (v3.0)` 뒤 | `### 4. Wiki 검색 (v3.2)` 신설 — 입구 표 + 가족 공유 켜는 순서(.env → plist → 방화벽 허용) + 제약(맥이 집에 켜져 있어야 함) |
| 요약 이력 표 맨 위 | 아래 1행 |
| 상세 변경 내역 맨 위 | `#### [v3.2] — 2026-10-03 (🏠 집 안 전용 Wiki 검색 서버)` 1절 — 배경(127.0.0.1 전용), 분리 이유(쓰기 엔드포인트 비노출), 안전장치, 검증 결과 |

요약 표 1행:
```
| **v3.2** | 2026-10-03 | **집 안 전용 Wiki 검색 서버**: 가족이 같은 네트워크의 다른 컴퓨터에서 `http://<맥이름>.local:3100/wiki`로 검색하도록 읽기 전용 서버 `wiki_lan_server.js` 신설. `server.js`(Notion 쓰기 프록시·인제스트 실행 포함)는 `127.0.0.1` 전용으로 유지하고 검색 경로만 분리 노출. 허용 대역(`WIKI_LAN_ALLOW_CIDR`) 밖 403, 미설정 시 루프백 전용(fail-closed), Host 검사, AI 답변 일일 총량으로 Gemini 무료 한도 보호. `launchd` `com.irichgreen.wiki-lan` 추가 |
```

### 8-4. 커밋

```bash
git add wiki_lan_server.js com.irichgreen.wiki-lan.plist wiki.html README.md CLAUDE.md AGENTS.md docs/tasks/2026-10-03-wiki-lan-server.md
git status --short
# 기대: 위 7개만 스테이징. ".env", ".env.bak.*" 가 보이면 중단
git commit -m "feat(wiki): 집 안 전용 읽기 전용 검색 서버 wiki_lan_server.js (v3.2)"
```

**`git push`는 하지 않는다.** 대표님 확인 후 별도로 한다.

### 8-5. 보고 (한국어)

1. §3 사전 확인 명령의 실제 출력
2. §4-3 fail-closed 출력
3. §5 기동 로그 + **방화벽 허용 창이 떴는지 여부**
4. §6 검증 6-1~6-7 각 항목의 실제 출력 (6-5를 생략했으면 그 이유)
5. 커밋 해시 2개(미커밋분 분리 커밋, 이번 작업 커밋)와 `git show --stat HEAD`
6. 기대와 달랐던 것, 지시서에 없어서 판단한 것

## 9. Cowork 사전 검증 결과 (2026-10-03, 스텁 검색 모듈 + 소켓 주소 치환 프리로드)

§4-1 코드를 수정 없이 실행해 확인한 것. 실제 인덱스·Gemini는 쓰지 않았다(그 부분은 §6이 검증한다).

| 항목 | 입력 | 결과 |
|---|---|---|
| fail-closed | `WIKI_LAN_ALLOW_CIDR` 미설정 | `127.0.0.1` 바인딩, LAN 주소 접속 불가 |
| 잘못된 대역 | `0.0.0.0/0`, `8.8.8.0/24`, `192.168.0.0/8`, `abc` | 4건 모두 오류 로그 + `127.0.0.1` 바인딩 |
| 대역 안 | `192.168.0.0/24` 허용(예시 대역), `.0.23` / `::ffff:` 표기 / `.0.255` | 200 |
| 대역 밖 | `192.168.1.23`, `192.167.255.255`, `8.8.8.8`, `fe80::1` | 403 |
| 다중 대역 | `192.168.0.0/24, 10.0.1.0/24` 허용, `10.0.1.5` / `10.0.2.5` | 200 / 403 |
| XFF 위조 | 대역 밖 + `X-Forwarded-For: <대역 안>` | 403 |
| 차단 로그 | 같은 IP 5회 차단 | 로그 1줄(IP당 분당 1줄로 제한) |
| Host 검사 | `evil.com` / `MyMac-3.local:3100` | 403 / 200 |
| 비노출 경로 | `/api/master-ingest`, `/api/config`, `/v1/pages`, `/../.env`, `/index.html` | 전부 404 |
| 보안 헤더 | `/wiki` 응답 | 4종 모두 존재 |
| AI 답변 출처 | 타 출처 `Origin` / 같은 출처 | 403 / 200 |
| AI 답변 입력 | 빈 질문 / 깨진 JSON / 본문 5KB | 400 / 400 / 413 |
| AI 답변 분당 한도 | 같은 IP 6번째 / 다른 IP | 429 / 200 |
| AI 답변 일일 총량 | `MAX=3`, IP 4개로 4회 | 200·200·200·429, 검색은 계속 200 |
| Gemini 중단 | `ask` 예외 | 503 + `results` (`server.js`와 같은 규약) |
| 전체 분당 한도 | 같은 IP 62회 / 다른 IP | 200×60 + 429×2 / 200 |
| 포트 충돌 | 두 번째 인스턴스 | `EADDRINUSE` 로그 + `exit 1` |
| 로그 | 위 전 과정 | 기동 배너와 차단 줄뿐, 검색어 기록 없음 |

## 10. 범위 밖 (손대지 않는다)

- **`server.js`, `lib/wiki_search.js`, `wiki_mcp.js`, `scheduler.js` 수정.** `server.js`의 `127.0.0.1` 바인딩은 그대로다.
- **macOS 방화벽 설정.** `sudo`가 필요하다 — 대표님이 직접 한다. `socketfilterfw`를 실행하지 않는다.
- **가족 PC에서의 실접속 확인.** 다른 기기가 있어야 한다 — 대표님이 한다.
- 집 밖 접속(Tailscale·터널·클라우드 배포), 로그인·비밀번호, HTTPS.
- `~/Library/Scripts/rotate_extra_logs.sh`에 `wiki-lan.log` 추가(상주형이라 금지).
- Claude 데스크톱 앱 MCP 등록, Vault 경로 승격(v3.3 예정분), `install-*.sh` 신설.
- `git push`.
