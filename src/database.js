// database.js - Base de datos local + respaldo/restauración
// En el celular usa SQLite nativo. En el navegador (para pruebas) usa jeep-sqlite.
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { defineCustomElements as jeepSqlite } from 'jeep-sqlite/loader';
import schema from './schema.sql?raw'; // Vite: importa el archivo como texto
import { prepararBase } from './sync-esquema.js';

const DB_NAME = 'caraudio';
export const esWeb = Capacitor.getPlatform() === 'web';
const sqlite = new SQLiteConnection(CapacitorSQLite);
let db = null;
let webListo = false;

// En el navegador hay que pedir que se guarde la base; en el celular se guarda sola
const guardarWeb = async () => { if (esWeb) await sqlite.saveToStore(DB_NAME); };

// Descarga un archivo desde el navegador (respaldos y facturas en modo prueba)
export function descargarArchivo(nombre, datos, tipo = 'application/octet-stream') {
  const blob = datos instanceof Blob ? datos : new Blob([datos], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- Inicio ----------
export async function initDB() {
  if (esWeb && !webListo) {
    jeepSqlite(window);
    if (!document.querySelector('jeep-sqlite')) document.body.append(document.createElement('jeep-sqlite'));
    await customElements.whenDefined('jeep-sqlite');
    await sqlite.initWebStore();
    webListo = true;
  }
  const existe = (await sqlite.isConnection(DB_NAME, false)).result;
  db = existe
    ? await sqlite.retrieveConnection(DB_NAME, false)
    : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await db.open();
  await db.execute('PRAGMA foreign_keys = ON;');
  await db.execute(schema.replace(/--.*$/gm, '')); // sin comentarios, por compatibilidad
  // Bases creadas antes de existir el margen por producto: se agrega la columna (si ya existe, se ignora el error)
  for (const alter of [
    'ALTER TABLE productos ADD COLUMN margen REAL',
    'ALTER TABLE clientes ADD COLUMN condicion TEXT',
    'ALTER TABLE clientes ADD COLUMN dias_credito INTEGER',
    'ALTER TABLE proveedores ADD COLUMN condicion TEXT',
    'ALTER TABLE proveedores ADD COLUMN dias_credito INTEGER',
    'ALTER TABLE ventas ADD COLUMN usuario_id INTEGER',
    'ALTER TABLE compras ADD COLUMN usuario_id INTEGER',
    'ALTER TABLE cotizaciones ADD COLUMN usuario_id INTEGER',
  ]) {
    try { await db.execute(alter); } catch { /* la columna ya existe */ }
  }
  // Sincronización: columnas uid/dirty/act, tablas de control y triggers que marcan los cambios
  // (cada sentencia va sola; los triggers llevan ";" por dentro y el plugin no los puede partir)
  await prepararBase(async (sql) => {
    try { await db.run(sql, [], false); } catch (e) { await db.execute(sql); }
  });
  const [{ n }] = await consultar("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync1_%'");
  syncListo = n >= 60; // 3 por tabla sincronizada + 1 de usuarios
  if (!syncListo) console.warn(`Sincronización no disponible: solo ${n} triggers creados`);
  await guardarWeb();
  return db;
}

// false si esta versión del motor de SQLite no pudo crear los triggers (entonces solo se trabaja en local)
let syncListo = false;
export const sincronizacionLista = () => syncListo;

// Quien quiera enterarse de cada escritura (para sincronizar poco después). La sincronización misma usa lote(), que no avisa.
let alEscribir = null;
export const onEscritura = (fn) => { alEscribir = fn; };

// Usuario que tiene la sesión abierta: queda guardado en cada venta, compra y cotización
let usuarioActualId = null;
export const setUsuarioActual = (id) => { usuarioActualId = id ?? null; };

export const consultar = async (sql, valores = []) =>
  (await db.query(sql, valores)).values ?? [];

export const ejecutar = async (sql, valores = []) => {
  const r = await db.run(sql, valores);
  await guardarWeb();
  alEscribir?.();
  return r;
};

// Varias sentencias en una sola transacción: si una falla, no se guarda ninguna (no avisa a la sincronización)
export const lote = async (sentencias) => {
  const r = await db.executeSet(sentencias, true);
  await guardarWeb();
  return r;
};

export const transaccion = async (sentencias) => {
  const r = await lote(sentencias);
  alEscribir?.();
  return r;
};

// Número de documento. Cada dispositivo conectado a la nube tiene su letra (V-B000012) para que nunca se repitan.
export async function numeroDocumento(prefijo, claveContador) {
  const [{ valor }] = await consultar('SELECT valor FROM config WHERE clave = ?', [claveContador]);
  const [c] = await consultar('SELECT codigo FROM sync_ctl WHERE id = 1');
  return `${prefijo}-${c?.codigo || ''}${String(valor ?? 1).padStart(6, '0')}`;
}

// ---------- Ventas ----------
// items: [{ producto_id, cantidad, precio_unitario, descuento }]
export const redondear = (n) => Math.round(n * 100) / 100;

// El margen se calcula sobre el costo: costo 60 con margen 30 % => precio 78
export const precioDesde = (costo, margen) => redondear(costo * (1 + margen / 100));
export const margenDesde = (costo, precio) => (costo > 0 ? redondear(((precio - costo) / costo) * 100) : null);
// Margen vigente de un producto: el guardado o, si no tiene, el que resulta de su costo y precio actuales
export const margenProducto = (p) => (p.margen != null ? p.margen : margenDesde(p.costo, p.precio));

// metodo_pago 'credito' = venta fiada: exige cliente y admite un pago inicial
export async function registrarVenta({ cliente_id = null, items, servicios = [], descuento = 0, metodo_pago = 'efectivo', notas = '', inicial = 0, dias_credito = null }) {
  if (!items.length && !servicios.length) throw new Error('Agrega al menos un producto o servicio.');
  for (const sv of servicios) {
    if (!String(sv.descripcion || '').trim()) throw new Error('Todos los servicios necesitan una descripción.');
    if (!(sv.cantidad > 0)) throw new Error('La cantidad de un servicio debe ser mayor que cero.');
    if (!(sv.precio_unitario >= 0)) throw new Error('El precio de un servicio no puede ser negativo.');
  }
  // 1. Validar stock
  for (const it of items) {
    const [p] = await consultar('SELECT nombre, stock_actual, costo FROM productos WHERE id = ?', [it.producto_id]);
    if (!p) throw new Error('Producto no existe');
    if (p.stock_actual < it.cantidad) throw new Error(`Stock insuficiente: ${p.nombre} (quedan ${p.stock_actual})`);
    it.costo_unitario = p.costo;
  }

  const subtotal = redondear(items.reduce((s, i) => s + i.cantidad * i.precio_unitario - (i.descuento || 0), 0)
    + servicios.reduce((s, i) => s + i.cantidad * i.precio_unitario, 0));
  if (descuento < 0 || descuento > subtotal + 0.005) throw new Error('El descuento no puede ser mayor que el subtotal.');
  const total = redondear(subtotal - descuento);

  if (metodo_pago === 'credito') {
    if (!cliente_id) throw new Error('Para vender a crédito elige un cliente.');
    if (inicial < 0 || redondear(inicial) > total) throw new Error('El pago inicial no puede ser mayor que el total.');
  }

  const numero = await numeroDocumento('V', 'siguiente_numero_venta');

  // 2. Guardar todo en una sola transacción
  const set = [
    {
      statement: `INSERT INTO ventas (numero, cliente_id, subtotal, descuento, total, metodo_pago, notas, usuario_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [numero, cliente_id, subtotal, descuento, total, metodo_pago, notas, usuarioActualId],
    },
  ];
  for (const it of items) {
    set.push({
      statement: `INSERT INTO venta_detalle (venta_id, producto_id, cantidad, precio_unitario, costo_unitario, descuento)
                  VALUES ((SELECT id FROM ventas WHERE numero = ?), ?, ?, ?, ?, ?)`,
      values: [numero, it.producto_id, it.cantidad, it.precio_unitario, it.costo_unitario, it.descuento || 0],
    });
    set.push({
      statement: 'UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?',
      values: [it.cantidad, it.producto_id],
    });
    set.push({
      statement: `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id)
                  VALUES (?, 'salida', ?, 'venta', (SELECT id FROM ventas WHERE numero = ?))`,
      values: [it.producto_id, -it.cantidad, numero],
    });
  }
  for (const sv of servicios) {
    set.push({
      statement: `INSERT INTO venta_servicios (venta_id, descripcion, cantidad, precio_unitario)
                  VALUES ((SELECT id FROM ventas WHERE numero = ?), ?, ?, ?)`,
      values: [numero, String(sv.descripcion).trim(), sv.cantidad, sv.precio_unitario],
    });
  }
  for (const it of items) {
    const meses = parseInt(it.garantia_meses, 10);
    if (meses > 0) {
      set.push({
        statement: `INSERT INTO garantias (venta_id, producto_id, cliente_id, serie, meses, inicio, vence)
                    VALUES ((SELECT id FROM ventas WHERE numero = ?), ?, ?, ?, ?,
                            date('now','localtime'), date('now','localtime', '+' || ? || ' months'))`,
        values: [numero, it.producto_id, cliente_id, (it.serie || '').trim() || null, meses, meses],
      });
    }
  }
  if (metodo_pago === 'credito' && dias_credito != null && dias_credito >= 0) {
    set.push({
      statement: `INSERT INTO cuentas_cobrar (venta_id, vence)
                  VALUES ((SELECT id FROM ventas WHERE numero = ?), date('now','localtime', '+' || ? || ' days'))`,
      values: [numero, Math.round(dias_credito)],
    });
  }
  if (metodo_pago === 'credito' && inicial > 0) {
    set.push({
      statement: `INSERT INTO pagos (venta_id, monto, metodo, nota)
                  VALUES ((SELECT id FROM ventas WHERE numero = ?), ?, 'efectivo', 'Inicial')`,
      values: [numero, redondear(inicial)],
    });
  }
  set.push({
    statement: "UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = 'siguiente_numero_venta'",
    values: [],
  });

  await transaccion(set);
  return numero;
}

// ---------- Cotizaciones ----------
// items: [{ producto_id|null, descripcion, cantidad, precio_unitario }]
function validarCotizacion(items, descuento) {
  if (!items.length) throw new Error('Agrega al menos una línea a la cotización.');
  for (const it of items) {
    if (!String(it.descripcion || '').trim()) throw new Error('Todas las líneas necesitan una descripción.');
    if (!(it.cantidad > 0)) throw new Error('La cantidad debe ser mayor que cero.');
    if (!(it.precio_unitario >= 0)) throw new Error('El precio no puede ser negativo.');
  }
  const subtotal = redondear(items.reduce((s, i) => s + i.cantidad * i.precio_unitario, 0));
  if (descuento < 0 || descuento > subtotal) throw new Error('El descuento no puede ser mayor que el subtotal.');
  return { subtotal, total: redondear(subtotal - descuento) };
}

export async function registrarCotizacion({ cliente_id = null, cliente_nombre = '', items, descuento = 0, validez_dias = 15, notas = '' }) {
  const { subtotal, total } = validarCotizacion(items, descuento);
  const numero = await numeroDocumento('C', 'siguiente_numero_cotizacion');
  const set = [{
    statement: `INSERT INTO cotizaciones (numero, cliente_id, cliente_nombre, subtotal, descuento, total, validez_dias, notas, usuario_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values: [numero, cliente_id, cliente_id ? null : (cliente_nombre || '').trim() || null, subtotal, descuento, total,
      Math.max(0, Math.round(validez_dias)), notas, usuarioActualId],
  }];
  for (const it of items) {
    set.push({
      statement: `INSERT INTO cotizacion_detalle (cotizacion_id, producto_id, descripcion, cantidad, precio_unitario)
                  VALUES ((SELECT id FROM cotizaciones WHERE numero = ?), ?, ?, ?, ?)`,
      values: [numero, it.producto_id ?? null, String(it.descripcion).trim(), it.cantidad, it.precio_unitario],
    });
  }
  set.push({
    statement: "UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = 'siguiente_numero_cotizacion'",
    values: [],
  });
  await transaccion(set);
  return numero;
}

export async function actualizarCotizacion(id, { cliente_id = null, cliente_nombre = '', items, descuento = 0, validez_dias = 15, notas = '' }) {
  const [c] = await consultar('SELECT estado FROM cotizaciones WHERE id = ?', [id]);
  if (!c) throw new Error('La cotización no existe.');
  if (c.estado === 'facturada') throw new Error('Esta cotización ya se convirtió en venta y no se puede editar.');
  const { subtotal, total } = validarCotizacion(items, descuento);
  const set = [
    { statement: 'DELETE FROM cotizacion_detalle WHERE cotizacion_id = ?', values: [id] },
    {
      statement: `UPDATE cotizaciones SET cliente_id = ?, cliente_nombre = ?, subtotal = ?, descuento = ?, total = ?,
                         validez_dias = ?, notas = ? WHERE id = ?`,
      values: [cliente_id, cliente_id ? null : (cliente_nombre || '').trim() || null, subtotal, descuento, total,
        Math.max(0, Math.round(validez_dias)), notas, id],
    },
  ];
  for (const it of items) {
    set.push({
      statement: `INSERT INTO cotizacion_detalle (cotizacion_id, producto_id, descripcion, cantidad, precio_unitario)
                  VALUES (?, ?, ?, ?, ?)`,
      values: [id, it.producto_id ?? null, String(it.descripcion).trim(), it.cantidad, it.precio_unitario],
    });
  }
  await transaccion(set);
}

export async function cambiarEstadoCotizacion(id, estado) {
  if (!['pendiente', 'aprobada', 'rechazada'].includes(estado)) throw new Error('Estado no válido.');
  const [c] = await consultar('SELECT estado FROM cotizaciones WHERE id = ?', [id]);
  if (!c) throw new Error('La cotización no existe.');
  if (c.estado === 'facturada') throw new Error('Esta cotización ya se convirtió en venta.');
  await ejecutar('UPDATE cotizaciones SET estado = ? WHERE id = ?', [estado, id]);
}

export async function eliminarCotizacion(id) {
  const [c] = await consultar('SELECT estado FROM cotizaciones WHERE id = ?', [id]);
  if (!c) return;
  if (c.estado === 'facturada') throw new Error('Esta cotización ya se convirtió en venta y no se puede eliminar.');
  await transaccion([
    { statement: 'DELETE FROM cotizacion_detalle WHERE cotizacion_id = ?', values: [id] },
    { statement: 'DELETE FROM cotizaciones WHERE id = ?', values: [id] },
  ]);
}

// ---------- Abonos ----------
export async function registrarAbono({ ventaId, monto, metodo = 'efectivo', nota = '' }) {
  const [v] = await consultar(
    `SELECT v.total, v.estado, v.metodo_pago,
            COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.venta_id = v.id), 0) AS pagado
       FROM ventas v WHERE v.id = ?`, [ventaId]);
  if (!v) throw new Error('La venta no existe');
  if (v.metodo_pago !== 'credito') throw new Error('Esta venta no es a crédito.');
  if (v.estado !== 'completada') throw new Error('La venta está anulada.');
  const saldo = redondear(v.total - v.pagado);
  if (!(monto > 0)) throw new Error('Escribe un monto mayor que cero.');
  if (redondear(monto) > saldo) throw new Error(`El abono no puede ser mayor que lo pendiente (${saldo.toFixed(2)}).`);
  await ejecutar('INSERT INTO pagos (venta_id, monto, metodo, nota) VALUES (?,?,?,?)',
    [ventaId, redondear(monto), metodo, nota || null]);
}

// ---------- Compras a proveedores ----------
// items: [{ producto_id, cantidad, costo_unitario, precio_venta (opcional) }]
// Suma las unidades al inventario. Si actualizarCosto es true, el costo de compra pasa a ser el costo del producto;
// si actualizarPrecio es true, el precio_venta de cada línea pasa a ser el precio de venta del producto.
// forma_pago: 'efectivo' | 'tarjeta' | 'transferencia' (se paga todo ahora) | 'credito' (queda por pagar al proveedor).
// En crédito: exige proveedor, admite un pago inicial (inicial, pagado con metodo_inicial) y un plazo en días.
export async function registrarCompra({
  proveedor_id = null, referencia = null, items, actualizarCosto = true, actualizarPrecio = false,
  forma_pago = 'efectivo', inicial = 0, metodo_inicial = 'efectivo', plazo_dias = null,
}) {
  if (!items?.length) throw new Error('Agrega al menos un producto.');
  for (const it of items) {
    if (!Number.isInteger(it.cantidad) || it.cantidad <= 0) throw new Error('Las cantidades deben ser números enteros mayores que cero.');
    if (!(it.costo_unitario >= 0)) throw new Error('El costo de cada producto debe ser un número válido.');
    if (actualizarPrecio && !(it.precio_venta > 0)) throw new Error('El precio de venta de cada producto debe ser mayor que cero.');
    const [p] = await consultar('SELECT id FROM productos WHERE id = ?', [it.producto_id]);
    if (!p) throw new Error('Un producto de la compra ya no existe.');
  }

  const total = redondear(items.reduce((s, i) => s + i.cantidad * i.costo_unitario, 0));
  const credito = forma_pago === 'credito';
  if (credito) {
    if (!proveedor_id) throw new Error('Para comprar a crédito elige un proveedor.');
    if (!(inicial >= 0) || redondear(inicial) > total) throw new Error('El pago inicial no puede ser mayor que el total.');
    if (plazo_dias != null && !(plazo_dias >= 0)) throw new Error('El plazo debe ser un número de días válido.');
  }
  const numero = await numeroDocumento('C', 'siguiente_numero_compra');

  const set = [{
    statement: 'INSERT INTO compras (numero, proveedor_id, referencia, total, usuario_id) VALUES (?, ?, ?, ?, ?)',
    values: [numero, proveedor_id, referencia, total, usuarioActualId],
  }];
  for (const it of items) {
    set.push({
      statement: `INSERT INTO compra_detalle (compra_id, producto_id, cantidad, costo_unitario)
                  VALUES ((SELECT id FROM compras WHERE numero = ?), ?, ?, ?)`,
      values: [numero, it.producto_id, it.cantidad, it.costo_unitario],
    });
    set.push({
      statement: 'UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?',
      values: [it.cantidad, it.producto_id],
    });
    if (actualizarCosto) {
      set.push({ statement: 'UPDATE productos SET costo = ? WHERE id = ?', values: [it.costo_unitario, it.producto_id] });
    }
    if (actualizarPrecio) {
      // El margen de la línea queda guardado en el producto
      const costoFinal = actualizarCosto ? it.costo_unitario : (await consultar('SELECT costo FROM productos WHERE id = ?', [it.producto_id]))[0].costo;
      set.push({
        statement: 'UPDATE productos SET precio = ?, margen = ? WHERE id = ?',
        values: [redondear(it.precio_venta), margenDesde(costoFinal, it.precio_venta), it.producto_id],
      });
    }
    set.push({
      statement: `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id)
                  VALUES (?, 'entrada', ?, 'compra', (SELECT id FROM compras WHERE numero = ?))`,
      values: [it.producto_id, it.cantidad, numero],
    });
  }
  if (credito) {
    set.push({
      statement: `INSERT INTO cuentas_pagar (compra_id, vence)
                  VALUES ((SELECT id FROM compras WHERE numero = ?), ${plazo_dias != null ? "date('now','localtime', '+' || ? || ' days')" : 'NULL'})`,
      values: plazo_dias != null ? [numero, Math.round(plazo_dias)] : [numero],
    });
    if (inicial > 0) {
      set.push({
        statement: `INSERT INTO pagos_compra (compra_id, monto, metodo, nota)
                    VALUES ((SELECT id FROM compras WHERE numero = ?), ?, ?, 'Inicial')`,
        values: [numero, redondear(inicial), metodo_inicial],
      });
    }
  } else if (total > 0) {
    set.push({
      statement: `INSERT INTO pagos_compra (compra_id, monto, metodo, nota)
                  VALUES ((SELECT id FROM compras WHERE numero = ?), ?, ?, 'Pago al contado')`,
      values: [numero, total, forma_pago],
    });
  }
  set.push({
    statement: "UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = 'siguiente_numero_compra'",
    values: [],
  });

  await transaccion(set);
  return numero;
}

// Pago a una compra a crédito (abono a la cuenta por pagar)
export async function registrarPagoCompra({ compraId, monto, metodo = 'efectivo', nota = '' }) {
  const [c] = await consultar(
    `SELECT c.total, c.estado, a.compra_id AS credito,
            (SELECT COALESCE(SUM(monto), 0) FROM pagos_compra WHERE compra_id = c.id) AS pagado
       FROM compras c LEFT JOIN cuentas_pagar a ON a.compra_id = c.id WHERE c.id = ?`, [compraId]);
  if (!c) throw new Error('La compra no existe');
  if (!c.credito) throw new Error('Esta compra no es a crédito.');
  if (c.estado !== 'completada') throw new Error('La compra está anulada.');
  const saldo = redondear(c.total - c.pagado);
  if (!(monto > 0)) throw new Error('Escribe un monto mayor que cero.');
  if (redondear(monto) > saldo) throw new Error(`El pago no puede ser mayor que lo pendiente (${saldo.toFixed(2)}).`);
  await ejecutar('INSERT INTO pagos_compra (compra_id, monto, metodo, nota) VALUES (?,?,?,?)',
    [compraId, redondear(monto), metodo, nota || null]);
}

// Anula la compra y resta las unidades, siempre que todavía estén en el almacén
export async function anularCompra(compraId) {
  const [c] = await consultar('SELECT estado FROM compras WHERE id = ?', [compraId]);
  if (!c) throw new Error('La compra no existe');
  if (c.estado === 'anulada') throw new Error('La compra ya está anulada');

  const items = await consultar('SELECT producto_id, cantidad FROM compra_detalle WHERE compra_id = ?', [compraId]);
  const porProducto = new Map();
  for (const it of items) porProducto.set(it.producto_id, (porProducto.get(it.producto_id) || 0) + it.cantidad);

  for (const [productoId, cantidad] of porProducto) {
    const [p] = await consultar('SELECT nombre, stock_actual FROM productos WHERE id = ?', [productoId]);
    if (p && p.stock_actual < cantidad) {
      throw new Error(`No se puede anular: de "${p.nombre}" solo quedan ${p.stock_actual} y esta compra trajo ${cantidad}. Ya se vendieron o sacaron unidades.`);
    }
  }

  const set = [{ statement: "UPDATE compras SET estado = 'anulada' WHERE id = ?", values: [compraId] }];
  for (const [productoId, cantidad] of porProducto) {
    set.push({
      statement: 'UPDATE productos SET stock_actual = stock_actual - ? WHERE id = ?',
      values: [cantidad, productoId],
    });
    set.push({
      statement: `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id)
                  VALUES (?, 'salida', ?, 'anulacion de compra', ?)`,
      values: [productoId, -cantidad, compraId],
    });
  }
  await transaccion(set);
}

// ---------- Caja diaria ----------
export async function cajaAbierta() {
  const [c] = await consultar("SELECT * FROM caja WHERE estado = 'abierta' ORDER BY id DESC LIMIT 1");
  return c || null;
}

export async function abrirCaja(efectivoInicial) {
  if (!(efectivoInicial >= 0)) throw new Error('Escribe cuánto efectivo hay para empezar (puede ser 0).');
  if (await cajaAbierta()) throw new Error('Ya hay una caja abierta.');
  await ejecutar('INSERT INTO caja (efectivo_inicial) VALUES (?)', [redondear(efectivoInicial)]);
}

// Resumen de un turno de caja: desde su apertura hasta "hasta" (por defecto, el cierre o ahora)
export async function resumenCaja(caja, hasta = null) {
  const fin = hasta || caja.fecha_cierre || '9999-12-31 23:59:59';
  const ventas = await consultar(
    `SELECT metodo_pago AS metodo, COALESCE(SUM(total), 0) AS monto FROM ventas
      WHERE estado = 'completada' AND metodo_pago <> 'credito' AND fecha >= ? AND fecha <= ?
      GROUP BY metodo_pago`, [caja.fecha_apertura, fin]);
  // Abonos e iniciales de ventas a crédito
  const cobros = await consultar(
    `SELECT p.metodo AS metodo, COALESCE(SUM(p.monto), 0) AS monto FROM pagos p
       JOIN ventas v ON v.id = p.venta_id
      WHERE v.estado = 'completada' AND p.fecha >= ? AND p.fecha <= ?
      GROUP BY p.metodo`, [caja.fecha_apertura, fin]);
  const gastos = await consultar(
    `SELECT metodo, COALESCE(SUM(monto), 0) AS monto FROM gastos WHERE caja_id = ? GROUP BY metodo`, [caja.id]);
  // Pagos a proveedores (compras al contado, iniciales y pagos de cuentas por pagar)
  const proveedores = await consultar(
    `SELECT p.metodo AS metodo, COALESCE(SUM(p.monto), 0) AS monto FROM pagos_compra p
       JOIN compras c ON c.id = p.compra_id
      WHERE c.estado = 'completada' AND p.fecha >= ? AND p.fecha <= ?
      GROUP BY p.metodo`, [caja.fecha_apertura, fin]);

  const suma = (filas, m) => redondear(filas.find((f) => f.metodo === m)?.monto || 0);
  const r = {
    inicial: caja.efectivo_inicial,
    ventas_efectivo: suma(ventas, 'efectivo'),
    cobros_efectivo: suma(cobros, 'efectivo'),
    gastos_efectivo: suma(gastos, 'efectivo'),
    proveedores_efectivo: suma(proveedores, 'efectivo'),
    proveedores_otros: redondear(proveedores.filter((x) => x.metodo !== 'efectivo').reduce((t, x) => t + x.monto, 0)),
    tarjeta: redondear(suma(ventas, 'tarjeta') + suma(cobros, 'tarjeta')),
    transferencia: redondear(suma(ventas, 'transferencia') + suma(cobros, 'transferencia')),
    gastos_otros: redondear(gastos.filter((g) => g.metodo !== 'efectivo').reduce((s, g) => s + g.monto, 0)),
  };
  r.esperado = redondear(r.inicial + r.ventas_efectivo + r.cobros_efectivo - r.gastos_efectivo - r.proveedores_efectivo);
  return r;
}

export async function registrarGasto({ concepto, categoria = null, monto, metodo = 'efectivo', nota = null }) {
  const caja = await cajaAbierta();
  if (!caja) throw new Error('Abre la caja para registrar gastos.');
  if (!concepto?.trim()) throw new Error('Escribe en qué se gastó.');
  if (!(monto > 0)) throw new Error('El monto del gasto debe ser mayor que cero.');
  await ejecutar(
    'INSERT INTO gastos (caja_id, concepto, categoria, monto, metodo, nota) VALUES (?,?,?,?,?,?)',
    [caja.id, concepto.trim(), categoria, redondear(monto), metodo, nota]);
}

export async function eliminarGasto(id) {
  const [g] = await consultar(
    'SELECT g.id, c.estado FROM gastos g LEFT JOIN caja c ON c.id = g.caja_id WHERE g.id = ?', [id]);
  if (!g) throw new Error('El gasto no existe');
  if (g.estado === 'cerrada') throw new Error('No se puede eliminar un gasto de una caja ya cerrada.');
  await ejecutar('DELETE FROM gastos WHERE id = ?', [id]);
}

export async function cerrarCaja({ cajaId, contado, notas = '' }) {
  const [c] = await consultar("SELECT * FROM caja WHERE id = ? AND estado = 'abierta'", [cajaId]);
  if (!c) throw new Error('La caja ya está cerrada.');
  if (!(contado >= 0)) throw new Error('Escribe el efectivo contado (puede ser 0).');
  const [{ ahora }] = await consultar("SELECT datetime('now','localtime') AS ahora");
  const r = await resumenCaja(c, ahora);
  await ejecutar(
    `UPDATE caja SET estado = 'cerrada', fecha_cierre = ?, efectivo_esperado = ?, efectivo_contado = ?, diferencia = ?, notas = ?
      WHERE id = ?`,
    [ahora, r.esperado, redondear(contado), redondear(contado - r.esperado), notas || null, cajaId]);
}

// ---------- Anulación ----------
// Marca la venta como anulada y devuelve las unidades al inventario
export async function anularVenta(ventaId) {
  const [v] = await consultar('SELECT estado FROM ventas WHERE id = ?', [ventaId]);
  if (!v) throw new Error('La venta no existe');
  if (v.estado === 'anulada') throw new Error('La venta ya está anulada');

  const items = await consultar('SELECT producto_id, cantidad FROM venta_detalle WHERE venta_id = ?', [ventaId]);
  const set = [
    { statement: "UPDATE ventas SET estado = 'anulada' WHERE id = ?", values: [ventaId] },
    { statement: "UPDATE garantias SET estado = 'anulada' WHERE venta_id = ?", values: [ventaId] },
  ];
  for (const it of items) {
    set.push({
      statement: 'UPDATE productos SET stock_actual = stock_actual + ? WHERE id = ?',
      values: [it.cantidad, it.producto_id],
    });
    set.push({
      statement: `INSERT INTO movimientos_inventario (producto_id, tipo, cantidad, motivo, referencia_id)
                  VALUES (?, 'entrada', ?, 'anulacion', ?)`,
      values: [it.producto_id, it.cantidad, ventaId],
    });
  }
  await transaccion(set);
}

// ---------- Respaldo ----------
export async function crearRespaldo() {
  const exportado = await db.exportToJson('full');
  const texto = JSON.stringify(exportado.export);
  const fecha = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const nombre = `respaldo-caraudio-${fecha}.json`;

  if (esWeb) { // modo prueba en el navegador: se descarga el archivo
    descargarArchivo(nombre, texto, 'application/json');
    return nombre;
  }

  await Filesystem.writeFile({
    path: nombre,
    data: texto,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  });
  const { uri } = await Filesystem.getUri({ path: nombre, directory: Directory.Documents });
  // Permite enviarlo por WhatsApp, Drive, correo, etc.
  await Share.share({ title: 'Respaldo Car Audio', url: uri });
  return nombre;
}

// ---------- Restauración ----------
// archivo: objeto File del <input type="file" accept=".json">
export async function restaurarRespaldo(archivo) {
  const texto = await archivo.text();
  const json = JSON.parse(texto);
  if (!json.tables) throw new Error('El archivo no es un respaldo válido');

  json.overwrite = true; // reemplaza los datos actuales
  const valido = await sqlite.isJsonValid(JSON.stringify(json));
  if (!valido.result) throw new Error('El respaldo está dañado o es incompatible');

  await db.close();
  await sqlite.closeConnection(DB_NAME, false);
  await sqlite.importFromJson(JSON.stringify(json));
  await initDB(); // reabre la base ya restaurada
}
