FROM node:20

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY server.js ./server.js
COPY lib ./lib
COPY routes ./routes
COPY scripts ./scripts
COPY test ./test

EXPOSE 3000

CMD ["npm", "start"]
