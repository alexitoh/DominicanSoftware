// database.js - Base de datos local + respaldo/restauración
// En el celular usa SQLite nativo. En el navegador (para pruebas) usa jeep-sqlite.
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { defineCustomElements as jeepSqlite } from 'jeep-sqlite/loader';
import schema from './schema.sql?raw'; // Vite: importa el archivo como texto
import { prepararBase } from './sync-esquema.js';
import { calcularItbis, TIPOS_NCF, formatearNCF, ncfValido, comprobanteDeCliente, REGLAS_COMPROBANTE_BASE } from './itbis.js';
import { limpiarDocumento } from './fiscal.js';

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
    'ALTER TABLE pagos ADD COLUMN recibo_id INTEGER',
    'ALTER TABLE clientes ADD COLUMN tipo_doc TEXT',
    'ALTER TABLE clientes ADD COLUMN documento TEXT',
    'ALTER TABLE clientes ADD COLUMN limite_credito REAL',
    'ALTER TABLE clientes ADD COLUMN tipo_comprobante TEXT',
    'ALTER TABLE clientes ADD COLUMN regimen_dgii TEXT',
    'ALTER TABLE proveedores ADD COLUMN condicion TEXT',
    'ALTER TABLE proveedores ADD COLUMN dias_credito INTEGER',
    'ALTER TABLE ventas ADD COLUMN usuario_id INTEGER',
    'ALTER TABLE compras ADD COLUMN usuario_id INTEGER',
    'ALTER TABLE cotizaciones ADD COLUMN usuario_id INTEGER',
    'ALTER TABLE productos ADD COLUMN itbis_exento INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE ventas ADD COLUMN itbis REAL NOT NULL DEFAULT 0',
    'ALTER TABLE ventas ADD COLUMN ncf TEXT',
    'ALTER TABLE ventas ADD COLUMN cliente_nombre TEXT',
    'ALTER TABLE compras ADD COLUMN itbis REAL NOT NULL DEFAULT 0',
    'ALTER TABLE compras ADD COLUMN ncf TEXT',
    'ALTER TABLE gastos ADD COLUMN itbis REAL NOT NULL DEFAULT 0',
    'ALTER TABLE gastos ADD COLUMN ncf TEXT',
    'ALTER TABLE gastos ADD COLUMN documento TEXT',
    'ALTER TABLE proveedores ADD COLUMN tipo_doc TEXT',
    'ALTER TABLE proveedores ADD COLUMN documento TEXT',
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
export const usuarioId = () => usuarioActualId;

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
export async function registrarVenta({ cliente_id = null, items, servicios = [], descuento = 0, metodo_pago = 'efectivo', notas = '', inicial = 0, dias_credito = null, tipo_ncf = 'auto', cliente_nombre = '' }) {
  if (!items.length && !servicios.length) throw new Error('Agrega al menos un producto o servicio.');
  // Con la nube conectada no se factura sin internet (ni con comprobante ni sin él): así no se cruzan números entre equipos
  if (reservaNCF?.activo()) await reservaNCF.exigirConexion();
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
  // ITBIS (si la facturación con comprobante está encendida): se suma al precio
  const cfgF = await configFiscal();
  const exentos = new Map();
  for (const it of items) {
    const [px] = await consultar('SELECT itbis_exento FROM productos WHERE id = ?', [it.producto_id]);
    exentos.set(it.producto_id, !!px?.itbis_exento);
  }
  const itbis = calcularItbis({
    lineas: [
      ...items.map((i) => ({ neto: i.cantidad * i.precio_unitario - (i.descuento || 0), exento: exentos.get(i.producto_id) })),
      ...servicios.map((s) => ({ neto: s.cantidad * s.precio_unitario, exento: false })),
    ],
    descuento, tasa: cfgF.tasa, modo: cfgF.modo,
  });
  const total = redondear(subtotal - descuento + (cfgF.modo === 'adicional' ? itbis : 0));

  if (metodo_pago === 'credito') {
    if (!cliente_id) throw new Error('Para vender a crédito elige un cliente.');
    if (inicial < 0 || redondear(inicial) > total) throw new Error('El pago inicial no puede ser mayor que el total.');
    // Solo se fía a clientes a los que Contabilidad les dio crédito (condición Crédito y días) en su perfil
    const [cc] = await consultar('SELECT nombre, condicion, dias_credito FROM clientes WHERE id = ?', [cliente_id]);
    if (!cc) throw new Error('El cliente no existe.');
    if (cc.condicion !== 'credito' || cc.dias_credito == null) {
      throw new Error(`${cc.nombre} no tiene crédito autorizado. Contabilidad debe configurarlo en su perfil de Clientes (condición Crédito y días permitidos); mientras tanto la venta debe ser de contado.`);
    }
    dias_credito = cc.dias_credito; // los días permitidos los fija el perfil del cliente
    // Límite de crédito del cliente: lo que ya debe más lo que queda pendiente de esta venta no puede pasarlo
    const [lim] = await consultar('SELECT nombre, limite_credito FROM clientes WHERE id = ?', [cliente_id]);
    if (lim?.limite_credito > 0) {
      const [{ deuda }] = await consultar(
        `SELECT COALESCE(SUM(v.total - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.venta_id = v.id), 0)), 0) AS deuda
           FROM ventas v WHERE v.cliente_id = ? AND v.estado = 'completada' AND v.metodo_pago = 'credito'`, [cliente_id]);
      const nueva = redondear(total - inicial);
      if (redondear(deuda + nueva) > lim.limite_credito + 0.005) {
        throw new Error(`Supera el límite de crédito de ${lim.nombre} (${redondear(lim.limite_credito)}): ya debe ${redondear(deuda)} y esta venta deja ${nueva} pendiente. Cobra un pago inicial mayor o ajusta el límite en Clientes.`);
      }
    }
  }

  // Con la facturación con comprobante encendida, toda venta lleva comprobante
  const ncf = cfgF.modo === 'no' || (tipo_ncf === 'ninguno' && cfgF.modo !== 'adicional') ? null
    : await siguienteNCF(cliente_id, tipo_ncf === 'ninguno' ? 'auto' : tipo_ncf, cfgF.modo === 'adicional');

  try {
    const numero = await numeroDocumento('V', 'siguiente_numero_venta');

    // 2. Guardar todo en una sola transacción
    const set = [
      {
        statement: `INSERT INTO ventas (numero, cliente_id, subtotal, descuento, total, metodo_pago, notas, usuario_id, itbis, ncf, cliente_nombre)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [numero, cliente_id, subtotal, descuento, total, metodo_pago, notas, usuarioActualId, itbis, ncf?.ncf ?? null,
          cliente_id ? null : (String(cliente_nombre || '').trim().slice(0, 80) || null)],
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
  } catch (e) {
    // El número de comprobante ya se había entregado y la factura no se guardó: ese número queda anulado y hay que repetir la factura
    if (ncf?.clave && reservaNCF) {
      await reservaNCF.anular(ncf.clave, 'La factura no se pudo guardar').catch(() => {});
      await registrarNcfAnulado({ ncf: ncf.ncf, motivo: `La factura no se pudo guardar (${e.message || e})`.slice(0, 200) }).catch(() => {});
      throw new Error(`No se pudo guardar la factura (${e.message || e}). El comprobante ${ncf.ncf} quedó anulado: vuelve a realizar la factura.`);
    }
    throw e;
  }
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

// ---------- Recibos de ingreso (cobros) ----------
export const METODOS_COBRO = ['efectivo', 'tarjeta', 'transferencia', 'cheque'];

// Saldo pendiente de cada factura a crédito de un cliente, de la más antigua a la más nueva
export async function facturasPendientes(clienteId) {
  const filas = await consultar(
    `SELECT v.id, v.numero, v.fecha, v.total, (SELECT vence FROM cuentas_cobrar WHERE venta_id = v.id) AS vence,
            COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.venta_id = v.id), 0) AS pagado
       FROM ventas v
      WHERE v.cliente_id = ? AND v.estado = 'completada' AND v.metodo_pago = 'credito'
      ORDER BY v.id`, [clienteId]);
  return filas.map((v) => ({ ...v, saldo: redondear(v.total - v.pagado) })).filter((v) => v.saldo > 0.005);
}

// Un cobro: uno o varios métodos de pago aplicados a una o varias facturas del cliente (pago parcial o total).
// metodos: [{ metodo, monto, referencia }]  aplicaciones: [{ ventaId, monto }]  (las dos listas deben sumar lo mismo)
// Devuelve { numero, id }.
export async function registrarCobro({ clienteId, metodos, aplicaciones, notas = '' }) {
  const cent = (n) => Math.round(Number(n) * 100);
  if (!clienteId) throw new Error('Elige el cliente.');
  const [cli] = await consultar('SELECT id FROM clientes WHERE id = ?', [clienteId]);
  if (!cli) throw new Error('El cliente no existe.');
  const pagos = (metodos || []).filter((m) => Number(m.monto) > 0);
  const apps = (aplicaciones || []).filter((a) => Number(a.monto) > 0);
  if (!pagos.length) throw new Error('Escribe cuánto te pagó el cliente.');
  if (!apps.length) throw new Error('Elige a qué facturas se aplica el pago.');
  for (const m of pagos) {
    if (!METODOS_COBRO.includes(m.metodo)) throw new Error('Método de pago no válido.');
    if (m.metodo === 'cheque' && !String(m.referencia || '').trim()) throw new Error('Escribe el número de cheque.');
  }
  const recibido = pagos.reduce((s, m) => s + cent(m.monto), 0);
  const aplicado = apps.reduce((s, a) => s + cent(a.monto), 0);
  if (recibido !== aplicado) {
    throw new Error(`Lo recibido (${(recibido / 100).toFixed(2)}) debe ser igual a lo aplicado a las facturas (${(aplicado / 100).toFixed(2)}).`);
  }
  const pendientes = new Map((await facturasPendientes(clienteId)).map((v) => [v.id, v]));
  const vistas = new Set();
  for (const a of apps) {
    const v = pendientes.get(a.ventaId);
    if (!v) throw new Error('Una de las facturas ya no tiene saldo pendiente.');
    if (vistas.has(a.ventaId)) throw new Error('Una factura aparece dos veces.');
    vistas.add(a.ventaId);
    if (cent(a.monto) > cent(v.saldo)) throw new Error(`Lo aplicado a ${v.numero} no puede pasar de lo pendiente (${v.saldo.toFixed(2)}).`);
  }

  const numero = await numeroDocumento('R', 'siguiente_numero_recibo');
  const set = [{
    statement: 'INSERT INTO recibos (numero, cliente_id, total, notas, usuario_id) VALUES (?, ?, ?, ?, ?)',
    values: [numero, clienteId, recibido / 100, notas || null, usuarioActualId],
  }];
  const reciboId = '(SELECT id FROM recibos WHERE numero = ?)';
  for (const m of pagos) {
    set.push({
      statement: `INSERT INTO recibo_metodos (recibo_id, metodo, monto, referencia) VALUES (${reciboId}, ?, ?, ?)`,
      values: [numero, m.metodo, cent(m.monto) / 100, String(m.referencia || '').trim() || null],
    });
  }
  // Se reparte cada método entre las facturas en orden: así cada pago de factura queda con un solo método (la caja lo necesita así)
  const restoMetodo = pagos.map((m) => ({ metodo: m.metodo, resto: cent(m.monto) }));
  let i = 0;
  for (const a of apps) {
    let porAplicar = cent(a.monto);
    while (porAplicar > 0) {
      const m = restoMetodo[i];
      const parte = Math.min(porAplicar, m.resto);
      set.push({
        statement: `INSERT INTO pagos (venta_id, monto, metodo, nota, recibo_id) VALUES (?, ?, ?, ?, ${reciboId})`,
        values: [a.ventaId, parte / 100, m.metodo, `Recibo ${numero}`, numero],
      });
      m.resto -= parte; porAplicar -= parte;
      if (m.resto === 0) i++;
    }
  }
  set.push({ statement: "UPDATE config SET valor = CAST(valor AS INTEGER) + 1 WHERE clave = 'siguiente_numero_recibo'", values: [] });
  await transaccion(set);
  const [r] = await consultar('SELECT id FROM recibos WHERE numero = ?', [numero]);
  return { numero, id: r.id };
}

// Anula un recibo: las facturas vuelven a deber lo que se había cobrado con él
export async function anularRecibo(reciboId) {
  const [r] = await consultar('SELECT estado FROM recibos WHERE id = ?', [reciboId]);
  if (!r) throw new Error('El recibo no existe.');
  if (r.estado === 'anulado') throw new Error('El recibo ya está anulado.');
  await transaccion([
    { statement: "UPDATE recibos SET estado = 'anulado' WHERE id = ?", values: [reciboId] },
    { statement: 'DELETE FROM pagos WHERE recibo_id = ?', values: [reciboId] },
  ]);
  await anotar('Recibo anulado', (await consultar('SELECT numero FROM recibos WHERE id = ?', [reciboId]))[0]?.numero || '');
}

// ---------- Compras a proveedores ----------
// items: [{ producto_id, cantidad, costo_unitario, precio_venta (opcional) }]
// Suma las unidades al inventario. Si actualizarCosto es true, el costo de compra pasa a ser el costo del producto;
// si actualizarPrecio es true, el precio_venta de cada línea pasa a ser el precio de venta del producto.
// forma_pago: 'efectivo' | 'tarjeta' | 'transferencia' (se paga todo ahora) | 'credito' (queda por pagar al proveedor).
// En crédito: exige proveedor, admite un pago inicial (inicial, pagado con metodo_inicial) y un plazo en días.
export async function registrarCompra({
  proveedor_id = null, referencia = null, items, actualizarCosto = true, actualizarPrecio = false,
  forma_pago = 'efectivo', inicial = 0, metodo_inicial = 'efectivo', plazo_dias = null, ncf = null, itbis = 0,
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
  if (!(itbis >= 0) || redondear(itbis) > total) throw new Error('El ITBIS de la compra no es válido.');
  if (ncf && !ncfValido(ncf)) throw new Error('El NCF no tiene el formato correcto (por ejemplo B0100000001).');
  const numero = await numeroDocumento('C', 'siguiente_numero_compra');

  const set = [{
    statement: 'INSERT INTO compras (numero, proveedor_id, referencia, total, usuario_id, itbis, ncf) VALUES (?, ?, ?, ?, ?, ?, ?)',
    values: [numero, proveedor_id, referencia, total, usuarioActualId, redondear(itbis), ncf ? String(ncf).trim().toUpperCase() : null],
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
  await anotar('Caja abierta', `Efectivo inicial ${redondear(efectivoInicial)}`);
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
    cheque: redondear(suma(ventas, 'cheque') + suma(cobros, 'cheque')),
    gastos_otros: redondear(gastos.filter((g) => g.metodo !== 'efectivo').reduce((s, g) => s + g.monto, 0)),
  };
  r.esperado = redondear(r.inicial + r.ventas_efectivo + r.cobros_efectivo - r.gastos_efectivo - r.proveedores_efectivo);
  return r;
}

export async function registrarGasto({ concepto, categoria = null, monto, metodo = 'efectivo', nota = null, ncf = null, itbis = 0, documento = null }) {
  const caja = await cajaAbierta();
  if (!caja) throw new Error('Abre la caja para registrar gastos.');
  if (!concepto?.trim()) throw new Error('Escribe en qué se gastó.');
  if (!(monto > 0)) throw new Error('El monto del gasto debe ser mayor que cero.');
  if (!(itbis >= 0) || redondear(itbis) > redondear(monto)) throw new Error('El ITBIS del gasto no es válido.');
  if (ncf && !ncfValido(ncf)) throw new Error('El NCF no tiene el formato correcto (por ejemplo B0100000001).');
  await ejecutar(
    'INSERT INTO gastos (caja_id, concepto, categoria, monto, metodo, nota, itbis, ncf, documento) VALUES (?,?,?,?,?,?,?,?,?)',
    [caja.id, concepto.trim(), categoria, redondear(monto), metodo, nota, redondear(itbis), ncf ? String(ncf).trim().toUpperCase() : null, documento ? limpiarDocumento(documento) : null]);
  await anotar('Gasto registrado', `${concepto.trim()} ${redondear(monto)}${ncf ? ` (${String(ncf).toUpperCase()})` : ''}`);
}

export async function eliminarGasto(id) {
  const [g] = await consultar(
    'SELECT g.id, c.estado FROM gastos g LEFT JOIN caja c ON c.id = g.caja_id WHERE g.id = ?', [id]);
  if (!g) throw new Error('El gasto no existe');
  if (g.estado === 'cerrada') throw new Error('No se puede eliminar un gasto de una caja ya cerrada.');
  const [gd] = await consultar('SELECT concepto, monto FROM gastos WHERE id = ?', [id]);
  await ejecutar('DELETE FROM gastos WHERE id = ?', [id]);
  await anotar('Gasto eliminado', `${gd?.concepto || ''} ${gd?.monto ?? ''}`.trim());
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
  await anotar('Caja cerrada', `Esperado ${r.esperado}, contado ${redondear(contado)}, diferencia ${redondear(contado - r.esperado)}`);
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
  await Share.share({ title: 'Respaldo Dominican Software', url: uri });
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

// ---------- Datos fiscales: ITBIS y secuencias de NCF (las secuencias son de este dispositivo) ----------
export async function configFiscal() {
  const f = Object.fromEntries((await consultar("SELECT clave, valor FROM config WHERE clave IN ('itbis_modo','itbis_tasa')")).map((r) => [r.clave, r.valor]));
  const tasa = parseFloat(f.itbis_tasa);
  const modo = f.itbis_modo === 'incluido' ? 'incluido' : f.itbis_modo === 'adicional' ? 'adicional' : 'no';
  return { modo, activo: modo !== 'no', tasa: tasa > 0 ? tasa : 18 };
}

// Secuencias autorizadas por la DGII: ncf_<tipo>_sig (próximo número) y ncf_<tipo>_hasta (último autorizado)
export async function leerSecuenciasNCF() {
  const filas = await consultar("SELECT clave, valor FROM config WHERE clave LIKE 'ncf\\_%' ESCAPE '\\'");
  const c = Object.fromEntries(filas.map((r) => [r.clave, r.valor]));
  return Object.keys(TIPOS_NCF).map((tipo) => ({
    tipo, sig: parseInt(c[`ncf_${tipo}_sig`], 10) || 0, hasta: parseInt(c[`ncf_${tipo}_hasta`], 10) || 0,
  }));
}

// En un equipo conectado a la nube las secuencias son del negocio (viven en el servidor) y cada factura pide su número ahí: hace falta internet.
// nube-app.js registra este enlace; sin nube (o sin enlace) se usan las secuencias de este dispositivo.
let reservaNCF = null; // { activo(), exigirConexion(), pedir(candidatos, clave) → {tipo, numero}, anular(clave, motivo) }
export const configurarReservaNCF = (r) => { reservaNCF = r; };

// Vacía lo que este equipo tenía de un tipo (cuando esos números pasan a administrarse desde el servidor)
export async function limpiarSecuenciaLocalNCF(tipo) {
  if (!TIPOS_NCF[tipo]) return;
  for (const k of [`ncf_${tipo}_sig`, `ncf_${tipo}_hasta`]) await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [k, '0']);
}

export async function guardarSecuenciaNCF(tipo, sig, hasta) {
  if (!TIPOS_NCF[tipo]) throw new Error('Tipo de NCF desconocido.');
  if (sig && hasta && sig > hasta) throw new Error('El número inicial no puede ser mayor que el final.');
  for (const [k, v] of [[`ncf_${tipo}_sig`, sig || 0], [`ncf_${tipo}_hasta`, hasta || 0]]) {
    await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', [k, String(v)]);
  }
}

// Reglas "si el régimen o categoría de la DGII contiene X → comprobante Y" (se editan en Ajustes; se comparten entre dispositivos)
export async function leerReglasComprobante() {
  const [r] = await consultar("SELECT valor FROM config WHERE clave = 'cpb_reglas'");
  try {
    const v = JSON.parse(r?.valor || 'null');
    if (Array.isArray(v)) return v.filter((x) => x && typeof x.texto === 'string' && TIPOS_NCF[x.tipo]);
  } catch { /* se usan las reglas base */ }
  return REGLAS_COMPROBANTE_BASE;
}
export async function guardarReglasComprobante(reglas) {
  const limpias = (reglas || []).map((r) => ({ texto: String(r.texto || '').trim().toUpperCase().slice(0, 60), tipo: r.tipo })).filter((r) => r.texto);
  if (limpias.some((r) => !TIPOS_NCF[r.tipo])) throw new Error('Elige el comprobante de cada regla.');
  await ejecutar('INSERT OR REPLACE INTO config (clave, valor) VALUES (?, ?)', ['cpb_reglas', JSON.stringify(limpias)]);
}

// Tipo de comprobante: 'auto' elige B01 (crédito fiscal) si el cliente tiene RNC y hay secuencia B01; si no, B02 (si no hay secuencia, la venta queda sin NCF).
// Si se pide un tipo concreto, se exige que se pueda emitir: B01, B14 y B15 necesitan un cliente con RNC, y todos una secuencia autorizada con números disponibles.
async function siguienteNCF(clienteId, pedido = 'auto', obligatorio = false) {
  const enNube = !!reservaNCF?.activo();
  const sec = enNube ? null : await leerSecuenciasNCF();
  // Con la nube no se sabe qué hay disponible hasta preguntarle al servidor: se arma la lista de preferencia y él elige
  const util = (t) => sec.find((s) => s.tipo === t && s.sig > 0 && s.sig <= s.hasta);
  let cli = null;
  if (clienteId) [cli] = await consultar('SELECT tipo_doc, documento, tipo_comprobante, regimen_dgii FROM clientes WHERE id = ?', [clienteId]);
  const tieneRnc = !!cli?.documento && limpiarDocumento(cli.documento).length === 9;
  let candidatos; let ideal = null; let motivo = '';
  if (pedido && pedido !== 'auto') {
    if (!TIPOS_NCF[pedido]) throw new Error('Tipo de comprobante desconocido.');
    if (pedido !== 'B02' && !tieneRnc) throw new Error(`El comprobante ${pedido} (${TIPOS_NCF[pedido]}) necesita un cliente con RNC.`);
    candidatos = [pedido];
  } else {
    // Automático: el tipo que le corresponde al cliente según su ficha, su RNC y su régimen en la DGII
    ({ tipo: ideal, motivo } = comprobanteDeCliente(cli, await leerReglasComprobante()));
    candidatos = !obligatorio && ideal !== 'B02' ? [ideal, 'B02'] : [ideal];
  }
  let tipo = null; let numero = 0; let clave = null;
  if (enNube) {
    clave = claveAleatoria();
    const r = await reservaNCF.pedir(candidatos, clave); // lanza un error claro si no hay internet
    if (r?.tipo) { tipo = r.tipo; numero = r.numero; }
  } else {
    const t = candidatos.find(util);
    if (t) { tipo = t; numero = util(t).sig; await ejecutar('UPDATE config SET valor = ? WHERE clave = ?', [String(numero + 1), `ncf_${t}_sig`]); }
  }
  if (!tipo) {
    if (pedido && pedido !== 'auto') throw new Error(`No hay números disponibles de ${pedido} (${TIPOS_NCF[pedido]}). Registra la secuencia autorizada por la DGII en Ajustes → Facturación con comprobante o elige otro tipo de comprobante.`);
    if (obligatorio) throw new Error(`A este cliente le corresponde ${ideal} (${TIPOS_NCF[ideal]}; ${motivo}), pero no hay números disponibles. Registra la secuencia en Ajustes → Facturación con comprobante o elige otro tipo de comprobante.`);
    return null;
  }
  return { ncf: formatearNCF(tipo, numero), tipo, clave };
}

const claveAleatoria = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`).replace(/-/g, '');

// Anota en la bitácora (quién hizo qué). Nunca interrumpe la operación que se está registrando.
export async function anotar(accion, detalle = '') {
  try {
    await ejecutar('INSERT INTO bitacora (usuario_id, usuario, accion, detalle) VALUES (?, (SELECT usuario FROM usuarios WHERE id = ?), ?, ?)',
      [usuarioActualId, usuarioActualId, accion, String(detalle || '').slice(0, 300)]);
  } catch { /* la bitácora no debe frenar el trabajo */ }
}

// Un comprobante que el sistema entregó y la factura no se guardó: queda anulado, anotado en la bitácora y listo para el formato 608
export async function registrarNcfAnulado({ ncf, motivo = 'La factura no se pudo guardar', origen = 'sistema' }) {
  const [ya] = await consultar('SELECT id FROM ncf_anulados WHERE ncf = ?', [ncf]);
  if (ya) return false;
  await ejecutar('INSERT INTO ncf_anulados (ncf, tipo, motivo, origen, usuario_id) VALUES (?, ?, ?, ?, ?)', [ncf, String(ncf).slice(0, 3), motivo, origen, usuarioActualId]);
  await ejecutar("INSERT INTO bitacora (usuario_id, usuario, accion, detalle) VALUES (?, (SELECT usuario FROM usuarios WHERE id = ?), 'Comprobante anulado por el sistema', ?)",
    [usuarioActualId, usuarioActualId, `${ncf}: ${motivo}. Revisa el formato 608 en Contabilidad → Reportes → Impuestos.`]);
  return true;
}

export async function asignarNCFVenta(ventaId, ncf) {
  const v = String(ncf || '').trim().toUpperCase();
  if (v && !ncfValido(v)) throw new Error('El NCF no tiene el formato correcto (por ejemplo B0200000001).');
  if (v) {
    const [u] = await consultar('SELECT numero FROM ventas WHERE ncf = ? AND id <> ?', [v, ventaId]);
    if (u) throw new Error(`Ese NCF ya se usó en la venta ${u.numero}.`);
  }
  await ejecutar('UPDATE ventas SET ncf = ? WHERE id = ?', [v || null, ventaId]);
}

// Guarda un archivo de texto (reportes TXT/CSV): descarga en el navegador o lo comparte desde el teléfono
export async function exportarTexto(nombre, texto, tipo = 'text/plain') {
  if (esWeb) { descargarArchivo(nombre, texto, `${tipo};charset=utf-8`); return nombre; }
  await Filesystem.writeFile({ path: nombre, data: texto, directory: Directory.Documents, encoding: Encoding.UTF8 });
  const { uri } = await Filesystem.getUri({ path: nombre, directory: Directory.Documents });
  await Share.share({ title: nombre, url: uri });
  return nombre;
}
