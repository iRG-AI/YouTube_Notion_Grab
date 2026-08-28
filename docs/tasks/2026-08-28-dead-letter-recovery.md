# dead-letter 509건 복구 (마스터 344 + 계정불일치 165)

- 작성: 2026-08-28 (Cowork)
- 대상: `scripts/clean_pending_queue.js` 수정 + `scripts/restore_dead_letters.js` 신규
- 영역: **Node**
- 선행 커밋: v2.7.1 (분류 5xx 재시도)

---

## 1. 배경

`pending_playlist_adds.dead.json` 539건 중 **509건은 영구 실패가 아니라 오분류**입니다.
두 건 모두 원인이 이미 해소됐습니다.

### 344건 — 마스터 재생목록을 "미등록"으로 오판

```
YOUTUBE_MASTER_PLAYLIST_ID : PLnDn1H0jzj2gcUeJUUqqojnbkNNU6xNZR
dead 344건의 playlistId    : PLnDn1H0jzj2gcUeJUUqqojnbkNNU6xNZR   ← 동일
```

`scripts/clean_pending_queue.js:18`이 유효 재생목록 집합을 **`playlists.json`에서만** 만듭니다.
거기엔 토픽 33개만 있고 마스터는 설계상 없습니다. 그래서 마스터로 향하는 항목을
전부 `playlists.json 미등록 재생목록`으로 격리했습니다.

재생목록은 살아 있습니다 — 2026-08-28 06:00 실행이 이 재생목록에서 **1,016개를 읽었습니다.**

원래 실패 사유는 계정 문제였습니다.

| 건수 | `reason` |
|---|---|
| 339 | `Token refresh failed: 400 invalid_grant` (expired or revoked) |
| 5 | (reason 없음) |

적재 시각은 **2026-05-29 ~ 08-17**로, GCP 게시 상태가 「테스트」라 refresh token이
7일마다 만료되던 기간과 정확히 겹칩니다. 이 항목들은 `topic`·`title`이 비어 있는데,
`migrate_classify.js:311`의 적재 형식이라 그렇습니다(마스터 보충 경로).

### 165건 — `playlistItemsNotAccessible`

2026-08-17에 "재생목록 삭제 = 영구 실패"로 판단해 격리했으나, 실제 원인은
**OAuth 토큰이 33개 재생목록을 소유하지 않은 계정**이었습니다.
2026-08-18 22:35 검증에서 채널 「타이쿤안」 **33/33 일치**를 확인했고,
같은 날 190건이 정상 배수됐습니다. 재시도하면 성공할 항목들입니다.

### 유지할 30건

| 건수 | 사유 | 판정 |
|---|---|---|
| 22 | `videoNotFound` (404) | 비공개·삭제 영상. 진짜 영구 실패 |
| 8 | 재시도 5회 초과 | 진짜 영구 실패 |

---

## 2. 🚨 이 작업의 함정 — `reason` 필드를 반드시 지울 것

`clean_pending_queue.js:39`는 큐 항목의 **`reason`** 을 보고 영구 실패를 판정합니다.

```js
else if (String(it.reason || '').includes('playlistItemsNotAccessible')) { permanent++; dead.push(...) }
```

165건은 `reason`에 `playlistItemsNotAccessible` 문자열을 그대로 들고 있습니다.
**복구하면서 `reason`을 남기면, 다음 `clean_pending_queue.js --apply`가 즉시 다시 격리합니다.**
복구는 무의미해지고 왕복만 반복됩니다.

→ 복구 시 `deadReason`·`deadAt`·`reason`·`retryCount`를 **모두 제거**합니다.
남길 필드는 `playlistId`, `videoId`, `topic`, `title`, `ts`뿐입니다.

---

## 3. 범위

큐 파일과 dead 파일의 **데이터 이동**, 그리고 `clean_pending_queue.js`의 판정 집합 수정.
`scheduler.js`·`lib/youtube_oauth.js`·quota 로직·안전장치는 **일절 건드리지 않습니다.**

---

## 4. AS-IS → TO-BE

### 4-1. `scripts/clean_pending_queue.js` (18~23행) — 마스터를 유효 집합에 포함

**AS-IS**

```js
const valid = new Set(
  readJson(path.join(ROOT, 'playlists.json'), [])
    .map(p => (String(p.url || '').match(/list=([^&]+)/) || [])[1])
    .filter(Boolean)
);
if (!valid.size) { console.error('❌ playlists.json 에서 playlistId 를 하나도 추출하지 못했습니다.'); process.exit(1); }
```

**TO-BE**

```js
// .env 의 마스터 재생목록은 playlists.json(토픽 33개)에 없다.
// 이걸 빼먹어 마스터行 344건을 "미등록"으로 오격리한 이력이 있다(2026-05~08).
function readMasterId() {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
      const m = line.match(/^YOUTUBE_MASTER_PLAYLIST_ID=(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
  return '';
}

const valid = new Set(
  readJson(path.join(ROOT, 'playlists.json'), [])
    .map(p => (String(p.url || '').match(/list=([^&]+)/) || [])[1])
    .filter(Boolean)
);
if (!valid.size) { console.error('❌ playlists.json 에서 playlistId 를 하나도 추출하지 못했습니다.'); process.exit(1); }

const MASTER_ID = readMasterId();
if (MASTER_ID) valid.add(MASTER_ID);
else console.warn('⚠️  YOUTUBE_MASTER_PLAYLIST_ID 를 .env 에서 읽지 못했습니다 — 마스터行이 오격리될 수 있습니다.');
```

> **이 수정이 선행되어야 합니다.** 안 하면 복구한 344건이 다음 정리 때 또 격리됩니다.

### 4-2. `scripts/restore_dead_letters.js` — 신규

`clean_pending_queue.js`와 같은 관례를 따릅니다 — **기본 dry-run, `--apply` 필수, 백업 생성.**

```js
#!/usr/bin/env node
// dead-letter 중 복구 가능한 항목을 대기 큐로 되돌린다.
//   복구 대상: (1) 마스터 재생목록行  (2) playlistItemsNotAccessible (계정 불일치가 원인)
//   유지 대상: videoNotFound / playlistNotFound / 재시도 5회 초과
//
// 사용:
//   node scripts/restore_dead_letters.js                    # dry-run (API 호출 없음)
//   node scripts/restore_dead_letters.js --check-master     # + 마스터 중복 제거 (읽기 약 21유닛)
//   node scripts/restore_dead_letters.js --check-master --apply

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const QUEUE = path.join(ROOT, 'pending_playlist_adds.json');
const DEAD = path.join(ROOT, 'pending_playlist_adds.dead.json');
const APPLY = process.argv.includes('--apply');
const CHECK_MASTER = process.argv.includes('--check-master');

const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return d; } };

function readEnv(key) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
      const m = line.match(new RegExp(`^${key}=(.*)$`));
      if (m) return m[1].replace(/^["']|["']$/g, '').trim();
    }
  } catch {}
  return '';
}

const MASTER_ID = readEnv('YOUTUBE_MASTER_PLAYLIST_ID');
if (!MASTER_ID) { console.error('❌ .env 에서 YOUTUBE_MASTER_PLAYLIST_ID 를 읽지 못했습니다.'); process.exit(1); }

const dead = readJson(DEAD, null);
const queue = readJson(QUEUE, null);
if (!Array.isArray(dead) || !Array.isArray(queue)) { console.error('❌ 큐/dead 파일을 읽을 수 없습니다.'); process.exit(1); }

// ── 1) 복구 대상 선별 ──
const isMasterRow = it => it.playlistId === MASTER_ID;
const isAccountMismatch = it => String(it.deadReason || '').includes('playlistItemsNotAccessible');

const recoverable = [], stayDead = [];
for (const it of dead) (isMasterRow(it) || isAccountMismatch(it)) ? recoverable.push(it) : stayDead.push(it);

// ── 2) 오염 필드 제거 ──
//   reason 을 남기면 clean_pending_queue.js:39 가 다시 영구실패로 격리한다.
const sanitize = ({ playlistId, videoId, topic, title, ts }) => {
  const o = { playlistId, videoId };
  if (topic) o.topic = topic;
  if (title) o.title = title;
  o.ts = ts || new Date().toISOString();
  return o;
};

// ── 3) 중복 제거 (기존 큐 + 복구분 내부) ──
const seen = new Set(queue.map(x => `${x.videoId}|${x.playlistId}`));
let dupQueue = 0, dupSelf = 0;
const toAdd = [];
for (const it of recoverable) {
  const key = `${it.videoId}|${it.playlistId}`;
  if (seen.has(key)) { (toAdd.some(x => `${x.videoId}|${x.playlistId}` === key) ? dupSelf++ : dupQueue++); continue; }
  seen.add(key);
  toAdd.push(sanitize(it));
}

// ── 4) 마스터에 이미 있는 영상 제외 (선택) ──
let alreadyInMaster = 0;
async function filterMaster(items) {
  if (!CHECK_MASTER) return items;
  const yt = require('../lib/youtube_oauth');
  console.log('🔎 마스터 재생목록 조회 중... (읽기 quota 소비)');
  const { videoIds } = await yt.listPlaylistItems(MASTER_ID);
  console.log(`   마스터 보유 영상: ${videoIds.size}건`);
  return items.filter(x => {
    if (x.playlistId === MASTER_ID && videoIds.has(x.videoId)) { alreadyInMaster++; return false; }
    return true;
  });
}

(async () => {
  let finalAdd;
  try {
    finalAdd = await filterMaster(toAdd);
  } catch (e) {
    // 인증/권한 오류면 연쇄 요청 없이 즉시 중단 (CLAUDE.md 보안 원칙 1)
    console.error(`❌ 마스터 조회 실패 — 중단합니다: ${e.message.slice(0, 120)}`);
    process.exit(1);
  }

  const newQueue = [...queue, ...finalAdd];

  console.log(`
| 구분                       | 건수 |
|----------------------------|------|
| dead 처리 전               | ${dead.length} |
| 복구 대상 선별             | ${recoverable.length} |
|   └ 마스터行               | ${recoverable.filter(isMasterRow).length} |
|   └ 계정불일치(403)        | ${recoverable.filter(isAccountMismatch).length} |
| 기존 큐와 중복 제외        | -${dupQueue} |
| 복구분 내부 중복 제외      | -${dupSelf} |
| 마스터에 이미 존재 제외    | -${alreadyInMaster}${CHECK_MASTER ? '' : ' (미확인 — --check-master 필요)'} |
| **실제 큐 복귀**           | **${finalAdd.length}** |
| 큐: ${queue.length} → ${newQueue.length} |  |
| dead: ${dead.length} → ${stayDead.length} |  |
`);
  console.log(`예상 쓰기 quota: ${finalAdd.length} × 50 = ${(finalAdd.length * 50).toLocaleString()}유닛 (약 ${(finalAdd.length / 190).toFixed(1)}일)`);

  if (!APPLY) { console.log('\nℹ️  dry-run — 실제 적용하려면 --apply'); process.exit(0); }
  if (!finalAdd.length) { console.log('✅ 복구할 항목 없음 — 파일 변경 안 함'); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d+)/, '$1-$2');
  fs.copyFileSync(QUEUE, path.join(ROOT, `pending_playlist_adds.backup.${stamp}.json`));
  fs.copyFileSync(DEAD, path.join(ROOT, `pending_playlist_adds.dead.backup.${stamp}.json`));
  fs.writeFileSync(QUEUE, JSON.stringify(newQueue, null, 2));
  fs.writeFileSync(DEAD, JSON.stringify(stayDead, null, 2));
  console.log(`✅ 적용 완료 — 백업 stamp: ${stamp}`);
})();
```

---

## 5. 실행 절차

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap

# ① 사전 상태 기록
node -e "for(const f of ['pending_playlist_adds.json','pending_playlist_adds.dead.json'])console.log(f, JSON.parse(require('fs').readFileSync(f)).length)"

# ② dry-run (API 호출 없음)
node scripts/restore_dead_letters.js

# ③ 마스터 대조 포함 dry-run (읽기 약 21유닛)
node scripts/restore_dead_letters.js --check-master

# ④ 적용
node scripts/restore_dead_letters.js --check-master --apply

# ⑤ 정리 스크립트가 되돌린 항목을 다시 격리하지 않는지 확인 (반드시 dry-run)
node scripts/clean_pending_queue.js
```

**⑤가 이 작업의 최종 관문입니다.** 출력의 `미등록 재생목록`과 `영구 실패`가
**둘 다 0**이어야 합니다. 하나라도 0이 아니면 §2의 `reason` 제거나 §4-1의 마스터 등록이
누락된 것이므로 **`--apply`를 절대 실행하지 말고** 롤백하십시오.

> **quota 주의** — ③④는 마스터 조회에 약 21유닛을 씁니다. 쓰기는 하지 않습니다.
> 실제 배수는 다음 정규 실행(00/06/12/18시)이 하루 190건씩 처리합니다.

---

## 6. 검증

### 6-1. dry-run 기대 출력 (2026-08-28 시점 실측 기준)

```
| dead 처리 전               | 539 |
| 복구 대상 선별             | 509 |
|   └ 마스터行               | 344 |
|   └ 계정불일치(403)        | 165 |
| 기존 큐와 중복 제외        | -3  |
| 복구분 내부 중복 제외      | -0  |
```

`--check-master` 없이 돌리면 `마스터에 이미 존재 제외`가 `-0 (미확인)`으로 나옵니다.
붙이면 그만큼 줄어들며, **줄어드는 것이 정상**입니다(5~8월 사이 스케줄러가 이미 넣은 영상).

### 6-2. 오염 필드 제거 확인 (적용 후)

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const q=JSON.parse(require('fs').readFileSync('pending_playlist_adds.json'));
const bad=q.filter(x=>x.reason||x.deadReason||x.deadAt||x.retryCount);
console.log('오염 필드 보유 항목:',bad.length);
console.log(bad.length===0?'✅ 정상':'❌ '+JSON.stringify(bad[0]).slice(0,160));
const keys=new Set(); q.forEach(x=>Object.keys(x).forEach(k=>keys.add(k)));
console.log('큐 항목 필드 종류:',[...keys].join(', '));"
```

**기대** — `✅ 정상`, 필드는 `playlistId, videoId, topic, title, ts` 범위 안.

### 6-3. 재격리 방지 확인

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node scripts/clean_pending_queue.js
```

**기대** — `미등록 재생목록` **0**, `영구 실패` **0**. (`중복 제거`는 0이어야 정상)

### 6-4. dead 파일 잔여 구성

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const d=JSON.parse(require('fs').readFileSync('pending_playlist_adds.dead.json'));
const g={}; for(const x of d){const r=String(x.deadReason||'');
  const k=r.includes('videoNotFound')?'videoNotFound':r.includes('재시도 5회')?'재시도 5회 초과':'기타: '+r.slice(0,50);
  g[k]=(g[k]||0)+1;}
console.log('dead 잔여:',d.length); for(const [k,v] of Object.entries(g))console.log('  ',v,k);"
```

**기대** — 총 **30건**, `videoNotFound` 22 + `재시도 5회 초과` 8.

### 6-5. 백업 파일이 gitignore에 걸리는지

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && for f in pending_playlist_adds.backup.*.json pending_playlist_adds.dead.backup.*.json; do git check-ignore -q "$f" && echo "ignored: $f" || echo "❌ NOT ignored: $f"; done
```

**기대** — 전부 `ignored`. (`.gitignore`의 `pending_playlist_adds*` 패턴이 잡습니다.)
하나라도 걸리지 않으면 **커밋하지 말고** 패턴을 먼저 고치십시오.

### 6-6. 범위 밖 무결성

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && \
printf "연속 실패 차단기 : %s\n" "$(grep -c 'consecutiveFail >= 10' scheduler.js)" && \
printf "중복 방지        : %s\n" "$(grep -c 'x.videoId === entry.videoId' scheduler.js)" && \
printf "consumeQuota ok  : %s\n" "$(grep -c \"consumeQuota(50, 'ok')\" lib/youtube_oauth.js)" && \
printf "todayKey PT      : %s\n" "$(grep -c 'America/Los_Angeles' lib/youtube_oauth.js)"
```

**기대** — 전부 `1`.

---

## 7. 롤백

`--apply`가 만든 백업 stamp로 되돌립니다.

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
cp pending_playlist_adds.backup.<stamp>.json      pending_playlist_adds.json
cp pending_playlist_adds.dead.backup.<stamp>.json pending_playlist_adds.dead.json
node -e "for(const f of ['pending_playlist_adds.json','pending_playlist_adds.dead.json'])console.log(f, JSON.parse(require('fs').readFileSync(f)).length)"
```

**766 / 539로 돌아오면 성공.** 코드 롤백은 `git checkout -- scripts/`.

> 기존 백업 `pending_playlist_adds.backup.20260817-165737.json`은 **삭제 금지**입니다.

---

## 8. 적용 후 예상

```
큐        766 → 약 1,270건 (마스터 중복 제외분만큼 감소)
dead      539 → 30건
소진 예상 약 1,270 ÷ 순감 184 ≈ 7일
```

배수는 하루 190건 상한이라 코드로 앞당길 수 없습니다. 텔레그램의
`✅ 재생목록 추가: N건`과 `⏳ 대기` 감소로 진척을 확인하십시오.

**적용 시점은 KST 16:00 이후를 권장합니다.** 그 전이면 당일 quota가 이미 소진돼 있어
마스터 조회(21유닛)마저 `quotaExceeded`로 실패할 수 있습니다.

---

## 9. 범위 밖 — 건드리지 말 것

- **`scheduler.js` 전부** — 큐 안전장치(중복 방지·연속 실패 10회 차단기·dead-letter·retryCount 5회), 텔레그램 블록.
- **`lib/youtube_oauth.js` 전부** — quota 임계·유닛 수·`todayKey()` PT 로직·`ok`/`fail` 계상.
- **`clean_pending_queue.js`의 나머지 로직** — 중복 제거·백업·dry-run 관례는 그대로. §4-1의 `valid` 집합만 수정.
- **`videoNotFound` 22건 / 재시도 초과 8건** — 복구 대상 아님.
- **기존 백업 파일** — 삭제 금지.
- **`migrate_classify.js`** — 이번 작업과 무관.

## 10. 산출물 규칙

- `README.md` + `README.html` 양쪽에 v2.8 Changelog 반영
- `CLAUDE.md` — 큐 파일 표에 `restore_dead_letters.js` 추가, `clean_pending_queue.js`가
  마스터를 유효 집합에 포함한다는 점 명시, 변경 이력에 v2.8 추가, 헤더 버전 갱신
- `git push`는 사전 확인 후

## 11. 커밋 메시지

```
feat(queue): dead-letter 509건 복구 및 마스터 재생목록 오격리 수정

dead 539건 중 509건이 영구 실패가 아니라 오분류였다.
- 344건: clean_pending_queue.js 가 유효 재생목록을 playlists.json(토픽 33개)
  에서만 만들어, 마스터 재생목록行을 "미등록"으로 격리했다. 원래 실패 사유는
  339건이 invalid_grant(토큰 만료)로, GCP 게시상태 「테스트」 기간과 겹친다.
- 165건: playlistItemsNotAccessible. 원인은 OAuth 계정 불일치였고
  2026-08-18 33/33 일치 검증으로 해소됐다.

- scripts/clean_pending_queue.js: .env 의 YOUTUBE_MASTER_PLAYLIST_ID 를
  valid 집합에 추가 (재격리 방지)
- scripts/restore_dead_letters.js 신규: 기본 dry-run, --apply 필수,
  큐·dead 양쪽 백업. 복구 시 reason/deadReason/deadAt/retryCount 를 제거한다
  — reason 을 남기면 clean_pending_queue.js:39 가 즉시 재격리한다.
- --check-master 로 마스터에 이미 있는 영상을 제외해 쓰기 quota 낭비 방지

videoNotFound 22건과 재시도 초과 8건은 그대로 dead 에 남긴다.
scheduler.js·lib/youtube_oauth.js 변경 없음.
```
