#!/usr/bin/env python3
"""
Karpathy LLM Wiki Ingest Engine
- Raw Source(.md) → Gemini 분석 → 엔티티/개념 페이지 합성
- 무료 티어 (15 RPM), Rate Limit 자동 준수
- 실행: python3 wiki_ingest.py [--full] [--limit=N]
"""

import os, re, json, sys, time, unicodedata
from datetime import datetime
from collections import defaultdict
from wiki_config import (
    VAULT, WIKI_DIR, ENTITIES_DIR, CONCEPTS_DIR, SYNTHESIS_DIR,
    STATE_FILE, ENTITIES, CONCEPTS, nfc, gemini_call, load_state, save_state,
    DailyQuotaExhausted
)

def log(msg): print(msg, flush=True)

# ══════════════════════════════════════
# 1. Raw Source 수집
# ══════════════════════════════════════
def collect_sources():
    """Vault에서 모든 원본 .md 파일 수집 (토픽 폴더 내 영상 요약 파일)"""
    sources = []
    for folder_raw in os.listdir(VAULT):
        folder = nfc(folder_raw)
        folder_path = os.path.join(VAULT, folder_raw)
        if not os.path.isdir(folder_path) or folder.startswith('.') or folder.startswith('_'):
            continue
        if folder in ('기타',):
            continue
        for fname_raw in os.listdir(folder_path):
            fname = nfc(fname_raw)
            if not fname.endswith('.md'): continue
            fpath = os.path.join(folder_path, fname_raw)
            try:
                content = nfc(open(fpath, encoding='utf-8', errors='ignore').read())
            except Exception:
                continue
            # frontmatter 파싱
            m = re.match(r'^---\n(.*?)\n---\n', content, re.DOTALL)
            fm = {}
            body = content
            if m:
                for line in m.group(1).split('\n'):
                    if ':' in line:
                        k, _, v = line.partition(':')
                        fm[k.strip()] = v.strip().strip('"')
                body = content[m.end():]
            sources.append({
                'path': fpath,
                'folder': folder,
                'filename': fname,
                'title': fm.get('title', fname[:-3]),
                'channel': fm.get('channel', ''),
                'notion_id': fm.get('notion_id', ''),
                'upload_date': fm.get('upload_date', ''),
                'body': body[:3000],  # API 비용 절약
            })
    return sources

# ══════════════════════════════════════
# 2. Gemini로 엔티티/개념 추출
# ══════════════════════════════════════
EXTRACT_PROMPT = """당신은 AI 기술 Wiki 관리자입니다. 아래 YouTube 영상 요약에서 엔티티와 개념을 추출하세요.

## 영상 정보
- 제목: {title}
- 채널: {channel}
- 폴더(주제): {folder}
- 업로드일: {upload_date}

## 요약 내용
{body}

## 추출 대상 엔티티 (아래 목록 중에서만 선택)
{entity_list}

## 추출 대상 개념 (아래 목록 중에서만 선택)
{concept_list}

## 규칙
1. 영상에서 **실질적으로 다루는** 엔티티/개념만 선택 (단순 언급 제외)
2. 각 항목에 대해 이 영상에서 얻을 수 있는 **핵심 정보 1~2문장** 작성
3. 엔티티/개념 간 **관계**가 있으면 기술 (예: "Claude Code로 바이브코딩")

## 출력 (JSON)
{{
  "entities": [
    {{"name": "엔티티명", "insight": "이 영상에서의 핵심 정보", "role": "주제|도구|비교대상"}}
  ],
  "concepts": [
    {{"name": "개념명", "insight": "이 영상에서의 핵심 정보"}}
  ],
  "relations": [
    {{"from": "A", "to": "B", "type": "사용|비교|통합|대체"}}
  ]
}}"""

def extract_from_source(source):
    """하나의 소스에서 엔티티/개념 추출"""
    prompt = EXTRACT_PROMPT.format(
        title=source['title'],
        channel=source['channel'],
        folder=source['folder'],
        upload_date=source['upload_date'],
        body=source['body'],
        entity_list=', '.join(ENTITIES),
        concept_list=', '.join(CONCEPTS),
    )
    raw = gemini_call(prompt)
    empty = {'entities': [], 'concepts': [], 'relations': []}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # 코드블록 감싸기 또는 깨진 JSON 복구
        m = re.search(r'\{[\s\S]*\}', raw)
        if not m:
            return empty
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            # 마지막 쉼표 제거 등 기본 수정 시도
            cleaned = re.sub(r',\s*([}\]])', r'\1', m.group(0))
            try:
                data = json.loads(cleaned)
            except json.JSONDecodeError:
                return empty
    return data

# ══════════════════════════════════════
# 3. 엔티티/개념 페이지 생성·갱신
# ══════════════════════════════════════
def update_entity_page(name, entries):
    """엔티티 페이지 생성 또는 갱신"""
    filepath = os.path.join(ENTITIES_DIR, nfc(f'{name}.md'))
    existing_sources = set()
    existing_content = ''

    if os.path.exists(filepath):
        existing_content = open(filepath, encoding='utf-8').read()
        # 기존 소스 목록 추출
        for m in re.finditer(r'\[\[(.+?)(?:\|.+?)?\]\]', existing_content):
            existing_sources.add(m.group(1))

    # 새 엔트리만 필터링
    new_entries = [e for e in entries if e['source_filename'] not in existing_sources]
    if not new_entries and os.path.exists(filepath):
        return False  # 변경 없음

    # 모든 엔트리 (기존 + 신규)
    all_entries = entries  # 전체 재작성

    # 역할별 분류
    by_role = defaultdict(list)
    for e in all_entries:
        by_role[e.get('role', '관련')].append(e)

    lines = [
        f'---',
        f'type: entity',
        f'name: "{name}"',
        f'source_count: {len(all_entries)}',
        f'last_updated: {datetime.now().strftime("%Y-%m-%d %H:%M")}',
        f'---',
        f'',
        f'# {name}',
        f'',
        f'> 총 **{len(all_entries)}개** 영상에서 언급됨',
        f'',
    ]

    # 역할별 섹션
    role_icon = {'주제': '🎯', '도구': '🔧', '비교대상': '⚖️', '관련': '🔗'}
    for role in ['주제', '도구', '비교대상', '관련']:
        role_entries = by_role.get(role, [])
        if not role_entries: continue
        icon = role_icon.get(role, '📌')
        lines.append(f'## {icon} {role}로 다룬 영상 ({len(role_entries)}개)')
        lines.append('')
        for e in sorted(role_entries, key=lambda x: x.get('upload_date', ''), reverse=True):
            date = str(e.get('upload_date', ''))[:10]
            lines.append(f"- [[{e['source_filename']}|{e['title']}]] `{e['channel']}` {date}")
            lines.append(f"  > {e['insight']}")
        lines.append('')

    # 관계 섹션
    relations = [e.get('relations', []) for e in all_entries]
    flat_rels = [r for rels in relations for r in rels if r.get('from') == name or r.get('to') == name]
    if flat_rels:
        lines.append('## 🔗 관련 엔티티/개념')
        lines.append('')
        seen = set()
        for r in flat_rels:
            other = r['to'] if r['from'] == name else r['from']
            rel_type = r.get('type', '관련')
            key = f"{other}-{rel_type}"
            if key not in seen:
                lines.append(f"- [[{other}]] — {rel_type}")
                seen.add(key)
        lines.append('')

    open(filepath, 'w', encoding='utf-8').write(nfc('\n'.join(lines)))
    return True

def update_concept_page(name, entries):
    """개념 페이지 생성 또는 갱신"""
    filepath = os.path.join(CONCEPTS_DIR, nfc(f'{name}.md'))

    lines = [
        f'---',
        f'type: concept',
        f'name: "{name}"',
        f'source_count: {len(entries)}',
        f'last_updated: {datetime.now().strftime("%Y-%m-%d %H:%M")}',
        f'---',
        f'',
        f'# {name}',
        f'',
        f'> 총 **{len(entries)}개** 영상에서 다룸',
        f'',
        f'## 📚 관련 영상',
        f'',
    ]

    for e in sorted(entries, key=lambda x: x.get('upload_date', ''), reverse=True):
        date = str(e.get('upload_date', ''))[:10]
        lines.append(f"- [[{e['source_filename']}|{e['title']}]] `{e['channel']}` {date}")
        lines.append(f"  > {e['insight']}")

    lines.append('')
    open(filepath, 'w', encoding='utf-8').write(nfc('\n'.join(lines)))
    return True

# ══════════════════════════════════════
# 4. Wiki Index 갱신
# ══════════════════════════════════════
def build_wiki_index(entity_data, concept_data):
    """_wiki/index.md 생성"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    lines = [
        f'# 🧠 AI LLM Wiki — Knowledge Index',
        f'',
        f'> 마지막 갱신: {now}',
        f'> Karpathy LLM Wiki 패턴 기반 지식 합성 시스템',
        f'',
        f'---',
        f'',
        f'## 📦 엔티티 (AI 도구/서비스) — {len(entity_data)}개',
        f'',
        f'| 엔티티 | 소스 수 | 최근 갱신 |',
        f'|--------|---------|-----------|',
    ]
    for name in sorted(entity_data.keys()):
        entries = entity_data[name]
        latest = max((e.get('upload_date', '') for e in entries), default='')[:10]
        lines.append(f'| [[{name}]] | {len(entries)}개 | {latest} |')

    lines.extend([
        f'',
        f'## 💡 개념 (기술/방법론) — {len(concept_data)}개',
        f'',
        f'| 개념 | 소스 수 | 최근 갱신 |',
        f'|------|---------|-----------|',
    ])
    for name in sorted(concept_data.keys()):
        entries = concept_data[name]
        latest = max((e.get('upload_date', '') for e in entries), default='')[:10]
        lines.append(f'| [[{name}]] | {len(entries)}개 | {latest} |')

    lines.extend(['', f'---', f'', f'*이 파일은 `wiki_ingest.py` 실행 시 자동 갱신됩니다.*'])
    open(os.path.join(WIKI_DIR, 'index.md'), 'w', encoding='utf-8').write(nfc('\n'.join(lines)))

# ══════════════════════════════════════
# 5. Wiki Log 기록
# ══════════════════════════════════════
def write_wiki_log(event, summary, details=None):
    log_path = os.path.join(WIKI_DIR, 'log.md')
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    today = datetime.now().strftime('%Y-%m-%d')

    if not os.path.exists(log_path):
        header = '# 📋 Wiki Ingest Log\n\n> Karpathy LLM Wiki 변경 이력\n\n'
        open(log_path, 'w', encoding='utf-8').write(nfc(header))

    entry = f'## [{today}] {event} | {summary}\n> ⏰ {now}\n\n'
    if details:
        for k, v in details.items():
            entry += f'- **{k}**: {v}\n'
    entry += '\n'

    existing = open(log_path, encoding='utf-8').read()
    # 헤더 이후에 삽입
    insert_pos = existing.find('\n\n', existing.find('변경 이력'))
    if insert_pos < 0:
        insert_pos = len(existing)
    else:
        insert_pos += 2
    open(log_path, 'w', encoding='utf-8').write(nfc(existing[:insert_pos] + entry + existing[insert_pos:]))

# ══════════════════════════════════════
# 메인 실행
# ══════════════════════════════════════
def main():
    log('🧠 Karpathy LLM Wiki Ingest 시작\n')
    start = time.time()

    # 옵션 파싱
    full_mode = '--full' in sys.argv
    limit = None
    for arg in sys.argv:
        if arg.startswith('--limit='):
            limit = int(arg.split('=')[1])

    # 상태 로드
    state = load_state()
    ingested = state.get('ingested', {})

    # 소스 수집
    log('📂 Raw Source 수집 중...')
    sources = collect_sources()
    log(f'  총 {len(sources)}개 소스 파일\n')

    # 미처리 소스 필터링
    if full_mode:
        pending = sources
        log('🔄 전체 재분석 모드 (--full)\n')
    else:
        pending = [s for s in sources if s['notion_id'] not in ingested]
        log(f'✨ 신규/미처리: {len(pending)}개\n')

    if limit:
        pending = pending[:limit]
        log(f'📊 처리 제한: {limit}개\n')

    if not pending:
        log('ℹ️  처리할 소스 없음 — 종료')
        return

    # 엔티티/개념 데이터 수집
    entity_data = defaultdict(list)  # name → [entry, ...]
    concept_data = defaultdict(list)

    processed = 0
    errors = 0

    for i, source in enumerate(pending):
        try:
            log(f'  [{i+1}/{len(pending)}] {source["title"][:50]}...')
            result = extract_from_source(source)

            source_ref = {
                'source_filename': source['filename'][:-3],
                'title': source['title'],
                'channel': source['channel'],
                'upload_date': source['upload_date'],
            }

            for ent in result.get('entities', []):
                name = ent.get('name', '')
                if name not in ENTITIES: continue
                entry = {**source_ref, 'insight': ent.get('insight', ''), 'role': ent.get('role', '관련'), 'relations': result.get('relations', [])}
                entity_data[name].append(entry)

            for con in result.get('concepts', []):
                name = con.get('name', '')
                if name not in CONCEPTS: continue
                entry = {**source_ref, 'insight': con.get('insight', '')}
                concept_data[name].append(entry)

            # 상태 저장 (점진적)
            if source['notion_id']:
                ingested[source['notion_id']] = datetime.now().isoformat()

            processed += 1

            # 10개마다 중간 저장
            if processed % 10 == 0:
                state['ingested'] = ingested
                save_state(state)
                log(f'  💾 중간 저장 ({processed}개 처리)')

        except DailyQuotaExhausted as e:
            log(f'\n  ⏸  {e}')
            log(f'  💾 진행상황 저장 중... ({processed}개 처리 완료)')
            state['ingested'] = ingested
            save_state(state)
            log(f'  ℹ️  내일 다시 실행하면 자동으로 이어서 처리됩니다.')
            break
        except Exception as e:
            log(f'  ❌ 오류: {e}')
            errors += 1
            # Rate limit 오류 시 대기
            if '429' in str(e) or 'RESOURCE_EXHAUSTED' in str(e):
                log('  ⏸  Rate limit — 60초 대기...')
                time.sleep(60)

    # 페이지 생성/갱신
    log(f'\n📝 Wiki 페이지 생성 중...')

    ent_updated = 0
    for name, entries in entity_data.items():
        if update_entity_page(name, entries):
            ent_updated += 1
            log(f'  ✅ 엔티티: {name} ({len(entries)}개 소스)')

    con_updated = 0
    for name, entries in concept_data.items():
        if update_concept_page(name, entries):
            con_updated += 1
            log(f'  ✅ 개념: {name} ({len(entries)}개 소스)')

    # 인덱스 갱신
    build_wiki_index(entity_data, concept_data)
    log('  ✅ index.md 갱신')

    # 상태 저장
    state['ingested'] = ingested
    state['last_run'] = datetime.now().isoformat()
    state['entities'] = {k: len(v) for k, v in entity_data.items()}
    state['concepts'] = {k: len(v) for k, v in concept_data.items()}
    save_state(state)

    elapsed = round(time.time() - start)
    log(f'\n🎉 Wiki Ingest 완료!')
    log(f'  처리: {processed}개 | 오류: {errors}개')
    log(f'  엔티티: {ent_updated}개 | 개념: {con_updated}개')
    log(f'  소요시간: {elapsed}초')

    # 로그 기록
    write_wiki_log('ingest', f'{processed}개 소스 처리', {
        '처리': f'{processed}개',
        '오류': f'{errors}개',
        '엔티티 갱신': f'{ent_updated}개',
        '개념 갱신': f'{con_updated}개',
        '소요시간': f'{elapsed}초',
        '모드': '전체' if full_mode else '증분',
    })

    # JSON 결과 출력 (파이프라인 연동용)
    print('WIKI_RESULT:' + json.dumps({
        'processed': processed, 'errors': errors,
        'entities_updated': ent_updated, 'concepts_updated': con_updated,
        'elapsed': elapsed,
    }))

if __name__ == '__main__':
    main()
