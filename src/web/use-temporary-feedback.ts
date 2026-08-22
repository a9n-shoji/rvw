import { useCallback, useEffect, useState } from "react";

export function useTemporaryFeedback(durationMs = 3_000): {
  feedback: string | null;
  showFeedback: (message: string) => void;
  clearFeedback: () => void;
} {
  const [current, setCurrent] = useState<{ message: string; revision: number } | null>(null);
  const showFeedback = useCallback((message: string): void => {
    setCurrent((previous) => ({ message, revision: (previous?.revision ?? 0) + 1 }));
  }, []);
  const clearFeedback = useCallback((): void => setCurrent(null), []);
  useEffect(() => {
    if (!current) return;
    const timeoutId = window.setTimeout(clearFeedback, durationMs);
    return () => window.clearTimeout(timeoutId);
  }, [clearFeedback, current, durationMs]);
  return { feedback: current?.message ?? null, showFeedback, clearFeedback };
}
