# Parses captured shohadayeghiam.info list pages into entries; each keeps the exact text of its card for quoting.
import re, sys, json, html
index = json.load(open(sys.argv[1] + '/index.json'))
out, seen = [], set()
for page in index:
    t = open(page['file'], encoding='utf-8', errors='replace').read()
    t = re.sub(r'<(script|style)[^>]*>.*?</\1>', '', t, flags=re.S)
    for href, inner in re.findall(r'<a[^>]+href=["\']?(?:https://shohadayeghiam\.info)?/(\d+)["\'\s>][^>]*>(.*?)</a>', t, flags=re.S):
        parts = [html.unescape(re.sub(r'\s+', ' ', p)).strip() for p in re.split(r'<[^>]+>', inner)]
        parts = [p for p in parts if p]
        if len(parts) < 3 or href in seen: continue
        seen.add(href)
        date = next((p for p in parts if re.search(r'۱۴۰[۴۵]', p)), None)
        num = next((p for p in parts if re.fullmatch(r'[۰-۹]+', p)), None)
        place = next((p for p in parts if ' - ' in p or '،' in p), None)
        name = next((p for p in parts if p not in (date, num, place) and len(p) < 60 and not re.search(r'[۰-۹]', p)), None)
        out.append({'id': href, 'url': f'https://shohadayeghiam.info/{href}', 'name': name, 'date': date, 'number': num, 'place': place, 'card': ' | '.join(parts), 'evidenceRef': page['evidenceRef']})
json.dump(out, open(sys.argv[1] + '/entries.json', 'w'), ensure_ascii=False)
print(len(out), 'entries;', sum(1 for e in out if not e['name']), 'without a parsed name;', sum(1 for e in out if e['date'] and '۱۴۰۵' in e['date']), 'dated 1405;', sum(1 for e in out if e['date'] and 'دی ۱۴۰۴' in e['date']), 'dated Dey 1404')
for e in out[-3:]: print(e['id'], e['name'], '|', e['date'], '|', e['place'], '|', e['number'])
