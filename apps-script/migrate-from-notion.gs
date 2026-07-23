/**
 * ONE-TIME MIGRATION — old Notion-backed app → Google Sheet
 *
 * The original Express app kept users, access codes, counts and records in four
 * Notion databases. This pulls all of it into the Sheet so the new app shows the
 * same history and the same logins as before.
 *
 * How to run: paste this at the END of Code.gs in the Apps Script editor, save,
 * reload the page (the run selector defaults to `aMigrateFromNotion`), press Run,
 * then delete it again. Requires NOTION_API_KEY in Script Properties.
 *
 * Safe to re-run: everything is keyed on existing IDs, so a second run adds
 * nothing and a timed-out run can simply be started again.
 *
 * What it does NOT do: it never writes to Notion. Records are imported with their
 * Notion page id already filled in, so syncPendingToNotion treats them as synced
 * and will not create duplicate pages.
 */

// The three legacy database ids (the records db is read from Script Properties).
var LEGACY_DB = {
  users:  '22f07ac0142480669e8bc4ea5795e85b',
  codes:  '22f07ac0142480749e11db5730a34ddc',
  counts: '22f07ac01424800fadcddffeceff7d34'
};

function aMigrateFromNotion() {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('NOTION_API_KEY');
  var recordsDb = props.getProperty('NOTION_RECORDS_DB_ID');
  if (!key || !recordsDb) throw new Error('Set NOTION_API_KEY and NOTION_RECORDS_DB_ID first.');

  var report = [];

  // ── Hourly retry trigger for failed Notion syncs ──────────────────────────
  var haveTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'syncPendingToNotion';
  });
  if (!haveTrigger) {
    ScriptApp.newTrigger('syncPendingToNotion').timeBased().everyHours(1).create();
    report.push('trigger: installed (hourly)');
  } else {
    report.push('trigger: already present');
  }

  // ── Users (passwords were plain text in Notion; store them hashed) ────────
  var usersSheet = sheet_(SHEETS.USERS);
  var seenUsers = {};
  dataRows_(SHEETS.USERS).forEach(function (r) { seenUsers[String(r[0])] = true; });

  var usersAdded = 0;
  nQueryAll_(LEGACY_DB.users, key).forEach(function (page) {
    var userID = nTitle_(page, 'UserID');
    if (!userID || seenUsers[userID]) return;
    var salt = Utilities.getUuid();
    usersSheet.appendRow([
      userID, hashPassword_(nRich_(page, 'Password'), salt), salt, new Date().toISOString()
    ]);
    seenUsers[userID] = true;
    usersAdded++;
  });
  report.push('users: +' + usersAdded);

  // ── Access codes ─────────────────────────────────────────────────────────
  var codesSheet = sheet_(SHEETS.CODES);
  var seenCodes = {};
  dataRows_(SHEETS.CODES).forEach(function (r) { seenCodes[String(r[0])] = true; });

  var codesAdded = 0;
  nQueryAll_(LEGACY_DB.codes, key).forEach(function (page) {
    var code = nTitle_(page, 'AccessCode');
    if (!code || seenCodes[code]) return;
    codesSheet.appendRow([code, 'Migrated from Notion']);
    seenCodes[code] = true;
    codesAdded++;
  });
  report.push('access codes: +' + codesAdded);

  // ── Department counts ────────────────────────────────────────────────────
  var countsSheet = sheet_(SHEETS.COUNTS);
  var seenCounts = {};
  dataRows_(SHEETS.COUNTS).forEach(function (r) { seenCounts[String(r[0])] = true; });

  var countsAdded = 0;
  nQueryAll_(LEGACY_DB.counts, key).forEach(function (page) {
    var dept = nTitle_(page, 'Department');
    if (!dept || seenCounts[dept]) return;
    var n = page.properties['Count'] ? page.properties['Count'].number : 0;
    countsSheet.appendRow([dept, n || 0]);
    seenCounts[dept] = true;
    countsAdded++;
  });
  report.push('counts: +' + countsAdded);

  // ── Records, copying each attached PDF from Notion into Drive ────────────
  // Notion's file URLs are short-lived signed links, so the PDFs are re-hosted
  // in Drive; that is also what the new app's view/download buttons point at.
  var recordsSheet = sheet_(SHEETS.RECORDS);
  var seenRecords = {};
  dataRows_(SHEETS.RECORDS).forEach(function (r) { seenRecords[String(r[0])] = true; });

  var recordsAdded = 0, filesCopied = 0, fileFailures = 0;
  nQueryAll_(recordsDb, key).forEach(function (page) {
    var p = page.properties;
    var id = p['ID'] ? p['ID'].number : null;
    if (!id || seenRecords[String(id)]) return;

    var fileName = nRich_(page, 'OriginalFileName');
    var fileSize = (p['FileSize'] && p['FileSize'].number) || 0;
    var driveFileId = '';

    var files = (p['NotionFile'] && p['NotionFile'].files) || [];
    if (files.length) {
      var f = files[0];
      if (!fileName) fileName = f.name || 'notes.pdf';
      var url = f.type === 'file' && f.file ? f.file.url
              : f.type === 'external' && f.external ? f.external.url : null;
      if (url) {
        try {
          var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
          if (resp.getResponseCode() < 300) {
            var blob = resp.getBlob().setName(fileName);
            var file = driveFolder_().createFile(blob);
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
            driveFileId = file.getId();
            if (!fileSize) fileSize = blob.getBytes().length;
            filesCopied++;
          } else {
            fileFailures++;
          }
        } catch (err) {
          fileFailures++;
        }
      }
    }

    recordsSheet.appendRow([
      id,
      (p['DateTime'] && p['DateTime'].date) ? p['DateTime'].date.start : '',
      (p['Department'] && p['Department'].select) ? p['Department'].select.name : '',
      nRich_(page, 'UserID'),
      fileName,
      fileSize,
      driveFileId,
      nRich_(page, 'SyllabusText'),
      page.id,   // already in Notion — keeps syncPendingToNotion from duplicating it
      ''
    ]);
    seenRecords[String(id)] = true;
    recordsAdded++;
  });
  report.push('records: +' + recordsAdded + ' (files copied to Drive: ' + filesCopied +
              ', failed: ' + fileFailures + ')');

  Logger.log('MIGRATION COMPLETE — ' + report.join(' | '));
  return report;
}

// ── Notion read helpers ────────────────────────────────────────────────────

/** Every page in a database, following pagination. */
function nQueryAll_(databaseId, key) {
  var results = [], cursor = null;
  do {
    var body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    var resp = UrlFetchApp.fetch('https://api.notion.com/v1/databases/' + databaseId + '/query', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + key, 'Notion-Version': '2022-06-28' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    if (data.object === 'error') throw new Error('Notion query failed: ' + data.message);
    results = results.concat(data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return results;
}

function nTitle_(page, name) {
  var prop = page.properties[name];
  return prop && prop.title && prop.title.length ? prop.title[0].plain_text : '';
}

function nRich_(page, name) {
  var prop = page.properties[name];
  if (!prop || !prop.rich_text) return '';
  return prop.rich_text.map(function (t) { return t.plain_text; }).join('');
}
