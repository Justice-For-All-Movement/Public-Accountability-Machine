import json, sys, re, collections, unicodedata
def norm(s):
    s = unicodedata.normalize('NFC', s or '')
    s = s.translate(str.maketrans({'ي': 'ی', 'ى': 'ی', 'ك': 'ک', 'ة': 'ه', 'ۀ': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ؤ': 'و', '‌': ' ', '‏': '', '‎': ''}))
    s = re.sub(r'[ً-ٰٟ]', '', s)          # harakat
    s = re.sub(r'\(.*?\)', ' ', s)                          # parenthesised notes such as (زیر۱۸سال)
    return re.sub(r'\s+', ' ', s).strip()
rows = json.load(open(sys.argv[1])); ent = json.load(open(sys.argv[2]))
off = collections.defaultdict(list); mem = collections.defaultdict(list)
for r in rows: off[norm(f"{r['first']} {r['last']}")].append(r)
for e in ent:
    if e['name']: mem[norm(e['name'])].append(e)
both = set(off) & set(mem)
unique = [k for k in both if len(off[k]) == 1 and len(mem[k]) == 1]
print('official names', len(off), '| memorial names', len(mem), '| identical after normalising', len(both), '| unique on both sides', len(unique))
print('official people with no identical memorial name:', sum(len(v) for k, v in off.items() if k not in mem))
print('memorial entries with no identical official name:', sum(len(v) for k, v in mem.items() if k not in off))
json.dump([{'key': k, 'row': off[k][0]['row'], 'memorialId': mem[k][0]['id']} for k in sorted(unique)], open(sys.argv[3], 'w'), ensure_ascii=False)
