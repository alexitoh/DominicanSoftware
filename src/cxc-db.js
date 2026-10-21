// cxc-db.js - datos de Cuentas por Cobrar (CxC): tipos de cliente, condiciones de pago, motivos, notas de crédito y débito,
// anticipos, estado de cuenta y reportes. Todo vive dentro de Contabilidad.
//
// Cómo se guardan los movimientos: una nota de crédito o un anticipo aplicado BAJAN lo que debe una factura y una nota de débito lo SUBE.
// Para que todos los saldos del sistema (facturas, clientes, reportes, contabilidad) sigan sumando igual, cada uno deja una línea en `pagos`
// con metodo 'nota_credito' | 'anticipo' (monto positivo) o 'nota_debito' (monto negativo) y apunta a su documento en cxc_docs.
import { consultar, ejecutar, transaccion, numeroDocumento, redondear, usuarioId, facturasPendientes, METODOS_COBRO, pedirNcfElectronico, soltarNcfElectronico } from './database.js';
import { exigirPeriodoAbierto } from './conta-db.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !Number.isNaN(Date.parse(f));
const limpio = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const contador = (clave) => ({ statement: 'UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = ?', values: [clave] });
export const METODOS_PAGO_CXC = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', cheque: 'Cheque' };
export const METODOS_ESPECIALES = ['nota_credito', 'nota_debito', 'anticipo']; // pagos que no son dinero recibido por caja o banco

// ---------- Tipos de cliente ----------
export const listarTiposCliente = () => consultar(
  `SELECT t.*, (SELECT COUNT(*) FROM clientes c WHERE c.tipo_cliente_id = t.id) AS n_clientes FROM tipos_cliente t ORDER BY t.activo DESC, t.nombre COLLATE NOCASE`);
export async function guardarTipoCliente({ id = null, nombre, descuento = 0, limite_credito = null, notas = '', activo = 1 }) {
  nombre = limpio(nombre);
  if (!nombre) throw new Error('Escribe el nombre del tipo de cliente.');
  const d = Number(descuento) || 0;
  if (d < 0 || d > 100) throw new Error('El descuento debe estar entre 0 y 100 %.');
  const lim = Number(limite_credito) > 0 ? r2(limite_credito) : null;
  const [dup] = await consultar('SELECT id FROM tipos_cliente WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe un tipo de cliente con ese nombre.');
  const v = [nombre, d, lim, limpio(notas) || null, activo ? 1 : 0];
  if (id) await ejecutar('UPDATE tipos_cliente SET nombre = ?, descuento = ?, limite_credito = ?, notas = ?, activo = ? WHERE id = ?', [...v, id]);
  else await ejecutar('INSERT INTO tipos_cliente (nombre, descuento, limite_credito, notas, activo) VALUES (?,?,?,?,?)', v);
}
export async function eliminarTipoCliente(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM clientes WHERE tipo_cliente_id = ?', [id]);
  if (n) throw new Error(`Hay ${n} ${n === 1 ? 'cliente' : 'clientes'} de este tipo. Desactívalo en lugar de eliminarlo.`);
  await ejecutar('DELETE FROM tipos_cliente WHERE id = ?', [id]);
}

// ---------- Condiciones de pago ----------
export const listarCondiciones = () => consultar(
  `SELECT t.*, (SELECT COUNT(*) FROM clientes c WHERE c.condicion_pago_id = t.id) AS n_clientes FROM condiciones_pago t ORDER BY t.activo DESC, t.dias, t.nombre COLLATE NOCASE`);
export async function guardarCondicion({ id = null, nombre, dias = 0, activo = 1 }) {
  nombre = limpio(nombre);
  if (!nombre) throw new Error('Escribe el nombre de la condición de pago.');
  const d = Number(dias);
  if (!Number.isInteger(d) || d < 0 || d > 365) throw new Error('Los días deben ser un número entero entre 0 y 365 (0 = contado).');
  const [dup] = await consultar('SELECT id FROM condiciones_pago WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe una condición con ese nombre.');
  if (id) {
    await ejecutar('UPDATE condiciones_pago SET nombre = ?, dias = ?, activo = ? WHERE id = ?', [nombre, d, activo ? 1 : 0, id]);
    // Los clientes con esta condición siguen la nueva cantidad de días
    await ejecutar("UPDATE clientes SET condicion = ?, dias_credito = ? WHERE condicion_pago_id = ?", [d > 0 ? 'credito' : 'contado', d > 0 ? d : null, id]);
  } else await ejecutar('INSERT INTO condiciones_pago (nombre, dias, activo) VALUES (?,?,?)', [nombre, d, activo ? 1 : 0]);
}
export async function eliminarCondicion(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM clientes WHERE condicion_pago_id = ?', [id]);
  if (n) throw new Error(`Hay ${n} ${n === 1 ? 'cliente' : 'clientes'} con esta condición. Desactívala en lugar de eliminarla.`);
  await ejecutar('DELETE FROM condiciones_pago WHERE id = ?', [id]);
}

// ---------- Descuentos y devoluciones (motivos) ----------
export const TIPOS_CONCEPTO_CXC = { descuento: 'Descuento', devolucion: 'Devolución', cargo: 'Cargo (nota de débito)' };
export const listarConceptosCxc = () => consultar(
  `SELECT k.*, (SELECT COUNT(*) FROM cxc_docs d WHERE d.concepto_id = k.id) AS n_docs FROM cxc_conceptos k ORDER BY k.activo DESC, k.tipo, k.nombre COLLATE NOCASE`);
export async function guardarConceptoCxc({ id = null, nombre, tipo = 'descuento', porcentaje = null, notas = '', activo = 1 }) {
  nombre = limpio(nombre);
  if (!nombre) throw new Error('Escribe el nombre del motivo.');
  if (!TIPOS_CONCEPTO_CXC[tipo]) throw new Error('Elige el tipo de motivo.');
  const pc = porcentaje === '' || porcentaje == null ? null : Number(porcentaje);
  if (pc != null && !(pc >= 0 && pc <= 100)) throw new Error('El porcentaje debe estar entre 0 y 100.');
  const [dup] = await consultar('SELECT id FROM cxc_conceptos WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe un motivo con ese nombre.');
  const v = [nombre, tipo, pc, limpio(notas) || null, activo ? 1 : 0];
  if (id) await ejecutar('UPDATE cxc_conceptos SET nombre = ?, tipo = ?, porcentaje = ?, notas = ?, activo = ? WHERE id = ?', [...v, id]);
  else await ejecutar('INSERT INTO cxc_conceptos (nombre, tipo, porcentaje, notas, activo) VALUES (?,?,?,?,?)', v);
}
export async function eliminarConceptoCxc(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM cxc_docs WHERE concepto_id = ?', [id]);
  if (n) throw new Error('Hay notas con este motivo. Desactívalo en lugar de eliminarlo.');
  await ejecutar('DELETE FROM cxc_conceptos WHERE id = ?', [id]);
}

// ---------- Clientes (vista de CxC) ----------
const VENCE = "COALESCE((SELECT vence FROM cuentas_cobrar WHERE venta_id = v.id), date(v.fecha, '+' || COALESCE(c.dias_credito, 30) || ' days'))";
const SALDO_V = '(v.total - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.venta_id = v.id), 0))';

// Todas las facturas a crédito con saldo (vigentes), con cliente, tipo y condición. Base de los reportes.
export async function facturasConSaldo({ hasta = null } = {}) {
  const filas = await consultar(
    `SELECT v.id, v.numero, v.fecha, v.total, v.cliente_id, c.nombre AS cliente, c.tipo_cliente_id, t.nombre AS tipo_cliente, c.condicion_pago_id, k.nombre AS condicion,
            ${VENCE} AS vence, ${SALDO_V} AS saldo
       FROM ventas v JOIN clientes c ON c.id = v.cliente_id LEFT JOIN tipos_cliente t ON t.id = c.tipo_cliente_id LEFT JOIN condiciones_pago k ON k.id = c.condicion_pago_id
      WHERE v.metodo_pago = 'credito' AND v.estado = 'completada' ${hasta ? 'AND substr(v.fecha, 1, 10) <= ?' : ''}`, hasta ? [hasta] : []);
  return filas.map((f) => ({ ...f, saldo: r2(f.saldo) })).filter((f) => f.saldo > 0.005);
}

export async function clientesCxc() {
  const clientes = await consultar(
    `SELECT c.*, t.nombre AS tipo_cliente, k.nombre AS condicion_nombre FROM clientes c LEFT JOIN tipos_cliente t ON t.id = c.tipo_cliente_id LEFT JOIN condiciones_pago k ON k.id = c.condicion_pago_id
      ORDER BY c.nombre COLLATE NOCASE`);
  const fac = await facturasConSaldo();
  const hoyISO = hoy();
  const ant = await consultar(
    `SELECT d.cliente_id, d.monto - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.documento_id = d.id), 0) AS disponible
       FROM cxc_docs d WHERE d.tipo = 'anticipo' AND d.estado = 'vigente'`);
  return clientes.map((c) => {
    const mias = fac.filter((f) => f.cliente_id === c.id);
    const saldo = r2(mias.reduce((s, f) => s + f.saldo, 0));
    const vencido = r2(mias.filter((f) => f.vence < hoyISO).reduce((s, f) => s + f.saldo, 0));
    const anticipos = r2(ant.filter((a) => a.cliente_id === c.id).reduce((s, a) => s + a.disponible, 0));
    return { ...c, saldo, vencido, facturas: mias.length, anticipos, disponible: c.limite_credito > 0 ? r2(Math.max(0, c.limite_credito - saldo)) : null };
  });
}

// Tipo de cliente, condición de pago y límite de crédito de un cliente. La condición fija contado/crédito y los días del cliente.
export async function guardarCreditoCliente({ cliente_id, tipo_cliente_id = null, condicion_pago_id = null, limite_credito = null }) {
  const [c] = await consultar('SELECT id FROM clientes WHERE id = ?', [cliente_id]);
  if (!c) throw new Error('El cliente no existe.');
  let condicion = null; let dias = null;
  if (condicion_pago_id) {
    const [k] = await consultar('SELECT * FROM condiciones_pago WHERE id = ?', [condicion_pago_id]);
    if (!k) throw new Error('La condición de pago no existe.');
    condicion = k.dias > 0 ? 'credito' : 'contado'; dias = k.dias > 0 ? k.dias : null;
  }
  if (tipo_cliente_id) {
    const [t] = await consultar('SELECT id FROM tipos_cliente WHERE id = ?', [tipo_cliente_id]);
    if (!t) throw new Error('El tipo de cliente no existe.');
  }
  const lim = Number(limite_credito) > 0 ? r2(limite_credito) : null;
  await ejecutar('UPDATE clientes SET tipo_cliente_id = ?, condicion_pago_id = ?, condicion = ?, dias_credito = ?, limite_credito = ? WHERE id = ?',
    [tipo_cliente_id || null, condicion_pago_id || null, condicion, dias, lim, cliente_id]);
}

// ---------- Notas de crédito y de débito ----------
async function facturaDelCliente(clienteId, ventaId) {
  const [v] = await consultar(
    `SELECT v.id, v.numero, v.cliente_id, v.total, v.estado, v.metodo_pago, ${SALDO_V} AS saldo FROM ventas v WHERE v.id = ?`, [ventaId]);
  if (!v) throw new Error('Elige la factura.');
  if (v.cliente_id !== clienteId) throw new Error('Esa factura no es de este cliente.');
  if (v.metodo_pago !== 'credito') throw new Error('La factura debe ser a crédito.');
  if (v.estado !== 'completada') throw new Error('La factura está anulada.');
  return { ...v, saldo: r2(v.saldo) };
}

export async function crearNota({ tipo, cliente_id, venta_id, concepto_id = null, monto, itbis = 0, ncf = '', fecha = hoy(), notas = '' }) {
  if (!['credito', 'debito'].includes(tipo)) throw new Error('Tipo de nota no válido.');
  const m = r2(monto); const it = r2(itbis || 0);
  if (!(m > 0)) throw new Error('Escribe un monto mayor que cero.');
  if (it < 0 || it > m) throw new Error('El ITBIS no puede ser negativo ni mayor que el monto.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  await exigirPeriodoAbierto(fecha);
  const v = await facturaDelCliente(cliente_id, venta_id);
  if (tipo === 'credito' && m > v.saldo + 0.005) throw new Error(`La nota de crédito no puede ser mayor que lo que debe la factura ${v.numero} (${v.saldo.toFixed(2)}).`);
  if (concepto_id) {
    const [k] = await consultar('SELECT tipo FROM cxc_conceptos WHERE id = ?', [concepto_id]);
    if (!k) throw new Error('El motivo no existe.');
    if ((tipo === 'debito') !== (k.tipo === 'cargo')) throw new Error(tipo === 'debito' ? 'Para una nota de débito elige un motivo de tipo cargo.' : 'Para una nota de crédito elige un descuento o una devolución.');
  }
  const prefijo = tipo === 'credito' ? 'NC' : 'ND'; const clave = tipo === 'credito' ? 'siguiente_numero_nc' : 'siguiente_numero_nd';
  // Si la factura es electrónica, su nota también: el e-NCF (E34 crédito / E33 débito) lo entrega el servidor y la nota viaja a la DGII
  let electronico = null;
  if (!limpio(ncf)) {
    const [fv] = await consultar('SELECT ncf FROM ventas WHERE id = ?', [venta_id]);
    if (/^E\d{12}$/.test(String(fv?.ncf || ''))) electronico = await pedirNcfElectronico(tipo === 'credito' ? 'E34' : 'E33');
    if (electronico) ncf = electronico.ncf;
  }
  try {
  const numero = await numeroDocumento(prefijo, clave);
  const doc = '(SELECT id FROM cxc_docs WHERE numero = ?)';
  await transaccion([
    { statement: 'INSERT INTO cxc_docs (numero, tipo, fecha, cliente_id, venta_id, concepto_id, monto, itbis, ncf, notas, usuario_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      values: [numero, tipo, fecha, cliente_id, venta_id, concepto_id || null, m, it, limpio(ncf).toUpperCase() || null, limpio(notas) || null, usuarioId()] },
    { statement: `INSERT INTO pagos (venta_id, monto, metodo, nota, documento_id, fecha) VALUES (?, ?, ?, ?, ${doc}, ?)`,
      values: [venta_id, tipo === 'credito' ? m : -m, tipo === 'credito' ? 'nota_credito' : 'nota_debito', `${tipo === 'credito' ? 'Nota de crédito' : 'Nota de débito'} ${numero}`, numero, fecha] },
    contador(clave),
  ]);
  const [d] = await consultar('SELECT id FROM cxc_docs WHERE numero = ?', [numero]);
  return { id: d.id, numero, ncf: electronico?.ncf || null };
  } catch (e) {
    if (electronico) await soltarNcfElectronico(electronico, `La nota no se pudo guardar (${e.message || e})`.slice(0, 200));
    throw e;
  }
}

export async function anularNota(id, motivo = '') {
  const [d] = await consultar("SELECT * FROM cxc_docs WHERE id = ? AND tipo IN ('credito','debito')", [id]);
  if (!d) throw new Error('La nota no existe.');
  if (d.estado === 'anulado') throw new Error('La nota ya está anulada.');
  if (!limpio(motivo)) throw new Error('Escribe el motivo de la anulación.');
  await exigirPeriodoAbierto(d.fecha);
  if (d.tipo === 'debito') {
    const v = await facturaDelCliente(d.cliente_id, d.venta_id).catch(() => null);
    if (v && v.saldo - d.monto < -0.005) throw new Error('El cliente ya pagó esta nota de débito. Anula primero los recibos que la cobraron.');
  }
  await transaccion([
    { statement: "UPDATE cxc_docs SET estado = 'anulado', anulado_motivo = ? WHERE id = ?", values: [limpio(motivo), id] },
    { statement: 'DELETE FROM pagos WHERE documento_id = ?', values: [id] },
  ]);
}

export async function listarNotas({ tipo, desde = '0000-00-00', hasta = '9999-12-31' }) {
  return consultar(
    `SELECT d.*, c.nombre AS cliente, v.numero AS factura, k.nombre AS concepto FROM cxc_docs d JOIN clientes c ON c.id = d.cliente_id
       LEFT JOIN ventas v ON v.id = d.venta_id LEFT JOIN cxc_conceptos k ON k.id = d.concepto_id
      WHERE d.tipo = ? AND substr(d.fecha, 1, 10) BETWEEN ? AND ? ORDER BY d.fecha DESC, d.id DESC`, [tipo, desde, hasta]);
}

// ---------- Anticipos ----------
export async function crearAnticipo({ cliente_id, monto, metodo = 'efectivo', referencia = '', fecha = hoy(), notas = '' }) {
  const m = r2(monto);
  if (!(m > 0)) throw new Error('Escribe el monto del anticipo.');
  if (!METODOS_COBRO.includes(metodo)) throw new Error('Método de pago no válido.');
  if (metodo === 'cheque' && !limpio(referencia)) throw new Error('Escribe el número de cheque.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  const [c] = await consultar('SELECT id FROM clientes WHERE id = ?', [cliente_id]);
  if (!c) throw new Error('Elige el cliente.');
  await exigirPeriodoAbierto(fecha);
  const numero = await numeroDocumento('AN', 'siguiente_numero_anticipo');
  await transaccion([
    { statement: "INSERT INTO cxc_docs (numero, tipo, fecha, cliente_id, monto, metodo, referencia, notas, usuario_id) VALUES (?, 'anticipo', ?, ?, ?, ?, ?, ?, ?)",
      values: [numero, fecha, cliente_id, m, metodo, limpio(referencia) || null, limpio(notas) || null, usuarioId()] },
    contador('siguiente_numero_anticipo'),
  ]);
  const [d] = await consultar('SELECT id FROM cxc_docs WHERE numero = ?', [numero]);
  return { id: d.id, numero };
}

export async function listarAnticipos({ clienteId = null, soloDisponibles = false } = {}) {
  const filas = await consultar(
    `SELECT d.*, c.nombre AS cliente, d.monto - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.documento_id = d.id), 0) AS disponible
       FROM cxc_docs d JOIN clientes c ON c.id = d.cliente_id WHERE d.tipo = 'anticipo' ${clienteId ? 'AND d.cliente_id = ?' : ''} ORDER BY d.fecha DESC, d.id DESC`, clienteId ? [clienteId] : []);
  const r = filas.map((a) => ({ ...a, disponible: a.estado === 'anulado' ? 0 : r2(a.disponible) }));
  return soloDisponibles ? r.filter((a) => a.estado === 'vigente' && a.disponible > 0.005) : r;
}
export const aplicacionesAnticipo = (id) => consultar(
  `SELECT p.id, p.monto, p.fecha, v.numero AS factura FROM pagos p JOIN ventas v ON v.id = p.venta_id WHERE p.documento_id = ? ORDER BY p.id`, [id]);

export async function aplicarAnticipo({ anticipo_id, venta_id, monto, fecha = hoy() }) {
  const [a] = await consultar("SELECT * FROM cxc_docs WHERE id = ? AND tipo = 'anticipo'", [anticipo_id]);
  if (!a) throw new Error('El anticipo no existe.');
  if (a.estado !== 'vigente') throw new Error('El anticipo está anulado.');
  const m = r2(monto);
  if (!(m > 0)) throw new Error('Escribe cuánto del anticipo se aplica.');
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  await exigirPeriodoAbierto(fecha);
  const [{ usado }] = await consultar('SELECT COALESCE(SUM(monto), 0) AS usado FROM pagos WHERE documento_id = ?', [anticipo_id]);
  const disponible = r2(a.monto - usado);
  if (m > disponible + 0.005) throw new Error(`El anticipo solo tiene ${disponible.toFixed(2)} disponible.`);
  const v = await facturaDelCliente(a.cliente_id, venta_id);
  if (m > v.saldo + 0.005) throw new Error(`La factura ${v.numero} solo debe ${v.saldo.toFixed(2)}.`);
  await ejecutar('INSERT INTO pagos (venta_id, monto, metodo, nota, documento_id, fecha) VALUES (?, ?, ?, ?, ?, ?)',
    [venta_id, m, 'anticipo', `Anticipo ${a.numero}`, anticipo_id, fecha]);
}
export async function quitarAplicacion(pagoId) {
  const [p] = await consultar("SELECT * FROM pagos WHERE id = ? AND metodo = 'anticipo'", [pagoId]);
  if (!p) throw new Error('La aplicación no existe.');
  await exigirPeriodoAbierto(String(p.fecha).slice(0, 10));
  await ejecutar('DELETE FROM pagos WHERE id = ?', [pagoId]);
}
export async function anularAnticipo(id, motivo = '') {
  const [d] = await consultar("SELECT * FROM cxc_docs WHERE id = ? AND tipo = 'anticipo'", [id]);
  if (!d) throw new Error('El anticipo no existe.');
  if (d.estado === 'anulado') throw new Error('El anticipo ya está anulado.');
  if (!limpio(motivo)) throw new Error('Escribe el motivo de la anulación.');
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM pagos WHERE documento_id = ?', [id]);
  if (n) throw new Error('Este anticipo ya se aplicó a facturas. Quita primero esas aplicaciones.');
  await exigirPeriodoAbierto(d.fecha);
  await ejecutar("UPDATE cxc_docs SET estado = 'anulado', anulado_motivo = ? WHERE id = ?", [limpio(motivo), id]);
}

// ---------- Recibos (lista) ----------
export const listarRecibos = ({ desde = '0000-00-00', hasta = '9999-12-31' } = {}) => consultar(
  `SELECT r.id, r.numero, r.fecha, r.total, r.estado, r.cliente_id, c.nombre AS cliente FROM recibos r JOIN clientes c ON c.id = r.cliente_id
    WHERE substr(r.fecha, 1, 10) BETWEEN ? AND ? ORDER BY r.id DESC`, [desde, hasta]);

// ---------- Estado de cuenta de un cliente ----------
export async function estadoCuentaCliente(clienteId, { hasta = hoy() } = {}) {
  const [c] = await consultar('SELECT c.*, t.nombre AS tipo_cliente, k.nombre AS condicion_nombre FROM clientes c LEFT JOIN tipos_cliente t ON t.id = c.tipo_cliente_id LEFT JOIN condiciones_pago k ON k.id = c.condicion_pago_id WHERE c.id = ?', [clienteId]);
  if (!c) throw new Error('El cliente no existe.');
  const facturas = (await facturasConSaldo({ hasta })).filter((f) => f.cliente_id === clienteId).sort((a, b) => a.vence.localeCompare(b.vence));
  const anticipos = await listarAnticipos({ clienteId, soloDisponibles: true });
  const movimientos = await consultar(
    `SELECT p.id, p.fecha, p.monto, p.metodo, p.nota, v.numero AS factura FROM pagos p JOIN ventas v ON v.id = p.venta_id
      WHERE v.cliente_id = ? AND v.metodo_pago = 'credito' AND v.estado = 'completada' ORDER BY p.fecha DESC, p.id DESC LIMIT 200`, [clienteId]);
  const saldo = r2(facturas.reduce((s, f) => s + f.saldo, 0));
  return { cliente: c, facturas, anticipos, movimientos, saldo, anticiposDisponibles: r2(anticipos.reduce((s, a) => s + a.disponible, 0)) };
}

// ---------- Reporte CxC: antigüedad de saldos por cliente ----------
export const TRAMOS_CXC = [['alDia', 'Al día', -1e9, 0], ['t30', '1 a 30', 1, 30], ['t60', '31 a 60', 31, 60], ['t90', '61 a 90', 61, 90], ['t90m', 'Más de 90', 91, 1e9]];
const diasEntre = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);
export async function reporteCxc({ hasta = hoy(), clienteId = null, tipoClienteId = null, condicionId = null } = {}) {
  let fac = await facturasConSaldo({ hasta });
  if (clienteId) fac = fac.filter((f) => f.cliente_id === clienteId);
  if (tipoClienteId) fac = fac.filter((f) => f.tipo_cliente_id === tipoClienteId);
  if (condicionId) fac = fac.filter((f) => f.condicion_pago_id === condicionId);
  const porCliente = new Map();
  for (const f of fac) {
    const atraso = diasEntre(f.vence, hasta); // positivo = vencida hace N días
    const tramo = TRAMOS_CXC.find((t) => atraso >= t[2] && atraso <= t[3])[0];
    const g = porCliente.get(f.cliente_id) || { cliente_id: f.cliente_id, cliente: f.cliente, tipo_cliente: f.tipo_cliente || '', condicion: f.condicion || '', facturas: 0, total: 0, vencido: 0, ...Object.fromEntries(TRAMOS_CXC.map((t) => [t[0], 0])) };
    g.facturas++; g.total = r2(g.total + f.saldo); g[tramo] = r2(g[tramo] + f.saldo); if (atraso > 0) g.vencido = r2(g.vencido + f.saldo);
    porCliente.set(f.cliente_id, g);
  }
  const clientes = [...porCliente.values()].sort((a, b) => b.total - a.total);
  const totales = Object.fromEntries([['total', 0], ['vencido', 0], ['facturas', 0], ...TRAMOS_CXC.map((t) => [t[0], 0])]);
  for (const g of clientes) for (const k of Object.keys(totales)) totales[k] = r2(totales[k] + g[k]);
  const detalle = fac.map((f) => ({ ...f, atraso: diasEntre(f.vence, hasta) })).sort((a, b) => b.atraso - a.atraso);
  return { hasta, clientes, totales, detalle };
}

// ---------- Reporte dinámico ----------
export const TIPOS_DOC_CXC = { factura: 'Facturas a crédito', debito: 'Notas de débito', credito: 'Notas de crédito', recibo: 'Recibos', anticipo: 'Anticipos' };
export const DIMENSIONES_CXC = { cliente: 'Cliente', tipo_cliente: 'Tipo de cliente', condicion: 'Condición de pago', mes: 'Mes', concepto: 'Motivo', documento: 'Tipo de documento' };

// Todos los movimientos de CxC del período, uno por documento (sin anulados)
export async function movimientosCxc({ desde = '0000-00-00', hasta = '9999-12-31' } = {}) {
  const facturas = await consultar(
    `SELECT 'factura' AS documento, v.numero, substr(v.fecha, 1, 10) AS fecha, c.nombre AS cliente, COALESCE(t.nombre, '(sin tipo)') AS tipo_cliente, COALESCE(k.nombre, '(sin condición)') AS condicion,
            'Venta a crédito' AS concepto, v.total AS monto FROM ventas v JOIN clientes c ON c.id = v.cliente_id LEFT JOIN tipos_cliente t ON t.id = c.tipo_cliente_id LEFT JOIN condiciones_pago k ON k.id = c.condicion_pago_id
      WHERE v.metodo_pago = 'credito' AND v.estado = 'completada' AND substr(v.fecha, 1, 10) BETWEEN ? AND ?`, [desde, hasta]);
  const recibos = await consultar(
    `SELECT 'recibo' AS documento, r.numero, substr(r.fecha, 1, 10) AS fecha, c.nombre AS cliente, COALESCE(t.nombre, '(sin tipo)') AS tipo_cliente, COALESCE(k.nombre, '(sin condición)') AS condicion,
            'Cobro de facturas' AS concepto, r.total AS monto FROM recibos r JOIN clientes c ON c.id = r.cliente_id LEFT JOIN tipos_cliente t ON t.id = c.tipo_cliente_id LEFT JOIN condiciones_pago k ON k.id = c.condicion_pago_id
      WHERE r.estado = 'vigente' AND substr(r.fecha, 1, 10) BETWEEN ? AND ?`, [desde, hasta]);
  const docs = await consultar(
    `SELECT d.tipo AS documento, d.numero, substr(d.fecha, 1, 10) AS fecha, c.nombre AS cliente, COALESCE(t.nombre, '(sin tipo)') AS tipo_cliente, COALESCE(k.nombre, '(sin condición)') AS condicion,
            COALESCE(x.nombre, CASE d.tipo WHEN 'anticipo' THEN 'Anticipo' ELSE '(sin motivo)' END) AS concepto, d.monto
       FROM cxc_docs d JOIN clientes c ON c.id = d.cliente_id LEFT JOIN tipos_cliente t ON t.id = c.tipo_cliente_id LEFT JOIN condiciones_pago k ON k.id = c.condicion_pago_id LEFT JOIN cxc_conceptos x ON x.id = d.concepto_id
      WHERE d.estado = 'vigente' AND substr(d.fecha, 1, 10) BETWEEN ? AND ?`, [desde, hasta]);
  return [...facturas, ...recibos, ...docs].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.numero.localeCompare(b.numero));
}

// Tabla dinámica: filas = dimensión elegida, columnas = tipos de documento. neto = facturas + débitos − créditos − recibos − anticipos
export function tablaDinamicaCxc(movs, { dimension = 'cliente', tipos = Object.keys(TIPOS_DOC_CXC), busqueda = '' } = {}) {
  if (!DIMENSIONES_CXC[dimension]) throw new Error('Agrupación no válida.');
  const q = String(busqueda || '').trim().toLowerCase();
  const clave = (m) => (dimension === 'mes' ? m.fecha.slice(0, 7) : dimension === 'documento' ? TIPOS_DOC_CXC[m.documento] : m[dimension]);
  const grupos = new Map();
  for (const m of movs) {
    if (!tipos.includes(m.documento)) continue;
    if (q && !`${m.cliente} ${m.numero} ${m.concepto}`.toLowerCase().includes(q)) continue;
    const k = clave(m);
    const g = grupos.get(k) || { clave: k, n: 0, ...Object.fromEntries(Object.keys(TIPOS_DOC_CXC).map((t) => [t, 0])), neto: 0 };
    g.n++; g[m.documento] = r2(g[m.documento] + m.monto);
    g.neto = r2(g.neto + (['factura', 'debito'].includes(m.documento) ? m.monto : -m.monto));
    grupos.set(k, g);
  }
  const filas = [...grupos.values()].sort((a, b) => (dimension === 'mes' ? a.clave.localeCompare(b.clave) : b.neto - a.neto));
  const total = { n: 0, neto: 0, ...Object.fromEntries(Object.keys(TIPOS_DOC_CXC).map((t) => [t, 0])) };
  for (const g of filas) for (const k of Object.keys(total)) total[k] = r2(total[k] + g[k]);
  return { filas, total };
}

// Facturas a crédito de un cliente (con saldo o sin él), para elegir en una nota
export async function facturasCredito(clienteId, { soloConSaldo = false } = {}) {
  const filas = await consultar(
    `SELECT v.id, v.numero, substr(v.fecha, 1, 10) AS fecha, v.total, ${SALDO_V} AS saldo FROM ventas v
      WHERE v.cliente_id = ? AND v.metodo_pago = 'credito' AND v.estado = 'completada' ORDER BY v.id DESC`, [clienteId]);
  const r = filas.map((f) => ({ ...f, saldo: r2(f.saldo) }));
  return soloConSaldo ? r.filter((f) => f.saldo > 0.005) : r;
}
