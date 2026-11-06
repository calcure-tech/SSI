# 국토종합진단지수 자료 적재 (v8) — 2026-11-06 8차 취합본
#
# v7에서 달라진 점
#   · 지역산업성장성(S5) 5.5~5.8 지표명 변경(원천자료 동일):
#     기술혁신산업(첨단/고/중/저) 특화도 → 첨단/고/중/저기술업종 산업 특화도.
#     메타 시트의 '지표 정의 및 설명' 칸에 옛 이름만 적혀 있고 정의는 '측정산식' 칸에
#     있으므로, 정의 칸이 이름처럼 짧으면 산식 칸을 정의로 쓴다.
#   · 교통인프라 접근성(S6) 결측치 보정 방식 변경 — KOTI 읍면동 원자료의 0은 120분으로
#     치환 후 산술평균, 국토조사 -999는 컬럼 유효 최댓값으로 치환. 새 파일은 시트 이름
#     ('시군구별_교통접근성'), 머리글 위치(3번째 줄), 코드 번호(S5_*)가 달라 맞춰 읽는다.
#   · 그 밖의 부문은 7차와 동일.
#
# 실행: python3 scripts/build_data8.py

import json
import os
import re
import unicodedata

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, 'src', 'data', 'ssi.json')
GEO = os.path.join(ROOT, 'src', 'data', 'sigungu_geo.json')
SRC = '/home/claude/newdata8'


def pick(prefix):
    for n in os.listdir(SRC):
        if unicodedata.normalize('NFC', n).startswith(prefix):
            return os.path.join(SRC, n)
    raise FileNotFoundError(prefix)


# head: 지표 시트에서 머리글 줄 (pandas header=)
# dirs: 지표 순번 → 방향 (자료에 방향 표기가 없을 때의 확정값)
SECTORS = [
    dict(key='S1', name='공간구조 효율성', icon='◫', file='국토종합진단지수_S1_', head=0, remap={},
         dirs={1: '+', 2: '+', 3: '+', 4: '+', 5: '+', 6: '-'}),
    dict(key='S2', name='인구활력도', icon='◈', file='국토종합진단지수_S2_', head=2, remap={},
         dirs={1: '+', 2: '+', 3: '-', 4: '-', 5: '-', 6: '+'}),
    dict(key='S3', name='재정건전성', icon='₩', file='국토종합진단지수_S3_', head=0, remap={},
         dirs={1: '+', 2: '-', 3: '-', 4: '-', 5: '-', 6: '-'}),
    dict(key='S4', name='지역경제활력도', icon='◐', file='국토종합진단지수_S4_', head=0,
         remap={'S3_': 'S4_'},                       # 자료 시트 첫 열 코드가 S3_1_23으로 잘못 적힘
         dirs={1: '+', 2: '+', 3: '+', 4: '+', 5: '+'}),
    dict(key='S5', name='지역산업성장성', icon='▤', file='국토종합진단지수_S5_', head=0,
         remap={'S4_': 'S5_'},
         desc_in_formula={5, 6, 7, 8},              # 8차: 정의 칸에 옛 지표명만, 정의는 산식 칸에
         dirs={1: '+', 2: '+', 3: '-', 4: '+', 5: '+', 6: '+', 7: '+', 8: '+'}),
    dict(key='S6', name='교통인프라 접근성', icon='◇', file='국토종합진단지수_S6_', head=2,
         remap={'S5_': 'S6_'},                       # 8차 파일: 자료·메타 코드가 옛 번호(S5_*)
         dirs={1: '-', 2: '-', 3: '-', 4: '-', 5: '-'}),
    dict(key='S7', name='생활인프라 접근성', icon='◍', file=None),
    dict(key='S8', name='지역사회건강도', icon='✚', file='국토종합진단지수_S8_', head=0, remap={},
         dirs={1: '-', 2: '-', 3: '-', 4: '-', 5: '-', 6: '-', 7: '+'}),
    dict(key='S9', name='지역안전성', icon='⚑', file='국토종합진단지수_S9_', head=0, remap={},
         dirs={1: '-', 2: '-', 3: '-', 4: '-', 5: '-', 6: '-'}),
    dict(key='S10', name='친환경성', icon='△', file='국토종합진단지수_S10_', head=2,
         remap={'S7_': 'S10_'},
         # 0827 지표 수정: 평가 '등급 평균(▼)' → '1·2등급 면적비율(▲)',
         # 신재생에너지 '생산량' → '발전 비중'. 확인받은 방향 ▲▲▼▲.
         # 7차(1020): 10.4가 신재생에너지 발전도(▲) → 최종에너지 소비량(▼)으로 교체
         dirs={1: '+', 2: '+', 3: '-', 4: '-'}),
]

# S7 생활인프라 접근성 — V0821 지표체계의 계획 지표
S7_PLANNED = [
    dict(no=1, label='교육·학습 인프라 편리성', dir='+', years='2023, 2024',
         desc='교육·학습 인프라 공급수준(천인당 공급량) + 향유수준(서비스권역 내 잠재수요인구 비율) + 충족 수준도(시설 충족도 50% 이상인 거주지 비율)'),
    dict(no=2, label='돌봄·복지 인프라 편리성', dir='+', years='2023, 2024',
         desc='돌봄·복지 인프라 공급수준 + 향유수준 + 충족 수준도'),
    dict(no=3, label='보건·의료 인프라 편리성', dir='+', years='2023, 2024',
         desc='보건·의료 인프라 공급수준 + 향유수준 + 충족 수준도'),
    dict(no=4, label='안전·치안 인프라 편리성', dir='+', years='2023, 2024',
         desc='안전·치안 인프라 공급수준 + 향유수준 + 충족 수준도'),
    dict(no=5, label='체육·문화 인프라 편리성', dir='+', years='2023, 2024',
         desc='체육·문화 인프라 공급수준 + 향유수준 + 충족 수준도'),
]

# 지표명 고정 — 7차 S10 파일의 메타에 1·2번 지표명이 0922 수정 이전 이름(…1•2등급 면적비율)으로
# 되돌아가 있다. README·V1020 지표체계 모두 10.4만 바뀌었다고 하므로 확정 이름을 유지한다.
LABEL_FIX = {'S10_1': '보전환경우수성', 'S10_2': '생태환경우수성'}

SIDO_FIX = {'전북특별자치도': '전라북도', '전남특별자치도': '전라남도'}

METHODS = [
    dict(key='minmax', label='Min-Max', short='MM', camp='간격보존형',
         formula='(x − 최소) / (최대 − 최소) × 100', range='0 ~ 100 (양끝 고정)',
         note='최솟값 0, 최댓값 100으로 고정. 값 간격을 선형으로 보존한다.'),
    dict(key='distance', label='거리기반', short='DI', camp='간격보존형',
         formula='x / 전국평균 × 100', range='상한 없음',
         note='100이 전국평균. LQ(입지지수) × 100과 같은 셈이다.'),
    dict(key='pctrank', label='백분위순위', short='PR', camp='순위전용형',
         formula='평균순위(1기준) / 전체 × 100', range='0 ~ 100 (고르게 퍼짐)',
         note='등수만 반영하고 값 간격은 버린다.'),
    dict(key='logistic', label='로지스틱', short='LG', camp='간격보존형',
         formula='100 / (1 + exp(−z)),  z = (x − 평균) / 표준편차',
         range='0 ~ 100 (양끝에 닿지 않음)',
         note='평균 근처를 벌리고 극단값을 눌러 준다.'),
]

# S5_1_1_21 같은 세 토막도 받는다: 열쇠 = 연도 앞까지 (S5_1_1)
COL_RE = re.compile(r'^S(\d+)_((?:\d+_)*\d+)_(\d{2})$', re.I)
TOTAL_RE = re.compile(r'^S(\d+)_(\d{2}|\d{4})$', re.I)          # S9_21 · S10_2024 — 부문 종합값(적재 안 함)


def s(x):
    if x is None:
        return ''
    t = str(x).strip()
    return '' if t in ('nan', 'NaT', 'None') else t


def year_of(text, fallback):
    m = re.search(r'(20\d{2})', s(text))
    return int(m.group(1)) if m else fallback


def dir_of(meta_dir, note, fallback):
    t = s(meta_dir)
    if '▼' in t: return '-'
    if '▲' in t: return '+'
    n = s(note)
    m = re.search(r'방향\s*([▲▼])', n)
    if m: return '-' if m.group(1) == '▼' else '+'
    return fallback


def read_sector(sec, order):
    path = pick(sec['file'])
    xl = pd.ExcelFile(path)
    sheet = next((n for n in xl.sheet_names if '지표' in n),
                 next(n for n in xl.sheet_names if '메타' not in n and '집계' not in n))
    msheet = next(n for n in xl.sheet_names if '메타' in n)
    df = pd.read_excel(path, sheet_name=sheet, header=sec['head'])
    meta = pd.read_excel(path, sheet_name=msheet, header=0)

    cols = list(df.columns)
    sido_c = next((c for c in cols if '시도' in s(c)), cols[0])
    name_c = next((c for c in cols if '시군구' in s(c) and '코드' not in s(c)), cols[1])
    df[sido_c] = df[sido_c].map(lambda v: SIDO_FIX.get(s(v), s(v)))
    df[name_c] = df[name_c].map(s)
    df = df[df[name_c] != '']
    idx = {(a, b): i for i, (a, b) in enumerate(zip(df[sido_c], df[name_c]))}

    miss = [k for k in order if k not in idx]
    if miss:
        print(f"   !! {sec['key']} 경계와 안 맞는 시군구 {len(miss)}곳: {miss[:5]}")

    def fix(code):
        for a, b in sec.get('remap', {}).items():
            if code.startswith(a.upper()):
                return b.upper() + code[len(a):]
        return code

    mcol = list(meta.columns)
    info = {}
    for _, r in meta.iterrows():
        code = fix(s(r.iloc[0]).upper())
        if not COL_RE.match(code):
            continue
        def g(n, d=''):
            return s(r[n]) if n in mcol else d
        info[code] = dict(
            label=g('지표명'), year=g('연도') or g('자료기준시점'),
            desc=g('지표 정의 및 설명'), formula=g('측정산식'),
            unit=g('단위') or g('원자료 단위'), source=g('자료출처'),
            note=g('비고'), dir=g('방향'),
        )

    inds, series, keyno = {}, {}, {}
    for c in cols:
        code = fix(s(c).upper())
        m = COL_RE.match(code)
        if not m:
            continue
        mid, yy = m.group(2), m.group(3)
        if f"S{m.group(1)}" != sec['key']:
            print(f"   !! {sec['key']} 파일에 다른 부문 코드 {code} — 건너뜀")
            continue
        ikey = f"S{m.group(1)}_{mid}"                     # 지표 열쇠 (S6_1_1 포함)
        md = info.get(code, {})
        year = year_of(md.get('year'), 2000 + int(yy))

        label0 = md.get('label') or ikey
        # 연도 한 칸의 설명 묶음 — S4처럼 정의가 산식 칸에 적힌 파일은 자리를 바꾼다
        desc, formula = md.get('desc', ''), md.get('formula', '')
        if formula and (desc == label0 or int(mid.split('_')[0]) in sec.get('desc_in_formula', ())):
            desc, formula = formula, ''
        fs = dict(desc=desc, formula=formula, unit=md.get('unit', ''),
                  source=md.get('source', ''), note=md.get('note', ''))

        if ikey not in inds:
            keyno[ikey] = len(keyno) + 1
            no = keyno[ikey]
            # 자료 명시 방향 → 순번 확정 방향 → ▲
            base_no = int(mid.split('_')[0])
            fb = sec['dirs'].get(base_no, '+')
            d = dir_of(md.get('dir'), md.get('note'), fb)
            inds[ikey] = dict(
                id=ikey, sector=sec['key'], no=no, label=LABEL_FIX.get(ikey, label0), dir=d,
                unit=fs['unit'], desc=fs['desc'], formula=fs['formula'],
                source=fs['source'], note=fs['note'],
                years=[], cols={},
            )
        else:
            # 이 연도의 설명이 기준(첫 연도)과 다르면 per[연도]에 차이만 담는다
            base = inds[ikey]
            diff = {k: v for k, v in fs.items() if v and v != base.get(k, '')}
            if diff:
                inds[ikey].setdefault('per', {})[str(year)] = diff
        if year not in inds[ikey]['years']:
            inds[ikey]['years'].append(year)
        inds[ikey]['cols'][str(year)] = code

        raw = df[c].tolist()
        vals = []
        for key in order:
            i = idx.get(key)
            v = None if i is None else pd.to_numeric(raw[i], errors='coerce')
            vals.append(None if v is None or pd.isna(v) else round(float(v), 6))
        series[code] = vals

    for v in inds.values():
        v['years'].sort()
    return sorted(inds.values(), key=lambda x: x['no']), series


def main():
    geo = json.load(open(GEO, encoding='utf-8'))
    order = [(f['properties']['sido'], f['properties']['name']) for f in geo['features']]
    order = sorted(set(order))
    rows = [dict(sido=a, name=b) for a, b in order]
    out_sectors, out_inds, out_series = {}, [], {}
    for sec in SECTORS:
        base = dict(key=sec['key'], name=sec['name'], icon=sec['icon'])
        if not sec['file']:
            planned = S7_PLANNED
            out_sectors[sec['key']] = dict(base, ready=False, note='자료 준비중',
                                           inds=[], planned=planned)
            print(f"{sec['key']:>4}  준비중 · 계획 지표 {len(planned)}개")
            continue
        inds, series = read_sector(sec, order)
        out_inds += inds
        out_series.update(series)
        out_sectors[sec['key']] = dict(base, ready=True, note='',
                                       inds=[i['id'] for i in inds], planned=[])
        yrs = sorted({y for i in inds for y in i['years']})
        dirs = ''.join('▼' if i['dir'] == '-' else '▲' for i in inds)
        print(f"{sec['key']:>4}  {sec['name']} · 지표 {len(inds)}개 [{dirs}] · 연도 {yrs[0]}~{yrs[-1]} · 계열 {sum(len(i['cols']) for i in inds)}")

    filled = {k: sum(1 for v in vs if v is not None) for k, vs in out_series.items()}
    thin = {k: n for k, n in filled.items() if n < len(rows)}
    if thin:
        print('\n빈칸이 있는 계열:')
        for k, n in sorted(thin.items()):
            print(f'   {k}: {n}/{len(rows)}')

    payload = dict(
        meta=dict(
            n=len(rows), built='2026-11-06',
            source='국토종합진단지수 8차 취합 (2026-11-06) · 9개 부문 (S7 생활인프라 준비중)',
            note='표준화·부문점수·순위는 화면에서 계산한다. 이 파일에는 원값과 설명만 담는다.',
            reversal='방향 ▼ 지표는 x′ = 최대 + 최소 − x 로 뒤집은 뒤 표준화한다.',
            jeju='제주특별자치도는 광역 1곳이라 제주시·서귀포시에 같은 값이 들어간 지표가 있다.',
        ),
        sectorKeys=[x['key'] for x in SECTORS],
        sectors=out_sectors,
        indicators=out_inds,
        series=out_series,
        methods=METHODS,
        rows=rows,
    )
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    kb = os.path.getsize(OUT) / 1024
    print(f'\n{OUT}  ({kb:,.0f} KB)')
    print(f'시군구 {len(rows)} · 지표 {len(out_inds)} · 계열 {len(out_series)}')


if __name__ == '__main__':
    main()
