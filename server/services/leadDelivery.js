import { leadAdapters } from '../integrations/index.js';
import { notifyIntegrationFailure } from '../integrations/notifier.js';

export async function dispatchLeadDelivery(lead) {
  const results = [];

  for (const adapter of leadAdapters) {
    const result = await adapter(lead);
    results.push(result);

    if (result.status === 'failed') {
      await notifyIntegrationFailure({
        adapter: result.adapter,
        reason: result.reason,
        lead_id: lead.id,
        lead_email: lead.email,
      });
    }
  }

  return {
    ok: results.every((item) => item.status !== 'failed'),
    results,
  };
}
