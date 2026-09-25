FROM node:20

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY server.js ./server.js
COPY lib ./lib
COPY config ./config
COPY routes ./routes
COPY scripts ./scripts
COPY test ./test

RUN node --check server.js \
 && node --check routes/supervisor.js \
 && node --check routes/leave.js \
 && node --check lib/approve-single-punch.js

EXPOSE 3000

CMD ["npm", "start"]
