import { useCallback, useEffect, useRef, useState } from 'react';
import type { Catalog, DeltaFile } from './types';

export type CollectTarget = 'catalog' | 'delta';

interface CollectStatus {
  running: boolean;
  target: CollectTarget | null;
  step: number;
  steps: number;
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
  const [dataSize, setDataSize] = useState<number | null>(null);
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

  // Сколько нальётся в этот раз, заранее неизвестно — берём вес прошлого
  // сбора: от прогона к прогону каталог меняется на доли процента.
  useEffect(() => {
    let cancelled = false;
    void measureData().then((size) => {
      if (!cancelled) setDataSize(size);
    });
    return () => {
      cancelled = true;
    };
  }, [savedAt]);

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

  const startCollect = async () => {
    setError(null);
    const response = await fetch(`/api/collect${refreshDetails ? '?details=1' : ''}`, {
      method: 'POST',
    });
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
          <button className="button" type="button" disabled={running} onClick={() => void startCollect()}>
            Загрузить данные
            {dataSize !== null && <span className="button__hint">≈ {formatSize(dataSize)}</span>}
          </button>
          <label className="check">
            <input
              type="checkbox"
              checked={refreshDetails}
              disabled={running}
              onChange={(event) => setRefreshDetails(event.target.checked)}
            />
            <span className="check__text">
              Перечитать описания
              <span className="check__hint">описания и «как играть» — меняются редко</span>
            </span>
          </label>
        </div>
      </div>

      {outdated && (
        <p className="note note--warning">
          На диске лежат более свежие файлы.{' '}
          <button className="link" type="button" onClick={onReload}>
            Перечитать их
          </button>{' '}
          и обновить копию в браузере.
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
              ? `Идёт сбор${stepOf(status)}: ${TARGET_TITLES[status.target ?? 'catalog']}${elapsed(status.startedAt)}`
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

const DATA_FILES = [
  '/data/catalog.json',
  '/data/delta30.json',
  '/data/tags.json',
  '/data/categories.json',
];

async function measureData(): Promise<number | null> {
  const sizes = await Promise.all(DATA_FILES.map(fileSize));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? total : null;
}

async function fileSize(url: string): Promise<number> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    const length = response.ok ? response.headers.get('content-length') : null;
    return length ? Number(length) : 0;
  } catch {
    return 0;
  }
}

function formatSize(bytes: number) {
  const megabytes = bytes / 1024 / 1024;
  return megabytes < 10
    ? `${megabytes.toFixed(1).replace('.', ',')} МБ`
    : `${Math.round(megabytes)} МБ`;
}

function stepOf(status: CollectStatus) {
  return status.steps > 1 ? ` (шаг ${status.step} из ${status.steps})` : '';
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
