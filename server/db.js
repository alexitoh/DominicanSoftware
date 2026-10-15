// db.js (servidor) - base SQLite con negocios, cuentas, dispositivos y el estado sincronizado de cada negocio
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TABLAS_SYNC = [
  'categorias', 'productos', 'tipos_cliente', 'condiciones_pago', 'clientes', 'cliente_direcciones', 'cliente_contactos', 'recibos', 'recibo_metodos', 'proveedores', 'ventas', 'venta_detalle', 'venta_servicios', 'cxc_conceptos', 'cxc_docs', 'pagos',
  'ventas_pendientes', 'ventas_pendientes_detalle', 'ventas_pendientes_servicios',
  'cuentas_cobrar', 'garantias', 'garantia_reclamos', 'compras', 'compra_detalle', 'cuentas_pagar', 'pagos_compra',
  'centros_costo', 'cuentas_contables', 'asientos', 'asiento_lineas', 'cuentas_bancarias', 'banco_movs', 'cajas_chicas', 'caja_chica_movs', 'conciliaciones_banco', 'conciliaciones', 'dep_tipos', 'activos_tipos', 'tasas_inflacion', 'activos_fijos', 'activos_reval', 'empleados', 'nomina_corridas', 'nomina_detalle', 'presupuestos', 'periodos_cerrados',
  'caja', 'tipos_pago', 'conceptos_conta', 'declaraciones', 'gastos', 'cotizaciones', 'cotizacion_detalle', 'movimientos_inventario', 'ncf_anulados', 'bitacora', 'config',
];

// Los usuarios y correos son únicos dentro de cada negocio (no en todo el servidor): dos negocios pueden tener un usuario "admin"
const DDL_CUENTAS = (nombre) => `CREATE TABLE IF NOT EXISTS ${nombre} (
      uid TEXT PRIMARY KEY,
      negocio TEXT NOT NULL REFERENCES negocios(uid),
      nombre TEXT NOT NULL,
      usuario TEXT NOT NULL,
      correo TEXT,
      rol TEXT NOT NULL DEFAULT 'vendedor',
      permisos TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      recup_hash TEXT,
      debe_cambiar INTEGER NOT NULL DEFAULT 0,
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      ultimo_acceso TEXT
    );`;
const COLUMNAS_CUENTAS = 'uid, negocio, nombre, usuario, correo, rol, permisos, activo, hash, recup_hash, debe_cambiar, creado, ultimo_acceso';

// Número de 9 dígitos al azar que no use otro negocio. Empieza con 9 para reconocerlo a simple vista como asignado.
export function identificadorLibre(db) {
  for (let i = 0; i < 100; i++) {
    const n = `9${String(crypto.randomInt(0, 100000000)).padStart(8, '0')}`;
    if (!db.prepare('SELECT 1 FROM negocios WHERE identificador = ?').get(n)) return n;
  }
  throw new Error('No se pudo generar un identificador libre.');
}

export function abrirBase(ruta) {
  if (ruta !== ':memory:') fs.mkdirSync(path.dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS negocios (
      uid TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      plan TEXT NOT NULL DEFAULT 'prueba',
      vence TEXT,
      creado TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ${DDL_CUENTAS('cuentas')}
    CREATE INDEX IF NOT EXISTS idx_cuentas_negocio ON cuentas(negocio);
    CREATE TABLE IF NOT EXISTS dispositivos (
      negocio TEXT NOT NULL,
      uid TEXT NOT NULL,
      codigo TEXT NOT NULL,
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      ultimo TEXT,
      PRIMARY KEY (negocio, uid)
    );
    CREATE TABLE IF NOT EXISTS registros (
      negocio TEXT NOT NULL,
      tabla TEXT NOT NULL,
      uid TEXT NOT NULL,
      datos TEXT,
      borrado INTEGER NOT NULL DEFAULT 0,
      actualizado INTEGER NOT NULL,
      version INTEGER NOT NULL,
      origen TEXT,
      PRIMARY KEY (negocio, tabla, uid)
    );
    CREATE INDEX IF NOT EXISTS idx_registros_version ON registros(negocio, version);
    CREATE TABLE IF NOT EXISTS secuencia (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL);
    INSERT OR IGNORE INTO secuencia (id, v) VALUES (1, 0);
  `);
  db.exec(`
    -- Secuencias de NCF autorizadas por la DGII: son del negocio (no del equipo). "siguiente" es el próximo número sin repartir.
    CREATE TABLE IF NOT EXISTS ncf_secuencias (
      negocio TEXT NOT NULL,
      tipo TEXT NOT NULL,
      siguiente INTEGER NOT NULL DEFAULT 0,
      hasta INTEGER NOT NULL DEFAULT 0,
      actualizado TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (negocio, tipo)
    );
    -- Cada comprobante entregado a un equipo. La clave evita entregar dos números si el equipo repite el pedido por un corte de internet,
    -- y permite anular el número si la factura no llegó a guardarse.
    CREATE TABLE IF NOT EXISTS ncf_emitidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      negocio TEXT NOT NULL,
      clave TEXT NOT NULL,
      tipo TEXT NOT NULL,
      numero INTEGER NOT NULL,
      estado TEXT NOT NULL DEFAULT 'emitido',
      motivo TEXT,
      equipo TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (negocio, clave)
    );
    -- Quién está cobrando cada venta enviada a caja: dos cajeros no pueden cobrar la misma factura
    CREATE TABLE IF NOT EXISTS cobros_reclamados (
      negocio TEXT NOT NULL,
      clave TEXT NOT NULL,
      equipo TEXT,
      estado TEXT NOT NULL DEFAULT 'cobrando',
      fecha TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (negocio, clave)
    );
    CREATE TABLE IF NOT EXISTS pagos_lic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      negocio TEXT NOT NULL,
      negocio_nombre TEXT,
      fecha TEXT NOT NULL DEFAULT (datetime('now')),
      monto REAL NOT NULL DEFAULT 0,
      meses INTEGER NOT NULL DEFAULT 0,
      nota TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pagos_lic_negocio ON pagos_lic(negocio);
    CREATE TABLE IF NOT EXISTS avisos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      negocio TEXT,
      titulo TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      nivel TEXT NOT NULL DEFAULT 'info',
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      caduca TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_avisos_negocio ON avisos(negocio);
    CREATE TABLE IF NOT EXISTS avisos_leidos (
      aviso TEXT NOT NULL,
      cuenta TEXT NOT NULL,
      PRIMARY KEY (aviso, cuenta)
    );
    CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL DEFAULT (datetime('now')),
      accion TEXT NOT NULL,
      negocio_nombre TEXT,
      detalle TEXT
    );
  `);
  for (const q of ['ALTER TABLE negocios ADD COLUMN notas TEXT', 'ALTER TABLE negocios ADD COLUMN aprobado TEXT', 'ALTER TABLE negocios ADD COLUMN precio REAL', 'ALTER TABLE negocios ADD COLUMN epoca INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE negocios ADD COLUMN identificador TEXT', "ALTER TABLE negocios ADD COLUMN id_tipo TEXT NOT NULL DEFAULT 'rnc'"]) {
    try { db.exec(q); } catch { /* la columna ya existe */ }
  }
  // Bases anteriores: usuario y correo eran únicos en todo el servidor. Se reconstruye la tabla para que lo sean por negocio.
  const defCuentas = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cuentas'").get()?.sql || '';
  if (/usuario\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(defCuentas)) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DROP INDEX IF EXISTS idx_cuentas_negocio');
      db.exec('ALTER TABLE cuentas RENAME TO cuentas_vieja');
      db.exec(DDL_CUENTAS('cuentas'));
      db.exec(`INSERT INTO cuentas (${COLUMNAS_CUENTAS}) SELECT ${COLUMNAS_CUENTAS} FROM cuentas_vieja`);
      db.exec('DROP TABLE cuentas_vieja');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cuentas_negocio ON cuentas(negocio);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cuentas_usuario ON cuentas(negocio, usuario);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cuentas_correo ON cuentas(negocio, correo) WHERE correo IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS ux_negocios_identificador ON negocios(identificador) WHERE identificador IS NOT NULL;
  `);
  // Los negocios que ya existían reciben un número asignado (el propietario puede cambiarlo por su RNC desde el panel)
  for (const { uid } of db.prepare('SELECT uid FROM negocios WHERE identificador IS NULL').all()) {
    db.prepare("UPDATE negocios SET identificador = ?, id_tipo = 'asignado' WHERE uid = ?").run(identificadorLibre(db), uid);
  }
  return db;
}

export function transaccion(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function siguienteVersion(db) {
  db.prepare('UPDATE secuencia SET v = v + 1 WHERE id = 1').run();
  return db.prepare('SELECT v FROM secuencia WHERE id = 1').get().v;
}
