// Прирост оценок за 30 дней с game-analytics.ru.
//
// Своя история в data/history/ даёт эту цифру только через месяц наблюдений.
// game-analytics.ru считает её давно, публикует открыто и держит в таблице
// data-id — это appID Яндекс Игр, так что строки сопоставляются с нашим
// каталогом один в один.
//
// Раздел /yg/filters — весь каталог (~21 000 игр) по 100 строк на страницу.
// В robots.txt сайта для обычных агентов стоит Crawl-delay: 10, поэтому пауза
// по умолчанию — 10 секунд, полный проход занимает около 40 минут.
//
// Запуск:
//   node scripts/collect-delta.mjs
//   node scripts/collect-delta.mjs --pages 3     # проверочный прогон
//   node scripts/collect-delta.mjs --delay 15000
//   node scripts/collect-delta.mjs --from 173   # дособрать хвост

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_FILE = path.join(ROOT, 'public', 'data', 'delta30.json');

const SOURCE = 'https://game-analytics.ru';
const LISTING = `${SOURCE}/yg/filters`;
const PER_PAGE = 100;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { pages: Infinity, delay: 10_000, from: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pages') options.pages = Number(argv[++i]);
    else if (arg === '--delay') options.delay = Number(argv[++i]);
    else if (arg === '--from') options.from = Number(argv[++i]);
    else throw new Error(`Неизвестный аргумент: ${arg}`);
  }
  return options;
}

async function fetchPage(page, attempt = 1) {
  const url = `${LISTING}?perPage=${PER_PAGE}&page=${page}`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (attempt >= 4) throw new Error(`Страница ${page} не открылась: ${error.message}`);
    await sleep(15_000 * attempt);
    return fetchPage(page, attempt + 1);
  }
}

const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

/** Числа в таблице разделены неразрывными пробелами: «65 417» → 65417. */
function parseNumber(text) {
  const digits = stripTags(text).replace(/[^\d\-]/g, '');
  if (!digits || digits === '-') return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

/**
 * Колонки ищем по заголовкам, а не по номерам: если автор сайта добавит
 * столбец, разбор должен не молча съехать, а продолжить работать.
 */
function findColumns(html) {
  const headerRow = html.match(/<thead.*?<tr(.*?)<\/tr>/s);
  if (!headerRow) throw new Error('на странице нет шапки таблицы');
  const headers = [...headerRow[1].matchAll(/<th.*?<\/th>/gs)].map((match) =>
    stripTags(match[0]).replace(/\s+/g, ' ').trim().toLowerCase(),
  );
  const columns = {
    ratingCount: headers.findIndex((title) => title.includes('всего оценок')),
    delta30: headers.findIndex((title) => title.includes('+30')),
  };
  if (columns.ratingCount < 0 || columns.delta30 < 0) {
    throw new Error(`не нашли колонки «Всего оценок» и «+30 дней». Шапка: ${headers.join(' | ')}`);
  }
  return columns;
}

function parseRows(html, columns) {
  const body = html.slice(html.indexOf('<tbody'));
  const rows = [...body.matchAll(/<tr.*?<\/tr>/gs)].map((match) => match[0]);
  const parsed = [];
  let games = 0;
  for (const row of rows) {
    const id = row.match(/data-id="(\d+)"/);
    if (!id) continue;
    games += 1;
    const cells = [...row.matchAll(/<td.*?<\/td>/gs)].map((match) => match[0]);
    // У игр без единой оценки в этих колонках стоит прочерк. Такую строку
    // пропускаем, но считаем её игрой: иначе целая страница таких игр
    // выглядит как конец каталога.
    const delta30 = parseNumber(cells[columns.delta30] ?? '');
    if (delta30 === null) continue;
    parsed.push({
      appID: Number(id[1]),
      delta30,
      ratingCount: parseNumber((cells[columns.ratingCount] ?? '').split('rd-increase')[0]),
    });
  }
  return { games, rows: parsed };
}

/** Прошлый результат не выбрасываем: частичный прогон должен дополнять его. */
async function readPreviousDeltas() {
  if (!existsSync(OUTPUT_FILE)) return new Map();
  try {
    const previous = JSON.parse(await readFile(OUTPUT_FILE, 'utf8'));
    return new Map(Object.entries(previous.deltas ?? {}).map(([id, value]) => [Number(id), value]));
  } catch {
    return new Map();
  }
}

function totalPages(html) {
  const links = [...html.matchAll(/(?:[?&]|&amp;)page=(\d+)/g)].map((match) => Number(match[1]));
  return links.length ? Math.max(...links) : 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });

  const first = await fetchPage(1);
  const columns = findColumns(first);
  const pagesOnSite = totalPages(first);
  const lastPage = Math.min(pagesOnSite, options.pages === Infinity ? pagesOnSite : options.pages);
  console.log(`Страниц на сайте: ${pagesOnSite}, забираем ${lastPage} с паузой ${options.delay} мс.`);

  const byAppId = await readPreviousDeltas();
  if (byAppId.size) console.log(`В прошлом файле было ${byAppId.size} игр — дополняем его.`);
  const absorb = (rows) => rows.forEach((row) => byAppId.set(row.appID, row.delta30));

  const firstPage = parseRows(first, columns);
  if (options.from === 1) absorb(firstPage.rows);

  for (let page = Math.max(2, options.from); page <= lastPage; page += 1) {
    await sleep(options.delay);
    const { games, rows } = parseRows(await fetchPage(page), columns);
    if (!games) {
      console.warn(`Страница ${page} без игр — останавливаемся.`);
      break;
    }
    absorb(rows);
    if (page % 10 === 0) console.log(`Страница ${page}/${lastPage}, игр с приростом ${byAppId.size}`);
  }

  const deltas = Object.fromEntries([...byAppId.entries()]);
  await writeFile(
    OUTPUT_FILE,
    JSON.stringify({
      collectedAt: new Date().toISOString(),
      source: 'game-analytics.ru',
      sourceUrl: `${LISTING}?perPage=${PER_PAGE}`,
      gamesCount: byAppId.size,
      deltas,
    }),
  );
  console.log(`Готово: public/data/delta30.json, игр с приростом ${byAppId.size}.`);
}

main().catch((error) => {
  console.error(`\nСбор прироста прерван: ${error.message}`);
  process.exit(1);
});
