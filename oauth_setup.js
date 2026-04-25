#!/usr/bin/env node
// ===== YouTube OAuth 2.0 refresh_token 1회성 발급 스크립트 =====
// 목적:
//   Desktop App OAuth 클라이언트로 사용자 동의를 받고 refresh_token 을 발급해
//   .env 의 YOUTUBE_OAUTH_REFRESH_TOKEN= 항목에 자동 기록.
// 동작:
//   1. .env 에서 CLIENT_ID, CLIENT_SECRET 로드
//   2. 로컬 루프백 서버(http://127.0.0.1:53682) 띄움
//   3. Google OAuth 동의 URL 출력 → 사용자가 브라우저에서 승인
//   4. 리다이렉트로 받은 code 를 token endpoint 에 교환 → refresh_token 획득
//   5. .env 파일에 자동 반영, 서버 종료
// 사용:
//   node oauth_setup.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { exec } = require('child_process');

const ENV_PATH = path.join(__dirname, '.env');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/youtube';

// ── .env 로드 ──
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error('❌ .env 파일을 찾을 수 없음:', ENV_PATH);
    process.exit(1);
  }
  const text = fs.readFileSync(ENV_PATH, 'utf-8');
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}

const env = loadEnv();
const CLIENT_ID = env.YOUTUBE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = env.YOUTUBE_OAUTH_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ .env 에 YOUTUBE_OAUTH_CLIENT_ID 또는 YOUTUBE_OAUTH_CLIENT_SECRET 누락');
  process.exit(1);
}

// ── PKCE 챌린지(보안 강화) ──
const codeVerifier = crypto.randomBytes(32).toString('base64url');
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');

// ── 동의 URL 구성 ──
const authParams = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',          // refresh_token 발급 필수
  prompt: 'consent',               // 매번 동의 화면 → refresh_token 보장
  state,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
});
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams}`;

// ── 토큰 교환 ──
function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }).toString();

    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(chunks);
          if (res.statusCode !== 200) reject(new Error(`Token exchange failed: ${res.statusCode} ${chunks}`));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── .env 갱신 ──
function updateEnvFile(refreshToken) {
  const text = fs.readFileSync(ENV_PATH, 'utf-8');
  let updated;
  if (/^YOUTUBE_OAUTH_REFRESH_TOKEN=.*$/m.test(text)) {
    updated = text.replace(/^YOUTUBE_OAUTH_REFRESH_TOKEN=.*$/m, `YOUTUBE_OAUTH_REFRESH_TOKEN=${refreshToken}`);
  } else {
    updated = text.trimEnd() + `\nYOUTUBE_OAUTH_REFRESH_TOKEN=${refreshToken}\n`;
  }
  fs.writeFileSync(ENV_PATH, updated, 'utf-8');
}

// ── 로컬 콜백 서버 ──
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT_URI);
  if (u.pathname !== '/callback') {
    res.writeHead(404).end('Not Found');
    return;
  }
  const code = u.searchParams.get('code');
  const returnedState = u.searchParams.get('state');
  const error = u.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ OAuth 오류: ${error}</h2><p>이 창을 닫고 콘솔을 확인하세요.</p>`);
    console.error(`\n❌ OAuth 오류: ${error}`);
    server.close();
    process.exit(1);
  }

  if (returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>❌ state 불일치 — CSRF 의심</h2>');
    console.error('\n❌ state 불일치');
    server.close();
    process.exit(1);
  }

  try {
    console.log('\n🔄 토큰 교환 중...');
    const tokenResp = await exchangeCode(code);
    if (!tokenResp.refresh_token) {
      throw new Error(`refresh_token 누락 — 응답: ${JSON.stringify(tokenResp)}`);
    }
    updateEnvFile(tokenResp.refresh_token);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h1 style="color:#0a7;">✅ OAuth 인증 완료</h1>
        <p>refresh_token이 .env 파일에 저장되었습니다.</p>
        <p>이 창을 닫으셔도 됩니다.</p>
      </body></html>
    `);
    console.log('\n✅ refresh_token 발급 및 .env 저장 완료');
    console.log(`   토큰 미리보기: ${tokenResp.refresh_token.slice(0, 16)}...`);
    console.log(`   access_token TTL: ${tokenResp.expires_in}s`);
    console.log(`   scope: ${tokenResp.scope}`);
    setTimeout(() => { server.close(); process.exit(0); }, 500);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h2>❌ 토큰 교환 실패</h2><pre>${e.message}</pre>`);
    console.error('\n❌', e.message);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, '127.0.0.1', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔐 YouTube OAuth 2.0 동의 플로우');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📍 로컬 콜백 서버: ${REDIRECT_URI}`);
  console.log('\n🌐 아래 URL을 브라우저에서 열고 동의하세요:\n');
  console.log(authUrl);
  console.log('\n💡 macOS 라면 자동으로 기본 브라우저가 열립니다...');
  exec(`open "${authUrl}"`, () => {});
  console.log('\n⏳ 브라우저 동의 대기 중... (Ctrl+C 로 중단)');
});

// 안전장치: 5분 후 자동 종료
setTimeout(() => {
  console.error('\n⏱  5분 타임아웃 — 동의가 완료되지 않았습니다.');
  server.close();
  process.exit(1);
}, 5 * 60 * 1000);
