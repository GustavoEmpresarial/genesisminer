import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { buildAssetFileNames } from './asset-epoch';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const apiPort = env.PORT || env.API_PORT || '3000';
  const apiTarget = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src')
      }
    },
    build: {
      rollupOptions: {
        output: buildAssetFileNames()
      }
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      allowedHosts: ['localhost', '127.0.0.1', 'genesisdao.tech', 'test.genesisdao.tech'],
      // `/api` + `/img` → backend. `/img` é rota HTTP (storage/uploads +
      // storage/media-seed via IMG_*). URLs flat `/img/123_foo.webp` só o handler
      // de genesis-api (`rust/genesis-api/src/img.rs`) resolve (senão Vite
      // devolve HTML SPA).
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true, secure: false },
        '/img': { target: apiTarget, changeOrigin: true, secure: false }
      }
    }
  };
});
