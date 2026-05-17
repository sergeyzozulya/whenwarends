// Placeholder: lib/kv.ts — KV cache helpers
// Implemented in Phase 1

export async function getCached(kv: any, key: string) {
  return await kv.get(key, 'json');
}

export async function setCached(kv: any, key: string, value: any, ttlSeconds: number = 3600) {
  return await kv.put(key, JSON.stringify(value), {
    expirationTtl: ttlSeconds,
  });
}
