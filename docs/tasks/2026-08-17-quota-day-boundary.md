# quota 일 경계를 태평양시(PT) 기준으로 교정

- 작성: 2026-08-17 (Cowork)
- 대상: `lib/youtube_oauth.js`, `scheduler.js`
- 영역: **Node**
- 선행 커밋: `a7ff77b` (문서/plist), `66ab4a2` (v2.5)

---

## 1. 배경

`.quota_state.json`의 일 경계가 **UTC**인데 YouTube 실제 quota 리셋은 **PT 자정(= KST 16:00)** 입니다.
UTC 자정은 KST 09:00이므로, 로컬 카운터가 구글보다 **7시간 먼저** 0으로 돌아갑니다.

결과적으로 **KST 09:00 ~ 16:00 구간**에서는

- 카운터: `used = 0` (새 날로 인식)
- 구글: 전날 사용량 유지

가 되어 `checkQuotaAvailable()`이 무조건 통과합니다. 이 구간의 스로틀은 사실상 무력하며,
실패 요청도 50유닛을 소비하므로 **소진된 quota에 계속 요청을 밀어넣게 됩니다.**

2026-08-17 실측 근거:

| 시각(KST) | 관측 |
|---|---|
| 17:03:40 | 구글 `403 quotaExceeded` — 실제 소진 |
| 18:00:27 | `.quota_state.json` = `{"date":"2026-08-17","used":200}` |
| 18:56 | 검증용 읽기 1건(1유닛)도 `quotaExceeded` 반송 |

카운터는 200유닛인데 구글은 소진 상태 — 두 값이 같은 "하루"를 세고 있지 않다는 증거입니다.

부수 문제로 `scheduler.js:1360`의 텔레그램 경고도 같은 UTC 키로 비교하므로,
KST 09:00~16:00 사이에는 정상 동작 중에도 `🛑 오늘 YouTube 쓰기 0건` 오경보가 발생합니다.

---

## 2. 범위

이 지시서는 **일 경계 계산만** 바꿉니다. 임계값(9,500)·소비량(50/1유닛)·큐 로직·차단기는 건드리지 않습니다.

---

## 3. AS-IS → TO-BE

### 3-1. `lib/youtube_oauth.js` (42~44행)

**AS-IS**

```js
function todayKey() {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD (UTC)
}
```

**TO-BE**

```js
// YouTube quota는 태평양시(PT) 자정에 리셋된다 (= KST 16:00, PDT 기준).
// UTC를 쓰면 KST 09:00에 카운터만 먼저 리셋돼 09:00~16:00 구간에서
// 스로틀이 무력화된다. DST(PDT/PST) 전환은 Intl이 처리한다.
// en-CA 로케일은 YYYY-MM-DD 형식을 준다.
const PT_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric', month: '2-digit', day: '2-digit',
});
function todayKey() {
  return PT_DATE_FMT.format(new Date());  // YYYY-MM-DD (PT)
}
```

### 3-2. `lib/youtube_oauth.js` — export 추가 (227~235행 `module.exports`)

`todayKey`를 추가합니다. scheduler가 같은 함수를 쓰게 해 키가 갈라지는 것을 막습니다.

```js
module.exports = {
  getAccessToken,
  listPlaylistItems,
  addToPlaylist,
  getQuotaUsed,
  checkQuotaAvailable,
  consumeQuota,
  loadQuotaState,
  todayKey,          // ← 추가
};
```

### 3-3. `scheduler.js` (1360행)

**AS-IS**

```js
      const today = new Date().toISOString().slice(0, 10);
```

**TO-BE**

```js
      const today = require('./lib/youtube_oauth').todayKey();
```

> 이미 `try { ... } catch {}` 안이므로 로드 실패 시 조용히 건너뜁니다. 별도 방어 불필요.

---

## 4. 검증

### 4-1. 키 계산 확인

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const yt=require('./lib/youtube_oauth');
console.log('PT key :', yt.todayKey());
console.log('UTC key:', new Date().toISOString().slice(0,10));
console.log('now KST:', new Date().toLocaleString('ko-KR',{timeZone:'Asia/Seoul'}));"
```

**기대 출력** — `PT key`가 `YYYY-MM-DD` 형식으로 나오면 성공.
KST 00:00~16:00 실행 시 `PT key`는 `UTC key`보다 **하루 이전**이어야 합니다.
KST 16:00~24:00에는 두 값이 같습니다. (실행 시각에 따라 달라지는 게 정상이며, 항상 같다면 실패입니다.)

### 4-2. 경계 동작 시뮬레이션 (실제 시계 변경 없이)

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const f=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'});
for(const kst of ['2026-08-17T08:59','2026-08-17T09:01','2026-08-17T15:59','2026-08-17T16:01']){
  const d=new Date(kst+':00+09:00');
  console.log('KST',kst,'→ PT',f.format(d));
}"
```

**기대 출력**

```
KST 2026-08-17T08:59 → PT 2026-08-16
KST 2026-08-17T09:01 → PT 2026-08-16
KST 2026-08-17T15:59 → PT 2026-08-16
KST 2026-08-17T16:01 → PT 2026-08-17
```

09:01에도 `2026-08-16`이 유지되고 **16:01에만 날짜가 바뀌면 교정 성공**입니다.
(수정 전이라면 09:01에서 이미 `2026-08-17`로 넘어갑니다.)

### 4-3. 상태 파일 연속성 확인

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && cat .quota_state.json && node -e "
const yt=require('./lib/youtube_oauth');
const s=yt.loadQuotaState();
console.log('loadQuotaState →', JSON.stringify(s));
console.log(s.used>0?'✅ 기존 사용량 유지':'⚠️ used=0 — 날짜키가 바뀌며 리셋됨(경계 넘었으면 정상)');"
```

**주의** — 이 작업을 KST 16:00 **이전**에 적용하면 PT 날짜가 하루 이전이 되면서
`loadQuotaState()`가 `date` 불일치로 `used`를 0으로 되돌립니다. 이는 의도된 동작이지만,
그 시점에 이미 구글 quota가 소진돼 있으면 스로틀이 다시 눈을 감습니다.
**적용은 KST 16:00 이후에 하는 것을 권장합니다.**

### 4-4. 텔레그램 오경보 확인

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && grep -n "todayKey\|toISOString().slice(0, *10)" scheduler.js lib/youtube_oauth.js
```

**기대 출력** — `lib/youtube_oauth.js`의 `PT_DATE_FMT` 정의부와 `scheduler.js`의 `todayKey()` 호출만 나오고,
`toISOString().slice(0, 10)` 잔존이 **0건**이어야 합니다.

### 4-5. 문법 검사

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node --check scheduler.js && node --check lib/youtube_oauth.js && echo "✅ 문법 OK"
```

---

## 5. 데몬 재기동

**재기동 불필요.** 근거 2가지 — 2026-08-17 확인 완료:

- `scheduler.js`는 launchd가 매 실행마다 새 프로세스로 띄우므로 다음 정규 실행(00/06/12/18시)에 자동 반영됩니다.
- `server.js`는 상주 데몬이지만 `lib/youtube_oauth`를 **로드하지 않습니다**(`grep -n "youtube_oauth" server.js` → 0건). 이번 변경이 닿지 않습니다.

작업 후 위 전제가 여전한지만 재확인하세요:

```bash
grep -c "youtube_oauth" /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap/server.js
```

`0`이 아니면 상주 데몬을 재기동해야 합니다:

```bash
launchctl unload ~/Library/LaunchAgents/com.irichgreen.server.plist
launchctl load  ~/Library/LaunchAgents/com.irichgreen.server.plist
launchctl list | grep com.irichgreen.server
```

---

## 6. 롤백

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
git checkout -- lib/youtube_oauth.js scheduler.js     # 커밋 전
git revert <커밋해시>                                  # 커밋 후
```

`.quota_state.json`은 코드가 자동 재생성하므로 별도 복구 불필요. 상태가 꼬이면 삭제하면 됩니다
(단, 삭제 시 그날 사용량 추적이 0부터 다시 시작하므로 **KST 16:00 이후에만** 삭제할 것).

---

## 7. 범위 밖 — 건드리지 말 것

- **큐 안전장치 전부** — 중복 방지(`scheduler.js:1020`), 연속 실패 10회 차단기(`:807`),
  dead-letter 격리(`:813`), `retryCount` 5회. v2.5의 핵심이며 이번 변경과 무관합니다.
- **`QUOTA_THRESHOLD` 9,500 / 버퍼 500 / `consumeQuota(50)`** — 값 조정 금지.
- **`wiki_config.py:68`의 `time.strftime('%Y-%m-%d')`** — Gemini 230 RPD용이며 YouTube quota와
  별개 체계입니다. 로컬시(KST) 기준이 맞으므로 **이번 작업에서 제외**합니다.
- **OAuth 계정 일치 문제** — 2026-08-17 17:43에 토큰을 재발급했으나 quota 소진으로 검증 미완입니다.
  **2026-08-18 16:00 이후** `CLAUDE.md` §"OAuth 계정 일치 검증"을 별도로 실행하세요. 이 지시서와 무관합니다.
- **dead 509건 복구** — 별건. 계정 일치 검증 통과 후에 판단합니다.

---

## 8. 커밋

```
fix(quota): 일 경계를 UTC → 태평양시(PT)로 교정

.quota_state.json의 날짜 키가 UTC라 KST 09:00에 리셋되는 반면
YouTube 실제 quota는 PT 자정(KST 16:00)에 리셋된다. 이 7시간 동안
카운터가 0으로 보여 checkQuotaAvailable()이 무력화되고, 실패 요청도
50유닛을 소비하므로 소진된 quota에 계속 요청을 밀어넣었다.

- lib/youtube_oauth.js: todayKey()를 Intl 기반 PT 날짜로 변경, export 추가
- scheduler.js:1360: 동일 키를 쓰도록 todayKey() 호출로 교체
  (KST 09:00~16:00 텔레그램 오경보 제거)

DST 전환은 Intl이 처리. 임계값·소비량·큐 로직은 변경 없음.
```

`git push`는 사전 확인 후 실행합니다.
