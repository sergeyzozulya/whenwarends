import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  cacheNewsImages,
  type ImageFetcher,
  type ImageProcessor,
} from '../../src/lib/newsImages';
import type { NewsItem } from '../../src/lib/types';

const item = (over: Partial<NewsItem>): NewsItem => ({
  url: 'https://ex.com/a',
  domain: 'ex.com',
  seenAt: '',
  original: 'orig',
  title: { uk: 'u', en: 'e', ru: 'r' },
  ...over,
});

const PNG = new Uint8Array([1, 2, 3]);
// Returns an image only for URLs containing "good".
const okFetcher: ImageFetcher = async (url) =>
  url.includes('good') ? { contentType: 'image/png', bytes: PNG } : null;
// Stand-in for sharp: hand back the bytes as a WebP thumbnail, no real codec.
const passProcessor: ImageProcessor = async (bytes) => ({ bytes, ext: 'webp' });

describe('cacheNewsImages', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wwe-news-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('caches a good image locally and rewrites to a served path', async () => {
    const out = await cacheNewsImages(
      [item({ url: 'https://ex.com/1', image: 'https://cdn/good.png' })],
      { fetcher: okFetcher, processor: passProcessor, dir, publicPrefix: '/news' }
    );
    const path = out[0].image ?? '';
    expect(path).toMatch(/^\/news\/[0-9a-f]{16}\.webp$/);
    expect(existsSync(resolve(dir, path.replace('/news/', '')))).toBe(true);
  });

  it('replaces a failed download with the placeholder (image undefined)', async () => {
    const out = await cacheNewsImages(
      [item({ url: 'https://ex.com/2', image: 'https://cdn/bad.png' })],
      { fetcher: okFetcher, processor: passProcessor, dir }
    );
    expect(out[0].image).toBeUndefined();
    expect(out[0].original).toBe('orig');
  });

  it('drops the image when processing fails (placeholder)', async () => {
    const failProc: ImageProcessor = async () => null;
    const out = await cacheNewsImages(
      [item({ url: 'https://ex.com/4', image: 'https://cdn/good.png' })],
      { fetcher: okFetcher, processor: failProc, dir }
    );
    expect(out[0].image).toBeUndefined();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('leaves an item that had no image without one', async () => {
    const out = await cacheNewsImages([item({ url: 'https://ex.com/3' })], {
      fetcher: okFetcher,
      processor: passProcessor,
      dir,
    });
    expect(out[0].image).toBeUndefined();
  });

  it('uses a stable filename per URL and the processor extension', async () => {
    const pngProc: ImageProcessor = async (bytes) => ({ bytes, ext: 'png' });
    const a = await cacheNewsImages(
      [item({ url: 'https://ex.com/x', image: 'https://cdn/good' })],
      { fetcher: okFetcher, processor: pngProc, dir }
    );
    const b = await cacheNewsImages(
      [item({ url: 'https://ex.com/x', image: 'https://cdn/good' })],
      { fetcher: okFetcher, processor: pngProc, dir }
    );
    expect(a[0].image).toBe(b[0].image);
    expect(a[0].image).toMatch(/\.png$/);
  });

  it('prunes cached files not in the current set', async () => {
    writeFileSync(resolve(dir, 'stale.jpg'), new Uint8Array([9]));
    await cacheNewsImages(
      [item({ url: 'https://ex.com/keep', image: 'https://cdn/good.png' })],
      { fetcher: okFetcher, processor: passProcessor, dir }
    );
    const files = readdirSync(dir);
    expect(files).not.toContain('stale.jpg');
    expect(files.some((f) => f.endsWith('.webp'))).toBe(true);
  });

  it('keeps .gitkeep during pruning', async () => {
    writeFileSync(resolve(dir, '.gitkeep'), '');
    await cacheNewsImages([], { fetcher: okFetcher, processor: passProcessor, dir });
    expect(existsSync(resolve(dir, '.gitkeep'))).toBe(true);
  });
});
