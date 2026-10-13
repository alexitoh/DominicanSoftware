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
  creado TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cliente_id INTEGER REFERENCES clientes(id),
  subtotal REAL NOT NULL DEFAULT 0,
  descuento REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  metodo_pago TEXT NOT NULL DEFAULT 'efectivo', -- efectivo | tarjeta | transferencia
  estado TEXT NOT NULL DEFAULT 'completada',    -- completada | anulada
  notas TEXT
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
CREATE TABLE IF NOT EXISTS pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id),
  monto REAL NOT NULL,
  metodo TEXT NOT NULL DEFAULT 'efectivo',
  nota TEXT,
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
  notas TEXT
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
  notas TEXT
);

CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caja_id INTEGER REFERENCES caja(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  concepto TEXT NOT NULL,
  categoria TEXT,
  monto REAL NOT NULL,
  metodo TEXT NOT NULL DEFAULT 'efectivo',
  nota TEXT
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

CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON bitacora(fecha);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
CREATE INDEX IF NOT EXISTS idx_detalle_venta ON venta_detalle(venta_id);
CREATE INDEX IF NOT EXISTS idx_venta_servicios ON venta_servicios(venta_id);
CREATE INDEX IF NOT EXISTS idx_mov_producto ON movimientos_inventario(producto_id);

INSERT OR IGNORE INTO categorias (nombre) VALUES
  ('Bajos / Subwoofers'), ('Bocinas'), ('Amplificadores'),
  ('Pantallas / Radios'), ('Cables y accesorios'), ('Otros');

INSERT OR IGNORE INTO config (clave, valor) VALUES
  ('negocio_nombre', 'Mi Car Audio'),
  ('negocio_telefono', ''),
  ('negocio_direccion', ''),
  ('moneda', 'RD$'),
  ('siguiente_numero_venta', '1'),
  ('siguiente_numero_compra', '1'),
  ('siguiente_numero_cotizacion', '1');
