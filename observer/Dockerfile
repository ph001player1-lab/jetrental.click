# Наблюдатель рабочей группы WhatsApp (только чтение). Отдельный контейнер:
# сторонняя библиотека WhatsApp Web изолирована от бота и его секретов.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --ignore-scripts: при установке не запускаем чужие скрипты
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src

# Ключи входа WhatsApp и настройки — в томе observer_data
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3100
CMD ["node", "src/index.js"]
