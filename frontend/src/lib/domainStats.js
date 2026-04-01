function extractEmailDomain(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex <= 0 || atIndex >= normalized.length - 1) return '';
  return normalized.slice(atIndex + 1);
}

function isTerminalAccountStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'registered'
    || normalized === 'codex_failed'
    || normalized === 'register_failed'
    || normalized === 'upload_failed'
    || normalized === 'completed';
}

function matchConfiguredDomain(actualDomain, configuredDomains) {
  const normalizedActual = String(actualDomain || '').trim().toLowerCase();
  if (!normalizedActual) return '';

  for (const configuredDomain of configuredDomains || []) {
    const normalizedConfigured = String(configuredDomain || '').trim().toLowerCase();
    if (!normalizedConfigured) continue;
    if (!normalizedConfigured.startsWith('*.')) {
      if (normalizedConfigured === normalizedActual) return normalizedConfigured;
      continue;
    }
    const suffix = normalizedConfigured.slice(2);
    if (normalizedActual === suffix) continue;
    if (normalizedActual.endsWith(`.${suffix}`)) return normalizedConfigured;
  }

  return normalizedActual;
}

export function buildEmailDomainStats(batches, configuredDomains) {
  const stats = {};
  for (const batch of batches || []) {
    for (const account of batch?.accounts || []) {
      const actualDomain = extractEmailDomain(account?.email || '');
      if (!actualDomain || !isTerminalAccountStatus(account?.status || '')) continue;
      const groupDomain = matchConfiguredDomain(actualDomain, configuredDomains);
      if (!groupDomain) continue;
      const current = stats[groupDomain] || { total: 0, success: 0, fail: 0 };
      current.total += 1;
      if (account?.register_ok && account?.codex_ok) current.success += 1;
      else current.fail += 1;
      stats[groupDomain] = current;
    }
  }
  return stats;
}
