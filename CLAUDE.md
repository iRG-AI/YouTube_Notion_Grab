# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**현재 버전: v2.7.1** (2026-08-28) · 레포 경로: `/Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap`

> 2026-08-17에 `~/Documents/Claude/` → `~/Documents/Claude/Projects/` 로 이관했습니다.
> 이전 경로가 박힌 문서·스크립트를 발견하면 갱신 대상입니다.
> 구 백업: `~/Claude/Youtube_Notion_Grap_BACKUP_20260717`.

## Commands

```bash
# 서버 (웹 UI + Notion API 프록시, 포트 3000)
node server.js

# 스케줄러 (수동 1회 실행)
node scheduler.js              # 마스터 인제스트 모드 (기본)
node scheduler.js --legacy     # 레거시 33개 재생목록 모드

# Obsidian 동기화
python3 sync_obsidian.py       # Notion DB → Obsidian .md 파일 증분 동기화 + Wiki Ingest
python3 build_obsidian_wiki.py # MOC + 키워드 허브 파일 재구성

# Karpathy LLM Wiki
python3 wiki_ingest.py              # 증분: 미처리 소스만 Wiki 합성
python3 wiki_ingest.py --full       # 전체: 모든 소스 재분석
python3 wiki_ingest.py --limit=20   # 테스트: 20개만 처리

# 기존 영상 일괄 마이그레이션
node migrate_classify.js --dry-run --limit=20
node migrate_classify.js --notion-only
node migrate_classify.js --youtube-only --resume
node migrate_classify.js --apply

# 대기 큐 정리 (중복 제거 + dead-letter 격리) — 기본 dry-run
node scripts/clean_pending_queue.js
node scripts/clean_pending_queue.js --apply

# launchd 제어 (6시간 자동 실행)
launchctl start com.irichgreen.ytsummarizer
launchctl stop com.irichgreen.ytsummarizer

# YouTube OAuth 토큰 재발급 (1회성) — 반드시 「타이쿤안」 채널 선택
node oauth_setup.js

# OAuth 연결 확인 (토큰 발급 여부만 확인 — 계정 일치는 확인 못 함)
node -e "require('./lib/youtube_oauth').getAccessToken().then(t => console.log('✅', t.slice(0,20))).catch(e => console.error('❌', e.message))"

# 상태 스냅샷 (진단 1순위)
cat .quota_state.json
node -e "for(const f of ['pending_playlist_adds.json','pending_playlist_adds.dead.json'])console.log(f, JSON.parse(require('fs').readFileSync(f)).length)"
```

### OAuth 계정 일치 검증 (1유닛, 재발급 후 필수)

토큰이 발급되는 것과 **33개 재생목록을 소유한 계정인지**는 별개입니다.
재발급 직후 반드시 아래를 돌려 `✅ 일치`를 확인하세요.

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

## 🚨 보안 및 안전 최우선 개발 원칙 (Security & Safety Guidelines)

이 프로젝트에서 코드를 설계하고 수정할 때 다음 **보안 및 예외 안전성 원칙을 최우선(1순위)**으로 고려해야 합니다. 단순 기능 구현보다 플랫폼의 보안 정책 준수와 사용자 계정 보호가 먼저입니다.

1. **플랫폼 보안 규정 준수 및 계정 보호 (Anti-Abuse)**:
   - 구글(Google/YouTube), 노션 등 외부 API 호출 시, 인증 만료(401)나 권한 거부/프로젝트 정지(403 Forbidden, Suspended 등) 상태가 감지되면 **추가적인 연쇄 요청을 멈추고 즉시 프로세스를 강제 종료(Exit)**해야 합니다.
   - 단시간 내에 실패하는 요청을 루프 형태로 난사하는 행위는 구글 보안 봇에 의해 계정이 도용/어뷰징된 것으로 오인받아 **연쇄 계정 정지(Suspension)**를 유발하므로 절대 금지합니다.
2. **견고한 예외 처리 및 스케줄러 안전장치 (Fail-Safe & Backoff)**:
   - 일시적인 오류(Rate Limit 429, 서버 오류 5xx)에 대해 재시도할 때는, 3초 고정 대기 대신 점진적으로 대기 시간을 늘리는 **지수 백오프(Exponential Backoff)** 알고리즘을 필수 적용합니다.
   - 무한 루프나 과도한 재시도를 원천 차단하고, 최대 시도 횟수 초과 시 안전하게 실패를 기록한 후 중단해야 합니다.
3. **사용자 환경 자산 격리 가이드**:
   - 개인 메인 계정의 정지를 예방하기 위해, 개발 및 테스트에는 항상 별도의 테스트용 구글 계정과 GCP 프로젝트를 생성하여 격리된 채널을 통해 연동하도록 권고합니다.

## 아키텍처 개요

### 전체 파이프라인

```
YouTube "AI 영상목록" (마스터 모드)
    → scheduler.js:processMasterIngest()
    → lib/classifier.js:classifyTopics()  [Gemini 2.5 Flash, 토픽 1~5개]
    → saveToNotionWithTopics()            [Notion DB 저장]
    → lib/youtube_oauth.js:addToPlaylist() [토픽별 YouTube 재생목록 추가]
    → sync_obsidian.py                    [Obsidian .md 파일 생성/갱신]
    → wiki_ingest.py                      [Gemini 2.5 Flash, 엔티티/개념 Wiki 페이지 합성]
    → build_obsidian_wiki.py              [MOC + 키워드 허브 재구성]
```

레거시 모드(`--legacy`)는 33개 토픽 재생목록을 순회하며 동일한 Gemini 요약 → Notion 저장 흐름을 수행합니다.

### 핵심 파일 역할

| 파일 | 역할 |
|------|------|
| `scheduler.js` | 메인 오케스트레이터. YouTube API 조회, Gemini 요약, Notion 저장, Telegram 알림. launchd가 6시간 간격 실행. |
| `server.js` | HTTP 서버(포트 3000). `index.html` 서빙 + Notion API 프록시(보안 화이트리스트). SSE `/api/master-ingest` 엔드포인트로 실시간 로그 스트리밍. |
| `index.html` | 단일 페이지 웹 UI. 재생목록 관리, 마스터 인제스트 트리거, 처리 결과 테이블. |
| `lib/classifier.js` | Gemini 기반 토픽 분류기. `playlists.json`의 토픽 목록만 허용(allowedSet 필터). 신뢰도 0.6 미만이면 YouTube 추가 건너뜀. |
| `lib/youtube_oauth.js` | YouTube OAuth2 쓰기 전용. access_token 메모리 캐시(50분), 일일 quota 추적(`.quota_state.json`), 호출 간 200ms rate limit. |
| `sync_obsidian.py` | Notion DB → Obsidian 증분 동기화. 내부적으로 `wiki_ingest.py`와 연동. 고아 `.md` 격리 포함(아래 참조). |
| `wiki_ingest.py` | Karpathy LLM Wiki 파이프라인. Obsidian 노트를 순회하며 Gemini로 개념 단위 지식 추출 및 합성. |
| `wiki_config.py` | Wiki 인제스트 설정 관리. 230 RPD 토큰 제한, API Rate limit 추적 및 예외 처리 로직 포함. |
| `build_obsidian_wiki.py` | 키워드별 허브 파일 27개 자동 생성(`_MOC/Claude.md` 등) + MOC 재구성. |
| `migrate_classify.js` | 기존 영상 일괄 재분류. `.migrate_state.json`으로 재개 가능. |
| `playlists.json` | 33개 토픽 재생목록 목록. 분류기의 허용 토픽 소스이기도 함. gitignore 대상. |
| `scripts/clean_pending_queue.js` | (v2.5) 큐 중복 제거 + dead-letter 격리. 기본 dry-run, `--apply` 필요. |

### Obsidian 고아 파일 격리 (`sync_obsidian.py:quarantine_orphans`)

Notion에서 삭제된 페이지의 잔여 `.md`를 **삭제하지 않고** `VAULT/_trash/<타임스탬프>/`로 이동합니다.
Notion API 일시 장애로 페이지 목록이 비면 대량 소실이 되므로 되돌릴 수 있어야 합니다.

**안전장치 3중 — 하나라도 걸리면 아무것도 하지 않는다. 완화 금지.**

1. Notion 페이지 0건이면 건너뜀 (API 오류 의심)
2. 로드된 페이지가 Vault 파일의 50% 미만이면 건너뜀 (부분 로드 의심)
3. 고아 비율이 40%를 넘으면 중단 (수동 확인 필요)

`video_url` 프론트매터가 있고 토픽 폴더 안에 있는 **영상 노트만** 대상입니다.
`schema.md` 등 Vault 시스템 문서는 오탐하지 않습니다.

- `python3 sync_obsidian.py --orphans-dry-run` — 대상만 출력, 이동 없음
- 실행 이력은 Obsidian `log.md`의 `cleanup` 항목에 남습니다
- 2026-08-21 첫 실행에서 435개 격리 (`_trash/20260821_172922/`). **이 폴더는 삭제 금지.**

### 재생목록 대기 큐 파일 (v2.5)

| 파일 | 역할 |
|------|------|
| `pending_playlist_adds.json` | 처리 대기 큐. quota 초과·실패 시 적재되고 다음 실행에서 소진. |
| `pending_playlist_adds.dead.json` | 영구 실패·재시도 초과 격리 (dead-letter). 자동 복구되지 않음. |
| `pending_playlist_adds.backup.*.json` | `clean_pending_queue.js --apply`가 만드는 백업. **삭제 금지.** |

### 외부 서비스

- **YouTube Data API v3** (읽기전용): `YOUTUBE_API_KEY`
- **YouTube OAuth v3** (재생목록 쓰기): `YOUTUBE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`
- **Gemini 2.5 Flash**: `GEMINI_API_KEY` (요약 + 분류 모두 사용)
- **Notion API** (`2022-06-28`): `NOTION_TOKEN`, `NOTION_DB_ID`
- **Telegram Bot**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

모든 API 키는 `.env`에서 로드. `scheduler.js`와 `lib/*.js` 각각 자체 `loadEnv()` 포함.

### 중요한 제약사항

**한글 NFC 정규화**: macOS는 파일명을 NFD로 저장함. Notion 태그, 재생목록명, Obsidian 파일명은 모두 `.normalize('NFC')` 필수. `addTopicToPage()`의 NFC 체크가 중복 태그 방지의 핵심.

**Notion API 한계**:
- 페이지 생성 시 `children` 최대 100블록. 초과분은 `/v1/blocks/{id}/children`으로 append.
- `rich_text` 항목당 최대 2000자 (`splitRichText()` 사용).
- `rich_text` 배열 최대 100개 (`parseBoldRichText()` 결과 50개씩 묶어 paragraph 생성).

**YouTube Quota**: 일일 10,000 유닛, 태평양시 자정 리셋 = **KST 16:00**. `playlistItems.insert` 50유닛, 대부분의 읽기 1유닛, `search.list` 100유닛. 안전 버퍼 500을 뺀 임계 **9,500유닛**(`QUOTA_THRESHOLD`) 도달 시 `pending_playlist_adds.json`에 적재 후 다음 실행에서 처리.

- **실패 요청도 quota를 동일하게 소비한다.** v2.5에서 `addToPlaylist`의 실패 경로에도 `consumeQuota(50)`을 넣었다(`lib/youtube_oauth.js:217`). 이전에는 실패가 계상되지 않아 `.quota_state.json`이 0에 머무른 채 실제 한도를 넘겼다.
- 따라서 **하루 재생목록 추가 상한은 약 190건**이다(9,500 ÷ 50). 코드로 늘릴 수 없다.
- 무료 할당량이자 상한선이라 **초과해도 과금되지 않는다.** 403으로 거부될 뿐이다.
- **일 경계는 태평양시(PT) 기준이다** (v2.6). `todayKey()`가 `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })`를 쓴다(`lib/youtube_oauth.js:45`). UTC를 쓰면 카운터만 KST 09:00에 리셋돼 **09:00~16:00 동안 스로틀이 무력화**된다. 실패도 50유닛을 먹으므로 소진된 quota에 계속 요청을 밀어넣게 된다. **날짜 키를 만드는 코드를 새로 쓸 때는 반드시 `todayKey()`를 재사용할 것** — `scheduler.js:1360`의 텔레그램 경고도 같은 키를 써야 오경보가 안 난다.
- `.quota_state.json` 스키마는 **`{date, used, ok, fail}`** 이다 (v2.7). `ok`/`fail`은 `playlistItems.insert`의 성공·실패 건수이고, 읽기(`list`)는 `used`에만 반영된다. `consumeQuota(units, outcome)`의 `outcome`은 `'ok' | 'fail' | undefined`. 기존 파일에 `ok`/`fail`이 없으면 `loadQuotaState()`가 0으로 채운다(하위호환).
- `.quota_state.json`의 `date`가 **PT 기준 오늘**이 아니면 그날 YouTube 쓰기가 한 건도 시도되지 않았다는 뜻이다. 최우선 이상 신호.
- **`date`가 오늘이라고 정상인 것은 아니다.** 실패도 `date`를 찍는다. `fail > 0 && ok === 0`이면 **인증은 되는데 쓰기만 전부 실패** — 계정 불일치를 의심할 자리다(v2.7이 이 분기를 텔레그램으로 경고한다).
- 상태 파일이 멈춰 있으면 "동작 안 함"과 "계측 안 됨"을 **둘 다** 의심할 것. (2026-08-17 오판 이력)

**대기 큐 안전장치 (v2.5) — 건드리지 말 것**

`scheduler.js:flushPendingQueue()`와 `processMasterIngest()` 내부 `appendPending`에 들어간 장치입니다. 큐 로직을 바꾸면 **`migrate_classify.js`도 같은 큐 파일에 쓰므로 양쪽을 함께 고쳐야 합니다.**

- `appendPending`은 `(videoId, playlistId)` 중복을 적재하지 않는다(`scheduler.js:1020`). 없으면 큐가 며칠 만에 2배로 부푼다. 실제 46.7%까지 중복된 이력이 있다.
- `flushPendingQueue`는 **연속 실패 10회에서 큐 처리를 중단**한다(`scheduler.js:807`). 403을 수백 번 난사하면 구글이 어뷰징으로 판단해 계정을 정지시킨다. 보안 원칙 1의 구현체다.
- `invalid_grant` / `Token refresh failed` 감지 시 큐를 보존한 채 즉시 중단한다.
- 영구 실패 사유(`playlistItemsNotAccessible`, `playlistNotFound`, `videoNotFound`, `forbidden`)는 dead-letter로 격리한다.
- 그 외 실패는 `retryCount` 5회 초과 시 dead-letter로 보낸다. 무한 순환 금지.

**YouTube OAuth — 가장 자주 깨지는 지점**

```
필요 채널 : 타이쿤안 (UCGDu0ceSSUgzhrRHbW0pQ9w)
GCP       : youtube-data-api-487306, 게시 상태 = 프로덕션
```

- 토큰 재발급 시 **반드시 「타이쿤안」 채널을 선택**한다. 다른 계정/채널로 발급하면 33개 재생목록 전체에 `403 playlistItemsNotAccessible`이 난다.
- **이 에러를 "재생목록이 삭제됨"으로 단정하지 말 것. 계정 불일치를 먼저 의심한다.** 2026-08-17에 이 오판으로 복구 가능한 165건을 영구 폐기할 뻔했다.
- GCP 게시 상태가 「테스트」로 돌아가면 refresh token이 **7일마다 만료**된다. `invalid_grant`가 재발하면 게시 상태부터 확인한다.
- 재발급 중 `accounts.google.com/info/unknownerror`가 뜨면 다중 로그인 세션 충돌이다. 출력된 URL을 **시크릿 창**에 붙여넣는다.
- 발급 후 위 §"OAuth 계정 일치 검증"을 먼저 돌린다(1유닛).

**Gemini 분류 경로 — 요약 경로와 대응이 달랐던 자리 (v2.7.1)**

- `scheduler.js`의 분류 재시도 catch는 원래 **429/quota만** 재시도했다. 요약 경로(`:459`)는 503에 키 로테이션 + 재시도로 대응하는데 분류만 빠져 있어 **503 한 번에 영상이 떨어졌다**(2026-08-28 06:00 실제 발생). 지금은 `5xx`·`UNAVAILABLE`·`overloaded`·`high demand`도 지수 백오프(2→15초 상한)로 재시도한다. **분류 쪽 재시도 조건을 손댈 때 요약 경로와 대칭인지 먼저 확인할 것.**
- `401`/`403`은 **명시적으로 즉시 중단**한다(보안 원칙 1). 재시도 조건을 넓힐 때 이 가드를 지우지 말 것.
- 재시도 소진 시 `cls`가 `undefined`인 채 `cls.topics`로 진입하던 잠복 TypeError 경로가 있었다. `clsAttempt < maxClsAttempts` 가드와 루프 직후 `if (!cls) throw` **가드 2개가 짝**이다. 한쪽만 지우면 되살아난다.
- `classifyTopics`를 `maxRetries: 0`으로 호출하는 것은 **의도된 설계**다. 재시도는 키 교체를 하는 바깥 루프가 담당한다.

**Gemini API 최적화 (중요)**: Gemini 2.5 Flash 모델 사용 시 내부 추론 과정에서 과다한 "Thinking 토큰" 과금을 방지하기 위해 반드시 API 호출 옵션에 `generationConfig: { thinkingConfig: { thinkingBudget: 0 } }`를 적용해야 합니다 (비용 85% 절감 효과).

**토픽 추가 시**: `playlists.json`에 새 항목 추가 + `build_obsidian_wiki.py`의 `VALID_NOTION_TAGS` 동기화 필수.

**server.js 보안**: Notion API 프록시는 `ALLOWED_NOTION_PATHS` 화이트리스트만 통과. CORS는 `localhost:3000`만 허용. IP당 분당 120요청 rate limit.

### launchd 데몬 3종

| 라벨 | 실행 대상 | 스케줄 | 인터프리터 |
|------|-----------|--------|-----------|
| `com.irichgreen.server` | `server.js` (포트 3000) | `KeepAlive`, `RunAtLoad` — 상주 | `/opt/homebrew/bin/node` |
| `com.irichgreen.ytsummarizer` | `scheduler.js` | 00 / 06 / 12 / 18시 | `/opt/homebrew/bin/node` |
| `com.irichgreen.wiki-ingest` | `wiki_ingest.py --full` | 매일 03:00 | `/usr/bin/python3` (시스템 파이썬) |

- **실제 동작하는 plist는 `~/Library/LaunchAgents/`에 있다.** 레포 루트의 plist 3개는 그 원본이며, 2026-08-17부터 3개 모두 실경로(`/Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap`)가 들어 있다. 예전에 `server`·`ytsummarizer` 두 개에 있던 `/Users/사용자명/youtube-notion-app` 플레이스홀더는 제거했다.
- 각 plist는 `ProgramArguments`·`WorkingDirectory` **2곳에 절대경로**가 박혀 있다. 경로 변경 시 6군데 동기화 + `plutil -lint` + unload/load.
- `install-server.sh`·`install-scheduler.sh`는 plist를 `~/Library/LaunchAgents/`로 복사하며 **sed로 이 실경로를 `$APP_DIR`로 치환**한다. 레포 경로를 바꾸면 두 스크립트의 sed 패턴도 같이 고쳐야 치환이 동작한다.
- `com.irichgreen.server`는 상주 프로세스라 **코드를 고쳐도 재기동 전까지 반영되지 않는다.**
- **`brew upgrade` 후에는 상주 데몬을 반드시 재기동한다.** 데몬은 기동 시점의 Cellar 경로를 물고 도는데, 업그레이드로 그 폴더가 삭제되면 이후 지연 import가 전부 실패한다. 이미 로드된 모듈은 멀쩡히 동작해 **부분 실패로 나타나므로 알아채기 어렵다.** (2026-08-17 자매 프로젝트 실장애)

### 보안 — 절대 커밋 금지

`.gitignore` 대상: `.env`, `.env.*`, `node_modules/`, `__pycache__/`, `*.log`, `playlists.json`, `.DS_Store`, `.claude/settings.local.json`, `wiki_index.json`, `wiki_index.vec`, `.migrate_state.json`, `.quota_state.json`, `.wiki_state.json`, `.wiki_quota.json`, `pending_playlist_adds*`

> ⚠️ **새 상태 파일을 만들면 `.gitignore` 패턴을 반드시 재확인한다.**
> `pending_playlist_adds.json*` 패턴이 `.dead.json`·`.backup.*.json`을 못 잡아 커밋될 뻔한 사고가 있었다(2026-08-17). 현재는 `pending_playlist_adds*`로 수정됨.
> 새 파일 추가 시 `git check-ignore -q <파일>`로 확인할 것.

`.env`·`.claude/`·상태 파일은 gitignore라 **`git clone`으로 복제되지 않는다.** 환경 이전은 clone이 아니라 `mv`/수동 복사로 한다.

### 로그 파일

- `scheduler.log` / `scheduler-stdout.log`: 스케줄러 실행 로그. **현재 약 20MB. 로테이션 미도입.** 통째로 읽지 말고 `tail`/`grep`으로 볼 것.
- `server.log`: 서버 요청 로그
- Obsidian vault의 `log.md`: wiki 변경 이력

### 진단 원칙

추측하지 말고 근거를 먼저 확보한다 — 로그(`tail`/`grep`), `git status`, `launchctl list | grep irichgreen`, 파일 mtime, `.quota_state.json`, 큐 파일 건수.

---

## 변경 이력

- **2026-08-28 (v2.7.1)** — 토픽 분류의 일시적 서버 오류(5xx) 재시도 추가. `scheduler.js` 분류 catch 블록의 재시도 대상을 429/quota → +`5xx`·`UNAVAILABLE`·`overloaded`·`high demand`로 확장하고 지수 백오프(2→15초 상한)를 적용, 401/403은 즉시 중단으로 명시, `keysCount > 1` 조건을 키 교체에만 적용해 키 1개 환경에서도 재시도되게 했다. 재시도 소진 시 `cls`가 `undefined`인 채 `cls.topics`로 진입하던 잠복 TypeError 경로를 가드 2개로 차단. 지시서 `docs/tasks/2026-08-28-classify-transient-retry.md`.
- **2026-08-19 (v2.7)** — 재생목록 쓰기 성공/실패 계측 도입. `.quota_state.json`에 `ok`/`fail` 추가(하위호환 기본값 0), `consumeQuota(units, outcome)`로 확장해 `addToPlaylist` 양쪽 경로에서 계상. 텔레그램 큐 블록을 쓰기 결과 3분기(성공/전부실패/시도없음) + 순감 기준 소진 예상일로 교체 — v2.5 이후 "시도했으나 전부 실패한 날"을 구조적으로 감지하지 못하던 구멍을 막았다. 지시서 `docs/tasks/2026-08-18-write-outcome-metrics.md`.
- **2026-08-17 (v2.6)** — quota 일 경계를 UTC → 태평양시(PT)로 교정. `todayKey()`를 `Intl` 기반으로 바꾸고 export해 `scheduler.js:1360`이 같은 키를 쓰게 했다(텔레그램 오경보 제거). KST 09:00~16:00 동안 스로틀이 무력화되던 구간을 없앴다. 지시서 `docs/tasks/2026-08-17-quota-day-boundary.md`. 커밋 `7eb112c`.
- **2026-08-17 (v2.5)** — 레포를 `Projects/` 하위로 이관. 대기 큐 안전장치 도입(중복 방지·연속 실패 10회 차단기·dead-letter 격리·실패 요청 quota 계상), `scripts/clean_pending_queue.js` 신규, `.gitignore` 패턴 수정. OAuth 토큰을 「타이쿤안」 채널로 재발급하고 GCP 게시 상태를 프로덕션으로 전환. 큐 5,392 → 2,365 정리. 커밋 `66ab4a2`.
- **2026-05-21** — 최초 작성.
