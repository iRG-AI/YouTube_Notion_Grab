#!/usr/bin/env python3
# ===== LLM Wiki 검색 인덱스 빌더 =====
# Obsidian 영상 노트 → gemini-embedding-001 임베딩 → wiki_index.json + wiki_index.vec
# 증분 빌드: notion_id + 본문 해시 비교, 변경분만 재임베딩
# 실행: python3 build_search_index.py [--verify]

import os, re, json, ssl, sys, time, math, hashlib, struct, urllib.error
from urllib.request import urlopen, Request
from wiki_config import VAULT, nfc, load_env

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
INDEX_JSON = os.path.join(SCRIPT_DIR, 'wiki_index.json')
INDEX_VEC  = os.path.join(SCRIPT_DIR, 'wiki_index.vec')

DIM = 768
BATCH_SIZE = 15        # TPM 30k 대응 (배치당 ~25k 토큰 이하)
CALL_INTERVAL = 6.0    # 100 RPM 여유 준수
EMBED_MODEL = 'gemini-embedding-001'

ENV = load_env()
_keys_str = ENV.get('GEMINI_API_KEYS', '')
KEYS = [k.strip() for k in _keys_str.split(',') if k.strip()] or [ENV.get('GEMINI_API_KEY', '')]
_key_idx = 0

def log(msg): print(msg, flush=True)

def rotate_key():
    global _key_idx
    if len(KEYS) <= 1: return False
    _key_idx = (_key_idx + 1) % len(KEYS)
    log(f'  🔄 API Key 교체 ➔ Key #{_key_idx + 1}')
    return True

_last_call = 0.0

def batch_embed(texts):
    """텍스트 리스트 → 정규화된 벡터 리스트. 429 키 로테이션 + 지수 백오프 + 킬스위치."""
    global _last_call
    ctx = ssl.create_default_context()
    body = json.dumps({'requests': [{
        'model': f'models/{EMBED_MODEL}',
        'content': {'parts': [{'text': t}]},
        'taskType': 'RETRIEVAL_DOCUMENT',
        'outputDimensionality': DIM,
    } for t in texts]}).encode('utf-8')

    max_attempts = len(KEYS) + 3
    for attempt in range(max_attempts):
        elapsed = time.time() - _last_call
        if elapsed < CALL_INTERVAL:
            time.sleep(CALL_INTERVAL - elapsed)
        req = Request(
            f'https://generativelanguage.googleapis.com/v1beta/models/{EMBED_MODEL}:batchEmbedContents?key={KEYS[_key_idx]}',
            data=body, method='POST', headers={'Content-Type': 'application/json'})
        _last_call = time.time()
        try:
            with urlopen(req, context=ctx, timeout=60) as res:
                result = json.loads(res.read())
            vecs = []
            for e in result['embeddings']:
                v = e['values']
                norm = math.sqrt(sum(x * x for x in v)) or 1.0
                vecs.append([x / norm for x in v])
            return vecs
        except urllib.error.HTTPError as e:
            try: err_body = e.read().decode('utf-8')
            except Exception: err_body = str(e)
            if e.code == 403:
                log(f'🚨 HTTP 403: {err_body[:300]}')
                log('⚠️  API Key/프로젝트 정지 또는 권한 오류 — 계정 보호를 위해 즉시 종료합니다.')
                sys.exit(1)
            if e.code in (400, 401):
                log(f'🚨 HTTP {e.code}: {err_body[:300]}')
                log('잘못된 요청/API 키 — 프로세스를 종료합니다.')
                sys.exit(1)
            if e.code == 429:
                log(f'  ⏳ 429 한도 초과 (Key #{_key_idx + 1})')
                if not rotate_key():
                    wait = min(60 * (2 ** attempt), 300)
                    log(f'  단일 키 — {wait}초 백오프')
                    time.sleep(wait)
                continue
            # 5xx: 지수 백오프
            wait = min(5 * (2 ** attempt), 120)
            log(f'  ⏳ HTTP {e.code} — {wait}초 백오프 후 재시도')
            time.sleep(wait)
    log('🚨 최대 재시도 초과 — 안전하게 중단합니다.')
    sys.exit(1)

SKIP_FILES = {'log.md', 'schema.md', '캔버스.md'}

def collect_notes():
    """Vault 순회 → 노트 메타 + 임베딩 텍스트 목록"""
    notes = []
    for root, dirs, files in os.walk(VAULT):
        dirs[:] = [d for d in dirs if not d.startswith('.') and not d.startswith('_')]
        for f in sorted(files):
            if not f.endswith('.md') or f in SKIP_FILES or f.endswith(' MOC.md'):
                continue
            fpath = os.path.join(root, f)
            try:
                content = nfc(open(fpath, encoding='utf-8', errors='ignore').read())
            except Exception:
                continue
            m = re.search(r'^notion_id:\s*(.+)$', content, re.MULTILINE)
            if not m: continue
            nid = m.group(1).strip()

            def fm(key, default=''):
                mm = re.search(rf'^{key}:\s*(.*)$', content, re.MULTILINE)
                return mm.group(1).strip().strip('"') if mm else default

            tags_m = re.search(r'^tags:\s*\[(.*)\]$', content, re.MULTILINE)
            tags = [t.strip().strip('"') for t in tags_m.group(1).split(',')] if tags_m and tags_m.group(1).strip() else []

            def section(name):
                sm = re.search(rf'^## {name}\s*\n(.*?)(?=^## |\Z)', content, re.MULTILINE | re.DOTALL)
                return sm.group(1).strip() if sm else ''

            overview = section('영상 개요')
            embed_text = '\n'.join(filter(None, [
                fm('title'), fm('channel'), ' '.join(tags),
                overview, section('핵심 내용'), section('주요 인사이트'),
            ]))[:2000]

            notes.append({
                'id': nid,
                'path': nfc(os.path.relpath(fpath, VAULT)),
                'title': fm('title'),
                'channel': fm('channel'),
                'topic': nfc(os.path.relpath(root, VAULT).split(os.sep)[0]) if root != VAULT else '기타',
                'tags': tags,
                'upload_date': fm('upload_date'),
                'view_count': int(fm('view_count', '0') or 0),
                'video_url': fm('video_url'),
                'hash': hashlib.sha1(embed_text.encode('utf-8')).hexdigest(),
                'snippet': re.sub(r'\s+', ' ', overview)[:200],
                '_embed_text': embed_text,
            })
    return notes

def load_old_index():
    """기존 인덱스 → id: (hash, vector_bytes)"""
    if not (os.path.exists(INDEX_JSON) and os.path.exists(INDEX_VEC)):
        return {}
    try:
        meta = json.loads(open(INDEX_JSON, encoding='utf-8').read())
        vec = open(INDEX_VEC, 'rb').read()
        row = DIM * 4
        if len(vec) != len(meta['notes']) * row: return {}
        return {n['id']: (n['hash'], vec[i * row:(i + 1) * row]) for i, n in enumerate(meta['notes'])}
    except Exception:
        return {}

def verify():
    meta = json.loads(open(INDEX_JSON, encoding='utf-8').read())
    vec_size = os.path.getsize(INDEX_VEC)
    n = len(meta['notes'])
    assert vec_size == n * DIM * 4, f'크기 불일치: {vec_size} != {n} × {DIM} × 4'
    ids = [x['id'] for x in meta['notes']]
    assert len(ids) == len(set(ids)), 'notion_id 중복 발견'
    log(f'✅ verify 통과 — {n}건, vec {vec_size / 1024 / 1024:.1f}MB, dim {meta["dim"]}')

if __name__ == '__main__':
    if '--verify' in sys.argv:
        verify(); sys.exit(0)

    log('🔍 LLM Wiki 검색 인덱스 빌드 시작')
    notes = collect_notes()
    log(f'  노트 수집: {len(notes)}건')

    # 중복 notion_id 제거 (뒤에 온 파일 우선 — 최신 동기화본)
    dedup = {}
    for n in notes: dedup[n['id']] = n
    notes = list(dedup.values())

    old = load_old_index()
    to_embed = [n for n in notes if n['id'] not in old or old[n['id']][0] != n['hash']]
    reused = len(notes) - len(to_embed)
    log(f'  재사용: {reused}건 / 신규 임베딩: {len(to_embed)}건 (배치 {BATCH_SIZE}개, ~{len(to_embed) // BATCH_SIZE * 6}초 예상)')

    new_vecs = {}  # id → vector_bytes
    for i in range(0, len(to_embed), BATCH_SIZE):
        batch = to_embed[i:i + BATCH_SIZE]
        vecs = batch_embed([n['_embed_text'] for n in batch])
        for n, v in zip(batch, vecs):
            new_vecs[n['id']] = struct.pack(f'<{DIM}f', *v)
        log(f'  [{min(i + BATCH_SIZE, len(to_embed))}/{len(to_embed)}] 임베딩 완료')

    # 조립 및 원자적 쓰기
    vec_parts = []
    for n in notes:
        vec_parts.append(new_vecs.get(n['id']) or old[n['id']][1])
        del n['_embed_text']

    meta = {
        'version': 1, 'model': EMBED_MODEL, 'dim': DIM,
        'built': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'notes': notes,
    }
    for target, data, mode in ((INDEX_JSON, json.dumps(meta, ensure_ascii=False), 'w'),
                               (INDEX_VEC, b''.join(vec_parts), 'wb')):
        tmp = target + '.tmp'
        with open(tmp, mode, **({'encoding': 'utf-8'} if mode == 'w' else {})) as fh:
            fh.write(data)
        os.replace(tmp, target)

    log(f'✅ 인덱스 저장 완료 — {len(notes)}건 → wiki_index.json / wiki_index.vec')
    verify()
