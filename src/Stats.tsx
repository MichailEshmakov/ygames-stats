import { useMemo, useState } from 'react';
import type { Game } from './types';

const DEFAULT_THRESHOLDS = '100, 1000';

interface Props {
  games: Game[];
}

interface Row {
  key: string;
  label: string;
  games: number;
  gamesWithDelta: number;
  medianDelta: number | null;
  sumDelta: number;
  sumRatingCount: number;
}

export function Stats({ games }: Props) {
  const [thresholdsText, setThresholdsText] = useState(DEFAULT_THRESHOLDS);

  const thresholds = useMemo(() => parseThresholds(thresholdsText), [thresholdsText]);

  const rows = useMemo<Row[]>(
    () => [
      summarize('all', 'Все найденные', games),
      ...thresholds.map((threshold) =>
        summarize(
          `gt-${threshold}`,
          `Более ${threshold.toLocaleString('ru-RU')} отзывов за всё время`,
          games.filter((game) => game.ratingCount > threshold),
        ),
      ),
    ],
    [games, thresholds],
  );

  return (
    <section className="stats">
      <div className="stats__head">
        <h2 className="stats__title">Сводка по найденным играм</h2>
        <label className="stats__filter">
          <span className="field__label">Отсечения по числу отзывов</span>
          <input
            className="field__input"
            value={thresholdsText}
            onChange={(event) => setThresholdsText(event.target.value)}
            placeholder="100, 1000"
          />
          <span className="field__hint">
            Через запятую. Для каждого числа считаем строку по играм, у которых отзывов больше.
          </span>
        </label>
      </div>

      <table className="stats__table">
        <thead>
          <tr>
            <th>Выборка</th>
            <th className="games__number">Игр</th>
            <th className="games__number">Медиана за 30 дней</th>
            <th className="games__number">Сумма за 30 дней</th>
            <th className="games__number">Всего отзывов</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td className="games__number">{row.games.toLocaleString('ru-RU')}</td>
              <td className="games__number">
                {row.medianDelta === null ? (
                  <span className="games__empty">—</span>
                ) : (
                  formatMedian(row.medianDelta)
                )}
              </td>
              <td className="games__number">{row.sumDelta.toLocaleString('ru-RU')}</td>
              <td className="games__number">{row.sumRatingCount.toLocaleString('ru-RU')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="stats__note">
        Медиана и сумма за 30 дней считают игры без известного прироста нулём
        {rows[0].games > rows[0].gamesWithDelta && (
          <>
            {' '}— в строке «Все найденные» прирост известен у{' '}
            {rows[0].gamesWithDelta.toLocaleString('ru-RU')} игр из{' '}
            {rows[0].games.toLocaleString('ru-RU')}
          </>
        )}
        .
      </p>
    </section>
  );
}

function summarize(key: string, label: string, games: Game[]): Row {
  const deltas: number[] = [];
  let gamesWithDelta = 0;
  let sumDelta = 0;
  let sumRatingCount = 0;

  for (const game of games) {
    sumRatingCount += game.ratingCount;
    const delta = game.ratingCountDelta30;
    // Источник прироста перечисляет только игры, у которых он был: отсутствие
    // записи означает, что за месяц не прибавилось ни одной оценки.
    if (delta !== null && delta !== undefined) gamesWithDelta += 1;
    deltas.push(delta ?? 0);
    sumDelta += delta ?? 0;
  }

  return {
    key,
    label,
    games: games.length,
    gamesWithDelta,
    medianDelta: median(deltas),
    sumDelta,
    sumRatingCount,
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatMedian(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
}

function parseThresholds(text: string): number[] {
  const values = text
    .split(/[,;\s]+/)
    .map((part) => Number(part.replace(/[^\d]/g, '')))
    .filter((value) => Number.isFinite(value) && value > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}
