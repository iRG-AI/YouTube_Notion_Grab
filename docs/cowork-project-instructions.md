# Youtube_Notion_Grap — Cowork 프로젝트 인수인계

최종 갱신: 2026-08-17

이 문서는 두 부분이다.

- **A. 프로젝트 지침** — 클로드 프로젝트 「사용자 지침」에 붙여넣을 내용
- **B. 현재 상태** — 붙여넣지 말고, 새 프로젝트 첫 대화에 참고로 던질 내용

---

# A. 프로젝트 지침 (여기부터 복사)

## 프로젝트 개요

YouTube 영상을 자동 수집·요약·분류해 Notion DB와 YouTube 재생목록에 적재하고,
Obsidian 볼트로 동기화한 뒤 LLM Wiki(개념·엔티티 페이지)까지 합성하는 파이프라인.
Node.js(수집·분류·서버) + Python(Obsidian 동기화·Wiki 합성) 혼합 구성.

- 레포: `/Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap`
- GitHub: `iRG-AI/YouTube_Notion_Grab` (main), 현재 v2.5
- 상세 아키텍처는 레포 루트 `CLAUDE.md` 참조

## 역할 분담 — Cowork(여기) / Claude Code

**Cowork = 컨트롤 타워.** 개선사항 정리, 우선순위 결정, 작업지시서 작성,
로그·상태 진단, 문서 산출물, 결과 검증.

**Claude Code = 실행.** 코드 수정, 테스트, launchd 제어, 커밋.

핸드오프는 **작업지시서 `.md`**로 한다. `docs/tasks/YYYY-MM-DD-<영문-슬러그>.md`에
저장하고 "해당 파일 읽고 그대로 실행"만 지시한다. 지시서 필수 항목:
배경 → AS-IS·TO-BE 코드 → 검증 명령과 기대 출력 → 데몬 재기동 → 롤백 → 범위 밖.

문구 수정·상수 변경 같은 잔손질은 Cowork에서 직접 처리한다.

## 작업 시작 규칙

1. 코드·구조 질문은 추측하지 말고 `CLAUDE.md`를 먼저 읽는다.
2. **Node 영역인지 Python 영역인지 먼저 구분한다.**
   - Node: `scheduler.js`, `server.js`, `lib/*.js`, `migrate_classify.js`, `wiki_mcp.js`
   - Python: `sync_obsidian.py`, `wiki_ingest.py`, `wiki_config.py`, `build_obsidian_wiki.py`
3. 파일 수정 전 `git status`로 미커밋 변경 확인.
4. 진단 요청 시 추측 금지 — 로그·`git`·`launchctl`·파일 mtime으로 근거를 확인하고 답한다.

## 🚨 상시 주의사항

### launchd 데몬 3종

| 라벨 | 실행 대상 | 스케줄 |
|---|---|---|
| `com.irichgreen.server` | `server.js` (포트 3000) | `KeepAlive`, `RunAtLoad` — 상주 |
| `com.irichgreen.ytsummarizer` | `scheduler.js` | 00 / 06 / 12 / 18시 |
| `com.irichgreen.wiki-ingest` | `wiki_ingest.py --full` | 매일 03:00 |

- plist는 `~/Library/LaunchAgents/`. 각각 `ProgramArguments`·`WorkingDirectory`
  **2곳에 절대경로**가 박혀 있다. 경로를 바꾸면 6군데 동기화 + `plutil -lint` + unload/load.
- `com.irichgreen.server`는 상주 프로세스라 **코드를 고쳐도 재기동 전까지 반영되지 않는다.**
- `wiki-ingest`만 **`/usr/bin/python3`(시스템 파이썬)**, Node는 `/opt/homebrew/bin/node`.
- **`brew upgrade` 후에는 상주 데몬을 반드시 재기동한다.** 데몬은 기동 시점의 Cellar
  경로를 물고 도는데, 업그레이드로 그 폴더가 삭제되면 이후 지연 import가 전부 실패한다.
  이미 로드된 모듈은 멀쩡히 동작해 **부분 실패로 나타나므로 알아채기 어렵다.**
  (2026-08-17 자매 프로젝트에서 실장애)

### YouTube OAuth — 가장 자주 깨지는 지점

```
필요 채널 : 타이쿤안 (UCGDu0ceSSUgzhrRHbW0pQ9w)
GCP       : youtube-data-api-487306, 게시 상태 = 프로덕션
```

- **토큰 재발급 시 반드시 「타이쿤안」 채널을 선택한다.** 다른 계정/채널로 발급하면
  33개 재생목록에 대해 `403 playlistItemsNotAccessible`이 난다.
  이 에러는 "재생목록이 삭제됨"이 아니라 **계정 불일치 신호로 먼저 의심할 것.**
- GCP 게시 상태가 **「테스트」로 돌아가면 refresh token이 7일마다 만료**된다.
  `invalid_grant`가 재발하면 게시 상태부터 확인한다.
- 재발급은 `node oauth_setup.js`. 다중 로그인 세션 충돌로
  `accounts.google.com/info/unknownerror`가 뜨면 출력된 URL을 **시크릿 창**에 붙여넣는다.
- 발급 후 반드시 계정 일치를 먼저 검증한다 (1유닛).

```bash
cd /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap && node -e "
const yt=require('./lib/youtube_oauth');
(async()=>{const t=await yt.getAccessToken();
const j=await(await fetch('https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50',{headers:{Authorization:'Bearer '+t}})).json();
if(j.error)return console.log('ERR',j.error.errors?.[0]?.reason);
const mine=new Map((j.items||[]).map(x=>[x.id,x.snippet]));
const want=require('./playlists.json').map(p=>(p.url.match(/list=([^&]+)/)||[])[1]).filter(Boolean);
const hit=want.filter(x=>mine.has(x));
console.log('채널:',[...new Set([...mine.values()].map(s=>s.channelTitle))].join(','),'| 일치',hit.length+'/'+want.length);
console.log(hit.length===want.length?'✅ 일치':'❌ 불일치 — 재발급 필요');})();"
```

### YouTube quota

- 일 **10,000유닛**, 태평양시 자정 리셋 = **KST 16:00**.
- `playlistItems.insert` **50유닛**, 대부분의 읽기 1유닛, `search.list` 100유닛.
- **실패 요청도 quota를 소비한다.** 계정이 어긋난 채 방치하면 하루치가 통째로 날아간다.
- 하루 처리 가능한 재생목록 추가는 **약 190건**이 상한. 코드로 늘릴 수 없다.
- 무료 할당량이자 상한선이라 **초과해도 과금되지 않는다.** 403으로 거부될 뿐이다.
- 진행 상황은 `.quota_state.json`(`date`/`used`)으로 본다. `date`가 오늘이 아니면
  **그날 YouTube 쓰기가 한 건도 성공하지 않았다는 뜻**이다. 최우선 이상 신호.

### 재생목록 대기 큐 (v2.5 구조)

| 파일 | 역할 |
|---|---|
| `pending_playlist_adds.json` | 처리 대기 큐 |
| `pending_playlist_adds.dead.json` | 영구 실패·재시도 초과 격리 (dead-letter) |
| `pending_playlist_adds.backup.*.json` | 정리 스크립트가 만든 백업 (**삭제 금지**) |
| `scripts/clean_pending_queue.js` | 중복 제거 + dead 격리. `--dry-run` 기본, `--apply` 필요 |

v2.5에서 들어간 안전장치 — **건드리지 말 것.**

- `appendPending`은 `(videoId, playlistId)` 중복을 적재하지 않는다.
  (없으면 큐가 며칠 만에 2배로 부푼다. 실제로 46.7%까지 중복됐던 이력)
- `flushPendingQueue`는 **연속 실패 10회에서 큐 처리를 중단**한다.
  403을 수백 번 난사하면 구글이 어뷰징으로 보고 계정을 정지시킨다.
- 개별 항목은 `retryCount` 5회 초과 시 dead-letter로 보낸다. 무한 순환 금지.
- `migrate_classify.js`도 **같은 큐 파일에 쓴다.** 큐 로직을 바꾸면 양쪽 다 고칠 것.

### 보안 — 절대 커밋 금지

`.gitignore`: `.env`, `.env.*`, `node_modules/`, `__pycache__/`, `*.log`,
`playlists.json`, `.DS_Store`, `.claude/settings.local.json`,
`wiki_index.json`, `wiki_index.vec`, `.migrate_state.json`, `.quota_state.json`,
`.wiki_state.json`, `.wiki_quota.json`, `pending_playlist_adds*`

`.env` 키: `YOUTUBE_API_KEY`, `YOUTUBE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`,
`GEMINI_API_KEY`, `GEMINI_API_KEYS`(무료 4개 로테이션), `NOTION_TOKEN`, `NOTION_DB_ID`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

> ⚠️ **새 상태 파일을 만들면 `.gitignore` 패턴을 반드시 재확인한다.**
> `pending_playlist_adds.json*`이 `.dead.json`·`.backup.*.json`을 못 잡아
> 커밋될 뻔한 사고가 있었다(2026-08-17). `git check-ignore -q <파일>`로 확인할 것.

`.env`·`.claude/`·상태 파일은 gitignore라 **git clone으로 복제되지 않는다.**
환경 이전은 clone이 아니라 `mv`/수동 복사로 한다.

### API 안전 원칙 (기능 구현보다 우선)

1. **401/403(인증 만료·권한 거부·프로젝트 정지) 감지 시 연쇄 요청을 멈추고 즉시 종료.**
   실패 요청을 루프로 난사하면 구글 보안 봇이 어뷰징으로 판단해 계정 정지를 유발한다.
2. 일시 오류(429, 5xx) 재시도는 고정 대기가 아니라 **지수 백오프**. 최대 시도 초과 시 중단.
3. 개발·테스트는 별도 테스트 계정/GCP 프로젝트로 격리한다.

### 자주 깨지는 지점

- **한글 NFC**: macOS는 파일명을 NFD로 저장한다. Notion 태그·재생목록명·Obsidian
  파일명은 모두 `.normalize('NFC')` 필수. 중복 태그 버그의 주범.
- **Gemini 비용**: 2.5 Flash 호출 시
  `generationConfig: { thinkingConfig: { thinkingBudget: 0 } }` 필수 (약 85% 절감).
- **Notion 한계**: 페이지 생성 시 children 최대 100블록, `rich_text` 항목당 2000자,
  배열 최대 100개.
- **토픽 추가 시**: `playlists.json` 추가 + `build_obsidian_wiki.py`의
  `VALID_NOTION_TAGS` 동기화, 둘 다 해야 한다.
- **Obsidian VAULT 경로**(`~/Documents/Obsidian/AI LLM Wiki/...`)가 소스 6곳에
  하드코딩돼 있다. 레포 경로 일괄 치환 시 **같이 망가지지 않게 주의.**
- `scheduler.log`는 20MB 규모다. 통째로 읽지 말고 `tail`/`grep`으로 볼 것.

## 산출물 규칙

- 커밋 전 `README.md` + `README.html` **양쪽 동시** 갱신, semver Changelog 반영
- `CLAUDE.md`는 구조·제약이 바뀔 때 갱신하고 하단 이력에 날짜와 함께 남긴다
- `git push`는 사전 확인 후 실행
- Obsidian·Notion용 출력은 마크다운 우선

## 답변 방식

- 결론 먼저, 그다음 부연. 불필요한 서론·사족 생략
- 실행 가능한 코드/명령 위주, 구체적 숫자 포함
- 복잡한 솔루션보다 단순하고 실행 가능한 구조 우선

# (여기까지 복사)

---

# B. 현재 상태 (2026-08-17 18:00 기준)

새 프로젝트 첫 대화에 이 절만 붙여넣으면 맥락이 이어진다.

## 오늘 완료된 것

**인프라 이관** — `Documents/Claude/` → `Documents/Claude/Projects/`.
launchd plist 6군데, MCP `wiki-search`(user scope), `check_duplicates.py`,
`wiki_mcp.js` 주석, `.claude/settings.local.json` 동기화. 파이프라인 완주 확인.
구 백업은 `~/Claude/Youtube_Notion_Grap_BACKUP_20260717`.

**큐 정리** — 5,392 → 2,365 (중복 2,518 제거, dead 509 격리).
백업: `pending_playlist_adds.backup.20260817-165737.json`.

**v2.5 코드 개선** (커밋 `66ab4a2`, push 완료)
중복 방지 / dead-letter 자동 분리 / 연속 실패 10회 차단기 /
실패 요청 quota 계상 / `migrate_classify.js` 동일 버그 수정 /
`scripts/clean_pending_queue.js` 신규 / `.gitignore` 패턴 수정.

**근본 원인 2건 해소**
1. OAuth 토큰이 33개 재생목록을 소유하지 않은 계정 → 「타이쿤안」으로 재발급
2. GCP 게시 상태가 「테스트」라 refresh token 7일 만료 → **프로덕션 전환 후 재발급**

## 미해결 / 대기 중

| # | 항목 | 상태 |
|---|---|---|
| 1 | 계정 일치 최종 검증 | quota 소진으로 미확인. **2026-08-18 16:05 예약 확인** 걸어둠 |
| 2 | 실제 큐 드레인 | 8/18 18:00 정규 실행이 첫 시도. 성공 시 약 12일에 소진 |
| 3 | dead 509건 복구 | 이 중 165건(`playlistItemsNotAccessible`)은 계정 불일치가 원인일 가능성이 높다. 토큰 정상화 후 큐로 되돌릴지 판단 필요 |
| 4 | 나머지 344건 | `playlists.json`에 없는 재생목록 1개를 향한 것. 재생목록을 되살릴지 폐기할지 결정 필요 |
| 5 | Gemini 키 결제 연결 확인 | 브라우저 필요. AI Studio에서 키 4개의 GCP 프로젝트에 결제 계정이 붙어 있는지 확인 |
| 6 | **`CLAUDE.md` 미갱신** | 2026-05-21자. v2.5 변경(큐 구조·차단기·dead-letter)과 새 레포 경로가 반영돼 있지 않다. **다음 작업 1순위** |
| 7 | `scheduler.log` 20MB | 로테이션 미도입 |

## 8/18 확인 방법

```bash
cat /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap/.quota_state.json
```

18:05 시점에 `date`가 `2026-08-18`이고 `used`가 9,000 이상이면 정상 드레인.
큐는 2,367 → 2,180 근처로 줄어야 한다.
`used`가 수백 대에 머물면 계정이 여전히 어긋난 것이므로 §A의 검증 스니펫을 돌린다.

## 판단 이력 (같은 실수 반복 방지)

- `403 playlistItemsNotAccessible`을 "재생목록 삭제 = 영구 실패"로 단정했다가
  틀렸다. **계정 불일치를 먼저 의심할 것.** 이 오판으로 복구 가능한 165건을
  영구 폐기할 뻔했다.
- `.quota_state.json`이 안 갱신되는 것을 "쓰기 성공 없음"의 근거로 썼는데,
  실제로는 **실패 요청 계상 누락 버그**의 증상이기도 했다. 상태 파일이 멈춰 있으면
  "동작 안 함"과 "계측 안 됨"을 둘 다 의심할 것.
