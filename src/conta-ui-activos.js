// conta-ui-activos.js - pestañas Activos fijos y Nómina
import { h, hoja, toast, dinero, confirmar } from './ui.js';
import {
  listarActivos, crearActivo, bajaActivo, listarCuentas, listarCentros, fechaHoy, configConta, guardarConfigConta,
  listarEmpleados, guardarEmpleado, prepararNomina, registrarNomina, pagarNomina, anularNomina, listarNominas, detalleNomina,
} from './conta-db.js';
import { calendarioDepreciacion, r2 } from './conta-motor.js';
import { PARAMS_NOMINA, ETIQUETAS_NOMINA } from './conta-nomina.js';
import { campo, numero, fechaInput, texto, selectCuentas, tabla, vacio, fechaCorta, limpiar, botonCSV } from './conta-ui-comun.js';

// ---------------- Activos fijos ----------------
export async function vistaActivos(raiz) {
  const activos = await listarActivos();
  const hoy = fechaHoy();
  const valores = activos.map((a) => {
    const cal = calendarioDepreciacion(a, hoy);
    const dep = r2(cal.reduce((s, x) => s + x.monto, 0));
    return { a, dep, libros: r2(a.costo - dep) };
  });

  async function nuevo() {
    const cuentas = await listarCuentas(true);
    const nombre = texto(''), codigo = texto('', 'Código (opcional)'), fecha = fechaInput(hoy), costo = numero(), residual = numero(), vida = numero('60', '1');
    const contra = selectCuentas(cuentas, { vacioTexto: 'Pagado de Caja', tipos: ['activo', 'pasivo'] });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja('Nuevo activo fijo', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), h('div', { class: 'rejilla' }, campo('Código', codigo), campo('Fecha de compra', fecha)),
      h('div', { class: 'rejilla' }, campo('Costo', costo), campo('Valor residual', residual)),
      campo('Vida útil (meses)', vida, '60 meses = 5 años. Depreciación en línea recta, mensual.'),
      campo('Pagado con', contra, 'Si lo compraste a crédito, elige la cuenta por pagar correspondiente.'), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try {
          await crearActivo({ nombre: nombre.value, codigo: codigo.value, fecha_adq: fecha.value, costo: costo.value, residual: residual.value, vida_meses: vida.value, contra_cuenta_id: Number(contra.value) || null });
          cerrar(); toast('Activo registrado'); await vistaActivos(raiz);
        } catch (e) { error.textContent = limpiar(e); }
      } }, 'Guardar'))));
  }

  function detalle({ a, dep, libros }) {
    const cal = calendarioDepreciacion(a, `${new Date().getFullYear() + 10}-12-31`);
    const fecha = fechaInput(hoy);
    const cerrar = hoja(a.nombre, h('div', { class: 'cuerpo' },
      h('div', { class: 'totales' }, h('div', {}, h('span', {}, 'Costo'), h('span', {}, dinero(a.costo))), h('div', {}, h('span', {}, 'Depreciación acumulada'), h('span', {}, dinero(dep))), h('div', {}, h('span', {}, 'Valor en libros'), h('span', {}, dinero(libros)))),
      h('p', { class: 'ayuda' }, `Comprado ${fechaCorta(a.fecha_adq)} · vida ${a.vida_meses} meses · residual ${dinero(a.residual)} · ${a.estado === 'baja' ? `de baja ${fechaCorta(a.fecha_baja)}` : `${cal.length} cuotas mensuales de ${dinero(cal[0]?.monto || 0)}`}`),
      a.estado === 'activo' ? h('div', {}, campo('Fecha de baja', fecha), h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
        if (!(await confirmar('Dar de baja', 'Se dejará de depreciar y se retira de los libros.', 'Dar de baja'))) return;
        try { await bajaActivo(a.id, fecha.value); cerrar(); toast('Activo dado de baja'); await vistaActivos(raiz); } catch (e) { toast(limpiar(e), 'error'); }
      } }, 'Dar de baja'))) : null));
  }

  raiz.replaceChildren(
    h('div', { class: 'filtros' }, h('button', { class: 'btn primario', onClick: nuevo }, 'Nuevo activo fijo')),
    activos.length ? h('div', { class: 'lista' }, valores.map((v) => h('button', { class: `fila inventario ${v.a.estado === 'baja' ? 'apagada' : ''}`, onClick: () => detalle(v) },
      h('span', { class: 'datos' }, h('strong', {}, v.a.nombre), h('small', {}, `${fechaCorta(v.a.fecha_adq)} · costo ${dinero(v.a.costo)}${v.a.estado === 'baja' ? ' · de baja' : ''}`)),
      h('span', { class: 'precio' }, dinero(v.libros)))))
      : vacio('Registra aquí equipos, vehículos, mobiliario… El sistema calcula y contabiliza la depreciación cada mes.'));
}

// ---------------- Nómina ----------------
export async function vistaNomina(raiz) {
  const [nominas, emps] = await Promise.all([listarNominas(), listarEmpleados()]);

  async function empleado(e = null) {
    const centros = (await listarCentros()).filter((c) => c.activo);
    const nombre = texto(e?.nombre ?? ''), cedula = texto(e?.cedula ?? ''), cargo = texto(e?.cargo ?? ''), salario = numero(e?.salario ?? ''), ingreso = fechaInput(e?.fecha_ingreso ?? '');
    const activo = h('input', { type: 'checkbox', checked: e ? !!e.activo : true });
    const error = h('p', { class: 'error', role: 'alert' });
    const cerrar = hoja(e ? 'Editar empleado' : 'Nuevo empleado', h('div', { class: 'cuerpo' },
      campo('Nombre', nombre), h('div', { class: 'rejilla' }, campo('Cédula', cedula), campo('Cargo', cargo)),
      h('div', { class: 'rejilla' }, campo('Salario mensual', salario), campo('Fecha de ingreso', ingreso)),
      e ? h('label', { class: 'etiqueta' }, activo, ' Empleado activo') : null, error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { await guardarEmpleado({ id: e?.id ?? null, nombre: nombre.value, cedula: cedula.value, cargo: cargo.value, salario: salario.value, fecha_ingreso: ingreso.value, activo: activo.checked ? 1 : 0 }); cerrar(); toast('Empleado guardado'); await vistaNomina(raiz); }
        catch (x) { error.textContent = limpiar(x); }
      } }, 'Guardar'))));
    void centros;
  }

  async function nueva() {
    const periodo = h('input', { class: 'campo', type: 'month', value: fechaHoy().slice(0, 7) });
    const ajustes = {};
    const cuerpo = h('div');
    const error = h('p', { class: 'error', role: 'alert' });
    async function pintar() {
      const filas = await prepararNomina(ajustes);
      const t = (k) => r2(filas.reduce((s, f) => s + f[k], 0));
      cuerpo.replaceChildren(
        tabla(['Empleado', 'Salario', 'Otros ingr.', 'AFP', 'SFS', 'ISR', 'Otros desc.', 'Neto'], filas.map((f) => {
          const oi = numero(ajustes[f.empleado.id]?.otros_ingresos ?? ''), od = numero(ajustes[f.empleado.id]?.otros_desc ?? '');
          const cambio = () => { ajustes[f.empleado.id] = { otros_ingresos: parseFloat(oi.value) || 0, otros_desc: parseFloat(od.value) || 0 }; };
          oi.addEventListener('change', async () => { cambio(); await pintar(); }); od.addEventListener('change', async () => { cambio(); await pintar(); });
          return [f.empleado.nombre, dinero(f.salario), oi, dinero(f.afp), dinero(f.sfs), dinero(f.isr), od, dinero(f.neto)];
        }), { num: [1, 3, 4, 5, 7] }),
        h('p', { class: 'ayuda' }, `Neto a pagar ${dinero(t('neto'))} · Aporte patronal ${dinero(r2(t('afp_pat') + t('sfs_pat') + t('srl_pat') + t('infotep')))}`));
    }
    await pintar();
    const cerrar = hoja('Nueva nómina', h('div', { class: 'cuerpo' }, campo('Mes', periodo), cuerpo,
      h('p', { class: 'ayuda' }, 'Cálculo orientativo con los porcentajes de Ajustes de nómina. Verifica con tu contador antes de pagar o declarar a la TSS y la DGII.'), error,
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        try { const n = await registrarNomina({ periodo: periodo.value, ajustes }); cerrar(); toast(`Nómina ${n} registrada`); await vistaNomina(raiz); }
        catch (x) { error.textContent = limpiar(x); }
      } }, 'Registrar nómina'))));
  }

  async function detalleN(n) {
    const det = await detalleNomina(n.id);
    const metodo = h('select', { class: 'campo' }, ['efectivo', 'transferencia', 'cheque'].map((m) => h('option', { value: m }, m)));
    const filas = det.map((d) => [d.nombre, d.salario, d.otros_ingresos, d.afp, d.sfs, d.isr, d.otros_desc, d.neto]);
    const cerrar = hoja(`Nómina ${n.periodo}`, h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, `${n.numero} · ${n.estado === 'anulada' ? 'Anulada' : n.pagada ? `Pagada ${fechaCorta(n.fecha_pago)}` : 'Pendiente de pago'}`),
      tabla(['Empleado', 'Salario', 'Otros ingr.', 'AFP', 'SFS', 'ISR', 'Otros desc.', 'Neto'], filas.map((f) => f.map((v, i) => (i ? dinero(v) : v))), { num: [1, 2, 3, 4, 5, 6, 7] }),
      botonCSV(`nomina-${n.periodo}`, ['Empleado', 'Salario', 'Otros ingresos', 'AFP', 'SFS', 'ISR', 'Otros descuentos', 'Neto'], filas),
      n.estado === 'vigente' ? h('div', {},
        n.pagada ? null : h('div', {}, campo('Pagar con', metodo), h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
          try { await pagarNomina(n.id, { metodo: metodo.value }); cerrar(); toast('Nómina pagada'); await vistaNomina(raiz); } catch (x) { toast(limpiar(x), 'error'); }
        } }, 'Marcar como pagada'))),
        h('div', { class: 'acciones' }, h('button', { class: 'btn peligro', onClick: async () => {
          if (!(await confirmar('Anular nómina', 'Se quitará de la contabilidad.', 'Anular'))) return;
          try { await anularNomina(n.id); cerrar(); toast('Nómina anulada'); await vistaNomina(raiz); } catch (x) { toast(limpiar(x), 'error'); }
        } }, 'Anular'))) : null));
  }

  async function parametros() {
    const { nomina: p } = await configConta();
    const campos = Object.keys(PARAMS_NOMINA).map((k) => [k, numero(p[k])]);
    const cerrar = hoja('Ajustes de nómina', h('div', { class: 'cuerpo' },
      h('p', { class: 'ayuda' }, 'Porcentajes (en %) y topes de la TSS e ISR. Cámbialos cuando la ley los actualice; verifica estos valores cada año.'),
      campos.map(([k, i]) => campo(ETIQUETAS_NOMINA[k] || k, i)),
      h('div', { class: 'acciones' }, h('button', { class: 'btn primario', onClick: async () => {
        for (const [k, i] of campos) if (i.value !== '' && Number(i.value) !== p[k]) await guardarConfigConta(k, i.value);
        cerrar(); toast('Parámetros guardados');
      } }, 'Guardar'))));
  }

  raiz.replaceChildren(
    h('div', { class: 'filtros' }, h('div', { class: 'acciones' },
      h('button', { class: 'btn primario', onClick: nueva, disabled: !emps.some((e) => e.activo) }, 'Nueva nómina'),
      h('button', { class: 'btn', onClick: () => empleado() }, 'Nuevo empleado'),
      h('button', { class: 'btn', onClick: parametros }, 'Parámetros'))),
    h('h3', { class: 'seccion' }, 'Nóminas'),
    nominas.length ? h('div', { class: 'lista' }, nominas.map((n) => h('button', { class: `fila inventario ${n.estado === 'anulada' ? 'apagada' : ''}`, onClick: () => detalleN(n) },
      h('span', { class: 'datos' }, h('strong', {}, `Nómina ${n.periodo}`), h('small', {}, `${n.empleados} empleados · ${n.estado === 'anulada' ? 'anulada' : n.pagada ? 'pagada' : 'por pagar'}`)),
      h('span', { class: 'precio' }, dinero(n.neto))))) : vacio('Aún no hay nóminas.'),
    h('h3', { class: 'seccion' }, 'Empleados'),
    emps.length ? h('div', { class: 'lista' }, emps.map((e) => h('button', { class: `fila inventario ${e.activo ? '' : 'apagada'}`, onClick: () => empleado(e) },
      h('span', { class: 'datos' }, h('strong', {}, e.nombre), h('small', {}, e.cargo || 'Sin cargo')), h('span', { class: 'precio' }, dinero(e.salario))))) : vacio('Agrega a tus empleados para calcular la nómina.'));
}
