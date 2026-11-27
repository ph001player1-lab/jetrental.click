FROM node:24-alpine

# Chromium — печать договоров, актов и квитанций в PDF (src/docs/pdf.js).
# Шрифты (латиница, кириллица, тайский) встроены в сами документы — assets/fonts
RUN apk add --no-cache chromium font-dejavu

WORKDIR /app
ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

COPY package.json package-lock.json ./
# Зависимости — строго по package-lock.json; чужие скрипты при установке не запускаем
RUN npm ci --omit=dev --ignore-scripts

COPY assets ./assets
COPY src ./src

# Папки для базы SQLite (том bot_data) и фото с сайта сотрудников (том
# site_uploads), доступные пользователю node
RUN mkdir -p /data /uploads && chown node:node /data /uploads

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
