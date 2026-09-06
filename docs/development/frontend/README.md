# Frontend — desenvolvimento

## Legado (`legacy/frontend`)

```bash
cd legacy/frontend
npm install
npm run dev      # vite
```

SPA sem componentes de shell: navbar/sidebar pós-login viviam **inline**
em `App.tsx`. Ver tabela no doc do shell actual.

## Current (`current/client`)

Portagem activa. Ver:

- [`current/client/README.md`](../../../client/README.md) — scripts + mapa de pastas
- [GAME_SHELL.md](./GAME_SHELL.md) — navbar + sidebar pós-login (extração do monólito)
- [`architecture/DECISIONS.md`](../../architecture/DECISIONS.md) **#80**

```bash
cd current/client
npm install
npm run dev      # :5173, proxy /api → :3000
npm run typecheck
```

### Stack (current)
React 19 + Vite + Tailwind + `lucide-react`.
