// Upserts report rows into the "RING CENTRAL" tab.
//
// Row identity: reportDate + RingCentral extensionId, stored as ROW-level
// developer metadata (key METADATA_KEY, value "YYYY-MM-DD|extensionId",
// visibility DOCUMENT). Developer metadata moves with the row when rows are
// sorted, inserted or deleted, so we never rely on row numbers or HR names.
//
// Writes:
//  * existing rows: values.batchUpdateByDataFilter (by metadata) -> idempotent
//  * new rows: ONE spreadsheets.batchUpdate (atomic) containing
//      [appendDimension if the grid is full] + updateCells + createDeveloperMetadata
//    If that call fails ambiguously (timeout/5xx/network), the key map is re-read
//    and only the rows that are still missing are retried. No blind re-append.
//  * values are written RAW / as typed cell values, so text (e.g. "+1312...",
//    "=..." ) is never parsed as a formula or number.
// Only columns A:H of our own rows are written. Other tabs, formats and cells are untouched.

import { backoffDelay, sleep as realSleep } from '../util/async.js';

export const HEADERS = Object.freeze([
  'Date',
  'HR name',
  "HR's phone number",
  'Total inbound calls',
  'Total outbounds calls',
  'Total missed calls',
  'Total calls',
  'Total SMS send',
]);

export const METADATA_KEY = 'rc-hr-daily-report:row-key';

export function rowKey(reportDate, extensionId) {
  return `${reportDate}|${extensionId}`;
}

export class SheetHeaderError extends Error {
  constructor(sheetName, actual) {
    const lines = HEADERS.map((expected, i) => {
      const got = actual[i] ?? '';
      const col = String.fromCharCode(65 + i);
      return `${col}1 expected "${expected}" found "${got}"${String(got).trim() === expected ? '' : '  <-- mismatch'}`;
    });
    super(`Header row of tab "${sheetName}" does not match the expected layout. Nothing was written. Fix row 1 manually (or point GOOGLE_SHEET_NAME to another tab):\n  ${lines.join('\n  ')}`);
    this.name = 'SheetHeaderError';
    this.code = 'SHEETS_HEADER_MISMATCH';
    this.actual = actual;
  }
}

export class SheetsWriteError extends Error {
  constructor(message, { code = 'SHEETS_WRITE_FAILED', cause } = {}) {
    super(message, { cause });
    this.name = 'SheetsWriteError';
    this.code = code;
  }
}

function httpStatus(err) {
  return err?.response?.status ?? err?.status ?? (Number.isInteger(err?.code) ? err.code : null);
}

/** Errors after which we cannot know whether the server applied the request. */
export function isAmbiguousOrTransient(err) {
  const status = httpStatus(err);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  if (status) return false;
  const code = String(err?.code || '');
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'UND_ERR_SOCKET'].includes(code) || err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timeout/i.test(err?.message || '');
}

export function quoteSheetName(name) {
  return `'${String(name).replace(/'/g, "''")}'`;
}

/** Row values for columns A:H. */
export function toRowValues(row) {
  return [
    String(row.reportDate),
    String(row.hrName),
    String(row.phoneNumber),
    Math.trunc(row.inbound),
    Math.trunc(row.outbound),
    Math.trunc(row.missed),
    Math.trunc(row.total),
    Math.trunc(row.sms),
  ];
}

function toCellData(value) {
  return typeof value === 'number' ? { userEnteredValue: { numberValue: value } } : { userEnteredValue: { stringValue: value } };
}

export class SheetWriter {
  /**
   * @param {object} p
   * @param {object} p.api googleapis sheets_v4.Sheets client (or a compatible fake)
   */
  constructor({ api, spreadsheetId, sheetName, logger, maxAttempts = 4, requestTimeoutMs = 60000, sleep = realSleep }) {
    this.api = api;
    this.spreadsheetId = spreadsheetId;
    this.sheetName = sheetName;
    this.logger = logger;
    this.maxAttempts = maxAttempts;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sleep = sleep;
  }

  reqOpts() {
    return { timeout: this.requestTimeoutMs };
  }

  async getSheetProps() {
    const res = await this.api.spreadsheets.get(
      { spreadsheetId: this.spreadsheetId, fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))' },
      this.reqOpts(),
    );
    const sheet = (res.data.sheets || []).find((s) => s.properties?.title === this.sheetName);
    return sheet ? sheet.properties : null;
  }

  /** Read-only inspection used by `npm run check`. */
  async inspect() {
    const props = await this.getSheetProps();
    if (!props) return { exists: false };
    const headers = await this.readHeaders();
    return { exists: true, sheetId: props.sheetId, headers, headerStatus: this.headerStatus(headers) };
  }

  async readHeaders() {
    const res = await this.api.spreadsheets.values.get(
      { spreadsheetId: this.spreadsheetId, range: `${quoteSheetName(this.sheetName)}!A1:H1`, valueRenderOption: 'FORMATTED_VALUE' },
      this.reqOpts(),
    );
    return (res.data.values && res.data.values[0]) || [];
  }

  headerStatus(actual) {
    if (!actual.length || actual.every((v) => String(v ?? '').trim() === '')) return 'empty';
    const ok = HEADERS.every((h, i) => String(actual[i] ?? '').trim() === h);
    return ok ? 'ok' : 'mismatch';
  }

  /** Creates the tab if missing, writes headers into an empty row 1, rejects mismatching headers. */
  async prepare() {
    let props = await this.getSheetProps();
    if (!props) {
      this.logger?.info('Sheet tab not found, creating it', { sheetName: this.sheetName });
      try {
        await this.api.spreadsheets.batchUpdate(
          { spreadsheetId: this.spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: this.sheetName } } }] } },
          this.reqOpts(),
        );
      } catch (err) {
        // A concurrent/timed-out creation may already have succeeded.
        props = await this.getSheetProps();
        if (!props) throw err;
      }
      props = props || (await this.getSheetProps());
      if (!props) throw new SheetsWriteError(`Could not create tab "${this.sheetName}"`, { code: 'SHEETS_TAB_CREATE_FAILED' });
    }

    const headers = await this.readHeaders();
    const status = this.headerStatus(headers);
    if (status === 'mismatch') throw new SheetHeaderError(this.sheetName, headers);
    if (status === 'empty') {
      await this.api.spreadsheets.values.update(
        {
          spreadsheetId: this.spreadsheetId,
          range: `${quoteSheetName(this.sheetName)}!A1:H1`,
          valueInputOption: 'RAW',
          requestBody: { values: [HEADERS.slice()] },
        },
        this.reqOpts(),
      );
      this.logger?.info('Header row written', { sheetName: this.sheetName });
    }
    return props;
  }

  /** key -> sorted row indexes (0-based) for our metadata in this sheet. */
  async loadKeyMap(sheetId) {
    const res = await this.api.spreadsheets.developerMetadata.search(
      {
        spreadsheetId: this.spreadsheetId,
        requestBody: { dataFilters: [{ developerMetadataLookup: { metadataKey: METADATA_KEY, locationType: 'ROW' } }] },
      },
      this.reqOpts(),
    );
    const map = new Map();
    for (const m of res.data.matchedDeveloperMetadata || []) {
      const md = m.developerMetadata;
      const range = md?.location?.dimensionRange;
      if (!md || !range || range.sheetId !== sheetId) continue;
      if (!map.has(md.metadataValue)) map.set(md.metadataValue, []);
      map.get(md.metadataValue).push(range.startIndex);
    }
    for (const rows of map.values()) rows.sort((a, b) => a - b);
    return map;
  }

  async nextFreeRowIndex(keyMap) {
    const res = await this.api.spreadsheets.values.get(
      { spreadsheetId: this.spreadsheetId, range: `${quoteSheetName(this.sheetName)}!A:H`, majorDimension: 'ROWS' },
      this.reqOpts(),
    );
    const usedByValues = (res.data.values || []).length;
    let maxMeta = -1;
    for (const rows of keyMap.values()) for (const r of rows) maxMeta = Math.max(maxMeta, r);
    return Math.max(1, usedByValues, maxMeta + 1);
  }

  async withRetry(label, fn) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isAmbiguousOrTransient(err) || attempt >= this.maxAttempts) throw err;
        const delay = backoffDelay(attempt);
        this.logger?.warn('Google Sheets transient error, retrying', { operation: label, attempt, delayMs: delay, errorCode: err?.code || httpStatus(err) });
        await this.sleep(delay);
      }
    }
  }

  async updateByMetadata(rows) {
    if (!rows.length) return;
    await this.withRetry('update-rows', () =>
      this.api.spreadsheets.values.batchUpdateByDataFilter(
        {
          spreadsheetId: this.spreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: rows.map((row) => ({
              dataFilter: { developerMetadataLookup: { metadataKey: METADATA_KEY, metadataValue: row.key, locationType: 'ROW' } },
              majorDimension: 'ROWS',
              values: [toRowValues(row)],
            })),
          },
        },
        this.reqOpts(),
      ),
    );
  }

  async insertRows(sheetId, rows, keyMap) {
    let pending = rows;
    let map = keyMap;
    for (let attempt = 1; pending.length; attempt += 1) {
      const props = await this.getSheetProps();
      if (!props || props.sheetId !== sheetId) throw new SheetsWriteError(`Tab "${this.sheetName}" disappeared during write`, { code: 'SHEETS_TAB_MISSING' });
      const startRow = await this.nextFreeRowIndex(map);
      const rowCount = props.gridProperties?.rowCount ?? 0;
      const requests = [];
      const needed = startRow + pending.length - rowCount;
      if (needed > 0) requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: needed } });
      requests.push({
        updateCells: {
          start: { sheetId, rowIndex: startRow, columnIndex: 0 },
          rows: pending.map((row) => ({ values: toRowValues(row).map(toCellData) })),
          fields: 'userEnteredValue',
        },
      });
      pending.forEach((row, i) => {
        requests.push({
          createDeveloperMetadata: {
            developerMetadata: {
              metadataKey: METADATA_KEY,
              metadataValue: row.key,
              visibility: 'DOCUMENT',
              location: { dimensionRange: { sheetId, dimension: 'ROWS', startIndex: startRow + i, endIndex: startRow + i + 1 } },
            },
          },
        });
      });

      try {
        await this.api.spreadsheets.batchUpdate({ spreadsheetId: this.spreadsheetId, requestBody: { requests } }, this.reqOpts());
        return;
      } catch (err) {
        if (!isAmbiguousOrTransient(err) || attempt >= this.maxAttempts) {
          throw new SheetsWriteError(`Inserting ${pending.length} row(s) failed: ${err.message}`, { code: 'SHEETS_INSERT_FAILED', cause: err });
        }
        // Do not re-append blindly: find out what actually landed.
        this.logger?.warn('Google Sheets insert outcome unknown, verifying before retry', { attempt, rows: pending.length, errorCode: err?.code || httpStatus(err) });
        await this.sleep(backoffDelay(attempt));
        map = await this.withRetry('verify-keys', () => this.loadKeyMap(sheetId));
        const landed = pending.filter((row) => map.has(row.key));
        if (landed.length) await this.updateByMetadata(landed);
        pending = pending.filter((row) => !map.has(row.key));
      }
    }
  }

  /**
   * @param {Array<{reportDate:string, extensionId:string, hrName:string, phoneNumber:string, inbound:number, outbound:number, missed:number, total:number, sms:number}>} rows
   * @returns {Promise<{updated:string[], inserted:string[], duplicates:string[]}>}
   */
  async upsertRows(rows) {
    const keyed = rows.map((r) => ({ ...r, key: rowKey(r.reportDate, r.extensionId) }));
    const props = await this.withRetry('prepare', () => this.prepare());
    const keyMap = await this.withRetry('load-keys', () => this.loadKeyMap(props.sheetId));

    const duplicates = [...keyMap.entries()].filter(([, idx]) => idx.length > 1).map(([k]) => k);
    if (duplicates.length) {
      this.logger?.warn('Several rows carry the same report key; all of them are kept in sync. Delete the extra rows manually.', { keys: duplicates.slice(0, 20), count: duplicates.length });
    }

    const toUpdate = keyed.filter((r) => keyMap.has(r.key));
    const toInsert = keyed.filter((r) => !keyMap.has(r.key));
    await this.updateByMetadata(toUpdate);
    if (toInsert.length) await this.insertRows(props.sheetId, toInsert, keyMap);
    return { updated: toUpdate.map((r) => r.key), inserted: toInsert.map((r) => r.key), duplicates };
  }
}
