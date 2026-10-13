// Sustituye los plugins de Capacitor por una base SQLite de Node para probar el código real de la app
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const aqui = path.dirname(fileURLToPath(import.meta.url));
const MAPA = {
  '@capacitor/core': 'capacitor-core.mjs',
  '@capacitor-community/sqlite': 'sqlite.mjs',
  '@capacitor/filesystem': 'vacio.mjs',
  '@capacitor/share': 'vacio.mjs',
  'jeep-sqlite/loader': 'vacio.mjs',
};
export async function resolve(spec, ctx, next) {
  if (MAPA[spec]) return { url: pathToFileURL(path.join(aqui, MAPA[spec])).href, shortCircuit: true };
  if (spec.endsWith('.sql?raw')) return { url: pathToFileURL(path.resolve(path.dirname(fileURLToPath(ctx.parentURL)), spec.replace('?raw', ''))).href + '?raw', shortCircuit: true };
  return next(spec, ctx);
}
export async function load(url, ctx, next) {
  if (url.endsWith('.sql?raw')) {
    const texto = fs.readFileSync(fileURLToPath(url.replace('?raw', '')), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(texto)};`, shortCircuit: true };
  }
  return next(url, ctx);
}
