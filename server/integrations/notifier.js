import { createLogger, maskPII } from '../utils/logger.js';

const NOTIFIER_TIMEOUT_MS = 5000;
const logger = createLogger({ service: 'fallback-notifier', channel: 'fallback_notifier' });

export async function notifyIntegrationFailure(event) {
  const url = process.env.NOTIFIER_WEBHOOK_URL;
  const log = logger.child({ request_id: event.request_id, correlation_id: event.correlation_id || event.request_id, lead_id: event.lead_id });

  if (!url) {
    return {
      channel: 'fallback_notifier',
      status: 'skipped',
      reason: 'NOTIFIER_WEBHOOK_URL is not configured',
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'lead.delivery.failed',
        sent_at: new Date().toISOString(),
        ...event,
      }),
      signal: AbortSignal.timeout(NOTIFIER_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`fallback notifier failed (${response.status})`);
    }

    log.info('fallback_notifier_sent', { adapter: event.adapter, status_code: response.status, event });
    return {
      channel: 'fallback_notifier',
      status: 'sent',
    };
  } catch (error) {
    log.error('fallback_notifier_failed', { error, event: maskPII(event) });
    return {
      channel: 'fallback_notifier',
      status: 'failed',
      reason: error instanceof Error ? maskPII(error.message) : maskPII(String(error)),
    };
  }
}
