import { useEffect, useRef } from 'react';

export function useLockedInterval(
  task: () => Promise<void> | void,
  intervalMs: number,
  enabled: boolean,
  runImmediately: boolean = false,
) {
  const taskRef = useRef(task);
  const runningRef = useRef(false);

  useEffect(() => {
    taskRef.current = task;
  }, [task]);

  useEffect(() => {
    if (!enabled || intervalMs <= 0) {
      return;
    }

    let cancelled = false;

    const run = async () => {
      if (cancelled || runningRef.current) {
        return;
      }
      runningRef.current = true;
      try {
        await taskRef.current();
      } finally {
        runningRef.current = false;
      }
    };

    if (runImmediately) {
      void run();
    }

    const timer = window.setInterval(() => {
      void run();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs, runImmediately]);
}
