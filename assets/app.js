/* ===========================================================================
   app.js - page controllers and wiring.
   =========================================================================== */
(function (global) {
  'use strict';

  var D = global.FTEData;
  var C = global.FTECalc;
  var U = global.UI;
  var DB = global.FTEDb;
  var EX = global.FTEExport;
  var IM = global.FTEImport;
  var PL = global.FTEPlanner;

  var esc = U.esc, el = U.el, qs = U.qs, qsa = U.qsa, fmt = U.fmt;

  /* =============================================================== state == */

  var S = {
    settings: Object.assign({}, D.DEFAULT_SETTINGS),
    wan: { rows: [], dpms: [], code: null, record: null, durMode: 'months' },
    lan: { rows: [], dpms: [], code: null, record: null, durMode: 'months' },
    records: [],
    projects: [],
    selectedProject: null,
    dpmPicker: { side: 'wan', temp: [] },
    refStage: 'Design',
    plan: { team: null, last: null, loading: false, error: null },
    pendingRoot: null     // data-folder path being typed in Settings, kept across re-renders
  };

  var PAGE_TITLES = {
    dashboard: 'Dashboard', wan: 'WAN Estimator', lan: 'LAN Estimator',
    capacity: 'Team capacity',
    records: 'FTE Records', projects: 'Projects', dpms: 'DPM Directory',
    reference: 'Rates & Method', settings: 'Settings'
  };

  /* ============================================================ helpers == */

  function sideState(side) { return side === 'wan' ? S.wan : S.lan; }
  function prefix(side) { return side === 'wan' ? 'w' : 'l'; }

  /** Read the active option of a segmented control. */
  function segValue(groupId) {
    var active = qs('#' + groupId + ' button.active');
    return active ? active.dataset.val : null;
  }

  function setSeg(groupId, value) {
    qsa('#' + groupId + ' button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.val === value);
    });
  }

  function val(id) { var n = el(id); return n ? n.value : ''; }
  function setVal(id, v) { var n = el(id); if (n) n.value = (v === null || v === undefined) ? '' : v; }
  function numVal(id) { return C.num(val(id)); }

  /* Turn every data-help marker into a focusable explanation button. */
  function hydrateHelp() {
    qsa('[data-help]').forEach(function (node) {
      if (node.dataset.helpDone === '1') return;
      node.dataset.helpDone = '1';
      var key = node.dataset.help;
      if (!D.HELP[key]) return;
      node.insertAdjacentHTML('beforeend', ' ' + U.hint(key));
    });
  }

  /* ========================================================= navigation == */

  function gotoPage(page) {
    qsa('.page').forEach(function (p) { p.classList.remove('active'); });
    qsa('.nav-item[data-page]').forEach(function (n) { n.classList.remove('active'); });
    var target = el('page-' + page);
    if (target) target.classList.add('active');
    var nav = qs('.nav-item[data-page="' + page + '"]');
    if (nav) nav.classList.add('active');
    el('page-title').textContent = PAGE_TITLES[page] || page;

    if (page === 'records') { renderRecords(); renderPortfolio(); }
    if (page === 'capacity') renderCapacityPage(true);
    if (page === 'projects') renderProjects();
    if (page === 'dpms') renderDpmDirectory();
    if (page === 'reference') renderReference();
    if (page === 'settings') renderSettingsPage();
    if (page === 'dashboard') renderDashboard();
  }

  /* ====================================================== status chips === */

  function renderStorageStatus() {
    var st = DB.status();
    var dot = el('storage-dot'), text = el('storage-text'), chip = el('storage-chip');

    if (st.mode === 'host') {
      dot.className = 'status-dot on';
      text.textContent = 'Saving to data folder';
      chip.title = 'Every calculation is written as a JSON file into: ' + (st.dataRoot || 'the data folder');
    } else if (st.mode === 'folder') {
      dot.className = 'status-dot on';
      text.textContent = 'Saving to ' + st.folderName;
      chip.title = 'Every calculation is written as a JSON file into the folder you connected: ' + st.folderName;
    } else {
      DB.countPending().then(function (n) {
        dot.className = 'status-dot warn';
        text.textContent = n > 0 ? ('In browser — ' + n + ' not on disk') : 'Saving in browser';
        chip.title = st.folderNeedsReconnect
          ? 'Reconnect "' + st.folderName + '" on the Settings page to resume writing files.'
          : (st.folderSupported
              ? 'Your work is saved in this browser. Connect a folder on the Settings page to also write JSON files to disk.'
              : 'Your work is saved in this browser. This browser cannot write to a folder, so use Download full backup on the Settings page to keep a copy.');
      });
    }
    if (el('page-settings').classList.contains('active')) renderSettingsPage();
  }

  function renderResultChip(record) {
    var dot = el('result-dot'), text = el('result-text');
    if (!record) { dot.className = 'status-dot off'; text.textContent = 'No calculation yet'; return; }
    dot.className = 'status-dot on';
    text.textContent = record.type + ' · ' + fmt.fte(record.results.fte) + ' FTE · ' +
                       fmt.md1(record.results.totalMd) + ' MD';
  }

  /* ================================================= allocation editing == */

  /** Live preview of the rate for a row, using whatever mode is selected now. */
  function wanRowRate(row) {
    if (segValue('w-mode') === 'Standard') return D.lookupBaseMd(row.connectivityMode, row.product);
    return row.overrideMdPerSite > 0 ? row.overrideMdPerSite : null;
  }

  function lanRowRate(row) {
    var tier = D.tierByLabel(row.tierLabel);
    if (!tier) return null;
    var mode = segValue('l-mode');
    if (mode === 'Standard') return tier.loe;
    if (mode === 'Non-standard') return row.overrideMdPerSite > 0 ? row.overrideMdPerSite : null;
    var stages = selectedStages();
    var rate = D.stageMdPerSite(tier.key, stages);
    return rate > 0 ? rate : null;
  }

  function shareCell(pct) {
    var p = Math.max(0, Math.min(100, pct || 0));
    return '<div class="share"><div class="share-track"><div class="share-fill" style="width:' + p +
           '%"></div></div><span class="share-num">' + p.toFixed(1) + '%</span></div>';
  }

  /* Rows built from an imported site list remember which sites they cover;
     the tag shows it and hovering lists the names. */
  function importedTag(row) {
    var list = row.sitesDetail || [];
    if (!list.length) return '';
    var names = list.slice(0, 12).map(function (s) {
      return s.name + (s.count > 1 ? ' ×' + s.count : '');
    }).join(', ') + (list.length > 12 ? ' … and ' + (list.length - 12) + ' more' : '');
    return ' <span class="tag tag-muted" title="' + esc('From the imported site list: ' + names) + '">' +
           list.length + ' from site list</span>';
  }

  function rowActions(side, index) {
    return '<button type="button" class="icon-btn" data-row-act="edit" data-side="' + side + '" data-index="' + index +
           '" title="Edit this row" aria-label="Edit row ' + (index + 1) + '">✎</button>' +
           '<button type="button" class="icon-btn" data-row-act="duplicate" data-side="' + side + '" data-index="' + index +
           '" title="Duplicate this row" aria-label="Duplicate row ' + (index + 1) + '">⧉</button>' +
           '<button type="button" class="icon-btn danger" data-row-act="delete" data-side="' + side + '" data-index="' + index +
           '" title="Delete this row" aria-label="Delete row ' + (index + 1) + '">✕</button>';
  }

  function renderWanRows() {
    var body = el('w-alloc-body'), foot = el('w-alloc-foot');
    var rows = S.wan.rows;
    if (!rows.length) {
      body.innerHTML = U.emptyRow(9, '⊞', 'No allocation rows yet',
        'Add a row above for each group of sites that share a product and connectivity mode.');
      foot.innerHTML = '';
      renderWanAllocBadge();
      return;
    }

    var effort = rows.map(function (r) {
      var rate = wanRowRate(r);
      return rate === null ? null : rate * (r.complexityPct / 100) * r.sites;
    });
    var total = effort.reduce(function (t, v) { return t + (v || 0); }, 0);

    body.innerHTML = rows.map(function (r, i) {
      var rate = wanRowRate(r), md = effort[i];
      var unavailable = rate === null;
      return '<tr' + (unavailable ? ' class="row-invalid"' : '') + '>' +
        '<td class="idx center">' + (i + 1) + '</td>' +
        '<td class="strong">' + esc(r.product) + importedTag(r) + '</td>' +
        '<td>' + esc(r.connectivityMode) + '</td>' +
        '<td class="num" data-sort="' + r.sites + '">' + fmt.int(r.sites) + '</td>' +
        '<td class="num" data-sort="' + r.complexityPct + '">' + r.complexityPct + '%</td>' +
        '<td class="num" data-sort="' + (rate || 0) + '">' +
          (unavailable ? '<span class="tag tag-err">not offered</span>' : fmt.md(rate)) +
          (r.overrideMdPerSite > 0 && segValue('w-mode') !== 'Standard'
            ? ' <span class="tag tag-info">override</span>' : '') + '</td>' +
        '<td class="num" data-sort="' + (md || 0) + '">' + (unavailable ? '—' : fmt.md(md)) + '</td>' +
        '<td>' + (unavailable ? '' : shareCell(total > 0 ? (md / total) * 100 : 0)) + '</td>' +
        '<td class="actions center">' + rowActions('wan', i) + '</td>' +
      '</tr>';
    }).join('');

    var sites = rows.reduce(function (t, r) { return t + r.sites; }, 0);
    foot.innerHTML = '<tr data-no-sort="1"><td></td><td>Total</td><td></td>' +
      '<td class="num">' + fmt.int(sites) + '</td><td></td><td></td>' +
      '<td class="num">' + fmt.md(total) + '</td><td></td><td></td></tr>';

    U.makeSortable(el('w-alloc-table'));
    renderWanAllocBadge();
  }

  function renderLanRows() {
    var body = el('l-alloc-body'), foot = el('l-alloc-foot');
    var rows = S.lan.rows;
    if (!rows.length) {
      body.innerHTML = U.emptyRow(8, '⊞', 'No tier rows yet',
        'Add a row per group of sites in the same size tier. Without rows, the device count above prices the whole project at one tier.');
      foot.innerHTML = '';
      renderLanAllocBadge();
      return;
    }

    var effort = rows.map(function (r) {
      var rate = lanRowRate(r);
      return rate === null ? null : rate * (r.complexityPct / 100) * r.sites;
    });
    var total = effort.reduce(function (t, v) { return t + (v || 0); }, 0);

    body.innerHTML = rows.map(function (r, i) {
      var rate = lanRowRate(r), md = effort[i];
      var unavailable = rate === null;
      return '<tr>' +
        '<td class="idx center">' + (i + 1) + '</td>' +
        '<td class="strong">' + esc(r.tierLabel) + importedTag(r) + '</td>' +
        '<td class="num" data-sort="' + r.sites + '">' + fmt.int(r.sites) + '</td>' +
        '<td class="num" data-sort="' + r.complexityPct + '">' + r.complexityPct + '%</td>' +
        '<td class="num" data-sort="' + (rate || 0) + '">' +
          (unavailable ? '<span class="tag tag-warn">needs a rate</span>' : fmt.md(rate)) + '</td>' +
        '<td class="num" data-sort="' + (md || 0) + '">' + (unavailable ? '—' : fmt.md(md)) + '</td>' +
        '<td>' + (unavailable ? '' : shareCell(total > 0 ? (md / total) * 100 : 0)) + '</td>' +
        '<td class="actions center">' + rowActions('lan', i) + '</td>' +
      '</tr>';
    }).join('');

    var sites = rows.reduce(function (t, r) { return t + r.sites; }, 0);
    foot.innerHTML = '<tr data-no-sort="1"><td></td><td>Total</td>' +
      '<td class="num">' + fmt.int(sites) + '</td><td></td><td></td>' +
      '<td class="num">' + fmt.md(total) + '</td><td></td><td></td></tr>';

    U.makeSortable(el('l-alloc-table'));
    renderLanAllocBadge();
  }

  function allocBadge(allocated, total) {
    if (!total) return '<span class="tag tag-muted">Enter the total number of sites to check your allocation</span>';
    if (Math.abs(allocated - total) < 1e-9) {
      return '<span class="tag tag-ok">✓ ' + fmt.int(allocated) + ' of ' + fmt.int(total) + ' sites allocated — ready to calculate</span>';
    }
    if (allocated < total) {
      return '<span class="tag tag-warn">⚠ ' + fmt.int(allocated) + ' of ' + fmt.int(total) + ' sites allocated — ' +
             fmt.int(total - allocated) + ' still to allocate</span>';
    }
    return '<span class="tag tag-err">✕ ' + fmt.int(allocated) + ' of ' + fmt.int(total) + ' sites allocated — ' +
           fmt.int(allocated - total) + ' too many</span>';
  }

  function renderWanAllocBadge() {
    var total = numVal('w-sites');
    var allocated = S.wan.rows.reduce(function (t, r) { return t + r.sites; }, 0);
    el('w-alloc-badge').innerHTML = allocBadge(allocated, total);
  }

  function renderLanAllocBadge() {
    var total = numVal('l-sites');
    var allocated = S.lan.rows.reduce(function (t, r) { return t + r.sites; }, 0);
    el('l-alloc-badge').innerHTML = allocBadge(allocated, total);
  }


  function addWanRow() {
    var sites = numVal('w-add-sites');
    if (!(sites > 0)) { U.toast('Enter how many sites this row covers.', 'warn'); el('w-add-sites').focus(); return; }
    var nonStandard = segValue('w-mode') === 'Non-standard';
    S.wan.rows.push({
      product: val('w-add-product'),
      connectivityMode: val('w-add-mode'),
      sites: sites,
      complexityPct: numVal('w-add-complexity') || S.settings.defaultComplexity,
      /* Only capture the override when it is actually in play. The old build
         read the hidden input regardless, storing a stale value that then
         appeared in the table. */
      overrideMdPerSite: nonStandard ? (numVal('w-add-override') || null) : null
    });
    setVal('w-add-sites', ''); setVal('w-add-override', '');
    setVal('w-add-complexity', S.settings.defaultComplexity);
    renderWanRows();
    el('w-add-sites').focus();
  }

  function addLanRow() {
    var sites = numVal('l-add-sites');
    if (!(sites > 0)) { U.toast('Enter how many sites this row covers.', 'warn'); el('l-add-sites').focus(); return; }
    var nonStandard = segValue('l-mode') === 'Non-standard';
    S.lan.rows.push({
      tierLabel: val('l-add-tier'),
      sites: sites,
      complexityPct: numVal('l-add-complexity') || S.settings.defaultComplexity,
      overrideMdPerSite: nonStandard ? (numVal('l-add-override') || null) : null
    });
    setVal('l-add-sites', ''); setVal('l-add-override', '');
    setVal('l-add-complexity', S.settings.defaultComplexity);
    renderLanRows();
    el('l-add-sites').focus();
  }

  function handleRowAction(side, action, index) {
    var st = sideState(side);
    var row = st.rows[index];
    if (!row) return;

    if (action === 'delete') {
      st.rows.splice(index, 1);
      side === 'wan' ? renderWanRows() : renderLanRows();
      return;
    }
    if (action === 'duplicate') {
      /* The copy is new sites, not the same named ones counted twice. */
      var copy = Object.assign({}, row);
      delete copy.sitesDetail;
      st.rows.splice(index + 1, 0, copy);
      side === 'wan' ? renderWanRows() : renderLanRows();
      return;
    }
    if (action === 'edit') {
      var hadNames = (row.sitesDetail || []).length > 0;
      /* Load the row back into the entry fields and remove it, so editing is
         "pull it out, change it, put it back" rather than a separate mode. */
      if (side === 'wan') {
        setVal('w-add-product', row.product);
        setVal('w-add-mode', row.connectivityMode);
        setVal('w-add-sites', row.sites);
        setVal('w-add-complexity', row.complexityPct);
        setVal('w-add-override', row.overrideMdPerSite || '');
        st.rows.splice(index, 1);
        renderWanRows();
        el('w-add-sites').focus();
      } else {
        setVal('l-add-tier', row.tierLabel);
        setVal('l-add-sites', row.sites);
        setVal('l-add-complexity', row.complexityPct);
        setVal('l-add-override', row.overrideMdPerSite || '');
        st.rows.splice(index, 1);
        renderLanRows();
        el('l-add-sites').focus();
      }
      U.toast('Row moved back into the entry fields — change it and add it again.' +
              (hadNames ? ' Its site names from the imported list are not kept.' : ''), 'info');
    }
  }

  /* ========================================================= site import = */

  function colLetter(c) {
    var s = '';
    for (var n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  function importSiteList(side, input) {
    var file = input.files && input.files[0];
    input.value = '';   // so choosing the same file again still fires
    if (!file) return;
    IM.readFile(file).then(function (sheets) {
      if (!sheets.length) { U.toast('No data was found in ' + file.name + '.', 'warn'); return; }
      openImportDialog(side, file.name, sheets);
    }).catch(function (err) {
      U.toast('Could not read that file: ' + (err && err.message ? err.message : err), 'err');
    });
  }

  /* Map columns, preview the grouped rows, then apply. Everything is worked
     out again on every change so the preview is always what will be applied. */
  function openImportDialog(side, fileName, sheets) {
    var roles = IM.SIDE_ROLES[side];
    var existingRows = sideState(side).rows;
    var existingSites = existingRows.reduce(function (t, r) { return t + r.sites; }, 0);
    var state = { sheet: 0, header: 0, mapping: {}, result: null, replace: true, setTotal: true };

    function setSheet(i) {
      state.sheet = i;
      var rows = sheets[i].rows;
      state.header = IM.detectHeader(rows, side);
      state.mapping = IM.guessMapping(rows[state.header] || [], side);
    }
    setSheet(0);

    function needed(role) {
      if (side === 'wan') return role === 'product' || role === 'mode';
      return role === 'devices' || role === 'tier';
    }

    var promise = U.dialog({
      title: 'Import ' + side.toUpperCase() + ' sites from a spreadsheet',
      confirmLabel: 'Use these rows',
      submitOnEnter: false,
      bodyHtml:
        '<p>Reading <span class="code">' + esc(fileName) + '</span>. Check each column is matched correctly — ' +
        'the preview below updates as you change them, and nothing changes in the estimator until you confirm.</p>' +
        '<div class="map-grid mt-3">' +
          (sheets.length > 1
            ? '<div class="field"><label class="dlg-label" for="imp-sheet">Sheet</label>' +
              '<select id="imp-sheet" class="dlg-input">' + sheets.map(function (s, i) {
                return '<option value="' + i + '">' + esc(s.name) + '</option>';
              }).join('') + '</select></div>'
            : '') +
          '<div class="field"><label class="dlg-label" for="imp-header">Column headings are on</label>' +
          '<select id="imp-header" class="dlg-input"></select></div>' +
        '</div>' +
        '<div class="divider"><span>Columns</span></div>' +
        '<div class="map-grid" id="imp-map"></div>' +
        (side === 'lan'
          ? '<p class="field-help mt-2">A LAN row needs a device count or a tier. When both are given, the tier wins.</p>'
          : '<p class="field-help mt-2">No “number of sites” column? Then every line counts as one site.</p>') +
        '<div class="divider"><span>Preview</span></div>' +
        '<div id="imp-preview"></div>' +
        '<div id="imp-options"></div>' +
        '<p class="dlg-error" hidden></p>',
      collect: function (root) {
        var res = state.result;
        if (!res || !res.ok || !res.rows.length) {
          var errBox = qs('.dlg-error', root);
          errBox.textContent = (res && !res.ok) ? res.error : 'No usable rows yet — check the column choices above.';
          errBox.hidden = false;
          return false;
        }
        return { result: res, replace: state.replace, setTotal: state.setTotal };
      }
    });
    var box = qs('.dlg');
    if (box) box.classList.add('wide', 'xwide');

    function renderHeaderChoices() {
      var rows = sheets[state.sheet].rows;
      var html = '';
      for (var r = 0; r < Math.min(rows.length, 15); r++) {
        var cells = (rows[r] || []).map(function (c) { return String(c).trim(); }).filter(Boolean);
        if (!cells.length) continue;
        var preview = cells.join(' | ');
        if (preview.length > 70) preview = preview.slice(0, 70) + '…';
        html += '<option value="' + r + '"' + (r === state.header ? ' selected' : '') + '>Row ' + (r + 1) + ': ' + esc(preview) + '</option>';
      }
      el('imp-header').innerHTML = html;
    }

    function renderMapping() {
      var headers = sheets[state.sheet].rows[state.header] || [];
      var options = '<option value="-1">— not in the file —</option>' + headers.map(function (h, c) {
        var name = String(h === null || h === undefined ? '' : h).trim() || '(no heading)';
        return '<option value="' + c + '">' + esc(colLetter(c) + ' · ' + name) + '</option>';
      }).join('');
      el('imp-map').innerHTML = roles.map(function (role) {
        return '<div class="field"><label class="dlg-label" for="imp-col-' + role + '">' + esc(IM.ROLES[role].label) + ' ' +
          (needed(role)
            ? '<span class="tag tag-info">' + (side === 'lan' ? 'this or the other' : 'needed') + '</span>'
            : '<span class="tag tag-muted">optional</span>') + '</label>' +
          '<select id="imp-col-' + role + '" class="dlg-input" data-imp-role="' + role + '">' + options + '</select></div>';
      }).join('');
      roles.forEach(function (role) {
        var sel = el('imp-col-' + role);
        if (sel) sel.value = String(state.mapping[role] === undefined ? -1 : state.mapping[role]);
      });
    }

    function renderOptions() {
      var res = state.result;
      var host = el('imp-options');
      if (!res || !res.ok || !res.rows.length) { host.innerHTML = ''; return; }
      var total = state.replace ? res.totalSites : existingSites + res.totalSites;
      host.innerHTML = '<div class="divider"><span>Apply</span></div>' +
        (existingRows.length
          ? '<label class="check-row"><input type="radio" name="imp-how" data-imp-how="replace"' + (state.replace ? ' checked' : '') + '>' +
              '<span>Replace the ' + existingRows.length + ' row(s) already in the table</span></label>' +
            '<label class="check-row"><input type="radio" name="imp-how" data-imp-how="append"' + (state.replace ? '' : ' checked') + '>' +
              '<span>Add to the rows already in the table</span></label>'
          : '') +
        '<label class="check-row"><input type="checkbox" data-imp-total="1"' + (state.setTotal ? ' checked' : '') + '>' +
          '<span>Set <b>Total sites</b> to ' + fmt.int(total) + ' so the allocation balances</span></label>';
    }

    function unknownList(map) {
      var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
      if (!keys.length) return '';
      var shown = keys.slice(0, 6).map(function (k) { return '“' + esc(k) + '” (' + map[k] + ')'; }).join(', ');
      return shown + (keys.length > 6 ? ' and ' + (keys.length - 6) + ' more' : '');
    }

    function renderPreview() {
      var rows = sheets[state.sheet].rows;
      var res = state.result = IM.build(rows, {
        side: side, headerIndex: state.header, mapping: state.mapping,
        defaultComplexity: S.settings.defaultComplexity,
        decimalComma: !!sheets[state.sheet].decimalComma
      });
      var host = el('imp-preview');
      var errBox = qs('.dlg-backdrop .dlg-error');
      if (errBox) errBox.hidden = true;

      if (!res.ok) {
        host.innerHTML = '<div class="callout warn"><span class="callout-ic">⚠</span><span>' + esc(res.error) + '</span></div>';
        renderOptions();
        return;
      }

      var html = '<div class="import-summary">' +
        '<span class="tag tag-ok">' + fmt.int(res.totalSites) + ' site(s)</span>' +
        '<span class="tag tag-info">' + res.rows.length + ' allocation row(s)</span>' +
        '<span class="tag tag-muted">' + res.linesUsed + ' line(s) used</span>' +
        (res.namedSites ? '<span class="tag tag-muted">' + fmt.int(res.namedSites) + ' named</span>' : '') +
        (res.skipped.length ? '<span class="tag tag-warn">' + res.skipped.length + ' line(s) skipped</span>' : '') +
        (res.notOffered ? '<span class="tag tag-err">' + res.notOffered + ' not on the rate card</span>' : '') +
        (sheets[state.sheet].truncated ? '<span class="tag tag-warn">file cut at 20,000 rows</span>' : '') +
        '</div>';

      if (res.rows.length) {
        var head = side === 'wan'
          ? '<th class="center">#</th><th>Product</th><th>Connectivity mode</th><th class="right">Sites</th><th class="right">Complexity</th><th class="right">Override</th>'
          : '<th class="center">#</th><th>Tier</th><th class="right">Sites</th><th class="right">Complexity</th><th class="right">Override</th>';
        var body = res.rows.map(function (r, i) {
          var offered = side === 'lan' || D.lookupBaseMd(r.connectivityMode, r.product) !== null;
          return '<tr' + (offered ? '' : ' class="row-invalid"') + '><td class="idx center">' + (i + 1) + '</td>' +
            (side === 'wan'
              ? '<td class="strong">' + esc(r.product) + '</td><td>' + esc(r.connectivityMode) +
                (offered ? '' : ' <span class="tag tag-err">not offered</span>') + '</td>'
              : '<td class="strong">' + esc(r.tierLabel) + '</td>') +
            '<td class="num">' + fmt.int(r.sites) + '</td>' +
            '<td class="num">' + r.complexityPct + '%</td>' +
            '<td class="num">' + (r.overrideMdPerSite > 0 ? fmt.md(r.overrideMdPerSite) : '—') + '</td></tr>';
        }).join('');
        html += '<div class="table-wrap scroll-y"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
      } else {
        html += '<div class="callout warn"><span class="callout-ic">⚠</span><span>No line produced a usable row. ' +
                'Check the column choices above, and the reasons below.</span></div>';
      }

      var unk = [];
      if (unknownList(res.unknown.product)) unk.push('<b>Products</b> ' + unknownList(res.unknown.product) + '. Known products: ' + esc(D.PRODUCTS.join(', ')) + '.');
      if (unknownList(res.unknown.mode)) unk.push('<b>Connectivity modes</b> ' + unknownList(res.unknown.mode) + '. Known modes: ' + esc(D.CONNECTIVITY_MODES.join(', ')) + '.');
      if (unknownList(res.unknown.tier)) unk.push('<b>Tiers</b> ' + unknownList(res.unknown.tier) + '. Known tiers: ' + esc(D.LAN_TIERS.map(function (t) { return t.name; }).join(', ')) + ', or give a device count.');
      if (unk.length) {
        html += '<div class="callout warn mt-3"><span class="callout-ic">⚠</span><span>Not recognised — fix these in the file and import again:<br>' +
                unk.join('<br>') + '</span></div>';
      }
      if (res.notOffered) {
        html += '<div class="callout err"><span class="callout-ic">✕</span><span>' + res.notOffered + ' row(s) pair a product with a connectivity mode ' +
                'the rate card does not offer. They are imported so nothing is lost, but Standard mode cannot price them — change the pairing, ' +
                'or switch to Non-standard mode and give them an override.</span></div>';
      }
      if (res.overrides && segValue(prefix(side) + '-mode') !== 'Non-standard') {
        html += '<div class="callout neutral"><span class="callout-ic">ℹ</span><span>' + res.overrides + ' row(s) carry an override MD per site. ' +
                'Overrides are only used in Non-standard mode.</span></div>';
      }
      if (res.skipped.length) {
        html += '<details class="fold"><summary>' + res.skipped.length + ' line(s) skipped — show why</summary><div class="import-skips mt-2">' +
          res.skipped.slice(0, 200).map(function (s) { return 'Row ' + s.row + ' — ' + esc(s.reason); }).join('<br>') +
          (res.skipped.length > 200 ? '<br>…' : '') + '</div></details>';
      }
      if (res.warnings.length) {
        html += '<details class="fold"><summary>' + res.warnings.length + ' note(s)</summary><div class="import-skips mt-2">' +
          res.warnings.slice(0, 200).map(esc).join('<br>') + '</div></details>';
      }
      host.innerHTML = html;
      renderOptions();
    }

    renderHeaderChoices();
    renderMapping();
    renderPreview();

    var root = qs('.dlg-backdrop');
    if (root) {
      root.addEventListener('change', function (e) {
        var t = e.target;
        if (t.id === 'imp-sheet') {
          setSheet(parseInt(t.value, 10) || 0);
          renderHeaderChoices(); renderMapping(); renderPreview();
        } else if (t.id === 'imp-header') {
          state.header = parseInt(t.value, 10) || 0;
          state.mapping = IM.guessMapping(sheets[state.sheet].rows[state.header] || [], side);
          renderMapping(); renderPreview();
        } else if (t.dataset.impRole) {
          state.mapping[t.dataset.impRole] = parseInt(t.value, 10);
          renderPreview();
        } else if (t.dataset.impHow) {
          state.replace = t.dataset.impHow === 'replace';
          renderOptions();
        } else if (t.dataset.impTotal) {
          state.setTotal = t.checked;
        }
      });
    }

    promise.then(function (res) {
      if (!res || res === true) return;
      var st = sideState(side);
      var imported = res.result.rows.map(function (r) { return Object.assign({}, r); });
      st.rows = res.replace ? imported : st.rows.concat(imported);
      if (res.setTotal) {
        setVal(prefix(side) + '-sites', st.rows.reduce(function (t, r) { return t + r.sites; }, 0));
      }
      if (side === 'wan') renderWanRows(); else renderLanRows();
      U.toast('Imported ' + fmt.int(res.result.totalSites) + ' site(s) as ' + imported.length + ' allocation row(s).', 'ok');
    });
  }

  /* ================================================================ DPMs = */

  function renderAssignedDpms(side) {
    var list = sideState(side).dpms;
    var host = el(prefix(side) + '-dpm-list');
    if (!list.length) {
      host.innerHTML = '<p class="empty-detail" style="text-align:left">No DPMs assigned yet. ' +
                       'Assignments are recorded on the estimate and included in exports.</p>';
      return;
    }
    host.innerHTML = '<div class="chip-row">' + list.map(function (d) {
      return '<div class="chip"><div class="chip-main">' +
        '<div class="chip-name">' + esc(d.name) + '</div>' +
        '<div class="chip-sub">' + esc(d.email) + '</div></div>' +
        '<span class="tag tag-info">' + esc(d.role || 'DPM') + '</span></div>';
    }).join('') + '</div>';
  }

  function openDpmPicker(side) {
    S.dpmPicker.side = side;
    S.dpmPicker.temp = sideState(side).dpms.map(function (d) { return Object.assign({}, d); });

    var promise = U.dialog({
      title: 'Assign DPMs',
      confirmLabel: 'Apply selection',
      bodyHtml:
        '<label class="dlg-label" for="dpm-modal-search">Search by name or email</label>' +
        '<input id="dpm-modal-search" class="dlg-input" type="text" placeholder="Start typing…" autocomplete="off">' +
        '<div class="dpm-grid scroll mt-3" id="dpm-modal-grid"></div>',
      submitOnEnter: false
    });

    /* The dialog is in the DOM synchronously, so its controls can be bound now. */
    renderDpmPickerGrid();
    var search = el('dpm-modal-search');
    if (search) search.addEventListener('input', renderDpmPickerGrid);
    var grid = el('dpm-modal-grid');
    if (grid) {
      grid.addEventListener('click', function (e) {
        var card = e.target.closest('[data-dpm-email]');
        if (!card || e.target.tagName === 'SELECT') return;
        toggleDpmSelection(card.dataset.dpmEmail, card.dataset.dpmName);
      });
      grid.addEventListener('change', function (e) {
        if (e.target.tagName !== 'SELECT') return;
        var card = e.target.closest('[data-dpm-email]');
        if (!card) return;
        var found = S.dpmPicker.temp.find(function (d) { return d.email === card.dataset.dpmEmail; });
        if (found) found.role = e.target.value;
      });
    }

    promise.then(function (result) {
      if (result !== true) return;
      sideState(S.dpmPicker.side).dpms = S.dpmPicker.temp.map(function (d) { return Object.assign({}, d); });
      renderAssignedDpms(S.dpmPicker.side);
      U.toast(S.dpmPicker.temp.length + ' DPM(s) assigned.', 'ok');
    });
  }

  function toggleDpmSelection(email, name) {
    var i = S.dpmPicker.temp.findIndex(function (d) { return d.email === email; });
    if (i >= 0) S.dpmPicker.temp.splice(i, 1);
    else S.dpmPicker.temp.push({ name: name, email: email, role: 'DPM' });
    renderDpmPickerGrid();
  }

  function renderDpmPickerGrid() {
    var grid = el('dpm-modal-grid');
    if (!grid) return;
    var q = (val('dpm-modal-search') || '').toLowerCase();
    var list = D.DPMS.filter(function (d) {
      return d.name.toLowerCase().indexOf(q) >= 0 || d.email.toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      grid.innerHTML = '<div class="empty"><p class="empty-title">No matches</p></div>';
      return;
    }
    grid.innerHTML = list.map(function (d) {
      var chosen = S.dpmPicker.temp.find(function (x) { return x.email === d.email; });
      var roleOptions = D.DPM_ROLES.map(function (r) {
        return '<option' + (chosen && chosen.role === r ? ' selected' : '') + '>' + esc(r) + '</option>';
      }).join('');
      return '<div class="dpm-card' + (chosen ? ' selected' : '') + '" data-dpm-email="' + esc(d.email) +
             '" data-dpm-name="' + esc(d.name) + '" role="button" tabindex="0">' +
        '<div class="dpm-name">' + esc(d.name) + '</div>' +
        '<div class="dpm-email">' + esc(d.email) + '</div>' +
        (chosen ? '<div class="dpm-role-row"><select aria-label="Role for ' + esc(d.name) + '">' + roleOptions + '</select></div>' : '') +
      '</div>';
    }).join('');
  }

  function renderDpmDirectory() {
    var q = (val('dpm-search') || '').toLowerCase();
    var list = D.DPMS.filter(function (d) {
      return d.name.toLowerCase().indexOf(q) >= 0 || d.email.toLowerCase().indexOf(q) >= 0;
    });
    el('dpm-count').textContent = list.length + ' of ' + D.DPMS.length;

    if (!D.DPMS.length) {
      el('dpm-directory').innerHTML =
        '<div class="empty"><div class="empty-ic">👤</div><p class="empty-title">The directory is empty</p>' +
        '<p class="empty-detail">Use <b>Add DPM</b> to build your list, <b>Import</b> to load one from a file, ' +
        'or <b>Restore published list</b> to bring back the version this app shipped with.</p></div>';
      return;
    }

    el('dpm-directory').innerHTML = list.length
      ? list.map(function (d) {
          return '<div class="dpm-card static">' +
            '<div class="dpm-card-head">' +
              '<div class="dpm-card-main">' +
                '<div class="dpm-name">' + esc(d.name) + '</div>' +
                '<div class="dpm-email">' + esc(d.email) + '</div>' +
              '</div>' +
              '<div class="dpm-card-actions">' +
                '<button type="button" class="icon-btn" data-dpm-act="edit" data-email="' + esc(d.email) +
                  '" title="Edit" aria-label="Edit ' + esc(d.name) + '">✎</button>' +
                '<button type="button" class="icon-btn danger" data-dpm-act="delete" data-email="' + esc(d.email) +
                  '" title="Remove" aria-label="Remove ' + esc(d.name) + '">✕</button>' +
              '</div>' +
            '</div></div>';
        }).join('')
      : '<div class="empty"><div class="empty-ic">👤</div><p class="empty-title">No matches</p>' +
        '<p class="empty-detail">No DPM matches that search.</p></div>';
  }

  /* Shared by add and edit. `existing` is null when adding. */
  function editDpmDialog(existing) {
    var isEdit = !!existing;

    U.dialog({
      title: isEdit ? 'Edit DPM' : 'Add a DPM',
      confirmLabel: isEdit ? 'Save changes' : 'Add',
      bodyHtml:
        '<label class="dlg-label" for="dpm-f-name">Full name</label>' +
        '<input id="dpm-f-name" class="dlg-input" type="text" autocomplete="off" value="' +
          esc(existing ? existing.name : '') + '">' +
        '<label class="dlg-label mt-3" for="dpm-f-email">Email address</label>' +
        '<input id="dpm-f-email" class="dlg-input" type="email" autocomplete="off" value="' +
          esc(existing ? existing.email : '') + '">' +
        '<p class="dlg-error" hidden></p>' +
        '<p class="field-help mt-2">The email address identifies the person, so changing it here replaces the old entry.</p>',
      submitOnEnter: true,

      /* Read while the dialog still exists, and validate in place. */
      collect: function (root) {
        var nameEl = qs('#dpm-f-name', root), emailEl = qs('#dpm-f-email', root);
        var errBox = qs('.dlg-error', root);
        var name = (nameEl.value || '').trim();
        var email = (emailEl.value || '').trim();

        function fail(message, focusEl) {
          errBox.textContent = message; errBox.hidden = false;
          if (focusEl) focusEl.focus();
          return false;
        }
        if (!name) return fail('Enter the person\'s name.', nameEl);
        if (!email) return fail('Enter an email address.', emailEl);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('That does not look like an email address.', emailEl);

        var clash = D.DPMS.find(function (d) {
          return d.email.toLowerCase() === email.toLowerCase() && (!isEdit || d.email !== existing.email);
        });
        if (clash) return fail('“' + clash.name + '” already uses that address.', emailEl);

        return { name: name, email: email };
      }
    }).then(function (result) {
      if (!result || result === true) return;   // cancelled

      var chain = Promise.resolve();
      /* The email is the key, so changing it means removing the old row. */
      if (isEdit && existing.email !== result.email) chain = DB.deleteDpm(existing.email);
      chain.then(function () { return DB.saveDpm(result); })
        .then(function () {
          renderDpmDirectory();
          U.toast(isEdit ? 'Updated ' + result.name + '.' : 'Added ' + result.name + '.', 'ok');
        });
    });

    var first = el('dpm-f-name');
    if (first) { first.focus(); first.select(); }
  }

  function deleteDpmPrompt(email) {
    var dpm = D.DPMS.find(function (d) { return d.email === email; });
    if (!dpm) return;
    U.confirm('Remove this DPM?',
      '“' + dpm.name + '” will be removed from your directory. Estimates that already reference them keep their record.',
      { confirmLabel: 'Remove', danger: true }).then(function (yes) {
      if (!yes) return;
      return DB.deleteDpm(email).then(function () {
        renderDpmDirectory();
        U.toast('Removed ' + dpm.name + '.', 'ok');
      });
    });
  }

  /* Accepts either a JSON array or a two-column CSV, because people will have
     the list in whichever of those their source system exports. */
  function parseDpmFile(text, filename) {
    var trimmed = text.replace(/^﻿/, '').trim();
    if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') {
      var parsed = JSON.parse(trimmed);
      var arr = Array.isArray(parsed) ? parsed : (parsed.dpms || parsed.directory || []);
      return arr.map(function (d) {
        return { name: String(d.name || '').trim(), email: String(d.email || '').trim() };
      });
    }
    return trimmed.split(/\r?\n/).map(function (line) {
      var cells = line.split(/[,;\t]/).map(function (c) { return c.trim().replace(/^"|"$/g, ''); });
      if (cells.length < 2) return null;
      if (/^(name|full ?name)$/i.test(cells[0])) return null;   // header row
      /* Tolerate either column order by looking for the one with an @ in it. */
      var emailIdx = cells.findIndex(function (c) { return c.indexOf('@') > 0; });
      if (emailIdx < 0) return null;
      var nameIdx = emailIdx === 0 ? 1 : 0;
      return { name: cells[nameIdx], email: cells[emailIdx] };
    }).filter(function (d) { return d && d.name && d.email; });
  }

  function importDpmFile(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var list;
      try { list = parseDpmFile(e.target.result, file.name); }
      catch (err) { U.toast('Could not read that file: ' + err.message, 'err'); input.value = ''; return; }
      if (!list.length) { U.toast('No usable name/email pairs were found in that file.', 'warn'); input.value = ''; return; }

      U.dialog({
        title: 'Import ' + list.length + ' DPM(s)',
        confirmLabel: 'Merge into my list',
        cancelLabel: 'Cancel',
        bodyHtml:
          '<p>Found <b>' + list.length + '</b> entries in <span class="code">' + esc(file.name) + '</span>.</p>' +
          '<p class="mt-3"><b>Merge</b> adds them to your existing ' + D.DPMS.length +
          ', updating anyone whose email already appears. To start from just this file instead, ' +
          'use Replace below.</p>' +
          '<div class="btn-row mt-3"><button type="button" class="btn btn-outline btn-sm" data-import-mode="replace">' +
          'Replace my whole list instead</button></div>'
      }).then(function (result) {
        if (result !== true) return;
        applyDpmImport(list, 'merge');
      });

      var replaceBtn = qs('[data-import-mode="replace"]');
      if (replaceBtn) {
        replaceBtn.addEventListener('click', function () {
          var backdrop = qs('.dlg-backdrop');
          if (backdrop) backdrop.remove();
          applyDpmImport(list, 'replace');
        });
      }
      input.value = '';
    };
    reader.readAsText(file);
  }

  function applyDpmImport(list, how) {
    var op;
    if (how === 'replace') {
      op = DB.replaceDpms(list);
    } else {
      var merged = D.DPMS.slice();
      list.forEach(function (incoming) {
        var i = merged.findIndex(function (d) { return d.email.toLowerCase() === incoming.email.toLowerCase(); });
        if (i >= 0) merged[i] = incoming; else merged.push(incoming);
      });
      op = DB.replaceDpms(merged);
    }
    op.then(function () {
      renderDpmDirectory();
      U.toast(how === 'replace'
        ? ('Directory replaced — ' + D.DPMS.length + ' DPM(s).')
        : ('Directory merged — now ' + D.DPMS.length + ' DPM(s).'), 'ok');
    });
  }

  function resetDpmsPrompt() {
    U.confirm('Restore the published list?',
      'Your directory will be replaced with the ' + D.seedDpms().length +
      ' entries this app was published with. Anyone you added will be removed.',
      { confirmLabel: 'Restore', danger: true }).then(function (yes) {
      if (!yes) return;
      return DB.resetDpmsToSeed().then(function () {
        renderDpmDirectory();
        U.toast('Published list restored.', 'ok');
      });
    });
  }

  /* --------------------------------------------------- backup / restore -- */

  function downloadJson(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportBackup() {
    Promise.all([DB.listRecords(), DB.listProjects()]).then(function (res) {
      var payload = {
        app: 'DPM FTE Calculator',
        appVersion: D.APP_VERSION,
        exportedAt: new Date().toISOString(),
        settings: S.settings,
        dpms: D.DPMS.map(function (d) { return { name: d.name, email: d.email }; }),
        records: res[0].map(function (r) { var c = Object.assign({}, r); delete c.sync; return c; }),
        projects: res[1]
      };
      downloadJson(payload, 'DPM-FTE-backup-' + new Date().toISOString().slice(0, 10) + '.json');
      U.toast('Backup downloaded — ' + res[0].length + ' record(s), ' + res[1].length + ' project(s).', 'ok');
    });
  }

  function importBackup(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var data;
      try { data = JSON.parse(e.target.result); }
      catch (err) { U.toast('That file is not valid JSON.', 'err'); input.value = ''; return; }

      var records = data.records || [], projects = data.projects || [], dpms = data.dpms || [];
      U.confirm('Restore this backup?',
        'It contains ' + records.length + ' record(s), ' + projects.length + ' project(s) and ' +
        dpms.length + ' DPM(s), saved ' + fmt.dateTime(data.exportedAt) + '. ' +
        'Anything already here is kept — only missing items are added.',
        { confirmLabel: 'Restore' }).then(function (yes) {
        if (!yes) return;
        return DB.listRecords().then(function (existing) {
          var known = {};
          existing.forEach(function (r) { known[r.id] = true; });
          var toAdd = records.filter(function (r) { return r && r.id && !known[r.id]; });
          return toAdd.reduce(function (chain, r) {
            return chain.then(function () { return DB.saveRecord(r); });
          }, Promise.resolve()).then(function () { return toAdd.length; });
        }).then(function (addedRecords) {
          return projects.reduce(function (chain, p) {
            return chain.then(function () { return p && p.name ? DB.saveProject(p) : null; });
          }, Promise.resolve()).then(function () { return addedRecords; });
        }).then(function (addedRecords) {
          return Promise.all([DB.listRecords(), DB.listProjects()]).then(function (res) {
            S.records = res[0]; S.projects = res[1];
            renderRecords(); renderPortfolio(); renderProjects(); renderDashboard(); renderSettingsPage();
            U.toast('Restored — ' + addedRecords + ' new record(s) added.', 'ok');
          });
        });
      });
      input.value = '';
    };
    reader.readAsText(file);
  }

  /* ============================================================== stages = */

  function selectedStages() {
    return qsa('#l-stages .stage-chip.checked').map(function (n) { return n.dataset.stage; });
  }

  function renderStageChips() {
    var host = el('l-stages');
    var current = selectedStages();
    host.innerHTML = D.STAGE_NAMES.map(function (name) {
      var checked = current.indexOf(name) >= 0;
      var perSite = D.stageMdPerSite('M', [name]);
      return '<button type="button" class="stage-chip' + (checked ? ' checked' : '') + '" data-stage="' + esc(name) +
             '" aria-pressed="' + checked + '">' +
             '<span class="stage-box">✓</span><span>' + esc(name) + '</span>' +
             '<span class="stage-hours">' + perSite.toFixed(2) + ' MD</span></button>';
    }).join('');
    renderStageSummary();
  }

  function renderStageSummary() {
    var host = el('l-stages-anchor');
    if (!host) return;
    var stages = selectedStages();
    if (!stages.length) {
      host.innerHTML = '<div class="callout warn mt-3"><span class="callout-ic">⚠</span>' +
        '<span>No stages selected. By Stage mode needs at least one.</span></div>';
      return;
    }
    var rows = D.LAN_TIERS.map(function (t) {
      var md = D.stageMdPerSite(t.key, stages);
      return '<tr><td class="strong">' + esc(t.name) + '</td><td>' + esc(t.range) + '</td>' +
             '<td class="num">' + (md * D.HOURS_PER_DAY).toFixed(2) + '</td>' +
             '<td class="num">' + md.toFixed(3) + '</td></tr>';
    }).join('');
    host.innerHTML = '<p class="table-caption">Resulting rate per site for the stages selected above:</p>' +
      '<div class="table-wrap"><table><thead><tr><th>Tier</th><th>Device range</th>' +
      '<th class="right">Hours per site</th><th class="right">MD per site</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>';
  }

  /* ============================================================ duration = */

  function switchDuration(side, mode) {
    var p = prefix(side);
    sideState(side).durMode = mode;
    el(p + '-dur-months').classList.toggle('hidden', mode !== 'months');
    el(p + '-dur-dates').classList.toggle('hidden', mode !== 'dates');
    qsa('#' + p + '-dur-tabs button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.dur === mode);
    });
  }

  /* Dates drive the months field, keeping the fraction rather than rounding
     it away, and the derived value is shown so nothing happens invisibly. */
  function recalcDuration(side) {
    var p = prefix(side);
    var months = C.monthsBetween(val(p + '-start-date'), val(p + '-end-date'), S.settings.dateDaysPerMonth);
    var out = el(p + '-dur-derived');
    if (months === null) {
      out.textContent = '—';
      out.title = 'Enter a start date and a later end date.';
      return;
    }
    setVal(p + '-months', months.toFixed(2));
    out.textContent = months.toFixed(2) + ' months';
    out.title = 'Calculated from the date range using an average month of ' + S.settings.dateDaysPerMonth + ' days.';
  }

  /* =========================================================== calculate = */

  /* The code must be stable for a given project but must not leak across
     projects: recalculating "Q3 EMEA" ten times keeps one code, whereas
     renaming the form to a different project earns a fresh one. Tying the
     code to the name it was minted for gives both. */
  function normName(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  /* A project that has been estimated before keeps its code: the other
     estimator's current code when it is the same project, else the code on
     the newest saved estimate with this name. Without this, every page load
     minted a new code for the same project, and the team plan could not tell
     a re-estimate from a second project. */
  function existingCodeFor(name, side) {
    var key = normName(name);
    if (!key) return null;
    var other = sideState(side === 'wan' ? 'lan' : 'wan');
    if (other.code && normName(other.codeName) === key) return other.code;
    var hit = S.records.find(function (r) { return r.projectCode && normName(r.projectName) === key; });
    return hit ? hit.projectCode : null;
  }

  function ensureCode(side) {
    var st = sideState(side);
    var name = (val(prefix(side) + '-proj-name') || '').trim();
    if (!st.code || st.codeName !== name) {
      st.code = existingCodeFor(name, side) || C.makeProjectCode(name);
      st.codeName = name;
    }
    var pill = el(prefix(side) + '-code-pill');
    pill.textContent = st.code;
    pill.classList.remove('hidden');
    pill.title = 'Stable project code. Generated once and reused on every calculation and export.';
    return st.code;
  }

  /* When the project starts, for the team plan. A date-driven duration
     already says so; otherwise it is the Planned start field. */
  function plannedStart(side) {
    var p = prefix(side);
    if (sideState(side).durMode === 'dates') return (val(p + '-start-date') || '').slice(0, 7);
    return val(p + '-start-month') || '';
  }

  function collectWanInput() {
    return {
      months: numVal('w-months'),
      totalSites: numVal('w-sites'),
      mode: segValue('w-mode'),
      migration: segValue('w-migration'),
      distribution: segValue('w-dist'),
      allocation: S.wan.rows.map(function (r) { return Object.assign({}, r); })
    };
  }

  function collectLanInput() {
    return {
      months: numVal('l-months'),
      totalSites: numVal('l-sites'),
      devices: numVal('l-devices'),
      mode: segValue('l-mode'),
      stages: selectedStages(),
      fallbackOverride: numVal('l-fb-ovrd') || null,
      distribution: segValue('l-dist'),
      allocation: S.lan.rows.map(function (r) { return Object.assign({}, r); })
    };
  }

  function calculateWan() {
    U.clearFieldErrors();
    var input = collectWanInput();
    var result = C.calculateWan(input, S.settings);
    if (!result.ok) { U.reportErrors(result.errors); return; }

    var record = {
      id: C.makeRecordId(),
      savedAt: new Date().toISOString(),
      appVersion: D.APP_VERSION,
      type: 'WAN',
      projectCode: ensureCode('wan'),
      projectName: val('w-proj-name') || 'Untitled WAN project',
      status: segValue('w-status'),
      notes: (val('w-notes') || '').trim(),
      /* The complete input set is frozen onto the record here. Exports and the
         records page read only from this, never from the live form. */
      inputs: {
        months: input.months,
        startDate: val('w-start-date'),
        endDate: val('w-end-date'),
        durationSource: S.wan.durMode,
        startMonth: plannedStart('wan'),
        totalSites: input.totalSites,
        mode: input.mode,
        migration: input.migration,
        projectType: val('w-type'),
        abacos: segValue('w-abacos'),
        pmRole: segValue('w-pm-role'),
        capacityMdPerMonth: S.settings.capacityMdPerMonth,
        migrationMdPerSite: S.settings.migrationMdPerSite,
        distribution: result.distribution,
        allocation: input.allocation
      },
      dpms: S.wan.dpms.map(function (d) { return Object.assign({}, d); }),
      results: {
        rows: result.rows, baseMd: result.baseMd, migrationMd: result.migrationMd,
        totalMd: result.totalMd, mdPerMonth: result.mdPerMonth, fte: result.fte,
        headcount: result.headcount, utilisationPct: result.utilisationPct,
        monthly: result.monthly, steps: result.steps, warnings: result.warnings,
        distribution: result.distribution, usingBell: result.usingBell,
        peakMd: result.peakMd, peakFte: result.peakFte,
        peakHeadcount: result.peakHeadcount, peakUtilisationPct: result.peakUtilisationPct,
        peakMonth: result.peakMonth
      }
    };

    S.wan.record = record;
    renderWanResult(record);
    renderResultChip(record);
    persistRecord(record);
  }

  function calculateLan() {
    U.clearFieldErrors();
    var input = collectLanInput();
    var result = C.calculateLan(input, S.settings);
    if (!result.ok) { U.reportErrors(result.errors); return; }

    var record = {
      id: C.makeRecordId(),
      savedAt: new Date().toISOString(),
      appVersion: D.APP_VERSION,
      type: 'LAN',
      projectCode: ensureCode('lan'),
      projectName: val('l-proj-name') || 'Untitled LAN project',
      status: segValue('l-status'),
      notes: (val('l-notes') || '').trim(),
      inputs: {
        months: input.months,
        startDate: val('l-start-date'),
        endDate: val('l-end-date'),
        durationSource: S.lan.durMode,
        startMonth: plannedStart('lan'),
        totalSites: input.totalSites,
        devices: input.devices,
        mode: input.mode,
        stages: input.stages,
        fallbackOverride: input.fallbackOverride,
        flan: segValue('l-flan'),
        pmRole: segValue('l-pm-role'),
        capacityMdPerMonth: S.settings.capacityMdPerMonth,
        distribution: result.distribution,
        allocation: input.allocation
      },
      dpms: S.lan.dpms.map(function (d) { return Object.assign({}, d); }),
      results: {
        rows: result.rows, baseMd: result.baseMd, migrationMd: 0,
        totalMd: result.totalMd, mdPerMonth: result.mdPerMonth, fte: result.fte,
        headcount: result.headcount, utilisationPct: result.utilisationPct,
        monthly: result.monthly, steps: result.steps, warnings: result.warnings,
        usedTierRows: result.usedTierRows, fallbackTier: result.fallbackTier,
        distribution: result.distribution, usingBell: result.usingBell,
        peakMd: result.peakMd, peakFte: result.peakFte,
        peakHeadcount: result.peakHeadcount, peakUtilisationPct: result.peakUtilisationPct,
        peakMonth: result.peakMonth
      }
    };

    S.lan.record = record;
    renderLanResult(record);
    renderResultChip(record);
    persistRecord(record);
  }

  function persistRecord(record) {
    DB.saveRecord(record).then(function (res) {
      if (res.written) U.toast('Calculation saved to ' + res.file, 'ok');
      else U.toast('Calculation saved in this browser. It will be written to the data folder when the app host is running.', 'warn');
      renderStorageStatus();
      return DB.listRecords();
    }).then(function (rows) {
      S.records = rows;
      renderDashboard();
    });
  }

  /* Notes and the planned start month may change after Calculate without a
     recalculation - neither feeds the arithmetic. Before an export or email,
     and when the start month is edited, the live values are copied onto the
     active record and it is re-persisted. Everything else on the record stays
     frozen. Only while the form still shows that record's project, so loading
     a different project never writes its notes onto the old estimate. */
  function formShowsRecord(side, rec) {
    if (!rec) return false;
    var formName = (val(prefix(side) + '-proj-name') || '').trim();
    return rec.projectCode === sideState(side).code && (!formName || formName === rec.projectName);
  }

  /* Resolves with the active record, re-saved if anything changed. The
     start month is only taken from the form when the user has just edited
     that field (startEdited) - otherwise a month a colleague moved on the
     team plan would be put back from this page's stale form. The re-save
     starts from the freshest stored copy and changes only these fields. */
  function syncActiveNotes(side, startEdited) {
    var st = sideState(side);
    var rec = st.record;
    if (!formShowsRecord(side, rec)) return Promise.resolve(rec);
    var p = prefix(side);
    var notes = (val(p + '-notes') || '').trim();
    var start = val(p + '-start-month') || '';
    var notesChanged = (rec.notes || '') !== notes;
    /* A date-driven estimate takes its start from the dates, which cannot
       change without recalculating. */
    var startChanged = !!startEdited && rec.inputs && rec.inputs.durationSource !== 'dates' &&
                       (rec.inputs.startMonth || '') !== start;
    if (!notesChanged && !startChanged) return Promise.resolve(rec);

    return DB.getFreshRecord(rec.id).then(function (fresh) {
      var target = fresh || rec;
      if (notesChanged) target.notes = notes;
      if (startChanged) target.inputs.startMonth = start;
      return DB.updateRecord(target);
    }).then(function (res) {
      var saved = res.record;
      if (st.record && st.record.id === saved.id) st.record = saved;
      if (!startChanged && saved.inputs.durationSource !== 'dates') setVal(p + '-start-month', saved.inputs.startMonth || '');
      S.plan.team = null;   // the team plan re-reads on its next visit
      return DB.listRecords().then(function (rows) { S.records = rows; return saved; });
    }).catch(function (err) {
      console.error(err);
      return rec;
    });
  }

  /* ============================================================= results = */

  function resultCell(label, value, helpKey, small, accent) {
    return '<div class="result-cell' + (accent ? ' accent' : '') + '"><div class="result-cell-label">' + esc(label) +
      (helpKey ? ' ' + U.hint(helpKey) : '') + '</div>' +
      '<div class="result-cell-value' + (small ? ' sm' : '') + '">' + value + '</div></div>';
  }

  function stepsHtml(steps) {
    return '<ol class="steps">' + (steps || []).map(function (s) {
      return '<li><span class="step-label">' + esc(s.label) +
        '<span class="step-formula">' + esc(s.formula) + '</span></span>' +
        '<span class="step-value">' + esc(s.value) + '</span></li>';
    }).join('') + '</ol>';
  }

  function rowMathHtml(rows) {
    return '<div class="summary-list">' + rows.map(function (r) {
      var name = r.product ? (r.product + ' — ' + r.connectivityMode) : r.label;
      return '<div>· <b>' + esc(name) + '</b><br>' +
        '<span class="row-math">' + fmt.md(r.baseMdPerSite) + ' MD/site × ' + r.complexityPct +
        '% × ' + fmt.int(r.sites) + ' sites = <b>' + fmt.md(r.md) + ' MD</b> (' + r.pctOfTotal + '% of total)</span></div>';
    }).join('') + '</div>';
  }

  function warningsHtml(warnings) {
    if (!warnings || !warnings.length) return '';
    return warnings.map(function (w) {
      return '<div class="callout warn"><span class="callout-ic">⚠</span><span>' + esc(w) + '</span></div>';
    }).join('');
  }

  /* Records saved before this change carry usingSchedule instead of usingBell;
     treat either as "distribution is shaped, show the peak". */
  function isShaped(r) { return !!(r.usingBell || r.usingSchedule); }

  /* The result KPI grid, shared by WAN and LAN. With a bell-curve distribution
     it grows three extra cells for the peak, and the two labels that differ
     between the flat and shaped cases adapt. */
  function resultGridHtml(r, i) {
    var shaped = isShaped(r);
    var cells =
      resultCell(shaped ? 'FTE (average)' : 'FTE required', fmt.fte(r.fte), 'fte') +
      resultCell('Headcount', r.headcount + ' people', 'headcount') +
      resultCell('Utilisation', fmt.pct(r.utilisationPct), 'utilisation') +
      resultCell('Total effort', fmt.md(r.totalMd) + ' MD', 'totalMd') +
      resultCell(shaped ? 'Average / month' : 'Per month', fmt.md(r.mdPerMonth) + ' MD', 'mdPerMonth') +
      resultCell('Duration', fmt.months(i.months), null, true);
    if (shaped) {
      cells +=
        resultCell('Peak FTE', fmt.fte(r.peakFte), 'peakFte', false, true) +
        resultCell('Peak headcount', r.peakHeadcount + ' people', 'peakHeadcount', false, true) +
        resultCell('Busiest month', 'Month ' + r.peakMonth + ' · ' + fmt.md1(r.peakMd) + ' MD', null, true);
    }
    return '<div class="result-grid">' + cells + '</div>';
  }

  function distributionNoteHtml(r) {
    if (!isShaped(r)) return '';
    return '<div class="callout"><span class="callout-ic">📈</span><span>' +
      '<b>Bell-curve distribution.</b> The man-days ramp up to a peak in <b>month ' + r.peakMonth +
      '</b> at ' + fmt.md1(r.peakMd) + ' MD and back down. That peak needs <b>' +
      fmt.fte(r.peakFte) + ' FTE (' + r.peakHeadcount + ' people)</b> — the level you actually staff to. ' +
      'The average FTE above is the total effort levelled evenly across the duration.</span></div>';
  }

  function renderWanResult(record) {
    var r = record.results, i = record.inputs;
    el('w-results').classList.remove('hidden');
    el('w-result-box').innerHTML =
      '<div class="result-title">✓ WAN result — ' + esc(record.projectName) +
        ' <span class="tag tag-info">' + esc(record.projectCode) + '</span>' +
        ' <span class="tag tag-muted">' + esc(i.mode) + ' mode</span>' +
        (isShaped(r) ? ' <span class="tag tag-info">bell curve</span>' : '') + '</div>' +
      warningsHtml(r.warnings) +
      distributionNoteHtml(r) +
      resultGridHtml(r, i) +
      '<div class="divider"><span>Effort by row</span></div>' + rowMathHtml(r.rows) +
      '<div class="divider"><span>How this number was reached</span></div>' + stepsHtml(r.steps);

    hydrateHelp();
    U.barChart('w-chart-products', r.rows.map(function (x) { return x.product; }),
               r.rows.map(function (x) { return x.md; }), 'Man-days', 0);
    U.barChart('w-chart-monthly', r.monthly.map(function (m) { return 'M' + m.month + (m.partial ? '*' : ''); }),
               r.monthly.map(function (m) { return m.md; }), 'MD per month', 0, true);
  }

  function renderLanResult(record) {
    var r = record.results, i = record.inputs;
    el('l-results').classList.remove('hidden');
    el('l-result-box').innerHTML =
      '<div class="result-title">✓ LAN result — ' + esc(record.projectName) +
        ' <span class="tag tag-info">' + esc(record.projectCode) + '</span>' +
        ' <span class="tag tag-muted">' + esc(i.mode) + ' mode</span>' +
        (i.stages && i.stages.length ? ' <span class="tag tag-muted">' + esc(i.stages.join(', ')) + '</span>' : '') +
        (isShaped(r) ? ' <span class="tag tag-info">bell curve</span>' : '') +
      '</div>' +
      warningsHtml(r.warnings) +
      distributionNoteHtml(r) +
      resultGridHtml(r, i) +
      '<div class="divider"><span>Effort by row</span></div>' + rowMathHtml(r.rows) +
      '<div class="divider"><span>How this number was reached</span></div>' + stepsHtml(r.steps);

    hydrateHelp();
    U.barChart('l-chart-tiers', r.rows.map(function (x) { return x.label; }),
               r.rows.map(function (x) { return x.md; }), 'Man-days', 1);
    U.barChart('l-chart-monthly', r.monthly.map(function (m) { return 'M' + m.month + (m.partial ? '*' : ''); }),
               r.monthly.map(function (m) { return m.md; }), 'MD per month', 1, true);
  }

  /* =========================================================== dashboard = */

  function kpiCard(cls, label, value, sub, helpKey, small) {
    return '<div class="kpi ' + cls + '"><div class="kpi-label">' + esc(label) +
      (helpKey ? ' ' + U.hint(helpKey) : '') + '</div>' +
      '<div class="kpi-value' + (small ? ' small' : '') + '">' + esc(value) + '</div>' +
      '<div class="kpi-sub">' + esc(sub) + '</div></div>';
  }

  function latestOfType(type) {
    return S.records.filter(function (r) { return r.type === type; })[0] || null;
  }

  function renderDashboard() {
    var wan = S.wan.record || latestOfType('WAN');
    var lan = S.lan.record || latestOfType('LAN');

    if (!wan && !lan) {
      el('dash-content').classList.add('hidden');
      el('dash-empty').innerHTML =
        '<div class="card"><div class="empty"><div class="empty-ic">▦</div>' +
        '<p class="empty-title">No calculations yet</p>' +
        '<p class="empty-detail">Run an estimate from the WAN or LAN page and the results will appear here. ' +
        'Every calculation is saved automatically.</p></div></div>';
      return;
    }
    el('dash-empty').innerHTML = '';
    el('dash-content').classList.remove('hidden');

    function kpis(rec, cls) {
      if (!rec) {
        return '<div class="kpi"><div class="kpi-label">No estimate yet</div>' +
               '<div class="kpi-value small">—</div>' +
               '<div class="kpi-sub">Run a calculation to populate this row.</div></div>';
      }
      var r = rec.results;
      return kpiCard(cls, 'Total man-days', fmt.md1(r.totalMd),
                     fmt.int(rec.inputs.totalSites) + ' sites over ' + fmt.months(rec.inputs.months), 'totalMd') +
             kpiCard(cls === 'g' ? 'g' : 'b', 'Man-days per month', fmt.md1(r.mdPerMonth),
                     'Sustained monthly workload', 'mdPerMonth') +
             kpiCard('a', 'FTE required', fmt.fte(r.fte),
                     'At ' + rec.inputs.capacityMdPerMonth + ' MD per DPM per month', 'fte') +
             kpiCard('v', 'Headcount', r.headcount + ' × ' + fmt.pct(r.utilisationPct),
                     'People needed and how loaded they are', 'headcount', true);
    }

    el('dash-wan-kpis').innerHTML = kpis(wan, 'b');
    el('dash-lan-kpis').innerHTML = kpis(lan, 'g');
    hydrateHelp();

    if (wan) {
      U.barChart('dash-wan-chart', wan.results.rows.map(function (x) { return x.product || x.label; }),
                 wan.results.rows.map(function (x) { return x.md; }), 'Man-days', 0);
    } else U.destroyChart('dash-wan-chart');

    if (lan) {
      U.barChart('dash-lan-chart', lan.results.rows.map(function (x) { return x.label; }),
                 lan.results.rows.map(function (x) { return x.md; }), 'Man-days', 1);
    } else U.destroyChart('dash-lan-chart');

    /* Combined monthly view: overlap the two calendars month by month. */
    var months = Math.max(wan ? wan.results.monthly.length : 0, lan ? lan.results.monthly.length : 0);
    var labels = [], values = [];
    for (var m = 0; m < months; m++) {
      labels.push('Month ' + (m + 1));
      var v = 0;
      if (wan && wan.results.monthly[m]) v += wan.results.monthly[m].md;
      if (lan && lan.results.monthly[m]) v += lan.results.monthly[m].md;
      values.push(C.round(v, 2));
    }
    U.barChart('dash-monthly-chart', labels, values, 'MD per month', 2, true);
  }

  /* ============================================================= records = */

  function filteredRecords() {
    var q = (val('rec-search') || '').toLowerCase();
    var type = val('rec-type'), status = val('rec-status'), sort = val('rec-sort');
    var list = S.records.filter(function (r) {
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
      if (!q) return true;
      return (r.projectName || '').toLowerCase().indexOf(q) >= 0 ||
             (r.projectCode || '').toLowerCase().indexOf(q) >= 0 ||
             (r.id || '').toLowerCase().indexOf(q) >= 0;
    });
    var sorters = {
      newest: function (a, b) { return (b.savedAt || '').localeCompare(a.savedAt || ''); },
      oldest: function (a, b) { return (a.savedAt || '').localeCompare(b.savedAt || ''); },
      fte: function (a, b) { return b.results.fte - a.results.fte; },
      md: function (a, b) { return b.results.totalMd - a.results.totalMd; },
      name: function (a, b) { return (a.projectName || '').localeCompare(b.projectName || ''); }
    };
    return list.sort(sorters[sort] || sorters.newest);
  }

  function renderRecords() {
    var list = filteredRecords();
    el('records-count').textContent = list.length + ' of ' + S.records.length + ' shown';
    var host = el('records-list');

    if (!list.length) {
      host.innerHTML = '<div class="empty"><div class="empty-ic">🗄</div>' +
        '<p class="empty-title">' + (S.records.length ? 'Nothing matches those filters' : 'No calculations saved yet') + '</p>' +
        '<p class="empty-detail">' + (S.records.length
          ? 'Try clearing the search box or the type filter.'
          : 'Run an estimate from the WAN or LAN page. Every calculation is recorded here automatically.') +
        '</p></div>';
      return;
    }

    host.innerHTML = '<div class="record-list">' + list.map(function (r) {
      var pending = !r.sync || r.sync.state !== 'saved';
      return '<div class="record-item" data-record-id="' + esc(r.id) + '">' +
        '<div class="record-main">' +
          '<div class="record-title-row">' +
            '<span class="record-name">' + esc(r.projectName) + '</span>' +
            '<span class="tag ' + (r.type === 'WAN' ? 'tag-info' : 'tag-ok') + '">' + esc(r.type) + '</span>' +
            '<span class="tag tag-muted">' + esc(r.status || '—') + '</span>' +
            (pending ? '<span class="tag tag-warn" title="Not yet written to the data folder">browser only</span>' : '') +
          '</div>' +
          '<div class="record-meta">' +
            '<span class="record-code">' + esc(r.projectCode) + '</span>' +
            '<span>' + esc(fmt.dateTime(r.savedAt)) + '</span>' +
            '<span>' + fmt.int(r.inputs.totalSites) + ' sites · ' + esc(fmt.months(r.inputs.months)) + '</span>' +
            '<span>' + esc(r.inputs.mode) + ' mode</span>' +
            (PL.startMonthOf(r) ? '<span>starts ' + esc(PL.monthLabel(PL.startMonthOf(r))) + '</span>' : '') +
            ((r.dpms || []).length ? '<span>' + r.dpms.length + ' DPM(s)</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="record-figures">' +
          '<div class="record-fig"><div class="record-fig-v">' + fmt.md1(r.results.totalMd) + '</div><div class="record-fig-l">man-days</div></div>' +
          '<div class="record-fig"><div class="record-fig-v">' + fmt.fte(r.results.fte) + '</div><div class="record-fig-l">FTE</div></div>' +
          '<div class="record-fig"><div class="record-fig-v">' + r.results.headcount + '</div><div class="record-fig-l">HC</div></div>' +
        '</div>' +
        '<div class="actions">' +
          '<button type="button" class="icon-btn" data-rec-act="view" data-id="' + esc(r.id) + '" title="View full detail" aria-label="View detail">👁</button>' +
          '<button type="button" class="icon-btn" data-rec-act="export" data-id="' + esc(r.id) + '" title="Export to Excel" aria-label="Export">↓</button>' +
          '<button type="button" class="icon-btn danger" data-rec-act="delete" data-id="' + esc(r.id) + '" title="Delete this record" aria-label="Delete">✕</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  function viewRecord(id) {
    var rec = S.records.find(function (r) { return r.id === id; });
    if (!rec) return;
    var r = rec.results, i = rec.inputs;

    var infoRows = rec.type === 'WAN'
      ? [['Project type', i.projectType], ['ABACOS', i.abacos], ['DPM acting as PM', i.pmRole]]
      : [['FLAN used', i.flan], ['DPM acting as PM', i.pmRole], ['Device count', i.devices]];

    U.dialog({
      title: rec.projectName + ' — ' + rec.type,
      confirmLabel: 'Export to Excel',
      cancelLabel: 'Close',
      bodyHtml:
        '<p><span class="tag tag-info">' + esc(rec.projectCode) + '</span> ' +
        '<span class="tag tag-muted">' + esc(rec.id) + '</span></p>' +
        '<p class="mt-3"><b>Calculated</b> ' + esc(fmt.dateTime(rec.savedAt)) + ' · ' +
        esc(i.mode) + ' mode · capacity ' + i.capacityMdPerMonth + ' MD per month' +
        (PL.startMonthOf(rec) ? ' · planned start <b>' + esc(PL.monthLabel(PL.startMonthOf(rec))) + '</b>' : '') + '</p>' +
        distributionNoteHtml(r) +
        '<div class="result-grid mt-3">' +
          resultCell(isShaped(r) ? 'FTE (avg)' : 'FTE', fmt.fte(r.fte)) +
          resultCell('Headcount', String(r.headcount)) +
          resultCell('Utilisation', fmt.pct(r.utilisationPct)) +
          resultCell('Total MD', fmt.md(r.totalMd)) +
          resultCell(isShaped(r) ? 'Avg / month' : 'Per month', fmt.md(r.mdPerMonth)) +
          resultCell('Sites', fmt.int(i.totalSites)) +
          (isShaped(r) ? resultCell('Peak FTE', fmt.fte(r.peakFte), null, false, true) : '') +
          (isShaped(r) ? resultCell('Peak HC', String(r.peakHeadcount), null, false, true) : '') +
          (isShaped(r) ? resultCell('Busiest', 'Mo ' + r.peakMonth, null, true) : '') +
        '</div>' +
        '<div class="divider"><span>Effort by row</span></div>' + rowMathHtml(r.rows) +
        ((rec.notes || '').trim() ? '<div class="divider"><span>Notes</span></div><div class="callout neutral"><span class="callout-ic">📝</span><span>' + esc((rec.notes || '').trim()).replace(/\n/g, '<br>') + '</span></div>' : '') +
        '<div class="divider"><span>Working</span></div>' + stepsHtml(r.steps) +
        '<div class="divider"><span>Recorded only</span></div>' +
        '<div class="summary-list">' + infoRows.map(function (p) {
          return '<div><span class="k">' + esc(p[0]) + ':</span> <b>' + esc(p[1] === undefined || p[1] === '' ? '—' : p[1]) + '</b></div>';
        }).join('') + '</div>' +
        ((rec.dpms || []).length
          ? '<div class="divider"><span>Assigned DPMs</span></div><div class="summary-list">' +
            rec.dpms.map(function (d) { return '<div>· <b>' + esc(d.name) + '</b> <span class="k">' + esc(d.email) + '</span> — ' + esc(d.role || 'DPM') + '</div>'; }).join('') +
            '</div>'
          : '')
    }).then(function (res) { if (res === true) EX.exportRecord(rec); });

    var box = qs('.dlg');
    if (box) box.classList.add('wide');
  }

  function deleteRecord(id) {
    var rec = S.records.find(function (r) { return r.id === id; });
    if (!rec) return;
    var st = DB.status();
    var offline = st.mode === 'browser' && (st.canReachHost || st.folderNeedsReconnect);
    var where = offline
      ? 'this browser now, and from the data folder as soon as it can be reached again'
      : (st.shared ? 'this browser and from the shared data folder, for everyone who uses it'
                   : (st.mode === 'browser' ? 'this browser' : 'this browser and from the data folder'));
    U.confirm('Delete this record?',
      'This removes "' + rec.projectName + '" (' + fmt.dateTime(rec.savedAt) + ') from ' + where + '. It cannot be undone.',
      { confirmLabel: 'Delete', danger: true }
    ).then(function (yes) {
      if (!yes) return;
      return DB.deleteRecord(id).then(function (res) {
        return DB.listRecords().then(function (rows) {
          S.records = rows; S.plan.team = null;
          if (S.wan.record && S.wan.record.id === id) S.wan.record = null;
          if (S.lan.record && S.lan.record.id === id) S.lan.record = null;
          renderRecords(); renderPortfolio(); renderDashboard();
          /* No disk at all (plain browser mode) is not a delay worth mentioning. */
          var queued = res && res.onDisk === false && (st.mode !== 'browser' || offline);
          U.toast(queued ? 'Deleted here. The file will be removed from the data folder once it can be reached.'
                         : 'Record deleted.', queued ? 'warn' : 'ok');
        });
      });
    });
  }

  function renderPortfolio() {
    var wanMd = {}, lanMd = {}, wanSites = {}, lanSites = {};
    S.records.forEach(function (rec) {
      var target = rec.type === 'WAN' ? wanMd : lanMd;
      var sites = rec.type === 'WAN' ? wanSites : lanSites;
      (rec.results.rows || []).forEach(function (row) {
        var key = rec.type === 'WAN' ? (row.product || row.label) : row.label;
        target[key] = (target[key] || 0) + row.md;
        sites[key] = (sites[key] || 0) + row.sites;
      });
    });

    function draw(id, agg, unit, offset) {
      var entries = Object.keys(agg).map(function (k) { return [k, agg[k]]; })
        .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10);
      if (!entries.length) { U.destroyChart(id); return; }
      U.barChart(id, entries.map(function (e) { return e[0]; }),
                 entries.map(function (e) { return C.round(e[1], 2); }), unit, offset);
    }
    draw('port-wan-md', wanMd, 'Man-days', 0);
    draw('port-lan-md', lanMd, 'Man-days', 1);
    draw('port-wan-sites', wanSites, 'Sites', 2);
    draw('port-lan-sites', lanSites, 'Sites', 3);
  }

  /* ======================================================= team capacity = */

  function teamCapacity() {
    var v = Number(S.settings.teamCapacityFte);
    return v > 0 ? v : D.DPMS.length;
  }

  /* Reads the shared location fresh (not this browser's copy), so a
     colleague's new estimate or deletion shows up on the next visit. */
  function loadTeam() {
    S.plan.loading = true;
    el('cap-source').innerHTML = '<div class="callout neutral"><span class="callout-ic">⏳</span><span>Reading the estimates…</span></div>';
    return DB.loadTeamRecords().then(function (team) {
      S.plan.team = team; S.plan.error = null;
    }).catch(function (err) {
      S.plan.error = (err && err.message) || String(err);
      return DB.listRecords().then(function (rows) {
        S.plan.team = { source: 'browser', location: null, errors: 0, pendingIncluded: 0, records: rows };
      });
    }).then(function () {
      S.plan.loading = false;
      renderCapacity();
    });
  }

  function renderCapacityPage(reload) {
    if (!val('cap-start')) setVal('cap-start', PL.currentMonthKey());
    el('cap-capacity').placeholder = D.DPMS.length + ' — the DPM Directory';
    if (document.activeElement !== el('cap-capacity')) {
      setVal('cap-capacity', Number(S.settings.teamCapacityFte) > 0 ? S.settings.teamCapacityFte : '');
    }
    if (reload || !S.plan.team) loadTeam(); else renderCapacity();
  }

  function currentPlan() {
    return PL.compute(S.plan.team ? S.plan.team.records : [], {
      start: val('cap-start'),
      horizon: parseInt(val('cap-horizon'), 10) || 12,
      capacity: teamCapacity(),
      includeInactive: segValue('cap-inactive') === 'Yes',
      directory: D.DPMS
    });
  }

  function renderCapacity() {
    if (!S.plan.team || !el('page-capacity').classList.contains('active')) return;
    var plan = currentPlan();
    S.plan.last = plan;
    renderCapSource(plan);
    renderCapKpis(plan);
    renderCapAlerts(plan);
    renderCapChart(plan);
    renderCapMonthTable(plan);
    renderCapPeople(plan);
    renderCapProjects(plan);
    hydrateHelp();
  }

  function capSourceText() {
    var t = S.plan.team, st = DB.status();
    if (!t) return '';
    if (t.source === 'host') return 'the data folder ' + (t.location || st.dataRoot || '');
    if (t.source === 'folder') return 'the connected folder “' + (t.location || st.folderName || '') + '”';
    return 'this browser only';
  }

  function renderCapSource(plan) {
    var t = S.plan.team, st = DB.status(), c = plan.counts;
    var shared = (t.source === 'host' && !st.isDefaultRoot) || t.source === 'folder';
    var parts = [];
    parts.push('<b>' + c.projects + ' project(s)</b> from ' + c.estimates + ' estimate(s) in ' + esc(capSourceText()) + '.');
    if (c.superseded) parts.push(c.superseded + ' older estimate(s) of the same projects are set aside — the latest one counts.');
    if (c.inactiveExcluded) parts.push(c.inactiveExcluded + ' inactive project(s) left out.');
    if (t.pendingIncluded) parts.push(t.pendingIncluded + ' of your estimate(s) not yet written to disk are included.');
    if (t.errors) parts.push(t.errors + ' file(s) could not be read (possibly still syncing) and were skipped.');

    var html = '<div class="callout' + (shared ? '' : ' neutral') + '"><span class="callout-ic">' + (shared ? '👥' : '👤') + '</span><span>' +
      parts.join(' ') +
      (shared ? '' : '<br>This plan only sees <b>your</b> estimates. To plan across the whole team, point everyone at one ' +
        'shared (SharePoint / Teams) folder — <a href="#" data-goto="settings">set it up in Settings</a>.') +
      '</span></div>';
    if (S.plan.error) {
      html += '<div class="callout warn"><span class="callout-ic">⚠</span><span>The data folder could not be read (' +
              esc(S.plan.error) + '), so this shows the copy saved in this browser.</span></div>';
    }
    el('cap-source').innerHTML = html;
  }

  function renderCapKpis(plan) {
    var cap = plan.capacity;
    var fromSetting = Number(S.settings.teamCapacityFte) > 0;
    var peakOver = cap > 0 && plan.peak.fte > cap + 1e-9;
    el('cap-kpis').innerHTML =
      kpiCard('b', 'Team capacity', fmt.num(cap, cap % 1 ? 1 : 0) + ' FTE',
              fromSetting ? 'Set on this page' : 'People in the DPM Directory', 'teamCapacity') +
      kpiCard(peakOver ? 'a' : 'g', 'Peak demand', fmt.fte(plan.peak.fte) + ' FTE',
              plan.peak.fte > 0 ? ('in ' + PL.monthLabel(plan.peak.month) + (cap > 0 ? ' · ' + fmt.pct(plan.peak.fte / cap * 100) + ' of capacity' : '')) : 'No demand in this window') +
      kpiCard(plan.overbookedCount ? 'a' : 'g', 'Overbooked months', plan.overbookedCount + ' of ' + plan.horizon,
              'Months where demand is above capacity') +
      kpiCard('v', 'Projects in window', String(plan.counts.inWindow),
              (plan.counts.unscheduled ? plan.counts.unscheduled + ' not scheduled · ' : '') +
              plan.counts.overbookedPeople + ' DPM(s) overbooked');
  }

  function renderCapAlerts(plan) {
    var out = [];
    if (plan.overbookedCount) {
      var list = [];
      plan.overbooked.forEach(function (over, i) {
        if (over) list.push(plan.labels[i] + ' (' + fmt.fte(plan.demand[i]) + ')');
      });
      out.push('<div class="callout err"><span class="callout-ic">✕</span><span><b>Demand is above the team\'s ' +
        fmt.num(plan.capacity, plan.capacity % 1 ? 1 : 0) + ' FTE</b> in ' + plan.overbookedCount + ' month(s): ' +
        esc(list.slice(0, 8).join(', ')) + (list.length > 8 ? ' …' : '') +
        '. Move a start month in the table below, or plan extra people for those months.</span></div>');
    }
    var over = plan.people.filter(function (p) { return p.overMonths > 0; });
    if (over.length) {
      out.push('<div class="callout warn"><span class="callout-ic">⚠</span><span><b>' + over.length + ' DPM(s) booked above a full month</b> ' +
        'in at least one month: ' + esc(over.slice(0, 8).map(function (p) { return p.name + ' (peak ' + fmt.fte(p.peak) + ')'; }).join(', ')) +
        (over.length > 8 ? ' …' : '') + '.</span></div>');
    }
    if (plan.counts.unscheduled) {
      out.push('<div class="callout warn"><span class="callout-ic">📅</span><span><b>' + plan.counts.unscheduled +
        ' project(s) have no start month</b>, so they are not on the calendar yet. Set one in the table at the bottom.</span></div>');
    }
    var unassignedPeak = plan.unassigned.reduce(function (m, v) { return Math.max(m, v); }, 0);
    if (unassignedPeak > 0.005) {
      out.push('<div class="callout neutral"><span class="callout-ic">ℹ</span><span>Up to <b>' + fmt.fte(unassignedPeak) +
        ' FTE</b> of the demand belongs to projects with no DPM assigned. It counts against the team, but not against anyone by name.</span></div>');
    }
    el('cap-alerts').innerHTML = out.join('');
  }

  function renderCapChart(plan) {
    var active = plan.projects.filter(function (p) { return p.windowMd > 1e-9; })
      .sort(function (a, b) { return b.windowMd - a.windowMd; });
    var shown = active.slice(0, 10), rest = active.slice(10);
    function r2(v) { return Math.round(v * 100) / 100; }

    U.customChart('cap-chart', function () {
      var dark = U.isDark();
      var datasets = shown.map(function (p, i) {
        return { type: 'bar', label: p.name + ' · ' + p.type, data: p.series.map(r2), backgroundColor: U.colour(i),
                 stack: 'demand', borderRadius: 2, maxBarThickness: 56, order: 2 };
      });
      if (rest.length) {
        datasets.push({ type: 'bar', label: rest.length + ' other project(s)', stack: 'demand', order: 2, maxBarThickness: 56,
          backgroundColor: dark ? '#475569' : '#cbd5e1',
          data: plan.months.map(function (_, idx) {
            return r2(rest.reduce(function (t, p) { return t + p.series[idx]; }, 0));
          }) });
      }
      if (plan.capacity > 0) {
        datasets.push({ type: 'line', label: 'Team capacity (' + fmt.num(plan.capacity, plan.capacity % 1 ? 1 : 0) + ' FTE)',
          data: plan.months.map(function () { return plan.capacity; }), stack: 'capacity', order: 1,
          borderColor: dark ? '#f87171' : '#dc2626', backgroundColor: dark ? '#f87171' : '#dc2626',
          borderDash: [6, 4], borderWidth: 2, pointRadius: 0, fill: false });
      }
      var o = U.chartOptions('FTE');
      o.plugins.legend = { display: true, position: 'bottom',
        labels: { boxWidth: 12, boxHeight: 12, color: dark ? '#a9b4c6' : '#475569', font: { size: 11 } } };
      o.plugins.tooltip.mode = 'index';
      o.plugins.tooltip.intersect = false;
      o.plugins.tooltip.displayColors = true;
      o.plugins.tooltip.filter = function (item) { return item.raw > 0 || item.dataset.stack === 'capacity'; };
      o.plugins.tooltip.callbacks = {
        footer: function (items) {
          var i = items.length ? items[0].dataIndex : 0;
          return 'Total demand: ' + fmt.fte(plan.demand[i]) + ' FTE';
        }
      };
      o.scales.x.stacked = true;
      o.scales.y.stacked = true;
      return { type: 'bar', data: { labels: plan.labels, datasets: datasets }, options: o };
    });
  }

  function heatClass(v, limit) {
    if (!(v > 0.005)) return 'zero';
    if (!(limit > 0)) return 'heat-ok';
    var ratio = v / limit;
    return ratio > 1 + 1e-9 ? 'heat-over' : (ratio >= 0.8 ? 'heat-high' : 'heat-ok');
  }

  function monthHeadCells(plan) {
    return plan.labels.map(function (l) {
      var parts = l.split(' ');
      return '<th class="m">' + esc(parts[0]) + '<span class="th-unit">' + esc(parts[1]) + '</span></th>';
    }).join('');
  }

  function renderCapMonthTable(plan) {
    var cap = plan.capacity;
    function row(label, values, classer, fmtFn) {
      return '<tr><td class="strong">' + esc(label) + '</td>' + values.map(function (v, i) {
        return '<td class="m ' + (classer ? classer(v, i) : '') + '">' + fmtFn(v) + '</td>';
      }).join('') + '</tr>';
    }
    var headroom = plan.demand.map(function (d) { return cap - d; });
    el('cap-month-table').innerHTML = '<div class="table-wrap"><table class="heat-table"><thead><tr><th>FTE</th>' +
      monthHeadCells(plan) + '</tr></thead><tbody>' +
      row('Demand', plan.demand, function (v) { return heatClass(v, cap); }, function (v) { return v > 0.005 ? fmt.fte(v) : '—'; }) +
      row('Capacity', plan.months.map(function () { return cap; }), null, function (v) { return fmt.fte(v); }) +
      row('Headroom', headroom, function (v) { return v < -1e-9 ? 'heat-over' : ''; }, function (v) { return (v > 0 ? '+' : '') + fmt.fte(v); }) +
      '</tbody></table></div>';
  }

  function renderCapPeople(plan) {
    var busy = plan.people.filter(function (p) { return p.total > 0.005; });
    var free = plan.people.filter(function (p) { return !(p.total > 0.005) && p.inDirectory; });
    var host = el('cap-people');

    if (!busy.length) {
      host.innerHTML = '<div class="empty"><div class="empty-ic">👤</div><p class="empty-title">No DPM has work in this window</p>' +
        '<p class="empty-detail">Assign DPMs on the WAN or LAN estimator and give the project a start month — their load appears here.</p></div>' +
        (free.length ? '<p class="card-note mt-3">' + free.length + ' people in the directory are free for the whole window.</p>' : '');
      return;
    }

    var rows = busy.map(function (p) {
      var projects = p.projects.filter(function (x) { return x.inWindow; });
      var title = projects.map(function (x) {
        return x.name + ' (' + x.type + ', ' + Math.round(x.share * 100) + '% share)';
      }).join('\n');
      return '<tr><td class="strong" title="' + esc(title) + '">' + esc(p.name) +
          (p.inDirectory ? '' : ' <span class="tag tag-warn" title="Assigned on an estimate but not in your DPM Directory">not in directory</span>') +
          '<span class="person-sub">' + projects.length + ' project(s) · peak ' + fmt.fte(p.peak) + '</span></td>' +
        p.load.map(function (v) {
          return '<td class="m ' + heatClass(v, 1) + '">' + (v > 0.005 ? fmt.fte(v) : '·') + '</td>';
        }).join('') + '</tr>';
    }).join('');

    var unassigned = plan.unassigned.some(function (v) { return v > 0.005; })
      ? '<tr class="sum"><td>No DPM assigned</td>' + plan.unassigned.map(function (v) {
          return '<td class="m">' + (v > 0.005 ? fmt.fte(v) : '·') + '</td>';
        }).join('') + '</tr>'
      : '';

    host.innerHTML = '<div class="table-wrap"><table class="heat-table"><thead><tr><th>DPM</th>' + monthHeadCells(plan) +
      '</tr></thead><tbody>' + rows + unassigned +
      '<tr class="sum"><td>Team demand</td>' + plan.demand.map(function (v) {
        return '<td class="m">' + (v > 0.005 ? fmt.fte(v) : '·') + '</td>';
      }).join('') + '</tr>' +
      '</tbody></table></div>' +
      (free.length
        ? '<details class="fold"><summary>' + free.length + ' people in the directory have no work in this window</summary><p>' +
          esc(free.map(function (p) { return p.name; }).join(' · ')) + '</p></details>'
        : '');
  }

  function renderCapProjects(plan) {
    var host = el('cap-projects');
    el('cap-proj-count').textContent = plan.projects.length + ' project(s)';
    if (!plan.projects.length) {
      host.innerHTML = '<div class="empty"><div class="empty-ic">▤</div><p class="empty-title">No projects to plan</p>' +
        '<p class="empty-detail">' + (plan.counts.inactiveExcluded
          ? 'Every project is marked Inactive. Choose “Include” above to see them.'
          : 'Run an estimate on the WAN or LAN page and it will appear here.') + '</p></div>';
      return;
    }
    var STATE_TAG = {
      unscheduled: '<span class="tag tag-warn">no start month</span>',
      current: '<span class="tag tag-ok">in this window</span>',
      later: '<span class="tag tag-muted">starts later</span>',
      ended: '<span class="tag tag-muted">finished</span>'
    };
    host.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
      '<th>Project</th><th>Type</th><th>Start month</th><th>Ends</th><th class="right">Months</th>' +
      '<th>Shape</th><th class="right">Total MD</th><th class="right">FTE (avg)</th><th class="right">Peak FTE</th>' +
      '<th>DPMs</th><th>On the plan</th></tr></thead><tbody>' +
      plan.projects.map(function (p) {
        var muted = p.state === 'ended' || p.state === 'later';
        var fromDates = !(p.record.inputs || {}).startMonth && p.start;
        return '<tr' + (muted ? ' class="row-muted"' : '') + '>' +
          '<td class="strong">' + esc(p.name) + (p.active ? '' : ' <span class="tag tag-muted">inactive</span>') +
            '<span class="person-sub">' + esc(p.code) + '</span></td>' +
          '<td><span class="tag ' + (p.type === 'WAN' ? 'tag-info' : 'tag-ok') + '">' + esc(p.type) + '</span></td>' +
          '<td><input type="month" class="cap-month" data-cap-id="' + esc(p.id) + '" value="' + esc(p.start || '') +
            '" aria-label="Start month for ' + esc(p.name) + '"' +
            (fromDates ? ' title="Taken from the start date on the estimate. Changing it here overrides that for the plan."' : '') + '></td>' +
          '<td>' + esc(p.end ? PL.monthLabel(p.end) : '—') + '</td>' +
          '<td class="num">' + fmt.num(p.months, p.months % 1 ? 1 : 0) + '</td>' +
          '<td>' + (p.distribution === 'bell' ? 'Bell curve' : 'Flat') + '</td>' +
          '<td class="num">' + fmt.md1(p.totalMd) + '</td>' +
          '<td class="num">' + fmt.fte(p.fte) + '</td>' +
          '<td class="num">' + fmt.fte(p.peakFte) + '</td>' +
          '<td>' + (p.dpms.length
            ? esc(p.dpms.map(function (d) { return d.name || d.email; }).join(', '))
            : '<span class="tag tag-warn">none assigned</span>') + '</td>' +
          '<td>' + STATE_TAG[p.state] + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* Moving a project on the calendar writes the new start month back onto its
     estimate - into the shared folder when there is one - so the whole team
     sees one plan. Only the start month changes; the calculation is untouched. */
  function updateStartMonth(id, value) {
    var team = S.plan.team;
    if (!team) return;
    var idx = -1;
    team.records.forEach(function (r, i) { if (r.id === id) idx = i; });
    if (idx < 0) return;
    var key = value ? PL.toMonthKey(value) : '';
    if (value && !key) { U.toast('Pick a valid month.', 'warn'); return; }

    /* Start from the newest stored copy, not the one read when this page
       opened, so only the start month changes - never someone's later edit. */
    DB.getFreshRecord(id).then(function (fresh) {
      var copy = fresh || JSON.parse(JSON.stringify(team.records[idx]));
      copy.inputs.startMonth = key;
      return DB.updateRecord(copy);
    }).then(function (res) {
      team.records[idx] = res.record;
      /* If this estimate is the one open on the WAN/LAN page, keep its
         Planned start field in step - but only while that form still shows
         this project, never a different one loaded since. */
      ['wan', 'lan'].forEach(function (side) {
        var st = sideState(side);
        if (!st.record || st.record.id !== id) return;
        var showing = formShowsRecord(side, st.record);
        st.record = res.record;
        if (showing && (res.record.inputs || {}).durationSource !== 'dates') setVal(prefix(side) + '-start-month', key);
      });
      return DB.listRecords().then(function (rows) {
        S.records = rows;
        renderCapacity();
        renderStorageStatus();
        if (!res.written) U.toast('Saved in this browser — it will be written to the data folder when it is reachable.', 'warn');
        else U.toast(key ? ('Start moved to ' + PL.monthLabel(key) + ' and saved on the estimate.') : 'Start month cleared.', 'ok');
      });
    }).catch(function (err) {
      U.toast('Could not save the start month: ' + (err && err.message ? err.message : err), 'err');
    });
  }

  function saveTeamCapacity() {
    var raw = val('cap-capacity');
    var n = C.num(raw, NaN);
    if (raw !== '' && !(n > 0)) { U.toast('Team capacity must be a number above zero, or blank.', 'warn'); return; }
    var value = raw === '' ? null : n;
    S.settings.teamCapacityFte = value;
    DB.setSetting('teamCapacityFte', value).then(function () { renderCapacity(); });
  }

  function refreshTeam() {
    return DB.probeServer()
      .then(function () { return DB.pullFromDisk(); })
      .then(function () { return DB.flushPending(); })
      .then(function () { return DB.listRecords(); })
      .then(function (rows) { S.records = rows; renderStorageStatus(); return loadTeam(); })
      .then(function () {
        U.toast('Team plan refreshed — ' + (S.plan.team ? S.plan.team.records.length : 0) + ' estimate(s) read.', 'ok');
      });
  }

  /* ============================================================ projects = */

  function buildProjectConfig(name) {
    return {
      name: name,
      savedAt: new Date().toISOString(),
      appVersion: D.APP_VERSION,
      projectCode: S.wan.code || S.lan.code || null,
      wan: {
        projName: val('w-proj-name'), status: segValue('w-status'), pmRole: segValue('w-pm-role'),
        months: numVal('w-months') || null, startDate: val('w-start-date'), endDate: val('w-end-date'),
        startMonth: val('w-start-month'),
        sites: numVal('w-sites') || null, projectType: val('w-type'),
        migration: segValue('w-migration'), abacos: segValue('w-abacos'), mode: segValue('w-mode'),
        distribution: segValue('w-dist'), notes: (val('w-notes') || '').trim(),
        rows: S.wan.rows.map(function (r) { return Object.assign({}, r); }),
        dpms: S.wan.dpms.map(function (d) { return Object.assign({}, d); })
      },
      lan: {
        projName: val('l-proj-name'), status: segValue('l-status'), pmRole: segValue('l-pm-role'),
        months: numVal('l-months') || null, startDate: val('l-start-date'), endDate: val('l-end-date'),
        startMonth: val('l-start-month'),
        sites: numVal('l-sites') || null, devices: numVal('l-devices'),
        flan: segValue('l-flan'), mode: segValue('l-mode'), stages: selectedStages(),
        fallbackOverride: numVal('l-fb-ovrd') || null,
        distribution: segValue('l-dist'), notes: (val('l-notes') || '').trim(),
        rows: S.lan.rows.map(function (r) { return Object.assign({}, r); }),
        dpms: S.lan.dpms.map(function (d) { return Object.assign({}, d); })
      }
    };
  }

  function applyProjectConfig(cfg) {
    var w = cfg.wan || {}, l = cfg.lan || {};
    S.wan.rows = (w.rows || []).map(function (r) { return Object.assign({}, r); });
    S.lan.rows = (l.rows || []).map(function (r) { return Object.assign({}, r); });
    S.wan.dpms = (w.dpms || []).map(function (d) { return Object.assign({}, d); });
    S.lan.dpms = (l.dpms || []).map(function (d) { return Object.assign({}, d); });
    /* Reuse the stored code rather than minting a new one, so a reloaded
       project keeps the identifier its earlier exports were filed under. */
    S.wan.code = cfg.projectCode || null;
    S.lan.code = cfg.projectCode || null;
    S.wan.codeName = (w.projName || '').trim();
    S.lan.codeName = (l.projName || '').trim();

    setVal('w-proj-name', w.projName || '');
    if (w.status) setSeg('w-status', w.status);
    if (w.pmRole) setSeg('w-pm-role', w.pmRole);
    setVal('w-months', w.months || '');
    setVal('w-start-date', w.startDate || '');
    setVal('w-end-date', w.endDate || '');
    setVal('w-start-month', w.startMonth || '');
    setVal('w-sites', w.sites || '');
    if (w.projectType) setVal('w-type', w.projectType);
    if (w.migration) setSeg('w-migration', w.migration);
    if (w.abacos) setSeg('w-abacos', w.abacos);
    if (w.mode) setSeg('w-mode', w.mode);
    setSeg('w-dist', w.distribution === 'bell' ? 'bell' : 'flat');
    setVal('w-notes', w.notes || '');

    setVal('l-proj-name', l.projName || '');
    if (l.status) setSeg('l-status', l.status);
    if (l.pmRole) setSeg('l-pm-role', l.pmRole);
    setVal('l-months', l.months || '');
    setVal('l-start-date', l.startDate || '');
    setVal('l-end-date', l.endDate || '');
    setVal('l-start-month', l.startMonth || '');
    setVal('l-sites', l.sites || '');
    setVal('l-devices', l.devices || 0);
    if (l.flan) setSeg('l-flan', l.flan);
    if (l.mode) setSeg('l-mode', l.mode);
    setVal('l-fb-ovrd', l.fallbackOverride || '');
    setSeg('l-dist', l.distribution === 'bell' ? 'bell' : 'flat');
    setVal('l-notes', l.notes || '');

    renderStageChips();
    if (l.stages) {
      qsa('#l-stages .stage-chip').forEach(function (n) {
        var on = l.stages.indexOf(n.dataset.stage) >= 0;
        n.classList.toggle('checked', on);
        n.setAttribute('aria-pressed', String(on));
      });
      renderStageSummary();
    }

    if (S.wan.code) { el('w-code-pill').textContent = S.wan.code; el('w-code-pill').classList.remove('hidden'); }
    if (S.lan.code) { el('l-code-pill').textContent = S.lan.code; el('l-code-pill').classList.remove('hidden'); }

    syncModeUi('wan'); syncModeUi('lan');
    renderWanRows(); renderLanRows();
    renderAssignedDpms('wan'); renderAssignedDpms('lan');
  }

  function saveCurrentAsProject() {
    var suggested = val('w-proj-name') || val('l-proj-name') || '';
    U.prompt('Save project', 'Give this configuration a name so you can reload it later.', suggested, {
      requiredMessage: 'Please enter a name for the project.'
    }).then(function (name) {
      if (!name) return;
      /* Re-read the folder first: a colleague may have saved a project of
         this name since this page loaded. */
      return DB.pullProjectsFromDisk().then(function () { return DB.listProjects(); }).then(function (list) {
        S.projects = list;
        return name;
      });
    }).then(function (name) {
      if (!name) return;
      /* Names are compared ignoring case because the file on disk is named
         after the project and Windows file names ignore case. In a shared
         folder the existing one may well be a colleague's. */
      var clash = S.projects.find(function (p) { return String(p.name).toLowerCase() === name.toLowerCase(); });
      var shared = DB.status().shared;
      var ask = clash
        ? U.confirm('Replace “' + clash.name + '”?',
            'A saved project with this name already exists' +
            (shared ? ' in the shared data folder, so it may be a colleague\'s' : '') +
            ' (saved ' + fmt.dateTime(clash.savedAt) + '). Saving replaces it. Choose Cancel to pick another name.',
            { confirmLabel: 'Replace it', danger: true })
        : Promise.resolve(true);
      return ask.then(function (yes) {
        if (!yes) return;
        var chain = (clash && clash.name !== name) ? DB.deleteProject(clash.name) : Promise.resolve();
        return chain.then(function () { return DB.saveProject(buildProjectConfig(name)); })
          .then(function () { return DB.listProjects(); })
          .then(function (list) {
            S.projects = list;
            renderProjects();
            U.toast('Project "' + name + '" saved.', 'ok');
          });
      });
    });
  }

  function renderProjects() {
    var host = el('proj-list');
    if (!S.projects.length) {
      host.innerHTML = '<div class="empty"><div class="empty-ic">⊞</div>' +
        '<p class="empty-title">No saved projects</p>' +
        '<p class="empty-detail">Use "Save as project" on the WAN or LAN page to store the settings you have entered, ' +
        'so you can pick the work up again later.</p></div>';
      return;
    }
    host.innerHTML = '<div class="record-list">' + S.projects.map(function (p) {
      var w = p.wan || {}, l = p.lan || {};
      var dpmCount = (w.dpms || []).length + (l.dpms || []).length;
      var rowCount = (w.rows || []).length + (l.rows || []).length;
      return '<div class="record-item' + (S.selectedProject === p.name ? ' selected' : '') +
             '" data-project-name="' + esc(p.name) + '" role="button" tabindex="0">' +
        '<div class="record-main">' +
          '<div class="record-title-row"><span class="record-name">' + esc(p.name) + '</span>' +
          (w.status ? '<span class="tag tag-muted">' + esc(w.status) + '</span>' : '') + '</div>' +
          '<div class="record-meta">' +
            (p.projectCode ? '<span class="record-code">' + esc(p.projectCode) + '</span>' : '') +
            '<span>' + esc(fmt.dateTime(p.savedAt)) + '</span>' +
            '<span>' + rowCount + ' allocation row(s)</span>' +
            (dpmCount ? '<span>' + dpmCount + ' DPM(s)</span>' : '') +
            (p.migratedFromLocalStorage ? '<span class="tag tag-muted">imported from old version</span>' : '') +
          '</div>' +
        '</div><span style="color:var(--text-4)">›</span></div>';
    }).join('') + '</div>';
  }

  function importProjectFile(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var cfg;
      try { cfg = JSON.parse(e.target.result); }
      catch (err) { U.toast('That file is not valid JSON.', 'err'); input.value = ''; return; }
      cfg.name = cfg.name || file.name.replace(/\.json$/i, '');
      cfg.savedAt = cfg.savedAt || new Date().toISOString();
      DB.saveProject(cfg)
        .then(function () { return DB.listProjects(); })
        .then(function (list) {
          S.projects = list;
          applyProjectConfig(cfg);
          renderProjects();
          U.toast('Imported "' + cfg.name + '".', 'ok');
        });
      input.value = '';
    };
    reader.readAsText(file);
  }

  /* =========================================================== reference = */

  var referenceBuilt = false;

  function renderReference() {
    if (referenceBuilt) return;
    referenceBuilt = true;

    el('method-formula').innerHTML =
      '<div class="summary-list">' +
      '<div><b>Step 1 — effort per row.</b> <span class="row-math">base rate (MD per site) × complexity % × number of sites</span></div>' +
      '<div><b>Step 2 — project effort.</b> <span class="row-math">sum of all rows' +
        ' + migration uplift (WAN only: 0.5 MD × every site, when migration support is in scope)</span></div>' +
      '<div><b>Step 3 — monthly workload.</b> <span class="row-math">total man-days ÷ duration in months</span></div>' +
      '<div><b>Step 4 — FTE.</b> <span class="row-math">monthly workload ÷ DPM monthly capacity (currently ' +
        esc(S.settings.capacityMdPerMonth) + ' MD)</span></div>' +
      '<div><b>Step 5 — headcount.</b> <span class="row-math">FTE rounded up to whole people</span></div>' +
      '<div><b>Step 6 — utilisation.</b> <span class="row-math">FTE ÷ headcount</span></div>' +
      '</div>' +
      '<div class="callout mt-4"><span class="callout-ic">💡</span><span>' +
      '<b>Worked example.</b> 40 sites of SD-WAN on Dual vEdge CPE at 100% complexity is ' +
      '2.250 × 1.00 × 40 = <b>90 MD</b>. Add 60 sites of BVPN Corporate on Dual at 75% complexity: ' +
      '2.500 × 0.75 × 60 = <b>112.5 MD</b>. Base effort is <b>202.5 MD</b>. With migration support across ' +
      '100 sites that is +50 MD, so <b>252.5 MD</b> total. Over 6 months that is 42.083 MD per month, ' +
      'which at 18 MD capacity is <b>2.338 FTE</b> — 3 people at 77.9% utilisation.' +
      '</span></div>' +
      '<div class="callout warn"><span class="callout-ic">⚠</span><span>These fields are stored and exported but do ' +
      '<b>not</b> affect any number above: ' + esc(D.INFORMATIONAL_FIELDS.join(', ')) + '.</span></div>';

    var wanHtml = '<table><thead><tr><th>Connectivity mode</th>' +
      D.PRODUCTS.map(function (p) { return '<th class="right">' + esc(p) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      D.CONNECTIVITY_MODES.map(function (mode) {
        return '<tr><td class="strong">' + esc(mode) + '</td>' +
          D.PRODUCTS.map(function (p) {
            var v = D.lookupBaseMd(mode, p);
            return v === null ? '<td class="muted right">—</td>' : '<td class="num">' + v.toFixed(3) + '</td>';
          }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
    el('ref-wan-table').innerHTML = wanHtml;

    el('ref-lan-table').innerHTML = '<table><thead><tr><th>Tier</th><th>Device range</th>' +
      '<th class="right">Base effort (MD per site)</th><th class="right">Equivalent hours</th>' +
      '</tr></thead><tbody>' +
      D.LAN_TIERS.map(function (t) {
        return '<tr><td class="strong">' + esc(t.name) + '</td><td>' + esc(t.range) + '</td>' +
          '<td class="num">' + t.loe.toFixed(3) + '</td>' +
          '<td class="num">' + (t.loe * D.HOURS_PER_DAY).toFixed(1) + '</td></tr>';
      }).join('') + '</tbody></table>';

    el('ref-glossary').innerHTML = '<table><thead><tr><th style="width:22%">Term</th><th>Meaning</th></tr></thead><tbody>' +
      D.GLOSSARY.map(function (g) {
        return '<tr><td class="strong">' + esc(g.term) + '</td><td>' + esc(g.meaning) + '</td></tr>';
      }).join('') + '</tbody></table>';

    renderStageReference(S.refStage);
  }

  function renderStageReference(stage) {
    S.refStage = stage;
    el('ref-stage-tabs').innerHTML = D.STAGE_NAMES.map(function (name) {
      return '<button type="button" data-ref-stage="' + esc(name) + '"' +
             (name === stage ? ' class="active"' : '') + '>' + esc(name) + '</button>';
    }).join('');

    var activities = D.STAGE_HOURS[stage] || {};
    var tiers = D.LAN_TIERS;
    var totals = tiers.map(function () { return 0; });

    var body = Object.keys(activities).map(function (act) {
      return '<tr><td>' + esc(act) + '</td>' + tiers.map(function (t, i) {
        var v = activities[act][t.key];
        if (typeof v === 'number') totals[i] += v;
        return typeof v === 'number' ? '<td class="num">' + v + '</td>' : '<td class="muted right">—</td>';
      }).join('') + '</tr>';
    }).join('');

    el('ref-stage-table').innerHTML = '<table><thead><tr><th>Activity</th>' +
      tiers.map(function (t) { return '<th class="right">' + esc(t.name) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + body + '</tbody><tfoot>' +
      '<tr><td>Total hours per site</td>' + totals.map(function (v) { return '<td class="num">' + v + '</td>'; }).join('') + '</tr>' +
      '<tr><td>Equivalent man-days per site</td>' + totals.map(function (v) {
        return '<td class="num">' + (v / D.HOURS_PER_DAY).toFixed(3) + '</td>';
      }).join('') + '</tr></tfoot></table>';
  }

  /* ============================================================ settings = */

  function renderSettingsPage() {
    setVal('set-capacity', S.settings.capacityMdPerMonth);
    setVal('set-migration', S.settings.migrationMdPerSite);
    setVal('set-complexity', S.settings.defaultComplexity);
    setVal('set-email-to', S.settings.emailTo || '');
    setVal('set-email-cc', S.settings.emailCc || '');
    setVal('set-email-subject', S.settings.emailSubject || '');

    var st = DB.status();
    var host = el('settings-storage');
    var actions = el('settings-storage-actions');
    var rows = [], buttons = [];

    if (st.mode === 'host') {
      rows.push('<div class="callout"><span class="callout-ic">✓</span><span>' +
        '<b>Saving to disk through the local app host.</b> Every calculation is written as a JSON file into ' +
        '<span class="code">' + esc(st.dataRoot || 'data') + '</span>' +
        (st.isDefaultRoot
          ? ' — the app\'s own data folder, which only you use.'
          : ' — a shared team folder: everyone pointed at it sees the same estimates and the same team plan.') +
        '</span></div>');
      /* The path being typed survives the re-renders a status change causes. */
      var rootValue = S.pendingRoot !== null ? S.pendingRoot : (st.isDefaultRoot ? '' : (st.dataRoot || ''));
      rows.push('<div class="divider"><span>Shared team folder</span></div>' +
        '<p class="card-note">To plan across the team, everyone points the app at <b>one folder</b> — a SharePoint or Teams ' +
        'document library synced to each PC through OneDrive (in Teams: <i>Files › Sync</i>, or <i>Add shortcut to My files</i>). ' +
        'Paste that folder\'s path below. Each person does this once on their own PC.</p>' +
        '<div class="field mb-0"><label for="set-data-root" data-help="sharedFolder">Folder path</label>' +
        '<input type="text" id="set-data-root" autocomplete="off" spellcheck="false" value="' + esc(rootValue) + '" ' +
        'placeholder="e.g. C:\\Users\\you\\Orange\\DPM Team - Documents\\FTE Data"></div>');
      buttons.push('<button class="btn btn-primary btn-sm" data-storage-act="use-root">Use this folder</button>');
      if (!st.isDefaultRoot) {
        buttons.push('<button class="btn btn-outline btn-sm" data-storage-act="publish">Copy my estimates here</button>');
        buttons.push('<button class="btn btn-ghost btn-sm" data-storage-act="reset-root">Back to my own data folder</button>');
      }
    } else if (st.mode === 'folder') {
      rows.push('<div class="callout"><span class="callout-ic">✓</span><span>' +
        '<b>Saving to the folder “' + esc(st.folderName) + '”.</b> Every calculation is written there as a JSON file, ' +
        'into <span class="code">records/</span> and <span class="code">projects/</span> sub-folders. ' +
        'Your browser may ask you to confirm this folder again after you close and reopen it.</span></div>' +
        '<p class="card-note">To share with the team, connect a folder that is synced from SharePoint or Teams: everyone ' +
        'who connects the same folder sees the same estimates and the same Team capacity plan.</p>');
      buttons.push('<button class="btn btn-outline btn-sm" data-storage-act="change">Change folder</button>');
      buttons.push('<button class="btn btn-outline btn-sm" data-storage-act="publish">Copy my estimates here</button>');
      buttons.push('<button class="btn btn-ghost btn-sm" data-storage-act="forget">Stop saving to this folder</button>');
    } else if (st.folderNeedsReconnect) {
      rows.push('<div class="callout warn"><span class="callout-ic">⚠</span><span>' +
        '<b>“' + esc(st.folderName) + '” needs reconnecting.</b> Browsers deliberately drop folder permission when the ' +
        'tab is closed, so it has to be granted again. Your work is safe in this browser meanwhile — reconnect and ' +
        'anything outstanding is written out immediately.</span></div>');
      buttons.push('<button class="btn btn-primary btn-sm" data-storage-act="reconnect">Reconnect folder</button>');
      buttons.push('<button class="btn btn-ghost btn-sm" data-storage-act="forget">Forget this folder</button>');
    } else if (st.canReachHost) {
      rows.push('<div class="callout warn"><span class="callout-ic">⚠</span><span>' +
        '<b>The local app host is not responding.</b> Calculations are still saved in this browser and will be ' +
        'written to the data folder automatically once the host is running again.</span></div>');
    } else if (st.folderSupported) {
      rows.push('<div class="callout"><span class="callout-ic">📁</span><span>' +
        '<b>Your work is saved in this browser.</b> That survives refreshes and restarts, but it is tied to this ' +
        'browser on this machine. Connect a folder and every calculation is also written there as a JSON file you ' +
        'can back up, share or open in any editor. Connect a folder synced from SharePoint or Teams and the whole ' +
        'team shares one set of estimates and one capacity plan.</span></div>');
      buttons.push('<button class="btn btn-primary btn-sm" data-storage-act="connect">Connect a folder</button>');
    } else {
      rows.push('<div class="callout warn"><span class="callout-ic">⚠</span><span>' +
        '<b>Your work is saved in this browser only.</b> ' +
        (st.isSecureContext
          ? 'This browser does not support writing to a folder — Chrome or Edge does. '
          : 'Writing to a folder needs a secure connection, which this page does not have. ') +
        'Use <b>Download full backup</b> below to keep a copy you control, and Export to Excel for reporting.</span></div>');
    }

    actions.innerHTML = buttons.join('');

    Promise.all([DB.listRecords(), DB.countPending()]).then(function (res) {
      var total = res[0].length, pending = res[1];
      host.innerHTML = rows.join('') +
        '<div class="summary-list mt-3">' +
        '<div><span class="k">FTE records stored:</span> <b>' + total + '</b></div>' +
        '<div><span class="k">Saved projects:</span> <b>' + S.projects.length + '</b></div>' +
        '<div><span class="k">DPMs in directory:</span> <b>' + D.DPMS.length + '</b></div>' +
        '<div><span class="k">Not yet written to disk:</span> <b>' + pending + '</b></div>' +
        '<div><span class="k">Storage mode:</span> <b>' + esc(st.mode) + '</b></div>' +
        '<div><span class="k">Application version:</span> <b>' + esc(D.APP_VERSION) + '</b></div>' +
        '<div><span class="k">Charts library:</span> <b>' + (typeof Chart !== 'undefined' ? 'loaded' : 'MISSING') + '</b></div>' +
        '<div><span class="k">Excel library:</span> <b>' + (EX.available() ? 'loaded' : 'MISSING') + '</b></div>' +
        '</div>';
      hydrateHelp();
    });
  }

  /* ------------------------------------------------ shared data folder --- */

  function useDataRoot() {
    var path = (val('set-data-root') || '').trim().replace(/^"|"$/g, '');
    if (!path) { U.toast('Paste the folder path first.', 'warn'); el('set-data-root').focus(); return; }
    var st = DB.status();
    if (st.dataRoot && path.toLowerCase() === String(st.dataRoot).toLowerCase()) {
      U.toast('Already saving to that folder.', 'info');
      return;
    }
    U.dialog({
      title: 'Switch the data folder?',
      confirmLabel: 'Switch folder',
      bodyHtml:
        '<p>New calculations will be saved to <span class="code">' + esc(path) + '</span>, and the estimates ' +
        'already in that folder will appear in your records and on the Team capacity page.</p>' +
        '<label class="check-row mt-3"><input type="checkbox" id="root-copy" checked>' +
        '<span>Also copy my existing estimates and projects into it</span></label>' +
        '<p class="field-help mt-2">Nothing is deleted from the current folder, and nothing already in the new ' +
        'folder is overwritten. This PC remembers the choice; nobody else\'s setting changes.</p>',
      collect: function (root) { return { copy: qs('#root-copy', root).checked }; }
    }).then(function (choice) {
      if (!choice || choice === true) return;
      return DB.setHostDataRoot(path, choice.copy).then(function (out) {
        S.pendingRoot = null;
        /* The host copies the files from the private data folder. This
           browser's own estimates that never reached that folder (or, when
           leaving another shared folder, the ones that are genuinely this
           person's) are published from here - never colleagues'. */
        var extra = choice.copy ? DB.publishLocal().catch(function () { return 0; }) : Promise.resolve(0);
        return extra.then(function (published) {
          var copied = (out.copiedRecords || 0) + published;
          var msg = 'Now saving to ' + out.dataRoot;
          if (choice.copy) msg += ' — copied ' + copied + ' estimate(s) and ' + (out.copiedProjects || 0) + ' project(s)';
          if (out.copyFailed) msg += '; ' + out.copyFailed + ' file(s) could not be copied (see the launcher window)';
          return afterDataRootChange(msg + '.', out.copyFailed ? 'warn' : 'ok');
        });
      });
    }).catch(function (err) {
      renderStorageStatus();
      U.toast(err && err.message ? err.message : 'Could not switch to that folder.', 'err');
    });
  }

  function resetDataRoot() {
    U.confirm('Go back to your own data folder?',
      'New calculations will be saved in the app\'s own data folder again. The shared folder is left exactly as it is, ' +
      'and colleagues keep using it.', { confirmLabel: 'Switch back' }).then(function (yes) {
      if (!yes) return;
      return DB.setHostDataRoot(null).then(function (out) {
        S.pendingRoot = null;
        return afterDataRootChange('Back to ' + out.dataRoot + '.');
      });
    }).catch(function (err) {
      U.toast(err && err.message ? err.message : 'Could not switch back.', 'err');
    });
  }

  /* After the host changes folder: read what is there, push anything still
     waiting, and refresh every view that shows records or projects. */
  function afterDataRootChange(message, level) {
    return DB.pullFromDisk()
      .then(function () { return DB.pullProjectsFromDisk(); })
      .then(function () { return DB.flushPending(); })
      .then(function () { return Promise.all([DB.listRecords(), DB.listProjects()]); })
      .then(function (res) {
        S.records = res[0]; S.projects = res[1]; S.plan.team = null;
        renderStorageStatus(); renderRecords(); renderPortfolio(); renderProjects(); renderDashboard();
        renderSettingsPage();
        U.toast(message, level || 'ok');
      });
  }

  function publishMine() {
    DB.publishLocal().then(function (n) {
      return DB.listRecords().then(function (rows) {
        S.records = rows; S.plan.team = null;
        renderRecords(); renderSettingsPage(); renderStorageStatus();
        U.toast(n ? (n + ' of your estimate(s) copied into the data folder.')
                  : 'Nothing to copy — your estimates are already there.', 'ok');
      });
    }).catch(function (err) {
      U.toast('Could not copy: ' + (err && err.message ? err.message : err), 'err');
    });
  }

  /* ------------------------------------------------- folder connection --- */

  function handleStorageAction(action) {
    if (action === 'use-root') { useDataRoot(); return; }
    if (action === 'reset-root') { resetDataRoot(); return; }
    if (action === 'publish') { publishMine(); return; }
    if (action === 'forget') {
      U.confirm('Stop saving to this folder?',
        'New calculations will be kept in this browser only. Files already written to the folder are not deleted.',
        { confirmLabel: 'Stop saving there' }).then(function (yes) {
        if (!yes) return;
        return DB.forgetFolder().then(function () {
          renderStorageStatus();
          U.toast('No longer saving to that folder.', 'ok');
        });
      });
      return;
    }

    var op = (action === 'reconnect') ? DB.reconnectFolder() : DB.connectFolder();
    op.then(function (res) {
      renderStorageStatus();
      /* A shared folder already holds colleagues' saved projects too. */
      return DB.pullProjectsFromDisk().then(function () {
        return Promise.all([DB.listRecords(), DB.listProjects()]);
      }).then(function (lists) {
        S.records = lists[0]; S.projects = lists[1]; S.plan.team = null;
        renderRecords(); renderProjects(); renderDashboard();
        var bits = [];
        if (res.flushed) bits.push(res.flushed + ' record(s) written out');
        if (res.pulled) bits.push(res.pulled + ' estimate(s) read from the folder');
        U.toast('Connected to “' + res.name + '”' + (bits.length ? ' — ' + bits.join(', ') + '.' : '. New calculations will be saved there.'), 'ok');
      });
    }).catch(function (err) {
      /* Cancelling the picker is a normal outcome, not a failure worth shouting about. */
      if (err && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) return;
      U.toast(err.message || 'Could not connect to that folder.', 'err');
    });
  }

  function saveSettings() {
    var capacity = numVal('set-capacity');
    var migration = numVal('set-migration');
    var complexity = numVal('set-complexity');
    U.clearFieldErrors();
    if (!(capacity > 0)) { U.showFieldError('set-capacity', 'Capacity must be greater than zero.'); return; }
    if (migration < 0) { U.showFieldError('set-migration', 'The migration uplift cannot be negative.'); return; }
    if (!(complexity > 0)) { U.showFieldError('set-complexity', 'Default complexity must be greater than zero.'); return; }

    S.settings.capacityMdPerMonth = capacity;
    S.settings.migrationMdPerSite = migration;
    S.settings.defaultComplexity = complexity;

    Promise.all([
      DB.setSetting('capacityMdPerMonth', capacity),
      DB.setSetting('migrationMdPerSite', migration),
      DB.setSetting('defaultComplexity', complexity)
    ]).then(function () {
      referenceBuilt = false;
      U.toast('Settings saved. They apply to new calculations.', 'ok');
      updateMigrationHelp();
    });
  }

  function updateMigrationHelp() {
    var help = qs('#w-migration');
    if (!help) return;
    var note = help.parentNode.querySelector('.field-help');
    if (note) {
      note.innerHTML = 'Adds <b>' + S.settings.migrationMdPerSite + ' MD per site</b> across the whole project when set to Yes.';
    }
  }

  function saveEmailSettings() {
    var to = (val('set-email-to') || '').trim();
    var cc = (val('set-email-cc') || '').trim();
    var subject = (val('set-email-subject') || '').trim() || D.DEFAULT_SETTINGS.emailSubject;
    S.settings.emailTo = to;
    S.settings.emailCc = cc;
    S.settings.emailSubject = subject;
    Promise.all([
      DB.setSetting('emailTo', to),
      DB.setSetting('emailCc', cc),
      DB.setSetting('emailSubject', subject)
    ]).then(function () {
      renderSettingsPage();
      U.toast('Email settings saved.', 'ok');
    });
  }

  /* ============================================================== email == */

  function emailSubjectFor(record) {
    var tpl = S.settings.emailSubject || D.DEFAULT_SETTINGS.emailSubject;
    return tpl.replace(/\{project\}/gi, record.projectName || 'Untitled');
  }

  /* Key result figures, in one place for the HTML and plain-text versions. */
  function emailKeyResults(record) {
    var r = record.results;
    var rows = [
      [isShaped(r) ? 'FTE required (average)' : 'FTE required', fmt.fte(r.fte)],
      ['Headcount', r.headcount + ' people'],
      ['Utilisation', fmt.pct(r.utilisationPct)],
      ['Total man-days', fmt.md1(r.totalMd) + ' MD']
    ];
    if (isShaped(r)) {
      rows.splice(1, 0, ['Peak FTE (bell curve)', fmt.fte(r.peakFte)]);
      rows.splice(3, 0, ['Peak headcount', r.peakHeadcount + ' people']);
      rows.push(['Busiest month', 'Month ' + r.peakMonth]);
    }
    return rows;
  }

  function emailProjectDetails(record) {
    var i = record.inputs;
    return [
      ['Project code', record.projectCode || '—'],
      ['Type', record.type + '  ·  ' + (i.mode || '—') + ' mode'],
      ['Effort distribution', isShaped(record.results) ? 'Bell curve (normal)' : 'Flat (even)'],
      ['Duration', fmt.months(i.months)],
      ['Total sites', fmt.int(i.totalSites)],
      ['DPM capacity', i.capacityMdPerMonth + ' MD / month']
    ];
  }

  /* ---- HTML email (Outlook COM path) ---------------------------------- */

  /* Outlook renders email with the Word engine, which ignores a lot of CSS:
     no shorthand (font:, background:), no text-transform, no letter-spacing,
     and cell fills only show reliably through the bgcolor attribute. So the
     markup below is deliberately old-fashioned - nested tables, bgcolor/align
     attributes, and longhand inline styles only - which is what makes it
     actually format in Outlook rather than only in a browser preview. */
  var EMAIL_FF = 'font-family:Segoe UI,Arial,sans-serif;';
  var EMAIL_BLUE = '#1d4ed8';

  function emailSectionTable(title, headerCells, aligns, dataRows) {
    var colspan = headerCells ? headerCells.length : 2;
    var out = '<tr><td style="padding:16px 0 0 0;">' +
      '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
      '<tr><td colspan="' + colspan + '" bgcolor="' + EMAIL_BLUE + '" style="padding:8px 14px;' + EMAIL_FF +
        'font-size:12px;font-weight:bold;color:#ffffff;border:1px solid ' + EMAIL_BLUE + ';">' + esc(title) + '</td></tr>';

    if (headerCells) {
      out += '<tr>' + headerCells.map(function (c, idx) {
        return '<td bgcolor="#eef2f7" align="' + aligns[idx] + '" style="padding:7px 12px;' + EMAIL_FF +
          'font-size:12px;font-weight:bold;color:#334155;border:1px solid #d0d5dd;">' + esc(c) + '</td>';
      }).join('') + '</tr>';
    }

    out += dataRows + '</table></td></tr>';
    return out;
  }

  function emailFactTable(title, rows, highlightFirst) {
    var body = rows.map(function (rw, idx) {
      var hi = highlightFirst && idx === 0;
      var bg = hi ? '#eff6ff' : (idx % 2 ? '#f4f6f9' : '#ffffff');
      var valColour = hi ? EMAIL_BLUE : '#0f172a';
      var valSize = hi ? '15px' : '13px';
      return '<tr>' +
        '<td width="46%" bgcolor="' + bg + '" style="padding:8px 14px;border:1px solid #e2e8f0;' + EMAIL_FF +
          'font-size:13px;color:#475569;">' + esc(rw[0]) + '</td>' +
        '<td bgcolor="' + bg + '" style="padding:8px 14px;border:1px solid #e2e8f0;' + EMAIL_FF +
          'font-size:' + valSize + ';font-weight:bold;color:' + valColour + ';">' + esc(rw[1]) + '</td>' +
        '</tr>';
    }).join('');
    return emailSectionTable(title, null, null, body);
  }

  function emailAllocationTable(record) {
    var isWan = record.type === 'WAN';
    var headers = [(isWan ? 'Product / mode' : 'Tier'), 'Sites', 'Complexity', 'Man-days', 'Share'];
    var aligns = ['left', 'right', 'right', 'right', 'right'];
    var body = (record.results.rows || []).map(function (row, idx) {
      var bg = idx % 2 ? '#f4f6f9' : '#ffffff';
      var name = row.product ? (row.product + ' / ' + row.connectivityMode) : row.label;
      var vals = [name, fmt.int(row.sites), row.complexityPct + '%', fmt.md(row.md), row.pctOfTotal + '%'];
      return '<tr>' + vals.map(function (v, ci) {
        return '<td bgcolor="' + bg + '" align="' + aligns[ci] + '" style="padding:7px 12px;border:1px solid #e2e8f0;' +
          EMAIL_FF + 'font-size:13px;color:#0f172a;">' + esc(v) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return emailSectionTable('Allocation breakdown', headers, aligns, body);
  }

  function emailNotesSection(record) {
    var notes = (record.notes || '').trim();
    if (!notes) return '';
    var body = '<tr><td bgcolor="#fffbeb" style="padding:10px 14px;border:1px solid #fde68a;' + EMAIL_FF +
      'font-size:13px;color:#0f172a;">' + esc(notes).replace(/\n/g, '<br>') + '</td></tr>';
    return emailSectionTable('Notes', null, null, body);
  }

  function emailHtml(record) {
    var banner =
      '<tr><td bgcolor="' + EMAIL_BLUE + '" style="padding:16px 20px;">' +
        '<span style="' + EMAIL_FF + 'font-size:19px;font-weight:bold;color:#ffffff;">DPM FTE Estimate</span><br>' +
        '<span style="' + EMAIL_FF + 'font-size:14px;color:#dbeafe;">' + esc(record.projectName) + '</span>' +
      '</td></tr>';
    return '<table width="640" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:#ffffff;">' +
      banner +
      '<tr><td style="padding:16px 20px 20px 20px;">' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">' +
          '<tr><td style="' + EMAIL_FF + 'font-size:14px;color:#334155;padding:0 0 4px 0;">Please find the DPM FTE estimate below.</td></tr>' +
          emailFactTable('Key results', emailKeyResults(record), true) +
          emailFactTable('Project details', emailProjectDetails(record), false) +
          emailAllocationTable(record) +
          emailNotesSection(record) +
          '<tr><td style="' + EMAIL_FF + 'font-size:11px;color:#94a3b8;padding:16px 0 0 0;">Generated by the DPM FTE Calculator · ' +
            esc(record.projectCode || '') + '</td></tr>' +
        '</table>' +
      '</td></tr></table>';
  }

  /* ---- plain-text email (mailto fallback) ----------------------------- */

  function emailText(record) {
    var rows = emailKeyResults(record).concat([['', '']]).concat(emailProjectDetails(record));
    rows = [['Project', record.projectName || '—']].concat(rows);
    var width = rows.reduce(function (m, rw) { return Math.max(m, rw[0].length); }, 0);
    var lines = rows.map(function (rw) {
      if (!rw[0]) return '';
      return rw[0] + new Array(width - rw[0].length + 2).join(' ') + ': ' + rw[1];
    });
    /* Kept short on purpose: this text becomes a mailto: URL, and the Windows
       shell / Outlook truncate very long ones. A long note is capped with a
       pointer to the Excel export, which carries the full text. */
    var notes = (record.notes || '').trim();
    if (notes.length > 400) notes = notes.slice(0, 400) + '… (truncated — see the Excel export for the full note)';
    return 'DPM FTE ESTIMATE\n\n' + lines.join('\n') +
      (notes ? '\n\nNOTES\n' + notes : '') +
      '\n\nGenerated by the DPM FTE Calculator.';
  }

  function openMailto(to, cc, subject, body) {
    var q = [];
    if (cc) q.push('cc=' + encodeURIComponent(cc));
    q.push('subject=' + encodeURIComponent(subject));
    q.push('body=' + encodeURIComponent(body));
    window.location.href = 'mailto:' + (to || '') + '?' + q.join('&');
  }

  function emailResult(side) {
    var record = side === 'wan' ? S.wan.record : S.lan.record;
    if (!record) { U.toast('Run a ' + side.toUpperCase() + ' calculation first.', 'warn'); return; }

    var to = S.settings.emailTo || '';
    var cc = S.settings.emailCc || '';
    var subject = emailSubjectFor(record);

    /* Host mode gets a real Outlook draft with the formatted HTML table;
       anywhere else the browser can only hand a plain-text summary to the
       default mail client through mailto. */
    if (DB.status().mode === 'host') {
      DB.sendOutlookEmail({ to: to, cc: cc, subject: subject, htmlBody: emailHtml(record) })
        .then(function () { U.toast('Outlook draft opened — review and send it.', 'ok'); })
        .catch(function (err) {
          openMailto(to, cc, subject, emailText(record));
          U.toast('Opened your mail app instead (' + (err.message || 'Outlook unavailable') + ').', 'warn');
        });
    } else {
      openMailto(to, cc, subject, emailText(record));
      U.toast('Opening your mail app…', 'ok');
    }
  }

  /* ============================================================== modes == */

  function syncModeUi(side) {
    if (side === 'wan') {
      var nonStandard = segValue('w-mode') === 'Non-standard';
      el('w-override-field').classList.toggle('hidden', !nonStandard);
      el('w-mode-help').innerHTML = nonStandard
        ? 'You supply the man-days per site for each row; the rate card is not used.'
        : 'Rates come from the published rate card.';
      renderWanRows();
    } else {
      var mode = segValue('l-mode');
      el('l-override-field').classList.toggle('hidden', mode !== 'Non-standard');
      el('l-fb-field').classList.toggle('hidden', mode !== 'Non-standard');
      el('l-stage-section').classList.toggle('hidden', mode !== 'By Stage');
      el('l-mode-help').innerHTML = mode === 'Non-standard'
        ? 'You supply the man-days per site for each row; the rate card is not used.'
        : (mode === 'By Stage'
            ? 'The rate is built from the delivery stages you select below.'
            : 'Rates come from the published tier rate card.');
      renderLanRows();
    }
  }

  /* ================================================================ boot = */

  function populateSelects() {
    var product = el('w-add-product');
    D.PRODUCTS.forEach(function (p) { product.add(new Option(p, p)); });
    var mode = el('w-add-mode');
    D.CONNECTIVITY_MODES.forEach(function (m) { mode.add(new Option(m, m)); });
    var tier = el('l-add-tier');
    D.LAN_TIER_LABELS.forEach(function (t) { tier.add(new Option(t, t)); });
    setVal('w-add-complexity', S.settings.defaultComplexity);
    setVal('l-add-complexity', S.settings.defaultComplexity);
  }

  function bindEvents() {
    /* Navigation and segmented controls are handled by delegation so nothing
       depends on inline handlers or on markup rendered later. */
    document.addEventListener('click', function (e) {
      var nav = e.target.closest('.nav-item[data-page]');
      if (nav) { gotoPage(nav.dataset.page); return; }

      var seg = e.target.closest('.segmented button');
      if (seg) {
        var group = seg.parentNode;
        qsa('button', group).forEach(function (b) { b.classList.remove('active'); });
        seg.classList.add('active');
        if (group.id === 'w-mode') syncModeUi('wan');
        if (group.id === 'l-mode') syncModeUi('lan');
        if (group.id === 'cap-inactive') renderCapacity();
        return;
      }

      var gotoLink = e.target.closest('[data-goto]');
      if (gotoLink) { e.preventDefault(); gotoPage(gotoLink.dataset.goto); return; }

      var durTab = e.target.closest('[data-dur]');
      if (durTab) {
        switchDuration(durTab.closest('#w-dur-tabs') ? 'wan' : 'lan', durTab.dataset.dur);
        return;
      }

      var stage = e.target.closest('.stage-chip');
      if (stage) {
        var on = !stage.classList.contains('checked');
        stage.classList.toggle('checked', on);
        stage.setAttribute('aria-pressed', String(on));
        renderStageSummary();
        renderLanRows();
        return;
      }

      var preset = e.target.closest('[data-stage-preset]');
      if (preset) {
        var want = preset.dataset.stagePreset;
        var list = want === 'all' ? D.STAGE_NAMES : (want === 'none' ? [] : want.split(','));
        qsa('#l-stages .stage-chip').forEach(function (n) {
          var checked = list.indexOf(n.dataset.stage) >= 0;
          n.classList.toggle('checked', checked);
          n.setAttribute('aria-pressed', String(checked));
        });
        renderStageSummary();
        renderLanRows();
        return;
      }

      var rowAct = e.target.closest('[data-row-act]');
      if (rowAct) {
        handleRowAction(rowAct.dataset.side, rowAct.dataset.rowAct, parseInt(rowAct.dataset.index, 10));
        return;
      }

      var recAct = e.target.closest('[data-rec-act]');
      if (recAct) {
        var id = recAct.dataset.id;
        if (recAct.dataset.recAct === 'view') viewRecord(id);
        if (recAct.dataset.recAct === 'delete') deleteRecord(id);
        if (recAct.dataset.recAct === 'export') {
          var rec = S.records.find(function (r) { return r.id === id; });
          if (rec) EX.exportRecord(rec);
        }
        return;
      }

      var recItem = e.target.closest('[data-record-id]');
      if (recItem) { viewRecord(recItem.dataset.recordId); return; }

      var projItem = e.target.closest('[data-project-name]');
      if (projItem) { S.selectedProject = projItem.dataset.projectName; renderProjects(); return; }

      var refStage = e.target.closest('[data-ref-stage]');
      if (refStage) { renderStageReference(refStage.dataset.refStage); return; }

      var dpmAct = e.target.closest('[data-dpm-act]');
      if (dpmAct) {
        var email = dpmAct.dataset.email;
        if (dpmAct.dataset.dpmAct === 'delete') deleteDpmPrompt(email);
        if (dpmAct.dataset.dpmAct === 'edit') {
          editDpmDialog(D.DPMS.find(function (d) { return d.email === email; }));
        }
        return;
      }

      var storageAct = e.target.closest('[data-storage-act]');
      if (storageAct) { handleStorageAction(storageAct.dataset.storageAct); return; }
    });

    el('theme-toggle').addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') !== 'dark';
      localStorage.setItem('dpm_theme', dark ? 'dark' : 'light');
      U.applyTheme(dark);
      U.redrawAllCharts();
    });

    /* WAN */
    el('w-add-row').addEventListener('click', addWanRow);
    el('w-clear-rows').addEventListener('click', function () {
      if (!S.wan.rows.length) return;
      U.confirm('Clear all allocation rows?', 'This removes all ' + S.wan.rows.length + ' WAN allocation rows.',
        { confirmLabel: 'Clear rows', danger: true }).then(function (yes) {
        if (yes) { S.wan.rows = []; renderWanRows(); }
      });
    });
    el('w-calculate').addEventListener('click', calculateWan);
    el('w-export').addEventListener('click', function () {
      if (!S.wan.record) { U.toast('Run a WAN calculation first.', 'warn'); return; }
      syncActiveNotes('wan').then(function () { EX.exportRecord(S.wan.record); });
    });
    el('w-save-project').addEventListener('click', saveCurrentAsProject);
    el('w-email').addEventListener('click', function () { syncActiveNotes('wan').then(function () { emailResult('wan'); }); });
    el('w-assign-dpms').addEventListener('click', function () { openDpmPicker('wan'); });
    el('w-sites').addEventListener('input', renderWanAllocBadge);
    el('w-start-date').addEventListener('input', function () { recalcDuration('wan'); });
    el('w-end-date').addEventListener('input', function () { recalcDuration('wan'); });
    el('w-add-sites').addEventListener('keydown', function (e) { if (e.key === 'Enter') addWanRow(); });
    el('w-start-month').addEventListener('change', function () { syncActiveNotes('wan', true); });
    el('w-import-btn').addEventListener('click', function () { el('w-import-file').click(); });
    el('w-import-file').addEventListener('change', function () { importSiteList('wan', this); });
    el('w-import-template').addEventListener('click', function () { EX.downloadImportTemplate('wan'); });

    /* LAN */
    el('l-add-row').addEventListener('click', addLanRow);
    el('l-clear-rows').addEventListener('click', function () {
      if (!S.lan.rows.length) return;
      U.confirm('Clear all tier rows?', 'This removes all ' + S.lan.rows.length + ' LAN tier rows.',
        { confirmLabel: 'Clear rows', danger: true }).then(function (yes) {
        if (yes) { S.lan.rows = []; renderLanRows(); }
      });
    });
    el('l-calculate').addEventListener('click', calculateLan);
    el('l-export').addEventListener('click', function () {
      if (!S.lan.record) { U.toast('Run a LAN calculation first.', 'warn'); return; }
      syncActiveNotes('lan').then(function () { EX.exportRecord(S.lan.record); });
    });
    el('l-save-project').addEventListener('click', saveCurrentAsProject);
    el('l-email').addEventListener('click', function () { syncActiveNotes('lan').then(function () { emailResult('lan'); }); });
    el('l-assign-dpms').addEventListener('click', function () { openDpmPicker('lan'); });
    el('l-sites').addEventListener('input', renderLanAllocBadge);
    el('l-start-date').addEventListener('input', function () { recalcDuration('lan'); });
    el('l-end-date').addEventListener('input', function () { recalcDuration('lan'); });
    el('l-add-sites').addEventListener('keydown', function (e) { if (e.key === 'Enter') addLanRow(); });
    el('l-start-month').addEventListener('change', function () { syncActiveNotes('lan', true); });
    el('l-import-btn').addEventListener('click', function () { el('l-import-file').click(); });
    el('l-import-file').addEventListener('change', function () { importSiteList('lan', this); });
    el('l-import-template').addEventListener('click', function () { EX.downloadImportTemplate('lan'); });

    /* Team capacity */
    el('cap-start').addEventListener('change', renderCapacity);
    el('cap-horizon').addEventListener('change', renderCapacity);
    el('cap-capacity').addEventListener('change', saveTeamCapacity);
    el('cap-refresh').addEventListener('click', refreshTeam);
    el('cap-export').addEventListener('click', function () {
      if (!S.plan.last) { U.toast('The plan is still loading.', 'warn'); return; }
      EX.exportCapacityPlan(S.plan.last, { source: capSourceText() });
    });
    el('cap-projects').addEventListener('change', function (e) {
      var input = e.target.closest('input[data-cap-id]');
      if (input) updateStartMonth(input.dataset.capId, input.value);
    });

    /* Settings: remember a half-typed data folder path across re-renders. */
    document.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'set-data-root') S.pendingRoot = e.target.value;
    });

    /* Records */
    ['rec-search', 'rec-type', 'rec-status', 'rec-sort'].forEach(function (id) {
      el(id).addEventListener('input', renderRecords);
    });
    el('rec-refresh').addEventListener('click', function () {
      DB.probeServer()
        .then(function () { return DB.pullFromDisk(); })
        .then(function () { return DB.flushPending(); })
        .then(function () { return DB.listRecords(); })
        .then(function (rows) {
          S.records = rows;
          renderRecords(); renderPortfolio(); renderStorageStatus();
          U.toast('Refreshed — ' + rows.length + ' record(s).', 'ok');
        });
    });
    el('rec-export-all').addEventListener('click', function () { EX.exportAllRecords(filteredRecords()); });

    /* Projects */
    el('proj-import-btn').addEventListener('click', function () { el('proj-import-file').click(); });
    el('proj-import-file').addEventListener('change', function () { importProjectFile(this); });
    el('proj-load').addEventListener('click', function () {
      if (!S.selectedProject) { U.toast('Select a project from the list first.', 'warn'); return; }
      var cfg = S.projects.find(function (p) { return p.name === S.selectedProject; });
      if (!cfg) return;
      applyProjectConfig(cfg);
      U.toast('Loaded "' + cfg.name + '" into the estimators.', 'ok');
      gotoPage('wan');
    });
    el('proj-export').addEventListener('click', function () {
      if (!S.selectedProject) { U.toast('Select a project from the list first.', 'warn'); return; }
      var cfg = S.projects.find(function (p) { return p.name === S.selectedProject; });
      if (cfg) EX.exportProject(cfg);
    });
    el('proj-delete').addEventListener('click', function () {
      if (!S.selectedProject) { U.toast('Select a project from the list first.', 'warn'); return; }
      var name = S.selectedProject;
      U.confirm('Delete this project?', 'This permanently removes the saved configuration "' + name + '".',
        { confirmLabel: 'Delete', danger: true }).then(function (yes) {
        if (!yes) return;
        return DB.deleteProject(name).then(function () { return DB.listProjects(); }).then(function (list) {
          S.projects = list; S.selectedProject = null; renderProjects();
          U.toast('Project deleted.', 'ok');
        });
      });
    });

    /* DPM directory */
    el('dpm-search').addEventListener('input', renderDpmDirectory);
    el('dpm-export').addEventListener('click', EX.exportDpmDirectory);
    el('dpm-add').addEventListener('click', function () { editDpmDialog(null); });
    el('dpm-reset').addEventListener('click', resetDpmsPrompt);
    el('dpm-import-btn').addEventListener('click', function () { el('dpm-import-file').click(); });
    el('dpm-import-file').addEventListener('change', function () { importDpmFile(this); });
    el('dpm-export-json').addEventListener('click', function () {
      downloadJson(D.DPMS.map(function (d) { return { name: d.name, email: d.email }; }),
                   'DPM-directory-' + new Date().toISOString().slice(0, 10) + '.json');
      U.toast(D.DPMS.length + ' DPM(s) downloaded as JSON.', 'ok');
    });

    /* Backup */
    el('backup-export').addEventListener('click', exportBackup);
    el('backup-import-btn').addEventListener('click', function () { el('backup-import-file').click(); });
    el('backup-import-file').addEventListener('change', function () { importBackup(this); });

    /* Settings */
    el('set-save').addEventListener('click', saveSettings);
    el('set-reset').addEventListener('click', function () {
      setVal('set-capacity', D.DEFAULT_SETTINGS.capacityMdPerMonth);
      setVal('set-migration', D.DEFAULT_SETTINGS.migrationMdPerSite);
      setVal('set-complexity', D.DEFAULT_SETTINGS.defaultComplexity);
      saveSettings();
    });
    el('set-email-save').addEventListener('click', saveEmailSettings);
    el('set-email-reset').addEventListener('click', function () {
      setVal('set-email-to', D.DEFAULT_SETTINGS.emailTo);
      setVal('set-email-cc', D.DEFAULT_SETTINGS.emailCc);
      setVal('set-email-subject', D.DEFAULT_SETTINGS.emailSubject);
      saveEmailSettings();
    });
    el('maint-resync').addEventListener('click', function () {
      DB.probeServer()
        .then(function () { return DB.pullFromDisk(); })
        .then(function () { return DB.flushPending(); })
        .then(function (n) { return DB.listRecords().then(function (rows) { S.records = rows; return n; }); })
        .then(function (n) {
          renderStorageStatus(); renderRecords(); renderDashboard();
          U.toast('Re-synced. ' + n + ' record(s) written to disk.', 'ok');
        });
    });
    el('maint-purge').addEventListener('click', function () {
      var st = DB.status();
      var shared = st.shared;
      U.confirm('Delete every FTE record?',
        'All ' + S.records.length + ' saved calculations will be removed from this browser and from the data folder. ' +
        (shared ? 'The data folder is shared, so this also deletes your colleagues\' estimates for everyone. ' : '') +
        'This cannot be undone.',
        { confirmLabel: 'Delete everything', danger: true }).then(function (yes) {
        if (!yes) return;
        return S.records.reduce(function (chain, r) {
          return chain.then(function () { return DB.deleteRecord(r.id); });
        }, Promise.resolve()).then(function () {
          S.records = []; S.wan.record = null; S.lan.record = null;
          renderRecords(); renderPortfolio(); renderDashboard();
          renderResultChip(null); renderSettingsPage();
          U.toast('All records deleted.', 'ok');
        });
      });
    });
  }

  function init() {
    U.applyTheme(localStorage.getItem('dpm_theme') === 'dark');
    hydrateHelp();
    populateSelects();
    renderStageChips();
    bindEvents();
    syncModeUi('wan');
    syncModeUi('lan');
    renderAssignedDpms('wan');
    renderAssignedDpms('lan');
    renderDpmDirectory();

    DB.onStatusChange(renderStorageStatus);

    DB.init()
      .then(function () { return DB.getSettings(); })
      .then(function (settings) {
        S.settings = Object.assign({}, D.DEFAULT_SETTINGS, settings);
        setVal('w-add-complexity', S.settings.defaultComplexity);
        setVal('l-add-complexity', S.settings.defaultComplexity);
        updateMigrationHelp();
        return Promise.all([DB.listRecords(), DB.listProjects()]);
      })
      .then(function (res) {
        S.records = res[0];
        S.projects = res[1];
        renderStorageStatus();
        renderDashboard();
        renderProjects();
        /* The database owns the directory, so re-render now that it has
           replaced the seed that was shown a moment ago. */
        renderDpmDirectory();
        if (S.records.length) renderResultChip(S.records[0]);
      })
      .catch(function (err) {
        console.error(err);
        U.toast('Storage could not be opened: ' + err.message, 'err');
      });

    /* Re-check the host when the tab regains focus, so starting the launcher
       after the page is already open lights the connection up without a reload. */
    global.addEventListener('focus', function () {
      DB.probeServer().then(function (online) {
        if (online) DB.flushPending().then(function (n) { if (n) renderStorageStatus(); });
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window);
