import { createLogger, maskPII } from '../utils/logger.js';

const CRM_TIMEOUT_MS = 5000;
const logger = createLogger({ service: 'crm-adapter', adapter: 'crm' });

export async function crmAdapter(lead) {
  const url = process.env.CRM_WEBHOOK_URL;
  const log = logger.child({ request_id: lead.request_id, correlation_id: lead.correlation_id || lead.request_id, lead_id: lead.id });

  if (!url) {
    return {
      adapter: 'crm',
      status: 'skipped',
      reason: 'CRM_WEBHOOK_URL is not configured',
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'lead.created',
        sent_at: new Date().toISOString(),
        lead,
      }),
      signal: AbortSignal.timeout(CRM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`CRM webhook failed (${response.status}) ${maskPII(body)}`.trim());
    }

    const data = await response.json().catch(() => ({}));
    const externalId = data?.id || data?.external_id || null;
    log.info('crm_webhook_sent', { status_code: response.status, external_id: externalId });

    return {
      adapter: 'crm',
      status: 'sent',
      externalId,
      external_id: externalId,
    };
  } catch (error) {
    log.error('crm_webhook_failed', { error });
    return {
      adapter: 'crm',
      status: 'failed',
      reason: error instanceof Error ? maskPII(error.message) : maskPII(String(error)),
    };
  }
}
