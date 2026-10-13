// Prueba de la búsqueda de módulos. Ejecutar con: node --import ./tests/stubs/registrar.mjs tests/busqueda.mjs
import assert from 'node:assert/strict';
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { addEventListener() {}, createElement: () => ({}) };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
const { buscarModulos } = await import('../src/inicio.js');
const ids = (t, puede) => buscarModulos(t, puede).map((m) => m.id);
assert.equal(ids('vent')[0], 'ventas', 'lo que empieza con el texto va primero');
assert.ok(ids('GARANTIA').includes('garantias'), 'sin importar acentos ni mayúsculas');
assert.ok(ids('garantías').includes('garantias'));
assert.ok(ids('factura').includes('ventas'), 'por palabras relacionadas');
assert.ok(ids('respaldo').includes('ajustes'));
assert.deepEqual(ids('zzz'), []);
assert.equal(ids('').length, 12, 'sin texto salen todos los módulos');
assert.deepEqual(ids('', (id) => id === 'ventas' || id === 'inicio'), ['ventas'], 'solo los módulos con permiso');
assert.equal(ids('ajust', (id) => id !== 'ajustes').includes('ajustes'), false, 'no ofrece módulos sin permiso');
console.log('  ✔ la búsqueda de módulos ignora acentos y mayúsculas, usa palabras relacionadas y respeta los permisos');
process.exit(0);
