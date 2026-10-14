# Car Audio: sistema de ventas

App de ventas, inventario, clientes y facturas en PDF. Funciona sin internet y guarda todo en el propio dispositivo.

## Probarla en tu computadora (lo primero)

Necesitas tener instalado Node.js (versión 18 o más nueva).

1. Descomprime la carpeta `caraudio`.
2. Abre una terminal dentro de la carpeta y escribe:
   ```
   npm install
   npm run dev
   ```
3. Abre en el navegador la dirección que aparece (normalmente http://localhost:5173).

En el navegador la base de datos queda guardada dentro del propio navegador. Los respaldos (.json) y las facturas (.pdf) se descargan como archivos en lugar de abrir el menú de compartir.

## Verla en tu celular sin instalar nada

Con `npm run dev` en marcha y el celular en la misma red Wi-Fi, abre en Chrome del celular la dirección que dice **Network** (algo como http://192.168.1.25:5173).

## Generar la APK

1. Instala Android Studio (incluye todo lo necesario para compilar).
2. Una sola vez: `npm run android:agregar`
3. Cada vez que cambies algo: `npm run android:abrir` (compila, sincroniza y abre Android Studio).
4. En Android Studio: **Build > Build APK(s)** para una APK de prueba, o **Build > Generate Signed App Bundle / APK** para la definitiva.
5. Pasa el `.apk` al celular e instálalo.

Guarda el archivo de firma (keystore) y su contraseña: sin él no podrás actualizar la app sin perder los datos.

## Recorrido de prueba

1. Ajustes (barra de iconos de arriba): escribe el nombre, teléfono y dirección de tu negocio.
2. Productos: crea uno con cantidad inicial y stock mínimo.
3. Ventas: Nueva venta, agrega el producto, cobra y comparte la factura.
4. Inventario: confirma que el stock bajó y registra una entrada.
5. Ventas: anula la venta y confirma que el stock volvió.
6. Ajustes: crea un respaldo, borra un producto, restaura el respaldo y comprueba que regresó.

La restauración del respaldo conviene probarla también en el celular con la APK, porque es la parte que más depende del motor de base de datos.

## Ventas a crédito (fiado) con abonos

7. Ventas: Nueva venta, elige un cliente, método de pago "Crédito (fiado)" y un pago inicial opcional. La venta queda con saldo pendiente.
8. Clientes: toca al cliente para ver lo que debe y registrar abonos. En la lista, "Con deuda" muestra solo los que deben.
9. La factura de una venta a crédito muestra lo abonado y lo pendiente.

## Compras y caja

10. Proveedores: crea un proveedor. En Compras, registra una compra con margen de ganancia y revisa que cambien el costo y el precio del producto.
11. Caja: abre la caja con el efectivo inicial, haz una venta en efectivo y registra un gasto. El "efectivo esperado" debe ser inicial + ventas en efectivo - gastos.
12. Cierra la caja contando el efectivo: muestra si sobra o falta dinero y guarda el cierre en el historial.

## Reportes

13. Reportes: elige Hoy, 7 días, Mes, Año o Todo. Verás lo vendido, la ganancia, los gastos, la ganancia neta, las ventas por método y por día, los productos más vendidos y el valor del inventario.

## Garantías

14. Ventas > Nueva venta: en cada producto escribe los meses de garantía (0 = sin garantía) y, si quieres, el número de serie. La app recuerda los meses de cada producto para la próxima venta.
15. Garantías: busca por serie, producto, cliente o factura; filtra Vigentes, Por vencer (30 días o menos) y Vencidas. Toca una garantía para ver los detalles, registrar un reclamo y marcarlo resuelto.
16. La factura PDF imprime la garantía y la serie bajo cada producto. Si anulas la venta, sus garantías quedan anuladas.

## Cuentas por pagar y escáner

17. Compras > Nueva compra: elige la forma de pago. Con "Crédito (por pagar)" (exige proveedor) puedes poner plazo en días y un pago inicial. Las compras al contado en efectivo descuentan del efectivo esperado de la caja.
18. Por pagar: lista lo que debes a proveedores (Pendientes, Vencidas, Pagadas). Toca una cuenta para registrar pagos. Los pagos en efectivo con la caja abierta bajan el efectivo esperado.
19. Escáner: el botón "Escanear" aparece en Nueva venta (agrega el producto por su código de barras), Nueva compra, Productos (código del producto), Inventario, la serie de cada producto vendido y Garantías (buscar por serie). Si no hay cámara disponible, puedes escribir el código en el mismo escáner.

Para que funcione la cámara en la APK, `npm run android:abrir` agrega solo el permiso de cámara al proyecto de Android. Después de actualizar la carpeta `src` y el `package.json` ejecuta una vez `npm install` (se agregan @zxing/browser y @zxing/library).

En el navegador de la computadora la cámara funciona en http://localhost:5173. Desde el celular por la red Wi-Fi (http://192.168...) Chrome bloquea la cámara porque la dirección no es segura; ahí prueba con la APK.

## Logo del negocio

20. Ajustes > Logo del negocio: elige una imagen (mejor PNG). Se reduce sola, se guarda en la base de datos (entra en los respaldos) y sale en el encabezado de las facturas PDF, a la izquierda del nombre.

## Margen por producto y barra de módulos

21. Productos: cada producto tiene Costo, Margen (%) y Precio de venta. Escribir el costo o el margen calcula el precio; escribir el precio ajusta el margen. En Ajustes puedes poner un margen por defecto para los productos nuevos.
22. Inventario > producto > Entrada: al escribir un costo nuevo, el precio de venta se recalcula con el margen del producto. Para cambiar solo el costo, deja la cantidad en 0.
23. Arriba de todas las pantallas está la barra con el icono de cada módulo y el de Inicio.

## Idioma (español / inglés)

24. Ajustes > Idioma / Language: elige el idioma de la aplicación y, por separado, el de las facturas PDF ("Igual que la app", Español o English). El cambio se aplica al instante.
25. Los textos están en `src/idioma-en.js` (español = inglés). Si ves algún texto sin traducir en inglés, agrégalo ahí. Las plantillas usan {} para los valores que cambian.

## Calendario de fechas

26. Ventas, Compras y Reportes tienen la opción "Rango": elige Desde y Hasta en el calendario y la lista y los totales se calculan solo con ese rango (ambas fechas incluidas).

27. **Condición de pago**: al crear un cliente o proveedor eliges *Contado* o *Crédito* y los días para pagar. En Ventas, al cobrar a crédito se calcula la fecha límite según el cliente; en Compras, al elegir un proveedor a crédito se llena solo la forma de pago y el plazo. La fecha límite sale en el detalle y en la factura.

28. **Reporte de facturas** (Reportes → pestaña "Reporte de facturas"): facturas a crédito con saldo pendiente, ordenadas de la más próxima a vencer a la más lejana según los días de crédito de cada cliente. Filtros: Todas, Vencidas, Próx. 7 días.

29. **Cotizaciones** (Ventas → pestaña "Cotizaciones"): cotiza trabajos antes de hacerlos con productos del inventario (también por código de barras) y servicios o mano de obra escritos a mano. Tiene días de validez, descuento y observaciones; se comparte en PDF con el logo; estados Pendiente, Aprobada, Rechazada, Facturada y Vencida. No mueve inventario ni caja. "Convertir en venta" abre Nueva venta con los productos y precios de la cotización, y al cobrar queda como Facturada.

30. **Servicios en las ventas**: en Nueva venta también está el botón "+ Servicio / mano de obra", para cobrar instalaciones y trabajos junto a los productos (o solos). Los servicios suman al total, a la factura, al detalle de la venta y a la ganancia, y no tocan el inventario. Al convertir una cotización en venta, sus servicios pasan completos. La cotización en sí nunca mueve inventario ni caja: eso solo ocurre cuando se cobra la venta.

31. **Versión web (PWA)**: la misma app se publica como página web instalable que también abre sin internet. Pasos: `npm.cmd run build` (crea la carpeta `dist`), y sube esa carpeta a un hosting de páginas estáticas con HTTPS (Netlify Drop: app.netlify.com/drop, o Cloudflare Pages). Con la dirección que te den, abre la página en el celular o la PC y usa "Instalar app" / "Agregar a pantalla de inicio". Para probar el resultado antes de subirlo: `npm.cmd run build` y luego `npm.cmd run preview`. Importante: los datos de la versión web viven en ese navegador de ese dispositivo; la APK tiene los suyos. Para pasar datos de uno a otro usa Ajustes > Respaldo (crear en uno, restaurar en el otro).

32. **Usuarios y acceso**: al abrir la app por primera vez se pide crear la cuenta del administrador (negocio, nombre, usuario, correo y contraseña) y se muestra un código de recuperación que hay que guardar. Después se entra con usuario o correo y contraseña (se puede mantener la sesión). El administrador gestiona empleados en el módulo "Usuarios": rol (Administrador, Gerente, Vendedor, Cajero, Almacén), a qué módulos puede entrar, permiso de anular, activar o desactivar, restablecer contraseña (queda una temporal que debe cambiar) y la pestaña "Actividad" con la bitácora. Cada venta, compra y cotización guarda quién la hizo y Reportes muestra ventas por vendedor. El círculo con las iniciales (arriba a la derecha) abre "Mi cuenta": cambiar contraseña y cerrar sesión. Las contraseñas se guardan con hash (PBKDF2). Tras 5 intentos fallidos se bloquea 1 minuto. Si ya tenías datos, se conservan: solo se pide crear la cuenta. Al restaurar un respaldo la app se reinicia y vuelve a pedir el acceso. Más adelante, ver PLAN-NUBE.md para cuentas en la nube.

## Ficha ampliada del cliente

- **Identificación fiscal:** en Clientes elige RNC (9 números), Cédula (11) o DNI/otro y escribe el número. No acepta el mismo documento en dos clientes. Sale en la factura PDF y se puede buscar por él.
- **Límite de crédito:** tope de lo que el cliente puede deber. Una venta a crédito que lo pase se rechaza (con un pago inicial mayor sí entra). Vacío o 0 = sin límite. El detalle muestra el límite y el crédito disponible.
- **Historial de compras:** el detalle del cliente lista todas sus ventas (fecha, forma de pago, total, anuladas) junto con su saldo pendiente.
- **Direcciones de entrega:** las que hagan falta, además de la principal (nombre, dirección y referencia).
- **Contactos:** personas asociadas (nombre, cargo, teléfono, correo).
- Todo se sincroniza con la nube igual que el resto.

## Cobros y recibos de ingreso

- **Clientes > Cobrar** (o "Registrar abono" en una factura): elige las facturas a pagar y cuánto se aplica a cada una; puede ser pago parcial o total. Si no escribes montos, se reparte solo de la factura más antigua a la más nueva.
- **Varios métodos en un mismo cobro:** efectivo, tarjeta, transferencia y cheque (con número de cheque y banco). "Agregar otro método de pago" suma otra línea. Lo recibido debe ser igual a lo aplicado a las facturas.
- Cada cobro genera un **recibo** (R-000001, con la letra del dispositivo si está en la nube) que se puede compartir en PDF. **Clientes > Recibos** lista los últimos 100; desde el detalle se puede anular y las facturas vuelven a deber lo cobrado.
- La caja separa lo cobrado en efectivo (entra al cajón) de tarjeta, transferencia y cheques. El cheque también se puede usar como forma de pago en ventas, compras y gastos.

## Nube y sincronización

33. **Trabajar sin internet y sincronizar**: la app guarda todo primero en el dispositivo (siempre funciona sin internet) y, si el negocio está conectado a la nube, sube los cambios y baja los de otros dispositivos cuando hay conexión (cada ~45 segundos, al volver el internet y poco después de cada cambio). Arriba, a la derecha, el icono de nube muestra el estado (verde: al día, azul parpadeando: sincronizando, gris: sin conexión, naranja: hay que volver a entrar) y cuántos cambios faltan por subir.
    - **Primera vez**: en la pantalla de bienvenida elige *Crear mi negocio en la nube* (nueva cuenta), *Ya tengo una cuenta* (dispositivo nuevo: baja todos los datos) o *Usar solo en este dispositivo*. Si ya usabas la app en local, el administrador entra a **Ajustes → Nube y sincronización** y elige *Crear mi negocio en la nube* (sube todo lo que ya tienes; los demás usuarios pasan con una contraseña temporal que se muestra una sola vez) o *Conectar con una cuenta existente*.
    - **Cuentas**: con la nube, usuarios y contraseñas viven en el servidor. Se entra con usuario o correo; si no hay internet, entran quienes ya hayan iniciado sesión antes en ese dispositivo. Crear usuarios, cambiar roles, restablecer contraseñas y recuperar con el código requieren internet.
    - **Si dos personas cambian lo mismo sin internet**: gana el cambio más reciente. El inventario no se pisa: cada venta o compra suma o resta, así que si dos dispositivos venden el mismo producto el stock final es correcto. Los números de factura llevan la letra del dispositivo (V-A000012, V-B000003) para no repetirse.
    - **Respaldo**: con la nube conectada los datos se recuperan entrando en otro dispositivo; "Restaurar desde un archivo" se oculta.
    - **Servidor**: ver `DESPLIEGUE.md` (Railway o VPS) y `server/README.md`. Pruebas automáticas: `npm run prueba`.


## Impuestos y reportes de negocio (DGII)

**Configuración** (Ajustes → Datos fiscales): RNC del negocio, si los precios incluyen ITBIS y la tasa (18 %), y los rangos de NCF autorizados por la DGII (B01 crédito fiscal, B02 consumo, B14, B15). Cada venta toma sola el siguiente NCF: B01 si el cliente tiene RNC, B02 si no. Las secuencias son **de cada dispositivo** (no se sincronizan): con varios dispositivos, dale a cada uno un rango distinto. Los productos pueden marcarse como *Exentos de ITBIS*.

**Datos que se capturan**: ventas guardan ITBIS y NCF; compras y gastos tienen campos de NCF e ITBIS incluido; proveedores tienen RNC/cédula.

**Reportes → Impuestos**: ITBIS cobrado vs. pagado del mes, lista de pendientes (ventas sin NCF, compras sin comprobante) y exportación de los formatos **607** (ventas) y **606** (compras y gastos) en TXT y CSV.
**Reportes → Negocio y P&L**: pérdidas y ganancias, y ventas por cliente, vendedor, producto, categoría y mes.
**Reportes → Flujo de caja**: cobros esperados y pagos a proveedores por fecha límite, con saldo acumulado.

**Límites actuales**: solo modo "precios con ITBIS incluido"; no incluye el formato 608 (NCF anulados), notas de crédito, retenciones ni comprobantes electrónicos (e-CF). El archivo TXT usa el encabezado `FORMATO|RNC|AAAAMM|cantidad` y campos separados con `|`: **valídalo con la herramienta de pre-validación de la DGII y con tu contador antes de enviarlo**.


## Contabilidad (ERP contable)
Módulo **Contabilidad** (permiso `contabilidad`; Administrador y Gerente lo tienen). Pestañas:
- **Resumen**: efectivo, por cobrar/pagar, activos, pasivos, patrimonio y resultados del año. Avisa si falta asignar una cuenta o si el balance no cuadra.
- **Asientos**: libro de asientos manuales y automáticos, nuevo asiento (partida doble, con centro de costo), anulación y saldos de apertura.
- **Cuentas**: catálogo estándar dominicano editable (códigos 1101 Caja… 6299 Otros gastos). Cada cuenta puede tener una *función* (Caja, Bancos, CxC, Inventario, ITBIS, Ventas…) que usa la contabilización automática.
- **Bancos**: cuentas bancarias, depósitos, retiros, cheques, transferencias, comisiones, intereses y conciliación contra el estado de cuenta.
- **Activos fijos**: depreciación mensual en línea recta y baja.
- **Nómina**: empleados, corrida mensual con AFP, SFS, ISR, aportes patronales (SRL, INFOTEP), pago y anulación. Los porcentajes y topes son editables en *Parámetros*.
- **Reportes**: balance general, estado de resultados, balanza de comprobación, libro diario, libro mayor, flujo de efectivo, antigüedad de CxC y CxP, por centro de costo. Todos exportan a CSV.
- **Presupuesto**: monto mensual por cuenta contra lo real.
- **Ajustes**: fecha de inicio contable, cierre de períodos, cierre del ejercicio y centros de costo.

Cómo funciona: ventas, cobros, compras, pagos a proveedores, gastos, activos, nómina y movimientos de banco **generan sus asientos solos** a partir de los documentos (no se duplican datos). Los asientos manuales se guardan aparte. Todo se sincroniza entre dispositivos.

Límites a tener presentes:
- Los asientos automáticos se calculan desde los documentos; cerrar un período bloquea solo asientos, banco, activos y nóminas manuales, no las ventas/compras.
- Los ajustes de inventario y mermas no generan asiento; los centros de costo solo aplican a líneas manuales.
- ITBIS solo en modo "incluido"; no hay 608 ni notas de crédito. La facturación electrónica (e-CF) queda para una etapa posterior.
- **Nómina**: las tasas del empleador (AFP 7.10 %, SFS 7.09 %, SRL 1.10 %, INFOTEP 1 %), los topes y la escala del ISR son orientativos; confírmalos cada año con la TSS y la DGII. INFOTEP no lleva tope en este cálculo.
- No sustituye a un contador: revisa los reportes con uno antes de presentarlos a la DGII.

## Tipo de comprobante y consulta de RNC en la DGII
- **Al facturar** (si el ITBIS está activo): eliges *Automático*, B01 Crédito fiscal, B02 Consumo, B14 Régimen especial, B15 Gubernamental o *Sin comprobante*. B01, B14 y B15 exigen un cliente con RNC y una secuencia autorizada con números disponibles (Ajustes → Datos fiscales); si no, la venta se rechaza con el motivo y no gasta números.
- **Casilla "RNC / cédula del cliente"** en la venta y en el formulario del cliente: al escribir el RNC consulta el listado de la DGII. Si el contribuyente está **ACTIVO** llena el nombre (y en la venta crea o elige al cliente). Si no, muestra su estatus (por ejemplo "SUSPENDIDO" o "DADO DE BAJA") y no lo usa; para B01/B14/B15 la venta se bloquea.
- Si no hay internet o el dispositivo no está conectado a la nube, avisa y deja escribir los datos a mano (no frena la venta).
- **Cómo funciona**: el servidor guarda el listado público de contribuyentes de la DGII (`DGII_RNC.zip`) y lo consulta al instante. Se baja solo al arrancar y cada semana. Variable opcional `DGII_RNC_URL` para usar otra dirección. Si la DGII bloquea al servidor (a veces rechaza IPs de fuera del país), el administrador puede bajar el archivo y subirlo en Ajustes → Datos fiscales → *Subir archivo*.
- El listado se actualiza con la frecuencia que lo publica la DGII, por lo que un cambio muy reciente de estatus puede tardar en verse.

## Facturación con comprobante e ITBIS sumado (Ajustes → Facturación con comprobante)
- Un interruptor **Facturar con comprobante e ITBIS**. **Encendido**: toda venta lleva comprobante (NCF) y el ITBIS (18 %, editable) **se suma al precio de venta** (precio 1,000 → total 1,180). **Apagado**: se factura sin comprobante ni ITBIS.
- Al facturar siempre puedes elegir el tipo (Automático, B01, B02, B14, B15). Automático = B01 si el cliente tiene RNC y B02 (consumidor final) si no. No hay opción de vender sin comprobante mientras esté encendido.
- Si no quedan números de la secuencia necesaria, la venta **no se registra** y el mensaje dice cuál secuencia cargar. Carga los rangos autorizados por la DGII en la misma sección antes de encender el interruptor.
- La factura PDF y el detalle de la venta muestran el tipo de comprobante (por ejemplo "Factura de consumo"), el NCF, el subtotal, el ITBIS y el total.
- Productos marcados *Exento de ITBIS* no pagan impuesto. El ITBIS se calcula después del descuento.
- Los negocios que ya tenían "los precios incluyen ITBIS" siguen igual hasta que guarden esta sección; al guardar con el interruptor encendido pasan al ITBIS sumado.
- Las **cotizaciones** todavía muestran el total sin ITBIS; al convertirlas en venta se suma.
