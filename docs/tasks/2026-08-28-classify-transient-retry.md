# 토픽 분류의 일시적 서버 오류(503) 재시도 추가

- 작성: 2026-08-28 (Cowork)
- 대상: `scheduler.js` (분류 재시도 루프 1곳)
- 영역: **Node**
- 선행 커밋: `5c3a53e` (v2.7)

---

## 1. 배경

2026-08-28 06:00 실행에서 영상 1건이 분류 단계에서 떨어졌습니다.

```
06:00:57  ⚠️ Gemini API 에러 503 (Key: AIzaSyBy...Gvg5eE). 6초 대기 후 다음 키로 교체 시도... (시도: 1/8)
06:00:57     🔄 [API Key Rotation] Key #1 ➔ Key #2
06:01:11  ✓ 요약 무결성 검증 통과!                     ← 요약은 살아남음
...
06:01:25  ❌ 오류 (4년 동안 AI 책 100권 읽었습니다...):
          classifyTopics failed after 1 attempts: Gemini 503
          "This model is currently experiencing high demand." (UNAVAILABLE)
```

**같은 503인데 요약은 살고 분류는 죽습니다.** 대응이 비대칭입니다.

| 단계 | 재시도 | 503 대응 |
|---|---|---|
| 요약 (`scheduler.js:459`) | 8회 + 키 로테이션 + 대기 | 키 교체 후 성공 |
| 분류 (`scheduler.js:963`) | **사실상 0회** | 즉시 포기 |

원인은 `scheduler.js:965`의 재시도 조건입니다.

```js
if ((clsErr.message.includes('429') || clsErr.message.includes('Quota') || clsErr.message.includes('quota')) && keysCount > 1) {
```

**429/quota만 재시도 대상**이고 나머지는 전부 `throw`합니다. 503은 일시적 과부하라
키만 바꿔도 대개 통과하는데 이 분기에 안 걸립니다. `classifyTopics`는 `maxRetries: 0`으로
호출되므로(`:960`) 내부 재시도도 없습니다 — "failed after 1 attempts"가 그 뜻입니다.

데이터 유실은 없습니다. Notion 저장 전에 죽어서 다음 실행에 자동 회수됩니다.
다만 **매번 6시간을 버리고 로그에 ❌가 쌓입니다.**

### 함께 고치는 잠복 버그

```js
while (clsAttempt < maxClsAttempts) {
  try { cls = await classifier.classifyTopics(...); break; }
  catch (clsErr) { clsAttempt++; if (재시도조건) { ...; continue; } throw clsErr; }
}
const topics = cls.topics;   // ← cls 가 undefined 일 수 있다
```

마지막 시도가 `continue`로 끝나면 `while` 조건이 거짓이 되어 루프를 빠져나가는데,
이때 `cls`는 `undefined`입니다. 바로 다음 줄 `cls.topics`에서 **TypeError로 죽습니다.**
현재는 재시도 조건이 좁아 도달하지 못했을 뿐, 조건을 넓히면 바로 밟게 됩니다.
아래 TO-BE는 재시도 조건에 `clsAttempt < maxClsAttempts`를 넣어 이 경로를 막습니다.

---

## 2. 범위

`scheduler.js`의 **분류 재시도 catch 블록 하나만** 고칩니다.
`lib/classifier.js`, 요약 경로, 키 로테이션 함수, quota·큐 로직은 건드리지 않습니다.

---

## 3. AS-IS → TO-BE

### `scheduler.js` (963~974행) — 분류 재시도 catch 블록

**AS-IS**

```js
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
```

**TO-BE**

```js
          } catch (clsErr) {
            clsAttempt++;
            const msg = clsErr.message || '';
            const currentKey = getActiveGeminiKey();
            const maskedKey = currentKey ? `${currentKey.slice(0, 8)}...${currentKey.slice(-6)}` : '없음';

            // 인증·권한 오류는 재시도하지 않는다 (CLAUDE.md 보안 원칙 1).
            // 실패를 루프로 난사하면 구글이 어뷰징으로 판단한다.
            if (/\b(401|403)\b/.test(msg)) throw clsErr;

            // 429/quota — 키를 바꾸면 대개 즉시 통과하므로 짧게 대기
            const isRateLimit = msg.includes('429') || /quota/i.test(msg);
            // 5xx·UNAVAILABLE — 모델 과부하 등 일시적 서버 오류.
            // 요약 경로(:459)는 이미 이걸 재시도하는데 분류만 빠져 있었다.
            const isTransient = /\b(500|502|503|504)\b/.test(msg)
              || /UNAVAILABLE|overloaded|high demand/i.test(msg);

            if ((isRateLimit || isTransient) && clsAttempt < maxClsAttempts) {
              // 일시 오류는 지수 백오프 (보안 원칙 2). 상한 15초.
              const waitMs = isRateLimit ? 1000 : Math.min(2000 * 2 ** (clsAttempt - 1), 15000);
              log(`    ⏳ [분류 ${isRateLimit ? 'Rate Limit' : '일시 오류'}] ${msg.slice(0, 60)} (Key: ${maskedKey}). ${waitMs / 1000}초 대기 후 재시도... (시도: ${clsAttempt}/${maxClsAttempts})`);
              if (keysCount > 1) rotateGeminiKey();
              await new Promise(r => setTimeout(r, waitMs));
              continue;
            }
            throw clsErr;
          }
        }
        // 재시도를 모두 소진하면 cls 가 undefined 인 채로 루프를 빠져나온다.
        // 아래 cls.topics 에서 TypeError 로 죽는 것을 막는다.
        if (!cls) throw new Error(`classifyTopics: 재시도 ${maxClsAttempts}회 소진`);
```

> `}` 위치 주의 — `if (!cls)` 는 `while` 루프를 **닫은 뒤**, 기존 `const topics = cls.topics;`
> (976행) **바로 위**에 들어갑니다.

**설계 근거 4가지**

1. `keysCount > 1` 조건을 재시도 자체에서 뺐습니다. 키가 1개여도 **일시 오류는 대기 후 재시도할 가치**가 있습니다. 키 교체(`rotateGeminiKey()`)만 키가 여러 개일 때 수행합니다.
2. 401/403은 **명시적으로 먼저 차단**합니다. 기존에는 조건에 안 걸려 우연히 `throw`됐지만, 조건을 넓히는 김에 의도를 코드로 못박습니다.
3. Rate limit은 1초 고정(키 교체가 실효), 일시 오류는 지수 백오프 2→4→8→15초(상한). 최악의 경우 영상 1건당 약 74초이며, 이는 실제 장애 상황에서만 발생합니다.
4. `clsAttempt < maxClsAttempts` 가드로 마지막 실패가 `continue` 대신 `throw`가 되게 합니다. 잠복 TypeError 경로를 없앱니다.

`maxClsAttempts`는 `Math.max(3, keysCount * 2)`이므로 현재 키 4개 기준 **8회**입니다(`:952`). 변경 없습니다.

---

## 4. 검증

### 4-1. 문법

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node --check scheduler.js && echo "✅ 문법 OK"
```

### 4-2. 분기 판정 로직 (API 호출 없음)

실제 에러 문자열로 분기가 맞는지 확인합니다.

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const cases=[
 ['Gemini 503: {\"error\":{\"code\":503,\"status\":\"UNAVAILABLE\"}}','transient'],
 ['Gemini 500: internal','transient'],
 ['This model is currently experiencing high demand.','transient'],
 ['Gemini 429: rate limit','ratelimit'],
 ['Quota exceeded for quota metric','ratelimit'],
 ['Gemini 403: forbidden','abort'],
 ['Gemini 401: unauthorized','abort'],
 ['No JSON in response: garbage','abort'],
];
let bad=0;
for(const [msg,want] of cases){
  let got;
  if(/\\b(401|403)\\b/.test(msg)) got='abort';
  else if(msg.includes('429')||/quota/i.test(msg)) got='ratelimit';
  else if(/\\b(500|502|503|504)\\b/.test(msg)||/UNAVAILABLE|overloaded|high demand/i.test(msg)) got='transient';
  else got='abort';
  const okk=got===want; if(!okk)bad++;
  console.log(okk?'✅':'❌', got.padEnd(10), msg.slice(0,55));
}
console.log(bad?'❌ '+bad+'건 불일치':'✅ 8/8 통과');"
```

**기대 출력** — 마지막 줄 `✅ 8/8 통과`.
특히 **403/401이 `abort`** 이고(보안 원칙 1), **JSON 파싱 실패도 `abort`** 여야 합니다
(모델이 계속 같은 쓰레기를 뱉을 뿐이라 재시도 가치가 없음).

### 4-3. 백오프 간격

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const max=8; let total=0;
for(let a=1;a<max;a++){const w=Math.min(2000*2**(a-1),15000); total+=w; console.log('시도',a,'→',w/1000+'초');}
console.log('일시 오류 최악 누적:', total/1000+'초');"
```

**기대 출력** — `2, 4, 8, 15, 15, 15, 15초` / 누적 `74초`.

### 4-4. 잠복 TypeError 경로 차단

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && grep -n "if (!cls) throw" scheduler.js && grep -n "clsAttempt < maxClsAttempts" scheduler.js && echo "✅ 두 가드 모두 존재"
```

### 4-5. 범위 밖 무결성

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && \
printf "요약 경로 재시도   : %s\n" "$(grep -c 'Gemini API 에러' scheduler.js)" && \
printf "maxClsAttempts     : %s\n" "$(grep -c 'Math.max(3, keysCount \* 2)' scheduler.js)" && \
printf "classifyTopics호출 : %s\n" "$(grep -c 'maxRetries: 0' scheduler.js)" && \
printf "연속 실패 차단기   : %s\n" "$(grep -c 'consecutiveFail >= 10' scheduler.js)" && \
printf "consumeQuota ok    : %s\n" "$(grep -c \"consumeQuota(50, 'ok')\" lib/youtube_oauth.js)"
```

**기대 출력** — 전부 `1`.

---

## 5. 데몬 재기동

**불필요.** `scheduler.js`는 launchd가 매 실행 새 프로세스로 띄웁니다.
`server.js`는 상주하지만 이 코드를 로드하지 않습니다.

## 6. 실동작 확인

다음 503 발생 시 로그에 아래가 나오면 성공입니다.

```
⏳ [분류 일시 오류] Gemini 503: ... (Key: AIza...). 2초 대기 후 재시도... (시도: 1/8)
🏷  분류: [...] (conf=0.xx)
```

503은 산발적이라 재현을 기다릴 필요는 없습니다. §4-2 분기 판정이 통과하면 충분합니다.

## 7. 롤백

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
git checkout -- scheduler.js     # 커밋 전
git revert <커밋해시>             # 커밋 후
```

상태 파일 변경 없음.

## 8. 범위 밖 — 건드리지 말 것

- **`lib/classifier.js`** — `maxRetries` 기본값(2)·프롬프트·NFC 정규화·`allowedSet` 필터.
  `scheduler.js`가 `maxRetries: 0`으로 호출하는 것도 **의도된 설계**입니다(재시도는 바깥 루프가 담당, 키 교체를 위해).
- **요약 경로 재시도 (`:420`~`:459`)** — 이미 정상 동작합니다.
- **`maxClsAttempts` 계산식 (`:952`)** — 8회 유지.
- **quota·큐 안전장치 전부**, `todayKey()` PT 로직, v2.7 `ok`/`fail` 계상.
- **dead 539건 복구** — 별건.

## 9. 산출물 규칙

- `README.md` + `README.html` 양쪽 v2.7.1 Changelog 반영 (패치 단위)
- `CLAUDE.md` — "자주 깨지는 지점"에 **분류 경로의 일시 오류 재시도** 한 줄 추가 + 변경 이력
- `git push`는 사전 확인 후

## 10. 커밋 메시지

```
fix(classify): 토픽 분류의 일시적 서버 오류(5xx) 재시도 추가

요약 경로는 503에 키 로테이션 + 재시도로 대응하는데 분류 경로는
429/quota 만 재시도 대상이라 503 한 번에 영상이 떨어졌다.
2026-08-28 06:00 실행에서 실제 발생(classifyTopics failed after 1 attempts).

- 5xx / UNAVAILABLE / high demand 를 재시도 대상에 추가, 지수 백오프(2→15초 상한)
- 401/403 은 명시적으로 즉시 중단 (보안 원칙 1)
- 키가 1개여도 일시 오류는 재시도하도록 keysCount 조건을 키 교체에만 적용
- 재시도 소진 시 cls 가 undefined 인 채 cls.topics 로 진입하던 잠복
  TypeError 경로를 가드 2개로 차단

lib/classifier.js·요약 경로·quota·큐 로직은 변경 없음.
```
