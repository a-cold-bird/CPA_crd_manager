import { useCallback, useRef } from 'react';

export function useRunLock() {
  const lockSetRef = useRef<Set<string>>(new Set());

  const isLocked = useCallback((key: string) => lockSetRef.current.has(key), []);

  const runWithLock = useCallback(async <T>(key: string, runner: () => Promise<T>): Promise<T | null> => {
    if (lockSetRef.current.has(key)) {
      return null;
    }

    lockSetRef.current.add(key);
    try {
      return await runner();
    } finally {
      lockSetRef.current.delete(key);
    }
  }, []);

  return {
    isLocked,
    runWithLock,
  };
}
