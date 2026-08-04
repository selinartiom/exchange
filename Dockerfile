# bitcoinjs-lib/bip32/@bitcoinerlab/secp256k1 — чистый JS/WASM, без нативной
# компиляции (нет node-gyp/python в зависимостях), поэтому alpine достаточно.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Порт сайта (у бота нет входящего порта — он сам инициирует соединения с Telegram)
EXPOSE 3000

# По умолчанию запускается сайт; для бота команда переопределяется в docker-compose.yml
CMD ["node", "src/server.js"]
