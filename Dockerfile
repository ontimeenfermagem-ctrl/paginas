# Servidor da pesquisa e do painel. Zero dependências de runtime: não há npm install, e a imagem
# é só o Node com os arquivos do site (o .dockerignore tira testes, documentação e segredos).
FROM node:22-alpine

WORKDIR /app

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Usuário sem privilégios: o servidor só lê arquivos e abre a porta 3000.
USER node

CMD ["node", "server.mjs"]
