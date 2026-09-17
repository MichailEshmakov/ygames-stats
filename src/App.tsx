import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CategoriesFile, Catalog, DeltaFile, Game, TagsFile } from './types';
import { readCached, writeCached, type Cached, type CacheKey } from './storage';
import { buildIndex, search, SEARCH_FIELDS, type KeywordMode, type SearchField } from './search';
import { GameTable, type SortField } from './GameTable';
import { DataPanel } from './DataPanel';
import { SearchHelp } from './SearchHelp';
import { Stats } from './Stats';

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [delta, setDelta] = useState<DeltaFile | null>(null);
  const [tags, setTags] = useState<TagsFile | null>(null);
  const [categories, setCategories] = useState<CategoriesFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [outdated, setOutdated] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [keywordMode, setKeywordMode] = useState<KeywordMode>('all');
  // Описание и «как играть» по умолчанию выключены: там пишут что угодно,
  // и попадание по ним мало говорит о том, про что игра.
  const [fields, setFields] = useState<SearchField[]>(['title', 'tags', 'categories']);
  const [sortField, setSortField] = useState<SortField>('ratingCount');

  const cache = useRef<{
    catalog: Cached<Catalog> | null;
    delta: Cached<DeltaFile> | null;
    tags: Cached<TagsFile> | null;
    categories: Cached<CategoriesFile> | null;
  }>({ catalog: null, delta: null, tags: null, categories: null });

  const apply = useCallback(
    (
      nextCatalog: Cached<Catalog> | null,
      nextDelta: Cached<DeltaFile> | null,
      nextTags: Cached<TagsFile> | null,
      nextCategories: Cached<CategoriesFile> | null,
      cached: boolean,
    ) => {
      cache.current = {
        catalog: nextCatalog,
        delta: nextDelta,
        tags: nextTags,
        categories: nextCategories,
      };
      setCatalog(nextCatalog?.data ?? null);
      setDelta(nextDelta?.data ?? null);
      setTags(nextTags?.data ?? null);
      setCategories(nextCategories?.data ?? null);
      setSavedAt(nextCatalog?.savedAt ?? null);
      setFromCache(cached);
      setLoading(false);
    },
    [],
  );

  const loadFromFiles = useCallback(async () => {
    setLoading(true);
    const [nextCatalog, nextDelta, nextTags, nextCategories] = await Promise.all([
      refresh<Catalog>('catalog', CATALOG_URL, cache.current.catalog),
      refresh<DeltaFile>('delta', DELTA_URL, cache.current.delta),
      refresh<TagsFile>('tags', TAGS_URL, cache.current.tags),
      refresh<CategoriesFile>('categories', CATEGORIES_URL, cache.current.categories),
    ]);
    apply(nextCatalog.entry, nextDelta.entry, nextTags.entry, nextCategories.entry, false);
    setOutdated(false);
    setStorageFailed(
      !nextCatalog.stored || !nextDelta.stored || !nextTags.stored || !nextCategories.stored,
    );
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [cachedCatalog, cachedDelta, cachedTags, cachedCategories] = await Promise.all([
        readCached<Catalog>('catalog'),
        readCached<DeltaFile>('delta'),
        readCached<TagsFile>('tags'),
        readCached<CategoriesFile>('categories'),
      ]);
      if (cancelled) return;
      if (!cachedCatalog || !cachedTags || !cachedCategories) {
        void loadFromFiles();
        return;
      }
      apply(cachedCatalog, cachedDelta, cachedTags, cachedCategories, true);
      const fresher = await hasFresherFiles(
        cachedCatalog,
        cachedDelta,
        cachedTags,
        cachedCategories,
      );
      if (!cancelled) setOutdated(fresher);
    })();
    return () => {
      cancelled = true;
    };
  }, [apply, loadFromFiles]);

  const games = useMemo(() => {
    if (!catalog) return [];
    if (!delta) return catalog.games;
    // Свой замер точнее: он снят тем же проходом, что и число оценок.
    // Чужой прирост подставляем только там, где своего ещё нет.
    return catalog.games.map((game) =>
      game.ratingCountDelta30 === null || game.ratingCountDelta30 === undefined
        ? { ...game, ratingCountDelta30: delta.deltas[game.appID] ?? null }
        : game,
    );
  }, [catalog, delta]);

  const dictionaries = useMemo(
    () => ({
      tagTitles: new Map((tags?.tags ?? []).map((tag) => [tag.id, tag.title])),
      categoryTitles: new Map(
        (categories?.categories ?? []).map((category) => [category.id, category.title]),
      ),
    }),
    [tags, categories],
  );

  const index = useMemo(() => buildIndex(games, dictionaries), [games, dictionaries]);

  const found = useMemo(
    () => search(index, { keywords, keywordMode, fields }),
    [index, keywords, keywordMode, fields],
  );

  const sorted = useMemo(() => sortGames(found, sortField), [found, sortField]);

  return (
    <main className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">Аналитика Яндекс Игр</h1>
          <p className="page__subtitle">Поиск игр каталога по ключевым словам</p>
        </div>
        <a
          className="telegram"
          href="https://t.me/MikhailAllowsHimself"
          target="_blank"
          rel="noreferrer noopener"
        >
          <svg className="telegram__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M9.04 15.47 8.7 20.2c.48 0 .69-.2.94-.45l2.26-2.15 4.68 3.42c.86.47 1.47.22 1.7-.79l3.08-14.4c.3-1.26-.46-1.75-1.29-1.44L1.9 9.76c-1.23.48-1.21 1.17-.21 1.48l4.6 1.43 10.7-6.72c.5-.33.96-.15.58.18z"
            />
          </svg>
          Канал Михаила
        </a>
      </header>

      <DataPanel
        catalog={catalog}
        delta={delta}
        savedAt={savedAt}
        fromCache={fromCache}
        outdated={outdated}
        storageFailed={storageFailed}
        onReload={() => void loadFromFiles()}
      />

      {loading && <p className="note">Загружаем данные…</p>}

      {!loading && !catalog && (
        <p className="note">
          Каталога ещё нет. Нажмите «Загрузить данные» — или соберите его в терминале
          командой <code>npm run collect</code>.
        </p>
      )}

      {catalog && (
        <>
          <form className="search" onSubmit={(event) => event.preventDefault()}>
            <label className="field">
              <span className="field__label">Ключевые слова</span>
              <input
                className="field__input"
                placeholder="(кот, котик, кошка) и (ферма или огород)"
                value={keywords}
                onChange={(event) => setKeywords(event.target.value)}
              />
              <span className="field__hint">Ищем по {enabledFields(fields)}.</span>
            </label>

            <fieldset className="modes">
              <legend className="field__label">Где искать</legend>
              {SEARCH_FIELDS.map(({ id, label }) => (
                <label className="mode" key={id}>
                  <input
                    type="checkbox"
                    checked={fields.includes(id)}
                    // Снять последнюю галочку нельзя: искать станет негде.
                    disabled={fields.length === 1 && fields.includes(id)}
                    onChange={() => setFields((current) => toggleField(current, id))}
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            <fieldset className="modes">
              <legend className="field__label">Между словами без оператора</legend>
              <label className="mode">
                <input
                  type="radio"
                  checked={keywordMode === 'all'}
                  onChange={() => setKeywordMode('all')}
                />
                и
              </label>
              <label className="mode">
                <input
                  type="radio"
                  checked={keywordMode === 'any'}
                  onChange={() => setKeywordMode('any')}
                />
                или
              </label>
            </fieldset>

            <SearchHelp />
          </form>

          <p className="summary">
            Найдено <strong>{sorted.length.toLocaleString('ru-RU')}</strong> из{' '}
            {catalog.gamesCount.toLocaleString('ru-RU')} игр каталога.
          </p>

          <Stats games={found} />

          <GameTable games={sorted} sortField={sortField} onSortChange={setSortField} />
        </>
      )}
    </main>
  );
}

function toggleField(current: SearchField[], field: SearchField): SearchField[] {
  return current.includes(field) ? current.filter((id) => id !== field) : [...current, field];
}

function enabledFields(fields: SearchField[]): string {
  return SEARCH_FIELDS.filter(({ id }) => fields.includes(id))
    .map(({ label }) => label)
    .join(', ');
}

function sortGames(games: Game[], field: SortField): Game[] {
  const sorted = [...games];
  sorted.sort((a, b) => {
    if (field === 'title') return a.title.localeCompare(b.title, 'ru');
    const left = field === 'ratingCount' ? a.ratingCount : (a.ratingCountDelta30 ?? -1);
    const right = field === 'ratingCount' ? b.ratingCount : (b.ratingCountDelta30 ?? -1);
    return right - left;
  });
  return sorted;
}

const CATALOG_URL = '/data/catalog.json';
const DELTA_URL = '/data/delta30.json';
const TAGS_URL = '/data/tags.json';
const CATEGORIES_URL = '/data/categories.json';

/**
 * Перечитываем файл, только если он изменился: каталог весит около 30 МБ,
 * и качать его ради того же самого содержимого незачем.
 */
async function refresh<T>(
  key: CacheKey,
  url: string,
  cached: Cached<T> | null,
): Promise<{ entry: Cached<T> | null; stored: boolean }> {
  if (cached?.sourceModifiedAt && (await modifiedAt(url)) === cached.sourceModifiedAt) {
    return { entry: cached, stored: true };
  }
  const downloaded = await download<T>(url);
  if (!downloaded) return { entry: cached, stored: true };
  const entry: Cached<T> = {
    savedAt: new Date().toISOString(),
    sourceModifiedAt: downloaded.modifiedAt,
    data: downloaded.data,
  };
  return { entry, stored: await writeCached(key, entry) };
}

async function download<T>(url: string): Promise<{ data: T; modifiedAt: string | null } | null> {
  try {
    const response = await fetch(`${url}?t=${Date.now()}`);
    if (!response.ok) return null;
    return { data: (await response.json()) as T, modifiedAt: response.headers.get('last-modified') };
  } catch {
    return null;
  }
}

async function modifiedAt(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok ? response.headers.get('last-modified') : null;
  } catch {
    return null;
  }
}

/**
 * Сборщик мог отработать в терминале, пока в браузере лежит старая копия.
 * Сравниваем Last-Modified, не выкачивая файлы целиком.
 */
async function hasFresherFiles(
  cachedCatalog: Cached<Catalog>,
  cachedDelta: Cached<DeltaFile> | null,
  cachedTags: Cached<TagsFile> | null,
  cachedCategories: Cached<CategoriesFile> | null,
): Promise<boolean> {
  const known: [string, string | null][] = [
    [CATALOG_URL, cachedCatalog.sourceModifiedAt],
    [DELTA_URL, cachedDelta?.sourceModifiedAt ?? null],
    [TAGS_URL, cachedTags?.sourceModifiedAt ?? null],
    [CATEGORIES_URL, cachedCategories?.sourceModifiedAt ?? null],
  ];
  const checks = await Promise.all(
    known.map(async ([url, stored]) => {
      if (!stored) return false;
      const current = await modifiedAt(url);
      return Boolean(current) && current !== stored;
    }),
  );
  return checks.some(Boolean);
}
