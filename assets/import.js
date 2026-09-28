/* ===========================================================================
   import.js - build allocation rows from a site-list spreadsheet.

   The site list usually already exists in Excel, one line per site. Typing it
   back in as grouped allocation rows is slow and easy to get wrong, so this
   reads the sheet, works out which column holds what, matches the free-text
   product / connectivity mode / tier values against the rate card, and groups
   identical sites into allocation rows. Nothing touches the estimator until
   the user has seen the preview and confirmed it.

   No DOM access; the page controller owns the dialog.
   =========================================================================== */
(function (global) {
  'use strict';

  var D = global.FTEData;

  var MAX_ROWS = 20000;   // generous for a site list, small enough not to hang the tab

  /* ------------------------------------------------------------ reading --- */

  /* ExcelJS hands back rich objects for formulas, hyperlinks and formatted
     text. Only the displayed value matters here. */
  function cellValue(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      if (v.richText) return v.richText.map(function (t) { return t.text; }).join('');
      /* An error cell, or a formula saved without its calculated value, is
         kept as visible text (e.g. "#N/A", "=SUM(C2:C9)") rather than
         blanked: a blank Sites cell would silently count as one site. */
      if (v.error) return String(v.error);
      if (v.formula || v.sharedFormula) {
        return (v.result === undefined || v.result === null) ? '=' + (v.formula || v.sharedFormula) : cellValue(v.result);
      }
      if (Object.prototype.hasOwnProperty.call(v, 'result')) return cellValue(v.result);
      if (v.text !== undefined) return cellValue(v.text);
      return '';
    }
    return v;
  }

  function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }
  function hasContent(row) { return (row || []).some(function (c) { return !isBlank(c); }); }

  function readXlsx(buffer) {
    if (typeof ExcelJS === 'undefined') return Promise.reject(new Error('The Excel library is not loaded.'));
    var wb = new ExcelJS.Workbook();
    return wb.xlsx.load(buffer).then(function () {
      var sheets = [];
      wb.eachSheet(function (ws) {
        if (ws.state && ws.state !== 'visible') return;
        var rows = [], truncated = false;
        ws.eachRow({ includeEmpty: true }, function (row, n) {
          if (n > MAX_ROWS) { truncated = true; return; }
          var vals = [];
          row.eachCell({ includeEmpty: true }, function (cell, c) { vals[c - 1] = cellValue(cell.value); });
          for (var i = 0; i < vals.length; i++) if (vals[i] === undefined) vals[i] = '';
          rows[n - 1] = vals;
        });
        /* Keep index i == spreadsheet row i+1, so messages can quote real row numbers. */
        for (var r = 0; r < rows.length; r++) if (!rows[r]) rows[r] = [];
        if (rows.some(hasContent)) sheets.push({ name: ws.name, rows: rows, truncated: truncated });
      });
      return sheets;
    });
  }

  function detectDelimiter(text) {
    var sample = text.split(/\r?\n/).slice(0, 10).join('\n');
    var best = ',', bestCount = -1;
    [',', ';', '\t', '|'].forEach(function (d) {
      var count = sample.split(d).length - 1;
      if (count > bestCount) { best = d; bestCount = count; }
    });
    return best;
  }

  /* A small RFC 4180 reader: quoted fields, doubled quotes, delimiters and
     line breaks inside quotes. Excel's "CSV (semicolon)" exports are handled
     by sniffing the delimiter. */
  function parseCsv(text, delimOut) {
    text = String(text || '').replace(/^﻿/, '');
    var delim = detectDelimiter(text);
    if (delimOut) delimOut.delimiter = delim;
    var rows = [], row = [], field = '', inQuotes = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
        continue;
      }
      if (ch === '"' && field === '') { inQuotes = true; continue; }
      if (ch === delim) { row.push(field); field = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
        if (rows.length >= MAX_ROWS) break;
        continue;
      }
      field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.map(function (r) { return r.map(function (c) { return c.trim(); }); });
  }

  /** Resolve to [{ name, rows, truncated }], one entry per sheet with data. */
  function readFile(file) {
    var name = (file && file.name) || '';
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (ext === 'xls') {
      return Promise.reject(new Error('Old-style .xls files cannot be read. In Excel use File › Save As › Excel Workbook (.xlsx) and import that file.'));
    }
    if (ext === 'xlsx' || ext === 'xlsm') {
      return file.arrayBuffer().then(readXlsx);
    }
    return file.arrayBuffer().then(function (buf) {
      var info = {};
      var rows = parseCsv(decodeText(buf), info);
      /* Semicolon-separated files come from locales where the comma is the
         decimal mark ("1,5" = one and a half), so numbers read that way. */
      return rows.some(hasContent)
        ? [{ name: name, rows: rows, truncated: rows.length >= MAX_ROWS, decimalComma: info.delimiter === ';' }]
        : [];
    });
  }

  /* Excel saves "CSV" in the Windows code page and "Unicode Text" as UTF-16,
     so the bytes are decoded by their byte-order mark, then as UTF-8, and
     only if that is not valid UTF-8, as Windows-1252 - which keeps accented
     site names intact whichever way the file was saved. */
  function decodeText(buf) {
    var b = new Uint8Array(buf);
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); }
    catch (e) { return new TextDecoder('windows-1252').decode(b); }
  }

  /* ------------------------------------------------------------ columns --- */

  function norm(s) {
    return String(s === null || s === undefined ? '' : s).toLowerCase()
      .replace(/[^a-z0-9%#]+/g, ' ').trim();
  }
  function compact(s) {
    return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  /* What each column can mean, and the headings people actually use for it. */
  var ROLES = {
    site:       { label: 'Site name / ID', aliases: ['site', 'site name', 'site id', 'site code', 'site ref', 'site reference', 'location', 'location name', 'branch', 'branch name', 'address', 'name', 'store', 'office', 'city'] },
    product:    { label: 'Product', aliases: ['product', 'products', 'product name', 'service', 'service type', 'offer', 'solution'] },
    mode:       { label: 'Connectivity mode', aliases: ['connectivity mode', 'connectivity', 'mode', 'access mode', 'access type', 'resilience', 'resiliency', 'design', 'topology', 'cpe', 'cpe type'] },
    count:      { label: 'Number of sites', aliases: ['sites', 'site count', 'number of sites', 'no of sites', 'nb sites', 'nbr sites', '# sites', '# of sites', 'count', 'qty', 'quantity'] },
    devices:    { label: 'Device count', aliases: ['devices', 'device count', 'number of devices', 'no of devices', 'nb devices', 'nbr devices', '# devices', '# of devices', 'equipment', 'equipment count', 'switches', 'routers', 'access points'] },
    tier:       { label: 'Tier / size', aliases: ['tier', 'lan tier', 'size', 'site size', 'category', 'class', 'site class'] },
    complexity: { label: 'Complexity %', aliases: ['complexity', 'complexity %', 'complexity pct', 'complexity percent', 'difficulty'] },
    override:   { label: 'Override MD per site', aliases: ['override', 'override md', 'override md per site', 'md per site', 'md site', 'rate', 'custom rate', 'man days per site'] }
  };

  var SIDE_ROLES = {
    wan: ['site', 'product', 'mode', 'count', 'complexity', 'override'],
    lan: ['site', 'devices', 'tier', 'count', 'complexity', 'override']
  };

  function headerScore(header, role) {
    var h = norm(header);
    if (!h) return 0;
    var best = 0;
    ROLES[role].aliases.forEach(function (a) {
      var s = 0;
      if (h === a) s = 100;
      else if (compact(h) === compact(a)) s = 90;
      /* Word match only for longer aliases: "name" alone must not claim
         "Product name", which the exact product alias should win. */
      else if (a.length >= 4 && (' ' + h + ' ').indexOf(' ' + a + ' ') >= 0) s = 60;
      if (s > best) best = s;
    });
    return best;
  }

  /* The header is the row, near the top, that looks most like column
     headings. Sheets often carry a title or a blank line above it. */
  function detectHeader(rows, side) {
    var roles = SIDE_ROLES[side];
    var best = -1, bestScore = 0;
    for (var r = 0; r < Math.min(rows.length, 15); r++) {
      var row = rows[r] || [];
      var found = {};
      row.forEach(function (cell) {
        if (typeof cell !== 'string') return;
        roles.forEach(function (role) { if (headerScore(cell, role) >= 60) found[role] = true; });
      });
      var score = Object.keys(found).length;
      if (score > bestScore) { best = r; bestScore = score; }
    }
    if (best >= 0) return best;
    for (var i = 0; i < rows.length; i++) if (hasContent(rows[i])) return i;
    return 0;
  }

  /** Best column for each role, each column used at most once. -1 = none. */
  function guessMapping(headers, side) {
    var roles = SIDE_ROLES[side];
    var candidates = [];
    roles.forEach(function (role) {
      (headers || []).forEach(function (h, col) {
        var s = headerScore(h, role);
        if (s >= 60) candidates.push({ role: role, col: col, score: s });
      });
    });
    candidates.sort(function (a, b) { return b.score - a.score || a.col - b.col; });
    var mapping = {}, usedCols = {};
    roles.forEach(function (role) { mapping[role] = -1; });
    candidates.forEach(function (c) {
      if (mapping[c.role] >= 0 || usedCols[c.col]) return;
      mapping[c.role] = c.col; usedCols[c.col] = true;
    });
    return mapping;
  }

  /* ------------------------------------------------------------- values --- */

  /* Accepted spellings, as compacted keys (lower case, letters and digits
     only). The canonical name is always accepted too. */
  var PRODUCT_KEYS = {
    'SD-WAN': ['sdwan'],
    'BVPN Corporate': ['bvpncorporate', 'bvpncorp', 'businessvpncorporate'],
    'IEL': ['iel'],
    'BVPN Small': ['bvpnsmall', 'businessvpnsmall'],
    'Internet Essential': ['internetessential', 'internetessentials'],
    'Internet Platinum': ['internetplatinum'],
    'Flexible SD-Branch': ['flexiblesdbranch', 'flexsdbranch', 'sdbranch']
  };

  var MODE_KEYS = {
    'Access only': ['accessonly', 'access', 'nocpe'],
    '1 CPE / No Continuity': ['1cpenocontinuity', '1cpe', 'onecpe', 'singlecpe', 'nocontinuity', 'withoutcontinuity', '1cpewithoutcontinuity'],
    '2 CPEs / With Continuity': ['2cpeswithcontinuity', '2cpes', '2cpe', 'twocpes', 'twocpe', 'dualcpe', 'withcontinuity', '2cpewithcontinuity'],
    'Single vEdge CPE': ['singlevedgecpe', 'singlevedge', '1vedge', 'onevedge'],
    'Dual vEdge CPE': ['dualvedgecpe', 'dualvedge', '2vedge', '2vedges', 'twovedges'],
    'Dual': ['dual', 'duallink', 'dualaccess'],
    'Air Backup': ['airbackup', 'air'],
    'Always-On': ['alwayson']
  };

  var TIER_KEYS = {
    OD_XS:  ['odxs', 'xs', 'od', 'extrasmall', 'xsmall'],
    S:      ['s', 'small'],
    M:      ['m', 'medium', 'med'],
    Large:  ['l', 'large'],
    XL:     ['xl', 'extralarge', 'xlarge'],
    Campus: ['campus']
  };

  function makeIndex(table) {
    var list = [];
    Object.keys(table).forEach(function (value) {
      var keys = table[value].slice();
      keys.push(compact(value));
      keys.forEach(function (k) { if (k) list.push({ key: k, value: value }); });
    });
    return list;
  }

  var PRODUCT_INDEX = makeIndex(PRODUCT_KEYS);
  var MODE_INDEX = makeIndex(MODE_KEYS);
  var TIER_INDEX = makeIndex(TIER_KEYS);

  /* Exact spelling first. Failing that, the known spellings contained in the
     text ("SD-WAN (Orange)", "Dual vEdge CPE - resilient"); short keys such
     as "s" or "air" only ever match exactly. A spelling that sits inside a
     longer one ("dual" inside "dual vedge") does not count separately. If
     what is left still names two different values - "Dual (2 accesses)"
     mentions both Dual and Access - it is ambiguous, and ambiguous is
     reported, never guessed. */
  function matchValue(raw, index) {
    var c = compact(raw);
    if (!c) return null;
    for (var i = 0; i < index.length; i++) if (index[i].key === c) return index[i].value;

    var spans = [];
    index.forEach(function (e) {
      if (e.key.length < 4) return;
      for (var at = c.indexOf(e.key); at >= 0; at = c.indexOf(e.key, at + 1)) {
        spans.push({ from: at, to: at + e.key.length, value: e.value });
      }
    });
    var kept = spans.filter(function (s) {
      return !spans.some(function (o) {
        return o !== s && o.from <= s.from && o.to >= s.to && (o.to - o.from) > (s.to - s.from);
      });
    });
    var values = {};
    kept.forEach(function (s) { values[s.value] = true; });
    var names = Object.keys(values);
    return names.length === 1 ? names[0] : null;
  }

  function matchTier(raw) {
    /* "M (11 - 50 devices)" is the app's own label; "Tier M" and "Size: M" are common too. */
    var cleaned = String(raw === null || raw === undefined ? '' : raw)
      .replace(/\(.*?\)/g, ' ').replace(/\b(tier|size|lan)\b/gi, ' ');
    var key = matchValue(cleaned, TIER_INDEX);
    if (!key) return null;
    for (var i = 0; i < D.LAN_TIERS.length; i++) {
      if (D.LAN_TIERS[i].key === key) return D.LAN_TIERS[i];
    }
    return null;
  }

  /* decimalComma: the file uses "1,5" for one and a half (and "1.234" or
     "1 234" for thousands). Otherwise "1,234" is a thousands separator and
     only a comma followed by other than three digits is read as a decimal. */
  function parseNum(v, decimalComma) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    var s = String(v === null || v === undefined ? '' : v).trim().replace(/[\s ]+/g, '').replace(/%$/, '');
    if (!s) return null;
    if (decimalComma) {
      if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '');
      s = s.replace(',', '.');
    } else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');   // 1,234 thousands
    else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');                        // 1,5 decimal comma
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }

  /* Excel stores a cell formatted as 120% as 1.2. A complexity of 1-5% is
     not a real setting, so small values are read as that fraction. */
  function parseComplexity(v, decimalComma) {
    var n = parseNum(v, decimalComma);
    if (n === null) return null;
    var hadPercent = typeof v === 'string' && /%\s*$/.test(v);
    if (!hadPercent && n > 0 && n <= 5) n = n * 100;
    n = Math.round(n * 100) / 100;
    return (n >= 1 && n <= 500) ? n : null;
  }

  /* -------------------------------------------------------------- build --- */

  var TOTAL_LINE = /^(grand\s*)?(sub[\s-]?)?totals?\s*:?$/i;

  function text(v) { return String(v === null || v === undefined ? '' : v).trim(); }

  function bump(map, key) { map[key] = (map[key] || 0) + 1; }

  /**
   * Turn sheet rows into allocation rows.
   * opts: { side: 'wan'|'lan', headerIndex, mapping: {role: col}, defaultComplexity }
   */
  function build(rows, opts) {
    var side = opts.side === 'lan' ? 'lan' : 'wan';
    var map = opts.mapping || {};
    var hdr = opts.headerIndex || 0;
    var defaultComplexity = opts.defaultComplexity || 100;
    var dc = !!opts.decimalComma;

    function col(role) { return (map[role] === undefined || map[role] === null) ? -1 : map[role]; }

    if (side === 'wan' && (col('product') < 0 || col('mode') < 0)) {
      return { ok: false, error: 'Choose the columns that hold the product and the connectivity mode.' };
    }
    if (side === 'lan' && col('devices') < 0 && col('tier') < 0) {
      return { ok: false, error: 'Choose the column that holds the device count or the tier.' };
    }

    var groups = {}, order = [];
    var skipped = [], warnings = [];
    var unknown = { product: {}, mode: {}, tier: {} };
    var used = 0, totalSites = 0, named = 0;

    for (var r = hdr + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      if (!hasContent(row)) continue;
      var rowNo = r + 1;
      var get = function (role) { var c = col(role); return c < 0 ? '' : row[c]; };

      var site = text(get('site'));
      var firstCell = text(row[0]);
      /* Only a cell that is just the word ("Total", "Grand total:") - a site
         called "Totalfina depot" is a site. */
      if (TOTAL_LINE.test(site) || TOTAL_LINE.test(firstCell)) {
        skipped.push({ row: rowNo, reason: 'Looks like a total line' });
        continue;
      }

      /* Sites on this line: blank means one site, which is what a plain
         one-line-per-site list is. */
      var count = 1;
      if (col('count') >= 0 && !isBlank(get('count'))) {
        count = parseNum(get('count'), dc);
        if (count === null) { skipped.push({ row: rowNo, reason: 'Sites "' + text(get('count')) + '" is not a number' }); continue; }
        if (count <= 0) { skipped.push({ row: rowNo, reason: 'Zero sites' }); continue; }
        if (Math.abs(count - Math.round(count)) > 1e-9) {
          skipped.push({ row: rowNo, reason: 'Sites must be a whole number (found ' + count + ')' });
          continue;
        }
        count = Math.round(count);
      }

      var complexity = defaultComplexity;
      if (col('complexity') >= 0 && !isBlank(get('complexity'))) {
        var cx = parseComplexity(get('complexity'), dc);
        if (cx === null) {
          warnings.push('Row ' + rowNo + ': complexity "' + text(get('complexity')) + '" not understood - used ' + defaultComplexity + '%.');
        } else complexity = cx;
      }

      var override = null;
      if (col('override') >= 0 && !isBlank(get('override'))) {
        var ov = parseNum(get('override'), dc);
        if (ov !== null && ov > 0) override = ov;
        else warnings.push('Row ' + rowNo + ': override "' + text(get('override')) + '" ignored - it must be a number above zero.');
      }

      var key, entry, devices = null;
      if (side === 'wan') {
        var rawProduct = text(get('product')), rawMode = text(get('mode'));
        if (!rawProduct) { skipped.push({ row: rowNo, reason: 'No product' }); continue; }
        if (!rawMode) { skipped.push({ row: rowNo, reason: 'No connectivity mode' }); continue; }
        var product = matchValue(rawProduct, PRODUCT_INDEX);
        var mode = matchValue(rawMode, MODE_INDEX);
        if (!product) bump(unknown.product, rawProduct);
        if (!mode) bump(unknown.mode, rawMode);
        if (!product || !mode) {
          skipped.push({ row: rowNo, reason: !product
            ? 'Product "' + rawProduct + '" not recognised'
            : 'Connectivity mode "' + rawMode + '" not recognised' });
          continue;
        }
        key = [product, mode, complexity, override].join('|');
        entry = groups[key] || (groups[key] = {
          product: product, connectivityMode: mode, sites: 0,
          complexityPct: complexity, overrideMdPerSite: override,
          offered: D.lookupBaseMd(mode, product) !== null, sitesDetail: []
        });
      } else {
        var tier = null;
        if (col('tier') >= 0 && !isBlank(get('tier'))) {
          tier = matchTier(get('tier'));
          if (!tier) bump(unknown.tier, text(get('tier')));
        }
        if (col('devices') >= 0 && !isBlank(get('devices'))) {
          devices = parseNum(get('devices'), dc);
          if (devices !== null && devices < 0) devices = null;
        }
        /* An explicit tier wins over a device count; the count only decides
           the tier when no tier is given. */
        if (!tier && devices !== null) tier = D.tierForDeviceCount(devices);
        if (!tier) {
          skipped.push({ row: rowNo, reason: col('tier') >= 0 && !isBlank(get('tier'))
            ? 'Tier "' + text(get('tier')) + '" not recognised'
            : 'No device count or tier' });
          continue;
        }
        var label = D.LAN_TIER_LABELS[D.LAN_TIERS.indexOf(tier)];
        key = [label, complexity, override].join('|');
        entry = groups[key] || (groups[key] = {
          tierLabel: label, sites: 0, complexityPct: complexity,
          overrideMdPerSite: override, offered: true, sitesDetail: []
        });
      }

      if (!entry.sites) order.push(key);
      entry.sites += count;
      totalSites += count;
      used++;
      if (site) {
        var detail = { name: site, count: count };
        if (side === 'lan' && devices !== null) detail.devices = devices;
        entry.sitesDetail.push(detail);
        named += count;
      }
    }

    var out = order.map(function (k) {
      var g = groups[k];
      var row = side === 'wan'
        ? { product: g.product, connectivityMode: g.connectivityMode }
        : { tierLabel: g.tierLabel };
      row.sites = g.sites;
      row.complexityPct = g.complexityPct;
      row.overrideMdPerSite = g.overrideMdPerSite;
      if (g.sitesDetail.length) row.sitesDetail = g.sitesDetail;
      return { row: row, offered: g.offered };
    });

    return {
      ok: true,
      rows: out.map(function (o) { return o.row; }),
      notOffered: out.filter(function (o) { return !o.offered; }).length,
      overrides: out.filter(function (o) { return o.row.overrideMdPerSite > 0; }).length,
      totalSites: totalSites,
      linesUsed: used,
      namedSites: named,
      skipped: skipped,
      warnings: warnings,
      unknown: unknown
    };
  }

  global.FTEImport = {
    ROLES: ROLES,
    SIDE_ROLES: SIDE_ROLES,
    readFile: readFile,
    parseCsv: parseCsv,
    detectHeader: detectHeader,
    guessMapping: guessMapping,
    build: build,
    matchProduct: function (v) { return matchValue(v, PRODUCT_INDEX); },
    matchMode: function (v) { return matchValue(v, MODE_INDEX); },
    matchTier: matchTier,
    parseNum: parseNum,
    parseComplexity: parseComplexity
  };
})(window);
