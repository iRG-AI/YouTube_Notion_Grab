const fs = require('fs');
const path = require('path');

const PENDING_FILE = path.join(__dirname, '../pending_playlist_adds.json');
const BACKUP_FILE = path.join(__dirname, '../pending_playlist_adds.json.bak');

function log(msg) {
  console.log(`[Queue Cleaner] ${msg}`);
}

function cleanQueue() {
  if (!fs.existsSync(PENDING_FILE)) {
    log('pending_playlist_adds.json 파일이 존재하지 않습니다.');
    return;
  }

  log('기존 pending 파일 로딩 중...');
  let queue = [];
  try {
    const raw = fs.readFileSync(PENDING_FILE, 'utf8');
    queue = JSON.parse(raw);
  } catch (e) {
    log(`파일 파싱 에러 (JSON 형식이 깨졌을 수 있음): ${e.message}`);
    return;
  }

  log(`현재 대기열 개수: ${queue.length}개`);

  // 백업 파일 생성
  fs.writeFileSync(BACKUP_FILE, JSON.stringify(queue, null, 2), 'utf8');
  log(`원본 파일을 백업했습니다 ➔ ${BACKUP_FILE}`);

  // 오래되었거나(3일 이상), 혹은 회복 불가능한 인증/권한 에러(403, 400, invalid_grant, accessNotConfigured)가 발생했던 항목 제외
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const beforeSize = queue.length;
  const filteredQueue = queue.filter(item => {
    // 1. 에러 사유 체크
    const reason = (item.reason || '').toLowerCase();
    const isFatalError = reason.includes('invalid_grant') || 
                         reason.includes('accessnotconfigured') || 
                         reason.includes('403') ||
                         reason.includes('400');
    
    if (isFatalError) return false;

    // 2. 날짜 체크 (3일 이내의 정상적인 임시 에러만 보존)
    if (item.ts) {
      const itemDate = new Date(item.ts);
      if (isNaN(itemDate.getTime()) || itemDate < threeDaysAgo) {
        return false; // 날짜가 없거나 3일 이전 항목은 삭제
      }
    } else {
      return false; // 날짜가 없는 미상 항목 삭제
    }

    return true;
  });

  const afterSize = filteredQueue.length;
  const deletedCount = beforeSize - afterSize;

  // 필터링된 결과 저장
  fs.writeFileSync(PENDING_FILE, JSON.stringify(filteredQueue, null, 2), 'utf8');
  log(`정리 완료! ${deletedCount}개의 만료/오류 항목을 삭제했습니다.`);
  log(`남은 정상 대기 항목: ${afterSize}개 (파일 갱신 완료)`);
}

cleanQueue();
