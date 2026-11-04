# Narrows the prime (′, feet) in the Barlow fonts:  python3 tools/fix-prime.py
# Barlow draws ′ the same as ’ but gives it an advance of 0.5-0.6 em, so "12′ 4″" reads as "12′   4″".
# This sets the prime's advance to the right quote's, which has the same outline. Running it twice changes nothing.
# Needs fontTools and brotli (pip install fonttools brotli).
from pathlib import Path
from fontTools.ttLib import TTFont

fonts = Path(__file__).resolve().parent.parent / 'fonts'
for path in sorted(fonts.glob('barlow*.woff2')):
    font = TTFont(path)
    cmap = font.getBestCmap()
    prime, quote = cmap.get(0x2032), cmap.get(0x2019)
    if not prime or not quote:
        print(f'{path.name}: no prime or right quote, left alone')
        continue
    hmtx = font['hmtx']
    adv, lsb = hmtx[prime]
    want = hmtx[quote][0]
    if adv <= want:
        print(f'{path.name}: prime already {adv}')
        continue
    hmtx[prime] = (want, lsb)
    font.flavor = 'woff2'
    tmp = path.with_suffix('.tmp')
    font.save(tmp)
    tmp.replace(path)
    print(f'{path.name}: prime {adv} -> {want}')
