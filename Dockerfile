FROM --platform=linux/amd64 node:10

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 1880

CMD [ "npm", "start" ]