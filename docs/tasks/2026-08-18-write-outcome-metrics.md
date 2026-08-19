# 재생목록 쓰기 성공/실패 계측 + 텔레그램 알림 교정 (v2.7)

- 작성: 2026-08-18 (Cowork)
- 대상: `lib/youtube_oauth.js`, `scheduler.js`
- 영역: **Node**
- 선행 커밋: `99bdcc7` (v2.6 문서), `7eb112c` (v2.6 코드)

---

## 1. 배경

**아무도 재생목록 쓰기 "성공 횟수"를 세고 있지 않습니다.** `.quota_state.json`은
`{date, used}`뿐이고 `used`는 성공·실패를 구분하지 않습니다. 여기서 두 가지 증상이 나옵니다.

### 증상 A — "전부 실패한 날"을 경고가 못 잡는다

`scheduler.js:1360`의 경고 조건은 이렇습니다.

```js
if (qs.date !== today) queueLines.push(`🛑 오늘 YouTube 쓰기 0건 ...`);
```

`date`가 오늘이 아닐 때만 발화합니다. 그런데 v2.5에서 **실패 요청도 `consumeQuota(50)`을 타게**
되면서, 실패만 해도 `date`가 오늘로 찍힙니다. 결과적으로 이 경고는 "한 번도 **시도조차** 안 한 날"만
잡고, "시도했는데 **전부 실패**한 날"은 구조적으로 감지하지 못합니다.

2026-08-17 실측: 197건 연속 `403 playlistItemsNotAccessible`이 났는데 🛑은 뜨지 않았습니다.
울린 것은 `⚠️ 큐 적체`뿐이었고, 이건 간접 신호라 원인을 지목하지 못합니다.
**이 구멍이 3개월간 큐가 5,392건까지 쌓이도록 방치된 원인입니다.**

참고 — 토큰 만료(`invalid_grant`)는 요청 자체가 나가지 않아 `date`가 안 찍히므로 🛑이 정상 발화합니다.
못 잡는 것은 **"인증은 되는데 쓰기만 전부 실패"** 하나뿐이며, 그게 정확히 계정 불일치 시나리오입니다.

### 증상 B — 성공한 날에도 성과가 안 보인다

2026-08-18 18:00 실행에서 큐 **190건이 3개월 만에 정상 배수**됐는데, 텔레그램 메시지에는
그 사실이 한 글자도 없습니다. 대신 이렇게만 나갔습니다.

```
⏳ 재생목록 대기: 2,234건 (소진 예상 11.8일)
⚠️ 큐 적체 — 원인 확인 필요
```

잔량만 세고 배수량을 안 세기 때문입니다. 앞으로 2주간 큐가 빠지는 것을 지켜봐야 하는데,
현재 알림으로는 진척을 확인할 수단이 없습니다.

### 증상 C — 소진 예상일이 유입을 무시한다

`(pendingCount / 190)`으로 계산해 `11.8일`이 나오지만, 매 실행마다 신규 영상의 토픽이
큐에 새로 적재됩니다. 2026-08-18 실측:

```
전날 잔량 2,367 − 배수 190 + 신규 유입 57 = 2,234   ← 실제 큐와 정확히 일치
순감 = 190 − 57 = 133건/일
2,234 ÷ 133 ≈ 16.8일   (표시값 11.8일의 약 1.4배)
```

유입 57건은 12:00 실행분 24건 + 18:00 실행분 33건입니다.

---

## 2. 범위

`.quota_state.json`에 **성공/실패 카운터를 추가**하고, 텔레그램 알림 3줄을 고칩니다.
quota 임계값(9,500)·소비량(50/1유닛)·일 경계(PT)·큐 안전장치는 **일절 건드리지 않습니다.**

---

## 3. AS-IS → TO-BE

### 3-1. `lib/youtube_oauth.js` — `loadQuotaState()` (54~60행)

기존 파일에는 `ok`/`fail`이 없으므로 **읽을 때 0으로 채워 하위호환**을 유지합니다.

**AS-IS**

```js
function loadQuotaState() {
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_STATE_PATH, 'utf-8'));
    if (j.date !== todayKey()) return { date: todayKey(), used: 0 };
    return j;
  } catch { return { date: todayKey(), used: 0 }; }
}
```

**TO-BE**

```js
// ok/fail 은 v2.7 추가. 기존 파일에 없으면 0으로 채운다(하위호환).
// 날짜가 바뀌면 used 와 함께 ok/fail 도 같이 리셋된다.
function emptyQuotaState() {
  return { date: todayKey(), used: 0, ok: 0, fail: 0 };
}

function loadQuotaState() {
  try {
    const j = JSON.parse(fs.readFileSync(QUOTA_STATE_PATH, 'utf-8'));
    if (j.date !== todayKey()) return emptyQuotaState();
    return { ok: 0, fail: 0, ...j };
  } catch { return emptyQuotaState(); }
}
```

> `{ ok: 0, fail: 0, ...j }` 순서가 중요합니다. 스프레드가 뒤에 와야 파일에 값이 있을 때 그 값이 이깁니다.

### 3-2. `lib/youtube_oauth.js` — `consumeQuota()` (66~71행)

**AS-IS**

```js
function consumeQuota(units) {
  const s = loadQuotaState();
  s.used += units;
  saveQuotaState(s);
  return s;
}
```

**TO-BE**

```js
// outcome: 'ok' | 'fail' | undefined
//   재생목록 쓰기(playlistItems.insert)만 성공/실패를 계상한다.
//   읽기(list)는 outcome 없이 호출해 used 에만 반영한다.
function consumeQuota(units, outcome) {
  const s = loadQuotaState();
  s.used += units;
  if (outcome === 'ok') s.ok += 1;
  else if (outcome === 'fail') s.fail += 1;
  saveQuotaState(s);
  return s;
}
```

> 인자를 뒤에 **추가만** 했으므로 기존 `consumeQuota(1)` 호출은 그대로 동작합니다.
> `migrate_classify.js`는 `loadQuotaState().used`만 읽으므로 영향 없습니다(`:290`, `:368`).

### 3-3. `lib/youtube_oauth.js` — `addToPlaylist()` 성공 경로 (214~217행)

**AS-IS**

```js
  if (res.status === 200 || res.status === 201) {
    consumeQuota(50);
    return { ok: true, item: res.data };
  }
```

**TO-BE**

```js
  if (res.status === 200 || res.status === 201) {
    consumeQuota(50, 'ok');
    return { ok: true, item: res.data };
  }
```

### 3-4. `lib/youtube_oauth.js` — `addToPlaylist()` 실패 경로 (225행)

**AS-IS**

```js
  consumeQuota(50);
```

**TO-BE**

```js
  consumeQuota(50, 'fail');
```

> 바로 위 주석 블록(219~224행)은 그대로 둡니다.

### 3-5. `scheduler.js` — 텔레그램 큐 블록 (1352~1363행)

**AS-IS**

```js
  const pendingCount = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'pending_playlist_adds.json'), 'utf-8')).length; } catch { return 0; }
  })();
  if (pendingCount > 0) {
    queueLines.push(`⏳ 재생목록 대기: ${fmtNum(pendingCount)}건 (소진 예상 ${(pendingCount / 190).toFixed(1)}일)`);
    if (pendingCount >= 1000) queueLines.push(`⚠️ 큐 적체 — 원인 확인 필요`);
    try {
      const qs = JSON.parse(fs.readFileSync(path.join(__dirname, '.quota_state.json'), 'utf-8'));
      const today = require('./lib/youtube_oauth').todayKey();
      if (qs.date !== today) queueLines.push(`🛑 오늘 YouTube 쓰기 0건 — quota_state 마지막 갱신 ${qs.date}`);
    } catch {}
  }
```

**TO-BE**

```js
  // 큐 파일을 한 번만 읽어 잔량과 오늘 유입을 함께 구한다.
  const queueSnapshot = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'pending_playlist_adds.json'), 'utf-8')); } catch { return []; }
  })();
  const pendingCount = queueSnapshot.length;

  if (pendingCount > 0) {
    const yt = require('./lib/youtube_oauth');
    const today = yt.todayKey();
    const qs = yt.loadQuotaState();          // ok/fail 이 없으면 0으로 채워져 온다
    const ok = qs.ok || 0, fail = qs.fail || 0;

    // ── 오늘 쓰기 결과 ──
    if (ok > 0) {
      queueLines.push(`✅ 재생목록 추가: ${fmtNum(ok)}건${fail ? ` (실패 ${fmtNum(fail)}건)` : ''}`);
    } else if (fail > 0) {
      // 인증은 되는데 쓰기만 전부 실패 — 계정 불일치·권한 문제의 신호
      queueLines.push(`🛑 오늘 재생목록 추가 전부 실패 (${fmtNum(fail)}건) — OAuth 계정 일치 확인 필요`);
    } else if (qs.date !== today) {
      queueLines.push(`🛑 오늘 YouTube 쓰기 시도 없음 — quota_state 마지막 갱신 ${qs.date}`);
    }

    // ── 잔량 + 오늘 유입 ──
    //   ts 는 appendPending 이 찍는 UTC ISO 문자열이므로 UTC 날짜로 맞춰 센다.
    const utcToday = new Date().toISOString().slice(0, 10);
    const inflow = queueSnapshot.filter(x => String(x.ts || '').slice(0, 10) === utcToday).length;
    const net = ok - inflow;
    const eta = net > 0 ? ` · 순감 ${fmtNum(net)}/일 → 약 ${(pendingCount / net).toFixed(1)}일` : '';
    queueLines.push(`⏳ 재생목록 대기: ${fmtNum(pendingCount)}건 (오늘 유입 +${fmtNum(inflow)}${eta})`);
    if (net <= 0 && ok > 0) queueLines.push(`⚠️ 유입이 배수보다 많음 — 큐가 줄지 않습니다`);

    if (pendingCount >= 1000) queueLines.push(`⚠️ 큐 적체 — 원인 확인 필요`);
  }
```

**설계 근거 3가지**

1. 기존 `try/catch`가 `loadQuotaState()` 안에 이미 있어 바깥 `try`가 불필요해졌습니다.
   `loadQuotaState()`는 파일이 없거나 깨져도 기본값을 돌려주므로 던지지 않습니다.
2. 소진 예상일을 **`net > 0`일 때만** 붙입니다. 순증 중일 때 "N일 후 소진"은 거짓말입니다.
3. `ts`가 UTC ISO라 유입 집계도 UTC 날짜로 맞춥니다. PT 기준 `todayKey()`와 경계가 다르지만,
   유입은 추정치이고 두 기준을 섞으면 오히려 어긋나므로 **ts와 같은 기준**을 씁니다.

---

## 4. 검증

### 4-1. 문법 검사

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node --check scheduler.js && node --check lib/youtube_oauth.js && echo "✅ 문법 OK"
```

### 4-2. 하위호환 — 기존 상태 파일을 깨지 않는가

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && cp .quota_state.json /tmp/qs.bak && node -e "
const yt=require('./lib/youtube_oauth');
const s=yt.loadQuotaState();
console.log('loadQuotaState →', JSON.stringify(s));
console.log(typeof s.ok==='number'&&typeof s.fail==='number'?'✅ ok/fail 채워짐':'❌ 실패');
console.log(s.used===9500?'✅ 기존 used 보존':'⚠️ used='+s.used+' (PT 날짜 경계를 넘었으면 정상)');"
```

**기대 출력** — `ok`/`fail`이 숫자로 나오고, PT 기준 같은 날이면 `used: 9500`이 보존됩니다.

### 4-3. 카운터 증가 (실제 API 호출 없이)

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const yt=require('./lib/youtube_oauth');
const b=yt.loadQuotaState();
yt.consumeQuota(0,'ok'); yt.consumeQuota(0,'fail'); yt.consumeQuota(0);
const a=yt.loadQuotaState();
console.log('before', JSON.stringify(b));
console.log('after ', JSON.stringify(a));
console.log(a.ok===b.ok+1&&a.fail===b.fail+1&&a.used===b.used?'✅ ok+1 fail+1 used불변':'❌ 실패');"
```

`units=0`이라 **quota를 전혀 소비하지 않고** 카운터 동작만 확인합니다.
확인 후 아래로 원상복구하세요.

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && cp /tmp/qs.bak .quota_state.json && cat .quota_state.json
```

### 4-4. 텔레그램 문구 3분기 (파일을 건드리지 않는 드라이런)

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const fmtNum=n=>n.toLocaleString('ko-KR');
const q=JSON.parse(require('fs').readFileSync('pending_playlist_adds.json'));
const utcToday=new Date().toISOString().slice(0,10);
const inflow=q.filter(x=>String(x.ts||'').slice(0,10)===utcToday).length;
for(const [label,qs] of [
  ['정상 배수', {date:'X',ok:190,fail:0}],
  ['전부 실패', {date:'X',ok:0,fail:197}],
  ['시도 없음', {date:'Y',ok:0,fail:0}],
]){
  const L=[];
  const ok=qs.ok,fail=qs.fail;
  if(ok>0) L.push(\`✅ 재생목록 추가: \${fmtNum(ok)}건\${fail?\` (실패 \${fmtNum(fail)}건)\`:''}\`);
  else if(fail>0) L.push(\`🛑 오늘 재생목록 추가 전부 실패 (\${fmtNum(fail)}건) — OAuth 계정 일치 확인 필요\`);
  else if(qs.date!=='X') L.push(\`🛑 오늘 YouTube 쓰기 시도 없음 — quota_state 마지막 갱신 \${qs.date}\`);
  const net=ok-inflow;
  const eta=net>0?\` · 순감 \${fmtNum(net)}/일 → 약 \${(q.length/net).toFixed(1)}일\`:'';
  L.push(\`⏳ 재생목록 대기: \${fmtNum(q.length)}건 (오늘 유입 +\${fmtNum(inflow)}\${eta})\`);
  if(net<=0&&ok>0) L.push('⚠️ 유입이 배수보다 많음 — 큐가 줄지 않습니다');
  console.log('── '+label); console.log(L.join('\n')); console.log();
}"
```

**기대 출력** — 세 분기가 각각 이렇게 나와야 합니다 (숫자는 당일 큐 상태에 따라 달라짐).

```
── 정상 배수
✅ 재생목록 추가: 190건
⏳ 재생목록 대기: 2,234건 (오늘 유입 +57 · 순감 133/일 → 약 16.8일)

── 전부 실패
🛑 오늘 재생목록 추가 전부 실패 (197건) — OAuth 계정 일치 확인 필요
⏳ 재생목록 대기: 2,234건 (오늘 유입 +57)

── 시도 없음
🛑 오늘 YouTube 쓰기 시도 없음 — quota_state 마지막 갱신 Y
⏳ 재생목록 대기: 2,234건 (오늘 유입 +57)
```

**핵심 확인 2가지** — ① "전부 실패" 분기에서 🛑이 **뜬다**(현재 코드는 안 뜸).
② 순증/실패 시 소진 예상일이 **안 붙는다**.

### 4-5. 잔존 확인

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && grep -n "pendingCount / 190\|쓰기 0건" scheduler.js || echo "✅ 구 로직 잔존 0건"
```

---

## 5. 데몬 재기동

**불필요.** `scheduler.js`는 launchd가 매 실행 새 프로세스로 띄웁니다.
`server.js`는 상주하지만 `lib/youtube_oauth`를 로드하지 않습니다(2026-08-17 확인, `grep -c` → 0).
작업 후 전제만 재확인하세요.

```bash
grep -c "youtube_oauth" /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap/server.js
```

`0`이 아니면 재기동합니다.

```bash
launchctl unload ~/Library/LaunchAgents/com.irichgreen.server.plist
launchctl load  ~/Library/LaunchAgents/com.irichgreen.server.plist
```

---

## 6. 실동작 확인 시점

다음 정규 실행(**00:00 / 06:00 / 12:00 / 18:00**)의 텔레그램 메시지에
`✅ 재생목록 추가: N건` 줄이 나오면 성공입니다.

단, **PT 자정(KST 16:00) 이후의 실행에서만 의미 있는 숫자**가 나옵니다.
16:00 이전 실행은 전날 quota를 이어받아 배수가 0건일 수 있으며, 그때는
`🛑 오늘 재생목록 추가 전부 실패`가 뜰 수 있습니다 — **이건 오경보가 아니라 사실입니다**
(quota 소진으로 시도했으나 실패). 하루 한 번 16:00 이후 실행에서 `✅`가 뜨는지로 판단하세요.

---

## 7. 롤백

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
git checkout -- lib/youtube_oauth.js scheduler.js     # 커밋 전
git revert <커밋해시>                                  # 커밋 후
cp /tmp/qs.bak .quota_state.json                       # 상태 파일 복구
```

`.quota_state.json`에 `ok`/`fail`이 남아 있어도 **구 코드는 그 필드를 무시**하므로 안전합니다.

---

## 8. 범위 밖 — 건드리지 말 것

- **큐 안전장치 전부** — 중복 방지(`scheduler.js:1020`), 연속 실패 10회 차단기(`:807`),
  dead-letter 격리(`:813`), `retryCount` 5회.
- **`QUOTA_THRESHOLD` 9,500 / 버퍼 500 / `consumeQuota` 유닛 수(50·1)** — 값 조정 금지.
- **`todayKey()` PT 로직 (v2.6)** — 이번 작업의 전제입니다. 그대로 둡니다.
- **`listPlaylistItems`의 `consumeQuota(1)`** — 읽기는 성공/실패 계상 대상이 아닙니다.
- **dead 509건 복구** — 별건. 계정 검증은 2026-08-18 22:35에 통과(33/33 일치)했으므로
  이제 착수 가능하지만 **이 지시서와 무관**합니다.
- **`scheduler.log` 로테이션** — 별건. 현재 20MB.

---

## 9. 산출물 규칙

- `README.md` + `README.html` **양쪽** v2.7 Changelog 반영
- `CLAUDE.md` — quota 절에 `.quota_state.json` 스키마가 `{date, used, ok, fail}`로 넓어졌음을
  기재하고, 하단 변경 이력에 v2.7 항목 추가. 버전 헤더도 v2.7로.
- `git push`는 사전 확인 후 실행

## 10. 커밋 메시지

```
feat(alert): 재생목록 쓰기 성공/실패 계측 및 텔레그램 알림 교정

.quota_state.json 이 성공/실패를 구분하지 않아 두 가지 문제가 있었다.
(1) 경고 조건이 date !== today 라, v2.5 이후 실패도 date 를 찍으면서
    "시도했으나 전부 실패한 날"을 구조적으로 감지하지 못했다.
    2026-08-17 197건 연속 403 때 🛑 이 뜨지 않았다.
(2) 배수량을 세지 않아 2026-08-18 의 190건 정상 배수가 알림에 드러나지 않았다.

- lib/youtube_oauth.js: quota state 에 ok/fail 추가(하위호환 기본값 0),
  consumeQuota(units, outcome) 로 확장, addToPlaylist 양쪽 경로에서 계상
- scheduler.js: 쓰기 결과 3분기 표시, 오늘 유입 집계 후 순감 기준으로
  소진 예상일 계산(순증이면 미표시)

임계값·유닛 수·일 경계(PT)·큐 안전장치는 변경 없음.
```
