================================================
  YouTube → Notion AI 요약기 v14
  (재생목록 관리 + Mac 자동 스케줄러)
================================================

[파일 구성]
  server.js                          ← 브라우저용 로컬 서버
  scheduler.js                       ← Mac 자동 실행 스크립트
  index.html                         ← 웹 UI (재생목록 관리 포함)
  playlists.json                     ← 재생목록 목록 (자동 생성)
  com.irichgreen.ytsummarizer.plist  ← Mac launchd 설정
  install-scheduler.sh               ← 자동 설치 스크립트
  scheduler.log                      ← 자동 실행 로그 (자동 생성)

────────────────────────────────────────────
  STEP 1. 브라우저에서 재생목록 등록
────────────────────────────────────────────
1. 터미널에서 서버 실행:
   node server.js

2. 브라우저에서 접속:
   http://localhost:3000

3. API 키 설정 후 재생목록 URL + 별명 입력하여 추가
   (등록한 목록은 playlists.json 에 자동 저장)

4. [▶ 전체 실행] 버튼으로 즉시 테스트 가능

────────────────────────────────────────────
  STEP 2. scheduler.js 설정값 입력
────────────────────────────────────────────
scheduler.js 파일을 편집기로 열고 CONFIG 채우기:

  const CONFIG = {
    youtubeApiKey:  'AIzaSy...',
    geminiApiKey:   'AIzaSy...',
    notionToken:    'secret_...',
    notionDbId:     '311a3cbc...',
  };

────────────────────────────────────────────
  STEP 3. Mac 자동 스케줄러 설치 (1회만)
────────────────────────────────────────────
터미널에서 아래 명령어 실행:
  bash install-scheduler.sh

→ 매일 00:30에 자동 실행됩니다
→ Mac이 켜져 있어야 합니다 (Sleep 중 실행 안 됨)
   시스템 설정 → 배터리 → 잠자기 비활성화 권장

────────────────────────────────────────────
  유용한 터미널 명령어
────────────────────────────────────────────
  # 즉시 테스트 실행
  launchctl start com.irichgreen.ytsummarizer

  # 등록 확인
  launchctl list | grep irichgreen

  # 로그 실시간 확인
  tail -f scheduler.log

  # 스케줄러 제거
  launchctl unload ~/Library/LaunchAgents/com.irichgreen.ytsummarizer.plist
