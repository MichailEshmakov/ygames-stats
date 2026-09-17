import type { Game } from './types';

/** Что подразумевается между словами, между которыми не написан оператор. */
export type KeywordMode = 'all' | 'any';

/** Поля игры, по которым ищутся ключевые слова. Набор выбирается в интерфейсе. */
export type SearchField = 'title' | 'tags' | 'categories' | 'description' | 'instruction';

export const SEARCH_FIELDS: { id: SearchField; label: string }[] = [
  { id: 'title', label: 'названию' },
  { id: 'tags', label: 'тегам' },
  { id: 'categories', label: 'категориям' },
  { id: 'description', label: 'описанию' },
  { id: 'instruction', label: 'как играть' },
];

export interface SearchQuery {
  /** Ключевые слова — ищутся в полях из fields. */
  keywords: string;
  /** По каким полям игры искать ключевые слова. */
  fields: SearchField[];
  /** Отдельная строка — ищется только в названии. */
  title: string;
  keywordMode: KeywordMode;
}

/**
 * Приводим текст к виду, по которому сравниваем: нижний регистр, ё → е,
 * любые не-буквы и не-цифры схлопываем в пробел. Пробелы по краям оставляем,
 * чтобы можно было искать по границе слова.
 */
function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

// Русская морфология без словаря: отрезаем частые окончания, чтобы «ферма»
// находила «фермы» и «ферме». Приём грубый, но для поиска по каталогу даёт
// заметно больше попаданий, чем точное совпадение, и не тянет зависимостей.
const ENDINGS = [
  'ями', 'ами', 'ого', 'ему', 'ыми', 'ими', 'ой', 'ей', 'ый', 'ий', 'ая', 'яя',
  'ое', 'ее', 'ые', 'ие', 'ов', 'ев', 'ам', 'ям', 'ах', 'ях', 'ом', 'ем', 'ую',
  'юю', 'а', 'я', 'ы', 'и', 'о', 'е', 'у', 'ю', 'й', 'ь',
];

function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 3) {
      return word.slice(0, word.length - ending.length);
    }
  }
  return word;
}

// --- Разбор запроса -------------------------------------------------------

export type Query =
  | { kind: 'term'; text: string }
  | { kind: 'not'; operand: Query }
  | { kind: 'and' | 'or'; left: Query; right: Query };

type Token =
  | { kind: 'term'; text: string }
  | { kind: 'and' | 'or' | 'not' | 'open' | 'close' };

const OPERATORS: Record<string, 'and' | 'or' | 'not'> = {
  и: 'and',
  and: 'and',
  или: 'or',
  or: 'or',
  не: 'not',
  кроме: 'not',
  not: 'not',
};

const QUOTES: Record<string, string> = { '"': '"', '«': '»', '“': '”' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pushTerm = (raw: string) => {
    const text = normalize(raw).trim();
    if (text) tokens.push({ kind: 'term', text });
  };

  let position = 0;
  while (position < input.length) {
    const char = input[position];

    if (/\s/.test(char)) {
      position += 1;
      continue;
    }
    if (char === '(') {
      tokens.push({ kind: 'open' });
      position += 1;
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'close' });
      position += 1;
      continue;
    }
    // Запятая — это «или»: перечисление «кот, котик, кошка» читается как
    // список написаний одного и того же, а не как список требований.
    if (char === ',' || char === ';' || char === '|' || char === '/') {
      tokens.push({ kind: 'or' });
      position += 1;
      continue;
    }
    if (char === '&' || char === '+') {
      tokens.push({ kind: 'and' });
      position += 1;
      continue;
    }
    // Минус — это «не» только перед словом: внутри слова он часть написания
    // («три-в-ряд»), и отрицанием его считать нельзя.
    if (char === '!' || (char === '-' && !/[\p{L}\p{N}]/u.test(input[position - 1] ?? ''))) {
      tokens.push({ kind: 'not' });
      position += 1;
      continue;
    }
    if (QUOTES[char]) {
      const closing = QUOTES[char];
      const end = input.indexOf(closing, position + 1);
      // Незакрытая кавычка: берём всё до конца строки, чтобы фраза искалась
      // уже во время набора, а не только после второй кавычки.
      pushTerm(end === -1 ? input.slice(position + 1) : input.slice(position + 1, end));
      position = end === -1 ? input.length : end + 1;
      continue;
    }

    let end = position;
    while (end < input.length && /[\p{L}\p{N}_.]/u.test(input[end])) end += 1;
    if (end === position) {
      position += 1;
      continue;
    }
    const word = input.slice(position, end);
    const operator = OPERATORS[word.toLowerCase().replace(/ё/g, 'е')];
    if (operator) tokens.push({ kind: operator });
    else pushTerm(word);
    position = end;
  }

  return tokens;
}

function startsOperand(token: Token | undefined): boolean {
  if (!token) return false;
  return token.kind === 'term' || token.kind === 'open' || token.kind === 'not';
}

function endsOperand(token: Token | undefined): boolean {
  if (!token) return false;
  return token.kind === 'term' || token.kind === 'close';
}

/** Между соседними операндами оператор не написан — подставляем режим поиска. */
function insertImplicitOperators(tokens: Token[], mode: KeywordMode): Token[] {
  const implicit: Token = { kind: mode === 'all' ? 'and' : 'or' };
  const result: Token[] = [];
  for (const token of tokens) {
    if (endsOperand(result[result.length - 1]) && startsOperand(token)) result.push(implicit);
    result.push(token);
  }
  return result;
}

/**
 * Разбор выражения: «не» связывает сильнее «и», «и» — сильнее «или».
 * Разбор нарочно терпимый: лишние скобки и операторы без операнда
 * пропускаются, а не превращают весь запрос в ошибку — строку набирают
 * посимвольно, и на каждом промежуточном её состоянии список должен жить.
 */
export function parseQuery(input: string, mode: KeywordMode = 'all'): Query | null {
  const tokens = insertImplicitOperators(tokenize(input), mode);
  let position = 0;

  const parseUnary = (): Query | null => {
    const token = tokens[position];
    if (!token) return null;
    if (token.kind === 'not') {
      position += 1;
      const operand = parseUnary();
      return operand ? { kind: 'not', operand } : null;
    }
    if (token.kind === 'open') {
      position += 1;
      const inner = parseOr();
      if (tokens[position]?.kind === 'close') position += 1;
      return inner;
    }
    if (token.kind === 'term') {
      position += 1;
      return { kind: 'term', text: token.text };
    }
    return null;
  };

  const parseAnd = (): Query | null => {
    let left = parseUnary();
    while (tokens[position]?.kind === 'and') {
      position += 1;
      const right = parseUnary();
      if (!right) continue;
      left = left ? { kind: 'and', left, right } : right;
    }
    return left;
  };

  function parseOr(): Query | null {
    let left = parseAnd();
    while (tokens[position]?.kind === 'or') {
      position += 1;
      const right = parseAnd();
      if (!right) continue;
      left = left ? { kind: 'or', left, right } : right;
    }
    return left;
  }

  let query = parseOr();
  // Лишняя закрывающая скобка: пропускаем её и дочитываем остаток,
  // чтобы «кот) и ферма» работало как «кот и ферма».
  while (position < tokens.length) {
    position += 1;
    const rest = parseOr();
    if (rest) query = query ? { kind: 'and', left: query, right: rest } : rest;
  }
  return query;
}

function evaluate(query: Query, matches: (term: string) => boolean): boolean {
  switch (query.kind) {
    case 'term':
      return matches(query.text);
    case 'not':
      return !evaluate(query.operand, matches);
    case 'and':
      return evaluate(query.left, matches) && evaluate(query.right, matches);
    case 'or':
      return evaluate(query.left, matches) || evaluate(query.right, matches);
  }
}

// --- Сопоставление слова с текстом игры -----------------------------------

/**
 * Слово должно начинаться с корня и добавлять к нему не больше трёх букв.
 * Без этого ограничения «кот» цепляет «которая», а «три» — «тридцать».
 */
const MAX_ENDING_LENGTH = 3;
const termPatterns = new Map<string, RegExp>();

function patternFor(term: string): RegExp {
  let pattern = termPatterns.get(term);
  if (!pattern) {
    const root = stem(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(` ${root}[\\p{L}\\p{N}]{0,${MAX_ENDING_LENGTH}} `, 'u');
    termPatterns.set(term, pattern);
  }
  return pattern;
}

function matchesKeyword(haystack: string, term: string): boolean {
  if (term.includes(' ')) return haystack.includes(` ${term} `);
  return patternFor(term).test(haystack);
}

/**
 * В поле «в названии» слово ищется по началу, без ограничения на длину
 * хвоста: там набирают кусок названия («симул» → «Симулятор»), а лишние
 * попадания видны глазом в той же колонке.
 */
function matchesTitlePart(haystack: string, term: string): boolean {
  return haystack.includes(` ${term.includes(' ') ? term : stem(term)}`);
}

interface IndexedGame {
  game: Game;
  /** Каждое поле хранится отдельно: набор полей задаётся на каждый запрос. */
  texts: Record<SearchField, string>;
}

export interface Dictionaries {
  tagTitles: Map<number, string>;
  categoryTitles: Map<number, string>;
}

function titlesById(titles: Map<number, string>): Map<number, string> {
  const normalized = new Map<number, string>();
  for (const [id, title] of titles) normalized.set(id, normalize(title));
  return normalized;
}

export function buildIndex(games: Game[], dictionaries: Dictionaries): IndexedGame[] {
  const tagText = titlesById(dictionaries.tagTitles);
  const categoryText = titlesById(dictionaries.categoryTitles);
  const join = (ids: number[], source: Map<number, string>) =>
    ids.map((id) => source.get(id) ?? '').join('');

  return games.map((game) => ({
    game,
    texts: {
      title: normalize(game.title),
      tags: join(game.tagIDs, tagText),
      categories: join(game.categoryIDs, categoryText),
      description: normalize(game.description ?? ''),
      instruction: normalize(game.instruction ?? ''),
    },
  }));
}

export function search(index: IndexedGame[], query: SearchQuery): Game[] {
  const keywordQuery = parseQuery(query.keywords, query.keywordMode);
  // В поле «в названии» несколько слов подряд — это кусок одного названия,
  // поэтому там режим не спрашиваем: без оператора всегда «и».
  const titleQuery = parseQuery(query.title, 'all');
  if (!keywordQuery && !titleQuery) return index.map((entry) => entry.game);

  return index
    .filter(({ texts }) => {
      if (titleQuery && !evaluate(titleQuery, (term) => matchesTitlePart(texts.title, term))) {
        return false;
      }
      if (!keywordQuery) return true;
      return evaluate(keywordQuery, (term) =>
        query.fields.some((field) => matchesKeyword(texts[field], term)),
      );
    })
    .map((entry) => entry.game);
}
