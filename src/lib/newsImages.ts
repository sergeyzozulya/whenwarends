// Local image cache for the selected news articles (Node-only; runs in the
// collect step, never in the Worker). Hotlinking publisher images leaks every
// visitor's IP/referrer to those outlets and breaks the site's no-third-party-
// requests privacy posture — so at collect time we download each chosen
// article's image once, downscale it to a small thumbnail (<=100px, WebP),
// store it under public/news/ (served from our own origin as a static asset),
// and rewrite the item's `image` to that local path.
//
// The set is overwritten every run: filenames are derived from the article URL
// (stable), and any cached file not referenced by the current selection is
// pruned, so the directory holds only the live set. A failed/oversized/non-
// image download simply drops that item's image (the UI shows its placeholder).
// The fetcher and target dir are injectable so unit tests stay offline and out
// of public/.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import type { NewsItem } from './types';

const DEFAULT_DIR = resolve(process.cwd(), 'public', 'news');
const DEFAULT_PREFIX = '/news';
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  'whenwarends-collector/1.0 (+https://whenwarends.org; non-commercial)';

// Cached thumbnails display ~96px wide; cap the longest side at 100px and
// re-encode to WebP, so a multi-hundred-KB publisher image becomes a few KB
// served from our origin (and the repo stays small).
const MAX_DIM = 100;

export interface FetchedImage {
  contentType: string;
  bytes: Uint8Array;
}

/** Fetch an image URL, or null if it isn't a usable image. Injectable. */
export type ImageFetcher = (url: string) => Promise<FetchedImage | null>;

const defaultImageFetcher: ImageFetcher = async (url) => {
  if (!/^https?:\/\//i.test(url)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/*' },
    });
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith('image/')) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared && declared > MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null;
    return { contentType, bytes };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Resize/re-encode fetched image bytes for storage, returning the output bytes
 * and file extension, or null if the image can't be processed. Injectable so
 * unit tests don't need a real image codec.
 */
export type ImageProcessor = (
  bytes: Uint8Array,
  contentType: string
) => Promise<{ bytes: Uint8Array; ext: string } | null>;

const defaultImageProcessor: ImageProcessor = async (bytes) => {
  try {
    const out = await sharp(bytes)
      .rotate() // honour EXIF orientation before resizing
      .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return { bytes: new Uint8Array(out), ext: 'webp' };
  } catch {
    return null;
  }
};

export interface CacheImagesOptions {
  fetcher?: ImageFetcher;
  /** Resize/re-encode step (default: downscale to <=100px WebP via sharp). */
  processor?: ImageProcessor;
  /** Target directory (default public/news). */
  dir?: string;
  /** URL prefix the saved files are served under (default /news). */
  publicPrefix?: string;
}

/**
 * Download each item's image into `dir`, rewriting `image` to the local served
 * path. Items without an image, or whose download fails, come back with no
 * image. Cached files not referenced by the returned set are pruned.
 */
export async function cacheNewsImages(
  items: NewsItem[],
  opts: CacheImagesOptions = {}
): Promise<NewsItem[]> {
  const fetcher = opts.fetcher ?? defaultImageFetcher;
  const processor = opts.processor ?? defaultImageProcessor;
  const dir = opts.dir ?? DEFAULT_DIR;
  const prefix = opts.publicPrefix ?? DEFAULT_PREFIX;

  mkdirSync(dir, { recursive: true });
  const keep = new Set<string>();
  const out: NewsItem[] = [];

  for (const item of items) {
    if (!item.image) {
      out.push({ ...item, image: undefined });
      continue;
    }
    const got = await fetcher(item.image);
    if (!got) {
      out.push({ ...item, image: undefined });
      continue;
    }
    const processed = await processor(got.bytes, got.contentType);
    if (!processed) {
      out.push({ ...item, image: undefined });
      continue;
    }
    const hash = createHash('sha1').update(item.url).digest('hex').slice(0, 16);
    const name = `${hash}.${processed.ext}`;
    writeFileSync(resolve(dir, name), processed.bytes);
    keep.add(name);
    out.push({ ...item, image: `${prefix}/${name}` });
  }

  // Prune stale cached files (keep .gitkeep and the current set).
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (file === '.gitkeep' || keep.has(file)) continue;
      rmSync(resolve(dir, file), { force: true });
    }
  }
  return out;
}
