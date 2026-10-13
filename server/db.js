// db.js (servidor) - base SQLite con negocios, cuentas, dispositivos y el estado sincronizado de cada negocio
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const TABLAS_SYNC = [
  'categorias', 'productos', 'clientes', 'proveedores', 'ventas', 'venta_detalle', 'venta_servicios', 'pagos',
  'cuentas_cobrar', 'garantias', 'garantia_reclamos', 'compras', 'compra_detalle', 'cuentas_pagar', 'pagos_compra',
  'caja', 'gastos', 'cotizaciones', 'cotizacion_detalle', 'movimientos_inventario', 'bitacora', 'config',
];

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
    CREATE TABLE IF NOT EXISTS cuentas (
      uid TEXT PRIMARY KEY,
      negocio TEXT NOT NULL REFERENCES negocios(uid),
      nombre TEXT NOT NULL,
      usuario TEXT NOT NULL UNIQUE,
      correo TEXT UNIQUE,
      rol TEXT NOT NULL DEFAULT 'vendedor',
      permisos TEXT,
      activo INTEGER NOT NULL DEFAULT 1,
      hash TEXT NOT NULL,
      recup_hash TEXT,
      debe_cambiar INTEGER NOT NULL DEFAULT 0,
      creado TEXT NOT NULL DEFAULT (datetime('now')),
      ultimo_acceso TEXT
    );
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
  for (const q of ['ALTER TABLE negocios ADD COLUMN notas TEXT', 'ALTER TABLE negocios ADD COLUMN aprobado TEXT']) {
    try { db.exec(q); } catch { /* la columna ya existe */ }
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
