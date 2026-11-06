'use strict';

/** Redacts every known credential before writing to VS Code's timestamped log. */
function createLogger(channel) {
  const secrets = new Set();
  let pattern;
  const redact = value => {
    let text = String(value?.message || value);
    // One pass, longest first: shorter credentials cannot reveal part of a
    // longer credential or modify a replacement marker from an earlier pass.
    if (pattern) text = text.replace(pattern, '[redacted]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  };
  return {
    protect(value) {
      if (!value || secrets.has(value)) return;
      secrets.add(value);
      const values = [...secrets].sort((a, b) => b.length - a.length);
      pattern = new RegExp(values.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    },
    info(value) { channel.info(redact(value)); },
    warn(value) { channel.warn(redact(value)); },
    error(value) { channel.error(redact(value)); },
    show() { channel.show(true); }
  };
}

module.exports = { createLogger };
