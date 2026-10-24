import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

const IDENTITY_EVENT = "admin:identity";

export function notifyIdentityChanged(): void {
  window.dispatchEvent(new Event(IDENTITY_EVENT));
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Stale-while-revalidate: the previous payload stays on screen while the
    // next one loads. Clearing it (the old behaviour) replaced the whole list
    // with a skeleton on every debounced keystroke, page turn and filter
    // change, which both flashed and jumped the scroll position.
    api<T>(path)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((requestError: ApiError) => {
        if (!cancelled) setError(requestError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, reloadKey]);

  useEffect(() => {
    const onIdentity = () => setReloadKey((key) => key + 1);
    window.addEventListener(IDENTITY_EVENT, onIdentity);
    return () => window.removeEventListener(IDENTITY_EVENT, onIdentity);
  }, []);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return { data, error, loading, retry };
}
