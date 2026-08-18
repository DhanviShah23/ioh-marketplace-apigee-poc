FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
EXPOSE 4101
CMD ["npm", "run", "start"]
