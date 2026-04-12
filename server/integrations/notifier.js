const NOTIFIER_TIMEOUT_MS = 5000;

export async function notifyIntegrationFailure(event) {
  const url = process.env.NOTIFIER_WEBHOOK_URL;

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

    return {
      channel: 'fallback_notifier',
      status: 'sent',
    };
  } catch (error) {
    return {
      channel: 'fallback_notifier',
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
