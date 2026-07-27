/* ===========================================================================
   export.js - Excel workbooks.

   Built on ExcelJS rather than SheetJS because the community build of SheetJS
   cannot write cell formatting or real Excel table objects, which is most of
   what makes a sheet readable.

   Every sheet is built from a saved record snapshot and never from live form
   fields. That is deliberate: reading the form at export time means changing
   any input after pressing Calculate produces a workbook whose header
   describes one project and whose numbers describe another.
   =========================================================================== */
(function (global) {
  'use strict';

  var D = global.FTEData;

  function available() { return typeof ExcelJS !== 'undefined'; }

  /* ---------------------------------------------------------- palette --- */

  var INK       = 'FF0F172A';
  var MUTED     = 'FF64748B';
  var ACCENT    = 'FF1D4ED8';
  var ACCENT_BG = 'FFEFF6FF';
  var BAND_BG   = 'FFF8FAFC';
  var LINE      = 'FFCBD5E1';
  var WHITE     = 'FFFFFFFF';

  var FMT = {
    md:    '#,##0.000',
    md1:   '#,##0.0',
    fte:   '0.00',
    int:   '#,##0',
    pct:   '0.0"%"',
    pct0:  '0"%"',
    date:  'yyyy-mm-dd hh:mm'
  };

  /* ------------------------------------------------------------ helpers -- */

  var _tableSeq = 0;
  /* Excel defined names cannot contain spaces and must be unique per book. */
  function tableName(hint) {
    _tableSeq += 1;
    return 'tbl' + String(hint || 'Data').replace(/[^A-Za-z0-9]/g, '') + _tableSeq;
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function safeName(s) {
    return String(s || 'report').replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'report';
  }

  function newBook() {
    var wb = new ExcelJS.Workbook();
    wb.creator = 'DPM FTE Calculator ' + D.APP_VERSION;
    wb.created = new Date();
    return wb;
  }

  function newSheet(wb, name, widths) {
    var ws = wb.addWorksheet(name.slice(0, 31), {
      views: [{ showGridLines: false }],
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    ws.columns = widths.map(function (w) { return { width: w }; });
    return ws;
  }

  /** Banner across the top of a sheet: what this is, and which project. */
  function titleBlock(ws, lastCol, title, subtitle, meta) {
    ws.mergeCells(1, 1, 1, lastCol);
    var t = ws.getCell(1, 1);
    t.value = title;
    t.font = { bold: true, size: 15, color: { argb: WHITE } };
    t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ACCENT } };
    t.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(1).height = 30;

    ws.mergeCells(2, 1, 2, lastCol);
    var s = ws.getCell(2, 1);
    s.value = subtitle;
    s.font = { bold: true, size: 12, color: { argb: INK } };
    s.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(2).height = 20;

    ws.mergeCells(3, 1, 3, lastCol);
    var m = ws.getCell(3, 1);
    m.value = meta;
    m.font = { size: 9, color: { argb: MUTED } };
    m.alignment = { vertical: 'middle', indent: 1 };
    ws.getRow(3).height = 16;
  }

  /* The headline the whole workbook exists to communicate. Rendered as a
     bordered strip of big figures so the FTE is impossible to miss. */
  function kpiBand(ws, startRow, cells) {
    var labelRow = ws.getRow(startRow);
    var valueRow = ws.getRow(startRow + 1);
    var noteRow  = ws.getRow(startRow + 2);
    labelRow.height = 16; valueRow.height = 30; noteRow.height = 14;

    cells.forEach(function (c, i) {
      var col = i + 1;

      var l = labelRow.getCell(col);
      l.value = c.label.toUpperCase();
      l.font = { bold: true, size: 8, color: { argb: MUTED } };
      l.alignment = { horizontal: 'center', vertical: 'middle' };
      l.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.highlight ? ACCENT_BG : BAND_BG } };
      l.border = { top: { style: 'thin', color: { argb: LINE } }, left: { style: 'thin', color: { argb: LINE } }, right: { style: 'thin', color: { argb: LINE } } };

      var v = valueRow.getCell(col);
      v.value = c.value;
      if (c.format) v.numFmt = c.format;
      v.font = { bold: true, size: c.highlight ? 20 : 14, color: { argb: c.highlight ? ACCENT : INK } };
      v.alignment = { horizontal: 'center', vertical: 'middle' };
      v.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.highlight ? ACCENT_BG : BAND_BG } };
      v.border = { left: { style: 'thin', color: { argb: LINE } }, right: { style: 'thin', color: { argb: LINE } } };

      var n = noteRow.getCell(col);
      n.value = c.note || '';
      n.font = { size: 8, color: { argb: MUTED } };
      n.alignment = { horizontal: 'center', vertical: 'middle' };
      n.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.highlight ? ACCENT_BG : BAND_BG } };
      n.border = { bottom: { style: 'thin', color: { argb: LINE } }, left: { style: 'thin', color: { argb: LINE } }, right: { style: 'thin', color: { argb: LINE } } };
    });

    return startRow + 3;
  }

  function sectionLabel(ws, row, text) {
    var c = ws.getCell(row, 1);
    c.value = text.toUpperCase();
    c.font = { bold: true, size: 9, color: { argb: ACCENT } };
    ws.getRow(row).height = 18;
    return row + 1;
  }

  /**
   * Add a real Excel table (filter buttons, banded rows, a proper header).
   * `columns` entries: { name, width?, numFmt?, total? }
   * Returns the next free row.
   */
  function addTable(ws, opts) {
    var startRow = opts.row;
    var columns = opts.columns;
    var rows = opts.rows;

    ws.addTable({
      name: tableName(opts.hint || opts.name),
      ref: ws.getCell(startRow, 1).address,
      headerRow: true,
      totalsRow: !!opts.totals,
      style: { theme: opts.theme || 'TableStyleMedium2', showRowStripes: true },
      columns: columns.map(function (c) {
        var def = { name: c.name, filterButton: opts.filter !== false };
        if (opts.totals) {
          if (c.total === 'label') { def.totalsRowLabel = c.totalLabel || 'Total'; }
          else if (c.total) { def.totalsRowFunction = c.total; }
          else { def.totalsRowFunction = 'none'; }
        }
        return def;
      }),
      rows: rows
    });

    /* Number formats and alignment are applied after the fact: addTable only
       carries values, not presentation. */
    var bodyRows = rows.length + (opts.totals ? 1 : 0);
    columns.forEach(function (c, i) {
      var col = i + 1;
      var header = ws.getCell(startRow, col);
      header.alignment = { horizontal: c.align || (c.numFmt ? 'right' : 'left'), vertical: 'middle', wrapText: true };
      for (var r = 1; r <= bodyRows; r++) {
        var cell = ws.getCell(startRow + r, col);
        if (c.numFmt) cell.numFmt = c.numFmt;
        cell.alignment = { horizontal: c.align || (c.numFmt ? 'right' : 'left'), vertical: 'middle' };
      }
    });
    ws.getRow(startRow).height = 26;

    return startRow + bodyRows + 2;
  }

  /** Two-column Field / Value table - the shape most of the summary uses. */
  function addFactTable(ws, row, heading, facts, opts) {
    var next = sectionLabel(ws, row, heading);
    return addTable(ws, {
      row: next,
      hint: heading,
      filter: false,
      theme: (opts && opts.theme) || 'TableStyleLight9',
      columns: [
        { name: 'Field', width: 34 },
        { name: 'Value', width: 30 },
        { name: 'Note', width: 52 }
      ],
      rows: facts
    });
  }

  function note(ws, row, text) {
    var c = ws.getCell(row, 1);
    c.value = text;
    c.font = { size: 9, italic: true, color: { argb: MUTED } };
    return row + 1;
  }

  /* ExcelJS writes a buffer; the browser still needs to be handed a file. */
  function save(wb, filename) {
    return wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      return filename;
    });
  }

  function fail(err) {
    console.error(err);
    global.UI.toast('The workbook could not be created: ' + (err && err.message ? err.message : err), 'err');
  }

  /* ------------------------------------------------------- chart images -- */

  /* ExcelJS cannot author native Excel charts, so the graphs are rendered with
     the Chart.js already loaded for the app and embedded as PNG images. With
     animation off, Chart.js draws synchronously on construction, so the canvas
     can be read back immediately. Colours are fixed to the light palette
     because the sheet background is always white. */
  var CH = {
    ink: '#334155', grid: '#e2e8f0', bar: '#3b82f6', peak: '#ef4444',
    line: '#16a34a', avg: '#94a3b8'
  };

  /* Paints a white backdrop so the PNG is not transparent when printed. */
  var whiteBg = {
    id: 'whiteBg',
    beforeDraw: function (c) {
      var ctx = c.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.restore();
    }
  };

  function chartToPng(config, w, h) {
    if (typeof Chart === 'undefined' || typeof document === 'undefined') return null;
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var chart = null;
    try {
      chart = new Chart(canvas.getContext('2d'), config);
      var url = canvas.toDataURL('image/png');
      return url.substring(url.indexOf(',') + 1);
    } catch (e) {
      console.error('chart render failed', e);
      return null;
    } finally {
      if (chart) chart.destroy();
    }
  }

  /* Place a rendered chart, sized in pixels, anchored to a cell. Returns the
     row a following block should start on, leaving room for the image. */
  function placeChart(wb, ws, base64, col, row, width, height) {
    if (!base64) return row + 2;
    var id = wb.addImage({ base64: base64, extension: 'png' });
    ws.addImage(id, { tl: { col: col, row: row }, ext: { width: width, height: height } });
    return row + Math.ceil(height / 20) + 2;   // default row is ~20px tall
  }

  /* A lightweight in-cell bar, so the distribution reads at a glance even in a
     printed table with no image. */
  function barText(value, max, width) {
    width = width || 12;
    if (!(max > 0)) return '';
    var filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
    var out = '';
    for (var i = 0; i < filled; i++) out += '█';
    for (var j = 0; j < width - filled; j++) out += '░';
    return out;
  }

  /* ------------------------------------------------------ shared sheets -- */

  /* usingSchedule kept for records saved before the bell-curve change. */
  function isShaped(r) { return !!(r.usingBell || r.usingSchedule); }

  function headlineCells(record) {
    var r = record.results, i = record.inputs;
    if (isShaped(r)) {
      /* With a bell curve the peak is the number you staff to, so it leads and
         is highlighted; the average sits beside it for budgeting. */
      return [
        { label: 'Peak FTE', value: r.peakFte, format: FMT.fte, highlight: true,
          note: 'busiest month (month ' + r.peakMonth + ')' },
        { label: 'Peak headcount', value: r.peakHeadcount, format: FMT.int, note: 'people at the peak' },
        { label: 'FTE (average)', value: r.fte, format: FMT.fte, note: 'levelled over ' + i.months + ' months' },
        { label: 'Headcount (avg)', value: r.headcount, format: FMT.int, note: 'average team' },
        { label: 'Total effort', value: r.totalMd, format: FMT.md, note: 'man-days' },
        { label: 'Total sites', value: i.totalSites, format: FMT.int, note: 'in scope' }
      ];
    }
    return [
      { label: 'FTE required', value: r.fte, format: FMT.fte, highlight: true,
        note: 'at ' + i.capacityMdPerMonth + ' MD per DPM per month' },
      { label: 'Headcount', value: r.headcount, format: FMT.int, note: 'FTE rounded up' },
      { label: 'Utilisation', value: r.utilisationPct, format: FMT.pct, note: 'how loaded the team is' },
      { label: 'Total effort', value: r.totalMd, format: FMT.md, note: 'man-days' },
      { label: 'Effort per month', value: r.mdPerMonth, format: FMT.md, note: 'over ' + i.months + ' months' },
      { label: 'Total sites', value: i.totalSites, format: FMT.int, note: 'in scope' }
    ];
  }

  function rateCardSheet(wb, record) {
    var row;
    if (record.type === 'WAN') {
      var ws = newSheet(wb, 'Rate card', [30].concat(D.PRODUCTS.map(function () { return 17; })));
      titleBlock(ws, D.PRODUCTS.length + 1, 'WAN RATE CARD',
        'Base effort in man-days per site',
        'These are the published rates the estimate was priced from, before any complexity multiplier.');
      row = 5;
      row = addTable(ws, {
        row: row, hint: 'WanRates', filter: false, theme: 'TableStyleMedium9',
        columns: [{ name: 'Connectivity mode', width: 30 }].concat(D.PRODUCTS.map(function (p) {
          return { name: p, numFmt: FMT.md, align: 'right' };
        })),
        rows: D.CONNECTIVITY_MODES.map(function (mode) {
          return [mode].concat(D.PRODUCTS.map(function (p) {
            var v = D.lookupBaseMd(mode, p);
            return v === null ? 'n/a' : v;
          }));
        })
      });
      note(ws, row, 'n/a means that product is not offered with that connectivity mode - it does not mean zero effort.');
    } else {
      var ls = newSheet(wb, 'Rate card', [22, 26, 22, 22]);
      titleBlock(ls, 4, 'LAN RATE CARD',
        'Base effort by device tier',
        'A site\'s tier is decided by how many network devices it contains.');
      row = addTable(ls, {
        row: 5, hint: 'LanRates', filter: false, theme: 'TableStyleMedium9',
        columns: [
          { name: 'Tier', width: 22 },
          { name: 'Device range', width: 26 },
          { name: 'Base effort (MD per site)', numFmt: FMT.md, align: 'right' },
          { name: 'Equivalent hours', numFmt: FMT.md1, align: 'right' }
        ],
        rows: D.LAN_TIERS.map(function (t) { return [t.name, t.range, t.loe, t.loe * D.HOURS_PER_DAY]; })
      });

      var stages = (record.inputs || {}).stages || [];
      if (stages.length) {
        row = sectionLabel(ls, row, 'Stage hours per site - ' + stages.join(', '));
        addTable(ls, {
          row: row, hint: 'StageHours', filter: false, theme: 'TableStyleLight9',
          columns: [{ name: 'Stage', width: 16 }, { name: 'Activity', width: 44 }]
            .concat(D.LAN_TIERS.map(function (t) { return { name: t.name, numFmt: FMT.md1, align: 'right' }; })),
          rows: stages.reduce(function (acc, stage) {
            var acts = D.STAGE_HOURS[stage] || {};
            Object.keys(acts).forEach(function (act) {
              acc.push([stage, act].concat(D.LAN_TIERS.map(function (t) {
                var v = acts[act][t.key];
                return typeof v === 'number' ? v : 0;
              })));
            });
            return acc;
          }, [])
        });
      }
    }
  }

  function dpmSheet(wb, record) {
    if (!(record.dpms || []).length) return;
    var ws = newSheet(wb, 'DPM allocation', [30, 44, 20]);
    titleBlock(ws, 3, 'ASSIGNED DPMS', record.projectName,
      'Recorded for reporting. DPM assignments do not change the calculated effort.');
    addTable(ws, {
      row: 5, hint: 'Dpms', theme: 'TableStyleMedium2',
      columns: [{ name: 'Name', width: 30 }, { name: 'Email', width: 44 }, { name: 'Role', width: 20 }],
      rows: record.dpms.map(function (d) { return [d.name, d.email, d.role || 'DPM']; })
    });
  }

  /* ------------------------------------------------ monthly distribution -- */

  /* The month-by-month view the effort is spread over. Always available (even
     the flat case produces one bucket per month), and genuinely useful once the
     bell-curve distribution turns it into a ramp. A numeric table plus two
     embedded graphs: effort with a cumulative-delivery curve, and the FTE each
     month against the average - which is exactly what the bell curve reveals. */
  function monthlyDistributionSheet(wb, record) {
    var r = record.results, i = record.inputs;
    var monthly = r.monthly || [];
    if (!monthly.length) return;

    var bell = !!(r.usingBell || r.usingSchedule);
    var total = r.totalMd || 0;
    var maxMd = monthly.reduce(function (m, x) { return Math.max(m, x.md); }, 0);
    var peakMonth = r.peakMonth || 0;
    var avgFte = r.fte || 0;

    var lastCol = 7;
    var ws = newSheet(wb, 'Monthly distribution', [10, 16, 12, 16, 12, 16, 14]);

    titleBlock(ws, lastCol, 'MONTHLY DISTRIBUTION', record.projectName,
      (bell
        ? 'Man-days follow a bell curve — the mid-project peak drives the staffing.'
        : 'Man-days spread evenly across the duration — switch to the bell curve to model a ramp.') +
      '   ·   ' + record.projectCode + '   ·   ' + record.type);

    var row = kpiBand(ws, 5, bell ? [
      { label: 'Peak FTE', value: r.peakFte, format: FMT.fte, highlight: true, note: 'busiest month' },
      { label: 'Busiest month', value: peakMonth, format: FMT.int, note: 'month number' },
      { label: 'Peak effort', value: r.peakMd, format: FMT.md, note: 'MD that month' },
      { label: 'FTE (average)', value: avgFte, format: FMT.fte, note: 'levelled' },
      { label: 'Total effort', value: total, format: FMT.md, note: 'man-days' },
      { label: 'Months', value: monthly.length, format: FMT.int, note: 'in the plan' }
    ] : [
      { label: 'FTE required', value: avgFte, format: FMT.fte, highlight: true, note: 'even spread' },
      { label: 'Effort per month', value: r.mdPerMonth, format: FMT.md, note: 'man-days' },
      { label: 'Total effort', value: total, format: FMT.md, note: 'man-days' },
      { label: 'Duration', value: i.months, format: FMT.md1, note: 'months' },
      { label: 'Total sites', value: i.totalSites, format: FMT.int, note: 'in scope' },
      { label: 'Months', value: monthly.length, format: FMT.int, note: 'buckets' }
    ]) + 1;

    /* ---- the numbers ---- */
    var cum = 0;
    var tableRows = monthly.map(function (m) {
      cum += m.md;
      var share = total > 0 ? round2(m.md / total * 100) : 0;
      var cumPct = total > 0 ? round2(cum / total * 100) : 0;
      return ['Month ' + m.month, m.md, m.fte, barText(m.md, maxMd), share, round2(cum), cumPct];
    });

    var columns = [
      { name: 'Month', width: 10, total: 'label', totalLabel: 'TOTAL' },
      { name: 'Effort (MD)', numFmt: FMT.md, align: 'right', total: 'sum' },
      { name: 'FTE', numFmt: FMT.fte, align: 'right' },
      { name: 'Load', width: 16, align: 'left' },
      { name: 'Share', numFmt: FMT.pct, align: 'right' },
      { name: 'Cumulative MD', numFmt: FMT.md, align: 'right' },
      { name: 'Cumulative', numFmt: FMT.pct, align: 'right' }
    ];

    row = addTable(ws, {
      row: row, hint: 'Monthly', theme: 'TableStyleMedium2', totals: true,
      columns: columns, rows: tableRows
    });
    row = note(ws, row, bell
      ? 'The man-days follow a normal distribution centred on the middle of the project.'
      : 'A partial final month (from a fractional duration) carries only its share of a month.');
    row += 1;

    /* ---- the graphs ---- */
    row = sectionLabel(ws, row, 'Visualisation');

    var labels = monthly.map(function (m) { return 'M' + m.month; });
    var mds = monthly.map(function (m) { return m.md; });
    var ftes = monthly.map(function (m) { return m.fte; });
    var cumPctSeries = [];
    var running = 0;
    monthly.forEach(function (m) { running += m.md; cumPctSeries.push(total > 0 ? round2(running / total * 100) : 0); });
    var barColours = monthly.map(function (m) {
      return (bell && m.month === peakMonth) ? CH.peak : CH.bar;
    });

    var combo = chartToPng({
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { type: 'bar', label: 'Man-days', data: mds, backgroundColor: barColours,
            borderRadius: 3, yAxisID: 'y', order: 2 },
          { type: 'line', label: 'Cumulative delivery %', data: cumPctSeries,
            borderColor: CH.line, backgroundColor: CH.line, tension: 0.25, pointRadius: 3,
            yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        responsive: false, animation: false, devicePixelRatio: 1,
        layout: { padding: 8 },
        plugins: {
          legend: { labels: { color: CH.ink, font: { size: 13 } } },
          title: { display: true, text: 'Effort per month and cumulative delivery', color: CH.ink, font: { size: 16, weight: 'bold' } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: CH.ink, font: { size: 12 } } },
          y: { beginAtZero: true, title: { display: true, text: 'Man-days', color: CH.ink }, ticks: { color: CH.ink }, grid: { color: CH.grid } },
          y1: { position: 'right', beginAtZero: true, suggestedMax: 100, title: { display: true, text: 'Cumulative %', color: CH.ink }, ticks: { color: CH.ink }, grid: { drawOnChartArea: false } }
        }
      },
      plugins: [whiteBg]
    }, 1400, 540);

    var fteChart = chartToPng({
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { type: 'bar', label: 'FTE that month', data: ftes, backgroundColor: barColours, borderRadius: 3, order: 2 },
          { type: 'line', label: 'Average FTE (' + round2(avgFte) + ')', data: labels.map(function () { return avgFte; }),
            borderColor: CH.avg, borderDash: [6, 4], borderWidth: 2, pointRadius: 0, order: 1 }
        ]
      },
      options: {
        responsive: false, animation: false, devicePixelRatio: 1,
        layout: { padding: 8 },
        plugins: {
          legend: { labels: { color: CH.ink, font: { size: 13 } } },
          title: { display: true, text: bell ? 'FTE needed each month vs. the average' : 'FTE per month (even spread)', color: CH.ink, font: { size: 16, weight: 'bold' } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: CH.ink, font: { size: 12 } } },
          y: { beginAtZero: true, title: { display: true, text: 'FTE', color: CH.ink }, ticks: { color: CH.ink }, grid: { color: CH.grid } }
        }
      },
      plugins: [whiteBg]
    }, 1400, 500);

    row = placeChart(wb, ws, combo, 0, row, 770, 297);
    row = placeChart(wb, ws, fteChart, 0, row, 770, 275);

    if (bell) {
      note(ws, row, 'The gap between the tallest bar and the dashed average line is the staffing the flat view hides.');
    }
  }

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  /* ---------------------------------------------------------- WAN / LAN -- */

  function buildRecordBook(record) {
    var wb = newBook();
    var r = record.results, i = record.inputs;
    var isWan = record.type === 'WAN';

    /* ---- Summary ---- */
    var ws = newSheet(wb, 'Summary', [34, 30, 52, 22, 22, 22]);
    titleBlock(ws, 6,
      record.type + ' FTE ESTIMATE',
      record.projectName,
      record.projectCode + '   ·   record ' + record.id + '   ·   calculated ' +
        new Date(record.savedAt).toLocaleString());

    var row = kpiBand(ws, 5, headlineCells(record)) + 1;

    row = addFactTable(ws, row, 'Project', [
      ['Project name', record.projectName, ''],
      ['Project code', record.projectCode, 'Stable identifier - the same for every estimate of this project'],
      ['Record ID', record.id, 'Unique to this one calculation'],
      ['Calculated at', new Date(record.savedAt).toLocaleString(), ''],
      ['Estimate type', record.type, isWan ? 'Wide-area network rollout' : 'Local-area network rollout']
    ]);

    var inputFacts = [
      ['Calculation mode', i.mode, i.mode === 'Standard' ? 'Rates taken from the published rate card' : 'Rates supplied per row'],
      ['Duration (months)', i.months, 'Effort is spread evenly across this period'],
      ['Start date', i.startDate || '-', ''],
      ['End date', i.endDate || '-', ''],
      ['Total sites', i.totalSites, ''],
      ['DPM monthly capacity (MD)', i.capacityMdPerMonth, 'Divides the monthly workload to give FTE']
    ];
    if (isWan) {
      inputFacts.splice(5, 0, ['Migration support', i.migration,
        i.migration === 'Yes' ? 'Adds ' + i.migrationMdPerSite + ' MD per site' : 'No uplift applied']);
    } else {
      inputFacts.splice(5, 0, ['Stages in scope', (i.stages || []).join(', ') || '-', 'By Stage mode only']);
      inputFacts.splice(6, 0, ['Priced from', r.usedTierRows ? 'Tier rows' : ('Fallback tier ' + (r.fallbackTier || '')),
        r.usedTierRows ? 'Each tier row priced separately' : 'All sites priced at one tier']);
    }
    inputFacts.push(['Effort distribution',
      isShaped(r) ? 'Bell curve (normal)' : 'Flat (even)',
      isShaped(r) ? 'Man-days ramp to a mid-project peak and back down'
                  : 'Man-days spread evenly across the duration']);
    row = addFactTable(ws, row, 'Inputs that affect the result', inputFacts);

    var resultFacts = [
      ['Total effort (MD)', r.totalMd, 'Sum of every allocation row' + (isWan && r.migrationMd ? ' plus the migration uplift' : '')],
      [isShaped(r) ? 'Average effort per month (MD)' : 'Effort per month (MD)', r.mdPerMonth, r.totalMd + ' MD / ' + i.months + ' months'],
      [isShaped(r) ? 'FTE (average)' : 'FTE required', r.fte, r.mdPerMonth + ' MD per month / ' + i.capacityMdPerMonth + ' MD capacity'],
      ['Headcount', r.headcount, 'FTE rounded up to whole people'],
      ['Utilisation (%)', r.utilisationPct, r.fte + ' FTE / ' + r.headcount + ' headcount']
    ];
    if (isWan) {
      resultFacts.unshift(['Migration uplift (MD)', r.migrationMd, i.migration === 'Yes'
        ? (i.migrationMdPerSite + ' MD x ' + i.totalSites + ' sites') : 'Not in scope']);
      resultFacts.unshift(['Base effort (MD)', r.baseMd, 'Allocation rows only']);
    }
    if (isShaped(r)) {
      resultFacts.push(['Busiest month', 'Month ' + r.peakMonth, 'Peak of the bell curve']);
      resultFacts.push(['Peak effort per month (MD)', r.peakMd, 'The busiest month of the curve']);
      resultFacts.push(['Peak FTE', r.peakFte, r.peakMd + ' MD / ' + i.capacityMdPerMonth + ' MD capacity — staff to this']);
      resultFacts.push(['Peak headcount', r.peakHeadcount, 'Peak FTE rounded up — the largest team the curve needs']);
    }
    row = addFactTable(ws, row, 'Result', resultFacts, { theme: 'TableStyleLight11' });

    var recorded = isWan
      ? [['Project status', record.status, 'Reporting only'],
         ['Project type', i.projectType, 'Reporting only'],
         ['ABACOS', i.abacos, 'Reporting only'],
         ['DPM acting as PM', i.pmRole, 'Reporting only']]
      : [['Project status', record.status, 'Reporting only'],
         ['FLAN used', i.flan, 'Reporting only'],
         ['Device count', i.devices, 'Only used when no tier rows were entered'],
         ['DPM acting as PM', i.pmRole, 'Reporting only']];
    row = addFactTable(ws, row, 'Recorded only - does not affect the result', recorded, { theme: 'TableStyleLight10' });
    note(ws, row, 'Every figure above was frozen when Calculate was pressed, so this workbook always describes one single calculation.');

    /* ---- Allocation ---- */
    var as = newSheet(wb, 'Allocation', isWan ? [6, 26, 26, 12, 14, 18, 20, 18, 14] : [6, 30, 12, 14, 18, 24, 18, 14]);
    var lastCol = isWan ? 9 : 8;
    titleBlock(as, lastCol, 'SITE ALLOCATION', record.projectName,
      'Row effort = base rate x complexity x sites.   ' + record.projectCode +
      '   ·   ' + record.type + '   ·   ' + i.mode + ' mode');

    var arow = kpiBand(as, 5, isShaped(r) ? [
      { label: 'Peak FTE', value: r.peakFte, format: FMT.fte, highlight: true, note: 'busiest month' },
      { label: 'FTE (average)', value: r.fte, format: FMT.fte, note: 'levelled' },
      { label: 'Total effort', value: r.totalMd, format: FMT.md, note: 'man-days' },
      { label: 'Allocation rows', value: r.rows.length, format: FMT.int, note: 'groups of sites' },
      { label: 'Total sites', value: i.totalSites, format: FMT.int, note: 'in scope' },
      { label: 'Duration', value: i.months, format: FMT.md1, note: 'months' }
    ] : [
      { label: 'FTE required', value: r.fte, format: FMT.fte, highlight: true, note: 'for this project' },
      { label: 'Headcount', value: r.headcount, format: FMT.int, note: 'people' },
      { label: 'Total effort', value: r.totalMd, format: FMT.md, note: 'man-days' },
      { label: 'Allocation rows', value: r.rows.length, format: FMT.int, note: 'groups of sites' },
      { label: 'Total sites', value: i.totalSites, format: FMT.int, note: 'in scope' },
      { label: 'Duration', value: i.months, format: FMT.md1, note: 'months' }
    ]) + 1;

    if (isWan) {
      arow = addTable(as, {
        row: arow, hint: 'WanAllocation', theme: 'TableStyleMedium2', totals: true,
        columns: [
          /* Exactly one column may carry the totals label, or Excel ends up
             with a stray default "Total" in a neighbouring cell. */
          { name: '#', width: 6, align: 'center', total: 'label', totalLabel: 'TOTAL' },
          { name: 'Product', width: 26 },
          { name: 'Connectivity mode', width: 26 },
          { name: 'Sites', numFmt: FMT.int, align: 'right', total: 'sum' },
          { name: 'Complexity', numFmt: FMT.pct0, align: 'right' },
          { name: 'Base rate (MD/site)', numFmt: FMT.md, align: 'right' },
          { name: 'Rate source', width: 20 },
          { name: 'Row effort (MD)', numFmt: FMT.md, align: 'right', total: 'sum' },
          { name: 'Share', numFmt: FMT.pct, align: 'right' }
        ],
        rows: r.rows.map(function (x, n) {
          return [n + 1, x.product, x.connectivityMode, x.sites, x.complexityPct,
                  x.baseMdPerSite, x.rateSource, x.md, x.pctOfTotal];
        })
      });
    } else {
      arow = addTable(as, {
        row: arow, hint: 'LanAllocation', theme: 'TableStyleMedium2', totals: true,
        columns: [
          { name: '#', width: 6, align: 'center', total: 'label', totalLabel: 'TOTAL' },
          { name: 'Tier', width: 30 },
          { name: 'Sites', numFmt: FMT.int, align: 'right', total: 'sum' },
          { name: 'Complexity', numFmt: FMT.pct0, align: 'right' },
          { name: 'Base rate (MD/site)', numFmt: FMT.md, align: 'right' },
          { name: 'Rate source', width: 24 },
          { name: 'Row effort (MD)', numFmt: FMT.md, align: 'right', total: 'sum' },
          { name: 'Share', numFmt: FMT.pct, align: 'right' }
        ],
        rows: r.rows.map(function (x, n) {
          return [n + 1, x.label, x.sites, x.complexityPct, x.baseMdPerSite, x.rateSource, x.md, x.pctOfTotal];
        })
      });
    }

    /* The table above totals the allocation rows only. When a migration uplift
       applies, that total is deliberately smaller than the project total shown
       at the top of the sheet, so say so rather than leave two figures that
       look like they disagree. */
    if (isWan && r.migrationMd > 0) {
      arow = note(as, arow, 'The TOTAL row above is the base effort from the allocation rows (' + r.baseMd +
        ' MD). Migration support adds a further ' + r.migrationMd + ' MD across ' + i.totalSites +
        ' sites, giving ' + r.totalMd + ' MD for the project.');
      arow += 1;
    }

    /* The number the reader came for, restated beside the detail that produced it. */
    arow = sectionLabel(as, arow, 'FTE for this project');
    arow = addTable(as, {
      row: arow, hint: 'AllocFte', filter: false, theme: 'TableStyleLight11',
      columns: [
        { name: 'Measure', width: 34 },
        { name: 'Value', width: 18, numFmt: FMT.md, align: 'right' },
        { name: 'How it was derived', width: 52 }
      ],
      rows: [
        ['Total effort (MD)', r.totalMd, (isWan && r.migrationMd > 0)
          ? ('Allocation rows ' + r.baseMd + ' MD + migration uplift ' + r.migrationMd + ' MD')
          : 'Sum of the Row effort column above'],
        ['Effort per month (MD)', r.mdPerMonth, r.totalMd + ' MD / ' + i.months + ' months'],
        ['FTE required', r.fte, r.mdPerMonth + ' MD per month / ' + i.capacityMdPerMonth + ' MD capacity per DPM'],
        ['Headcount', r.headcount, 'FTE rounded up to whole people'],
        ['Utilisation (%)', r.utilisationPct, r.fte + ' FTE / ' + r.headcount + ' headcount']
      ]
    });
    if ((r.warnings || []).length) {
      r.warnings.forEach(function (w) { arow = note(as, arow, 'Note: ' + w); });
    }

    monthlyDistributionSheet(wb, record);
    rateCardSheet(wb, record);
    dpmSheet(wb, record);
    return wb;
  }

  function exportRecord(record) {
    if (!record) { global.UI.toast('Nothing to export.', 'warn'); return Promise.resolve(); }
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return Promise.resolve(); }
    try {
      var wb = buildRecordBook(record);
      return save(wb, record.type + '_' + safeName(record.projectName) + '_' + stamp() + '.xlsx')
        .then(function () { global.UI.toast(record.type + ' workbook exported.', 'ok'); })
        .catch(fail);
    } catch (err) { fail(err); return Promise.resolve(); }
  }

  /* ------------------------------------------------------- all records --- */

  function exportAllRecords(records) {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return Promise.resolve(); }
    if (!records || !records.length) { global.UI.toast('There are no records to export.', 'warn'); return Promise.resolve(); }

    try {
      var wb = newBook();
      var totalMd = records.reduce(function (t, r) { return t + (r.results.totalMd || 0); }, 0);
      var totalSites = records.reduce(function (t, r) { return t + (r.inputs.totalSites || 0); }, 0);
      var peakFte = records.reduce(function (m, r) { return Math.max(m, r.results.fte || 0); }, 0);

      var ws = newSheet(wb, 'All estimates', [26, 18, 12, 12, 30, 12, 12, 14, 14, 12, 12, 14]);
      titleBlock(ws, 12, 'FTE RECORDS', records.length + ' saved calculation(s)',
        'Exported ' + new Date().toLocaleString() + '. Each row is one calculation, frozen at the moment it was run.');

      var row = kpiBand(ws, 5, [
        { label: 'Estimates', value: records.length, format: FMT.int, highlight: true, note: 'in this export' },
        { label: 'Combined effort', value: totalMd, format: FMT.md1, note: 'man-days' },
        { label: 'Highest FTE', value: peakFte, format: FMT.fte, note: 'single estimate' },
        { label: 'Total sites', value: totalSites, format: FMT.int, note: 'across all' },
        { label: 'WAN', value: records.filter(function (r) { return r.type === 'WAN'; }).length, format: FMT.int, note: 'estimates' },
        { label: 'LAN', value: records.filter(function (r) { return r.type === 'LAN'; }).length, format: FMT.int, note: 'estimates' }
      ]) + 1;

      row = addTable(ws, {
        row: row, hint: 'AllRecords', theme: 'TableStyleMedium2', totals: true,
        columns: [
          { name: 'Project name', width: 26, total: 'label', totalLabel: 'TOTAL' },
          { name: 'Project code', width: 18 },
          { name: 'Type', width: 10, align: 'center' },
          { name: 'Status', width: 12, align: 'center' },
          { name: 'Calculated at', width: 22 },
          { name: 'Months', numFmt: FMT.md1, align: 'right' },
          { name: 'Sites', numFmt: FMT.int, align: 'right', total: 'sum' },
          { name: 'Total MD', numFmt: FMT.md, align: 'right', total: 'sum' },
          { name: 'MD / month', numFmt: FMT.md, align: 'right' },
          { name: 'FTE', numFmt: FMT.fte, align: 'right', total: 'max' },
          { name: 'Headcount', numFmt: FMT.int, align: 'right' },
          { name: 'Utilisation', numFmt: FMT.pct, align: 'right' }
        ],
        rows: records.map(function (rec) {
          var i = rec.inputs || {}, r = rec.results || {};
          return [rec.projectName, rec.projectCode, rec.type, rec.status || '-',
                  new Date(rec.savedAt).toLocaleString(), i.months, i.totalSites,
                  r.totalMd, r.mdPerMonth, r.fte, r.headcount, r.utilisationPct];
        })
      });
      note(ws, row, 'The FTE total column shows the highest single estimate, not a sum - FTE from different projects cannot simply be added.');

      var ds = newSheet(wb, 'All allocation rows', [26, 10, 34, 12, 14, 18, 20, 18, 12]);
      titleBlock(ds, 9, 'ALLOCATION DETAIL', 'Every row from every estimate',
        'Row effort = base rate x complexity x sites.');
      addTable(ds, {
        row: 5, hint: 'AllRows', theme: 'TableStyleMedium2', totals: true,
        columns: [
          { name: 'Project name', width: 26, total: 'label', totalLabel: 'TOTAL' },
          { name: 'Type', width: 10, align: 'center' },
          { name: 'Row', width: 34 },
          { name: 'Sites', numFmt: FMT.int, align: 'right', total: 'sum' },
          { name: 'Complexity', numFmt: FMT.pct0, align: 'right' },
          { name: 'Base rate (MD/site)', numFmt: FMT.md, align: 'right' },
          { name: 'Rate source', width: 20 },
          { name: 'Row effort (MD)', numFmt: FMT.md, align: 'right', total: 'sum' },
          { name: 'Share', numFmt: FMT.pct, align: 'right' }
        ],
        rows: records.reduce(function (acc, rec) {
          ((rec.results || {}).rows || []).forEach(function (x) {
            acc.push([rec.projectName, rec.type,
                      x.label + (x.connectivityMode ? ' / ' + x.connectivityMode : ''),
                      x.sites, x.complexityPct, x.baseMdPerSite, x.rateSource, x.md, x.pctOfTotal]);
          });
          return acc;
        }, [])
      });

      var people = records.reduce(function (acc, rec) {
        (rec.dpms || []).forEach(function (d) {
          acc.push([rec.projectName, rec.projectCode, d.name, d.email, d.role || 'DPM']);
        });
        return acc;
      }, []);
      if (people.length) {
        var ps = newSheet(wb, 'DPM assignments', [26, 18, 28, 42, 16]);
        titleBlock(ps, 5, 'DPM ASSIGNMENTS', 'Across all exported estimates',
          'Recorded for reporting. Assignments do not change the calculated effort.');
        addTable(ps, {
          row: 5, hint: 'AllDpms', theme: 'TableStyleMedium2',
          columns: [
            { name: 'Project name', width: 26 }, { name: 'Project code', width: 18 },
            { name: 'Name', width: 28 }, { name: 'Email', width: 42 }, { name: 'Role', width: 16 }
          ],
          rows: people
        });
      }

      return save(wb, 'FTE_Records_' + stamp() + '.xlsx')
        .then(function () { global.UI.toast(records.length + ' record(s) exported.', 'ok'); })
        .catch(fail);
    } catch (err) { fail(err); return Promise.resolve(); }
  }

  /* ----------------------------------------------------------- project --- */

  function exportProject(project) {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return Promise.resolve(); }
    try {
      var wb = newBook();
      var w = project.wan || {}, l = project.lan || {};

      var ws = newSheet(wb, 'Configuration', [34, 30, 52]);
      titleBlock(ws, 3, 'SAVED PROJECT CONFIGURATION', project.name,
        (project.projectCode ? project.projectCode + '   ·   ' : '') +
        'saved ' + (project.savedAt ? new Date(project.savedAt).toLocaleString() : '-') +
        '   ·   these are stored inputs, not a calculated result');

      var row = addFactTable(ws, 5, 'WAN side', [
        ['Project name', w.projName || '-', ''],
        ['Status', w.status || '-', 'Recorded only'],
        ['Calculation mode', w.mode || '-', ''],
        ['Duration (months)', w.months || '-', ''],
        ['Start date', w.startDate || '-', ''],
        ['End date', w.endDate || '-', ''],
        ['Total sites', w.sites || '-', ''],
        ['Project type', w.projectType || '-', 'Recorded only'],
        ['Migration support', w.migration || '-', ''],
        ['ABACOS', w.abacos || '-', 'Recorded only'],
        ['DPM acting as PM', w.pmRole || '-', 'Recorded only']
      ]);

      row = addFactTable(ws, row, 'LAN side', [
        ['Project name', l.projName || '-', ''],
        ['Status', l.status || '-', 'Recorded only'],
        ['Calculation mode', l.mode || '-', ''],
        ['Duration (months)', l.months || '-', ''],
        ['Start date', l.startDate || '-', ''],
        ['End date', l.endDate || '-', ''],
        ['Total sites', l.sites || '-', ''],
        ['Device count', l.devices || 0, 'Only used when no tier rows exist'],
        ['FLAN used', l.flan || '-', 'Recorded only'],
        ['Stages', (l.stages || []).join(', ') || '-', 'By Stage mode only'],
        ['DPM acting as PM', l.pmRole || '-', 'Recorded only']
      ]);
      note(ws, row, 'A project stores the inputs you typed. Open it in the app and press Calculate to produce a result.');

      if ((w.rows || []).length) {
        var wsx = newSheet(wb, 'WAN allocation', [6, 28, 28, 12, 14, 20]);
        titleBlock(wsx, 6, 'WAN ALLOCATION', project.name, 'Stored allocation rows.');
        addTable(wsx, {
          row: 5, hint: 'ProjWan', theme: 'TableStyleMedium2', totals: true,
          columns: [
            { name: '#', width: 6, align: 'center', total: 'label', totalLabel: '' },
            { name: 'Product', width: 28, total: 'label', totalLabel: 'TOTAL' },
            { name: 'Connectivity mode', width: 28 },
            { name: 'Sites', numFmt: FMT.int, align: 'right', total: 'sum' },
            { name: 'Complexity', numFmt: FMT.pct0, align: 'right' },
            { name: 'Override MD/site', numFmt: FMT.md, align: 'right' }
          ],
          rows: w.rows.map(function (r, n) {
            return [n + 1, r.product, r.connectivityMode, r.sites, r.complexityPct, r.overrideMdPerSite || 0];
          })
        });
      }

      if ((l.rows || []).length) {
        var lsx = newSheet(wb, 'LAN allocation', [6, 32, 12, 14, 20]);
        titleBlock(lsx, 5, 'LAN ALLOCATION', project.name, 'Stored tier rows.');
        addTable(lsx, {
          row: 5, hint: 'ProjLan', theme: 'TableStyleMedium2', totals: true,
          columns: [
            { name: '#', width: 6, align: 'center', total: 'label', totalLabel: '' },
            { name: 'Tier', width: 32, total: 'label', totalLabel: 'TOTAL' },
            { name: 'Sites', numFmt: FMT.int, align: 'right', total: 'sum' },
            { name: 'Complexity', numFmt: FMT.pct0, align: 'right' },
            { name: 'Override MD/site', numFmt: FMT.md, align: 'right' }
          ],
          rows: l.rows.map(function (r, n) {
            return [n + 1, r.tierLabel, r.sites, r.complexityPct, r.overrideMdPerSite || 0];
          })
        });
      }

      var dpms = [];
      (w.dpms || []).forEach(function (d) { dpms.push(['WAN', d.name, d.email, d.role || 'DPM']); });
      (l.dpms || []).forEach(function (d) { dpms.push(['LAN', d.name, d.email, d.role || 'DPM']); });
      if (dpms.length) {
        var dsx = newSheet(wb, 'DPM assignments', [12, 30, 44, 18]);
        titleBlock(dsx, 4, 'DPM ASSIGNMENTS', project.name, 'Recorded for reporting only.');
        addTable(dsx, {
          row: 5, hint: 'ProjDpms', theme: 'TableStyleMedium2',
          columns: [{ name: 'Side', width: 12, align: 'center' }, { name: 'Name', width: 30 },
                    { name: 'Email', width: 44 }, { name: 'Role', width: 18 }],
          rows: dpms
        });
      }

      return save(wb, 'Project_' + safeName(project.name) + '_' + stamp() + '.xlsx')
        .then(function () { global.UI.toast('Project workbook exported.', 'ok'); })
        .catch(fail);
    } catch (err) { fail(err); return Promise.resolve(); }
  }

  /* --------------------------------------------------------- directory --- */

  function exportDpmDirectory() {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return Promise.resolve(); }
    try {
      var wb = newBook();
      var ws = newSheet(wb, 'DPM directory', [8, 32, 46]);
      titleBlock(ws, 3, 'DPM DIRECTORY', D.DPMS.length + ' people',
        'Exported ' + new Date().toLocaleString() + '.');
      addTable(ws, {
        row: 5, hint: 'Directory', theme: 'TableStyleMedium2',
        columns: [{ name: '#', width: 8, align: 'center' }, { name: 'Name', width: 32 }, { name: 'Email', width: 46 }],
        rows: D.DPMS.map(function (d, n) { return [n + 1, d.name, d.email]; })
      });
      return save(wb, 'DPM_Directory_' + stamp() + '.xlsx')
        .then(function () { global.UI.toast('Directory exported.', 'ok'); })
        .catch(fail);
    } catch (err) { fail(err); return Promise.resolve(); }
  }

  global.FTEExport = {
    available: available,
    exportRecord: exportRecord,
    exportAllRecords: exportAllRecords,
    exportProject: exportProject,
    exportDpmDirectory: exportDpmDirectory
  };
})(window);
