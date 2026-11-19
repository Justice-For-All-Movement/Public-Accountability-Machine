# Reads the preserved official spreadsheet into JSON rows. National-ID fragments are NOT written out.
import sys, json, xlrd
sh = xlrd.open_workbook(sys.argv[1]).sheet_by_index(0)
head = [str(sh.cell_value(0, c)).strip() for c in range(sh.ncols)]
assert head == ['نام', 'نام خانوادگی', 'نام پدر', 'شش رقم آخر کد ملی'], head
rows = []
for r in range(1, sh.nrows):
    first, last, father = (str(sh.cell_value(r, c)).strip() for c in range(3))
    idcell = str(sh.cell_value(r, 3)).strip()
    rows.append({'row': r + 1, 'first': first, 'last': last, 'father': father, 'hasId': idcell not in ('', '0', '0.0')})
json.dump(rows, open(sys.argv[2], 'w'), ensure_ascii=False)
print(len(rows), 'rows;', sum(1 for x in rows if not x['first'] or not x['last']), 'with an empty name part;', sum(1 for x in rows if not x['hasId']), 'without an ID fragment')
