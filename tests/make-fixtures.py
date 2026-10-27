# tests/make-fixtures.py: real Excel files for the tests, written with openpyxl (compressed, shared strings):
#   fixtures/sos-items-SAMPLE.xlsx      the invented SOS item list, with a title row like many exports have
#   fixtures/katana-products-TEMPLATE.xlsx  a stand-in for Katana's blank products template: Katana's column names,
#                                       in a different order, plus a column we have no data for
import csv, os
from openpyxl import Workbook
here = os.path.dirname(os.path.abspath(__file__))
rows = list(csv.reader(open(os.path.join(here, '..', 'samples', 'sos-items-SAMPLE.csv'), encoding='utf-8')))
wb = Workbook(); ws = wb.active; ws.title = 'Items'
ws.append(['SOS Inventory: Items (SAMPLE, invented)'])
ws.append(rows[0])
for r in rows[1:]:
    out = []
    for i, v in enumerate(r):
        if i in (5, 6) and v: out.append(float(v))
        elif i in (7, 8) and v: out.append(int(v))
        else: out.append(v)
    ws.append(out)
wb.save(os.path.join(here, 'fixtures', 'sos-items-SAMPLE.xlsx'))
wb = Workbook(); ws = wb.active; ws.title = 'Products'
ws.append(['Variant code / SKU', 'Product name', 'Category', 'Default sales price', 'Unit of measure', 'Make?', 'Buy?', 'Registered barcode', 'Additional info'])
wb.save(os.path.join(here, 'fixtures', 'katana-products-TEMPLATE.xlsx'))
print('wrote fixtures')
