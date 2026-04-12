const CRM_TIMEOUT_MS = 5000;

export async function crmAdapter(lead) {
  const url = process.env.CRM_WEBHOOK_URL;

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
      throw new Error(`CRM webhook failed (${response.status}) ${body}`.trim());
    }

    const data = await response.json().catch(() => ({}));

    return {
      adapter: 'crm',
      status: 'sent',
      externalId: data?.id || data?.external_id || null,
    };
  } catch (error) {
    return {
      adapter: 'crm',
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
