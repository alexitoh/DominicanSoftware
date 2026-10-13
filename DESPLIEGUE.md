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
