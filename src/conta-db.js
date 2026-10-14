// conta-db.js - capa de datos de Contabilidad: catálogo, asientos, bancos, activos, nómina, presupuestos y cierres.
import { consultar, ejecutar, transaccion, numeroDocumento, redondear, usuarioId } from './database.js';
import {
  asientosAutomaticos, construirLibro, validarAsiento, asientoCierre, mapaRoles, finDeMes, r2,
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
  const activos = await q('SELECT * FROM activos_fijos');
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
  return { ventas, pagos, compras, pagosCompra, gastos, activos, nominas, bancoMovs, hoy: hoy() };
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

// ---------- Activos fijos ----------
export const listarActivos = () => consultar('SELECT * FROM activos_fijos ORDER BY estado, fecha_adq DESC, id DESC');
export async function crearActivo({ codigo = '', nombre, fecha_adq, costo, residual = 0, vida_meses, contra_cuenta_id = null, notas = '' }) {
  if (!String(nombre || '').trim()) throw new Error('Escribe el nombre del activo.');
  await exigirPeriodoAbierto(fecha_adq);
  costo = redondear(costo); residual = redondear(residual || 0);
  if (!(costo > 0)) throw new Error('El costo debe ser mayor que cero.');
  if (!(residual >= 0) || residual >= costo) throw new Error('El valor residual debe ser menor que el costo.');
  vida_meses = parseInt(vida_meses, 10);
  if (!(vida_meses >= 1 && vida_meses <= 600)) throw new Error('La vida útil debe estar entre 1 y 600 meses.');
  await ejecutar('INSERT INTO activos_fijos (codigo, nombre, fecha_adq, costo, residual, vida_meses, contra_cuenta_id, notas) VALUES (?,?,?,?,?,?,?,?)',
    [codigo.trim() || null, nombre.trim(), fecha_adq, costo, residual, vida_meses, contra_cuenta_id, notas.trim() || null]);
}
export async function bajaActivo(id, fecha) {
  const [a] = await consultar('SELECT * FROM activos_fijos WHERE id = ?', [id]);
  if (!a) throw new Error('El activo no existe.');
  if (a.estado === 'baja') throw new Error('El activo ya está dado de baja.');
  if (fecha < a.fecha_adq) throw new Error('La baja no puede ser antes de la compra.');
  await exigirPeriodoAbierto(fecha);
  await ejecutar("UPDATE activos_fijos SET estado = 'baja', fecha_baja = ? WHERE id = ?", [fecha, id]);
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
