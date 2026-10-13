import { defineConfig } from 'vite';

export default defineConfig({
  // host: true permite abrir la app desde el celular con la IP de tu computadora
  server: { host: true },
  build: { target: 'es2020' },
});
