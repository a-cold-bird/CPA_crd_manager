export function createKeyedAsyncRequestCache({ ttlMs = 0, clone = (value) => value, now = Date.now } = {}) {
  const entries = new Map();
  const inFlight = new Map();
  const queuedRefreshes = new Map();
  const versions = new Map();

  const get = async (key, loader, { maxAgeMs = ttlMs } = {}) => {
    const cached = entries.get(key);
    if (cached && maxAgeMs >= 0 && now() - cached.at <= maxAgeMs) {
      return clone(cached.value);
    }

    const version = versions.get(key) || 0;
    const pending = inFlight.get(key);
    if (pending?.version === version) {
      return clone(await pending.promise);
    }
    if (pending) {
      let queued = queuedRefreshes.get(key);
      if (!queued) {
        let queuedEntry;
        const promise = pending.promise
          .catch(() => undefined)
          .then(() => {
            if (queuedRefreshes.get(key) === queuedEntry) {
              queuedRefreshes.delete(key);
            }
            return get(key, loader, { maxAgeMs });
          });
        queuedEntry = { promise };
        queued = queuedEntry;
        queuedRefreshes.set(key, queued);
        promise.finally(() => {
          if (queuedRefreshes.get(key) === queued) {
            queuedRefreshes.delete(key);
          }
        }).catch(() => {});
      }
      return clone(await queued.promise);
    }

    const operation = Promise.resolve()
      .then(loader)
      .then((value) => {
        if ((versions.get(key) || 0) === version) {
          entries.set(key, { value, at: now() });
        }
        return value;
      });
    const pendingOperation = { version, promise: operation };
    inFlight.set(key, pendingOperation);
    try {
      return clone(await operation);
    } finally {
      if (inFlight.get(key) === pendingOperation) {
        inFlight.delete(key);
      }
    }
  };

  return {
    get,
    invalidate: (key) => {
      versions.set(key, (versions.get(key) || 0) + 1);
      entries.delete(key);
    },
  };
}
