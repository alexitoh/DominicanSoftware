// Copia el motor SQLite para navegador (sql-wasm.wasm) a public/assets.
// Solo hace falta para probar la app en el navegador; en el celular no se usa.
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const origen = 'node_modules/sql.js/dist/sql-wasm.wasm';
if (!existsSync(origen)) {
  console.log('sql.js todavía no está instalado; se omite la copia del wasm.');
  process.exit(0);
}
mkdirSync('public/assets', { recursive: true });
cpSync(origen, 'public/assets/sql-wasm.wasm');
console.log('sql-wasm.wasm copiado a public/assets');
