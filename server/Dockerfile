FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Папки для базы SQLite (том bot_data) и фото с сайта сотрудников (том
# site_uploads), доступные пользователю node
RUN mkdir -p /data /uploads && chown node:node /data /uploads

USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
