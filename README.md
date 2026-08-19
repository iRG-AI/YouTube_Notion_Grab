# 🎬 YouTube → Notion AI 요약기 + Obsidian LLM Wiki

YouTube 재생목록의 영상을 **Gemini AI**로 자동 요약하여 **Notion DB**에 저장하고,  
**Obsidian**으로 자동 동기화하여 **LLM Wiki** 지식베이스를 구축하는 풀스택 자동화 솔루션입니다.

---

## 🚀 프로젝트 개요
본 프로젝트는 AI 에이전트 기술을 활용하여 구현 및 고도화되었습니다.
* **AI Assistant**: Claude (Anthropic) — Agentic Coding
* **AI Model**: **Gemini 2.5 Flash** — YouTube 영상 요약 및 분류 엔진
* **Coding Style**: **Vibe Coding** (AI-driven iterative design & implementation)

---

## ✨ 주요 기능

- 🎥 **YouTube 재생목록 자동 수집** — YouTube Data API v3로 재생목록 영상 전체 조회
- 🤖 **Gemini AI 자동 요약** — 영상 제목·설명·태그 기반 4섹션 보고서 자동 생성
- 📝 **Notion DB 자동 저장** — 요약 결과를 Notion 데이터베이스에 구조화하여 저장
- 🔄 **스마트 중복 방지** — Notion 전체 캐시 로드 후 메모리에서 즉시 중복 체크
- 📊 **통계 자동 업데이트** — 조회수·구독자수 15% 이상 변화 시만 Notion API 호출
- 📓 **Obsidian 자동 동기화** — 신규 저장 완료 시 Obsidian LLM Wiki 자동 업데이트
- 🔗 **Wiki 링크 자동 구성** — 재생목록별 MOC, 채널별 목차, 키워드 링크 자동 생성
- 📱 **텔레그램 알림** — 노션 저장 결과 + Obsidian 동기화 결과 통합 전송
- ⏰ **launchd 자동 스케줄링** — Mac 로그인 시 서버 자동 시작, 6시간 간격 스케줄러 실행

---

## 🏗️ 시스템 아키텍처

```mermaid
flowchart TD
    USER["👤 사용자\n'AI 영상목록' 재생목록에 영상 추가"]
    MASTER[("📺 YouTube AI 영상목록")]
    USER -->|영상 추가| MASTER

    subgraph TRIGGER["⏰ 실행 트리거"]
        SCHED["launchd 스케줄러\n6시간 간격 (YouTube 인제스트)"]
        WEBUI["웹 UI 버튼\nlocalhost:3000"]
        WIKI_SCHED["launchd 스케줄러\n매일 03:00 (Wiki 전체 재분석)"]
    end

    SCHED --> ENTRY
    WEBUI -->|SSE| ENTRY
    MASTER -->|Data API v3| FETCH

    subgraph PIPELINE["🤖 마스터 인제스트 파이프라인 (scheduler.js)"]
        ENTRY["processMasterIngest()"]
        FETCH["영상 메타 조회\n+ Notion 캐시 로드 · 중복 체크"]
        GEMINI["lib/classifier.js\nGemini 2.5 Flash\n요약 + 토픽 1~5개 분류"]
        NSAVE["saveToNotionWithTopics()\n— 영상별 in-loop —"]
        YSAVE["lib/youtube_oauth.js\nplaylistItems.insert\n— 영상별 in-loop —"]
        ENTRY --> FETCH --> GEMINI --> NSAVE --> YSAVE
    end

    NSAVE --> NOTION[("📋 Notion DB\n다중 주제 태그 + 4섹션 요약")]
    YSAVE -->|"quota 여유"| YT_PL[("📺 YouTube 토픽 재생목록\n33개")]
    YSAVE -->|"quota 초과"| PENDING[("⏳ pending_playlist_adds.json")]
    PENDING -->|"다음 실행 시 자동 소진"| YT_PL

    NOTION -->|"모든 영상 처리 완료 후 1회"| SYNC
    WIKI_SCHED -->|"일일 230 API 제한 준수"| WIKI_INGEST

    subgraph OBS["📓 Obsidian Karpathy LLM Wiki"]
        SYNC["sync_obsidian.py\n신규 영상 .md 생성 + tags 갱신"]
        WIKI_INGEST["wiki_ingest.py\nGemini 2.5 Flash\n개념/엔티티 Wiki 페이지 합성"]
        BUILD["build_obsidian_wiki.py\nMOC + 키워드 허브 27개 자동 생성"]
        VAULT[("📁 Obsidian Vault\nAI LLM Wiki/")]
        
        SYNC --> WIKI_INGEST
        WIKI_INGEST --> BUILD
        BUILD --> VAULT
    end

    VAULT --> TG["📱 Telegram 통합 알림\nNotion 결과 + Obsidian 결과"]
    YT_PL --> TG
```

---

## 📂 프로젝트 구조

```
Youtube_Notion_Grap/
├── server.js                          # 웹 서버 + Notion API 프록시 + Obsidian 트리거
├── scheduler.js                       # 자동 스케줄러 (6시간 간격, 마스터 인제스트 포함)
├── index.html                         # 웹 앱 UI (단일 파일)
├── package.json                       # Node.js CommonJS 설정
├── playlists.json                     # 등록된 재생목록 목록
├── .env                               # API 키 (gitignore — 절대 커밋 금지)
├── favicon.svg                        # 브라우저 탭 아이콘
├── migrate_classify.js                # 기존 영상 일괄 재분류 스크립트 (v102)
├── oauth_setup.js                     # YouTube OAuth refresh_token 1회 발급 도구 (v102)
├── notion_to_obsidian.js              # Notion → Obsidian 일회성 마이그레이션
├── sync_obsidian.py                   # Obsidian 증분 동기화 (신규 영상 추가 및 위키 인제스트 연동)
├── wiki_ingest.py                     # Gemini 기반 엔티티/개념 위키 페이지 합성 스크립트 (v111)
├── wiki_config.py                     # Wiki Ingest 공통 설정 및 API 호출 유틸 (v111)
├── build_obsidian_wiki.py             # MOC + 채널 목차 + 키워드 링크 빌더
├── cleanup_duplicates.py              # 노션/Obsidian 중복 정리 도구
├── com.irichgreen.server.plist        # launchd 서버 자동시작 설정
├── com.irichgreen.ytsummarizer.plist  # launchd 스케줄러 설정
├── com.irichgreen.wiki-ingest.plist   # launchd 일일 Wiki 인제스트 스케줄러 (v111)
├── install-server.sh                  # 서버 자동시작 설치 스크립트
├── install-scheduler.sh               # 스케줄러 설치 스크립트
├── install-wiki-ingest.sh             # 일일 Wiki 인제스트 스케줄러 설치 스크립트 (v111)
├── lib/
│   ├── youtube_oauth.js               # YouTube OAuth 2.0 + playlistItems.insert (v102)
│   └── classifier.js                  # Gemini 기반 토픽 분류기 (v102)
└── README.md
```

---

## 🛠️ 기술 스택

| 분류 | 기술 |
|------|------|
| **Runtime** | Node.js v25+, Python 3 |
| **Backend** | Node.js HTTP 서버 (Notion API 프록시) |
| **Frontend** | Vanilla HTML/CSS/JavaScript (Single File) |
| **AI 요약** | Google Gemini 2.5 Flash API |
| **데이터 소스** | YouTube Data API v3 |
| **저장소** | Notion Database API |
| **Wiki** | Obsidian (로컬 마크다운 지식베이스) |
| **알림** | Telegram Bot API, Gmail SMTP |
| **스케줄링** | macOS launchd |

---

## 🔑 환경 변수 설정 (.env)

프로젝트 루트에 `.env` 파일을 생성하세요. (GitHub에 절대 올리지 않습니다)

```env
YOUTUBE_API_KEY=AIzaSy...
GEMINI_API_KEY=AIzaSy...
NOTION_TOKEN=ntn_...
NOTION_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=1234567890:AAG...
TELEGRAM_CHAT_ID=1234567890

EMAIL_ENABLED=false
EMAIL_FROM=your@gmail.com
EMAIL_TO=recipient@email.com
EMAIL_APP_PASS=xxxx xxxx xxxx xxxx

# YouTube OAuth 2.0 (v102 — 토픽 재생목록 자동 추가용)
# oauth_setup.js 실행 후 자동 기입됩니다
YOUTUBE_OAUTH_CLIENT_ID=...
YOUTUBE_OAUTH_CLIENT_SECRET=...
YOUTUBE_OAUTH_REFRESH_TOKEN=...
YOUTUBE_MASTER_PLAYLIST_ID=PLxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 📦 설치 및 실행

### 1. 사전 요구사항
- Node.js v18 이상, Python 3
- YouTube Data API v3 키
- Google Gemini API 키
- Notion Integration 토큰 + 데이터베이스 ID

### 2. 서버 및 스케줄러 실행
```bash
# 서버 수동 실행
node server.js

# Mac 자동 시작 등록
bash install-server.sh
bash install-scheduler.sh
```

---

## 📓 Obsidian LLM Wiki

노션에 저장된 AI 영상 요약을 Obsidian 지식베이스로 자동 변환하며, `wiki_ingest.py`를 통해 지식 간의 관계를 분석하여 위키 페이지를 합성합니다. 자세한 구조는 [CLAUDE.md](CLAUDE.md)를 참조하세요.

---

## 📊 Notion DB 컬럼 구조

| 컬럼명 | 타입 | 설명 |
|--------|------|------|
| 영상 제목 | Title | YouTube 영상 제목 |
| 요약 내용 | Rich Text | Gemini AI 생성 4섹션 보고서 |
| 유튜브 채널 | Rich Text | 채널명 |
| 업로드 일자 | Date | 실제 영상 업로드 날짜 |
| 조회수 | Number | 최신 조회수 |
| 구독자수 | Number | 채널 구독자수 |
| 영상 URL | URL | YouTube 영상 링크 |
| 썸네일 URL | URL | 영상 썸네일 이미지 |
| 처리 상태 | Select | 완료 / 오류 |
| 주제 | Multi-Select | 재생목록명 (NFC 정규화 적용) |

---

## 🔄 버전 관리 (Version History)

본 프로젝트는 **`v[Major].[Minor]`** 형식의 단순화된 버전 규칙을 따릅니다.
- **Major**: 핵심 엔진 교체, 아키텍처 개편 등 대규모 변화
- **Minor**: 기능 개선, 버그 수정, 프롬프트 튜닝 등 마이너한 변화

### 📌 요약 이력 (Summary Table)

| 버전 | 날짜 | 주요 내용 요약 |
| :-- | :--- | :--- |
| **v2.7** | 2026-08-19 | **재생목록 쓰기 성공/실패 계측 및 알림 교정**: `.quota_state.json`이 성공·실패를 구분하지 않아 "시도했으나 전부 실패한 날"을 감지하지 못하던 구멍을 막고, 텔레그램 알림에 당일 배수량·유입량·순감 기준 소진 예상일을 표기 |
| **v2.6** | 2026-08-17 | **quota 일 경계 태평양시(PT) 교정**: `.quota_state.json`의 날짜 키가 UTC라 KST 09:00에 리셋되는 반면 YouTube 실제 quota는 PT 자정(KST 16:00)에 리셋되어, 그 7시간 동안 스로틀이 무력화되던 문제를 교정 |
| **v2.5** | 2026-08-17 | **재생목록 대기큐 정합성 및 API 어뷰징 차단**: 중복 적재 원천 차단, 영구 실패 dead-letter 격리(재시도 5회 상한), 연속 실패 10회 시 큐 처리 즉시 중단, 실패 요청의 quota 계상 누락 교정, 텔레그램 큐 적체 알림 추가 |
| **v2.4** | 2026-07-08 | **주제 분류 API 키 로테이션 적용 및 안정성 강화**: 주제 분류 단계(`classifyTopics`)에서 429 에러(할당량 초과) 발생 시 다음 API Key로 자동 전환(`rotateGeminiKey()`) 후 재시도하는 로직을 추가하여 무중단 인제스트의 안정성을 극대화함 |
| **v2.3** | 2026-06-02 | **비용 최적화 및 무료 Key 로테이션 적용**: 요약 스케줄러 내 누락되었던 비용 절감 옵션 추가 적용 및 다중 무료 API 키 로테이션 구축으로 비용 0원 가동 환경 마련 |
| **v2.2** | 2026-05-21 | **API 보안 킬스위치 및 안전장치 강화**: API 키 정지 감지 시 프로세스 즉시 종료, 스케줄러 영구 언로드, 보안 스킬 규정 지정 |
| **v2.1** | 2026-05-18 | **요약 안정성 극대화 및 지식베이스 정상화**: 요약 짤림 완전 방지, RAG 기술 분류 보강 및 3MB 오류 큐 정리 |
| **v2.0** | 2026-05-16 | **할당량 최적화 및 안정성 강화**: 배치 크기 하향 및 순차 처리 도입 |
| **v1.2** | 2026-05-12 | **Karpathy LLM Wiki & 비용 최적화**: Wiki Ingest 구현 및 비용 85% 절감 |
| **v1.1** | 2026-05-02 | **개발 환경 및 분류 지능화**: CLAUDE.md 도입 및 바이브코딩 매핑 강화 |
| **v1.0** | 2026-04-10 | 프로젝트 초기화 및 핵심 파이프라인 구축 단계 |

---

### 📝 상세 변경 내역 (Detailed Change Log)

#### [v2.7] — 2026-08-19 (📊 재생목록 쓰기 성공/실패 계측 및 알림 교정)
- **"전부 실패한 날"을 감지하지 못하던 구멍 차단**: 큐 적체 경고의 발화 조건이 `.quota_state.json`의 `date !== today` 하나뿐이었는데, v2.5에서 실패 요청도 `consumeQuota(50)`을 타게 되면서 **실패만 해도 `date`가 당일로 갱신**되어 경고가 무력화되던 문제를 교정. 이 구조 탓에 2026-08-17의 197건 연속 `403 playlistItemsNotAccessible` 상황에서 원인을 지목하는 경고가 한 건도 발송되지 않았음. quota state에 `ok`/`fail` 카운터를 추가하고, **인증은 되는데 쓰기만 전부 실패**하는 계정 불일치 시나리오를 별도 분기로 경고하도록 변경.
- **성공/실패 계측 도입**: `lib/youtube_oauth.js`의 `consumeQuota(units, outcome)`로 확장하여 `playlistItems.insert`의 성공·실패 경로에서 각각 계상. 읽기(`list`)는 계상 대상에서 제외해 `used`에만 반영. 기존 상태 파일에 `ok`/`fail`이 없으면 0으로 채워 **하위호환을 유지**하며, 날짜 경계에서 `used`와 함께 리셋됨.
- **알림 문구 3분기 + 순감 기준 소진 예상일**: 텔레그램 완료 요약이 잔량만 표시하고 배수량을 세지 않아 정상 배수(2026-08-18 190건)가 드러나지 않던 문제를 교정. 당일 배수량·유입량을 함께 표기하고, 소진 예상일을 `(잔량 ÷ 190)`이 아닌 **`(잔량 ÷ 순감)` 기준**으로 계산하도록 변경 — 유입을 무시하던 기존 계산은 실제(약 16.8일)보다 낙관적인 11.8일을 표시했음. 순증 중일 때는 예상일 대신 경고를 표기.
- 임계값(9,500)·소비량(50/1유닛)·일 경계(PT)·대기큐 안전장치는 변경 없음.

#### [v2.6] — 2026-08-17 (🕐 quota 일 경계 태평양시(PT) 교정)
- **일 경계 UTC → PT 교정**: `lib/youtube_oauth.js`의 `todayKey()`가 UTC 날짜를 쓰던 탓에 로컬 카운터가 KST 09:00에 0으로 리셋되는 반면, YouTube 실제 quota는 태평양시 자정(= KST 16:00)에 리셋되어 **KST 09:00~16:00 구간에서 `checkQuotaAvailable()`이 무조건 통과**하던 문제를 교정. 실패 요청도 50유닛을 소비하므로(v2.5) 이 구간에서는 이미 소진된 quota에 계속 요청을 밀어넣는 상태였음. `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' })` 기반으로 변경하여 DST(PDT/PST) 전환도 자동 처리.
- **텔레그램 오경보 제거**: `scheduler.js`의 quota 미갱신 경고가 동일한 UTC 키로 비교하던 탓에 KST 09:00~16:00 사이에는 정상 동작 중에도 `🛑 오늘 YouTube 쓰기 0건`이 발송되던 문제를 교정. `todayKey()`를 export하여 스케줄러와 quota 추적기가 **같은 날짜 키를 공유**하도록 일원화함.
- 임계값(9,500)·소비량(50/1유닛)·대기큐 안전장치는 변경 없음.

#### [v2.5] — 2026-08-17 (🧹 재생목록 대기큐 정합성 및 API 어뷰징 차단)
- **중복 적재 원천 차단**: `scheduler.js`·`migrate_classify.js`의 `appendPending()`이 무조건 `push`하던 탓에 동일 `(videoId, playlistId)` 조합이 최대 28회까지 중복 적재되어 대기큐의 46.7%가 중복으로 채워지던 문제를 교정. 적재 전 동일 조합 존재 여부를 검사하여 재적재를 차단함.
- **영구 실패 dead-letter 격리**: `flushPendingQueue()`의 "기타 오류" 분기가 `403 playlistItemsNotAccessible` 같은 영구 실패까지 큐에 되돌려 영원히 재시도하던 구조를 개선. 영구 실패 사유(`playlistItemsNotAccessible`, `playlistNotFound`, `videoNotFound`, `forbidden`)는 `pending_playlist_adds.dead.json`으로 격리하고, 일시적 오류도 `retryCount` 5회를 넘기면 함께 격리하여 **어떤 실패도 무한 순환하지 않도록** 보장함.
- **연속 실패 차단기(Circuit Breaker)**: 계정·권한 문제로 실패가 연쇄될 때 수백 건의 403 요청을 난사하던 동작을 차단. 연속 10회 실패 시 큐 처리를 즉시 중단하고 잔여 항목을 보존함 (CLAUDE.md 보안 원칙 1 — 연쇄 요청 금지 준수).
- **실패 요청 quota 계상 교정**: `lib/youtube_oauth.js`가 성공 응답에서만 `consumeQuota(50)`를 호출해, 실패한 `playlistItems.insert`가 소비한 실제 quota가 `.quota_state.json`에 반영되지 않던 문제를 교정. 로컬 카운터가 0에 머문 채 실제 일일 한도를 초과하던 원인이었음.
- **큐 적체 알림 추가**: 대기큐가 3개월간 5,392건까지 누적되도록 아무 경보가 없던 문제를 보완. 텔레그램 완료 요약에 잔량·소진 예상일을 상시 표기하고, 1,000건 이상 적체 시와 `.quota_state.json`이 당일 갱신되지 않은 경우(= 당일 YouTube 쓰기 0건) 경고를 함께 발송함.
- **재실행 가능한 큐 정리 스크립트**: `scripts/clean_pending_queue.js` 신규 추가. 중복 제거(최초 `ts` 보존), `playlists.json` 미등록 재생목록 및 영구 실패 항목의 dead-letter 격리를 수행하며, 기본 `--dry-run`·`--apply` 시 타임스탬프 백업 생성.

#### [v2.4] — 2026-07-08
- **주제 분류 API 키 로테이션 적용 및 안정성 강화**: 주제 분류 단계(`classifyTopics`)에서 429 에러(할당량 초과) 발생 시 다음 API Key로 자동 전환(`rotateGeminiKey()`) 후 재시도하도록 개선하여 특정 API Key의 한도 초과 상황에서도 스케줄러의 무중단 인제스트 무결성을 확보함.

#### [v2.3] — 2026-06-02
- **Gemini 2.5 Flash 비용 최적화 옵션 추가 적용**: `scheduler.js`에서 Gemini 2.5 Flash를 통한 요약 수행 시 누락되었던 `thinkingConfig: { thinkingBudget: 0 }`를 추가하여, 보이지 않는 백그라운드 추론 토큰 과금(Thinking Quota)으로 인해 비용이 과다 청구되던 현상을 원천 방지(비용 약 85% 이상 절감).
- **무료 API Key 로테이션 적용**: 결제 카드가 연결되지 않은 4개의 순수 무료 API 키(`anvaksa@gmail.com`, `irichgreen.ai@gmail.com` 등)를 생성하여 `.env` 내 `GEMINI_API_KEYS`에 멀티 등록. 429 에러(무료 한도 초과) 발생 시 자동으로 다음 키로 교환 작동하도록 스케줄러 동작을 보완하여 **비용 0원 무과금 가동 환경**을 구축함.

#### [v2.2] — 2026-05-21
- **API 403 Suspended 에러 킬스위치(Kill-switch) 구현**: Gemini API 키가 차단(`suspended`)되었을 때 무한 루프를 돌며 API 호출을 시도하지 않고, 즉시 텔레그램으로 경보를 보낸 뒤 `process.exit(1)` 및 `sys.exit(1)`로 안전하게 프로세스를 강제 종료하는 안전장치 추가.
- **백업용 지수 백오프(Exponential Backoff)**: 일시적인 오류(429, 5xx)에 대해 단순 고정 3초 대기 대신 점진적으로 대기 간격을 늘리는 지수 백오프 알고리즘 적용 (`scheduler.js`, `wiki_config.py`).
- **백그라운드 자동 스케줄러 완전 정지 및 plist 삭제**: 백그라운드 오작동으로 인한 구글 계정의 비정상 활동 감지 리스크를 차단하기 위해 launchd 스케줄러(`ytsummarizer`, `wiki-ingest`)를 완전 언로드 및 설정 파일(plist) 2종을 영구 삭제 처리.
- **보안 및 안전 최우선 지침 지정**: `SKILL_SAFETY.md`를 생성하여 AI 에이전트의 API 남용과 비정상 호출을 차단하는 가이드를 스킬로 지정하고, `CLAUDE.md`에도 이 보안 최우선 개발 원칙을 명문화함.

#### [v2.1] — 2026-05-18
- **요약 무결성 검증 (`validateSummary`)**: Notion 저장 전 4대 필수 섹션(영상 개요, 핵심 내용, 주요 인사이트, 활용 포인트)의 유실 여부를 자동 판별하는 검증 로직 도입.
- **자동 Fallback 재시도**: 검증 실패 시 짧고 밀도 높은 `fallbackPrompt`를 태워 최대 2회까지 자동으로 요약을 재생성하는 자가 치유(Self-healing) 기능 구축.
- **Gemini 용량 확장**: maxOutputTokens를 `2000`에서 `4000`으로 상향하여 한국어 요약 도중 문장이 뚝 끊기는 절단 문제 차단.
- **정밀 제목 정규화 (`normalizeTitle`)**: 띄어쓰기, 인코딩(NFC/NFD), 특수기호 및 이모지 차이를 정제 대조하는 비교 엔진을 추가하여 중복 저장 차단.
- **RAG & 콘텐츠 자동화 분류 보완 (`classifier.js`)**: 칭킹, 벡터 DB, 하이브리드 검색 등 RAG 기술군이 `'AI LLM Wiki'` 카테고리로 정확히 매핑되고, AI 에이전트 기반 콘텐츠 대량 자동화가 `'AI 자동화'`에 고스란히 태깅되도록 프롬프트 정밀 튜닝.
- **오류 큐 대청소 (`clean_pending_queue.js`)**: 회복 불가능한 API 403 오류로 3MB 수준까지 불어났던 9,514개의 무한 실패 대기 항목을 깨끗이 정리 및 경량화.
- **Obsidian 짤림 파일 일괄 자가 복구**: 과거에 잘렸던 Obsidian 로컬 마크다운 파일 13개를 디텍션하여 선제적으로 삭제하고, Notion 최신 완전본으로 동기화(sync_obsidian.py)하여 Karpathy LLM Wiki 지식 합성까지 물 흐르듯 가동 성공.

#### [v2.0] — 2026-05-16
- **할당량 최적화**: `scheduler.js`의 `MAX_NEW_PER_RUN`을 15개로 하향 조정하여 Gemini API 할당량 대응.
- **순차 처리 도입**: 병렬 처리를 순차 처리로 변경하여 안정적인 API 호출 확보.
- **지연 시간 추가**: 요청 사이에 2초의 지용 시간(setTimeout)을 추가하여 Rate Limit 방지.
- **아키텍처 시각화**: Mermaid 다이어그램 도입으로 전체 시스템 데이터 흐름 가시화.

#### [v1.2] — 2026-05-12
- **Karpathy Wiki 파이프라인**: `wiki_ingest.py`를 통해 Obsidian 문서를 분석하여 Wiki 페이지 자동 합성 기능 구현.
- **비용 최적화 (핵심)**: Gemini API 호출부에 `thinkingBudget: 0` 설정을 적용하여 토큰 비용 약 85% 절감.
- **자동 스케줄링**: `launchd`를 통해 매일 03:00에 Wiki 인제스트 자동 실행 설정.

#### [v1.1] — 2026-05-02
- **개발 환경 정비**: `CLAUDE.md` 도입 및 Claude Code 환경 최적화.
- **분류 지능화**: AI 코딩 콘텐츠를 "AI 바이브코딩"으로 매핑 강화하여 분류 정확도 향상.
- **웹 UI 고도화**: 마스터 인제스트 모드 실시간 처리 결과 테이블 연동.

#### [v1.0] — 2026-04-10
- **프로젝트 초기화**: YouTube -> Notion -> Obsidian 기본 파이프라인 구축.
- **NFC 정규화**: Notion 태그 한글 깨짐 방지를 위한 NFC 정규화 전수 적용.
- **마스터 인제스트**: "AI 영상목록" 하나로 자동 분류 및 배분 시스템 구축.

---

© 2026 iRichGreen AI Development Team.  
Powered by **Claude (Anthropic)** & **Gemini 2.5 Flash (Google)**
