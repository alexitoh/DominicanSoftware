// finanzas-db.js - datos de Finanzas: monedas, tasas de cambio, conversión y diferencia cambiaria
import { consultar, ejecutar } from './database.js';
import { crearAsiento, listarCuentas, fechaHoy } from './conta-db.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !Number.isNaN(Date.parse(f));

// ---------- Monedas y tasas ----------
// La moneda base es la del negocio (pesos). Aquí se registran las otras; la tasa es cuántos pesos vale una unidad.
export const listarMonedas = () => consultar(
  `SELECT m.*, (SELECT t.tasa FROM tasas_cambio t WHERE t.moneda_id = m.id ORDER BY t.fecha DESC LIMIT 1) AS tasa_actual,
          (SELECT t.fecha FROM tasas_cambio t WHERE t.moneda_id = m.id ORDER BY t.fecha DESC LIMIT 1) AS fecha_tasa,
          (SELECT COUNT(*) FROM partidas_ext p WHERE p.moneda_id = m.id) AS n_partidas
     FROM monedas m ORDER BY m.activa DESC, m.codigo`);
export async function guardarMoneda({ id = null, codigo, nombre, simbolo = '', activa = 1 }) {
  codigo = String(codigo || '').trim().toUpperCase();
  nombre = String(nombre || '').trim();
  if (!/^[A-Z]{2,5}$/.test(codigo)) throw new Error('El código son de 2 a 5 letras (por ejemplo USD).');
  if (codigo === 'DOP') throw new Error('DOP es la moneda base del negocio: no se registra aquí.');
  if (!nombre) throw new Error('Escribe el nombre de la moneda.');
  const [dup] = await consultar('SELECT id FROM monedas WHERE codigo = ? AND id <> ?', [codigo, id || 0]);
  if (dup) throw new Error('Ya existe una moneda con ese código.');
  if (id) {
    const [ant] = await consultar('SELECT codigo FROM monedas WHERE id = ?', [id]);
    if (ant && ant.codigo !== codigo) {
      const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM tasas_cambio WHERE moneda_id = ?', [id]);
      if (n) throw new Error('No se puede cambiar el código de una moneda que ya tiene tasas.');
    }
    await ejecutar('UPDATE monedas SET codigo = ?, nombre = ?, simbolo = ?, activa = ? WHERE id = ?', [codigo, nombre, String(simbolo || '').trim() || null, activa ? 1 : 0, id]);
  } else await ejecutar('INSERT INTO monedas (codigo, nombre, simbolo, activa) VALUES (?,?,?,?)', [codigo, nombre, String(simbolo || '').trim() || null, activa ? 1 : 0]);
}
export async function eliminarMoneda(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM partidas_ext WHERE moneda_id = ?', [id]);
  if (n) throw new Error('Hay partidas en esta moneda. Desactívala en lugar de eliminarla.');
  await ejecutar('DELETE FROM tasas_cambio WHERE moneda_id = ?', [id]);
  await ejecutar('DELETE FROM monedas WHERE id = ?', [id]);
}
export const listarTasas = (monedaId) => consultar('SELECT * FROM tasas_cambio WHERE moneda_id = ? ORDER BY fecha DESC', [monedaId]);
export async function guardarTasa({ moneda_id, fecha, tasa }) {
  const [m] = await consultar('SELECT codigo FROM monedas WHERE id = ?', [moneda_id]);
  if (!m) throw new Error('Elige la moneda.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  const t = r4(tasa);
  if (!(t > 0)) throw new Error('Escribe la tasa: cuántos pesos vale una unidad.');
  const clave = `${m.codigo}:${fecha}`;
  const [ya] = await consultar('SELECT id FROM tasas_cambio WHERE clave = ?', [clave]);
  if (ya) await ejecutar('UPDATE tasas_cambio SET tasa = ? WHERE id = ?', [t, ya.id]);
  else await ejecutar('INSERT INTO tasas_cambio (clave, moneda_id, fecha, tasa) VALUES (?,?,?,?)', [clave, moneda_id, fecha, t]);
}
export const eliminarTasa = (id) => ejecutar('DELETE FROM tasas_cambio WHERE id = ?', [id]);
// Tasa vigente en una fecha: la más reciente que no pase de esa fecha
export async function tasaEn(monedaId, fecha = fechaHoy()) {
  const [t] = await consultar('SELECT tasa, fecha FROM tasas_cambio WHERE moneda_id = ? AND fecha <= ? ORDER BY fecha DESC LIMIT 1', [monedaId, fecha]);
  return t || null;
}
// de / a: id de moneda o 'BASE' (la moneda del negocio)
export async function convertirMoneda({ monto, de = 'BASE', a = 'BASE', fecha = fechaHoy() }) {
  const m = Number(monto);
  if (!Number.isFinite(m)) throw new Error('Escribe el monto a convertir.');
  const tasa = async (x) => {
    if (x === 'BASE' || x === '' || x == null) return { tasa: 1, fecha: null };
    const t = await tasaEn(Number(x), fecha);
    if (!t) { const [mo] = await consultar('SELECT codigo FROM monedas WHERE id = ?', [Number(x)]); throw new Error(`No hay tasa de ${mo?.codigo || 'esa moneda'} para esa fecha. Regístrala primero.`); }
    return t;
  };
  const td = await tasa(de); const ta = await tasa(a);
  return { resultado: r2((m * td.tasa) / ta.tasa), tasaDe: td.tasa, tasaA: ta.tasa, fechaTasaDe: td.fecha, fechaTasaA: ta.fecha };
}

// ---------- Diferencia cambiaria ----------
// Una partida es un saldo en moneda extranjera (por ejemplo una cuenta en dólares o un préstamo en dólares) que está registrada
// en una cuenta contable con una tasa. Al cambiar la tasa, su valor en pesos cambia: esa diferencia es una ganancia o una pérdida.
export const listarPartidas = () => consultar(
  `SELECT p.*, m.codigo AS moneda, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre, c.tipo AS cuenta_tipo
     FROM partidas_ext p JOIN monedas m ON m.id = p.moneda_id JOIN cuentas_contables c ON c.id = p.cuenta_id ORDER BY p.activa DESC, p.descripcion COLLATE NOCASE`);
export async function guardarPartida({ id = null, descripcion, moneda_id, cuenta_id, monto_ext, tasa_libro, fecha = fechaHoy(), notas = '', activa = 1 }) {
  descripcion = String(descripcion || '').trim();
  if (!descripcion) throw new Error('Escribe qué es esta partida.');
  const [m] = await consultar('SELECT id FROM monedas WHERE id = ?', [moneda_id]);
  if (!m) throw new Error('Elige la moneda.');
  const [c] = await consultar('SELECT * FROM cuentas_contables WHERE id = ?', [cuenta_id]);
  if (!c) throw new Error('Elige la cuenta contable.');
  if (c.grupo) throw new Error('Elige una cuenta de detalle, no un título.');
  if (!['activo', 'pasivo'].includes(c.tipo)) throw new Error('La cuenta debe ser de activo o de pasivo.');
  if (['cxc', 'cxp'].includes(c.rol)) throw new Error('Las cuentas por cobrar y por pagar se calculan con las facturas del sistema; usa otra cuenta (banco en dólares, préstamo…).');
  if (!(Number(monto_ext) > 0)) throw new Error('Escribe el monto en la moneda extranjera.');
  if (!(Number(tasa_libro) > 0)) throw new Error('Escribe la tasa con la que está registrada hoy.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  const v = [descripcion, moneda_id, cuenta_id, r2(monto_ext), r4(tasa_libro), fecha, String(notas || '').trim() || null, activa ? 1 : 0];
  if (id) await ejecutar('UPDATE partidas_ext SET descripcion = ?, moneda_id = ?, cuenta_id = ?, monto_ext = ?, tasa_libro = ?, fecha = ?, notas = ?, activa = ? WHERE id = ?', [...v, id]);
  else await ejecutar('INSERT INTO partidas_ext (descripcion, moneda_id, cuenta_id, monto_ext, tasa_libro, fecha, notas, activa) VALUES (?,?,?,?,?,?,?,?)', v);
}
export async function eliminarPartida(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM dif_cambiaria WHERE partida_id = ?', [id]);
  if (n) throw new Error('Esta partida ya tiene diferencias contabilizadas. Desactívala en lugar de eliminarla.');
  await ejecutar('DELETE FROM partidas_ext WHERE id = ?', [id]);
}

// Calcula, sin guardar nada, cuánto cambió cada partida activa con la tasa vigente en la fecha
export async function revaluar(fecha = fechaHoy()) {
  const filas = [];
  for (const p of (await listarPartidas()).filter((x) => x.activa)) {
    const t = await tasaEn(p.moneda_id, fecha);
    const libro = r2(p.monto_ext * p.tasa_libro);
    if (!t) { filas.push({ ...p, tasa_nueva: null, valor_libro: libro, valor_nuevo: null, delta: 0, efecto: 0, sinTasa: true }); continue; }
    const nuevo = r2(p.monto_ext * t.tasa);
    const delta = r2(nuevo - libro);
    // En un activo, subir la tasa es ganancia; en un pasivo (deuda), subir la tasa es pérdida
    filas.push({ ...p, tasa_nueva: t.tasa, fecha_tasa: t.fecha, valor_libro: libro, valor_nuevo: nuevo, delta, efecto: p.cuenta_tipo === 'activo' ? delta : -delta, sinTasa: false });
  }
  return { fecha, filas, ganancia: r2(filas.filter((f) => f.efecto > 0).reduce((s, f) => s + f.efecto, 0)), perdida: r2(-filas.filter((f) => f.efecto < 0).reduce((s, f) => s + f.efecto, 0)) };
}

// Registra UN asiento con todas las diferencias, actualiza la tasa de cada partida y guarda el historial
export async function contabilizarDiferencia(fecha = fechaHoy()) {
  const r = await revaluar(fecha);
  const cambios = r.filas.filter((f) => !f.sinTasa && Math.abs(f.delta) > 0.004);
  if (!cambios.length) throw new Error('No hay diferencias que contabilizar: las tasas no han cambiado o falta registrar la tasa de la fecha.');
  const cuentas = await listarCuentas(true);
  const rol = (x) => cuentas.find((c) => c.rol === x);
  const gan = rol('ganancia_cambiaria'); const per = rol('perdida_cambiaria');
  if (!gan || !per) throw new Error('Faltan las cuentas de ganancia o pérdida por diferencia cambiaria en el catálogo.');
  const lineas = [];
  for (const f of cambios) {
    const sube = f.delta > 0;
    const act = f.cuenta_tipo === 'activo';
    const monto = Math.abs(f.delta);
    // activo: sube = débito; pasivo: sube = crédito
    lineas.push({ cuenta_id: f.cuenta_id, debe: act === sube ? monto : 0, haber: act === sube ? 0 : monto, detalle: `${f.descripcion} (${f.moneda} ${f.tasa_libro} → ${f.tasa_nueva})` });
  }
  if (r.ganancia > 0.004) lineas.push({ cuenta_id: gan.id, debe: 0, haber: r.ganancia, detalle: 'Ganancia cambiaria' });
  if (r.perdida > 0.004) lineas.push({ cuenta_id: per.id, debe: r.perdida, haber: 0, detalle: 'Pérdida cambiaria' });
  const numero = await crearAsiento({ fecha, concepto: `Diferencia cambiaria al ${fecha.split('-').reverse().join('/')}`, tipo: 'manual', lineas });
  for (const f of cambios) {
    await ejecutar('INSERT INTO dif_cambiaria (partida_id, fecha, tasa_anterior, tasa_nueva, monto, asiento_numero) VALUES (?,?,?,?,?,?)', [f.id, fecha, f.tasa_libro, f.tasa_nueva, f.efecto, numero]);
    await ejecutar('UPDATE partidas_ext SET tasa_libro = ? WHERE id = ?', [f.tasa_nueva, f.id]);
  }
  return { numero, ganancia: r.ganancia, perdida: r.perdida, partidas: cambios.length };
}
export const historialDiferencias = () => consultar(
  `SELECT d.*, p.descripcion, m.codigo AS moneda FROM dif_cambiaria d JOIN partidas_ext p ON p.id = d.partida_id JOIN monedas m ON m.id = p.moneda_id ORDER BY d.fecha DESC, d.id DESC`);
