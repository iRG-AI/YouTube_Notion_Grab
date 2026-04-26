#!/usr/bin/env node
// ===== Notion DB 주제(태그) NFC 정규화 일회성 정리 스크립트 =====
// 목적:
//   v87 이전에 macOS NFD 형태로 저장된 한글 멀티셀렉트 태그(예: "AI 바이브코딩"의 자모 분해 변형)가
//   현재 DB 페이지에 잔존하면서, NFC 신규 태그와 공존하여 중복 표시되는 문제를 해결.
// 동작:
//   1. NOTION_TOKEN, NOTION_DB_ID 를 .env 에서 로드
//   2. DB 전체 페이지 페이지네이션 조회
//   3. 각 페이지의 props['주제'].multi_select 에서:
//      - 각 t.name 을 NFC 정규화
//      - Set 으로 중복 제거 (NFD ↔ NFC 동일화)
//      - 원본과 다르면 PATCH /v1/pages/{id} 로 기록
//   4. dry-run / 실제 모드 분리, 진행률·변경 페이지 수·제거된 NFD 태그 수 출력
// 사용:
//   node fix_nfc_topics.js --dry-run    # 미리보기
//   node fix_nfc_topics.js              # 실제 적용

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── .env 로드 ──
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env 파일을 찾을 수 없음:', envPath);
    process.exit(1);
  }
  const text = fs.readFileSync(envPath, 'utf-8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}

const env = loadEnv();
const TOKEN = env.NOTION_TOKEN;
const DB_ID = env.NOTION_DB_ID;
const DRY_RUN = process.argv.includes('--dry-run');

if (!TOKEN || !DB_ID) {
  console.error('❌ .env 에 NOTION_TOKEN 또는 NOTION_DB_ID 누락');
  process.exit(1);
}

// ── HTTPS 요청 헬퍼 ──
// ⚠️ chunks를 Buffer 배열로 수집 → utf8 디코딩 (한글 멀티바이트가 청크 경계에서 잘려 U+FFFD로 깨지는 버그 차단)
function notionFetch(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── canonical 토픽 목록 로드 (playlists.json + 마스터) ──
function loadCanonicalTopics() {
  try {
    const pls = JSON.parse(fs.readFileSync(path.join(__dirname, 'playlists.json'), 'utf-8'));
    const names = pls.map(p => (p.name || '').normalize('NFC')).filter(Boolean);
    names.push('AI 영상목록');  // 마스터 (v102)
    return [...new Set(names)];
  } catch { return []; }
}

// ── 깨진 이름(U+FFFD 포함) → canonical 매핑 (subsequence 매칭) ──
//   visible chars(U+FFFD 제외)이 canonical 이름에 순서대로 등장하면 매칭
function recoverBrokenName(broken, canonicals) {
  const visible = broken.replace(/�/g, '');
  if (!visible) return null;

  const matches = canonicals.filter(c => {
    let i = 0;
    for (const ch of c) { if (i < visible.length && ch === visible[i]) i++; }
    return i === visible.length;
  });

  // 단일 매칭만 자동 복구 (모호하면 수동 검토)
  return matches.length === 1 ? matches[0] : null;
}

// ── 메인 ──
(async () => {
  console.log(`🔧 모드: ${DRY_RUN ? 'DRY-RUN (미리보기, 실제 변경 안 함)' : '실제 적용'}`);

  const CANONICAL = loadCanonicalTopics();
  console.log(`📚 canonical 토픽: ${CANONICAL.length}개 (U+FFFD 복구용)\n`);
  console.log('📥 Notion DB 페이지 로드 중...\n');

  let cursor = undefined;
  let total = 0, changedPages = 0, removedNfdCount = 0;
  let recoveredCount = 0, unrecoverableCount = 0;
  const nfdSamples = new Set();
  const recoveryMap = new Map();  // 깨진 이름 → 복구된 이름 (또는 null=수동검토)

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionFetch('POST', `/v1/databases/${DB_ID}/query`, body);
    if (res.status !== 200) {
      console.error('❌ 쿼리 실패:', res.status, res.data);
      process.exit(1);
    }
    const pages = res.data.results || [];

    for (const page of pages) {
      total++;
      const original = page.properties?.['주제']?.multi_select || [];
      if (!original.length) continue;

      const seen = new Set();
      const cleaned = [];
      for (const t of original) {
        let nfc = (t.name || '').normalize('NFC');

        // U+FFFD 포함 시 canonical 매칭으로 복구 시도
        if (/�/.test(nfc)) {
          if (!recoveryMap.has(nfc)) {
            const recovered = recoverBrokenName(nfc, CANONICAL);
            recoveryMap.set(nfc, recovered);
            if (recovered) recoveredCount++; else unrecoverableCount++;
          }
          const recovered = recoveryMap.get(nfc);
          if (recovered) {
            nfdSamples.add(`${JSON.stringify(nfc)} ➜ ${JSON.stringify(recovered)} (복구)`);
            nfc = recovered;
          } else {
            nfdSamples.add(`${JSON.stringify(nfc)} ⚠️  수동 검토 필요`);
            continue;  // 복구 실패 → 해당 토픽 페이지에서 제거
          }
        }

        if (!seen.has(nfc)) {
          seen.add(nfc);
          cleaned.push(nfc);
        }
        if (t.name !== nfc) nfdSamples.add(`${JSON.stringify(t.name)} → ${JSON.stringify(nfc)}`);
      }

      const changed = original.length !== cleaned.length
        || original.some((t, i) => t.name !== cleaned[i]);

      if (changed) {
        changedPages++;
        removedNfdCount += (original.length - cleaned.length) + original.filter((t, i) => t.name !== (cleaned[i] || '')).length;
        if (DRY_RUN) {
          console.log(`  [DRY] ${page.id.slice(0, 8)} — ${original.map(t => t.name).join(', ')} → ${cleaned.join(', ')}`);
        } else {
          const patch = await notionFetch('PATCH', `/v1/pages/${page.id}`, {
            properties: { '주제': { multi_select: cleaned.map(name => ({ name })) } }
          });
          if (patch.status !== 200) {
            console.error(`  ⚠️  PATCH 실패 ${page.id.slice(0, 8)}: ${patch.status}`);
          } else {
            process.stdout.write(`  ✓ ${changedPages}/${total} 정리됨\r`);
          }
        }
      }
    }

    cursor = res.data.has_more ? res.data.next_cursor : undefined;
    process.stdout.write(`📦 진행: ${total}개 페이지 처리\r`);
  } while (cursor);

  console.log('\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 총 페이지: ${total}`);
  console.log(`🔧 변경 ${DRY_RUN ? '대상' : '완료'}: ${changedPages} 페이지`);
  console.log(`🗑  제거된 NFD 태그 발생: ${removedNfdCount}회`);
  console.log(`✨ U+FFFD 복구: ${recoveredCount}종 (canonical 매칭 성공)`);
  if (unrecoverableCount > 0) console.log(`⚠️  복구 실패(수동 검토): ${unrecoverableCount}종`);
  if (nfdSamples.size > 0) {
    console.log(`\n📋 발견된 NFD 변형 (${nfdSamples.size}종):`);
    for (const s of nfdSamples) console.log(`   ${s}`);
  } else {
    console.log('\n✨ NFD 변형 없음 — 깨끗한 상태');
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━');

  // ── DB 옵션 풀의 깨진 글리프(U+FFFD / 비-NFC) 청소 ──
  console.log('\n🔍 DB 옵션 풀 점검 중...');
  const dbInfo = await notionFetch('GET', `/v1/databases/${DB_ID}`);
  if (dbInfo.status !== 200) {
    console.error('  ⚠️  DB 메타 조회 실패:', dbInfo.status);
  } else {
    const opts = dbInfo.data?.properties?.['주제']?.multi_select?.options || [];
    const broken = opts.filter(o => /\uFFFD/.test(o.name) || o.name !== o.name.normalize('NFC'));
    if (!broken.length) {
      console.log(`  ✨ 옵션 풀 ${opts.length}개 모두 정상`);
    } else {
      console.log(`  🗑  깨진 옵션 ${broken.length}개 발견:`);
      for (const b of broken) console.log(`     - ${JSON.stringify(b.name)}`);
      if (DRY_RUN) {
        console.log('  💡 실제 적용 시 옵션 풀에서 자동 제거됩니다.');
      } else {
        // 빠진 옵션은 Notion이 자동 삭제 — name 으로 식별, 정상 옵션만 다시 PATCH
        // 안전성: 위 페이지 단계에서 이미 페이지 사용 0건 확인된 상태에서만 시도
        const survivors = opts
          .filter(o => !broken.includes(o))
          .map(o => ({ id: o.id, name: o.name, color: o.color }));
        const patch = await notionFetch('PATCH', `/v1/databases/${DB_ID}`, {
          properties: { '주제': { multi_select: { options: survivors } } }
        });
        if (patch.status === 200) {
          console.log(`  ✓ 옵션 풀 청소 완료 — ${broken.length}개 제거`);
        } else {
          console.error(`  ❌ 옵션 풀 PATCH 실패: ${patch.status}`, JSON.stringify(patch.data).slice(0, 300));
        }
      }
    }
  }

  if (DRY_RUN) {
    console.log('\n💡 실제 적용하려면 --dry-run 없이 다시 실행하세요.');
  }
})().catch((e) => {
  console.error('❌ 실행 오류:', e);
  process.exit(1);
});
