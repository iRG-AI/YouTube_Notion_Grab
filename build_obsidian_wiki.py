#!/usr/bin/env python3
# ===== Obsidian LLM Wiki 구조 빌더 =====
# 1단계: MOC(Map of Contents) 파일 생성 - 재생목록별, 채널별
# 2단계: 각 .md 파일에 키워드 링크 자동 삽입
# 실행: python3 build_obsidian_wiki.py

import os, re
from collections import defaultdict

VAULT = '/Users/tycoonan/Documents/Obsidian/AI LLM Wiki/AI LLM Wiki'
MOC_DIR = os.path.join(VAULT, '_MOC')

# ── 사전 정의 키워드 목록 (AI 도구/기술명) ──
KEYWORDS = [
    # AI 모델/서비스
    'Claude', 'Gemini', 'GPT', 'ChatGPT', 'Grok', 'Perplexity',
    'NotebookLM', 'Notebook LM', 'Gemma',
    # 개발 도구
    'Claude Code', 'Antigravity', 'AntiGravity', 'Lovable', 'Replit',
    'Cursor', 'OpenClaw', 'Cowork', 'n8n', 'Make', 'Zapier',
    'Vite', 'React', 'MCP', 'API',
    # AI 기술
    'RAG', 'LLM', 'Agent', '에이전트', '바이브코딩', 'Vibe Coding',
    'Prompt', '프롬프트', 'Fine-tuning',
    # 플랫폼/서비스
    'Google AI Studio', 'Opal', '오팔', 'Genspark', '젠스파크',
    'Obsidian', '옵시디언', 'Notion', '노션',
    'YouTube', 'Gamma', '감마', 'Canva', '캔버스',
    # 이미지/영상
    'Seedance', 'Kling', 'Nano Banana', '나노바나나', 'Sora',
    # 기타 기술
    'MCP', 'A2A', 'RAG', 'Vector', 'Embedding',
]

# 키워드 → Obsidian 링크 형식 매핑 (표시명이 다른 경우)
KEYWORD_ALIAS = {
    'Notebook LM': 'NotebookLM',
    'AntiGravity': 'Antigravity',
    'Vibe Coding': '바이브코딩',
}

def parse_frontmatter(content):
    """YAML frontmatter 파싱"""
    m = re.match(r'^---\n(.*?)\n---\n', content, re.DOTALL)
    if not m:
        return {}, content
    fm = {}
    for line in m.group(1).split('\n'):
        if ':' in line:
            k, _, v = line.partition(':')
            v = v.strip().strip('"')
            if v.startswith('[') and v.endswith(']'):
                v = [x.strip().strip('"') for x in v[1:-1].split(',') if x.strip()]
            fm[k.strip()] = v
    body = content[m.end():]
    return fm, body

def get_all_files():
    """모든 .md 파일과 메타데이터 수집"""
    files = []
    for folder in os.listdir(VAULT):
        folder_path = os.path.join(VAULT, folder)
        if not os.path.isdir(folder_path) or folder.startswith('.') or folder.startswith('_'):
            continue
        for fname in os.listdir(folder_path):
            if not fname.endswith('.md'):
                continue
            fpath = os.path.join(folder_path, fname)
            content = open(fpath, encoding='utf-8').read()
            fm, body = parse_frontmatter(content)
            files.append({
                'path': fpath,
                'folder': folder,
                'filename': fname[:-3],  # .md 제거
                'title': fm.get('title', fname[:-3]),
                'channel': fm.get('channel', ''),
                'tags': fm.get('tags', []) if isinstance(fm.get('tags', []), list) else [fm.get('tags', '')],
                'upload_date': fm.get('upload_date', ''),
                'view_count': fm.get('view_count', 0),
                'video_url': fm.get('video_url', ''),
                'fm': fm,
                'body': body,
                'content': content,
            })
    return files

# ══════════════════════════════════════════════
# 1단계: MOC 파일 생성
# ══════════════════════════════════════════════
def build_moc_files(files):
    os.makedirs(MOC_DIR, exist_ok=True)

    # ── 재생목록별 MOC ──
    playlist_map = defaultdict(list)
    for f in files:
        playlist_map[f['folder']].append(f)

    for playlist, pfiles in sorted(playlist_map.items()):
        # 채널별로 그룹화
        channel_map = defaultdict(list)
        for f in pfiles:
            channel_map[f['channel']].append(f)

        lines = [f'# {playlist} MOC\n']
        lines.append(f'> 총 {len(pfiles)}개 영상\n')

        for channel in sorted(channel_map.keys()):
            cfiles = sorted(channel_map[channel], key=lambda x: x['upload_date'], reverse=True)
            lines.append(f'\n## {channel}\n')
            for f in cfiles:
                date = str(f['upload_date'])[:10] if f['upload_date'] else ''
                lines.append(f"- [[{f['filename']}|{f['title']}]] {date}\n")

        moc_path = os.path.join(MOC_DIR, f"{playlist} MOC.md")
        open(moc_path, 'w', encoding='utf-8').write(''.join(lines))
        print(f"  ✅ {playlist} MOC.md ({len(pfiles)}개)")

    # ── 채널별 MOC ──
    channel_map = defaultdict(list)
    for f in files:
        channel_map[f['channel']].append(f)

    channel_lines = ['# 채널별 목차\n\n']
    for channel in sorted(channel_map.keys()):
        cfiles = sorted(channel_map[channel], key=lambda x: x['upload_date'], reverse=True)
        subs = cfiles[0].get('view_count', '') if cfiles else ''
        channel_lines.append(f"## {channel}\n")
        channel_lines.append(f"> 영상 {len(cfiles)}개\n\n")
        for f in cfiles[:5]:  # 채널당 최근 5개만
            channel_lines.append(f"- [[{f['filename']}|{f['title']}]]\n")
        if len(cfiles) > 5:
            channel_lines.append(f"- ... 외 {len(cfiles)-5}개\n")
        channel_lines.append('\n')

    open(os.path.join(MOC_DIR, '채널별 목차.md'), 'w', encoding='utf-8').write(''.join(channel_lines))
    print(f"  ✅ 채널별 목차.md ({len(channel_map)}개 채널)")

    # ── 전체 인덱스 (카탈로그) ──
    total_views = sum(int(f.get('view_count', 0) or 0) for f in files)
    index_lines = ['# 🗂 AI LLM Wiki 전체 인덱스\n\n']
    index_lines.append(f'> 총 **{len(files)}개** 영상 요약 | 누적 조회수 **{total_views:,}회** | 재생목록 **{len(playlist_map)}개**\n\n')
    index_lines.append('---\n\n')

    # 탐색 허브
    index_lines.append('## 🧭 탐색 허브\n\n')
    index_lines.append('| 분류 | 링크 | 설명 |\n')
    index_lines.append('|------|------|------|\n')
    for playlist in sorted(playlist_map.keys()):
        cnt = len(playlist_map[playlist])
        top_ch = max(defaultdict(int, {f['channel']: 1 for f in playlist_map[playlist]}).items(), key=lambda x: x[1])[0] if playlist_map[playlist] else ''
        index_lines.append(f"| {playlist} | [[{playlist} MOC]] | 영상 {cnt}개 |\n")
    index_lines.append(f"| 채널별 목차 | [[채널별 목차]] | {len(channel_map)}개 채널 |\n")
    index_lines.append(f"| 키워드 인덱스 | [[키워드 인덱스]] | 주요 AI 도구/기술 |\n")
    index_lines.append(f"| 변경 이력 | [[log]] | Wiki 업데이트 기록 |\n")
    index_lines.append('\n---\n\n')

    # 재생목록별 최신 영상 카탈로그
    index_lines.append('## 📋 재생목록별 최신 영상\n\n')
    for playlist in sorted(playlist_map.keys()):
        pfiles = sorted(playlist_map[playlist], key=lambda x: x['upload_date'], reverse=True)
        index_lines.append(f'### {playlist} ({len(pfiles)}개)\n\n')
        for f in pfiles[:3]:  # 최신 3개만
            date = str(f['upload_date'])[:10] if f['upload_date'] else ''
            ch = f['channel']
            # 본문에서 첫 문장 추출 (한 줄 요약)
            summary = ''
            for line in f['body'].split('\n'):
                line = line.strip().lstrip('#- *>').strip()
                if len(line) > 20:
                    summary = line[:60] + ('...' if len(line) > 60 else '')
                    break
            index_lines.append(f"- [[{f['filename']}|{f['title']}]] `{ch}` {date}\n")
            if summary:
                index_lines.append(f"  > {summary}\n")
        if len(pfiles) > 3:
            index_lines.append(f"- *... 외 {len(pfiles)-3}개 → [[{playlist} MOC]]*\n")
        index_lines.append('\n')

    open(os.path.join(VAULT, '🗂 전체 인덱스.md'), 'w', encoding='utf-8').write(''.join(index_lines))
    print(f"  ✅ 🗂 전체 인덱스.md (카탈로그 + 한 줄 요약)")

# ══════════════════════════════════════════════
# 2단계: 각 .md 파일에 키워드 링크 삽입
# ══════════════════════════════════════════════
def add_keyword_links(files):
    """각 파일 본문에서 키워드를 찾아 [[키워드]] 링크로 변환"""
    updated = 0
    # 길이 긴 키워드 먼저 처리 (중복 치환 방지)
    sorted_kw = sorted(KEYWORDS, key=len, reverse=True)

    for f in files:
        content = f['content']
        fm_end = content.find('\n---\n', 4) + 5  # frontmatter 끝 위치
        frontmatter = content[:fm_end]
        body = content[fm_end:]

        new_body = body
        for kw in sorted_kw:
            alias = KEYWORD_ALIAS.get(kw, kw)
            link = f'[[{alias}]]' if alias == kw else f'[[{alias}|{kw}]]'
            # 이미 링크된 것, 코드블록 내부, frontmatter 제외
            # 단어 경계로 매칭 (앞뒤가 이미 [[]] 아닌 경우만)
            pattern = r'(?<!\[\[)(?<!\|)' + re.escape(kw) + r'(?!\]\])(?!\|)'
            new_body = re.sub(pattern, link, new_body, count=1)  # 파일당 1회만

        # 관련 키워드 수집
        found_kws = []
        for kw in sorted_kw:
            alias = KEYWORD_ALIAS.get(kw, kw)
            if f'[[{alias}]]' in new_body or f'[[{alias}|' in new_body:
                found_kws.append(alias)

        # 기존 관련 항목 섹션 제거 (재생성)
        new_body = re.sub(r'\n\n---\n## 🔗 관련 항목\n[\s\S]*$', '', new_body)

        # 파일 하단에 관련 링크 섹션 추가 (키워드 유무 관계없이 항상 MOC 링크 포함)
        related = f'\n\n---\n## 🔗 관련 항목\n'
        if found_kws:
            related += ' '.join([f'[[{k}]]' for k in found_kws[:10]]) + '\n'
        related += f'\n**재생목록**: [[{f["folder"]} MOC]]\n'

        open(f['path'], 'w', encoding='utf-8').write(frontmatter + new_body + related)
        updated += 1

    print(f"  ✅ {updated}개 파일 키워드 링크 삽입 완료")

# ══════════════════════════════════════════════
# 3단계: 키워드 인덱스 파일 생성
# ══════════════════════════════════════════════
def build_keyword_index(files):
    kw_map = defaultdict(list)
    sorted_kw = sorted(KEYWORDS, key=len, reverse=True)

    for f in files:
        content = open(f['path'], encoding='utf-8').read()
        fm_end = content.find('\n---\n', 4) + 5
        body = content[fm_end:]
        for kw in sorted_kw:
            alias = KEYWORD_ALIAS.get(kw, kw)
            if f'[[{alias}]]' in body or f'[[{alias}|' in body:
                kw_map[alias].append(f)

    lines = ['# 🔑 키워드 인덱스\n\n']
    for kw in sorted(kw_map.keys()):
        kfiles = kw_map[kw]
        lines.append(f'## {kw}\n')
        lines.append(f'> {len(kfiles)}개 영상에서 언급됨\n\n')
        for f in sorted(kfiles, key=lambda x: x['upload_date'], reverse=True)[:10]:
            lines.append(f"- [[{f['filename']}|{f['title']}]]\n")
        lines.append('\n')

    open(os.path.join(MOC_DIR, '키워드 인덱스.md'), 'w', encoding='utf-8').write(''.join(lines))
    print(f"  ✅ 키워드 인덱스.md ({len(kw_map)}개 키워드)")

# ══════════════════════════════════════════════
# 4단계: Wiki Lint (헬스체크)
# ══════════════════════════════════════════════
def lint_wiki(files):
    issues = []

    # 1. 기타 폴더 파일 (미분류)
    unclassified = [f for f in files if f['folder'] == '기타']
    if unclassified:
        issues.append(f"⚠️  미분류 파일 {len(unclassified)}개 ('기타' 폴더)")
        for f in unclassified[:5]:
            issues.append(f"   - {f['filename']}")

    # 2. MOC 링크 없는 고아 파일
    orphans = []
    for f in files:
        content = open(f['path'], encoding='utf-8', errors='ignore').read()
        has_moc = '재생목록]]' in content or 'MOC]]' in content
        if not has_moc:
            orphans.append(f)
    if orphans:
        issues.append(f"⚠️  MOC 링크 없는 파일 {len(orphans)}개")
        for f in orphans[:3]:
            issues.append(f"   - {f['folder']}/{f['filename']}")

    # 3. 요약 내용이 없거나 너무 짧은 파일
    thin = [f for f in files if len(f['body'].strip()) < 100]
    if thin:
        issues.append(f"⚠️  내용이 너무 짧은 파일 {len(thin)}개 (100자 미만)")

    # 4. 영상 URL 없는 파일
    no_url = [f for f in files if not f.get('video_url') or f['video_url'] == 'null']
    if no_url:
        issues.append(f"⚠️  영상 URL 없는 파일 {len(no_url)}개")

    # 5. 통계 요약
    total = len(files)
    with_kw = sum(1 for f in files if '🔗 관련 항목' in open(f['path'], encoding='utf-8', errors='ignore').read())
    issues.append(f"✅  총 {total}개 파일 | 키워드 링크 있음 {with_kw}개 ({with_kw*100//total}%)")

    # Lint 결과를 _MOC/lint.md에 저장
    from datetime import datetime
    now = datetime.now().strftime('%Y-%m-%d %H:%M')
    lint_lines = [f'# 🔍 Wiki Lint 결과\n\n> 마지막 실행: {now}\n\n']
    for issue in issues:
        lint_lines.append(f'{issue}\n')
    open(os.path.join(MOC_DIR, 'lint.md'), 'w', encoding='utf-8').write(''.join(lint_lines))

    # 콘솔 출력
    problem_count = sum(1 for i in issues if i.startswith('⚠️'))
    if problem_count == 0:
        print('  ✅ 이상 없음!')
    else:
        print(f'  ⚠️  {problem_count}개 항목 발견 → _MOC/lint.md 확인')
    print(f'  ✅ lint.md 저장 완료')

# ══════════════════════════════════════════════
# 5단계: schema.md 자동 재생성
# ══════════════════════════════════════════════
def build_schema(files):
    from datetime import datetime
    now = datetime.now().strftime('%Y-%m-%d %H:%M')

    # 현재 폴더/태그 목록 동적 수집
    folders = sorted(set(f['folder'] for f in files))
    all_tags = sorted(set(t for f in files for t in f['tags'] if t))
    total = len(files)
    channels = len(set(f['channel'] for f in files))
    total_views = sum(int(f.get('view_count', 0) or 0) for f in files)

    lines = [
        f'# 📐 AI LLM Wiki Schema\n\n',
        f'> 자동 생성됨: {now} | 총 {total}개 파일 | {channels}개 채널 | 누적 조회수 {total_views:,}회\n',
        f'> Wiki 구조, 규칙, 워크플로우를 정의합니다. `build_obsidian_wiki.py` 실행 시 자동으로 업데이트됩니다.\n\n---\n\n',

        '## 📁 Vault 구조\n\n```\nAI LLM Wiki/\n',
        '├── 📁 _MOC/                    # 허브 파일 모음\n',
        '│   ├── {재생목록명} MOC.md     # 재생목록별 영상 목차\n',
        '│   ├── 채널별 목차.md\n',
        '│   ├── 키워드 인덱스.md\n',
        '│   ├── lint.md                 # 헬스체크 결과\n',
        '│   └── dataview-queries.md     # Dataview 쿼리 모음\n',
    ]
    for folder in folders:
        cnt = sum(1 for f in files if f['folder'] == folder)
        lines.append(f'├── 📁 {folder}/  ({cnt}개)\n')
    lines.append('├── 🗂 전체 인덱스.md\n├── log.md\n└── schema.md  ← 이 파일\n```\n\n---\n\n')

    lines.append('## 📄 파일명 규칙\n\n```\n채널명_영상제목_날짜.md\n예) 오후다섯씨_Claude Code 완벽 가이드_20260315.md\n```\n- 특수문자 `/ \\ : * ? " < > | #` → `_` 치환, 최대 120자\n\n---\n\n')

    lines.append('## 🏷️ YAML Frontmatter 형식\n\n```yaml\n---\ntitle: "영상 제목"\nchannel: "채널명"\ntags: ["AI 바이브코딩", "AI Claude"]\nupload_date: 2026-03-15\nview_count: 42000\nsubscriber_count: 141000\nvideo_url: https://youtube.com/watch?v=xxxxx\nstatus: 완료\nnotion_id: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\n---\n```\n\n---\n\n')

    lines.append(f'## 🏷️ 주제 태그 목록 (현재 {len(all_tags)}개)\n\n')
    lines.append('| 태그 | 영상 수 |\n|------|--------|\n')
    tag_counts = defaultdict(int)
    for f in files:
        for t in f['tags']:
            tag_counts[t] += 1
    for tag in sorted(all_tags):
        lines.append(f'| {tag} | {tag_counts.get(tag, 0)}개 |\n')
    lines.append('\n---\n\n')

    lines.append('## 🔑 키워드 링크 대상\n\n')
    lines.append('`Claude` `Gemini` `GPT` `ChatGPT` `NotebookLM` `Gemma`\n')
    lines.append('`Claude Code` `Antigravity` `Lovable` `Replit` `OpenClaw` `Cowork` `n8n` `MCP` `API`\n')
    lines.append('`RAG` `LLM` `Agent` `에이전트` `바이브코딩` `Prompt` `프롬프트`\n')
    lines.append('`Google AI Studio` `Opal` `오팔` `Genspark` `젠스파크`\n')
    lines.append('`Obsidian` `옵시디언` `Notion` `노션`\n\n---\n\n')

    lines.append('## 🔄 워크플로우\n\n')
    lines.append('### 자동 파이프라인\n```\nYouTube → Gemini 요약 → Notion 저장\n→ sync_obsidian.py → .md 생성 → build_obsidian_wiki.py\n→ MOC + 키워드 링크 + lint + schema 재생성 → log.md 기록\n```\n\n')
    lines.append('### 수동 명령어\n```bash\npython3 sync_obsidian.py --rebuild   # 전체 재구성\npython3 build_obsidian_wiki.py       # MOC/링크/schema 재구성\npython3 cleanup_duplicates.py        # 중복 정리\ngrep "^## \\[" log.md | tail -10      # 최근 10개 변경 이력\n```\n\n')
    lines.append('*이 파일은 `build_obsidian_wiki.py` 실행 시 자동으로 재생성됩니다.*\n')

    open(os.path.join(VAULT, 'schema.md'), 'w', encoding='utf-8').write(''.join(lines))
    print(f'  ✅ schema.md 자동 재생성 완료 (태그 {len(all_tags)}개, 폴더 {len(folders)}개)')

# ── 메인 실행 ──
if __name__ == '__main__':
    print('📚 Obsidian LLM Wiki 빌더 시작\n')
    print('📂 파일 수집 중...')
    files = get_all_files()
    print(f'  총 {len(files)}개 파일\n')

    print('1️⃣  MOC 파일 생성 중...')
    build_moc_files(files)

    print('\n2️⃣  키워드 링크 삽입 중...')
    add_keyword_links(files)

    print('\n3️⃣  키워드 인덱스 생성 중...')
    # 변경된 파일 다시 읽기
    files = get_all_files()
    build_keyword_index(files)

    print('\n✅ 완료!')
    print(f'📁 MOC 폴더: {MOC_DIR}')

    # ── Lint 실행 ──
    print('\n🔍 Wiki Lint 실행 중...')
    lint_wiki(files)

    # ── schema.md 자동 재생성 ──
    print('\n📐 schema.md 업데이트 중...')
    build_schema(files)

    # ── log.md 기록 (직접 실행 시에만) ──
    try:
        from sync_obsidian import write_wiki_log
        write_wiki_log('rebuild', f'Wiki 수동 재구성 — {len(files)}개 파일', {
            '총 파일': f'{len(files)}개',
            'MOC': f'{len([d for d in os.listdir(MOC_DIR) if d.endswith(".md")])}개',
        })
    except Exception:
        pass
