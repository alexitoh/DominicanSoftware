// dgii.js - padrón de contribuyentes (RNC) de la DGII, guardado en la base del servidor para consultarlo al instante.
// La DGII publica el listado completo en https://dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip (texto separado por "|").
// Se lee sin depender del orden exacto de las columnas: el estatus y la fecha se reconocen por su contenido.
import zlib from 'node:zlib';

export const URL_DGII = 'https://dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip';
const ESTADOS = /^(ACTIVO|SUSPENDIDO|DADO DE BAJA|ANULADO|CESE TEMPORAL|CESADO|INACTIVO|BAJA|SUSPENDIDA)\b/i;

export function prepararTablaRNC(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dgii_rnc (
      rnc TEXT PRIMARY KEY, nombre TEXT NOT NULL, actividad TEXT, inicio TEXT, estado TEXT, regimen TEXT
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS dgii_meta (clave TEXT PRIMARY KEY, valor TEXT);
  `);
}

// Saca el primer archivo de un .zip (método 0 = sin comprimir, 8 = deflate)
export function descomprimirZip(buf) {
  if (buf.length < 22) throw new Error('El archivo no es un .zip válido.');
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw new Error('El archivo no es un .zip válido.');
  const total = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  for (let k = 0; k < total; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('El .zip está dañado.');
    const metodo = buf.readUInt16LE(p + 10);
    const tam = buf.readUInt32LE(p + 20);
    const nombre = buf.toString('latin1', p + 46, p + 46 + buf.readUInt16LE(p + 28));
    const extra = buf.readUInt16LE(p + 30), coment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    p += 46 + buf.readUInt16LE(p + 28) + extra + coment;
    if (nombre.endsWith('/')) continue;
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(ini, ini + tam);
    if (metodo === 0) return datos;
    if (metodo === 8) return zlib.inflateRawSync(datos);
    throw new Error('El .zip usa una compresión no admitida.');
  }
  throw new Error('El .zip no contiene archivos.');
}

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

// Una línea del padrón → fila, o null si no es un registro (encabezado, línea vacía)
export function leerLinea(linea) {
  const c = linea.split('|').map((x) => x.trim());
  const rnc = soloDigitos(c[0]);
  if (c.length < 4 || !(rnc.length === 9 || rnc.length === 11) || !c[1]) return null;
  let iEstado = -1;
  for (let i = 2; i < c.length; i++) if (ESTADOS.test(c[i])) { iEstado = i; break; }
  const inicio = c.find((x, i) => i >= 2 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(x)) || null;
  return {
    rnc, nombre: c[1], actividad: c[2] && c[2] !== c[1] && !ESTADOS.test(c[2]) && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c[2]) ? c[2] : null,
    inicio, estado: iEstado >= 0 ? c[iEstado].toUpperCase() : null, regimen: iEstado >= 0 ? (c[iEstado + 1] || null) : null,
  };
}

// Reemplaza el padrón con el contenido del archivo (texto del .txt o bytes del .zip). Devuelve cuántos RNC quedaron.
export function importarPadron(db, archivo) {
  let datos = Buffer.isBuffer(archivo) ? archivo : Buffer.from(archivo);
  if (datos.length > 4 && datos.readUInt32LE(0) === 0x04034b50) datos = descomprimirZip(datos);
  const texto = datos.toString('latin1');
  const filas = [];
  let i = 0;
  while (i < texto.length) {
    let j = texto.indexOf('\n', i);
    if (j < 0) j = texto.length;
    const f = leerLinea(texto.slice(i, j).replace(/\r$/, ''));
    if (f) filas.push(f);
    i = j + 1;
  }
  if (filas.length < 1) throw new Error('No se encontraron contribuyentes en el archivo. ¿Es el listado de RNC de la DGII?');
  prepararTablaRNC(db);
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM dgii_rnc');
    const ins = db.prepare('INSERT OR REPLACE INTO dgii_rnc (rnc, nombre, actividad, inicio, estado, regimen) VALUES (?,?,?,?,?,?)');
    for (const f of filas) ins.run(f.rnc, f.nombre, f.actividad, f.inicio, f.estado, f.regimen);
    db.prepare("INSERT OR REPLACE INTO dgii_meta (clave, valor) VALUES ('actualizado', ?)").run(new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return filas.length;
}

export async function descargarPadron(db, { url = URL_DGII, fetchFn = fetch } = {}) {
  const r = await fetchFn(url, { headers: { 'User-Agent': 'Mozilla/5.0 DominicanSoftware' }, signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`La DGII respondió ${r.status}.`);
  return importarPadron(db, Buffer.from(await r.arrayBuffer()));
}

export function estadoPadron(db) {
  prepararTablaRNC(db);
  const n = db.prepare('SELECT COUNT(*) AS n FROM dgii_rnc').get().n;
  const a = db.prepare("SELECT valor FROM dgii_meta WHERE clave = 'actualizado'").get();
  return { cantidad: n, actualizado: a?.valor || null };
}

// Consulta un RNC o cédula. activo = el padrón dice ACTIVO.
export function consultarRNC(db, numero) {
  const rnc = soloDigitos(numero);
  if (!(rnc.length === 9 || rnc.length === 11)) return { error: 'Escribe un RNC de 9 números o una cédula de 11.' };
  const p = estadoPadron(db);
  if (!p.cantidad) return { padronVacio: true };
  const f = db.prepare('SELECT * FROM dgii_rnc WHERE rnc = ?').get(rnc);
  if (!f) return { encontrado: false, rnc, actualizado: p.actualizado };
  const estado = f.estado || 'DESCONOCIDO';
  return {
    encontrado: true, rnc, nombre: f.nombre, actividad: f.actividad, inicio: f.inicio, estado, regimen: f.regimen,
    activo: /^ACTIVO/i.test(estado), actualizado: p.actualizado,
  };
}
