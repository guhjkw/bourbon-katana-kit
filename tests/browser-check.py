# tests/browser-check.py: drives the real page in Chromium the way Rusty would use it.
# Run: python3 tests/browser-check.py   (serves the folder on a local port, prints PASS/FAIL lines and a count)
import http.server, os, socketserver, subprocess, sys, tempfile, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'tests', 'screenshots'); os.makedirs(SHOTS, exist_ok=True)
SAMPLES = os.path.join(ROOT, 'samples'); FIX = os.path.join(ROOT, 'tests', 'fixtures')
results = []
def check(name, ok, detail=''):
    results.append(ok); print(('  PASS ' if ok else '  FAIL ') + name + ('' if ok else ' -> ' + str(detail)))
def xl(path, expr):
    return subprocess.run([sys.executable, '-W', 'ignore', '-c', 'import openpyxl,sys; wb=openpyxl.load_workbook(sys.argv[1]); ws=wb.active; print(' + expr + ')', path], capture_output=True, text=True).stdout.strip()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
httpd = socketserver.TCPServer(('127.0.0.1', 0), Quiet); port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto('http://127.0.0.1:%d/index.html' % port)
    text = lambda sel: page.locator(sel).inner_text()
    tab = lambda name: page.click('.tabs [data-tab=%s]' % name)
    def drop(kind, path):
        # set the file, then wait until the box shows its name: reading a file is asynchronous
        page.set_input_files('input[data-kind=%s]' % kind, path)
        page.wait_for_function('n => document.querySelector("#slots").innerText.includes(n)', arg=os.path.basename(path))
    def save(selector, name):
        with page.expect_download() as d: page.click(selector)
        path = os.path.join(tempfile.gettempdir(), name); d.value.save_as(path); return path

    print('\n1. First visit')
    check('four boxes, results hidden', page.locator('.slot').count() == 4 and page.locator('#results').is_hidden())

    print('\n2. Sample files: product codes')
    page.click('#sample')
    check('results and sample banner shown', page.locator('#results').is_visible() and page.locator('#samplebanner').is_visible())
    tiles = text('#codes .tiles')
    check('9 to fix, 1 to check, 10 / 15 products / materials, 35 usable recipe lines', tiles.startswith('9') and '10 / 15' in tiles and '35' in tiles, tiles.replace('\n', ' | '))
    check('10 problems listed', page.locator('#codes tbody tr').count() == 10)
    check('SB-1OIL becomes SB-1Oil to match Faire', 'SB-1OIL becomes SB-1Oil' in text('#codes .note'))
    page.click('[data-codes=clean]')
    check('"Clean capitals" lists the Faire listing to change instead', 'SB-1Oil to SB-1OIL' in text('#codes .note'), text('#codes .note'))
    page.click('[data-codes=orders]')
    page.screenshot(path=os.path.join(SHOTS, 'codes-desktop.png'), full_page=True)

    print('\n3. Katana files')
    tab('files')
    cards = text('#files .cards')
    check('materials 14 rows, products 10, recipes 35', '14 rows' in cards and '10 rows' in cards and '35 rows' in cards, cards)
    check('preview shows the first product', 'Sweet Bourbon 8 oz Candle' in text('#files table'))
    path = save('[data-dl=k-products-xlsx]', 'kk-products.xlsx')
    check('products .xlsx opens in Excel with Katana’s columns', xl(path, 'ws.max_row, ws["B1"].value, ws["E2"].value') == '11 Variant code / SKU Yes', xl(path, 'ws.max_row, ws["B1"].value, ws["E2"].value'))
    drop('templates', os.path.join(FIX, 'katana-products-TEMPLATE.xlsx'))
    check('a dropped Katana template is recognised as the products template', 'products: katana-products-TEMPLATE.xlsx' in text('#slots'))
    tab('files')
    check('...and the products file is filled into it', 'filled into your template' in text('#files .cards'))
    path = save('[data-dl=k-products-xlsx]', 'kk-products-tpl.xlsx')
    check('the download uses the template’s own column order', xl(path, 'ws["A1"].value, "|", ws["A2"].value, "|", ws["H1"].value') == 'Variant code / SKU | SB-8OZ | Registered barcode', xl(path, 'ws["A1"].value, "|", ws["A2"].value, "|", ws["H1"].value'))
    tab('downloads')
    path = save('[data-dl=k-all-xlsx]', 'kk-all.xlsx')
    check('one workbook with all three sheets', xl(path, 'wb.sheetnames') == "['materials', 'products', 'recipes']", xl(path, 'wb.sheetnames'))

    print('\n4. Order desk')
    tab('desk')
    t = text('#desk .tiles')
    check('9 lines need attention, 7 open orders, $2,610.00', t.startswith('9') and '7' in t and '$2,610.00' in t, t)
    page.click('#desk [data-desk=price]')
    check('"Price differs" shows the MarketTime line', page.locator('#desk tbody tr').count() == 1 and '$14.00 here, $16.00 in SOS' in text('#desk tbody'))
    page.click('#desk [data-desk=unknown]')
    check('unknown code shows the closest real one', 'closest: SB-8OZ' in text('#desk tbody'))

    print('\n5. Make plan')
    tab('plan')
    plan = text('#plan')
    check('Wax 152 units, about $572.30 of materials', 'Wax: 152 units' in plan and '$572.30' in plan, plan[:300])
    check('room spray marked "no recipe yet"', 'no recipe yet' in plan)
    page.screenshot(path=os.path.join(SHOTS, 'plan-desktop.png'), full_page=True)
    page.click('[data-horizon="30"]')
    row = page.locator('#plan tr', has_text='BL-8OZ').first.inner_text()
    check('a 30-day window takes in the 20 Nov order (BL-8OZ ordered 36)', '36' in row.split('\t')[2] if '\t' in row else ' 36' in row, row)
    page.click('[data-horizon="14"]')
    before = text('#plan')
    page.click('#topup')
    check('without topping up, the plan changes', text('#plan') != before)
    page.click('#topup')

    print('\n6. Cutover plan')
    tab('cutover')
    check('go-live 30 Nov, first step 6 Nov', page.input_value('#golive') == '2026-11-30' and 'Fri, Nov 6' in text('#cutover'), text('#cutover')[:200])
    page.fill('#golive', '2026-11-02'); page.dispatch_event('#golive', 'change')
    check('a go-live too soon is called out', 'too little time' in text('#cutover'))

    print('\n7. Real files dropped in (Excel SOS list, CSV recipes and orders)')
    page.click('#clear')
    check('clear hides the results', page.locator('#results').is_hidden())
    drop('items', os.path.join(FIX, 'sos-items-SAMPLE.xlsx'))
    page.wait_for_selector('#results:not(.hidden)')
    drop('bom', os.path.join(SAMPLES, 'sos-assemblies-SAMPLE.csv'))
    drop('orders', os.path.join(SAMPLES, 'wholesale-orders-SAMPLE.csv'))
    page.fill('#asof', '2026-10-27'); page.dispatch_event('#asof', 'change')
    tab('codes')
    check('Excel SOS list read (27 rows) with the same 9 fixes', 'sos-items-SAMPLE.xlsx: 27 rows' in text('#slots') and text('#codes .tiles').startswith('9'), text('#codes .tiles'))
    check('no sample banner for real files', page.locator('#samplebanner').is_hidden())

    print('\n8. Changing a column changes the result')
    before = text('#codes .tiles')
    page.click('.slot[data-kind=items] summary')
    page.select_option('select[data-kind=items][data-field=price]', '')
    check('with no price column, the ordered products show as missing a price', text('#codes .tiles') != before and 'Product with no sales price' in text('#codes'), text('#codes .tiles'))
    page.select_option('select[data-kind=items][data-field=price]', 'Sales Price')
    check('putting it back restores the result', text('#codes .tiles') == before)

    print('\n9. Wrong files are refused with a reason')
    drop('items', os.path.join(SAMPLES, 'wholesale-orders-SAMPLE.csv'))
    check('orders dropped in the SOS box: "looks like an orders export", results hidden', 'This looks like an orders export, not an SOS item list. Drop it in the Wholesale orders box.' in text('#slots') and page.locator('#results').is_hidden(), text('#slots')[:400])
    tmp = tempfile.NamedTemporaryFile(suffix='.pdf', delete=False); tmp.write(b'%PDF-1.7 report'); tmp.close()
    drop('bom', tmp.name)
    check('a PDF is refused and says what to do', 'Export the report as Excel or CSV' in text('#slots'))
    drop('items', os.path.join(FIX, 'sos-items-SAMPLE.xlsx'))
    drop('bom', os.path.join(SAMPLES, 'sos-assemblies-SAMPLE.csv'))
    page.fill('#asof', '2026-10-27'); page.dispatch_event('#asof', 'change')

    print('\n10. Downloads')
    tab('downloads')
    path = save('[data-dl=plan-xlsx]', 'kk-plan.xlsx')
    check('make plan workbook: Make and Buy sheets', xl(path, 'wb.sheetnames, wb["Make"].max_row, wb["Buy"]["E1"].value') == "['Make', 'Buy'] 10 To buy", xl(path, 'wb.sheetnames, wb["Make"].max_row, wb["Buy"]["E1"].value'))
    path = save('[data-dl=fix-csv]', 'kk-fix.csv')
    check('code fix list CSV: header plus 10 problems', open(path, encoding='utf-8-sig').read().count('\n') == 11)

    print('\n11. Phone width')
    page.set_viewport_size({'width': 390, 'height': 844})
    tab('desk')
    check('no sideways scrolling on a phone', page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    page.screenshot(path=os.path.join(SHOTS, 'desk-phone.png'), full_page=False)

    check('no console or page errors', not errors, errors)
    b.close()
httpd.shutdown()
print('\n%d passed, %d failed' % (results.count(True), results.count(False)))
sys.exit(0 if all(results) else 1)
