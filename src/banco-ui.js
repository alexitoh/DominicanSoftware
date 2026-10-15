// banco-ui.js - pantallas del módulo Banco: Cargo, Cheque, Depósito, Transferencia, Crédito, Solicitud de pago, Tipo de cuenta, Moneda y reportes
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import { consultar } from './database.js';
import { listarCuentas, fechaHoy, listarBancos } from './conta-db.js';
import { tienePermiso } from './auth.js';
import { listarMonedas, guardarMoneda, eliminarMoneda } from './finanzas-db.js';
import {
  listarTiposCuenta, guardarTipoCuenta, eliminarTipoCuenta, listarMovsBanco, anularMovBanco, anularCheque, ESTADOS_CHEQUE, CONCEPTOS_CARGO,
  registrarCargo, registrarDeposito, registrarTransferencia, emitirCheque, calcularCuota, tablaAmortizacion,
  crearCredito, listarCreditos, detalleCredito, pagarCreditoCuota, anularPagoCredito, anularCredito,
  crearSolicitudPago, listarSolicitudesPago, aprobarSolicitudPago, rechazarSolicitudPago, pagarSolicitudPago, ESTADOS_SOLICITUD_PAGO,
  reporteBanco, movimientosBancoDin, tablaDinamicaBanco, TIPOS_DOC_BANCO, DIMENSIONES_BANCO,
} from './banco-db.js';
import { selectDe } from './cxp-docs.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, vacio, fechaCorta, limpiar, renglon, botonCSV } from './conta-ui-comun.js';

const selectBancos = (bancos, { valor = '', etiqueta = 'Cuenta bancaria', todos = null } = {}) =>
  selectDe(bancos.filter((b) => b.activo).map((b) => [b.id, b.nombre]), { valor, vacioTexto: todos, etiqueta });
const aviso = (t) => h('p', { class: 'ayuda' }, t);

// ---------- Lista de movimientos de una clase (cargos, depósitos, transferencias, cheques) ----------
const CLASES = {
  cargo: { vacio: 'Aún no hay cargos bancarios.', nuevo: 'Nuevo cargo bancario', ayuda: 'Comisiones e impuestos que el banco te descuenta. Salen de la cuenta y van al gasto "Comisiones bancarias".' },
  deposito: { vacio: 'Aún no hay depósitos.', nuevo: 'Nuevo depósito bancario', ayuda: 'Dinero que entra a una cuenta. Por defecto sale de Caja general; si viene de otra cuenta contable, la eliges.' },
  transferencia: { vacio: 'Aún no hay transferencias.', nuevo: 'Nueva transferencia bancaria', ayuda: 'Mueve dinero entre tus cuentas bancarias. No cambia el total, solo de qué cuenta está.' },
  cheque: { vacio: 'Aún no hay cheques emitidos.', nuevo: 'Emitir cheque', ayuda: 'Cada cheque sale de la cuenta contra la cuenta contable que paga (gasto o deuda). Queda "en tránsito" hasta que lo concilies con el estado de cuenta.' },
};

export async function seccionMovsBanco(raiz, recargar, clase) {
  const bancos = await listarBancos();
  const cfg = CLASES[clase];
  const filtro = selectBancos(bancos, { todos: 'Todas las cuentas', etiqueta: 'Filtrar por cuenta' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Buscar por número, referencia o detalle', 'aria-label': 'Buscar' });
  const lista = h('div'); const resumen = h('div', { class: 'totales' });
  let movs = [];
  async function cargar() { movs = await listarMovsBanco(clase, { bancoId: Number(filtro.value) || null }); pintar(); }
  function pintar() {
    const q = buscar.value.trim().toLowerCase();
    const vis = movs.filter((m) => m.estado === 'vigente' || clase === 'cheque').filter((m) => !q || `${m.numero} ${m.referencia || ''} ${m.detalle || ''} ${m.beneficiario || ''}`.toLowerCase().includes(q));
    const vigentes = vis.filter((m) => m.estado === 'vigente');
    resumen.replaceChildren(renglon(clase === 'cheque' ? 'Cheques emitidos' : 'Total', dinero(vigentes.reduce((s, m) => s + m.monto, 0)), 'gran'), renglon('Movimientos', String(vigentes.length)),
      clase === 'cheque' ? renglon('En tránsito', dinero(vis.filter((m) => m.estado_cheque === 'transito').reduce((s, m) => s + m.monto, 0))) : null);
    lista.replaceChildren(vis.length ? h('div', { class: 'lista' }, vis.map((m) => h('div', { class: `fila inventario ${m.estado === 'anulado' ? 'apagada' : ''}` },
      h('span', { class: 'datos' },
        h('strong', {}, clase === 'cheque' ? `Cheque ${m.referencia} · ${m.beneficiario || ''}` : `${m.numero} · ${m.banco}${m.destino ? ` → ${m.destino}` : ''}`),
        h('small', {}, [fechaCorta(m.fecha), clase === 'cheque' ? `${m.banco} · ${ESTADOS_CHEQUE[m.estado_cheque]}` : (m.detalle || m.referencia), m.contra_nombre && `${m.contra_codigo} ${m.contra_nombre}`].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, dinero(m.monto)),
      m.estado === 'vigente' && (clase !== 'cheque' || m.estado_cheque === 'transito') ? h('button', { class: 'btn chico', 'aria-label': `Anular ${m.numero}`, onClick: async () => {
        if (!(await confirmar('Anular movimiento', `Se anulará ${m.numero}.`, 'Anular'))) return;
        try { await (clase === 'cheque' ? anularCheque(m.id) : anularMovBanco(m.id)); toast('Anulado'); await recargar(); } catch (e) { toast(limpiar(e), 'error'); }
      } }, 'Anular') : null))) : vacio(cfg.vacio));
  }
  async function nuevo() {
    const cuentas = await listarCuentas(true);
    const banco = selectBancos(bancos, { valor: bancos.find((b) => b.predeterminada)?.id ?? '' });
    const fecha = fechaInput(fechaHoy()); const monto = numero(''); const ref = texto('', clase === 'cheque' ? 'Número del cheque' : 'Referencia (opcional)'); const det = texto('', 'Detalle (opcional)');
    const error = h('p', { class: 'error', role: 'alert' });
    const extra = [];
    let guardar;
    if (clase === 'cargo') {
      const conc = selectDe(CONCEPTOS_CARGO.map((c) => [c, c]), { etiqueta: 'Concepto' }); const otro = texto('', 'Escribe el concepto');
      const ver = () => { otroBox.style.display = conc.value === 'Otro' ? '' : 'none'; }; const otroBox = campo('Otro concepto', otro); conc.addEventListener('change', ver); ver();
      extra.push(campo('Concepto', conc), otroBox);
      guardar = () => registrarCargo({ banco_id: Number(banco.value), fecha: fecha.value, monto: monto.value, concepto: conc.value === 'Otro' ? otro.value : conc.value, referencia: ref.value });
    } else if (clase === 'deposito') {
      const origen = selectCuentas(cuentas, { vacioTexto: 'Caja general (por defecto)' });
      extra.push(campo('De dónde viene el dinero', origen), campo('Detalle', det));
      guardar = () => registrarDeposito({ banco_id: Number(banco.value), fecha: fecha.value, monto: monto.value, origen_cuenta_id: Number(origen.value) || null, referencia: ref.value, detalle: det.value });
    } else if (clase === 'transferencia') {
      const destino = selectBancos(bancos, { etiqueta: 'Cuenta destino', valor: bancos.filter((b) => b.activo)[1]?.id ?? '' });
      extra.push(campo('Transferir a', destino), campo('Detalle', det));
      guardar = () => registrarTransferencia({ banco_id: Number(banco.value), banco_destino_id: Number(destino.value), fecha: fecha.value, monto: monto.value, referencia: ref.value, detalle: det.value });
    } else {
      const benef = texto('', 'A nombre de'); const contra = selectCuentas(cuentas, { vacioTexto: '— Cuenta que paga el cheque —' });
      extra.push(campo('A nombre de', benef), campo('Se aplica a', contra, 'El gasto o la deuda que este cheque paga.'), campo('Detalle', det));
      guardar = () => emitirCheque({ banco_id: Number(banco.value), fecha: fecha.value, monto: monto.value, numero_cheque: ref.value, beneficiario: benef.value, contra_cuenta_id: Number(contra.value) || null, detalle: det.value });
    }
    if (!bancos.some((b) => b.activo)) { toast('Primero crea una cuenta bancaria en la sección Banco', 'error'); return; }
    const cerrar = hoja(cfg.nuevo, h('div', { class: 'cuerpo' }, aviso(cfg.ayuda), campo('Cuenta bancaria', banco), h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Monto', monto)),
      campo(clase === 'cheque' ? 'Número de cheque' : 'Referencia', ref), ...extra, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try { await guardar(); cerrar(); toast('Guardado'); await recargar(); } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }
  filtro.addEventListener('change', cargar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(aviso(cfg.ayuda), h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nuevo }, cfg.nuevo)), filtro, buscar, resumen, lista);
  await cargar();
}

// ---------- Crédito Bancario ----------
export async function seccionCreditos(raiz, recargar) {
  const bancos = await listarBancos();
  const creditos = await listarCreditos();
  async function nuevo() {
    if (!bancos.some((b) => b.activo)) { toast('Primero crea una cuenta bancaria en la sección Banco', 'error'); return; }
    const entidad = texto('', 'Ej. Banreservas'); const banco = selectBancos(bancos, { valor: bancos.find((b) => b.predeterminada)?.id ?? '', etiqueta: 'Cuenta donde se deposita' });
    const monto = numero(''); const tasa = numero('', '0'); const plazo = numero('', '1'); plazo.setAttribute('step', '1'); const fecha = fechaInput(fechaHoy()); const notas = texto('', 'Opcional');
    const cuota = h('div', { class: 'totales' }); const error = h('p', { class: 'error', role: 'alert' });
    const verCuota = () => { const c = calcularCuota(Number(monto.value), Number(tasa.value), Number(plazo.value)); cuota.replaceChildren(renglon('Cuota mensual estimada', c ? dinero(c) : '—', 'gran')); };
    for (const el of [monto, tasa, plazo]) el.addEventListener('input', verCuota); verCuota();
    const cerrar = hoja('Nuevo crédito bancario', h('div', { class: 'cuerpo' },
      aviso('El dinero entra a la cuenta elegida y queda como deuda en "Créditos bancarios por pagar". Cada cuota baja la deuda (capital) y paga el interés del mes.'),
      campo('Entidad financiera', entidad), campo('Cuenta donde se deposita', banco), h('div', { class: 'rejilla' }, campo('Fecha del desembolso', fecha), campo('Monto', monto)),
      h('div', { class: 'rejilla' }, campo('Tasa anual (%)', tasa), campo('Plazo (meses)', plazo)), cuota, campo('Notas', notas), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try { await crearCredito({ fecha: fecha.value, entidad: entidad.value, banco_id: Number(banco.value), monto: monto.value, tasa_anual: tasa.value || 0, plazo_meses: plazo.value, notas: notas.value }); cerrar(); toast('Crédito registrado'); await recargar(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Registrar crédito'))));
  }
  async function detalle(id) {
    const c = await detalleCredito(id);
    const error = h('p', { class: 'error', role: 'alert' });
    const banco = selectBancos(bancos, { valor: c.banco_id, etiqueta: 'Pagar desde' }); const fecha = fechaInput(fechaHoy());
    const monto = numero(''); const ref = texto('', 'Referencia (opcional)');
    let amort = false; const cuerpoAm = h('div');
    const pintarAm = () => cuerpoAm.replaceChildren(...(amort ? [tabla(['#', 'Cuota', 'Interés', 'Capital', 'Saldo'], c.amortizacion.map((f) => [String(f.n), dinero(f.cuota), dinero(f.interes), dinero(f.capital), dinero(f.saldo)]), { num: [1, 2, 3, 4] })] : []));
    const cerrar = hoja(`${c.numero} · ${c.entidad || 'Crédito'}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Debes', dinero(c.saldo), 'gran'), renglon('Monto original', dinero(c.monto)), renglon('Cuota mensual', dinero(c.cuota)),
        renglon('Tasa / plazo', `${c.tasa_anual}% · ${c.plazo_meses} meses`), renglon('Capital pagado', dinero(c.capital_pagado)), renglon('Intereses pagados', dinero(c.interes_pagado))),
      c.estado !== 'vigente' ? h('p', { class: 'error' }, 'Este crédito está anulado.') : c.saldo > 0.004 ? h('div', { class: 'cuerpo sin-borde' },
        h('h3', {}, 'Pagar cuota'), aviso(`Interés de este mes: ${dinero(c.proximoInteres)}. Deja el monto vacío para pagar la cuota normal; si pones más, el sobrante abona al capital.`),
        h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Monto (opcional)', monto)), campo('Pagar desde', banco), campo('Referencia', ref),
        h('button', { class: 'btn primario', onClick: async () => {
          error.textContent = '';
          try { const r = await pagarCreditoCuota({ credito_id: c.id, fecha: fecha.value, banco_id: Number(banco.value), monto: monto.value === '' ? null : monto.value, referencia: ref.value }); cerrar(); toast(`Cuota pagada (capital ${dinero(r.capital)} + interés ${dinero(r.interes)})`); await recargar(); }
          catch (e) { error.textContent = limpiar(e); }
        } }, 'Pagar cuota')) : h('p', { class: 'ayuda' }, 'Crédito pagado por completo.'),
      error,
      c.pagos.length ? h('h3', {}, 'Pagos') : null,
      c.pagos.length ? h('div', { class: 'lista' }, c.pagos.map((p) => h('div', { class: `fila inventario ${p.estado === 'anulado' ? 'apagada' : ''}` },
        h('span', { class: 'datos' }, h('strong', {}, `${p.numero} · ${fechaCorta(p.fecha)}`), h('small', {}, `Capital ${dinero(p.capital)} · interés ${dinero(p.interes)} · ${p.banco}${p.estado === 'anulado' ? ' · anulado' : ''}`)),
        h('span', { class: 'precio' }, dinero(p.capital + p.interes)),
        p.estado === 'vigente' && c.estado === 'vigente' ? h('button', { class: 'btn chico', onClick: async () => { try { await anularPagoCredito(p.id); cerrar(); toast('Pago anulado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Anular') : null))) : null,
      h('div', { class: 'acciones' },
        h('button', { class: 'btn', onClick: () => { amort = !amort; pintarAm(); } }, 'Ver tabla de amortización'),
        c.estado === 'vigente' && !c.n_pagos ? h('button', { class: 'btn peligro', onClick: async () => { if (!(await confirmar('Anular crédito', `Se anulará ${c.numero} y su desembolso.`, 'Anular'))) return; try { await anularCredito(c.id); cerrar(); toast('Crédito anulado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Anular crédito') : null),
      cuerpoAm));
    pintarAm();
  }
  const vivos = creditos.filter((c) => c.estado === 'vigente');
  raiz.replaceChildren(aviso('Préstamos con el banco: el desembolso entra a tu cuenta, la deuda queda en Créditos bancarios por pagar y cada cuota separa capital e interés.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nuevo }, 'Nuevo crédito bancario')),
    h('div', { class: 'totales' }, renglon('Debes al banco', dinero(vivos.reduce((s, c) => s + c.saldo, 0)), 'gran'), renglon('Créditos vigentes', String(vivos.filter((c) => c.saldo > 0.004).length))),
    creditos.length ? h('div', { class: 'lista' }, creditos.map((c) => h('button', { class: `fila inventario ${c.estado === 'anulado' ? 'apagada' : ''}`, onClick: () => detalle(c.id) },
      h('span', { class: 'datos' }, h('strong', {}, `${c.numero} · ${c.entidad || 'Crédito'}`), h('small', {}, `${fechaCorta(c.fecha)} · ${c.tasa_anual}% · ${c.plazo_meses} meses · cuota ${dinero(c.cuota)}${c.estado === 'anulado' ? ' · anulado' : ''}`)),
      h('span', { class: 'precio' }, dinero(c.saldo))))) : vacio('Aún no hay créditos bancarios.'));
}

// ---------- Solicitud de Pago ----------
export async function seccionSolicitudesPago(raiz, recargar) {
  const [bancos, sols] = [await listarBancos(), await listarSolicitudesPago()];
  const puedeAprobar = tienePermiso('autorizar_pagos');
  async function nueva() {
    const cuentas = await listarCuentas(true);
    const provs = await consultar('SELECT id, nombre FROM proveedores ORDER BY nombre COLLATE NOCASE');
    const prov = selectDe(provs.map((p) => [p.id, p.nombre]), { vacioTexto: 'Otro beneficiario (no es suplidor)', etiqueta: 'Suplidor' });
    const benef = texto('', 'A quién se le paga'); const contra = selectCuentas(cuentas, { vacioTexto: '— Cuenta que paga (gasto o deuda) —' });
    const concepto = texto('', 'Concepto'); const monto = numero(''); const fecha = fechaInput(fechaHoy()); const forma = selectDe([['cheque', 'Cheque'], ['transferencia', 'Transferencia']], { etiqueta: 'Forma de pago' });
    const notas = texto('', 'Opcional'); const error = h('p', { class: 'error', role: 'alert' });
    const otroBox = h('div', { class: 'cuerpo sin-borde' }, campo('A nombre de', benef), campo('Se aplica a', contra, 'El gasto o la deuda que este pago cubre.'));
    const ver = () => { otroBox.style.display = prov.value ? 'none' : ''; }; prov.addEventListener('change', ver); ver();
    const cerrar = hoja('Nueva solicitud de pago', h('div', { class: 'cuerpo' },
      aviso('La solicitud no mueve dinero: primero se aprueba y luego se paga con cheque o transferencia. Si es para un suplidor, el pago baja sus facturas pendientes.'),
      campo('Suplidor', prov), otroBox, campo('Concepto', concepto), h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo('Monto', monto)), campo('Forma de pago', forma), campo('Notas', notas), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        error.textContent = '';
        try { await crearSolicitudPago({ fecha: fecha.value, proveedor_id: Number(prov.value) || null, beneficiario: benef.value, concepto: concepto.value, monto: monto.value, forma: forma.value, contra_cuenta_id: Number(contra.value) || null, notas: notas.value }); cerrar(); toast('Solicitud creada'); await recargar(); }
        catch (e) { error.textContent = limpiar(e); }
      } }, 'Crear solicitud'))));
  }
  function detalle(s) {
    const error = h('p', { class: 'error', role: 'alert' });
    const banco = selectBancos(bancos, { valor: bancos.find((b) => b.predeterminada)?.id ?? '', etiqueta: 'Pagar desde' }); const fecha = fechaInput(fechaHoy());
    const ref = texto('', s.forma === 'cheque' ? 'Número del cheque' : 'Referencia (opcional)'); const motivo = texto('', 'Motivo (opcional)');
    const accion = (fn, msg) => async () => { error.textContent = ''; try { await fn(); cerrar(); toast(msg); await recargar(); } catch (e) { error.textContent = limpiar(e); } };
    const cerrar = hoja(`Solicitud ${s.numero}`, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, renglon('Monto', dinero(s.monto), 'gran'), renglon('Estado', ESTADOS_SOLICITUD_PAGO[s.estado]), renglon('Forma', s.forma === 'cheque' ? 'Cheque' : 'Transferencia'), s.aprobado_por ? renglon('Aprobada por', s.aprobado_por) : null),
      aviso([s.beneficiario, s.concepto, fechaCorta(s.fecha), s.contra_nombre && `Se aplica a ${s.contra_codigo} ${s.contra_nombre}`, s.mov_numero && `Movimiento ${s.mov_numero}`, s.notas].filter(Boolean).join(' · ')),
      error,
      s.estado === 'pendiente' ? h('div', { class: 'acciones' },
        puedeAprobar ? h('button', { class: 'btn primario', onClick: accion(() => aprobarSolicitudPago(s.id), 'Solicitud aprobada') }, 'Aprobar') : h('p', { class: 'ayuda' }, 'Solo quien tiene permiso de aprobar pagos puede aprobarla.'),
        puedeAprobar ? h('button', { class: 'btn peligro', onClick: accion(() => rechazarSolicitudPago(s.id, motivo.value), 'Solicitud rechazada') }, 'Rechazar') : null) : null,
      s.estado === 'pendiente' && puedeAprobar ? campo('Motivo del rechazo', motivo) : null,
      s.estado === 'aprobada' ? h('div', { class: 'cuerpo sin-borde' },
        h('h3', {}, 'Pagar'), s.proveedor_id ? aviso('Se aplica a las facturas más viejas del suplidor y sale de la cuenta bancaria predeterminada.') : campo('Pagar desde', banco),
        h('div', { class: 'rejilla' }, campo('Fecha', fecha), campo(s.forma === 'cheque' ? 'Número de cheque' : 'Referencia', ref)),
        h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: accion(() => pagarSolicitudPago({ id: s.id, banco_id: Number(banco.value) || null, fecha: fecha.value, referencia: ref.value }), 'Pago registrado') }, 'Pagar'),
          h('button', { class: 'btn peligro', onClick: accion(() => rechazarSolicitudPago(s.id, ''), 'Solicitud rechazada') }, 'Rechazar'))) : null));
  }
  const pend = sols.filter((s) => s.estado === 'pendiente'); const apr = sols.filter((s) => s.estado === 'aprobada');
  raiz.replaceChildren(aviso('Pide un pago, apruébalo y luego sale el cheque o la transferencia. Así nadie paga sin autorización.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nueva }, 'Nueva solicitud de pago')),
    h('div', { class: 'totales' }, renglon('Por aprobar', dinero(pend.reduce((s, x) => s + x.monto, 0)), 'gran'), renglon('Aprobadas sin pagar', dinero(apr.reduce((s, x) => s + x.monto, 0)))),
    sols.length ? h('div', { class: 'lista' }, sols.map((s) => h('button', { class: `fila inventario ${['rechazada'].includes(s.estado) ? 'apagada' : ''}`, onClick: () => detalle(s) },
      h('span', { class: 'datos' }, h('strong', {}, `${s.numero} · ${s.beneficiario}`), h('small', {}, [fechaCorta(s.fecha), s.concepto, ESTADOS_SOLICITUD_PAGO[s.estado]].filter(Boolean).join(' · '))),
      h('span', { class: 'precio' }, dinero(s.monto))))) : vacio('Aún no hay solicitudes de pago.'));
}

// ---------- Tipo de Cuenta ----------
export async function seccionTiposCuenta(raiz, recargar) {
  const tipos = await listarTiposCuenta();
  function formulario(t = null) {
    const nombre = texto(t?.nombre || '', 'Ej. Corriente'); const activo = h('input', { type: 'checkbox', checked: t ? !!t.activo : true }); const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(t ? 'Editar tipo de cuenta' : 'Nuevo tipo de cuenta', h('div', { class: 'cuerpo' }, campo('Nombre', nombre), h('label', { class: 'etiqueta' }, h('span', {}, 'Disponible'), activo), error,
      h('div', { class: 'acciones' },
        t ? h('button', { class: 'btn peligro', onClick: async () => { try { await eliminarTipoCuenta(t.id); cerrar(); toast('Eliminado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => { try { await guardarTipoCuenta({ id: t?.id ?? null, nombre: nombre.value, activo: activo.checked ? 1 : 0 }); cerrar(); toast('Guardado'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Guardar'))));
  }
  raiz.replaceChildren(aviso('Clasifica tus cuentas bancarias (corriente, ahorro…). Se asigna en la sección Banco y se usa para agrupar los reportes.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nuevo tipo de cuenta')),
    tipos.length ? h('div', { class: 'lista' }, tipos.map((t) => h('button', { class: `fila inventario ${t.activo ? '' : 'apagada'}`, onClick: () => formulario(t) },
      h('span', { class: 'datos' }, h('strong', {}, t.nombre), h('small', {}, t.activo ? 'Disponible' : 'No disponible')),
      h('span', { class: 'precio' }, `${t.n_cuentas} ${t.n_cuentas === 1 ? 'cuenta' : 'cuentas'}`)))) : vacio('Aún no hay tipos de cuenta.'));
}

// ---------- Moneda (catálogo) ----------
export async function seccionCatalogoMonedas(raiz, recargar) {
  const monedas = await listarMonedas();
  function formulario(m = null) {
    const codigo = texto(m?.codigo || '', 'USD'); const nombre = texto(m?.nombre || ''); const simbolo = texto(m?.simbolo || '', '$');
    const activa = h('input', { type: 'checkbox', checked: m ? !!m.activa : true }); const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(m ? 'Editar moneda' : 'Nueva moneda', h('div', { class: 'cuerpo' }, campo('Código', codigo), campo('Nombre', nombre), campo('Símbolo', simbolo), h('label', { class: 'etiqueta' }, h('span', {}, 'Activa'), activa), error,
      h('div', { class: 'acciones' },
        m ? h('button', { class: 'btn peligro', onClick: async () => { if (!(await confirmar('Eliminar moneda', `¿Eliminar ${m.codigo} y sus tasas?`, 'Eliminar'))) return; try { await eliminarMoneda(m.id); cerrar(); toast('Moneda eliminada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Eliminar') : null,
        h('button', { class: 'btn primario', onClick: async () => { try { await guardarMoneda({ id: m?.id || null, codigo: codigo.value, nombre: nombre.value, simbolo: simbolo.value, activa: activa.checked }); cerrar(); toast('Moneda guardada'); await recargar(); } catch (e) { error.textContent = limpiar(e); } } }, 'Guardar'))));
  }
  raiz.replaceChildren(aviso('Las monedas con las que trabajas además del peso dominicano. Sus tasas se registran en Cambio Tasa.'),
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: () => formulario() }, 'Nueva moneda')),
    monedas.length ? h('div', { class: 'lista' }, monedas.map((m) => h('button', { class: `fila inventario ${m.activa ? '' : 'apagada'}`, onClick: () => formulario(m) },
      h('span', { class: 'datos' }, h('strong', {}, `${m.codigo} · ${m.nombre}`), h('small', {}, m.tasa_actual ? `Tasa actual: ${m.tasa_actual} DOP (${fechaCorta(m.fecha_tasa)})` : 'Sin tasa registrada')),
      h('span', { class: 'precio' }, m.simbolo || '')))) : vacio('Aún no hay monedas.'));
}

// ---------- Reporte Banco ----------
export async function seccionReporteBanco(raiz) {
  const hoy = fechaHoy(); const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy); const cuerpo = h('div');
  async function cargar() {
    const r = await reporteBanco({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); const t = r.total;
    const filas = r.filas.map((f) => [f.nombre, f.tipo_cuenta, dinero(f.inicial), dinero(f.entradas), dinero(f.salidas), dinero(f.final), dinero(f.conciliado), String(f.pendientes)]);
    cuerpo.replaceChildren(
      h('div', { class: 'totales' }, renglon('Saldo en bancos', dinero(t.final), 'gran'), renglon('Entradas del período', dinero(t.entradas)), renglon('Salidas del período', dinero(t.salidas)), renglon('Movimientos sin conciliar', String(t.pendientes))),
      r.filas.length ? tabla(['Cuenta', 'Tipo', 'Inicial', 'Entradas', 'Salidas', 'Final', 'Conciliado', 'Pend.'], [...filas, ['Total', '', dinero(t.inicial), dinero(t.entradas), dinero(t.salidas), dinero(t.final), dinero(t.conciliado), String(t.pendientes)]],
        { num: [2, 3, 4, 5, 6, 7], clases: { [filas.length]: 'total' } }) : vacio('Aún no hay cuentas bancarias.'),
      r.filas.some((f) => f.chequesTransito || f.depositosTransito) ? tabla(['Cuenta', 'Cheques en tránsito', 'Depósitos en tránsito'], r.filas.map((f) => [f.nombre, dinero(f.chequesTransito), dinero(f.depositosTransito)]), { num: [1, 2] }) : null,
      aviso('Los saldos salen de la contabilidad (cuenta contable de cada banco). "Conciliado" es lo que ya aparece en el estado de cuenta; el resto está en tránsito.'),
      r.filas.length ? botonCSV(`bancos-${r.hasta}`, ['Cuenta', 'Tipo', 'Inicial', 'Entradas', 'Salidas', 'Final', 'Conciliado', 'Pendientes'], r.filas.map((f) => [f.nombre, f.tipo_cuenta, f.inicial, f.entradas, f.salidas, f.final, f.conciliado, f.pendientes])) : null);
  }
  for (const el of [desde, hasta]) el.addEventListener('change', cargar);
  raiz.replaceChildren(aviso('Saldos y movimiento de cada cuenta bancaria en el período.'), h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), cuerpo);
  await cargar();
}

// ---------- Reporte Dinámico ----------
export async function seccionDinamicoBanco(raiz) {
  const hoy = fechaHoy(); const desde = fechaInput(`${hoy.slice(0, 4)}-01-01`); const hasta = fechaInput(hoy);
  const dim = selectDe(Object.entries(DIMENSIONES_BANCO), { valor: 'cuenta', etiqueta: 'Agrupar por' });
  const buscar = h('input', { class: 'campo', type: 'search', placeholder: 'Filtrar por cuenta, número o concepto', 'aria-label': 'Filtrar' });
  const marcados = new Set(Object.keys(TIPOS_DOC_BANCO)); const cajas = h('div', { class: 'segmento', role: 'group', 'aria-label': 'Movimientos' }); const cuerpo = h('div');
  let movs = [];
  async function cargar() { movs = await movimientosBancoDin({ desde: desde.value || '0000-00-00', hasta: hasta.value || hoy }); pintar(); }
  function pintar() {
    cajas.replaceChildren(...Object.entries(TIPOS_DOC_BANCO).map(([id, t]) => h('button', { 'aria-pressed': String(marcados.has(id)), onClick: () => { if (marcados.has(id)) marcados.delete(id); else marcados.add(id); pintar(); } }, t)));
    const r = tablaDinamicaBanco(movs, { dimension: dim.value, tipos: [...marcados], busqueda: buscar.value });
    const cols = Object.keys(TIPOS_DOC_BANCO).filter((k) => marcados.has(k));
    const f = (g) => [g.clave, String(g.n), ...cols.map((k) => dinero(g[k])), dinero(g.neto)];
    cuerpo.replaceChildren(
      r.filas.length ? tabla([DIMENSIONES_BANCO[dim.value], 'Mov.', ...cols.map((k) => TIPOS_DOC_BANCO[k]), 'Neto'], [...r.filas.map(f), f({ clave: 'Total', ...r.total })],
        { num: cols.map((_, i) => i + 1).concat([cols.length + 1, cols.length + 2]), clases: { [r.filas.length]: 'total' } }) : vacio('No hay movimientos con esos filtros.'),
      aviso('Neto = depósitos + intereses + créditos recibidos − retiros − cheques − cargos − cuotas de crédito. Las transferencias entre cuentas no cambian el total.'),
      r.filas.length ? botonCSV(`banco-dinamico-${dim.value}`, [DIMENSIONES_BANCO[dim.value], 'Movimientos', ...cols.map((k) => TIPOS_DOC_BANCO[k]), 'Neto'], r.filas.map((g) => [g.clave, g.n, ...cols.map((k) => g[k]), g.neto])) : null);
  }
  for (const el of [desde, hasta]) el.addEventListener('change', cargar);
  dim.addEventListener('change', pintar); buscar.addEventListener('input', pintar);
  raiz.replaceChildren(aviso('Arma tu propio reporte: elige cómo agrupar y qué movimientos incluir.'), h('div', { class: 'rejilla' }, campo('Desde', desde), campo('Hasta', hasta)), campo('Agrupar por', dim), cajas, buscar, cuerpo);
  await cargar();
}
