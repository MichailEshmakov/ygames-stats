import { useCallback, useEffect, useRef, useState } from 'react';
import type { Catalog, DeltaFile } from './types';

export type CollectTarget = 'catalog' | 'delta';

interface CollectStatus {
  running: boolean;
  target: CollectTarget | null;
  startedAt: number | null;
  lines: string[];
  exitCode: number | null;
}

const TARGET_TITLES: Record<CollectTarget, string> = {
  catalog: 'Каталог Яндекс Игр',
  delta: 'Прирост с game-analytics.ru',
};

interface Props {
  catalog: Catalog | null;
  delta: DeltaFile | null;
  /** Когда данные положили в браузер; null — пока не загружены. */
  savedAt: string | null;
  fromCache: boolean;
  outdated: boolean;
  /** Копия не легла в браузер — файлы придётся читать при каждом открытии. */
  storageFailed: boolean;
  onReload: () => void;
}

export function DataPanel({
  catalog,
  delta,
  savedAt,
  fromCache,
  outdated,
  storageFailed,
  onReload,
}: Props) {
  const [status, setStatus] = useState<CollectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshDetails, setRefreshDetails] = useState(false);
  const wasRunning = useRef(false);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/collect');
    if (!response.ok) return null;
    const next = (await response.json()) as CollectStatus;
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.running) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [status?.running, refresh]);

  useEffect(() => {
    if (status?.running) wasRunning.current = true;
    else if (wasRunning.current && status?.exitCode === 0) {
      wasRunning.current = false;
      onReload();
    }
  }, [status, onReload]);

  const startCollect = async (target: CollectTarget) => {
    setError(null);
    const query =
      target === 'catalog' && refreshDetails ? '?target=catalog&details=refresh' : `?target=${target}`;
    const response = await fetch(`/api/collect${query}`, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) {
      // Кнопка живёт только в dev-режиме: в собранной сборке отвечать некому.
      setError(body.error ?? 'Не удалось запустить сбор. Запущен ли npm run dev?');
      return;
    }
    setStatus(body as CollectStatus);
  };

  const running = Boolean(status?.running);

  return (
    <section className="data">
      <div className="data__row">
        <div className="data__state">
          <DataLine
            title="Каталог"
            value={
              catalog
                ? `${catalog.gamesCount.toLocaleString('ru-RU')} игр, ${formatDate(catalog.collectedAt)}`
                : 'не загружен'
            }
          />
          <DataLine
            title="Прирост за 30 дней"
            value={
              catalog?.deltaBaselineDate
                ? `свои снимки, к ${formatDate(catalog.deltaBaselineDate)}`
                : delta
                  ? `${delta.source}, ${formatDate(delta.collectedAt)}`
                  : 'нет данных'
            }
          />
          {savedAt && (
            <DataLine
              title="В браузере"
              value={
                fromCache
                  ? `сохранено ${formatDateTime(savedAt)}, открыто без загрузки`
                  : `обновлено ${formatDateTime(savedAt)}`
              }
            />
          )}
        </div>

        <div className="data__actions">
          <button
            className="button"
            type="button"
            disabled={running}
            onClick={() => void startCollect('catalog')}
          >
            Загрузить каталог
            <span className="button__hint">{refreshDetails ? '~20 минут' : '~16 минут'}</span>
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={refreshDetails}
              disabled={running}
              onChange={(event) => setRefreshDetails(event.target.checked)}
            />
            Перечитать описания
          </label>
          <button
            className="button"
            type="button"
            disabled={running}
            onClick={() => void startCollect('delta')}
          >
            Загрузить прирост
            <span className="button__hint">~36 минут</span>
          </button>
          <button className="button" type="button" disabled={running} onClick={onReload}>
            Перечитать файлы
            <span className="button__hint">обновить копию в браузере</span>
          </button>
        </div>
      </div>

      {outdated && (
        <p className="note note--warning">
          На диске лежат более свежие файлы — нажмите «Перечитать файлы», чтобы обновить копию
          в браузере.
        </p>
      )}

      {storageFailed && (
        <p className="note note--warning">
          Данные не поместились в хранилище браузера — они прочитаны из локальных файлов и
          будут читаться заново при каждом открытии.
        </p>
      )}

      {error && <p className="note note--error">{error}</p>}

      {status && (status.running || status.lines.length > 0) && (
        <div className="progress">
          <p className="progress__title">
            {status.running
              ? `Идёт сбор: ${TARGET_TITLES[status.target ?? 'catalog']}${elapsed(status.startedAt)}`
              : status.exitCode === 0
                ? 'Сбор завершён, данные обновлены.'
                : `Сбор прерван (код ${status.exitCode}).`}
          </p>
          <pre className="progress__log">{status.lines.join('\n')}</pre>
        </div>
      )}
    </section>
  );
}

function DataLine({ title, value }: { title: string; value: string }) {
  return (
    <p className="data__line">
      <span className="data__label">{title}:</span> {value}
    </p>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString('ru-RU');
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function elapsed(startedAt: number | null) {
  if (!startedAt) return '';
  const minutes = Math.floor((Date.now() - startedAt) / 60000);
  return minutes > 0 ? `, идёт ${minutes} мин.` : '';
}
