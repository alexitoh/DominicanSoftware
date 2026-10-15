// conta-db.js - capa de datos de Contabilidad: catálogo, asientos, bancos, activos, nómina, presupuestos y cierres.
import { consultar, ejecutar, transaccion, numeroDocumento, redondear, usuarioId } from './database.js';
import {
  asientosAutomaticos, construirLibro, validarAsiento, asientoCierre, mapaRoles, finDeMes, r2, valoresActivo, calendarioDepreciacion,
} from './conta-motor.js';
import { calcularNomina, paramsDesde } from './conta-nomina.js';
import { TIPOS_CUENTA, ROLES } from './conta-plan.js';

const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '') && !Number.isNaN(Date.parse(f));
const contador = (clave) => ({ statement: 'UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = ?', values: [clave] });
export const fechaHoy = hoy;

// ---------- Configuración ----------
export async function configConta() {
  const filas = await consultar("SELECT clave, valor FROM config WHERE clave = 'conta_inicio' OR clave LIKE 'nom\\_%' ESCAPE '\\'");
  const cfg = Object.fromEntries(filas.map((r) => [r.clave, r.valor]));
  return { inicio: /^\d{4}-\d{2}-\d{2}$/.test(cfg.conta_inicio || '') ? cfg.conta_inicio : '', nomina: paramsDesde(cfg) };
}
export async function guardarConfigConta(clave, valor) {
  await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [clave, String(valor)]);
}
export async function guardarInicioConta(fecha) {
  if (fecha && !fechaValida(fecha)) throw new Error('La fecha de inicio no es válida.');
  await guardarConfigConta('conta_inicio', fecha || '');
}

// ---------- Períodos cerrados ----------
export async function periodosCerrados() {
  return (await consultar('SELECT periodo FROM periodos_cerrados ORDER BY periodo')).map((r) => r.periodo);
}
export async function exigirPeriodoAbierto(fecha) {
  if (!fechaValida(fecha)) throw new Error('La fecha no es válida.');
  const [c] = await consultar('SELECT 1 AS x FROM periodos_cerrados WHERE periodo = ?', [fecha.slice(0, 7)]);
  if (c) throw new Error(`El período ${fecha.slice(0, 7)} está cerrado. Reábrelo para registrar movimientos en esa fecha.`);
}
export async function cerrarPeriodo(periodo) {
  if (!/^\d{4}-\d{2}$/.test(periodo)) throw new Error('Período no válido (AAAA-MM).');
  if ((await periodosCerrados()).includes(periodo)) throw new Error('Ese período ya está cerrado.');
  await ejecutar('INSERT INTO periodos_cerrados (periodo) VALUES (?)', [periodo]);
}
export async function reabrirPeriodo(periodo) {
  await ejecutar('DELETE FROM periodos_cerrados WHERE periodo = ?', [periodo]);
}

// ---------- Catálogo de cuentas ----------
export const listarCuentas = (soloActivas = false) =>
  consultar(`SELECT * FROM cuentas_contables ${soloActivas ? 'WHERE activo = 1' : ''} ORDER BY codigo`);

function validarCuenta(c) {
  if (!/^[0-9A-Za-z.-]{1,12}$/.test(String(c.codigo || '').trim())) throw new Error('El código debe tener de 1 a 12 letras o números.');
  if (!String(c.nombre || '').trim()) throw new Error('Escribe el nombre de la cuenta.');
  if (!TIPOS_CUENTA[c.tipo]) throw new Error('Elige el tipo de cuenta.');
  if (c.rol && !ROLES[c.rol]) throw new Error('Rol desconocido.');
}

export async function crearCuenta(c) {
  validarCuenta(c);
  const [dup] = await consultar('SELECT 1 AS x FROM cuentas_contables WHERE codigo = ?', [String(c.codigo).trim()]);
  if (dup) throw new Error('Ya existe una cuenta con ese código.');
  if (c.rol) await ejecutar('UPDATE cuentas_contables SET rol = NULL WHERE rol = ?', [c.rol]); // un rol lo lleva una sola cuenta
  await ejecutar('INSERT INTO cuentas_contables (codigo, nombre, tipo, grupo, rol, categoria_gasto) VALUES (?,?,?,?,?,?)',
    [String(c.codigo).trim(), String(c.nombre).trim(), c.tipo, c.grupo ? 1 : 0, c.rol || null, c.categoria_gasto || null]);
}

export async function editarCuenta(id, c) {
  validarCuenta(c);
  const [act] = await consultar('SELECT * FROM cuentas_contables WHERE id = ?', [id]);
  if (!act) throw new Error('La cuenta no existe.');
  const [dup] = await consultar('SELECT 1 AS x FROM cuentas_contables WHERE codigo = ? AND id <> ?', [String(c.codigo).trim(), id]);
  if (dup) throw new Error('Ya existe una cuenta con ese código.');
  const [mov] = await consultar('SELECT 1 AS x FROM asiento_lineas WHERE cuenta_id = ? LIMIT 1', [id]);
  if (mov && act.tipo !== c.tipo) throw new Error('No se puede cambiar el tipo de una cuenta que ya tiene movimientos.');
  if (c.rol && c.rol !== act.rol) await ejecutar('UPDATE cuentas_contables SET rol = NULL WHERE rol = ?', [c.rol]);
  await ejecutar('UPDATE cuentas_contables SET codigo=?, nombre=?, tipo=?, grupo=?, rol=?, categoria_gasto=?, activo=? WHERE id = ?',
    [String(c.codigo).trim(), String(c.nombre).trim(), c.tipo, c.grupo ? 1 : 0, c.rol || null, c.categoria_gasto || null, c.activo === 0 ? 0 : 1, id]);
}

export async function eliminarCuenta(id) {
  const [c] = await consultar('SELECT * FROM cuentas_contables WHERE id = ?', [id]);
  if (!c) throw new Error('La cuenta no existe.');
  if (c.sistema) throw new Error('Las cuentas que trae el sistema no se borran; puedes desactivarlas.');
  const usos = await consultar(`SELECT (SELECT COUNT(*) FROM asiento_lineas WHERE cuenta_id = ?) + (SELECT COUNT(*) FROM cuentas_bancarias WHERE cuenta_id = ?)
    + (SELECT COUNT(*) FROM presupuestos WHERE cuenta_id = ?) + (SELECT COUNT(*) FROM banco_movs WHERE contra_cuenta_id = ?)
    + (SELECT COUNT(*) FROM activos_fijos WHERE contra_cuenta_id = ?) AS n`, [id, id, id, id, id]);
  if (usos[0].n > 0) throw new Error('La cuenta ya se usa en movimientos; desactívala en lugar de borrarla.');
  await ejecutar('DELETE FROM cuentas_contables WHERE id = ?', [id]);
}

// ---------- Centros de costo ----------
export const listarCentros = () => consultar('SELECT * FROM centros_costo ORDER BY activo DESC, nombre');
export async function guardarCentro({ id = null, codigo = '', nombre, activo = 1 }) {
  if (!String(nombre || '').trim()) throw new Error('Escribe el nombre del centro de costo.');
  if (id) await ejecutar('UPDATE centros_costo SET codigo=?, nombre=?, activo=? WHERE id=?', [codigo.trim() || null, nombre.trim(), activo ? 1 : 0, id]);
  else await ejecutar('INSERT INTO centros_costo (codigo, nombre) VALUES (?,?)', [codigo.trim() || null, nombre.trim()]);
}

// ---------- Asientos manuales ----------
export async function crearAsiento({ fecha, concepto, tipo = 'manual', lineas, referencia = null }) {
  await exigirPeriodoAbierto(fecha);
  if (!String(concepto || '').trim()) throw new Error('Escribe el concepto del asiento.');
  const v = validarAsiento(lineas.map((l) => ({ ...l, debe: r2(l.debe || 0), haber: r2(l.haber || 0) })));
  const ids = new Set(v.lineas.map((l) => l.cuenta_id));
  for (const id of ids) {
    const [c] = await consultar('SELECT grupo, activo FROM cuentas_contables WHERE id = ?', [id]);
    if (!c) throw new Error('Una de las cuentas ya no existe.');
    if (c.grupo) throw new Error('No se puede contabilizar en una cuenta título; usa una cuenta de detalle.');
    if (!c.activo) throw new Error('Una de las cuentas está desactivada.');
  }
  const numero = await numeroDocumento('A', 'siguiente_numero_asiento');
  const set = [{
    statement: 'INSERT INTO asientos (numero, fecha, concepto, tipo, referencia, usuario_id) VALUES (?,?,?,?,?,?)',
    values: [numero, fecha, concepto.trim(), tipo, referencia, usuarioId()],
  }];
  for (const l of v.lineas) {
    set.push({
      statement: 'INSERT INTO asiento_lineas (asiento_id, cuenta_id, debe, haber, detalle, centro_id) VALUES ((SELECT id FROM asientos WHERE numero = ?),?,?,?,?,?)',
      values: [numero, l.cuenta_id, l.debe || 0, l.haber || 0, l.detalle || null, l.centro_id || null],
    });
  }
  set.push(contador('siguiente_numero_asiento'));
  await transaccion(set);
  return numero;
}

export async function anularAsiento(id) {
  const [a] = await consultar('SELECT * FROM asientos WHERE id = ?', [id]);
  if (!a) throw new Error('El asiento no existe.');
  if (a.estado === 'anulado') throw new Error('El asiento ya está anulado.');
  await exigirPeriodoAbierto(a.fecha);
  await ejecutar("UPDATE asientos SET estado = 'anulado' WHERE id = ?", [id]);
}

export async function asientosManuales({ incluirAnulados = false } = {}) {
  const as = await consultar(`SELECT * FROM asientos ${incluirAnulados ? '' : "WHERE estado = 'vigente'"} ORDER BY fecha, id`);
  const ls = await consultar('SELECT * FROM asiento_lineas ORDER BY id');
  const porAsiento = new Map();
  for (const l of ls) { if (!porAsiento.has(l.asiento_id)) porAsiento.set(l.asiento_id, []); porAsiento.get(l.asiento_id).push(l); }
  return as.map((a) => ({ ...a, lineas: porAsiento.get(a.id) || [] }));
}

// ---------- Fuentes y libro ----------
export async function cargarFuentes() {
  const q = consultar;
  const ventas = await q(`SELECT COALESCE(v.uid, v.id) AS id, v.numero, v.fecha, v.subtotal, v.total, v.itbis, v.metodo_pago, v.estado, c.nombre AS cliente,
      (SELECT COALESCE(SUM(d.cantidad * d.costo_unitario), 0) FROM venta_detalle d WHERE d.venta_id = v.id) AS costo,
      (SELECT COALESCE(SUM(s.cantidad * s.precio_unitario), 0) FROM venta_servicios s WHERE s.venta_id = v.id) AS servicios
    FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id`);
  const pagos = await q(`SELECT COALESCE(p.uid, p.id) AS id, v.numero AS venta_numero, p.fecha, p.monto, p.metodo FROM pagos p JOIN ventas v ON v.id = p.venta_id`);
  const compras = await q(`SELECT c.numero, c.fecha, c.total, c.itbis, c.estado, p.nombre AS proveedor FROM compras c LEFT JOIN proveedores p ON p.id = c.proveedor_id`);
  const pagosCompra = await q(`SELECT COALESCE(p.uid, p.id) AS id, c.numero AS compra_numero, p.fecha, p.monto, p.metodo FROM pagos_compra p JOIN compras c ON c.id = p.compra_id`);
  const gastos = await q('SELECT COALESCE(uid, id) AS id, fecha, concepto, categoria, monto, itbis, metodo FROM gastos');
  const revs = await q('SELECT * FROM activos_reval ORDER BY fecha, id');
  const activos = (await q('SELECT * FROM activos_fijos')).map((a) => ({ ...a, revals: revs.filter((r) => r.activo_id === a.id) }));
  const corridas = await q('SELECT * FROM nomina_corridas');
  const tots = await q(`SELECT corrida_id, SUM(salario) AS salario, SUM(otros_ingresos) AS otros_ingresos, SUM(afp) AS afp, SUM(sfs) AS sfs, SUM(isr) AS isr,
      SUM(otros_desc) AS otros_desc, SUM(neto) AS neto, SUM(afp_pat) AS afp_pat, SUM(sfs_pat) AS sfs_pat, SUM(srl_pat) AS srl_pat, SUM(infotep) AS infotep
    FROM nomina_detalle GROUP BY corrida_id`);
  const porCorrida = new Map(tots.map((t) => [t.corrida_id, t]));
  const nominas = corridas.filter((c) => porCorrida.has(c.id)).map((c) => ({ ...c, totales: Object.fromEntries(Object.entries(porCorrida.get(c.id)).map(([k, v]) => [k, r2(v || 0)])) }));
  const bancos = await q('SELECT * FROM cuentas_bancarias');
  const cuentas = await listarCuentas();
  const rolBanco = mapaRoles(cuentas).banco?.id ?? null;
  const cuentaDe = new Map(bancos.map((b) => [b.id, b.cuenta_id ?? rolBanco]));
  const movs = await q('SELECT * FROM banco_movs');
  const bancoMovs = movs.map((m) => ({ ...m, cuenta_banco_id: cuentaDe.get(m.banco_id), cuenta_destino_id: cuentaDe.get(m.banco_destino_id) }));
  const cajasCh = new Map((await q('SELECT id, nombre FROM cajas_chicas')).map((c) => [c.id, c.nombre]));
  const cajaChicaMovs = (await q('SELECT * FROM caja_chica_movs')).map((m) => ({ ...m, caja_nombre: cajasCh.get(m.caja_chica_id) || '', cuenta_banco_id: m.banco_id ? cuentaDe.get(m.banco_id) : null }));
  return { ventas, pagos, compras, pagosCompra, gastos, activos, nominas, bancoMovs, cajaChicaMovs, hoy: hoy() };
}

// Libro completo hasta una fecha (por defecto hoy). Respeta la fecha de inicio contable.
export async function libroContable({ hasta = hoy() } = {}) {
  const [cuentas, fuentes, manuales, bancos, cfg] = await Promise.all([listarCuentas(), cargarFuentes(), asientosManuales(), consultar('SELECT * FROM cuentas_bancarias WHERE activo = 1'), configConta()]);
  const predet = bancos.find((b) => b.predeterminada && b.cuenta_id) || bancos.find((b) => b.cuenta_id);
  const overrides = predet ? { banco: cuentas.find((c) => c.id === predet.cuenta_id) } : {};
  const automaticos = asientosAutomaticos(fuentes, { inicio: cfg.inicio, hasta });
  const libro = construirLibro({ manuales: manuales.filter((a) => a.fecha <= hasta && (!cfg.inicio || a.fecha >= cfg.inicio || a.tipo === 'apertura')), automaticos, cuentas, overrides });
  return { ...libro, cuentas, fuentes, bancos, inicio: cfg.inicio };
}

// ---------- Cierre del ejercicio ----------
export async function cerrarEjercicio(anio) {
  anio = parseInt(anio, 10);
  if (!(anio >= 2000 && anio <= 2100)) throw new Error('Año no válido.');
  const [ya] = await consultar("SELECT numero FROM asientos WHERE tipo = 'cierre' AND estado = 'vigente' AND fecha = ?", [`${anio}-12-31`]);
  if (ya) throw new Error(`El ejercicio ${anio} ya tiene su asiento de cierre (${ya.numero}). Anúlalo para generarlo de nuevo.`);
  const { lineas, cuentas } = await libroContable({ hasta: `${anio}-12-31` });
  const a = asientoCierre(cuentas, lineas, anio);
  if (!a.lineas.length) throw new Error('No hay saldos de ingresos, costos o gastos para cerrar.');
  const numero = await crearAsiento({ fecha: a.fecha, concepto: a.concepto, tipo: 'cierre', lineas: a.lineas });
  return { numero, resultado: a.resultado };
}

// ---------- Bancos ----------
export const listarBancos = () => consultar(`SELECT b.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre FROM cuentas_bancarias b LEFT JOIN cuentas_contables c ON c.id = b.cuenta_id ORDER BY b.activo DESC, b.nombre`);

export async function crearBanco({ nombre, banco = '', numero = '' }) {
  if (!String(nombre || '').trim()) throw new Error('Escribe un nombre para la cuenta (por ejemplo, Popular corriente).');
  const bancos = await consultar('SELECT cuenta_id FROM cuentas_bancarias');
  const rolBanco = (await listarCuentas()).find((c) => c.rol === 'banco');
  let cuentaId = null;
  if (rolBanco && !bancos.some((b) => b.cuenta_id === rolBanco.id)) cuentaId = rolBanco.id;
  else {
    // Una cuenta contable propia para cada cuenta bancaria: 1111, 1112…
    const usados = new Set((await listarCuentas()).map((c) => c.codigo));
    let n = 1111;
    while (usados.has(String(n))) n++;
    await ejecutar('INSERT INTO cuentas_contables (codigo, nombre, tipo, grupo) VALUES (?,?,?,0)', [String(n), `Banco: ${nombre.trim()}`, 'activo']);
    cuentaId = (await consultar('SELECT id FROM cuentas_contables WHERE codigo = ?', [String(n)]))[0].id;
  }
  await ejecutar('INSERT INTO cuentas_bancarias (nombre, banco, numero, cuenta_id, predeterminada) VALUES (?,?,?,?,?)',
    [nombre.trim(), banco.trim() || null, numero.trim() || null, cuentaId, bancos.length === 0 ? 1 : 0]);
}

export async function hacerPredeterminado(id) {
  await ejecutar('UPDATE cuentas_bancarias SET predeterminada = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
}

export const TIPOS_MOV_BANCO = { deposito: 'Depósito', retiro: 'Retiro', cheque: 'Cheque emitido', transferencia: 'Transferencia entre cuentas', comision: 'Comisión bancaria', interes: 'Interés ganado' };

export async function registrarMovBanco({ banco_id, fecha, tipo, monto, contra_cuenta_id = null, banco_destino_id = null, referencia = '', detalle = '' }) {
  if (!TIPOS_MOV_BANCO[tipo]) throw new Error('Tipo de movimiento no válido.');
  await exigirPeriodoAbierto(fecha);
  monto = redondear(monto);
  if (!(monto > 0)) throw new Error('El monto debe ser mayor que cero.');
  const [b] = await consultar('SELECT * FROM cuentas_bancarias WHERE id = ?', [banco_id]);
  if (!b) throw new Error('Elige la cuenta bancaria.');
  if (tipo === 'transferencia') {
    if (!banco_destino_id || banco_destino_id === banco_id) throw new Error('Elige la cuenta de destino (distinta a la de origen).');
  }
  if ((tipo === 'cheque') && !String(referencia).trim()) throw new Error('Escribe el número de cheque.');
  const numero = await numeroDocumento('BK', 'siguiente_numero_bancomov');
  await transaccion([{
    statement: 'INSERT INTO banco_movs (numero, banco_id, fecha, tipo, monto, contra_cuenta_id, banco_destino_id, referencia, detalle) VALUES (?,?,?,?,?,?,?,?,?)',
    values: [numero, banco_id, fecha, tipo, monto, contra_cuenta_id, tipo === 'transferencia' ? banco_destino_id : null, referencia.trim() || null, detalle.trim() || TIPOS_MOV_BANCO[tipo]],
  }, contador('siguiente_numero_bancomov')]);
  return numero;
}

export async function anularMovBanco(id) {
  const [m] = await consultar('SELECT * FROM banco_movs WHERE id = ?', [id]);
  if (!m) throw new Error('El movimiento no existe.');
  await exigirPeriodoAbierto(m.fecha);
  await ejecutar("UPDATE banco_movs SET estado = 'anulado' WHERE id = ?", [id]);
}

// Movimientos de la cuenta contable del banco, con su estado de conciliación
export async function movimientosBanco(bancoId, { hasta = hoy() } = {}) {
  const lib = await libroContable({ hasta });
  const b = lib.bancos.find((x) => x.id === bancoId) || (await consultar('SELECT * FROM cuentas_bancarias WHERE id = ?', [bancoId]))[0];
  if (!b) throw new Error('La cuenta bancaria no existe.');
  const cuentaId = b.cuenta_id ?? mapaRoles(lib.cuentas).banco?.id;
  const conc = new Map((await consultar('SELECT ref, fecha FROM conciliaciones WHERE banco_id = ?', [bancoId])).map((r) => [r.ref, r.fecha]));
  const movs = lib.lineas.filter((l) => l.cuenta_id === cuentaId).map((l) => {
    const ref = `${l.ref}#${l.i}`;
    return { ...l, key: ref, entra: l.debe, sale: l.haber, conciliado: conc.has(ref), fechaConc: conc.get(ref) || null };
  });
  const saldoLibros = r2(movs.reduce((s, m) => s + m.entra - m.sale, 0));
  const saldoConciliado = r2(movs.filter((m) => m.conciliado).reduce((s, m) => s + m.entra - m.sale, 0));
  return { banco: b, movimientos: movs, saldoLibros, saldoConciliado };
}

export async function marcarConciliados(bancoId, keys, conciliar = true) {
  for (const k of keys) {
    const [ya] = await consultar('SELECT id FROM conciliaciones WHERE banco_id = ? AND ref = ?', [bancoId, k]);
    if (conciliar && !ya) await ejecutar('INSERT INTO conciliaciones (banco_id, ref) VALUES (?,?)', [bancoId, k]);
    if (!conciliar && ya) await ejecutar('DELETE FROM conciliaciones WHERE banco_id = ? AND ref = ?', [bancoId, k]);
  }
}

// Conciliación: el saldo conciliado debe igualar el saldo del estado de cuenta del banco
export const diferenciaConciliacion = (saldoConciliado, saldoExtracto) => r2(saldoExtracto - saldoConciliado);

// ---------- Conciliación bancaria formal ----------
// Saldo del estado de cuenta + depósitos en tránsito - cheques y retiros en circulación = saldo bancario ajustado,
// que debe ser igual al saldo en libros. Si no cuadra, falta registrar en libros algo que el banco ya hizo
// (comisiones, intereses, notas de débito o crédito, depósitos directos) o hay un error.
// movimientos: los del libro hasta la fecha de corte; marcas: llaves que sí aparecen en el estado de cuenta.
export function calcularConciliacion(movimientos, marcas, saldoExtracto) {
  const enBanco = movimientos.filter((m) => m.conciliado || marcas.has(m.key));
  const transito = movimientos.filter((m) => !m.conciliado && !marcas.has(m.key));
  const depositos = r2(transito.reduce((s, m) => s + m.entra, 0));
  const cheques = r2(transito.reduce((s, m) => s + m.sale, 0));
  const saldoLibros = r2(movimientos.reduce((s, m) => s + m.entra - m.sale, 0));
  const extracto = Number(saldoExtracto);
  const ajustado = r2(extracto + depositos - cheques);
  return {
    saldoExtracto: extracto, depositosTransito: depositos, chequesTransito: cheques, saldoAjustado: ajustado, saldoLibros,
    diferencia: r2(ajustado - saldoLibros), cuadra: Number.isFinite(extracto) && Math.abs(ajustado - saldoLibros) < 0.005,
    nEnBanco: enBanco.length, transito,
  };
}

export async function prepararConciliacion(bancoId, fechaCorte) {
  const info = await movimientosBanco(bancoId, { hasta: fechaCorte });
  return { ...info, movimientos: info.movimientos.filter((m) => m.fecha <= fechaCorte) };
}

export const listarConciliaciones = (bancoId) =>
  consultar('SELECT * FROM conciliaciones_banco WHERE banco_id = ? ORDER BY fecha_corte DESC, id DESC LIMIT 24', [bancoId]);

export async function finalizarConciliacion({ banco_id, fecha_corte, saldo_extracto, marcas = [], notas = '' }) {
  if (!fecha_corte) throw new Error('Elige la fecha de corte del estado de cuenta.');
  if (!Number.isFinite(Number(saldo_extracto)) || saldo_extracto === '') throw new Error('Escribe el saldo final del estado de cuenta.');
  const info = await prepararConciliacion(banco_id, fecha_corte);
  const validas = new Set(info.movimientos.filter((m) => !m.conciliado).map((m) => m.key));
  const elegidas = new Set([...marcas].filter((k) => validas.has(k)));
  const c = calcularConciliacion(info.movimientos, elegidas, saldo_extracto);
  if (!c.cuadra) throw new Error(`La conciliación no cuadra: diferencia de ${c.diferencia}. Registra lo que falta en libros (comisiones, intereses, notas del banco) o revisa lo marcado.`);
  const [ult] = await consultar('SELECT MAX(fecha_corte) AS f FROM conciliaciones_banco WHERE banco_id = ?', [banco_id]);
  if (ult?.f && fecha_corte < ult.f) throw new Error(`Ya hay una conciliación hasta el ${ult.f}. Elige una fecha igual o posterior.`);
  await ejecutar(
    `INSERT INTO conciliaciones_banco (banco_id, fecha_corte, saldo_extracto, saldo_libros, depositos_transito, cheques_transito, saldo_ajustado, n_conciliados, notas)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [banco_id, fecha_corte, r2(c.saldoExtracto), c.saldoLibros, c.depositosTransito, c.chequesTransito, c.saldoAjustado, elegidas.size, notas.trim() || null]);
  const [{ id }] = await consultar('SELECT MAX(id) AS id FROM conciliaciones_banco WHERE banco_id = ?', [banco_id]);
  for (const k of elegidas) await ejecutar('INSERT INTO conciliaciones (banco_id, ref, fecha, conciliacion_id) VALUES (?,?,?,?)', [banco_id, k, fecha_corte, id]);
  return id;
}

// Solo se deshace la última conciliación de la cuenta: sus movimientos vuelven a quedar pendientes
export async function deshacerConciliacion(id) {
  const [c] = await consultar('SELECT * FROM conciliaciones_banco WHERE id = ?', [id]);
  if (!c) throw new Error('La conciliación no existe.');
  const [mas] = await consultar('SELECT id FROM conciliaciones_banco WHERE banco_id = ? AND (fecha_corte > ? OR (fecha_corte = ? AND id > ?))', [c.banco_id, c.fecha_corte, c.fecha_corte, id]);
  if (mas) throw new Error('Solo se puede deshacer la última conciliación de la cuenta.');
  await transaccion([
    { statement: 'DELETE FROM conciliaciones WHERE conciliacion_id = ?', values: [id] },
    { statement: 'DELETE FROM conciliaciones_banco WHERE id = ?', values: [id] },
  ]);
}

// ---------- Caja chica ----------
// Fondo fijo con custodio. Saldo = fondos + reposiciones - desembolsos. Los desembolsos se gastan al momento (contra la cuenta Caja chica);
// la reposición devuelve al fondo lo gastado, desde la Caja general o un banco. Los desembolsos con NCF entran al 606.
export const TIPOS_CAJA_CHICA = { fondo: 'Fondo', desembolso: 'Desembolso', reposicion: 'Reposición' };

async function nuevoNumeroCajaChica() { return numeroDocumento('CC', 'siguiente_numero_cajachica'); }

export async function listarCajasChicas() {
  const cajas = await consultar('SELECT * FROM cajas_chicas ORDER BY activa DESC, nombre COLLATE NOCASE');
  const out = [];
  for (const c of cajas) {
    const [r] = await consultar(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'fondo' THEN monto END), 0) AS fondo,
              COALESCE(SUM(CASE WHEN tipo = 'reposicion' THEN monto END), 0) AS repuesto,
              COALESCE(SUM(CASE WHEN tipo = 'desembolso' THEN monto END), 0) AS gastado,
              COALESCE(SUM(CASE WHEN tipo = 'desembolso' AND reposicion_numero IS NULL THEN monto END), 0) AS por_reponer,
              COALESCE(SUM(CASE WHEN tipo = 'desembolso' AND reposicion_numero IS NULL THEN 1 END), 0) AS n_por_reponer
         FROM caja_chica_movs WHERE caja_chica_id = ? AND estado = 'vigente'`, [c.id]);
    out.push({ ...c, fondo: r2(r.fondo), saldo: r2(r.fondo + r.repuesto - r.gastado), por_reponer: r2(r.por_reponer), n_por_reponer: r.n_por_reponer });
  }
  return out;
}

async function cajaChicaPorId(id) {
  const [c] = (await listarCajasChicas()).filter((x) => x.id === id);
  if (!c) throw new Error('La caja chica no existe.');
  return c;
}

async function movimientoFondo({ caja_chica_id, tipo, fecha, monto, banco_id = null, concepto }) {
  await exigirPeriodoAbierto(fecha);
  const numero = await nuevoNumeroCajaChica();
  await transaccion([{
    statement: 'INSERT INTO caja_chica_movs (numero, caja_chica_id, fecha, tipo, concepto, monto, banco_id) VALUES (?,?,?,?,?,?,?)',
    values: [numero, caja_chica_id, fecha, tipo, concepto, monto, banco_id || null],
  }, contador('siguiente_numero_cajachica')]);
  return numero;
}

// Crear (con su fondo inicial) o editar los datos de una caja chica
export async function guardarCajaChica({ id = null, nombre, custodio = '', notas = '', activa = 1, fondo = 0, banco_id = null, fecha = hoy() }) {
  nombre = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (!nombre) throw new Error('Escribe el nombre de la caja chica.');
  const [dup] = await consultar('SELECT id FROM cajas_chicas WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe una caja chica con ese nombre.');
  if (id) {
    await ejecutar('UPDATE cajas_chicas SET nombre = ?, custodio = ?, notas = ?, activa = ? WHERE id = ?', [nombre, custodio.trim() || null, notas.trim() || null, activa ? 1 : 0, id]);
    return id;
  }
  fondo = redondear(fondo || 0);
  if (!(fondo > 0)) throw new Error('Escribe el monto del fondo (mayor que cero).');
  await exigirPeriodoAbierto(fecha);
  await ejecutar('INSERT INTO cajas_chicas (nombre, custodio, notas, activa) VALUES (?,?,?,1)', [nombre, custodio.trim() || null, notas.trim() || null]);
  const [{ nid }] = await consultar('SELECT id AS nid FROM cajas_chicas WHERE nombre = ?', [nombre]);
  await movimientoFondo({ caja_chica_id: nid, tipo: 'fondo', fecha, monto: fondo, banco_id, concepto: 'Fondo inicial' });
  return nid;
}

export async function aumentarFondo({ caja_chica_id, monto, banco_id = null, fecha = hoy() }) {
  await cajaChicaPorId(caja_chica_id);
  monto = redondear(monto || 0);
  if (!(monto > 0)) throw new Error('Escribe cuánto aumenta el fondo.');
  return movimientoFondo({ caja_chica_id, tipo: 'fondo', fecha, monto, banco_id, concepto: 'Aumento del fondo' });
}

export async function registrarDesembolso({ caja_chica_id, fecha, concepto, categoria = '', beneficiario = '', documento = '', comprobante = '', ncf = '', itbis = 0, monto }) {
  const c = await cajaChicaPorId(caja_chica_id);
  if (!c.activa) throw new Error('Esta caja chica está desactivada.');
  if (!fecha) throw new Error('Elige la fecha.');
  if (!String(concepto || '').trim()) throw new Error('Escribe el concepto del desembolso.');
  monto = redondear(monto || 0); itbis = redondear(itbis || 0);
  if (!(monto > 0)) throw new Error('El monto debe ser mayor que cero.');
  if (itbis < 0 || itbis > monto) throw new Error('El ITBIS no puede ser mayor que el monto.');
  if (monto > c.saldo + 0.004) throw new Error(`El fondo solo tiene ${c.saldo} disponible. Pide una reposición o aumenta el fondo.`);
  await exigirPeriodoAbierto(fecha);
  const numero = await nuevoNumeroCajaChica();
  await transaccion([{
    statement: `INSERT INTO caja_chica_movs (numero, caja_chica_id, fecha, tipo, concepto, categoria, beneficiario, documento, comprobante, ncf, itbis, monto)
                VALUES (?,?,?,'desembolso',?,?,?,?,?,?,?,?)`,
    values: [numero, caja_chica_id, fecha, concepto.trim(), categoria.trim() || 'Otros', beneficiario.trim() || null, documento.trim() || null, comprobante.trim() || null,
      String(ncf || '').trim().toUpperCase() || null, itbis, monto],
  }, contador('siguiente_numero_cajachica')]);
  return numero;
}

export const desembolsosPorReponer = (caja_chica_id) => consultar(
  "SELECT * FROM caja_chica_movs WHERE caja_chica_id = ? AND tipo = 'desembolso' AND estado = 'vigente' AND reposicion_numero IS NULL ORDER BY fecha, id", [caja_chica_id]);

// Reposición: devuelve al fondo lo desembolsado (todos los pendientes o los elegidos) y los marca como repuestos
export async function reponerCajaChica({ caja_chica_id, fecha = hoy(), banco_id = null, ids = null }) {
  await cajaChicaPorId(caja_chica_id);
  let pend = await desembolsosPorReponer(caja_chica_id);
  if (ids) pend = pend.filter((d) => ids.includes(d.id));
  if (!pend.length) throw new Error('No hay desembolsos pendientes de reponer.');
  if (pend.some((d) => d.fecha > fecha)) throw new Error('La fecha de la reposición no puede ser anterior a un desembolso que repone.');
  await exigirPeriodoAbierto(fecha);
  const monto = redondear(pend.reduce((s, d) => s + d.monto, 0));
  const numero = await nuevoNumeroCajaChica();
  await transaccion([
    { statement: "INSERT INTO caja_chica_movs (numero, caja_chica_id, fecha, tipo, concepto, monto, banco_id) VALUES (?,?,?,'reposicion',?,?,?)",
      values: [numero, caja_chica_id, fecha, `Reposición de ${pend.length} ${pend.length === 1 ? 'desembolso' : 'desembolsos'}`, monto, banco_id || null] },
    ...pend.map((d) => ({ statement: 'UPDATE caja_chica_movs SET reposicion_numero = ? WHERE id = ?', values: [numero, d.id] })),
    contador('siguiente_numero_cajachica'),
  ]);
  return { numero, monto, cantidad: pend.length };
}

export async function anularMovCajaChica(id) {
  const [m] = await consultar('SELECT * FROM caja_chica_movs WHERE id = ?', [id]);
  if (!m) throw new Error('El movimiento no existe.');
  if (m.estado !== 'vigente') throw new Error('El movimiento ya está anulado.');
  await exigirPeriodoAbierto(m.fecha);
  const c = await cajaChicaPorId(m.caja_chica_id);
  if (m.tipo === 'desembolso' && m.reposicion_numero) throw new Error(`Ya fue repuesto en ${m.reposicion_numero}. Anula primero esa reposición.`);
  if ((m.tipo === 'fondo' || m.tipo === 'reposicion') && c.saldo - m.monto < -0.004) throw new Error('No se puede anular: el fondo quedaría en negativo.');
  const set = [{ statement: "UPDATE caja_chica_movs SET estado = 'anulado' WHERE id = ?", values: [id] }];
  if (m.tipo === 'reposicion') set.push({ statement: 'UPDATE caja_chica_movs SET reposicion_numero = NULL WHERE reposicion_numero = ? AND caja_chica_id = ?', values: [m.numero, m.caja_chica_id] });
  await transaccion(set);
}

export function movimientosCajaChica(caja_chica_id, { desde = '0000-00-00', hasta = '9999-12-31', todos = false } = {}) {
  return consultar(
    `SELECT * FROM caja_chica_movs WHERE caja_chica_id = ? AND fecha BETWEEN ? AND ? ${todos ? '' : "AND estado = 'vigente'"} ORDER BY fecha DESC, id DESC`,
    [caja_chica_id, desde, hasta]);
}

// ---------- Activos fijos ----------
export const MOTIVOS_RETIRO = { venta: 'Venta', desecho: 'Desecho u obsolescencia', perdida: 'Pérdida o robo', donacion: 'Donación' };
export const CATEGORIAS_ACTIVO = ['Equipos de cómputo', 'Mobiliario y equipos de oficina', 'Vehículos', 'Maquinaria y equipos', 'Herramientas', 'Edificaciones', 'Terrenos', 'Otros'];

export async function listarActivos() {
  const activos = await consultar('SELECT * FROM activos_fijos ORDER BY estado, fecha_adq DESC, id DESC');
  const revs = await consultar('SELECT * FROM activos_reval ORDER BY fecha, id');
  return activos.map((a) => ({ ...a, revals: revs.filter((r) => r.activo_id === a.id) }));
}
export async function crearActivo({ codigo = '', nombre, fecha_adq, costo, residual = 0, vida_meses, contra_cuenta_id = null, notas = '', categoria = '', ubicacion = '', serie = '', tipo_id = null, dep_tipo_id = null }) {
  if (!String(nombre || '').trim()) throw new Error('Escribe el nombre del activo.');
  await exigirPeriodoAbierto(fecha_adq);
  costo = redondear(costo); residual = redondear(residual || 0);
  if (!(costo > 0)) throw new Error('El costo debe ser mayor que cero.');
  if (!(residual >= 0) || residual >= costo) throw new Error('El valor residual debe ser menor que el costo.');
  vida_meses = parseInt(vida_meses, 10);
  if (!(vida_meses >= 1 && vida_meses <= 600)) throw new Error('La vida útil debe estar entre 1 y 600 meses.');
  // El tipo de activo aporta el nombre de categoría, si se deprecia y el tipo de depreciación; ese se copia al activo (cambiar el tipo después no reescribe el pasado)
  let deprecia = 1;
  if (tipo_id) {
    const [t] = await consultar('SELECT * FROM activos_tipos WHERE id = ?', [tipo_id]);
    if (!t) throw new Error('El tipo de activo no existe.');
    deprecia = t.deprecia ? 1 : 0;
    if (!String(categoria).trim()) categoria = t.nombre;
    if (!dep_tipo_id) dep_tipo_id = t.dep_tipo_id;
  }
  let metodo = 'lineal', tasa = null;
  if (dep_tipo_id) {
    const [d] = await consultar('SELECT * FROM dep_tipos WHERE id = ?', [dep_tipo_id]);
    if (!d) throw new Error('El tipo de depreciación no existe.');
    metodo = d.metodo; tasa = d.metodo === 'saldo_decreciente' ? d.tasa_anual : null;
  }
  await ejecutar('INSERT INTO activos_fijos (codigo, nombre, fecha_adq, costo, residual, vida_meses, contra_cuenta_id, notas, categoria, ubicacion, serie, tipo_id, dep_tipo_id, metodo_dep, tasa_dep, deprecia) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [codigo.trim() || null, nombre.trim(), fecha_adq, costo, residual, vida_meses, contra_cuenta_id, notas.trim() || null, categoria.trim() || null, ubicacion.trim() || null, serie.trim() || null,
      tipo_id || null, dep_tipo_id || null, metodo, tasa, deprecia]);
}
// Datos descriptivos: no tocan la contabilidad
export async function actualizarActivo(id, { codigo = '', nombre, categoria = '', ubicacion = '', serie = '', notas = '' }) {
  if (!String(nombre || '').trim()) throw new Error('Escribe el nombre del activo.');
  await ejecutar('UPDATE activos_fijos SET codigo = ?, nombre = ?, categoria = ?, ubicacion = ?, serie = ?, notas = ? WHERE id = ?',
    [codigo.trim() || null, nombre.trim(), categoria.trim() || null, ubicacion.trim() || null, serie.trim() || null, notas.trim() || null, id]);
}
// Retiro: venta (con lo cobrado), desecho, pérdida/robo o donación. La ganancia o pérdida sale contra el valor en libros a esa fecha.
export async function bajaActivo(id, fecha, { motivo = null, precio = 0, cuenta_id = null, nota = '' } = {}) {
  const [a] = (await listarActivos()).filter((x) => x.id === id);
  if (!a) throw new Error('El activo no existe.');
  if (a.estado === 'baja') throw new Error('El activo ya está dado de baja.');
  if (!fecha) throw new Error('Elige la fecha del retiro.');
  if (fecha < a.fecha_adq) throw new Error('La baja no puede ser antes de la compra.');
  if (a.revals.some((r) => r.fecha > fecha)) throw new Error('Hay una revalorización posterior a esa fecha.');
  if (motivo && !MOTIVOS_RETIRO[motivo]) throw new Error('Motivo de retiro no válido.');
  precio = motivo === 'venta' ? redondear(precio || 0) : 0;
  if (!(precio >= 0)) throw new Error('El precio de venta no puede ser negativo.');
  if (motivo === 'venta' && !(precio > 0)) throw new Error('Escribe el precio de venta.');
  await exigirPeriodoAbierto(fecha);
  await ejecutar("UPDATE activos_fijos SET estado = 'baja', fecha_baja = ?, baja_motivo = ?, baja_precio = ?, baja_cuenta_id = ?, baja_nota = ? WHERE id = ?",
    [fecha, motivo, precio || null, precio ? cuenta_id : null, nota.trim() || null, id]);
}
// Revalorización: fija un nuevo valor en libros. La diferencia va a Superávit por revalorización (si sube) o a pérdida (si baja),
// y desde el mes siguiente se deprecia el nuevo valor durante la vida que queda.
export async function revalorizarActivo({ activo_id, fecha, valor_nuevo, nota = '' }) {
  const [a] = (await listarActivos()).filter((x) => x.id === activo_id);
  if (!a) throw new Error('El activo no existe.');
  if (a.estado === 'baja') throw new Error('El activo está dado de baja.');
  if (!fecha) throw new Error('Elige la fecha de la revalorización.');
  if (fecha < a.fecha_adq) throw new Error('La fecha no puede ser antes de la compra.');
  if (a.revals.some((r) => r.fecha > fecha)) throw new Error('Ya hay una revalorización posterior a esa fecha.');
  valor_nuevo = redondear(valor_nuevo);
  if (!(valor_nuevo >= 0) || String(valor_nuevo) === 'NaN') throw new Error('Escribe el nuevo valor en libros.');
  if (valor_nuevo < redondear(a.residual || 0)) throw new Error('El nuevo valor no puede ser menor que el valor residual.');
  await exigirPeriodoAbierto(fecha);
  const v = valoresActivo(a, fecha);
  const ajuste = redondear(valor_nuevo - v.libros);
  if (Math.abs(ajuste) < 0.005) throw new Error('El nuevo valor es igual al valor en libros actual.');
  await ejecutar('INSERT INTO activos_reval (activo_id, fecha, valor_anterior, valor_nuevo, ajuste, nota) VALUES (?,?,?,?,?,?)',
    [activo_id, fecha, v.libros, valor_nuevo, ajuste, nota.trim() || null]);
  return { anterior: v.libros, nuevo: valor_nuevo, ajuste };
}

// ---------- Tipos de depreciación, tipos de activo y tasas de inflación ----------
export const METODOS_DEP = { lineal: 'Línea recta', saldo_decreciente: 'Saldo decreciente' };

export const listarDepTipos = () => consultar('SELECT * FROM dep_tipos ORDER BY activo DESC, nombre COLLATE NOCASE');
export async function guardarDepTipo({ id = null, nombre, metodo = 'lineal', tasa_anual = null, notas = '', activo = 1 }) {
  nombre = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (!nombre) throw new Error('Escribe el nombre del tipo de depreciación.');
  if (!METODOS_DEP[metodo]) throw new Error('Elige el método de depreciación.');
  let tasa = null;
  if (metodo === 'saldo_decreciente') {
    tasa = Number(tasa_anual);
    if (!(tasa > 0 && tasa <= 100)) throw new Error('El porcentaje anual debe estar entre 0 y 100.');
  }
  const [dup] = await consultar('SELECT id FROM dep_tipos WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe un tipo de depreciación con ese nombre.');
  if (id) await ejecutar('UPDATE dep_tipos SET nombre = ?, metodo = ?, tasa_anual = ?, notas = ?, activo = ? WHERE id = ?', [nombre, metodo, tasa, notas.trim() || null, activo ? 1 : 0, id]);
  else await ejecutar('INSERT INTO dep_tipos (nombre, metodo, tasa_anual, notas, activo) VALUES (?,?,?,?,?)', [nombre, metodo, tasa, notas.trim() || null, activo ? 1 : 0]);
}
export async function eliminarDepTipo(id) {
  const [{ n }] = await consultar('SELECT (SELECT COUNT(*) FROM activos_tipos WHERE dep_tipo_id = ?) + (SELECT COUNT(*) FROM activos_fijos WHERE dep_tipo_id = ?) AS n', [id, id]);
  if (n) throw new Error('Está en uso por tipos de activo o activos. Desactívalo en lugar de eliminarlo.');
  await ejecutar('DELETE FROM dep_tipos WHERE id = ?', [id]);
}

export const listarTiposActivo = () => consultar(
  `SELECT t.*, d.nombre AS dep_nombre, (SELECT COUNT(*) FROM activos_fijos a WHERE a.tipo_id = t.id) AS n_activos
     FROM activos_tipos t LEFT JOIN dep_tipos d ON d.id = t.dep_tipo_id ORDER BY t.activo DESC, t.nombre COLLATE NOCASE`);
export async function guardarTipoActivo({ id = null, nombre, vida_meses = 60, residual_pct = 0, deprecia = 1, dep_tipo_id = null, notas = '', activo = 1 }) {
  nombre = String(nombre || '').trim().replace(/\s+/g, ' ');
  if (!nombre) throw new Error('Escribe el nombre del tipo de activo.');
  vida_meses = parseInt(vida_meses, 10);
  if (!(vida_meses >= 1 && vida_meses <= 600)) throw new Error('La vida útil debe estar entre 1 y 600 meses.');
  residual_pct = Number(residual_pct || 0);
  if (!(residual_pct >= 0 && residual_pct < 100)) throw new Error('El valor residual debe ser un porcentaje menor a 100.');
  const [dup] = await consultar('SELECT id FROM activos_tipos WHERE lower(nombre) = lower(?) AND id <> ?', [nombre, id || 0]);
  if (dup) throw new Error('Ya existe un tipo de activo con ese nombre.');
  const campos = [nombre, vida_meses, residual_pct, deprecia ? 1 : 0, dep_tipo_id || null, notas.trim() || null, activo ? 1 : 0];
  if (id) {
    await ejecutar('UPDATE activos_tipos SET nombre = ?, vida_meses = ?, residual_pct = ?, deprecia = ?, dep_tipo_id = ?, notas = ?, activo = ? WHERE id = ?', [...campos, id]);
    await ejecutar('UPDATE activos_fijos SET categoria = ? WHERE tipo_id = ?', [nombre, id]); // la categoría que se ve en listados y reportes sigue el nombre
  } else await ejecutar('INSERT INTO activos_tipos (nombre, vida_meses, residual_pct, deprecia, dep_tipo_id, notas, activo) VALUES (?,?,?,?,?,?,?)', campos);
}
export async function eliminarTipoActivo(id) {
  const [{ n }] = await consultar('SELECT COUNT(*) AS n FROM activos_fijos WHERE tipo_id = ?', [id]);
  if (n) throw new Error('Hay activos de este tipo. Desactívalo en lugar de eliminarlo.');
  await ejecutar('DELETE FROM activos_tipos WHERE id = ?', [id]);
}

export const listarTasasInflacion = () => consultar('SELECT * FROM tasas_inflacion ORDER BY anio DESC');
export async function guardarTasaInflacion({ anio, tasa, fuente = '' }) {
  anio = parseInt(anio, 10);
  if (!(anio >= 1990 && anio <= 2100)) throw new Error('Escribe un año válido.');
  tasa = Number(tasa);
  if (!Number.isFinite(tasa) || tasa <= -100 || tasa > 1000) throw new Error('Escribe la tasa de inflación en porcentaje (por ejemplo 4.5).');
  const [ya] = await consultar('SELECT id FROM tasas_inflacion WHERE anio = ?', [anio]);
  if (ya) await ejecutar('UPDATE tasas_inflacion SET tasa = ?, fuente = ? WHERE id = ?', [tasa, fuente.trim() || null, ya.id]);
  else await ejecutar('INSERT INTO tasas_inflacion (anio, tasa, fuente) VALUES (?,?,?)', [anio, tasa, fuente.trim() || null]);
}
export const eliminarTasaInflacion = (id) => ejecutar('DELETE FROM tasas_inflacion WHERE id = ?', [id]);

// Ajuste por inflación: propone subir el valor en libros de cada activo (que se deprecia y tenga valor) por la tasa del año, al 31 de diciembre.
export async function propuestaInflacion(anio) {
  const [t] = await consultar('SELECT * FROM tasas_inflacion WHERE anio = ?', [anio]);
  if (!t) throw new Error(`No hay tasa de inflación registrada para ${anio}.`);
  const fecha = `${anio}-12-31`;
  const propuesta = [];
  for (const a of await listarActivos()) {
    if (a.estado !== 'activo' || a.fecha_adq > fecha || a.deprecia === 0) continue;
    if (a.revals.some((r) => r.fecha >= fecha)) continue;
    const v = valoresActivo(a, fecha);
    if (!(v.libros > 0)) continue;
    const nuevo = redondear(v.libros * (1 + t.tasa / 100));
    if (Math.abs(nuevo - v.libros) < 0.005) continue;
    propuesta.push({ activo: a, libros: v.libros, nuevo, ajuste: redondear(nuevo - v.libros) });
  }
  return { tasa: t.tasa, fecha, propuesta };
}
export async function aplicarInflacion(anio, activoIds) {
  const { tasa, fecha, propuesta } = await propuestaInflacion(anio);
  const elegidos = propuesta.filter((p) => activoIds.includes(p.activo.id));
  if (!elegidos.length) throw new Error('Elige al menos un activo.');
  for (const p of elegidos) await revalorizarActivo({ activo_id: p.activo.id, fecha, valor_nuevo: p.nuevo, nota: `Ajuste por inflación ${anio} (${tasa}%)` });
  return elegidos.length;
}

// ---------- Empleados y nómina ----------
export const listarEmpleados = () => consultar('SELECT * FROM empleados ORDER BY activo DESC, nombre');
export async function guardarEmpleado({ id = null, nombre, cedula = '', cargo = '', salario, fecha_ingreso = '', centro_id = null, activo = 1 }) {
  if (!String(nombre || '').trim()) throw new Error('Escribe el nombre del empleado.');
  salario = redondear(salario);
  if (!(salario >= 0)) throw new Error('El salario no es válido.');
  const v = [nombre.trim(), cedula.replace(/\D/g, '') || null, cargo.trim() || null, salario, fecha_ingreso || null, centro_id, activo ? 1 : 0];
  if (id) await ejecutar('UPDATE empleados SET nombre=?, cedula=?, cargo=?, salario=?, fecha_ingreso=?, centro_id=?, activo=? WHERE id=?', [...v, id]);
  else await ejecutar('INSERT INTO empleados (nombre, cedula, cargo, salario, fecha_ingreso, centro_id, activo) VALUES (?,?,?,?,?,?,?)', v);
}

// Vista previa de la nómina de un mes: una fila por empleado activo, con los ajustes que se le pasen
export async function prepararNomina(ajustes = {}) {
  const { nomina: p } = await configConta();
  const emps = (await listarEmpleados()).filter((e) => e.activo);
  return emps.map((e) => {
    const aj = ajustes[e.id] || {};
    return { empleado: e, ...calcularNomina(e, p, { otrosIngresos: aj.otros_ingresos, otrosDesc: aj.otros_desc }) };
  });
}

export async function registrarNomina({ periodo, fecha, ajustes = {}, notas = '' }) {
  if (!/^\d{4}-\d{2}$/.test(periodo)) throw new Error('El período debe ser AAAA-MM.');
  fecha = fecha || finDeMes(periodo);
  await exigirPeriodoAbierto(fecha);
  const [ya] = await consultar("SELECT numero FROM nomina_corridas WHERE periodo = ? AND estado = 'vigente'", [periodo]);
  if (ya) throw new Error(`Ya existe la nómina de ${periodo} (${ya.numero}). Anúlala si quieres rehacerla.`);
  const filas = await prepararNomina(ajustes);
  if (!filas.length) throw new Error('No hay empleados activos. Agrégalos primero.');
  const numero = await numeroDocumento('N', 'siguiente_numero_nomina');
  const set = [{ statement: 'INSERT INTO nomina_corridas (numero, periodo, fecha, notas) VALUES (?,?,?,?)', values: [numero, periodo, fecha, notas.trim() || null] }];
  for (const f of filas) {
    set.push({
      statement: `INSERT INTO nomina_detalle (corrida_id, empleado_id, salario, otros_ingresos, afp, sfs, isr, otros_desc, neto, afp_pat, sfs_pat, srl_pat, infotep)
                  VALUES ((SELECT id FROM nomina_corridas WHERE numero = ?),?,?,?,?,?,?,?,?,?,?,?,?)`,
      values: [numero, f.empleado.id, f.salario, f.otros_ingresos, f.afp, f.sfs, f.isr, f.otros_desc, f.neto, f.afp_pat, f.sfs_pat, f.srl_pat, f.infotep],
    });
  }
  set.push(contador('siguiente_numero_nomina'));
  await transaccion(set);
  return numero;
}

export async function pagarNomina(id, { metodo = 'efectivo', fecha = hoy() } = {}) {
  const [c] = await consultar('SELECT * FROM nomina_corridas WHERE id = ?', [id]);
  if (!c || c.estado !== 'vigente') throw new Error('La nómina no existe o está anulada.');
  if (c.pagada) throw new Error('Esta nómina ya está pagada.');
  await exigirPeriodoAbierto(fecha);
  await ejecutar('UPDATE nomina_corridas SET pagada = 1, fecha_pago = ?, metodo_pago = ? WHERE id = ?', [fecha, metodo, id]);
}
export async function anularNomina(id) {
  const [c] = await consultar('SELECT * FROM nomina_corridas WHERE id = ?', [id]);
  if (!c) throw new Error('La nómina no existe.');
  await exigirPeriodoAbierto(c.fecha);
  await ejecutar("UPDATE nomina_corridas SET estado = 'anulada' WHERE id = ?", [id]);
}
export const listarNominas = () => consultar(`SELECT n.*, (SELECT COUNT(*) FROM nomina_detalle d WHERE d.corrida_id = n.id) AS empleados,
  (SELECT COALESCE(SUM(neto), 0) FROM nomina_detalle d WHERE d.corrida_id = n.id) AS neto FROM nomina_corridas n ORDER BY n.periodo DESC, n.id DESC`);
export const detalleNomina = (id) => consultar('SELECT d.*, e.nombre, e.cedula, e.cargo FROM nomina_detalle d JOIN empleados e ON e.id = d.empleado_id WHERE d.corrida_id = ? ORDER BY e.nombre', [id]);

// ---------- Presupuestos ----------
export async function guardarPresupuesto(anio, cuentaId, montos) {
  anio = parseInt(anio, 10);
  if (!(anio >= 2000 && anio <= 2100)) throw new Error('Año no válido.');
  if (!Array.isArray(montos) || montos.length !== 12) throw new Error('Se necesitan 12 montos, uno por mes.');
  for (let mes = 1; mes <= 12; mes++) {
    const m = redondear(montos[mes - 1] || 0);
    if (!(m >= 0)) throw new Error('Los montos no pueden ser negativos.');
    const [ya] = await consultar('SELECT id FROM presupuestos WHERE anio = ? AND cuenta_id = ? AND mes = ?', [anio, cuentaId, mes]);
    if (ya) await ejecutar('UPDATE presupuestos SET monto = ? WHERE id = ?', [m, ya.id]);
    else if (m > 0) await ejecutar('INSERT INTO presupuestos (anio, cuenta_id, mes, monto) VALUES (?,?,?,?)', [anio, cuentaId, mes, m]);
  }
}
export const listarPresupuestos = (anio) => consultar('SELECT * FROM presupuestos WHERE anio = ?', [anio]);

// ---------- Cuentas por cobrar y por pagar (para la antigüedad de saldos) ----------
export async function saldosPorCobrar() {
  return consultar(`SELECT * FROM (
    SELECT v.numero AS documento, COALESCE(c.nombre, 'Cliente general') AS tercero,
           COALESCE(a.vence, date(v.fecha, '+' || COALESCE(c.dias_credito, 30) || ' days')) AS vence,
           v.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos WHERE venta_id = v.id) AS saldo
      FROM ventas v LEFT JOIN clientes c ON c.id = v.cliente_id LEFT JOIN cuentas_cobrar a ON a.venta_id = v.id
     WHERE v.metodo_pago = 'credito' AND v.estado = 'completada') WHERE saldo > 0.005`);
}
export async function saldosPorPagar() {
  return consultar(`SELECT * FROM (
    SELECT c.numero AS documento, COALESCE(p.nombre, 'Sin proveedor') AS tercero,
           COALESCE(a.vence, date(c.fecha, '+' || COALESCE(p.dias_credito, 30) || ' days')) AS vence,
           c.total - (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id) AS saldo
      FROM cuentas_pagar a JOIN compras c ON c.id = a.compra_id LEFT JOIN proveedores p ON p.id = c.proveedor_id
     WHERE c.estado = 'completada') WHERE saldo > 0.005`);
}
