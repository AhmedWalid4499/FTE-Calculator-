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
    compare: { wan: [], lan: [] },   // side-by-side scenarios, in memory only until saved
    records: [],
    projects: [],
    selectedProject: null,
    dpmPicker: { side: 'wan', temp: [] },
    refStage: 'Design',
    plan: { team: null, last: null, loading: false, error: null },
    pendingRoot: null,    // data-folder path being typed in Settings, kept across re-renders
    me: { name: '', email: '', source: '' },                  // who is using the app
    teamFolder: { checked: false, candidates: [], linked: false, error: null }
  };

  var TF = D.TEAM_FOLDER;

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

    var tfState = teamFolderState();
    if (tfState === 'verified') {
      dot.className = 'status-dot on';
      text.textContent = 'Saving to SharePoint';
      chip.title = 'Every calculation is written into the team folder “' + TF.name + '” (' + st.dataRoot +
        ') and OneDrive uploads it to SharePoint.';
    } else if (tfState === 'named') {
      dot.className = 'status-dot on';
      text.textContent = 'Saving to ' + TF.name;
      chip.title = 'Every calculation is written into a folder named “' + TF.name + '”' +
        (st.mode === 'host' ? ' (' + st.dataRoot + ')' : '') + '. See Settings to check it is the shared SharePoint folder.';
    } else if (st.mode === 'host') {
      dot.className = 'status-dot on';
      text.textContent = st.isDefaultRoot ? 'Saving on this PC only' : 'Saving to data folder';
      chip.title = 'Every calculation is written as a JSON file into: ' + (st.dataRoot || 'the data folder') +
        (st.isDefaultRoot ? '. Link the SharePoint team folder in Settings to share them with the team.' : '');
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
    renderUpdates();   // "update required" follows the storage status
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

  /* Read the WAN form, run the engine and wrap the result in a record - the
     same self-contained snapshot a calculation produces, but WITHOUT saving
     it. Calculate saves it; "Add to comparison" holds several in memory. Null
     is returned (and field errors shown) when the form does not validate. */
  function buildWanRecord() {
    U.clearFieldErrors();
    var input = collectWanInput();
    var result = C.calculateWan(input, S.settings);
    if (!result.ok) { U.reportErrors(result.errors); return null; }

    return {
      id: C.makeRecordId(),
      savedAt: new Date().toISOString(),
      appVersion: D.APP_VERSION,
      type: 'WAN',
      projectCode: ensureCode('wan'),
      projectName: val('w-proj-name') || 'Untitled WAN project',
      status: segValue('w-status'),
      createdBy: meStamp(),
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
  }

  function buildLanRecord() {
    U.clearFieldErrors();
    var input = collectLanInput();
    var result = C.calculateLan(input, S.settings);
    if (!result.ok) { U.reportErrors(result.errors); return null; }

    return {
      id: C.makeRecordId(),
      savedAt: new Date().toISOString(),
      appVersion: D.APP_VERSION,
      type: 'LAN',
      projectCode: ensureCode('lan'),
      projectName: val('l-proj-name') || 'Untitled LAN project',
      status: segValue('l-status'),
      createdBy: meStamp(),
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
  }

  function showResult(side, record) {
    sideState(side).record = record;
    if (side === 'wan') renderWanResult(record); else renderLanResult(record);
    renderResultChip(record);
  }

  function calculateWan() {
    var record = buildWanRecord();
    if (!record) return;
    showResult('wan', record);
    persistRecord(record);
  }

  function calculateLan() {
    var record = buildLanRecord();
    if (!record) return;
    showResult('lan', record);
    persistRecord(record);
  }

  function persistRecord(record) {
    DB.saveRecord(record).then(function (res) {
      renderStorageStatus();
      return DB.listRecords().then(function (rows) {
        S.records = rows;
        renderDashboard();
        if (!res.written) {
          var needsUpdate = DB.status().updateRequired;
          U.toast(needsUpdate
            ? 'Calculation kept in this browser only — this copy of the app must be updated before it can save to the data folder (see the Dashboard).'
            : 'Calculation saved in this browser. It will be written to the data folder when the app host is running.', 'warn');
          return;
        }
        /* The estimate is on disk; now the project's workbook beside it. */
        return updateProjectWorkbook(record.projectName, record.createdBy, { silent: true }).then(function (wbk) {
          var where = (onTeamFolder() ? 'SharePoint' : 'the data folder') + ' › ' + D.projectFolderName(record.projectName);
          if (wbk && wbk.written) U.toast('Saved to ' + where + ': the estimate and “' + wbk.name + '”.', 'ok');
          else if (wbk && wbk.error) U.toast('Estimate saved to ' + where + ', but the Excel workbook could not be updated: ' + wbk.error, 'warn');
          else U.toast('Calculation saved to ' + res.file, 'ok');
        });
      });
    });
  }

  /* ---------------------------------------------------- project workbook -- */

  /* Beside every project's estimates sits "<project> - <who did it>.xlsx",
     rebuilt from that person's latest estimate(s) of the project whenever one
     changes, and removed when they have none left.
       - Built from a fresh read of the data folder when the job runs, never
         from this browser's copy, which can lag behind colleagues' changes -
         so nobody's workbook is regressed or removed on stale information.
       - One file belongs to one person: estimates are grouped by the person's
         email and the file is named from their newest estimate. If two people
         would get the same file name, each gets their email name added.
       - Jobs run one at a time, so two changes never write one file together. */
  var workbookQueue = Promise.resolve();

  function enqueueWorkbookJob(fn) {
    var job = workbookQueue.then(fn);
    workbookQueue = job.then(function () {}, function () {});
    return job;
  }

  function groupKey(projectName, person) {
    return D.projectFolderName(projectName).toLowerCase() + '|' + creatorKey({ createdBy: person });
  }

  function workbookPool() {
    return DB.loadTeamRecords().then(function (t) { return t.records; });
  }

  /* Every workbook the estimates in `pool` call for.
     groups: key -> { folder, name, latest: [record] }
     claims: "folder|name" (lower case) -> key */
  function planWorkbooks(pool) {
    var groups = {};
    (pool || []).forEach(function (r) {
      if (!r || !r.results) return;
      var k = groupKey(r.projectName, r.createdBy);
      var g = groups[k] || (groups[k] = { key: k, folder: D.projectFolderName(r.projectName), records: [] });
      g.records.push(r);
    });
    var byName = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      g.records.sort(function (a, b) { return String(b.savedAt || '').localeCompare(String(a.savedAt || '')); });
      g.person = g.records[0].createdBy || null;
      g.name = D.projectWorkbookName(g.records[0].projectName, g.person);
      var latest = {};
      g.records.forEach(function (r) { if (!latest[r.type]) latest[r.type] = r; });
      g.latest = Object.keys(latest).map(function (t) { return latest[t]; });
      var nk = (g.folder + '|' + g.name).toLowerCase();
      (byName[nk] = byName[nk] || []).push(g);
    });
    Object.keys(byName).forEach(function (nk) {
      if (byName[nk].length < 2) return;
      byName[nk].forEach(function (g) {
        var tag = g.person && g.person.email ? String(g.person.email).split('@')[0] : 'unknown';
        g.name = D.projectWorkbookName(g.records[0].projectName, { name: personName(g.person) + ' (' + tag + ')' });
      });
    });
    var claims = {};
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      claims[(g.folder + '|' + g.name).toLowerCase()] = k;
    });
    return { groups: groups, claims: claims };
  }

  function isClaimed(plan, folder, name) {
    return !!plan.claims[(folder + '|' + name).toLowerCase()];
  }

  function errorText(err) { return (err && err.message) || String(err); }

  /* Bring whole project folders in line with the plan: every person's
     workbook in them rebuilt, and any "<project> - ....xlsx" no estimate calls
     for any more removed - a deleted person's, or one left under an old name
     (a changed display name, or a same-name clash that has since gone away).
     folders: lower-case folder names, or null for every folder. */
  function syncFolders(plan, folders, tally) {
    function fail(err) { tally.failed++; tally.lastError = errorText(err); }
    function wanted(folder) { return !folders || folders[folder.toLowerCase()]; }
    var groups = Object.keys(plan.groups).map(function (k) { return plan.groups[k]; })
      .filter(function (g) { return wanted(g.folder); });
    return groups.reduce(function (c, g) {
      return c.then(function () {
        return EX.buildProjectWorkbook(g.latest)
          .then(function (bytes) { return DB.saveProjectFile(g.folder, g.name, bytes); })
          .then(function () { tally.written++; tally.names[g.key] = g.name; }, fail);
      });
    }, Promise.resolve()).then(function () {
      return DB.listProjectFiles();
    }).then(function (files) {
      var orphans = files.filter(function (f) {
        return wanted(f.folder) &&
               f.name.toLowerCase().indexOf((f.folder + ' - ').toLowerCase()) === 0 &&
               !isClaimed(plan, f.folder, f.name);
      });
      return orphans.reduce(function (c, f) {
        return c.then(function () {
          return DB.deleteProjectFile(f.folder, f.name).then(function () { tally.removed++; }, fail);
        });
      }, Promise.resolve());
    });
  }

  function newTally() { return { written: 0, removed: 0, failed: 0, lastError: '', names: {} }; }

  /**
   * Update the workbooks of one project after one person's estimate changed.
   * opts.silent: the caller reports the outcome itself; otherwise a failure
   * is shown as a warning. Resolves { name, folder, written | removed | skipped | error }.
   */
  function updateProjectWorkbook(projectName, person, opts) {
    var folder = D.projectFolderName(projectName);
    var key = groupKey(projectName, person);
    var name = D.projectWorkbookName(projectName, person);
    return enqueueWorkbookJob(function () {
      if (DB.status().mode === 'browser') return { name: name, folder: folder, skipped: true };
      var tally = newTally(), only = {};
      only[folder.toLowerCase()] = true;
      return workbookPool().then(function (pool) {
        var plan = planWorkbooks(pool);
        return syncFolders(plan, only, tally).then(function () {
          var mine = plan.groups[key];
          if (tally.failed) return { name: mine ? mine.name : name, folder: folder, error: tally.lastError };
          return mine ? { name: mine.name, folder: folder, written: true } : { name: name, folder: folder, removed: true };
        });
      });
    }).catch(function (err) {
      return { name: name, folder: folder, error: errorText(err) };
    }).then(function (res) {
      if (res.error && !(opts && opts.silent)) {
        U.toast('The Excel workbook “' + res.name + '” could not be updated: ' + res.error, 'warn');
      }
      return res;
    });
  }

  /**
   * Update many workbooks in one job, from one fresh read of the folder.
   * opts.keys: [{ projectName, createdBy }] - only those projects' folders;
   * default: every project folder. Resolves a tally; failures are shown
   * unless opts.silent.
   */
  function rebuildWorkbooks(opts) {
    opts = opts || {};
    var tally = newTally();
    return enqueueWorkbookJob(function () {
      if (DB.status().mode === 'browser') return tally;
      var folders = null;
      if (opts.keys) {
        folders = {};
        opts.keys.forEach(function (x) { folders[D.projectFolderName(x.projectName).toLowerCase()] = true; });
      }
      return workbookPool().then(function (pool) { return syncFolders(planWorkbooks(pool), folders, tally); });
    }).then(function () { return tally; }, function (err) {
      tally.failed++; tally.lastError = errorText(err); return tally;
    }).then(function (t) {
      if (t.failed && !opts.silent) U.toast(t.failed + ' Excel workbook(s) could not be updated: ' + t.lastError, 'warn');
      return t;
    });
  }

  /* Estimates that reached disk later - a flush once the folder was back, a
     publish into a newly linked folder - or a delete that had to wait: their
     projects' workbooks catch up here. */
  function onRecordsChanged(ev) {
    var keys = ev.written.map(function (r) { return { projectName: r.projectName, createdBy: r.createdBy }; })
      .concat(ev.deleted.map(function (t) { return { projectName: t.projectName, createdBy: t.createdBy }; }));
    if (keys.length) rebuildWorkbooks({ keys: keys });
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
      /* No saved copy means this is a comparison scenario loaded onto the form
         but never saved. Editing its notes or start month, or exporting it,
         must not quietly turn it into a saved estimate - only "Save as
         estimate" does that. */
      if (!fresh) return { record: rec, written: false };
      var target = fresh;
      if (notesChanged) target.notes = notes;
      if (startChanged) target.inputs.startMonth = start;
      target.updatedBy = meStamp();
      target.updatedAt = new Date().toISOString();
      return DB.updateRecord(target);
    }).then(function (res) {
      var saved = res.record;
      if (st.record && st.record.id === saved.id) st.record = saved;
      if (!startChanged && saved.inputs.durationSource !== 'dates') setVal(p + '-start-month', saved.inputs.startMonth || '');
      S.plan.team = null;   // the team plan re-reads on its next visit
      if (res.written) updateProjectWorkbook(saved.projectName, saved.createdBy);   // in the background
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

  /* ========================================================= comparison == */

  /* Several estimates of the SAME project held side by side so their effort can
     be compared under different conditions (complexity, mode, flat/bell curve,
     migration, duration, capacity, allocation). Each scenario is a full record
     snapshot built with the pure engine; nothing is written to the data folder
     until the user saves a scenario as the estimate, or saves the comparison.
     A saved comparison lives in this browser (the settings store), separate
     from Records and the team plan so neither is polluted by what-if variants. */

  var COMPARISONS_KEY = '_comparisons';
  function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function findScenario(side, id) {
    return S.compare[side].filter(function (s) { return s.id === id; })[0] || null;
  }

  /* A short name for a new scenario: "Baseline" for the first, otherwise the
     conditions that differ from it, so the label itself says what changed. */
  function defaultScenarioLabel(side, rec, index) {
    if (index === 0) return 'Baseline';
    var base = S.compare[side][0] && S.compare[side][0].record;
    var diffs = [];
    if (base) {
      var bi = base.inputs, ri = rec.inputs;
      if ((ri.distribution === 'bell') !== (bi.distribution === 'bell')) diffs.push(ri.distribution === 'bell' ? 'Bell curve' : 'Flat');
      if (ri.mode !== bi.mode) diffs.push(ri.mode);
      if (C.num(ri.months) !== C.num(bi.months)) diffs.push(fmt.months(ri.months));
      if (side === 'wan' && ri.migration !== bi.migration) diffs.push(ri.migration === 'Yes' ? 'With migration' : 'No migration');
      if (side === 'lan' && (ri.stages || []).join(',') !== (bi.stages || []).join(',')) diffs.push('Other stages');
      if (C.num(ri.totalSites) !== C.num(bi.totalSites)) diffs.push(fmt.int(ri.totalSites) + ' sites');
      if (C.num(ri.capacityMdPerMonth) !== C.num(bi.capacityMdPerMonth)) diffs.push(ri.capacityMdPerMonth + ' MD/mo');
      if (JSON.stringify(ri.allocation || []) !== JSON.stringify(bi.allocation || [])) diffs.push('Adjusted scope');
    }
    if (diffs.length) return diffs.slice(0, 2).join(', ');
    return 'Variant ' + (index + 1);
  }

  function addToComparison(side) {
    var rec = side === 'wan' ? buildWanRecord() : buildLanRecord();
    if (!rec) return;
    showResult(side, rec);
    var list = S.compare[side];
    var label = defaultScenarioLabel(side, rec, list.length);
    list.push({ id: uid(), label: label, record: rec });
    renderCompare(side);
    var card = el(side === 'wan' ? 'w-compare' : 'l-compare');
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    U.toast('Added “' + label + '” — ' + list.length + ' scenario(s) in the comparison.', 'ok');
  }

  /* ---- the side-by-side table ---- */

  function cmpAllocCell(rec) {
    var rows = rec.results.rows || [];
    if (!rows.length) return '<span class="cmp-muted">—</span>';
    return rows.map(function (x) {
      var name = x.product ? (x.product + ' — ' + x.connectivityMode) : x.label;
      return esc(name) + ': ' + fmt.int(x.sites) + ' @ ' + x.complexityPct + '%';
    }).join('<br>');
  }

  /* Each entry: { label, html (ready to insert), raw (for the differs-from-
     baseline test) }. */
  function cmpConditions(side, rec) {
    var i = rec.inputs;
    var out = [
      { label: 'Duration', html: esc(fmt.months(i.months)) },
      { label: 'Total sites', html: esc(fmt.int(i.totalSites)) },
      { label: 'Mode', html: esc(i.mode || '—') },
      { label: 'Distribution', html: i.distribution === 'bell' ? 'Bell curve' : 'Flat' }
    ];
    if (side === 'wan') {
      out.push({ label: 'Migration uplift', html: i.migration === 'Yes' ? 'Yes' : 'No' });
    } else {
      out.splice(2, 0, { label: 'Devices (fallback)', html: esc(fmt.int(i.devices || 0)) });
      out.push({ label: 'Stages', html: (i.stages && i.stages.length) ? esc(i.stages.join(', ')) : '—' });
      /* Always emit this row (not only when set) so every LAN scenario has the
         same rows and the columns stay aligned - comparing "with override" to
         "default" is a normal use. */
      out.push({ label: 'Fallback override', html: i.fallbackOverride ? (esc(fmt.md(i.fallbackOverride)) + ' MD/site') : '<span class="cmp-muted">—</span>' });
    }
    out.push({ label: 'DPM capacity', html: esc((i.capacityMdPerMonth || '—') + ' MD/mo') });
    out.push({ label: 'Allocation', html: cmpAllocCell(rec), raw: JSON.stringify(i.allocation || []) });
    out.forEach(function (c) { if (c.raw === undefined) c.raw = c.html; });
    return out;
  }

  function cmpResults(rec) {
    var r = rec.results, shaped = isShaped(r);
    return [
      { label: 'Total man-days', html: esc(fmt.md(r.totalMd) + ' MD'), num: r.totalMd, delta: true },
      { label: shaped ? 'Average / month' : 'Per month', html: esc(fmt.md(r.mdPerMonth) + ' MD'), num: r.mdPerMonth, delta: true },
      { label: shaped ? 'FTE (average)' : 'FTE required', html: esc(fmt.fte(r.fte)), num: r.fte, delta: true },
      { label: 'Headcount', html: esc(r.headcount + ' people'), num: r.headcount },
      { label: 'Utilisation', html: esc(fmt.pct(r.utilisationPct)), num: r.utilisationPct },
      { label: 'Peak FTE', html: shaped ? esc(fmt.fte(r.peakFte)) : '—', num: shaped ? r.peakFte : null, delta: true },
      { label: 'Peak headcount', html: shaped ? esc(r.peakHeadcount + ' people') : '—', num: shaped ? r.peakHeadcount : null }
    ];
  }

  function deltaChip(num, baseNum) {
    if (typeof num !== 'number' || typeof baseNum !== 'number' || baseNum === 0) return '';
    var d = (num - baseNum) / baseNum * 100;
    if (Math.abs(d) < 0.5) return '<span class="cmp-delta cmp-same">same</span>';
    var cls = d > 0 ? 'cmp-up' : 'cmp-down';
    return '<span class="cmp-delta ' + cls + '">' + (d > 0 ? '+' : '') + d.toFixed(0) + '%</span>';
  }

  function cmpGroupRow(title, n) {
    return '<tr class="cmp-group"><td colspan="' + (n + 1) + '">' + esc(title) + '</td></tr>';
  }

  function compareTableHtml(side, list) {
    var conds = list.map(function (s) { return cmpConditions(side, s.record); });
    var reslt = list.map(function (s) { return cmpResults(s.record); });
    var n = list.length;

    var html = '<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th class="cmp-rowhead"></th>';
    list.forEach(function (s, idx) {
      html += '<th class="cmp-colhead"><div class="cmp-scn-label">' + esc(s.label) +
        (idx === 0 ? ' <span class="tag tag-info">baseline</span>' : '') + '</div>' +
        '<div class="cmp-scn-acts">' +
          '<button class="btn btn-ghost btn-xs" data-cmp-scn-act="rename" data-side="' + side + '" data-id="' + s.id + '" title="Rename">✎</button>' +
          '<button class="btn btn-ghost btn-xs" data-cmp-scn-act="load" data-side="' + side + '" data-id="' + s.id + '" title="Load into the form to tweak">Load</button>' +
          '<button class="btn btn-ghost btn-xs" data-cmp-scn-act="promote" data-side="' + side + '" data-id="' + s.id + '" title="Save this one as the estimate">Save</button>' +
          '<button class="btn btn-ghost btn-xs" data-cmp-scn-act="remove" data-side="' + side + '" data-id="' + s.id + '" title="Remove from the comparison">✕</button>' +
        '</div></th>';
    });
    html += '</tr></thead><tbody>';

    html += cmpGroupRow('Conditions', n);
    conds[0].forEach(function (_, rIdx) {
      html += '<tr><td class="cmp-rowhead">' + esc(conds[0][rIdx].label) + '</td>';
      conds.forEach(function (col, cIdx) {
        var cell = col[rIdx];
        if (!cell) { html += '<td></td>'; return; }   // defensive: never let an uneven column crash the table
        var differs = cIdx > 0 && cell.raw !== conds[0][rIdx].raw;
        html += '<td class="' + (differs ? 'cmp-diff' : '') + '">' + cell.html + '</td>';
      });
      html += '</tr>';
    });

    html += cmpGroupRow('Results', n);
    reslt[0].forEach(function (_, rIdx) {
      html += '<tr><td class="cmp-rowhead">' + esc(reslt[0][rIdx].label) + '</td>';
      reslt.forEach(function (col, cIdx) {
        var cell = col[rIdx];
        var chip = (cell.delta && cIdx > 0) ? deltaChip(cell.num, reslt[0][rIdx].num) : '';
        html += '<td><span class="cmp-val">' + cell.html + '</span>' + chip + '</td>';
      });
      html += '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
  }

  function renderCompare(side) {
    var p = side === 'wan' ? 'w' : 'l';
    var body = el(p + '-compare-body');
    if (!body) return;
    var list = S.compare[side];
    var countEl = el(p + '-compare-count');
    if (countEl) countEl.textContent = list.length;
    qsa('[data-cmp-act="save"][data-side="' + side + '"], [data-cmp-act="clear"][data-side="' + side + '"]').forEach(function (b) {
      b.disabled = !list.length;
    });
    if (!list.length) {
      body.innerHTML = '<p class="cmp-empty">No scenarios yet. Set the conditions above and press ' +
        '<b>➕ Add to comparison</b> to snapshot one, then change a condition and add another to see the effort side by side.' +
        '<span class="cmp-empty-hint">Nothing is written to the data folder until you save a scenario as the estimate, or save the comparison.</span></p>';
      return;
    }
    body.innerHTML = compareTableHtml(side, list);
  }

  function handleCompareAction(act, side) {
    if (act === 'save') saveComparison(side);
    else if (act === 'open') openSavedComparison(side);
    else if (act === 'clear') clearComparison(side);
  }

  function handleScenarioAction(act, side, id) {
    var scn = findScenario(side, id);
    if (!scn) return;
    if (act === 'remove') {
      S.compare[side] = S.compare[side].filter(function (s) { return s.id !== id; });
      renderCompare(side);
    } else if (act === 'rename') {
      U.prompt('Rename scenario', 'A short name for this scenario.', scn.label, { requiredMessage: 'Please enter a name.' })
        .then(function (name) { if (name) { scn.label = name; renderCompare(side); } });
    } else if (act === 'load') {
      applyRecordToForm(side, scn.record);
      U.toast('Loaded “' + scn.label + '” into the form. Change a condition and press ➕ Add to comparison for a new variant.', 'ok');
    } else if (act === 'promote') {
      U.confirm('Save “' + scn.label + '” as the estimate?',
        'It will be saved for “' + (scn.record.projectName || 'this project') + '” and written to the data folder like a normal calculation. ' +
        'The other scenarios stay in the comparison.', { confirmLabel: 'Save as estimate' })
        .then(function (yes) {
          if (!yes) return;
          var rec = scn.record;
          showResult(side, rec);
          persistRecord(rec);
        });
    }
  }

  function clearComparison(side) {
    if (!S.compare[side].length) return;
    U.confirm('Clear the comparison?',
      'This removes all ' + S.compare[side].length + ' scenario(s) from the side-by-side view. ' +
      'Saved comparisons and saved estimates are not affected.', { confirmLabel: 'Clear', danger: true })
      .then(function (yes) { if (yes) { S.compare[side] = []; renderCompare(side); } });
  }

  /* ---- put a scenario's snapshot back on the form, to tweak and re-add ---- */

  function applyRecordToForm(side, rec) {
    var i = rec.inputs || {};
    var st = sideState(side);
    st.rows = (i.allocation || []).map(function (r) { return Object.assign({}, r); });
    st.dpms = (rec.dpms || []).map(function (d) { return Object.assign({}, d); });
    st.code = rec.projectCode || null;
    st.codeName = (rec.projectName || '').trim();

    if (side === 'wan') {
      setVal('w-proj-name', rec.projectName || '');
      if (rec.status) setSeg('w-status', rec.status);
      if (i.pmRole) setSeg('w-pm-role', i.pmRole);
      setVal('w-months', i.months || '');
      setVal('w-start-date', i.startDate || '');
      setVal('w-end-date', i.endDate || '');
      setVal('w-start-month', i.startMonth || '');
      setVal('w-sites', i.totalSites || '');
      if (i.projectType) setVal('w-type', i.projectType);
      if (i.migration) setSeg('w-migration', i.migration);
      if (i.abacos) setSeg('w-abacos', i.abacos);
      if (i.mode) setSeg('w-mode', i.mode);
      setSeg('w-dist', i.distribution === 'bell' ? 'bell' : 'flat');
      setVal('w-notes', rec.notes || '');
    } else {
      setVal('l-proj-name', rec.projectName || '');
      if (rec.status) setSeg('l-status', rec.status);
      if (i.pmRole) setSeg('l-pm-role', i.pmRole);
      setVal('l-months', i.months || '');
      setVal('l-start-date', i.startDate || '');
      setVal('l-end-date', i.endDate || '');
      setVal('l-start-month', i.startMonth || '');
      setVal('l-sites', i.totalSites || '');
      setVal('l-devices', i.devices || 0);
      if (i.flan) setSeg('l-flan', i.flan);
      if (i.mode) setSeg('l-mode', i.mode);
      setVal('l-fb-ovrd', i.fallbackOverride || '');
      setSeg('l-dist', i.distribution === 'bell' ? 'bell' : 'flat');
      setVal('l-notes', rec.notes || '');
      renderStageChips();
      var stages = i.stages || [];
      qsa('#l-stages .stage-chip').forEach(function (n) {
        var on = stages.indexOf(n.dataset.stage) >= 0;
        n.classList.toggle('checked', on);
        n.setAttribute('aria-pressed', String(on));
      });
      renderStageSummary();
    }

    var pill = el(prefix(side) + '-code-pill');
    if (st.code && pill) { pill.textContent = st.code; pill.classList.remove('hidden'); }
    switchDuration(side, i.durationSource === 'dates' ? 'dates' : 'months');
    syncModeUi(side);
    if (side === 'wan') renderWanRows(); else renderLanRows();
    renderAssignedDpms(side);
    showResult(side, rec);
  }

  /* ---- saved comparisons (this browser) ---- */

  function getSavedComparisons() {
    return DB.getSettings().then(function (s) {
      return Array.isArray(s[COMPARISONS_KEY]) ? s[COMPARISONS_KEY] : [];
    }).catch(function () { return []; });
  }

  function saveComparison(side) {
    var list = S.compare[side];
    if (!list.length) { U.toast('Add at least one scenario first.', 'warn'); return; }
    var proj = (list[0].record.projectName || '').trim();
    var suggested = proj ? (proj + ' — comparison') : (side.toUpperCase() + ' comparison');
    U.prompt('Save comparison', 'Name this comparison so you can reopen it later. It is saved in this browser.', suggested,
      { requiredMessage: 'Please enter a name.' }).then(function (name) {
      if (!name) return;
      return getSavedComparisons().then(function (all) {
        var obj = {
          id: uid(), name: name, side: side, savedAt: new Date().toISOString(),
          savedBy: meStamp(), projectName: proj,
          scenarios: list.map(function (s) { return { label: s.label, record: s.record }; })
        };
        var kept = all.filter(function (c) {
          return !(c.side === side && String(c.name).toLowerCase() === name.toLowerCase());
        });
        kept.push(obj);
        return DB.setSetting(COMPARISONS_KEY, kept).then(function () {
          U.toast('Comparison “' + name + '” saved. Reopen it with “Open saved”.', 'ok');
        });
      });
    });
  }

  function savedListHtml(list, side) {
    var rows = list.slice().sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); });
    return '<div class="cmp-saved-list">' + rows.map(function (c) {
      return '<label class="cmp-saved-row"><input type="radio" name="cmppick" value="' + esc(c.id) + '">' +
        '<span class="cmp-saved-main"><b>' + esc(c.name) + '</b>' +
        '<span class="cmp-saved-meta">' + (c.scenarios || []).length + ' scenario(s) · ' + esc(fmt.dateTime(c.savedAt)) + '</span></span>' +
        '<button type="button" class="icon-btn" data-cmpdel="' + esc(c.id) + '" data-side="' + side + '" title="Delete this saved comparison">🗑</button>' +
        '</label>';
    }).join('') + '</div><p class="dlg-error" hidden role="alert"></p>';
  }

  function fillSavedList(backdrop, side) {
    getSavedComparisons().then(function (all) {
      var mine = all.filter(function (c) { return c.side === side; });
      var bodyEl = qs('.dlg-body', backdrop);
      if (!bodyEl) return;
      bodyEl.innerHTML = mine.length ? savedListHtml(mine, side) : '<p>No saved comparisons left.</p>';
    });
  }

  function openSavedComparison(side) {
    getSavedComparisons().then(function (all) {
      var mine = all.filter(function (c) { return c.side === side; });
      if (!mine.length) { U.toast('No saved comparisons yet. Use “Save comparison” first.', 'warn'); return; }
      U.dialog({
        title: 'Open saved comparison', confirmLabel: 'Open', bodyHtml: savedListHtml(mine, side),
        collect: function (bd) {
          var sel = qs('input[name="cmppick"]:checked', bd);
          if (!sel) {
            var err = qs('.dlg-error', bd);
            if (err) { err.textContent = 'Pick a comparison to open.'; err.hidden = false; }
            return false;
          }
          return sel.value;
        }
      }).then(function (id) { if (id) loadSavedComparison(side, id); });
    });
  }

  function loadSavedComparison(side, id) {
    getSavedComparisons().then(function (all) {
      var c = all.filter(function (x) { return x.id === id; })[0];
      if (!c) { U.toast('That comparison is no longer available.', 'warn'); return; }
      S.compare[side] = (c.scenarios || []).map(function (s) { return { id: uid(), label: s.label, record: s.record }; });
      renderCompare(side);
      if (S.compare[side].length) applyRecordToForm(side, S.compare[side][0].record);
      var card = el((side === 'wan' ? 'w' : 'l') + '-compare');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      U.toast('Opened “' + c.name + '” — ' + S.compare[side].length + ' scenario(s).', 'ok');
    });
  }

  function deleteSavedComparison(id) {
    return getSavedComparisons().then(function (all) {
      return DB.setSetting(COMPARISONS_KEY, all.filter(function (c) { return c.id !== id; }));
    });
  }

  /* ============================================================== AI ====== */

  /* The assistant: a chat drawer that answers questions, gives an opinion on a
     result, and auto-fills the estimator from an uploaded file. Everything
     routes through FTEAi, which calls the launcher's /api/ai proxy; it only
     works in host mode, so the whole UI is hidden unless a key is configured. */
  var AI = global.FTEAi;

  function aiInit() {
    S.ai = { available: false, mode: '', needsKey: false, open: false, busy: false, connect: false, history: [], fileSide: null };
    if (!AI || !AI.supported) { aiReflect(); return; }
    AI.getStatus().then(function (st) {
      S.ai.available = !!st.available; S.ai.mode = st.mode; S.ai.needsKey = !!st.needsKey;
      aiReflect();
    });
  }

  function aiReflect() {
    var show = !!(AI && AI.supported);         // the feature exists here (website or launcher)
    var usable = !!(S.ai && S.ai.available);   // a key/launcher is ready, so Calculate-time buttons make sense
    var chip = el('ai-toggle'); if (chip) chip.classList.toggle('hidden', !show);
    qsa('.ai-only').forEach(function (b) { b.classList.toggle('hidden', !usable); });
  }

  function aiOpen() {
    if (!(AI && AI.supported)) return;
    S.ai.open = true; el('ai-drawer').classList.remove('hidden'); aiRender();
    setTimeout(function () {
      var t = el((S.ai.connect || S.ai.needsKey) ? 'ai-key-input' : 'ai-text'); if (t) t.focus();
    }, 30);
  }
  function aiClose() { S.ai.open = false; el('ai-drawer').classList.add('hidden'); }
  function aiToggle() { if (S.ai.open) aiClose(); else aiOpen(); }

  /* Escape everything, then allow only **bold** and leave line breaks (the
     container is pre-wrap). No other HTML from the model is rendered. */
  function aiFormat(text) {
    return esc(text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }

  /* The paste-your-key panel, shown on the website (no launcher) until a key is
     saved in this browser, and whenever the user clicks the key icon. */
  function aiConnectHtml() {
    var has = AI.hasBrowserKey();
    return '<div class="ai-connect">' +
      '<div class="ai-connect-title">🔑 Connect your Anthropic key</div>' +
      '<p>Paste your Anthropic API key to switch the Assistant on. It is saved <b>only in this browser</b> — never uploaded, never shared, never in the app\'s code.</p>' +
      '<input type="password" id="ai-key-input" class="ai-key-input" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">' +
      '<input type="text" id="ai-wsid-input" class="ai-key-input" placeholder="Workspace ID — only if your key needs one" autocomplete="off" spellcheck="false">' +
      '<div class="btn-row">' +
        '<button class="btn btn-primary btn-sm" data-ai-key="save">Save &amp; connect</button>' +
        (has ? '<button class="btn btn-ghost btn-sm" data-ai-key="clear">Remove key</button>' : '') +
        (!S.ai.needsKey ? '<button class="btn btn-ghost btn-sm" data-ai-key="cancel">Cancel</button>' : '') +
      '</div>' +
      '<p class="ai-connect-note">Get a key at <b>console.anthropic.com</b> → API keys. A workspace-scoped key needs no Workspace ID.</p>' +
    '</div>';
  }

  function aiStatusThen(cb) {
    return AI.getStatus(true).then(function (st) {
      S.ai.available = !!st.available; S.ai.mode = st.mode; S.ai.needsKey = !!st.needsKey;
      aiReflect(); if (cb) cb(st);
    });
  }
  function aiSaveKey() {
    var ki = el('ai-key-input'), wi = el('ai-wsid-input');
    var k = ki ? (ki.value || '').trim() : '';
    var w = wi ? (wi.value || '').trim() : '';
    if (!k) { U.toast('Paste your API key first.', 'warn'); if (ki) ki.focus(); return; }
    AI.setBrowserKey(k, w);
    S.ai.connect = false;
    aiStatusThen(function () { aiRender(); U.toast('Assistant connected on this browser.', 'ok'); });
  }
  function aiClearKey() {
    AI.clearBrowserKey(); S.ai.connect = false;
    aiStatusThen(function () { aiRender(); U.toast('Key removed from this browser.', 'ok'); });
  }

  /* Shared failure handler. An org-scoped key that needs a Workspace ID opens
     the key panel on that field instead of showing a cryptic error. */
  function aiHandleError(err) {
    S.ai.busy = false;
    if (err && err.needsWorkspace && S.ai.mode !== 'proxy') {
      S.ai.connect = true; aiRender();
      var w = el('ai-wsid-input'); if (w) w.focus();
      U.toast('Your key needs a Workspace ID — add it here, then Save & connect.', 'warn');
      return;
    }
    S.ai.history.push({ role: 'note', text: 'Error: ' + errorText(err) });
    aiRender();
  }

  function aiRender() {
    var host = el('ai-msgs'); if (!host) return;
    var kb = el('ai-key'); if (kb) kb.classList.toggle('hidden', !(S.ai.mode === 'direct' || S.ai.needsKey));
    if (S.ai.connect || S.ai.needsKey) { host.innerHTML = aiConnectHtml(); return; }
    if (!S.ai.history.length && !S.ai.busy) {
      host.innerHTML = '<div class="ai-empty"><span class="ai-spark">✨</span>Ask about this estimate, how to set one up, or whether the numbers look right — or attach a spreadsheet, PDF or photo and I\'ll fill the form for you.</div>';
      return;
    }
    var html = S.ai.history.map(function (m) {
      if (m.role === 'note') return '<div class="ai-msg note">' + esc(m.text) + '</div>';
      return '<div class="ai-msg ' + (m.role === 'user' ? 'user' : 'bot') + '">' + aiFormat(m.text) + '</div>';
    }).join('');
    if (S.ai.busy) html += '<div class="ai-msg bot typing">…thinking…</div>';
    host.innerHTML = html;
    host.scrollTop = host.scrollHeight;
  }

  function aiRecordSummary(rec) {
    var i = rec.inputs || {}, r = rec.results || {};
    var lines = [
      rec.type + ' estimate "' + rec.projectName + '" (' + rec.projectCode + ')',
      'Duration ' + i.months + ' months, ' + i.totalSites + ' sites, ' + i.mode + ' mode, ' +
        (i.distribution === 'bell' ? 'bell-curve' : 'flat') + ' distribution' + (i.migration ? (', migration ' + i.migration) : ''),
      'Rows:'
    ];
    (r.rows || []).forEach(function (x) {
      var nm = x.product ? (x.product + ' / ' + x.connectivityMode) : x.label;
      lines.push('  - ' + nm + ': ' + x.sites + ' sites @ ' + x.complexityPct + '% = ' + x.md + ' MD');
    });
    lines.push('Result: ' + r.totalMd + ' MD total, ' + r.mdPerMonth + ' MD/month, ' + r.fte + ' FTE avg, headcount ' + r.headcount + ', utilisation ' + r.utilisationPct + '%');
    if (r.usingBell) lines.push('Bell-curve peak: ' + r.peakFte + ' FTE (' + r.peakHeadcount + ' people) in month ' + r.peakMonth);
    if (rec.notes) lines.push('Notes: ' + rec.notes);
    return lines.join('\n');
  }

  function aiContext() {
    var page = (qs('.page.active') || {}).id;
    var rec = (page === 'page-lan' && S.lan.record) ? S.lan.record
            : (page === 'page-wan' && S.wan.record) ? S.wan.record
            : (S.wan.record || S.lan.record);
    return rec ? aiRecordSummary(rec) : '';
  }

  function aiSend(text) {
    if (S.ai.busy || !text) return;
    var userMsg = { role: 'user', text: text };
    S.ai.history.push(userMsg);
    S.ai.busy = true; aiRender();
    /* Opinion/auto-fill bubbles are display-only (aside) and must not go into
       the API transcript, and the turns must start with 'user' and alternate -
       otherwise Anthropic rejects the request. */
    var hist = S.ai.history
      .filter(function (m) { return (m.role === 'user' || m.role === 'assistant') && !m.aside; })
      .map(function (m) { return { role: m.role, content: m.raw || m.text }; });
    while (hist.length && hist[0].role !== 'user') { hist.shift(); }
    AI.chat(hist, aiContext()).then(function (res) {
      S.ai.busy = false;
      S.ai.history.push({ role: 'assistant', text: res.text || '(no answer)', raw: res.raw && res.raw.content });
      aiRender();
    }).catch(function (err) {
      /* Drop the just-added user turn so a retry doesn't send two user turns. */
      var i = S.ai.history.indexOf(userMsg);
      if (i >= 0) S.ai.history.splice(i, 1);
      aiHandleError(err);
    });
  }

  function aiOpinion(side) {
    var rec = sideState(side).record;
    if (!rec) { U.toast('Run a ' + side.toUpperCase() + ' calculation first.', 'warn'); return; }
    aiOpen();
    S.ai.history.push({ role: 'note', text: 'Opinion on "' + rec.projectName + '"' });
    S.ai.busy = true; aiRender();
    AI.opinion(aiRecordSummary(rec)).then(function (txt) {
      S.ai.busy = false; S.ai.history.push({ role: 'assistant', text: txt || '(no answer)', aside: true }); aiRender();
    }).catch(aiHandleError);
  }

  function aiBestName(value, list) {
    if (!value) return null;
    var v = String(value).trim().toLowerCase();
    var exact = list.filter(function (x) { return x.toLowerCase() === v; })[0];
    if (exact) return exact;
    return list.filter(function (x) { return x.toLowerCase().indexOf(v) >= 0 || v.indexOf(x.toLowerCase()) >= 0; })[0] || null;
  }

  /* Put an extracted project onto the estimator form. Names are matched to the
     exact rate-card entries; anything unmatched is kept verbatim so the user
     (and the allocation badge) can see and fix it. */
  function applyAiExtraction(data, preferSide) {
    var side = (data.side === 'lan' || data.side === 'wan') ? data.side : (preferSide || 'wan');
    gotoPage(side);
    var p = prefix(side), st = sideState(side), rows = [];

    if (data.projectName) setVal(p + '-proj-name', data.projectName);
    if (data.durationMonths > 0) { st.durMode = 'months'; switchDuration(side, 'months'); setVal(p + '-months', data.durationMonths); }
    if (data.totalSites > 0) setVal(p + '-sites', data.totalSites);
    setSeg(p + '-dist', data.distribution === 'bell' ? 'bell' : 'flat');

    if (side === 'wan') {
      setSeg('w-mode', data.mode === 'Non-standard' ? 'Non-standard' : 'Standard');
      if (data.migration) setSeg('w-migration', data.migration === 'Yes' ? 'Yes' : 'No');
      (data.allocation || []).forEach(function (a) {
        if (!(a.sites > 0)) return;
        rows.push({
          product: aiBestName(a.product, D.PRODUCTS) || a.product || D.PRODUCTS[0],
          connectivityMode: aiBestName(a.connectivityMode, D.CONNECTIVITY_MODES) || a.connectivityMode || D.CONNECTIVITY_MODES[0],
          sites: a.sites, complexityPct: a.complexityPct > 0 ? a.complexityPct : 100,
          overrideMdPerSite: a.overrideMdPerSite || null
        });
      });
      st.rows = rows; syncModeUi('wan'); renderWanRows(); renderWanAllocBadge();
    } else {
      setSeg('l-mode', (data.mode === 'Non-standard' || data.mode === 'By Stage') ? data.mode : 'Standard');
      if (data.devices > 0) setVal('l-devices', data.devices);
      (data.allocation || []).forEach(function (a) {
        if (!(a.sites > 0)) return;
        rows.push({
          tierLabel: aiBestName(a.tierLabel, D.LAN_TIER_LABELS) || a.tierLabel || D.LAN_TIER_LABELS[0],
          sites: a.sites, complexityPct: a.complexityPct > 0 ? a.complexityPct : 100,
          overrideMdPerSite: a.overrideMdPerSite || null
        });
      });
      st.rows = rows;
      renderStageChips();
      if (data.stages && data.stages.length) {
        var want = data.stages.map(function (s) { return String(s).toLowerCase(); });
        qsa('#l-stages .stage-chip').forEach(function (n) {
          var on = want.indexOf(String(n.dataset.stage).toLowerCase()) >= 0;
          n.classList.toggle('checked', on); n.setAttribute('aria-pressed', String(on));
        });
        renderStageSummary();
      }
      syncModeUi('lan'); renderLanRows(); renderLanAllocBadge();
    }
    if (data.notes) setVal(p + '-notes', data.notes);
    st.code = null; ensureCode(side);
    return { side: side, summary: rows.length + ' row(s), ' + (data.totalSites || '?') + ' sites' };
  }

  function aiAutofill(files, side) {
    if (!files || !files.length) return;
    var total = 0; Array.prototype.forEach.call(files, function (f) { total += f.size || 0; });
    if (total > 12 * 1024 * 1024) { U.toast('That file is large (over 12 MB). Try a smaller or compressed version.', 'warn'); return; }
    aiOpen();
    var names = Array.prototype.map.call(files, function (f) { return f.name; }).join(', ');
    S.ai.history.push({ role: 'note', text: 'Reading ' + names + '…' });
    S.ai.busy = true; aiRender();
    AI.extract(files).then(function (out) {
      S.ai.busy = false;
      if (!out.data) { S.ai.history.push({ role: 'assistant', text: out.text || 'I couldn\'t read a project out of that file. Try a clearer site list or tell me the details here.', aside: true }); aiRender(); return; }
      var applied = applyAiExtraction(out.data, side);
      var msg = 'Filled the ' + applied.side.toUpperCase() + ' form — ' + applied.summary + '.';
      var asum = out.data.assumptions || [];
      if (asum.length) msg += '\n\n**I assumed / couldn\'t find:**\n' + asum.map(function (a) { return '• ' + a; }).join('\n');
      msg += '\n\nCheck the fields, then press Calculate.';
      S.ai.history.push({ role: 'assistant', text: msg, aside: true });
      aiRender();
    }).catch(aiHandleError);
  }

  function bindAiEvents() {
    var toggle = el('ai-toggle'); if (toggle) toggle.addEventListener('click', aiToggle);
    var close = el('ai-close'); if (close) close.addEventListener('click', aiClose);
    var clear = el('ai-clear'); if (clear) clear.addEventListener('click', function () { S.ai.history = []; aiRender(); });
    var keyBtn = el('ai-key'); if (keyBtn) keyBtn.addEventListener('click', function () { S.ai.connect = true; aiRender(); var i = el('ai-key-input'); if (i) i.focus(); });
    /* The connect panel is re-rendered into #ai-msgs, so its buttons are wired
       by delegation. */
    var msgs = el('ai-msgs');
    if (msgs) {
      msgs.addEventListener('click', function (e) {
        var b = e.target.closest('[data-ai-key]'); if (!b) return;
        var act = b.getAttribute('data-ai-key');
        if (act === 'save') aiSaveKey();
        else if (act === 'clear') aiClearKey();
        else if (act === 'cancel') { S.ai.connect = false; aiRender(); }
      });
      msgs.addEventListener('keydown', function (e) {
        if (e.target && e.target.id === 'ai-key-input' && e.key === 'Enter') { e.preventDefault(); aiSaveKey(); }
      });
    }
    var form = el('ai-form');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      var t = el('ai-text'); var v = (t.value || '').trim(); if (!v) return;
      t.value = ''; t.style.height = 'auto'; aiSend(v);
    });
    var text = el('ai-text');
    if (text) {
      text.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el('ai-form').dispatchEvent(new Event('submit', { cancelable: true })); }
      });
      text.addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(120, this.scrollHeight) + 'px'; });
    }
    var fileInput = el('ai-file');
    var attach = el('ai-attach');
    if (attach) attach.addEventListener('click', function () {
      var page = (qs('.page.active') || {}).id;
      S.ai.fileSide = page === 'page-lan' ? 'lan' : (page === 'page-wan' ? 'wan' : null);
      fileInput.click();
    });
    if (fileInput) fileInput.addEventListener('change', function () {
      if (this.files && this.files.length) aiAutofill(this.files, S.ai.fileSide);
      this.value = ''; S.ai.fileSide = null;
    });
    ['wan', 'lan'].forEach(function (side) {
      var af = el(side[0] + '-ai-autofill');
      if (af) af.addEventListener('click', function () { S.ai.fileSide = side; fileInput.click(); });
      var op = el(side[0] + '-ai-opinion');
      if (op) op.addEventListener('click', function () { aiOpinion(side); });
    });
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

  function creatorKey(r) {
    var c = r && r.createdBy;
    return c ? String(c.email || c.name || '').toLowerCase() : '';
  }

  /* "Created by" choices: Everyone, Me, then everyone who has an estimate. */
  function renderOwnerFilter() {
    var sel = el('rec-owner');
    if (!sel) return;
    var current = sel.value;
    var people = {};
    S.records.forEach(function (r) {
      var k = creatorKey(r);
      if (k && !people[k]) people[k] = personName(r.createdBy);
    });
    var meKey = String(S.me.email || '').toLowerCase();
    var keys = Object.keys(people)
      .filter(function (k) { return k !== meKey; })   // already offered as "Me"
      .sort(function (a, b) { return people[a].localeCompare(people[b]); });
    var html = '<option value="">Everyone</option>' +
      (S.me.email ? '<option value="me">Me (' + esc(S.me.name || S.me.email) + ')</option>' : '') +
      keys.map(function (k) { return '<option value="' + esc(k) + '">' + esc(people[k]) + '</option>'; }).join('') +
      (S.records.some(function (r) { return !creatorKey(r); }) ? '<option value="none">Not recorded</option>' : '');
    sel.innerHTML = html;
    sel.value = current;
    if (sel.value !== current) sel.value = '';
  }

  function filteredRecords() {
    var q = (val('rec-search') || '').toLowerCase();
    var type = val('rec-type'), status = val('rec-status'), sort = val('rec-sort');
    var owner = val('rec-owner');
    var meKey = String(S.me.email || '').toLowerCase();
    var list = S.records.filter(function (r) {
      if (type && r.type !== type) return false;
      if (status && r.status !== status) return false;
      if (owner === 'me' && (!meKey || creatorKey(r) !== meKey)) return false;
      if (owner === 'none' && creatorKey(r)) return false;
      if (owner && owner !== 'me' && owner !== 'none' && creatorKey(r) !== owner) return false;
      if (!q) return true;
      return (r.projectName || '').toLowerCase().indexOf(q) >= 0 ||
             (r.projectCode || '').toLowerCase().indexOf(q) >= 0 ||
             (r.id || '').toLowerCase().indexOf(q) >= 0 ||
             personName(r.createdBy).toLowerCase().indexOf(q) >= 0;
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
    renderOwnerFilter();
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
            (r.createdBy ? '<span class="by">by <b>' + esc(isMe(r.createdBy) ? 'you' : personName(r.createdBy)) + '</b></span>' : '') +
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
        '<p class="by">Created by <b>' + esc(rec.createdBy ? personName(rec.createdBy) : 'not recorded') + '</b>' +
          (rec.createdBy && rec.createdBy.email ? ' (' + esc(rec.createdBy.email) + ')' : '') +
          (rec.updatedBy ? ' · last changed by <b>' + esc(personName(rec.updatedBy)) + '</b> ' + esc(fmt.dateTime(rec.updatedAt)) : '') +
        '</p>' +
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
          updateProjectWorkbook(rec.projectName, rec.createdBy);   // rebuilt from what is left, or removed
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
    if (t.source !== 'browser' && onTeamFolder()) return 'the SharePoint team folder “' + TF.name + '”';
    if (t.source === 'host') return 'the data folder ' + (t.location || st.dataRoot || '');
    if (t.source === 'folder') return 'the connected folder “' + (t.location || st.folderName || '') + '”';
    return 'this browser only';
  }

  function renderCapSource(plan) {
    var t = S.plan.team, st = DB.status(), c = plan.counts;
    var shared = (t.source === 'host' && !st.isDefaultRoot) || t.source === 'folder';
    var parts = [];
    var creators = {};
    plan.projects.forEach(function (p) { var k = creatorKey(p.record); if (k) creators[k] = true; });
    var nCreators = Object.keys(creators).length;
    parts.push('<b>' + c.projects + ' project(s)</b> from ' + c.estimates + ' estimate(s)' +
      (nCreators > 1 ? ' by ' + nCreators + ' people' : '') + ' in ' + esc(capSourceText()) + '.');
    if (c.superseded) parts.push(c.superseded + ' older estimate(s) of the same projects are set aside — the latest one counts.');
    if (c.inactiveExcluded) parts.push(c.inactiveExcluded + ' inactive project(s) left out.');
    if (t.pendingIncluded) parts.push(t.pendingIncluded + ' of your estimate(s) not yet written to disk are included.');
    if (t.errors) parts.push(t.errors + ' file(s) could not be read (possibly still syncing) and were skipped.');

    var html = '<div class="callout' + (shared ? '' : ' neutral') + '"><span class="callout-ic">' + (shared ? '👥' : '👤') + '</span><span>' +
      parts.join(' ') +
      (shared ? '' : '<br>This plan only sees <b>your</b> estimates. To plan across the whole team, link the SharePoint ' +
        'team folder “' + esc(TF.name) + '” — <a href="#" data-goto="settings">see Settings</a>.') +
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
            '<span class="person-sub">' + esc(p.code) +
            (p.record.createdBy ? ' · by ' + esc(isMe(p.record.createdBy) ? 'you' : personName(p.record.createdBy)) : '') +
            '</span></td>' +
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
      copy.updatedBy = meStamp();
      copy.updatedAt = new Date().toISOString();
      return DB.updateRecord(copy);
    }).then(function (res) {
      team.records[idx] = res.record;
      if (res.written) updateProjectWorkbook(res.record.projectName, res.record.createdBy);
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
      savedBy: meStamp(),
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
            (p.savedBy ? '<span class="by">by <b>' + esc(isMe(p.savedBy) ? 'you' : personName(p.savedBy)) + '</b></span>' : '') +
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

  /* ============================================================ identity = */

  function directoryName(email) {
    var e = String(email || '').trim().toLowerCase();
    if (!e) return '';
    var d = D.DPMS.find(function (x) { return String(x.email).toLowerCase() === e; });
    return d ? d.name : '';
  }

  /* Who is using the app: what they set in Settings, else the OneDrive work
     account the launcher reports (named from the DPM Directory when listed). */
  /* The OneDrive work account that owns the data folder when several are
     signed in (it is the one whose files hold it), else the first. */
  function pickAccount(accounts) {
    var list = (accounts || []).filter(function (a) { return a && a.email; });
    var root = String(DB.status().dataRoot || '').toLowerCase();
    var owner = list.find(function (a) {
      var f = String(a.folder || '').toLowerCase().replace(/[\\/]+$/, '');
      return f && root.indexOf(f + '\\') === 0;
    });
    return owner || list[0] || null;
  }

  function resolveIdentity() {
    var name = String(S.settings.userName || '').trim();
    var email = String(S.settings.userEmail || '').trim();
    /* Whatever was typed in Settings wins, field by field; the OneDrive
       account fills in the rest - a name typed alone keeps the email. */
    var need = !(name && email);
    return (need ? DB.whoami() : Promise.resolve(null)).then(function (w) {
      var acct = w ? pickAccount(w.accounts || (w.email ? [w] : [])) : null;
      var em = email || (acct ? acct.email : '');
      var nm = name || directoryName(em) || D.nameFromEmail(em);
      S.me = (nm || em)
        ? { name: nm, email: em, source: (name || email) ? 'settings' : 'onedrive', account: acct ? acct.email : '' }
        : { name: '', email: '', source: '', account: '' };
      DB.setIdentity(S.me.email);
      return S.me;
    });
  }

  /** The "created by" / "changed by" stamp, or null when nobody is known. */
  function meStamp() {
    return (S.me.name || S.me.email) ? { name: S.me.name, email: S.me.email } : null;
  }

  function isMe(p) {
    return !!(p && p.email && S.me.email && String(p.email).toLowerCase() === String(S.me.email).toLowerCase());
  }

  function personName(p) { return p ? (p.name || p.email || '') : ''; }

  /* Asked once, the first time someone calculates without the launcher
     having recognised them. Skipping is allowed - estimates then simply show
     no creator. */
  function ensureIdentity() {
    if (S.me.name || S.me.email || S.settings.identityAsked) return Promise.resolve();
    S.settings.identityAsked = true;
    DB.setSetting('identityAsked', true);
    return askIdentity();
  }

  function askIdentity() {
    var promise = U.dialog({
      title: 'Who is creating this estimate?',
      confirmLabel: 'Save',
      cancelLabel: 'Skip',
      submitOnEnter: true,
      bodyHtml:
        '<p>Your name is stamped on every estimate you create as <b>Created by</b>, so the team can see whose ' +
        'estimate is whose in the shared SharePoint folder. You are only asked once; change it any time in Settings.</p>' +
        '<label class="dlg-label mt-3" for="me-name">Your name</label>' +
        '<input id="me-name" class="dlg-input" type="text" list="me-dpm-names" autocomplete="off" placeholder="Start typing — pick yourself from the DPM Directory">' +
        '<datalist id="me-dpm-names">' + D.DPMS.map(function (d) { return '<option value="' + esc(d.name) + '">'; }).join('') + '</datalist>' +
        '<label class="dlg-label mt-3" for="me-email">Your email</label>' +
        '<input id="me-email" class="dlg-input" type="email" autocomplete="off" placeholder="name@orange.com">' +
        '<p class="dlg-error" hidden></p>',
      collect: function (root) {
        var name = (qs('#me-name', root).value || '').trim();
        var email = (qs('#me-email', root).value || '').trim();
        var errBox = qs('.dlg-error', root);
        if (!name && !email) { errBox.textContent = 'Enter your name, or choose Skip.'; errBox.hidden = false; return false; }
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          errBox.textContent = 'That does not look like an email address.'; errBox.hidden = false; return false;
        }
        return { name: name, email: email };
      }
    });
    var nameEl = el('me-name');
    if (nameEl) {
      nameEl.focus();
      nameEl.addEventListener('input', function () {
        var d = D.DPMS.find(function (x) { return x.name === nameEl.value; });
        if (d && el('me-email')) el('me-email').value = d.email;
      });
    }
    return promise.then(function (res) {
      if (!res || res === true) return;
      return saveIdentity(res.name, res.email);
    });
  }

  function saveIdentity(name, email) {
    S.pendingMe = null;
    S.settings.userName = name;
    S.settings.userEmail = email;
    return Promise.all([DB.setSetting('userName', name), DB.setSetting('userEmail', email)])
      .then(resolveIdentity)
      .then(function () { renderIdentity(); renderRecords(); });
  }

  function renderIdentity() {
    if (!el('set-user-name')) return;
    el('set-user-dpms').innerHTML = D.DPMS.map(function (d) { return '<option value="' + esc(d.name) + '">'; }).join('');
    /* Unsaved typing survives any re-render; otherwise show what is saved. */
    var pending = S.pendingMe;
    setVal('set-user-name', pending ? pending.name : (S.settings.userName || ''));
    setVal('set-user-email', pending ? pending.email : (S.settings.userEmail || ''));
    el('set-user-name').placeholder = S.me.name || 'Your name';
    el('set-user-email').placeholder = S.me.email || 'name@orange.com';
    var who = '<b>' + esc(S.me.name || S.me.email) + '</b>' + (S.me.email && S.me.name ? ' (' + esc(S.me.email) + ')' : '');
    el('set-user-note').innerHTML = !(S.me.name || S.me.email)
      ? 'Not set yet — your estimates will show no creator until you add your name.'
      : (S.me.source === 'onedrive'
          ? '✓ Recognised from your OneDrive work account: ' + who + '. Leave these blank to keep using it.'
          : 'Estimates you create are stamped <b>Created by</b> ' + who +
            (S.me.account && !S.settings.userEmail ? ' — the email comes from your OneDrive work account.' : '.'));
  }

  function saveIdentityFromSettings() {
    var name = (val('set-user-name') || '').trim();
    var email = (val('set-user-email') || '').trim();
    U.clearFieldErrors();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      U.showFieldError('set-user-email', 'That does not look like an email address.');
      return;
    }
    saveIdentity(name, email).then(function () {
      U.toast(S.me.name || S.me.email ? 'Estimates will be stamped “Created by ' + (S.me.name || S.me.email) + '”.' : 'Name cleared.', 'ok');
    });
  }

  /* ========================================================= team folder = */

  function samePath(a, b) {
    function n(p) { return String(p || '').replace(/[\\/]+$/, '').toLowerCase(); }
    return !!a && !!b && n(a) === n(b);
  }

  /* Is the current data location the SharePoint team folder? Worked out
     from where the app saves right now - never from a remembered flag, which
     would go stale the moment the folder is changed.
       'verified' - OneDrive lists this folder as the shared SharePoint one
       'named'    - a folder with the right name that could not be verified
                    (a private copy would look the same), or any folder named
                    so in the browser, where it cannot be checked
       ''         - not the team folder */
  function teamFolderState() {
    var st = DB.status();
    var tf = TF.name.toLowerCase();
    if (st.mode === 'host') {
      var hit = (S.teamFolder.candidates || []).filter(function (c) { return samePath(c.path, st.dataRoot); })[0];
      if (hit) return hit.how === 'sharepoint' ? 'verified' : 'named';
      var leaf = String(st.dataRoot || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop().toLowerCase();
      return (!st.isDefaultRoot && leaf === tf) ? 'named' : '';
    }
    if (st.mode === 'folder') return String(st.folderName || '').toLowerCase() === tf ? 'named' : '';
    return '';
  }

  function onTeamFolder() { return !!teamFolderState(); }

  function checkTeamFolder() {
    if (DB.status().mode !== 'host') return Promise.resolve(S.teamFolder);
    return DB.findTeamFolder(TF.name, D.teamFolderWebPath()).then(function (res) {
      S.teamFolder = { checked: true, candidates: (res && res.candidates) || [], linked: !!(res && res.linked), error: null };
      return S.teamFolder;
    }).catch(function (err) {
      S.teamFolder = { checked: true, candidates: [], linked: false, error: (err && err.message) || String(err) };
      return S.teamFolder;
    });
  }

  /* The synced copy OneDrive maps to the folder's SharePoint address - the
     only kind linked without asking. */
  function verifiedTeamCandidate() {
    return (S.teamFolder.candidates || []).filter(function (x) { return x.how === 'sharepoint'; })[0] || null;
  }

  /* For the Settings card: the verified one, else a single same-named folder
     (offered with a warning, never linked automatically). */
  function bestTeamCandidate() {
    var c = S.teamFolder.candidates || [];
    return verifiedTeamCandidate() || (c.length === 1 ? c[0] : null);
  }

  /* On start with the launcher: link the synced team folder automatically -
     only when OneDrive confirms it is the shared SharePoint folder, and only
     when this person has not chosen otherwise: not after "Use my own folder
     instead" (localOnly), not while another folder is in use, and not when a
     folder they chose is merely missing this session (missingRoot). */
  var autoLinking = null;
  function autoLinkTeamFolder() {
    if (DB.status().mode !== 'host') return Promise.resolve();
    if (autoLinking) return autoLinking;   // focus events can arrive while a check is running
    autoLinking = checkTeamFolder().then(function () {
      var st = DB.status();
      teamCopyArmed = true;
      if (onTeamFolder()) { renderStorageStatus(); resumeTeamCopy(); return; }
      if (!st.isDefaultRoot || st.localOnly || st.missingRoot) { renderStorageStatus(); return; }
      var best = verifiedTeamCandidate();
      if (!best) { renderStorageStatus(); return; }
      return linkTeamFolder(best.path);
    }).then(function () { autoLinking = null; }, function () { autoLinking = null; });
    return autoLinking;
  }

  /* This person's own earlier estimates and projects, copied into the team
     folder - chosen here in the browser by who created them, so a colleague's
     estimate sitting in the old folder is never published. The request is
     remembered (TEAM_COPY_KEY) until a copy runs while saving is allowed, so a
     link made while the folder refused writes still brings them along later. */
  var TEAM_COPY_KEY = 'dpm_team_copy_pending';
  var teamCopying = null;
  var teamCopyArmed = false;   // set once start-up knows who is using the app

  function copyMineToTeam() {
    if (teamCopying) return teamCopying;
    teamCopying = Promise.all([
      DB.publishLocal(S.me.email).catch(function () { return 0; }),
      DB.publishLocalProjects(S.me.email)
    ]).then(function (n) {
      teamCopying = null;
      if (!DB.status().updateRequired) lsSet(TEAM_COPY_KEY, '');
      return n;
    }, function (err) { teamCopying = null; throw err; });
    return teamCopying;
  }

  function resumeTeamCopy() {
    var st = DB.status();
    if (!teamCopyArmed || teamCopying || st.mode !== 'host' || st.updateRequired ||
        !lsGet(TEAM_COPY_KEY) || !onTeamFolder()) return;
    copyMineToTeam().then(function (n) {
      if (n[0] || n[1]) {
        return afterDataRootChange(n[0] + ' of your earlier estimate(s) and ' + n[1] + ' project(s) copied into the team folder “' + TF.name + '”.');
      }
    }).catch(function () { /* tried again at the next start */ });
  }

  /* Switch to the team folder, then bring along this person's own estimates
     and projects. */
  function linkTeamFolder(path) {
    return DB.setHostDataRoot(path, false).then(function (out) {
      S.pendingRoot = null;
      /* A folder that needs a newer app refuses every write: say so instead
         of reporting "0 copied". The copy is remembered and made as soon as
         saving there works (resumeTeamCopy). */
      lsSet(TEAM_COPY_KEY, '1');
      var blocked = DB.status().updateRequired;
      if (blocked) {
        return afterDataRootChange('Linked to the SharePoint team folder “' + TF.name + '”, but nothing can be saved there yet: ' +
          blocked + ' Your earlier estimates will be copied in once it can.', 'warn');
      }
      return copyMineToTeam().then(function (n) {
        return afterDataRootChange('Linked to the SharePoint team folder “' + TF.name + '”. Every estimate is now saved there and ' +
          'uploaded by OneDrive' + (n[0] || n[1]
            ? ' — ' + n[0] + ' of your earlier estimate(s) and ' + n[1] + ' project(s) copied in.' : '.'));
        /* The copied estimates' workbooks follow through DB.onRecordsChanged. */
      });
    }).catch(function (err) {
      renderStorageStatus();
      U.toast('Could not link the team folder: ' + (err && err.message ? err.message : err), 'err');
    });
  }

  function lookForTeamFolder() {
    checkTeamFolder().then(function () {
      var best = verifiedTeamCandidate();   // a merely same-named folder is offered in Settings, not linked
      if (teamFolderState() === 'verified') { U.toast('Already linked to the team folder.', 'ok'); renderSettingsPage(); return; }
      if (best) return linkTeamFolder(best.path);
      renderSettingsPage();
      U.toast(S.teamFolder.candidates.length
        ? 'Found a folder named “' + TF.name + '”, but OneDrive does not list it as the shared SharePoint folder — see Settings.'
        : '“' + TF.name + '” is not synced on this PC yet. Open it on SharePoint and choose “Add shortcut to My files”.', 'warn');
    });
  }

  function teamFolderLink(label) {
    return '<a href="' + esc(TF.url) + '" target="_blank" rel="noopener noreferrer">' + esc(label || ('Open “' + TF.name + '” on SharePoint')) + ' ↗</a>';
  }

  function teamFolderSteps(finalStep) {
    return '<ol class="steps-plain">' +
      '<li>' + teamFolderLink() + '. It opens for people ' + esc(TF.owner) + ' has shared the folder with (with edit rights).</li>' +
      '<li>In SharePoint, choose <b>Add shortcut to My files</b> in the bar at the top. OneDrive then syncs the folder to this PC within a minute or so.</li>' +
      '<li>' + finalStep + '</li>' +
      '</ol>';
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

    renderTeamFolderSettings();
    renderIdentity();

    if (st.mode === 'host') {
      var team = onTeamFolder();
      rows.push('<div class="callout"><span class="callout-ic">✓</span><span>' +
        '<b>Saving to disk through the local app host.</b> Every calculation is written as a JSON file into ' +
        '<span class="code">' + esc(st.dataRoot || 'data') + '</span>' +
        (team
          ? ' — the SharePoint team folder. OneDrive uploads each file to SharePoint automatically.'
          : (st.isDefaultRoot
              ? ' — the app\'s own data folder on this PC, which only you use.'
              : ' — a folder you chose. Everyone pointed at it sees the same estimates and the same team plan.')) +
        '</span></div>');
      /* The path being typed survives the re-renders a status change causes. */
      var rootValue = S.pendingRoot !== null ? S.pendingRoot : ((st.isDefaultRoot || team) ? '' : (st.dataRoot || ''));
      if (st.missingRoot) {
        rows.push('<div class="callout warn"><span class="callout-ic">⚠</span><span>The folder you chose, ' +
          '<span class="code">' + esc(st.missingRoot) + '</span>, was not available when the app started, so estimates go to ' +
          'the app\'s own folder for now. Your choice is kept — restart the app once that folder is back.</span></div>');
      }
      rows.push('<details class="fold" id="set-other-folder"' + ((S.pendingRoot !== null || S.otherFolderOpen) ? ' open' : '') +
        '><summary>Use a different folder</summary>' +
        '<p class="card-note mt-2">Any folder works — for example a Teams channel library synced through OneDrive. ' +
        'Paste the folder\'s path as it appears in File Explorer.</p>' +
        '<div class="field mb-0"><label for="set-data-root" data-help="sharedFolder">Folder path</label>' +
        '<input type="text" id="set-data-root" autocomplete="off" spellcheck="false" value="' + esc(rootValue) + '" ' +
        'placeholder="e.g. C:\\Users\\you\\Orange\\DPM Team - Documents\\FTE Data"></div>' +
        '<div class="btn-row mt-2"><button class="btn btn-outline btn-sm" data-storage-act="use-root">Use this folder</button>' +
        (!st.isDefaultRoot && !team ? '<button class="btn btn-outline btn-sm" data-storage-act="publish">Copy my estimates here</button>' +
          '<button class="btn btn-ghost btn-sm" data-storage-act="reset-root">Back to my own data folder</button>' : '') +
        '</div></details>');
    } else if (st.mode === 'folder') {
      rows.push('<div class="callout"><span class="callout-ic">✓</span><span>' +
        '<b>Saving to the folder “' + esc(st.folderName) + '”.</b> Every calculation is written there as a JSON file, ' +
        'in a folder per project together with the project\'s Excel workbook; saved configurations go in ' +
        '<span class="code">projects/</span>. ' +
        'Your browser may ask you to confirm this folder again after you close and reopen it.</span></div>');
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

  /* The "SharePoint team folder" card: linked, found-but-not-linked, or the
     steps to get it synced - for whichever way the app was opened. */
  function renderTeamFolderSettings() {
    var host = el('settings-team');
    if (!host) return;
    var st = DB.status();
    var html;
    var openBtn = '<a class="btn btn-outline btn-sm" href="' + esc(TF.url) + '" target="_blank" rel="noopener noreferrer">Open on SharePoint ↗</a>';

    var state = teamFolderState();
    var linkedButtons = '<div class="btn-row">' + openBtn +
      '<button class="btn btn-outline btn-sm" data-storage-act="publish">Copy my estimates here</button>' +
      (st.mode === 'host' ? '<button class="btn btn-ghost btn-sm" data-storage-act="reset-root">Use my own folder instead</button>' : '') +
      '</div>';

    if (state === 'verified') {
      html = '<div class="callout"><span class="callout-ic">✓</span><span><b>Linked to “' + esc(TF.name) + '”.</b> ' +
        'Every estimate is saved in the team folder (<span class="code">' + esc(st.dataRoot) + '</span>) and OneDrive ' +
        'uploads it to SharePoint automatically, stamped with who created it. Everyone who has the folder ' +
        'sees the same estimates and the same Team capacity plan.</span></div>' + linkedButtons;
    } else if (state === 'named' && st.mode === 'host') {
      html = '<div class="callout warn"><span class="callout-ic">⚠</span><span>Saving to a folder named “' + esc(TF.name) +
        '” (<span class="code">' + esc(st.dataRoot) + '</span>), but OneDrive does not list it as the shared SharePoint folder. ' +
        'If it is a private copy, the team will not see your estimates. To be sure, open the link below, choose ' +
        '<b>Add shortcut to My files</b>, then press <b>Look again</b>.</span></div>' +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-storage-act="look-team">Look again</button>' +
        linkedButtons.replace('<div class="btn-row">', '');
    } else if (state === 'named') {
      html = '<div class="callout"><span class="callout-ic">✓</span><span><b>Connected to “' + esc(TF.name) + '”.</b> ' +
        'Every estimate is saved there. The browser cannot check which folder this is, so make sure it is the ' +
        '<b>shortcut</b> to the shared SharePoint folder (added with <b>Add shortcut to My files</b>), not a copy — ' +
        'then OneDrive uploads each estimate to SharePoint automatically.</span></div>' + linkedButtons;
    } else if (st.mode === 'host') {
      var best = bestTeamCandidate();
      var cands = S.teamFolder.candidates || [];
      if (best && best.how === 'sharepoint') {
        html = '<div class="callout"><span class="callout-ic">📁</span><span><b>The team folder is synced on this PC</b> at ' +
          '<span class="code">' + esc(best.path) + '</span>' + (best.records ? ' (' + best.records + ' estimate(s) in it)' : '') + '. ' +
          (st.localOnly ? 'You chose your own folder earlier, so it was not linked automatically.'
            : (st.missingRoot ? 'It was not linked automatically because the folder you chose is missing this session.'
              : 'Link it and every estimate is saved there.')) +
          '</span></div><div class="btn-row">' +
          '<button class="btn btn-primary btn-sm" data-storage-act="link-team" data-path="' + esc(best.path) + '">Link the team folder</button>' +
          openBtn + '</div>';
      } else if (cands.length) {
        html = '<div class="callout warn"><span class="callout-ic">⚠</span><span>' +
          (cands.length > 1 ? 'Folders' : 'A folder') + ' named “' + esc(TF.name) + '” ' + (cands.length > 1 ? 'exist' : 'exists') +
          ' on this PC, but OneDrive does not list ' + (cands.length > 1 ? 'any of them' : 'it') + ' as the shared SharePoint ' +
          'folder — ' + (cands.length > 1 ? 'they' : 'it') + ' may be a private copy. The safest way is to add the shortcut:</span></div>' +
          teamFolderSteps('Press <b>Look again</b> — the app links it by itself.') +
          '<div class="btn-row"><button class="btn btn-primary btn-sm" data-storage-act="look-team">Look again</button>' + openBtn + '</div>' +
          '<div class="summary-list mt-2">' + cands.map(function (c) {
            return '<div><button class="btn btn-ghost btn-sm" data-storage-act="link-team" data-path="' + esc(c.path) + '">Link anyway</button> ' +
              '<span class="code">' + esc(c.path) + '</span> · ' + c.records + ' estimate(s)</div>';
          }).join('') + '</div>';
      } else {
        html = '<div class="callout warn"><span class="callout-ic">⚠</span><span><b>“' + esc(TF.name) + '” is not synced on this PC yet.</b> ' +
          'Until it is, estimates are saved in the app\'s own folder on this PC only.</span></div>' +
          teamFolderSteps('Come back and press <b>Look again</b> — or simply restart the app: it links the folder by itself.') +
          '<div class="btn-row"><button class="btn btn-primary btn-sm" data-storage-act="look-team">Look again</button>' + openBtn + '</div>' +
          (S.teamFolder.error ? '<p class="field-help mt-2">Last check failed: ' + esc(S.teamFolder.error) + '</p>' : '');
      }
    } else if (st.mode === 'folder') {
      html = '<div class="callout warn"><span class="callout-ic">⚠</span><span>Connected to “' + esc(st.folderName) +
        '”, not the team folder “' + esc(TF.name) + '”.</span></div>' +
        teamFolderSteps('Press <b>Connect the team folder</b> and pick “' + esc(TF.name) + '” inside your OneDrive folder (“OneDrive - orange.com”).') +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-storage-act="change">Connect the team folder</button>' + openBtn + '</div>';
    } else if (st.canReachHost) {
      html = '<div class="callout warn"><span class="callout-ic">⚠</span><span>The local app host is not responding, so the team ' +
        'folder cannot be reached right now. Estimates are kept in this browser and written there once it is back.</span></div>';
    } else if (st.folderNeedsReconnect) {
      var wasTeam = String(st.folderName || '').toLowerCase() === TF.name.toLowerCase();
      html = '<div class="callout warn"><span class="callout-ic">⚠</span><span><b>“' + esc(st.folderName) + '” needs reconnecting.</b> ' +
        'Browsers drop folder permission when the tab is closed; one click grants it again, and anything saved meanwhile is ' +
        'written out straight away.</span></div><div class="btn-row">' +
        '<button class="btn btn-primary btn-sm" data-storage-act="reconnect">Reconnect ' + (wasTeam ? 'the team folder' : 'folder') + '</button>' +
        (wasTeam ? '' : '<button class="btn btn-outline btn-sm" data-storage-act="connect">Connect the team folder instead</button>') +
        openBtn + '</div>';
    } else if (st.folderSupported) {
      html = '<div class="callout"><span class="callout-ic">📁</span><span>Save straight into the team\'s SharePoint folder, “' +
        esc(TF.name) + '”. OneDrive uploads each estimate automatically.</span></div>' +
        teamFolderSteps('Press <b>Connect the team folder</b> and pick “' + esc(TF.name) + '” inside your OneDrive folder (“OneDrive - orange.com”).') +
        '<div class="btn-row"><button class="btn btn-primary btn-sm" data-storage-act="connect">Connect the team folder</button>' + openBtn + '</div>';
    } else {
      html = '<div class="callout warn"><span class="callout-ic">⚠</span><span>This browser cannot save into a folder. To save into the ' +
        'team\'s SharePoint folder “' + esc(TF.name) + '”, open the app in Chrome or Edge, or start it with ' +
        '<span class="code">Start FTE Calculator.cmd</span>.</span></div><div class="btn-row">' + openBtn + '</div>';
    }
    host.innerHTML = html;
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
      return DB.setHostDataRoot(path, false).then(function (out) {
        S.pendingRoot = null;
        /* Copied from here rather than by the host, so the choice is made by
           who created each estimate: a colleague's estimate sitting in the
           old folder is never published into the new one. */
        var extra = choice.copy
          ? Promise.all([DB.publishLocal(S.me.email).catch(function () { return 0; }), DB.publishLocalProjects(S.me.email)])
          : Promise.resolve([0, 0]);
        return extra.then(function (n) {
          var msg = 'Now saving to ' + out.dataRoot;
          if (choice.copy) msg += ' — copied ' + n[0] + ' estimate(s) and ' + n[1] + ' project(s)';
          return afterDataRootChange(msg + '.');
        });
      });
    }).catch(function (err) {
      renderStorageStatus();
      U.toast(err && err.message ? err.message : 'Could not switch to that folder.', 'err');
    });
  }

  function resetDataRoot() {
    var leavingTeam = onTeamFolder();
    U.confirm('Use your own data folder?',
      'New calculations will be saved only in the app\'s own data folder on this PC' +
      (leavingTeam ? ', not in SharePoint — the team will not see them' : '') + '. The shared folder is left exactly as it is, ' +
      'and colleagues keep using it.' +
      (leavingTeam ? ' The app will not link the team folder again by itself; use “Link the team folder” in Settings to go back.' : ''),
      { confirmLabel: 'Use my own folder' }).then(function (yes) {
      if (!yes) return;
      /* localOnly: a deliberate choice, so the automatic team-folder link on
         the next start must not undo it. */
      return DB.setHostDataRoot(null, false, { localOnly: true }).then(function (out) {
        S.pendingRoot = null;
        lsSet(TEAM_COPY_KEY, '');
        return afterDataRootChange('Now saving to ' + out.dataRoot + ' only.');
      });
    }).catch(function (err) {
      U.toast(err && err.message ? err.message : 'Could not switch back.', 'err');
    });
  }

  /* After the host changes folder: read what is there, push anything still
     waiting, and refresh every view that shows records or projects. */
  function afterDataRootChange(message, level) {
    return checkTeamFolder()
      .then(function () { return DB.pullFromDisk(); })
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
    DB.publishLocal(S.me.email).then(function (n) {
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

  function handleStorageAction(action, button) {
    if (action === 'link-team') { linkTeamFolder(button && button.dataset.path); return; }
    if (action === 'look-team') { lookForTeamFolder(); return; }
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
        var isTeam = String(res.name || '').toLowerCase() === TF.name.toLowerCase();
        if (isTeam) {
          U.toast('Connected to the SharePoint team folder “' + res.name + '”' + (bits.length ? ' — ' + bits.join(', ') : '') +
                  '. OneDrive uploads every estimate automatically.', 'ok');
        } else {
          U.toast('Connected to “' + res.name + '”' + (bits.length ? ' — ' + bits.join(', ') : '') +
                  '. Note: the team\'s SharePoint folder is “' + TF.name + '”.', 'warn');
        }
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

  /* ============================================================ updates == */

  /* The panel at the top of the Dashboard: what this version added, whether
     a newer one exists, and the button that installs it (launcher), reloads
     the page (website) or points to the new file (single-file copy). */
  var UP = global.FTEUpdates;
  S.update = { state: 'idle', latest: '', releases: [], action: '', error: '', checkedAt: null, installing: false };

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private window */ } }

  function currentRelease() {
    return (D.RELEASES.releases || []).filter(function (r) { return r.version === D.APP_VERSION; })[0] ||
           { version: D.APP_VERSION, title: '', features: [] };
  }

  /* manual: the person asked (toasts the answer). force: ask GitHub now
     rather than take the launcher's remembered answer. */
  function checkForUpdates(manual, force) {
    if (S.update.state === 'checking' || S.update.installing) return Promise.resolve();
    var st = DB.status();
    var check;
    if (st.mode === 'host') {
      /* The launcher checks GitHub and remembers the answer; when it last
         asked is its time, not this page's. */
      check = (manual || force ? DB.updateCheck() : DB.updateStatus()).then(function (i) {
        return { latest: i.latest, available: !!i.available, releases: i.releases || [], error: i.error || '',
                 action: i.installMode === 'git' ? 'git' : 'install', checkedAt: i.checkedAt };
      });
    } else if (location.protocol === 'file:') {
      check = UP.checkGitHub(D.APP_VERSION);
    } else if (st.canReachHost) {
      check = Promise.reject(new Error('the launcher (Start FTE Calculator.cmd) is not running'));
    } else {
      check = UP.checkWebsite(D.APP_VERSION);
    }
    S.update.state = 'checking';
    renderUpdates();
    var when = null;
    return check.then(function (r) {
      if (r.checkedAt && !isNaN(new Date(r.checkedAt).getTime())) when = new Date(r.checkedAt);
      S.update.latest = r.latest || '';
      S.update.releases = r.releases || [];
      S.update.action = r.action;
      S.update.error = r.error || '';
      S.update.state = r.error ? 'error' : (r.available ? 'available' : 'current');
      if (manual && !r.error) {
        U.toast(r.available ? 'Version ' + r.latest + ' is available — see the Dashboard.' : 'You have the latest version (' + D.APP_VERSION + ').',
                r.available ? 'info' : 'ok');
      }
    }, function (err) {
      S.update.state = 'error';
      S.update.error = 'Could not check for updates: ' + errorText(err) + '.';
      if (manual) U.toast(S.update.error, 'warn');
    }).then(function () {
      S.update.checkedAt = when || new Date();
      renderUpdates();
    });
  }

  /* Reload with fresh copies of the app's files. A plain reload may take
     scripts from the browser's cache and come back as the old version. */
  function hardReload() {
    var urls = [global.location.href.split('#')[0]];
    Array.prototype.forEach.call(document.querySelectorAll('script[src], link[rel="stylesheet"][href]'), function (n) {
      var u = n.src || n.href;
      if (u && u.indexOf(global.location.origin) === 0) urls.push(u);
    });
    var refresh = Promise.all(urls.map(function (u) {
      return fetch(u, { cache: 'reload' }).catch(function () { /* reload anyway */ });
    }));
    var cap = new Promise(function (r) { setTimeout(r, 8000); });
    Promise.race([refresh, cap]).then(function () { global.location.reload(); });
  }

  function installUpdate() {
    var u = S.update;
    if (u.installing) return;
    if (u.action === 'reload') { u.installing = 'reload'; renderUpdates(); hardReload(); return; }
    if (u.action === 'download') { global.open(UP.WEBSITE, '_blank', 'noopener'); return; }
    var news = (u.releases || []).map(function (r) {
      return '<b>' + esc(r.version) + '</b> — ' + esc(r.title || '');
    }).join('<br>');
    U.dialog({
      title: 'Install version ' + u.latest + '?',
      confirmLabel: 'Update now',
      bodyHtml:
        (news ? '<p>' + news + '</p>' : '') +
        (u.action === 'git'
          ? '<p>This copy is a git working folder, so it is updated with <span class="code">git pull</span> — only if it has no local changes. ' +
            'The version you have now stays in git\'s history.</p>' +
            '<p>Your estimates, settings, DPM directory and data folder are not touched.</p>'
          : '<p>The app downloads the update from GitHub, installs it and restarts, which takes a few seconds.</p>' +
            '<p>Your estimates, settings, DPM directory and data folder are not touched. The version you have now is kept in the ' +
            '<span class="code">backup</span> folder next to the app.</p>')
    }).then(function (yes) {
      if (yes !== true || S.update.installing) return;
      S.update.installing = true;
      renderUpdates();
      return DB.updateInstall().then(function (res) {
        if (!res || !res.to || D.compareVersions(res.to, D.APP_VERSION) <= 0) {
          throw new Error('The update did not install a newer version' + (res && res.to ? ' (still ' + res.to + ')' : '') + '.');
        }
        U.toast('Version ' + res.to + ' installed — restarting…', 'info');
        return DB.waitForHostVersion(res.to, 90000).then(function (back) {
          if (back) {
            lsSet('dpm_updated_to', res.to);
            hardReload();
            return;
          }
          S.update.installing = false;
          S.update.state = 'error';
          S.update.error = 'Version ' + res.to + ' was installed, but the app did not restart by itself. ' +
                           'Close its window and start it again with Start FTE Calculator.cmd.';
          renderUpdates();
        });
      }).catch(function (err) {
        S.update.installing = false;
        renderUpdates();
        U.toast(errorText(err), 'err');
      });
    });
  }

  function releaseBlock(r, heading) {
    return '<div class="release-block"><h4>' + esc(heading || ('Version ' + r.version)) +
      (r.title ? ' — ' + esc(r.title) : '') + (r.date ? ' <span class="release-date">' + esc(fmt.date(r.date)) + '</span>' : '') +
      '</h4><ul class="updates-list">' + (r.features || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') +
      '</ul></div>';
  }

  function showAllReleases() {
    U.dialog({
      title: 'All updates',
      confirmLabel: 'Close',
      hideCancel: true,
      bodyHtml: (D.RELEASES.releases || []).map(function (r) { return releaseBlock(r); }).join('')
    });
    var box = qs('.dlg');
    if (box) box.classList.add('wide');
  }

  function renderUpdates() {
    var host = el('dash-updates');
    var chip = el('update-chip');
    if (!host) return;
    var st = DB.status(), u = S.update, cur = currentRelease();
    var required = st.updateRequired, fix = st.updateFix;
    var busy = u.installing ? ' disabled' : '';

    /* The folder may need a version that has not been published yet (someone
       ran a newer copy against it): updating cannot help, only waiting. */
    var unpublished = fix === 'update' && st.folderNeeds && (u.state === 'available' || u.state === 'current') &&
                      D.compareVersions(u.latest || D.APP_VERSION, st.folderNeeds) < 0;
    /* Only say so on a fresh answer: right after a release, a check from
       before it would claim the new version does not exist. */
    if (unpublished && !u.installing && (!u.checkedAt || Date.now() - u.checkedAt.getTime() > 60 * 1000)) {
      unpublished = false;
      setTimeout(function () { checkForUpdates(false, true); }, 0);
    }

    /* Top-bar chip, on every page. */
    if (chip) {
      var showChip = !!required || u.state === 'available';
      chip.classList.toggle('hidden', !showChip);
      chip.classList.toggle('required', !!required);
      el('update-chip-text').textContent = !required ? ('Version ' + u.latest + ' available')
        : fix === 'reload' ? 'Reload needed' : fix === 'restart' ? 'Restart needed' : fix === 'wait' ? 'Saving paused' : 'Update required';
    }

    var html = '<div class="card updates-card' + (required ? ' required' : (u.state === 'available' ? ' available' : '')) + '">';

    if (required) {
      var heading = { reload: 'Reload needed.', restart: 'Restart the launcher.', wait: 'Saving paused.' }[fix] || 'Update required.';
      var text = unpublished
        ? 'The data folder needs version ' + st.folderNeeds + ' or later of the app, which is not published yet (the newest is ' +
          (u.latest || D.APP_VERSION) + '). Nothing can be saved there until it is — ask whoever maintains the app to publish it.'
        : required;
      var button = '';
      if (fix === 'reload') button = '<button class="btn btn-primary btn-sm" data-upd="reload"' + busy + '>Reload the page</button>';
      else if (fix === 'update' && !unpublished) {
        button = st.mode === 'host'
          ? '<button class="btn btn-primary btn-sm" data-upd="check-install"' + busy + '>' + (u.installing ? 'Installing…' : 'Update now') + '</button>'
          : '<button class="btn btn-primary btn-sm" data-upd="reload"' + busy + '>Reload the page</button>';
      } else if (fix !== 'restart') {
        button = '<button class="btn btn-ghost btn-sm" data-upd="check"' + (u.state === 'checking' ? ' disabled' : busy) + '>Check again</button>';
      }
      html += '<div class="callout err"><span class="callout-ic">⚠</span><span><b>' + heading + '</b> ' +
        esc(text) + '</span></div>' + (button ? '<div class="btn-row mb-3">' + button + '</div>' : '');
    }

    if (u.state === 'available') {
      var how = {
        install: 'Installing takes a few seconds: the app restarts, and your estimates and settings are kept.',
        git: 'This copy is a git working folder: it is updated with git pull, only if it has no local changes.',
        reload: 'A newer version of the website has been published — reload the page to use it.',
        download: 'This single-file copy cannot update itself: use the website, or ask for the new file.'
      }[u.action] || '';
      var label = { install: 'Update now', git: 'Update now', reload: 'Reload to update', download: 'Open the website' }[u.action] || 'Update';
      html += '<div class="updates-head"><div>' +
          '<div class="updates-title">⬆ Update available — version ' + esc(u.latest) + '</div>' +
          '<div class="updates-sub">You have version ' + esc(D.APP_VERSION) + '. ' + esc(how) + '</div></div>' +
          '<div class="btn-row">' +
            '<button class="btn btn-primary btn-sm" data-upd="install"' + busy + '>' +
              (u.installing ? (u.installing === 'reload' ? 'Reloading…' : 'Installing…') : esc(label)) + '</button>' +
            '<button class="btn btn-ghost btn-sm" data-upd="check"' + (u.installing ? ' disabled' : '') + '>Check again</button>' +
          '</div></div>' +
        (u.releases || []).map(function (r) { return releaseBlock(r, 'New in ' + r.version); }).join('');
    } else {
      var seen = lsGet('dpm_seen_release') === D.APP_VERSION;
      html += '<div class="updates-head"><div>' +
          '<div class="updates-title">✨ What\'s new in version ' + esc(D.APP_VERSION) +
            (seen ? '' : ' <span class="tag tag-info">new</span>') + '</div>' +
          '<div class="updates-sub">' + esc(cur.title || '') + (cur.date ? ' · released ' + esc(fmt.date(cur.date)) : '') + '</div></div>' +
          '<div class="btn-row">' +
            '<button class="btn btn-outline btn-sm" data-upd="check"' + (u.state === 'checking' ? ' disabled' : busy) + '>' +
              (u.state === 'checking' ? 'Checking…' : '↻ Check for updates') + '</button>' +
          '</div></div>';
      if (!seen) {
        html += '<ul class="updates-list">' + (cur.features || []).map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
      }
    }

    var status;
    if (u.installing) status = u.installing === 'reload' ? 'Reloading with the latest files…' : 'Installing the update…';
    else if (u.state === 'checking') status = 'Checking for updates…';
    else if (u.state === 'current') status = '✓ You have the latest version.';
    else if (u.state === 'available') status = 'Version ' + D.APP_VERSION + ' installed · ' + u.latest + ' available.';
    else if (u.state === 'error') status = '⚠ ' + u.error;
    else status = 'Version ' + D.APP_VERSION + '.';
    if (u.checkedAt && u.state !== 'checking') {
      status += ' Last checked ' + u.checkedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + '.';
    }
    var seenNow = lsGet('dpm_seen_release') === D.APP_VERSION;
    html += '<div class="updates-status"><span>' + esc(status) + '</span><span class="grow"></span>' +
      (u.state !== 'available' && !seenNow ? '<button class="btn btn-ghost btn-sm" data-upd="seen">Got it</button>' : '') +
      (u.state !== 'available' && seenNow ? '<button class="btn btn-ghost btn-sm" data-upd="whatsnew">What\'s new</button>' : '') +
      '<button class="btn btn-ghost btn-sm" data-upd="history">All updates</button></div>';
    html += '</div>';
    host.innerHTML = html;
  }

  function handleUpdateAction(action) {
    if (S.update.installing && /^(check|install|reload|check-install)$/.test(action)) return;
    if (action === 'check') {
      /* A blocked save is re-tested too: the folder may have finished syncing. */
      var st = DB.status();
      var again = !st.updateRequired ? Promise.resolve()
        : st.mode === 'host' ? DB.probeServer() : DB.checkFolderVersion();
      again.then(function () { renderUpdates(); return checkForUpdates(true); });
      return;
    }
    if (action === 'install') { installUpdate(); return; }
    if (action === 'reload') { S.update.installing = 'reload'; renderUpdates(); hardReload(); return; }
    if (action === 'check-install') {
      checkForUpdates(true).then(function () { if (S.update.state === 'available') installUpdate(); });
      return;
    }
    if (action === 'seen') { lsSet('dpm_seen_release', D.APP_VERSION); renderUpdates(); return; }
    if (action === 'whatsnew') { lsSet('dpm_seen_release', ''); renderUpdates(); return; }
    if (action === 'history') showAllReleases();
  }

  /* Checked shortly after start, every 30 minutes, and when the window comes
     back after 10 minutes away. */
  function scheduleUpdateChecks() {
    setTimeout(function () { checkForUpdates(false); }, 1500);
    setInterval(function () { checkForUpdates(false); }, 30 * 60 * 1000);
    global.addEventListener('focus', function () {
      if (!S.update.checkedAt || Date.now() - S.update.checkedAt.getTime() > 10 * 60 * 1000) checkForUpdates(false);
    });
    var updatedTo = lsGet('dpm_updated_to');
    if (updatedTo) {
      lsSet('dpm_updated_to', '');
      if (updatedTo === D.APP_VERSION) {
        lsSet('dpm_seen_release', '');   // show what the update added
        U.toast('Updated to version ' + D.APP_VERSION + ' — see what\'s new on the Dashboard.', 'ok');
      }
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

      var updAct = e.target.closest('[data-upd]');
      if (updAct) { e.preventDefault(); handleUpdateAction(updAct.dataset.upd); return; }

      var storageAct = e.target.closest('[data-storage-act]');
      if (storageAct) { handleStorageAction(storageAct.dataset.storageAct, storageAct); return; }

      var cmpDel = e.target.closest('[data-cmpdel]');
      if (cmpDel) {
        e.preventDefault();
        var bd = cmpDel.closest('.dlg-backdrop');
        deleteSavedComparison(cmpDel.dataset.cmpdel).then(function () { if (bd) fillSavedList(bd, cmpDel.dataset.side); });
        return;
      }
      var cmpAct = e.target.closest('[data-cmp-act]');
      if (cmpAct) { handleCompareAction(cmpAct.dataset.cmpAct, cmpAct.dataset.side); return; }
      var scnAct = e.target.closest('[data-cmp-scn-act]');
      if (scnAct) { handleScenarioAction(scnAct.dataset.cmpScnAct, scnAct.dataset.side, scnAct.dataset.id); return; }
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
    el('w-calculate').addEventListener('click', function () { ensureIdentity().then(calculateWan); });
    el('w-export').addEventListener('click', function () {
      if (!S.wan.record) { U.toast('Run a WAN calculation first.', 'warn'); return; }
      syncActiveNotes('wan').then(function () { EX.exportRecord(S.wan.record); });
    });
    el('w-save-project').addEventListener('click', saveCurrentAsProject);
    el('w-add-compare').addEventListener('click', function () { ensureIdentity().then(function () { addToComparison('wan'); }); });
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
    el('l-calculate').addEventListener('click', function () { ensureIdentity().then(calculateLan); });
    el('l-export').addEventListener('click', function () {
      if (!S.lan.record) { U.toast('Run a LAN calculation first.', 'warn'); return; }
      syncActiveNotes('lan').then(function () { EX.exportRecord(S.lan.record); });
    });
    el('l-save-project').addEventListener('click', saveCurrentAsProject);
    el('l-add-compare').addEventListener('click', function () { ensureIdentity().then(function () { addToComparison('lan'); }); });
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

    /* Settings: remember half-typed values across re-renders. */
    document.addEventListener('input', function (e) {
      var id = e.target && e.target.id;
      if (id === 'set-data-root') S.pendingRoot = e.target.value;
      if (id === 'set-user-name' || id === 'set-user-email') {
        S.pendingMe = { name: val('set-user-name'), email: val('set-user-email') };
      }
    });
    document.addEventListener('toggle', function (e) {
      if (e.target && e.target.id === 'set-other-folder') S.otherFolderOpen = e.target.open;
    }, true);

    /* Records */
    ['rec-search', 'rec-owner', 'rec-type', 'rec-status', 'rec-sort'].forEach(function (id) {
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
    el('set-user-save').addEventListener('click', saveIdentityFromSettings);
    el('set-user-name').addEventListener('input', function () {
      var typed = this.value;
      var d = D.DPMS.find(function (x) { return x.name === typed; });
      if (d) setVal('set-user-email', d.email);
    });
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
    el('maint-workbooks').addEventListener('click', function () {
      if (DB.status().mode === 'browser') {
        U.toast('Workbooks are written into the data folder, which this page cannot reach right now.', 'warn');
        return;
      }
      U.toast('Rebuilding the Excel workbooks…', 'info');
      var moved = 0;
      /* Estimates an earlier version kept in records/ first move into their
         project folders, so each folder ends up with its JSON and its Excel. */
      DB.organiseLegacyRecords()
        .then(function (n) { moved = n; return rebuildWorkbooks({ silent: true }); })
        .then(function (t) {
          U.toast(t.written + ' workbook(s) rebuilt' +
            (t.removed ? ', ' + t.removed + ' left over from deleted estimates removed' : '') +
            (moved ? ', ' + moved + ' older estimate(s) moved into their project folders' : '') +
            (t.failed ? '; ' + t.failed + ' could not be written (' + t.lastError + ')' : '') + '.', t.failed ? 'warn' : 'ok');
          return DB.listRecords().then(function (rows) { S.records = rows; renderRecords(); });
        })
        .catch(function (err) { U.toast('Could not rebuild the workbooks: ' + (err && err.message ? err.message : err), 'err'); });
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
        var gone = S.records.slice();
        return gone.reduce(function (chain, r) {
          return chain.then(function () { return DB.deleteRecord(r.id); });
        }, Promise.resolve()).then(function () {
          /* Each affected workbook is rebuilt from what is really left on
             disk - removed when nothing is, kept if a colleague's estimate
             this browser never saw still belongs in it. */
          rebuildWorkbooks({ keys: gone.map(function (r) { return { projectName: r.projectName, createdBy: r.createdBy }; }) });
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
    bindAiEvents();
    aiInit();
    syncModeUi('wan');
    syncModeUi('lan');
    renderAssignedDpms('wan');
    renderAssignedDpms('lan');
    renderCompare('wan');
    renderCompare('lan');
    renderDpmDirectory();

    DB.onStatusChange(renderStorageStatus);
    DB.onStatusChange(function () { resumeTeamCopy(); });   // e.g. the folder's version file finished syncing
    DB.onRecordsChanged(onRecordsChanged);
    renderUpdates();

    DB.init()
      .then(function () { return DB.getSettings(); })
      .then(function (settings) {
        S.settings = Object.assign({}, D.DEFAULT_SETTINGS, settings);
        delete S.settings[COMPARISONS_KEY];   // saved comparisons live in the settings store but are not app settings
        setVal('w-add-complexity', S.settings.defaultComplexity);
        setVal('l-add-complexity', S.settings.defaultComplexity);
        updateMigrationHelp();
        return resolveIdentity();
      })
      /* With the launcher, link the synced SharePoint team folder by itself. */
      .then(function () { return autoLinkTeamFolder(); })
      .then(function () { return Promise.all([DB.listRecords(), DB.listProjects()]); })
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
        scheduleUpdateChecks();
      })
      .catch(function (err) {
        console.error(err);
        U.toast('Storage could not be opened: ' + err.message, 'err');
      });

    /* Re-check the host when the tab regains focus, so starting the launcher
       after the page is already open lights the connection up without a reload. */
    global.addEventListener('focus', function () {
      DB.probeServer().then(function (online) {
        if (!online) return;
        DB.flushPending().then(function (n) { if (n) renderStorageStatus(); });
        /* The launcher was started after the page was opened. */
        if (!S.teamFolder.checked) {
          resolveIdentity().then(autoLinkTeamFolder).then(function () {
            return DB.listRecords().then(function (rows) { S.records = rows; renderRecords(); renderDashboard(); });
          });
        }
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window);
