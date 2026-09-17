export interface Game {
  appID: number;
  title: string;
  slug: string | null;
  icon: string | null;
  rating: number | null;
  /** Число оценок игры на площадке. Отзывов как таковых каталог не отдаёт. */
  ratingCount: number;
  /**
   * Прирост числа оценок за ~30 дней.
   * null — если для игры ещё нет снимка месячной давности.
   * undefined — если истории нет вообще (первый прогон сборщика).
   */
  ratingCountDelta30?: number | null;
  developer: string | null;
  developerID: number | null;
  tagIDs: number[];
  categoryIDs: number[];
  description?: string;
  /** Блок «как играть» из карточки игры. */
  instruction?: string;
  /** Unix-время первой публикации, секунды. */
  firstPublished?: number | null;
}

export interface Catalog {
  collectedAt: string;
  lang: string;
  gamesCount: number;
  /** Дата снимка, к которому посчитан прирост, и его возраст в днях. */
  deltaBaselineDate: string | null;
  deltaBaselineDays: number | null;
  games: Game[];
}

export interface Tag {
  id: number;
  title: string;
  slug: string;
  gamesCount: number;
  /** Служебные теги площадка показывает только у себя внутри. */
  isService: boolean;
}

export interface TagsFile {
  collectedAt: string;
  tags: Tag[];
}

export interface Category {
  id: number;
  title: string;
  /** Английское имя категории — им она названа в адресах площадки. */
  name: string;
}

export interface CategoriesFile {
  collectedAt: string;
  categories: Category[];
}

/** Прирост, снятый с чужого агрегатора: public/data/delta30.json. */
export interface DeltaFile {
  collectedAt: string;
  source: string;
  sourceUrl: string;
  gamesCount: number;
  deltas: Record<string, number>;
}
