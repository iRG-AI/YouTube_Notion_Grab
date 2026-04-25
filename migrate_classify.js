#!/usr/bin/env node
// ===== 일회성 마이그레이션: Notion 기존 영상 → 자동 분류 + 재생목록 추가 =====
// 동작:
//   1. Notion DB 전체 페이지 조회 (페이지네이션)
//   2. 각 페이지의 요약 본문(blocks)을 Gemini 로 재분석 → 적합한 토픽(주제) 1~3개 추천
//   3. 기존 주제 ∪ 추천 주제 (NFC) → Notion PATCH
//   4. 추천 토픽 + "AI 영상목록" 마스터 재생목록에 영상 추가 (OAuth)
//   5. .migrate_state.json 으로 재개 가능, .quota_state.json 으로 일일 quota 추적
//
// 사용:
//   node migrate_classify.js --dry-run [--limit=20]   # 분류만, CSV 출력
//   node migrate_classify.js --apply [--daily-quota=9500] [--limit=N]  # 실제 적용
//   node migrate_classify.js --apply --resume          # state file 부터 재개
//   node migrate_classify.js --reset-state             # state 초기화

const fs = require('fs');
const path = require('path');
const https = require('https');

const yt = require('./lib/youtube_oauth');
const { classifyTopics } = require('./lib/classifier');

// ── CLI 파싱 ──
const argv = process.argv.slice(2);
const arg = (k, def) => {
  const m = argv.find(a => a === k || a.startsWith(`${k}=`));
  if (!m) return def;
  if (m === k) return true;
  return m.split('=')[1];
};
const DRY_RUN = arg('--dry-run', false);
const APPLY = arg('--apply', false);
const NOTION_ONLY = arg('--notion-only', false);  // Notion 태그만 업데이트, YouTube insert 없이
const YOUTUBE_ONLY = arg('--youtube-only', false); // YouTube 추가만, Notion 업데이트 없이
const RESUME = arg('--resume', false);
const RESET_STATE = arg('--reset-state', false);
const LIMIT = parseInt(arg('--limit', 0), 10) || 0;
const DAILY_QUOTA_CAP = parseInt(arg('--daily-quota', 9500), 10);

if (!DRY_RUN && !APPLY && !NOTION_ONLY && !YOUTUBE_ONLY && !RESET_STATE) {
  console.error('사용: node migrate_classify.js (--dry-run | --apply | --notion-only | --youtube-only | --reset-state) [--limit=N] [--daily-quota=N] [--resume]');
  process.exit(1);
}

// ── 환경변수 ──
function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}
const env = loadEnv();
const NOTION_TOKEN = env.NOTION_TOKEN;
const NOTION_DB_ID = env.NOTION_DB_ID;
const MASTER_PLAYLIST_ID = env.YOUTUBE_MASTER_PLAYLIST_ID;

if (!NOTION_TOKEN || !NOTION_DB_ID) {
  console.error('❌ NOTION_TOKEN/NOTION_DB_ID 누락'); process.exit(1);
}
if (APPLY && !MASTER_PLAYLIST_ID) {
  console.error('❌ YOUTUBE_MASTER_PLAYLIST_ID 누락 (.env)'); process.exit(1);
}

// ── 상태 파일 ──
const STATE_PATH = path.join(__dirname, '.migrate_state.json');
const PREVIEW_CSV = path.join(__dirname, 'migration_preview.csv');
const PENDING_QUEUE_PATH = path.join(__dirname, 'pending_playlist_adds.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')); }
  catch { return { processed: {}, lastCursor: null, startedAt: null, totalProcessed: 0 }; }
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

if (RESET_STATE) {
  if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
  console.log('✅ state 초기화');
  process.exit(0);
}

// ── playlists.json 로드 (토픽 → playlistId 매핑) ──
const playlists = JSON.parse(fs.readFileSync(path.join(__dirname, 'playlists.json'), 'utf-8'));
const TOPIC_TO_PLAYLIST_ID = {};
for (const p of playlists) {
  const m = p.url.match(/[?&]list=([^&]+)/);
  if (m) TOPIC_TO_PLAYLIST_ID[(p.name || '').normalize('NFC')] = m[1];
}
const AVAILABLE_TOPICS = Object.keys(TOPIC_TO_PLAYLIST_ID);
console.log(`📚 로드된 토픽: ${AVAILABLE_TOPICS.length}개`);

// ── Notion 호출 ──
function notionFetch(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com', path: urlPath, method,
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: chunks ? JSON.parse(chunks) : null }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── 페이지 본문(blocks) → 텍스트 ──
async function getSummaryText(pageId) {
  let pageToken = '';
  const lines = [];
  do {
    const url = `/v1/blocks/${pageId}/children?page_size=100${pageToken ? `&start_cursor=${pageToken}` : ''}`;
    const res = await notionFetch('GET', url);
    if (res.status !== 200) throw new Error(`blocks fetch ${res.status}`);
    for (const b of res.data.results || []) {
      const rich = b[b.type]?.rich_text || [];
      const text = rich.map(r => r.plain_text || '').join('');
      if (text) lines.push(text);
    }
    pageToken = res.data.has_more ? res.data.next_cursor : '';
  } while (pageToken);
  return lines.join('\n').slice(0, 8000);
}

// ── pending queue ──
function appendPending(entry) {
  let q = [];
  try { q = JSON.parse(fs.readFileSync(PENDING_QUEUE_PATH, 'utf-8')); } catch {}
  q.push({ ...entry, ts: new Date().toISOString() });
  fs.writeFileSync(PENDING_QUEUE_PATH, JSON.stringify(q, null, 2));
}

// ── 영상ID 추출 ──
function videoIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ── 메인 ──
(async () => {
  const mode = DRY_RUN ? 'DRY-RUN' : NOTION_ONLY ? 'NOTION-ONLY' : YOUTUBE_ONLY ? 'YOUTUBE-ONLY' : 'APPLY';
  console.log(`🚀 모드: ${mode}${LIMIT ? ` (limit=${LIMIT})` : ''}`);
  if (!NOTION_ONLY) console.log(`📊 일일 quota cap: ${DAILY_QUOTA_CAP} units`);

  // CSV 헤더
  if (DRY_RUN) {
    fs.writeFileSync(PREVIEW_CSV, 'page_id,title,existing_topics,recommended_topics,confidence,reasoning\n');
  }

  const state = RESUME ? loadState() : { processed: {}, lastCursor: null, startedAt: new Date().toISOString(), totalProcessed: 0 };

  // 마스터 재생목록 기존 영상 캐싱 (중복 방지)
  let masterExisting = new Set();
  if (APPLY || YOUTUBE_ONLY) {
    console.log('🔍 마스터 재생목록 기존 영상 캐싱...');
    try {
      const r = await yt.listPlaylistItems(MASTER_PLAYLIST_ID);
      masterExisting = r.videoIds;
      console.log(`   ${masterExisting.size}개 영상 이미 추가됨`);
    } catch (e) {
      console.warn(`⚠️  마스터 캐싱 실패: ${e.message} — 중복 추가 가능`);
    }
  }

  // 토픽 재생목록 캐싱은 lazy (필요할 때만)
  const topicCache = {};   // { topicName: Set<videoId> }
  async function getTopicCache(topic) {
    if (topicCache[topic]) return topicCache[topic];
    const pid = TOPIC_TO_PLAYLIST_ID[topic];
    if (!pid) return new Set();
    try {
      const r = await yt.listPlaylistItems(pid);
      topicCache[topic] = r.videoIds;
      return r.videoIds;
    } catch (e) {
      console.warn(`⚠️  토픽 "${topic}" 캐싱 실패: ${e.message}`);
      topicCache[topic] = new Set();
      return topicCache[topic];
    }
  }

  let cursor = state.lastCursor || undefined;
  let pageNum = 0;
  let stats = {
    total: 0, classified: 0, lowConfidence: 0, noMatch: 0,
    notionUpdated: 0, ytAdded: 0, ytSkipDup: 0, ytFailed: 0, errors: 0,
  };

  outer: do {
    const body = { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const res = await notionFetch('POST', `/v1/databases/${NOTION_DB_ID}/query`, body);
    if (res.status !== 200) {
      console.error('❌ DB 쿼리 실패:', res.status, res.data);
      process.exit(1);
    }

    for (const page of res.data.results || []) {
      stats.total++;
      pageNum++;

      if (LIMIT && stats.classified >= LIMIT) break outer;
      if (state.processed[page.id]) continue;  // resume skip

      const props = page.properties || {};
      const title = (props['영상 제목']?.title?.[0]?.plain_text || '').trim();
      const url = props['영상 URL']?.url || '';
      const channel = props['유튜브 채널']?.rich_text?.[0]?.plain_text || '';
      const summaryRich = props['요약 내용']?.rich_text || [];
      const summaryFromProp = summaryRich.map(r => r.plain_text || '').join('');
      const existingTopics = (props['주제']?.multi_select || [])
        .map(t => (t.name || '').normalize('NFC'));
      const videoId = videoIdFromUrl(url);

      if (!videoId) {
        stats.errors++;
        console.log(`  ⏭  [${pageNum}] videoId 추출 실패 — ${title.slice(0, 40)}`);
        continue;
      }

      try {
        // 1차: 속성에서 직접 읽기 (대부분의 페이지)
        let summary = summaryFromProp;
        // 2차: 속성이 비어있으면 page body blocks 폴백 (구버전 페이지 호환)
        if (!summary || summary.length < 50) {
          summary = await getSummaryText(page.id);
        }
        if (!summary || summary.length < 50) {
          console.log(`  ⏭  [${pageNum}] 요약 너무 짧음 (${summary?.length || 0}자) — ${title.slice(0, 40)}`);
          continue;
        }

        const cls = await classifyTopics(
          { summary, title, channel },
          AVAILABLE_TOPICS,
          { maxRetries: 2 }
        );
        stats.classified++;

        const recommended = cls.topics;
        const merged = [...new Set([...existingTopics, ...recommended].map(t => t.normalize('NFC')))];
        const newOnes = recommended.filter(t => !existingTopics.includes(t));

        if (cls.confidence < 0.6) stats.lowConfidence++;
        if (recommended.length === 0) stats.noMatch++;

        const logLine = `[${pageNum}] ${title.slice(0, 50)}\n     기존: [${existingTopics.join(', ')}]\n     추천: [${recommended.join(', ')}] (conf=${cls.confidence.toFixed(2)})`;
        console.log(`  ${logLine}`);

        if (DRY_RUN) {
          // CSV 한 줄 (큰따옴표 escape)
          const csvEsc = (s) => `"${String(s).replace(/"/g, '""')}"`;
          fs.appendFileSync(PREVIEW_CSV, [
            page.id, csvEsc(title), csvEsc(existingTopics.join('|')),
            csvEsc(recommended.join('|')), cls.confidence, csvEsc(cls.reasoning),
          ].join(',') + '\n');

        } else if (NOTION_ONLY || APPLY) {
          // ── Notion 태그 업데이트 ──
          if (newOnes.length > 0) {
            const patch = await notionFetch('PATCH', `/v1/pages/${page.id}`, {
              properties: { '주제': { multi_select: merged.map(name => ({ name })) } },
            });
            if (patch.status === 200) stats.notionUpdated++;
            else console.warn(`     ⚠️  Notion PATCH ${patch.status}`);
          }
        }

        if (APPLY || YOUTUBE_ONLY) {
          // Quota check
          if (yt.loadQuotaState().used >= DAILY_QUOTA_CAP) {
            console.log(`\n⏸  일일 quota cap (${DAILY_QUOTA_CAP}) 도달 — 내일 --resume으로 재실행하세요`);
            state.lastCursor = cursor;
            saveState(state);
            break outer;
          }

          // ── 마스터 재생목록 추가 ──
          if (!masterExisting.has(videoId)) {
            try {
              await yt.addToPlaylist(MASTER_PLAYLIST_ID, videoId);
              masterExisting.add(videoId);
              stats.ytAdded++;
            } catch (e) {
              if (e.code === 'QUOTA_EXHAUSTED') {
                console.log('\n⏸  YouTube quota 소진 — 다음 실행에서 재개');
                state.lastCursor = cursor;
                saveState(state);
                break outer;
              }
              stats.ytFailed++;
              appendPending({ playlistId: MASTER_PLAYLIST_ID, videoId, reason: e.message });
            }
          } else {
            stats.ytSkipDup++;
          }

          // ── 토픽 재생목록 추가 (신뢰도 0.6+ 만) ──
          if (cls.confidence >= 0.6) {
            for (const topic of recommended) {
              const pid = TOPIC_TO_PLAYLIST_ID[topic];
              if (!pid) continue;
              const cache = await getTopicCache(topic);
              if (cache.has(videoId)) { stats.ytSkipDup++; continue; }
              try {
                await yt.addToPlaylist(pid, videoId);
                cache.add(videoId);
                stats.ytAdded++;
              } catch (e) {
                if (e.code === 'QUOTA_EXHAUSTED') {
                  console.log('\n⏸  YouTube quota 소진');
                  state.lastCursor = cursor;
                  saveState(state);
                  break outer;
                }
                stats.ytFailed++;
                appendPending({ playlistId: pid, topic, videoId, reason: e.message });
              }
            }
          }
        }

        state.processed[page.id] = { ts: Date.now(), topics: recommended };
        state.totalProcessed++;
        if (state.totalProcessed % 10 === 0) saveState(state);

      } catch (e) {
        stats.errors++;
        console.warn(`  ⚠️  [${pageNum}] ${e.message.slice(0, 200)}`);
      }
    }

    cursor = res.data.has_more ? res.data.next_cursor : undefined;
  } while (cursor);

  saveState(state);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 통계 (${mode})`);
  console.log(`   조회 페이지: ${stats.total}`);
  console.log(`   분류 성공: ${stats.classified}`);
  console.log(`   저신뢰도(<0.6): ${stats.lowConfidence}`);
  console.log(`   매칭 없음: ${stats.noMatch}`);
  console.log(`   Notion 업데이트: ${stats.notionUpdated}`);
  console.log(`   YouTube 추가: ${stats.ytAdded}`);
  console.log(`   YouTube 중복 스킵: ${stats.ytSkipDup}`);
  console.log(`   YouTube 실패: ${stats.ytFailed} (pending_playlist_adds.json 적재)`);
  console.log(`   오류: ${stats.errors}`);
  if (APPLY || YOUTUBE_ONLY) console.log(`   YouTube quota 사용: ${yt.loadQuotaState().used} units`);
  if (DRY_RUN) console.log(`\n📄 분류 결과: ${PREVIEW_CSV}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
})().catch((e) => {
  console.error('\n❌ 실행 오류:', e);
  process.exit(1);
});
