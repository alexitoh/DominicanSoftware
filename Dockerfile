# Una sola imagen: construye la app web y la sirve junto con la API de cuentas y sincronización.
FROM node:24-slim AS web
WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-slim
# openssl: el servidor lo usa para leer el certificado digital (.p12) de la facturación electrónica
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server ./server
COPY --from=web /app/dist ./dist
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
EXPOSE 3000
CMD ["node", "server/index.js"]
