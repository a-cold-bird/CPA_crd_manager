export function hasRuntimeOwnershipForCredential(credential, runtimeEntry) {
  const credentialAuthIndex = String(credential?.auth_index || '').trim();
  const runtimeAuthIndex = String(runtimeEntry?.auth_index || '').trim();
  return Boolean(runtimeEntry?.disabled_by_runtime)
    && Boolean(credentialAuthIndex)
    && credentialAuthIndex === runtimeAuthIndex;
}

export function canProbeCredentialInRuntime(credential, runtimeEntry) {
  if (!credential?.name) return false;
  return !Boolean(credential.disabled) || hasRuntimeOwnershipForCredential(credential, runtimeEntry);
}

export function shouldAutoEnableRecoveredCredential(credential, runtimeEntry, status) {
  return status === 'active'
    && Boolean(credential?.disabled)
    && hasRuntimeOwnershipForCredential(credential, runtimeEntry);
}

export function selectCredentialsForProbe(credentials, {
  archivedNameSet,
  bucketCredentials,
  nowMs,
  normalIntervalMs,
  cursorName,
  maxPerCycle,
  resolveDueAtMs,
}) {
  const archived = archivedNameSet instanceof Set ? archivedNameSet : new Set();
  const bucket = bucketCredentials && typeof bucketCredentials === 'object' ? bucketCredentials : {};
  const limit = Math.max(1, Number(maxPerCycle) || 1);
  const entries = (Array.isArray(credentials) ? credentials : [])
    .filter((credential) => credential?.name && !archived.has(credential.name))
    .map((credential) => ({
      credential,
      name: String(credential.name),
      dueAtMs: Number(resolveDueAtMs(credential, bucket[credential.name] || {}, normalIntervalMs)) || 0,
    }));

  if (entries.length === 0) {
    return { selected: [], nextCursorName: String(cursorName || '') };
  }

  const dueEntries = [...entries]
    .filter((entry) => entry.dueAtMs <= nowMs)
    .sort((left, right) => (left.dueAtMs - right.dueAtMs) || left.name.localeCompare(right.name));
  const selected = dueEntries.slice(0, limit).map((entry) => entry.credential);

  const lastSelected = selected.length > 0 ? selected[selected.length - 1] : null;
  return {
    selected,
    nextCursorName: String(lastSelected?.name || cursorName || ''),
  };
}
