#!/usr/bin/env node
// pending_playlist_adds.json 정리 — 중복 제거 + 영구 실패/미등록 재생목록 dead-letter 격리
// 사용: node scripts/clean_pending_queue.js [--apply]   (기본 dry-run)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const QUEUE = path.join(ROOT, 'pending_playlist_adds.json');
const DEAD = path.join(ROOT, 'pending_playlist_adds.dead.json');
const APPLY = process.argv.includes('--apply');

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return d; } };

const queue = readJson(QUEUE, null);
if (!Array.isArray(queue)) { console.error(`❌ ${QUEUE} 를 읽을 수 없습니다.`); process.exit(1); }

const valid = new Set(
  readJson(path.join(ROOT, 'playlists.json'), [])
    .map(p => (String(p.url || '').match(/list=([^&]+)/) || [])[1])
    .filter(Boolean)
);
if (!valid.size) { console.error('❌ playlists.json 에서 playlistId 를 하나도 추출하지 못했습니다.'); process.exit(1); }

// 1) (videoId, playlistId) 중복 제거 — 가장 오래된 ts 를 남긴다
const byKey = new Map();
for (const it of queue) {
  const key = `${it.videoId}|${it.playlistId}`;
  const prev = byKey.get(key);
  if (!prev || String(it.ts || '') < String(prev.ts || '')) byKey.set(key, it);
}
const unique = [...byKey.values()];

// 2) 영구 실패 / 미등록 재생목록 분리
const keep = [], dead = [];
let unregistered = 0, permanent = 0;
for (const it of unique) {
  if (!valid.has(it.playlistId)) { unregistered++; dead.push({ ...it, deadReason: 'playlists.json 미등록 재생목록', deadAt: new Date().toISOString() }); }
  else if (String(it.reason || '').includes('playlistItemsNotAccessible')) { permanent++; dead.push({ ...it, deadReason: it.reason.slice(0, 200), deadAt: new Date().toISOString() }); }
  else keep.push(it);
}

console.log(`
| 구분             | 건수 |
|------------------|------|
| 처리 전          | ${queue.length} |
| 중복 제거        | -${queue.length - unique.length} |
| 미등록 재생목록  | -${unregistered} |
| 영구 실패        | -${permanent} |
| 처리 후 큐       | ${keep.length} |
| dead 격리 합계   | ${dead.length} |
`);

if (!APPLY) { console.log('ℹ️  dry-run — 실제 적용하려면 --apply'); process.exit(0); }
if (dead.length === 0 && keep.length === queue.length) { console.log('✅ 정리할 항목 없음 — 파일 변경 안 함'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d+)/, '$1-$2');
const backup = path.join(ROOT, `pending_playlist_adds.backup.${stamp}.json`);
fs.copyFileSync(QUEUE, backup);
fs.writeFileSync(QUEUE, JSON.stringify(keep, null, 2));
fs.writeFileSync(DEAD, JSON.stringify([...readJson(DEAD, []), ...dead], null, 2));
console.log(`✅ 적용 완료 — 백업: ${path.basename(backup)}`);
