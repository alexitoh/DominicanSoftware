// banco-db.js - datos del módulo Banco: tipos de cuenta, cheques, depósitos, cargos, transferencias, créditos bancarios,
// solicitudes de pago y reportes. Cada movimiento nace de banco_movs / creditos_bancarios / credito_pagos y el motor contable
// (conta-motor.js) le arma su asiento con la cuenta contable de su cuenta bancaria; aquí no se escribe ningún asiento a mano.
import { consultar, ejecutar, transaccion, numeroDocumento, usuarioId } from './database.js';
import { registrarMovBanco, anularMovBanco, movimientosBanco, listarBancos, exigirPeriodoAbierto, libroContable } from './conta-db.js';
import { pagarSuplidor } from './cxp-db.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !Number.isNaN(Date.parse(f));
const limpio = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const contador = (clave) => ({ statement: 'UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = ?', values: [clave] });

// ---------- Tipos de cuenta ----------
export const listarTiposCuenta = () => consultar(
  `SELECT t.*, (SELECT COUNT(*) FROM cuentas_bancarias b WHERE b.tipo_cuenta_id = t.id) AS n_cuentas FROM tipos_cuenta_banco t ORDER BY t.activo DESC, t.nombre COLLATE NOCASE`);
export async function guardarTipoCuenta({ id = null, nombre, activo = 1 }) {
  nombre = limpio(nombre);
  if (!nombre) throw new Error('Escribe el nombre del tipo de cuenta.');
  const [dup] = await consultar('SELECT id FROM tipos_cuenta_banco WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe un tipo de cuenta con ese nombre.');
  if (id) await ejecutar('UPDATE tipos_cuenta_banco SET nombre = ?, activo = ? WHERE id = ?', [nombre, activo ? 1 : 0, id]);
  else await ejecutar('INSERT INTO tipos_cuenta_banco (nombre, activo) VALUES (?,?)', [nombre, activo ? 1 : 0]);
}
export async function eliminarTipoCuenta(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM cuentas_bancarias WHERE tipo_cuenta_id = ?', [id]);
  if (n) throw new Error('Hay cuentas bancarias de este tipo: cámbiales el tipo o desactívalo.');
  await ejecutar('DELETE FROM tipos_cuenta_banco WHERE id = ?', [id]);
}
export async function asignarTipoCuenta(bancoId, tipoId) {
  await ejecutar('UPDATE cuentas_bancarias SET tipo_cuenta_id = ? WHERE id = ?', [tipoId || null, bancoId]);
}

// ---------- Cuentas con saldo ----------
export async function resumenBancos() {
  const bancos = await consultar(`SELECT b.*, t.nombre AS tipo_cuenta FROM cuentas_bancarias b LEFT JOIN tipos_cuenta_banco t ON t.id = b.tipo_cuenta_id ORDER BY b.activo DESC, b.nombre COLLATE NOCASE`);
  const out = [];
  for (const b of bancos) {
    const m = await movimientosBanco(b.id).catch(() => ({ saldoLibros: 0, saldoConciliado: 0 }));
    out.push({ ...b, saldoLibros: m.saldoLibros, saldoConciliado: m.saldoConciliado });
  }
  return out;
}

// ---------- Movimientos de banco por clase ----------
export const CLASES_MOV = { deposito: ['deposito', 'interes'], cargo: ['comision'], cheque: ['cheque'], transferencia: ['transferencia'] };

// Movimientos de una clase, con su cuenta y (para cheques) si ya salió por el banco (conciliado)
export async function listarMovsBanco(clase, { bancoId = null, desde = '0000-00-00', hasta = '9999-12-31' } = {}) {
  const tipos = CLASES_MOV[clase];
  if (!tipos) throw new Error('Clase de movimiento no válida.');
  const rows = await consultar(
    `SELECT m.*, b.nombre AS banco, d.nombre AS destino, c.codigo AS contra_codigo, c.nombre AS contra_nombre
       FROM banco_movs m JOIN cuentas_bancarias b ON b.id = m.banco_id LEFT JOIN cuentas_bancarias d ON d.id = m.banco_destino_id LEFT JOIN cuentas_contables c ON c.id = m.contra_cuenta_id
      WHERE m.tipo IN (${tipos.map(() => '?').join(',')}) AND m.fecha BETWEEN ? AND ? ${bancoId ? 'AND m.banco_id = ?' : ''} ORDER BY m.fecha DESC, m.id DESC LIMIT 300`,
    [...tipos, desde, hasta, ...(bancoId ? [bancoId] : [])]);
  if (clase !== 'cheque') return rows;
  const conc = new Map();
  for (const b of new Set(rows.map((r) => r.banco_id))) {
    const info = await movimientosBanco(b).catch(() => ({ movimientos: [] }));
    conc.set(b, info.movimientos.filter((x) => x.conciliado).map((x) => x.key));
  }
  return rows.map((m) => ({ ...m, estado_cheque: m.estado === 'anulado' ? 'anulado' : (conc.get(m.banco_id) || []).some((k) => k.startsWith(`banco:${m.numero}#`)) ? 'cobrado' : 'transito' }));
}
export const ESTADOS_CHEQUE = { transito: 'En tránsito', cobrado: 'Cobrado', anulado: 'Anulado' };

export const CONCEPTOS_CARGO = ['Comisión por mantenimiento de cuenta', 'Impuesto 0.15% (Ley 288-04)', 'Comisión por transferencia', 'Cargo por cheque devuelto', 'Cargo por emisión de chequera', 'Otro'];

async function exigirCuenta(bancoId) {
  const [b] = await consultar('SELECT id, nombre FROM cuentas_bancarias WHERE id = ? AND activo = 1', [bancoId]);
  if (!b) throw new Error('Elige la cuenta bancaria.');
  return b;
}

export async function registrarCargo({ banco_id, fecha = hoy(), monto, concepto, referencia = '' }) {
  concepto = limpio(concepto);
  if (!concepto) throw new Error('Escribe el concepto del cargo (por ejemplo, comisión por mantenimiento).');
  await exigirCuenta(banco_id);
  return registrarMovBanco({ banco_id, fecha, tipo: 'comision', monto, referencia, detalle: concepto });
}

export async function registrarDeposito({ banco_id, fecha = hoy(), monto, origen_cuenta_id = null, referencia = '', detalle = '' }) {
  await exigirCuenta(banco_id);
  return registrarMovBanco({ banco_id, fecha, tipo: 'deposito', monto, contra_cuenta_id: origen_cuenta_id || null, referencia, detalle: limpio(detalle) || 'Depósito bancario' });
}

export async function registrarTransferencia({ banco_id, banco_destino_id, fecha = hoy(), monto, referencia = '', detalle = '' }) {
  await exigirCuenta(banco_id); await exigirCuenta(banco_destino_id);
  return registrarMovBanco({ banco_id, banco_destino_id, fecha, tipo: 'transferencia', monto, referencia, detalle: limpio(detalle) || 'Transferencia entre cuentas' });
}

// Cheque emitido: sale del banco contra la cuenta donde se gasta (o la deuda que se paga). Queda "en tránsito" hasta conciliarlo.
export async function emitirCheque({ banco_id, fecha = hoy(), monto, numero_cheque, beneficiario, contra_cuenta_id, detalle = '' }) {
  numero_cheque = limpio(numero_cheque); beneficiario = limpio(beneficiario);
  if (!numero_cheque) throw new Error('Escribe el número del cheque.');
  if (!beneficiario) throw new Error('Escribe a nombre de quién sale el cheque.');
  if (!contra_cuenta_id) throw new Error('Elige la cuenta contable donde se aplica el cheque (el gasto o la deuda que paga).');
  await exigirCuenta(banco_id);
  const [dup] = await consultar("SELECT id FROM banco_movs WHERE banco_id = ? AND tipo = 'cheque' AND referencia = ? AND estado = 'vigente'", [banco_id, numero_cheque]);
  if (dup) throw new Error(`El cheque ${numero_cheque} ya se emitió desde esta cuenta.`);
  return registrarMovBanco({ banco_id, fecha, tipo: 'cheque', monto, contra_cuenta_id, referencia: numero_cheque, beneficiario, detalle: limpio(detalle) || `Cheque ${numero_cheque} a ${beneficiario}` });
}
export async function anularCheque(id) {
  const [m] = await consultar("SELECT numero, tipo FROM banco_movs WHERE id = ?", [id]);
  if (!m || m.tipo !== 'cheque') throw new Error('El cheque no existe.');
  const info = await listarMovsBanco('cheque');
  const c = info.find((x) => x.id === id);
  if (c?.estado_cheque === 'cobrado') throw new Error('Ese cheque ya se concilió con el banco; no se puede anular.');
  await anularMovBanco(id);
}
export { anularMovBanco };

// ---------- Créditos bancarios ----------
// Cuota fija (sistema francés): el interés de cada cuota es la tasa mensual por el saldo; el resto es capital.
export function calcularCuota(monto, tasaAnual, plazo) {
  const i = Number(tasaAnual) / 100 / 12;
  if (!(monto > 0) || !(plazo > 0)) return 0;
  return r2(i === 0 ? monto / plazo : (monto * i) / (1 - (1 + i) ** -plazo));
}
export function tablaAmortizacion(monto, tasaAnual, plazo, cuota = calcularCuota(monto, tasaAnual, plazo)) {
  const i = Number(tasaAnual) / 100 / 12; let saldo = r2(monto); const filas = [];
  for (let n = 1; n <= plazo; n++) {
    const interes = r2(saldo * i);
    const capital = n === plazo ? saldo : r2(cuota - interes);
    saldo = r2(saldo - capital);
    filas.push({ n, cuota: r2(capital + interes), interes, capital, saldo });
  }
  return filas;
}

export async function crearCredito({ fecha = hoy(), entidad = '', banco_id, monto, tasa_anual = 0, plazo_meses, notas = '' }) {
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  await exigirPeriodoAbierto(fecha);
  await exigirCuenta(banco_id);
  monto = r2(monto);
  if (!(monto > 0)) throw new Error('El monto del crédito debe ser mayor que cero.');
  tasa_anual = Number(tasa_anual);
  if (!(tasa_anual >= 0) || tasa_anual > 100) throw new Error('La tasa anual debe estar entre 0 y 100.');
  plazo_meses = Number(plazo_meses);
  if (!Number.isInteger(plazo_meses) || plazo_meses < 1 || plazo_meses > 480) throw new Error('El plazo debe ser un número entero de meses (1 a 480).');
  const numero = await numeroDocumento('CB', 'siguiente_numero_credito');
  await transaccion([{
    statement: 'INSERT INTO creditos_bancarios (numero, fecha, entidad, banco_id, monto, tasa_anual, plazo_meses, cuota, notas) VALUES (?,?,?,?,?,?,?,?,?)',
    values: [numero, fecha, limpio(entidad) || null, banco_id, monto, tasa_anual, plazo_meses, calcularCuota(monto, tasa_anual, plazo_meses), limpio(notas) || null],
  }, contador('siguiente_numero_credito')]);
  return numero;
}

const SQL_CREDITOS = `SELECT c.*, b.nombre AS banco,
    COALESCE((SELECT SUM(p.capital) FROM credito_pagos p WHERE p.credito_id = c.id AND p.estado = 'vigente'), 0) AS capital_pagado,
    COALESCE((SELECT SUM(p.interes) FROM credito_pagos p WHERE p.credito_id = c.id AND p.estado = 'vigente'), 0) AS interes_pagado,
    (SELECT COUNT(*) FROM credito_pagos p WHERE p.credito_id = c.id AND p.estado = 'vigente') AS n_pagos
  FROM creditos_bancarios c JOIN cuentas_bancarias b ON b.id = c.banco_id`;
export async function listarCreditos() {
  return (await consultar(`${SQL_CREDITOS} ORDER BY c.fecha DESC, c.id DESC`)).map((c) => ({ ...c, saldo: r2(c.monto - c.capital_pagado) }));
}
export async function detalleCredito(id) {
  const [c] = await consultar(`${SQL_CREDITOS} WHERE c.id = ?`, [id]);
  if (!c) throw new Error('El crédito no existe.');
  const pagos = await consultar('SELECT p.*, b.nombre AS banco FROM credito_pagos p JOIN cuentas_bancarias b ON b.id = p.banco_id WHERE p.credito_id = ? ORDER BY p.fecha DESC, p.id DESC', [id]);
  const saldo = r2(c.monto - c.capital_pagado);
  const i = c.tasa_anual / 100 / 12;
  return { ...c, saldo, pagos, proximoInteres: r2(saldo * i), amortizacion: tablaAmortizacion(c.monto, c.tasa_anual, c.plazo_meses, c.cuota) };
}
// Pago de una cuota (o abono): el interés es el del mes sobre el saldo; lo demás baja el capital
export async function pagarCreditoCuota({ credito_id, fecha = hoy(), banco_id, monto = null, referencia = '' }) {
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  await exigirPeriodoAbierto(fecha);
  await exigirCuenta(banco_id);
  const c = await detalleCredito(credito_id);
  if (c.estado !== 'vigente') throw new Error('El crédito está anulado.');
  if (c.saldo <= 0.004) throw new Error('Este crédito ya está pagado.');
  const interes = c.proximoInteres;
  const total = monto === null || monto === '' ? Math.min(c.cuota, r2(c.saldo + interes)) : r2(monto);
  if (!(total > interes)) throw new Error(`El pago debe ser mayor que el interés del mes (${interes.toFixed(2)}).`);
  const capital = r2(total - interes);
  if (capital > c.saldo + 0.004) throw new Error(`El pago no puede pasar de lo que queda por pagar (${r2(c.saldo + interes).toFixed(2)}).`);
  const numero = await numeroDocumento('PC', 'siguiente_numero_pagocredito');
  await transaccion([{
    statement: 'INSERT INTO credito_pagos (numero, credito_id, fecha, capital, interes, banco_id, referencia) VALUES (?,?,?,?,?,?,?)',
    values: [numero, credito_id, fecha, capital, interes, banco_id, limpio(referencia) || null],
  }, contador('siguiente_numero_pagocredito')]);
  return { numero, capital, interes };
}
export async function anularPagoCredito(id) {
  const [p] = await consultar('SELECT fecha FROM credito_pagos WHERE id = ?', [id]);
  if (!p) throw new Error('El pago no existe.');
  await exigirPeriodoAbierto(p.fecha);
  await ejecutar("UPDATE credito_pagos SET estado = 'anulado' WHERE id = ?", [id]);
}
export async function anularCredito(id) {
  const [c] = await consultar('SELECT fecha FROM creditos_bancarios WHERE id = ?', [id]);
  if (!c) throw new Error('El crédito no existe.');
  const [{ n }] = await consultar("SELECT COUNT(*) AS n FROM credito_pagos WHERE credito_id = ? AND estado = 'vigente'", [id]);
  if (n) throw new Error('El crédito tiene cuotas pagadas: anúlalas primero.');
  await exigirPeriodoAbierto(c.fecha);
  await ejecutar("UPDATE creditos_bancarios SET estado = 'anulado' WHERE id = ?", [id]);
}

// ---------- Solicitudes de pago ----------
export const ESTADOS_SOLICITUD_PAGO = { pendiente: 'Pendiente de aprobar', aprobada: 'Aprobada', pagada: 'Pagada', rechazada: 'Rechazada' };

// A un suplidor (se aplica a sus facturas pendientes) o a un tercero (se aplica a la cuenta contable de gasto que se indique)
export async function crearSolicitudPago({ fecha = hoy(), beneficiario = '', proveedor_id = null, concepto = '', monto, forma = 'cheque', contra_cuenta_id = null, notas = '' }) {
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  if (!['cheque', 'transferencia'].includes(forma)) throw new Error('La forma de pago debe ser cheque o transferencia.');
  monto = r2(monto);
  if (!(monto > 0)) throw new Error('El monto debe ser mayor que cero.');
  if (proveedor_id) {
    const [p] = await consultar('SELECT nombre FROM proveedores WHERE id = ?', [proveedor_id]);
    if (!p) throw new Error('El suplidor no existe.');
    beneficiario = p.nombre;
  } else {
    beneficiario = limpio(beneficiario);
    if (!beneficiario) throw new Error('Escribe a quién se le paga o elige un suplidor.');
    if (!contra_cuenta_id) throw new Error('Elige la cuenta contable donde se aplica el pago (el gasto o la deuda).');
  }
  const numero = await numeroDocumento('SP', 'siguiente_numero_solpago');
  await transaccion([{
    statement: 'INSERT INTO solicitudes_pago (numero, fecha, beneficiario, proveedor_id, concepto, monto, forma, contra_cuenta_id, notas, usuario_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    values: [numero, fecha, beneficiario, proveedor_id || null, limpio(concepto) || null, monto, forma, proveedor_id ? null : contra_cuenta_id, limpio(notas) || null, usuarioId()],
  }, contador('siguiente_numero_solpago')]);
  return numero;
}
export const listarSolicitudesPago = () => consultar(
  `SELECT s.*, b.nombre AS banco, c.codigo AS contra_codigo, c.nombre AS contra_nombre FROM solicitudes_pago s LEFT JOIN cuentas_bancarias b ON b.id = s.banco_id LEFT JOIN cuentas_contables c ON c.id = s.contra_cuenta_id
    ORDER BY CASE s.estado WHEN 'pendiente' THEN 0 WHEN 'aprobada' THEN 1 ELSE 2 END, s.fecha DESC, s.id DESC LIMIT 300`);
async function solicitud(id) {
  const [s] = await consultar('SELECT * FROM solicitudes_pago WHERE id = ?', [id]);
  if (!s) throw new Error('La solicitud no existe.');
  return s;
}
export async function aprobarSolicitudPago(id) {
  const s = await solicitud(id);
  if (s.estado !== 'pendiente') throw new Error('Solo se puede aprobar una solicitud pendiente.');
  const [u] = usuarioId() ? await consultar('SELECT nombre FROM usuarios WHERE id = ?', [usuarioId()]) : [];
  await ejecutar("UPDATE solicitudes_pago SET estado = 'aprobada', aprobado_por = ? WHERE id = ?", [u?.nombre || 'Administrador', id]);
}
export async function rechazarSolicitudPago(id, motivo = '') {
  const s = await solicitud(id);
  if (!['pendiente', 'aprobada'].includes(s.estado)) throw new Error('Esta solicitud ya no se puede rechazar.');
  await ejecutar("UPDATE solicitudes_pago SET estado = 'rechazada', notas = ? WHERE id = ?", [[s.notas, limpio(motivo) && `Rechazo: ${limpio(motivo)}`].filter(Boolean).join(' · ') || null, id]);
}
// Pagar una solicitud aprobada. A un tercero: emite el cheque (o sale la transferencia) de la cuenta elegida contra la cuenta contable de la solicitud.
// A un suplidor: se aplica a sus facturas más viejas y sale de la cuenta bancaria predeterminada (así lo hace todo pago a suplidores).
export async function pagarSolicitudPago({ id, banco_id = null, fecha = hoy(), referencia = '' }) {
  const s = await solicitud(id);
  if (s.estado !== 'aprobada') throw new Error('La solicitud debe estar aprobada para pagarla.');
  referencia = limpio(referencia);
  if (s.forma === 'cheque' && !referencia) throw new Error('Escribe el número del cheque.');
  let mov = null; let banco = banco_id;
  if (s.proveedor_id) {
    const pred = (await listarBancos()).find((b) => b.predeterminada && b.activo) || (await listarBancos()).find((b) => b.activo);
    if (!pred) throw new Error('Crea una cuenta bancaria para pagar por cheque o transferencia.');
    banco = pred.id;
    await pagarSuplidor({ proveedor_id: s.proveedor_id, monto: s.monto, metodo: s.forma, nota: `Solicitud ${s.numero}${referencia ? ` · ${s.forma === 'cheque' ? 'cheque' : 'ref.'} ${referencia}` : ''}` });
  } else {
    if (!banco) throw new Error('Elige la cuenta bancaria de la que sale el pago.');
    if (s.forma === 'cheque') mov = await emitirCheque({ banco_id: banco, fecha, monto: s.monto, numero_cheque: referencia, beneficiario: s.beneficiario, contra_cuenta_id: s.contra_cuenta_id, detalle: s.concepto || '' });
    else mov = await registrarMovBanco({ banco_id: banco, fecha, tipo: 'retiro', monto: s.monto, contra_cuenta_id: s.contra_cuenta_id, referencia, beneficiario: s.beneficiario, detalle: `Transferencia a ${s.beneficiario}${s.concepto ? ` · ${s.concepto}` : ''}` });
  }
  await ejecutar("UPDATE solicitudes_pago SET estado = 'pagada', banco_id = ?, mov_numero = ?, referencia = ? WHERE id = ?", [banco, mov, referencia || null, id]);
  return mov;
}

// ---------- Reporte de banco ----------
// Por cuenta: saldo inicial, entradas, salidas y saldo final del período, lo conciliado y lo que falta por conciliar
export async function reporteBanco({ desde = `${hoy().slice(0, 4)}-01-01`, hasta = hoy() } = {}) {
  const bancos = await consultar(`SELECT b.*, t.nombre AS tipo_cuenta FROM cuentas_bancarias b LEFT JOIN tipos_cuenta_banco t ON t.id = b.tipo_cuenta_id WHERE b.activo = 1 ORDER BY b.nombre COLLATE NOCASE`);
  const filas = [];
  for (const b of bancos) {
    const info = await movimientosBanco(b.id, { hasta });
    const antes = info.movimientos.filter((m) => m.fecha < desde);
    const en = info.movimientos.filter((m) => m.fecha >= desde);
    const inicial = r2(antes.reduce((s, m) => s + m.entra - m.sale, 0));
    const entradas = r2(en.reduce((s, m) => s + m.entra, 0)); const salidas = r2(en.reduce((s, m) => s + m.sale, 0));
    const pend = info.movimientos.filter((m) => !m.conciliado);
    filas.push({ id: b.id, nombre: b.nombre, banco: b.banco, tipo_cuenta: b.tipo_cuenta || '(sin tipo)', inicial, entradas, salidas, final: r2(inicial + entradas - salidas), conciliado: info.saldoConciliado,
      pendientes: pend.length, depositosTransito: r2(pend.reduce((s, m) => s + m.entra, 0)), chequesTransito: r2(pend.reduce((s, m) => s + m.sale, 0)) });
  }
  const suma = (k) => r2(filas.reduce((s, f) => s + f[k], 0));
  return { desde, hasta, filas, total: { inicial: suma('inicial'), entradas: suma('entradas'), salidas: suma('salidas'), final: suma('final'), conciliado: suma('conciliado'), pendientes: filas.reduce((s, f) => s + f.pendientes, 0) } };
}

// ---------- Reporte dinámico ----------
export const TIPOS_DOC_BANCO = { deposito: 'Depósitos', interes: 'Intereses ganados', credito: 'Créditos recibidos', transferencia: 'Transferencias', retiro: 'Retiros', cheque: 'Cheques', comision: 'Cargos bancarios', pagocredito: 'Cuotas de créditos' };
const ENTRADAS = ['deposito', 'interes', 'credito'];
export const DIMENSIONES_BANCO = { cuenta: 'Cuenta bancaria', tipo_cuenta: 'Tipo de cuenta', mes: 'Mes', concepto: 'Concepto', documento: 'Tipo de movimiento' };

export async function movimientosBancoDin({ desde = '0000-00-00', hasta = '9999-12-31' } = {}) {
  const base = `SELECT m.tipo AS documento, m.numero, m.fecha, b.nombre AS cuenta, COALESCE(t.nombre, '(sin tipo)') AS tipo_cuenta, COALESCE(m.detalle, m.tipo) AS concepto, m.monto
    FROM banco_movs m JOIN cuentas_bancarias b ON b.id = m.banco_id LEFT JOIN tipos_cuenta_banco t ON t.id = b.tipo_cuenta_id WHERE m.estado = 'vigente' AND m.fecha BETWEEN ? AND ?`;
  const movs = await consultar(base, [desde, hasta]);
  const creditos = await consultar(
    `SELECT 'credito' AS documento, c.numero, c.fecha, b.nombre AS cuenta, COALESCE(t.nombre, '(sin tipo)') AS tipo_cuenta, 'Crédito ' || COALESCE(c.entidad, '') AS concepto, c.monto
       FROM creditos_bancarios c JOIN cuentas_bancarias b ON b.id = c.banco_id LEFT JOIN tipos_cuenta_banco t ON t.id = b.tipo_cuenta_id WHERE c.estado = 'vigente' AND c.fecha BETWEEN ? AND ?`, [desde, hasta]);
  const pagos = await consultar(
    `SELECT 'pagocredito' AS documento, p.numero, p.fecha, b.nombre AS cuenta, COALESCE(t.nombre, '(sin tipo)') AS tipo_cuenta, 'Cuota ' || c.numero AS concepto, p.capital + p.interes AS monto
       FROM credito_pagos p JOIN creditos_bancarios c ON c.id = p.credito_id JOIN cuentas_bancarias b ON b.id = p.banco_id LEFT JOIN tipos_cuenta_banco t ON t.id = b.tipo_cuenta_id
      WHERE p.estado = 'vigente' AND c.estado = 'vigente' AND p.fecha BETWEEN ? AND ?`, [desde, hasta]);
  return [...movs, ...creditos, ...pagos].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.numero.localeCompare(b.numero));
}
// neto = entradas (depósitos, intereses, créditos) − salidas (retiros, cheques, cargos, cuotas). Las transferencias entre cuentas no cambian el total.
export function tablaDinamicaBanco(movs, { dimension = 'cuenta', tipos = Object.keys(TIPOS_DOC_BANCO), busqueda = '' } = {}) {
  if (!DIMENSIONES_BANCO[dimension]) throw new Error('Agrupación no válida.');
  const q = String(busqueda || '').trim().toLowerCase();
  const clave = (m) => (dimension === 'mes' ? m.fecha.slice(0, 7) : dimension === 'documento' ? TIPOS_DOC_BANCO[m.documento] : m[dimension]);
  const vacioG = () => ({ n: 0, ...Object.fromEntries(Object.keys(TIPOS_DOC_BANCO).map((t) => [t, 0])), neto: 0 });
  const grupos = new Map();
  for (const m of movs) {
    if (!tipos.includes(m.documento)) continue;
    if (q && !`${m.cuenta} ${m.numero} ${m.concepto}`.toLowerCase().includes(q)) continue;
    const k = clave(m);
    const g = grupos.get(k) || { clave: k, ...vacioG() };
    g.n++; g[m.documento] = r2(g[m.documento] + m.monto);
    if (m.documento !== 'transferencia') g.neto = r2(g.neto + (ENTRADAS.includes(m.documento) ? m.monto : -m.monto));
    grupos.set(k, g);
  }
  const filas = [...grupos.values()].sort((a, b) => (dimension === 'mes' ? a.clave.localeCompare(b.clave) : b.neto - a.neto));
  const total = vacioG();
  for (const g of filas) for (const k of Object.keys(total)) total[k] = r2(total[k] + g[k]);
  return { filas, total };
}
