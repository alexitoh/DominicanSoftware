// conta-plan.js - catálogo de cuentas estándar (comercio en República Dominicana) y roles contables.
// Un "rol" es la función de una cuenta para la contabilización automática (ventas, caja, ITBIS…).
// Las cuentas se pueden renombrar o desactivar; el rol hace que el sistema las encuentre aunque cambie el código.

export const TIPOS_CUENTA = {
  activo: { nombre: 'Activo', natural: 'debe', grupo: 1 },
  pasivo: { nombre: 'Pasivo', natural: 'haber', grupo: 2 },
  patrimonio: { nombre: 'Patrimonio', natural: 'haber', grupo: 3 },
  ingreso: { nombre: 'Ingreso', natural: 'haber', grupo: 4 },
  costo: { nombre: 'Costo', natural: 'debe', grupo: 5 },
  gasto: { nombre: 'Gasto', natural: 'debe', grupo: 6 },
};

export const ROLES = {
  caja: 'Caja (efectivo)', caja_chica: 'Caja chica (fondo fijo)', banco: 'Banco (tarjeta, transferencia, cheque)', cxc: 'Cuentas por cobrar', inventario: 'Inventario',
  itbis_adelantado: 'ITBIS pagado (a favor)', activo_fijo: 'Activos fijos (costo)', dep_acumulada: 'Depreciación acumulada',
  cxp: 'Cuentas por pagar', itbis_pagar: 'ITBIS cobrado (por pagar)', tss_pagar: 'TSS por pagar', isr_pagar: 'ISR retenido por pagar',
  sueldos_pagar: 'Sueldos por pagar', otros_pagar: 'Otras retenciones por pagar', anticipos_clientes: 'Anticipos de clientes', anticipos_proveedores: 'Anticipos a proveedores',
  capital: 'Capital social', superavit_reval: 'Superávit por revalorización', utilidades_acum: 'Utilidades acumuladas', utilidad_ejercicio: 'Utilidad del ejercicio',
  ventas: 'Ventas de mercancía', servicios: 'Ingresos por servicios', desc_ventas: 'Descuentos y devoluciones en ventas', otros_ingresos: 'Otros ingresos', cargos_clientes: 'Cargos y recargos a clientes', ganancia_cambiaria: 'Ganancia por diferencia cambiaria',
  costo_ventas: 'Costo de ventas', desc_compras: 'Descuentos y devoluciones en compras', cargos_proveedores: 'Cargos y recargos de proveedores', gasto_sueldos: 'Sueldos y salarios', gasto_tss: 'Aportes patronales',
  gasto_depreciacion: 'Gasto de depreciación', gasto_bancario: 'Comisiones bancarias', perdida_cambiaria: 'Pérdida por diferencia cambiaria', gasto_otros: 'Otros gastos', prestamos_bancarios: 'Préstamos bancarios (créditos)', gasto_intereses: 'Intereses de préstamos',
};

// [código, nombre, tipo, es título (no admite movimientos), rol, categoría de gasto de Caja]
export const PLAN_BASE = [
  ['1', 'ACTIVOS', 'activo', 1],
  ['11', 'Activos corrientes', 'activo', 1],
  ['1101', 'Caja general', 'activo', 0, 'caja'],
  ['1102', 'Caja chica', 'activo', 0, 'caja_chica'],
  ['1110', 'Bancos', 'activo', 0, 'banco'],
  ['1201', 'Cuentas por cobrar clientes', 'activo', 0, 'cxc'],
  ['1210', 'ITBIS pagado por adelantado', 'activo', 0, 'itbis_adelantado'],
  ['1220', 'Anticipos a proveedores', 'activo', 0, 'anticipos_proveedores'],
  ['1301', 'Inventario de mercancía', 'activo', 0, 'inventario'],
  ['15', 'Activos no corrientes', 'activo', 1],
  ['1501', 'Mobiliario y equipos', 'activo', 0, 'activo_fijo'],
  ['1599', 'Depreciación acumulada', 'activo', 0, 'dep_acumulada'],
  ['2', 'PASIVOS', 'pasivo', 1],
  ['21', 'Pasivos corrientes', 'pasivo', 1],
  ['2101', 'Cuentas por pagar proveedores', 'pasivo', 0, 'cxp'],
  ['2110', 'ITBIS por pagar', 'pasivo', 0, 'itbis_pagar'],
  ['2150', 'Anticipos de clientes', 'pasivo', 0, 'anticipos_clientes'],
  ['2120', 'TSS por pagar', 'pasivo', 0, 'tss_pagar'],
  ['2121', 'ISR retenido por pagar', 'pasivo', 0, 'isr_pagar'],
  ['2130', 'Sueldos por pagar', 'pasivo', 0, 'sueldos_pagar'],
  ['2140', 'Otras retenciones por pagar', 'pasivo', 0, 'otros_pagar'],
  ['25', 'Pasivos no corrientes', 'pasivo', 1],
  ['2501', 'Préstamos bancarios a largo plazo', 'pasivo', 0],
  ['2502', 'Créditos bancarios por pagar', 'pasivo', 0, 'prestamos_bancarios'],
  ['3', 'PATRIMONIO', 'patrimonio', 1],
  ['3101', 'Capital social', 'patrimonio', 0, 'capital'],
  ['3201', 'Utilidades acumuladas', 'patrimonio', 0, 'utilidades_acum'],
  ['3301', 'Utilidad del ejercicio', 'patrimonio', 0, 'utilidad_ejercicio'],
  ['3401', 'Retiros del propietario', 'patrimonio', 0],
  ['3501', 'Superávit por revalorización de activos', 'patrimonio', 0, 'superavit_reval'],
  ['4', 'INGRESOS', 'ingreso', 1],
  ['4101', 'Ventas de mercancía', 'ingreso', 0, 'ventas'],
  ['4102', 'Ingresos por servicios', 'ingreso', 0, 'servicios'],
  ['4103', 'Descuentos y devoluciones en ventas', 'ingreso', 0, 'desc_ventas'],
  ['4201', 'Otros ingresos', 'ingreso', 0, 'otros_ingresos'],
  ['4202', 'Cargos y recargos a clientes', 'ingreso', 0, 'cargos_clientes'],
  ['4203', 'Ganancia por diferencia cambiaria', 'ingreso', 0, 'ganancia_cambiaria'],
  ['5', 'COSTOS', 'costo', 1],
  ['5101', 'Costo de ventas', 'costo', 0, 'costo_ventas'],
  ['5102', 'Descuentos y devoluciones en compras', 'costo', 0, 'desc_compras'],
  ['6', 'GASTOS', 'gasto', 1],
  ['6101', 'Sueldos y salarios', 'gasto', 0, 'gasto_sueldos', 'Sueldos'],
  ['6102', 'Aportes patronales (TSS, INFOTEP)', 'gasto', 0, 'gasto_tss'],
  ['6201', 'Alquiler', 'gasto', 0, null, 'Alquiler'],
  ['6202', 'Luz y agua', 'gasto', 0, null, 'Luz y agua'],
  ['6203', 'Internet y teléfono', 'gasto', 0, null, 'Internet y teléfono'],
  ['6204', 'Transporte', 'gasto', 0, null, 'Transporte'],
  ['6205', 'Mantenimiento y reparaciones', 'gasto', 0, null, 'Mantenimiento'],
  ['6206', 'Depreciación', 'gasto', 0, 'gasto_depreciacion'],
  ['6207', 'Comisiones bancarias', 'gasto', 0, 'gasto_bancario'],
  ['6208', 'Pérdida por diferencia cambiaria', 'gasto', 0, 'perdida_cambiaria'],
  ['6209', 'Cargos y recargos de proveedores', 'gasto', 0, 'cargos_proveedores'],
  ['6215', 'Intereses de préstamos', 'gasto', 0, 'gasto_intereses'],
  ['6299', 'Otros gastos', 'gasto', 0, 'gasto_otros', 'Otros'],
];

export const nivelDe = (codigo) => (codigo.length <= 1 ? 0 : codigo.length === 2 ? 1 : 2);

const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
// SQL de las cuentas base (se pega en schema.sql)
export function sqlPlanBase() {
  const filas = PLAN_BASE.map(([c, n, t, g, r, cat]) => `  (${q(c)}, ${q(n)}, ${q(t)}, ${g}, ${q(r)}, ${q(cat)}, 1)`);
  return `INSERT OR IGNORE INTO cuentas_contables (codigo, nombre, tipo, grupo, rol, categoria_gasto, sistema) VALUES\n${filas.join(',\n')};`;
}
