/* ===========================================================================
   export.js - Excel workbooks.

   Every sheet is built from a saved record snapshot and never from live form
   fields. That is deliberate: the previous build read the form at export time,
   so changing any input after pressing Calculate produced a workbook whose
   header described one project and whose numbers described another.
   =========================================================================== */
(function (global) {
  'use strict';

  var D = global.FTEData;

  function available() { return typeof XLSX !== 'undefined'; }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  function safeName(s) {
    return String(s || 'report').replace(/[^A-Za-z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 60) || 'report';
  }

  /** Append a sheet, sizing columns from the widest cell in each column. */
  function addSheet(wb, name, rows, widths) {
    var ws = XLSX.utils.aoa_to_sheet(rows);
    if (!widths) {
      widths = [];
      rows.forEach(function (r) {
        (r || []).forEach(function (cell, i) {
          var len = String(cell === null || cell === undefined ? '' : cell).length;
          widths[i] = Math.max(widths[i] || 10, Math.min(len + 3, 62));
        });
      });
    }
    ws['!cols'] = widths.map(function (w) { return { wch: w }; });
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    return ws;
  }

  /* ------------------------------------------------------ shared sheets -- */

  function methodologySheet(record) {
    var i = record.inputs || {};
    var r = record.results || {};
    var rows = [
      ['How this estimate was calculated'],
      [],
      ['Step', 'Calculation', 'Result']
    ];
    (r.steps || []).forEach(function (s) { rows.push([s.label, s.formula, s.value]); });
    rows.push([]);
    rows.push(['Constants in force when this estimate ran']);
    rows.push(['DPM monthly capacity (MD)', i.capacityMdPerMonth, 'Productive man-days one full-time DPM delivers per month']);
    if (record.type === 'WAN') {
      rows.push(['Migration uplift (MD per site)', i.migrationMdPerSite, 'Added per site when migration support is in scope']);
    }
    if (record.type === 'LAN') {
      rows.push(['Hours per man-day', D.HOURS_PER_DAY, 'Used to convert stage hours into man-days']);
    }
    rows.push([]);
    rows.push(['Definitions']);
    rows.push(['Term', 'Meaning']);
    D.GLOSSARY.forEach(function (g) { rows.push([g.term, g.meaning]); });
    rows.push([]);
    rows.push(['Fields recorded but excluded from the calculation']);
    rows.push([D.INFORMATIONAL_FIELDS.join(', ')]);
    return rows;
  }

  function rateCardSheet(record) {
    var rows = [];
    if (record.type === 'WAN') {
      rows.push(['WAN base effort - man-days per site']);
      rows.push([]);
      rows.push(['Connectivity mode'].concat(D.PRODUCTS));
      D.CONNECTIVITY_MODES.forEach(function (mode) {
        rows.push([mode].concat(D.PRODUCTS.map(function (p) {
          var v = D.lookupBaseMd(mode, p);
          return v === null ? 'n/a' : v;
        })));
      });
      rows.push([]);
      rows.push(['"n/a" means the product is not offered with that connectivity mode.']);
    } else {
      rows.push(['LAN base effort - man-days per site']);
      rows.push([]);
      rows.push(['Tier', 'Device range', 'Base effort (MD per site)']);
      D.LAN_TIERS.forEach(function (t) { rows.push([t.name, t.range, t.loe]); });
      var stages = (record.inputs || {}).stages || [];
      if (stages.length) {
        rows.push([]);
        rows.push(['Stage hours per site for the selected stages: ' + stages.join(', ')]);
        rows.push(['Stage', 'Activity'].concat(D.LAN_TIERS.map(function (t) { return t.name; })));
        stages.forEach(function (stage) {
          var acts = D.STAGE_HOURS[stage] || {};
          Object.keys(acts).forEach(function (act) {
            rows.push([stage, act].concat(D.LAN_TIERS.map(function (t) {
              var v = acts[act][t.key];
              return typeof v === 'number' ? v : '-';
            })));
          });
        });
      }
    }
    return rows;
  }

  function monthlySheet(record) {
    var rows = [['Month', 'Portion of month', 'Man-days', 'FTE']];
    (record.results.monthly || []).forEach(function (m) {
      rows.push(['Month ' + m.month, m.partial ? m.span : 1, m.md, m.fte]);
    });
    rows.push([]);
    rows.push(['Total', '', record.results.totalMd, '']);
    rows.push([]);
    rows.push(['A final partial month is shown with the fraction of the month it covers,',
               'so the monthly figures always add up to the project total.']);
    return rows;
  }

  function dpmSheet(record) {
    var rows = [['Name', 'Email', 'Role']];
    (record.dpms || []).forEach(function (d) { rows.push([d.name, d.email, d.role || 'DPM']); });
    rows.push([]);
    rows.push(['DPM assignments are recorded for reporting and do not change the calculated effort.']);
    return rows;
  }

  /* --------------------------------------------------------------- WAN --- */

  function exportWanRecord(record) {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return; }
    var i = record.inputs, r = record.results;
    var wb = XLSX.utils.book_new();

    addSheet(wb, 'Summary', [
      ['DPM FTE Calculator - WAN estimate'],
      [],
      ['Field', 'Value', 'Note'],
      ['Project name', record.projectName, ''],
      ['Project code', record.projectCode, 'Stable identifier - never changes for this project'],
      ['Record ID', record.id, 'Unique to this calculation'],
      ['Calculated at', record.savedAt, ''],
      [],
      ['INPUTS THAT AFFECT THE RESULT'],
      ['Calculation mode', i.mode, ''],
      ['Duration (months)', i.months, 'Effort is spread evenly across this period'],
      ['Start date', i.startDate || '-', ''],
      ['End date', i.endDate || '-', ''],
      ['Total sites', i.totalSites, ''],
      ['Migration support', i.migration, i.migration === 'Yes'
        ? ('Adds ' + i.migrationMdPerSite + ' MD per site') : 'No uplift applied'],
      ['DPM monthly capacity (MD)', i.capacityMdPerMonth, 'Divisor used to convert workload into FTE'],
      [],
      ['RECORDED ONLY - DOES NOT AFFECT THE RESULT'],
      ['Project status', record.status, 'Reporting only'],
      ['Project type', i.projectType, 'Reporting only'],
      ['ABACOS', i.abacos, 'Reporting only'],
      ['DPM acting as PM', i.pmRole, 'Reporting only'],
      [],
      ['RESULT'],
      ['Base effort (MD)', r.baseMd, 'Sum of all allocation rows'],
      ['Migration uplift (MD)', r.migrationMd, ''],
      ['Total effort (MD)', r.totalMd, ''],
      ['Man-days per month', r.mdPerMonth, 'Total effort / duration'],
      ['FTE required', r.fte, 'Man-days per month / monthly capacity'],
      ['Headcount', r.headcount, 'FTE rounded up to whole people'],
      ['Utilisation', r.utilisationPct + '%', 'FTE / headcount']
    ], [30, 34, 56]);

    var alloc = [['#', 'Product', 'Connectivity mode', 'Sites', 'Complexity %',
                  'Base rate (MD per site)', 'Rate source', 'Row effort (MD)', 'Share of total %']];
    (r.rows || []).forEach(function (row, n) {
      alloc.push([n + 1, row.product, row.connectivityMode, row.sites, row.complexityPct,
                  row.baseMdPerSite, row.rateSource, row.md, row.pctOfTotal]);
    });
    alloc.push([]);
    alloc.push(['', 'TOTAL', '', i.totalSites, '', '', '', r.baseMd, 100]);
    alloc.push([]);
    alloc.push(['Row effort = base rate x complexity x sites']);
    addSheet(wb, 'Allocation', alloc);

    addSheet(wb, 'Monthly breakdown', monthlySheet(record));
    addSheet(wb, 'Methodology', methodologySheet(record), [34, 52, 60]);
    addSheet(wb, 'Rate card', rateCardSheet(record));
    if ((record.dpms || []).length) addSheet(wb, 'DPM allocation', dpmSheet(record));

    XLSX.writeFile(wb, 'WAN_' + safeName(record.projectName) + '_' + stamp() + '.xlsx');
    global.UI.toast('WAN workbook exported.', 'ok');
  }

  /* --------------------------------------------------------------- LAN --- */

  function exportLanRecord(record) {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return; }
    var i = record.inputs, r = record.results;
    var wb = XLSX.utils.book_new();

    addSheet(wb, 'Summary', [
      ['DPM FTE Calculator - LAN estimate'],
      [],
      ['Field', 'Value', 'Note'],
      ['Project name', record.projectName, ''],
      ['Project code', record.projectCode, 'Stable identifier - never changes for this project'],
      ['Record ID', record.id, 'Unique to this calculation'],
      ['Calculated at', record.savedAt, ''],
      [],
      ['INPUTS THAT AFFECT THE RESULT'],
      ['Calculation mode', i.mode, ''],
      ['Stages in scope', (i.stages || []).join(', ') || '-', 'By Stage mode only'],
      ['Duration (months)', i.months, 'Effort is spread evenly across this period'],
      ['Start date', i.startDate || '-', ''],
      ['End date', i.endDate || '-', ''],
      ['Total sites', i.totalSites, ''],
      ['Device count', i.devices, 'Used only when no tier rows were entered'],
      ['Priced from', r.usedTierRows ? 'Tier rows' : ('Fallback tier ' + (r.fallbackTier || '')),
        r.usedTierRows ? 'Each tier row priced separately' : 'All sites priced at a single tier'],
      ['DPM monthly capacity (MD)', i.capacityMdPerMonth, 'Divisor used to convert workload into FTE'],
      [],
      ['RECORDED ONLY - DOES NOT AFFECT THE RESULT'],
      ['Project status', record.status, 'Reporting only'],
      ['FLAN used', i.flan, 'Reporting only'],
      ['DPM acting as PM', i.pmRole, 'Reporting only'],
      [],
      ['RESULT'],
      ['Total effort (MD)', r.totalMd, ''],
      ['Man-days per month', r.mdPerMonth, 'Total effort / duration'],
      ['FTE required', r.fte, 'Man-days per month / monthly capacity'],
      ['Headcount', r.headcount, 'FTE rounded up to whole people'],
      ['Utilisation', r.utilisationPct + '%', 'FTE / headcount']
    ], [30, 34, 56]);

    var alloc = [['#', 'Tier', 'Sites', 'Complexity %', 'Base rate (MD per site)',
                  'Rate source', 'Row effort (MD)', 'Share of total %']];
    (r.rows || []).forEach(function (row, n) {
      alloc.push([n + 1, row.label, row.sites, row.complexityPct,
                  row.baseMdPerSite, row.rateSource, row.md, row.pctOfTotal]);
    });
    alloc.push([]);
    alloc.push(['', 'TOTAL', i.totalSites, '', '', '', r.totalMd, 100]);
    alloc.push([]);
    alloc.push(['Row effort = base rate x complexity x sites']);
    addSheet(wb, 'Allocation', alloc);

    addSheet(wb, 'Monthly breakdown', monthlySheet(record));
    addSheet(wb, 'Methodology', methodologySheet(record), [34, 52, 60]);
    addSheet(wb, 'Rate card', rateCardSheet(record));
    if ((record.dpms || []).length) addSheet(wb, 'DPM allocation', dpmSheet(record));

    XLSX.writeFile(wb, 'LAN_' + safeName(record.projectName) + '_' + stamp() + '.xlsx');
    global.UI.toast('LAN workbook exported.', 'ok');
  }

  function exportRecord(record) {
    if (!record) { global.UI.toast('Nothing to export.', 'warn'); return; }
    if (record.type === 'LAN') exportLanRecord(record); else exportWanRecord(record);
  }

  /* -------------------------------------------------------- everything --- */

  function exportAllRecords(records) {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return; }
    if (!records || !records.length) { global.UI.toast('There are no records to export.', 'warn'); return; }
    var wb = XLSX.utils.book_new();

    var index = [['Record ID', 'Calculated at', 'Type', 'Project code', 'Project name', 'Status',
                  'Duration (months)', 'Total sites', 'Total MD', 'MD per month', 'FTE',
                  'Headcount', 'Utilisation %', 'Capacity used', 'Saved to disk']];
    records.forEach(function (rec) {
      var i = rec.inputs || {}, r = rec.results || {};
      index.push([rec.id, rec.savedAt, rec.type, rec.projectCode, rec.projectName, rec.status,
                  i.months, i.totalSites, r.totalMd, r.mdPerMonth, r.fte, r.headcount,
                  r.utilisationPct, i.capacityMdPerMonth,
                  (rec.sync && rec.sync.state === 'saved') ? 'Yes' : 'No']);
    });
    addSheet(wb, 'All records', index);

    var detail = [['Record ID', 'Type', 'Project name', 'Row', 'Sites', 'Complexity %',
                   'Base rate (MD per site)', 'Rate source', 'Row effort (MD)', 'Share %']];
    records.forEach(function (rec) {
      ((rec.results || {}).rows || []).forEach(function (row) {
        detail.push([rec.id, rec.type, rec.projectName,
                     row.label + (row.connectivityMode ? ' / ' + row.connectivityMode : ''),
                     row.sites, row.complexityPct, row.baseMdPerSite, row.rateSource,
                     row.md, row.pctOfTotal]);
      });
    });
    addSheet(wb, 'All allocation rows', detail);

    var people = [['Record ID', 'Project name', 'DPM name', 'Email', 'Role']];
    records.forEach(function (rec) {
      (rec.dpms || []).forEach(function (d) {
        people.push([rec.id, rec.projectName, d.name, d.email, d.role || 'DPM']);
      });
    });
    if (people.length > 1) addSheet(wb, 'DPM assignments', people);

    XLSX.writeFile(wb, 'FTE_Records_' + stamp() + '.xlsx');
    global.UI.toast(records.length + ' record(s) exported.', 'ok');
  }

  function exportProject(project) {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return; }
    var wb = XLSX.utils.book_new();
    var w = project.wan || {}, l = project.lan || {};

    addSheet(wb, 'WAN configuration', [
      ['Saved WAN configuration'], [],
      ['Field', 'Value'],
      ['Project name', w.projName || ''], ['Project code', project.projectCode || ''],
      ['Status', w.status || ''], ['DPM acting as PM', w.pmRole || ''],
      ['Calculation mode', w.mode || ''], ['Duration (months)', w.months || ''],
      ['Start date', w.startDate || ''], ['End date', w.endDate || ''],
      ['Total sites', w.sites || ''], ['Project type', w.projectType || ''],
      ['Migration support', w.migration || ''], ['ABACOS', w.abacos || ''],
      ['Saved at', project.savedAt || '']
    ], [28, 44]);

    if ((w.rows || []).length) {
      var wr = [['#', 'Product', 'Connectivity mode', 'Sites', 'Complexity %', 'Override MD per site']];
      w.rows.forEach(function (r, n) {
        wr.push([n + 1, r.product, r.connectivityMode, r.sites, r.complexityPct, r.overrideMdPerSite || '']);
      });
      addSheet(wb, 'WAN allocation', wr);
    }

    addSheet(wb, 'LAN configuration', [
      ['Saved LAN configuration'], [],
      ['Field', 'Value'],
      ['Project name', l.projName || ''], ['Project code', project.projectCode || ''],
      ['Status', l.status || ''], ['DPM acting as PM', l.pmRole || ''],
      ['Calculation mode', l.mode || ''], ['Duration (months)', l.months || ''],
      ['Start date', l.startDate || ''], ['End date', l.endDate || ''],
      ['Total sites', l.sites || ''], ['Device count', l.devices || 0],
      ['FLAN used', l.flan || ''], ['Stages', (l.stages || []).join(', ')],
      ['Saved at', project.savedAt || '']
    ], [28, 44]);

    if ((l.rows || []).length) {
      var lr = [['#', 'Tier', 'Sites', 'Complexity %', 'Override MD per site']];
      l.rows.forEach(function (r, n) {
        lr.push([n + 1, r.tierLabel, r.sites, r.complexityPct, r.overrideMdPerSite || '']);
      });
      addSheet(wb, 'LAN allocation', lr);
    }

    var dpms = [['Side', 'Name', 'Email', 'Role']];
    (w.dpms || []).forEach(function (d) { dpms.push(['WAN', d.name, d.email, d.role || 'DPM']); });
    (l.dpms || []).forEach(function (d) { dpms.push(['LAN', d.name, d.email, d.role || 'DPM']); });
    if (dpms.length > 1) addSheet(wb, 'DPM assignments', dpms);

    XLSX.writeFile(wb, 'Project_' + safeName(project.name) + '_' + stamp() + '.xlsx');
    global.UI.toast('Project workbook exported.', 'ok');
  }

  function exportDpmDirectory() {
    if (!available()) { global.UI.toast('Excel library unavailable.', 'err'); return; }
    var wb = XLSX.utils.book_new();
    var rows = [['Name', 'Email']];
    D.DPMS.forEach(function (d) { rows.push([d.name, d.email]); });
    addSheet(wb, 'DPM directory', rows);
    XLSX.writeFile(wb, 'DPM_Directory_' + stamp() + '.xlsx');
    global.UI.toast('Directory exported.', 'ok');
  }

  global.FTEExport = {
    available: available,
    exportRecord: exportRecord,
    exportAllRecords: exportAllRecords,
    exportProject: exportProject,
    exportDpmDirectory: exportDpmDirectory
  };
})(window);
