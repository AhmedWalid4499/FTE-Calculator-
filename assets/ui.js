/* ===========================================================================
   ui.js - shared interface primitives.

   Escaping, toasts, accessible dialogs, tooltips, number formatting, tables
   and charts. Everything that touches the DOM but knows nothing about DPM
   estimation lives here.
   =========================================================================== */
(function (global) {
  'use strict';

  var D = global.FTEData;

  /* ---------------------------------------------------------- escaping --- */

  /* Project names, DPM names and product labels all end up inside generated
     markup. The previous build interpolated them straight into onclick="..."
     attributes, so a single apostrophe in a project name broke the page. All
     interpolation now goes through here, and handlers bind via data-* instead
     of inline attributes. */
  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, function (c) { return ESCAPES[c]; });
  }

  /* ------------------------------------------------------------- query --- */

  function el(id) { return document.getElementById(id); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* --------------------------------------------------------- formatting -- */

  var fmt = {
    md: function (n) { return (Number(n) || 0).toFixed(3); },
    md1: function (n) { return (Number(n) || 0).toFixed(1); },
    fte: function (n) { return (Number(n) || 0).toFixed(2); },
    int: function (n) { return Math.round(Number(n) || 0).toLocaleString(); },
    num: function (n, dp) { return (Number(n) || 0).toFixed(dp === undefined ? 2 : dp); },
    pct: function (n) { return (Number(n) || 0).toFixed(1) + '%'; },
    dateTime: function (iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d)) return '—';
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    },
    date: function (iso) {
      if (!iso) return '—';
      var d = new Date(iso);
      if (isNaN(d)) return '—';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
    },
    months: function (n) {
      var v = Number(n) || 0;
      return (Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : v.toFixed(1)) + ' month' + (v === 1 ? '' : 's');
    }
  };

  /* ---------------------------------------------------------- tooltips --- */

  /* A focusable button rather than a bare span, so the explanation is
     reachable by keyboard and announced by screen readers. */
  function hint(key, inlineText) {
    var text = inlineText || (D.HELP[key] || '');
    if (!text) return '';
    return '<button type="button" class="hint" data-tip="' + esc(text) +
           '" aria-label="' + esc(text) + '">i</button>';
  }

  function label(text, helpKey) {
    return esc(text) + (helpKey ? ' ' + hint(helpKey) : '');
  }

  /* Badge used on every input that is stored but excluded from the maths. */
  function infoOnlyBadge() {
    return '<span class="tag tag-muted" title="This field is saved with the estimate and appears in exports, but it does not change the calculated effort.">recorded only</span>';
  }

  /* ------------------------------------------------------------ toasts --- */

  function toast(message, type) {
    var wrap = el('toast-wrap');
    if (!wrap) return;
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'ok');
    t.setAttribute('role', type === 'err' ? 'alert' : 'status');
    var icon = { ok: '✓', err: '✕', warn: '⚠', info: 'i' }[type || 'ok'];
    t.innerHTML = '<span class="toast-ic">' + esc(icon) + '</span><span>' + esc(message) + '</span>';
    wrap.appendChild(t);
    setTimeout(function () {
      t.classList.add('leaving');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, type === 'err' ? 6000 : 3600);
  }

  /* ----------------------------------------------------------- dialogs --- */

  var _openDialog = null;

  function focusables(root) {
    return qsa('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root);
  }

  /* One dialog implementation for confirm, prompt and custom content, with a
     focus trap and Escape-to-close. Replaces the native confirm()/prompt(),
     which are visually inconsistent and blocked in some embedded contexts. */
  function dialog(opts) {
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.className = 'dlg-backdrop';
      backdrop.innerHTML =
        '<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title">' +
          '<div class="dlg-head">' +
            '<h3 id="dlg-title">' + esc(opts.title || '') + '</h3>' +
            '<button type="button" class="icon-btn" data-act="cancel" aria-label="Close">✕</button>' +
          '</div>' +
          '<div class="dlg-body">' + (opts.bodyHtml || '<p>' + esc(opts.message || '') + '</p>') + '</div>' +
          '<div class="dlg-foot">' +
            (opts.hideCancel ? '' : '<button type="button" class="btn btn-ghost" data-act="cancel">' + esc(opts.cancelLabel || 'Cancel') + '</button>') +
            '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-act="confirm">' +
              esc(opts.confirmLabel || 'Confirm') + '</button>' +
          '</div>' +
        '</div>';

      var previouslyFocused = document.activeElement;

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        _openDialog = null;
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
        if (e.key === 'Enter' && opts.submitOnEnter !== false) {
          var tag = (e.target.tagName || '').toLowerCase();
          if (tag === 'input') { e.preventDefault(); confirmNow(); return; }
        }
        if (e.key !== 'Tab') return;
        var items = focusables(backdrop);
        if (!items.length) return;
        var first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }

      function confirmNow() {
        var value = true;
        if (opts.input) {
          var input = qs('.dlg-input', backdrop);
          value = input ? input.value.trim() : '';
          if (opts.required && !value) {
            var errBox = qs('.dlg-error', backdrop);
            if (errBox) { errBox.textContent = opts.requiredMessage || 'This field is required.'; errBox.hidden = false; }
            if (input) input.focus();
            return;
          }
        }
        /* Dialogs with their own fields must read them here, while the markup
           still exists - close() detaches it. Returning false keeps the dialog
           open so a validation message can be shown in place. */
        if (typeof opts.collect === 'function') {
          var collected = opts.collect(backdrop);
          if (collected === false) return;
          value = collected;
        }
        close(value);
      }

      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) { close(null); return; }
        var act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'cancel') close(null);
        if (act === 'confirm') confirmNow();
      });

      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(backdrop);
      _openDialog = backdrop;

      var focusTarget = qs('.dlg-input', backdrop) || qs('[data-act="confirm"]', backdrop);
      if (focusTarget) focusTarget.focus();
      if (focusTarget && focusTarget.select) focusTarget.select();
    });
  }

  function confirmDialog(title, message, opts) {
    return dialog(Object.assign({
      title: title, message: message, confirmLabel: 'Confirm', danger: false
    }, opts || {})).then(function (r) { return r === true; });
  }

  function promptDialog(title, labelText, defaultValue, opts) {
    var o = Object.assign({
      title: title,
      input: true,
      required: true,
      confirmLabel: 'Save',
      bodyHtml:
        '<label class="dlg-label" for="dlg-input-field">' + esc(labelText) + '</label>' +
        '<input id="dlg-input-field" class="dlg-input" type="text" value="' + esc(defaultValue || '') + '" autocomplete="off">' +
        '<p class="dlg-error" hidden></p>'
    }, opts || {});
    return dialog(o).then(function (r) { return (r === null || r === true) ? null : r; });
  }

  /* ------------------------------------------------------------ tables --- */

  /* Sort a table body in place. Values are read from data-sort so numeric
     columns sort numerically without parsing formatted text. */
  function makeSortable(table) {
    if (!table || table.dataset.sortableBound === '1') return;
    table.dataset.sortableBound = '1';
    var headers = qsa('thead th[data-sort-key]', table);
    headers.forEach(function (th, index) {
      th.classList.add('sortable');
      th.setAttribute('tabindex', '0');
      th.setAttribute('role', 'button');
      function activate() {
        var asc = th.dataset.dir !== 'asc';
        headers.forEach(function (h) { h.dataset.dir = ''; h.classList.remove('sorted-asc', 'sorted-desc'); });
        th.dataset.dir = asc ? 'asc' : 'desc';
        th.classList.add(asc ? 'sorted-asc' : 'sorted-desc');
        var tbody = qs('tbody', table);
        var rows = qsa('tr', tbody).filter(function (r) { return !r.dataset.noSort; });
        rows.sort(function (a, b) {
          var av = a.children[index] ? (a.children[index].dataset.sort || a.children[index].textContent) : '';
          var bv = b.children[index] ? (b.children[index].dataset.sort || b.children[index].textContent) : '';
          var an = parseFloat(av), bn = parseFloat(bv);
          var cmp = (isFinite(an) && isFinite(bn)) ? an - bn : String(av).localeCompare(String(bv));
          return asc ? cmp : -cmp;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      }
      th.addEventListener('click', activate);
      th.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
    });
  }

  function emptyRow(colspan, iconChar, title, detail) {
    return '<tr data-no-sort="1"><td colspan="' + colspan + '">' +
             '<div class="empty"><div class="empty-ic">' + esc(iconChar) + '</div>' +
             '<p class="empty-title">' + esc(title) + '</p>' +
             '<p class="empty-detail">' + esc(detail || '') + '</p></div>' +
           '</td></tr>';
  }

  /* ------------------------------------------------------------ charts --- */

  var _charts = {};

  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  var PALETTE_LIGHT = ['#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#dc2626',
                       '#059669', '#9333ea', '#ca8a04', '#0369a1', '#be185d', '#65a30d'];
  var PALETTE_DARK  = ['#60a5fa', '#4ade80', '#fbbf24', '#c084fc', '#22d3ee', '#f87171',
                       '#34d399', '#d8b4fe', '#fcd34d', '#7dd3fc', '#f9a8d4', '#a3e635'];

  function colour(i) {
    var p = isDark() ? PALETTE_DARK : PALETTE_LIGHT;
    return p[i % p.length];
  }

  function chartOptions(yLabel, opts) {
    var dark = isDark();
    var grid = dark ? 'rgba(255,255,255,.06)' : 'rgba(15,23,42,.07)';
    var tick = dark ? '#8b97ab' : '#64748b';
    return Object.assign({
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 260 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: dark ? '#1b2233' : '#ffffff',
          titleColor: dark ? '#f1f5f9' : '#0f172a',
          bodyColor: dark ? '#a9b4c6' : '#475569',
          borderColor: dark ? '#2b3549' : '#e2e8f0',
          borderWidth: 1, padding: 11, cornerRadius: 8, displayColors: false,
          titleFont: { weight: '600' }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: tick, font: { size: 11 } }, border: { display: false } },
        y: {
          beginAtZero: true,
          grid: { color: grid }, ticks: { color: tick, font: { size: 11 } },
          title: { display: !!yLabel, text: yLabel || '', color: tick, font: { size: 11 } },
          border: { display: false }
        }
      }
    }, opts || {});
  }

  function destroyChart(id) {
    if (_charts[id]) { _charts[id].destroy(); delete _charts[id]; }
  }

  /* Bars are coloured per category only when the categories are genuinely
     different things (products, tiers). A single series such as effort per
     month gets one colour - varying it there implies a distinction that does
     not exist. */
  function barColours(values, offset, uniform) {
    if (uniform) {
      var single = colour(offset || 0);
      return values.map(function () { return single; });
    }
    return values.map(function (_, i) { return colour(i + (offset || 0)); });
  }

  function barChart(canvasId, labels, values, yLabel, colourOffset, uniform) {
    if (typeof Chart === 'undefined') return null;
    var canvas = el(canvasId);
    if (!canvas) return null;
    destroyChart(canvasId);
    if (!labels || !labels.length) return null;
    var chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: values,
          backgroundColor: barColours(values, colourOffset, uniform),
          borderRadius: 6, borderSkipped: false, maxBarThickness: 64
        }]
      },
      options: chartOptions(yLabel)
    });
    /* Remembered so a theme switch can recolour without the caller. */
    chart.$fteStyle = { yLabel: yLabel, offset: colourOffset || 0, uniform: !!uniform };
    _charts[canvasId] = chart;
    return chart;
  }

  function redrawAllCharts() {
    Object.keys(_charts).forEach(function (id) {
      var c = _charts[id];
      if (!c) return;
      var style = c.$fteStyle || { yLabel: '', offset: 0, uniform: false };
      c.options = chartOptions(style.yLabel);
      c.data.datasets.forEach(function (ds) {
        ds.backgroundColor = barColours(ds.data, style.offset, style.uniform);
      });
      c.update('none');
    });
  }

  /* ------------------------------------------------------------- theme --- */

  function applyTheme(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    var icon = el('theme-icon'), text = el('theme-label');
    if (icon) icon.textContent = dark ? '☾' : '☀';
    if (text) text.textContent = dark ? 'Switch to light' : 'Switch to dark';
    if (typeof Chart !== 'undefined') {
      Chart.defaults.color = dark ? '#8b97ab' : '#64748b';
      Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    }
  }

  /* ------------------------------------------- inline field validation --- */

  function clearFieldErrors(scope) {
    qsa('.field-error', scope || document).forEach(function (n) { n.remove(); });
    qsa('.has-error', scope || document).forEach(function (n) { n.classList.remove('has-error'); });
  }

  /* Errors are shown against the control that caused them, not only as a
     toast that disappears before it can be acted on. */
  function showFieldError(fieldId, message) {
    var target = el(fieldId) || el(fieldId + '-anchor');
    if (!target) return false;
    var host = target.closest('.field') || target.parentNode;
    if (!host) return false;
    host.classList.add('has-error');
    var msg = document.createElement('p');
    msg.className = 'field-error';
    msg.setAttribute('role', 'alert');
    msg.textContent = message;
    host.appendChild(msg);
    return true;
  }

  function reportErrors(errors) {
    clearFieldErrors();
    var unplaced = [];
    (errors || []).forEach(function (e) {
      if (!showFieldError(e.field, e.message)) unplaced.push(e.message);
    });
    if (unplaced.length) toast(unplaced[0], 'err');
    var firstError = qs('.has-error');
    if (firstError) firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return (errors || []).length;
  }

  global.UI = {
    esc: esc, el: el, qs: qs, qsa: qsa, fmt: fmt,
    hint: hint, label: label, infoOnlyBadge: infoOnlyBadge,
    toast: toast, dialog: dialog, confirm: confirmDialog, prompt: promptDialog,
    makeSortable: makeSortable, emptyRow: emptyRow,
    colour: colour, chartOptions: chartOptions, barChart: barChart,
    destroyChart: destroyChart, redrawAllCharts: redrawAllCharts, isDark: isDark,
    applyTheme: applyTheme,
    clearFieldErrors: clearFieldErrors, showFieldError: showFieldError, reportErrors: reportErrors
  };
})(window);
