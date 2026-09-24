#!/usr/bin/env python3
"""ゆらしてピタッ: 広告収入の試算モデル（外部ライブラリ不要）。

game/docs/ad-revenue-estimate.md に載せた表は、すべてこのスクリプトの出力。
実行: python3 game/docs/ad-revenue-model.py

単位:
- 金額は円（パブリッシャーの手取り＝ネットワークの取り分を引いた後）。
- eCPM は「1,000 表示あたりの手取り（円）」。日本のバナーだけは「1,000 画面あたりの手取り（円）」（ページ RPM で較正、下記）。
- セッション = /api/boot 1 回（ページを開いてから閉じるまで、の下限）。
- DAU = その日に遊んだブラウザ（端末）の数。
"""
from __future__ import annotations

import datetime as dt

# ---------------------------------------------------------------- 為替
# ECB は EUR 建てのレートだけを公表する（2026-09-23: EUR/JPY 180.20, EUR/USD 1.1411）。USD/JPY はそのクロス。
FX_EUR = 180.20
FX_EUR_USD = 1.1411
FX_USD = round(FX_EUR / FX_EUR_USD, 2)   # 157.92

# ---------------------------------------------------------------- 実測（2026-09-24 16:40 JST 時点。data/*.json）
SESSIONS_D1 = 6489             # 09-23（実際の流入は 15:00 JST から）
SESSIONS_D2_PARTIAL = 3252     # 09-24 00:00-16:40
BOOTS_BY_HOUR_D2 = {12: 231, 13: 191, 14: 236, 15: 164, 16: 127}  # 16 時台は 17:41 に確定値を確認（16:40 時点では 95）
HOURS_LEFT_D2 = 7 + 20 / 60    # 16:40 → 24:00
D2_RATE = (100, 170)           # 残り時間の 1 時間あたりセッション（仮定: 下限は 16 時台 127 からの減少、上限は夜に 170/時まで戻る）
SESSIONS_D2_FULL = tuple(round(SESSIONS_D2_PARTIAL + HOURS_LEFT_D2 * r) for r in D2_RATE)
D2_MID = sum(SESSIONS_D2_FULL) / 2
DEVICES_ACTIVE_D2 = 1978       # 09-24 に新しいクリア行を送った端末（下限）
SESSIONS_PER_USER_MEASURED = SESSIONS_D2_PARTIAL / DEVICES_ACTIVE_D2  # 1.64（上限側）
BOOTS_TOTAL = 9741             # 09-23 + 09-24 16:40 まで

# plays: 面ごとの「初めてクリアした端末」の数（09-23 20:44 以降＋それ以前は runs から補完、09-24 16:38 時点）
PLAYS_LEVEL = {'1-1': 3456, '1-2': 2524, '1-3': 2026, '1-4': 1121, '2-1': 951, '2-2': 150, '2-3': 298, '2-4': 47,
               '3-1': 126, '3-2': 19, '3-3': 8, '4-1': 26, '4-2': 56, '4-3': 14, '5-1': 9, '5-2': 8, '5-3': 25, '5-4': 2}
# 09-24 00:00-16:40 だけの行（data/d2_board_split.json）
PLAYS_LEVEL_D2 = {'1-1': 1848, '1-2': 1332, '1-3': 1037, '1-4': 523, '2-1': 416, '2-2': 67, '2-3': 125, '2-4': 25,
                  '3-1': 63, '3-2': 12, '3-3': 5, '4-1': 14, '4-2': 28, '4-3': 9, '5-1': 9, '5-2': 8, '5-3': 18, '5-4': 2}
LAST_LEVEL = '5-4'             # 次のレベルがないので「リザルト→次へ」は起きない
PLAYS_ROWS_D2 = 5659           # 09-24 の新しい行（今日の5球を含む）
BURST_ROWS_D2 = 1709           # うち、全行が 1 分以内に届いた端末（598 台）の行
PLAYS_ROWS_D1_EVENING = 3202   # 09-23 20:44-24:00
BOOTS_D1_EVENING = round(648 * 16 / 60 + 534 + 492 + 493)   # 20:44-24:00 のセッション（20 時台は按分）
RETURN_ALL = (136, 2225)       # 09-23 に記録のある端末のうち 09-24 にも新しい行を送った数
RETURN_AFTER_2044 = (90, 1182)  # 09-23 20:44 以降に記録された端末に限った場合

# /api/boot の国別件数（クライアント IP の国、09-23 + 09-24 16:40 まで）
BOOT_BY_COUNTRY = {
    'JP': 9171, 'US': 111, 'TW': 55, 'KR': 48, 'FR': 33, 'HK': 31, 'GB': 27, 'IN': 23, 'SG': 22,
    'ID': 15, 'DE': 14, 'VN': 14, 'BR': 14, 'CH': 13, 'NL': 12, 'TH': 11, 'ES': 11, 'AU': 8, 'GR': 8,
    'MX': 7, 'PH': 6, 'TR': 6, 'CA': 6, 'MY': 5, 'BE': 5, 'IL': 5, 'SA': 4, 'AR': 4, 'IT': 4, 'HU': 3,
    'SE': 3, 'PL': 3, 'CL': 3, 'NZ': 3, 'RS': 3, 'QA': 2, 'KH': 2, 'SK': 2, 'UZ': 2, 'CN': 2, 'FI': 2,
    'LT': 2, 'CZ': 2, 'GT': 1, 'PT': 1, 'LV': 1, 'CO': 1, 'UG': 1, 'MA': 1, 'JO': 1, 'BY': 1, 'NP': 1,
    'NG': 1,
}
EU27 = set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split())
EEA_UK_CH = EU27 | {'IS', 'LI', 'NO', 'GB', 'CH'}        # Google 認定 CMP が必要な地域
TIER1 = {'US', 'CA', 'GB', 'AU', 'NZ', 'IE', 'DE', 'FR', 'NL', 'BE', 'LU', 'AT', 'CH',
         'DK', 'SE', 'NO', 'FI', 'IS', 'IT', 'ES'}          # 単価の高い国（筆者の区分）


def region_of(cc: str) -> str:
    if cc == 'JP':
        return 'JP'
    return 'T1' if cc in TIER1 else 'OTHER'


def level_after(a: str, b: str) -> bool:
    """面 a が面 b 以降か（'2-3' >= '2-3'）。"""
    return tuple(map(int, a.split('-'))) >= tuple(map(int, b.split('-')))


def eligible_results(plays: dict[str, int], first: str) -> int:
    """§6.2 のルールで全画面広告を出せる「リザルト→次のレベル」の回数（初クリアだけ）。first 以降の面、最終面を除く。"""
    return sum(n for lv, n in plays.items() if level_after(lv, first) and lv != LAST_LEVEL)


# ---------------------------------------------------------------- 1 セッションあたりの広告の数
# インタースティシャル（§6.2 のおすすめルール: リザルト→次のレベルだけ、1-1〜1-4 と 2-2 の前後には出さない、3 分に 1 回まで）
INTER_IMP = {
    'low': eligible_results(PLAYS_LEVEL, '2-4') / BOOTS_TOTAL,             # 2-3 のリザルトも「2-2 の前後」とみなす
    'mid': eligible_results(PLAYS_LEVEL, '2-3') / BOOTS_TOTAL,             # 2-3 以降の初クリア（2 日間）
    'high': eligible_results(PLAYS_LEVEL_D2, '2-3') / SESSIONS_D2_PARTIAL,  # 09-24 だけ（戻ってきた人は先の面にいる）
}
INTER_IMP_FREE = 1.0     # 制限なし（毎回のリザルト→次へ、3 分に 1 回まで）の上限の目安。旧版の中の値
BANNER_SETS = {'low': 1.0, 'mid': 1.5, 'high': 3.0}    # 新しい広告枠を読み込む画面の数（自動更新は禁止）
REWARD_OFFERS = {'low': 0.1, 'mid': 0.2, 'high': 0.3}  # リワードを提案する回数（スキン早期開放・ヒントなど）
REWARD_ACCEPT = {'low': 0.2, 'mid': 0.35, 'high': 0.5}  # 提案 1 回あたり見る割合（仮定。業界の数字は DAU あたりの参加率で単位が違う）
FILL = {'low': 0.70, 'mid': 0.85, 'high': 0.95}         # 広告が実際に返ってくる割合
ADBLOCK = {'JP': 0.10, 'T1': 0.30, 'OTHER': 0.30}       # 広告ブロックで表示されない割合

# ---------------------------------------------------------------- 単価（筆者の推定。根拠は md の §2.4）
# 日本のバナー: 1,000 画面あたりの手取り（円）。個人サイトのページ RPM（全枠合計、Fill・広告ブロック・視認性込み）で較正したので、
# Fill と広告ブロックはもう掛けない。
JP_BANNER_RPM = {'low': 20, 'mid': 40, 'high': 100}
# それ以外: 1,000 表示あたりの手取り（円）。
ECPM = {
    'low':  {'banner': {'T1': 80,  'OTHER': 10}, 'inter': {'JP': 150, 'T1': 250,  'OTHER': 50},  'reward': {'JP': 300,  'T1': 600,  'OTHER': 150}},
    'mid':  {'banner': {'T1': 130, 'OTHER': 25}, 'inter': {'JP': 250, 'T1': 500,  'OTHER': 120}, 'reward': {'JP': 650,  'T1': 1000, 'OTHER': 250}},
    'high': {'banner': {'T1': 200, 'OTHER': 60}, 'inter': {'JP': 800, 'T1': 1500, 'OTHER': 300}, 'reward': {'JP': 1500, 'T1': 2400, 'OTHER': 500}},
}
RATE_LABEL = {'low': '低単価', 'mid': '中単価', 'high': '高単価'}

# ---------------------------------------------------------------- 流入（発売の山のあとの継続と、新しく来る人）
LAUNCH_DAY = dt.date(2026, 9, 23)
AD_START = dt.date(2026, 11, 1)
LAUNCH_COHORT = round(4058 + HOURS_LEFT_D2 * 45, -2)   # 発売 2 日間にクリアを記録した端末（16:40 に 4,058、残りは 45 台/時と仮定）
SESSIONS_PER_USER = 1.5  # 実測 1.64 は上限側なので少し下げる
ORGANIC_FROM = 7         # 発売 8 日目から、毎日一定数の新しい人が来ると置く
# r1: 翌日も来る割合（実測 6.1〜7.6%、下限）。b: t 日後に来る割合 = r1 × t^-b の減り方（モバイルゲームの上位 25% ≈ 0.65、下位 25% ≈ 1.0）
# inflow: 1 日に新しく来る端末（仮定。根拠となる実測はない）。spikes: 1 年の再バズの回数（仮定）。
TRAFFIC = {
    '保守': {'r1': 0.06, 'b': 1.00, 'inflow': 5,  'spikes': 0, 'rate': 'low'},
    '標準': {'r1': 0.08, 'b': 0.80, 'inflow': 20, 'spikes': 1, 'rate': 'mid'},
    '楽観': {'r1': 0.12, 'b': 0.65, 'inflow': 50, 'spikes': 4, 'rate': 'high'},
}
DAYS_PER_MONTH = 365 / 12

# 再バズ 1 回ぶんのセッション: 発売 2 日間の実測 + 3〜7 日目を 1 日 0.6 倍で減衰と仮定
SPIKE_DECAY = 0.6
SPIKE_SESSIONS = SESSIONS_D1 + D2_MID + sum(D2_MID * SPIKE_DECAY ** k for k in range(1, 6))

# 季節補正（月ごと）
SEASON_BY_MONTH = {10: 1.1, 11: 1.2, 12: 1.3, 1: 0.7}
MONTHS = [f'{(2026 * 12 + 10 + i) // 12}-{(10 + i) % 12 + 1:02d}' for i in range(12)]   # 2026-11 .. 2027-10

# ---------------------------------------------------------------- 費用・閾値
DOMAIN_NOW = 10.46 * FX_USD        # .com（Cloudflare Registrar、2026-09 時点）
DOMAIN_AFTER_NOV = 11.17 * FX_USD  # 2026-11-01 の卸値改定後の見込み
PAYOUT_THRESHOLD = 8000            # AdSense 日本の支払い基準額
H5_WAIT_MONTHS = 2                 # H5 ゲーム広告の承認待ち（仮定）。その間はバナーだけ

FMT_ALL = ('banner', 'inter', 'reward')
PATTERNS = {
    'A バナーのみ': (('banner',), None),
    'B リワードのみ': (('reward',), None),
    'C バナー＋リワード': (('banner', 'reward'), None),
    'D バナー＋インタースティシャル（おすすめルール）': (('banner', 'inter'), None),
    'E 全部（おすすめルール）': (FMT_ALL, None),
    'F 全部（インタースティシャル制限なし 1.0/セッション、上限の目安）': (FMT_ALL, INTER_IMP_FREE),
}


def shares(overseas_mult: float = 1.0) -> dict[str, float]:
    """国ごとのセッション（今の総数を 1 とする）。overseas_mult で日本はそのまま、海外だけ増やす（足し算）。"""
    tot = sum(BOOT_BY_COUNTRY.values())
    return {cc: n / tot * (1.0 if cc == 'JP' else overseas_mult) for cc, n in BOOT_BY_COUNTRY.items()}


def rev_per_session(rate: str, fmts=FMT_ALL, overseas_mult=1.0, exclude_eea=True, ecpm_mult=None, imp_mult=None,
                    fill=None, inter_imp=None, only=None) -> dict[str, float]:
    """今のセッション 1 回あたりの手取り（円）を形式別に返す。only='JP' / 'OS' で日本・海外だけを数える。"""
    ecpm_mult = ecpm_mult or {}
    imp_mult = imp_mult or {}
    f = FILL[rate] if fill is None else fill
    ii = INTER_IMP[rate] if inter_imp is None else inter_imp
    imps = {'banner': BANNER_SETS[rate], 'inter': ii, 'reward': REWARD_OFFERS[rate] * REWARD_ACCEPT[rate]}
    out = {fm: 0.0 for fm in FMT_ALL}
    for cc, sh in shares(overseas_mult).items():
        if exclude_eea and cc in EEA_UK_CH:
            continue
        if only == 'JP' and cc != 'JP' or only == 'OS' and cc == 'JP':
            continue
        rg = region_of(cc)
        for fm in fmts:
            imp = imps[fm] * imp_mult.get(fm, 1.0)
            m = ecpm_mult.get(fm, 1.0)
            if fm == 'banner' and rg == 'JP':
                out[fm] += sh * imp * JP_BANNER_RPM[rate] * m / 1000
            else:
                out[fm] += sh * (1 - ADBLOCK[rg]) * f * imp * ECPM[rate][fm][rg] * m / 1000
    return out


def rps(rate: str, fmts=FMT_ALL, **kw) -> float:
    return sum(rev_per_session(rate, fmts, **kw).values())


# ---------------------------------------------------------------- DAU の推移
_S_CACHE: dict[float, list[float]] = {}


def _prefix(b: float, n: int) -> list[float]:
    """S[k] = Σ_{a=1..k} a^-b"""
    s = _S_CACHE.setdefault(b, [0.0])
    for a in range(len(s), n + 1):
        s.append(s[-1] + a ** -b)
    return s


def dau_parts(tr: dict, day: dt.date) -> tuple[float, float]:
    """(発売 2 日間の人のうち戻ってくる数, 8 日目以降に来た人とその再訪)"""
    t = (day - LAUNCH_DAY).days
    cohort = LAUNCH_COHORT * tr['r1'] * t ** -tr['b'] if t >= 1 else LAUNCH_COHORT
    n = t - ORGANIC_FROM
    organic = tr['inflow'] * (1 + tr['r1'] * _prefix(tr['b'], max(n, 0))[max(n, 0)]) if n >= 0 else 0.0
    return cohort, organic


def dau(tr: dict, day: dt.date) -> float:
    return sum(dau_parts(tr, day))


def month_iter(n_months: int):
    """広告開始から n か月ぶんの (ラベル, [日付...])"""
    y, m = AD_START.year, AD_START.month
    for _ in range(n_months):
        days = []
        d = dt.date(y, m, 1)
        while d.month == m:
            days.append(d)
            d += dt.timedelta(days=1)
        yield f'{y}-{m:02d}', days
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def monthly_series(tr: dict, rps_of_month, n_months: int = 12, season: bool = True) -> list[tuple[str, float, float]]:
    """[(月, 平均 DAU, 手取り)]。rps_of_month(i) で月ごとに 1 セッションあたりの手取りを変えられる（H5 の承認待ちなど）。"""
    out = []
    for i, (lab, avg_dau, sess) in enumerate(_sessions_by_month(tr, n_months)):
        s = SEASON_BY_MONTH.get(int(lab[5:]), 1.0) if season else 1.0
        out.append((lab, avg_dau, sess * rps_of_month(i) * s))
    return out


def first_month(tr: dict, r: float) -> float:
    """11 月（開始月）の手取り、季節補正前"""
    return monthly_series(tr, lambda i: r, 1, season=False)[0][2]


def first_year(tr: dict, r: float) -> float:
    return sum(v for _, _, v in monthly_series(tr, lambda i: r)) + tr['spikes'] * SPIKE_SESSIONS * r


_SERIES_CACHE: dict[tuple, list[tuple[str, float, float]]] = {}


def _sessions_by_month(tr: dict, n_months: int) -> list[tuple[str, float, float]]:
    """[(月, 平均 DAU, セッション)]（季節補正・単価の前）。同じシナリオで何度も呼ぶのでキャッシュする。"""
    key = (tuple(sorted(tr.items())), n_months)
    if key not in _SERIES_CACHE:
        out = []
        for lab, days in month_iter(n_months):
            d_sum = sum(dau(tr, d) for d in days)
            out.append((lab, d_sum / len(days), d_sum * SESSIONS_PER_USER))
        _SERIES_CACHE[key] = out
    return _SERIES_CACHE[key]


def payout(tr: dict, rps_of_month, months: int = 240, spike_every_12_at: int | None = None) -> tuple[int, str] | None:
    """累計が基準額に届く月（1 始まり）と、支払いの時期。spike_every_12_at を与えると、毎年その月（0 始まり）に再バズ 1 回を足す。"""
    cum = 0.0
    for i, (lab, _, v) in enumerate(monthly_series(tr, rps_of_month, months)):
        cum += v
        if spike_every_12_at is not None and i % 12 == spike_every_12_at:
            cum += SPIKE_SESSIONS * rps_of_month(i)
        if cum >= PAYOUT_THRESHOLD:
            n = i + 1
            y, mo = divmod(2026 * 12 + 10 + n, 12)   # 翌月
            when = f'{y}-{mo + 1:02d} の 21〜26 日' if n < 36 else f'{n + 1} か月目（約 {(n + 0.75) / 12:.1f} 年後）'
            return n, when
    return None


def dau_for(yen_per_year: float, r: float) -> float:
    return yen_per_year / (SESSIONS_PER_USER * 365 * r)


def yen(x: float) -> str:
    """1,000 円以上は 10 円単位、10 円以上は 1 円単位、それ未満は 0.1 円単位で丸める。"""
    a = abs(x)
    sign = '−' if x < 0 else ''
    if a >= 1000:
        return sign + f'{round(a, -1):,.0f}'
    if a >= 10:
        return sign + f'{a:,.0f}'
    return sign + f'{a:,.1f}'


def table(head: list[str], rows: list[list[str]]) -> str:
    lines = ['| ' + ' | '.join(head) + ' |', '|' + '|'.join('---' for _ in head) + '|']
    lines += ['| ' + ' | '.join(r) + ' |' for r in rows]
    return '\n'.join(lines)


def main() -> None:
    s = shares()
    jp = s['JP']
    t1 = sum(v for cc, v in s.items() if region_of(cc) == 'T1')
    other = sum(v for cc, v in s.items() if region_of(cc) == 'OTHER')
    eea = sum(v for cc, v in s.items() if cc in EEA_UK_CH)

    print('## T0 為替・実測からの導出')
    print(f'USD/JPY {FX_EUR} ÷ {FX_EUR_USD} = {FX_USD} / EUR/JPY {FX_EUR}')
    print(f'国の数（日本を含む）: {len(BOOT_BY_COUNTRY)}')
    print(table(['区分', 'セッション比率'], [
        ['日本', f'{jp:.1%}'], ['Tier1（米・加・英・豪・NZ・西欧）', f'{t1:.1%}'], ['その他', f'{other:.1%}'],
        ['うち EEA・英国・スイス（CMP が必要）', f'{eea:.1%}'], ['うち米国', f'{s["US"]:.1%}'],
    ]))
    lo, hi = SESSIONS_D2_FULL
    print(f'09-24 全日: {SESSIONS_D2_PARTIAL:,} + {HOURS_LEFT_D2:.2f} 時間 × {D2_RATE[0]}〜{D2_RATE[1]}/時 = {lo:,}〜{hi:,}（中央 {D2_MID:,.0f}）。'
          f'中央に要る 1 時間あたり: {(D2_MID - SESSIONS_D2_PARTIAL) / HOURS_LEFT_D2:.0f}')
    print(f'再バズ 1 回のセッション数（仮定）: {SPIKE_SESSIONS:,.0f}（D2 の見込みを {1 + sum(SPIKE_DECAY ** k for k in range(1, 6)):.2f} 回使う）')
    print(f'新しいクリア/セッション: 2 日間 {sum(PLAYS_LEVEL.values()):,}/{BOOTS_TOTAL:,} = {sum(PLAYS_LEVEL.values()) / BOOTS_TOTAL:.2f}、'
          f'09-24 {PLAYS_ROWS_D2 / SESSIONS_D2_PARTIAL:.2f}（1 分以内のまとまりを除くと {(PLAYS_ROWS_D2 - BURST_ROWS_D2) / SESSIONS_D2_PARTIAL:.2f}）、'
          f'09-23 夜 {PLAYS_ROWS_D1_EVENING}/{BOOTS_D1_EVENING} = {PLAYS_ROWS_D1_EVENING / BOOTS_D1_EVENING:.2f}')
    print(f'全画面広告を出せるリザルト→次へ（初クリア）: 2-3 以降 {eligible_results(PLAYS_LEVEL, "2-3")}、2-4 以降 {eligible_results(PLAYS_LEVEL, "2-4")}（{BOOTS_TOTAL:,} セッション）、'
          f'09-24 だけ 2-3 以降 {eligible_results(PLAYS_LEVEL_D2, "2-3")}（{SESSIONS_D2_PARTIAL:,} セッション）')
    print('→ インタースティシャル/セッション: ' + ' / '.join(f'{RATE_LABEL[r]} {INTER_IMP[r]:.3f}' for r in INTER_IMP))
    print(f'翌日も来た割合: {RETURN_ALL[0]}/{RETURN_ALL[1]} = {RETURN_ALL[0] / RETURN_ALL[1]:.1%}、20:44 以降の組 {RETURN_AFTER_2044[0]}/{RETURN_AFTER_2044[1]} = {RETURN_AFTER_2044[0] / RETURN_AFTER_2044[1]:.1%}')
    print(f'発売 2 日間の端末（見込み）: {LAUNCH_COHORT:,.0f}')
    print(f'リワード視聴/DAU/日（中）: {REWARD_OFFERS["mid"] * REWARD_ACCEPT["mid"] * SESSIONS_PER_USER:.3f}')
    print()

    print('## T0b 流入シナリオ: DAU の推移（広告開始 2026-11-01 = 発売 39 日目）')
    rows = []
    for tn, tr in TRAFFIC.items():
        c0, o0 = dau_parts(tr, AD_START)
        c1, o1 = dau_parts(tr, dt.date(2027, 10, 31))
        avg = sum(a for _, a, _ in monthly_series(tr, lambda i: 0.0)) / 12
        rows.append([tn, f'{tr["r1"]:.0%}', f'{tr["b"]:.2f}', f'{tr["inflow"]}', f'{tr["spikes"]}',
                     f'{c0:.0f} + {o0:.0f} = {c0 + o0:.0f}', f'{c1:.0f} + {o1:.0f} = {c1 + o1:.0f}', f'{avg:.0f}'])
    print(table(['シナリオ', '翌日も来る割合', '減り方 b', '新しく来る/日', '再バズ/年',
                 'DAU 2026-11-01（発売組 + その後の組）', 'DAU 2027-10-31', '初年度の平均 DAU'], rows))
    print()

    print('## T1 1 セッションあたりの表示回数と手取り（EEA・英国・スイスは配信しない）')
    rows = []
    for r in ('low', 'mid', 'high'):
        rv = rev_per_session(r)
        rows.append([RATE_LABEL[r], f'{BANNER_SETS[r]:g}', f'{INTER_IMP[r]:.3f}', f'{REWARD_OFFERS[r] * REWARD_ACCEPT[r]:.3g}',
                     f'{FILL[r]:.0%}', yen(rv['banner'] * 1000), yen(rv['inter'] * 1000), yen(rv['reward'] * 1000),
                     yen(sum(rv.values()) * 1000), f'{sum(rv.values()) * SESSIONS_PER_USER:.2f}'])
    for r in ('mid',):
        rv = rev_per_session(r, inter_imp=INTER_IMP_FREE)
        rows.append([f'参考: {RATE_LABEL[r]}・制限なし', f'{BANNER_SETS[r]:g}', f'{INTER_IMP_FREE:g}', f'{REWARD_OFFERS[r] * REWARD_ACCEPT[r]:.3g}',
                     f'{FILL[r]:.0%}', yen(rv['banner'] * 1000), yen(rv['inter'] * 1000), yen(rv['reward'] * 1000),
                     yen(sum(rv.values()) * 1000), f'{sum(rv.values()) * SESSIONS_PER_USER:.2f}'])
    print(table(['単価', 'バナーの画面/セッション', 'インタースティシャル/セッション', 'リワード視聴/セッション', 'Fill',
                 'バナー 円/1000セッション', 'インタースティシャル 円/1000セッション', 'リワード 円/1000セッション',
                 '合計 円/1000セッション', '円/DAU/日'], rows))
    print()

    combos = [(tn, tr['rate']) for tn, tr in TRAFFIC.items()]
    print('## T2 3 シナリオ（E 全部・おすすめルール）: 11 月の月額（季節補正前）と初年度')
    rows = []
    for tn, r in combos:
        tr = TRAFFIC[tn]
        rv = rev_per_session(r)
        m = {k: first_month(tr, v) for k, v in rv.items()}
        y = first_year(tr, sum(rv.values()))
        rows.append([f'{tn}（{RATE_LABEL[r]}・再バズ年 {tr["spikes"]} 回）', f'{dau(tr, AD_START):.0f}', yen(m['banner']), yen(m['inter']),
                     yen(m['reward']), yen(sum(m.values())), yen(y)])
    print(table(['シナリオ', 'DAU（11-01）', 'バナー 円/月', 'インタースティシャル 円/月', 'リワード 円/月', '合計 円/月（11 月）',
                 '初年度 円/年（季節補正・再バズ込み）'], rows))
    print()

    print('## T3 流入 × 単価の 9 通り（E）: 11 月の月額 / 初年度')
    rows = []
    for tn, tr in TRAFFIC.items():
        row = [f'{tn}（DAU {dau(tr, AD_START):.0f}→{dau(tr, dt.date(2027, 10, 31)):.0f}、再バズ {tr["spikes"]} 回/年）']
        for r in ('low', 'mid', 'high'):
            x = rps(r)
            row.append(f'{yen(first_month(tr, x))} / {yen(first_year(tr, x))}')
        rows.append(row)
    print(table(['流入 ＼ 単価', '低単価', '中単価', '高単価'], rows))
    print()

    print('## T4 入れ方（パターン）別: 中単価での 1000 セッションあたりと 11 月の月額')
    rows = []
    for name, (fm, ii) in PATTERNS.items():
        x = rps('mid', fm, inter_imp=ii)
        rows.append([name, yen(x * 1000)] + [yen(first_month(TRAFFIC[t], x)) for t in TRAFFIC] + [yen(first_year(TRAFFIC['標準'], x))])
    print(table(['入れ方', '円/1000セッション', '保守 円/月', '標準 円/月', '楽観 円/月', '標準の初年度 円'], rows))
    base_c = rps('mid', ('banner', 'reward'))
    print(f'E / C = {rps("mid") / base_c:.2f}、F / C = {rps("mid", inter_imp=INTER_IMP_FREE) / base_c:.2f}')
    print()

    print('## T4b C バナー＋リワードの 9 通り: 11 月の月額（円）')
    rows = []
    for tn, tr in TRAFFIC.items():
        rows.append([tn] + [yen(first_month(tr, rps(r, ('banner', 'reward')))) for r in ('low', 'mid', 'high')])
    print(table(['流入 ＼ 単価', '低単価', '中単価', '高単価'], rows))
    print()

    print('## T5 比較: 外部の実績・推定（1000 セッション or 1000 PV / 1000 プレイあたり）')
    rows = [
        ['このモデル・中単価・バナーのみ', yen(rps('mid', ('banner',)) * 1000)],
        ['このモデル・中単価・E 全部（おすすめルール）', yen(rps('mid') * 1000)],
        ['このモデル・中単価・F 全部（制限なし）', yen(rps('mid', inter_imp=INTER_IMP_FREE) * 1000)],
        ['このモデル・日本のインタースティシャルだけ（中・E）', yen(rev_per_session('mid', ('inter',), only='JP')['inter'] * 1000)],
        ['このモデル・日本のインタースティシャルだけ（中・F）', yen(rev_per_session('mid', ('inter',), only='JP', inter_imp=INTER_IMP_FREE)['inter'] * 1000)],
        ['Google AdSense 計算機（ゲーム・APAC、$1.55/1000PV）', yen(1.55 * FX_USD)],
        ['Google AdSense 計算機（ゲーム・南北アメリカ、$1.21）', yen(1.21 * FX_USD)],
        ['CrazyGames 8 作品の開発者取り分（€1.23/1000 プレイ）', yen(556.92 / 451327 * 1000 * FX_EUR)],
        ['CrazyGames 1 作品（€0.77/1000 プレイ）', yen(0.77 * FX_EUR)],
    ]
    print(table(['比較対象', '円/1000'], rows))
    print()

    print('## T6 もし発売直後から広告が出ていたら（E 全部・おすすめルール）')
    rl, rm, rh = (rps(r) for r in ('low', 'mid', 'high'))
    rows = [
        [f'09-23（{SESSIONS_D1:,} セッション）', yen(SESSIONS_D1 * rl), yen(SESSIONS_D1 * rm), yen(SESSIONS_D1 * rh)],
        [f'09-24 全日見込み（{D2_MID:,.0f} セッション）', yen(D2_MID * rl), yen(D2_MID * rm), yen(D2_MID * rh)],
        [f'再バズ 1 回（{SPIKE_SESSIONS:,.0f} セッション）', yen(SPIKE_SESSIONS * rl), yen(SPIKE_SESSIONS * rm), yen(SPIKE_SESSIONS * rh)],
    ]
    print(table(['期間', '低単価 円', '中単価 円', '高単価 円'], rows))
    print(f'2 日間（中）: E {yen((SESSIONS_D1 + D2_MID) * rm)} 円 / C {yen((SESSIONS_D1 + D2_MID) * base_c)} 円 / F {yen((SESSIONS_D1 + D2_MID) * rps("mid", inter_imp=INTER_IMP_FREE))} 円')
    print()

    std = TRAFFIC['標準']
    r_a, r_c, r_e = rps('mid', ('banner',)), base_c, rm
    print('## T7 初年度の月別（標準・中単価・E、再バズなし）')
    cum = 0.0
    rows = []
    for lab, a, v in monthly_series(std, lambda i: r_e):
        cum += v
        rows.append([lab, f'{a:.0f}', f'×{SEASON_BY_MONTH.get(int(lab[5:]), 1.0):g}', yen(v), yen(cum)])
    print(table(['月', '平均 DAU', '季節補正', '手取り 円', '累計 円'], rows))
    print()

    print('## T7b 累計 8,000 円に届く時期（標準・中単価、再バズなし）')
    cases = [
        ('E を 11-01 から', lambda i: r_e),
        (f'H5 の承認待ち {H5_WAIT_MONTHS} か月はバナーだけ、その後 E', lambda i: r_a if i < H5_WAIT_MONTHS else r_e),
        (f'H5 の承認待ち {H5_WAIT_MONTHS} か月はバナーだけ、その後 C', lambda i: r_a if i < H5_WAIT_MONTHS else r_c),
        ('H5 が通らずバナーだけ', lambda i: r_a),
        ('E を 11-01 から＋再バズ 毎年 1 回（各年の 6 か月目と仮定）', lambda i: r_e, 5),
    ]
    rows = []
    for name, f, *sp in cases:
        p = payout(std, f, spike_every_12_at=sp[0] if sp else None)
        rows.append([name, f'{p[0]} か月目' if p else '20 年以上', p[1] if p else '—'])
    print(table(['ケース', '累計が 8,000 円を超える月', '最初の支払い'], rows))
    print()

    print('## T8 損益分岐と支払い（E、再バズは初年度には入れ、支払いの計算には入れない）')
    rows = []
    for tn, r in combos:
        tr = TRAFFIC[tn]
        x = rps(r)
        xa = rps(r, ('banner',))
        y = first_year(tr, x)
        p1 = payout(tr, lambda i: x)
        p2 = payout(tr, lambda i: xa if i < H5_WAIT_MONTHS else x)
        w1, w2 = (p[1] if p else '20 年以上' for p in (p1, p2))
        rows.append([f'{tn}（{RATE_LABEL[r]}）', yen(y), yen(y - DOMAIN_AFTER_NOV), w1 if w1 == w2 else f'{w1} 〜 {w2}'])
    print(table(['シナリオ', '初年度収益 円', 'ドメイン代（約 1,760 円/年）を引いた残り 円', '最初の支払い（E を 11-01 から 〜 2 か月バナーだけ）'], rows))
    print(f'ドメイン代: 現在 {DOMAIN_NOW:,.0f} 円/年、2026-11-01 以降 約 {DOMAIN_AFTER_NOV:,.0f} 円/年')
    print()

    print('## T9 必要な DAU（定常、再バズなし、季節補正なし、E）')
    targets = [('ドメイン代を回収（年 1,760 円）', DOMAIN_AFTER_NOV), ('1 年で支払い基準額（年 8,000 円）', 8000),
               ('月 1 万円（年 12 万円）', 120000), ('勤労学生控除の線（所得 10 万円/年）', 100000),
               ('会社員の確定申告の線（所得 20 万円/年）', 200000), ('所得税の扶養の線（所得 62 万円/年、2026 年分）', 620000)]
    rows = []
    for name, v in targets:
        rows.append([name] + [f'{dau_for(v, rps(r)):,.0f}' for r in ('low', 'mid', 'high')] + [f'{dau_for(v, base_c):,.0f}'])
    print(table(['目標', '低単価', '中単価', '高単価', '参考: C・中単価'], rows))
    print()

    print('## T10 感度分析（標準・中単価・E を 1.00 とした倍率）')
    base = rm
    rv_base = rev_per_session('mid')
    jp_ps = rps('mid', only='JP') / jp
    os_ps = rps('mid', only='OS') / (1 - jp)
    k70 = (jp / 0.70 - jp) / (1 - jp)
    sens = [
        ('DAU が 2 倍', 2.0),
        ('1 人あたりのセッションが 2 倍', 2.0),
        ('インタースティシャルの回数が 2 倍', rps('mid', imp_mult={'inter': 2}) / base),
        ('インタースティシャルの eCPM が 2 倍', rps('mid', ecpm_mult={'inter': 2}) / base),
        ('インタースティシャルを制限なし（1.0/セッション）', rps('mid', inter_imp=INTER_IMP_FREE) / base),
        ('バナーの単価が 2 倍', rps('mid', ecpm_mult={'banner': 2}) / base),
        ('バナーの画面数が 2 倍', rps('mid', imp_mult={'banner': 2}) / base),
        ('リワードの視聴（提案の回数 × 見る割合）が 2 倍', rps('mid', imp_mult={'reward': 2}) / base),
        ('リワードの eCPM が 2 倍', rps('mid', ecpm_mult={'reward': 2}) / base),
        ('Fill が 85% → 100%', rps('mid', fill=1.0) / base),
        ('海外のセッションが今の 2 倍（日本はそのまま）', rps('mid', overseas_mult=2) / base),
        (f'英語版で海外が増え、日本が全体の 70% に（日本はそのまま、海外 ×{k70:.1f}）', rps('mid', overseas_mult=k70) / base),
        ('EEA・英国・スイスにも配信（CMP を入れる）', rps('mid', exclude_eea=False) / base),
        ('インタースティシャルをやめる（C）', base_c / base),
        ('広告で DAU が 30% 減る', 0.7),
    ]
    print(table(['変える前提', '収入の倍率'], [[n, f'×{v:.2f}'] for n, v in sens]))
    share = {k: v / base for k, v in rv_base.items()}
    print(f'形式別の比率（標準）: バナー {share["banner"]:.0%} / インタースティシャル {share["inter"]:.0%} / リワード {share["reward"]:.0%}')
    print(f'1 セッションあたり（中・E）: 日本 {jp_ps:.3f} 円、海外 {os_ps:.3f} 円（海外は日本の {os_ps / jp_ps:.2f} 倍）')
    print()

    print('## T11 その他の数字')
    std_m = first_month(std, r_e)
    per_day = std_m / 30
    print(f'09-24 の水準（{D2_MID:,.0f} セッション/日）が 1 か月続いた場合（中単価）: E {yen(D2_MID * DAYS_PER_MONTH * r_e)} 円/月、'
          f'C {yen(D2_MID * DAYS_PER_MONTH * r_c)} 円/月、F {yen(D2_MID * DAYS_PER_MONTH * rps("mid", inter_imp=INTER_IMP_FREE))} 円/月')
    print(f'標準・E の 11 月の 1 日あたり: {per_day:,.1f} 円')
    print(f'OFUSE 1,000 円の単発支援（2026-10-01 以降、手数料 16%、決済手数料込み）の手取り 840 円 = 標準・E の 11 月の広告 {840 / per_day:.0f} 日分')
    print(f'Ko-fi / BMC で 500 円（手数料 5% の場合 475 円、決済手数料は別）= 標準・E の 11 月の広告 {475 / per_day:.0f} 日分')
    print(f'CrazyGames の支払い最低額 €100 = {100 * FX_EUR:,.0f} 円、GameMonetize $30 = {30 * FX_USD:,.0f} 円、BMC 出金 $10 = {10 * FX_USD:,.0f} 円')
    print(f'COPPA 罰金上限 $53,088 = {53088 * FX_USD / 1e4:,.0f} 万円')
    print(f'AdSense 計算機 APAC ゲーム $1.55/1000PV で 8,000 円に届く PV: {8000 / (1.55 * FX_USD) * 1000:,.0f}')


if __name__ == '__main__':
    main()
