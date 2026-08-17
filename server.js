// ===== YouTube → Notion AI 요약기 백엔드 서버 (보안 강화판) =====
// 실행 방법: node server.js

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

// ── .env 파일 로드 ──
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}
loadEnv();

// ── 허용할 출처 (localhost만 허용) ──
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

// ── 허용된 Notion API 경로 패턴 (화이트리스트) ──
const ALLOWED_NOTION_PATHS = [
  /^\/v1\/pages$/,                          // 페이지 생성
  /^\/v1\/pages\/[a-f0-9\-]{32,36}$/,       // 페이지 수정
  /^\/v1\/databases\/[a-f0-9\-]{32,36}\/query$/, // DB 쿼리
  /^\/v1\/users\/me$/,                      // 토큰 테스트
  /^\/v1\/blocks\/[a-f0-9\-]{32,36}\/children$/, // 블록 append (v97: 100블록 초과 긴 요약문 저장)
];

// ── 요청 크기 제한 (5MB) ──
const MAX_BODY_SIZE = 5 * 1024 * 1024;

// ── Rate Limiting (IP당 분당 최대 요청 수) ──
const rateLimitMap = new Map();
const RATE_LIMIT = 120;     // 분당 최대 요청 수
const RATE_WINDOW = 60000;  // 1분

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return true;
}

// ── 오래된 Rate Limit 항목 주기적 정리 (메모리 누수 방지) ──
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.start > RATE_WINDOW * 2) rateLimitMap.delete(ip);
  }
}, 60000);

// ── 토큰 정리 함수 ──
function cleanToken(token) {
  if (!token) return '';
  try { token = decodeURIComponent(token); } catch(e) {}
  token = token.trim().replace(/[\r\n\t\x00-\x1F\x7F]/g, '');
  token = token.replace(/^Bearer\s+/i, '');
  return token;
}

// ── Notion 경로 유효성 검사 (인젝션 방지) ──
function isValidNotionPath(notionPath) {
  // 경로 순회 공격 차단
  if (notionPath.includes('..') || notionPath.includes('//')) return false;
  // 화이트리스트 패턴 확인
  return ALLOWED_NOTION_PATHS.some(pattern => pattern.test(notionPath));
}

// ── playlists.json 입력값 검증 ──
function validatePlaylists(data) {
  let parsed;
  try { parsed = JSON.parse(data); } catch(e) { return false; }
  if (!Array.isArray(parsed)) return false;
  if (parsed.length > 100) return false; // 최대 100개
  for (const item of parsed) {
    if (typeof item !== 'object' || !item.url || !item.name) return false;
    if (typeof item.url !== 'string' || typeof item.name !== 'string') return false;
    if (item.url.length > 500 || item.name.length > 200) return false;
    // YouTube 재생목록 URL 형식만 허용
    if (!/^https:\/\/(www\.)?youtube\.com\/playlist\?/.test(item.url) &&
        !/^https:\/\/youtube\.com\/playlist\?/.test(item.url)) return false;
  }
  return true;
}

// ── CORS 헤더 생성 (출처 검증) ──
function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-notion-token',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

// ── Notion API 호출 ──
function callNotion(method, apiPath, token, body, callback) {
  const cleanedToken = cleanToken(token);
  // 로그에 토큰 노출 최소화 (앞 6자만)
  console.log(`[Notion] ${method} ${apiPath} (token: ${cleanedToken.substring(0, 6)}...)`);

  const options = {
    hostname: 'api.notion.com',
    port: 443,
    path: apiPath,
    method: method,
    headers: {
      'Authorization': `Bearer ${cleanedToken}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    }
  };

  const notionReq = https.request(options, (notionRes) => {
    let data = '';
    notionRes.on('data', chunk => data += chunk);
    notionRes.on('end', () => {
      console.log(`[Notion] 응답: ${notionRes.statusCode}`);
      if (notionRes.statusCode !== 200) {
        // 오류 시 민감 정보 제거 후 로그
        try {
          const parsed = JSON.parse(data);
          console.log(`[Notion] 오류: ${parsed.message || parsed.code || notionRes.statusCode}`);
        } catch(e) {}
      }
      callback(null, notionRes.statusCode, data);
    });
  });

  notionReq.on('error', err => {
    console.error('[Notion] 요청 오류:', err.message);
    callback(err, null, null);
  });

  if (body) notionReq.write(body);
  notionReq.end();
}

// ── 요청 본문 수집 (크기 제한 적용) ──
function collectBody(req, callback) {
  let body = '';
  let size = 0;
  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      callback(new Error('요청 크기 초과'), null);
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => callback(null, body));
  req.on('error', err => callback(err, null));
}

// ── HTTP 서버 ──
const server = http.createServer((req, res) => {
  // WHATWG URL API 사용 (url.parse() 보안 경고 제거)
  const parsedUrl = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin || '';
  const CORS = getCorsHeaders(origin);
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  // Rate Limit 검사
  if (!checkRateLimit(clientIp)) {
    res.writeHead(429, { ...CORS, 'Retry-After': '60' });
    res.end(JSON.stringify({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' }));
    return;
  }

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // ── API 설정값 제공 (웹앱 자동 로드용) ──
  if (parsedUrl.pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, CORS);
    res.end(JSON.stringify({
      ytKey:   process.env.YOUTUBE_API_KEY  || '',
      gmKey:   process.env.GEMINI_API_KEY   || '',
      ntToken: process.env.NOTION_TOKEN     || '',
      ntDb:    process.env.NOTION_DB_ID     || '',
      telegram: {
        enabled:  process.env.TELEGRAM_ENABLED === 'true',
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId:   process.env.TELEGRAM_CHAT_ID   || '',
      },
    }));
    return;
  }

  // ── Obsidian 동기화 트리거 ──
  if (parsedUrl.pathname === '/api/sync-obsidian' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let notionMsg = '';
      try {
        const parsed = JSON.parse(body || '{}');
        notionMsg = parsed.notionMsg || '';
      } catch(e) {}

      res.writeHead(200, CORS);
      res.end(JSON.stringify({ ok: true, message: 'Obsidian 동기화 시작' }));

      const { execFile } = require('child_process');
      const python3 = '/opt/homebrew/bin/python3';
      const syncScript = require('path').join(__dirname, 'sync_obsidian.py');
      execFile(python3, [syncScript], { cwd: __dirname }, async (err, stdout) => {
        if (err) {
          console.log(`❌ Obsidian 동기화 오류: ${err.message}`);
          // 오류 시 최소한 notionMsg라도 전송
          if (notionMsg && process.env.TELEGRAM_ENABLED === 'true') {
            const text = encodeURIComponent(notionMsg);
            const token = process.env.TELEGRAM_BOT_TOKEN;
            const chatId = process.env.TELEGRAM_CHAT_ID;
            require('https').get(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${text}`);
          }
          return;
        }
        // RESULT_JSON 파싱 후 텔레그램 전송 (v97: Notion + 구분선 + Obsidian을 1개 메시지로 통합)
        const jsonLine = (stdout || '').split('\n').find(l => l.startsWith('RESULT_JSON:'));
        if (jsonLine && process.env.TELEGRAM_ENABLED === 'true') {
          try {
            const r = JSON.parse(jsonLine.replace('RESULT_JSON:', ''));
            const obsLines = [
              `📓 Obsidian AI LLM Wiki`,
              `  • 신규 추가: ${r.added}개`,
              ...(r.tags_updated > 0 ? [`  • tags 갱신: ${r.tags_updated}개`] : []),
              `  • Wiki 재구성: ${r.rebuilt ? '✅ 완료' : '⏭ 생략'}`,
              `  • 소요시간: ${r.elapsed}초`,
            ];
            const obsMsg = obsLines.join('\n');
            const combined = notionMsg
              ? `${notionMsg}\n━━━━━━━━━━━━━━━━━━━━━━\n${obsMsg}`
              : obsMsg;
            const text = encodeURIComponent(combined);
            const token = process.env.TELEGRAM_BOT_TOKEN;
            const chatId = process.env.TELEGRAM_CHAT_ID;
            require('https').get(`https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${text}`);
            console.log(`✅ Obsidian 동기화 완료 — 추가: ${r.added}개`);
          } catch(e) {
            console.log(`⚠️ Obsidian 결과 파싱 오류: ${e.message}`);
          }
        }
      });
    });
    return;
  }

  // ── AI 영상목록 마스터 인제스트 (SSE 스트리밍) ──
  if (parsedUrl.pathname === '/api/master-ingest' && req.method === 'POST') {
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (msg) => {
      try { res.write(`data: ${JSON.stringify({ msg })}\n\n`); } catch {}
    };
    const done = (stats) => {
      try { res.write(`data: ${JSON.stringify({ done: true, stats })}\n\n`); res.end(); } catch {}
    };

    send('🚀 AI 영상목록 마스터 인제스트 시작...');

    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [require('path').join(__dirname, 'scheduler.js')], {
      cwd: __dirname,
      env: { ...process.env },
    });

    let output = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      output += text;
      for (const line of text.split('\n')) {
        // RESULT_ROW: 접두사 → 구조화 데이터(결과 테이블용)로 별도 전송
        if (line.startsWith('RESULT_ROW:')) {
          try {
            const row = JSON.parse(line.slice('RESULT_ROW:'.length).trim());
            try { res.write(`data: ${JSON.stringify({ row })}\n\n`); } catch {}
          } catch {}
          continue;
        }
        const clean = line.replace(/^\[.*?\]\s*/, '').trim();
        if (clean) send(clean);
      }
    });
    child.stderr.on('data', (d) => send('⚠️ ' + d.toString().trim()));

    child.on('close', (code) => {
      // 통계 파싱
      const savedM  = output.match(/저장:\s*([\d,]+)개/);
      const skipM   = output.match(/Skip:\s*([\d,]+)개/);
      const errorM  = output.match(/오류:\s*([\d,]+)개/);
      done({
        saved: parseInt((savedM?.[1] || '0').replace(/,/g, ''), 10),
        skip:  parseInt((skipM?.[1]  || '0').replace(/,/g, ''), 10),
        error: parseInt((errorM?.[1] || '0').replace(/,/g, ''), 10),
        code,
      });
    });

    req.on('close', () => { try { child.kill(); } catch {} });
    return;
  }

  // ── LLM Wiki 검색 페이지 ──
  if (parsedUrl.pathname === '/wiki' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'wiki.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
    return;
  }

  // ── LLM Wiki 토픽 목록 (필터 드롭다운용) ──
  if (parsedUrl.pathname === '/api/wiki-topics' && req.method === 'GET') {
    try {
      const topics = require('./lib/wiki_search').listTopics();
      res.writeHead(200, CORS);
      res.end(JSON.stringify({ topics }));
    } catch (e) {
      res.writeHead(500, CORS);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── LLM Wiki 검색 API ──
  if (parsedUrl.pathname === '/api/wiki-search' && req.method === 'GET') {
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    if (!q || q.length > 500) {
      res.writeHead(400, CORS);
      res.end(JSON.stringify({ error: '검색어(q)는 1~500자여야 합니다.' }));
      return;
    }
    const topic = (parsedUrl.searchParams.get('topic') || '').trim();
    const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '10', 10) || 10, 30);
    const wikiSearch = require('./lib/wiki_search');
    wikiSearch.search(q, { topic, limit })
      .then(({ results, mode }) => {
        res.writeHead(200, CORS);
        res.end(JSON.stringify({ results, mode }));
      })
      .catch(e => {
        console.error('[wiki-search] 오류:', e.message);
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  // ── LLM Wiki AI 답변 API (RAG) ──
  if (parsedUrl.pathname === '/api/wiki-ask' && req.method === 'POST') {
    collectBody(req, (err, body) => {
      if (err) {
        res.writeHead(413, CORS);
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      let question = '';
      try { question = (JSON.parse(body || '{}').question || '').trim(); } catch (e) {}
      if (!question || question.length > 500) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: '질문(question)은 1~500자여야 합니다.' }));
        return;
      }
      const wikiSearch = require('./lib/wiki_search');
      wikiSearch.ask(question)
        .then(result => {
          res.writeHead(200, CORS);
          res.end(JSON.stringify(result));
        })
        .catch(e => {
          console.error('[wiki-ask] 오류:', e.message);
          // 답변 생성 실패 시에도 검색 결과는 최대한 반환
          wikiSearch.search(question, { limit: 8 })
            .then(({ results }) => {
              res.writeHead(503, CORS);
              res.end(JSON.stringify({ error: 'AI 답변 생성 불가 (일일 한도 도달 또는 API 중단)', results }));
            })
            .catch(() => {
              res.writeHead(500, CORS);
              res.end(JSON.stringify({ error: e.message }));
            });
        });
    });
    return;
  }

  // ── HTML 서빙 ──
  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
    return;
  }

  // ── 이메일 전송 ──
  if (parsedUrl.pathname === '/send-email' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { from, to, appPass, subject, body: msgBody } = JSON.parse(body);
        if (!from || !to || !appPass || !subject) {
          res.writeHead(400, CORS);
          res.end(JSON.stringify({ ok: false, error: '필수 파라미터 누락' }));
          return;
        }
        const tls = require('tls');
        const auth = Buffer.from(`\0${from}\0${appPass.replace(/\s/g,'')}`).toString('base64');
        const subjectEncoded = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
        const bodyBase64 = Buffer.from(msgBody || '').toString('base64');
        const msg = [
          `From: YouTube Notion 요약기 <${from}>`,
          `To: ${to}`,
          `Subject: ${subjectEncoded}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          bodyBase64,
        ].join('\r\n');

        const socket = tls.connect(465, 'smtp.gmail.com', {}, () => {
          let step = 0;
          const cmds = [
            `EHLO localhost\r\n`,
            `AUTH PLAIN ${auth}\r\n`,
            `MAIL FROM:<${from}>\r\n`,
            `RCPT TO:<${to}>\r\n`,
            `DATA\r\n`,
            `${msg}\r\n.\r\n`,
            `QUIT\r\n`,
          ];
          socket.on('data', d => {
            const r = d.toString();
            if ((r.startsWith('220') || r.includes('250') || r.includes('235')) && step < 5) {
              socket.write(cmds[step++]);
            } else if (r.startsWith('354') && step === 5) {
              socket.write(cmds[step++]);
            } else if (r.startsWith('250') && step === 6) {
              socket.write(cmds[step++]);
            } else if (r.startsWith('221')) {
              res.writeHead(200, CORS);
              res.end(JSON.stringify({ ok: true }));
              socket.destroy();
            }
          });
          socket.on('error', e => {
            res.writeHead(500, CORS);
            res.end(JSON.stringify({ ok: false, error: e.message }));
          });
        });
        socket.on('error', e => {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        });
      } catch(e) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // ── Notion 토큰 테스트 ──
  if (parsedUrl.pathname === '/test-notion' && req.method === 'GET') {
    // 토큰은 헤더에서만 받음 (URL 파라미터 금지)
    const rawToken = req.headers['x-notion-token'] || '';
    const token = cleanToken(rawToken);

    if (!token) {
      res.writeHead(400, CORS);
      res.end(JSON.stringify({ error: '토큰을 입력하세요.' }));
      return;
    }

    callNotion('GET', '/v1/users/me', token, null, (err, status, data) => {
      if (err) {
        res.writeHead(500, CORS);
        res.end(JSON.stringify({ status: '❌ 서버 오류', message: '연결 실패' }));
        return;
      }
      const result = JSON.parse(data);
      res.writeHead(status, CORS);
      if (status === 200) {
        res.end(JSON.stringify({
          status: '✅ 토큰 유효',
          type: result.type,
          name: result.name || '(이름 없음)',
        }));
      } else {
        res.end(JSON.stringify({
          status: '❌ 토큰 오류',
          statusCode: status,
          message: result.message,
          code: result.code,
        }));
      }
    });
    return;
  }

  // ── Notion API 프록시 ──
  if (parsedUrl.pathname.startsWith('/notion-proxy') && req.method !== 'GET') {
    const notionPath = parsedUrl.pathname.replace('/notion-proxy', '');

    // 경로 유효성 검사 (인젝션 방지)
    if (!isValidNotionPath(notionPath)) {
      console.warn(`[보안] 허용되지 않은 Notion 경로 차단: ${notionPath} (IP: ${clientIp})`);
      res.writeHead(403, CORS);
      res.end(JSON.stringify({ error: '허용되지 않은 경로입니다.' }));
      return;
    }

    const rawToken = req.headers['x-notion-token'] || '';
    const token = cleanToken(rawToken);

    if (!token) {
      res.writeHead(401, CORS);
      res.end(JSON.stringify({ error: '인증 토큰이 필요합니다.' }));
      return;
    }

    collectBody(req, (err, body) => {
      if (err) {
        res.writeHead(413, CORS);
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      callNotion(req.method, notionPath, token, body || null, (err, status, data) => {
        if (err) {
          res.writeHead(500, CORS);
          res.end(JSON.stringify({ error: '서버 오류' }));
          return;
        }
        res.writeHead(status, CORS);
        res.end(data);
      });
    });
    return;
  }

  // ── 재생목록 읽기 ──
  if (parsedUrl.pathname === '/playlists' && req.method === 'GET') {
    const filePath = path.join(__dirname, 'playlists.json');
    fs.readFile(filePath, 'utf8', (err, data) => {
      res.writeHead(200, CORS);
      res.end(err ? '[]' : data);
    });
    return;
  }

  // ── 재생목록 저장 ──
  if (parsedUrl.pathname === '/playlists' && req.method === 'POST') {
    collectBody(req, (err, body) => {
      if (err) {
        res.writeHead(413, CORS);
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      // 입력값 검증
      if (!validatePlaylists(body)) {
        res.writeHead(400, CORS);
        res.end(JSON.stringify({ error: '유효하지 않은 재생목록 데이터입니다.' }));
        return;
      }
      const filePath = path.join(__dirname, 'playlists.json');
      fs.writeFile(filePath, body, 'utf8', (err) => {
        res.writeHead(err ? 500 : 200, CORS);
        res.end(JSON.stringify({ ok: !err }));
      });
    });
    return;
  }

  // ── 404 ──
  res.writeHead(404, CORS);
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('========================================');
  console.log('  YouTube → Notion AI 요약기 (보안 강화)');
  console.log('========================================');
  console.log(`  브라우저 접속: http://localhost:${PORT}`);
  console.log('  종료: Ctrl+C');
  console.log('========================================');
  console.log('');
});
