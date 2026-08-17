#!/usr/bin/env node
// ===== LLM Wiki MCP 서버 (stdio) =====
// Claude Code/Desktop에서 Obsidian LLM Wiki를 검색하는 도구 제공.
// 등록: claude mcp add wiki-search -- node /Users/tycoonan/Documents/Claude/Youtube_Notion_Grap/wiki_mcp.js
// 주의: stdout은 프로토콜 전용 — 모든 로그는 stderr로.

const wiki = require('./lib/wiki_search');

const TOOLS = [
  {
    name: 'search_wiki',
    description: 'Obsidian AI LLM Wiki(유튜브 AI 영상 요약 2,800여 건)를 의미 기반으로 검색합니다. ' +
      '한국어 자연어 질문을 그대로 넣으세요. 결과의 path로 read_note를 호출하면 전체 요약을 읽을 수 있습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '검색 질문 (한국어 자연어)' },
        topic: { type: 'string', description: '토픽 폴더로 필터 (예: "AI Claude", "AI 에이전트", "AI 수익화")' },
        limit: { type: 'number', description: '결과 수 (기본 10, 최대 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_note',
    description: '검색 결과의 path로 영상 요약 노트 전문(마크다운)을 읽습니다.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'search_wiki 결과의 path (Vault 상대 경로)' },
      },
      required: ['path'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'search_wiki') {
    const limit = Math.min(args.limit || 10, 30);
    const { results, mode } = await wiki.search(args.query, { topic: args.topic || '', limit });
    return JSON.stringify({ mode, results }, null, 1);
  }
  if (name === 'read_note') {
    return wiki.readNote(args.path);
  }
  throw new Error(`알 수 없는 도구: ${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'wiki-search', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return; // 알림 — 응답 없음
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    try {
      const text = await callTool(params.name, params.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

let buffer = '';
let pending = 0;
let stdinEnded = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      pending++;
      handle(JSON.parse(line))
        .catch(e => console.error('[wiki_mcp] 처리 오류:', e.message))
        .finally(() => {
          pending--;
          if (stdinEnded && pending === 0) process.exit(0);
        });
    } catch (e) {
      console.error('[wiki_mcp] JSON 파싱 오류:', e.message);
    }
  }
});
// stdin 종료 시 진행 중인 비동기 요청(임베딩 등)이 끝난 뒤 종료
process.stdin.on('end', () => {
  stdinEnded = true;
  if (pending === 0) process.exit(0);
});
console.error('[wiki_mcp] LLM Wiki MCP 서버 시작 (stdio)');
