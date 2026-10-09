// Read-only: lists RingCentral extensions to help fill hr.config.json.
//   npm run list-extensions                 (User extensions)
//   npm run list-extensions -- --all        (every extension type)
//   npm run list-extensions -- --json       (JSON with hr.config.json skeleton entries)
// NOTE: "ExtensionId" (long, internal) is what hr.config.json needs, not the short "Ext #".

import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, loadDotenv } from '../config.js';
import { createLogger } from '../logger.js';
import { createRingCentral } from '../app.js';
import { permissionGuidance } from '../ringcentral/errors.js';
import { printTable } from './table.js';

const { values: args } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

loadDotenv();
let config;
try {
  // Only RingCentral settings are needed here.
  config = loadConfig({ ...process.env, REPORT_START_DATE: process.env.REPORT_START_DATE || '2000-01-01' }, { needSheets: false });
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  throw err;
}
const logger = createLogger({ level: config.logLevel === 'debug' ? 'debug' : 'warn' });
const { dataSource } = createRingCentral(config, logger);

try {
  const query = args.all ? {} : { type: ['User'] };
  const extensions = await dataSource.listExtensions(query);

  const numbersByExt = new Map();
  let numbersNote = '';
  try {
    for (const n of await dataSource.listCompanyPhoneNumbers()) {
      const extId = n?.extension?.id ? String(n.extension.id) : null;
      if (!extId || !n.phoneNumber) continue;
      if (!numbersByExt.has(extId)) numbersByExt.set(extId, []);
      numbersByExt.get(extId).push({ phoneNumber: n.phoneNumber, usageType: n.usageType, type: n.type });
    }
  } catch (err) {
    numbersNote = `Phone numbers could not be loaded (${err.message}). ${permissionGuidance(err)}`;
  }

  const rows = extensions
    .map((e) => {
      const numbers = numbersByExt.get(String(e.id)) || [];
      const direct = numbers.filter((n) => n.usageType === 'DirectNumber');
      return {
        extensionId: String(e.id),
        extensionNumber: e.extensionNumber ?? '',
        name: e.name || [e.contact?.firstName, e.contact?.lastName].filter(Boolean).join(' '),
        type: e.type ?? '',
        status: e.status ?? '',
        numbers: (direct.length ? direct : numbers).map((n) => n.phoneNumber),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        rows.map((r) => ({
          ...r,
          hrConfigSkeleton: { extensionId: r.extensionId, name: r.name, phoneNumber: r.numbers[0] || '+1XXXXXXXXXX', reportStartDate: 'YYYY-MM-DD', reportEndDate: null },
        })),
        null,
        2,
      )}\n`,
    );
  } else {
    printTable(
      rows.map((r) => ({ ...r, numbers: r.numbers.join(', ') })),
      [
        { key: 'extensionId', title: 'ExtensionId (use this)' },
        { key: 'extensionNumber', title: 'Ext #' },
        { key: 'name', title: 'Name' },
        { key: 'type', title: 'Type' },
        { key: 'status', title: 'Status' },
        { key: 'numbers', title: 'Phone numbers' },
      ],
    );
    process.stdout.write(`\n${rows.length} extension(s).\n`);
  }
  if (numbersNote) process.stderr.write(`\n${numbersNote}\n`);
  process.exit(0);
} catch (err) {
  process.stderr.write(`Failed to list extensions: ${err.message}\n`);
  const guidance = permissionGuidance(err);
  if (guidance) process.stderr.write(`${guidance}\n`);
  process.exit(1);
}
