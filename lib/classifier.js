// ===== Gemini 기반 영상 토픽 분류기 =====
// 역할:
//   영상 요약 + 메타정보를 받아 사전 정의된 토픽 목록 중 가장 적합한
//   1~3개를 추천. 신뢰도(confidence) 함께 반환.
//
// 응답 스키마: { topics: string[], confidence: number, reasoning: string }
//   - topics: availableTopics 의 부분집합 (NFC), 정확한 문자열 매칭만 허용
//   - confidence: 0.0~1.0
//   - reasoning: 짧은 설명 (디버그/감사용)
//
// 사용 예:
//   const { classifyTopics } = require('./lib/classifier');
//   const r = await classifyTopics({ summary, title, channel }, AVAILABLE_TOPICS);

const fs = require('fs');
const path = require('path');
const https = require('https');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}
const env = loadEnv();
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';

function geminiCall(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,         // 분류는 결정적이어야 함
        responseMimeType: 'application/json',
      },
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(chunks);
          if (res.statusCode !== 200) return reject(new Error(`Gemini ${res.statusCode}: ${chunks.slice(0, 300)}`));
          const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '';
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function buildPrompt({ summary, title, channel, availableTopics }) {
  const topicList = availableTopics.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `당신은 한국어 YouTube 영상 분류 전문가입니다. 아래 영상을 분석해 주어진 토픽 목록 중 **실제로 적합한 만큼만** 선정하세요.

## 입력
- 제목: ${title || '(없음)'}
- 채널: ${channel || '(없음)'}
- 요약:
${(summary || '(없음)').slice(0, 5000)}

## 토픽 목록 (정확히 이 중에서만 선택)
${topicList}

## 판단 기준 (매우 중요)
- **개수**: 0~5개. 영상의 실제 내용에 맞게 자유롭게 선택, **상한은 5개**
  - 단일 도구/주제만 다루면 **1개만** 선택
  - 여러 도구를 본격적으로 비교/통합하면 최대 5개
  - 적합한 토픽이 없으면 **빈 배열** (강제 매칭 금지)
- **제목 우선 신호**: 제목에 도구/주제명이 명시되면 해당 토픽을 반드시 포함
  - "바이브 코딩으로 미니앱 개발" → "AI 바이브코딩" ✅
  - "NotebookLM으로 슬라이드 만들기" → "AI 노트북 LM" ✅
  - 제목이 명확하면 요약 본문이 부족해도 토픽 인정
- **본질적 주제만**: 영상이 그 토픽으로 검색됐을 때 사용자가 만족할 정도여야 함
  - ✅ Claude API 사용법 영상 → "AI Claude"
  - ❌ Claude를 한두 문장 언급한 영상 → "AI Claude" 제외

### ⚠️ 추상 토픽 과추천 금지 (가장 흔한 오류)
다음 토픽은 거의 모든 AI 영상이 부수적으로 해당될 수 있어 **남발 금지**.
영상의 **핵심 주제일 때만** 추가하라:
- "AI 생산성 향상" → 영상이 명시적으로 *업무 효율화/시간 절약 방법*을 주된 가치로 다룰 때만
  - ❌ 단순히 "이걸로 빨라진다"고 언급 → 제외
  - ✅ 워크플로 자체가 주제 (예: "1시간 → 5분 단축법") → 포함
- "AI 자동화" → 영상이 *자동화 파이프라인/봇 구축*을 핵심으로 다룰 때만
  - ❌ 자동화 효과 언급만 → 제외
  - ✅ n8n/Make/Zapier/스크립트 자동화 구현 → 포함
- "AI 에이전트" → 영상이 *agent 아키텍처/MCP/A2A/MAS* 등을 주제로 다룰 때만
  - ❌ "에이전트처럼 동작한다" 비유적 표현 → 제외
  - ✅ Sub-agent 구축, 에이전트 프레임워크 설명 → 포함
- "AI 트렌드" → 영상이 *시장 흐름/뉴스 종합*을 주된 포맷으로 다룰 때만
  - ❌ 신기능 소개 영상 → 제외 (해당 도구 토픽으로만)
- "AI 프롬프트" → 영상이 *프롬프트 엔지니어링 자체*를 주제로 다룰 때만
  - ❌ 프롬프트 예시 한두 개 공유 → 제외

### 기타
- **부차적 언급 무시**: 도구 나열, 짧은 비교 언급, 배경 설명용 도구는 토픽 아님
- **도구 이름 정확 매칭**: "AI Claude" ≠ "AI Codex" — 유사 이름 혼동 금지
- 한국어 토픽 이름은 완성형(NFC) 그대로 사용

## 출력 (JSON only)
{
  "topics": ["토픽이름1", ...],
  "confidence": 0.85,
  "reasoning": "한 문장 근거 — 왜 이 개수만큼 선택했는지 설명"
}

## confidence (선택된 모든 토픽이 실제로 영상의 본질적 주제일 확률)
- 0.9+: 모든 추천 토픽이 명백히 본질적 주제
- 0.7~0.9: 추천이 대체로 적합하나 일부 약한 매칭 포함
- 0.5~0.7: 약한 매칭 위주, 사람 검토 권장
- <0.5: 매칭 부적절 — 차라리 빈 배열 권장`;
}

async function classifyTopics({ summary, title, channel }, availableTopics, opts = {}) {
  const maxRetries = opts.maxRetries ?? 2;
  // availableTopics 는 NFC 정규화 강제 (v101 정책)
  const topics = availableTopics.map(t => (t || '').normalize('NFC')).filter(Boolean);
  const allowedSet = new Set(topics);

  const prompt = buildPrompt({ summary, title, channel, availableTopics: topics });

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const raw = await geminiCall(prompt);
      // responseMimeType=application/json 이라 raw 가 직접 JSON
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // 모델이 가끔 코드블럭 감싸서 반환 → 첫 { ~ 마지막 } 추출
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error(`No JSON in response: ${raw.slice(0, 200)}`);
        parsed = JSON.parse(m[0]);
      }

      // 검증 + NFC 정규화 + allowedSet 필터링 + 상한 5개 강제
      const cleanTopics = (parsed.topics || [])
        .map(t => (t || '').normalize('NFC'))
        .filter(t => allowedSet.has(t))
        .slice(0, 5);

      const confidence = typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence)) : 0;

      return {
        topics: cleanTopics,
        confidence,
        reasoning: (parsed.reasoning || '').slice(0, 300),
        droppedTopics: (parsed.topics || []).filter(t => !allowedSet.has((t || '').normalize('NFC'))),
      };
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw new Error(`classifyTopics failed after ${maxRetries + 1} attempts: ${lastErr?.message}`);
}

module.exports = { classifyTopics };
