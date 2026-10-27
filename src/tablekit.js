// src/tablekit.js: reads the spreadsheets people actually export and writes files other tools import.
//   - CSV with any delimiter (comma, semicolon, tab, pipe), quoted fields, line breaks inside quotes, a BOM
//   - Excel .xlsx (zip + XML), with shared strings, inline strings and date-formatted cells turned into dates
//   - a header row that is not the first row (exports often start with a title or a date range)
//   - columns found by their header names (each tool calls "booking number" something slightly different)
//   - money and dates in the formats exports use ("VT 12,000", "1.234,50", "22/10/2026 08:30", Excel serials)
//   - .csv and .xlsx written back (the .xlsx is uncompressed, which every spreadsheet tool opens)
// Same file in the browser (window.TableKit) and in node (require); the tests load this exact file.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TableKit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- CSV ----------
  function detectDelimiter(text) {
    const line = (text.split(/\r\n|\n|\r/).find((l) => l.trim()) || '');
    let best = ',', bestCount = 0;
    [',', ';', '\t', '|'].forEach((d) => {
      let n = 0, inQ = false;
      for (const ch of line) { if (ch === '"') inQ = !inQ; else if (!inQ && ch === d) n++; }
      if (n > bestCount) { best = d; bestCount = n; }
    });
    return best;
  }

  function parseCsv(text, delimiter) {
    text = String(text || '').replace(/^﻿/, '');
    const d = delimiter || detectDelimiter(text);
    const rows = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
        continue;
      }
      if (ch === '"' && field === '') inQ = true;
      else if (ch === d) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
    return rows;
  }

  // ---------- ZIP (read) ----------
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

  async function defaultInflate(data) {
    if (typeof DecompressionStream !== 'undefined') {
      const out = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
      return new Uint8Array(await out.arrayBuffer());
    }
    return new Uint8Array(require('zlib').inflateRawSync(Buffer.from(data)));
  }

  async function unzip(bytes, inflate) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const count = u16(b, eocd + 10); let p = u32(b, eocd + 16);
    const files = {};
    for (let n = 0; n < count; n++) {
      if (u32(b, p) !== 0x02014b50) throw new Error('damaged zip directory');
      const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
      const name = utf8(b.subarray(p + 46, p + 46 + nlen));
      const start = off + 30 + u16(b, off + 26) + u16(b, off + 28);
      files[name] = { method, data: b.subarray(start, start + csize) };
      p += 46 + nlen + xlen + clen;
    }
    const read = async (name) => {
      const f = files[name]; if (!f) return null;
      if (f.method === 0) return f.data;
      if (f.method === 8) return (inflate || defaultInflate)(f.data);
      throw new Error('unsupported zip compression ' + f.method);
    };
    return { names: Object.keys(files), read };
  }

  // ---------- XLSX (read) ----------
  const decodeXml = (s) => String(s)
    .replace(/_x([0-9A-Fa-f]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const texts = (xml) => { let s = ''; xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, (m, t) => { s += t; return m; }); return decodeXml(s); };
  const attr = (a, name) => { const m = new RegExp('\\b' + name + '="([^"]*)"').exec(a); return m ? m[1] : null; };
  const colIndex = (ref) => { const L = /^[A-Z]+/.exec(ref)[0]; let n = 0; for (const c of L) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };

  // Excel stores dates as day numbers since 1899-12-30 (or 1904-01-01 on old Macs); this turns one into text.
  function serialToIso(serial, withTime, date1904) {
    // rounded to the minute: Excel keeps 08:00 as 0.33333..., which is a few milliseconds short of 8 o'clock
    const ms = Math.round(((date1904 ? serial + 1462 : serial) - 25569) * 1440) * 60000;
    if (!isFinite(ms)) return null;
    const d = new Date(ms), iso = d.toISOString();
    return withTime && (d.getUTCHours() || d.getUTCMinutes()) ? iso.slice(0, 10) + ' ' + iso.slice(11, 16) : iso.slice(0, 10);
  }
  function dateStyles(stylesXml) {
    const custom = {};
    (stylesXml.match(/<numFmt\b[^>]*>/g) || []).forEach((t) => { custom[attr(t, 'numFmtId')] = decodeXml(attr(t, 'formatCode') || ''); });
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
    return (xfs ? xfs[1].match(/<xf\b[^>]*>/g) || [] : []).map((t) => {
      const id = +(attr(t, 'numFmtId') || 0);
      if ((id >= 14 && id <= 17) || (id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return 'date';
      if (id === 22 || (id >= 18 && id <= 21) || (id >= 45 && id <= 47)) return id === 22 ? 'datetime' : 'time';
      const code = (custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      if (!/[dmyhs]/i.test(code)) return null;
      return /[dy]/i.test(code) ? (/h|s/i.test(code) ? 'datetime' : 'date') : 'time';
    });
  }

  async function readXlsx(bytes, opts) {
    const zip = await unzip(bytes, opts && opts.inflate);
    const text = async (n) => { const d = await zip.read(n); return d ? utf8(d) : null; };
    const wb = (await text('xl/workbook.xml')) || '';
    const rels = (await text('xl/_rels/workbook.xml.rels')) || '';
    const sheets = (wb.match(/<sheet\b[^>]*>/g) || []).map((t) => {
      const rid = attr(t, 'r:id'), rel = (rels.match(/<Relationship\b[^>]*>/g) || []).find((r) => attr(r, 'Id') === rid);
      const target = rel ? attr(rel, 'Target') : null;
      return { name: decodeXml(attr(t, 'name') || ''), path: target ? (target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')) : null };
    });
    const first = (sheets.find((s) => s.path && zip.names.includes(s.path)) || {}).path || zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    if (!first) throw new Error('no worksheet in this file');
    const shared = [];
    const ss = await text('xl/sharedStrings.xml');
    if (ss) (ss.match(/<si>[\s\S]*?<\/si>|<si\/>/g) || []).forEach((si) => shared.push(texts(si)));
    const styles = dateStyles((await text('xl/styles.xml')) || '');
    const date1904 = /date1904="(1|true)"/.test(wb);
    const xml = await text(first);
    const rows = [];
    (xml.match(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g) || []).forEach((rx) => {
      const r = +(attr(rx.slice(0, rx.indexOf('>')), 'r') || rows.length + 1) - 1;
      const cells = [];
      rx.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, a, inner) => {
        const ref = attr(a, 'r'), t = attr(a, 't'), s = attr(a, 's');
        const idx = ref ? colIndex(ref) : cells.length;
        let v = '';
        if (inner != null) {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
          if (t === 's') v = vm ? (shared[+vm[1]] || '') : '';
          else if (t === 'inlineStr') v = texts(inner);
          else if (t === 'b') v = vm && vm[1] === '1' ? 'TRUE' : 'FALSE';
          else if (vm) v = decodeXml(vm[1]);
          const kind = s != null ? styles[+s] : null;
          if (kind && (t == null || t === 'n') && v !== '' && isFinite(+v)) {
            if (kind === 'time') { const mins = Math.round((+v % 1) * 1440); v = String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'); }
            else v = serialToIso(+v, kind === 'datetime', date1904);
          }
        }
        cells[idx] = v; return m;
      });
      for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
      rows[r] = cells;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    while (rows.length && rows[rows.length - 1].every((c) => !String(c).trim())) rows.pop();
    return rows;
  }

  // Reads a dropped file: bytes plus its name. Returns rows, or throws with a reason a person can act on.
  async function readFile(bytes, name, opts) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const lower = String(name || '').toLowerCase();
    if (b.length >= 4 && u32(b, 0) === 0x04034b50) return readXlsx(b, opts);
    if (/\.(xls)$/.test(lower) || (b.length >= 8 && b[0] === 0xD0 && b[1] === 0xCF)) throw new Error('This is an old-style .xls file. Open it and save it as .xlsx or .csv, then drop it in again.');
    if (/\.(pdf)$/.test(lower) || (b[0] === 0x25 && b[1] === 0x50)) throw new Error('This is a PDF. Export the report as Excel or CSV instead.');
    const text = utf8(b);
    if (/\u0000/.test(text.slice(0, 2000))) throw new Error('This file is not a spreadsheet. Export it as Excel (.xlsx) or CSV.');
    return parseCsv(text);
  }

  // ---------- table ----------
  const isNumberish = (v) => /^[-+(]?[\d\s.,]+\)?$/.test(String(v).trim());
  // The header row is the one with the most text labels near the top (exports often begin with a title line).
  function toTable(rows) {
    let best = -1, bestScore = 0;
    rows.slice(0, 15).forEach((r, i) => {
      const labels = r.filter((c) => String(c).trim() && !isNumberish(c)).length;
      if (labels >= 2 && labels > bestScore) { best = i; bestScore = labels; }
    });
    if (best < 0) return { headers: [], records: [], headerRow: -1 };
    const seen = {};
    const headers = rows[best].map((h, i) => {
      let name = String(h).trim() || 'Column ' + (i + 1);
      if (seen[name]) name += ' (' + (++seen[name]) + ')'; else seen[name] = 1;
      return name;
    });
    const records = [];
    rows.slice(best + 1).forEach((r, i) => {
      if (!r.some((c) => String(c).trim())) return;
      const rec = { _row: best + i + 2 };
      // values stay exactly as exported (a stray space in a product code is itself worth reporting); readers trim
      headers.forEach((h, j) => { rec[h] = r[j] == null ? '' : String(r[j]); });
      records.push(rec);
    });
    return { headers, records, headerRow: best };
  }

  // ---------- columns ----------
  // "InvoiceAmountDue", "*DueDate" and "Amount due" all normalise to words: invoice amount due, due date, amount due.
  const norm = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  function score(header, syn) {
    const h = norm(header), s = norm(syn);
    if (!h || !s) return 0;
    if (h === s) return 100;
    if ((' ' + h + ' ').includes(' ' + s + ' ')) return 60 + Math.min(s.length, 20);
    if ((' ' + s + ' ').includes(' ' + h + ' ')) return 40 + Math.min(h.length, 10);
    const ht = new Set(h.split(' ')), st = s.split(' ');
    const common = st.filter((t) => ht.has(t)).length;
    return common ? Math.round(35 * common / Math.max(st.length, ht.size)) : 0;
  }
  // spec: { field: { label, synonyms: [...], required, avoid: [...] } }. Each header is used for one field at most.
  function mapColumns(headers, spec, fixed) {
    const pairs = [];
    Object.entries(spec).forEach(([field, f]) => headers.forEach((h) => {
      if ((f.avoid || []).some((a) => (' ' + norm(h) + ' ').includes(' ' + norm(a) + ' '))) return;
      const sc = Math.max(...[f.label].concat(f.synonyms || []).map((s) => score(h, s)));
      if (sc >= 30) pairs.push({ field, header: h, sc });
    }));
    pairs.sort((a, b) => b.sc - a.sc);
    const map = {}, used = new Set();
    Object.entries(fixed || {}).forEach(([field, h]) => { map[field] = h || null; if (h) used.add(h); });
    pairs.forEach((p) => { if (!(p.field in map) && !used.has(p.header)) { map[p.field] = p.header; used.add(p.header); } });
    Object.keys(spec).forEach((f) => { if (!(f in map)) map[f] = null; });
    const missing = Object.keys(spec).filter((f) => spec[f].required && !map[f]);
    return { map, missing };
  }

  // ---------- values ----------
  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[\s  ]/g, '').replace(/^(VUV|VT|USD|AUD|NZD|XPF|EUR|US\$|A\$|NZ\$|\$|€|£)/i, '').replace(/(VUV|VT|USD|AUD|NZD|XPF|EUR|€|\$)$/i, '');
    if (/^-/.test(s)) { neg = !neg; s = s.slice(1); }
    if (!/^[\d.,]+$/.test(s)) return null;
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
    else if (lastComma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    const n = parseFloat(s);
    return isFinite(n) ? (neg ? -n : n) : null;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, janv: 1, fevr: 2, fev: 2, mars: 3, avr: 4, mai: 5, juin: 6, juil: 7, aout: 8, sept: 9, octo: 10, nove: 11, dece: 12 };
  const pad = (n) => String(n).padStart(2, '0');
  function validDate(y, m, d) { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }
  function parseTime(s) {
    const m = /(\d{1,2})[:h.](\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?/i.exec(String(s || ''));
    if (!m) return null;
    let h = +m[1]; const min = +m[2], ap = m[3] && m[3].toLowerCase();
    if (ap === 'p' && h < 12) h += 12; if (ap === 'a' && h === 12) h = 0;
    return h < 24 && min < 60 ? pad(h) + ':' + pad(min) : null;
  }
  // Returns { date: 'YYYY-MM-DD', time: 'HH:MM' | null } or null. order: 'DMY' or 'MDY' for 03/04/2026 style dates.
  function parseDateTime(v, order) {
    if (v == null || v === '') return null;
    let s = String(v).trim();
    if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) {
      const iso = serialToIso(+s, true); return iso ? { date: iso.slice(0, 10), time: iso.length > 10 ? iso.slice(11) : null } : null;
    }
    let y, mo, d, rest = '';
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(s);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
    else if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(.*)$/.exec(s))) {
      const a = +m[1], b = +m[2]; y = +m[3]; if (y < 100) y += 2000; rest = m[4];
      if (order === 'MDY' || (order !== 'DMY' && b > 12)) { mo = a; d = b; } else { d = a; mo = b; }
    } else {
      const t = s.replace(/^[A-Za-z]{3,9},?\s+/, (w) => (MONTHS[norm(w).slice(0, 3)] ? w : ''));
      if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-zéû]{3,9})\.?,?\s+(\d{4})(.*)$/.exec(t))) { d = +m[1]; mo = MONTHS[norm(m[2].normalize('NFD').replace(/[̀-ͯ]/g, '')).slice(0, 4)] || MONTHS[norm(m[2]).slice(0, 3)]; y = +m[3]; rest = m[4]; }
      else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(.*)$/.exec(t))) { mo = MONTHS[norm(m[1]).slice(0, 3)]; d = +m[2]; y = +m[3]; rest = m[4]; }
      else return null;
    }
    if (!mo || !validDate(y, mo, d)) return null;
    return { date: y + '-' + pad(mo) + '-' + pad(d), time: parseTime(rest) };
  }
  // Decides whether 03/04/2026 means 3 April (DMY) or March 4 (MDY) from all values in a column.
  function dateOrder(values, fallback) {
    let dmy = 0, mdy = 0;
    values.forEach((v) => { const m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}/.exec(String(v || '').trim()); if (m) { if (+m[1] > 12) dmy++; if (+m[2] > 12) mdy++; } });
    return dmy > mdy ? 'DMY' : mdy > dmy ? 'MDY' : (fallback || 'DMY');
  }

  // ---------- write ----------
  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function toCsv(headers, rows) { return '﻿' + [headers].concat(rows).map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

  let CRC;
  function crc32(bytes) {
    if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zipStore(files) {
    const enc = new TextEncoder(), parts = [], dir = []; let off = 0;
    const le = (n, len) => { const a = []; for (let i = 0; i < len; i++) a.push((n >>> (8 * i)) & 0xFF); return a; };
    files.forEach(({ name, data }) => {
      const nb = enc.encode(name), db = typeof data === 'string' ? enc.encode(data) : data, crc = crc32(db);
      const head = [].concat(le(0x04034b50, 4), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x5C21, 2), le(crc, 4), le(db.length, 4), le(db.length, 4), le(nb.length, 2), le(0, 2));
      parts.push(new Uint8Array(head), nb, db);
      dir.push([].concat(le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0x5C21, 2), le(crc, 4), le(db.length, 4), le(db.length, 4), le(nb.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4)), nb);
      off += head.length + nb.length + db.length;
    });
    let size = 0; dir.forEach((d) => { size += d.length; });
    const flat = [];
    dir.forEach((d) => { if (d instanceof Uint8Array) flat.push(d); else flat.push(new Uint8Array(d)); });
    const end = new Uint8Array([].concat(le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2), le(size, 4), le(off, 4), le(0, 2)));
    const all = parts.concat(flat, [end]); let total = 0; all.forEach((p) => { total += p.length; });
    const out = new Uint8Array(total); let p = 0; all.forEach((x) => { out.set(x, p); p += x.length; });
    return out;
  }
  const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const colName = (i) => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
  // sheets: [{ name, headers, rows }]. Numbers stay numbers; everything else is written as text. Header row in bold.
  function xlsxBytes(sheets) {
    const sheetXml = (sh) => {
      const all = [sh.headers].concat(sh.rows);
      const body = all.map((r, ri) => '<row r="' + (ri + 1) + '">' + r.map((v, ci) => {
        const ref = colName(ci) + (ri + 1), style = ri === 0 ? ' s="1"' : '';
        if (v == null || v === '') return '';
        if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + style + '><v>' + v + '</v></c>';
        return '<c r="' + ref + '"' + style + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
      }).join('') + '</row>').join('');
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>';
    };
    const files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xmlEsc(String(s.name || 'Sheet' + (i + 1)).slice(0, 31).replace(/[\\\/?*\[\]:]/g, ' ')) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') + '</sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('') + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' }
    ].concat(sheets.map((s, i) => ({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s) })));
    return zipStore(files);
  }

  return { detectDelimiter, parseCsv, unzip, readXlsx, readFile, toTable, mapColumns, normHeader: norm, parseNumber, parseDateTime, parseTime, dateOrder, serialToIso, toCsv, xlsxBytes, crc32 };
});
