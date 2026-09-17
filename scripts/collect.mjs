// Сборщик каталога Яндекс Игр.
//
// Зачем скрипт, а не запрос из браузера: API каталога отвечает без
// CORS-заголовков, напрямую со страницы его не дёрнуть. Поэтому каталог
// выкачивается здесь в JSON, а приложение только читает файл и фильтрует.
//
// Запуск:
//   node scripts/collect.mjs                 # весь каталог (~2100 страниц)
//   node scripts/collect.mjs --pages 20      # быстрый прогон для разработки
//   node scripts/collect.mjs --resume        # продолжить прерванный обход
//   node scripts/collect.mjs --refresh-details  # заодно перечитать карточки игр
//
// Прирост отзывов за 30 дней площадка не отдаёт — его нет ни в одном
// ответе API. Он считается по нашим же снимкам: каждый прогон кладёт в
// data/history/<дата>.json число оценок по каждой игре, и прирост — это
// разница с ближайшим снимком месячной давности. На первом прогоне
// прироста не будет, он появится, когда накопится история.

import { mkdir, readFile, writeFile, readdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchCatalogPage,
  fetchGameDetails,
  fetchTags,
  fetchCategories,
  sleep,
  HttpError,
} from './yandex-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_DIR = path.join(ROOT, 'data', 'history');
const CACHE_FILE = path.join(ROOT, 'data', 'catalog-raw.ndjson');
const OUTPUT_DIR = path.join(ROOT, 'public', 'data');

const DETAILS_BATCH_SIZE = 100;
const ICON_SIZE = 'pjpg128x128';
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = { pages: Infinity, lang: 'ru', delay: 250, resume: false, refreshDetails: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pages') options.pages = Number(argv[++i]);
    else if (arg === '--lang') options.lang = argv[++i];
    else if (arg === '--delay') options.delay = Number(argv[++i]);
    else if (arg === '--resume') options.resume = true;
    else if (arg === '--refresh-details') options.refreshDetails = true;
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  return options;
}

const today = () => new Date().toISOString().slice(0, 10);

function iconUrl(media) {
  const prefix = media?.icon?.['prefix-url'];
  return prefix ? `${prefix}${ICON_SIZE}` : null;
}

/** Сжимаем ответ каталога до того, что нужно приложению. */
function toGame(item) {
  return {
    appID: item.appID,
    title: item.title,
    slug: item.appSlug ?? null,
    icon: iconUrl(item.media),
    rating: item.rating ?? null,
    ratingCount: item.ratingCount ?? 0,
    developer: item.developer?.name ?? null,
    developerID: item.developer?.id ?? null,
    tagIDs: item.tagIDs ?? [],
    categoryIDs: item.categoryIDs ?? [],
  };
}

async function readCachedPages() {
  if (!existsSync(CACHE_FILE)) return new Map();
  const cached = new Map();
  const content = await readFile(CACHE_FILE, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const { pageId, items } = JSON.parse(line);
    cached.set(pageId, items);
  }
  return cached;
}

async function appendPage(pageId, items) {
  await appendFile(CACHE_FILE, `${JSON.stringify({ pageId, items })}\n`);
}

async function walkCatalog({ pages, lang, delay, resume }) {
  const cached = resume ? await readCachedPages() : new Map();
  if (cached.size) console.log(`Продолжаем: в кэше ${cached.size} страниц.`);
  else await writeFile(CACHE_FILE, '');

  const byAppId = new Map();
  const absorb = (items) => items.forEach((item) => byAppId.set(item.appID, toGame(item)));

  let totalPages;
  if (cached.has(1)) {
    absorb(cached.get(1));
    totalPages = Number.MAX_SAFE_INTEGER;
  } else {
    const first = await fetchCatalogPage(1, lang);
    totalPages = first.totalPages;
    absorb(first.items);
    await appendPage(1, first.items);
  }

  // При --resume число страниц заранее неизвестно, уточняем его первым же
  // сетевым запросом; до этого идём по кэшу.
  const lastPageOf = (total) => Math.min(total, pages === Infinity ? total : pages);
  let lastPage = lastPageOf(totalPages);

  for (let pageId = 2; pageId <= lastPage; pageId += 1) {
    if (cached.has(pageId)) {
      absorb(cached.get(pageId));
      continue;
    }
    let page;
    try {
      page = await fetchCatalogPage(pageId, lang);
    } catch (error) {
      // Каталог живёт своей жизнью: пока идёт обход, игры добавляются и
      // снимаются, и объявленная в начале последняя страница может исчезнуть.
      if (error instanceof HttpError && error.status === 400) {
        console.log(`Страница ${pageId} уже за концом каталога — обход закончен.`);
        break;
      }
      throw error;
    }
    if (totalPages === Number.MAX_SAFE_INTEGER) {
      totalPages = page.totalPages;
      lastPage = lastPageOf(totalPages);
    }
    absorb(page.items);
    await appendPage(pageId, page.items);
    if (pageId % 50 === 0) {
      console.log(`Каталог: страница ${pageId}/${lastPage}, игр собрано ${byAppId.size}`);
    }
    await sleep(delay);
  }

  return { games: [...byAppId.values()], totalPages };
}

/**
 * Теги и дата публикации у уже собранной игры почти неизменны, а карточки
 * тянутся сотнями и занимают большую часть прогона. Поэтому берём их из
 * прошлого каталога, а в API идём только за играми, которых там не было.
 * Полностью перечитать карточки — флаг --refresh-details.
 */
async function readCollectedDetails() {
  const file = path.join(OUTPUT_DIR, 'catalog.json');
  if (!existsSync(file)) return new Map();
  const { games } = JSON.parse(await readFile(file, 'utf8'));
  const details = new Map();
  for (const game of games) {
    // Инструкции нет у карточек, собранных до того, как она понадобилась, —
    // такие игры перечитываем.
    if (game.instruction === undefined) continue;
    details.set(game.appID, {
      description: game.description ?? '',
      instruction: game.instruction ?? '',
      firstPublished: game.firstPublished ?? null,
      tagIDs: game.tagIDs ?? [],
    });
  }
  return details;
}

function applyDetails(game, detail) {
  game.description = detail.description ?? '';
  game.instruction = detail.instruction ?? '';
  game.firstPublished = detail.firstPublished ?? null;
  if (detail.tagIDs?.length) game.tagIDs = detail.tagIDs;
}

/**
 * В списочных ответах нет ни описания, ни инструкции, а теги приходят
 * обрезанными — всё это есть только в карточке игры. Поиск умеет искать по
 * каждому из этих полей, включать их или нет — выбор в интерфейсе.
 */
async function enrichWithDetails(games, { lang, delay, refreshDetails }) {
  const collected = refreshDetails ? new Map() : await readCollectedDetails();
  const byAppId = new Map();
  let reused = 0;
  for (const game of games) {
    const known = collected.get(game.appID);
    if (known) {
      applyDetails(game, known);
      reused += 1;
    } else {
      byAppId.set(game.appID, game);
    }
  }

  const ids = [...byAppId.keys()];
  console.log(`Карточки: готовых из прошлого каталога ${reused}, догружаем ${ids.length}.`);
  for (let offset = 0; offset < ids.length; offset += DETAILS_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + DETAILS_BATCH_SIZE);
    const details = await fetchGameDetails(batch, lang);
    for (const detail of details) {
      const game = byAppId.get(detail.appID);
      if (game) applyDetails(game, detail);
    }
    const done = Math.min(offset + DETAILS_BATCH_SIZE, ids.length);
    if (done % 1000 < DETAILS_BATCH_SIZE) console.log(`Карточки: ${done}/${ids.length}`);
    await sleep(delay);
  }
}

async function saveSnapshot(games) {
  await mkdir(HISTORY_DIR, { recursive: true });
  const ratingCounts = Object.fromEntries(games.map((game) => [game.appID, game.ratingCount]));
  await writeFile(
    path.join(HISTORY_DIR, `${today()}.json`),
    JSON.stringify({ date: today(), ratingCounts }),
  );
}

/**
 * Прирост оценок за ~30 дней по ближайшему подходящему снимку.
 * Окно 20–45 дней: раньше — прирост уже не про месяц, позже — слишком шумно.
 */
async function computeMonthlyDelta(games) {
  await mkdir(HISTORY_DIR, { recursive: true });
  const files = (await readdir(HISTORY_DIR)).filter((name) => name.endsWith('.json'));
  const target = Date.now() - 30 * DAY_MS;

  let best = null;
  for (const file of files) {
    const date = file.replace('.json', '');
    if (date === today()) continue;
    const time = new Date(date).getTime();
    if (Number.isNaN(time)) continue;
    const days = (Date.now() - time) / DAY_MS;
    if (days < 20 || days > 45) continue;
    const distance = Math.abs(time - target);
    if (!best || distance < best.distance) best = { file, date, days: Math.round(days), distance };
  }

  if (!best) {
    console.log('Снимка месячной давности пока нет — прирост за 30 дней будет пустым.');
    return { baselineDate: null, baselineDays: null };
  }

  const { ratingCounts } = JSON.parse(await readFile(path.join(HISTORY_DIR, best.file), 'utf8'));
  for (const game of games) {
    const previous = ratingCounts[game.appID];
    game.ratingCountDelta30 = previous === undefined ? null : game.ratingCount - previous;
  }
  console.log(`Прирост посчитан к снимку от ${best.date} (${best.days} дн. назад).`);
  return { baselineDate: best.date, baselineDays: best.days };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(path.join(ROOT, 'data'), { recursive: true });

  console.log('Обходим каталог…');
  const { games, totalPages } = await walkCatalog(options);
  console.log(`Собрано игр: ${games.length} (страниц в каталоге: ${totalPages}).`);

  console.log('Догружаем карточки игр…');
  await enrichWithDetails(games, options);

  await saveSnapshot(games);
  const baseline = await computeMonthlyDelta(games);

  games.sort((a, b) => b.ratingCount - a.ratingCount);
  await writeFile(
    path.join(OUTPUT_DIR, 'catalog.json'),
    JSON.stringify({
      collectedAt: new Date().toISOString(),
      lang: options.lang,
      gamesCount: games.length,
      deltaBaselineDate: baseline.baselineDate,
      deltaBaselineDays: baseline.baselineDays,
      games,
    }),
  );

  const tags = await fetchTags(options.lang);
  await writeFile(
    path.join(OUTPUT_DIR, 'tags.json'),
    JSON.stringify({
      collectedAt: new Date().toISOString(),
      tags: tags.map((tag) => ({
        id: tag.id,
        title: tag.title,
        slug: tag.slug,
        gamesCount: tag.info?.games_count ?? 0,
        isService: Boolean(tag.isService),
      })),
    }),
  );

  const categories = await fetchCategories(options.lang);
  await writeFile(
    path.join(OUTPUT_DIR, 'categories.json'),
    JSON.stringify({ collectedAt: new Date().toISOString(), categories }),
  );

  console.log(
    `Готово: public/data/catalog.json (${games.length} игр), ` +
      `public/data/tags.json (${tags.length} тегов), ` +
      `public/data/categories.json (${categories.length} категорий).`,
  );
}

main().catch((error) => {
  console.error(`\nСборка прервана: ${error.message}`);
  console.error('Повторный запуск с --resume продолжит с прерванного места.');
  process.exit(1);
});
