# Plan de nube (estado actual)

Lo que pensábamos hacer con un servicio externo (Supabase) quedó resuelto con un servidor propio de Node sin
dependencias (`server/`), porque se puede probar de punta a punta aquí mismo y se despliega en Railway o en un VPS.

## Cómo funciona

- **Offline primero**: la app lee y escribe siempre en su base SQLite local. Nada depende del internet para trabajar.
- **Cada registro tiene un `uid`** igual en todos los dispositivos. Triggers de SQLite marcan lo que cambió
  (`dirty`, `act`) y guardan los borrados (`sync_borrados`).
- **Sincronizar** (`src/sync-nucleo.js`): sube lo marcado en orden de padres a hijos, baja lo nuevo con un cursor
  (versión del servidor) y lo aplica. Gana el cambio con la fecha más reciente (la hora de un dispositivo adelantada
  se limita a +1 minuto en el servidor).
- **Stock**: no se copia; cada dispositivo suma los movimientos de inventario de todos (ventas simultáneas correctas).
- **Cuentas**: el servidor es dueño de usuarios/contraseñas (scrypt). Cada dispositivo guarda una copia (hash PBKDF2)
  para poder entrar sin internet. Roles y permisos iguales a los locales.
- **Multi-negocio**: cada negocio es un espacio aislado (`negocio`); el servidor nunca mezcla datos.
- **Numeración**: el servidor asigna una letra a cada dispositivo (A, B, …) que va en los números de documento.

## Qué falta para venderlo en serio

1. Cobro y planes: la tabla `negocios` ya tiene `activo`, `plan` y `vence`; falta un panel para gestionarlos y la pasarela de pago.
2. Correo: recuperar contraseña hoy usa el código de recuperación; se puede agregar el envío por correo.
3. Respaldos automáticos del volumen y monitoreo del servidor.
4. Aviso legal / política de privacidad y términos para tus clientes.
5. Conflictos poco comunes que hoy se resuelven "gana el último": dos personas editando el mismo producto a la vez, o dos cajas abiertas al mismo tiempo.
6. Probar la APK y la web con varios usuarios reales antes de ofrecerlo (las pruebas automáticas cubren la lógica, no la pantalla).
