// src/katanaKit.js: the Katana Move Kit for Bourbon Royalty. Takes the exports Rusty already has (the SOS Inventory
// item list, the SOS assembly recipes, and Faire / MarketTime orders) and works out everything the move to Katana needs:
//   - product-code health: duplicates, codes that differ only in capitals or spaces (SB-1OIL in SOS, SB-1Oil on Faire),
//     blanks, typos with the closest real code, items missing a cost or a price, assemblies with no recipe
//   - Katana import files: products, materials and recipes, using the codes Faire and MarketTime send (or clean
//     capitals), and able to fill Katana's own blank templates column by column
//   - the order desk: every open order line checked before production (unknown code, price differs from SOS,
//     archived item, late or due this week, duplicate line)
//   - the make plan: what each line (wax, laundry, misc, mop) needs to make, and the materials to buy, with cost
//   - a dated cutover plan
// The page and the tests load this same file. It needs TableKit (src/tablekit.js) for reading values.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./tablekit'));
  else root.KatanaKit = factory(root.TableKit);
})(typeof self !== 'undefined' ? self : this, function (TK) {
  'use strict';

  const SPECS = {
    items: {
      sku: { label: 'SKU', required: true, synonyms: ['sku', 'item sku', 'part number', 'item code', 'code', 'product code', 'variant code'] },
      name: { label: 'Item name', required: true, synonyms: ['name', 'item name', 'item', 'product name', 'title'], avoid: ['vendor', 'category', 'customer'] },
      description: { label: 'Description', synonyms: ['description', 'sales description', 'purchase description', 'notes'] },
      type: { label: 'Type', synonyms: ['type', 'item type', 'kind'] },
      category: { label: 'Category', synonyms: ['category', 'item category', 'class', 'product line', 'line', 'group'] },
      cost: { label: 'Purchase cost', synonyms: ['purchase cost', 'cost', 'unit cost', 'average cost', 'default cost', 'cost each'], avoid: ['sales', 'price', 'total'] },
      price: { label: 'Sales price', synonyms: ['sales price', 'price', 'wholesale price', 'selling price', 'unit price', 'default price'], avoid: ['cost', 'purchase', 'total'] },
      reorder: { label: 'Reorder point', synonyms: ['reorder point', 'reorder level', 'min stock', 'minimum stock', 'safety stock', 'reorder'] },
      onHand: { label: 'On hand', synonyms: ['on hand', 'quantity on hand', 'qty on hand', 'in stock', 'available', 'stock', 'quantity'] },
      uom: { label: 'Unit of measure', synonyms: ['unit of measure', 'uom', 'unit', 'base unit', 'units', 'base uom'] },
      vendor: { label: 'Vendor', synonyms: ['vendor', 'preferred vendor', 'supplier', 'default supplier'] },
      active: { label: 'Archived / inactive', synonyms: ['archived', 'inactive', 'active', 'status', 'is archived'] }
    },
    bom: {
      parent: { label: 'Assembly (what is made)', required: true, synonyms: ['assembly', 'assembly sku', 'assembly name', 'parent', 'parent sku', 'parent item', 'finished good', 'product', 'item'] },
      component: { label: 'Component (what goes in)', required: true, synonyms: ['component', 'component sku', 'component name', 'ingredient', 'material', 'part', 'child', 'raw material', 'component item'] },
      qty: { label: 'Quantity per', required: true, synonyms: ['quantity', 'qty', 'quantity per', 'qty per', 'component quantity', 'amount', 'amount per'] },
      uom: { label: 'Unit', synonyms: ['unit of measure', 'uom', 'unit'] }
    },
    orders: {
      order: { label: 'Order number', required: true, synonyms: ['order number', 'order id', 'order', 'order no', 'po number', 'po', 'purchase order', 'reference'] },
      date: { label: 'Order date', synonyms: ['order date', 'date', 'placed', 'created', 'date placed'], avoid: ['ship', 'deliver'] },
      retailer: { label: 'Retailer', synonyms: ['retailer', 'retailer name', 'customer', 'store', 'buyer', 'ship to name', 'company', 'account'] },
      shipBy: { label: 'Ship by', synonyms: ['ship by', 'ship by date', 'ship date', 'requested ship date', 'must ship by', 'expected ship date', 'ship window', 'ship on'] },
      sku: { label: 'SKU', required: true, synonyms: ['sku', 'item sku', 'product sku', 'variant sku', 'style number', 'item code', 'product code'] },
      product: { label: 'Product', synonyms: ['product name', 'product', 'item name', 'item', 'description', 'title'] },
      qty: { label: 'Quantity', required: true, synonyms: ['quantity', 'qty', 'units', 'quantity ordered', 'ordered quantity', 'ordered'] },
      price: { label: 'Wholesale price', synonyms: ['wholesale price', 'unit price', 'price', 'item price', 'price each'], avoid: ['total', 'retail', 'msrp'] },
      status: { label: 'Status', synonyms: ['status', 'order status', 'state', 'fulfillment status'] },
      source: { label: 'Channel', synonyms: ['source', 'channel', 'marketplace', 'platform', 'sales channel'] }
    }
  };
  // Katana's import templates name their columns like this (support.katanamrp.com, Products and Materials articles,
  // read 27 Oct 2026). Dropping in Katana's own blank template overrides these names (fillTemplate).
  const KATANA_HEADERS = {
    products: ['Product name', 'Variant code / SKU', 'Category', 'Unit of measure', 'Make?', 'Buy?', 'Default sales price', 'Default purchase price', 'Additional info'],
    materials: ['Material name', 'Variant code / SKU', 'Category', 'Unit of measure', 'Default supplier', 'Default purchase price', 'Purchase UoM', 'Conversion rate', 'Additional info'],
    recipes: ['Product variant code / SKU', 'Ingredient variant code / SKU', 'Quantity', 'Notes']
  };
  const TEMPLATE_FIELDS = {
    products: { name: ['product name', 'name'], sku: ['variant code sku', 'variant code', 'sku'], category: ['category'], uom: ['unit of measure', 'uom'], make: ['make'], buy: ['buy'], salesPrice: ['default sales price', 'sales price'], purchasePrice: ['default purchase price', 'purchase price'], supplier: ['default supplier', 'supplier'], info: ['additional info', 'notes'] },
    materials: { name: ['material name', 'name'], sku: ['variant code sku', 'variant code', 'sku'], category: ['category'], uom: ['unit of measure', 'uom'], supplier: ['default supplier', 'supplier'], purchasePrice: ['default purchase price', 'purchase price'], purchaseUom: ['purchase uom', 'purchase unit'], conversion: ['conversion rate'], info: ['additional info', 'notes'] },
    recipes: { product: ['product variant code sku', 'product variant code', 'product sku', 'product'], ingredient: ['ingredient variant code sku', 'ingredient variant code', 'ingredient sku', 'ingredient', 'material'], qty: ['quantity', 'qty'], notes: ['notes'] }
  };
  const HOLIDAYS = ['2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-07-05', '2027-09-06'];
  const DEFAULTS = { codes: 'orders', horizonDays: 14, topUp: true, tolerance: 0.01, currency: 'USD', holidays: HOLIDAYS };

  // ---------- helpers ----------
  const DAY = 86400000;
  const toDate = (s) => new Date(s + 'T00:00:00Z');
  const fmt = (d) => d.toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
  const low = (s) => String(s || '').trim().toLowerCase();
  // The comparison key: trim, spaces/underscores/slashes to one hyphen, capitals. " sb-1oil", "SB 1OIL" and "SB-1Oil" match.
  const keyOf = (raw) => String(raw == null ? '' : raw).trim().replace(/[\s_\/]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toUpperCase();
  function levenshtein(a, b) {
    const m = a.length, n = b.length, dp = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[m][n];
  }
  const money = (n) => n == null || !isFinite(n) ? '' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyText = (n) => n == null ? '' : (Math.round(n * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
  function isBusinessDay(d, H) { const wd = toDate(d).getUTCDay(); return wd !== 0 && wd !== 6 && !H.includes(d); }
  function addBusinessDays(d, n, H) { let t = toDate(d); const step = n < 0 ? -1 : 1; let left = Math.abs(n); while (left > 0) { t = new Date(t.getTime() + step * DAY); if (isBusinessDay(fmt(t), H)) left--; } return fmt(t); }
  function niceDate(s) { return s ? toDate(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; }

  // ---------- reading ----------
  function columns(kind, table, fixed) { return TK.mapColumns(table ? table.headers : [], SPECS[kind], fixed); }
  function prepare(tables, maps, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const problems = [], cols = {};
    const get = (rec, m, f) => (m[f] ? rec[m[f]] : '');
    ['items', 'bom', 'orders'].forEach((k) => { if (tables[k]) cols[k] = columns(k, tables[k], (maps || {})[k]); });

    const items = [];
    if (tables.items) {
      const m = cols.items.map;
      tables.items.records.forEach((r) => {
        const rawSku = String(get(r, m, 'sku') == null ? '' : get(r, m, 'sku')), name = String(get(r, m, 'name') || '').trim();
        if (!rawSku.trim() && !name) return;
        const act = low(get(r, m, 'active')), hdr = low(m.active);
        const archived = !!act && (/archiv|inactive/.test(hdr) ? /^(yes|y|true|1|x|archived|inactive)$/.test(act) : /^(no|n|false|0|inactive|archived|disabled)$/.test(act));
        items.push({
          rawSku, sku: rawSku.trim(), key: keyOf(rawSku), name, description: String(get(r, m, 'description') || '').trim(), type: String(get(r, m, 'type') || '').trim(),
          category: String(get(r, m, 'category') || '').trim(), cost: TK.parseNumber(get(r, m, 'cost')), price: TK.parseNumber(get(r, m, 'price')),
          reorder: TK.parseNumber(get(r, m, 'reorder')), onHand: TK.parseNumber(get(r, m, 'onHand')), uom: String(get(r, m, 'uom') || '').trim(),
          vendor: String(get(r, m, 'vendor') || '').trim(), archived, row: r._row
        });
      });
    }
    const bom = [];
    if (tables.bom) {
      const m = cols.bom.map;
      tables.bom.records.forEach((r) => {
        const parent = String(get(r, m, 'parent') || '').trim(), comp = String(get(r, m, 'component') || '').trim(), qty = TK.parseNumber(get(r, m, 'qty'));
        if (!parent && !comp) return;
        if (!parent || !comp) { problems.push({ file: 'recipes', row: r._row, text: 'needs both the assembly and the component' }); return; }
        if (qty == null || qty <= 0) { problems.push({ file: 'recipes', row: r._row, text: parent + ' / ' + comp + ': quantity "' + get(r, m, 'qty') + '" not readable' }); return; }
        bom.push({ parent, component: comp, qty, uom: String(get(r, m, 'uom') || '').trim(), row: r._row });
      });
    }
    const orders = [];
    if (tables.orders) {
      const m = cols.orders.map;
      const order = TK.dateOrder(tables.orders.records.map((r) => get(r, m, 'shipBy')).concat(tables.orders.records.map((r) => get(r, m, 'date'))), 'MDY');
      tables.orders.records.forEach((r) => {
        const num = String(get(r, m, 'order') || '').trim(), sku = String(get(r, m, 'sku') || ''), qty = TK.parseNumber(get(r, m, 'qty'));
        if (!num && !sku.trim()) return;
        if (!sku.trim()) { problems.push({ file: 'orders', row: r._row, text: 'order ' + num + ': no SKU on this line' }); return; }
        const sb = TK.parseDateTime(get(r, m, 'shipBy'), order), dt = TK.parseDateTime(get(r, m, 'date'), order);
        const status = low(get(r, m, 'status'));
        orders.push({
          order: num, date: dt ? dt.date : null, retailer: String(get(r, m, 'retailer') || '').trim(), shipBy: sb ? sb.date : null, rawShipBy: String(get(r, m, 'shipBy') || '').trim(),
          rawSku: sku, sku: sku.trim(), key: keyOf(sku), product: String(get(r, m, 'product') || '').trim(), qty, price: TK.parseNumber(get(r, m, 'price')),
          status, open: !/ship|deliver|fulfil|complete|cancel|closed|invoiced|refund/.test(status), source: String(get(r, m, 'source') || '').trim(), row: r._row
        });
      });
    }
    return { items, bom, orders, problems, columns: cols, opts: o };
  }

  // ---------- product-code health ----------
  const ISSUE = {
    dup_sku: { level: 'fix', title: 'Same code on two items', fix: 'Give each item its own code before importing' },
    case_clash: { level: 'fix', title: 'Codes differ only in capitals or spaces', fix: 'Pick one spelling; Katana treats them as different items' },
    no_sku: { level: 'fix', title: 'No code', fix: 'Add a code; Katana matches everything on it' },
    messy_sku: { level: 'fix', title: 'Spaces around the code', fix: 'Trim the spaces in SOS (the Katana files already do)' },
    order_case: { level: 'fix', title: 'Orders spell the code differently', fix: 'The Katana files use the orders’ spelling, so Syncware matches' },
    order_unknown: { level: 'fix', title: 'Ordered code not in SOS', fix: 'Fix the listing on Faire/MarketTime or add the item' },
    no_recipe: { level: 'fix', title: 'Assembly with no recipe', fix: 'Add its recipe, or Katana cannot make it' },
    recipe_unknown: { level: 'fix', title: 'Recipe uses an unknown item', fix: 'Fix the component code in the recipe' },
    archived_ordered: { level: 'fix', title: 'Archived item is still being ordered', fix: 'Reactivate it or take the listing down' },
    no_cost: { level: 'warn', title: 'Material with no cost', fix: 'Add a cost so Katana can cost each candle' },
    no_price: { level: 'warn', title: 'Product with no sales price', fix: 'Add the wholesale price' },
    no_uom: { level: 'warn', title: 'No unit of measure', fix: 'Katana needs one; the files use "pcs" until you set it' }
  };

  function audit(data) {
    const o = data.opts, issues = [];
    const add = (code, detail, extra) => issues.push(Object.assign({ code, level: ISSUE[code].level, title: ISSUE[code].title, fix: ISSUE[code].fix, detail }, extra || {}));
    const active = data.items.filter((x) => !x.archived);
    const byKey = {}; data.items.forEach((x) => { if (x.key) (byKey[x.key] = byKey[x.key] || []).push(x); });
    const byName = {}; data.items.forEach((x) => { byName[low(x.name)] = byName[low(x.name)] || x; });
    const find = (code) => { const k = keyOf(code); const list = byKey[k] || []; return list.find((x) => x.sku === String(code).trim()) || list[0] || byName[low(code)] || null; };

    data.items.forEach((x) => {
      if (!x.key) add('no_sku', x.name, { item: x });
      else if (x.rawSku !== x.rawSku.trim()) add('messy_sku', '"' + x.rawSku + '" (' + x.name + ')', { item: x });
    });
    Object.values(byKey).forEach((list) => {
      if (list.length < 2) return;
      const spellings = [...new Set(list.map((x) => x.sku))];
      if (spellings.length === 1) add('dup_sku', spellings[0] + ': ' + list.map((x) => x.name).join(' / '), { items: list });
      else add('case_clash', spellings.join(' vs ') + ': ' + list.map((x) => x.name).join(' / '), { items: list });
    });

    // recipes, resolved to items (a recipe may name items by code or by name)
    const recipes = {}, parentsWithRecipe = new Set();
    data.bom.forEach((b) => {
      const p = find(b.parent), c = find(b.component);
      if (!p) { add('recipe_unknown', 'assembly "' + b.parent + '" (recipe row ' + b.row + ')', { bom: b }); return; }
      if (!c) { add('recipe_unknown', p.name + ' uses "' + b.component + '" (recipe row ' + b.row + ')', { bom: b }); return; }
      (recipes[p.key] = recipes[p.key] || []).push({ item: c, qty: b.qty, uom: b.uom });
      parentsWithRecipe.add(p.key);
    });

    // order spellings: what Faire and MarketTime actually send for each item
    const orderSpelling = {}, unknown = {};
    data.orders.forEach((l) => {
      const exact = data.items.find((x) => x.sku === l.sku);
      const match = exact || (byKey[l.key] || [])[0];
      l.item = match || null;
      l.resolved = exact ? 'exact' : match ? 'case' : 'unknown';
      if (match) { const s = orderSpelling[match.key] = orderSpelling[match.key] || {}; s[l.sku] = (s[l.sku] || 0) + 1; }
      else {
        let best = null, bestD = 3;
        active.forEach((x) => { const d = levenshtein(l.key, x.key); if (d < bestD) { bestD = d; best = x; } });
        l.suggestion = best ? best.sku : null;
        (unknown[l.sku] = unknown[l.sku] || { sku: l.sku, lines: 0, units: 0, suggestion: l.suggestion, product: l.product }).lines++;
        unknown[l.sku].units += l.qty || 0;
      }
    });
    Object.entries(orderSpelling).forEach(([k, spellings]) => {
      const item = (byKey[k] || [])[0]; const other = Object.keys(spellings).filter((s) => s !== item.sku);
      if (other.length) add('order_case', 'SOS ' + item.sku + ', orders ' + other.join(', ') + ' (' + item.name + ')', { item, spellings: other });
    });
    Object.values(unknown).forEach((u) => add('order_unknown', u.sku + (u.product ? ' (' + u.product + ')' : '') + ': ' + u.lines + ' line' + (u.lines === 1 ? '' : 's') + (u.suggestion ? '. Closest: ' + u.suggestion : ''), { unknownSku: u.sku, suggestion: u.suggestion }));

    // what each item becomes in Katana
    const onOrders = new Set(data.orders.filter((l) => l.item).map((l) => l.item.key));
    const asComponent = new Set([].concat(...Object.values(recipes).map((rs) => rs.map((r) => r.item.key))));
    data.items.forEach((x) => {
      const t = low(x.type);
      const service = /service|non.?inventory|labou?r|shipping|fee|discount|other charge/.test(t);
      const assemblyType = /assembl|kit|manufactur|finished|bundle|build/.test(t);
      x.role = service ? 'skip' : (assemblyType || parentsWithRecipe.has(x.key) || onOrders.has(x.key) || (x.price > 0 && !asComponent.has(x.key))) ? 'product' : 'material';
      if (x.archived && !onOrders.has(x.key)) x.role = 'skip';
      x.makes = parentsWithRecipe.has(x.key);
      x.assemblyType = assemblyType;
    });
    data.items.filter((x) => x.role === 'product' && x.assemblyType && !x.makes).forEach((x) => add('no_recipe', x.sku + ' ' + x.name, { item: x }));
    data.items.filter((x) => x.archived && onOrders.has(x.key)).forEach((x) => add('archived_ordered', x.sku + ' ' + x.name, { item: x }));
    data.items.filter((x) => x.role === 'material' && !(x.cost > 0)).forEach((x) => add('no_cost', x.sku + ' ' + x.name, { item: x }));
    data.items.filter((x) => x.role === 'product' && onOrders.has(x.key) && !(x.price > 0)).forEach((x) => add('no_price', x.sku + ' ' + x.name, { item: x }));
    const noUom = data.items.filter((x) => x.role !== 'skip' && !x.uom);
    if (noUom.length && data.columns.items && data.columns.items.map.uom) noUom.forEach((x) => add('no_uom', x.sku + ' ' + x.name, { item: x }));

    // the code each item gets in Katana
    data.items.forEach((x) => {
      const spell = orderSpelling[x.key];
      const fromOrders = spell ? Object.entries(spell).sort((a, b) => b[1] - a[1])[0][0] : null;
      x.katanaSku = o.codes === 'clean' ? x.key : (fromOrders || x.sku);
    });
    const renames = data.items.filter((x) => x.role !== 'skip' && x.katanaSku && x.katanaSku !== x.sku).map((x) => ({ item: x, from: x.sku, to: x.katanaSku }));
    const listingChanges = o.codes === 'clean' ? [].concat(...Object.entries(orderSpelling).map(([k, sp]) => Object.keys(sp).filter((s) => s !== k).map((s) => ({ from: s, to: k })))) : [];

    const order = Object.keys(ISSUE);
    issues.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    const counts = {}; issues.forEach((x) => { counts[x.code] = (counts[x.code] || 0) + 1; });
    const fix = issues.filter((x) => x.level === 'fix').length;
    return { issues, counts, fix, warn: issues.length - fix, recipes, renames, listingChanges, find, byKey,
      products: data.items.filter((x) => x.role === 'product'), materials: data.items.filter((x) => x.role === 'material'), skipped: data.items.filter((x) => x.role === 'skip') };
  }

  // ---------- Katana files ----------
  function katanaRows(data, a) {
    const info = (x) => [x.description, x.type ? 'SOS type: ' + x.type : '', x.sku !== x.katanaSku ? 'SOS code: ' + x.sku : ''].filter(Boolean).join(' | ');
    // an item with no code stays out of the files (it is on the fix list): Katana matches everything on the code
    const products = a.products.filter((x) => x.key).map((x) => ({ name: x.name, sku: x.katanaSku, category: x.category, uom: x.uom || 'pcs', make: x.makes ? 'Yes' : 'No', buy: x.makes ? 'No' : 'Yes', salesPrice: x.price, purchasePrice: x.makes ? null : x.cost, supplier: x.makes ? '' : x.vendor, info: info(x) }));
    const materials = a.materials.filter((x) => x.key).map((x) => ({ name: x.name, sku: x.katanaSku, category: x.category, uom: x.uom || 'pcs', supplier: x.vendor, purchasePrice: x.cost, purchaseUom: x.uom || 'pcs', conversion: 1, info: info(x) }));
    const recipes = [];
    a.products.filter((x) => x.makes).forEach((p) => (a.recipes[p.key] || []).forEach((r) => recipes.push({ product: p.katanaSku, ingredient: r.item.katanaSku, qty: r.qty, notes: r.uom ? 'per ' + r.uom : '' })));
    return { products, materials, recipes };
  }
  const OWN = {
    products: (r) => [r.name, r.sku, r.category, r.uom, r.make, r.buy, r.salesPrice, r.purchasePrice, r.info],
    materials: (r) => [r.name, r.sku, r.category, r.uom, r.supplier, r.purchasePrice, r.purchaseUom, r.conversion, r.info],
    recipes: (r) => [r.product, r.ingredient, r.qty, r.notes]
  };
  function katanaFiles(data, a) {
    const rows = katanaRows(data, a), out = {};
    Object.keys(OWN).forEach((k) => { out[k] = { headers: KATANA_HEADERS[k], rows: rows[k].map(OWN[k]) }; });
    return out;
  }
  // Fills Katana's own blank template: its header names, in its order. Columns we have no data for stay blank;
  // fields with no matching column are listed so nothing is lost silently.
  function fillTemplate(kind, templateHeaders, data, a) {
    const spec = {}; Object.entries(TEMPLATE_FIELDS[kind]).forEach(([f, syn]) => { spec[f] = { label: syn[0], synonyms: syn }; });
    const { map } = TK.mapColumns(templateHeaders, spec);
    const rows = katanaRows(data, a)[kind];
    const byHeader = {}; Object.entries(map).forEach(([f, h]) => { if (h) byHeader[h] = f; });
    const unplaced = Object.keys(spec).filter((f) => !map[f] && rows.some((r) => r[f] != null && r[f] !== ''));
    return { headers: templateHeaders, rows: rows.map((r) => templateHeaders.map((h) => (byHeader[h] && r[byHeader[h]] != null ? r[byHeader[h]] : ''))), map, unplaced };
  }

  // ---------- order desk ----------
  const LINE = {
    unknown: 'Code not in SOS', case: 'Code spelled differently', archived: 'Archived item', price: 'Price differs from SOS', qty: 'Quantity not usable',
    no_ship: 'No ship-by date', late: 'Past its ship-by date', soon: 'Ships this week', dup: 'Same item twice in one order'
  };
  function orderDesk(data, a, asOf) {
    const today = asOf || fmt(new Date()), o = data.opts;
    const open = data.orders.filter((l) => l.open);
    const seen = {};
    const lines = open.map((l) => {
      const flags = [];
      if (l.resolved === 'unknown') flags.push({ code: 'unknown', text: LINE.unknown + (l.suggestion ? ' (closest: ' + l.suggestion + ')' : '') });
      if (l.resolved === 'case') flags.push({ code: 'case', text: LINE.case + ' (SOS ' + l.item.sku + ')' });
      if (l.item && l.item.archived) flags.push({ code: 'archived', text: LINE.archived });
      if (l.item && l.price != null && l.item.price > 0 && Math.abs(l.price - l.item.price) > Math.max(0.01, l.item.price * o.tolerance)) flags.push({ code: 'price', text: money(l.price) + ' here, ' + money(l.item.price) + ' in SOS' });
      if (l.qty == null || l.qty <= 0 || Math.round(l.qty) !== l.qty) flags.push({ code: 'qty', text: LINE.qty + ' (' + (l.qty == null ? 'blank' : l.qty) + ')' });
      if (!l.shipBy) flags.push({ code: 'no_ship', text: LINE.no_ship + (l.rawShipBy ? ' ("' + l.rawShipBy + '" not readable)' : '') });
      else { const d = daysBetween(today, l.shipBy); if (d < 0) flags.push({ code: 'late', text: LINE.late + ' (' + niceDate(l.shipBy) + ')' }); else if (d <= 7) flags.push({ code: 'soon', text: LINE.soon + ' (' + niceDate(l.shipBy) + ')' }); }
      const k = l.order + '|' + (l.item ? l.item.key : l.key);
      if (seen[k]) flags.push({ code: 'dup', text: LINE.dup + ' (rows ' + seen[k] + ' and ' + l.row + ')' }); else seen[k] = l.row;
      return Object.assign({}, l, { flags, katanaSku: l.item ? l.item.katanaSku : l.sku, value: (l.qty || 0) * (l.price != null ? l.price : (l.item && l.item.price) || 0) });
    });
    const exceptions = lines.filter((l) => l.flags.some((f) => f.code !== 'soon' && f.code !== 'case'));
    const orders = [...new Set(lines.map((l) => l.order))];
    const sum = (f) => lines.reduce((s, l) => s + (f(l) || 0), 0);
    const counts = {}; lines.forEach((l) => l.flags.forEach((f) => { counts[f.code] = (counts[f.code] || 0) + 1; }));
    return { lines, exceptions, counts, summary: { orders: orders.length, lines: lines.length, units: sum((l) => l.qty), value: sum((l) => l.value), retailers: new Set(lines.map((l) => l.retailer).filter(Boolean)).size, shipped: data.orders.length - open.length } };
  }

  // ---------- make plan ----------
  function makePlan(data, a, asOf, opts) {
    const o = Object.assign({}, data.opts, opts || {}), today = asOf || fmt(new Date());
    const until = fmt(new Date(toDate(today).getTime() + o.horizonDays * DAY));
    const demand = {}, firstShip = {};
    data.orders.filter((l) => l.open && l.item && !l.item.archived && l.qty > 0 && (!l.shipBy || l.shipBy <= until)).forEach((l) => {
      demand[l.item.key] = (demand[l.item.key] || 0) + l.qty;
      if (l.shipBy && (!firstShip[l.item.key] || l.shipBy < firstShip[l.item.key])) firstShip[l.item.key] = l.shipBy;
    });
    const make = [], buyFinished = [], need = {}, needItem = {};
    a.products.forEach((p) => {
      const d = demand[p.key] || 0, onHand = p.onHand || 0, reorder = o.topUp ? (p.reorder || 0) : 0;
      const qty = Math.max(0, Math.ceil(d + reorder - onHand));
      if (!qty && !d) return;
      const row = { item: p, line: p.category || 'Other', demand: d, onHand, reorder: p.reorder || 0, qty, firstShip: firstShip[p.key] || null, noRecipe: !p.makes };
      // made in-house (has a recipe, or SOS calls it an assembly); bought in finished otherwise
      if (p.makes || p.assemblyType) make.push(row); else if (qty) buyFinished.push(row);
    });
    // what the make list uses, through every level of the recipe (a wax blend made in-house is made first)
    const explode = (key, qty, depth, path) => {
      if (depth > 6 || path.includes(key)) return;
      (a.recipes[key] || []).forEach((r) => {
        const c = r.item, req = qty * r.qty;
        if (a.recipes[c.key] && c.role === 'product') explode(c.key, req, depth + 1, path.concat(key));
        else { need[c.key] = (need[c.key] || 0) + req; needItem[c.key] = c; }
      });
    };
    make.filter((m) => m.qty).forEach((m) => explode(m.item.key, m.qty, 0, []));
    const materials = Object.entries(need).map(([k, req]) => {
      const it = needItem[k], onHand = it.onHand || 0, reorder = o.topUp ? (it.reorder || 0) : 0;
      const toBuy = Math.max(0, req + reorder - onHand);
      return { item: it, needed: req, onHand, reorder: it.reorder || 0, toBuy, cost: it.cost != null ? toBuy * it.cost : null, vendor: it.vendor };
    }).sort((x, y) => (y.toBuy > 0) - (x.toBuy > 0) || x.item.name.localeCompare(y.item.name));
    const byLine = {};
    make.forEach((m) => { const L = byLine[m.line] = byLine[m.line] || { line: m.line, units: 0, items: [] }; L.units += m.qty; L.items.push(m); });
    Object.values(byLine).forEach((L) => L.items.sort((x, y) => (x.firstShip || '9').localeCompare(y.firstShip || '9') || y.qty - x.qty));
    const spend = materials.reduce((s, m) => s + (m.cost || 0), 0) + buyFinished.reduce((s, b) => s + (b.item.cost || 0) * b.qty, 0);
    return { until, lines: Object.values(byLine).sort((x, y) => y.units - x.units), make, buyFinished, materials, spend, missingCost: materials.filter((m) => m.toBuy && m.item.cost == null).length };
  }

  // ---------- cutover plan ----------
  function nextMonday(asOf, weeks) { let d = toDate(asOf); d = new Date(d.getTime() + weeks * 7 * DAY); while (d.getUTCDay() !== 1) d = new Date(d.getTime() + DAY); return fmt(d); }
  function cutoverPlan(data, a, goLive, asOf) {
    const H = data.opts.holidays, today = asOf || fmt(new Date());
    const live = goLive || nextMonday(today, 4);
    const at = (n) => addBusinessDays(live, n, H);
    const fixes = a.fix, renames = a.renames.length;
    const steps = [
      { n: -15, who: 'Rusty + Taiwo', what: fixes ? 'Fix the ' + fixes + ' code problem' + (fixes === 1 ? '' : 's') + ' on the Product codes tab' + (renames ? ' (' + renames + (renames === 1 ? ' item changes' : ' items change') + ' spelling to match Faire and MarketTime)' : '') : 'Product codes are clean: confirm the item list' },
      { n: -12, who: 'Taiwo', what: 'Import ' + a.materials.length + ' materials into Katana (materials file first: recipes can only use items that exist)' },
      { n: -11, who: 'Taiwo', what: 'Import ' + a.products.length + ' products, then ' + Object.values(a.recipes).reduce((s, r) => s + r.length, 0) + ' recipe lines; compare counts with SOS' },
      { n: -8, who: 'Rusty’s team', what: 'Count stock and load opening quantities into Katana' },
      { n: -6, who: 'Taiwo', what: 'Connect Katana to QuickBooks (invoice when an order is packed) and to ShipStation; send two test orders through' },
      { n: -5, who: 'Taiwo', what: 'Point Syncware at Katana for Faire and MarketTime; one real order of each lands in Katana' },
      { n: -4, who: 'Everyone', what: 'Parallel week: orders land in both SOS and Katana; the order desk is checked every morning' },
      { n: -1, who: 'Rusty', what: 'Sign off the parallel week: no doubles, no misses, stock matches' },
      { n: 0, who: 'Taiwo', what: 'Go live: turn off the QuickBooks to SOS sync; Katana is the system' },
      { n: 5, who: 'Rusty + Taiwo', what: 'First-week review: make plans, purchase orders and invoices as expected; SOS stays read-only for history' }
    ].map((s) => Object.assign(s, { date: at(s.n), nice: niceDate(at(s.n)), past: at(s.n) < today }));
    return { goLive: live, steps, tooSoon: steps[0].date < today };
  }

  // ---------- downloads ----------
  function issuesRows(a) { return a.issues.map((x) => [x.title, x.detail, x.fix]); }
  function orderRows(desk) { return desk.lines.map((l) => [l.order, l.retailer, l.date || '', l.shipBy || '', l.sku, l.katanaSku, l.product || (l.item ? l.item.name : ''), l.qty, l.price, l.flags.map((f) => f.text).join('; ')]); }
  function planRows(plan) { return plan.make.map((m) => [m.line, m.item.katanaSku, m.item.name, m.demand, m.onHand, m.reorder, m.qty, m.firstShip || '']); }
  function buyRows(plan) { return plan.materials.map((m) => [m.item.katanaSku, m.item.name, qtyText(m.needed), qtyText(m.onHand), qtyText(m.toBuy), m.item.uom, m.vendor, m.cost != null ? Math.round(m.cost * 100) / 100 : '']); }

  return { SPECS, DEFAULTS, ISSUE, KATANA_HEADERS, HOLIDAYS, keyOf, levenshtein, columns, prepare, audit, katanaRows, katanaFiles, fillTemplate, orderDesk, makePlan, cutoverPlan, addBusinessDays, niceDate, money, qtyText, issuesRows, orderRows, planRows, buyRows };
});
