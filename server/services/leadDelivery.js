import { leadAdapters } from '../integrations/index.js';
import { notifyIntegrationFailure } from '../integrations/notifier.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'lead-worker' });

export async function dispatchLeadDelivery(lead) {
  const log = logger.child({ request_id: lead.request_id, correlation_id: lead.correlation_id || lead.request_id, lead_id: lead.id });
  const results = [];

  for (const adapter of leadAdapters) {
    const result = await adapter(lead);
    results.push(result);
    log.info('lead_delivery_adapter_result', { adapter: result.adapter, status: result.status, reason: result.reason, external_id: result.external_id || result.externalId || null });

    if (result.status === 'failed') {
      const notifyResult = await notifyIntegrationFailure({
        adapter: result.adapter,
        reason: result.reason,
        lead_id: lead.id,
        lead_email: lead.email,
        request_id: lead.request_id,
        correlation_id: lead.correlation_id || lead.request_id,
      });
      log.warn('lead_delivery_adapter_failed', { adapter: result.adapter, reason: result.reason, notifier_status: notifyResult?.status || 'unknown' });
    }
  }

  return {
    ok: results.every((item) => item.status !== 'failed'),
    results,
  };
}
