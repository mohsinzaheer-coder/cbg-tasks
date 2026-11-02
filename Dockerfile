FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY index.html app.js styles.css logo-mark.png logo-full.png ./public/
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/cbg.db
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
