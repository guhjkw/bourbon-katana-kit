// tests/verify.js: node tests for the Katana Move Kit (src/katanaKit.js) and its file reader (src/tablekit.js).
// They load the same files the page loads. Run: node tests/verify.js
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const TK = require('../src/tablekit');
const K = require('../src/katanaKit');

let pass = 0, fail = 0;
const check = (name, ok, detail) => { if (ok) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : '')); } };
const section = (t) => console.log('\n' + t);
const sample = (f) => TK.toTable(TK.parseCsv(fs.readFileSync(path.join(__dirname, '..', 'samples', f), 'utf8')));
const AS_OF = '2026-10-27';

(async () => {
  const tables = { items: sample('sos-items-SAMPLE.csv'), bom: sample('sos-assemblies-SAMPLE.csv'), orders: sample('wholesale-orders-SAMPLE.csv') };

  section('1. Reading the exports');
  const data = K.prepare(tables);
  check('27 SOS items, 36 recipe lines, 17 order lines', data.items.length === 27 && data.bom.length === 36 && data.orders.length === 17, [data.items.length, data.bom.length, data.orders.length]);
  const im = data.columns.items.map, om = data.columns.orders.map;
  check('SOS columns found by name', im.sku === 'SKU' && im.name === 'Name' && im.cost === 'Purchase Cost' && im.price === 'Sales Price' && im.reorder === 'Reorder Point' && im.onHand === 'On Hand' && im.active === 'Archived', im);
  check('order columns found by name', om.order === 'Order Number' && om.shipBy === 'Ship By' && om.price === 'Wholesale Price' && om.qty === 'Quantity' && om.source === 'Channel', om);
  check('US order dates read month first', data.orders[0].shipBy === '2026-10-24' && data.orders[0].date === '2026-10-15');
  check('a trailing space in a code is kept for the report', data.items.find((x) => x.name.startsWith('Laundry')).rawSku === 'LD-32 ');
  check('"Archived: Yes" means archived', data.items.find((x) => x.sku === 'HV-8OZ').archived && !data.items.find((x) => x.sku === 'SB-8OZ').archived);
  check('shipped orders are not open', data.orders.filter((l) => !l.open).length === 1);
  const xt = TK.toTable(await TK.readFile(fs.readFileSync(path.join(__dirname, 'fixtures', 'sos-items-SAMPLE.xlsx')), 'items.xlsx'));
  const xdata = K.prepare({ items: xt, bom: tables.bom, orders: tables.orders });
  check('real Excel SOS export: title row skipped, same 27 items, numbers read', xdata.items.length === 27 && xdata.items[0].price === 16 && xdata.items.find((x) => x.sku === 'WAX-SOY').onHand === 120, xt.headers);
  check('...and the same findings as the CSV', K.audit(xdata).fix === 9);

  section('2. Product codes');
  const a = K.audit(data);
  const has = (code, re) => a.issues.some((x) => x.code === code && re.test(x.detail));
  check('9 to fix before importing, 1 warning', a.fix === 9 && a.warn === 1, a.counts);
  check('same code on two items: LBL-FRONT', has('dup_sku', /LBL-FRONT: Front Label \/ Front Label \(2025 design\)/));
  check('capitals clash: WAX-SOY vs wax-soy', has('case_clash', /WAX-SOY vs wax-soy/));
  check('no code: Shipping Box Large', has('no_sku', /Shipping Box Large/));
  check('trailing space: "LD-32 "', has('messy_sku', /"LD-32 "/));
  check('orders spell SB-1OIL as SB-1Oil', has('order_case', /SOS SB-1OIL, orders SB-1Oil/));
  check('typo SB-80Z suggests SB-8OZ', has('order_unknown', /SB-80Z.*Closest: SB-8OZ/));
  check('room spray has no recipe', has('no_recipe', /RS-4/));
  check('recipe names an unknown oil (FO-VAN)', has('recipe_unknown', /FO-VAN/));
  check('archived Holiday Vanilla still ordered', has('archived_ordered', /HV-8OZ/));
  check('material with no cost: Laundry Booster Base', has('no_cost', /BASE-LD/));
  check('a recipe can name a component by its name ("Amber Jar 8 oz")', a.recipes['BL-8OZ'].some((r) => r.item.sku === 'JAR-8'));

  section('3. Katana files');
  check('10 products, 15 materials (one without a code), 2 left out (service, archived duplicate)', a.products.length === 10 && a.materials.length === 15 && a.skipped.map((x) => x.sku).sort().join() === 'SHIP-FEE,wax-soy');
  check('Katana uses the spelling Faire sends: SB-1Oil', a.products.some((x) => x.katanaSku === 'SB-1Oil') && a.renames.length === 1 && a.renames[0].from === 'SB-1OIL');
  const files = K.katanaFiles(data, a);
  check('products file: 10 rows with Katana’s column names', files.products.rows.length === 10 && files.products.headers[1] === 'Variant code / SKU' && files.products.headers[4] === 'Make?');
  check('items with a recipe are Make?=Yes, Buy?=No', (() => { const r = files.products.rows.find((x) => x[1] === 'SB-8OZ'); return r[4] === 'Yes' && r[5] === 'No' && r[6] === 16; })());
  check('materials file leaves out the item with no code (14 rows)', files.materials.rows.length === 14 && !files.materials.rows.some((r) => r[0] === 'Shipping Box Large'));
  check('recipes file: 35 lines, one per ingredient, on Katana codes', files.recipes.rows.length === 35 && files.recipes.rows.filter((r) => r[0] === 'SB-1Oil').length === 3 && files.recipes.rows.some((r) => r[0] === 'BL-8OZ' && r[1] === 'JAR-8' && r[2] === 1));
  check('the SOS code is kept in Additional info when the code changes', files.products.rows.find((x) => x[1] === 'SB-1Oil')[8].includes('SOS code: SB-1OIL'));
  const clean = K.audit(K.prepare(tables, null, { codes: 'clean' }));
  check('"clean capitals" mode keeps SB-1OIL and lists the Faire listing to change', clean.products.some((x) => x.katanaSku === 'SB-1OIL') && clean.listingChanges.length === 1 && clean.listingChanges[0].from === 'SB-1Oil' && clean.listingChanges[0].to === 'SB-1OIL');
  const xbytes = TK.xlsxBytes([{ name: 'Products', headers: files.products.headers, rows: files.products.rows }]);
  const tmp = path.join(require('os').tmpdir(), 'katana-check-' + process.pid + '.xlsx'); fs.writeFileSync(tmp, xbytes);
  const py = execFileSync('python3', ['-W', 'ignore', '-c', 'import sys,openpyxl; ws=openpyxl.load_workbook(sys.argv[1]).active; print(ws.max_row, ws["B1"].value, ws["B2"].value, ws["G2"].value)', tmp]).toString().trim();
  fs.unlinkSync(tmp);
  check('the products .xlsx opens in Excel (openpyxl)', py === '11 Variant code / SKU SB-8OZ 16', py);

  section('4. Filling Katana’s own template');
  const tpl = TK.toTable(await TK.readFile(fs.readFileSync(path.join(__dirname, 'fixtures', 'katana-products-TEMPLATE.xlsx')), 'tpl.xlsx'));
  check('blank template read: header row only', tpl.headers.length === 9 && tpl.records.length === 0, tpl.headers);
  const filled = K.fillTemplate('products', tpl.headers, data, a);
  check('filled in the template’s own order', filled.headers[0] === 'Variant code / SKU' && filled.rows[0][0] === 'SB-8OZ' && filled.rows[0][1] === 'Sweet Bourbon 8 oz Candle', filled.rows[0]);
  check('a template column we have no data for stays blank (Registered barcode)', filled.rows.every((r) => r[7] === ''));
  check('nothing is listed as unplaced when every field with data has a column', filled.unplaced.length === 0, filled.unplaced);
  const noCat = K.fillTemplate('products', tpl.headers.filter((h) => h !== 'Category'), data, a);
  check('a field the template has no column for is listed, not lost (Category)', JSON.stringify(noCat.unplaced) === '["category"]', noCat.unplaced);

  section('5. Order desk (as of 27 Oct 2026)');
  const desk = K.orderDesk(data, a, AS_OF);
  check('7 open orders, 16 lines, 228 units, $2,610, 5 retailers', desk.summary.orders === 7 && desk.summary.lines === 16 && desk.summary.units === 228 && Math.round(desk.summary.value) === 2610 && desk.summary.retailers === 5, desk.summary);
  check('9 lines need attention', desk.exceptions.length === 9, desk.counts);
  const flags = (order, sku) => desk.lines.filter((l) => l.order === order && l.sku === sku).map((l) => l.flags.map((f) => f.code).join('+'));
  check('Oak & Ember order is past its ship-by date', flags('F-10021', 'SB-8OZ')[0] === 'late');
  check('price $14 on MarketTime vs $16 in SOS', flags('MT-5530', 'SB-8OZ')[0] === 'price' && desk.lines.find((l) => l.order === 'MT-5530' && l.sku === 'SB-8OZ').flags[0].text === '$14.00 here, $16.00 in SOS');
  check('typo line is unknown with a suggestion, and due this week', flags('F-10041', 'SB-80Z')[0] === 'unknown+soon');
  check('no ship-by date, and the same item twice in one order', JSON.stringify(flags('F-10052', 'SB-1Oil')) === '["case+no_ship","case+no_ship+dup"]', flags('F-10052', 'SB-1Oil'));
  check('zero quantity flagged', flags('F-10060', 'MOP-16')[0] === 'qty');
  check('differently spelled codes still map to the Katana item', desk.lines.filter((l) => l.sku === 'SB-1Oil').every((l) => l.katanaSku === 'SB-1Oil' && l.item.sku === 'SB-1OIL'));

  section('6. Make plan (next 14 days, topping up to reorder points)');
  const plan = K.makePlan(data, a, AS_OF);
  const mk = (s) => (plan.make.find((m) => m.item.katanaSku === s) || {}).qty;
  check('wax line makes 152 units, misc 46, mop 20, laundry 18', plan.lines.map((L) => L.line + ':' + L.units).join() === 'Wax:152,Misc:46,Mop:20,Laundry:18', plan.lines.map((L) => L.line + ':' + L.units));
  check('Sweet Bourbon 8 oz: 36 ordered + 24 reorder point - 18 on hand = 42', mk('SB-8OZ') === 42);
  check('orders past the 14 days (20 Nov) wait; zero-quantity and unknown lines are ignored', mk('BL-8OZ') === 8 && plan.make.find((m) => m.item.sku === 'BL-8OZ').demand === 24);
  check('room spray shows as "no recipe yet" on the make list', plan.make.find((m) => m.item.sku === 'RS-4').noRecipe === true);
  const buy = (s) => plan.materials.find((m) => m.item.katanaSku === s);
  check('Sweet Bourbon oil: 120.2 oz needed, 104.2 oz to buy', Math.abs(buy('FO-SB').needed - 120.2) < 1e-9 && Math.abs(buy('FO-SB').toBuy - 104.2) < 1e-9);
  check('enough soy wax, jars and wicks: nothing to buy', buy('WAX-SOY').toBuy === 0 && buy('JAR-8').toBuy === 0 && buy('WICK-8').toBuy === 0);
  check('materials spend $572.30, one material has no cost', plan.spend.toFixed(2) === '572.30' && plan.missingCost === 1);
  const noTop = K.makePlan(data, a, AS_OF, { topUp: false });
  check('without topping up, only the orders: 36 - 18 = 18 candles', (noTop.make.find((m) => m.item.sku === 'SB-8OZ') || {}).qty === 18);
  const wide = K.makePlan(data, a, AS_OF, { horizonDays: 30 });
  check('a 30-day window takes in the 20 Nov order', wide.make.find((m) => m.item.sku === 'BL-8OZ').demand === 36);

  section('7. Cutover plan');
  const cut = K.cutoverPlan(data, a, null, AS_OF);
  check('go-live on the Monday four weeks out: 30 Nov', cut.goLive === '2026-11-30');
  check('steps skip weekends and Thanksgiving', cut.steps.map((s) => s.date).join() === '2026-11-06,2026-11-11,2026-11-12,2026-11-17,2026-11-19,2026-11-20,2026-11-23,2026-11-27,2026-11-30,2026-12-07', cut.steps.map((s) => s.date));
  check('first step names the 9 fixes and the rename', /Fix the 9 code problems/.test(cut.steps[0].what) && /1 item changes spelling/.test(cut.steps[0].what), cut.steps[0].what);
  check('a go-live too close to today is flagged', K.cutoverPlan(data, a, '2026-11-02', AS_OF).tooSoon === true);

  section('8. Bad rows are reported, not fatal');
  const bad = K.prepare({ bom: TK.toTable(TK.parseCsv('Assembly,Component,Quantity\nSB-8OZ,WAX-SOY,abc\nSB-8OZ,,1\n')), orders: TK.toTable(TK.parseCsv('Order Number,SKU,Quantity\nF-1,,2\n')) });
  check('unreadable quantity, missing component and missing order code reported', bad.problems.length === 3 && bad.bom.length === 0 && bad.orders.length === 0, bad.problems);
  check('downloads have one row per finding', K.issuesRows(a).length === a.issues.length && K.orderRows(desk).length === 16 && K.planRows(plan).length === plan.make.length && K.buyRows(plan).length === plan.materials.length);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
