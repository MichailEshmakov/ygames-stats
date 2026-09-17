// Тонкая обёртка над внутренним JSON-API каталога Яндекс Игр.
// Пути и параметры разобраны в .claude-docs/2026-09-16-получение-игр-по-словам-и-тегам.md
// API недокументированный: любой неожиданный ответ роняем с внятной ошибкой,
// чтобы поломка была заметна сразу, а не превратилась в тихо пустой каталог.

const BASE = 'https://yandex.ru/games/api/catalogue';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} — ${url}`);
    this.status = status;
  }
}

async function request(url, init, attempt = 1) {
  const maxAttempts = 5;
  try {
    const response = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', 'User-Agent': UA, ...init?.headers },
    });
    if (!response.ok) throw new HttpError(response.status, url);
    return await response.json();
  } catch (error) {
    // Повторяем только то, что может пройти со второй попытки: обрыв связи,
    // 429 и ошибки самой площадки. На 4xx повторять нечего.
    const retryable =
      !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
    if (!retryable || attempt >= maxAttempts) {
      if (error instanceof HttpError) throw error;
      throw new Error(`Запрос не удался после ${attempt} попыток: ${url}\n${error.message}`);
    }
    await sleep(1000 * 2 ** (attempt - 1));
    return request(url, init, attempt + 1);
  }
}

/** Страница полного каталога: 10 игр. Нумерация с 1. */
export async function fetchCatalogPage(pageId, lang = 'ru') {
  const data = await request(`${BASE}/v2/all_games/?lang=${lang}&page_id=${pageId}`);
  if (!Array.isArray(data.items) || typeof data.totalPages !== 'number') {
    throw new Error(`all_games вернул неожиданный формат на странице ${pageId}`);
  }
  return { items: data.items, totalPages: data.totalPages };
}

/** Полные карточки игр батчем: описание, дата публикации, теги. */
export async function fetchGameDetails(appIDs, lang = 'ru') {
  const data = await request(`${BASE}/v2/get_games?lang=${lang}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appIDs, format: 'long' }),
  });
  if (!Array.isArray(data.games)) {
    throw new Error('get_games вернул неожиданный формат');
  }
  return data.games;
}

/**
 * Справочник категорий. Отдельного метода в API нет — список приезжает
 * в состоянии главной страницы, оттуда его и вынимаем.
 */
export async function fetchCategories(lang = 'ru') {
  const url = `https://yandex.ru/games/?lang=${lang}`;
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new HttpError(response.status, url);
  const html = await response.text();

  const marker = '"categoryDataMappedByID":';
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error('На главной больше нет categoryDataMappedByID — справочник категорий переехал');
  }
  const byId = JSON.parse(cutObject(html, start + marker.length));

  return Object.entries(byId).map(([id, category]) => ({
    id: Number(id),
    title: category.title,
    name: category.name,
  }));
}

/** Вырезает из строки объект JSON, начинающийся с позиции start, по балансу скобок. */
function cutObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === '\\') i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error('Не удалось разобрать справочник категорий на главной');
}

/** Справочник тегов площадки. */
export async function fetchTags(lang = 'ru') {
  const data = await request(`${BASE}/v2/tags/?lang=${lang}`);
  if (!Array.isArray(data.tags)) {
    throw new Error('tags вернул неожиданный формат');
  }
  return data.tags;
}
