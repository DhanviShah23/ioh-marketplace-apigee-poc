FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
EXPOSE 4103
CMD ["npm", "run", "start"]
