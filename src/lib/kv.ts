// Typed KV cache helpers. KV holds the precomputed homepage payload so the
// public page never blocks on D1. Keys are namespaced by purpose + locale.

import type { Env, Lang } from './types';

/** Stable cache keys. Bump the version suffix to invalidate everything at once. */
export const CACHE_KEYS = {
  homepage: (lang: Lang) => `home:v1:${lang}`,
} as const;

export async function getCached<T>(env: Env, key: string): Promise<T | null> {
  return env.KV_CACHE.get<T>(key, 'json');
}

export async function setCached<T>(
  env: Env,
  key: string,
  value: T,
  ttlSeconds = 3600
): Promise<void> {
  await env.KV_CACHE.put(key, JSON.stringify(value), {
    expirationTtl: ttlSeconds,
  });
}

export async function deleteCached(env: Env, key: string): Promise<void> {
  await env.KV_CACHE.delete(key);
}

/** Invalidate every locale's homepage payload (called after a brief publishes). */
export async function invalidateHomepage(env: Env): Promise<void> {
  await Promise.all(
    (['uk', 'en', 'ru'] as const).map((lang) =>
      deleteCached(env, CACHE_KEYS.homepage(lang))
    )
  );
}
