# WhatsApp-бот для клиентов. Отдельный контейнер: сторонняя библиотека
# WhatsApp Web изолирована от бота и его секретов.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --ignore-scripts: при установке не запускаем чужие скрипты
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src

# Ключи входа WhatsApp и настройки — в томе wabot_data
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3200
CMD ["node", "src/index.js"]
