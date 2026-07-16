export function createKeyedOperationQueue() {
  const operationTails = new Map();

  return (key, operation) => {
    const previous = operationTails.get(key) || Promise.resolve();
    const current = previous.then(operation);
    let tracked;
    const cleanup = () => {
      if (operationTails.get(key) === tracked) {
        operationTails.delete(key);
      }
    };
    tracked = current.then(cleanup, cleanup);
    operationTails.set(key, tracked);
    return current;
  };
}

export function createKeyedInFlightDeduper() {
  const inFlight = new Map();

  return (key, operation) => {
    const pending = inFlight.get(key);
    if (pending) {
      return pending;
    }
    const current = Promise.resolve().then(operation);
    inFlight.set(key, current);
    const cleanup = () => {
      if (inFlight.get(key) === current) {
        inFlight.delete(key);
      }
    };
    current.then(cleanup, cleanup);
    return current;
  };
}
