FROM node:22-alpine

WORKDIR /app

# 仅安装生产依赖（ws）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY shared ./shared
COPY public ./public
COPY server ./server

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]
