/*
 * server.mjs — APIs do painel: login, sessão (cookie HMAC), consultas ao banco e o CSV.
 *
 * Supabase falso que grava cada chamada (URL, método, headers, corpo), para conferir que o
 * servidor pede ao PostgREST exatamente o que o contrato manda.
 */
import assert from "node:assert/strict";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { afterEach, test } from "node:test";
import { createServerApp, COLUNAS_CSV, celulaCsv, dataHoraBrasilia } from "../server.mjs";

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const PAINEL_EMAIL = "equipe@escolaenfermagemdevalor.com.br";
const PAINEL_SENHA = "SenhaDoPainel@2026";
const PAINEL_SEGREDO = "segredo-de-sessao-de-teste-0123456789abcdef";

function hashDe(senha) {
  const salt = randomBytes(16);
  const hash = scryptSync(senha, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 16384, 8, 1, salt.toString("hex"), hash.toString("hex")].join("$");
}
const PAINEL_HASH = hashDe(PAINEL_SENHA);

const servers = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        })
    )
  );
});

async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const RESUMO = {
  desde: null,
  ate: null,
  perfil: null,
  visitantes: 120,
  visitas: 180,
  comecaram: 90,
  pessoas: 60,
  tentativas: 64,
  concluidas: 41,
  com_perfil: 58,
  tempo_mediano_segundos: 412,
  por_etapa: [{ etapa: 1, chegaram: 58 }],
  pararam_em: [],
  perfis: [],
  distribuicoes: [],
  responderam: [],
  escalas: [],
  por_dia: [],
  trafego: []
};

/**
 * `tabelas` responde GET em pesquisa_pessoas / pesquisa_respostas (função recebe a URL e devolve
 * { linhas, total } ou uma Response). `rpc` responde por nome de função.
 */
function createFakeBackend({ rpc = {}, tabelas = {} } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const endereco = new URL(String(url));
    chamadas.push({
      url: String(url),
      caminho: endereco.pathname,
      params: endereco.searchParams,
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined
    });

    const nome = endereco.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
    if (nome) {
      const resposta = rpc[nome] ?? (nome === "pesquisa_painel" ? RESUMO : undefined);
      if (typeof resposta === "function") return await resposta(chamadas.at(-1));
      if (resposta !== undefined) return jsonResponse(resposta);
      return jsonResponse({ message: "função desconhecida" }, 404);
    }

    const tabela = endereco.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
    if (tabela && tabelas[tabela]) {
      const resultado = await tabelas[tabela](endereco.searchParams, chamadas.at(-1));
      if (resultado instanceof Response) return resultado;
      const { linhas, total } = resultado;
      const offset = Number(endereco.searchParams.get("offset") || 0);
      return jsonResponse(linhas, 200, {
        "Content-Range": linhas.length ? `${offset}-${offset + linhas.length - 1}/${total ?? "*"}` : `*/${total ?? "*"}`
      });
    }
    return jsonResponse({ message: "rota inesperada no teste" }, 404);
  };
  return { chamadas, fetchImpl };
}

function painelApp({ backend = createFakeBackend(), ...options } = {}) {
  const server = createServerApp({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    painelEmail: PAINEL_EMAIL,
    painelSenhaHash: PAINEL_HASH,
    painelSessaoSegredo: PAINEL_SEGREDO,
    resolveEmailDomain: async () => "ok",
    fetchImpl: backend.fetchImpl,
    ...options
  });
  return { server, backend };
}

function login(appUrl, { email = PAINEL_EMAIL, senha = PAINEL_SENHA, headers = {} } = {}) {
  return fetch(`${appUrl}/api/painel/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email, senha })
  });
}

function cookieDe(response) {
  const [cookie] = response.headers.getSetCookie();
  return String(cookie || "").split(";")[0];
}

async function logado(opcoes) {
  const { server, backend } = painelApp(opcoes);
  const appUrl = await listen(server);
  const cookie = cookieDe(await login(appUrl));
  assert.match(cookie, /^ev_painel=/);
  const get = (rota) => fetch(`${appUrl}${rota}`, { headers: { Cookie: cookie } });
  return { appUrl, backend, cookie, get };
}

function tokenAssinado(payload, segredo = PAINEL_SEGREDO) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${createHmac("sha256", segredo).update(data).digest("base64url")}`;
}

function rawRequest(appUrl, { method = "GET", path, headers = {}, body }) {
  const { port } = new URL(appUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const ROTAS_DE_DADOS = [
  "/api/painel/resumo",
  "/api/painel/respostas",
  "/api/painel/abertas?chaves=sonho",
  "/api/painel/cruzamento?linha=perfil&coluna=renda_atual",
  "/api/painel/paginas",
  "/api/painel/exportar.csv"
];

/* ================================================================== configuração e login */

test("sem PAINEL_* configurado: login, sessão e dados respondem 503 painel_not_configured", async () => {
  for (const faltando of ["painelEmail", "painelSenhaHash", "painelSessaoSegredo"]) {
    const { server } = painelApp({ [faltando]: "" });
    const appUrl = await listen(server);

    const response = await login(appUrl);
    assert.equal(response.status, 503, faltando);
    assert.deepEqual(await response.json(), { ok: false, error: "painel_not_configured" });

    for (const rota of ["/api/painel/sessao", ...ROTAS_DE_DADOS]) {
      const dados = await fetch(`${appUrl}${rota}`);
      assert.equal(dados.status, 503, `${faltando} ${rota}`);
      assert.deepEqual(await dados.json(), { ok: false, error: "painel_not_configured" });
    }
  }
});

test("login: credenciais erradas → 401 sem cookie; certas → cookie de sessão", async () => {
  const { server } = painelApp();
  const appUrl = await listen(server);

  for (const credenciais of [{ senha: "senha-errada-123" }, { email: "outra@pessoa.com" }, { senha: "" }, { email: "", senha: "" }]) {
    const response = await login(appUrl, credenciais);
    assert.equal(response.status, 401, JSON.stringify(credenciais));
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_credentials" });
    assert.deepEqual(response.headers.getSetCookie(), []);
  }

  const semJson = await fetch(`${appUrl}/api/painel/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `email=${PAINEL_EMAIL}&senha=${PAINEL_SENHA}`
  });
  assert.equal(semJson.status, 415);

  const quebrado = await fetch(`${appUrl}/api/painel/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(quebrado.status, 400);

  const get = await fetch(`${appUrl}/api/painel/login`);
  assert.equal(get.status, 405);

  // E-mail com maiúsculas e espaço é o mesmo e-mail.
  const ok = await login(appUrl, { email: `  ${PAINEL_EMAIL.toUpperCase()} ` });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, email: PAINEL_EMAIL });
  assert.equal(ok.headers.get("cache-control"), "no-store");

  const [cookie] = ok.headers.getSetCookie();
  assert.match(cookie, /^ev_painel=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; /);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Max-Age=28800/);
  // Em localhost, sem HTTPS, o cookie não pode ser Secure (senão o navegador o descarta).
  assert.doesNotMatch(cookie, /Secure/);
});

test("cookie é Secure fora de localhost, mesmo sem X-Forwarded-Proto", async () => {
  const { server } = painelApp();
  const appUrl = await listen(server);
  const corpo = JSON.stringify({ email: PAINEL_EMAIL, senha: PAINEL_SENHA });

  for (const headers of [{ Host: "pesquisa.escolaenfermagemdevalor.com.br" }, { Host: "localhost:3000", "X-Forwarded-Proto": "https" }]) {
    const response = await rawRequest(appUrl, {
      method: "POST",
      path: "/api/painel/login",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(corpo), ...headers },
      body: corpo
    });
    assert.equal(response.status, 200);
    assert.match(response.headers["set-cookie"][0], /; Secure$/, JSON.stringify(headers));
  }
});

test("login: 10 tentativas por 15 minutos por IP", async () => {
  let agora = Date.parse("2026-09-21T12:00:00Z");
  const { server } = painelApp({ now: () => agora });
  const appUrl = await listen(server);

  for (let i = 0; i < 10; i += 1) {
    const response = await login(appUrl, { senha: `errada-${i}-xxxxx` });
    assert.equal(response.status, 401, `tentativa ${i + 1}`);
  }
  const bloqueada = await login(appUrl);
  assert.equal(bloqueada.status, 429);
  assert.deepEqual(await bloqueada.json(), { ok: false, error: "too_many_attempts" });

  // Outro IP (último item do X-Forwarded-For) não é afetado; forjar o primeiro item não adianta.
  assert.equal((await login(appUrl, { headers: { "X-Forwarded-For": "200.1.1.1" } })).status, 200);
  assert.equal((await login(appUrl, { headers: { "X-Forwarded-For": "200.1.1.1, 127.0.0.1" } })).status, 429);

  agora += 15 * 60 * 1000 + 1;
  assert.equal((await login(appUrl)).status, 200);
});

/* ================================================================== sessão */

test("sessão: sem cookie, assinatura adulterada, payload trocado, segredo errado ou expirada → 401", async () => {
  let agora = Date.parse("2026-09-21T12:00:00Z");
  const { server } = painelApp({ now: () => agora });
  const appUrl = await listen(server);
  const sessao = (cookie) => fetch(`${appUrl}/api/painel/sessao`, { headers: cookie ? { Cookie: cookie } : {} });

  const cookie = cookieDe(await login(appUrl));
  const valida = await sessao(cookie);
  assert.equal(valida.status, 200);
  assert.deepEqual(await valida.json(), { ok: true, email: PAINEL_EMAIL });

  const token = cookie.slice("ev_painel=".length);
  const [data, assinatura] = token.split(".");
  const payloadTrocado = Buffer.from(JSON.stringify({ email: "invasor@x.com", exp: agora + 1e9 })).toString("base64url");

  for (const invalido of [
    null,
    "ev_painel=",
    "ev_painel=abc",
    "ev_painel=abc.def",
    `ev_painel=${data}.${assinatura.slice(0, -2)}xx`,
    `ev_painel=${payloadTrocado}.${assinatura}`,
    `ev_painel=${token}.extra`,
    `ev_painel=${tokenAssinado({ email: PAINEL_EMAIL, exp: agora + 60_000 }, "outro-segredo")}`,
    `ev_painel=${tokenAssinado({ email: PAINEL_EMAIL })}`,
    `ev_painel=${tokenAssinado({ email: PAINEL_EMAIL, exp: "9999999999999" })}`,
    `outro_cookie=${token}`
  ]) {
    const response = await sessao(invalido);
    assert.equal(response.status, 401, String(invalido));
    assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
  }

  // Token bem assinado continua valendo até expirar (8h).
  agora += 8 * 60 * 60 * 1000 - 1000;
  assert.equal((await sessao(cookie)).status, 200);
  agora += 2000;
  assert.equal((await sessao(cookie)).status, 401);
});

test("logout exige JSON e limpa o cookie", async () => {
  const { appUrl, cookie } = await logado();

  const cruzado = await fetch(`${appUrl}/api/painel/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "x=1"
  });
  assert.equal(cruzado.status, 415);
  assert.deepEqual(cruzado.headers.getSetCookie(), []);

  const response = await fetch(`${appUrl}/api/painel/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: "{}"
  });
  assert.equal(response.status, 200);
  const [limpo] = response.headers.getSetCookie();
  assert.match(limpo, /^ev_painel=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0/);
});

test("todas as rotas de dados exigem sessão (401 JSON), e 503 sem banco", async () => {
  const { server } = painelApp();
  const appUrl = await listen(server);
  for (const rota of ROTAS_DE_DADOS) {
    const response = await fetch(`${appUrl}${rota}`);
    assert.equal(response.status, 401, rota);
    assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
  }

  const semBanco = await logado({ supabaseUrl: "", supabaseKey: "" });
  for (const rota of ROTAS_DE_DADOS) {
    const response = await semBanco.get(rota);
    assert.equal(response.status, 503, rota);
    assert.deepEqual(await response.json(), { ok: false, error: "database_not_configured" });
  }

  for (const rota of ROTAS_DE_DADOS) {
    const post = await fetch(`${appUrl}${rota}`, { method: "POST" });
    assert.equal(post.status, 405, rota);
  }
});

/* ================================================================== resumo */

test("resumo: chama pesquisa_painel com filtros e as chaves de texto a ignorar", async () => {
  const agora = Date.parse("2026-09-21T18:00:00Z");
  const { get, backend } = await logado({ now: () => agora });

  const response = await get("/api/painel/resumo");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, resumo: RESUMO, gerado_em: "2026-09-21T18:00:00.000Z" });
  assert.equal(response.headers.get("cache-control"), "no-store");

  const chamada = backend.chamadas.at(-1);
  assert.equal(chamada.url, `${SUPABASE_URL}/rest/v1/rpc/pesquisa_painel`);
  assert.equal(chamada.method, "POST");
  assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  assert.equal(chamada.headers.Authorization, `Bearer ${SUPABASE_KEY}`);
  assert.deepEqual(chamada.body.p_desde, null);
  assert.deepEqual(chamada.body.p_ate, null);
  assert.deepEqual(chamada.body.p_perfil, null);
  // Só as 4 abertas (29, 30 e as duas partes da 31): nenhuma pergunta tem "Outro".
  assert.deepEqual(chamada.body.p_ignorar, ["problema_unico", "sonho", "frase_desejo", "frase_bloqueio"]);

  const filtrado = await get(
    `/api/painel/resumo?desde=${encodeURIComponent("2026-09-14T03:00:00.000Z")}&ate=2026-09-21T03:00:00-03:00&perfil=${encodeURIComponent("Técnico(a) de enfermagem")}`
  );
  assert.equal(filtrado.status, 200);
  assert.deepEqual(
    { ...backend.chamadas.at(-1).body, p_ignorar: undefined },
    {
      p_desde: "2026-09-14T03:00:00.000Z",
      p_ate: "2026-09-21T06:00:00.000Z",
      p_perfil: "Técnico(a) de enfermagem",
      p_ignorar: undefined,
      p_status: null,
      p_busca: null,
      p_busca_digitos: null
    }
  );
});

test("resumo, cruzamento e abertas: status e busca viram filtro (mesma validação da lista e do CSV)", async () => {
  const backend = createFakeBackend({
    rpc: {
      pesquisa_abertas: { total: 0, itens: [] },
      pesquisa_cruzamento: { linha: "perfil", coluna: "idade", base: 0, celulas: [], linhas: [], colunas: [] }
    }
  });
  const { get } = await logado({ backend });
  const rotas = {
    pesquisa_painel: "/api/painel/resumo?",
    pesquisa_cruzamento: "/api/painel/cruzamento?linha=perfil&coluna=idade&",
    pesquisa_abertas: "/api/painel/abertas?chaves=sonho&"
  };
  const casos = [
    // Vazio (ou ausente) vira null: sem filtro.
    ["", { p_status: null, p_busca: null, p_busca_digitos: null }],
    ["status=&busca=", { p_status: null, p_busca: null, p_busca_digitos: null }],
    ["status=concluida", { p_status: "concluida", p_busca: null, p_busca_digitos: null }],
    ["status=em_andamento&busca=maria", { p_status: "em_andamento", p_busca: "maria", p_busca_digitos: null }],
    // Sintaxe do PostgREST sai, como na lista; com letras não procura no telefone.
    [`busca=${encodeURIComponent(" Maria (11) 9*,%\"\\ ")}`, { p_status: null, p_busca: "Maria 11 9", p_busca_digitos: null }],
    // Cara de telefone: dígitos também (+55 e máscara saem).
    [`busca=${encodeURIComponent("+55 (11) 91234-5678")}`, { p_status: null, p_busca: "+55 11 91234-5678", p_busca_digitos: "11912345678" }],
    [`busca=${encodeURIComponent("edna.4@hotmail.com")}`, { p_status: null, p_busca: "edna.4@hotmail.com", p_busca_digitos: null }],
    // Só caracteres proibidos: nenhum filtro.
    [`busca=${encodeURIComponent("(*)")}`, { p_status: null, p_busca: null, p_busca_digitos: null }]
  ];
  for (const [nome, prefixo] of Object.entries(rotas)) {
    for (const [query, esperado] of casos) {
      const response = await get(prefixo + query);
      assert.equal(response.status, 200, `${nome} ${query}`);
      const chamada = backend.chamadas.at(-1);
      assert.equal(chamada.caminho, `/rest/v1/rpc/${nome}`);
      const { p_status, p_busca, p_busca_digitos } = chamada.body;
      assert.deepEqual({ p_status, p_busca, p_busca_digitos }, esperado, `${nome} ${query}`);
    }
  }
  // Busca muito longa tem teto (o mesmo da lista).
  await get(`/api/painel/resumo?busca=${"a".repeat(300)}`);
  assert.ok(backend.chamadas.at(-1).body.p_busca.length <= 80);
});

test("filtros inválidos → 422 invalid_filters, sem ir ao banco", async () => {
  const { get, backend } = await logado();
  const antes = backend.chamadas.length;

  for (const rota of [
    "/api/painel/resumo?desde=ontem",
    "/api/painel/resumo?ate=2026-13-45",
    "/api/painel/resumo?perfil=Médico",
    "/api/painel/resumo?perfil=cuidador",
    // "Outro" deixou de ser perfil (decisão do cliente) e nenhum complemento "_outro" existe.
    "/api/painel/resumo?perfil=Outro",
    "/api/painel/abertas?chaves=ambientes_outro",
    "/api/painel/respostas?status=todas",
    "/api/painel/resumo?status=todas",
    "/api/painel/resumo?status=Concluida",
    "/api/painel/cruzamento?linha=perfil&coluna=idade&status=x",
    "/api/painel/abertas?chaves=sonho&status=concluidas",
    "/api/painel/respostas?limite=0",
    "/api/painel/respostas?limite=-5",
    "/api/painel/respostas?limite=dez",
    "/api/painel/respostas?limite=1.5",
    "/api/painel/respostas?offset=-1",
    "/api/painel/respostas?perfil=x",
    "/api/painel/abertas",
    "/api/painel/abertas?chaves=",
    "/api/painel/abertas?chaves=perfil",
    "/api/painel/abertas?chaves=sonho,nome",
    "/api/painel/abertas?chaves=sonho&limite=0",
    "/api/painel/cruzamento",
    "/api/painel/cruzamento?linha=perfil",
    "/api/painel/cruzamento?linha=perfil&coluna=perfil",
    "/api/painel/cruzamento?linha=perfil&coluna=sonho",
    "/api/painel/cruzamento?linha=frase&coluna=idade",
    "/api/painel/cruzamento?linha=perfil&coluna=nome",
    "/api/painel/cruzamento?linha=perfil&coluna=idade&desde=x",
    "/api/painel/exportar.csv?tentativas=algumas",
    "/api/painel/exportar.csv?status=x",
    "/api/painel/exportar.csv?desde=x",
    "/api/painel/paginas?desde=ontem",
    "/api/painel/paginas?ate=2026-13-45"
  ]) {
    const response = await get(rota);
    assert.equal(response.status, 422, rota);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_filters" }, rota);
  }
  assert.equal(backend.chamadas.length, antes);
});

test("banco fora ou resposta fora do formato → 502 database_unavailable", async () => {
  for (const [rota, backend] of [
    ["/api/painel/resumo", createFakeBackend({ rpc: { pesquisa_painel: () => jsonResponse({ message: "x" }, 500) } })],
    ["/api/painel/resumo", createFakeBackend({ rpc: { pesquisa_painel: [] } })],
    ["/api/painel/resumo", createFakeBackend({ rpc: { pesquisa_painel: () => Promise.reject(new Error("timeout")) } })],
    ["/api/painel/abertas?chaves=sonho", createFakeBackend({ rpc: { pesquisa_abertas: "texto" } })],
    ["/api/painel/cruzamento?linha=perfil&coluna=idade", createFakeBackend({ rpc: { pesquisa_cruzamento: () => jsonResponse({}, 401) } })],
    ["/api/painel/respostas", createFakeBackend({ tabelas: { pesquisa_pessoas: () => jsonResponse({ message: "x" }, 500) } })],
    ["/api/painel/respostas", createFakeBackend({ tabelas: { pesquisa_pessoas: () => jsonResponse({ nao: "lista" }) } })],
    ["/api/painel/exportar.csv", createFakeBackend({ tabelas: { pesquisa_pessoas: () => jsonResponse({ message: "x" }, 503) } })],
    ["/api/painel/paginas", createFakeBackend({ rpc: { paginas_resumo: () => jsonResponse({ message: "x" }, 500) } })],
    ["/api/painel/paginas", createFakeBackend({ rpc: { paginas_resumo: [] } })],
    ["/api/painel/paginas", createFakeBackend({ rpc: { paginas_resumo: { paginas: "nao-e-lista" } } })],
    ["/api/painel/paginas", createFakeBackend({ rpc: { paginas_resumo: () => Promise.reject(new Error("timeout")) } })]
  ]) {
    const { get } = await logado({ backend });
    const response = await get(rota);
    assert.equal(response.status, 502, rota);
    assert.deepEqual(await response.json(), { ok: false, error: "database_unavailable" });
  }
});

/* ================================================================== páginas de obrigado */

test("paginas: chama paginas_resumo com o período e o mapa perfil → página do obrigado-config", async () => {
  const agora = Date.parse("2026-09-21T18:00:00Z");
  const PAGINAS = [
    { pagina: "afericao", visitas: 3, visitantes: 2, cliques: 1, clicaram: 1, atribuidas: 4, por_perfil: [], por_origem: [], por_dia: [] },
    { pagina: "cuidador", visitas: 0, visitantes: 0, cliques: 0, clicaram: 0, atribuidas: 0, por_perfil: [], por_origem: [], por_dia: [] },
    { pagina: "evento_outubro", visitas: 0, visitantes: 0, cliques: 0, clicaram: 0, atribuidas: 0, por_perfil: [], por_origem: [], por_dia: [] }
  ];
  const backend = createFakeBackend({ rpc: { paginas_resumo: { paginas: PAGINAS } } });
  const { get } = await logado({ backend, now: () => agora });

  const response = await get("/api/painel/paginas?desde=2026-09-14T03:00:00.000Z&ate=2026-09-21T03:00:00Z");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, paginas: PAGINAS, gerado_em: "2026-09-21T18:00:00.000Z" });

  const chamada = backend.chamadas.find((item) => item.caminho === "/rest/v1/rpc/paginas_resumo");
  assert.equal(chamada.method, "POST");
  assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  assert.deepEqual(chamada.body, {
    p_desde: "2026-09-14T03:00:00.000Z",
    p_ate: "2026-09-21T03:00:00.000Z",
    p_mapa: {
      "Auxiliar ou antiga atendente de enfermagem": "afericao",
      "Cuidador(a)": "cuidador",
      "Técnico(a) de enfermagem": "evento_outubro",
      "Enfermeiro(a)": "evento_outubro"
    }
  });

  // Sem período: null nos dois. Perfil, situação e busca não existem nesta rota (e não quebram).
  await get("/api/painel/paginas?perfil=Cuidador(a)&busca=maria");
  const semPeriodo = backend.chamadas.filter((item) => item.caminho === "/rest/v1/rpc/paginas_resumo").at(-1);
  assert.equal(semPeriodo.body.p_desde, null);
  assert.equal(semPeriodo.body.p_ate, null);
});

/* ================================================================== respostas (lista de pessoas) */

test("respostas: consulta pesquisa_pessoas com ordem estável, paginação, contagem e filtros", async () => {
  const itens = [{ id: "a", nome: "Maria da Silva" }, { id: "b", nome: "Ana Souza" }];
  const backend = createFakeBackend({ tabelas: { pesquisa_pessoas: () => ({ linhas: itens, total: 57 }) } });
  const { get } = await logado({ backend });

  const response = await get("/api/painel/respostas");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, total: 57, itens });

  let chamada = backend.chamadas.at(-1);
  assert.equal(chamada.caminho, "/rest/v1/pesquisa_pessoas");
  assert.equal(chamada.method, "GET");
  assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  assert.equal(chamada.headers.Authorization, `Bearer ${SUPABASE_KEY}`);
  assert.equal(chamada.headers.Prefer, "count=exact");
  assert.deepEqual(Object.fromEntries(chamada.params), { select: "*", order: "criado_em.desc,id.desc", limit: "100", offset: "0", pesquisa: "eq.icp-escola-ev" });

  await get(
    `/api/painel/respostas?status=concluida&busca=${encodeURIComponent(" Maria (11) 9*,%\"\\ ")}&limite=9999&offset=200&desde=2026-09-01T03:00:00Z&ate=2026-09-21T03:00:00Z&perfil=${encodeURIComponent("Cuidador(a)")}`
  );
  chamada = backend.chamadas.at(-1);
  assert.equal(chamada.params.get("limit"), "500");
  assert.equal(chamada.params.get("offset"), "200");
  assert.equal(chamada.params.get("status"), "eq.concluida");
  assert.equal(chamada.params.get("perfil"), "eq.Cuidador(a)");
  assert.deepEqual(chamada.params.getAll("criado_em"), ["gte.2026-09-01T03:00:00.000Z", "lt.2026-09-21T03:00:00.000Z"]);
  // Nada de sintaxe do PostgREST vindo da busca. Com letras, não é telefone: nada de WhatsApp.
  assert.equal(chamada.params.get("or"), "(nome.ilike.*Maria 11 9*,email.ilike.*Maria 11 9*)");

  // Busca com cara de telefone procura também nos dígitos do WhatsApp (+55 e máscara saem).
  await get(`/api/painel/respostas?busca=${encodeURIComponent("(11) 91234")}`);
  assert.equal(backend.chamadas.at(-1).params.get("or"), "(nome.ilike.*11 91234*,email.ilike.*11 91234*,whatsapp_digits.ilike.*1191234*)");
  await get(`/api/painel/respostas?busca=${encodeURIComponent("+55 11 91234-5678")}`);
  assert.match(backend.chamadas.at(-1).params.get("or"), /whatsapp_digits\.ilike\.\*11912345678\*\)$/);
  // E-mail com número não vira "todo WhatsApp que tem 4".
  await get(`/api/painel/respostas?busca=${encodeURIComponent("edna.4@hotmail.com")}`);
  assert.equal(backend.chamadas.at(-1).params.get("or"), "(nome.ilike.*edna.4@hotmail.com*,email.ilike.*edna.4@hotmail.com*)");

  await get("/api/painel/respostas?busca=maria");
  assert.equal(backend.chamadas.at(-1).params.get("or"), "(nome.ilike.*maria*,email.ilike.*maria*)");

  // Busca que só tinha caracteres proibidos não vira filtro vazio.
  await get(`/api/painel/respostas?busca=${encodeURIComponent("(*)")}`);
  assert.equal(backend.chamadas.at(-1).params.get("or"), null);
});

/* ================================================================== abertas e cruzamento */

test("abertas: chama pesquisa_abertas só com chaves de texto", async () => {
  const resultado = { total: 3, itens: [{ id: "x", nome: "Maria", textos: { sonho: "Ter minha clínica" } }] };
  const backend = createFakeBackend({ rpc: { pesquisa_abertas: resultado } });
  const { get } = await logado({ backend });

  const response = await get(`/api/painel/abertas?chaves=frase_desejo,frase_bloqueio,frase_desejo&limite=50&offset=100&perfil=${encodeURIComponent("Enfermeiro(a)")}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ...resultado });

  const chamada = backend.chamadas.at(-1);
  assert.equal(chamada.url, `${SUPABASE_URL}/rest/v1/rpc/pesquisa_abertas`);
  assert.equal(chamada.method, "POST");
  assert.deepEqual(chamada.body, {
    p_chaves: ["frase_desejo", "frase_bloqueio"],
    p_desde: null,
    p_ate: null,
    p_perfil: "Enfermeiro(a)",
    p_limite: 50,
    p_offset: 100,
    p_status: null,
    p_busca: null,
    p_busca_digitos: null
  });

  await get("/api/painel/abertas?chaves=problema_unico");
  assert.deepEqual(backend.chamadas.at(-1).body.p_chaves, ["problema_unico"]);
  assert.equal(backend.chamadas.at(-1).body.p_limite, 200);
  await get("/api/painel/abertas?chaves=sonho&limite=9000");
  assert.equal(backend.chamadas.at(-1).body.p_limite, 500);
});

test("cruzamento: chama pesquisa_cruzamento com duas perguntas analisáveis diferentes", async () => {
  const cruzamento = { linha: "perfil", coluna: "renda_atual", base: 10, celulas: [], linhas: [], colunas: [] };
  const backend = createFakeBackend({ rpc: { pesquisa_cruzamento: cruzamento } });
  const { get } = await logado({ backend });

  const response = await get("/api/painel/cruzamento?linha=perfil&coluna=renda_atual&desde=2026-09-01T00:00:00Z");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, cruzamento });
  assert.deepEqual(backend.chamadas.at(-1).body, {
    p_linha: "perfil",
    p_coluna: "renda_atual",
    p_desde: "2026-09-01T00:00:00.000Z",
    p_ate: null,
    p_perfil: null,
    p_status: null,
    p_busca: null,
    p_busca_digitos: null
  });

  // Múltipla, escala e lista também cruzam.
  for (const [linha, coluna] of [["ambientes", "seguranca"], ["estado", "cuidador_realidade"]]) {
    const ok = await get(`/api/painel/cruzamento?linha=${linha}&coluna=${coluna}`);
    assert.equal(ok.status, 200, `${linha} × ${coluna}`);
  }
});

/* ================================================================== CSV */

function linhaPessoa(n, extra = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    criado_em: "2026-09-21T14:05:00+00:00",
    concluido_em: null,
    status: "em_andamento",
    progresso_percentual: 35,
    pergunta_max: "maior_dificuldade",
    tentativas: 1,
    nome: `Pessoa ${n}`,
    whatsapp: "(11) 91234-5678",
    whatsapp_internacional: "5511912345678",
    email: `pessoa${n}@gmail.com`,
    respostas: { perfil: "Cuidador(a)" },
    tempo_total_segundos: null,
    dispositivo: "mobile",
    utm_source: "instagram",
    pesquisa_versao: "1.0",
    ...extra
  };
}

// Parser mínimo de CSV com aspas (o suficiente para conferir o que o servidor escreve).
// Response.text() já descarta o BOM (TextDecoder); quem quer conferir o BOM lê os bytes.
function lerCsv(texto) {
  assert.notEqual(texto.charCodeAt(0), 0xfeff, "BOM deveria ter sido consumido pelo decoder");
  const linhas = [];
  let linha = [];
  let campo = "";
  let aspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i += 1;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ";") {
      linha.push(campo);
      campo = "";
    } else if (c === "\r" && texto[i + 1] === "\n") {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
      i += 1;
    } else campo += c;
  }
  if (campo || linha.length) throw new Error("CSV terminou sem \\r\\n");
  return linhas;
}

test("CSV: cabeçalhos HTTP, BOM, separador ';', CRLF e colunas na ordem do contrato", async () => {
  const agora = Date.parse("2026-09-22T01:30:00Z"); // 21/09 ainda, no horário de Brasília
  const backend = createFakeBackend({ tabelas: { pesquisa_pessoas: () => ({ linhas: [linhaPessoa(1)] }) } });
  const { get } = await logado({ backend, now: () => agora });

  const response = await get("/api/painel/exportar.csv");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="pesquisa-icp-2026-09-21.csv"');
  assert.equal(response.headers.get("cache-control"), "no-store");

  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8");
  const texto = bytes.subarray(3).toString("utf8");
  assert.ok(texto.endsWith("\r\n"));
  assert.doesNotMatch(texto.replace(/\r\n/g, ""), /\n/);

  const [cabecalho, primeira] = lerCsv(texto);
  const esperado = [
    "id",
    "criado_em",
    "concluido_em",
    "status",
    "progresso_percentual",
    "parou_em",
    "tentativas",
    "nome",
    "whatsapp",
    "whatsapp_internacional",
    "email",
    "perfil_codigo",
    "pagina_obrigado",
    "1. Perfil profissional",
    "2. Idade",
    "3. Estado",
    "4. Onde mora",
    "5. Tempo na área da saúde",
    "6. Situação profissional",
    "7. Trabalha na saúde hoje",
    "8. Ambientes de trabalho",
    "9. Renda atual",
    "10. Maior dificuldade",
    "11. Situação que mais incomoda",
    "12. Segurança profissional (0 a 10)",
    "13. Situações que geram insegurança",
    "14. Objetivo em 12 meses",
    "15. Renda desejada",
    "16. O que seria evoluir na carreira",
    "17. Frequência de investimento em cursos",
    "18. Ticket já investido",
    "19. Ticket disposto a investir",
    "20. O que mais pesa na compra",
    "21. Objeções de compra",
    "22. Formato de aprendizado preferido",
    "23. Tempo de estudo por semana",
    "24. Período de estudo",
    "25. Onde busca informação",
    "26. Conteúdo que chama atenção",
    "27. Como conheceu a Iza",
    "28. Tempo acompanhando a Iza",
    "29. O único problema que resolveria",
    "30. Maior sonho profissional",
    "31. Eu gostaria muito de",
    "31. mas ainda não consegui porque",
    "A1. Auxiliar: situação atual",
    "A2. Auxiliar: documentos que comprovam a atuação",
    "B1. Cuidador: realidade",
    "B2. Cuidador: maior dificuldade",
    "C1. Técnico: momento atual",
    "C2. Técnico: maior objetivo",
    "D1. Enfermeiro: principal interesse",
    "D2. Enfermeiro: caminho profissional",
    "regiao",
    "tempo_total_min",
    "dispositivo",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbclid",
    "gclid",
    "page_url",
    "referrer",
    "pesquisa_versao",
    "enviado_n8n_em"
  ];
  assert.deepEqual(cabecalho, esperado);
  assert.deepEqual(
    COLUNAS_CSV.map((coluna) => coluna.cabecalho),
    esperado
  );
  assert.equal(primeira.length, esperado.length);
  assert.equal(primeira[esperado.indexOf("criado_em")], "21/09/2026 11:05");
  assert.equal(primeira[esperado.indexOf("parou_em")], "10. Maior dificuldade");
  assert.equal(primeira[esperado.indexOf("perfil_codigo")], "cuidador");
  assert.equal(primeira[esperado.indexOf("pagina_obrigado")], "cuidador");
});

test("CSV: perfil_codigo e pagina_obrigado de cada perfil; Técnico e Enfermeiro na mesma página, com códigos diferentes", async () => {
  const perfis = [
    ["Auxiliar ou antiga atendente de enfermagem", "auxiliar_atendente", "afericao"],
    ["Cuidador(a)", "cuidador", "cuidador"],
    ["Técnico(a) de enfermagem", "tecnico_enfermagem", "evento_outubro"],
    ["Enfermeiro(a)", "enfermeiro", "evento_outubro"],
    // Sem perfil ainda, ou um perfil que saiu da pesquisa (rascunho antigo): colunas vazias.
    [null, "", ""],
    ["Estudante da área da saúde", "", ""]
  ];
  const linhas = perfis.map(([perfil], indice) => linhaPessoa(indice + 1, { perfil, respostas: perfil ? { perfil } : {} }));
  const backend = createFakeBackend({ tabelas: { pesquisa_pessoas: () => ({ linhas }) } });
  const { get } = await logado({ backend });
  const [cabecalho, ...corpo] = lerCsv(await (await get("/api/painel/exportar.csv")).text());
  const coluna = (linha, nome) => linha[cabecalho.indexOf(nome)];
  assert.equal(cabecalho.indexOf("perfil_codigo"), cabecalho.indexOf("email") + 1);
  assert.equal(cabecalho.indexOf("pagina_obrigado"), cabecalho.indexOf("email") + 2);
  perfis.forEach(([perfil, codigo, pagina], indice) => {
    assert.equal(coluna(corpo[indice], "perfil_codigo"), codigo, String(perfil));
    assert.equal(coluna(corpo[indice], "pagina_obrigado"), pagina, String(perfil));
  });
});

test("CSV: valores — múltipla com ' | ', frase, região, tempo, fórmula neutralizada", async () => {
  const concluida = linhaPessoa(1, {
    status: "concluida",
    concluido_em: "2026-09-21T14:12:30Z",
    progresso_percentual: 100,
    pergunta_max: "fim",
    tentativas: 2,
    nome: '=HYPERLINK("http://mal.com","clique")',
    email: "+maria@gmail.com",
    tempo_total_segundos: 450,
    utm_campaign: "-desconto",
    utm_content: "@conteudo",
    utm_term: "\tTab",
    referrer: "\rcr",
    respostas: {
      perfil: "Cuidador(a)",
      estado: "Bahia",
      seguranca: 0,
      ambientes: ["Hospital", "Home care"],
      frase_desejo: 'ter minha "clínica"',
      frase_bloqueio: "falta dinheiro;\ne tempo"
    }
  });
  const andamento = linhaPessoa(2, { pergunta_max: null, respostas: null, dispositivo: null });
  concluida.webhook_enviado_em = "2026-09-21T14:13:05Z";
  const backend = createFakeBackend({ tabelas: { pesquisa_pessoas: () => ({ linhas: [concluida, andamento] }) } });
  const { get } = await logado({ backend });

  const texto = (await get("/api/painel/exportar.csv")).text();
  const [cabecalho, a, b] = lerCsv(await texto);
  const coluna = (linha, nome) => linha[cabecalho.indexOf(nome)];

  assert.equal(coluna(a, "status"), "concluida");
  assert.equal(coluna(a, "concluido_em"), "21/09/2026 11:12");
  assert.equal(coluna(a, "enviado_n8n_em"), "21/09/2026 11:13");
  assert.equal(coluna(b, "enviado_n8n_em"), "");
  assert.equal(coluna(a, "parou_em"), "");
  assert.equal(coluna(a, "tentativas"), "2");
  assert.equal(coluna(a, "nome"), `'=HYPERLINK("http://mal.com","clique")`);
  assert.equal(coluna(a, "email"), "'+maria@gmail.com");
  assert.equal(coluna(a, "utm_campaign"), "'-desconto");
  assert.equal(coluna(a, "utm_content"), "'@conteudo");
  assert.equal(coluna(a, "utm_term"), "'\tTab");
  assert.equal(coluna(a, "referrer"), "'\rcr");
  assert.equal(coluna(a, "1. Perfil profissional"), "Cuidador(a)");
  assert.equal(coluna(a, "8. Ambientes de trabalho"), "Hospital | Home care");
  assert.ok(!cabecalho.some((nome) => /Outro/.test(nome)), "nenhuma coluna \"(Outro)\"");
  assert.equal(coluna(a, "12. Segurança profissional (0 a 10)"), "0");
  assert.equal(coluna(a, "31. Eu gostaria muito de"), 'ter minha "clínica"');
  assert.equal(coluna(a, "31. mas ainda não consegui porque"), "falta dinheiro;\ne tempo");
  assert.equal(coluna(a, "3. Estado"), "Bahia");
  assert.equal(coluna(a, "regiao"), "Nordeste");
  assert.equal(coluna(a, "tempo_total_min"), "7,5");
  assert.equal(coluna(a, "whatsapp_internacional"), "5511912345678");

  // Linha com dados faltando não quebra a exportação.
  assert.equal(coluna(b, "parou_em"), "");
  assert.equal(coluna(b, "1. Perfil profissional"), "");
  assert.equal(coluna(b, "regiao"), "");
  assert.equal(coluna(b, "dispositivo"), "");
  assert.equal(coluna(b, "tempo_total_min"), "");

  assert.equal(celulaCsv(null), '""');
  assert.equal(celulaCsv('a"b'), '"a""b"');
  assert.equal(celulaCsv("=1+1"), `"'=1+1"`);
  assert.equal(dataHoraBrasilia("lixo"), "");
});

test("CSV: busca TODAS as linhas em páginas de 1.000, com os mesmos filtros, e escreve tudo", async () => {
  const total = 2_003;
  const todas = Array.from({ length: total }, (_, i) => linhaPessoa(i + 1));
  const backend = createFakeBackend({
    tabelas: {
      pesquisa_pessoas: (params) => {
        const offset = Number(params.get("offset"));
        const limite = Number(params.get("limit"));
        return { linhas: todas.slice(offset, offset + limite) };
      }
    }
  });
  const { get } = await logado({ backend });

  const response = await get(
    `/api/painel/exportar.csv?status=em_andamento&busca=maria&perfil=${encodeURIComponent("Cuidador(a)")}&desde=2026-09-01T03:00:00Z`
  );
  assert.equal(response.status, 200);
  const linhas = lerCsv(await response.text());
  assert.equal(linhas.length, total + 1);
  assert.equal(linhas[1][0], todas[0].id);
  assert.equal(linhas.at(-1)[0], todas.at(-1).id);
  assert.equal(new Set(linhas.slice(1).map((linha) => linha[0])).size, total);

  const paginas = backend.chamadas.filter((chamada) => chamada.caminho === "/rest/v1/pesquisa_pessoas");
  assert.deepEqual(
    paginas.map((chamada) => chamada.params.get("offset")),
    ["0", "1000", "2000"]
  );
  for (const chamada of paginas) {
    assert.equal(chamada.params.get("limit"), "1000");
    assert.equal(chamada.params.get("order"), "criado_em.asc,id.asc");
    assert.equal(chamada.params.get("status"), "eq.em_andamento");
    assert.equal(chamada.params.get("perfil"), "eq.Cuidador(a)");
    assert.equal(chamada.params.get("criado_em"), "gte.2026-09-01T03:00:00.000Z");
    assert.equal(chamada.params.get("or"), "(nome.ilike.*maria*,email.ilike.*maria*)");
    assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  }
});

test("CSV: exatamente 1.000 linhas pede uma página a mais e para quando ela vem vazia", async () => {
  const todas = Array.from({ length: 1_000 }, (_, i) => linhaPessoa(i + 1));
  const backend = createFakeBackend({
    tabelas: { pesquisa_pessoas: (params) => ({ linhas: todas.slice(Number(params.get("offset")), Number(params.get("offset")) + 1000) }) }
  });
  const { get } = await logado({ backend });
  const linhas = lerCsv(await (await get("/api/painel/exportar.csv")).text());
  assert.equal(linhas.length, 1_001);
  assert.equal(backend.chamadas.filter((chamada) => chamada.caminho === "/rest/v1/pesquisa_pessoas").length, 2);
});

test("CSV: tentativas=todas exporta da tabela crua (uma linha por tentativa)", async () => {
  const backend = createFakeBackend({
    tabelas: {
      pesquisa_respostas: () => ({ linhas: [linhaPessoa(1, { tentativas: undefined }), linhaPessoa(2, { tentativas: undefined })] }),
      pesquisa_pessoas: () => ({ linhas: [] })
    }
  });
  const { get } = await logado({ backend });
  const response = await get("/api/painel/exportar.csv?tentativas=todas");
  assert.equal(response.status, 200);
  const linhas = lerCsv(await response.text());
  assert.equal(linhas.length, 3);
  assert.deepEqual(
    backend.chamadas.map((chamada) => chamada.caminho),
    ["/rest/v1/pesquisa_respostas"]
  );
});

test("CSV: sem nenhuma resposta ainda sai só o cabeçalho", async () => {
  const backend = createFakeBackend({ tabelas: { pesquisa_pessoas: () => ({ linhas: [], total: 0 }) } });
  const { get } = await logado({ backend });
  const linhas = lerCsv(await (await get("/api/painel/exportar.csv")).text());
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0][0], "id");
});

test("CSV: se o banco cair no meio, a conexão é cortada (download falha em vez de vir pela metade)", async () => {
  const todas = Array.from({ length: 1_000 }, (_, i) => linhaPessoa(i + 1));
  const backend = createFakeBackend({
    tabelas: {
      pesquisa_pessoas: (params) => (params.get("offset") === "0" ? { linhas: todas } : jsonResponse({ message: "caiu" }, 500))
    }
  });
  const { get } = await logado({ backend });
  const response = await get("/api/painel/exportar.csv");
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});

test("CSV: link clicado sem sessão (pede HTML) volta para o login em vez de baixar o JSON do erro", async () => {
  const { server } = painelApp();
  const appUrl = await listen(server);
  const clique = await fetch(`${appUrl}/api/painel/exportar.csv?status=concluida`, {
    redirect: "manual",
    headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" }
  });
  assert.equal(clique.status, 302);
  assert.equal(clique.headers.get("location"), "/painel");

  // Chamada de API (sem pedir HTML) continua recebendo o 401 em JSON.
  const api = await fetch(`${appUrl}/api/painel/exportar.csv`);
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { ok: false, error: "unauthorized" });
});
