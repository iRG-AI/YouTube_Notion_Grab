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

const CONFIG = {
  youtubeApiKey:  process.env.YOUTUBE_API_KEY  || '',
  geminiApiKey:   process.env.GEMINI_API_KEY   || '',
  notionToken:    process.env.NOTION_TOKEN      || '',
  notionDbId:     process.env.NOTION_DB_ID      || '',

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
// ── Gemini 요약 ──
async function geminiSummarize(v) {
  const prompt = `당신은 YouTube 영상 콘텐츠를 분석하는 전문 리서처입니다.
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

  const res = await httpsRequest({
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${CONFIG.geminiApiKey}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
  });

  if (res.status !== 200) throw new Error(`Gemini 오류 ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '요약 불가';
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
  const cache = new Map(); // title → { pageId, topics, savedViewCount, savedSubscribers, savedDate }
  let cursor = undefined;
  let total = 0;
  log('  📦 Notion DB 캐시 로딩 중...');
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionCall('POST', `/v1/databases/${CONFIG.notionDbId}/query`, body);
    if (res.status !== 200) break;
    for (const page of (res.data?.results || [])) {
      const props = page.properties || {};
      const title = (props['영상 제목']?.title || []).map(t => t.text?.content || '').join(''); // 전체 rich_text 조각 합산
      if (!title) continue;
      // 같은 제목이 이미 있으면 덮어씌우지 않음 (먼저 저장된 것 우선)
      if (!cache.has(title)) {
        cache.set(title, {
          pageId:           page.id,
          topics:           (props['주제']?.multi_select || []).map(t => t.name),
          savedViewCount:   props['조회수']?.number ?? null,
          savedSubscribers: props['구독자수']?.number ?? null,
          savedDate:        props['업로드 일자']?.date?.start ?? null,
        });
      }
    }
    total += res.data?.results?.length || 0;
    cursor = res.data?.next_cursor;
  } while (cursor);
  log(`  ✓ Notion DB 캐시 완료: ${total}개 페이지 로드`);
  return cache;
}

// ── 중복 체크 (캐시에서 조회) ──
function findDuplicate(title, cache) {
  return cache.get(title) || null;
}

// ── 기존 페이지에 주제(재생목록) 추가 ──
async function addTopicToPage(pageId, newTopic, existingTopics) {
  if (existingTopics.includes(newTopic)) return false;
  const allTopics = [...existingTopics, newTopic];
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
      '주제': { multi_select: playlistTitle ? [{ name: playlistTitle }] : [] },
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

// ── 재생목록 하나 처리 ──
async function processPlaylist(pl, notionCache) {
  const m = pl.url.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (!m) { log(`⚠️  URL 형식 오류: ${pl.url}`); return { saved: 0, skip: 0, error: 0 }; }
  const listId = m[1];

  log(`\n▶ [${pl.name}] 재생목록 조회 중...`);
  const playlistTitle = await getPlaylistTitle(listId);
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
    const dup = findDuplicate(v.title, notionCache);
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
      // 조회수: savedView가 있을 때만, 10% 이상 변화 시만 업데이트
      const savedView = dup.savedViewCount || 0;
      const viewChanged = savedView > 0 && newViewCount > 0
        && Math.abs(newViewCount - savedView) / savedView >= 0.1;
      // 구독자수: 숫자 비교 (타입 통일)
      const savedSubs = dup.savedSubscribers || 0;
      const subsChanged = savedSubs > 0 && newSubscribers > 0 && savedSubs !== newSubscribers;
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
  const PARALLEL = 3;
  if (newVideos.length > 0) {
    log('\n  ⚡ 신규 ' + newVideos.length + '개 Gemini 병렬 요약 시작 (3개씩 동시)...');
  }
  for (let i = 0; i < newVideos.length; i += PARALLEL) {
    const batch = newVideos.slice(i, i + PARALLEL);
    log('  ⚡ [' + (i+1) + '~' + Math.min(i+PARALLEL, newVideos.length) + '/' + newVideos.length + '] 병렬 요약 중...');
    const results = await Promise.allSettled(batch.map(v => geminiSummarize(v)));
    for (let j = 0; j < batch.length; j++) {
      const v = batch[j];
      const res = results[j];
      try {
        if (res.status === 'rejected') throw new Error(res.reason?.message || '요약 실패');
        const summary = res.value;
        log('    ✓ 요약 완료 (' + summary.length + '자): ' + v.title.slice(0,30));
        await saveToNotion(v, summary, playlistTitle);
        notionCache.set(v.title, {
          pageId: 'new', topics: [playlistTitle],
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
  if (!playlists.length) {
    log('⚠️  처리할 재생목록이 없습니다. 브라우저에서 먼저 등록하세요.');
    process.exit(0);
  }

  log(`📋 총 ${playlists.length}개 재생목록 처리 시작`);

  // ── Notion DB 전체 캐시 로드 (API 호출 대폭 감소) ──
  const notionCache = await loadNotionCache();

  let totalSaved = 0, totalSkip = 0, totalError = 0;
  const results = [];  // 재생목록별 결과 (알림용)

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
      log(`❌ 재생목록 처리 중 오류: ${e.message}`);
      results.push({ name: pl.name, saved: 0, skip: 0, error: 1 });
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
  const summaryLines = results.map(r =>
    `• [${r.name}] 저장: ${fmtNum(r.saved)}개 / Skip: ${fmtNum(r.skip)}개 / 오류: ${fmtNum(r.error)}개`
  ).join('\n');
  const elapsed = formatElapsed(Date.now() - startTime);
  const msg = [
    `🎬 YouTube → Notion 요약 완료`,
    `📅 ${now}`,
    `⏱ 소요시간: ${elapsed}`,
    ``,
    summaryLines,
    ``,
    `📊 전체 합계: 저장 ${fmtNum(totalSaved)}개 / Skip ${fmtNum(totalSkip)}개 / 오류 ${fmtNum(totalError)}개`,
  ].join('\n');

  await sendTelegram(msg);
  await sendEmail(`[YouTube 요약] 완료 - 저장 ${totalSaved}개`, msg);
}

main().catch(e => {
  log(`❌ 치명적 오류: ${e.message}`);
  process.exit(1);
});
