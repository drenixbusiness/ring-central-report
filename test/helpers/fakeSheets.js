// In-memory imitation of the subset of the Google Sheets v4 API that SheetWriter uses.
// Developer metadata is attached to a row object, so it "moves" with the row like
// the real API does when rows are inserted or sorted.

function parseRange(range) {
  const m = /^'((?:[^']|'')*)'!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(range);
  if (!m) throw new Error(`fake: unsupported range ${range}`);
  return { title: m[1].replace(/''/g, "'"), startRow: m[3] ? Number(m[3]) - 1 : 0, endRow: m[5] ? Number(m[5]) : null };
}

export class FakeSheets {
  constructor({ tabs = { Other: [['keep me']] } } = {}) {
    this.nextSheetId = 100;
    this.tabs = new Map(); // title -> { sheetId, rows: [{ cells: [], meta: [] }], rowCount }
    for (const [title, values] of Object.entries(tabs)) this.addTab(title, values);
    this.calls = [];
    this.failNext = {}; // method -> { error, afterApply }
    this.nextMetaId = 1;
    const self = this;

    this.spreadsheets = {
      get: async (params) => self.handle('get', params, () => ({
        data: { sheets: [...self.tabs.entries()].map(([title, t]) => ({ properties: { sheetId: t.sheetId, title, gridProperties: { rowCount: t.rowCount, columnCount: 26 } } })) },
      })),
      batchUpdate: async (params) => self.handle('batchUpdate', params, () => self.applyBatch(params.requestBody.requests)),
      values: {
        get: async (params) => self.handle('values.get', params, () => {
          const { title, startRow, endRow } = parseRange(params.range);
          const tab = self.tabs.get(title);
          if (!tab) throw Object.assign(new Error('Unable to parse range'), { response: { status: 400 } });
          const rows = tab.rows.slice(startRow, endRow ?? tab.rows.length).map((r) => r.cells.slice(0, 8));
          while (rows.length && rows[rows.length - 1].every((c) => c === '' || c === undefined)) rows.pop();
          return { data: { values: rows.length ? rows.map((r) => { const out = [...r]; while (out.length && (out[out.length - 1] === '' || out[out.length - 1] === undefined)) out.pop(); return out.map((c) => (c === undefined ? '' : c)); }) : undefined } };
        }),
        update: async (params) => self.handle('values.update', params, () => {
          const { title, startRow } = parseRange(params.range);
          const tab = self.tabs.get(title);
          params.requestBody.values.forEach((vals, i) => self.setCells(tab, startRow + i, vals));
          return { data: {} };
        }),
        batchUpdateByDataFilter: async (params) => self.handle('values.batchUpdateByDataFilter', params, () => {
          for (const d of params.requestBody.data) {
            const lk = d.dataFilter.developerMetadataLookup;
            for (const tab of self.tabs.values()) {
              tab.rows.forEach((row, idx) => {
                if (row.meta.some((m) => m.metadataKey === lk.metadataKey && m.metadataValue === lk.metadataValue)) self.setCells(tab, idx, d.values[0]);
              });
            }
          }
          return { data: {} };
        }),
      },
      developerMetadata: {
        search: async (params) => self.handle('developerMetadata.search', params, () => {
          const lk = params.requestBody.dataFilters[0].developerMetadataLookup;
          const matched = [];
          for (const tab of self.tabs.values()) {
            tab.rows.forEach((row, idx) => {
              for (const m of row.meta) {
                if (m.metadataKey !== lk.metadataKey) continue;
                if (lk.metadataValue && m.metadataValue !== lk.metadataValue) continue;
                matched.push({ developerMetadata: { ...m, location: { locationType: 'ROW', dimensionRange: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 } } } });
              }
            });
          }
          return { data: { matchedDeveloperMetadata: matched } };
        }),
      },
    };
  }

  addTab(title, values = []) {
    const rows = values.map((cells) => ({ cells: [...cells], meta: [] }));
    this.tabs.set(title, { sheetId: this.nextSheetId++, rows, rowCount: Math.max(1000, rows.length) });
  }

  tabById(sheetId) {
    for (const [title, t] of this.tabs) if (t.sheetId === sheetId) return { title, tab: t };
    throw Object.assign(new Error('no sheet'), { response: { status: 400 } });
  }

  ensureRow(tab, idx) {
    while (tab.rows.length <= idx) tab.rows.push({ cells: [], meta: [] });
  }

  setCells(tab, rowIdx, values) {
    if (rowIdx >= tab.rowCount) throw Object.assign(new Error('exceeds grid limits'), { response: { status: 400 } });
    this.ensureRow(tab, rowIdx);
    values.forEach((v, i) => {
      tab.rows[rowIdx].cells[i] = v;
    });
  }

  applyBatch(requests) {
    // Atomic: validate on a copy first.
    const snapshot = JSON.stringify([...this.tabs.entries()]);
    try {
      for (const r of requests) {
        if (r.addSheet) {
          if (this.tabs.has(r.addSheet.properties.title)) throw Object.assign(new Error('already exists'), { response: { status: 400 } });
          this.addTab(r.addSheet.properties.title, []);
        } else if (r.appendDimension) {
          const { tab } = this.tabById(r.appendDimension.sheetId);
          tab.rowCount += r.appendDimension.length;
        } else if (r.updateCells) {
          const { tab } = this.tabById(r.updateCells.start.sheetId);
          r.updateCells.rows.forEach((row, i) => {
            const vals = row.values.map((c) => (c.userEnteredValue.numberValue !== undefined ? c.userEnteredValue.numberValue : c.userEnteredValue.stringValue));
            this.setCells(tab, r.updateCells.start.rowIndex + i, vals);
          });
        } else if (r.createDeveloperMetadata) {
          const md = r.createDeveloperMetadata.developerMetadata;
          const { tab } = this.tabById(md.location.dimensionRange.sheetId);
          this.ensureRow(tab, md.location.dimensionRange.startIndex);
          tab.rows[md.location.dimensionRange.startIndex].meta.push({ metadataId: this.nextMetaId++, metadataKey: md.metadataKey, metadataValue: md.metadataValue, visibility: md.visibility });
        } else {
          throw new Error(`fake: unsupported request ${Object.keys(r)[0]}`);
        }
      }
    } catch (err) {
      const restored = JSON.parse(snapshot);
      this.tabs = new Map(restored);
      throw err;
    }
    return { data: {} };
  }

  async handle(method, params, fn) {
    this.calls.push(method);
    const failure = this.failNext[method];
    if (failure) {
      delete this.failNext[method];
      if (failure.afterApply) await fn();
      throw failure.error;
    }
    return fn();
  }

  /** Values of a tab as a 2-D array (for assertions). */
  dump(title) {
    return this.tabs.get(title).rows.map((r) => [...r.cells]);
  }

  /** Simulates a user sorting data rows (row 2..n) by a column, metadata moves with rows. */
  sortDataRows(title, compare) {
    const tab = this.tabs.get(title);
    const [header, ...rest] = tab.rows;
    rest.sort(compare);
    tab.rows = [header, ...rest];
  }
}

export function timeoutError() {
  const err = new Error('network timeout at: https://sheets.googleapis.com/');
  err.code = 'ETIMEDOUT';
  return err;
}
