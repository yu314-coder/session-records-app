/**
 * Session Records Management System — serverless backend (Google Apps Script)
 *
 * Data flow:   GitHub Pages (static site) → this web app → Google Sheet → Notion
 *
 * The static site (docs/ folder, hosted on GitHub Pages) POSTs JSON to this
 * script's /exec URL. Records are written to the Google Sheet first (the
 * source of truth), then pushed on to Notion. Uploaded PDFs are stored in a
 * Google Drive folder and also uploaded into the Notion record.
 *
 * ── SETUP (one time) ─────────────────────────────────────────────────────────
 *  1. Create a Google Sheet → Extensions → Apps Script → paste this file.
 *  2. Run setup() once from the editor (authorize when prompted). It creates
 *     the tabs and a starter access code CHANGE-ME (edit it in AccessCodes).
 *  3. Optional Notion sync — Project Settings → Script Properties:
 *       NOTION_API_KEY          your Notion integration token
 *       NOTION_RECORDS_DB_ID    your Records database id
 *     The Notion Records database needs the same properties as before:
 *       ID (number), DateTime (date), Department (select), UserID (rich text),
 *       SyllabusText (rich text), NotionFile (files),
 *       OriginalFileName (rich text), FileSize (number).
 *     Leave the properties unset to run on Sheets only.
 *  4. Deploy → New deployment → type "Web app" → Execute as: Me →
 *     Who has access: Anyone. Copy the /exec URL into docs/config.js.
 *     (Later code updates: Manage deployments → ✏️ Edit → Version: New —
 *      this keeps the same URL.)
 *  5. Optional: Triggers → add a time-driven trigger for syncPendingToNotion
 *     (e.g. hourly) so records that failed to reach Notion are retried.
 */

var SHEETS = {
  USERS: 'Users',
  CODES: 'AccessCodes',
  RECORDS: 'Records',
  ARCHIVE: 'RecordsArchive',
  COUNTS: 'Counts',
  SESSIONS: 'Sessions'
};

var HEADERS = {
  Users: ['UserID', 'PasswordHash', 'Salt', 'CreatedAt'],
  AccessCodes: ['AccessCode', 'Note'],
  Records: ['ID', 'DateTime', 'Department', 'UserID', 'FileName', 'FileSize', 'DriveFileId', 'SyllabusText', 'NotionPageId', 'NotionSyncError'],
  RecordsArchive: ['ID', 'DateTime', 'Department', 'UserID', 'FileName', 'FileSize', 'DriveFileId', 'SyllabusText', 'NotionPageId', 'ArchivedAt', 'ArchivedBy'],
  Counts: ['Department', 'Count'],
  Sessions: ['Token', 'UserID', 'AccessGranted', 'CreatedAt']
};

var SESSION_HOURS = 24;
var HASH_ITERATIONS = 5000;
var MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB, same as the original app
var DRIVE_FOLDER = 'Session Records Files';
var NOTION_VERSION = '2022-06-28';

// ── Entry points ─────────────────────────────────────────────────────────────

function doGet(e) {
  return json_({
    success: true,
    message: 'Session Records Management System API is running',
    version: '3.0.0-sheets',
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ success: false, message: 'Invalid request body' });
  }

  try {
    switch (req.action) {
      case 'register':        return json_(register_(req));
      case 'login':           return json_(login_(req));
      case 'checkAccessCode': return json_(checkAccessCode_(req));
      case 'addRecord':       return json_(addRecord_(req));
      case 'records':         return json_(getRecords_(req));
      case 'clearRecords':    return json_(clearRecords_(req));
      case 'counts':          return json_(getCounts_(req));
      case 'session':         return json_(sessionInfo_(req));
      case 'logout':          return json_(logout_(req));
      default:                return json_({ success: false, message: 'Unknown action: ' + req.action });
    }
  } catch (err) {
    return json_({ success: false, message: 'Server error: ' + err.message });
  }
}

/** Run once from the editor to create all tabs and a starter access code. */
function setup() {
  Object.keys(HEADERS).forEach(function (name) { sheet_(name); });
  var codes = sheet_(SHEETS.CODES);
  if (codes.getLastRow() < 2) {
    codes.appendRow(['CHANGE-ME', 'Starter access code — replace with your own']);
  }
  driveFolder_();
  Logger.log('Setup complete. Edit the AccessCodes tab, then deploy as a web app.');
}

// ── Auth ─────────────────────────────────────────────────────────────────────

function register_(req) {
  var userID = String(req.userID || '').trim();
  var password = String(req.password || '');

  if (!userID || !password) return { success: false, message: 'UserID and password are required' };
  if (userID.length < 3) return { success: false, message: 'UserID must be at least 3 characters long' };
  if (password.length < 6) return { success: false, message: 'Password must be at least 6 characters long' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (findRow_(SHEETS.USERS, 0, userID)) {
      return { success: false, message: 'UserID already registered. Please choose a different UserID.' };
    }
    var salt = Utilities.getUuid();
    sheet_(SHEETS.USERS).appendRow([userID, hashPassword_(password, salt), salt, new Date().toISOString()]);
  } finally {
    lock.releaseLock();
  }

  return {
    success: true,
    message: 'Registration successful! Redirecting to login...',
    userID: userID
  };
}

function login_(req) {
  var userID = String(req.userID || '').trim();
  var password = String(req.password || '');

  if (!userID || !password) return { success: false, message: 'UserID and password are required' };

  var hit = findRow_(SHEETS.USERS, 0, userID);
  if (!hit) return { success: false, message: 'User not found. Please check your UserID or register first.' };

  var storedHash = String(hit.row[1]);
  var salt = String(hit.row[2]);
  if (hashPassword_(password, salt) !== storedHash) {
    return { success: false, message: 'Invalid password. Please check your password and try again.' };
  }

  purgeExpiredSessions_();
  var token = Utilities.getUuid() + '-' + Utilities.getUuid();
  sheet_(SHEETS.SESSIONS).appendRow([token, userID, false, new Date().toISOString()]);

  return {
    success: true,
    message: 'Login successful! Redirecting to access code...',
    token: token,
    userID: userID
  };
}

function checkAccessCode_(req) {
  var session = getSession_(req.token, false);
  if (!session) return { success: false, message: 'Not authenticated. Please login first.' };

  var accessCode = String(req.accessCode || '').trim();
  if (!accessCode) return { success: false, message: 'Access code is required' };

  if (!findRow_(SHEETS.CODES, 0, accessCode)) {
    return { success: false, message: 'Invalid access code. Please contact your administrator for a valid code.' };
  }

  sheet_(SHEETS.SESSIONS).getRange(session.rowIndex, 3).setValue(true);
  return { success: true, message: 'Access granted! Welcome to the Session Records System.' };
}

function sessionInfo_(req) {
  var session = getSession_(req.token, false);
  return {
    success: true,
    authenticated: !!(session && session.accessGranted),
    userID: session ? session.userID : null
  };
}

function logout_(req) {
  var session = getSession_(req.token, false);
  if (session) sheet_(SHEETS.SESSIONS).deleteRow(session.rowIndex);
  return { success: true, message: 'Logged out successfully' };
}

// ── Records ──────────────────────────────────────────────────────────────────

function addRecord_(req) {
  var session = getSession_(req.token, true);
  if (!session) return { success: false, message: 'Not authenticated. Please login first.' };

  var department = String(req.department || '').trim();
  var syllabusText = String(req.syllabusText || '').trim();

  if (!department) return { success: false, message: 'Please select a department' };
  if (!syllabusText && !req.fileData) {
    return { success: false, message: 'Please provide either syllabus text or upload a notes file' };
  }

  // Save the PDF to Drive first
  var fileName = '', fileSize = 0, driveFileId = '', blob = null;
  if (req.fileData) {
    fileName = String(req.fileName || 'notes.pdf');
    if (!/\.pdf$/i.test(fileName)) return { success: false, message: 'Only PDF files are allowed!' };
    var bytes;
    try {
      bytes = Utilities.base64Decode(req.fileData);
    } catch (err) {
      return { success: false, message: 'Could not decode the uploaded file. Please try again.' };
    }
    if (bytes.length > MAX_FILE_BYTES) return { success: false, message: 'File size must be less than 20MB' };
    fileSize = bytes.length;
    blob = Utilities.newBlob(bytes, 'application/pdf', fileName);
    var file = driveFolder_().createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    driveFileId = file.getId();
  }

  var record = {
    id: new Date().getTime(),
    dateTime: new Date().toISOString(),
    department: department,
    userID: session.userID,
    fileName: fileName,
    fileSize: fileSize,
    driveFileId: driveFileId,
    syllabusText: syllabusText
  };

  // 1) Google Sheet is the source of truth
  var recordsSheet = sheet_(SHEETS.RECORDS);
  recordsSheet.appendRow([
    record.id, record.dateTime, record.department, record.userID,
    record.fileName, record.fileSize, record.driveFileId, record.syllabusText, '', ''
  ]);
  var rowIndex = recordsSheet.getLastRow();

  // 2) Then Sheet → Notion (record kept in the Sheet even if Notion fails)
  var notionNote = '';
  if (notionEnabled_()) {
    try {
      var pageId = notionCreatePage_(record, blob);
      recordsSheet.getRange(rowIndex, 9).setValue(pageId);
    } catch (err) {
      recordsSheet.getRange(rowIndex, 10).setValue(String(err.message).slice(0, 500));
      notionNote = ' (Saved to the Sheet, but the Notion sync failed — it will be retried.)';
    }
  }

  updateCounts_(department);

  return {
    success: true,
    message: 'Record added successfully!' +
      (fileName ? ' File "' + fileName + '" uploaded.' : '') + notionNote,
    recordInfo: {
      recordId: record.id,
      department: department,
      hasFile: !!fileName,
      fileName: fileName,
      fileSize: fileSize,
      hasText: !!syllabusText,
      timestamp: new Date().toLocaleString()
    }
  };
}

function getRecords_(req) {
  var session = getSession_(req.token, true);
  if (!session) return { success: false, message: 'Not authenticated. Please login first.' };

  var values = dataRows_(SHEETS.RECORDS);
  var records = values.map(function (row) {
    return {
      id: row[0],
      dateTime: isoString_(row[1]),
      department: String(row[2] || ''),
      userID: String(row[3] || ''),
      fileName: String(row[4] || ''),
      fileSize: Number(row[5]) || 0,
      fileId: String(row[6] || ''),
      syllabusText: String(row[7] || ''),
      notionSynced: !!row[8]
    };
  });
  records.sort(function (a, b) { return (b.id || 0) - (a.id || 0); });

  return { success: true, data: records, count: records.length };
}

function clearRecords_(req) {
  var session = getSession_(req.token, true);
  if (!session) return { success: false, message: 'Not authenticated. Please login first.' };

  var recordsSheet = sheet_(SHEETS.RECORDS);
  var archiveSheet = sheet_(SHEETS.ARCHIVE);
  var rows = dataRows_(SHEETS.RECORDS);
  var now = new Date().toISOString();

  // Move every record to the archive tab (files stay in Drive)
  rows.forEach(function (row) {
    archiveSheet.appendRow([
      row[0], isoString_(row[1]), row[2], row[3], row[4], row[5], row[6], row[7], row[8], now, session.userID
    ]);
  });
  if (recordsSheet.getLastRow() > 1) {
    recordsSheet.deleteRows(2, recordsSheet.getLastRow() - 1);
  }

  // Archive the synced Notion pages too
  if (notionEnabled_()) {
    rows.forEach(function (row) {
      if (row[8]) {
        try { notionArchivePage_(String(row[8])); } catch (err) { /* page may already be gone */ }
      }
    });
  }

  // Audit trail entry, in the Sheet and (if enabled) in Notion
  var audit = {
    id: new Date().getTime(),
    dateTime: now,
    department: 'System',
    userID: session.userID,
    fileName: '',
    fileSize: 0,
    driveFileId: '',
    syllabusText: 'ADMIN CLEAR: ' + rows.length + ' records cleared by ' + session.userID + ' at ' +
      new Date().toLocaleString() + '. Files remain in Drive; rows moved to RecordsArchive.'
  };
  recordsSheet.appendRow([
    audit.id, audit.dateTime, audit.department, audit.userID, '', 0, '', audit.syllabusText, '', ''
  ]);
  if (notionEnabled_()) {
    try {
      var pageId = notionCreatePage_(audit, null);
      recordsSheet.getRange(recordsSheet.getLastRow(), 9).setValue(pageId);
    } catch (err) { /* audit sync is best-effort */ }
  }

  clearCounts_();

  return {
    success: true,
    message: 'Successfully cleared ' + rows.length + ' records. Files remain in Drive storage.',
    clearedCount: rows.length,
    clearedBy: session.userID,
    clearedAt: new Date().toLocaleString()
  };
}

function getCounts_(req) {
  var session = getSession_(req.token, true);
  if (!session) return { success: false, message: 'Not authenticated. Please login first.' };

  var data = dataRows_(SHEETS.COUNTS).map(function (row) {
    return { department: String(row[0] || ''), count: Number(row[1]) || 0 };
  });
  return { success: true, data: data, totalDepartments: data.length };
}

// ── Counts helpers ───────────────────────────────────────────────────────────

function updateCounts_(department) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var hit = findRow_(SHEETS.COUNTS, 0, department);
    if (hit) {
      sheet_(SHEETS.COUNTS).getRange(hit.rowIndex, 2).setValue((Number(hit.row[1]) || 0) + 1);
    } else {
      sheet_(SHEETS.COUNTS).appendRow([department, 1]);
    }
  } finally {
    lock.releaseLock();
  }
}

function clearCounts_() {
  var countsSheet = sheet_(SHEETS.COUNTS);
  if (countsSheet.getLastRow() > 1) {
    countsSheet.deleteRows(2, countsSheet.getLastRow() - 1);
  }
}

// ── Notion sync ──────────────────────────────────────────────────────────────

function notionEnabled_() {
  var props = PropertiesService.getScriptProperties();
  return !!(props.getProperty('NOTION_API_KEY') && props.getProperty('NOTION_RECORDS_DB_ID'));
}

function notionHeaders_() {
  return {
    'Authorization': 'Bearer ' + PropertiesService.getScriptProperties().getProperty('NOTION_API_KEY'),
    'Notion-Version': NOTION_VERSION
  };
}

/** Creates the record page in Notion, uploading the PDF into Notion as well. */
function notionCreatePage_(record, blob) {
  var fileUploadId = null;
  if (blob) {
    var createResp = UrlFetchApp.fetch('https://api.notion.com/v1/file_uploads', {
      method: 'post',
      contentType: 'application/json',
      headers: notionHeaders_(),
      payload: JSON.stringify({ filename: record.fileName }),
      muteHttpExceptions: true
    });
    if (createResp.getResponseCode() >= 300) {
      throw new Error('Notion file upload create failed: ' + createResp.getContentText());
    }
    var upload = JSON.parse(createResp.getContentText());

    // Sending a blob in the payload makes UrlFetchApp use multipart/form-data
    var sendResp = UrlFetchApp.fetch(upload.upload_url, {
      method: 'post',
      headers: notionHeaders_(),
      payload: { file: blob },
      muteHttpExceptions: true
    });
    if (sendResp.getResponseCode() >= 300) {
      throw new Error('Notion file content upload failed: ' + sendResp.getContentText());
    }
    fileUploadId = upload.id;
  }

  var properties = {
    'ID': { number: record.id },
    'DateTime': { date: { start: record.dateTime } },
    'Department': { select: { name: record.department } },
    'UserID': { rich_text: [{ text: { content: record.userID } }] },
    'SyllabusText': { rich_text: [{ text: { content: record.syllabusText || '' } }] }
  };
  if (fileUploadId) {
    properties['NotionFile'] = {
      files: [{ type: 'file_upload', file_upload: { id: fileUploadId }, name: record.fileName }]
    };
    properties['OriginalFileName'] = { rich_text: [{ text: { content: record.fileName } }] };
    properties['FileSize'] = { number: record.fileSize };
  }

  var resp = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: notionHeaders_(),
    payload: JSON.stringify({
      parent: { database_id: PropertiesService.getScriptProperties().getProperty('NOTION_RECORDS_DB_ID') },
      properties: properties
    }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) {
    throw new Error('Notion page create failed: ' + resp.getContentText());
  }
  return JSON.parse(resp.getContentText()).id;
}

function notionArchivePage_(pageId) {
  UrlFetchApp.fetch('https://api.notion.com/v1/pages/' + pageId, {
    method: 'patch',
    contentType: 'application/json',
    headers: notionHeaders_(),
    payload: JSON.stringify({ archived: true }),
    muteHttpExceptions: true
  });
}

/**
 * Retries Sheet rows that never made it to Notion. Run manually or attach a
 * time-driven trigger (e.g. hourly).
 */
function syncPendingToNotion() {
  if (!notionEnabled_()) return;
  var recordsSheet = sheet_(SHEETS.RECORDS);
  var rows = dataRows_(SHEETS.RECORDS);
  rows.forEach(function (row, i) {
    if (row[8]) return; // already synced
    var rowIndex = i + 2;
    var record = {
      id: row[0],
      dateTime: isoString_(row[1]),
      department: String(row[2] || ''),
      userID: String(row[3] || ''),
      fileName: String(row[4] || ''),
      fileSize: Number(row[5]) || 0,
      syllabusText: String(row[7] || '')
    };
    var blob = null;
    if (row[6]) {
      try { blob = DriveApp.getFileById(String(row[6])).getBlob(); } catch (err) { /* file gone */ }
    }
    try {
      var pageId = notionCreatePage_(record, blob);
      recordsSheet.getRange(rowIndex, 9).setValue(pageId);
      recordsSheet.getRange(rowIndex, 10).setValue('');
    } catch (err) {
      recordsSheet.getRange(rowIndex, 10).setValue(String(err.message).slice(0, 500));
    }
  });
}

// ── Session helpers ──────────────────────────────────────────────────────────

function getSession_(token, needAccess) {
  if (!token) return null;
  var hit = findRow_(SHEETS.SESSIONS, 0, String(token));
  if (!hit) return null;

  var created = new Date(isoString_(hit.row[3]));
  if (isNaN(created.getTime()) || (Date.now() - created.getTime()) > SESSION_HOURS * 3600 * 1000) {
    sheet_(SHEETS.SESSIONS).deleteRow(hit.rowIndex);
    return null;
  }

  var accessGranted = hit.row[2] === true || String(hit.row[2]).toUpperCase() === 'TRUE';
  if (needAccess && !accessGranted) return null;

  return {
    token: token,
    userID: String(hit.row[1]),
    accessGranted: accessGranted,
    rowIndex: hit.rowIndex
  };
}

function purgeExpiredSessions_() {
  var sessionsSheet = sheet_(SHEETS.SESSIONS);
  var rows = dataRows_(SHEETS.SESSIONS);
  var cutoff = Date.now() - SESSION_HOURS * 3600 * 1000;
  for (var i = rows.length - 1; i >= 0; i--) {
    var created = new Date(isoString_(rows[i][3]));
    if (isNaN(created.getTime()) || created.getTime() < cutoff) {
      sessionsSheet.deleteRow(i + 2);
    }
  }
}

// ── Generic helpers ──────────────────────────────────────────────────────────

function hashPassword_(password, salt) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + ':' + password, Utilities.Charset.UTF_8);
  for (var i = 0; i < HASH_ITERATIONS; i++) {
    digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest);
  }
  return Utilities.base64Encode(digest);
}

function ss_() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  var spreadsheet = ss_();
  var sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
    sheet.appendRow(HEADERS[name]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** All data rows (without the header) of a tab. */
function dataRows_(name) {
  var sheet = sheet_(name);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
}

/** Finds the first row whose column `col` (0-based) equals `value`. */
function findRow_(name, col, value) {
  var rows = dataRows_(name);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][col]) === String(value)) {
      return { row: rows[i], rowIndex: i + 2 };
    }
  }
  return null;
}

/** Sheets may auto-parse ISO strings into Dates — normalize back to ISO. */
function isoString_(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || '');
}

function driveFolder_() {
  var folders = DriveApp.getFoldersByName(DRIVE_FOLDER);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
