import { DatabaseSync } from 'node:sqlite';
// Imita lo mínimo de @capacitor-community/sqlite que usa database.js
const bd = new DatabaseSync(':memory:');
const conexion = {
  async open() {},
  async close() {},
  async execute(sql) { bd.exec(sql); return {}; },
  async run(sql, valores = []) { const r = bd.prepare(sql).run(...valores); return { changes: { changes: r.changes, lastId: Number(r.lastInsertRowid) } }; },
  async query(sql, valores = []) { return { values: bd.prepare(sql).all(...valores).map((f) => ({ ...f })) }; },
  async executeSet(set) {
    bd.exec('BEGIN');
    try { for (const s of set) bd.prepare(s.statement).run(...(s.values || [])); bd.exec('COMMIT'); } catch (e) { bd.exec('ROLLBACK'); throw e; }
    return {};
  },
};
export const CapacitorSQLite = {};
export class SQLiteConnection {
  async isConnection() { return { result: false }; }
  async createConnection() { return conexion; }
  async retrieveConnection() { return conexion; }
}
export const __bd = bd;
