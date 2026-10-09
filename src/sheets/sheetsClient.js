import fs from 'node:fs';
import { auth, sheets } from '@googleapis/sheets';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Google Sheets v4 client authenticated as the service account (key file or inline .env key). */
export function createSheetsApi(googleConfig) {
  const options = googleConfig.inlineCredentials
    ? { credentials: googleConfig.inlineCredentials, scopes: [SHEETS_SCOPE] }
    : { keyFile: googleConfig.credentialsPath, scopes: [SHEETS_SCOPE] };
  return sheets({ version: 'v4', auth: new auth.GoogleAuth(options) });
}

/** Service account e-mail (to share the spreadsheet with). Never returns key material. */
export function readServiceAccountEmail(googleConfig) {
  if (googleConfig.inlineCredentials) {
    return { email: googleConfig.inlineCredentials.client_email || null, type: 'service_account' };
  }
  try {
    const json = JSON.parse(fs.readFileSync(googleConfig.credentialsPath, 'utf8'));
    return { email: json.client_email || null, type: json.type || null };
  } catch (err) {
    return { email: null, type: null, error: err.message };
  }
}
