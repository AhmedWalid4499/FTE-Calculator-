/* ===========================================================================
   db.js - persistence.

   IndexedDB is always the working store: it is available everywhere, survives
   a refresh, and never depends on permissions. On top of it sits one of three
   ways of getting the same records onto disk as .json files:

     'host'    the PowerShell launcher is running and writes the files itself.
     'folder'  the page is on a secure origin (https, or localhost) and the
               user has granted a folder through the File System Access API.
               This is how the published GitHub Pages build saves to disk.
     'browser' neither is available - Firefox, Safari, or index.html opened
               straight from disk. Records still persist in IndexedDB and can
               be downloaded on demand.

   Anything that could not reach disk is flagged pending and pushed as soon as
   a backend becomes available, so nothing is ever silently lost.
   =========================================================================== */
(function (global) {
  'use strict';

  var DB_NAME = 'dpm_fte';
  var DB_VERSION = 2;
  var STORE_RECORDS = 'records';
  var STORE_PROJECTS = 'projects';
  var STORE_SETTINGS = 'settings';
  var STORE_DPMS = 'dpms';
  var STORE_HANDLES = 'handles';
  var LEGACY_PROJECTS_KEY = 'dpm_fte_projects';

  var _db = null;
  var _serverOnline = false;
  var _serverInfo = null;
  var _listeners = [];

  /* Folder backend state */
  var _dirHandle = null;      // FileSystemDirectoryHandle, once granted
  var _folderName = null;
  var _folderReady = false;   // handle present AND permission currently granted

  /* ------------------------------------------------------------ events --- */

  function onStatusChange(fn) { _listeners.push(fn); }
  function emitStatus() {
    var s = status();
    _listeners.forEach(function (fn) { try { fn(s); } catch (e) { console.error(e); } });
  }

  /* -------------------------------------------------------- indexeddb ---- */

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_RECORDS)) {
          var recs = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
          recs.createIndex('savedAt', 'savedAt', { unique: false });
          recs.createIndex('projectCode', 'projectCode', { unique: false });
          recs.createIndex('type', 'type', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          db.createObjectStore(STORE_PROJECTS, { keyPath: 'name' });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
        /* v2: the DPM directory became editable data, and the granted folder
           handle needs somewhere to live between visits. */
        if (!db.objectStoreNames.contains(STORE_DPMS)) {
          db.createObjectStore(STORE_DPMS, { keyPath: 'email' });
        }
        if (!db.objectStoreNames.contains(STORE_HANDLES)) {
          db.createObjectStore(STORE_HANDLES, { keyPath: 'key' });
        }
      };
      req.onsuccess = function (e) { _db = e.target.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode) {
    return open().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function putLocal(store, value) { return tx(store, 'readwrite').then(function (s) { return wrap(s.put(value)); }); }
  function getLocal(store, key)   { return tx(store, 'readonly').then(function (s) { return wrap(s.get(key)); }); }
  function allLocal(store)        { return tx(store, 'readonly').then(function (s) { return wrap(s.getAll()); }); }
  function delLocal(store, key)   { return tx(store, 'readwrite').then(function (s) { return wrap(s.delete(key)); }); }

  /* ------------------------------------------------------------- http ---- */

  /* The PowerShell host only ever runs on loopback. Probing for it anywhere
     else - notably the published GitHub Pages site - would just produce a
     guaranteed 404 in everyone's console on every visit. */
  var IS_LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var CAN_REACH_HOST = (location.protocol === 'http:' || location.protocol === 'https:') && IS_LOOPBACK;

  function api(path, options) {
    if (!CAN_REACH_HOST) return Promise.reject(new Error('no local host on this origin'));
    var opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
    return fetch(path, opts).then(function (res) {
      /* The host explains its refusals ("that folder does not exist"), so a
         failure carries the server's own message rather than just a code. */
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          var err = new Error((body && body.error) || ('HTTP ' + res.status));
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function probeServer() {
    if (!CAN_REACH_HOST) {
      _serverOnline = false; _serverInfo = null; emitStatus();
      return Promise.resolve(false);
    }
    return api('/api/health')
      .then(function (info) { _serverOnline = true; _serverInfo = info; emitStatus(); return true; })
      .catch(function () { _serverOnline = false; _serverInfo = null; emitStatus(); return false; });
  }

  /* ----------------------------------------------------------- folder ---- */

  /* Requires a secure context. A page opened from disk is an opaque origin and
     the picker rejects outright, which is exactly why the launcher exists for
     local use and why the hosted build can do this instead. */
  var FOLDER_SUPPORTED = typeof global.showDirectoryPicker === 'function' && global.isSecureContext === true;

  function saveHandle(handle, name) {
    return putLocal(STORE_HANDLES, { key: 'dataFolder', handle: handle, name: name });
  }

  function verifyPermission(handle, interactive) {
    if (!handle || !handle.queryPermission) return Promise.resolve(false);
    var opts = { mode: 'readwrite' };
    return handle.queryPermission(opts).then(function (state) {
      if (state === 'granted') return true;
      if (!interactive) return false;
      return handle.requestPermission(opts).then(function (s) { return s === 'granted'; });
    }).catch(function () { return false; });
  }

  /** Ask the user for a folder. Must be called from a click. */
  function connectFolder() {
    if (!FOLDER_SUPPORTED) {
      return Promise.reject(new Error('This browser cannot save to a folder. Chrome or Edge is required.'));
    }
    return global.showDirectoryPicker({ mode: 'readwrite', id: 'dpm-fte-data' })
      .then(function (handle) {
        return verifyPermission(handle, true).then(function (ok) {
          if (!ok) throw new Error('Permission to write to that folder was not granted.');
          _dirHandle = handle;
          _folderName = handle.name;
          _folderReady = true;
          return saveHandle(handle, handle.name);
        });
      })
      .then(function () { return flushPending(); })
      .then(function (n) {
        /* A shared folder already holds colleagues' estimates - read them in. */
        return pullFromDisk().then(function (pulled) {
          emitStatus();
          return { name: _folderName, flushed: n, pulled: pulled };
        });
      });
  }

  function forgetFolder() {
    _dirHandle = null; _folderName = null; _folderReady = false;
    return delLocal(STORE_HANDLES, 'dataFolder').then(function () { emitStatus(); });
  }

  /* Restore a previously granted folder. Chrome keeps the handle but not
     necessarily the permission, so this reports "needs reconnect" rather than
     prompting - a prompt without a user gesture would be rejected anyway. */
  function restoreFolder() {
    if (!FOLDER_SUPPORTED) return Promise.resolve(false);
    return getLocal(STORE_HANDLES, 'dataFolder').then(function (row) {
      if (!row || !row.handle) return false;
      _dirHandle = row.handle;
      _folderName = row.name || row.handle.name;
      return verifyPermission(row.handle, false).then(function (ok) {
        _folderReady = ok;
        emitStatus();
        return ok;
      });
    }).catch(function () { return false; });
  }

  /** Re-grant permission for an already-chosen folder. Must be called from a click. */
  function reconnectFolder() {
    if (!_dirHandle) return connectFolder();
    return verifyPermission(_dirHandle, true).then(function (ok) {
      _folderReady = ok;
      if (!ok) throw new Error('Permission to write to that folder was not granted.');
      return flushPending();
    }).then(function (n) {
      return pullFromDisk().then(function (pulled) {
        emitStatus();
        return { name: _folderName, flushed: n, pulled: pulled };
      });
    });
  }

  function writeToFolder(subdir, filename, text) {
    if (!_folderReady || !_dirHandle) return Promise.reject(new Error('no folder connected'));
    return _dirHandle.getDirectoryHandle(subdir, { create: true })
      .then(function (dir) { return dir.getFileHandle(filename, { create: true }); })
      .then(function (file) { return file.createWritable(); })
      .then(function (writable) {
        return writable.write(text).then(function () { return writable.close(); });
      })
      .then(function () { return subdir + '/' + filename; });
  }

  /** One file from the connected folder, parsed; null when missing or unreadable. */
  function readFolderFile(subdir, filename) {
    if (!_folderReady || !_dirHandle) return Promise.resolve(null);
    return _dirHandle.getDirectoryHandle(subdir, { create: false })
      .then(function (dir) { return dir.getFileHandle(filename, { create: false }); })
      .then(function (h) { return h.getFile(); })
      .then(function (f) { return f.text(); })
      .then(function (txt) { return JSON.parse(String(txt).replace(/^﻿/, '')); })
      .catch(function () { return null; });
  }

  function deleteFromFolder(subdir, filename) {
    if (!_folderReady || !_dirHandle) return Promise.resolve();
    return _dirHandle.getDirectoryHandle(subdir, { create: false })
      .then(function (dir) { return dir.removeEntry(filename); })
      .catch(function () { /* already gone, or folder never created */ });
  }

  /* Read every JSON file in a sub-folder of the connected folder. This is how
     the hosted build sees estimates written by colleagues who connected the
     same shared (SharePoint-synced) folder. A file that is mid-sync or
     corrupt is counted and skipped rather than failing the whole read. */
  function readAllFromFolder(subdir) {
    if (!_folderReady || !_dirHandle) return Promise.reject(new Error('no folder connected'));
    return _dirHandle.getDirectoryHandle(subdir, { create: true }).then(function (dir) {
      var out = [], errors = 0;
      var it = dir.values();
      function step() {
        return it.next().then(function (res) {
          if (res.done) return { items: out, errors: errors };
          var h = res.value;
          if (h.kind !== 'file' || !/\.json$/i.test(h.name)) return step();
          return h.getFile()
            .then(function (f) { return f.text(); })
            .then(function (txt) {
              try {
                var obj = JSON.parse(String(txt).replace(/^﻿/, ''));
                if (obj && typeof obj === 'object') out.push(obj); else errors++;
              } catch (e) { errors++; }
            }, function () { errors++; })
            .then(step);
        });
      }
      return step();
    });
  }

  /* ----------------------------------------------------------- status ---- */

  function mode() {
    if (_serverOnline) return 'host';
    if (_folderReady) return 'folder';
    return 'browser';
  }

  /* Which place a record was written to. Stored on the record's sync info,
     so that "on disk here before, missing now" can be recognised as a
     deliberate deletion by someone else rather than as work to re-publish. */
  function currentLoc() {
    if (_serverOnline) return 'host:' + String((_serverInfo && _serverInfo.dataRoot) || '').toLowerCase();
    if (_folderReady) return 'folder:' + (_folderName || '');
    return null;
  }

  /* A shared location, as opposed to the app's own private data folder. A
     connected folder may or may not be shared, so it is treated as shared. */
  function isSharedLocation() {
    if (_serverOnline) return !(_serverInfo && _serverInfo.isDefaultRoot !== false);
    return _folderReady;
  }

  function status() {
    return {
      mode: mode(),
      serverOnline: _serverOnline,
      canReachHost: CAN_REACH_HOST,
      dataRoot: _serverInfo ? _serverInfo.dataRoot : null,
      defaultDataRoot: _serverInfo ? _serverInfo.defaultDataRoot : null,
      isDefaultRoot: _serverInfo ? _serverInfo.isDefaultRoot !== false : true,
      shared: isSharedLocation(),
      folderSupported: FOLDER_SUPPORTED,
      folderName: _folderName,
      folderReady: _folderReady,
      folderNeedsReconnect: !!(_dirHandle && !_folderReady),
      isSecureContext: global.isSecureContext === true
    };
  }

  /* ---------------------------------------------------------- records ---- */

  /* `sync` is this browser's bookkeeping about whether it managed to push the
     record. It is meaningless to anyone reading the file, so it is stripped
     from the payload rather than written to disk. */
  function forDisk(record) {
    var copy = Object.assign({}, record);
    delete copy.sync;
    return JSON.stringify(copy, null, 2);
  }

  /* One write path per backend. Tried in order of durability: the host writes
     wherever it was launched from, the folder writes wherever the user chose,
     and browser mode keeps it in IndexedDB for an explicit download later. */
  function writeRecordToDisk(record) {
    if (_serverOnline) {
      return api('/api/records', { method: 'POST', body: forDisk(record) })
        .then(function (res) { return res.file; });
    }
    if (_folderReady) {
      return writeToFolder('records', record.id + '.json', forDisk(record))
        .then(function (path) { return (_folderName || 'folder') + '/' + path; });
    }
    return Promise.reject(new Error('no disk backend available'));
  }

  /* Ask the local host to open an Outlook draft (host mode only). The server
     opens the compose window for the user to review; it never sends. */
  function sendOutlookEmail(payload) {
    if (!_serverOnline) return Promise.reject(new Error('the local app host is not running'));
    return api('/api/email', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (res) {
        if (res && res.ok) return res;
        throw new Error((res && res.error) || 'Outlook could not open the draft');
      });
  }

  function saveRecord(record) {
    record.sync = record.sync || {};
    /* Keep the "came from a colleague" marker through re-saves, e.g. when a
       planned start month is edited on the Team capacity page. */
    var pulled = !!record.sync.pulled;
    return putLocal(STORE_RECORDS, record)
      .then(function () { return writeRecordToDisk(record); })
      .then(function (file) {
        record.sync = { state: 'saved', file: file, loc: currentLoc(), at: new Date().toISOString(), pulled: pulled };
        return putLocal(STORE_RECORDS, record).then(function () {
          return { record: record, written: true, file: file };
        });
      })
      .catch(function () {
        record.sync = { state: 'pending', file: null, at: new Date().toISOString(), pulled: pulled };
        return putLocal(STORE_RECORDS, record)
          /* A failed write means our belief about the backend is out of date.
             Re-check so the status chip stops claiming we are saving to disk
             when we are not. */
          .then(function () {
            if (_serverOnline) return probeServer();
            if (_dirHandle) {
              return verifyPermission(_dirHandle, false).then(function (ok) {
                _folderReady = ok; emitStatus();
              });
            }
          })
          .then(function () {
            return { record: record, written: false, file: null };
          });
      });
  }

  /* Re-save an estimate that may have come straight from disk - the Team
     capacity page moves colleagues' projects too. The local copy's `pulled`
     flag is carried over; a record never seen here before that lives in a
     shared folder is someone else's, so it stays out of "copy my estimates". */
  function updateRecord(record) {
    return getLocal(STORE_RECORDS, record.id).then(function (local) {
      var rec = Object.assign({}, record);
      rec.sync = { pulled: local ? !!(local.sync && local.sync.pulled) : isSharedLocation() };
      return saveRecord(rec);
    });
  }

  function listRecords() {
    return allLocal(STORE_RECORDS).then(function (rows) {
      rows.sort(function (a, b) { return (b.savedAt || '').localeCompare(a.savedAt || ''); });
      return rows;
    });
  }

  function getRecord(id) { return getLocal(STORE_RECORDS, id); }

  /* ------------------------------------------------------- tombstones ---- */

  /* A delete made while the data folder is out of reach (host stopped,
     folder permission not yet re-granted) cannot touch the file, and the next
     read of the folder would bring the record straight back. The id is kept
     here until the delete reaches disk, and pulls ignore it meanwhile. */
  var TOMBSTONES = '_tombstones';

  function getTombstones() {
    return getLocal(STORE_SETTINGS, TOMBSTONES)
      .then(function (row) { return (row && Array.isArray(row.value)) ? row.value : []; })
      .catch(function () { return []; });
  }

  function setTombstones(ids) { return setSetting(TOMBSTONES, ids); }

  function addTombstone(id) {
    return getTombstones().then(function (ids) {
      if (ids.indexOf(id) < 0) ids.push(id);
      return setTombstones(ids);
    });
  }

  function flushTombstones() {
    if (!_serverOnline && !_folderReady) return Promise.resolve(0);
    return getTombstones().then(function (ids) {
      if (!ids.length) return 0;
      var left = [];
      return ids.reduce(function (chain, id) {
        return chain.then(function () {
          var del = _serverOnline
            ? api('/api/records/' + encodeURIComponent(id), { method: 'DELETE' })
            : deleteFromFolder('records', id + '.json');
          return del.catch(function () { left.push(id); });
        });
      }, Promise.resolve()).then(function () {
        return setTombstones(left).then(function () { return ids.length - left.length; });
      });
    });
  }

  /** Resolves { onDisk } - false when the file delete is queued for later. */
  function deleteRecord(id) {
    return delLocal(STORE_RECORDS, id).then(function () {
      if (_serverOnline) {
        return api('/api/records/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function () { return { onDisk: true }; },
                function () { return addTombstone(id).then(function () { return { onDisk: false }; }); });
      }
      if (_folderReady) return deleteFromFolder('records', id + '.json').then(function () { return { onDisk: true }; });
      /* A disk backend exists but is unreachable right now. */
      if (CAN_REACH_HOST || _dirHandle) return addTombstone(id).then(function () { return { onDisk: false }; });
      return { onDisk: false };
    });
  }

  function countPending() {
    return listRecords().then(function (rows) {
      return rows.filter(function (r) { return !r.sync || r.sync.state !== 'saved'; }).length;
    });
  }

  /* Push everything that never made it to disk. Runs whenever a backend
     becomes available: the host comes back, or a folder is connected. */
  function flushPending() {
    if (!_serverOnline && !_folderReady) return Promise.resolve(0);
    return flushTombstones().then(listRecords).then(function (rows) {
      var pending = rows.filter(function (r) { return !r.sync || r.sync.state !== 'saved'; });
      if (!pending.length) return 0;
      return pending.reduce(function (chain, rec) {
        return chain.then(function (n) {
          return writeRecordToDisk(rec)
            .then(function (file) {
              rec.sync = { state: 'saved', file: file, loc: currentLoc(), at: new Date().toISOString(),
                           pulled: !!(rec.sync && rec.sync.pulled) };
              return putLocal(STORE_RECORDS, rec).then(function () { return n + 1; });
            })
            .catch(function () { return n; });
        });
      }, Promise.resolve(0));
    });
  }

  function withoutSync(r) {
    var copy = Object.assign({}, r);
    delete copy.sync;
    return copy;
  }

  /* Every record file in the current data location, parsed. The host sends
     each file as text so that one unreadable file costs only itself; those,
     and files the host could not read at all, come back as `errors`. */
  function readDiskRecords() {
    if (_serverOnline) {
      return api('/api/records/all').then(function (res) {
        if (!res || !Array.isArray(res.records)) throw new Error('the data folder listing could not be read');
        var items = [], errors = Number(res.skipped) || 0;
        res.records.forEach(function (entry) {
          var rec = entry;
          if (typeof entry === 'string') {
            try { rec = JSON.parse(entry); } catch (e) { errors++; return; }
          }
          if (rec && typeof rec === 'object' && rec.id) items.push(rec); else errors++;
        });
        return { items: items, errors: errors, location: res.dataRoot };
      });
    }
    if (_folderReady) {
      return readAllFromFolder('records').then(function (res) {
        return { items: res.items.filter(function (r) { return r && r.id; }), errors: res.errors, location: _folderName };
      });
    }
    return Promise.reject(new Error('no disk backend available'));
  }

  function toIdSet(ids) {
    var set = {};
    (ids || []).forEach(function (id) { set[id] = true; });
    return set;
  }

  /* Bring records read from disk into this browser. Disk wins: it is the copy
     that syncs through OneDrive and that colleagues can edit (for instance a
     planned start month changed on the Team capacity page), so a local copy
     that differs is replaced - unless it is still waiting to be written, in
     which case the local edit is the newer one.

     Records that arrive from a shared location are marked `pulled`: that is
     how "copy my estimates here" tells your own work from colleagues'. From
     the app's own private folder everything is yours, however this browser
     came to see it. And a record this browser once saw in this very location
     that has since gone from it was deleted by someone - it is dropped here
     too, but only after a complete read, so a file that is merely mid-sync is
     never mistaken for a deletion. */
  function mergeIntoLocal(disk) {
    return Promise.all([listRecords(), getTombstones()]).then(function (res) {
      var local = res[0], dead = toIdSet(res[1]);
      var loc = currentLoc(), shared = isSharedLocation();
      var byId = {}, onDisk = {};
      local.forEach(function (r) { byId[r.id] = r; });
      (disk.items || []).forEach(function (r) { onDisk[r.id] = true; });

      var changes = (disk.items || []).filter(function (r) {
        if (dead[r.id]) return false;
        var mine = byId[r.id];
        if (!mine) return true;
        if (!mine.sync || mine.sync.state !== 'saved') return false;
        return JSON.stringify(withoutSync(mine)) !== JSON.stringify(withoutSync(r));
      });
      var gone = disk.errors ? [] : local.filter(function (r) {
        return !onDisk[r.id] && r.sync && r.sync.state === 'saved' && loc && r.sync.loc === loc;
      });

      var chain = changes.reduce(function (c, r) {
        return c.then(function (n) {
          var mine = byId[r.id];
          var rec = withoutSync(r);
          rec.sync = { state: 'saved', file: null, loc: loc, at: new Date().toISOString(),
                       pulled: mine ? !!(mine.sync && mine.sync.pulled) : shared };
          return putLocal(STORE_RECORDS, rec).then(function () { return n + 1; });
        });
      }, Promise.resolve(0));
      return gone.reduce(function (c, r) {
        return c.then(function (n) { return delLocal(STORE_RECORDS, r.id).then(function () { return n; }); });
      }, chain);
    });
  }

  /* Pull everything on disk in one request (the host joins the files), so a
     shared folder of hundreds of estimates costs one round trip, not one per
     record. */
  function pullFromDisk() {
    if (!_serverOnline && !_folderReady) return Promise.resolve(0);
    return readDiskRecords().then(mergeIntoLocal).catch(function () { return 0; });
  }

  /* Every estimate the team can see, read fresh from the shared location, plus
     this browser's estimates still waiting to be written there. A pending
     local copy wins over the disk copy of the same id - it is the newer edit.
     The Team capacity page uses this rather than the browser copy so a
     colleague's deletion or edit is reflected immediately. */
  function loadTeamRecords() {
    var localP = Promise.all([listRecords(), getTombstones()]);
    function combine(disk, localRes, source) {
      var local = localRes[0], dead = toIdSet(localRes[1]);
      var byId = {}, pendingAdded = 0;
      (disk.items || []).forEach(function (r) { if (!dead[r.id]) byId[r.id] = r; });
      local.forEach(function (r) {
        if (r.sync && r.sync.state === 'saved') return;
        if (!byId[r.id]) pendingAdded++;
        byId[r.id] = r;
      });
      return {
        source: source, location: disk.location, errors: disk.errors || 0, pendingIncluded: pendingAdded,
        records: Object.keys(byId).map(function (k) { return byId[k]; })
      };
    }
    if (_serverOnline || _folderReady) {
      var source = _serverOnline ? 'host' : 'folder';
      return Promise.all([readDiskRecords(), localP]).then(function (res) {
        return combine(res[0], res[1], source);
      });
    }
    return localP.then(function (res) {
      return { source: 'browser', location: null, errors: 0, pendingIncluded: 0, records: res[0] };
    });
  }

  /* Copy this browser's own estimates into the current data location when they
     are not there yet - used after switching to a shared folder. Two kinds
     are never re-published, because either would resurrect a record someone
     deliberately deleted: estimates pulled from a shared folder (colleagues'),
     and estimates already written to this very location once. */
  function publishLocal() {
    if (!_serverOnline && !_folderReady) return Promise.resolve(0);
    var loc = currentLoc();
    return Promise.all([readDiskRecords(), listRecords()]).then(function (res) {
      var onDisk = {};
      res[0].items.forEach(function (r) { onDisk[r.id] = true; });
      var mine = res[1].filter(function (r) {
        if (onDisk[r.id] || (r.sync && r.sync.pulled)) return false;
        return !(r.sync && r.sync.state === 'saved' && r.sync.loc === loc);
      });
      return mine.reduce(function (chain, rec) {
        return chain.then(function (n) {
          return writeRecordToDisk(rec).then(function (file) {
            rec.sync = { state: 'saved', file: file, loc: loc, at: new Date().toISOString(), pulled: false };
            return putLocal(STORE_RECORDS, rec).then(function () { return n + 1; });
          }).catch(function () { return n; });
        });
      }, Promise.resolve(0));
    });
  }

  /* The newest copy of one record: the file in the data location when there
     is one (a colleague may have changed it since this browser read it),
     otherwise this browser's copy. Used before re-saving a record, so the
     re-save changes only what the user changed instead of writing back a
     stale snapshot over someone else's edit. */
  function getFreshRecord(id) {
    var localP = getLocal(STORE_RECORDS, id);
    var diskP;
    if (_serverOnline) diskP = api('/api/records/' + encodeURIComponent(id)).catch(function () { return null; });
    else if (_folderReady) diskP = readFolderFile('records', id + '.json');
    else diskP = Promise.resolve(null);
    return Promise.all([diskP, localP]).then(function (res) {
      var disk = res[0], local = res[1];
      if (local && (!local.sync || local.sync.state !== 'saved')) return local;   // our newer, unwritten edit
      if (disk && typeof disk === 'object' && disk.id === id) {
        var rec = withoutSync(disk);
        rec.sync = local ? local.sync : { pulled: isSharedLocation() };
        return rec;
      }
      return local || null;
    });
  }

  /* ------------------------------------------------------ host config ---- */

  function getHostConfig() { return api('/api/config'); }

  /** Point the launcher at another data folder (null/'' = back to default). */
  function setHostDataRoot(path, copyExisting) {
    var body = path ? { dataRoot: path, copyExisting: !!copyExisting } : { reset: true };
    /* Re-probe either way: a failure part-way may still have moved the host. */
    return api('/api/config', { method: 'POST', body: JSON.stringify(body) })
      .then(function (res) { return probeServer().then(function () { return res; }); },
            function (err) { return probeServer().then(function () { throw err; }); });
  }

  /* --------------------------------------------------------- projects ---- */

  function safeFileName(name) {
    return String(name || 'project').replace(/[^A-Za-z0-9 \-_.]/g, '_').slice(0, 100) || 'project';
  }

  function saveProject(project) {
    return putLocal(STORE_PROJECTS, project)
      .then(function () {
        var body = JSON.stringify(project, null, 2);
        if (_serverOnline) {
          return api('/api/projects', { method: 'POST', body: body }).catch(function () {});
        }
        if (_folderReady) {
          return writeToFolder('projects', safeFileName(project.name) + '.json', body).catch(function () {});
        }
      })
      .then(function () { return project; });
  }

  function listProjects() {
    return allLocal(STORE_PROJECTS).then(function (rows) {
      rows.sort(function (a, b) { return (b.savedAt || '').localeCompare(a.savedAt || ''); });
      return rows;
    });
  }

  function getProject(name) { return getLocal(STORE_PROJECTS, name); }

  function deleteProject(name) {
    return delLocal(STORE_PROJECTS, name).then(function () {
      if (_serverOnline) {
        return api('/api/projects/' + encodeURIComponent(name), { method: 'DELETE' }).catch(function () {});
      }
      if (_folderReady) return deleteFromFolder('projects', safeFileName(name) + '.json');
    });
  }

  function pullProjectsFromDisk() {
    var itemsP;
    if (_serverOnline) itemsP = api('/api/projects').then(function (res) { return (res && res.projects) || []; });
    else if (_folderReady) itemsP = readAllFromFolder('projects').then(function (res) { return res.items; });
    else return Promise.resolve(0);
    return itemsP.then(function (items) {
      return listProjects().then(function (local) {
        var known = {};
        local.forEach(function (p) { known[p.name] = true; });
        var missing = items.filter(function (p) { return p && p.name && !known[p.name]; });
        return missing.reduce(function (chain, p) {
          return chain.then(function (n) { return putLocal(STORE_PROJECTS, p).then(function () { return n + 1; }); });
        }, Promise.resolve(0));
      });
    }).catch(function () { return 0; });
  }

  /* --------------------------------------------------------- the team ---- */

  /* The directory is owned by the database, seeded once from the published
     list. After that the two are independent: edits here never touch the
     shipped file, and a future update to the shipped file never silently
     rewrites somebody's customised team. */
  function loadDpms() {
    return allLocal(STORE_DPMS).then(function (rows) {
      if (rows && rows.length) return global.FTEData.setDpms(rows);
      var seed = global.FTEData.seedDpms();
      if (!seed.length) return global.FTEData.setDpms([]);
      return seed.reduce(function (chain, d) {
        return chain.then(function () { return putLocal(STORE_DPMS, d); });
      }, Promise.resolve()).then(function () { return global.FTEData.setDpms(seed); });
    }).catch(function () {
      return global.FTEData.setDpms(global.FTEData.seedDpms());
    });
  }

  function saveDpm(dpm) {
    return putLocal(STORE_DPMS, { name: dpm.name, email: dpm.email }).then(loadDpms);
  }

  function deleteDpm(email) {
    return delLocal(STORE_DPMS, email).then(loadDpms);
  }

  function replaceDpms(list) {
    return tx(STORE_DPMS, 'readwrite')
      .then(function (s) { return wrap(s.clear()); })
      .then(function () {
        return (list || []).reduce(function (chain, d) {
          return chain.then(function () { return putLocal(STORE_DPMS, { name: d.name, email: d.email }); });
        }, Promise.resolve());
      })
      .then(loadDpms);
  }

  function resetDpmsToSeed() { return replaceDpms(global.FTEData.seedDpms()); }

  /* --------------------------------------------------------- settings ---- */

  function getSettings() {
    return allLocal(STORE_SETTINGS).then(function (rows) {
      var out = Object.assign({}, global.FTEData.DEFAULT_SETTINGS);
      rows.forEach(function (r) { out[r.key] = r.value; });
      return out;
    }).catch(function () {
      return Object.assign({}, global.FTEData.DEFAULT_SETTINGS);
    });
  }

  function setSetting(key, value) { return putLocal(STORE_SETTINGS, { key: key, value: value }); }

  /* -------------------------------------------------------- migration ---- */

  /* The previous build kept saved configurations in localStorage. Move them
     across once so nobody loses work, then leave the old key in place as a
     safety net rather than deleting it. */
  function migrateLegacy() {
    return getLocal(STORE_SETTINGS, '_legacyMigrated').then(function (flag) {
      if (flag && flag.value) return 0;
      var raw = null;
      try { raw = localStorage.getItem(LEGACY_PROJECTS_KEY); } catch (e) { raw = null; }
      if (!raw) return setSetting('_legacyMigrated', true).then(function () { return 0; });

      var parsed;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') {
        return setSetting('_legacyMigrated', true).then(function () { return 0; });
      }

      var names = Object.keys(parsed);
      return names.reduce(function (chain, name) {
        return chain.then(function (n) {
          var cfg = parsed[name] || {};
          cfg.name = name;
          cfg.savedAt = cfg.timestamp || new Date().toISOString();
          cfg.migratedFromLocalStorage = true;
          return saveProject(cfg).then(function () { return n + 1; });
        });
      }, Promise.resolve(0)).then(function (n) {
        return setSetting('_legacyMigrated', true).then(function () { return n; });
      });
    });
  }

  /* ------------------------------------------------------------- boot ---- */

  function init() {
    return open()
      .then(loadDpms)
      .then(probeServer)
      .then(function () { return restoreFolder(); })
      .then(function () { return migrateLegacy(); })
      .then(function () { return pullFromDisk(); })
      .then(function () { return pullProjectsFromDisk(); })
      .then(function () { return flushPending(); })
      .then(function () { emitStatus(); return status(); });
  }

  global.FTEDb = {
    init: init,
    status: status,
    mode: mode,
    probeServer: probeServer,
    onStatusChange: onStatusChange,

    connectFolder: connectFolder,
    reconnectFolder: reconnectFolder,
    forgetFolder: forgetFolder,
    folderSupported: function () { return FOLDER_SUPPORTED; },
    sendOutlookEmail: sendOutlookEmail,

    saveRecord: saveRecord,
    updateRecord: updateRecord,
    getFreshRecord: getFreshRecord,
    listRecords: listRecords,
    getRecord: getRecord,
    deleteRecord: deleteRecord,
    countPending: countPending,
    flushPending: flushPending,
    pullFromDisk: pullFromDisk,
    pullProjectsFromDisk: pullProjectsFromDisk,
    loadTeamRecords: loadTeamRecords,
    publishLocal: publishLocal,
    getHostConfig: getHostConfig,
    setHostDataRoot: setHostDataRoot,

    saveProject: saveProject,
    listProjects: listProjects,
    getProject: getProject,
    deleteProject: deleteProject,

    loadDpms: loadDpms,
    saveDpm: saveDpm,
    deleteDpm: deleteDpm,
    replaceDpms: replaceDpms,
    resetDpmsToSeed: resetDpmsToSeed,

    getSettings: getSettings,
    setSetting: setSetting
  };
})(window);
