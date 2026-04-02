# 🎬 YouTube → Notion AI 요약기

YouTube 재생목록의 영상을 **Gemini AI**로 자동 요약하여 **Notion 데이터베이스**에 저장하는 풀스택 자동화 솔루션입니다.

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
- 📊 **통계 자동 업데이트** — 조회수(10% 이상 변화 시), 구독자수, 업로드일 변경 감지
- 📱 **텔레그램 알림** — 작업 완료 시 텔레그램 봇으로 결과 자동 전송
- 📧 **이메일 알림** — Gmail SMTP를 통한 이메일 알림 (선택)
- ⏰ **launchd 자동 스케줄링** — Mac 로그인 시 서버 자동 시작, 6시간 간격 스케줄러 실행

---

## 🏗️ 아키텍처

```
┌─────────────────────────────────────────────┐
│              웹 앱 (index.html)              │
│  체크박스 선택 → 선택된 재생목록만 실행       │
│  Notion 전체 캐시 → 배치 조회 → 병렬 요약    │
└──────────────┬──────────────────────────────┘
               │ localhost:3000
┌──────────────▼──────────────────────────────┐
│           서버 (server.js)                   │
│  Express + Notion API 프록시                 │
│  로그인 시 자동 시작 (launchd KeepAlive)      │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│         스케줄러 (scheduler.js)              │
│  6시간 간격 자동 실행 (00/06/12/18시)         │
│  전체 재생목록 순차 처리                      │
└─────────────────────────────────────────────┘
```

---

## 🛠️ 기술 스택

| 분류 | 기술 |
|------|------|
| **Runtime** | Node.js v25+ |
| **Backend** | Express.js (Notion API 프록시 서버) |
| **Frontend** | Vanilla HTML/CSS/JavaScript (Single File) |
| **AI 요약** | Google Gemini 2.5 Flash API |
| **데이터 소스** | YouTube Data API v3 |
| **저장소** | Notion Database API |
| **알림** | Telegram Bot API, Gmail SMTP |
| **스케줄링** | macOS launchd |

---

## 📁 파일 구조

```
Youtube_Notion_Grap/
├── server.js                      # Express 웹 서버 + Notion API 프록시
├── scheduler.js                   # 자동 스케줄러 (6시간 간격)
├── index.html                     # 웹 앱 UI (단일 파일)
├── package.json                   # Node.js CommonJS 설정
├── playlists.json                 # 등록된 재생목록 목록
├── favicon.svg                    # 브라우저 탭 아이콘
├── com.irichgreen.server.plist    # launchd 서버 자동시작 설정
├── com.irichgreen.ytsummarizer.plist  # launchd 스케줄러 설정
├── install-server.sh              # 서버 자동시작 설치 스크립트
├── install-scheduler.sh           # 스케줄러 설치 스크립트
└── README.md
```

---

## ⚙️ 성능 최적화

- **YouTube 배치 조회**: 영상 50개씩 묶어서 API 호출 (1,200번 → 24번)
- **Notion 전체 캐시**: 실행 시작 시 DB 전체 로드 → 메모리에서 중복 체크 (API 호출 0)
- **채널 구독자 병렬 조회**: `Promise.all`로 채널별 동시 조회
- **Gemini 병렬 요약**: 신규 영상 3개씩 동시 처리
- **스마트 Skip**: 중복 영상은 딜레이 없이 즉시 처리
- **조회수 스마트 업데이트**: 10% 이상 변화 시만 Notion API 호출

> 1,200개 영상 기준: 기존 2시간 37분 → **약 3~5분**으로 단축

---

## 📦 설치 및 실행

### 1. 사전 요구사항

- Node.js v18 이상
- YouTube Data API v3 키
- Google Gemini API 키
- Notion Integration 토큰 + 데이터베이스 ID
- (선택) Telegram Bot Token + Chat ID

### 2. 설정

`scheduler.js` 상단의 CONFIG 값을 입력하세요:

```javascript
const CONFIG = {
  youtubeApiKey:  'YOUR_YOUTUBE_API_KEY',
  geminiApiKey:   'YOUR_GEMINI_API_KEY',
  notionToken:    'YOUR_NOTION_TOKEN',
  notionDbId:     'YOUR_NOTION_DB_ID',
  telegram: {
    enabled:  true,
    botToken: 'YOUR_BOT_TOKEN',
    chatId:   'YOUR_CHAT_ID',
  },
};
```


### 3. 서버 실행 (수동)

```bash
cd ~/Documents/Claude/Youtube_Notion_Grap
node server.js
# 브라우저에서 http://localhost:3000 접속
```

### 4. Mac 로그인 시 자동 시작 설치 (최초 1회)

```bash
# 서버 자동 시작 등록
bash install-server.sh

# 스케줄러 자동 실행 등록
bash install-scheduler.sh
```

---

## 🖥️ 웹 앱 사용법

1. 브라우저에서 `http://localhost:3000` 접속
2. **재생목록 추가**: URL 입력 후 `+ 추가` 클릭
3. **체크박스 선택**: 처리할 재생목록만 선택 (헤더 체크박스로 전체 선택/해제)
4. **▶ 선택 실행** 클릭
5. 진행 상황 실시간 확인 및 처리 결과 테이블 자동 스크롤

---

## ⏰ 스케줄러 관리

```bash
# 상태 확인
launchctl list | grep irichgreen

# 스케줄러 즉시 실행
launchctl start com.irichgreen.ytsummarizer

# 서버 재시작
launchctl stop com.irichgreen.server
launchctl start com.irichgreen.server

# 로그 확인
tail -f ~/Documents/Claude/Youtube_Notion_Grap/scheduler.log
tail -f ~/Documents/Claude/Youtube_Notion_Grap/scheduler-stdout.log
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
| 주제 | Multi-Select | 재생목록명 (다중 선택) |

---

## 📝 버전 히스토리

| 버전 | 주요 내용 |
|------|-----------|
| v1~v10 | 기본 기능 구현 (YouTube 수집, Gemini 요약, Notion 저장) |
| v11~v20 | UI 개선, 텔레그램/이메일 알림 추가 |
| v21~v30 | 체크박스 선택 실행, 처리 결과 테이블 추가 |
| v31~v40 | Notion 전체 캐시, YouTube 배치 조회 최적화 |
| v41~v50 | 중복 저장 버그 수정, 실시간 카운트, 자동 스크롤 |
| v51~v60 | 병렬 처리, 속도 최적화, 파비콘, launchd 자동 시작 |
| v61~v63 | node 경로 수정, 조회수/구독자 비교 버그 수정, 극한 속도 개선 |

---

## 🔒 보안 주의사항

- `scheduler.js`의 API 키는 환경변수로 분리 권장
- `playlists.json`은 개인 재생목록 정보 포함 — `.gitignore`에 추가 권장
- Notion 토큰은 외부 공개 금지

---

© 2026 iRichGreen AI Development Team.  
Powered by **Claude (Anthropic)** & **Gemini 2.5 Flash (Google)**.
