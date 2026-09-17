import { spawn, type ChildProcess } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

type Target = 'catalog' | 'delta';

const SCRIPTS: Record<Target, string> = {
  catalog: 'scripts/collect.mjs',
  delta: 'scripts/collect-delta.mjs',
};

interface RunState {
  target: Target;
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

  const start = (target: Target, args: string[]) => {
    const child = spawn(process.execPath, [SCRIPTS[target], ...args], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const state: RunState = { target, startedAt: Date.now(), lines: [], process: child, exitCode: null };

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
      state.exitCode = code ?? 0;
      state.process = null;
    });

    current = state;
    return state;
  };

  const statusOf = (state: RunState | null) =>
    state === null
      ? { running: false, target: null, lines: [], exitCode: null, startedAt: null }
      : {
          running: state.process !== null,
          target: state.target,
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
          return send(409, { error: `Уже идёт сбор: ${current.target}` });
        }

        const target = url.searchParams.get('target');
        if (target !== 'catalog' && target !== 'delta') {
          return send(400, { error: 'target должен быть catalog или delta' });
        }
        // Описания игр сборщик берёт из прошлого каталога; перечитать их
        // целиком просим только по явной галочке на странице.
        const args = target === 'catalog' && url.searchParams.get('details') === 'refresh'
          ? ['--refresh-details']
          : [];
        return send(200, statusOf(start(target, args)));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), collectorApi()],
  server: { open: true },
});
