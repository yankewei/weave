import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
  const env = loadEnv(mode, rootDirectory, '');

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': `http://127.0.0.1:${env.PORT ?? '3001'}`,
      },
    },
  };
});
