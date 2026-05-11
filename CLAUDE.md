# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

# launchd 제어 (6시간 자동 실행)
launchctl start com.irichgreen.ytsummarizer
launchctl stop com.irichgreen.ytsummarizer

# YouTube OAuth 토큰 재발급 (1회성)
node oauth_setup.js

# OAuth 연결 확인
node -e "require('./lib/youtube_oauth').getAccessToken().then(t => console.log('✅', t.slice(0,20))).catch(e => console.error('❌', e.message))"
```

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
| `sync_obsidian.py` | Notion DB → Obsidian 증분 동기화. 내부적으로 `wiki_ingest.py`와 연동. |
| `wiki_ingest.py` | Karpathy LLM Wiki 파이프라인. Obsidian 노트를 순회하며 Gemini로 개념 단위 지식 추출 및 합성. |
| `wiki_config.py` | Wiki 인제스트 설정 관리. 230 RPD 토큰 제한, API Rate limit 추적 및 예외 처리 로직 포함. |
| `build_obsidian_wiki.py` | 키워드별 허브 파일 27개 자동 생성(`_MOC/Claude.md` 등) + MOC 재구성. |
| `migrate_classify.js` | 기존 영상 일괄 재분류. `.migrate_state.json`으로 재개 가능. |
| `playlists.json` | 33개 토픽 재생목록 목록. 분류기의 허용 토픽 소스이기도 함. |
| `pending_playlist_adds.json` | YouTube quota 초과 시 적재되는 큐. 다음 cron 실행 시 자동 처리. |

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

**YouTube Quota**: 일일 10,000 유닛. `playlistItems.insert`는 50유닛. 임계(9,500유닛) 도달 시 `pending_playlist_adds.json`에 적재 후 다음날 처리.

**Gemini API 최적화 (중요)**: Gemini 2.5 Flash 모델 사용 시 내부 추론 과정에서 과다한 "Thinking 토큰" 과금을 방지하기 위해 반드시 API 호출 옵션에 `generationConfig: { thinkingConfig: { thinkingBudget: 0 } }`를 적용해야 합니다 (비용 85% 절감 효과).

**토픽 추가 시**: `playlists.json`에 새 항목 추가 + `build_obsidian_wiki.py`의 `VALID_NOTION_TAGS` 동기화 필수.

**server.js 보안**: Notion API 프록시는 `ALLOWED_NOTION_PATHS` 화이트리스트만 통과. CORS는 `localhost:3000`만 허용. IP당 분당 120요청 rate limit.

### 로그 파일

- `scheduler.log` / `scheduler-stdout.log`: 스케줄러 실행 로그 (용량 큼, 주기적 확인 필요)
- `server.log`: 서버 요청 로그
- Obsidian vault의 `log.md`: wiki 변경 이력
