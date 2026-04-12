const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function levelEnabled(current, target) {
  const currentLevel = LEVELS[current] ?? LEVELS.info;
  return (LEVELS[target] ?? LEVELS.info) >= currentLevel;
}

function maskEmail(email = '') {
  const [local = '', domain = ''] = String(email).split('@');
  if (!domain) return '[redacted_email]';
  const safeLocal = local.length <= 2 ? `${local[0] || '*'}*` : `${local.slice(0, 1)}***${local.slice(-1)}`;
  const domainParts = domain.split('.');
  const root = domainParts.shift() || '';
  const tld = domainParts.join('.');
  const safeRoot = root.length <= 2 ? `${root[0] || '*'}*` : `${root.slice(0, 1)}***${root.slice(-1)}`;
  return `${safeLocal}@${safeRoot}${tld ? `.${tld}` : ''}`;
}

function maskPhone(input = '') {
  const s = String(input);
  const digits = s.replace(/\D/g, '');
  if (!digits) return '[redacted_phone]';
  const keep = digits.slice(-2);
  return `***${keep} (len:${digits.length})`;
}

function maskIp(ip = '') {
  const s = String(ip).trim();
  if (s.includes(':')) {
    const parts = s.split(':');
    return `${parts.slice(0, 2).join(':')}::[redacted]`;
  }
  const parts = s.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  return '[redacted_ip]';
}

function maskMessageSnippet(text = '') {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const snippet = s.slice(0, 24);
  return `${snippet}${s.length > 24 ? '…' : ''} [len:${s.length}]`;
}

function maskKnownString(value, key = '') {
  const lowerKey = String(key).toLowerCase();
  if (lowerKey.includes('email')) return maskEmail(value);
  if (lowerKey.includes('phone')) return maskPhone(value);
  if (lowerKey === 'ip' || lowerKey.endsWith('_ip') || lowerKey.includes('ip_address')) return maskIp(value);
  if (lowerKey.includes('message') || lowerKey.includes('body') || lowerKey.includes('text')) return maskMessageSnippet(value);

  const s = String(value);
  return s
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (m) => maskEmail(m))
    .replace(/\b(?:\+?\d[\d\s().-]{5,}\d)\b/g, (m) => maskPhone(m))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (m) => maskIp(m));
}

export function maskPII(value, key = '') {
  if (value == null) return value;
  if (typeof value === 'string') return maskKnownString(value, key);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskKnownString(value.message || '', key),
      stack: value.stack ? String(value.stack).split('\n').slice(0, 2).join('\n') : undefined,
    };
  }
  if (Array.isArray(value)) return value.map((v) => maskPII(v, key));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskPII(v, k);
    return out;
  }
  return String(value);
}

export function createLogger(baseContext = {}) {
  const configuredLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

  function emit(level, message, context = {}) {
    if (!levelEnabled(configuredLevel, level)) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...maskPII(baseContext),
      ...maskPII(context),
    };
    const line = JSON.stringify(entry);
    if (level === 'error') return console.error(line);
    if (level === 'warn') return console.warn(line);
    console.log(line);
  }

  return {
    child(context = {}) { return createLogger({ ...baseContext, ...context }); },
    debug(message, context = {}) { emit('debug', message, context); },
    info(message, context = {}) { emit('info', message, context); },
    warn(message, context = {}) { emit('warn', message, context); },
    error(message, context = {}) { emit('error', message, context); },
  };
}
