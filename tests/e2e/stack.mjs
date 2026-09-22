// Um "Supabase de bolso", local e descartável, para os testes de ponta a ponta.
//
// Sobe, via Docker CLI (sem dependência nenhuma de npm):
//   . uma rede docker só deste teste;
//   . Postgres 17 com os papéis do Supabase (anon, authenticated, service_role com BYPASSRLS e
//     authenticator, que faz SET ROLE) e com os GRANTS PADRÃO do Supabase no schema public — é isso
//     que faz os revokes do supabase.sql serem testados de verdade: aqui, como lá, tudo o que nasce
//     em public ganha grant para anon;
//   . o supabase.sql do repositório, aplicado com ON_ERROR_STOP;
//   . PostgREST (o mesmo motor do /rest/v1 do Supabase), com segredo JWT aleatório;
//   . um proxy Node que faz /rest/v1/* -> PostgREST /*, exigindo o header apikey como o gateway
//     do Supabase exige. É o endereço que o server.mjs recebe em SUPABASE_URL.
//
// Uso nos testes:
//   const stack = await startStack();
//   stack.supabaseUrl, stack.serviceKey, stack.anonKey, stack.authenticatedKey
//   await stack.sql("select ...")      -> [{coluna: "texto"|null, ...}]  (uma consulta por chamada;
//                                         null e "" voltam como null)
//   await stack.aplicarSql(caminho)    -> roda um arquivo .sql (ON_ERROR_STOP)
//   await stack.reset()                -> esvazia as tabelas da pesquisa
//   await stack.stop()                 -> derruba containers, rede e proxy
//
// Como CLI (para rodar o servidor ou o painel contra um banco de verdade na sua máquina):
//   node tests/e2e/stack.mjs up
// imprime SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY e fica no ar até Ctrl+C.
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SQL_DO_PROJETO = path.join(RAIZ, "supabase.sql");

const IMAGEM_POSTGRES = process.env.E2E_POSTGRES_IMAGE || "postgres:17";
const IMAGEM_POSTGREST = process.env.E2E_POSTGREST_IMAGE || "postgrest/postgrest:v14.1";

/* ------------------------------------------------------------------------------------------ */
/* Docker                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Roda um comando e devolve {code, stdout, stderr}. `input` vai para o stdin. Nunca usa shell. */
function executar(comando, args, { input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const filho = spawn(comando, args, { stdio: ["pipe", "pipe", "pipe"] });
    const saida = [];
    const erro = [];
    const relogio = setTimeout(() => filho.kill("SIGKILL"), timeoutMs);
    filho.stdout.on("data", (parte) => saida.push(parte));
    filho.stderr.on("data", (parte) => erro.push(parte));
    filho.on("error", (falha) => {
      clearTimeout(relogio);
      reject(falha);
    });
    filho.on("close", (code) => {
      clearTimeout(relogio);
      resolve({ code, stdout: Buffer.concat(saida).toString("utf8"), stderr: Buffer.concat(erro).toString("utf8") });
    });
    filho.stdin.on("error", () => {}); // processo que morre antes de ler o stdin não derruba o teste
    filho.stdin.end(input ?? "");
  });
}

async function docker(args, opcoes) {
  const resultado = await executar("docker", args, opcoes);
  if (resultado.code !== 0) {
    throw new Error(`docker ${args.slice(0, 2).join(" ")} falhou (${resultado.code}): ${resultado.stderr.trim() || resultado.stdout.trim()}`);
  }
  return resultado.stdout;
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Repete `tentativa` até ela devolver algo verdadeiro, ou estoura com a última falha. */
async function aguardar(descricao, tentativa, { timeoutMs = 60_000, intervaloMs = 300 } = {}) {
  const limite = Date.now() + timeoutMs;
  let ultimaFalha;
  while (Date.now() < limite) {
    try {
      const ok = await tentativa();
      if (ok) return ok;
    } catch (falha) {
      ultimaFalha = falha;
    }
    await esperar(intervaloMs);
  }
  throw new Error(`Tempo esgotado esperando ${descricao}${ultimaFalha ? `: ${ultimaFalha.message}` : ""}`);
}

/* ------------------------------------------------------------------------------------------ */
/* JWT HS256 (o formato das chaves anon e service_role do Supabase)                            */
/* ------------------------------------------------------------------------------------------ */

function base64url(valor) {
  return Buffer.from(valor).toString("base64url");
}

export function assinarJwt(payload, segredo) {
  const cabecalho = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const corpo = base64url(JSON.stringify(payload));
  const assinatura = createHmac("sha256", segredo).update(`${cabecalho}.${corpo}`).digest("base64url");
  return `${cabecalho}.${corpo}.${assinatura}`;
}

function chaveDoPapel(role, segredo) {
  const agora = Math.floor(Date.now() / 1000);
  return assinarJwt({ iss: "supabase", ref: "local-e2e", role, iat: agora, exp: agora + 60 * 60 * 24 * 365 }, segredo);
}

/* ------------------------------------------------------------------------------------------ */
/* Resultado do psql em CSV -> objetos                                                         */
/* ------------------------------------------------------------------------------------------ */

// O psql em --csv escreve null E string vazia do mesmo jeito (campo vazio), então os dois voltam
// como null. Para distinguir, peça no próprio SQL (ex.: coalesce(coluna, '<null>')).
function lerCsv(texto) {
  const linhas = [];
  let linha = [];
  let campo = "";
  let entreAspas = false;
  let teveAspas = false;
  let i = 0;
  const fecharCampo = () => {
    linha.push(campo === "" && !teveAspas ? null : campo);
    campo = "";
    teveAspas = false;
  };
  while (i < texto.length) {
    const c = texto[i];
    if (entreAspas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i += 2;
        continue;
      }
      if (c === '"') entreAspas = false;
      else campo += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      entreAspas = true;
      teveAspas = true;
    } else if (c === ",") {
      fecharCampo();
    } else if (c === "\n") {
      fecharCampo();
      linhas.push(linha);
      linha = [];
    } else if (c !== "\r") {
      campo += c;
    }
    i += 1;
  }
  if (campo !== "" || teveAspas || linha.length) {
    fecharCampo();
    linhas.push(linha);
  }
  if (!linhas.length) return [];
  const [cabecalho, ...dados] = linhas;
  return dados.map((valores) => Object.fromEntries(cabecalho.map((nome, j) => [nome, valores[j] ?? null])));
}

/* ------------------------------------------------------------------------------------------ */
/* O stack                                                                                     */
/* ------------------------------------------------------------------------------------------ */

// Papéis e grants como o Supabase cria num projeto novo. Os "alter default privileges" são o ponto
// principal: fazem toda tabela, view, sequência e função que o supabase.sql criar nascer com grant
// para anon e authenticated — exatamente o que acontece no Supabase de verdade.
function sqlDePapeis(senhaAuthenticator) {
  return `
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
    create role authenticator login noinherit password '${senhaAuthenticator}';
    grant anon, authenticated, service_role to authenticator;

    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `;
}

function criarProxy(destinoPorta, chavesAceitas) {
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, "http://proxy.local");
    if (!url.pathname.startsWith("/rest/v1/") && url.pathname !== "/rest/v1") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "no Route matched with those values" }));
      return;
    }
    // O gateway do Supabase recusa requisição sem apikey válida antes de chegar no PostgREST.
    const apikey = req.headers.apikey;
    if (!apikey || !chavesAceitas.has(String(apikey))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Invalid API key" }));
      return;
    }
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.apikey;
    delete headers.connection;
    if (!headers.authorization) headers.authorization = `Bearer ${apikey}`;

    const destino = http.request(
      {
        host: "127.0.0.1",
        port: destinoPorta,
        method: req.method,
        path: (url.pathname.slice("/rest/v1".length) || "/") + url.search,
        headers
      },
      (resposta) => {
        res.writeHead(resposta.statusCode || 502, resposta.headers);
        resposta.pipe(res);
      }
    );
    destino.on("error", (falha) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `proxy: ${falha.message}` }));
    });
    req.pipe(destino);
  });
  return new Promise((resolve, reject) => {
    servidor.once("error", reject);
    // Porta 0: o sistema escolhe uma livre. Outros testes podem estar rodando ao mesmo tempo.
    servidor.listen(0, "127.0.0.1", () => resolve(servidor));
  });
}

async function portaPublicada(container, portaInterna) {
  const saida = await docker(["port", container, `${portaInterna}/tcp`]);
  const encontrada = saida.split("\n").map((linha) => linha.trim().match(/:(\d+)$/)).find(Boolean);
  if (!encontrada) throw new Error(`porta ${portaInterna} de ${container} não publicada`);
  return Number(encontrada[1]);
}

/**
 * Sobe o stack inteiro. Se qualquer passo falhar, o que já tinha subido é derrubado antes de a
 * exceção sair — nada de container órfão depois de um teste quebrado.
 */
export async function startStack({ sqlFile = SQL_DO_PROJETO, log = () => {} } = {}) {
  const sufixo = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const rede = `ev-e2e-${sufixo}`;
  const pg = `ev-e2e-pg-${sufixo}`;
  const rest = `ev-e2e-rest-${sufixo}`;
  const senhaPostgres = randomBytes(12).toString("hex");
  const senhaAuthenticator = randomBytes(12).toString("hex");
  const jwtSecret = randomBytes(32).toString("hex"); // 64 caracteres; o PostgREST exige ≥ 32

  const criados = { rede: false, containers: [] };
  let proxy = null;
  let parado = false;

  async function stop() {
    if (parado) return;
    parado = true;
    process.off("exit", pararSincrono);
    if (proxy) await new Promise((resolve) => proxy.close(() => resolve()));
    if (proxy) proxy.closeAllConnections?.();
    for (const nome of criados.containers.reverse()) {
      await executar("docker", ["rm", "-f", "-v", nome]).catch(() => {});
    }
    if (criados.rede) await executar("docker", ["network", "rm", rede]).catch(() => {});
  }

  // Última rede de segurança: se o processo sair sem chamar stop(), tira os containers mesmo assim.
  function pararSincrono() {
    if (parado) return;
    try {
      if (criados.containers.length) spawnSync("docker", ["rm", "-f", "-v", ...criados.containers], { stdio: "ignore" });
      if (criados.rede) spawnSync("docker", ["network", "rm", rede], { stdio: "ignore" });
    } catch {
      /* saindo de qualquer jeito */
    }
  }
  process.on("exit", pararSincrono);

  async function psql(sql, { csv = false, arquivo = false } = {}) {
    const args = ["exec", "-i", pg, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"];
    if (csv) args.push("--csv");
    args.push("-f", "-");
    const resultado = await executar("docker", args, { input: sql });
    if (resultado.code !== 0) {
      throw new Error(`psql falhou${arquivo ? ` em ${arquivo}` : ""}: ${resultado.stderr.trim()}`);
    }
    return resultado.stdout;
  }

  try {
    log("criando rede docker…");
    await docker(["network", "create", rede]);
    criados.rede = true;

    log(`subindo ${IMAGEM_POSTGRES}…`);
    criados.containers.push(pg);
    await docker([
      "run", "-d", "--name", pg, "--network", rede, "--network-alias", "db",
      "-e", `POSTGRES_PASSWORD=${senhaPostgres}`,
      "-e", "TZ=UTC",
      "-p", "127.0.0.1::5432",
      IMAGEM_POSTGRES,
      // fsync desligado: o banco é jogado fora no fim, e os testes ficam bem mais rápidos.
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"
    ]);

    // Espera por TCP, e não pelo socket: durante o initdb a imagem sobe um servidor temporário só
    // no socket, que reinicia logo depois — conectar nele faria o bootstrap morrer no meio.
    await aguardar("o Postgres aceitar conexões", async () => {
      const r = await executar("docker", ["exec", pg, "psql", "-h", "127.0.0.1", "-U", "postgres", "-Atc", "select 1"]);
      return r.code === 0 && r.stdout.trim() === "1";
    }, { timeoutMs: 90_000 });

    log("criando papéis do Supabase…");
    await psql(sqlDePapeis(senhaAuthenticator));

    log("aplicando supabase.sql…");
    await psql(await readFile(sqlFile, "utf8"), { arquivo: sqlFile });

    log(`subindo ${IMAGEM_POSTGREST}…`);
    criados.containers.push(rest);
    await docker([
      "run", "-d", "--name", rest, "--network", rede,
      "-e", `PGRST_DB_URI=postgres://authenticator:${senhaAuthenticator}@db:5432/postgres`,
      "-e", "PGRST_DB_SCHEMAS=public",
      "-e", "PGRST_DB_ANON_ROLE=anon",
      "-e", `PGRST_JWT_SECRET=${jwtSecret}`,
      "-e", "PGRST_DB_CHANNEL_ENABLED=true",
      "-p", "127.0.0.1::3000",
      IMAGEM_POSTGREST
    ]);
    const portaRest = await portaPublicada(rest, 3000);

    const serviceKey = chaveDoPapel("service_role", jwtSecret);
    const anonKey = chaveDoPapel("anon", jwtSecret);
    const authenticatedKey = chaveDoPapel("authenticated", jwtSecret);

    // "Pronto de verdade" = já carregou o schema cache e responde uma RPC nossa com a service_role.
    await aguardar("o PostgREST ficar pronto", async () => {
      const resposta = await fetch(`http://127.0.0.1:${portaRest}/rpc/pesquisa_painel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: "{}"
      });
      await resposta.arrayBuffer();
      return resposta.status === 200;
    }, { timeoutMs: 60_000 });

    proxy = await criarProxy(portaRest, new Set([serviceKey, anonKey, authenticatedKey]));
    const supabaseUrl = `http://127.0.0.1:${proxy.address().port}`;
    const portaPostgres = await portaPublicada(pg, 5432);
    log("stack pronto.");

    return {
      supabaseUrl,
      serviceKey,
      anonKey,
      authenticatedKey,
      jwtSecret,
      postgrestUrl: `http://127.0.0.1:${portaRest}`,
      postgresPort: portaPostgres,
      postgresPassword: senhaPostgres,
      containers: { postgres: pg, postgrest: rest, rede },
      /** Uma consulta por chamada; devolve as linhas como objetos (valores em texto, null = null). */
      async sql(consulta) {
        return lerCsv(await psql(consulta, { csv: true }));
      },
      /** Roda um arquivo .sql inteiro, parando no primeiro erro. */
      async aplicarSql(caminho = sqlFile) {
        await psql(await readFile(caminho, "utf8"), { arquivo: caminho });
      },
      async reset() {
        await psql("truncate table public.pesquisa_respostas, public.pesquisa_visitas;");
      },
      stop
    };
  } catch (falha) {
    await stop();
    throw falha;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* CLI                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const ehPrincipal = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (ehPrincipal) {
  const comando = process.argv[2];
  if (comando !== "up") {
    console.error("Uso: node tests/e2e/stack.mjs up");
    process.exit(2);
  }
  let stack;
  const sair = async (codigo) => {
    try {
      if (stack) await stack.stop();
    } finally {
      process.exit(codigo);
    }
  };
  process.on("SIGINT", () => sair(0));
  process.on("SIGTERM", () => sair(0));
  try {
    stack = await startStack({ log: (mensagem) => console.error(`[stack] ${mensagem}`) });
    console.log(`SUPABASE_URL=${stack.supabaseUrl}`);
    console.log(`SUPABASE_SERVICE_ROLE_KEY=${stack.serviceKey}`);
    console.log(`# chave anon (para provar que ela NÃO lê nada): ${stack.anonKey}`);
    console.log(`# psql: docker exec -it ${stack.containers.postgres} psql -U postgres`);
    console.error("[stack] no ar. Ctrl+C derruba tudo.");
    setInterval(() => {}, 1 << 30);
  } catch (falha) {
    console.error(`[stack] ${falha.message}`);
    await sair(1);
  }
}
