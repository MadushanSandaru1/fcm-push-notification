import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('./web', import.meta.url));
const modules = fileURLToPath(new URL('./node_modules', import.meta.url));

export default defineConfig({
  root: web,
  envDir: web,
  plugins: [vue()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    allowedHosts: ['localhost'],
    fs: {
      strict: true,
      allow: [web, modules],
      deny: ['**/.env', '**/.env.*', '**/.git/**', '**/*service-account*.json', '**/*firebase-adminsdk*.json', '**/*.{pem,crt,key}'],
    },
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['tests/**/*.test.js'],
    environment: 'node',
    clearMocks: true,
  },
});
