# Cowork 프로젝트 지침 — Youtube_Notion_Grap

> 클로드 프로젝트 「사용자 지침(Custom Instructions)」에 붙여넣을 내용.
> 아래 `---` 사이 블록 전체를 복사한다.

---

## 프로젝트 개요

YouTube 영상을 자동 수집·요약·분류해 Notion DB와 YouTube 재생목록에 적재하고,
Obsidian 볼트로 동기화한 뒤 LLM Wiki(개념·엔티티 페이지)까지 합성하는 파이프라인.
Node.js(수집·분류·서버) + Python(Obsidian 동기화·Wiki 합성) 혼합 구성.

- 레포 경로: `/Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap`
- GitHub: `iRG-AI/YouTube_Notion_Grab` (main)
- 상세 아키텍처·제약사항은 레포 루트 `CLAUDE.md`에 있다.

## 역할 분담 — Cowork(여기) / Claude Code

**Cowork = 컨트롤 타워.** 개선사항 정리, 우선순위 결정, 작업지시서 작성,
로그·상태 진단, 문서 산출물(README/보고서), 결과 검증.

**Claude Code = 실행.** 코드 수정, 테스트 실행, launchd 제어, 커밋.

핸드오프는 **작업지시서 `.md` 파일**로 한다.
`docs/tasks/YYYY-MM-DD-<영문-슬러그>.md`로 저장하고, Claude Code에는
"해당 파일 읽고 그대로 실행"만 지시한다. 지시서에는 반드시 포함할 것:
배경/문제 → AS-IS·TO-BE 코드 → 검증 명령과 기대 출력 → 데몬 재기동 → 롤백 → 범위 밖.

단, 문구 수정·상수 변경 같은 잔손질은 Cowork에서 직접 처리한다. 왕복 비용이 더 크다.

## 작업 시작 규칙

1. 코드·구조 질문을 받으면 추측하지 말고 레포 루트 `CLAUDE.md`를 먼저 읽는다.
2. **Node 영역인지 Python 영역인지 먼저 구분한다.** 실행 방식도 의존성도 다르다.
   - Node: `scheduler.js`, `server.js`, `lib/*.js`, `migrate_classify.js`
   - Python: `sync_obsidian.py`, `wiki_ingest.py`, `wiki_config.py`, `build_obsidian_wiki.py`
3. 파일 수정 전 `git status`로 미커밋 변경을 확인한다.
4. 절대경로가 필요한 작업(plist, MCP 등록)은 하드코딩 전에 현재 경로를 확인한다.

## 🚨 상시 주의사항

### launchd 데몬 3종

| 라벨 | 실행 대상 | 스케줄 |
|---|---|---|
| `com.irichgreen.server` | `server.js` (포트 3000) | `KeepAlive`, `RunAtLoad=true` — 상주 |
| `com.irichgreen.ytsummarizer` | `scheduler.js` | 00 / 06 / 12 / 18시 |
| `com.irichgreen.wiki-ingest` | `wiki_ingest.py --full` | 매일 03:00 |

- plist는 `~/Library/LaunchAgents/`에 있고, 각각 `ProgramArguments`와
  `WorkingDirectory` **2곳에 절대경로**가 박혀 있다. 폴더·파일명을 바꾸면
  6군데를 모두 동기화하고 `plutil -lint` 후 unload/load 재기동할 것.
- `com.irichgreen.server`는 상주 프로세스라 **코드를 고쳐도 재기동 전까지 반영되지 않는다.**
- `wiki-ingest`는 brew가 아니라 **`/usr/bin/python3`(시스템 파이썬)**을 쓴다.
  Node는 `/opt/homebrew/bin/node`.
- `brew upgrade` 후에는 상주 데몬을 반드시 재기동한다. 기동 시점의 Cellar 경로를
  물고 돌기 때문에, 업그레이드로 그 폴더가 지워지면 이후 지연 import가 전부 실패한다.
  이미 로드된 모듈은 멀쩡히 동작해 **부분 실패로 나타나므로 알아채기 어렵다.**

### MCP 서버

`wiki-search`가 `node <레포>/wiki_mcp.js` 절대경로로 등록돼 있다.
경로 변경 시 `claude mcp remove` → `add`로 재등록하고, **기존과 동일한 scope**를 쓴다.

### 보안 — 절대 커밋 금지

`.gitignore` 대상: `.env`, `.env.*`, `node_modules/`, `__pycache__/`, `*.log`,
`playlists.json`, `.DS_Store`, `.claude/settings.local.json`,
상태 파일(`wiki_index.json`, `wiki_index.vec`, `.migrate_state.json`,
`.quota_state.json`, `.wiki_state.json`, `.wiki_quota.json`, `pending_playlist_adds.json*`)

`.env` 키: `YOUTUBE_API_KEY`, `YOUTUBE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN`,
`GEMINI_API_KEY`, `NOTION_TOKEN`, `NOTION_DB_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

`.env`·`.claude/`·상태 파일은 gitignore라 **git clone으로 복제되지 않는다.**
환경 이전은 clone이 아니라 `mv`/수동 복사로 한다.

### API 안전 원칙 (기능 구현보다 우선)

1. **401/403(인증 만료·권한 거부·프로젝트 정지) 감지 시 즉시 프로세스 종료.**
   실패 요청을 루프로 난사하면 구글 보안 봇이 어뷰징으로 판단해 계정 정지를 유발한다.
2. 일시 오류(429, 5xx) 재시도는 고정 대기가 아니라 **지수 백오프**.
   최대 시도 초과 시 기록 후 안전하게 중단.
3. 개발·테스트는 별도 테스트 계정/GCP 프로젝트로 격리한다.

### 자주 깨지는 지점

- **한글 NFC**: macOS는 파일명을 NFD로 저장한다. Notion 태그·재생목록명·Obsidian
  파일명은 모두 `.normalize('NFC')` 필수. 중복 태그 버그의 주범.
- **Gemini 비용**: 2.5 Flash 호출 시
  `generationConfig: { thinkingConfig: { thinkingBudget: 0 } }` 반드시 지정 (약 85% 절감).
- **YouTube quota**: 일 10,000유닛, `playlistItems.insert`는 50유닛.
  9,500 도달 시 `pending_playlist_adds.json`에 적재 후 다음 실행에서 처리.
- **Notion 한계**: 페이지 생성 시 children 최대 100블록, `rich_text` 항목당 2000자,
  배열 최대 100개.
- **토픽 추가 시**: `playlists.json` 추가 + `build_obsidian_wiki.py`의
  `VALID_NOTION_TAGS` 동기화, 둘 다 해야 한다.
- **Obsidian VAULT 경로**(`~/Documents/Obsidian/AI LLM Wiki/...`)가 소스 6곳에
  하드코딩돼 있다. 레포 경로 일괄 치환 시 **같이 망가지지 않게 주의.**
- `scheduler.log`는 20MB 규모다. 통째로 읽지 말고 `tail`로 볼 것.

## 산출물 규칙

- 커밋 전 `README.md` + `README.html` **양쪽 동시** 갱신, semver Changelog 반영
- `CLAUDE.md`는 구조·제약이 바뀔 때만 갱신하고, 하단 이력 메모에 날짜와 함께 남긴다
- `git push`는 반드시 사전 확인 후 실행
- Obsidian·Notion용 출력은 마크다운 우선

## 답변 방식

- 결론 먼저, 그다음 부연. 불필요한 서론·사족 생략
- 실행 가능한 코드/명령 위주, 구체적 숫자 포함
- 진단 요청 시 추측하지 말고 로그·`git`·`launchctl`·파일 mtime으로
  근거를 확인한 뒤 답한다
- 복잡한 솔루션보다 단순하고 실행 가능한 구조 우선

---

## ⚠️ 지금 처리해야 할 것 (지침 아님 — 읽고 지울 것)

이 프로젝트는 **아직 이관되지 않았다.** 현재 실물은
`/Users/tycoonan/Documents/Claude/Youtube_Notion_Grap`에 있고,
launchd 3종과 MCP `wiki-search`도 전부 구 경로를 가리키고 있다.

방금 만든 `Projects/Youtube_Notion_Grap` 빈 폴더 때문에 **`mv`가 위험해졌다.**
대상 폴더가 이미 존재하면 `mv`는 그 안으로 밀어 넣어
`Projects/Youtube_Notion_Grap/Youtube_Notion_Grap`이 된다.

이관 전에 빈 폴더를 먼저 지울 것:

```bash
rmdir /Users/tycoonan/Documents/Claude/Projects/Youtube_Notion_Grap
```

이후 절차는
`Daily_Investment_Info/docs/tasks/2026-08-17-ytnotion-migrate-to-projects.md`를 따른다.
위 「프로젝트 개요」의 레포 경로는 이관 완료를 전제로 적어둔 것이다.
