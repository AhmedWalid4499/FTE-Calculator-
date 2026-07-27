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
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
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
      .then(function (n) { emitStatus(); return { name: _folderName, flushed: n }; });
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
    }).then(function (n) { emitStatus(); return { name: _folderName, flushed: n }; });
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

  function deleteFromFolder(subdir, filename) {
    if (!_folderReady || !_dirHandle) return Promise.resolve();
    return _dirHandle.getDirectoryHandle(subdir, { create: false })
      .then(function (dir) { return dir.removeEntry(filename); })
      .catch(function () { /* already gone, or folder never created */ });
  }

  /* ----------------------------------------------------------- status ---- */

  function mode() {
    if (_serverOnline) return 'host';
    if (_folderReady) return 'folder';
    return 'browser';
  }

  function status() {
    return {
      mode: mode(),
      serverOnline: _serverOnline,
      canReachHost: CAN_REACH_HOST,
      dataRoot: _serverInfo ? _serverInfo.dataRoot : null,
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
    return putLocal(STORE_RECORDS, record)
      .then(function () { return writeRecordToDisk(record); })
      .then(function (file) {
        record.sync = { state: 'saved', file: file, at: new Date().toISOString() };
        return putLocal(STORE_RECORDS, record).then(function () {
          return { record: record, written: true, file: file };
        });
      })
      .catch(function () {
        record.sync = { state: 'pending', file: null, at: new Date().toISOString() };
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

  function listRecords() {
    return allLocal(STORE_RECORDS).then(function (rows) {
      rows.sort(function (a, b) { return (b.savedAt || '').localeCompare(a.savedAt || ''); });
      return rows;
    });
  }

  function getRecord(id) { return getLocal(STORE_RECORDS, id); }

  function deleteRecord(id) {
    return delLocal(STORE_RECORDS, id).then(function () {
      if (_serverOnline) {
        return api('/api/records/' + encodeURIComponent(id), { method: 'DELETE' }).catch(function () {});
      }
      if (_folderReady) return deleteFromFolder('records', id + '.json');
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
    return listRecords().then(function (rows) {
      var pending = rows.filter(function (r) { return !r.sync || r.sync.state !== 'saved'; });
      if (!pending.length) return 0;
      return pending.reduce(function (chain, rec) {
        return chain.then(function (n) {
          return writeRecordToDisk(rec)
            .then(function (file) {
              rec.sync = { state: 'saved', file: file, at: new Date().toISOString() };
              return putLocal(STORE_RECORDS, rec).then(function () { return n + 1; });
            })
            .catch(function () { return n; });
        });
      }, Promise.resolve(0));
    });
  }

  /* Pull anything on disk that this browser profile has not seen. Disk wins:
     it is the copy that syncs through OneDrive and that colleagues can read. */
  function pullFromDisk() {
    if (!_serverOnline) return Promise.resolve(0);
    return api('/api/records').then(function (index) {
      var entries = (index && index.records) || [];
      return listRecords().then(function (local) {
        var known = {};
        local.forEach(function (r) { known[r.id] = true; });
        var missing = entries.filter(function (e) { return e && e.id && !known[e.id]; });
        return missing.reduce(function (chain, entry) {
          return chain.then(function (n) {
            return api('/api/records/' + encodeURIComponent(entry.id))
              .then(function (full) {
                full.sync = { state: 'saved', file: entry.file, at: new Date().toISOString() };
                return putLocal(STORE_RECORDS, full).then(function () { return n + 1; });
              })
              .catch(function () { return n; });
          });
        }, Promise.resolve(0));
      });
    }).catch(function () { return 0; });
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
    if (!_serverOnline) return Promise.resolve(0);
    return api('/api/projects').then(function (res) {
      var items = (res && res.projects) || [];
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
    listRecords: listRecords,
    getRecord: getRecord,
    deleteRecord: deleteRecord,
    countPending: countPending,
    flushPending: flushPending,
    pullFromDisk: pullFromDisk,

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
