# 🎬 YouTube → Notion AI 요약기 + Obsidian LLM Wiki

YouTube 재생목록의 영상을 **Gemini AI**로 자동 요약하여 **Notion DB**에 저장하고,  
**Obsidian**으로 자동 동기화하여 **LLM Wiki** 지식베이스를 구축하는 풀스택 자동화 솔루션입니다.

---

## ⚡ Vibe Coding with AI

본 프로젝트는 AI 에이전트 기술을 활용하여 구현 및 고도화되었습니다.

- **AI Assistant**: [Claude](https://claude.ai) (Anthropic) — Agentic Coding
- **AI Model**: **Gemini 2.5 Flash** — YouTube 영상 요약 엔진
- **Coding Style**: **Vibe Coding** (AI-driven iterative design & implementation)

---

## ✨ 주요 기능

- 🎥 **YouTube 재생목록 자동 수집** — YouTube Data API v3로 재생목록 영상 전체 조회
- 🤖 **Gemini AI 자동 요약** — 영상 제목·설명·태그 기반 4섹션 보고서 자동 생성
- 📝 **Notion DB 자동 저장** — 요약 결과를 Notion 데이터베이스에 구조화하여 저장
- 🔄 **스마트 중복 방지** — Notion 전체 캐시 로드 후 메모리에서 즉시 중복 체크
- 📊 **통계 자동 업데이트** — 조회수(10% 이상 변화 시), 구독자수 변경 감지
- 📓 **Obsidian 자동 동기화** — 신규 저장 완료 시 Obsidian LLM Wiki 자동 업데이트
- 🔗 **Wiki 링크 자동 구성** — 재생목록별 MOC, 채널별 목차, 키워드 링크 자동 생성
- 📱 **텔레그램 알림** — 노션 저장 결과 + Obsidian 동기화 결과 통합 전송
- 📧 **이메일 알림** — Gmail SMTP를 통한 이메일 알림 (선택)
- ⏰ **launchd 자동 스케줄링** — Mac 로그인 시 서버 자동 시작, 6시간 간격 스케줄러 실행


---

## 🏗️ 전체 파이프라인

```
YouTube 재생목록
      ↓
 웹앱 / 스케줄러
      ↓
 Gemini AI 요약
      ↓
 Notion DB 저장
      ↓  (신규 저장 > 0 이면 자동 실행)
 sync_obsidian.py
  ├── 신규 영상 .md 파일 생성
  └── build_obsidian_wiki.py
        ├── 재생목록별 MOC 재구성
        ├── 채널별 목차 재구성
        └── 키워드 링크 삽입
      ↓
 텔레그램 결과 전송
  ├── 노션 저장 결과
  └── Obsidian 동기화 결과
```

---

## 🏛️ 아키텍처

```
┌─────────────────────────────────────────────┐
│              웹 앱 (index.html)              │
│  체크박스 선택 → 선택된 재생목록만 실행       │
│  완료 후 → POST /api/sync-obsidian 자동 호출 │
└──────────────┬──────────────────────────────┘
               │ localhost:3000
┌──────────────▼──────────────────────────────┐
│           서버 (server.js)                   │
│  Notion API 프록시                           │
│  /api/config  → .env 키 자동 로드            │
│  /api/sync-obsidian → Python 동기화 트리거   │
│  로그인 시 자동 시작 (launchd KeepAlive)     │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│         스케줄러 (scheduler.js)              │
│  6시간 간격 자동 실행 (00/06/12/18시)         │
│  완료 후 → sync_obsidian.py 자동 실행        │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│      Obsidian LLM Wiki (Python)             │
│  sync_obsidian.py  → 신규 .md 증분 추가     │
│  build_obsidian_wiki.py → MOC + 링크 재구성 │
└─────────────────────────────────────────────┘
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

## 📁 파일 구조

```
Youtube_Notion_Grap/
├── server.js                          # 웹 서버 + Notion API 프록시 + Obsidian 트리거
├── scheduler.js                       # 자동 스케줄러 (6시간 간격)
├── index.html                         # 웹 앱 UI (단일 파일)
├── package.json                       # Node.js CommonJS 설정
├── playlists.json                     # 등록된 재생목록 목록
├── .env                               # API 키 (gitignore — 절대 커밋 금지)
├── favicon.svg                        # 브라우저 탭 아이콘
├── notion_to_obsidian.js              # Notion → Obsidian 일회성 마이그레이션
├── sync_obsidian.py                   # Obsidian 증분 동기화 (신규 영상만 추가)
├── build_obsidian_wiki.py             # MOC + 채널 목차 + 키워드 링크 빌더
├── cleanup_duplicates.py              # 노션/Obsidian 중복 정리 도구
├── com.irichgreen.server.plist        # launchd 서버 자동시작 설정
├── com.irichgreen.ytsummarizer.plist  # launchd 스케줄러 설정
├── install-server.sh                  # 서버 자동시작 설치 스크립트
├── install-scheduler.sh               # 스케줄러 설치 스크립트
└── README.md
```

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
```

> `.env` 파일을 저장하면 서버 재시작 시 자동으로 로드됩니다.  
> 웹 앱도 서버의 `/api/config` 엔드포인트를 통해 키를 자동 수신합니다.


---

## 📦 설치 및 실행

### 1. 사전 요구사항

- Node.js v18 이상, Python 3
- YouTube Data API v3 키
- Google Gemini API 키 (이 프로젝트 전용 별도 키 권장)
- Notion Integration 토큰 + 데이터베이스 ID
- (선택) Telegram Bot Token + Chat ID

### 2. `.env` 파일 생성

위 환경 변수 설정 섹션을 참조하여 `.env` 파일을 생성합니다.

### 3. 서버 실행 (수동)

```bash
cd ~/Documents/Claude/Youtube_Notion_Grap
node server.js
# 브라우저에서 http://localhost:3000 접속
```

### 4. Mac 로그인 시 자동 시작 설치 (최초 1회)

```bash
bash install-server.sh     # 서버 자동 시작 등록 (포트 3000)
bash install-scheduler.sh  # 6시간 간격 스케줄러 등록
```

---

## 🖥️ 웹 앱 사용법

1. 브라우저에서 `http://localhost:3000` 접속
2. **재생목록 추가**: URL 입력 후 `+ 추가` 클릭
3. **체크박스 선택**: 처리할 재생목록만 선택 (헤더 체크박스로 전체 선택/해제)
4. **▶ 선택 실행** 클릭
5. 진행 상황 실시간 확인
6. 완료 시 텔레그램 알림 수신 (노션 + Obsidian 결과 포함)

---

## ⏰ 스케줄러 관리

```bash
# 상태 확인
launchctl list | grep irichgreen

# 스케줄러 즉시 실행
launchctl start com.irichgreen.ytsummarizer

# 서버 재시작
launchctl stop com.irichgreen.server && launchctl start com.irichgreen.server

# 로그 확인
tail -f ~/Documents/Claude/Youtube_Notion_Grap/scheduler.log
```

---

## ⚙️ 성능 최적화

- **YouTube 배치 조회**: 영상 50개씩 묶어서 API 호출 (1,200번 → 24번)
- **Notion 전체 캐시**: 실행 시작 시 DB 전체 로드 → 메모리에서 중복 체크
- **채널 구독자 병렬 조회**: `Promise.all`로 채널별 동시 조회
- **Gemini 병렬 요약**: 신규 영상 3개씩 동시 처리
- **스마트 Skip**: 중복 영상은 딜레이 없이 즉시 처리
- **조회수/구독자 스마트 업데이트**: 20% 이상 변화 시만 Notion API 호출
- **Obsidian 증분 동기화**: notion_id 기반으로 신규 영상만 추가 (전체 재생성 X)

> 1,200개 영상 기준: 기존 2시간 37분 → **약 3~5분**으로 단축


---

## 📓 Obsidian LLM Wiki

노션에 저장된 AI 영상 요약을 Obsidian 지식베이스로 자동 변환합니다.

### Vault 구조

```
📁 Obsidian Vault/
├── 📁 _MOC/                        ← 허브 파일 (Map of Contents)
│   ├── 🗂 AI 바이브코딩 MOC.md     ← 재생목록별 영상 목차
│   ├── 🗂 AI Claude MOC.md
│   ├── 📋 채널별 목차.md           ← 채널별 영상 목록
│   ├── 🔑 키워드 인덱스.md         ← AI 도구/기술 키워드 인덱스
│   ├── 🔍 lint.md                  ← Wiki 헬스체크 결과 (자동 생성)
│   └── 📊 dataview-queries.md      ← Dataview 쿼리 모음
├── 📁 AI 바이브코딩/               ← 재생목록별 폴더
│   └── 채널명_영상제목_날짜.md     ← 영상 요약 파일
├── 📁 AI Claude/
├── 📁 AI Gemini/
├── ... (재생목록별 폴더)
├── 🗂 전체 인덱스.md               ← Wiki 시작점 (카탈로그 + 한 줄 요약)
├── 📋 log.md                       ← 변경 이력 (자동 기록, append-only)
└── 📐 schema.md                    ← Wiki 구조 정의 (자동 재생성)
```

### 각 영상 .md 파일 구조

```markdown
---
title: "영상 제목"
channel: "채널명"
tags: ["AI 바이브코딩", "AI Claude"]
upload_date: 2026-03-15
view_count: 42000
subscriber_count: 141000
video_url: https://youtube.com/watch?v=...
notion_id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
---

## 영상 개요
...

## 핵심 내용
...Gemini AI가 생성한 요약...

---
## 🔗 관련 항목
[[Claude]] [[MCP]] [[바이브코딩]]

**재생목록**: [[AI 바이브코딩 MOC]]
```

### Obsidian 관련 명령

```bash
# 전체 마이그레이션 (최초 1회)
node notion_to_obsidian.js

# 증분 동기화 + Wiki 재구성
python3 sync_obsidian.py

# Wiki 강제 재구성 (파일 추가 없이 링크만 재구성)
python3 sync_obsidian.py --rebuild

# MOC + 키워드 링크만 재구성
python3 build_obsidian_wiki.py

# 노션 + Obsidian 중복 정리 (dry-run: 실제 삭제 없이 확인만)
python3 cleanup_duplicates.py --dry-run
python3 cleanup_duplicates.py
```

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
| 주제 | Multi-Select | 재생목록명 (playlists.json 기반, AI 바이브코딩 등 한글 통일) |

---

## 📱 텔레그램 알림 형식

```
🎬 YouTube → Notion 요약 완료
📅 2026. 4. 15. PM 6:00
⏱ 소요시간: 43분 56초

• AI 바이브 코딩: 저장 2/ 스킵 569/ 오류 0
• AI Claude: 저장 1/ 스킵 495/ 오류 0
...
📊 합계: 저장 12/ 스킵 2283/ 오류 0

📓 Obsidian AI LLM Wiki
  • 신규 추가: 12개
  • Wiki 재구성: ✅ 완료
  • 소요시간: 87초
```

---

## 📝 버전 히스토리

| 버전 | 주요 내용 |
|------|-----------|
| v1~v62 | 기본 기능 구현, UI 개선, 성능 최적화, 버그 수정 |
| v63 | 조회수/구독자 비교 버그 수정, 극한 속도 개선 |
| v64 | API 키를 `.env` 파일로 분리 (보안 강화) |
| v65 | 웹앱 API 키 `.env` 자동 로드 (`/api/config` 엔드포인트) |
| v66~v67 | 포트 3000 정리 (웹앱 3000, 재무자동화 3001, 대시보드 5173) |
| v68~v70 | 텔레그램 메시지 포맷 간소화 (한글화, 글자수 단축) |
| v71 | 재생목록 주제 태그 이모지 깨짐 수정 (playlists.json name 사용) |
| v72 | Obsidian LLM Wiki 자동 동기화 파이프라인 구축 |
| v73 | 텔레그램 알림에 Obsidian 동기화 결과 포함 |
| v74 | URL 기준 중복 체크 변경 + 노션/Obsidian 중복 정리 스크립트 추가 |
| v75 | 주제 태그 `AI 바이브 코딩` → `AI 바이브코딩` 통합 정리 |
| v76 | 주제 태그 명칭 정리 (AI Notebook LM→AI 노트북 LM, AI 구글 AI Studio→AI Studio, AI 구글 Gemma→AI Gemma) |
| v77 | 키워드 없는 파일도 MOC 링크 항상 추가 (Obsidian 그래프 독립 노드 해소) |
| v78 | 캐시 videoId+title 이중 등록으로 중복 저장 버그 수정 |
| v79 | [1순위] log.md 자동 생성 — sync 실행 시 ingest/rebuild/error 자동 기록 |
| v80 | [2~5순위] index.md 카탈로그 개선, Lint 헬스체크, schema.md, Dataview 쿼리 (Karpathy LLM Wiki 방법론) |
| v81 | schema.md 자동 재생성 — build 실행 시 태그/폴더 현황 동적 반영 |
| v82 | 구독자수 업데이트 조건 변경 (단순 변경 → 20% 이상 변화 시만) |
| v83 | 조회수 업데이트 조건 변경 (10% → 20% 이상 변화 시만) + README 동기화 |
| v84 | VALID_NOTION_TAGS 상수 추가, 구버전 태그 MOC 자동 방지, 다중 태그 MOC 링크로 독립 노드 해소 |
| v85 | 기타 MOC/폴더 제거, cleanup_duplicates.py 오류 재시도 로직 추가 |
| v86 | 키워드 목록 엄선 — 빈 파일 생성 방지 ([NotebookLM, API, 날짜 빈파일 제거) |
| v87 | 한글 깨짐 근본 해결 — macOS NFD→NFC 정규화 (파일명/내용 전체 적용) |
| v88 | NFC 정규화 전수 적용 — build/sync 모든 파일 쓰기에 nfc() 함수 적용 |

---

## 🔒 보안 주의사항

- **`.env` 파일**: API 키 보관 — `.gitignore`에 등록되어 GitHub에 절대 올라가지 않음
- **Notion 토큰**: 외부 공개 금지
- **Gemini API 키**: 이 프로젝트 전용 별도 키 사용 권장 (Google Cloud 비용 분리)
- **playlists.json**: 개인 재생목록 정보 포함 — 필요 시 `.gitignore` 추가 권장

---

## 🔌 포트 구성

| 포트 | 프로그램 |
|------|---------|
| **3000** | YouTube → Notion AI 요약기 (이 프로그램) |
| **3001** | 재무 데이터 자동 다운로드 및 엑셀 업데이트 |
| **5173** | 아이리치그린 재무 대시보드 |

---

© 2026 iRichGreen AI Development Team.  
Powered by **Claude (Anthropic)** & **Gemini 2.5 Flash (Google)**
