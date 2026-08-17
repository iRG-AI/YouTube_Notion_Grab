// ===== YouTube OAuth + Playlist Write API =====
// 책임:
//   - refresh_token → access_token 갱신 (50분 메모리 캐시)
//   - playlistItems.insert / list 호출
//   - 일일 quota 추적 (.quota_state.json), 임계 도달 시 자동 throttle
//   - 호출 간 200ms rate limit
//
// 사용 예:
//   const yt = require('./lib/youtube_oauth');
//   await yt.addToPlaylist(playlistId, videoId);

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── .env 로드 (lib에서 self-load: scheduler/migrate 양쪽 호환) ──
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) throw new Error('.env not found');
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}
const env = loadEnv();
const CLIENT_ID = env.YOUTUBE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = env.YOUTUBE_OAUTH_CLIENT_SECRET;
const REFRESH_TOKEN = env.YOUTUBE_OAUTH_REFRESH_TOKEN;

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.warn('⚠️  YouTube OAuth 자격증명 미설정 — addToPlaylist 호출 시 실패함');
}

// ── Quota 추적 ──
const QUOTA_STATE_PATH = path.join(__dirname, '..', '.quota_state.json');
const DAILY_QUOTA_LIMIT = 10000;
const DAILY_QUOTA_BUFFER = 500;     // 안전 버퍼
const QUOTA_THRESHOLD = DAILY_QUOTA_LIMIT - DAILY_QUOTA_BUFFER;  // 9500

function todayKey() {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD (UTC)
}

function loadQuotaState() {
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_STATE_PATH, 'utf-8'));
    if (j.date !== todayKey()) return { date: todayKey(), used: 0 };
    return j;
  } catch { return { date: todayKey(), used: 0 }; }
}

function saveQuotaState(state) {
  fs.writeFileSync(QUOTA_STATE_PATH, JSON.stringify(state, null, 2));
}

function consumeQuota(units) {
  const s = loadQuotaState();
  s.used += units;
  saveQuotaState(s);
  return s;
}

function checkQuotaAvailable(units) {
  const s = loadQuotaState();
  return (s.used + units) <= QUOTA_THRESHOLD;
}

function getQuotaUsed() { return loadQuotaState().used; }

// ── access_token 캐시 ──
let cachedToken = null;
let cachedTokenExp = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExp) return cachedToken;

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(chunks);
          if (res.statusCode !== 200 || !j.access_token) {
            return reject(new Error(`Token refresh failed: ${res.statusCode} ${chunks}`));
          }
          cachedToken = j.access_token;
          cachedTokenExp = Date.now() + (j.expires_in - 600) * 1000;  // 10분 마진
          resolve(cachedToken);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Rate limit ──
let lastCallAt = 0;
const RATE_LIMIT_MS = 200;
async function throttle() {
  const wait = lastCallAt + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

// ── HTTPS 요청 헬퍼 ──
function ytFetch(method, urlPath, body, accessToken) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: chunks ? JSON.parse(chunks) : null });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── 재생목록의 모든 videoId 조회 (중복 체크용) ──
//   read 비용: 1 unit/page × 페이지 수
async function listPlaylistItems(playlistId) {
  const token = await getAccessToken();
  const videoIds = new Set();
  const itemMap = new Map();   // videoId → playlistItemId (제거 시 필요)
  let pageToken = '';

  do {
    if (!checkQuotaAvailable(1)) throw new Error('QUOTA_EXHAUSTED');
    await throttle();
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await ytFetch('GET', `/youtube/v3/playlistItems?${params}`, null, token);
    consumeQuota(1);

    if (res.status !== 200) throw new Error(`listPlaylistItems failed: ${res.status} ${JSON.stringify(res.data)}`);
    for (const item of res.data.items || []) {
      const vid = item.contentDetails?.videoId;
      if (vid) {
        videoIds.add(vid);
        itemMap.set(vid, item.id);
      }
    }
    pageToken = res.data.nextPageToken || '';
  } while (pageToken);

  return { videoIds, itemMap };
}

// ── 영상을 재생목록에 추가 ──
//   write 비용: 50 units/call
//   skipIfExists=true 면 중복 체크 후 skip (그러나 list 비용 들어 caller 에서 캐싱 권장)
async function addToPlaylist(playlistId, videoId, opts = {}) {
  if (!checkQuotaAvailable(50)) {
    const err = new Error('QUOTA_EXHAUSTED');
    err.code = 'QUOTA_EXHAUSTED';
    throw err;
  }
  const token = await getAccessToken();
  await throttle();

  const res = await ytFetch('POST', '/youtube/v3/playlistItems?part=snippet', {
    snippet: {
      playlistId,
      resourceId: { kind: 'youtube#video', videoId },
    },
  }, token);

  if (res.status === 200 || res.status === 201) {
    consumeQuota(50);
    return { ok: true, item: res.data };
  }

  // 흔한 오류:
  //   404 videoNotFound — 비공개/삭제된 영상
  //   403 quotaExceeded — 일일 한도 초과
  //   409 conflict — 이미 추가되어 있음 (drop)
  // 실패한 요청도 YouTube quota를 동일하게 소비한다.
  // 성공 시에만 계산하면 .quota_state.json 이 0에 머무른 채 실제 한도를 초과한다.
  consumeQuota(50);

  const errReason = res.data?.error?.errors?.[0]?.reason;
  const err = new Error(`addToPlaylist failed: ${res.status} ${errReason || ''} ${JSON.stringify(res.data).slice(0, 300)}`);
  err.status = res.status;
  err.reason = errReason;
  if (errReason === 'quotaExceeded') err.code = 'QUOTA_EXHAUSTED';
  throw err;
}

module.exports = {
  getAccessToken,
  listPlaylistItems,
  addToPlaylist,
  getQuotaUsed,
  checkQuotaAvailable,
  consumeQuota,
  loadQuotaState,
};
