// ===== YouTube → Notion AI 요약기 자동 스케줄러 =====
// Mac launchd에 의해 6시간 간격으로 자동 실행됩니다.
// 직접 실행: node scheduler.js

const https = require('https');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════
// ★ .env 파일에서 환경변수 로드 ★
// ══════════════════════════════════
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

// ── Gemini 다중 API Key 로더 및 상태 관리 ──
const getGeminiKeys = () => {
  const keysStr = process.env.GEMINI_API_KEYS || '';
  if (keysStr) {
    return keysStr.split(',').map(k => k.trim()).filter(Boolean);
  }
  return [process.env.GEMINI_API_KEY || ''].filter(Boolean);
};

let currentGeminiKeyIdx = 0;

function getActiveGeminiKey() {
  const keys = CONFIG.geminiApiKeys;
  if (!keys || keys.length === 0) return '';
  return keys[currentGeminiKeyIdx % keys.length];
}

function rotateGeminiKey() {
  const keys = CONFIG.geminiApiKeys;
  if (!keys || keys.length <= 1) return false;
  const oldKeyIdx = currentGeminiKeyIdx;
  currentGeminiKeyIdx = (currentGeminiKeyIdx + 1) % keys.length;
  log(`      🔄 [API Key Rotation] API 키 교체 ➔ (Key #${oldKeyIdx + 1} ➔ Key #${currentGeminiKeyIdx + 1})`);
  return true;
}

const CONFIG = {
  youtubeApiKey:        process.env.YOUTUBE_API_KEY             || '',
  geminiApiKey:         process.env.GEMINI_API_KEY              || '', // 하위 호환성용
  geminiApiKeys:        getGeminiKeys(),                        // 다중 키 배열
  notionToken:          process.env.NOTION_TOKEN                || '',
  notionDbId:           process.env.NOTION_DB_ID                || '',
  masterPlaylistId:     process.env.YOUTUBE_MASTER_PLAYLIST_ID  || '',

  telegram: {
    enabled:  process.env.TELEGRAM_ENABLED === 'true',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId:   process.env.TELEGRAM_CHAT_ID   || '',
  },
  email: {
    enabled:  process.env.EMAIL_ENABLED === 'true',
    from:     process.env.EMAIL_FROM     || '',
    to:       process.env.EMAIL_TO       || '',
    appPass:  process.env.EMAIL_APP_PASS || '',
  },
};
// ══════════════════════════════════

// ══════════════════════════════════
// 텔레그램 알림 전송
// ══════════════════════════════════
function sendTelegram(message) {
  return new Promise((resolve) => {
    if (!CONFIG.telegram.enabled) return resolve();
    const text = encodeURIComponent(message);
    const url = `/bot${CONFIG.telegram.botToken}/sendMessage?chat_id=${CONFIG.telegram.chatId}&text=${text}&parse_mode=HTML`;
    const req = https.request(
      { hostname: 'api.telegram.org', path: url, method: 'GET' },
      (res) => {
        let data = [];
        res.on('data', c => data.push(c));
        res.on('end', () => {
          const body = JSON.parse(Buffer.concat(data).toString('utf8'));
          if (body.ok) log('📱 텔레그램 알림 전송 완료');
          else log('⚠️  텔레그램 전송 실패: ' + body.description);
          resolve();
        });
      }
    );
    req.on('error', (e) => { log('⚠️  텔레그램 오류: ' + e.message); resolve(); });
    req.end();
  });
}

// ══════════════════════════════════
// 이메일 알림 전송 (Gmail SMTP over TLS)
// ══════════════════════════════════
function sendEmail(subject, body) {
  return new Promise((resolve) => {
    if (!CONFIG.email.enabled) return resolve();
    const tls = require('tls');
    const { from, to, appPass } = CONFIG.email;
    const auth = Buffer.from(`\0${from}\0${appPass}`).toString('base64');
    const boundary = 'boundary_yt_notify';
    const msg = [
      `From: YouTube Notion 요약기 <${from}>`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: text/plain; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body).toString('base64'),
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
      socket.on('data', (d) => {
        const res = d.toString();
        if (res.startsWith('220') && step === 0) { socket.write(cmds[step++]); return; }
        if ((res.includes('250') || res.includes('235')) && step <= 5) { socket.write(cmds[step++]); return; }
        if (res.startsWith('354') && step === 5) { socket.write(cmds[step++]); return; }
        if (res.startsWith('221')) { log('📧 이메일 알림 전송 완료'); socket.destroy(); resolve(); }
      });
      socket.on('error', (e) => { log('⚠️  이메일 오류: ' + e.message); resolve(); });
    });
    socket.on('error', (e) => { log('⚠️  이메일 연결 오류: ' + e.message); resolve(); });
  });
}

// ── 로그 파일 경로 (scheduler.log 로 기록됨) ──
const LOG_FILE = path.join(__dirname, 'scheduler.log');

// ── 로그 기록 함수 (터미널 + 파일) ──
function log(msg) {
  const t = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const line = `[${t}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

// ── playlists.json 에서 재생목록 목록 읽기 ──
function loadPlaylists() {
  const filePath = path.join(__dirname, 'playlists.json');
  if (!fs.existsSync(filePath)) {
    log('⚠️  playlists.json 파일이 없습니다. 브라우저에서 재생목록을 먼저 등록하세요.');
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    log(`❌ playlists.json 파싱 오류: ${e.message}`);
    return [];
  }
}

// ── 토큰 정리 ──
function cleanToken(token) {
  if (!token) return '';
  try { token = decodeURIComponent(token); } catch(e) {}
  token = token.trim().replace(/[\r\n\t\x00-\x1F\x7F]/g, '');
  token = token.replace(/^Bearer\s+/i, '');
  return token;
}

// ── HTTPS GET/POST 래퍼 ──
// Buffer 배열로 수집 후 utf8 디코딩 → 이모지 등 멀티바이트 문자 깨짐 방지
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (body) {
      // body를 utf8 Buffer로 변환하여 전송 (이모지 포함 제목 처리)
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      const bodyBuf = Buffer.from(bodyStr, 'utf8');
      req.write(bodyBuf);
    }
    req.end();
  });
}

// ── YouTube API 호출 ──
async function ytFetch(path) {
  const res = await httpsRequest({
    hostname: 'www.googleapis.com',
    path: `/youtube/v3/${path}&key=${CONFIG.youtubeApiKey}`,
    method: 'GET',
  });
  if (res.status !== 200) throw new Error(`YouTube API 오류 ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

// ── 재생목록 이름 가져오기 ──
async function getPlaylistTitle(listId) {
  const d = await ytFetch(`playlists?part=snippet&id=${listId}`);
  return d.items?.[0]?.snippet?.title || '';
}

// ── 재생목록 전체 동영상 가져오기 ──
async function getVideos(listId) {
  const videos = [];
  let token = '';
  do {
    const d = await ytFetch(`playlistItems?part=snippet&playlistId=${listId}&maxResults=50&pageToken=${token}`);
    for (const it of d.items) {
      const s = it.snippet;
      if (s.resourceId?.videoId) {
        videos.push({
          videoId: s.resourceId.videoId,
          title: s.title,
          channelId: s.channelId,
          channelTitle: s.channelTitle,
          publishedAt: s.publishedAt,
          thumbnail: s.thumbnails?.medium?.url || '',
        });
      }
    }
    token = d.nextPageToken || '';
  } while (token);
  return videos;
}

// ── 동영상 상세 정보 (최대 50개 배치 조회) ──
async function getBatchDetails(videoIds) {
  if (!videoIds.length) return {};
  const map = {};
  // 50개씩 나눠서 배치 조회
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const d = await ytFetch(`videos?part=statistics,snippet&id=${batch.join(',')}`);
    for (const it of (d.items || [])) {
      map[it.id] = {
        viewCount:       parseInt(it?.statistics?.viewCount || 0),
        description:     it?.snippet?.description || '',
        tags:            it?.snippet?.tags || [],
        realChannelTitle: it?.snippet?.channelTitle || '',
        realChannelId:   it?.snippet?.channelId || '',
        realPublishedAt: it?.snippet?.publishedAt || '',
      };
    }
  }
  return map;
}

// ── 채널 구독자수 ──
async function getSubs(channelId) {
  const d = await ytFetch(`channels?part=statistics&id=${channelId}`);
  return parseInt(d.items?.[0]?.statistics?.subscriberCount || 0);

}
// ── 요약 무결성 검증 함수 ──
function validateSummary(summary) {
  if (!summary || summary === '요약 불가') return false;
  const requiredSections = [
    '## 영상 개요',
    '## 핵심 내용',
    '## 주요 인사이트',
    '## 활용 포인트'
  ];
  // 4가지 섹션 헤더가 모두 포함되어 있는지 검증
  const hasAllHeaders = requiredSections.every(sec => summary.includes(sec));
  if (!hasAllHeaders) return false;

  // 마지막 섹션인 '## 활용 포인트' 밑에 내용이 충분히 채워졌는지 검증 (10자 이상)
  const partIndex = summary.indexOf('## 활용 포인트');
  const partContent = summary.slice(partIndex + '## 활용 포인트'.length).trim();
  if (partContent.length < 10) return false;

  return true;
}

// ── 제목 정규화 헬퍼 (중복 감지 신뢰도 향상) ──
function normalizeTitle(t) {
  if (!t) return '';
  return t
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '') // 공백, 기호, 이모지 등 모두 제거해 매칭률 극대화
    .trim();
}

// ── Gemini 요약 ──
async function geminiSummarize(v) {
  const basePrompt = `당신은 YouTube 영상 콘텐츠를 분석하는 전문 리서처입니다.
아래 영상 정보를 바탕으로 경영진이 읽는 보고서를 한국어로 작성해주세요.

[절대 규칙]
- 반드시 아래 4개 섹션을 모두 작성할 것 (하나라도 빠지면 안 됨)
- 각 섹션 제목은 반드시 ## 로 시작할 것
- 핵심 내용과 주요 인사이트는 반드시 * 로 시작하는 항목으로 작성할 것
- **굵게** 표시가 필요한 핵심 키워드는 **텍스트** 형식으로 표시
- 영상 정보가 부족해도 제목과 채널명을 바탕으로 반드시 추론하여 작성할 것
- 절대로 중간에 끊지 말고 4개 섹션을 모두 완성할 것

[작성 형식]
## 영상 개요
(이 영상이 다루는 주제와 목적을 정확히 3문장으로 서술. 영상의 핵심 주제, 대상 시청자, 주요 목적을 포함)

## 핵심 내용
* **[핵심 키워드1]**: (구체적인 설명 1~2문장)
* **[핵심 키워드2]**: (구체적인 설명 1~2문장)
* **[핵심 키워드3]**: (구체적인 설명 1~2문장)
* **[핵심 키워드4]**: (구체적인 설명 1~2문장)
(반드시 4개 이상 항목 작성)

## 주요 인사이트
* **[인사이트1]**: (비즈니스/실무 관점의 핵심 시사점 1~2문장)
* **[인사이트2]**: (비즈니스/실무 관점의 핵심 시사점 1~2문장)
* **[인사이트3]**: (비즈니스/실무 관점의 핵심 시사점 1~2문장)
(반드시 3개 항목 작성)

## 활용 포인트
(이 영상의 내용을 실무나 의사결정에 어떻게 활용할 수 있는지 구체적으로 2~3문장 작성)

[영상 정보]
제목: ${v.title}
채널: ${v.channelTitle}
설명: ${v.description || '(없음)'}
태그: ${v.tags?.join(', ') || '(없음)'}

보고서:`;

  const fallbackPrompt = `당신은 YouTube 영상 콘텐츠를 분석하는 전문 리서처입니다.
[🚨 중요: 이번에는 텍스트가 절대 짤리지 않도록 각 섹션을 중언부언하지 말고 매우 간결하고 밀도 높은 한국어 문장(핵심당 1문장 내외)으로 짧게 완성해 주세요.]

[절대 규칙]
- 반드시 아래 4개 섹션을 모두 작성할 것 (하나라도 빠지면 안 됨)
- 각 섹션 제목은 반드시 ## 로 시작할 것
- 핵심 내용과 주요 인사이트는 반드시 * 로 시작하는 항목으로 작성할 것
- 절대로 중간에 끊지 말고 4개 섹션을 모두 완벽히 완성할 것

[작성 형식]
## 영상 개요
(이 영상이 다루는 주제와 목적을 핵심 위주로 정확히 2문장으로 요약)

## 핵심 내용
* **[핵심 키워드1]**: (구체적인 설명 1문장)
* **[핵심 키워드2]**: (구체적인 설명 1문장)
* **[핵심 키워드3]**: (구체적인 설명 1문장)
(반드시 3개 이상 항목 작성)

## 주요 인사이트
* **[인사이트1]**: (비즈니스/실무 관점의 핵심 시사점 1문장)
* **[인사이트2]**: (비즈니스/실무 관점의 핵심 시사점 1문장)
(반드시 2개 이상 항목 작성)

## 활용 포인트
(이 영상의 내용을 실무나 의사결정에 어떻게 활용할 수 있는지 구체적으로 1~2문장 작성)

[영상 정보]
제목: ${v.title}
채널: ${v.channelTitle}
설명: ${v.description || '(없음)'}
태그: ${v.tags?.join(', ') || '(없음)'}

보고서:`;

  let finalSummary = '요약 불가';
  let qualityAttempt = 0;
  const maxQualityAttempts = 3;

  while (qualityAttempt < maxQualityAttempts) {
    const isFallback = qualityAttempt > 0;
    const prompt = isFallback ? fallbackPrompt : basePrompt;
    
    if (isFallback) {
      log(`    ⚠️ [요약 무결성 검증 실패] 주요 섹션 유실 감지 ➔ 간결한 Fallback 프롬프트로 재시도 (${qualityAttempt}/${maxQualityAttempts - 1})`);
    }

    let res;
    const keysCount = CONFIG.geminiApiKeys.length;
    const maxAttempts = Math.max(3, keysCount * 2);
    let attempt = 0;

    while (attempt < maxAttempts) {
      const currentKey = getActiveGeminiKey();
      const maskedKey = currentKey ? `${currentKey.slice(0, 8)}...${currentKey.slice(-6)}` : '없음';

      res = await httpsRequest({
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.3, 
          maxOutputTokens: 4000, // 한글 출력 짤림 방지를 위해 2000 ➔ 4000 상향
          thinkingConfig: { thinkingBudget: 0 }
        },
      });

      if (res.status === 429) {
        attempt++;
        if (keysCount > 1 && attempt < keysCount) {
          log(`    ⏳ [Rate Limit] 429 에러 발생 (Key: ${maskedKey}). 대기 없이 다음 API Key로 즉시 교체 시도... (시도: ${attempt}/${maxAttempts})`);
          rotateGeminiKey();
          await new Promise(r => setTimeout(r, 500));
          continue;
        } else {
          log(`    ⏳ [Rate Limit] 429 에러 지속 발생 (Key: ${maskedKey}). 20초 대기 후 순환 재시도... (시도: ${attempt}/${maxAttempts})`);
          rotateGeminiKey();
          await new Promise(r => setTimeout(r, 20000));
          continue;
        }
      }

      if (res.status === 403) {
        const errorMsg = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
        log(`\n🚨🚨🚨 [치명적 권한 에러] Gemini API 403 Forbidden 감지! (Key: ${maskedKey})`);
        log(`상세 내용: ${errorMsg}`);
        
        if (errorMsg.includes('suspended') || errorMsg.includes('CONSUMER_SUSPENDED')) {
          log(`⚠️  경고: 구글에 의해 해당 API Key 또는 프로젝트가 정지(Suspended)되었습니다.`);
          log(`계정 보호 및 추가 연쇄 정지 방지를 위해 즉시 작업을 전면 중단하고 프로세스를 종료합니다.`);
          await sendTelegram(`🚨 <b>[치명적 보안 경고]</b>\nGemini API 키 정지(Suspended) 감지!\n추가 차단 방지를 위해 요약 작업을 긴급 중단하고 프로세스를 강제 종료했습니다.\n계정 및 API 상태를 즉시 확인하세요.`);
          process.exit(1);
        } else {
          log(`⚠️  권한 부족 오류입니다. 추가 에러 방지를 위해 작업을 중단합니다.`);
          await sendTelegram(`🚨 <b>[작업 중단 알림]</b>\nGemini API 403 Forbidden 권한 에러 감지.\n작업을 긴급 중단했습니다.`);
          process.exit(1);
        }
      }

      if (res.status === 400 || res.status === 401) {
        log(`🚨 [치명적 설정 에러] Gemini API ${res.status} 감지! (Key: ${maskedKey})`);
        log(`잘못된 요청이거나 잘못된 API 키 설정입니다. 추가적인 무의미한 API 호출 방지를 위해 프로세스를 종료합니다.`);
        await sendTelegram(`🚨 <b>[설정 오류 알림]</b>\nGemini API ${res.status} 오류 감지.\n프로세스를 중단했습니다.`);
        process.exit(1);
      }
      
      if (res.status !== 200) {
        attempt++;
        const waitTime = Math.min(20000, 3000 * Math.pow(2, attempt)); // 지수 백오프 적용
        log(`    ⚠️  Gemini API 에러 ${res.status} (Key: ${maskedKey}). ${waitTime / 1000}초 대기 후 다음 키로 교체 시도... (시도: ${attempt}/${maxAttempts})`);
        rotateGeminiKey();
        await new Promise(r => setTimeout(r, waitTime));
        continue;
      }
      break;
    }
    
    if (res.status !== 200) throw new Error(`Gemini 재시도 초과 오류 ${res.status}: ${JSON.stringify(res.data)}`);
    
    const candidateText = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '요약 불가';
    
    if (validateSummary(candidateText)) {
      finalSummary = candidateText;
      log(`    ✓ 요약 무결성 검증 통과!`);
      break;
    } else {
      finalSummary = candidateText;
      qualityAttempt++;
    }
  }

  return finalSummary;
}

// ── Notion API 호출 ──
async function notionCall(method, apiPath, body) {
  const token = cleanToken(CONFIG.notionToken);
  const bodyStr = body ? JSON.stringify(body) : null;
  const res = await httpsRequest({
    hostname: 'api.notion.com',
    path: apiPath,
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
      ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr, 'utf8') } : {}),
    },
  }, bodyStr);
  return res;
}

// ── Notion DB 전체 캐시 로드 (재생목록 처리 전 1회만 호출) ──
async function loadNotionCache() {
  const cache = new Map();
  let cursor = undefined;
  let total = 0;
  let retryCount = 0;
  const MAX_RETRY = 10;          // 네트워크 복구 대기 포함해 여유 있게
  const NETWORK_WAIT_MS = 30000; // 네트워크 오류 시 30초 대기
  log('  📦 Notion DB 캐시 로딩 중...');
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    let res;
    try {
      res = await notionCall('POST', `/v1/databases/${CONFIG.notionDbId}/query`, body);
    } catch (netErr) {
      retryCount++;
      const isNetErr = netErr.code === 'ENOTFOUND' || netErr.code === 'ETIMEDOUT'
                    || netErr.code === 'ECONNREFUSED' || netErr.code === 'ECONNRESET';
      const waitMs = isNetErr ? NETWORK_WAIT_MS : 2000 * retryCount;
      log(`  ⚠️ 네트워크 오류 (${netErr.code || netErr.message}), ${waitMs / 1000}초 후 재시도 ${retryCount}/${MAX_RETRY}...`);
      if (retryCount >= MAX_RETRY) throw netErr;
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    if (res.status !== 200) {
      retryCount++;
      log(`  ⚠️ Notion API 오류 (status ${res.status}), 재시도 ${retryCount}/${MAX_RETRY}...`);
      if (retryCount >= MAX_RETRY) {
        log(`  ❌ Notion 캐시 로딩 실패 — 재시도 횟수 초과`);
        break;
      }
      await new Promise(r => setTimeout(r, 2000 * retryCount));
      continue;
    }
    retryCount = 0;
    for (const page of (res.data?.results || [])) {
      const props = page.properties || {};
      const title = (props['영상 제목']?.title || []).map(t => t.text?.content || '').join('');
      const videoUrl = props['영상 URL']?.url || '';
      const vidMatch = videoUrl.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
      const videoId = vidMatch ? vidMatch[1] : '';
      if (!videoId && !title) continue;
      
      const entry = {
        pageId:           page.id,
        title:            title,
        topics:           (props['주제']?.multi_select || []).map(t => (t.name || '').normalize('NFC')),
        savedViewCount:   props['조회수']?.number ?? null,
        savedSubscribers: props['구독자수']?.number ?? null,
        savedDate:        props['업로드 일자']?.date?.start ?? null,
      };

      if (videoId) cache.set(videoId, entry);
      if (title) cache.set(title, entry);
      
      // 정규화된 제목 보조 키 등록 (공백/이모지 방지)
      const normTitle = normalizeTitle(title);
      if (normTitle) cache.set(normTitle, entry);
    }
    total += res.data?.results?.length || 0;
    cursor = res.data?.next_cursor;
    log(`  📦 캐시 진행: ${total}개 로드됨...`);
  } while (cursor);
  log(`  ✓ Notion DB 캐시 완료: ${total}개 페이지 로드`);
  return cache;
}

// ── 중복 체크 (videoId 우선, 없으면 정규화된 title로 fallback) ──
function findDuplicate(video, cache) {
  if (video.videoId && cache.has(video.videoId)) return cache.get(video.videoId);
  if (video.title) {
    if (cache.has(video.title)) return cache.get(video.title);
    const normTitle = normalizeTitle(video.title);
    if (cache.has(normTitle)) return cache.get(normTitle);
  }
  return null;
}

// ── 기존 페이지에 주제(재생목록) 추가 ──
async function addTopicToPage(pageId, newTopic, existingTopics) {
  // NFC 정규화 — 레거시 NFD 자모 분해 태그가 신규 NFC와 별개로 등록되는 것을 차단
  const nfcNew = (newTopic || '').normalize('NFC');
  const nfcExisting = (existingTopics || []).map(t => (t || '').normalize('NFC'));
  if (nfcExisting.includes(nfcNew)) return false;
  const allTopics = [...new Set([...nfcExisting, nfcNew])];
  const res = await notionCall('PATCH', `/v1/pages/${pageId}`, {
    properties: {
      '주제': { multi_select: allTopics.map(t => ({ name: t })) }
    }
  });
  return res.status === 200;
}

// ── Notion rich_text 2000자 제한 분할 헬퍼 ──
function splitRichText(text, maxLen = 1900) {
  const result = [];
  for (let i = 0; i < (text || '').length; i += maxLen) {
    result.push({ type: 'text', text: { content: text.slice(i, i + maxLen) } });
  }
  return result.length ? result : [{ type: 'text', text: { content: '' } }];
}

// ── **볼드** 마크다운 → Notion rich_text 변환 ──
function parseBoldRichText(text, maxLen = 1900) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', text: { content: text.slice(last, m.index) } });
    parts.push({ type: 'text', text: { content: m[1] }, annotations: { bold: true } });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: 'text', text: { content: text.slice(last) } });

  // 각 part를 maxLen으로 분할
  const result = [];
  for (const p of parts) {
    const content = p.text.content;
    for (let i = 0; i < content.length; i += maxLen) {
      result.push({ ...p, text: { ...p.text, content: content.slice(i, i + maxLen) } });
    }
  }
  return result.length ? result : [{ type: 'text', text: { content: '' } }];
}

// ── Notion 본문 블록 생성 ──
function buildBlocks(summary, thumbUrl, v) {
  const blocks = [];
  const ytUrl = `https://www.youtube.com/watch?v=${v.videoId}`;

  blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: thumbUrl }, caption: [{ type: 'text', text: { content: v.title || '' } }] } });
  blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: '▶ 영상 보기: ' }, annotations: { bold: true } }, { type: 'text', text: { content: ytUrl, link: { url: ytUrl } }, annotations: { color: 'blue' } }] } });
  blocks.push({ object: 'block', type: 'divider', divider: {} });

  const lines = (summary || '').split('\n');
  let paraLines = [];
  const flushPara = () => {
    const text = paraLines.join('\n').trim();
    if (text) {
      // 1900자씩 나누되 ** 볼드 파싱 적용
      const richText = parseBoldRichText(text);
      // Notion rich_text 배열도 100개 제한 있으므로 50개씩 묶어 paragraph 생성
      for (let i = 0; i < richText.length; i += 50) {
        blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText.slice(i, i + 50) } });
      }
    }
    paraLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flushPara();
      blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: parseBoldRichText(line.replace(/^## /, '')) } });
    } else if (line.startsWith('# ')) {
      flushPara();
      blocks.push({ object: 'block', type: 'heading_1', heading_1: { rich_text: parseBoldRichText(line.replace(/^# /, '')) } });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      flushPara();
      blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: parseBoldRichText(line.replace(/^[-*] /, '')) } });
    } else {
      paraLines.push(line);
    }
  }
  flushPara();
  return blocks;
}

// ── Notion 저장 ──
// ── 중복 영상 조회수·구독자수 업데이트 ──
async function updateStats(pageId, viewCount, subscriberCount, uploadDate) {
  try {
    const props = {
      '조회수':   { number: viewCount || 0 },
      '구독자수': { number: subscriberCount || 0 },
    };
    if (uploadDate) props['업로드 일자'] = { date: { start: uploadDate } };
    await notionCall('PATCH', `/v1/pages/${pageId}`, { properties: props });
    return true;
  } catch { return false; }
}

async function saveToNotion(v, summary, playlistTitle) {
  const date = v.publishedAt?.split('T')[0] || null;
  const thumbUrl = v.thumbnail || `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`;

  const body = {
    parent: { database_id: CONFIG.notionDbId },
    cover: { type: 'external', external: { url: thumbUrl } },
    properties: {
      '영상 제목': { title: [{ text: { content: v.title || '' } }] },
      '요약 내용': { rich_text: splitRichText(summary || '') },
      '유튜브 채널': { rich_text: [{ text: { content: v.channelTitle || '' } }] },
      '조회수': { number: v.viewCount || 0 },
      '구독자수': { number: v.subscriberCount || 0 },
      '영상 URL': { url: `https://www.youtube.com/watch?v=${v.videoId}` },
      '썸네일 URL': { url: thumbUrl },
      '처리 상태': { select: { name: '완료' } },
      '주제': { multi_select: playlistTitle ? [{ name: playlistTitle.normalize('NFC') }] : [] },
    },
    children: buildBlocks(summary, thumbUrl, v),
  };
  if (date) body.properties['업로드 일자'] = { date: { start: date } };

  // Notion API: 페이지 생성 시 children 최대 100개 제한
  const allBlocks = body.children;
  body.children = allBlocks.slice(0, 100);

  const res = await notionCall('POST', '/v1/pages', body);
  if (res.status !== 200) throw new Error(`Notion 저장 오류 ${res.status}: ${JSON.stringify(res.data)}`);

  const pageId = res.data.id;

  // 100개 초과 블록은 appendBlocks로 추가 저장
  for (let i = 100; i < allBlocks.length; i += 100) {
    const chunk = allBlocks.slice(i, i + 100);
    const appendRes = await notionCall('PATCH', `/v1/blocks/${pageId}/children`, { children: chunk });
    if (appendRes.status !== 200) {
      log(`  ⚠️  블록 추가 저장 오류 (${i}~${i+chunk.length}): ${appendRes.status}`);
    }
  }

  return res.data;
}

// ── Notion 저장 (다중 토픽 지원) ──
async function saveToNotionWithTopics(v, summary, topics) {
  const date = v.publishedAt?.split('T')[0] || null;
  const thumbUrl = v.thumbnail || `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`;
  const nfcTopics = [...new Set((topics || []).map(t => (t || '').normalize('NFC')))].filter(Boolean);

  const body = {
    parent: { database_id: CONFIG.notionDbId },
    cover: { type: 'external', external: { url: thumbUrl } },
    properties: {
      '영상 제목': { title: [{ text: { content: v.title || '' } }] },
      '요약 내용': { rich_text: splitRichText(summary || '') },
      '유튜브 채널': { rich_text: [{ text: { content: v.channelTitle || '' } }] },
      '조회수': { number: v.viewCount || 0 },
      '구독자수': { number: v.subscriberCount || 0 },
      '영상 URL': { url: `https://www.youtube.com/watch?v=${v.videoId}` },
      '썸네일 URL': { url: thumbUrl },
      '처리 상태': { select: { name: '완료' } },
      '주제': { multi_select: nfcTopics.map(name => ({ name })) },
    },
    children: buildBlocks(summary, thumbUrl, v),
  };
  if (date) body.properties['업로드 일자'] = { date: { start: date } };

  const allBlocks = body.children;
  body.children = allBlocks.slice(0, 100);
  const res = await notionCall('POST', '/v1/pages', body);
  if (res.status !== 200) throw new Error(`Notion 저장 오류 ${res.status}: ${JSON.stringify(res.data)}`);
  const pageId = res.data.id;
  for (let i = 100; i < allBlocks.length; i += 100) {
    const chunk = allBlocks.slice(i, i + 100);
    await notionCall('PATCH', `/v1/blocks/${pageId}/children`, { children: chunk });
  }
  return res.data;
}

// ── pending_playlist_adds.json 큐 소진 ──
// 매 실행 시 quota 여유분 내에서 미처리 YouTube 재생목록 추가를 처리합니다.
async function flushPendingQueue() {
  const PENDING_PATH = path.join(__dirname, 'pending_playlist_adds.json');
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8')); } catch { return; }
  if (!queue.length) return;

  let yt;
  try { yt = require('./lib/youtube_oauth'); } catch (e) {
    log(`⚠️  flushPendingQueue: youtube_oauth 로드 실패 — ${e.message}`); return;
  }

  log(`⏳ pending 큐 처리 시작 — ${queue.length}건`);
  const remaining = [];
  let done = 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (!yt.checkQuotaAvailable(50)) {
      log(`  ⏸  quota 한도 — ${queue.length - i}건 다음 실행으로 연기`);
      remaining.push(...queue.slice(i));
      break;
    }
    try {
      await yt.addToPlaylist(item.playlistId, item.videoId);
      done++;
    } catch (e) {
      if (e.code === 'QUOTA_EXHAUSTED') {
        log(`  ⏸  quota 소진 — ${queue.length - i}건 연기`);
        remaining.push(...queue.slice(i));
        break;
      }
      // OAuth 토큰 만료 → 전체 중단, 큐 보존
      if (e.message?.includes('invalid_grant') || e.message?.includes('Token refresh failed')) {
        log(`  ❌ OAuth 오류 — 큐 처리 중단 (node oauth_setup.js 로 토큰 재발급 필요): ${e.message.slice(0, 80)}`);
        remaining.push(...queue.slice(i));
        break;
      }
      // 기타 오류: 건너뛰지 않고 큐에 유지 (다음 실행에서 재시도)
      log(`  ⚠️  실패 [${item.videoId}] ${item.topic || ''}: ${e.message.slice(0, 80)}`);
      remaining.push(item);
    }
  }

  fs.writeFileSync(PENDING_PATH, JSON.stringify(remaining, null, 2));
  log(`  ✓ pending 처리: ${done}건 추가 완료, ${remaining.length}건 잔여`);
}

// ── AI 영상목록 → 자동 분류 + Notion 저장 + 토픽 재생목록 추가 ──
async function processMasterIngest(notionCache) {
  const masterId = CONFIG.masterPlaylistId;
  if (!masterId) {
    log('⚠️  YOUTUBE_MASTER_PLAYLIST_ID 미설정 — 마스터 인제스트 건너뜀');
    return { saved: 0, skip: 0, error: 0 };
  }

  // lib 모듈 lazy-load (선택적 기능, 없어도 레거시 동작)
  let yt, classifier;
  try {
    yt = require('./lib/youtube_oauth');
    classifier = require('./lib/classifier');
  } catch (e) {
    log('⚠️  lib/youtube_oauth 또는 lib/classifier 로드 실패 — 마스터 인제스트 건너뜀: ' + e.message);
    return { saved: 0, skip: 0, error: 0 };
  }

  // playlists.json에서 토픽 → playlistId 매핑 구성
  const playlists = loadPlaylists();
  const topicToPlaylistId = {};
  for (const pl of playlists) {
    const m = pl.url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (m && pl.name) topicToPlaylistId[(pl.name || '').normalize('NFC')] = m[1];
  }
  const availableTopics = Object.keys(topicToPlaylistId);

  log(`\n▶ [AI 영상목록] 마스터 인제스트 시작...`);
  log(`  📚 분류 가능 토픽: ${availableTopics.length}개`);

  const videos = await getVideos(masterId);
  log(`  총 ${fmtNum(videos.length)}개 동영상`);
  if (!videos.length) return { saved: 0, skip: 0, error: 0 };

  log(`  🔄 YouTube 상세 정보 조회 중...`);
  const detailMap = await getBatchDetails(videos.map(v => v.videoId));

  const chCache = {};
  const uniqueChannels = [...new Set(videos.map(v => detailMap[v.videoId]?.realChannelId || v.channelId).filter(Boolean))];
  await Promise.all(uniqueChannels.map(async (chId) => { chCache[chId] = await getSubs(chId); }));

  let saved = 0, skip = 0, error = 0;
  const savedList  = [];   // [{title, topics, confidence}] — 저장된 영상 목록
  const topicStats = {};   // {topicName: count} — 주제별 저장 건수
  const skipList   = [];   // 스킵된 영상 제목 (최대 5개, 디버그용)
  const newVideos  = [];

  // ── 1단계: 중복 체크 ──
  for (const v of videos) {
    const det = detailMap[v.videoId];
    if (det) {
      v.viewCount = det.viewCount; v.description = det.description; v.tags = det.tags;
      if (det.realChannelTitle) v.channelTitle = det.realChannelTitle;
      if (det.realChannelId)    v.channelId    = det.realChannelId;
      if (det.realPublishedAt)  v.publishedAt  = det.realPublishedAt;
    }
    v.subscriberCount = chCache[v.channelId] || 0;

    const dup = findDuplicate(v, notionCache);
    if (dup) {
      if (skipList.length < 5) skipList.push(v.title || '(제목 없음)');
      skip++;
      log(`  ⏭ Skip (이미 저장됨): ${v.title?.slice(0, 50)}`);
      // 결과 테이블용 구조화 데이터 (server.js → index.html 전달)
      console.log('RESULT_ROW:' + JSON.stringify({
        videoId: v.videoId, title: v.title, channelTitle: v.channelTitle,
        publishedAt: v.publishedAt, viewCount: v.viewCount, subscriberCount: v.subscriberCount,
        summary: null, topics: [], status: 'skip',
      }));
    } else {
      newVideos.push(v);
    }
  }

  if (!newVideos.length) {
    log('  ✓ 신규 영상 없음');
    return { saved, skip, error, savedList, topicStats, skipList, totalInPlaylist: videos.length };
  }

  // ── 2단계: 신규 영상 — 요약 + 분류 + 저장 + YouTube 추가 ──
  const MAX_NEW_PER_RUN = 15;
  const processList = newVideos.slice(0, MAX_NEW_PER_RUN);
  if (newVideos.length > MAX_NEW_PER_RUN) {
    log(`\n  ⚠️ 신규 영상이 너무 많습니다 (${newVideos.length}개). 할당량 보호를 위해 상위 ${MAX_NEW_PER_RUN}개만 먼저 처리합니다.`);
  }

  log(`\n  ⚡ 신규 ${processList.length}개 처리 시작...`);
  const PARALLEL = 1;

  for (let i = 0; i < processList.length; i += PARALLEL) {
    const batch = processList.slice(i, i + PARALLEL);
    log(`  ⚡ [${i+1}~${Math.min(i+PARALLEL, processList.length)}/${processList.length}] 병렬 요약 중...`);

    const summaryResults = await Promise.allSettled(batch.map(v => geminiSummarize(v)));
    
    // API 호출 간격 확보 (2초 대기)
    await new Promise(r => setTimeout(r, 2000));

    for (let j = 0; j < batch.length; j++) {
      const v = batch[j];
      const sRes = summaryResults[j];
      try {
        if (sRes.status === 'rejected') throw new Error(sRes.reason?.message || '요약 실패');
        const summary = sRes.value;

        // 분류 (현재 활성화된 로테이션된 API Key 주입)
        let cls;
        const keysCount = CONFIG.geminiApiKeys.length;
        const maxClsAttempts = Math.max(3, keysCount * 2);
        let clsAttempt = 0;

        while (clsAttempt < maxClsAttempts) {
          try {
            cls = await classifier.classifyTopics(
              { summary, title: v.title, channel: v.channelTitle },
              availableTopics,
              { geminiApiKey: getActiveGeminiKey(), maxRetries: 0 }
            );
            break;
          } catch (clsErr) {
            clsAttempt++;
            if ((clsErr.message.includes('429') || clsErr.message.includes('Quota') || clsErr.message.includes('quota')) && keysCount > 1) {
              const currentKey = getActiveGeminiKey();
              const maskedKey = currentKey ? `${currentKey.slice(0, 8)}...${currentKey.slice(-6)}` : '없음';
              log(`    ⏳ [분류 Rate Limit] 에러 발생 (Key: ${maskedKey}). API Key 교체 후 재시도... (시도: ${clsAttempt}/${maxClsAttempts})`);
              rotateGeminiKey();
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }
            throw clsErr;
          }
        }
        const topics = cls.topics;  // 분류된 토픽들
        const allTopics = [...topics];  // 분류 토픽만 (AI 영상목록은 재생목록이지 주제 태그 아님)

        const confStr = `conf=${cls.confidence.toFixed(2)}`;
        log(`    🏷  분류: [${topics.join(', ')}] (${confStr})`);
        if (cls.droppedTopics?.length) {
          log(`    ⚠️  droppedTopics (allowedSet 불일치): [${cls.droppedTopics.join(', ')}]`);
        }
        if (cls.confidence < 0.6) {
          log(`    ⚠️  신뢰도 낮음 — 주제 저장은 하되 수동 검토 권장`);
        }

        // Notion 저장
        const notionPage = await saveToNotionWithTopics(v, summary, allTopics);
        const pageId = notionPage.id;
        log(`    ✓ Notion 저장 완료 (주제: ${allTopics.join(', ') || '(분류 없음)'})`);
        // 결과 테이블용 구조화 데이터 (server.js → index.html 전달)
        console.log('RESULT_ROW:' + JSON.stringify({
          videoId: v.videoId, title: v.title, channelTitle: v.channelTitle,
          publishedAt: v.publishedAt, viewCount: v.viewCount, subscriberCount: v.subscriberCount,
          summary: summary?.slice(0, 200) || '', topics: allTopics, status: 'ok',
        }));

        // notionCache 갱신
        notionCache.set(v.videoId || v.title, {
          pageId, title: v.title, topics: allTopics,
          savedViewCount: v.viewCount, savedSubscribers: v.subscriberCount,
          savedDate: v.publishedAt?.split('T')[0] || null,
        });

        // 저장 통계 수집
        savedList.push({ title: v.title, topics: allTopics, confidence: cls.confidence });
        for (const t of topics) {
          topicStats[t] = (topicStats[t] || 0) + 1;
        }

        // YouTube 토픽 재생목록에 추가 (신뢰도 0.6+)
        if (cls.confidence >= 0.6 && topics.length > 0) {
          // pending 큐 헬퍼 (migrate_classify.js와 동일한 파일 공유)
          const PENDING_PATH = path.join(__dirname, 'pending_playlist_adds.json');
          const appendPending = (entry) => {
            let q = [];
            try { q = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8')); } catch {}
            q.push({ ...entry, ts: new Date().toISOString() });
            fs.writeFileSync(PENDING_PATH, JSON.stringify(q, null, 2));
          };

          for (const topic of topics) {
            const pid = topicToPlaylistId[topic];
            if (!pid) continue;
            try {
              if (!yt.checkQuotaAvailable(50)) {
                log(`    ⏸  YouTube quota 한도 — [${topic}] 보류 (pending 큐 적재)`);
                appendPending({ playlistId: pid, topic, videoId: v.videoId, title: v.title });
                continue;
              }
              await yt.addToPlaylist(pid, v.videoId);
              log(`    ✓ YouTube [${topic}] 재생목록 추가`);
            } catch (ytErr) {
              log(`    ⚠️  YouTube [${topic}] 추가 실패: ${ytErr.message?.slice(0, 80)}`);
              appendPending({ playlistId: pid, topic, videoId: v.videoId, title: v.title, reason: ytErr.message });
            }
          }
        }

        saved++;
      } catch (e) {
        log(`    ❌ 오류 (${v.title?.slice(0, 30)}): ${e.message}`);
        error++;
        // 결과 테이블용 구조화 데이터 (오류)
        console.log('RESULT_ROW:' + JSON.stringify({
          videoId: v.videoId, title: v.title, channelTitle: v.channelTitle,
          publishedAt: v.publishedAt, viewCount: v.viewCount, subscriberCount: v.subscriberCount,
          summary: `오류: ${e.message}`, topics: [], status: 'error',
        }));
      }
    }
    if (i + PARALLEL < newVideos.length) await new Promise(r => setTimeout(r, 300));
  }

  return { saved, skip, error, savedList, topicStats, skipList, totalInPlaylist: videos.length };
}

// ── 재생목록 하나 처리 ──
async function processPlaylist(pl, notionCache) {
  const m = pl.url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (!m) { log(`⚠️  URL 형식 오류: ${pl.url}`); return { saved: 0, skip: 0, error: 0 }; }
  const listId = m[1];

  log(`\n▶ [${pl.name}] 재생목록 조회 중...`);
  // YouTube API 제목 대신 playlists.json의 name 사용 (이모지 깨짐 방지)
  const playlistTitle = (pl.name || '').normalize('NFC');
  log(`  재생목록명: "${playlistTitle}"`);

  const videos = await getVideos(listId);
  log(`  총 ${fmtNum(videos.length)}개 동영상`);

  // ── ① YouTube 상세 정보 배치 조회 (50개씩, API 호출 대폭 감소) ──
  log(`  🔄 YouTube 상세 정보 배치 조회 중...`);
  const detailMap = await getBatchDetails(videos.map(v => v.videoId));

  // ── 채널 구독자수 병렬 조회 (채널별 1회만) ──
  const chCache = {};
  const uniqueChannels = [...new Set(
    videos.map(v => detailMap[v.videoId]?.realChannelId || v.channelId).filter(Boolean)
  )];
  log(`  🔄 채널 구독자수 조회 중... (${uniqueChannels.length}개 채널)`);
  await Promise.all(uniqueChannels.map(async (chId) => {
    chCache[chId] = await getSubs(chId);
  }));

  let saved = 0, skip = 0, error = 0;

  // ── 1단계: 모든 영상 순회 → Skip/업데이트 처리 + 신규 영상 수집 ──
  const newVideos = [];
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const det = detailMap[v.videoId];
    if (det) {
      v.viewCount = det.viewCount; v.description = det.description; v.tags = det.tags;
      if (det.realChannelTitle) v.channelTitle = det.realChannelTitle;
      if (det.realChannelId)    v.channelId    = det.realChannelId;
      if (det.realPublishedAt)  v.publishedAt  = det.realPublishedAt;
    }
    v.subscriberCount = chCache[v.channelId] || 0;

    log(`  [${i+1}/${videos.length}] ${v.title}`);
    const dup = findDuplicate(v, notionCache);
    if (dup) {
      // ← API 호출 전에 미리 체크 (불필요한 Notion API 호출 차단)
      const needTopicAdd = !dup.topics.includes(playlistTitle);
      const topicAdded = needTopicAdd
        ? await addTopicToPage(dup.pageId, playlistTitle, dup.topics)
        : false;
      if (topicAdded) dup.topics.push(playlistTitle);
      const newViewCount = v.viewCount || 0;
      const newSubscribers = v.subscriberCount || 0;  // 숫자로 통일
      const newDate = v.publishedAt?.split('T')[0] || null;
      // 조회수: savedView가 null/0이면 최초 채움, 그 외 15% 이상 변화 시만 업데이트
      const savedView = dup.savedViewCount ?? null;
      const viewChanged = newViewCount > 0 && (
        savedView === null || savedView === 0
          ? true
          : Math.abs(newViewCount - savedView) / savedView >= 0.15
      );
      // 구독자수: 동일 로직
      const savedSubs = dup.savedSubscribers ?? null;
      const subsChanged = newSubscribers > 0 && (
        savedSubs === null || savedSubs === 0
          ? true
          : Math.abs(newSubscribers - savedSubs) / savedSubs >= 0.15
      );
      const dateChanged = newDate && dup.savedDate && dup.savedDate !== newDate;
      if (viewChanged || subsChanged || dateChanged) {
        await updateStats(dup.pageId, newViewCount, newSubscribers, dateChanged ? newDate : null);
        dup.savedViewCount = newViewCount;
        dup.savedSubscribers = newSubscribers;
        if (dateChanged) dup.savedDate = newDate;
        const ch = [];
        if (viewChanged) ch.push('조회수 ' + (savedView||0).toLocaleString() + '->' + newViewCount.toLocaleString());
        if (subsChanged) ch.push('구독자 ' + savedSubs.toLocaleString() + '->' + newSubscribers.toLocaleString());
        if (dateChanged) ch.push('업로드일 ->' + newDate);
        log('    🔄 통계 업데이트: ' + ch.join(' / '));
      } else if (topicAdded) {
        log('    ⏭ 중복 — 주제 "' + playlistTitle + '" 추가 후 Skip');
      } else {
        log('    ⏭ Skip (변경사항 없음)');
      }
      skip++;
    } else {
      log('    → 신규 영상');
      newVideos.push(v);
    }
  }

  // ── 2단계: 신규 영상 3개씩 병렬 Gemini 요약 → Notion 저장 ──
  const PARALLEL = 1; // 순차 처리로 변경
  if (newVideos.length > 0) {
    log('\n  ⚡ 신규 ' + newVideos.length + '개 Gemini 병렬 요약 시작 (3개씩 동시)...');
  }
  for (let i = 0; i < newVideos.length; i += PARALLEL) {
    const batch = newVideos.slice(i, i + PARALLEL);
    log('  ⚡ [' + (i+1) + '~' + Math.min(i+PARALLEL, newVideos.length) + '/' + newVideos.length + '] 병렬 요약 중...');
    const results = await Promise.allSettled(batch.map(v => geminiSummarize(v)));
    
    // API 호출 간격 확보 (2초 대기)
    await new Promise(r => setTimeout(r, 2000));
    for (let j = 0; j < batch.length; j++) {
      const v = batch[j];
      const res = results[j];
      try {
        if (res.status === 'rejected') throw new Error(res.reason?.message || '요약 실패');
        const summary = res.value;
        log('    ✓ 요약 완료 (' + summary.length + '자): ' + v.title.slice(0,30));
        await saveToNotion(v, summary, playlistTitle);
        const cacheKey = v.videoId || v.title;
        notionCache.set(cacheKey, {
          pageId: 'new', title: v.title, topics: [playlistTitle],
          savedViewCount: v.viewCount, savedSubscribers: v.subscriberCount,
          savedDate: v.publishedAt?.split('T')[0] || null,
        });
        log('    ✓ Notion 저장 완료');
        saved++;
      } catch(e) {
        log('    ❌ 오류: ' + e.message);
        error++;
      }
    }
    if (i + PARALLEL < newVideos.length) await new Promise(r => setTimeout(r, 300));
  }
  return { saved, skip, error };
}

// ══════════════════════════════════
// ── 메인 실행 ──
// ══════════════════════════════════
// ── 유동적 구분선 생성 (내용 길이 기준) ──
// ═ 는 터미널에서 2칸 폭 전각문자, 타임스탬프는 약 14칸
// 가장 긴 내용 줄 길이에 맞춰 구분선 자동 계산
function makeLine(...texts) {
  // 각 텍스트의 시각적 너비 계산 (한글/CJK=2칸, 나머지=1칸)
  const visualLen = (str) => {
    let w = 0;
    for (const ch of str) {
      const code = ch.codePointAt(0);
      w += (code > 0x2E00) ? 2 : 1;
    }
    return w;
  };
  // ─ 는 1칸짜리 문자 → 가장 긴 텍스트 너비만큼 생성
  const maxLen = Math.max(...texts.map(t => visualLen(t)));
  return '─'.repeat(maxLen + 2); // 터미널 폰트 렌더링 여백 보정 +2
}

// ── 숫자 천단위 콤마 포맷 ──
function fmtNum(n) {
  return Number(n).toLocaleString('ko-KR');
}

// ── 소요시간 포맷 (분 단위, 60분 이상이면 시간+분) ──
function formatElapsed(ms) {
  const totalMin = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  if (totalMin < 60) {
    return totalMin > 0 ? `${String(totalMin).padStart(2,'0')}분 ${String(sec).padStart(2,'0')}초` : `${String(sec).padStart(2,'0')}초`;
  }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2,'0')}시간 ${String(m).padStart(2,'0')}분`;
}

async function main() {
  log('');
  const startTime = Date.now();
  const titleLine = makeLine('  YouTube → Notion 자동 요약 스케줄러 시작');
  log(titleLine);
  log('  YouTube → Notion 자동 요약 스케줄러 시작');
  log(titleLine);

  // 설정값 검증
  if (CONFIG.youtubeApiKey === 'YOUR_YOUTUBE_API_KEY') {
    log('❌ scheduler.js 의 CONFIG 설정값을 채워주세요!'); process.exit(1);
  }

  const playlists = loadPlaylists();
  const LEGACY_MODE = process.argv.includes('--legacy');
  const useMasterMode = CONFIG.masterPlaylistId && !LEGACY_MODE;

  if (!playlists.length && !useMasterMode) {
    log('⚠️  처리할 재생목록이 없습니다. 브라우저에서 먼저 등록하세요.');
    process.exit(0);
  }

  if (useMasterMode) {
    log(`🆕 마스터 인제스트 모드 — "AI 영상목록" 기반 자동 분류`);
    log(`   (레거시 33개 재생목록 모드: node scheduler.js --legacy)`);
  } else {
    log(`📋 레거시 모드 — 총 ${playlists.length}개 재생목록 처리`);
  }

  // ── Notion DB 전체 캐시 로드 ──
  const notionCache = await loadNotionCache();

  // ── pending 큐 소진 (quota 여유분 내에서) ──
  await flushPendingQueue();

  let totalSaved = 0, totalSkip = 0, totalError = 0;
  const results = [];

  if (useMasterMode) {
    // ── 신규 워크플로: AI 영상목록 → 자동 분류 ──
    try {
      const result = await processMasterIngest(notionCache);
      totalSaved += result.saved;
      totalSkip += result.skip;
      totalError += result.error;
      results.push({ name: 'AI 영상목록 (마스터)', ...result });
    } catch (e) {
      const errMsg = e instanceof Error ? (e.stack || e.message) : String(e);
      log(`❌ 마스터 인제스트 오류:\n${errMsg}`);
      totalError += 1;
      results.push({ name: 'AI 영상목록 (마스터)', saved: 0, skip: 0, error: 1 });
    }
  } else {
    // ── 레거시 워크플로: 33개 토픽 재생목록 순회 ──
    for (let i = 0; i < playlists.length; i++) {
      const pl = playlists[i];
      log(`\n━━━ [${i+1}/${playlists.length}] ${pl.name} ━━━`);
      try {
        const result = await processPlaylist(pl, notionCache);
        totalSaved += result.saved;
        totalSkip += result.skip;
        totalError += result.error;
        results.push({ name: pl.name, ...result });
      } catch (e) {
        const errMsg = e instanceof Error ? (e.stack || e.message) : String(e);
        log(`❌ 재생목록 처리 중 오류:\n${errMsg}`);
        totalError += 1;
        results.push({ name: pl.name, saved: 0, skip: 0, error: 1 });
      }
    }
  }

  log('');
  const line1 = `  완료! 저장: ${fmtNum(totalSaved)}개 / Skip: ${fmtNum(totalSkip)}개 / 오류: ${fmtNum(totalError)}개`;
  const line2 = `  소요시간: ${formatElapsed(Date.now() - startTime)}`;
  const finishLine = makeLine(line1, line2);
  log(finishLine);
  log(line1);
  log(line2);
  log(finishLine);

  // ── 전체 완료 알림 전송 ──
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // 마스터 모드: 주제별 분류 / 저장 영상 목록 포함한 상세 메시지
  let summaryLines;
  if (useMasterMode && results.length > 0) {
    const r = results[0];
    const inPlaylist = r.totalInPlaylist ?? (r.saved + r.skip + r.error);
    const lines = [];

    if (r.saved > 0) {
      lines.push(`• AI 영상목록 (마스터): 재생목록 ${fmtNum(inPlaylist)}개 | 신규 저장 ${fmtNum(r.saved)}개 | 스킵 ${fmtNum(r.skip)}개`);

      // 주제별 저장 건수
      const topicEntries = Object.entries(r.topicStats || {}).sort((a, b) => b[1] - a[1]);
      if (topicEntries.length) {
        lines.push(`  🏷 주제별: ${topicEntries.map(([t, c]) => `${t}(${c})`).join(', ')}`);
      }
    } else {
      lines.push(`• AI 영상목록 (마스터): 재생목록 ${fmtNum(inPlaylist)}개 | 신규 없음`);
      lines.push(`  ℹ️ ${fmtNum(r.skip)}개 모두 이미 Notion에 저장된 영상`);
      // 스킵 예시 (최대 2개 — 실제로 어떤 영상인지 파악용)
      const samples = (r.skipList || []).slice(0, 2).map(t => t.slice(0, 25));
      if (samples.length) {
        lines.push(`  예) ${samples.map(t => `"${t}"`).join(', ')} …`);
      }
    }
    if (r.error > 0) lines.push(`  ❌ 오류 ${fmtNum(r.error)}개`);
    summaryLines = lines.join('\n');
  } else {
    // 레거시 모드: 기존 형식
    summaryLines = results.map(r =>
      `• ${r.name}: 저장 ${fmtNum(r.saved)}/ 스킵 ${fmtNum(r.skip)}/ 오류 ${fmtNum(r.error)}`
    ).join('\n');
  }
  const elapsed = formatElapsed(Date.now() - startTime);
  const totalLine = useMasterMode
    ? `📊 합계: 신규 저장 ${fmtNum(totalSaved)}개 | 스킵 ${fmtNum(totalSkip)}개 | 오류 ${fmtNum(totalError)}개`
    : `📊 합계: 저장 ${fmtNum(totalSaved)}/ 스킵 ${fmtNum(totalSkip)}/ 오류 ${fmtNum(totalError)}`;

  const msg = [
    `🎬 YouTube → Notion 요약 완료`,
    `📅 ${now}`,
    `⏱ 소요시간: ${elapsed}`,
    ``,
    summaryLines,
    ``,
    totalLine,
  ].join('\n');

  await sendEmail(`[YouTube 요약] 완료 - 저장 ${totalSaved}개`, msg);

  // ── Obsidian 동기화 (항상 실행 - 노션+Obsidian 결과 합쳐서 1개 메시지 전송) ──
  log('\n🔄 Obsidian 동기화 시작...');
  const { execFile } = require('child_process');
  const python3 = '/opt/homebrew/bin/python3';
  const syncScript = path.join(__dirname, 'sync_obsidian.py');
  const syncArgs = totalSaved > 0 ? [syncScript] : [syncScript, '--rebuild'];
  execFile(python3, syncArgs, { cwd: __dirname }, async (err, stdout, stderr) => {
    if (err) {
      log(`❌ Obsidian 동기화 오류: ${err.message}`);
      if (totalSaved > 0) {
        await sendTelegram(msg + `\n\n⚠️ Obsidian 동기화 실패`);
      }
      return;
    }
    const jsonLine = stdout.split('\n').find(l => l.startsWith('RESULT_JSON:'));
    if (jsonLine) {
      try {
        const r = JSON.parse(jsonLine.replace('RESULT_JSON:', ''));
        const obsSection = [
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━`,
          `📓 Obsidian AI LLM Wiki`,
          `  • 신규 추가: ${r.added}개`,
          ...(r.tags_updated > 0 ? [`  • tags 갱신: ${r.tags_updated}개`] : []),
          `  • Wiki 재구성: ${r.rebuilt ? '✅ 완료' : '⏭ 생략'}`,
          `  • 소요시간: ${r.elapsed}초`,
        ].join('\n');
        log(`✅ Obsidian 동기화 완료! 추가: ${r.added}개`);

        const hasNewOrUpdated = totalSaved > 0 || (r.added && r.added > 0) || (r.tags_updated && r.tags_updated > 0);
        if (hasNewOrUpdated) {
          await sendTelegram(msg + obsSection);
        } else {
          log(`ℹ️  신규 저장/업데이트된 동영상이 없으므로 텔레그램 메시지 발송 생략`);
        }
      } catch(e) {
        log(`⚠️ Obsidian 결과 파싱 오류: ${e.message}`);
        if (totalSaved > 0) {
          await sendTelegram(msg);
        }
      }
    } else {
      if (totalSaved > 0) {
        await sendTelegram(msg);
      }
    }
  });
}

main().catch(e => {
  log(`❌ 치명적 오류: ${e.message}`);
  process.exit(1);
});
