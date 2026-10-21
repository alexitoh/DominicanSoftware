-- Sistema de ventas Dominican Software - Fase 1
-- Base de datos SQLite (sin comprobante fiscal)

CREATE TABLE IF NOT EXISTS config (
  clave TEXT PRIMARY KEY,
  valor TEXT
);

CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT UNIQUE,
  nombre TEXT NOT NULL,
  categoria_id INTEGER REFERENCES categorias(id),
  marca TEXT,
  costo REAL NOT NULL DEFAULT 0,
  precio REAL NOT NULL DEFAULT 0,
  margen REAL,
  stock_actual INTEGER NOT NULL DEFAULT 0,
  stock_minimo INTEGER NOT NULL DEFAULT 0,
  ubicacion TEXT,
  foto TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  itbis_exento INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  telefono TEXT,
  direccion TEXT,
  notas TEXT,
  condicion TEXT,       -- contado | credito (vacío = sin definir)
  dias_credito INTEGER, -- días para pagar si es a crédito
  tipo_doc TEXT,        -- rnc | cedula | dni (identificación fiscal)
  documento TEXT,       -- número sin guiones ni espacios
  limite_credito REAL,  -- tope de deuda a crédito (vacío = sin límite)
  tipo_comprobante TEXT, -- B01 | B02 | B14 | B15 (vacío = automático según su RNC)
  regimen_dgii TEXT,    -- régimen que la DGII tiene registrado para su RNC (se llena al verificarlo)
  tipo_cliente_id INTEGER REFERENCES tipos_cliente(id),
  condicion_pago_id INTEGER REFERENCES condiciones_pago(id),
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Direcciones de envío o entrega de un cliente (la dirección de la ficha es la principal)
CREATE TABLE IF NOT EXISTS cliente_direcciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  etiqueta TEXT,        -- Casa, Oficina, Almacén…
  direccion TEXT NOT NULL,
  referencia TEXT
);
CREATE INDEX IF NOT EXISTS idx_cliente_dir ON cliente_direcciones(cliente_id);

-- Personas de contacto asociadas a un cliente
CREATE TABLE IF NOT EXISTS cliente_contactos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  nombre TEXT NOT NULL,
  cargo TEXT,
  telefono TEXT,
  correo TEXT
);
CREATE INDEX IF NOT EXISTS idx_cliente_cont ON cliente_contactos(cliente_id);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cliente_id INTEGER REFERENCES clientes(id),
  subtotal REAL NOT NULL DEFAULT 0,
  descuento REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  metodo_pago TEXT NOT NULL DEFAULT 'efectivo', -- efectivo | tarjeta | transferencia | cheque
  estado TEXT NOT NULL DEFAULT 'completada',    -- completada | anulada
  notas TEXT,
  itbis REAL NOT NULL DEFAULT 0,
  ncf TEXT,
  cliente_nombre TEXT, -- cliente ambulante de consumo (nombre suelto, sin ficha)
  cajero_id INTEGER REFERENCES usuarios(id) -- quién cobró en caja (si la venta pasó por la cola de caja)
);

-- Ventas al contado que el vendedor envía a caja: el cliente paga allí y recién entonces nace la factura
CREATE TABLE IF NOT EXISTS ventas_pendientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cliente_id INTEGER REFERENCES clientes(id),
  cliente_nombre TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  tipo_ncf TEXT NOT NULL DEFAULT 'auto',
  descuento REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  notas TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente',   -- pendiente | cobrada | cancelada
  venta_id INTEGER REFERENCES ventas(id)
);
CREATE TABLE IF NOT EXISTS ventas_pendientes_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pendiente_id INTEGER NOT NULL REFERENCES ventas_pendientes(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL,
  precio_unitario REAL NOT NULL,
  descuento REAL NOT NULL DEFAULT 0,
  garantia_meses INTEGER NOT NULL DEFAULT 0,
  serie TEXT
);
CREATE TABLE IF NOT EXISTS ventas_pendientes_servicios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pendiente_id INTEGER NOT NULL REFERENCES ventas_pendientes(id),
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL,
  precio_unitario REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS venta_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL,
  precio_unitario REAL NOT NULL,
  costo_unitario REAL NOT NULL DEFAULT 0,
  descuento REAL NOT NULL DEFAULT 0
);

-- Servicios o mano de obra cobrados en una venta (no tienen inventario)
CREATE TABLE IF NOT EXISTS venta_servicios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id),
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL DEFAULT 1,
  precio_unitario REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS movimientos_inventario (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  tipo TEXT NOT NULL,          -- entrada | salida | ajuste
  cantidad INTEGER NOT NULL,   -- positiva suma, negativa resta
  motivo TEXT,                 -- compra | venta | anulacion | ajuste | dano
  referencia_id INTEGER,       -- id de la venta, si aplica
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Abonos e inicial de las ventas a crédito (metodo_pago = 'credito')
-- Recibo de ingreso: un cobro a un cliente que puede pagar varias facturas con varios métodos de pago
CREATE TABLE IF NOT EXISTS recibos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  total REAL NOT NULL,
  estado TEXT NOT NULL DEFAULT 'vigente', -- vigente | anulado
  notas TEXT,
  usuario_id INTEGER
);
-- Cómo se pagó el recibo: una línea por método (efectivo, tarjeta, transferencia, cheque)
CREATE TABLE IF NOT EXISTS recibo_metodos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recibo_id INTEGER NOT NULL REFERENCES recibos(id),
  metodo TEXT NOT NULL,
  monto REAL NOT NULL,
  referencia TEXT       -- número de cheque, banco o referencia de la transferencia
);
CREATE INDEX IF NOT EXISTS idx_recibos_cliente ON recibos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_recibo_metodos ON recibo_metodos(recibo_id);

CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id),
  monto REAL NOT NULL,
  metodo TEXT NOT NULL DEFAULT 'efectivo',
  nota TEXT,
  recibo_id INTEGER REFERENCES recibos(id),
  documento_id INTEGER,   -- nota de crédito/débito o anticipo de cxc_docs que originó este movimiento
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_pagos_venta ON pagos(venta_id);

-- Fecha límite de pago de las ventas a crédito
CREATE TABLE IF NOT EXISTS cuentas_cobrar (
  venta_id INTEGER PRIMARY KEY REFERENCES ventas(id),
  vence TEXT
);

-- Compras a proveedores
CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  telefono TEXT,
  direccion TEXT,
  notas TEXT,
  condicion TEXT,
  dias_credito INTEGER,
  tipo_doc TEXT,
  documento TEXT,
  tipo_proveedor_id INTEGER REFERENCES tipos_proveedor(id),
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS compras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  proveedor_id INTEGER REFERENCES proveedores(id),
  referencia TEXT,
  total REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'completada',
  notas TEXT,
  itbis REAL NOT NULL DEFAULT 0,
  ncf TEXT,
  fecha_factura TEXT                        -- fecha que trae la factura del suplidor
);

CREATE TABLE IF NOT EXISTS compra_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compra_id INTEGER NOT NULL REFERENCES compras(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL,
  costo_unitario REAL NOT NULL
);

-- Pagos de compras. Una compra a crédito (cuenta por pagar) tiene además una fila en cuentas_pagar.
CREATE TABLE IF NOT EXISTS cuentas_pagar (
  compra_id INTEGER PRIMARY KEY REFERENCES compras(id),
  vence TEXT
);

CREATE TABLE IF NOT EXISTS pagos_compra (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compra_id INTEGER NOT NULL REFERENCES compras(id),
  monto REAL NOT NULL,
  metodo TEXT NOT NULL DEFAULT 'efectivo',
  nota TEXT,
  documento_id INTEGER,   -- nota de crédito/débito o anticipo de cxp_docs que originó este movimiento
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_pagos_compra ON pagos_compra(compra_id);
CREATE INDEX IF NOT EXISTS idx_compras_fecha ON compras(fecha);
CREATE INDEX IF NOT EXISTS idx_compra_detalle ON compra_detalle(compra_id);

-- Caja diaria: cada turno se abre con efectivo inicial y se cierra contando el cajón
CREATE TABLE IF NOT EXISTS caja (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_apertura TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  efectivo_inicial REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'abierta',
  fecha_cierre TEXT,
  efectivo_esperado REAL,
  efectivo_contado REAL,
  diferencia REAL,
  notas TEXT,
  conteo_cajero REAL,
  conteo_fecha TEXT,
  conteo_nota TEXT,
  conteo_por TEXT
);

-- Tipos de pago: nombres de formas de pago que se asocian a un método base y, si se quiere, a un banco o a una cuenta contable
CREATE TABLE IF NOT EXISTS tipos_pago (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  metodo TEXT NOT NULL DEFAULT 'efectivo', -- efectivo | tarjeta | transferencia | cheque
  banco_id INTEGER REFERENCES cuentas_bancarias(id),
  cuenta_id INTEGER REFERENCES cuentas_contables(id),
  requiere_ref INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
);

-- Conceptos reutilizables para asientos y gastos
CREATE TABLE IF NOT EXISTS conceptos_conta (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL DEFAULT 'asiento',   -- asiento | gasto
  cuenta_debe_id INTEGER REFERENCES cuentas_contables(id),
  cuenta_haber_id INTEGER REFERENCES cuentas_contables(id),
  categoria_gasto TEXT,
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);

-- Declaraciones presentadas a la DGII (una por período y formulario)
CREATE TABLE IF NOT EXISTS declaraciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT NOT NULL UNIQUE,            -- AAAA-MM:formulario
  periodo TEXT NOT NULL,
  formulario TEXT NOT NULL,
  fecha_presentada TEXT NOT NULL,
  referencia TEXT,
  notas TEXT
);

-- CxC: tipos de cliente, condiciones de pago, motivos de descuento/devolución y documentos (notas de crédito y débito, anticipos)
CREATE TABLE IF NOT EXISTS tipos_cliente (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  descuento REAL NOT NULL DEFAULT 0,      -- % de descuento sugerido para este tipo de cliente
  limite_credito REAL,                    -- límite de crédito sugerido
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS condiciones_pago (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  dias INTEGER NOT NULL DEFAULT 0,        -- 0 = de contado
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cxc_conceptos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  tipo TEXT NOT NULL DEFAULT 'descuento', -- descuento | devolucion | cargo
  porcentaje REAL,                        -- % sugerido (opcional)
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
-- tipo: credito (baja lo que debe una factura) | debito (lo sube) | anticipo (dinero recibido por adelantado)
CREATE TABLE IF NOT EXISTS cxc_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  tipo TEXT NOT NULL,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  venta_id INTEGER REFERENCES ventas(id),
  concepto_id INTEGER REFERENCES cxc_conceptos(id),
  monto REAL NOT NULL,
  itbis REAL NOT NULL DEFAULT 0,
  ncf TEXT,
  metodo TEXT,                            -- solo anticipos: cómo se recibió el dinero
  referencia TEXT,
  notas TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente', -- vigente | anulado
  anulado_motivo TEXT,
  usuario_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cxc_docs_cliente ON cxc_docs(cliente_id);

-- CxP: tipos de suplidor, documentos (notas de crédito y débito, anticipos) y compras (solicitud, requisición de cotización, orden)
CREATE TABLE IF NOT EXISTS tipos_proveedor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);
-- tipo: credito (baja lo que se le debe al suplidor) | debito (lo sube) | anticipo (dinero entregado por adelantado)
CREATE TABLE IF NOT EXISTS cxp_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  tipo TEXT NOT NULL,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
  compra_id INTEGER REFERENCES compras(id),
  concepto TEXT,
  monto REAL NOT NULL,
  itbis REAL NOT NULL DEFAULT 0,
  ncf TEXT,
  metodo TEXT,                            -- solo anticipos: cómo se pagó
  referencia TEXT,
  notas TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente', -- vigente | anulado
  anulado_motivo TEXT,
  usuario_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cxp_docs_proveedor ON cxp_docs(proveedor_id);

CREATE TABLE IF NOT EXISTS solicitudes_compra (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  solicitante TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | aprobada | rechazada | atendida | anulada
  notas TEXT,
  usuario_id INTEGER
);
CREATE TABLE IF NOT EXISTS solicitud_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  solicitud_id INTEGER NOT NULL REFERENCES solicitudes_compra(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL,
  nota TEXT
);
CREATE TABLE IF NOT EXISTS requisiciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  estado TEXT NOT NULL DEFAULT 'abierta',   -- abierta | adjudicada | anulada
  solicitud_id INTEGER REFERENCES solicitudes_compra(id),
  notas TEXT,
  usuario_id INTEGER
);
CREATE TABLE IF NOT EXISTS requisicion_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL
);
-- Precio que cada suplidor cotizó para cada línea de la requisición
CREATE TABLE IF NOT EXISTS requisicion_cot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisicion_id INTEGER NOT NULL REFERENCES requisiciones(id),
  proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
  detalle_id INTEGER NOT NULL REFERENCES requisicion_detalle(id),
  costo_unitario REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS ordenes_compra (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | autorizada | parcial (back order) | recibida | anulada
  entrega TEXT,                             -- fecha esperada de entrega
  condicion TEXT NOT NULL DEFAULT 'contado', -- contado | credito: cómo se autoriza el despacho
  dias_credito INTEGER,                     -- plazo si es a crédito
  autorizado_por TEXT,
  autorizada_fecha TEXT,
  requisicion_id INTEGER REFERENCES requisiciones(id),
  compra_id INTEGER REFERENCES compras(id), -- la factura del suplidor con la que se recibió
  notas TEXT,
  usuario_id INTEGER
);
CREATE TABLE IF NOT EXISTS orden_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  orden_id INTEGER NOT NULL REFERENCES ordenes_compra(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad INTEGER NOT NULL,
  costo_unitario REAL NOT NULL DEFAULT 0,
  recibido INTEGER NOT NULL DEFAULT 0,      -- unidades ya llegadas (facturas recibidas)
  no_llegara INTEGER NOT NULL DEFAULT 0,    -- 1 = lo pendiente no llegará: el comprador lo gestiona en otro lado
  nota TEXT
);

-- Finanzas: monedas, tasas de cambio y partidas en moneda extranjera (para la diferencia cambiaria)
CREATE TABLE IF NOT EXISTS monedas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,            -- USD, EUR…
  nombre TEXT NOT NULL,
  simbolo TEXT,
  activa INTEGER NOT NULL DEFAULT 1
);
-- tasa = cuántos pesos (moneda base) vale una unidad de la moneda en esa fecha
CREATE TABLE IF NOT EXISTS tasas_cambio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT NOT NULL UNIQUE,             -- CODIGO:AAAA-MM-DD
  moneda_id INTEGER NOT NULL REFERENCES monedas(id),
  fecha TEXT NOT NULL,
  tasa REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS partidas_ext (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  descripcion TEXT NOT NULL,
  moneda_id INTEGER NOT NULL REFERENCES monedas(id),
  cuenta_id INTEGER NOT NULL REFERENCES cuentas_contables(id),
  monto_ext REAL NOT NULL,                -- monto en la moneda extranjera
  tasa_libro REAL NOT NULL,               -- tasa con la que está registrada hoy en los libros
  fecha TEXT NOT NULL,
  notas TEXT,
  activa INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS dif_cambiaria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partida_id INTEGER NOT NULL REFERENCES partidas_ext(id),
  fecha TEXT NOT NULL,
  tasa_anterior REAL NOT NULL,
  tasa_nueva REAL NOT NULL,
  monto REAL NOT NULL,                    -- positivo = ganancia, negativo = pérdida
  asiento_numero TEXT
);

CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caja_id INTEGER REFERENCES caja(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  concepto TEXT NOT NULL,
  categoria TEXT,
  monto REAL NOT NULL,
  metodo TEXT NOT NULL DEFAULT 'efectivo',
  nota TEXT,
  itbis REAL NOT NULL DEFAULT 0,
  ncf TEXT,
  documento TEXT,
  tipo_pago_id INTEGER REFERENCES tipos_pago(id),
  beneficiario TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente',   -- vigente | anulado
  origen TEXT NOT NULL DEFAULT 'caja'       -- caja | conta (registrado desde Contabilidad, sin caja abierta)
);

-- Garantías de los productos vendidos (una por línea de venta que la lleve)
CREATE TABLE IF NOT EXISTS garantias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cliente_id INTEGER REFERENCES clientes(id),
  serie TEXT,
  meses INTEGER NOT NULL,
  inicio TEXT NOT NULL,
  vence TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'vigente' -- vigente | anulada
);

CREATE TABLE IF NOT EXISTS garantia_reclamos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  garantia_id INTEGER NOT NULL REFERENCES garantias(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  problema TEXT NOT NULL,
  resolucion TEXT,
  estado TEXT NOT NULL DEFAULT 'abierto' -- abierto | resuelto
);

CREATE INDEX IF NOT EXISTS idx_garantias_venta ON garantias(venta_id);
CREATE INDEX IF NOT EXISTS idx_reclamos_garantia ON garantia_reclamos(garantia_id);
CREATE INDEX IF NOT EXISTS idx_gastos_caja ON gastos(caja_id);
CREATE INDEX IF NOT EXISTS idx_productos_nombre ON productos(nombre);
-- Cotizaciones de trabajos (no mueven inventario ni caja hasta convertirlas en venta)
CREATE TABLE IF NOT EXISTS cotizaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cliente_id INTEGER REFERENCES clientes(id),
  cliente_nombre TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  descuento REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  validez_dias INTEGER NOT NULL DEFAULT 15,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  notas TEXT,
  venta_id INTEGER REFERENCES ventas(id)
);

CREATE TABLE IF NOT EXISTS cotizacion_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cotizacion_id INTEGER NOT NULL REFERENCES cotizaciones(id),
  producto_id INTEGER REFERENCES productos(id),
  descripcion TEXT NOT NULL,
  cantidad REAL NOT NULL DEFAULT 1,
  precio_unitario REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cotizaciones_fecha ON cotizaciones(fecha);
CREATE INDEX IF NOT EXISTS idx_cot_detalle ON cotizacion_detalle(cotizacion_id);
-- Usuarios que pueden entrar a la app y su actividad
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE,
  correo TEXT,
  rol TEXT NOT NULL DEFAULT 'vendedor',
  permisos TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  iter INTEGER NOT NULL DEFAULT 150000,
  recup_salt TEXT,
  recup_hash TEXT,
  debe_cambiar INTEGER NOT NULL DEFAULT 0,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ultimo_acceso TEXT
);

CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  usuario_id INTEGER,
  usuario TEXT,
  accion TEXT NOT NULL,
  detalle TEXT
);

-- Comprobantes (NCF) que el sistema entregó y quedaron anulados porque la factura no se llegó a guardar (alimenta el formato 608)
CREATE TABLE IF NOT EXISTS ncf_anulados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ncf TEXT NOT NULL UNIQUE,
  tipo TEXT,
  motivo TEXT,
  origen TEXT NOT NULL DEFAULT 'sistema',
  usuario_id INTEGER
);

-- Estado de cada comprobante electrónico (e-CF). Lo escribe el servidor; los dispositivos solo lo leen.
CREATE TABLE IF NOT EXISTS ecf_documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ncf TEXT NOT NULL,
  tipo TEXT,
  estado TEXT,
  track_id TEXT,
  codigo_seguridad TEXT,
  fecha_firma TEXT,
  mensaje TEXT,
  monto REAL,
  qr_url TEXT,
  ambiente TEXT,
  venta_id INTEGER,
  cxc_doc_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ecf_venta ON ecf_documentos(venta_id);
CREATE INDEX IF NOT EXISTS idx_ecf_ncf ON ecf_documentos(ncf);

CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON bitacora(fecha);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
CREATE INDEX IF NOT EXISTS idx_detalle_venta ON venta_detalle(venta_id);
CREATE INDEX IF NOT EXISTS idx_venta_servicios ON venta_servicios(venta_id);
CREATE INDEX IF NOT EXISTS idx_mov_producto ON movimientos_inventario(producto_id);

INSERT OR IGNORE INTO config (clave, valor) VALUES
  ('negocio_nombre', 'Mi Car Audio'),
  ('negocio_telefono', ''),
  ('negocio_direccion', ''),
  ('moneda', 'RD$'),
  ('siguiente_numero_venta', '1'),
  ('siguiente_numero_compra', '1'),
  ('siguiente_numero_cotizacion', '1'),
  ('siguiente_numero_recibo', '1'),
  ('itbis_modo', 'no'),
  ('itbis_tasa', '18');

-- ---------- Contabilidad ----------
CREATE TABLE IF NOT EXISTS centros_costo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT,
  nombre TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cuentas_contables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,                 -- activo | pasivo | patrimonio | ingreso | costo | gasto
  grupo INTEGER NOT NULL DEFAULT 0,   -- 1 = título (no admite movimientos)
  rol TEXT,                           -- función para la contabilización automática
  categoria_gasto TEXT,               -- categoría de gasto de Caja que carga a esta cuenta
  sistema INTEGER NOT NULL DEFAULT 0, -- 1 = viene con el sistema (no se borra)
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS asientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL,
  concepto TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'manual', -- manual | apertura | cierre
  estado TEXT NOT NULL DEFAULT 'vigente', -- vigente | anulado
  referencia TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  anulado_fecha TEXT,
  anulado_por TEXT,
  anulado_motivo TEXT
);

CREATE TABLE IF NOT EXISTS asiento_lineas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asiento_id INTEGER NOT NULL REFERENCES asientos(id),
  cuenta_id INTEGER NOT NULL REFERENCES cuentas_contables(id),
  debe REAL NOT NULL DEFAULT 0,
  haber REAL NOT NULL DEFAULT 0,
  detalle TEXT,
  centro_id INTEGER REFERENCES centros_costo(id)
);
CREATE INDEX IF NOT EXISTS idx_asiento_lineas ON asiento_lineas(asiento_id);

CREATE TABLE IF NOT EXISTS cuentas_bancarias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo_cuenta_id INTEGER,
  nombre TEXT NOT NULL,
  banco TEXT,
  numero TEXT,
  cuenta_id INTEGER REFERENCES cuentas_contables(id),
  predeterminada INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1
);

-- Tipos de cuenta bancaria (corriente, ahorro…)
CREATE TABLE IF NOT EXISTS tipos_cuenta_banco (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS banco_movs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  banco_id INTEGER NOT NULL REFERENCES cuentas_bancarias(id),
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL,                 -- deposito | retiro | cheque | transferencia | comision | interes
  monto REAL NOT NULL,
  contra_cuenta_id INTEGER REFERENCES cuentas_contables(id),
  banco_destino_id INTEGER REFERENCES cuentas_bancarias(id),
  referencia TEXT,
  detalle TEXT,
  beneficiario TEXT,                  -- cheques: a nombre de quién
  estado TEXT NOT NULL DEFAULT 'vigente'
);

-- Créditos bancarios (préstamos): desembolso al banco y cuotas con capital e interés
CREATE TABLE IF NOT EXISTS creditos_bancarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  fecha TEXT NOT NULL,
  entidad TEXT,
  banco_id INTEGER NOT NULL REFERENCES cuentas_bancarias(id), -- cuenta donde se depositó el desembolso
  monto REAL NOT NULL,
  tasa_anual REAL NOT NULL DEFAULT 0,
  plazo_meses INTEGER NOT NULL,
  cuota REAL NOT NULL,
  notas TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente'
);
CREATE TABLE IF NOT EXISTS credito_pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  credito_id INTEGER NOT NULL REFERENCES creditos_bancarios(id),
  fecha TEXT NOT NULL,
  capital REAL NOT NULL,
  interes REAL NOT NULL DEFAULT 0,
  banco_id INTEGER NOT NULL REFERENCES cuentas_bancarias(id),
  referencia TEXT,
  estado TEXT NOT NULL DEFAULT 'vigente'
);

-- Solicitudes de pago: se piden, se aprueban y recién ahí se emite el cheque o la transferencia
CREATE TABLE IF NOT EXISTS solicitudes_pago (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  fecha TEXT NOT NULL,
  beneficiario TEXT NOT NULL,
  proveedor_id INTEGER REFERENCES proveedores(id),
  concepto TEXT,
  monto REAL NOT NULL,
  forma TEXT NOT NULL DEFAULT 'cheque',          -- cheque | transferencia
  contra_cuenta_id INTEGER REFERENCES cuentas_contables(id), -- en qué se gasta (si no es pago a un suplidor)
  banco_id INTEGER REFERENCES cuentas_bancarias(id),
  estado TEXT NOT NULL DEFAULT 'pendiente',      -- pendiente | aprobada | pagada | rechazada
  aprobado_por TEXT,
  mov_numero TEXT,
  referencia TEXT,
  notas TEXT,
  usuario_id INTEGER
);

-- Caja chica: fondos fijos con custodio. El saldo sale de sus movimientos (fondo + reposiciones - desembolsos).
CREATE TABLE IF NOT EXISTS cajas_chicas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  custodio TEXT,
  notas TEXT,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS caja_chica_movs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  caja_chica_id INTEGER NOT NULL REFERENCES cajas_chicas(id),
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL,                  -- fondo | desembolso | reposicion
  concepto TEXT,
  categoria TEXT,
  beneficiario TEXT,
  documento TEXT,                      -- RNC o cédula de quien recibió el pago
  comprobante TEXT,                    -- número del vale o recibo
  ncf TEXT,
  itbis REAL NOT NULL DEFAULT 0,
  monto REAL NOT NULL,
  banco_id INTEGER REFERENCES cuentas_bancarias(id), -- fondo y reposición: de dónde sale el dinero (vacío = Caja general)
  reposicion_numero TEXT,              -- en un desembolso: la reposición que ya lo repuso
  estado TEXT NOT NULL DEFAULT 'vigente'
);

-- Conciliación bancaria terminada: guarda las cifras del cierre a una fecha de corte
CREATE TABLE IF NOT EXISTS conciliaciones_banco (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  banco_id INTEGER NOT NULL REFERENCES cuentas_bancarias(id),
  fecha_corte TEXT NOT NULL,
  saldo_extracto REAL NOT NULL,
  saldo_libros REAL NOT NULL,
  depositos_transito REAL NOT NULL DEFAULT 0,
  cheques_transito REAL NOT NULL DEFAULT 0,
  saldo_ajustado REAL NOT NULL DEFAULT 0,
  n_conciliados INTEGER NOT NULL DEFAULT 0,
  notas TEXT,
  por TEXT,
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS conciliaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  banco_id INTEGER NOT NULL REFERENCES cuentas_bancarias(id),
  ref TEXT NOT NULL,
  fecha TEXT NOT NULL DEFAULT (date('now','localtime')),
  conciliacion_id INTEGER REFERENCES conciliaciones_banco(id)
);

-- Tipos de depreciación: línea recta (según la vida útil del activo) o saldo decreciente (% anual sobre el valor en libros)
CREATE TABLE IF NOT EXISTS dep_tipos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  metodo TEXT NOT NULL DEFAULT 'lineal', -- lineal | saldo_decreciente
  tasa_anual REAL,
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);

-- Tipos de activo fijo: valores por defecto (vida útil, residual, método) que se copian al registrar un activo
CREATE TABLE IF NOT EXISTS activos_tipos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  vida_meses INTEGER NOT NULL DEFAULT 60,
  residual_pct REAL NOT NULL DEFAULT 0,
  deprecia INTEGER NOT NULL DEFAULT 1,
  dep_tipo_id INTEGER REFERENCES dep_tipos(id),
  notas TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);

-- Tasa de inflación anual (%) para ajustar el valor de los activos
CREATE TABLE IF NOT EXISTS tasas_inflacion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anio INTEGER NOT NULL UNIQUE,
  tasa REAL NOT NULL,
  fuente TEXT
);

CREATE TABLE IF NOT EXISTS activos_fijos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT,
  nombre TEXT NOT NULL,
  fecha_adq TEXT NOT NULL,
  costo REAL NOT NULL,
  residual REAL NOT NULL DEFAULT 0,
  vida_meses INTEGER NOT NULL,
  contra_cuenta_id INTEGER REFERENCES cuentas_contables(id),
  estado TEXT NOT NULL DEFAULT 'activo', -- activo | baja
  fecha_baja TEXT,
  notas TEXT,
  categoria TEXT,
  ubicacion TEXT,
  serie TEXT,
  baja_motivo TEXT,                 -- venta | desecho | perdida | donacion | baja
  baja_precio REAL,                 -- lo cobrado si se vendió
  baja_cuenta_id INTEGER REFERENCES cuentas_contables(id), -- dónde entró el dinero (por defecto Caja)
  baja_nota TEXT,
  tipo_id INTEGER REFERENCES activos_tipos(id),
  dep_tipo_id INTEGER REFERENCES dep_tipos(id),
  metodo_dep TEXT NOT NULL DEFAULT 'lineal',
  tasa_dep REAL,
  deprecia INTEGER NOT NULL DEFAULT 1
);

-- Revalorización: cambia el valor en libros de un activo a una fecha; la depreciación se recalcula sobre la vida restante
CREATE TABLE IF NOT EXISTS activos_reval (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activo_id INTEGER NOT NULL REFERENCES activos_fijos(id),
  fecha TEXT NOT NULL,
  valor_anterior REAL NOT NULL,
  valor_nuevo REAL NOT NULL,
  ajuste REAL NOT NULL,
  nota TEXT
);

CREATE TABLE IF NOT EXISTS empleados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  cedula TEXT,
  cargo TEXT,
  salario REAL NOT NULL DEFAULT 0,
  fecha_ingreso TEXT,
  centro_id INTEGER REFERENCES centros_costo(id),
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS nomina_corridas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  periodo TEXT NOT NULL,              -- AAAA-MM
  fecha TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'vigente', -- vigente | anulada
  pagada INTEGER NOT NULL DEFAULT 0,
  fecha_pago TEXT,
  metodo_pago TEXT,
  notas TEXT
);

CREATE TABLE IF NOT EXISTS nomina_detalle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  corrida_id INTEGER NOT NULL REFERENCES nomina_corridas(id),
  empleado_id INTEGER NOT NULL REFERENCES empleados(id),
  salario REAL NOT NULL DEFAULT 0,
  otros_ingresos REAL NOT NULL DEFAULT 0,
  afp REAL NOT NULL DEFAULT 0,
  sfs REAL NOT NULL DEFAULT 0,
  isr REAL NOT NULL DEFAULT 0,
  otros_desc REAL NOT NULL DEFAULT 0,
  neto REAL NOT NULL DEFAULT 0,
  afp_pat REAL NOT NULL DEFAULT 0,
  sfs_pat REAL NOT NULL DEFAULT 0,
  srl_pat REAL NOT NULL DEFAULT 0,
  infotep REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presupuestos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anio INTEGER NOT NULL,
  cuenta_id INTEGER NOT NULL REFERENCES cuentas_contables(id),
  mes INTEGER NOT NULL,
  monto REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS periodos_cerrados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  periodo TEXT NOT NULL                -- AAAA-MM
);

INSERT OR IGNORE INTO cuentas_contables (codigo, nombre, tipo, grupo, rol, categoria_gasto, sistema) VALUES
  ('1', 'ACTIVOS', 'activo', 1, NULL, NULL, 1),
  ('11', 'Activos corrientes', 'activo', 1, NULL, NULL, 1),
  ('1101', 'Caja general', 'activo', 0, 'caja', NULL, 1),
  ('1102', 'Caja chica', 'activo', 0, 'caja_chica', NULL, 1),
  ('1110', 'Bancos', 'activo', 0, 'banco', NULL, 1),
  ('1201', 'Cuentas por cobrar clientes', 'activo', 0, 'cxc', NULL, 1),
  ('1210', 'ITBIS pagado por adelantado', 'activo', 0, 'itbis_adelantado', NULL, 1),
  ('1220', 'Anticipos a proveedores', 'activo', 0, 'anticipos_proveedores', NULL, 1),
  ('1301', 'Inventario de mercancía', 'activo', 0, 'inventario', NULL, 1),
  ('15', 'Activos no corrientes', 'activo', 1, NULL, NULL, 1),
  ('1501', 'Mobiliario y equipos', 'activo', 0, 'activo_fijo', NULL, 1),
  ('1599', 'Depreciación acumulada', 'activo', 0, 'dep_acumulada', NULL, 1),
  ('2', 'PASIVOS', 'pasivo', 1, NULL, NULL, 1),
  ('21', 'Pasivos corrientes', 'pasivo', 1, NULL, NULL, 1),
  ('2101', 'Cuentas por pagar proveedores', 'pasivo', 0, 'cxp', NULL, 1),
  ('2110', 'ITBIS por pagar', 'pasivo', 0, 'itbis_pagar', NULL, 1),
  ('2150', 'Anticipos de clientes', 'pasivo', 0, 'anticipos_clientes', NULL, 1),
  ('2120', 'TSS por pagar', 'pasivo', 0, 'tss_pagar', NULL, 1),
  ('2121', 'ISR retenido por pagar', 'pasivo', 0, 'isr_pagar', NULL, 1),
  ('2130', 'Sueldos por pagar', 'pasivo', 0, 'sueldos_pagar', NULL, 1),
  ('2140', 'Otras retenciones por pagar', 'pasivo', 0, 'otros_pagar', NULL, 1),
  ('25', 'Pasivos no corrientes', 'pasivo', 1, NULL, NULL, 1),
  ('2501', 'Préstamos bancarios a largo plazo', 'pasivo', 0, NULL, NULL, 1),
  ('2502', 'Créditos bancarios por pagar', 'pasivo', 0, 'prestamos_bancarios', NULL, 1),
  ('3', 'PATRIMONIO', 'patrimonio', 1, NULL, NULL, 1),
  ('3101', 'Capital social', 'patrimonio', 0, 'capital', NULL, 1),
  ('3201', 'Utilidades acumuladas', 'patrimonio', 0, 'utilidades_acum', NULL, 1),
  ('3301', 'Utilidad del ejercicio', 'patrimonio', 0, 'utilidad_ejercicio', NULL, 1),
  ('3401', 'Retiros del propietario', 'patrimonio', 0, NULL, NULL, 1),
  ('3501', 'Superávit por revalorización de activos', 'patrimonio', 0, 'superavit_reval', NULL, 1),
  ('4', 'INGRESOS', 'ingreso', 1, NULL, NULL, 1),
  ('4101', 'Ventas de mercancía', 'ingreso', 0, 'ventas', NULL, 1),
  ('4102', 'Ingresos por servicios', 'ingreso', 0, 'servicios', NULL, 1),
  ('4103', 'Descuentos y devoluciones en ventas', 'ingreso', 0, 'desc_ventas', NULL, 1),
  ('4201', 'Otros ingresos', 'ingreso', 0, 'otros_ingresos', NULL, 1),
  ('4202', 'Cargos y recargos a clientes', 'ingreso', 0, 'cargos_clientes', NULL, 1),
  ('4203', 'Ganancia por diferencia cambiaria', 'ingreso', 0, 'ganancia_cambiaria', NULL, 1),
  ('5', 'COSTOS', 'costo', 1, NULL, NULL, 1),
  ('5101', 'Costo de ventas', 'costo', 0, 'costo_ventas', NULL, 1),
  ('5102', 'Descuentos y devoluciones en compras', 'costo', 0, 'desc_compras', NULL, 1),
  ('6', 'GASTOS', 'gasto', 1, NULL, NULL, 1),
  ('6101', 'Sueldos y salarios', 'gasto', 0, 'gasto_sueldos', 'Sueldos', 1),
  ('6102', 'Aportes patronales (TSS, INFOTEP)', 'gasto', 0, 'gasto_tss', NULL, 1),
  ('6201', 'Alquiler', 'gasto', 0, NULL, 'Alquiler', 1),
  ('6202', 'Luz y agua', 'gasto', 0, NULL, 'Luz y agua', 1),
  ('6203', 'Internet y teléfono', 'gasto', 0, NULL, 'Internet y teléfono', 1),
  ('6204', 'Transporte', 'gasto', 0, NULL, 'Transporte', 1),
  ('6205', 'Mantenimiento y reparaciones', 'gasto', 0, NULL, 'Mantenimiento', 1),
  ('6206', 'Depreciación', 'gasto', 0, 'gasto_depreciacion', NULL, 1),
  ('6207', 'Comisiones bancarias', 'gasto', 0, 'gasto_bancario', NULL, 1),
  ('6208', 'Pérdida por diferencia cambiaria', 'gasto', 0, 'perdida_cambiaria', NULL, 1),
  ('6209', 'Cargos y recargos de proveedores', 'gasto', 0, 'cargos_proveedores', NULL, 1),
  ('6215', 'Intereses de préstamos', 'gasto', 0, 'gasto_intereses', NULL, 1),
  ('6299', 'Otros gastos', 'gasto', 0, 'gasto_otros', 'Otros', 1);


INSERT OR IGNORE INTO config (clave, valor) VALUES
  ('siguiente_numero_asiento', '1'),
  ('siguiente_numero_bancomov', '1'),
  ('siguiente_numero_cajachica', '1'),
  ('siguiente_numero_nc', '1'), ('siguiente_numero_nd', '1'), ('siguiente_numero_anticipo', '1'),
  ('siguiente_numero_credito', '1'), ('siguiente_numero_pagocredito', '1'), ('siguiente_numero_solpago', '1'),
  ('siguiente_numero_ncp', '1'), ('siguiente_numero_ndp', '1'), ('siguiente_numero_anticipop', '1'), ('siguiente_numero_solicitud', '1'), ('siguiente_numero_requisicion', '1'), ('siguiente_numero_orden', '1'),
  ('fiscal_mes_inicio', '1'),
  ('siguiente_numero_nomina', '1'),
  ('conta_inicio', ''),
  ('nom_afp_emp', '2.87'), ('nom_sfs_emp', '3.04'),
  ('nom_afp_pat', '7.10'), ('nom_sfs_pat', '7.09'), ('nom_srl_pat', '1.10'), ('nom_infotep', '1.00'),
  ('nom_tope_afp', '464460'), ('nom_tope_sfs', '232230'), ('nom_tope_srl', '92892'),
  ('nom_isr_exento', '416220');
