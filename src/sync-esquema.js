// sync-esquema.js - qué tablas se sincronizan y cómo se marcan los cambios.
// Solo datos y generadores de SQL (sin dependencias) para usarlos en la app y en las pruebas.

// Todas las tablas sincronizadas, de padres a hijos. El orden importa: se sube y se aplica en este orden.
// cols: columnas que viajan tal cual. refs: llaves foráneas, que viajan como el "uid" del registro padre.
// unicos: columnas con restricción UNIQUE (si chocan al recibir, se le agrega un sufijo).
export const TABLAS = [
  { t: 'categorias', cols: ['nombre'], unicos: ['nombre'] },
  { t: 'tipos_cliente', cols: ['nombre', 'descuento', 'limite_credito', 'notas', 'activo'], unicos: ['nombre'] },
  { t: 'condiciones_pago', cols: ['nombre', 'dias', 'activo'], unicos: ['nombre'] },
  { t: 'clientes', refs: [{ col: 'tipo_cliente_id', tabla: 'tipos_cliente' }, { col: 'condicion_pago_id', tabla: 'condiciones_pago' }], cols: ['nombre', 'telefono', 'direccion', 'notas', 'condicion', 'dias_credito', 'tipo_doc', 'documento', 'limite_credito', 'tipo_comprobante', 'regimen_dgii', 'creado'] },
  { t: 'cliente_direcciones', cols: ['etiqueta', 'direccion', 'referencia'], refs: [{ col: 'cliente_id', tabla: 'clientes' }] },
  { t: 'cliente_contactos', cols: ['nombre', 'cargo', 'telefono', 'correo'], refs: [{ col: 'cliente_id', tabla: 'clientes' }] },
  { t: 'recibos', cols: ['numero', 'fecha', 'total', 'estado', 'notas'], refs: [{ col: 'cliente_id', tabla: 'clientes' }, { col: 'usuario_id', tabla: 'usuarios' }], unicos: ['numero'] },
  { t: 'recibo_metodos', cols: ['metodo', 'monto', 'referencia'], refs: [{ col: 'recibo_id', tabla: 'recibos' }] },
  { t: 'tipos_proveedor', cols: ['nombre', 'notas', 'activo'], unicos: ['nombre'] },
  { t: 'proveedores', refs: [{ col: 'tipo_proveedor_id', tabla: 'tipos_proveedor' }], cols: ['nombre', 'telefono', 'direccion', 'notas', 'condicion', 'dias_credito', 'tipo_doc', 'documento', 'creado'] },
  {
    t: 'productos',
    cols: ['codigo', 'nombre', 'marca', 'costo', 'precio', 'margen', 'stock_minimo', 'ubicacion', 'foto', 'activo', 'itbis_exento', 'creado'],
    refs: [{ col: 'categoria_id', tabla: 'categorias' }],
    unicos: ['codigo'],
    // El stock NO viaja: se calcula sumando los movimientos de inventario de todos los dispositivos
    disparar: ['codigo', 'nombre', 'categoria_id', 'marca', 'costo', 'precio', 'margen', 'stock_minimo', 'ubicacion', 'foto', 'activo', 'itbis_exento'],
  },
  {
    t: 'ventas',
    cols: ['numero', 'fecha', 'subtotal', 'descuento', 'total', 'metodo_pago', 'estado', 'notas', 'itbis', 'ncf', 'cliente_nombre'],
    refs: [{ col: 'cliente_id', tabla: 'clientes' }, { col: 'usuario_id', tabla: 'usuarios' }, { col: 'cajero_id', tabla: 'usuarios' }],
    unicos: ['numero'],
  },
  {
    t: 'venta_detalle',
    cols: ['cantidad', 'precio_unitario', 'costo_unitario', 'descuento'],
    refs: [{ col: 'venta_id', tabla: 'ventas' }, { col: 'producto_id', tabla: 'productos' }],
  },
  { t: 'venta_servicios', cols: ['descripcion', 'cantidad', 'precio_unitario'], refs: [{ col: 'venta_id', tabla: 'ventas' }] },
  { t: 'cxc_conceptos', cols: ['nombre', 'tipo', 'porcentaje', 'notas', 'activo'], unicos: ['nombre'] },
  {
    t: 'cxc_docs', cols: ['numero', 'tipo', 'fecha', 'monto', 'itbis', 'ncf', 'metodo', 'referencia', 'notas', 'estado', 'anulado_motivo'],
    refs: [{ col: 'cliente_id', tabla: 'clientes' }, { col: 'venta_id', tabla: 'ventas' }, { col: 'concepto_id', tabla: 'cxc_conceptos' }, { col: 'usuario_id', tabla: 'usuarios' }], unicos: ['numero'],
  },
  { t: 'pagos', cols: ['monto', 'metodo', 'nota', 'fecha'], refs: [{ col: 'venta_id', tabla: 'ventas' }, { col: 'recibo_id', tabla: 'recibos' }, { col: 'documento_id', tabla: 'cxc_docs' }] },
  {
    t: 'ventas_pendientes',
    cols: ['numero', 'fecha', 'cliente_nombre', 'tipo_ncf', 'descuento', 'total', 'notas', 'estado'],
    refs: [{ col: 'cliente_id', tabla: 'clientes' }, { col: 'usuario_id', tabla: 'usuarios' }, { col: 'venta_id', tabla: 'ventas' }],
  },
  {
    t: 'ventas_pendientes_detalle',
    cols: ['cantidad', 'precio_unitario', 'descuento', 'garantia_meses', 'serie'],
    refs: [{ col: 'pendiente_id', tabla: 'ventas_pendientes' }, { col: 'producto_id', tabla: 'productos' }],
  },
  { t: 'ventas_pendientes_servicios', cols: ['descripcion', 'cantidad', 'precio_unitario'], refs: [{ col: 'pendiente_id', tabla: 'ventas_pendientes' }] },
  { t: 'cuentas_cobrar', cols: ['vence'], refs: [{ col: 'venta_id', tabla: 'ventas' }] },
  {
    t: 'garantias',
    cols: ['serie', 'meses', 'inicio', 'vence', 'estado'],
    refs: [{ col: 'venta_id', tabla: 'ventas' }, { col: 'producto_id', tabla: 'productos' }, { col: 'cliente_id', tabla: 'clientes' }],
  },
  { t: 'garantia_reclamos', cols: ['fecha', 'problema', 'resolucion', 'estado'], refs: [{ col: 'garantia_id', tabla: 'garantias' }] },
  {
    t: 'compras',
    cols: ['numero', 'fecha', 'referencia', 'total', 'estado', 'notas', 'itbis', 'ncf'],
    refs: [{ col: 'proveedor_id', tabla: 'proveedores' }, { col: 'usuario_id', tabla: 'usuarios' }],
    unicos: ['numero'],
  },
  {
    t: 'compra_detalle',
    cols: ['cantidad', 'costo_unitario'],
    refs: [{ col: 'compra_id', tabla: 'compras' }, { col: 'producto_id', tabla: 'productos' }],
  },
  { t: 'cuentas_pagar', cols: ['vence'], refs: [{ col: 'compra_id', tabla: 'compras' }] },
  {
    t: 'cxp_docs', cols: ['numero', 'tipo', 'fecha', 'concepto', 'monto', 'itbis', 'ncf', 'metodo', 'referencia', 'notas', 'estado', 'anulado_motivo'],
    refs: [{ col: 'proveedor_id', tabla: 'proveedores' }, { col: 'compra_id', tabla: 'compras' }, { col: 'usuario_id', tabla: 'usuarios' }], unicos: ['numero'],
  },
  { t: 'pagos_compra', cols: ['monto', 'metodo', 'nota', 'fecha'], refs: [{ col: 'compra_id', tabla: 'compras' }, { col: 'documento_id', tabla: 'cxp_docs' }] },
  { t: 'solicitudes_compra', cols: ['numero', 'fecha', 'solicitante', 'estado', 'notas'], refs: [{ col: 'usuario_id', tabla: 'usuarios' }], unicos: ['numero'] },
  { t: 'solicitud_detalle', cols: ['cantidad', 'nota'], refs: [{ col: 'solicitud_id', tabla: 'solicitudes_compra' }, { col: 'producto_id', tabla: 'productos' }] },
  { t: 'requisiciones', cols: ['numero', 'fecha', 'estado', 'notas'], refs: [{ col: 'solicitud_id', tabla: 'solicitudes_compra' }, { col: 'usuario_id', tabla: 'usuarios' }], unicos: ['numero'] },
  { t: 'requisicion_detalle', cols: ['cantidad'], refs: [{ col: 'requisicion_id', tabla: 'requisiciones' }, { col: 'producto_id', tabla: 'productos' }] },
  { t: 'requisicion_cot', cols: ['costo_unitario'], refs: [{ col: 'requisicion_id', tabla: 'requisiciones' }, { col: 'proveedor_id', tabla: 'proveedores' }, { col: 'detalle_id', tabla: 'requisicion_detalle' }] },
  { t: 'ordenes_compra', cols: ['numero', 'fecha', 'estado', 'entrega', 'notas'], refs: [{ col: 'proveedor_id', tabla: 'proveedores' }, { col: 'requisicion_id', tabla: 'requisiciones' }, { col: 'compra_id', tabla: 'compras' }, { col: 'usuario_id', tabla: 'usuarios' }], unicos: ['numero'] },
  { t: 'orden_detalle', cols: ['cantidad', 'costo_unitario'], refs: [{ col: 'orden_id', tabla: 'ordenes_compra' }, { col: 'producto_id', tabla: 'productos' }] },
  { t: 'caja', cols: ['fecha_apertura', 'efectivo_inicial', 'estado', 'fecha_cierre', 'efectivo_esperado', 'efectivo_contado', 'diferencia', 'notas', 'conteo_cajero', 'conteo_fecha', 'conteo_nota', 'conteo_por'] },
  { t: 'tipos_pago', cols: ['nombre', 'metodo', 'requiere_ref', 'activo'], refs: [{ col: 'banco_id', tabla: 'cuentas_bancarias' }, { col: 'cuenta_id', tabla: 'cuentas_contables' }], unicos: ['nombre'] },
  {
    t: 'conceptos_conta', cols: ['nombre', 'tipo', 'categoria_gasto', 'notas', 'activo'],
    refs: [{ col: 'cuenta_debe_id', tabla: 'cuentas_contables' }, { col: 'cuenta_haber_id', tabla: 'cuentas_contables' }], unicos: ['nombre'],
  },
  { t: 'monedas', cols: ['codigo', 'nombre', 'simbolo', 'activa'], unicos: ['codigo'] },
  { t: 'tasas_cambio', cols: ['clave', 'fecha', 'tasa'], refs: [{ col: 'moneda_id', tabla: 'monedas' }], unicos: ['clave'] },
  { t: 'partidas_ext', cols: ['descripcion', 'monto_ext', 'tasa_libro', 'fecha', 'notas', 'activa'], refs: [{ col: 'moneda_id', tabla: 'monedas' }, { col: 'cuenta_id', tabla: 'cuentas_contables' }] },
  { t: 'dif_cambiaria', cols: ['fecha', 'tasa_anterior', 'tasa_nueva', 'monto', 'asiento_numero'], refs: [{ col: 'partida_id', tabla: 'partidas_ext' }] },
  { t: 'declaraciones', cols: ['clave', 'periodo', 'formulario', 'fecha_presentada', 'referencia', 'notas'], unicos: ['clave'] },
  {
    t: 'gastos', cols: ['fecha', 'concepto', 'categoria', 'monto', 'metodo', 'nota', 'itbis', 'ncf', 'documento', 'beneficiario', 'estado', 'origen'],
    refs: [{ col: 'caja_id', tabla: 'caja' }, { col: 'tipo_pago_id', tabla: 'tipos_pago' }],
  },
  {
    t: 'cotizaciones',
    cols: ['numero', 'fecha', 'cliente_nombre', 'subtotal', 'descuento', 'total', 'validez_dias', 'estado', 'notas'],
    refs: [{ col: 'cliente_id', tabla: 'clientes' }, { col: 'venta_id', tabla: 'ventas' }, { col: 'usuario_id', tabla: 'usuarios' }],
    unicos: ['numero'],
  },
  {
    t: 'cotizacion_detalle',
    cols: ['descripcion', 'cantidad', 'precio_unitario'],
    refs: [{ col: 'cotizacion_id', tabla: 'cotizaciones' }, { col: 'producto_id', tabla: 'productos' }],
  },
  {
    // Solo se agregan: el movimiento nunca cambia. La referencia apunta a una venta o a una compra según el motivo.
    t: 'movimientos_inventario',
    cols: ['tipo', 'cantidad', 'motivo', 'fecha'],
    refs: [
      { col: 'producto_id', tabla: 'productos' },
      { col: 'referencia_id', tabla: 'ventas', clave: 'referencia_venta', cuando: "motivo IN ('venta','anulacion')" },
      { col: 'referencia_id', tabla: 'compras', clave: 'referencia_compra', cuando: "motivo IN ('compra','anulacion de compra')" },
    ],
    inmutable: true,
  },
  // ---- Contabilidad ----
  { t: 'centros_costo', cols: ['codigo', 'nombre', 'activo'] },
  { t: 'cuentas_contables', cols: ['codigo', 'nombre', 'tipo', 'grupo', 'rol', 'categoria_gasto', 'sistema', 'activo'], unicos: ['codigo'] },
  { t: 'asientos', cols: ['numero', 'fecha', 'concepto', 'tipo', 'estado', 'referencia', 'creado', 'anulado_fecha', 'anulado_por', 'anulado_motivo'], refs: [{ col: 'usuario_id', tabla: 'usuarios' }], unicos: ['numero'] },
  {
    t: 'asiento_lineas', cols: ['debe', 'haber', 'detalle'],
    refs: [{ col: 'asiento_id', tabla: 'asientos' }, { col: 'cuenta_id', tabla: 'cuentas_contables' }, { col: 'centro_id', tabla: 'centros_costo' }],
  },
  { t: 'cuentas_bancarias', cols: ['nombre', 'banco', 'numero', 'predeterminada', 'activo'], refs: [{ col: 'cuenta_id', tabla: 'cuentas_contables' }] },
  {
    t: 'banco_movs', cols: ['numero', 'fecha', 'tipo', 'monto', 'referencia', 'detalle', 'estado'],
    refs: [{ col: 'banco_id', tabla: 'cuentas_bancarias' }, { col: 'contra_cuenta_id', tabla: 'cuentas_contables' }, { col: 'banco_destino_id', tabla: 'cuentas_bancarias' }],
    unicos: ['numero'],
  },
  {
    t: 'conciliaciones_banco', cols: ['fecha_corte', 'saldo_extracto', 'saldo_libros', 'depositos_transito', 'cheques_transito', 'saldo_ajustado', 'n_conciliados', 'notas', 'por', 'creado'],
    refs: [{ col: 'banco_id', tabla: 'cuentas_bancarias' }],
  },
  { t: 'conciliaciones', cols: ['ref', 'fecha'], refs: [{ col: 'banco_id', tabla: 'cuentas_bancarias' }, { col: 'conciliacion_id', tabla: 'conciliaciones_banco' }] },
  { t: 'cajas_chicas', cols: ['nombre', 'custodio', 'notas', 'activa'], unicos: ['nombre'] },
  {
    t: 'caja_chica_movs', cols: ['numero', 'fecha', 'tipo', 'concepto', 'categoria', 'beneficiario', 'documento', 'comprobante', 'ncf', 'itbis', 'monto', 'reposicion_numero', 'estado'],
    refs: [{ col: 'caja_chica_id', tabla: 'cajas_chicas' }, { col: 'banco_id', tabla: 'cuentas_bancarias' }], unicos: ['numero'],
  },
  { t: 'dep_tipos', cols: ['nombre', 'metodo', 'tasa_anual', 'notas', 'activo'], unicos: ['nombre'] },
  { t: 'activos_tipos', cols: ['nombre', 'vida_meses', 'residual_pct', 'deprecia', 'notas', 'activo'], refs: [{ col: 'dep_tipo_id', tabla: 'dep_tipos' }], unicos: ['nombre'] },
  { t: 'tasas_inflacion', cols: ['anio', 'tasa', 'fuente'], unicos: ['anio'] },
  {
    t: 'activos_fijos', cols: ['codigo', 'nombre', 'fecha_adq', 'costo', 'residual', 'vida_meses', 'estado', 'fecha_baja', 'notas', 'categoria', 'ubicacion', 'serie', 'baja_motivo', 'baja_precio', 'baja_nota', 'metodo_dep', 'tasa_dep', 'deprecia'],
    refs: [{ col: 'contra_cuenta_id', tabla: 'cuentas_contables' }, { col: 'baja_cuenta_id', tabla: 'cuentas_contables' }, { col: 'tipo_id', tabla: 'activos_tipos' }, { col: 'dep_tipo_id', tabla: 'dep_tipos' }],
  },
  { t: 'activos_reval', cols: ['fecha', 'valor_anterior', 'valor_nuevo', 'ajuste', 'nota'], refs: [{ col: 'activo_id', tabla: 'activos_fijos' }] },
  { t: 'empleados', cols: ['nombre', 'cedula', 'cargo', 'salario', 'fecha_ingreso', 'activo'], refs: [{ col: 'centro_id', tabla: 'centros_costo' }] },
  { t: 'nomina_corridas', cols: ['numero', 'periodo', 'fecha', 'estado', 'pagada', 'fecha_pago', 'metodo_pago', 'notas'], unicos: ['numero'] },
  {
    t: 'nomina_detalle',
    cols: ['salario', 'otros_ingresos', 'afp', 'sfs', 'isr', 'otros_desc', 'neto', 'afp_pat', 'sfs_pat', 'srl_pat', 'infotep'],
    refs: [{ col: 'corrida_id', tabla: 'nomina_corridas' }, { col: 'empleado_id', tabla: 'empleados' }],
  },
  { t: 'presupuestos', cols: ['anio', 'mes', 'monto'], refs: [{ col: 'cuenta_id', tabla: 'cuentas_contables' }] },
  { t: 'periodos_cerrados', cols: ['periodo'] },
  { t: 'ncf_anulados', cols: ['fecha', 'ncf', 'tipo', 'motivo', 'origen'], refs: [{ col: 'usuario_id', tabla: 'usuarios' }], unicos: ['ncf'] },
  { t: 'bitacora', cols: ['fecha', 'usuario', 'accion', 'detalle'], refs: [{ col: 'usuario_id', tabla: 'usuarios' }], inmutable: true },
  { t: 'config', cols: ['valor'], clave: 'clave' },
];

// Ajustes del negocio que se comparten entre dispositivos (los contadores de numeración y el idioma son de cada uno)
export const CONFIG_COMPARTIDA = ['cpb_reglas', 'negocio_nombre', 'negocio_telefono', 'negocio_direccion', 'negocio_logo', 'moneda', 'margen_defecto', 'idioma_factura', 'negocio_rnc', 'negocio_categoria', 'itbis_modo', 'itbis_tasa',
  'conta_inicio', 'nom_afp_emp', 'nom_sfs_emp', 'nom_afp_pat', 'nom_sfs_pat', 'nom_srl_pat', 'nom_infotep', 'nom_tope_afp', 'nom_tope_sfs', 'nom_tope_srl', 'nom_isr_exento'];

export const CATEGORIAS_BASE = ['Bajos / Subwoofers', 'Bocinas', 'Amplificadores', 'Pantallas / Radios', 'Cables y accesorios', 'Otros'];

export const porNombre = Object.fromEntries(TABLAS.map((d) => [d.t, d]));
export const nombresTablas = TABLAS.map((d) => d.t);

const AHORA = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
export const SQL_AHORA = AHORA;
const lista = (xs) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(',');
const APLICANDO = '(SELECT aplicando FROM sync_ctl WHERE id = 1) = 0';
const ALEATORIO = 'lower(hex(randomblob(12)))';

// Expresión SQL del uid de un registro nuevo. prefijo: 'NEW.' en triggers, '' en actualizaciones masivas.
function exprUid(d, prefijo) {
  if (d.t === 'config') return `${prefijo}clave`;
  // En actualizaciones masivas (prefijo vacío) la fila se cita por el nombre de la tabla; la subconsulta usa el alias x
  const f = prefijo || `${d.t}.`;
  if (d.t === 'categorias') {
    // Las categorías que trae la app tienen uid fijo para que todos los dispositivos coincidan
    return `CASE WHEN ${f}nombre IN (${lista(CATEGORIAS_BASE)})
                  AND NOT EXISTS (SELECT 1 FROM categorias x WHERE x.uid = 'c:' || lower(${f}nombre))
                THEN 'c:' || lower(${f}nombre) ELSE ${ALEATORIO} END`;
  }
  if (d.t === 'cuentas_contables') {
    // Las cuentas que trae el sistema tienen uid fijo para que todos los dispositivos coincidan
    return `CASE WHEN ${f}sistema = 1
                  AND NOT EXISTS (SELECT 1 FROM cuentas_contables x WHERE x.uid = 'cc:' || ${f}codigo)
                THEN 'cc:' || ${f}codigo ELSE ${ALEATORIO} END`;
  }
  return ALEATORIO;
}

// Condición extra para que solo los ajustes compartidos marquen cambios
const filtroConfig = (d, prefijo) => (d.t === 'config' ? ` AND ${prefijo}clave IN (${lista(CONFIG_COMPARTIDA)})` : '');

// ---------- Migración ----------
export const CREAR_CONTROL = [
  `CREATE TABLE IF NOT EXISTS sync_ctl (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     aplicando INTEGER NOT NULL DEFAULT 0,
     cursor INTEGER NOT NULL DEFAULT 0,
     dispositivo TEXT, codigo TEXT, negocio TEXT, negocio_nombre TEXT, ultimo TEXT)`,
  'INSERT OR IGNORE INTO sync_ctl (id) VALUES (1)',
  'UPDATE sync_ctl SET aplicando = 0 WHERE id = 1',
  `CREATE TABLE IF NOT EXISTS sync_borrados (
     tabla TEXT NOT NULL, uid TEXT NOT NULL, act INTEGER NOT NULL, PRIMARY KEY (tabla, uid))`,
];

export function sentenciasColumnas() {
  const s = [];
  for (const d of TABLAS) {
    s.push(`ALTER TABLE ${d.t} ADD COLUMN uid TEXT`);
    s.push(`ALTER TABLE ${d.t} ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0`);
    s.push(`ALTER TABLE ${d.t} ADD COLUMN act INTEGER`);
  }
  s.push('ALTER TABLE usuarios ADD COLUMN uid TEXT');
  s.push('ALTER TABLE sync_ctl ADD COLUMN epoca INTEGER NOT NULL DEFAULT 0');
  s.push('ALTER TABLE sync_ctl ADD COLUMN negocio_id TEXT');
  return s;
}

export function sentenciasRelleno() {
  const s = TABLAS.map((d) => `UPDATE ${d.t} SET uid = ${exprUid(d, '')} WHERE uid IS NULL`);
  s.push(`UPDATE usuarios SET uid = ${ALEATORIO} WHERE uid IS NULL`);
  return s;
}

export function sentenciasIndices() {
  return [...TABLAS.map((d) => d.t), 'usuarios'].map((t) => `CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_uid ON ${t}(uid)`);
}

// Triggers que marcan cada alta, cambio o baja. Los cambios que llegan de la nube se hacen con aplicando = 1 y no se marcan.
export function sentenciasTriggers() {
  const s = [];
  for (const d of TABLAS) {
    const llave = d.t === 'config' ? 'clave' : 'rowid';
    const nuevaLlave = d.t === 'config' ? 'NEW.clave' : 'NEW.rowid';
    s.push(`CREATE TRIGGER IF NOT EXISTS sync1_ai_${d.t} AFTER INSERT ON ${d.t}
      WHEN ${APLICANDO}${filtroConfig(d, 'NEW.')}
      BEGIN
        UPDATE ${d.t} SET uid = COALESCE(uid, ${exprUid(d, 'NEW.')}), dirty = 1, act = ${AHORA} WHERE ${llave} = ${nuevaLlave};
        DELETE FROM sync_borrados WHERE tabla = '${d.t}' AND uid = (SELECT uid FROM ${d.t} WHERE ${llave} = ${nuevaLlave});
      END`);
    // Si cambia la lista de columnas vigiladas, el trigger viejo se reemplaza
    if (d.disparar) s.push(`DROP TRIGGER IF EXISTS sync1_au_${d.t}`);
    const columnas = d.disparar ? ` OF ${d.disparar.join(', ')}` : '';
    s.push(`CREATE TRIGGER IF NOT EXISTS sync1_au_${d.t} AFTER UPDATE${columnas} ON ${d.t}
      WHEN ${APLICANDO} AND NEW.act IS OLD.act${filtroConfig(d, 'NEW.')}
      BEGIN
        UPDATE ${d.t} SET dirty = 1,
               act = MAX(${AHORA}, COALESCE(OLD.act, 0) + 1) WHERE ${llave} = ${nuevaLlave};
      END`);
    s.push(`CREATE TRIGGER IF NOT EXISTS sync1_ad_${d.t} AFTER DELETE ON ${d.t}
      WHEN ${APLICANDO} AND OLD.uid IS NOT NULL${filtroConfig(d, 'OLD.')}
      BEGIN
        INSERT OR REPLACE INTO sync_borrados (tabla, uid, act) VALUES ('${d.t}', OLD.uid, ${AHORA});
      END`);
  }
  // Los usuarios no se sincronizan como los demás datos, pero necesitan su uid para enlazarse con la cuenta de la nube
  s.push(`CREATE TRIGGER IF NOT EXISTS sync1_ai_usuarios AFTER INSERT ON usuarios WHEN NEW.uid IS NULL
    BEGIN UPDATE usuarios SET uid = ${ALEATORIO} WHERE id = NEW.id; END`);
  return s;
}

// Prepara una base para sincronizar. "ejecutar" corre una sentencia suelta; los errores de ALTER repetido se ignoran.
export async function prepararBase(ejecutar) {
  for (const q of CREAR_CONTROL) await ejecutar(q);
  for (const q of sentenciasColumnas()) { try { await ejecutar(q); } catch { /* la columna ya existe */ } }
  for (const q of sentenciasRelleno()) await ejecutar(q);
  for (const q of sentenciasIndices()) await ejecutar(q);
  for (const q of sentenciasTriggers()) await ejecutar(q);
}
