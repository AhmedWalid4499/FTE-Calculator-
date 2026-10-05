/* ===========================================================================
   ai.js - the AI assistant: upload-to-autofill, result opinions, and chat.

   All Claude calls go through the local launcher (POST /api/ai/message), which
   holds the shared Anthropic API key and attaches it server-side. The key is
   never in this file, never sent to the browser, and never in the public repo.
   The assistant therefore works only in host mode (the launcher running); the
   published website and the single-file build show it as unavailable.
   =========================================================================== */
(function (global) {
  'use strict';

  var D = global.FTEData;

  /* The launcher only ever runs on loopback. Everywhere else there is no key
     and no proxy, so the assistant is simply unavailable. */
  var IS_LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var CAN_REACH_HOST = (location.protocol === 'http:' || location.protocol === 'https:') && IS_LOOPBACK;

  /* Two ways to reach Claude:
       'proxy'  - the launcher holds the key and calls Anthropic for us
                  (loopback only; the key stays on the PC).
       'direct' - this browser holds the key (entered once, kept in
                  localStorage) and calls Anthropic itself. This is what makes
                  the assistant work on the published website, where there is
                  no launcher. The key is never in the app's code or repo.
     Direct calls need a real web origin (http/https), not a file:// build. */
  var SUPPORTED = (location.protocol === 'http:' || location.protocol === 'https:');
  var DEFAULT_MODEL = 'claude-opus-5-5';
  var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
  var LS_KEY = 'dpm_anthropic_key';
  var LS_WSID = 'dpm_anthropic_wsid';

  function lsGet(k) { try { return (localStorage.getItem(k) || '').trim(); } catch (e) { return ''; } }
  function lsSet(k, v) { try { if (v) { localStorage.setItem(k, v); } else { localStorage.removeItem(k); } } catch (e) { /* private window */ } }

  function getBrowserKey() { return lsGet(LS_KEY); }
  function getWorkspace() { return lsGet(LS_WSID); }
  function hasBrowserKey() { return !!getBrowserKey(); }
  function setBrowserKey(key, wsid) { lsSet(LS_KEY, (key || '').trim()); lsSet(LS_WSID, (wsid || '').trim()); _status.checked = false; }
  function clearBrowserKey() { lsSet(LS_KEY, ''); lsSet(LS_WSID, ''); _status.checked = false; }

  var _status = { checked: false, proxy: false, model: DEFAULT_MODEL };

  /* Which transport a call will use right now, or '' if not usable yet. */
  function mode() {
    if (_status.proxy) return 'proxy';
    if (SUPPORTED && hasBrowserKey()) return 'direct';
    return '';
  }

  function getStatus(force) {
    var finish = function () {
      var m = mode();
      return {
        available: !!m,              // a call can be made right now
        mode: m,
        canSetup: SUPPORTED,         // a pasted key could switch it on
        needsKey: SUPPORTED && !_status.proxy && !hasBrowserKey(),
        model: _status.model || DEFAULT_MODEL
      };
    };
    if (!CAN_REACH_HOST) { _status.proxy = false; _status.checked = true; return Promise.resolve(finish()); }
    if (_status.checked && !force) return Promise.resolve(finish());
    return fetch('/api/ai/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) { _status.proxy = !!(s && s.available); if (s && s.model) _status.model = s.model; _status.checked = true; return finish(); })
      .catch(function () { _status.proxy = false; _status.checked = true; return finish(); });
  }

  function handleResponse(res) {
    return res.json().catch(function () { return null; }).then(function (data) {
      if (!res.ok) {
        var msg = (data && data.error && (data.error.message || data.error)) || (data && data.error) || ('HTTP ' + res.status);
        var err = new Error(typeof msg === 'string' ? msg : 'The AI request failed.');
        err.status = res.status;
        throw err;
      }
      if (data && data.type === 'error') {
        var e2 = new Error((data.error && data.error.message) || 'The AI request failed.');
        e2.status = 400; throw e2;
      }
      return data;
    });
  }

  /* Low-level call. body is a full Messages-API request (model, max_tokens,
     messages, ...). Resolves with the Anthropic message; rejects with an Error
     carrying .status. */
  function rawMessage(body) {
    var m = mode();
    if (m === 'proxy') {
      return fetch('/api/ai/message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).then(handleResponse);
    }
    if (m === 'direct') {
      var headers = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'x-api-key': getBrowserKey()
      };
      var wsid = getWorkspace();
      if (wsid) headers['anthropic-workspace-id'] = wsid;
      return fetch(ANTHROPIC_URL, { method: 'POST', headers: headers, body: JSON.stringify(body) }).then(handleResponse);
    }
    return Promise.reject(new Error('Connect your Anthropic key first (the key icon in the Assistant).'));
  }

  /* Pull the plain text out of a response (thinking/tool blocks are skipped). */
  function textOf(message) {
    if (!message || !message.content) return '';
    return message.content.filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; }).join('\n').trim();
  }
  function toolInputOf(message, name) {
    if (!message || !message.content) return null;
    var b = message.content.filter(function (x) { return x.type === 'tool_use' && (!name || x.name === name); })[0];
    return b ? b.input : null;
  }

  /* --------------------------------------------------------- file input --- */

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }
  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); };
      r.readAsText(file);
    });
  }
  function bytesToBase64(buf) {
    var bytes = new Uint8Array(buf), bin = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(bin);
  }

  /* A spreadsheet is turned into plain CSV text in the browser (the API has no
     native .xlsx reader); PDFs and images are sent as native document/image
     blocks. Returns a Promise of an array of content blocks for one file. */
  function fileToBlocks(file) {
    var name = (file.name || '').toLowerCase();
    var type = (file.type || '').toLowerCase();

    if (/\.(xlsx|xls)$/.test(name) || type.indexOf('spreadsheet') >= 0 || type.indexOf('ms-excel') >= 0) {
      return readAsArrayBuffer(file).then(function (buf) {
        var wb = new global.ExcelJS.Workbook();
        return wb.xlsx.load(buf).then(function () {
          var out = [];
          wb.eachSheet(function (ws) {
            out.push('# Sheet: ' + ws.name);
            ws.eachRow(function (row) {
              var vals = [];
              row.eachCell({ includeEmpty: true }, function (cell) {
                var v = cell && cell.value;
                if (v && typeof v === 'object') { v = (v.text || v.result || v.richText && v.richText.map(function (t) { return t.text; }).join('') || ''); }
                vals.push(v === null || v === undefined ? '' : String(v));
              });
              out.push(vals.join(','));
            });
            out.push('');
          });
          return [{ type: 'text', text: 'Spreadsheet "' + file.name + '" as CSV:\n' + out.join('\n') }];
        });
      });
    }
    if (/\.pdf$/.test(name) || type === 'application/pdf') {
      return readAsArrayBuffer(file).then(function (buf) {
        return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytesToBase64(buf) } }];
      });
    }
    if (/\.(png|jpe?g|gif|webp)$/.test(name) || type.indexOf('image/') === 0) {
      var media = type.indexOf('image/') === 0 ? type : (/\.png$/.test(name) ? 'image/png' : (/\.gif$/.test(name) ? 'image/gif' : (/\.webp$/.test(name) ? 'image/webp' : 'image/jpeg')));
      return readAsArrayBuffer(file).then(function (buf) {
        return [{ type: 'image', source: { type: 'base64', media_type: media, data: bytesToBase64(buf) } }];
      });
    }
    /* csv / txt / anything else: treat as text. */
    return readAsText(file).then(function (txt) {
      return [{ type: 'text', text: 'File "' + file.name + '":\n' + String(txt) }];
    });
  }

  /* ------------------------------------------------------ autofill ------- */

  /* The tool Claude calls to hand back the extracted project. Not strict, so
     the app normalises/validates the result itself (names, numbers). */
  function fillTool() {
    return {
      name: 'fill_estimate',
      description: 'Return the network rollout project details extracted from the uploaded data, to pre-fill the estimator form.',
      input_schema: {
        type: 'object',
        properties: {
          side: { type: 'string', enum: ['wan', 'lan'], description: 'wan = wide-area (priced per product + connectivity mode). lan = local-area (priced per device-count tier).' },
          projectName: { type: 'string' },
          durationMonths: { type: 'number' },
          totalSites: { type: 'number' },
          mode: { type: 'string', enum: ['Standard', 'Non-standard', 'By Stage'], description: 'By Stage is LAN only.' },
          distribution: { type: 'string', enum: ['flat', 'bell'] },
          migration: { type: 'string', enum: ['Yes', 'No'], description: 'WAN migration support uplift.' },
          devices: { type: 'number', description: 'LAN only: device count, used when no tier rows are given.' },
          stages: { type: 'array', items: { type: 'string' }, description: 'LAN By Stage only.' },
          allocation: {
            type: 'array',
            description: 'One row per group of sites sharing a product/mode (WAN) or tier (LAN).',
            items: {
              type: 'object',
              properties: {
                product: { type: 'string', description: 'WAN product; must be one of the allowed products.' },
                connectivityMode: { type: 'string', description: 'WAN connectivity mode; must be one of the allowed modes.' },
                tierLabel: { type: 'string', description: 'LAN tier label; must be one of the allowed tiers.' },
                sites: { type: 'number' },
                complexityPct: { type: 'number', description: 'Percent, default 100.' },
                overrideMdPerSite: { type: 'number', description: 'Only for Non-standard mode.' }
              },
              required: ['sites']
            }
          },
          notes: { type: 'string' },
          assumptions: { type: 'array', items: { type: 'string' }, description: 'Anything you inferred, guessed, or could not find.' }
        },
        required: ['side', 'allocation']
      }
    };
  }

  function extractSystem() {
    var products = (D.PRODUCTS || []).join(' | ');
    var modes = (D.CONNECTIVITY_MODES || []).join(' | ');
    var tiers = (D.LAN_TIER_LABELS || []).join(' | ');
    var stages = (D.STAGE_NAMES || []).join(' | ');
    return [
      'You extract the details of a network rollout project from the uploaded data (a spreadsheet, PDF, or image) and return them by calling the fill_estimate tool, to pre-fill a DPM FTE estimator.',
      'Decide WAN or LAN from the content. WAN is priced per product and connectivity mode; LAN per device-count tier.',
      'Use ONLY these exact names where they apply:',
      'WAN products: ' + products,
      'WAN connectivity modes: ' + modes,
      'LAN tiers: ' + tiers,
      'LAN stages: ' + stages,
      'Group sites that share the same product/mode (WAN) or tier (LAN) into one allocation row with a site count. The allocation site counts should add up to the total sites.',
      'If a value is not in the data, omit it rather than invent it, and list what you assumed or could not find in "assumptions". Always call fill_estimate exactly once.'
    ].join('\n');
  }

  /* Read the files, ask Claude to extract, return { data, assumptions, text }.
     `data` is the fill_estimate input (or null if it did not call the tool). */
  function extract(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.reject(new Error('No file chosen.'));
    return Promise.all(list.map(fileToBlocks)).then(function (groups) {
      var content = [];
      groups.forEach(function (g) { content = content.concat(g); });
      content.push({ type: 'text', text: 'Extract this project and call fill_estimate.' });
      return rawMessage({
        model: _status.model,
        max_tokens: 3000,
        output_config: { effort: 'low' },
        system: extractSystem(),
        tools: [fillTool()],
        messages: [{ role: 'user', content: content }]
      }).then(function (msg) {
        var data = toolInputOf(msg, 'fill_estimate');
        return { data: data, text: textOf(msg), raw: msg };
      });
    });
  }

  /* ------------------------------------------------------- opinion/chat --- */

  var OPINION_SYSTEM = [
    'You are a senior Orange delivery manager reviewing a DPM FTE estimate for a network rollout.',
    'Give a brief, candid, practical opinion (120 words max): is the effort and FTE reasonable for the scope, what are the main risks or things to double-check, and one concrete suggestion. Plain words, no preamble, no restating all the numbers. Use short bullet points.'
  ].join(' ');

  function opinion(summaryText) {
    return rawMessage({
      model: _status.model,
      max_tokens: 700,
      output_config: { effort: 'low' },
      system: OPINION_SYSTEM,
      messages: [{ role: 'user', content: summaryText }]
    }).then(textOf);
  }

  var CHAT_SYSTEM = [
    'You are the assistant inside the DPM FTE Calculator, helping Delivery Project Managers estimate the man-days and FTE for WAN and LAN network rollouts.',
    'Be concise and practical. You can explain the method, sanity-check numbers, suggest how to set up an estimate, and give an opinion. The current estimate (if any) is provided for context.',
    'You cannot press buttons; when the user should change something, tell them which field. Plain words, short answers.'
  ].join(' ');

  /* history: array of {role:'user'|'assistant', content: <string | blocks>}.
     context: a short text summary of the current estimate (may be ''). */
  function chat(history, context) {
    var sys = CHAT_SYSTEM + (context ? ('\n\nCurrent estimate in the app:\n' + context) : '');
    var messages = history.map(function (m) {
      return { role: m.role, content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content };
    });
    return rawMessage({
      model: _status.model,
      max_tokens: 1500,
      output_config: { effort: 'low' },
      system: sys,
      messages: messages
    }).then(function (msg) { return { text: textOf(msg), raw: msg }; });
  }

  global.FTEAi = {
    canReachHost: CAN_REACH_HOST,
    supported: SUPPORTED,
    getStatus: getStatus,
    mode: mode,
    hasBrowserKey: hasBrowserKey,
    setBrowserKey: setBrowserKey,
    clearBrowserKey: clearBrowserKey,
    extract: extract,
    opinion: opinion,
    chat: chat,
    textOf: textOf
  };
})(window);
