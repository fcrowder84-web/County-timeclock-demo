FROM node:20

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY server.js ./server.js

EXPOSE 3000

CMD ["npm", "start"]
