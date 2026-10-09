export class RcApiError extends Error {
  /**
   * @param {object} p
   * @param {number|null} p.status HTTP status, null for network errors
   * @param {string} [p.errorCode] RingCentral errorCode (e.g. CMN-408) when present
   * @param {string} p.message human readable, never contains credentials
   * @param {string} [p.endpoint] logical endpoint name (call-log, message-store, ...)
   * @param {string} [p.extensionId]
   */
  constructor({ status = null, errorCode = '', message, endpoint = '', extensionId = '' }) {
    super(message);
    this.name = 'RcApiError';
    this.status = status;
    this.errorCode = errorCode;
    this.endpoint = endpoint;
    this.extensionId = extensionId;
  }

  /** Stable code stored in state and logs, e.g. RC_403, RC_NETWORK. */
  get code() {
    if (this.status === null) return 'RC_NETWORK';
    return `RC_${this.status}`;
  }

  get isPermissionError() {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Explains what access is missing, without suggesting ways around it.
 */
export function permissionGuidance(err) {
  if (!(err instanceof RcApiError)) return '';
  const ext = err.extensionId ? ` for extensionId ${err.extensionId}` : '';
  if (err.status === 401) {
    return `RingCentral rejected the credentials${ext}. Verify RC_CLIENT_ID, RC_CLIENT_SECRET and RC_JWT, that the JWT credential is not expired/revoked, and that the app is allowed to use the JWT auth flow in production.`;
  }
  if (err.status !== 403) return '';
  if (err.endpoint === 'call-log') {
    return `Access denied to the call log${ext}. Required: the app has the "ReadCallLog" scope AND the user who owns RC_JWT has a role that can read other users' call logs (e.g. Super Admin, or a custom role with company call log access covering this extension). App scopes alone do not grant mailbox access.`;
  }
  if (err.endpoint === 'message-store') {
    return `Access denied to the message store${ext}. Required: the app has the "ReadMessages" scope AND the RC_JWT user is permitted to read this user's messages. If an admin JWT cannot read other users' mailboxes in your account, use an officially supported method instead: a JWT credential issued for an authorized user of that mailbox, or RingCentral's account-level Message Store Report (export) API, which requires the "ReadMessages" scope and admin "Users" permission. Do not share user passwords.`;
  }
  if (err.endpoint === 'extension' || err.endpoint === 'phone-number') {
    return `Access denied to account data${ext}. Required: the app has the "ReadAccounts" scope and the RC_JWT user has permission to view extensions / company phone numbers.`;
  }
  return `Access denied${ext}. Check the app scopes and the RC_JWT user's role.`;
}
