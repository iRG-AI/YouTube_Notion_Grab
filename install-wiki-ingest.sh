#!/bin/bash
# Karpathy LLM Wiki Ingest — launchd 설치 스크립트
# 매일 03:00에 자동 실행, 일일 한도 도달 시 자동 중단/재개

set -e

PLIST_NAME="com.irichgreen.wiki-ingest"
PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/${PLIST_NAME}.plist"
PLIST_DST="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"

echo "🧠 Karpathy Wiki Ingest 스케줄러 설치"
echo ""

# 기존 제거
if launchctl list | grep -q "$PLIST_NAME" 2>/dev/null; then
  echo "  ⏹  기존 스케줄 제거 중..."
  launchctl unload "$PLIST_DST" 2>/dev/null || true
fi

# 복사 및 등록
cp "$PLIST_SRC" "$PLIST_DST"
launchctl load "$PLIST_DST"

echo "  ✅ 설치 완료!"
echo ""
echo "  📅 실행 시간: 매일 03:00"
echo "  📁 로그: wiki_ingest.log"
echo "  🔄 일일 ~230개 자동 처리, 전체 완료까지 약 10일"
echo ""
echo "  수동 실행: launchctl start $PLIST_NAME"
echo "  상태 확인: cat .wiki_quota.json"
echo "  제거:      launchctl unload $PLIST_DST"
