FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Папка для базы SQLite (Docker-том bot_data), доступная пользователю node
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
