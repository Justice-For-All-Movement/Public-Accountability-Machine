import sys, xlrd
book = xlrd.open_workbook(sys.argv[1])
for sh in book.sheets():
    print('sheet', repr(sh.name), sh.nrows, 'rows x', sh.ncols, 'cols')
    for r in range(min(6, sh.nrows)):
        row = [str(sh.cell_value(r, c)) for c in range(sh.ncols)]
        # national-id-like cells are masked in this preview
        print(r, [('<id>' if any(ch.isdigit() for ch in v) and len(v.replace('.0','')) >= 5 else v) for v in row])
    print('last row:', sh.nrows - 1, [('<id>' if any(ch.isdigit() for ch in str(sh.cell_value(sh.nrows-1, c))) and len(str(sh.cell_value(sh.nrows-1, c))) >= 5 else str(sh.cell_value(sh.nrows-1, c))) for c in range(sh.ncols)])
