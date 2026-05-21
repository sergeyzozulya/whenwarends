// Related-news collection. Pulls a relevance-ranked, state-media-filtered pool
// of war-related articles from GDELT (multilingual), then runs one LLM pass to
// pick the top stories and translate each title into uk/en/ru, and overwrites
// data/news.json with that selected set. The same file feeds both the displayed
// news column and the weekly brief's headline context.
//
// Needs ANTHROPIC_API_KEY (the selection/translation pass). The whole thing is
// failure-isolated — on any error the previous news.json is left intact rather
// than clobbered, and the run only fails if there is no prior file to fall back
// on. Run locally with `npm run collect-news`.

import './loadEnv';
import { fetchGdeltArticles } from '../src/lib/sources/gdeltArticles';
import { selectAndTranslateNews } from '../src/lib/llm';
import { cacheNewsImages } from '../src/lib/newsImages';
import { readNews, writeNews } from '../src/lib/filestore';
import { isEntrypoint } from './isEntrypoint';

/**
 * Refresh data/news.json. Failure-isolated and never calls process.exit, so it
 * can be awaited from the collect orchestrator. Returns true if a usable
 * news.json exists after the run (either freshly written or a kept prior file).
 */
export async function runCollectNews(): Promise<boolean> {
  const asOf = new Date().toISOString().slice(0, 10);
  try {
    const pool = await fetchGdeltArticles();
    console.log(`related news: ${pool.length} candidates from GDELT`);
    if (pool.length === 0) {
      console.error('related news: empty candidate pool — keeping existing file');
      return readNews() != null;
    }

    const selected = await selectAndTranslateNews(pool, { count: 10 });
    if (selected.length === 0) {
      console.error('related news: selection returned nothing — keeping existing file');
      return readNews() != null;
    }

    // Download each article's image to public/news/ and rewrite to a local
    // path; failed downloads drop the image so the UI shows its placeholder.
    const articles = await cacheNewsImages(selected);
    const cached = articles.filter((a) => a.image).length;

    writeNews({ asOf, source: 'gdelt', articles });
    console.log(
      `✓ related news: selected ${articles.length} of ${pool.length}, ${cached} images cached locally, translated uk/en/ru, for ${asOf}`
    );
    return true;
  } catch (err) {
    console.error(
      `✗ related news: ${err instanceof Error ? err.message : String(err)}`
    );
    // Leave any prior news.json untouched.
    return readNews() != null;
  }
}

// Standalone CLI: `npm run collect-news`. Fail only if we end up with no news.
if (isEntrypoint(import.meta.url)) {
  runCollectNews()
    .then((ok) => {
      if (!ok) process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
