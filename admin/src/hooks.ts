import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

const IDENTITY_EVENT = "admin:identity";

export function notifyIdentityChanged(): void {
  window.dispatchEvent(new Event(IDENTITY_EVENT));
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    setData(null);
    setError(null);
    api<T>(path)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((requestError: ApiError) => {
        if (!cancelled) setError(requestError);
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

  return { data, error, retry };
}
