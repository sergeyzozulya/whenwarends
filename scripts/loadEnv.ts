// Auto-load .dev.vars into process.env for the local scripts (collect,
// draft-brief). Cloudflare's .dev.vars convention; mirrors .dev.vars.example.
//
// - Node-only, dependency-free, side-effecting on import (run it first).
// - Never overrides an already-set variable, so CI's real secrets and an
//   explicit `set -a; . ./.dev.vars` both still win.
// - Absent file is fine (CI has no .dev.vars — it uses Actions secrets).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.cwd(), '.dev.vars');
if (existsSync(path)) {
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
