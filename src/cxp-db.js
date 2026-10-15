// cxp-db.js - datos de Cuentas por Pagar (CxP): tipos de suplidor, notas de crédito y débito, anticipos, pagos, estado de cuenta, reportes,
// y el circuito de compras (solicitud de compra → requisición de cotización → orden de compra → factura del suplidor).
//
// Igual que en CxC: una nota de crédito o un anticipo aplicado BAJAN lo que se le debe al suplidor por una factura y una nota de débito lo SUBE.
// Cada uno deja una línea en `pagos_compra` con metodo 'nota_credito' | 'anticipo' (monto positivo) o 'nota_debito' (monto negativo) y apunta a su
// documento en cxp_docs. Así todos los saldos del sistema (facturas, suplidores, reportes, contabilidad) siguen sumando igual.
import { consultar, ejecutar, transaccion, numeroDocumento, redondear, usuarioId, registrarPagoCompra } from './database.js';
import { exigirPeriodoAbierto } from './conta-db.js';
import { TRAMOS_CXC } from './cxc-db.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !Number.isNaN(Date.parse(f));
const limpio = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const contador = (clave) => ({ statement: 'UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = ?', values: [clave] });
export const METODOS_PAGO_CXP = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };
export const METODOS_ESPECIALES_CXP = ['nota_credito', 'nota_debito', 'anticipo']; // pagos_compra que no son dinero que sale de caja o banco
export const TRAMOS_CXP = TRAMOS_CXC;
export const CONCEPTOS_NC = ['Descuento comercial', 'Descuento por pronto pago', 'Devolución de mercancía', 'Error en la factura', 'Otro'];
export const CONCEPTOS_ND = ['Interés por mora', 'Flete o transporte', 'Diferencia de precio', 'Otro'];

// ---------- Tipos de suplidor ----------
export const listarTiposProveedor = () => consultar(
  `SELECT t.*, (SELECT COUNT(*) FROM proveedores p WHERE p.tipo_proveedor_id = t.id) AS n_proveedores FROM tipos_proveedor t ORDER BY t.activo DESC, t.nombre COLLATE NOCASE`);
export async function guardarTipoProveedor({ id = null, nombre, notas = '', activo = 1 }) {
  nombre = limpio(nombre);
  if (!nombre) throw new Error('Escribe el nombre del tipo de suplidor.');
  const [dup] = await consultar('SELECT id FROM tipos_proveedor WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe un tipo de suplidor con ese nombre.');
  const v = [nombre, limpio(notas) || null, activo ? 1 : 0];
  if (id) await ejecutar('UPDATE tipos_proveedor SET nombre = ?, notas = ?, activo = ? WHERE id = ?', [...v, id]);
  else await ejecutar('INSERT INTO tipos_proveedor (nombre, notas, activo) VALUES (?,?,?)', v);
}
export async function eliminarTipoProveedor(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM proveedores WHERE tipo_proveedor_id = ?', [id]);
  if (n) throw new Error(`Hay ${n} ${n === 1 ? 'suplidor' : 'suplidores'} de este tipo. Desactívalo en lugar de eliminarlo.`);
  await ejecutar('DELETE FROM tipos_proveedor WHERE id = ?', [id]);
}
// Tipo de suplidor de un proveedor
export async function guardarTipoDeProveedor(proveedorId, tipoId) {
  const [p] = await consultar('SELECT id FROM proveedores WHERE id = ?', [proveedorId]);
  if (!p) throw new Error('El suplidor no existe.');
  if (tipoId) { const [t] = await consultar('SELECT id FROM tipos_proveedor WHERE id = ?', [tipoId]); if (!t) throw new Error('El tipo de suplidor no existe.'); }
  await ejecutar('UPDATE proveedores SET tipo_proveedor_id = ? WHERE id = ?', [tipoId || null, proveedorId]);
}

// ---------- Facturas del suplidor (compras) ----------
const PAGADO = '(SELECT COALESCE(SUM(pc.monto), 0) FROM pagos_compra pc WHERE pc.compra_id = c.id)';
const VENCE = "COALESCE(a.vence, date(c.fecha, '+' || COALESCE(p.dias_credito, 30) || ' days'))";
const BASE_FACT = `FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id LEFT JOIN tipos_proveedor t ON t.id = p.tipo_proveedor_id LEFT JOIN cuentas_pagar a ON a.compra_id = c.id`;
const COLS_FACT = `c.id, c.numero, c.fecha, c.total, c.itbis, c.ncf, c.referencia, c.estado, c.proveedor_id, COALESCE(p.nombre, 'Sin suplidor') AS proveedor, p.tipo_proveedor_id, COALESCE(t.nombre, '') AS tipo_proveedor,
  a.compra_id IS NOT NULL AS credito, ${VENCE} AS vence, c.total - ${PAGADO} AS saldo`;

// Todas las facturas del suplidor (a crédito y de contado), más recientes primero
export async function listarFacturasSuplidor({ desde = '0000-00-00', hasta = '9999-12-31', proveedorId = null } = {}) {
  const filas = await consultar(`SELECT ${COLS_FACT} ${BASE_FACT} WHERE substr(c.fecha, 1, 10) BETWEEN ? AND ? ${proveedorId ? 'AND c.proveedor_id = ?' : ''} ORDER BY c.id DESC LIMIT 1000`,
    proveedorId ? [desde, hasta, proveedorId] : [desde, hasta]);
  return filas.map((f) => ({ ...f, credito: !!f.credito, saldo: f.estado === 'anulada' ? 0 : r2(f.saldo) }));
}
// Facturas a crédito con saldo (vigentes). Base de los reportes.
export async function facturasConSaldoCxp({ hasta = null } = {}) {
  const filas = await consultar(`SELECT ${COLS_FACT} ${BASE_FACT} WHERE a.compra_id IS NOT NULL AND c.estado = 'completada' ${hasta ? 'AND substr(c.fecha, 1, 10) <= ?' : ''}`, hasta ? [hasta] : []);
  return filas.map((f) => ({ ...f, saldo: r2(f.saldo) })).filter((f) => f.saldo > 0.005);
}
export async function detalleFacturaSuplidor(id) {
  const [f] = await consultar(`SELECT ${COLS_FACT}, p.telefono AS proveedor_tel ${BASE_FACT} WHERE c.id = ?`, [id]);
  if (!f) throw new Error('La factura no existe.');
  const items = await consultar('SELECT d.cantidad, d.costo_unitario, pr.nombre FROM compra_detalle d JOIN productos pr ON pr.id = d.producto_id WHERE d.compra_id = ? ORDER BY d.id', [id]);
  const movimientos = await consultar('SELECT * FROM pagos_compra WHERE compra_id = ? ORDER BY id', [id]);
  return { ...f, credito: !!f.credito, saldo: f.estado === 'anulada' ? 0 : r2(f.saldo), items, movimientos };
}
// Facturas a crédito de un suplidor, para elegir en una nota
export async function facturasCreditoProveedor(proveedorId, { soloConSaldo = false } = {}) {
  const filas = await consultar(`SELECT ${COLS_FACT} ${BASE_FACT} WHERE c.proveedor_id = ? AND a.compra_id IS NOT NULL AND c.estado = 'completada' ORDER BY c.id DESC`, [proveedorId]);
  const r = filas.map((f) => ({ ...f, fecha: String(f.fecha).slice(0, 10), saldo: r2(f.saldo) }));
  return soloConSaldo ? r.filter((f) => f.saldo > 0.005) : r;
}
// Compras de contado (se pagaron al recibirlas)
export async function listarComprasContado({ desde = '0000-00-00', hasta = '9999-12-31' } = {}) {
  return consultar(
    `SELECT c.id, c.numero, c.fecha, c.total, c.ncf, c.referencia, COALESCE(p.nombre, 'Sin suplidor') AS proveedor,
            COALESCE((SELECT pc.metodo FROM pagos_compra pc WHERE pc.compra_id = c.id AND pc.metodo NOT IN ('nota_credito','nota_debito','anticipo') ORDER BY pc.id LIMIT 1), '') AS metodo
       FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id LEFT JOIN cuentas_pagar a ON a.compra_id = c.id
      WHERE a.compra_id IS NULL AND c.estado = 'completada' AND substr(c.fecha, 1, 10) BETWEEN ? AND ? ORDER BY c.id DESC`, [desde, hasta]);
}

// ---------- Suplidores (vista de CxP) ----------
export async function proveedoresCxp() {
  const provs = await consultar(
    `SELECT p.*, t.nombre AS tipo_proveedor FROM proveedores p LEFT JOIN tipos_proveedor t ON t.id = p.tipo_proveedor_id ORDER BY p.nombre COLLATE NOCASE`);
  const fac = await facturasConSaldoCxp();
  const hoyISO = hoy();
  const ant = await consultar(
    `SELECT d.proveedor_id, d.monto - COALESCE((SELECT SUM(pc.monto) FROM pagos_compra pc WHERE pc.documento_id = d.id), 0) AS disponible
       FROM cxp_docs d WHERE d.tipo = 'anticipo' AND d.estado = 'vigente'`);
  return provs.map((p) => {
    const mias = fac.filter((f) => f.proveedor_id === p.id);
    return {
      ...p, saldo: r2(mias.reduce((s, f) => s + f.saldo, 0)), vencido: r2(mias.filter((f) => f.vence < hoyISO).reduce((s, f) => s + f.saldo, 0)), facturas: mias.length,
      anticipos: r2(ant.filter((a) => a.proveedor_id === p.id).reduce((s, a) => s + a.disponible, 0)),
    };
  });
}

// ---------- Notas de crédito y de débito ----------
async function facturaDelSuplidor(proveedorId, compraId) {
  const [c] = await consultar(`SELECT ${COLS_FACT} ${BASE_FACT} WHERE c.id = ?`, [compraId]);
  if (!c) throw new Error('Elige la factura.');
  if (c.proveedor_id !== proveedorId) throw new Error('Esa factura no es de este suplidor.');
  if (!c.credito) throw new Error('La factura debe ser a crédito.');
  if (c.estado !== 'completada') throw new Error('La factura está anulada.');
  return { ...c, saldo: r2(c.saldo) };
}

export async function crearNotaProveedor({ tipo, proveedor_id, compra_id, concepto = '', monto, itbis = 0, ncf = '', fecha = hoy(), notas = '' }) {
  if (!['credito', 'debito'].includes(tipo)) throw new Error('Tipo de nota no válido.');
  const m = r2(monto); const it = r2(itbis || 0);
  if (!(m > 0)) throw new Error('Escribe un monto mayor que cero.');
  if (it < 0 || it > m) throw new Error('El ITBIS no puede ser negativo ni mayor que el monto.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  await exigirPeriodoAbierto(fecha);
  const c = await facturaDelSuplidor(proveedor_id, compra_id);
  if (tipo === 'credito' && m > c.saldo + 0.005) throw new Error(`La nota de crédito no puede ser mayor que lo que se debe de la factura ${c.numero} (${c.saldo.toFixed(2)}).`);
  const prefijo = tipo === 'credito' ? 'NCP' : 'NDP'; const clave = tipo === 'credito' ? 'siguiente_numero_ncp' : 'siguiente_numero_ndp';
  const numero = await numeroDocumento(prefijo, clave);
  await transaccion([
    { statement: 'INSERT INTO cxp_docs (numero, tipo, fecha, proveedor_id, compra_id, concepto, monto, itbis, ncf, notas, usuario_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      values: [numero, tipo, fecha, proveedor_id, compra_id, limpio(concepto) || null, m, it, limpio(ncf).toUpperCase() || null, limpio(notas) || null, usuarioId()] },
    { statement: 'INSERT INTO pagos_compra (compra_id, monto, metodo, nota, documento_id, fecha) VALUES (?, ?, ?, ?, (SELECT id FROM cxp_docs WHERE numero = ?), ?)',
      values: [compra_id, tipo === 'credito' ? m : -m, tipo === 'credito' ? 'nota_credito' : 'nota_debito', `${tipo === 'credito' ? 'Nota de crédito' : 'Nota de débito'} ${numero}`, numero, fecha] },
    contador(clave),
  ]);
  const [d] = await consultar('SELECT id FROM cxp_docs WHERE numero = ?', [numero]);
  return { id: d.id, numero };
}

export async function anularNotaProveedor(id, motivo = '') {
  const [d] = await consultar("SELECT * FROM cxp_docs WHERE id = ? AND tipo IN ('credito','debito')", [id]);
  if (!d) throw new Error('La nota no existe.');
  if (d.estado === 'anulado') throw new Error('La nota ya está anulada.');
  if (!limpio(motivo)) throw new Error('Escribe el motivo de la anulación.');
  await exigirPeriodoAbierto(d.fecha);
  if (d.tipo === 'debito') {
    const c = await facturaDelSuplidor(d.proveedor_id, d.compra_id).catch(() => null);
    if (c && c.saldo - d.monto < -0.005) throw new Error('Ya se pagó esta nota de débito. Anula primero los pagos que la cubrieron.');
  }
  await transaccion([
    { statement: "UPDATE cxp_docs SET estado = 'anulado', anulado_motivo = ? WHERE id = ?", values: [limpio(motivo), id] },
    { statement: 'DELETE FROM pagos_compra WHERE documento_id = ?', values: [id] },
  ]);
}

export const listarNotasProveedor = ({ tipo, desde = '0000-00-00', hasta = '9999-12-31' }) => consultar(
  `SELECT d.*, p.nombre AS proveedor, c.numero AS factura FROM cxp_docs d JOIN proveedores p ON p.id = d.proveedor_id LEFT JOIN compras c ON c.id = d.compra_id
    WHERE d.tipo = ? AND substr(d.fecha, 1, 10) BETWEEN ? AND ? ORDER BY d.fecha DESC, d.id DESC`, [tipo, desde, hasta]);

// ---------- Anticipos a suplidores ----------
export async function crearAnticipoProveedor({ proveedor_id, monto, metodo = 'efectivo', referencia = '', fecha = hoy(), notas = '' }) {
  const m = r2(monto);
  if (!(m > 0)) throw new Error('Escribe el monto del anticipo.');
  if (!METODOS_PAGO_CXP[metodo]) throw new Error('Método de pago no válido.');
  if (metodo === 'cheque' && !limpio(referencia)) throw new Error('Escribe el número de cheque.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  const [p] = await consultar('SELECT id FROM proveedores WHERE id = ?', [proveedor_id]);
  if (!p) throw new Error('Elige el suplidor.');
  await exigirPeriodoAbierto(fecha);
  const numero = await numeroDocumento('ANP', 'siguiente_numero_anticipop');
  await transaccion([
    { statement: "INSERT INTO cxp_docs (numero, tipo, fecha, proveedor_id, monto, metodo, referencia, notas, usuario_id) VALUES (?, 'anticipo', ?, ?, ?, ?, ?, ?, ?)",
      values: [numero, fecha, proveedor_id, m, metodo, limpio(referencia) || null, limpio(notas) || null, usuarioId()] },
    contador('siguiente_numero_anticipop'),
  ]);
  const [d] = await consultar('SELECT id FROM cxp_docs WHERE numero = ?', [numero]);
  return { id: d.id, numero };
}
export async function listarAnticiposProveedor({ proveedorId = null, soloDisponibles = false } = {}) {
  const filas = await consultar(
    `SELECT d.*, p.nombre AS proveedor, d.monto - COALESCE((SELECT SUM(pc.monto) FROM pagos_compra pc WHERE pc.documento_id = d.id), 0) AS disponible
       FROM cxp_docs d JOIN proveedores p ON p.id = d.proveedor_id WHERE d.tipo = 'anticipo' ${proveedorId ? 'AND d.proveedor_id = ?' : ''} ORDER BY d.fecha DESC, d.id DESC`, proveedorId ? [proveedorId] : []);
  const r = filas.map((a) => ({ ...a, disponible: a.estado === 'anulado' ? 0 : r2(a.disponible) }));
  return soloDisponibles ? r.filter((a) => a.estado === 'vigente' && a.disponible > 0.005) : r;
}
export const aplicacionesAnticipoProveedor = (id) => consultar(
  `SELECT pc.id, pc.monto, pc.fecha, c.numero AS factura FROM pagos_compra pc JOIN compras c ON c.id = pc.compra_id WHERE pc.documento_id = ? ORDER BY pc.id`, [id]);

export async function aplicarAnticipoProveedor({ anticipo_id, compra_id, monto, fecha = hoy() }) {
  const [a] = await consultar("SELECT * FROM cxp_docs WHERE id = ? AND tipo = 'anticipo'", [anticipo_id]);
  if (!a) throw new Error('El anticipo no existe.');
  if (a.estado !== 'vigente') throw new Error('El anticipo está anulado.');
  const m = r2(monto);
  if (!(m > 0)) throw new Error('Escribe cuánto del anticipo se aplica.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  await exigirPeriodoAbierto(fecha);
  const [{ usado }] = await consultar('SELECT COALESCE(SUM(monto), 0) AS usado FROM pagos_compra WHERE documento_id = ?', [anticipo_id]);
  const disponible = r2(a.monto - usado);
  if (m > disponible + 0.005) throw new Error(`El anticipo solo tiene ${disponible.toFixed(2)} disponible.`);
  const c = await facturaDelSuplidor(a.proveedor_id, compra_id);
  if (m > c.saldo + 0.005) throw new Error(`La factura ${c.numero} solo tiene ${c.saldo.toFixed(2)} pendiente.`);
  await ejecutar('INSERT INTO pagos_compra (compra_id, monto, metodo, nota, documento_id, fecha) VALUES (?, ?, ?, ?, ?, ?)', [compra_id, m, 'anticipo', `Anticipo ${a.numero}`, anticipo_id, fecha]);
}
export async function quitarAplicacionProveedor(pagoId) {
  const [p] = await consultar("SELECT * FROM pagos_compra WHERE id = ? AND metodo = 'anticipo'", [pagoId]);
  if (!p) throw new Error('La aplicación no existe.');
  await exigirPeriodoAbierto(String(p.fecha).slice(0, 10));
  await ejecutar('DELETE FROM pagos_compra WHERE id = ?', [pagoId]);
}
export async function anularAnticipoProveedor(id, motivo = '') {
  const [d] = await consultar("SELECT * FROM cxp_docs WHERE id = ? AND tipo = 'anticipo'", [id]);
  if (!d) throw new Error('El anticipo no existe.');
  if (d.estado === 'anulado') throw new Error('El anticipo ya está anulado.');
  if (!limpio(motivo)) throw new Error('Escribe el motivo de la anulación.');
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM pagos_compra WHERE documento_id = ?', [id]);
  if (n) throw new Error('Este anticipo ya se aplicó a facturas. Quita primero esas aplicaciones.');
  await exigirPeriodoAbierto(d.fecha);
  await ejecutar("UPDATE cxp_docs SET estado = 'anulado', anulado_motivo = ? WHERE id = ?", [limpio(motivo), id]);
}

// ---------- Pagar a un suplidor (se reparte entre sus facturas, las más antiguas primero) ----------
export async function pagarSuplidor({ proveedor_id, monto, metodo = 'efectivo', nota = '' }) {
  const m = r2(monto);
  if (!(m > 0)) throw new Error('Escribe un monto mayor que cero.');
  if (!METODOS_PAGO_CXP[metodo]) throw new Error('Método de pago no válido.');
  const facs = (await facturasConSaldoCxp()).filter((f) => f.proveedor_id === proveedor_id).sort((a, b) => String(a.vence).localeCompare(String(b.vence)) || a.id - b.id);
  const deuda = r2(facs.reduce((s, f) => s + f.saldo, 0));
  if (m > deuda + 0.005) throw new Error(`El pago no puede ser mayor que lo que se le debe al suplidor (${deuda.toFixed(2)}).`);
  let resto = m; const aplicados = [];
  for (const f of facs) {
    if (resto <= 0.004) break;
    const x = r2(Math.min(resto, f.saldo));
    await registrarPagoCompra({ compraId: f.id, monto: x, metodo, nota: nota || '' });
    aplicados.push({ factura: f.numero, monto: x }); resto = r2(resto - x);
  }
  return { aplicados };
}

// ---------- Estado de cuenta de un suplidor ----------
export async function estadoCuentaProveedor(proveedorId, { hasta = hoy() } = {}) {
  const [p] = await consultar('SELECT p.*, t.nombre AS tipo_proveedor FROM proveedores p LEFT JOIN tipos_proveedor t ON t.id = p.tipo_proveedor_id WHERE p.id = ?', [proveedorId]);
  if (!p) throw new Error('El suplidor no existe.');
  const facturas = (await facturasConSaldoCxp({ hasta })).filter((f) => f.proveedor_id === proveedorId).sort((a, b) => String(a.vence).localeCompare(String(b.vence)));
  const anticipos = await listarAnticiposProveedor({ proveedorId, soloDisponibles: true });
  const movimientos = await consultar(
    `SELECT pc.id, pc.fecha, pc.monto, pc.metodo, pc.nota, c.numero AS factura FROM pagos_compra pc JOIN compras c ON c.id = pc.compra_id
      WHERE c.proveedor_id = ? AND c.estado = 'completada' AND EXISTS (SELECT 1 FROM cuentas_pagar a WHERE a.compra_id = c.id) ORDER BY pc.fecha DESC, pc.id DESC LIMIT 200`, [proveedorId]);
  const saldo = r2(facturas.reduce((s, f) => s + f.saldo, 0));
  return { proveedor: p, facturas, anticipos, movimientos, saldo, anticiposDisponibles: r2(anticipos.reduce((s, a) => s + a.disponible, 0)) };
}

// ---------- Reporte CxP: antigüedad de saldos por suplidor ----------
const diasEntre = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
export async function reporteCxp({ hasta = hoy(), proveedorId = null, tipoProveedorId = null } = {}) {
  let fac = await facturasConSaldoCxp({ hasta });
  if (proveedorId) fac = fac.filter((f) => f.proveedor_id === proveedorId);
  if (tipoProveedorId) fac = fac.filter((f) => f.tipo_proveedor_id === tipoProveedorId);
  const por = new Map();
  for (const f of fac) {
    const atraso = diasEntre(f.vence, hasta); // positivo = vencida hace N días
    const tramo = TRAMOS_CXP.find((t) => atraso >= t[2] && atraso <= t[3])[0];
    const g = por.get(f.proveedor_id) || { proveedor_id: f.proveedor_id, proveedor: f.proveedor, tipo_proveedor: f.tipo_proveedor || '', facturas: 0, total: 0, vencido: 0, ...Object.fromEntries(TRAMOS_CXP.map((t) => [t[0], 0])) };
    g.facturas++; g.total = r2(g.total + f.saldo); g[tramo] = r2(g[tramo] + f.saldo); if (atraso > 0) g.vencido = r2(g.vencido + f.saldo);
    por.set(f.proveedor_id, g);
  }
  const proveedores = [...por.values()].sort((a, b) => b.total - a.total);
  const totales = Object.fromEntries([['total', 0], ['vencido', 0], ['facturas', 0], ...TRAMOS_CXP.map((t) => [t[0], 0])]);
  for (const g of proveedores) for (const k of Object.keys(totales)) totales[k] = r2(totales[k] + g[k]);
  const detalle = fac.map((f) => ({ ...f, atraso: diasEntre(f.vence, hasta) })).sort((a, b) => b.atraso - a.atraso);
  return { hasta, proveedores, totales, detalle };
}

// ---------- Reporte dinámico ----------
export const TIPOS_DOC_CXP = { factura: 'Facturas a crédito', debito: 'Notas de débito', credito: 'Notas de crédito', pago: 'Pagos', anticipo: 'Anticipos', contado: 'Compras de contado' };
export const DIMENSIONES_CXP = { proveedor: 'Suplidor', tipo_proveedor: 'Tipo de suplidor', mes: 'Mes', concepto: 'Concepto', documento: 'Tipo de documento' };

export async function movimientosCxp({ desde = '0000-00-00', hasta = '9999-12-31' } = {}) {
  const base = (doc, num, fecha, nom, conc, monto) => `SELECT '${doc}' AS documento, ${num} AS numero, substr(${fecha}, 1, 10) AS fecha, ${nom} AS proveedor, COALESCE(t.nombre, '(sin tipo)') AS tipo_proveedor, ${conc} AS concepto, ${monto} AS monto`;
  const facturas = await consultar(
    `${base('factura', 'c.numero', 'c.fecha', "COALESCE(p.nombre, 'Sin suplidor')", "'Compra a crédito'", 'c.total')} ${BASE_FACT} WHERE a.compra_id IS NOT NULL AND c.estado = 'completada' AND substr(c.fecha, 1, 10) BETWEEN ? AND ?`, [desde, hasta]);
  const contado = await consultar(
    `${base('contado', 'c.numero', 'c.fecha', "COALESCE(p.nombre, 'Sin suplidor')", "'Compra de contado'", 'c.total')} ${BASE_FACT} WHERE a.compra_id IS NULL AND c.estado = 'completada' AND substr(c.fecha, 1, 10) BETWEEN ? AND ?`, [desde, hasta]);
  const pagos = await consultar(
    `${base('pago', 'c.numero', 'pc.fecha', "COALESCE(p.nombre, 'Sin suplidor')", "'Pago de facturas'", 'pc.monto')} FROM pagos_compra pc JOIN compras c ON c.id = pc.compra_id LEFT JOIN proveedores p ON p.id = c.proveedor_id
       LEFT JOIN tipos_proveedor t ON t.id = p.tipo_proveedor_id JOIN cuentas_pagar a ON a.compra_id = c.id
      WHERE c.estado = 'completada' AND pc.metodo NOT IN ('nota_credito','nota_debito','anticipo') AND substr(pc.fecha, 1, 10) BETWEEN ? AND ?`, [desde, hasta]);
  const docs = await consultar(
    `SELECT d.tipo AS documento, d.numero, substr(d.fecha, 1, 10) AS fecha, p.nombre AS proveedor, COALESCE(t.nombre, '(sin tipo)') AS tipo_proveedor,
            COALESCE(d.concepto, CASE d.tipo WHEN 'anticipo' THEN 'Anticipo' ELSE '(sin concepto)' END) AS concepto, d.monto
       FROM cxp_docs d JOIN proveedores p ON p.id = d.proveedor_id LEFT JOIN tipos_proveedor t ON t.id = p.tipo_proveedor_id
      WHERE d.estado = 'vigente' AND substr(d.fecha, 1, 10) BETWEEN ? AND ?`, [desde, hasta]);
  return [...facturas, ...contado, ...pagos, ...docs].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.numero.localeCompare(b.numero));
}
// neto = facturas + débitos − créditos − pagos − anticipos (las compras de contado no crean deuda y no cuentan)
export function tablaDinamicaCxp(movs, { dimension = 'proveedor', tipos = Object.keys(TIPOS_DOC_CXP), busqueda = '' } = {}) {
  if (!DIMENSIONES_CXP[dimension]) throw new Error('Agrupación no válida.');
  const q = String(busqueda || '').trim().toLowerCase();
  const clave = (m) => (dimension === 'mes' ? m.fecha.slice(0, 7) : dimension === 'documento' ? TIPOS_DOC_CXP[m.documento] : m[dimension]);
  const vacioG = () => ({ n: 0, ...Object.fromEntries(Object.keys(TIPOS_DOC_CXP).map((t) => [t, 0])), neto: 0 });
  const grupos = new Map();
  for (const m of movs) {
    if (!tipos.includes(m.documento)) continue;
    if (q && !`${m.proveedor} ${m.numero} ${m.concepto}`.toLowerCase().includes(q)) continue;
    const k = clave(m);
    const g = grupos.get(k) || { clave: k, ...vacioG() };
    g.n++; g[m.documento] = r2(g[m.documento] + m.monto);
    if (m.documento !== 'contado') g.neto = r2(g.neto + (['factura', 'debito'].includes(m.documento) ? m.monto : -m.monto));
    grupos.set(k, g);
  }
  const filas = [...grupos.values()].sort((a, b) => (dimension === 'mes' ? a.clave.localeCompare(b.clave) : b.neto - a.neto));
  const total = vacioG();
  for (const g of filas) for (const k of Object.keys(total)) total[k] = r2(total[k] + g[k]);
  return { filas, total };
}

// ======================= Circuito de compras =======================
async function lineasValidas(items, { conCosto = false } = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('Agrega al menos un producto.');
  const out = [];
  for (const it of items) {
    const cantidad = Number(it.cantidad);
    if (!Number.isInteger(cantidad) || cantidad <= 0) throw new Error('Las cantidades deben ser números enteros mayores que cero.');
    const [p] = await consultar('SELECT id FROM productos WHERE id = ?', [it.producto_id]);
    if (!p) throw new Error('Un producto ya no existe.');
    const costo = conCosto ? r2(it.costo_unitario) : 0;
    if (conCosto && !(costo >= 0)) throw new Error('El costo de cada producto debe ser un número válido.');
    out.push({ producto_id: it.producto_id, cantidad, costo_unitario: costo, nota: limpio(it.nota) || null });
  }
  return out;
}

// ---------- Solicitud de compras (lo que el negocio necesita comprar) ----------
export const ESTADOS_SOLICITUD = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', atendida: 'Atendida', anulada: 'Anulada' };
export async function crearSolicitud({ solicitante = '', items, notas = '', fecha = hoy() }) {
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  const ls = await lineasValidas(items);
  const numero = await numeroDocumento('SC', 'siguiente_numero_solicitud');
  const set = [{ statement: 'INSERT INTO solicitudes_compra (numero, fecha, solicitante, notas, usuario_id) VALUES (?,?,?,?,?)', values: [numero, fecha, limpio(solicitante) || null, limpio(notas) || null, usuarioId()] }];
  for (const l of ls) set.push({ statement: 'INSERT INTO solicitud_detalle (solicitud_id, producto_id, cantidad, nota) VALUES ((SELECT id FROM solicitudes_compra WHERE numero = ?), ?, ?, ?)', values: [numero, l.producto_id, l.cantidad, l.nota] });
  set.push(contador('siguiente_numero_solicitud'));
  await transaccion(set);
  const [s] = await consultar('SELECT id FROM solicitudes_compra WHERE numero = ?', [numero]);
  return { id: s.id, numero };
}
export const listarSolicitudes = () => consultar(
  `SELECT s.*, (SELECT COUNT(*) FROM solicitud_detalle d WHERE d.solicitud_id = s.id) AS lineas, (SELECT COALESCE(SUM(d.cantidad), 0) FROM solicitud_detalle d WHERE d.solicitud_id = s.id) AS unidades
     FROM solicitudes_compra s ORDER BY s.id DESC LIMIT 500`);
export async function detalleSolicitud(id) {
  const [s] = await consultar('SELECT * FROM solicitudes_compra WHERE id = ?', [id]);
  if (!s) throw new Error('La solicitud no existe.');
  const items = await consultar('SELECT d.*, p.nombre, p.stock_actual, p.costo FROM solicitud_detalle d JOIN productos p ON p.id = d.producto_id WHERE d.solicitud_id = ? ORDER BY d.id', [id]);
  return { ...s, items };
}
const TRANSICIONES_SOLICITUD = { pendiente: ['aprobada', 'rechazada', 'anulada'], aprobada: ['atendida', 'anulada'], rechazada: ['pendiente'], atendida: [], anulada: [] };
export async function cambiarEstadoSolicitud(id, estado) {
  const [s] = await consultar('SELECT estado FROM solicitudes_compra WHERE id = ?', [id]);
  if (!s) throw new Error('La solicitud no existe.');
  if (!(TRANSICIONES_SOLICITUD[s.estado] || []).includes(estado)) throw new Error(`Una solicitud ${ESTADOS_SOLICITUD[s.estado].toLowerCase()} no puede pasar a ${ESTADOS_SOLICITUD[estado]?.toLowerCase() || estado}.`);
  await ejecutar('UPDATE solicitudes_compra SET estado = ? WHERE id = ?', [estado, id]);
}

// ---------- Requisición de cotización (pedir precio a varios suplidores) ----------
export const ESTADOS_REQUISICION = { abierta: 'Abierta', adjudicada: 'Adjudicada', anulada: 'Anulada' };
export async function crearRequisicion({ items, notas = '', solicitud_id = null, fecha = hoy() }) {
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  const ls = await lineasValidas(items);
  if (solicitud_id) {
    const [s] = await consultar('SELECT estado FROM solicitudes_compra WHERE id = ?', [solicitud_id]);
    if (!s) throw new Error('La solicitud no existe.');
    if (s.estado !== 'aprobada') throw new Error('Solo se puede cotizar una solicitud aprobada.');
  }
  const numero = await numeroDocumento('RQ', 'siguiente_numero_requisicion');
  const set = [{ statement: 'INSERT INTO requisiciones (numero, fecha, solicitud_id, notas, usuario_id) VALUES (?,?,?,?,?)', values: [numero, fecha, solicitud_id || null, limpio(notas) || null, usuarioId()] }];
  for (const l of ls) set.push({ statement: 'INSERT INTO requisicion_detalle (requisicion_id, producto_id, cantidad) VALUES ((SELECT id FROM requisiciones WHERE numero = ?), ?, ?)', values: [numero, l.producto_id, l.cantidad] });
  if (solicitud_id) set.push({ statement: "UPDATE solicitudes_compra SET estado = 'atendida' WHERE id = ?", values: [solicitud_id] });
  set.push(contador('siguiente_numero_requisicion'));
  await transaccion(set);
  const [r] = await consultar('SELECT id FROM requisiciones WHERE numero = ?', [numero]);
  return { id: r.id, numero };
}
export const listarRequisiciones = () => consultar(
  `SELECT r.*, (SELECT COUNT(*) FROM requisicion_detalle d WHERE d.requisicion_id = r.id) AS lineas,
          (SELECT COUNT(DISTINCT proveedor_id) FROM requisicion_cot c WHERE c.requisicion_id = r.id) AS cotizaciones
     FROM requisiciones r ORDER BY r.id DESC LIMIT 500`);
// items, suplidores que cotizaron y precios: cot[detalle_id][proveedor_id] = costo
export async function detalleRequisicion(id) {
  const [r] = await consultar('SELECT * FROM requisiciones WHERE id = ?', [id]);
  if (!r) throw new Error('La requisición no existe.');
  const items = await consultar('SELECT d.*, p.nombre FROM requisicion_detalle d JOIN productos p ON p.id = d.producto_id WHERE d.requisicion_id = ? ORDER BY d.id', [id]);
  const cots = await consultar('SELECT c.*, p.nombre AS proveedor FROM requisicion_cot c JOIN proveedores p ON p.id = c.proveedor_id WHERE c.requisicion_id = ? ORDER BY c.id', [id]);
  const proveedores = [...new Map(cots.map((c) => [c.proveedor_id, c.proveedor])).entries()].map(([proveedor_id, nombre]) => ({ proveedor_id, nombre }));
  const cot = {};
  for (const c of cots) (cot[c.detalle_id] ||= {})[c.proveedor_id] = c.costo_unitario;
  // total cotizado por suplidor (solo si cotizó todas las líneas) y menor precio por línea
  const totales = proveedores.map((p) => {
    const completo = items.every((i) => cot[i.id]?.[p.proveedor_id] != null);
    return { ...p, completo, total: completo ? r2(items.reduce((s, i) => s + i.cantidad * cot[i.id][p.proveedor_id], 0)) : null };
  });
  const mejor = {};
  for (const i of items) { const xs = Object.entries(cot[i.id] || {}); if (xs.length) mejor[i.id] = Number(xs.sort((a, b) => a[1] - b[1])[0][0]); }
  const [orden] = await consultar("SELECT numero FROM ordenes_compra WHERE requisicion_id = ? AND estado <> 'anulada' ORDER BY id DESC LIMIT 1", [id]);
  return { ...r, items, proveedores, cot, totales, mejor, orden_numero: orden?.numero || null };
}
// precios: { detalle_id: costo } (vacío = no cotizó esa línea)
export async function guardarCotizacion({ requisicion_id, proveedor_id, precios }) {
  const [r] = await consultar('SELECT estado FROM requisiciones WHERE id = ?', [requisicion_id]);
  if (!r) throw new Error('La requisición no existe.');
  if (r.estado !== 'abierta') throw new Error('La requisición ya no está abierta.');
  const [p] = await consultar('SELECT id FROM proveedores WHERE id = ?', [proveedor_id]);
  if (!p) throw new Error('Elige el suplidor.');
  const items = await consultar('SELECT id FROM requisicion_detalle WHERE requisicion_id = ?', [requisicion_id]);
  const set = [{ statement: 'DELETE FROM requisicion_cot WHERE requisicion_id = ? AND proveedor_id = ?', values: [requisicion_id, proveedor_id] }];
  let n = 0;
  for (const it of items) {
    const v = precios?.[it.id];
    if (v === '' || v == null) continue;
    const costo = r2(v);
    if (!(costo >= 0)) throw new Error('Revisa los precios: deben ser números válidos.');
    set.push({ statement: 'INSERT INTO requisicion_cot (requisicion_id, proveedor_id, detalle_id, costo_unitario) VALUES (?,?,?,?)', values: [requisicion_id, proveedor_id, it.id, costo] }); n++;
  }
  if (!n) throw new Error('Escribe al menos un precio cotizado.');
  await transaccion(set);
}
export async function quitarCotizacion(requisicion_id, proveedor_id) {
  const [r] = await consultar('SELECT estado FROM requisiciones WHERE id = ?', [requisicion_id]);
  if (r?.estado !== 'abierta') throw new Error('La requisición ya no está abierta.');
  await ejecutar('DELETE FROM requisicion_cot WHERE requisicion_id = ? AND proveedor_id = ?', [requisicion_id, proveedor_id]);
}
export async function anularRequisicion(id) {
  const [r] = await consultar('SELECT estado FROM requisiciones WHERE id = ?', [id]);
  if (!r) throw new Error('La requisición no existe.');
  if (r.estado !== 'abierta') throw new Error('Solo se puede anular una requisición abierta.');
  await ejecutar("UPDATE requisiciones SET estado = 'anulada' WHERE id = ?", [id]);
}
// Escoge al suplidor ganador y genera su orden de compra con los precios cotizados
export async function adjudicarRequisicion({ requisicion_id, proveedor_id, entrega = '', notas = '' }) {
  const d = await detalleRequisicion(requisicion_id);
  if (d.estado !== 'abierta') throw new Error('La requisición ya no está abierta.');
  const t = d.totales.find((x) => x.proveedor_id === proveedor_id);
  if (!t) throw new Error('Ese suplidor no ha cotizado.');
  if (!t.completo) throw new Error('Ese suplidor no cotizó todas las líneas. Pídele los precios que faltan.');
  const orden = await crearOrden({ proveedor_id, items: d.items.map((i) => ({ producto_id: i.producto_id, cantidad: i.cantidad, costo_unitario: d.cot[i.id][proveedor_id] })), entrega, notas: notas || `Cotización ${d.numero}`, requisicion_id });
  await ejecutar("UPDATE requisiciones SET estado = 'adjudicada' WHERE id = ?", [requisicion_id]);
  return orden;
}

// ---------- Orden de compras ----------
export const ESTADOS_ORDEN = { pendiente: 'Pendiente', recibida: 'Recibida', anulada: 'Anulada' };
export async function crearOrden({ proveedor_id, items, entrega = '', notas = '', requisicion_id = null, fecha = hoy() }) {
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  if (entrega && !fechaValida(entrega)) throw new Error('La fecha de entrega no es válida.');
  const [p] = await consultar('SELECT id FROM proveedores WHERE id = ?', [proveedor_id]);
  if (!p) throw new Error('Elige el suplidor.');
  const ls = await lineasValidas(items, { conCosto: true });
  const numero = await numeroDocumento('OC', 'siguiente_numero_orden');
  const set = [{ statement: 'INSERT INTO ordenes_compra (numero, fecha, proveedor_id, entrega, requisicion_id, notas, usuario_id) VALUES (?,?,?,?,?,?,?)',
    values: [numero, fecha, proveedor_id, entrega || null, requisicion_id || null, limpio(notas) || null, usuarioId()] }];
  for (const l of ls) set.push({ statement: 'INSERT INTO orden_detalle (orden_id, producto_id, cantidad, costo_unitario) VALUES ((SELECT id FROM ordenes_compra WHERE numero = ?), ?, ?, ?)', values: [numero, l.producto_id, l.cantidad, l.costo_unitario] });
  set.push(contador('siguiente_numero_orden'));
  await transaccion(set);
  const [o] = await consultar('SELECT id FROM ordenes_compra WHERE numero = ?', [numero]);
  return { id: o.id, numero };
}
export const listarOrdenes = () => consultar(
  `SELECT o.*, p.nombre AS proveedor, c.numero AS factura,
          (SELECT COALESCE(SUM(d.cantidad * d.costo_unitario), 0) FROM orden_detalle d WHERE d.orden_id = o.id) AS total
     FROM ordenes_compra o JOIN proveedores p ON p.id = o.proveedor_id LEFT JOIN compras c ON c.id = o.compra_id ORDER BY o.id DESC LIMIT 500`);
export async function detalleOrden(id) {
  const [o] = await consultar('SELECT o.*, p.nombre AS proveedor, c.numero AS factura FROM ordenes_compra o JOIN proveedores p ON p.id = o.proveedor_id LEFT JOIN compras c ON c.id = o.compra_id WHERE o.id = ?', [id]);
  if (!o) throw new Error('La orden no existe.');
  const items = await consultar('SELECT d.*, p.nombre FROM orden_detalle d JOIN productos p ON p.id = d.producto_id WHERE d.orden_id = ? ORDER BY d.id', [id]);
  return { ...o, items, total: r2(items.reduce((s, i) => s + i.cantidad * i.costo_unitario, 0)) };
}
export async function anularOrden(id) {
  const [o] = await consultar('SELECT estado FROM ordenes_compra WHERE id = ?', [id]);
  if (!o) throw new Error('La orden no existe.');
  if (o.estado !== 'pendiente') throw new Error('Solo se puede anular una orden pendiente.');
  await ejecutar("UPDATE ordenes_compra SET estado = 'anulada' WHERE id = ?", [id]);
}
// Se llama cuando la factura del suplidor ya se registró (la orden queda recibida y enlazada a esa factura)
export async function marcarOrdenRecibida(id, numeroCompra) {
  const [o] = await consultar('SELECT estado FROM ordenes_compra WHERE id = ?', [id]);
  if (!o) throw new Error('La orden no existe.');
  if (o.estado !== 'pendiente') throw new Error('La orden ya no está pendiente.');
  const [c] = await consultar('SELECT id FROM compras WHERE numero = ?', [numeroCompra]);
  if (!c) throw new Error('No se encontró la factura del suplidor.');
  await ejecutar("UPDATE ordenes_compra SET estado = 'recibida', compra_id = ? WHERE id = ?", [c.id, id]);
}
