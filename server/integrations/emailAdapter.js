function hasSmtpConfig() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export async function emailAdapter(_lead) {
  if (!hasSmtpConfig()) {
    return {
      adapter: 'email',
      status: 'skipped',
      reason: 'SMTP_HOST/SMTP_USER/SMTP_PASS are not fully configured',
    };
  }

  // Safe scaffold: SMTP config may exist, but delivery wiring is intentionally a no-op for now.
  return {
    adapter: 'email',
    status: 'skipped',
    reason: 'email adapter scaffold only (no-op until SMTP sender is implemented)',
  };
}
