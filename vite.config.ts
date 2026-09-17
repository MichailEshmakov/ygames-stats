import { spawn, type ChildProcess } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

type Target = 'catalog' | 'delta';

const SCRIPTS: Record<Target, string> = {
  catalog: 'scripts/collect.mjs',
  delta: 'scripts/collect-delta.mjs',
};

interface Job {
  target: Target;
  args: string[];
}

interface RunState {
  plan: Job[];
  step: number;
  startedAt: number;
  lines: string[];
  process: ChildProcess | null;
  exitCode: number | null;
}

/**
 * Сборщики ходят в сеть, а браузеру туда нельзя: ни API Яндекса, ни
 * game-analytics.ru не отдают CORS-заголовков. Поэтому кнопка на странице
 * не качает данные сама, а просит об этом dev-сервер — он и запускает те же
 * скрипты, что и npm run collect.
 */
function collectorApi(): Plugin {
  let current: RunState | null = null;

  const runStep = (state: RunState) => {
    const job = state.plan[state.step];
    const child = spawn(process.execPath, [SCRIPTS[job.target], ...job.args], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    state.process = child;

    const absorb = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        const text = line.trim();
        if (!text) continue;
        state.lines.push(text);
        if (state.lines.length > 200) state.lines.shift();
      }
    };
    child.stdout?.on('data', absorb);
    child.stderr?.on('data', absorb);
    child.on('close', (code) => {
      state.process = null;
      // Следующий шаг запускаем, только если предыдущий дошёл до конца:
      // считать прирост поверх недособранного каталога нечего.
      if (code === 0 && state.step + 1 < state.plan.length) {
        state.step += 1;
        runStep(state);
        return;
      }
      state.exitCode = code ?? 0;
    });
  };

  const start = (plan: Job[]) => {
    const state: RunState = {
      plan,
      step: 0,
      startedAt: Date.now(),
      lines: [],
      process: null,
      exitCode: null,
    };
    runStep(state);
    current = state;
    return state;
  };

  const statusOf = (state: RunState | null) =>
    state === null
      ? { running: false, target: null, step: 0, steps: 0, lines: [], exitCode: null, startedAt: null }
      : {
          running: state.process !== null,
          target: state.plan[state.step].target,
          step: state.step + 1,
          steps: state.plan.length,
          startedAt: state.startedAt,
          lines: state.lines.slice(-12),
          exitCode: state.exitCode,
        };

  return {
    name: 'collector-api',
    configureServer(server) {
      server.middlewares.use('/api/collect', (request, response) => {
        const send = (status: number, body: unknown) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json; charset=utf-8');
          response.end(JSON.stringify(body));
        };

        const url = new URL(request.url ?? '/', 'http://localhost');
        if (request.method === 'GET') return send(200, statusOf(current));

        if (request.method !== 'POST') return send(405, { error: 'Только GET и POST' });
        if (current?.process) {
          return send(409, { error: 'Сбор уже идёт' });
        }

        // Описания игр сборщик берёт из прошлого каталога: они почти не
        // меняются, а их перечитывание удлиняет обход.
        const details = url.searchParams.get('details') === '1';
        const plan: Job[] = [
          { target: 'catalog', args: details ? ['--refresh-details'] : [] },
          { target: 'delta', args: [] },
        ];
        return send(200, statusOf(start(plan)));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), collectorApi()],
  // localhost на машине резолвится в ::1, и Vite вешается только на IPv6-петлю —
  // браузер при этом стучится в 127.0.0.1 и получает отказ. Адрес задан явно.
  server: { host: '127.0.0.1', open: true },
});
