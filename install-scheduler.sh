#!/bin/bash
# =========================================================
# Mac launchd 자동 등록 스크립트
# 터미널에서 실행: bash install-scheduler.sh
# =========================================================

set -e

# 현재 폴더 경로 자동 감지
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.irichgreen.ytsummarizer.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
PLIST_SRC="$APP_DIR/$PLIST_NAME"

echo ""
echo "================================================"
echo "  YouTube → Notion 자동 스케줄러 설치"
echo "================================================"
echo "  앱 폴더: $APP_DIR"
echo ""

# ── node 경로 확인 ──
NODE_PATH="$(which node 2>/dev/null || echo '')"
if [ -z "$NODE_PATH" ]; then
  # nvm 사용자 대비
  NODE_PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -1)/bin/node"
fi
if [ ! -f "$NODE_PATH" ]; then
  echo "❌ Node.js를 찾을 수 없습니다."
  echo "   https://nodejs.org 에서 Node.js를 설치한 후 다시 실행하세요."
  exit 1
fi
echo "  Node.js 경로: $NODE_PATH"

# ── scheduler.js 설정값 확인 (실제 값이 기본값 그대로인지만 체크) ──
if grep -q "youtubeApiKey:  'YOUR_YOUTUBE_API_KEY'" "$APP_DIR/scheduler.js"; then
  echo ""
  echo "⚠️  scheduler.js 의 CONFIG 설정값이 비어있습니다."
  echo "   scheduler.js 파일을 열어 아래 값을 채워주세요:"
  echo "   - youtubeApiKey"
  echo "   - geminiApiKey"
  echo "   - notionToken"
  echo "   - notionDbId"
  echo ""
  read -p "설정값을 채운 후 Enter를 눌러 계속하거나, Ctrl+C로 종료하세요..."
fi

# ── plist 파일 경로 치환 후 복사 ──
mkdir -p "$HOME/Library/LaunchAgents"

sed \
  -e "s|/Users/사용자명/youtube-notion-app/scheduler.js|$APP_DIR/scheduler.js|g" \
  -e "s|/Users/사용자명/youtube-notion-app|$APP_DIR|g" \
  -e "s|/usr/local/bin/node|$NODE_PATH|g" \
  "$PLIST_SRC" > "$PLIST_DST"

echo "  plist 설치 위치: $PLIST_DST"

# ── 기존 등록 해제 후 재등록 ──
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo ""
echo "================================================"
echo "  ✅ 설치 완료! 매일 00:30에 자동 실행됩니다."
echo ""
echo "  지금 즉시 테스트 실행:"
echo "  launchctl start com.irichgreen.ytsummarizer"
echo ""
echo "  로그 확인:"
echo "  tail -f $APP_DIR/scheduler-stdout.log"
echo ""
echo "  제거하려면:"
echo "  launchctl unload $PLIST_DST"
echo "================================================"
echo ""
