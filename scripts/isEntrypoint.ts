import { pathToFileURL } from 'node:url';

/**
 * True when `metaUrl` (a module's import.meta.url) is the script Node was
 * invoked with on the CLI. Lets a script export its logic for reuse while still
 * auto-running when executed directly — and NOT running when merely imported
 * (e.g. by scripts/collect.ts orchestrating everything in one process).
 */
export function isEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  return entry != null && metaUrl === pathToFileURL(entry).href;
}
