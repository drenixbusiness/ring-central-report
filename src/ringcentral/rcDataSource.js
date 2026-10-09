// RingCentral endpoints used by the report. All read-only.
//
// Verified against the RingCentral OpenAPI spec (rc-platform.yml):
//  GET /restapi/v1.0/account/~/extension                         throttling: Medium, app scope ReadAccounts
//  GET /restapi/v1.0/account/~/phone-number                      throttling: Heavy,  app scope ReadAccounts
//  GET /restapi/v1.0/account/~/extension/{id}/call-log           throttling: Heavy,  app scope ReadCallLog
//      dateFrom/dateTo (ISO 8601), view=Simple (perPage max 1000), type=Voice, showDeleted
//  GET /restapi/v1.0/account/~/extension/{id}/message-store      throttling: Light,  app scope ReadMessages
//      dateFrom/dateTo filter by creationTime, messageType, direction, availability (multi-value)
// Pagination: page (1-based) + perPage, response navigation.nextPage / paging.

const ACCOUNT = '/restapi/v1.0/account/~';

export class RcDataSource {
  /** @param {{client: import('./rcClient.js').RcClient, config: object}} p */
  constructor({ client, config }) {
    this.client = client;
    this.config = config;
  }

  /** All Voice call-log records of one extension with startTime in [fromUtc, toUtc]. */
  async fetchCallLog(extensionId, fromUtc, toUtc) {
    const query = {
      dateFrom: fromUtc,
      dateTo: toUtc,
      view: 'Simple',
      type: 'Voice',
    };
    if (this.config.rc.includeDeletedCalls) query.showDeleted = true;
    return this.client.getAllPages(`${ACCOUNT}/extension/${encodeURIComponent(extensionId)}/call-log`, query, {
      perPage: this.config.rc.callLogPageSize,
      group: 'Heavy',
      endpoint: 'call-log',
      extensionId,
    });
  }

  /** Outbound SMS records of one extension with creationTime in [fromUtc, toUtc]. */
  async fetchOutboundSms(extensionId, fromUtc, toUtc) {
    const query = {
      dateFrom: fromUtc,
      dateTo: toUtc,
      messageType: ['SMS'],
      direction: ['Outbound'],
      // Messages the user deleted in the app were still sent; count them too.
      availability: ['Alive', 'Deleted', 'Purged'],
    };
    return this.client.getAllPages(`${ACCOUNT}/extension/${encodeURIComponent(extensionId)}/message-store`, query, {
      perPage: this.config.rc.messagePageSize,
      group: 'Light',
      endpoint: 'message-store',
      extensionId,
    });
  }

  async getExtension(extensionId) {
    return this.client.get(`${ACCOUNT}/extension/${encodeURIComponent(extensionId)}`, {}, { group: 'Light', endpoint: 'extension', extensionId });
  }

  async getCurrentExtension() {
    return this.client.get(`${ACCOUNT}/extension/~`, {}, { group: 'Light', endpoint: 'extension' });
  }

  async listExtensions(query = {}) {
    return this.client.getAllPages(`${ACCOUNT}/extension`, query, { perPage: 1000, group: 'Medium', endpoint: 'extension' });
  }

  async listCompanyPhoneNumbers() {
    return this.client.getAllPages(`${ACCOUNT}/phone-number`, {}, { perPage: 1000, group: 'Heavy', endpoint: 'phone-number' });
  }

  /** Single-record probe used by `npm run check`. */
  async probeCallLog(extensionId, fromUtc, toUtc) {
    return this.client.get(`${ACCOUNT}/extension/${encodeURIComponent(extensionId)}/call-log`, { dateFrom: fromUtc, dateTo: toUtc, view: 'Simple', perPage: 1 }, { group: 'Heavy', endpoint: 'call-log', extensionId });
  }

  async probeMessageStore(extensionId, fromUtc, toUtc) {
    return this.client.get(
      `${ACCOUNT}/extension/${encodeURIComponent(extensionId)}/message-store`,
      { dateFrom: fromUtc, dateTo: toUtc, messageType: ['SMS'], perPage: 1 },
      { group: 'Light', endpoint: 'message-store', extensionId },
    );
  }
}
