# Node 20 slim
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npx tsc

EXPOSE 8080

CMD ["node", "dist/api.js"]
