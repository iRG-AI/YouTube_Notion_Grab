// ===== Notion → Obsidian 마이그레이션 스크립트 =====
// 노션 DB의 YouTube 요약 자료를 Obsidian .md 파일로 변환
// 실행: node notion_to_obsidian.js

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── .env 로드 ──
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const VAULT_PATH   = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki';

if (!NOTION_TOKEN || !NOTION_DB_ID) {
  console.error('❌ .env 파일에 NOTION_TOKEN, NOTION_DB_ID를 설정하세요.');
  process.exit(1);
}


// ── Notion API 호출 ──
function notionCall(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.notion.com',
      port: 443,
      path: apiPath,
      method,
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Notion 블록(본문) 가져오기 ──
async function getBlocks(pageId) {
  let blocks = [], cursor;
  do {
    const res = await notionCall('GET',
      `/v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`
    );
    blocks = blocks.concat(res.data.results || []);
    cursor = res.data.next_cursor;
  } while (cursor);
  return blocks;
}

// ── 블록 → 마크다운 변환 ──
function richTextToMd(richTexts) {
  return (richTexts || []).map(rt => {
    let text = rt.text?.content || '';
    if (rt.annotations?.bold)   text = `**${text}**`;
    if (rt.annotations?.italic) text = `*${text}*`;
    if (rt.annotations?.code)   text = `\`${text}\``;
    return text;
  }).join('');
}

function blockToMd(block) {
  const type = block.type;
  const b = block[type];
  const text = richTextToMd(b?.rich_text || []);
  switch (type) {
    case 'heading_1':    return `# ${text}`;
    case 'heading_2':    return `## ${text}`;
    case 'heading_3':    return `### ${text}`;
    case 'paragraph':    return text || '';
    case 'bulleted_list_item': return `- ${text}`;
    case 'numbered_list_item': return `1. ${text}`;
    case 'quote':        return `> ${text}`;
    case 'divider':      return '---';
    case 'image': {
      const url = b?.file?.url || b?.external?.url || '';
      return url ? `![이미지](${url})` : '';
    }
    default: return text || '';
  }
}


// ── 파일명 안전 변환 (특수문자 제거) ──
function safeFilename(str) {
  return (str || 'untitled')
    .replace(/[\/\\:*?"<>|#]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// ── 노션 DB 전체 페이지 로드 ──
async function loadAllPages() {
  const pages = [];
  let cursor;
  console.log('📦 Notion DB 로딩 중...');
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionCall('POST', `/v1/databases/${NOTION_DB_ID}/query`, body);
    pages.push(...(res.data.results || []));
    cursor = res.data.next_cursor;
    process.stdout.write(`  ${pages.length}개 로드 중...\r`);
  } while (cursor);
  console.log(`\n✅ 총 ${pages.length}개 페이지 로드 완료\n`);
  return pages;
}

// ── Notion 블록(본문) 가져오기 ──
async function getBlocks(pageId) {
  let blocks = [], cursor;
  do {
    const res = await notionCall('GET',
      `/v1/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`
    );
    blocks = blocks.concat(res.data.results || []);
    cursor = res.data.next_cursor;
  } while (cursor);
  return blocks;
}

// ── Rich Text → 마크다운 ──
function richTextToMd(richTexts) {
  return (richTexts || []).map(rt => {
    let text = rt.text?.content || '';
    if (rt.annotations?.bold)   text = `**${text}**`;
    if (rt.annotations?.italic) text = `*${text}*`;
    if (rt.annotations?.code)   text = `\`${text}\``;
    return text;
  }).join('');
}

// ── 블록 → 마크다운 ──
function blockToMd(block) {
  const type = block.type;
  const b = block[type];
  const text = richTextToMd(b?.rich_text || []);
  switch (type) {
    case 'heading_1': return `# ${text}`;
    case 'heading_2': return `## ${text}`;
    case 'heading_3': return `### ${text}`;
    case 'paragraph': return text || '';
    case 'bulleted_list_item': return `- ${text}`;
    case 'numbered_list_item': return `1. ${text}`;
    case 'quote':     return `> ${text}`;
    case 'divider':   return '---';
    default:          return text || '';
  }
}

// ── 페이지 → .md 파일 저장 ──
async function pageToMd(page, idx, total) {
  const props   = page.properties || {};
  const title   = (props['영상 제목']?.title || []).map(t => t.text?.content || '').join('') || 'untitled';
  const channel = (props['유튜브 채널']?.rich_text || []).map(t => t.text?.content || '').join('') || '알수없음';
  const topics  = (props['주제']?.multi_select || []).map(t => t.name);
  const folder  = topics.length > 0 ? topics[0] : '기타';
  const viewCount  = props['조회수']?.number ?? 0;
  const subCount   = props['구독자수']?.number ?? 0;
  const uploadDate = props['업로드 일자']?.date?.start || '';
  const videoUrl   = props['영상 URL']?.url || '';
  const thumbUrl   = props['썸네일 URL']?.url || '';
  const status     = props['처리 상태']?.select?.name || '';

  // 파일명: 채널명_영상제목_날짜.md
  const datePart = uploadDate ? uploadDate.slice(0, 10).replace(/-/g, '') : '00000000';
  const filename = safeFilename(`${channel}_${title}_${datePart}`) + '.md';

  // 폴더 생성
  const dirPath = path.join(VAULT_PATH, safeFilename(folder));
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

  // 본문 블록 가져오기
  const blocks = await getBlocks(page.id);
  const bodyMd = blocks.map(blockToMd).filter(l => l !== null).join('\n');

  // YAML frontmatter + 본문
  const md = [
    '---',
    `title: "${title.replace(/"/g, "'")}"`,
    `channel: "${channel}"`,
    `tags: [${topics.map(t => `"${t}"`).join(', ')}]`,
    `upload_date: ${uploadDate || 'null'}`,
    `view_count: ${viewCount}`,
    `subscriber_count: ${subCount}`,
    `video_url: ${videoUrl || 'null'}`,
    `thumbnail: ${thumbUrl || 'null'}`,
    `status: ${status}`,
    `notion_id: ${page.id}`,
    '---',
    '',
    bodyMd,
  ].join('\n');

  const filePath = path.join(dirPath, filename);
  fs.writeFileSync(filePath, md, 'utf8');
  process.stdout.write(`  [${idx}/${total}] ${folder}/${filename}\r`);
}

// ── 메인 실행 ──
async function main() {
  console.log('🚀 Notion → Obsidian 마이그레이션 시작');
  console.log(`📁 Vault 경로: ${VAULT_PATH}\n`);

  if (!fs.existsSync(VAULT_PATH)) {
    console.error(`❌ Vault 경로가 없습니다: ${VAULT_PATH}`);
    process.exit(1);
  }

  const pages = await loadAllPages();
  const total = pages.length;
  let done = 0, error = 0;

  for (let i = 0; i < pages.length; i++) {
    try {
      await pageToMd(pages[i], i + 1, total);
      done++;
    } catch (e) {
      error++;
      console.error(`\n  ❌ 오류 [${i+1}]: ${e.message}`);
    }
    // Notion API Rate Limit 방지 (3 req/sec)
    await new Promise(r => setTimeout(r, 350));
  }

  console.log(`\n\n✅ 완료! 저장: ${done}개 / 오류: ${error}개`);
  console.log(`📁 저장 위치: ${VAULT_PATH}`);
}

main().catch(e => {
  console.error('❌ 치명적 오류:', e.message);
  process.exit(1);
});
