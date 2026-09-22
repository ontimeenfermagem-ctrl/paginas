// Gera PAINEL_SENHA_HASH e PAINEL_SESSAO_SEGREDO para o painel /painel.
// Uso: npm run painel:senha -- "a-senha-que-voce-quer"
//
// A senha em si não é guardada em lugar nenhum: o servidor só conhece o hash scrypt, e confere
// o login derivando a senha digitada com o mesmo sal e os mesmos parâmetros.
import { randomBytes, scryptSync } from "node:crypto";

// Os mesmos parâmetros que o server.mjs lê do próprio hash (scrypt$N$r$p$sal$hash). Subir o N
// aqui no futuro não quebra nada: cada hash carrega os parâmetros com que foi gerado.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
const password = process.argv[2];

if (!password) {
  console.error('Informe a senha: npm run painel:senha -- "sua-senha"');
  process.exit(1);
}

if (password.length < 10) {
  console.error("Use uma senha com pelo menos 10 caracteres.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);

console.log("Cadastre estas variáveis no Railway (Settings > Variables):\n");
console.log(`PAINEL_SENHA_HASH=${["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("hex"), hash.toString("hex")].join("$")}`);
// Trocar este segredo derruba todas as sessões abertas do painel: é o "sair de todos os aparelhos".
console.log(`PAINEL_SESSAO_SEGREDO=${randomBytes(32).toString("hex")}`);
console.log("\nNum arquivo .env, coloque o hash entre aspas simples: ele tem o caractere $.");
console.log("A senha em si não é guardada em lugar nenhum: só este hash.");
