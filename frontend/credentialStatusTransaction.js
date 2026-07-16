export class CredentialStatusTransitionError extends Error {
  constructor(message, cause, transition) {
    super(message, { cause });
    this.name = 'CredentialStatusTransitionError';
    this.transition = transition;
    this.response = cause?.response;
  }
}

class CredentialStatusUncertainError extends Error {
  constructor(cause, reconciliationError) {
    super(
      `CPA status could not be reconciled after failure: ${String(cause?.message || cause)}; ${String(reconciliationError?.message || reconciliationError)}`,
      { cause },
    );
    this.name = 'CredentialStatusUncertainError';
    this.response = cause?.response;
    this.reconciliationError = reconciliationError;
  }
}

export function evaluateCredentialStatusTransitionPrecondition({
  previousDisabled,
  previousRuntimeState,
  expectedProbeAtMs,
  requireRuntimeOwnership = false,
  claimRuntimeOwnership = false,
  requireExactProbeVersion = false,
}) {
  const runtimeOwned = Boolean(previousRuntimeState?.disabled_by_runtime);
  const currentProbeAtMs = typeof previousRuntimeState?.last_probe_at === 'number'
    ? previousRuntimeState.last_probe_at
    : Number.NaN;
  const expectedAtMs = typeof expectedProbeAtMs === 'number' ? expectedProbeAtMs : Number.NaN;
  if (
    requireExactProbeVersion
    && (!Number.isFinite(expectedAtMs) || !Number.isFinite(currentProbeAtMs) || currentProbeAtMs !== expectedAtMs)
  ) {
    return { skipped: true, reason: 'probe_version_mismatch' };
  }
  if (
    Number.isFinite(expectedAtMs)
    && Number.isFinite(currentProbeAtMs)
    && currentProbeAtMs > expectedAtMs
  ) {
    return { skipped: true, reason: 'newer_probe_exists' };
  }
  if (requireRuntimeOwnership && !runtimeOwned) {
    return { skipped: true, reason: 'runtime_ownership_missing' };
  }
  if (claimRuntimeOwnership && Boolean(previousDisabled) && !runtimeOwned) {
    return { skipped: true, reason: 'credential_manually_disabled' };
  }
  return { skipped: false, reason: '' };
}

export function canCommitRuntimeArchive(runtimeState, expectedProbeAtMs) {
  return Boolean(runtimeState?.disabled_by_runtime)
    && Boolean(runtimeState?.archived_by_runtime)
    && typeof runtimeState?.last_probe_at === 'number'
    && Number.isFinite(runtimeState.last_probe_at)
    && runtimeState.last_probe_at === expectedProbeAtMs;
}

export function isSameCredentialIdentity(currentAuthIndex, expectedAuthIndex) {
  const current = String(currentAuthIndex || '').trim();
  const expected = String(expectedAuthIndex || '').trim();
  return Boolean(expected) && current === expected;
}

export async function executeCredentialStatusTransaction({
  previousDisabled,
  targetDisabled,
  previousRuntimeState,
  runtimeStatePatch,
  applyCredentialStatus,
  applyRuntimeState,
  restoreRuntimeState,
  readCredentialDisabled,
}) {
  const statusChanged = Boolean(previousDisabled) !== Boolean(targetDisabled);
  let runtimeCommitted = false;
  let credentialStatusCommitted = false;
  let nextRuntimeState = previousRuntimeState;

  const applyCredentialStatusConfirmed = async (disabled) => {
    try {
      await applyCredentialStatus(disabled);
      return;
    } catch (error) {
      if (typeof readCredentialDisabled !== 'function') {
        throw error;
      }
      let observedDisabled;
      try {
        observedDisabled = Boolean(await readCredentialDisabled());
      } catch (reconciliationError) {
        throw new CredentialStatusUncertainError(error, reconciliationError);
      }
      if (observedDisabled !== Boolean(disabled)) {
        throw error;
      }
    }
  };

  try {
    if (targetDisabled && runtimeStatePatch) {
      nextRuntimeState = await applyRuntimeState(runtimeStatePatch);
      runtimeCommitted = true;
    }
    if (statusChanged) {
      await applyCredentialStatusConfirmed(Boolean(targetDisabled));
      credentialStatusCommitted = true;
    }
    if (!targetDisabled && runtimeStatePatch) {
      nextRuntimeState = await applyRuntimeState(runtimeStatePatch);
      runtimeCommitted = true;
    }
    return {
      disabled: Boolean(targetDisabled),
      state: nextRuntimeState,
      statusChanged,
    };
  } catch (error) {
    if (error instanceof CredentialStatusUncertainError) {
      throw new CredentialStatusTransitionError(
        `Credential status transition failed: ${String(error.message || error)}`,
        error,
        {
          rolled_back: false,
          inconsistent: true,
          rollback_error: String(error.reconciliationError?.message || error.reconciliationError || ''),
        },
      );
    }
    const rollbackErrors = [];
    if (credentialStatusCommitted) {
      try {
        await applyCredentialStatusConfirmed(Boolean(previousDisabled));
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (runtimeCommitted) {
      try {
        await restoreRuntimeState(previousRuntimeState);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    throw new CredentialStatusTransitionError(
      `Credential status transition failed: ${String(error?.message || error)}`,
      error,
      {
        rolled_back: rollbackErrors.length === 0,
        inconsistent: rollbackErrors.length > 0,
        rollback_error: rollbackErrors.map((item) => String(item?.message || item)).join('; '),
      },
    );
  }
}
