# 작업지시서 — pending 재생목록 큐 적체 진단 및 개선

- 작성일: 2026-08-17
- 대상 파일: `scheduler.js`, `lib/youtube_oauth.js`, `pending_playlist_adds.json`
- 성격: 데이터 정리 + 로직 결함 수정
- 선행 조건: **P0(OAuth 토큰 재발급)이 끝나야 나머지 검증이 가능하다**

---

## 0. 먼저 — 비용은 발생하지 않았다

큐가 5,392건까지 쌓였지만 **여기서 발생한 금전적 비용은 0원이다.**

YouTube Data API v3의 일일 10,000유닛은 **무료 할당량이자 상한선**이다.
초과분에 대한 종량 과금이 없고, 한도를 넘으면 `403 quotaExceeded`로 거부될 뿐이다.
따라서 큐가 아무리 쌓여도 요금이 붙지 않는다. 이건 **비용 문제가 아니라
처리량·정합성 문제**다.

다만 실제 비용 벡터는 하나 있다 — **Gemini**. 현재 `.env`에 무료 키 4개가
로테이션으로 등록돼 있고(`GEMINI_API_KEYS`), `thinkingBudget: 0`도 적용돼 있다.
이 구성이면 무과금이지만, **키 중 하나라도 결제가 활성화된 GCP 프로젝트에
묶여 있으면 무료 한도 초과분이 과금된다.** §4-4에서 확인할 것.

## 1. 진단

### D1. 큐가 3개월째 배수되지 않았다

적재 시점 분포를 보면 **2026-05-18부터 하루도 빠짐없이 누적**되어 왔다.
드레인(소진)된 흔적이 없다.

```
2026-05-18   36건   ...   2026-08-16  105건   2026-08-17   29건
```

`.quota_state.json`이 결정적 증거다.

```json
{ "date": "2026-06-07", "used": 1 }
```

이 파일은 **quota를 실제로 소비했을 때만** 갱신된다. 6월 7일 이후 멈춰 있다는 건
**그 뒤로 재생목록 쓰기가 단 한 번도 성공하지 못했다**는 뜻이다.
OAuth `invalid_grant`(8/12~)는 가장 최근 원인일 뿐, 그 이전에도 계속 실패해 왔다.

### D2. 중복이 46.7%다 — `appendPending`에 중복 검사가 없다

`scheduler.js:983` 부근의 `appendPending()`은 무조건 `q.push()` 한다.

```javascript
const appendPending = (entry) => {
  let q = [];
  try { q = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8')); } catch {}
  q.push({ ...entry, ts: new Date().toISOString() });   // ← 중복 검사 없음
  fs.writeFileSync(PENDING_PATH, JSON.stringify(q, null, 2));
};
```

같은 `(videoId, playlistId)` 조합이 **최대 28회** 중복 적재돼 있다.

```
전체 5,392건 → 고유 조합 2,874건 (중복 2,518건, 46.7%)
고유 영상 616개
```

### D3. 영구 실패가 영원히 재시도된다

`flushPendingQueue()`의 마지막 분기가 문제다.

```javascript
// 기타 오류: 건너뛰지 않고 큐에 유지 (다음 실행에서 재시도)
log(`  ⚠️  실패 [${item.videoId}] ...`);
remaining.push(item);
```

`403 playlistItemsNotAccessible`은 **재생목록이 삭제됐거나 접근 권한이 없다**는
영구 실패다. 몇 번을 재시도해도 성공하지 않는데 "기타 오류"로 분류돼 큐에 남는다.
현재 **165건**이 이 상태로 영구 순환 중이다.

### D4. playlists.json에 없는 재생목록을 참조한다

고유 playlistId **1개**가 `playlists.json`(33개)에서 빠졌는데,
그 재생목록을 향한 항목 **344건**이 큐에 남아 있다. 역시 영원히 실패한다.

### D5. 적체를 알려주는 장치가 없다

큐가 3개월간 5,392건까지 커지는 동안 어떤 알림도 없었다.
텔레그램 알림은 "저장 N건" 요약만 보내고 큐 잔량은 다루지 않는다.

### 정리 — 실제로 살릴 수 있는 항목

```
전체            5,392건
─ 중복 제거    -2,518건
─ 미등록 PL    -  344건
─ 영구 실패    -  165건
────────────────────────
재시도 가치     2,365건  →  190건/일 기준 약 12.4일이면 소진
```

**28일이 아니라 12일**이다. 정리만 해도 절반 이하로 줄어든다.

## 2. 조치

### P0. OAuth 토큰 재발급 (사용자 수동 — 최우선)

브라우저 인증이 필요해 자동화할 수 없다.

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
node oauth_setup.js
# 발급된 refresh token을 .env의 YOUTUBE_OAUTH_REFRESH_TOKEN 에 반영
node -e "require('./lib/youtube_oauth').getAccessToken().then(t=>console.log('✅',t.slice(0,20))).catch(e=>console.error('❌',e.message))"
```

**이게 끝나기 전에는 P1~P4를 검증할 수 없다.**

### P1. 큐 정리 스크립트 작성 (`scripts/clean_pending_queue.js`)

일회성 수작업이 아니라 **재실행 가능한 스크립트**로 만든다. 앞으로도 쓸 일이 생긴다.

요구사항:

1. 실행 전 `pending_playlist_adds.json`을 타임스탬프 붙여 백업
2. `(videoId, playlistId)` 기준 중복 제거 — **가장 오래된 `ts`를 남긴다**
3. `playlists.json`에 없는 `playlistId` 항목 분리
4. `reason`에 `playlistItemsNotAccessible` 포함 항목 분리
5. 3·4번은 삭제하지 말고 **`pending_playlist_adds.dead.json`으로 격리**
6. `--dry-run` 기본값. `--apply`를 줘야 실제로 쓴다
7. 처리 전후 건수를 표로 출력

```bash
node scripts/clean_pending_queue.js            # dry-run
node scripts/clean_pending_queue.js --apply
```

`playlists.json`의 playlistId는 `url` 필드에서 뽑는다 (`list=` 파라미터).
`playlistId` 키가 따로 없으니 주의할 것.

```javascript
const valid = new Set(
  playlists.map(p => (p.url.match(/list=([^&]+)/) || [])[1]).filter(Boolean)
);
```

기대 결과:

| 구분 | 건수 |
|---|---|
| 처리 전 | 5,392 |
| 중복 제거 | -2,518 |
| dead 격리 (미등록 PL 344 + 영구실패 165) | -509 |
| **처리 후 큐** | **2,365** |

### P2. `appendPending` 중복 방지 (`scheduler.js:983` 부근)

```javascript
// TO-BE
const appendPending = (entry) => {
  let q = [];
  try { q = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf-8')); } catch {}
  const dup = q.some(x => x.videoId === entry.videoId && x.playlistId === entry.playlistId);
  if (dup) return;                                   // 이미 대기 중이면 적재하지 않음
  q.push({ ...entry, ts: new Date().toISOString() });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(q, null, 2));
};
```

> 큐가 2,000건대면 `some()` 선형 탐색으로 충분하다. `Set` 인덱스 도입은 과설계다.

### P3. `flushPendingQueue` — 영구 실패를 dead-letter로 분리

`scheduler.js:800` 부근, "기타 오류" 분기를 교체한다.

```javascript
// AS-IS
      // 기타 오류: 건너뛰지 않고 큐에 유지 (다음 실행에서 재시도)
      log(`  ⚠️  실패 [${item.videoId}] ${item.topic || ''}: ${e.message.slice(0, 80)}`);
      remaining.push(item);
```

```javascript
// TO-BE
      // 영구 실패는 재시도해도 성공하지 않는다 → dead-letter로 격리
      const PERMANENT = ['playlistItemsNotAccessible', 'playlistNotFound',
                         'videoNotFound', 'forbidden'];
      const isPermanent = PERMANENT.some(k => (e.message || '').includes(k));

      if (isPermanent) {
        deadLetters.push({ ...item, deadReason: e.message.slice(0, 200),
                           deadAt: new Date().toISOString() });
        log(`  ⛔ 영구 실패 격리 [${item.videoId}] ${item.topic || ''}: ${e.message.slice(0, 60)}`);
      } else {
        item.retryCount = (item.retryCount || 0) + 1;
        if (item.retryCount >= 5) {
          deadLetters.push({ ...item, deadReason: `재시도 5회 초과: ${e.message.slice(0,150)}`,
                             deadAt: new Date().toISOString() });
          log(`  ⛔ 재시도 한도 초과 격리 [${item.videoId}]`);
        } else {
          log(`  ⚠️  실패(${item.retryCount}/5) [${item.videoId}]: ${e.message.slice(0, 60)}`);
          remaining.push(item);
        }
      }
```

함수 상단에 `const deadLetters = [];`를 선언하고, 마지막 `writeFileSync` 직전에
누적분을 파일에 append 한다.

```javascript
  if (deadLetters.length) {
    const DEAD_PATH = path.join(__dirname, 'pending_playlist_adds.dead.json');
    let dead = [];
    try { dead = JSON.parse(fs.readFileSync(DEAD_PATH, 'utf-8')); } catch {}
    fs.writeFileSync(DEAD_PATH, JSON.stringify([...dead, ...deadLetters], null, 2));
    log(`  ⛔ dead-letter ${deadLetters.length}건 격리 (누적 ${dead.length + deadLetters.length}건)`);
  }
```

`retryCount` 상한 5회를 둔 이유는, **어떤 실패도 무한 순환하지 않게** 하기 위해서다.
D3의 재발 방지책이다.

### P4. 큐 적체 알림 — 텔레그램 요약에 잔량 추가

3개월간 아무도 몰랐던 게 가장 큰 문제다. 매 실행 알림에 한 줄 넣는다.

```javascript
// 텔레그램 요약 생성부에 추가
const pendingCount = remaining.length;          // flushPendingQueue 결과를 전달
if (pendingCount > 0) {
  const days = (pendingCount / 190).toFixed(1);
  msg += `\n⏳ 재생목록 대기: ${pendingCount}건 (소진 예상 ${days}일)`;
}
if (pendingCount >= 1000) {
  msg += `\n⚠️ 큐 적체 — 원인 확인 필요`;
}
```

`.quota_state.json`의 `date`가 오늘이 아니면 "오늘 YouTube 쓰기 0건"이라는 뜻이므로,
이것도 경고 대상으로 넣는다.

```javascript
const qs = JSON.parse(fs.readFileSync('.quota_state.json', 'utf-8'));
const today = new Date().toISOString().slice(0, 10);
if (qs.date !== today && pendingCount > 0) {
  msg += `\n🛑 오늘 YouTube 쓰기 0건 — quota_state 마지막 갱신 ${qs.date}`;
}
```

### P5. 큐 드레인 속도 — 이번엔 손대지 않는다

일 190건 한도는 `playlistItems.insert`가 50유닛인 YouTube API 정책 자체이므로
코드로 늘릴 수 없다. 정리 후 2,365건이면 **약 12일**에 자연 소진된다.
쿼터 증액 신청은 별건이며, 무료 한도로 충분한 상황이라 지금은 불필요하다.

## 3. 실행 순서

```
P0 (사용자, 브라우저 인증)
  ↓
P1 --dry-run 으로 건수 확인 → --apply
  ↓
P2, P3, P4 코드 수정
  ↓
검증 §4
  ↓
커밋 + push
```

## 4. 검증

### 4-1. 정리 스크립트 (dry-run이 먼저)

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
node scripts/clean_pending_queue.js
```

기대: 처리 전 5,392 / 중복 -2,518 / dead -509 / 처리 후 **2,365**.
숫자가 다르면 `--apply` 하지 말고 먼저 원인을 확인할 것.

```bash
node scripts/clean_pending_queue.js --apply
node -e "
const q=require('./pending_playlist_adds.json'), d=require('./pending_playlist_adds.dead.json');
const s=new Set(q.map(x=>x.videoId+'|'+x.playlistId));
console.log('큐:',q.length,'/ dead:',d.length,'/ 중복 잔존:',q.length-s.size);
"
```

`중복 잔존: 0` 이어야 한다.

### 4-2. 중복 재적재 차단 (P2)

같은 영상이 두 번 처리돼도 큐가 늘지 않아야 한다.

```bash
node -e "
const fs=require('fs');
const before=JSON.parse(fs.readFileSync('pending_playlist_adds.json')).length;
console.log('before:',before);
" && node scheduler.js && node -e "
console.log('after:',require('./pending_playlist_adds.json').length);
"
```

정상 동작 시 신규 영상 수만큼만 증가하고, 재실행해도 같은 항목이 다시 붙지 않는다.

### 4-3. dead-letter 분리 (P3)

큐에 일부러 잘못된 playlistId를 넣고 1회 실행한다.

```bash
node -e "
const fs=require('fs');
const q=JSON.parse(fs.readFileSync('pending_playlist_adds.json'));
q.unshift({playlistId:'PL_INVALID_TEST_0000',topic:'테스트',videoId:'dQw4w9WgXcQ',
           title:'dead-letter 테스트',ts:new Date().toISOString()});
fs.writeFileSync('pending_playlist_adds.json',JSON.stringify(q,null,2));
console.log('테스트 항목 주입');
"
node scheduler.js
grep "dead-letter\|영구 실패 격리" ~/Library/Logs/irichgreen/ytsummarizer.log | tail -3
node -e "console.log('dead:',require('./pending_playlist_adds.dead.json').length)"
```

주입한 항목이 큐가 아니라 `dead.json`으로 가야 한다. 확인 후 테스트 항목은 제거.

### 4-4. Gemini 과금 여부 확인 (§0 관련)

`.env`의 `GEMINI_API_KEYS` 4개 각각에 대해
[Google AI Studio](https://aistudio.google.com/apikey)에서
연결된 GCP 프로젝트의 **결제 계정 연결 여부**를 확인한다.
결제가 붙은 키가 있으면 무료 한도 초과분이 과금되므로, 무료 전용 키로 교체할 것.

### 4-5. 토큰 정상화 후 실제 드레인

P0 완료 후 1회 실행해 실제로 큐가 줄어드는지 본다.

```bash
launchctl start com.irichgreen.ytsummarizer
sleep 120
grep "pending 처리" ~/Library/Logs/irichgreen/ytsummarizer.log | tail -2
cat .quota_state.json      # date가 오늘, used가 0보다 커야 정상
```

`quota_state.json`의 `date`가 오늘로 갱신되고 `used`가 증가하면
**6월 7일 이후 처음으로 YouTube 쓰기가 성공한 것**이다. 이게 최종 확인 지표다.

## 5. 롤백

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
ls -t pending_playlist_adds.backup.*.json | head -1     # 최신 백업 확인
cp <위 백업파일> pending_playlist_adds.json
git checkout scheduler.js
```

`pending_playlist_adds.json`은 gitignore 대상이라 git으로 복구되지 않는다.
**P1 스크립트가 만든 백업 파일이 유일한 복구 수단이므로 지우지 말 것.**

## 6. 범위 밖 (이번엔 하지 않음)

- YouTube quota 증액 신청
- `scheduler.log` 20MB 로테이션 (별도 작업)
- dead-letter 항목의 사후 처리(재생목록 재생성 등)
- OAuth 토큰 만료 자동 감지·알림 — P4의 quota_state 경고로 우선 대체
- Gemini 키 로테이션 로직 변경

---

## 부록 — P0·P1 선행 완료 기록 (2026-08-17 16:57, Cowork 수행)

18:00 정규 실행 전에 중복이 재생목록으로 흘러드는 것을 막기 위해
**P0와 P1의 정리 작업은 이미 적용된 상태**다. Claude Code는 §2의 P1을
"이미 정리된 큐" 위에서 시작하게 된다.

### 완료된 것

| 항목 | 결과 |
|---|---|
| P0 OAuth 토큰 재발급 | 완료. `access_token` 획득 확인 |
| 큐 백업 | `pending_playlist_adds.backup.20260817-165737.json` (2.1MB) |
| 중복 제거 | 5,392 → 2,874 (-2,518) |
| dead-letter 격리 | -509건 → `pending_playlist_adds.dead.json` |
| **최종 큐** | **2,365건** (중복 잔존 0, 소진 예상 12.4일) |
| `.gitignore` 수정 | `pending_playlist_adds.json*` → `pending_playlist_adds*` |

### `.gitignore` 패턴 버그 (이번에 발견)

기존 패턴은 `.json` **뒤에만** 와일드카드가 붙어 있어
`pending_playlist_adds.dead.json`, `pending_playlist_adds.backup.*.json`을
잡지 못했다. 새 상태 파일을 만들면 그대로 커밋될 뻔했다.

```diff
- pending_playlist_adds.json*
+ pending_playlist_adds*
```

### Claude Code 작업 시 달라지는 점

- **§4-1의 기대 수치(5,392 → 2,365)는 이미 반영된 상태다.**
  `clean_pending_queue.js`를 dry-run 하면 "제거 대상 0건"이 정상이다.
  스크립트는 앞으로 재사용할 목적으로 여전히 작성한다.
- P2(`appendPending` 중복 방지), P3(dead-letter 분리), P4(적체 알림)는
  **미적용 상태이므로 지시서대로 진행할 것.** 특히 P2가 없으면 중복이 다시 쌓인다.
- 검증 §4-2, §4-3은 그대로 수행한다.
