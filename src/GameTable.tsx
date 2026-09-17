import { useEffect, useState } from 'react';
import type { Game } from './types';

export type SortField = 'ratingCount' | 'delta30' | 'title';

const PAGE_SIZE = 100;

interface Props {
  games: Game[];
  sortField: SortField;
  onSortChange: (field: SortField) => void;
}

export function GameTable({ games, sortField, onSortChange }: Props) {
  // В каталоге больше двадцати тысяч игр — рисуем порциями, иначе вкладка
  // встаёт колом на первом же пустом запросе.
  const [visible, setVisible] = useState(PAGE_SIZE);
  useEffect(() => setVisible(PAGE_SIZE), [games]);

  if (!games.length) {
    return <p className="note">Ничего не нашлось. Попробуйте меньше слов или режим «любое из них».</p>;
  }

  return (
    <>
      <table className="games">
        <thead>
          <tr>
            <th className="games__num">#</th>
            <th className="games__icon" aria-label="Иконка" />
            <th>
              <SortButton field="title" current={sortField} onChange={onSortChange}>
                Игра
              </SortButton>
            </th>
            <th className="games__number">
              <SortButton field="ratingCount" current={sortField} onChange={onSortChange}>
                Всего оценок
              </SortButton>
            </th>
            <th className="games__number">
              <SortButton field="delta30" current={sortField} onChange={onSortChange}>
                +30 дней
              </SortButton>
            </th>
          </tr>
        </thead>
        <tbody>
          {games.slice(0, visible).map((game, position) => (
            <tr key={game.appID}>
              <td className="games__num">{position + 1}</td>
              <td className="games__icon">
                {game.icon && <img src={game.icon} alt="" width={40} height={40} loading="lazy" />}
              </td>
              <td>
                <a
                  className="games__title"
                  href={`https://yandex.ru/games/app/${game.appID}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {game.title}
                </a>
                {game.developer && <span className="games__developer">{game.developer}</span>}
              </td>
              <td className="games__number">{game.ratingCount.toLocaleString('ru-RU')}</td>
              <td className="games__number">
                <Delta value={game.ratingCountDelta30} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {visible < games.length && (
        <button className="more" type="button" onClick={() => setVisible(visible + PAGE_SIZE)}>
          Показать ещё {Math.min(PAGE_SIZE, games.length - visible)}
        </button>
      )}
    </>
  );
}

function Delta({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="games__empty">—</span>;
  if (value <= 0) return <span className="games__empty">{value.toLocaleString('ru-RU')}</span>;
  return <span className="games__growth">+{value.toLocaleString('ru-RU')}</span>;
}

interface SortButtonProps {
  field: SortField;
  current: SortField;
  onChange: (field: SortField) => void;
  children: React.ReactNode;
}

function SortButton({ field, current, onChange, children }: SortButtonProps) {
  return (
    <button
      className={`sort${current === field ? ' sort--active' : ''}`}
      type="button"
      onClick={() => onChange(field)}
    >
      {children}
    </button>
  );
}
