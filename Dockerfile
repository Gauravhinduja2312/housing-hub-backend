# --- Stage 1: The Builder ---
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# --- Stage 2: The Production Image ---
FROM node:18-alpine

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app .

EXPOSE 3001

CMD ["node", "server.js"]