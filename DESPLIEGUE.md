# Poner el sistema en la nube (paso a paso)

Con esto tus clientes tendrán su negocio en la nube: entran con usuario o correo desde la web o desde la app del
teléfono y ven los mismos datos. Todo sigue funcionando sin internet y se sincroniza al volver la conexión.

## Opción A: Railway (la más fácil)

1. Sube la carpeta del proyecto a un repositorio de GitHub (privado).
2. En railway.app: **New Project → Deploy from GitHub repo** y elige el repositorio. Railway detecta el `Dockerfile` solo.
3. En el servicio: **Settings → Volumes → Add Volume** y como ruta de montaje escribe `/data`.
   (Sin el volumen los datos se borran cada vez que Railway reinicia o actualiza.)
4. **Settings → Networking → Generate Domain**. Te da una dirección como `https://caraudio-production.up.railway.app`.
5. Abre esa dirección: aparece la web. Pulsa "Crear mi negocio en la nube". Esa dirección es tu servidor.
6. (Opcional) En **Variables** agrega `JWT_SECRET` con una frase larga y secreta. Si no la pones, el servidor crea una y la guarda en el volumen.

## Panel del propietario (aprobar clientes)

Cada negocio que se registra queda **pendiente**: no puede entrar ni sincronizar hasta que tú lo apruebes.

1. En Railway → **Variables** agrega `OWNER_PASSWORD` con una clave larga y secreta solo tuya. (Sin esta variable el panel no existe.)
2. Abre `https://TU-DOMINIO/propietario` y entra con esa clave.
3. En **Por aprobar** ves cada registro con nombre del negocio, administrador, correo y fecha. Cuando confirmes el pago pulsa **Aprobar**, elige plan (mensual, anual…) y fecha de vencimiento.
4. Resumen arriba: por aprobar, activos, que vencen en 7 días, vencidos, suspendidos, ingreso mensual estimado, cobrado este mes y tamaño de la base de datos. Hay buscador y pestañas **Por vencer** e **Historial** (pagos y todo lo que has hecho).
5. Cuando un cliente te paga: **Registrar pago** (monto, meses, nota). El vencimiento se alarga solo y, si estaba suspendido o vencido, queda activo.
6. Otras acciones: **Suspender / Reactivar**, **Editar** (plan, vencimiento, precio, notas), **Detalle** (usuarios con activar/desactivar y nueva clave temporal, dispositivos, pagos, datos guardados) y **Descargar respaldo** (archivo JSON con todo el negocio).
7. **Eliminar**: cuando un cliente deja de pagar, descarga su respaldo y pulsa Eliminar; escribe el nombre exacto del negocio. Se borran sus datos, usuarios y dispositivos para siempre y la base se compacta para recuperar el espacio. En **Rechazar y eliminar** (pendientes) la persona puede volver a registrarse. Al llegar la fecha de vencimiento el negocio se bloquea solo.
8. Para pruebas puedes agregar `APROBACION_AUTOMATICA=1` y los registros se aprueban solos (quítala cuando vendas).

### Avisos y mensajes a tus clientes

- **Recordatorio de pago automático:** cuando faltan 7, 3 y 1 días para el vencimiento, el administrador del negocio ve una franja amarilla arriba y un aviso nuevo en la campana, con tu teléfono de contacto. No tienes que hacer nada.
- **Mensaje a un cliente:** en su tarjeta pulsa **Enviar mensaje**.
- **Mensaje masivo:** botón **Mensaje masivo** arriba (a todos, a los que vencen en 7 días o a los activos). Eliges título, texto, si es importante y cuántos días estará visible.
- La pestaña **Mensajes** muestra lo enviado, cuántos usuarios lo han leído y permite borrarlo.
- Los clientes lo ven en la campana de la app (web o teléfono) la próxima vez que tengan internet; después queda guardado en su dispositivo.

## Opción B: tu propio VPS

```
git clone <tu repositorio> caraudio && cd caraudio
docker build -t caraudio .
docker run -d --name caraudio --restart unless-stopped -p 3000:3000 -v caraudio-datos:/data caraudio
```
Pon delante un proxy con HTTPS (Caddy o Nginx). Con Caddy basta: `tudominio.com { reverse_proxy localhost:3000 }`.

## La app del teléfono (APK)

La APK necesita saber la dirección del servidor. Dos formas:

- **Ya compilada**: en la pantalla de bienvenida, abre "Servidor" y escribe la dirección (se recuerda).
- **Incluida al compilar** (para tus clientes): crea un archivo `.env.production` en la raíz con
  `VITE_API_URL=https://caraudio-production.up.railway.app` y compila la APK de nuevo. Así tus clientes no tienen que escribirla.

## Probar que funciona

1. Abre la web, crea tu negocio, registra un producto.
2. En el teléfono (APK) pulsa "Ya tengo una cuenta", entra con el mismo usuario: aparece el producto.
3. Pon el teléfono en modo avión, haz una venta, quita el modo avión: en unos segundos la ve la web (la nube del barra de arriba pasa a verde).

## Mantenimiento

- Actualizar: sube los cambios a GitHub y Railway redespliega (el volumen conserva los datos).
- Respaldo: ver `server/README.md`.
- Pruebas automáticas (en tu PC): `npm run prueba`.
