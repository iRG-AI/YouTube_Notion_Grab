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

    # ── 전체 인덱스 MOC ──
    index_lines = ['# 🗂 AI LLM Wiki 전체 인덱스\n\n']
    index_lines.append(f'> 총 {len(files)}개 영상 요약 저장됨\n\n')
    index_lines.append('## 재생목록별 MOC\n')
    for playlist in sorted(playlist_map.keys()):
        cnt = len(playlist_map[playlist])
        index_lines.append(f"- [[{playlist} MOC]] — {cnt}개\n")
    index_lines.append('\n## 채널별 목차\n')
    index_lines.append('- [[채널별 목차]]\n')
    index_lines.append('\n## 키워드 인덱스\n')
    index_lines.append('- [[키워드 인덱스]]\n')

    open(os.path.join(VAULT, '🗂 전체 인덱스.md'), 'w', encoding='utf-8').write(''.join(index_lines))
    print(f"  ✅ 🗂 전체 인덱스.md")

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

        if new_body != body:
            # 관련 키워드 섹션 추가
            found_kws = []
            for kw in sorted_kw:
                alias = KEYWORD_ALIAS.get(kw, kw)
                if f'[[{alias}]]' in new_body or f'[[{alias}|' in new_body:
                    found_kws.append(alias)

            # 파일 하단에 관련 링크 섹션 추가
            related = f'\n\n---\n## 🔗 관련 항목\n'
            related += ' '.join([f'[[{k}]]' for k in found_kws[:10]])
            related += f'\n\n**재생목록**: [[{f["folder"]} MOC]]\n'

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
