# 작업지시서 — scheduler.js에 카카오톡 →「AI 꿀팁」인제스트 훅 추가 (v3.0)

작성일: 2026-09-06 · 대상: Claude Code · 영역: **Node (`scheduler.js`)**
선행 작업: `docs/tasks/2026-09-06-kakao-tips-ingest.md` (Python 쪽은 Cowork에서 완료·검증됨)

> 이 파일을 읽고 그대로 실행한다. 범위 밖 항목은 손대지 않는다.

---

## 1. 배경

v2.8에서 Python 쪽 파이프라인이 완성됐다.

| 파일 | 상태 |
|---|---|
| `kakao_ingest.py` | 완료. `--apply --if-new` 로 호출하면 최신 `KakaoTalk_Chat_안진훈_*.csv` 를 찾아 신규 링크만 Notion「AI 꿀팁」에 생성하고, 마지막 줄에 `RESULT_JSON:{...}` 를 찍는다. 같은 CSV(mtime 동일)는 `.kakao_state.json` 을 보고 Notion 조회 없이 즉시 종료한다. |
| `lib/kakao_parse.py`, `lib/tips_notion.py` | 완료. 멱등성(같은 CSV 2회 실행 → 0건), 생성 경로(테스트 행 생성→아카이브), `/opt/homebrew/bin/python3` 3.14 SSL 동작 모두 검증됨. |
| `sync_obsidian.py` | 완료. `sync_tips()` 가 「AI 꿀팁」DB → `VAULT/AI 꿀팁/*.md` 신규 노트를 만들고 `RESULT_JSON.tips_added` 를 돌려준다. |

**남은 것은 `scheduler.js` 가 Obsidian 동기화 직전에 `kakao_ingest.py` 를 호출하고, 텔레그램 요약에 꿀팁 건수를 싣는 것뿐이다.**
그러면 6시간마다(00/06/12/18시) 다음이 자동으로 돈다:

```
scheduler.js
  ├ YouTube 마스터 인제스트 → Notion 영상 DB           (기존)
  ├ kakao_ingest.py --apply --if-new → Notion「AI 꿀팁」 (신규 — 이 지시서)
  └ sync_obsidian.py → 영상 노트 + 꿀팁 노트 → wiki_ingest → MOC (기존 + v2.8)
```

## 2. 설계 원칙 (지키지 않으면 되돌린다)

1. **카톡 단계 실패가 Obsidian 동기화를 막으면 안 된다.** `runKakaoIngest()` 는 절대 reject 하지 않고 `null` 을 돌려준다.
2. **Notion 401/403 이면 즉시 중단.** `kakao_ingest.py` 가 exit 2 + `RESULT_JSON.error === 'auth'` 로 알려준다. scheduler는 로그만 남기고 다음 단계로 간다. 재시도 금지.
3. 인터프리터는 기존 Obsidian 동기화와 같은 **`/opt/homebrew/bin/python3`** (1420행 `python3` 상수 재사용).
4. `RESULT_JSON:` 파싱 규약은 `sync_obsidian.py` 와 동일하게 `stdout.split('\n').find(l => l.startsWith('RESULT_JSON:'))`.
5. 텔레그램은 **기존 1개 메시지에 섹션 추가**. 메시지를 하나 더 만들지 않는다.

## 3. AS-IS → TO-BE

### 3-1. 헬퍼 함수 추가 — `sendTelegram` 정의(79행 근처) 아래 아무 곳

```js
// ── (v3.0) 카카오톡 → Notion「AI 꿀팁」 ──
// kakao_ingest.py --apply --if-new 실행. 새 CSV 가 없으면 Python 쪽이 즉시 종료한다.
// 실패해도 reject 하지 않는다 — 카톡 단계가 Obsidian 동기화를 막으면 안 된다.
function runKakaoIngest(python3) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const script = path.join(__dirname, 'kakao_ingest.py');
    if (!fs.existsSync(script)) { log('ℹ️  kakao_ingest.py 없음 — 건너뜀'); return resolve(null); }
    execFile(python3, [script, '--apply', '--if-new'], { cwd: __dirname, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        let r = null;
        const line = String(stdout || '').split('\n').find(l => l.startsWith('RESULT_JSON:'));
        if (line) { try { r = JSON.parse(line.slice('RESULT_JSON:'.length)); } catch (e) { log(`⚠️ 카톡 결과 파싱 오류: ${e.message}`); } }
        if (r && r.error === 'auth') {
          log('🛑 카톡 인제스트: Notion 401/403 — 연쇄 요청 없이 이번 실행은 건너뜀 (토큰·DB 연결 확인 필요)');
        } else if (err) {
          log(`⚠️ 카톡 인제스트 오류 (exit ${err.code}): ${String(stderr || '').slice(-300)}`);
        } else if (r && r.skipped) {
          log(`ℹ️  카톡 인제스트 건너뜀: ${r.skipped}${r.csv ? ` (${r.csv})` : ''}`);
        } else if (r) {
          log(`📎 카톡 인제스트: 신규 ${r.created}건 / 후보 ${r.candidates}건 · DB 총 ${r.db_total}건`);
        }
        resolve(r);
      });
  });
}
```

`fs` 와 `path` 는 파일 상단에 이미 require 되어 있는지 확인하고, 없으면 추가한다.

### 3-2. 호출 지점 — Obsidian 동기화 직전 (현재 1416~1423행)

AS-IS
```js
  await sendEmail(`[YouTube 요약] 완료 - 저장 ${totalSaved}개`, msg);

  // ── Obsidian 동기화 (항상 실행 - 노션+Obsidian 결과 합쳐서 1개 메시지 전송) ──
  log('\n🔄 Obsidian 동기화 시작...');
  const { execFile } = require('child_process');
  const python3 = '/opt/homebrew/bin/python3';
  const syncScript = path.join(__dirname, 'sync_obsidian.py');
```

TO-BE
```js
  await sendEmail(`[YouTube 요약] 완료 - 저장 ${totalSaved}개`, msg);

  const python3 = '/opt/homebrew/bin/python3';

  // ── (v3.0) 카카오톡 → Notion「AI 꿀팁」 (새 CSV 있을 때만 실제 동작) ──
  log('\n📎 카톡 → AI 꿀팁 인제스트...');
  const kakao = await runKakaoIngest(python3);
  const kakaoCreated = (kakao && kakao.created) || 0;

  // ── Obsidian 동기화 (항상 실행 - 노션+Obsidian 결과 합쳐서 1개 메시지 전송) ──
  log('\n🔄 Obsidian 동기화 시작...');
  const { execFile } = require('child_process');
  const syncScript = path.join(__dirname, 'sync_obsidian.py');
```

(`const python3` 를 위로 올린 것뿐이다. 아래에서 중복 선언되지 않게 원래 줄은 지운다.)

### 3-3. 텔레그램 섹션 — `obsSection` 조립부 (현재 1436~1444행)

AS-IS
```js
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
```

TO-BE
```js
        const tipsAdded = r.tips_added || 0;
        const kakaoSection = kakaoCreated > 0 ? [
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━`,
          `📎 카톡 → AI 꿀팁`,
          `  • Notion 신규: ${kakaoCreated}건 (DB 총 ${kakao.db_total}건)`,
          ...(Array.isArray(kakao.titles) ? kakao.titles.slice(0, 5).map(t => `    - ${t}`) : []),
        ] : [];
        const obsSection = [
          ...kakaoSection,
          ``,
          `━━━━━━━━━━━━━━━━━━━━━━`,
          `📓 Obsidian AI LLM Wiki`,
          `  • 신규 영상 노트: ${r.added - tipsAdded}개`,
          ...(tipsAdded > 0 ? [`  • 신규 꿀팁 노트: ${tipsAdded}개`] : []),
          ...(r.tags_updated > 0 ? [`  • tags 갱신: ${r.tags_updated}개`] : []),
          `  • Wiki 재구성: ${r.rebuilt ? '✅ 완료' : '⏭ 생략'}`,
          `  • 소요시간: ${r.elapsed}초`,
        ].join('\n');
        log(`✅ Obsidian 동기화 완료! 추가: ${r.added}개 (꿀팁 ${tipsAdded})`);

        const hasNewOrUpdated = totalSaved > 0 || kakaoCreated > 0 || (r.added && r.added > 0) || (r.tags_updated && r.tags_updated > 0);
```

### 3-4. 파일 상단 주석 — 버전 표기가 있으면 `v3.0` 으로

## 4. 검증

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
node --check scheduler.js && echo SYNTAX_OK

# 카톡 단계 단독 확인 (Notion 조회 없이 스킵되어야 정상 — 오늘 CSV 는 이미 처리됨)
/opt/homebrew/bin/python3 kakao_ingest.py --apply --if-new | tail -1
# 기대: RESULT_JSON:{"skipped": "already_processed", ...}

# 스케줄러 1회 수동 실행 후 로그 확인 (YouTube quota 를 쓰므로 16:00 리셋 이후 권장)
launchctl start com.irichgreen.ytsummarizer
sleep 120; grep -E "카톡|꿀팁|Obsidian 동기화" scheduler.log | tail -8
# 기대:
#   📎 카톡 → AI 꿀팁 인제스트...
#   ℹ️  카톡 인제스트 건너뜀: already_processed (KakaoTalk_Chat_안진훈_….csv)
#   🔄 Obsidian 동기화 시작...
#   ✅ Obsidian 동기화 완료! 추가: N개 (꿀팁 0)
```

새 CSV 로 끝까지 검증하려면: 카톡 '나와의 채팅' → 대화 내보내기 → `~/Downloads` 에 새 파일이 생기면 다음 스케줄에서 자동 처리된다. 텔레그램에 `📎 카톡 → AI 꿀팁` 섹션이 나오면 성공.

## 5. 데몬 재기동

`scheduler.js` 는 launchd 가 매 실행마다 새로 띄우므로 **재기동 불필요.**
`com.irichgreen.server` 는 이번 변경과 무관 — 건드리지 않는다.

## 6. 산출물·커밋

1. `README.md` — Cowork 가 v3.0 으로 이미 갱신했다. 훅 구현 후 `scheduler.js` 관련 문구가 실제와 다르면 그 부분만 고친다.
2. **`README.html` 은 삭제됐고 앞으로 만들지 않는다** (CLAUDE.md 산출물 규칙 갱신됨).
3. 커밋 메시지: `v3.0: 카카오톡 → Notion「AI 꿀팁」→ Obsidian 통합, scheduler 훅`
4. `git push` 는 사용자 확인 후.

```bash
git status --short
# 기대 변경 파일:
#  M .gitignore  M CLAUDE.md  M README.md  M kakao_ingest.py  M scheduler.js  M sync_obsidian.py
#  D README.html
#  ?? docs/tasks/2026-09-06-kakao-tips-ingest.md  ?? docs/tasks/2026-09-06-scheduler-kakao-hook.md
#  ?? kakao_ingest.py  ?? lib/kakao_parse.py  ?? lib/tips_notion.py
# AGENTS.md(Codex용)는 별건 — 이번 커밋에 넣지 않는다.
git check-ignore -q .kakao_state.json && echo "state ignored"
```

## 7. 롤백

```bash
git checkout -- scheduler.js
```
Python 쪽은 그대로 두어도 무해하다 (scheduler 가 호출하지 않으면 아무 일도 없다).

## 8. 범위 밖 — 하지 말 것

- `sync_obsidian.py`, `kakao_ingest.py`, `lib/*.py` 수정 (완료·검증된 파일)
- `wiki_ingest.py` 호출 방식 변경 (꿀팁이 많이 들어오면 무제한 호출되는 기존 동작은 알고 있는 사안. 별건)
- 큐/quota/OAuth 로직 일체
- 텔레그램 메시지를 2개로 나누는 것
- `README.html` 재생성
