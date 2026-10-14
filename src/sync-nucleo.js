// sync-nucleo.js - motor de sincronización (sin dependencias del navegador, se prueba con Node).
//
// Cada registro tiene un "uid" que es igual en todos los dispositivos (el "id" local sigue siendo propio de cada uno).
// Los triggers de la base marcan lo que cambió (dirty) y guardan lo que se borró (sync_borrados).
// sincronizar(): sube lo marcado, baja lo nuevo del servidor y lo aplica. Gana el cambio más reciente de cada registro;
// el stock no se copia: cada dispositivo suma los movimientos de inventario de todos.
import { TABLAS, porNombre, CONFIG_COMPARTIDA, SQL_AHORA } from './sync-esquema.js';

const MAX_BYTES = 1_500_000; // tamaño aproximado de cada envío
const MAX_CAMBIOS = 800;
const POR_TABLA = 400;

const ENVOLTURA = (sentencias) => [
  { statement: 'UPDATE sync_ctl SET aplicando = 1 WHERE id = 1', values: [] },
  ...sentencias,
  { statement: 'UPDATE sync_ctl SET aplicando = 0 WHERE id = 1', values: [] },
];

const filtroConfig = `clave IN (${CONFIG_COMPARTIDA.map((k) => `'${k}'`).join(',')})`;

// Agrupa las llaves foráneas por columna (una columna puede apuntar a varias tablas según el motivo)
function gruposRef(d) {
  const m = new Map();
  for (const r of d.refs || []) {
    if (!m.has(r.col)) m.set(r.col, []);
    m.get(r.col).push({ ...r, clave: r.clave || r.col });
  }
  return m;
}

export function crearMotor({ consultar, lote, nube, alMiembros = null }) {
  let corriendo = null;

  const ctl = async () => (await consultar('SELECT * FROM sync_ctl WHERE id = 1'))[0] || {};

  // ---------- Preparación ----------
  // Si el stock de un producto no coincide con la suma de sus movimientos, se registra la diferencia como saldo inicial
  async function reconciliarStock() {
    const filas = await consultar(
      `SELECT id, d FROM (SELECT id, stock_actual - COALESCE((SELECT SUM(cantidad) FROM movimientos_inventario m WHERE m.producto_id = productos.id), 0) AS d
                            FROM productos) WHERE d <> 0`);
    if (!filas.length) return 0;
    await lote(filas.map((f) => ({
      statement: "INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo) VALUES (?, 'ajuste', ?, 'saldo inicial')",
      values: [f.id, f.d],
    })));
    return filas.length;
  }

  // Marca todo lo que hay en este dispositivo para subirlo (al conectar por primera vez)
  async function marcarTodo() {
    await reconciliarStock();
    const sets = TABLAS.map((d) => ({
      statement: `UPDATE ${d.t} SET dirty = 1, act = COALESCE(act, ${SQL_AHORA}) WHERE uid IS NOT NULL${d.t === 'config' ? ` AND ${filtroConfig}` : ''}`,
      values: [],
    }));
    await lote(ENVOLTURA(sets));
  }

  // Borra los datos de este dispositivo para empezar de cero con lo que tiene la nube
  async function reemplazarLocal() {
    const sets = [...TABLAS].reverse().map((d) => ({
      statement: `DELETE FROM ${d.t}${d.t === 'config' ? ` WHERE ${filtroConfig}` : ''}`, values: [],
    }));
    sets.push({ statement: 'DELETE FROM sync_borrados', values: [] });
    sets.push({ statement: 'UPDATE sync_ctl SET cursor = 0 WHERE id = 1', values: [] });
    await lote(ENVOLTURA(sets));
  }

  async function vincular({ dispositivo, codigo, negocio, negocioNombre, epoca = 0, negocioId = null }) {
    await lote([{
      statement: 'UPDATE sync_ctl SET dispositivo = ?, codigo = ?, negocio = ?, negocio_nombre = ?, cursor = 0, epoca = ?, negocio_id = ? WHERE id = 1',
      values: [dispositivo, codigo, negocio, negocioNombre, epoca || 0, negocioId || null],
    }]);
  }

  // El identificador (RNC o número asignado) lo cambia solo el propietario del sistema: aquí se guarda el vigente
  async function recordarIdentificador(negocioId) {
    await lote([{ statement: 'UPDATE sync_ctl SET negocio_id = ? WHERE id = 1', values: [negocioId || null] }]);
  }

  async function desvincular() {
    await lote([{ statement: 'UPDATE sync_ctl SET negocio = NULL, negocio_nombre = NULL, negocio_id = NULL, codigo = NULL, cursor = 0, ultimo = NULL WHERE id = 1', values: [] }]);
  }

  async function pendientes() {
    let n = 0;
    for (const d of TABLAS) n += (await consultar(`SELECT COUNT(*) AS n FROM ${d.t} WHERE dirty = 1`))[0].n;
    n += (await consultar('SELECT COUNT(*) AS n FROM sync_borrados'))[0].n;
    return n;
  }

  // ---------- Subir ----------
  function sqlSucias(d) {
    const refs = d.refs || [];
    const joins = refs.map((r, i) =>
      `LEFT JOIN ${r.tabla} r${i} ON r${i}.id = t.${r.col}${r.cuando ? ` AND (${r.cuando.replace(/\bmotivo\b/g, 't.motivo')})` : ''}`);
    const campos = [`t.uid AS _uid`, `t.act AS _act`, ...d.cols.map((c) => `t.${c} AS ${c}`), ...refs.map((r, i) => `r${i}.uid AS _r${i}`)];
    return `SELECT ${campos.join(', ')} FROM ${d.t} t ${joins.join(' ')} WHERE t.dirty = 1 ORDER BY t.rowid LIMIT ${POR_TABLA}`;
  }

  async function reunir() {
    const cambios = [];
    const marcas = []; // para limpiar después: { t, uid, act, borrado }
    let bytes = 0;
    const lleno = () => cambios.length >= MAX_CAMBIOS || bytes >= MAX_BYTES;

    for (const d of TABLAS) {
      if (lleno()) break;
      const filas = await consultar(sqlSucias(d));
      for (const f of filas) {
        const datos = {};
        for (const c of d.cols) datos[c] = f[c] ?? null;
        (d.refs || []).forEach((r, i) => { datos[r.clave || r.col] = f[`_r${i}`] ?? null; });
        const cambio = { t: d.t, uid: f._uid, u: f._act ?? Date.now(), d: datos };
        const tam = JSON.stringify(cambio).length;
        if (cambios.length && (bytes + tam > MAX_BYTES || cambios.length >= MAX_CAMBIOS)) break;
        cambios.push(cambio);
        marcas.push({ t: d.t, uid: f._uid, act: f._act });
        bytes += tam;
      }
    }
    // Las bajas van al final y de hijos a padres
    if (!lleno()) {
      const orden = Object.fromEntries(TABLAS.map((d, i) => [d.t, i]));
      const bajas = (await consultar('SELECT tabla, uid, act FROM sync_borrados ORDER BY act LIMIT 400'))
        .sort((a, b) => orden[b.tabla] - orden[a.tabla]);
      for (const b of bajas) {
        if (cambios.length >= MAX_CAMBIOS) break;
        cambios.push({ t: b.tabla, uid: b.uid, u: b.act, x: true });
        marcas.push({ t: b.tabla, uid: b.uid, act: b.act, borrado: true });
      }
    }
    return { cambios, marcas };
  }

  async function limpiar(marcas) {
    if (!marcas.length) return;
    const sets = marcas.map((m) => (m.borrado
      ? { statement: 'DELETE FROM sync_borrados WHERE tabla = ? AND uid = ? AND act = ?', values: [m.t, m.uid, m.act] }
      : { statement: `UPDATE ${m.t} SET dirty = 0 WHERE uid = ? AND act IS ?`, values: [m.uid, m.act] }));
    await lote(ENVOLTURA(sets));
  }

  // ---------- Bajar ----------
  // Si un valor único ya lo usa otro registro local, se le agrega un sufijo al que llega
  async function ajustarUnicos(d, c) {
    for (const col of d.unicos || []) {
      const valor = c.d?.[col];
      if (valor == null || valor === '') continue;
      let candidato = valor;
      for (let n = 2; n < 50; n++) {
        const [dup] = await consultar(`SELECT uid FROM ${d.t} WHERE ${col} = ? AND (uid IS NULL OR uid <> ?) LIMIT 1`, [candidato, c.uid]);
        if (!dup) break;
        candidato = `${valor} (${n})`;
      }
      c.d[col] = candidato;
    }
  }

  function sentenciasDe(d, c) {
    if (c.x) {
      return [{ statement: `DELETE FROM ${d.t} WHERE uid = ? AND (act IS NULL OR act <= ?)`, values: [c.uid, c.u] }];
    }
    const datos = c.d || {};
    const grupos = gruposRef(d);
    const colsPlanas = d.cols;
    const colsRef = [...grupos.keys()];
    const columnas = [...colsPlanas, ...colsRef, 'uid', 'dirty', 'act'];
    const marcas = [...colsPlanas.map(() => '?')];
    const valores = colsPlanas.map((k) => datos[k] ?? null);
    for (const [, refs] of grupos) {
      const exprs = refs.map((r) => `(SELECT id FROM ${r.tabla} WHERE uid = ?)`);
      marcas.push(exprs.length > 1 ? `COALESCE(${exprs.join(', ')})` : exprs[0]);
      for (const r of refs) valores.push(datos[r.clave] ?? null);
    }
    marcas.push('?', '0', '?');
    valores.push(c.uid, c.u);
    if (d.clave) { columnas.push(d.clave); marcas.push('?'); valores.push(c.uid); }

    const sets = [];
    if (d.t === 'movimientos_inventario') {
      // El stock cambia solo la primera vez que llega el movimiento
      sets.push({
        statement: `UPDATE productos SET stock_actual = stock_actual + ?
                     WHERE uid = ? AND NOT EXISTS (SELECT 1 FROM movimientos_inventario WHERE uid = ?)`,
        values: [datos.cantidad ?? 0, datos.producto_id ?? null, c.uid],
      });
    }
    const actualizar = d.inmutable
      ? 'DO NOTHING'
      : `DO UPDATE SET ${[...colsPlanas, ...colsRef].map((k) => `${k} = excluded.${k}`).join(', ')}, dirty = 0, act = excluded.act
         WHERE ${d.t}.act IS NULL OR ${d.t}.act <= excluded.act`;
    sets.push({
      statement: `INSERT INTO ${d.t} (${columnas.join(', ')}) VALUES (${marcas.join(', ')}) ON CONFLICT(uid) ${actualizar}`,
      values: valores,
    });
    return sets;
  }

  async function aplicar(cambios) {
    const res = { aplicados: 0, omitidos: 0, errores: [] };
    const sets = [];
    const porCambio = [];
    for (const c of cambios) {
      const d = porNombre[c.t];
      if (!d || !c.uid) { res.omitidos++; continue; }
      if (d.t === 'config' && !CONFIG_COMPARTIDA.includes(c.uid)) { res.omitidos++; continue; }
      if (!c.x) await ajustarUnicos(d, c);
      const s = sentenciasDe(d, c);
      porCambio.push({ c, s });
      sets.push(...s);
    }
    if (!sets.length) return res;
    try {
      await lote(ENVOLTURA(sets));
      res.aplicados = porCambio.length;
    } catch {
      // Algo no cuadró (por ejemplo un registro cuyo padre no existe): se aplica uno por uno para no perder el resto
      for (const { c } of porCambio) {
        try {
          if (!c.x) await ajustarUnicos(porNombre[c.t], c); // ahora sí ve lo que ya se aplicó
          await lote(ENVOLTURA(sentenciasDe(porNombre[c.t], c)));
          res.aplicados++;
        } catch (e) {
          res.omitidos++;
          res.errores.push(`${c.t}/${c.uid}: ${e.message || e}`);
        }
      }
    }
    return res;
  }

  // ---------- Ciclo completo ----------
  async function ciclo(alProgreso) {
    let c = await ctl();
    if (!c.negocio || !c.dispositivo) throw new Error('Este dispositivo no está conectado a la nube.');
    await reconciliarStock();
    const total = { subidos: 0, bajados: 0, omitidos: 0, errores: [] };
    let cursor = c.cursor || 0;

    for (let ronda = 0; ronda < 500; ronda++) {
      const { cambios, marcas } = await reunir();
      const resp = await nube.sync({ dispositivo: c.dispositivo, desde: cursor, cambios, limite: 500, epoca: c.epoca || 0 });
      if (resp.miembros && alMiembros) await alMiembros(resp.miembros);
      if (resp.reiniciar) {
        // El propietario limpió los datos del negocio: se vacía lo local y se adopta la nueva época
        await reemplazarLocal();
        await lote([{ statement: 'UPDATE sync_ctl SET epoca = ?, cursor = 0 WHERE id = 1', values: [resp.epoca || 0] }]);
        c = await ctl();
        cursor = 0;
        total.reiniciado = true;
        continue;
      }
      await limpiar(marcas);
      const r = await aplicar(resp.cambios || []);
      total.subidos += resp.aceptados ?? cambios.length;
      total.bajados += r.aplicados;
      total.omitidos += r.omitidos;
      total.errores.push(...r.errores);
      cursor = Math.max(cursor, resp.hasta || 0);
      await lote([{ statement: "UPDATE sync_ctl SET cursor = ?, ultimo = datetime('now') WHERE id = 1", values: [cursor] }]);
      alProgreso?.({ ...total, hayMas: !!resp.hayMas });
      const quedan = cambios.length > 0 ? (await pendientes()) > 0 : false;
      if (!resp.hayMas && !quedan) break;
    }
    return total;
  }

  function sincronizar(alProgreso) {
    if (!corriendo) corriendo = ciclo(alProgreso).finally(() => { corriendo = null; });
    return corriendo;
  }

  return {
    ctl, vincular, recordarIdentificador, desvincular, marcarTodo, reemplazarLocal, reconciliarStock, pendientes, sincronizar,
    enCurso: () => !!corriendo,
  };
}
