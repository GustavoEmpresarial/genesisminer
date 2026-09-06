import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**', 'dist/**', 'client/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['server/core/**/*.ts', 'server/shared/**/*.ts', 'server/bootstrap/**/*.ts', 'server/modules/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'dist/**',
        'node_modules/**',
        // Clientes de conexão real (Prisma/Redis/Socket.IO) — cobertos por
        // teste de integração (tests/, a criar), não por unit test com serviço mockado
        // inteiro; testar aqui só a lógica pura de cada um (config, parsing, fallback).
        'server/core/database/prisma.ts',
        'server/core/database/pool.ts',
        'server/core/redis/client.ts',
        'server/core/socket/client.ts',
        // Barris de export puro (sem lógica própria) — nada a cobrir.
        'server/core/http/index.ts',
        // Efeito colateral puro no import (dotenv.config()) — nada a testar em unit test.
        'server/bootstrap/env.ts'
      ],
      thresholds: {
        // core/http: lógica de decisão pura (isOriginAllowed, buildCspDirectives, parseRateLimit,
        // isLoopbackIp, client-ip) está a 100% via teste unitário direto — o que sobra sem
        // cobertura é só o wiring fino sobre `cors()`/`helmet()`/`express-rate-limit`
        // (closures internas da lib, não código nosso).
        'server/core/http/**/*.ts': { statements: 90, branches: 85, functions: 85, lines: 90 },
        'server/core/redis/lock.ts': { statements: 90, branches: 80, functions: 100, lines: 90 },
        'server/shared/errors/**/*.ts': { statements: 100, branches: 88, functions: 100, lines: 100 },
        'server/shared/security/**/*.ts': { statements: 90, branches: 78, functions: 100, lines: 90 },
        'server/shared/utils/**/*.ts': { statements: 95, branches: 85, functions: 95, lines: 95 },
        'server/modules/**/*.ts': { statements: 85, branches: 70, functions: 85, lines: 85 }
      }
    }
  }
});
