/*
 * server.mjs — rotas públicas: estático, redirect, pixel, cabeçalhos e as duas APIs da pesquisa.
 *
 * Nada sai da máquina: o Supabase e o webhook são um fetch falso que grava as chamadas, e o DNS
 * do e-mail é um resolvedor falso. O estático vem de uma pasta temporária com arquivos de
 * mentira (o HTML de verdade é de outro pedaço do projeto); as regras (lead-rules e
 * pesquisa-config) são as de verdade, lidas pelo servidor do próprio repositório.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { createServerApp, respostasLegiveis, calcularPosicao } from "../server.mjs";

const SUPABASE_URL = "https://projeto-de-teste.supabase.co";
const SUPABASE_KEY = "chave-service-role-de-teste";
const WEBHOOK_URL = "https://webhook-falso.local/pesquisa";

const servers = [];
let root;

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

/* ------------------------------------------------------------------ fixture do estático */

const HTML_PESQUISA = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Pesquisa</title></head><body><main id="app">pesquisa</main></body></html>';
const HTML_PAINEL = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Painel</title></head><body>painel</body></html>';

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ev-pesquisa-estatico-"));
  const arquivos = {
    "pesquisa.html": HTML_PESQUISA,
    "painel.html": HTML_PAINEL,
    "js/pesquisa.js": `console.log(${JSON.stringify("x".repeat(4000))});`,
    "js/painel.js": "console.log('painel');",
    "css/pesquisa.css": "body{color:#392b38}",
    "css/painel.css": "body{color:#392b38}",
    "fonts/parkinsans-latin.woff2": "wOF2-falso",
    "img/ev-logo-color.png": "png-falso",
    "img/favicon-32.png": "favicon-falso",
    "img/.oculto.png": "segredo",
    "package.json": '{"name":"segredo"}',
    "package-lock.json": "{}",
    "supabase.sql": "select 1;",
    "server.mjs": "// segredo",
    "README.md": "# segredo",
    "DEPLOY.md": "# segredo",
    Dockerfile: "FROM node",
    ".env": "SUPABASE_SERVICE_ROLE_KEY=segredo",
    ".env.example": "X=1",
    ".git/config": "[core]",
    "railway.toml": "[build]",
    "scripts/gerar-senha-painel.mjs": "// segredo",
    "scripts/util.js": "// segredo",
    "tests/server.test.mjs": "// segredo",
    "tests/dados.json": "{}",
    "node_modules/pacote/index.js": "// segredo",
    "node_modules/pacote/package.json": "{}",
    "robots.txt": "User-agent: *\nDisallow: /painel"
  };
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    const destino = path.join(root, nome);
    await mkdir(path.dirname(destino), { recursive: true });
    await writeFile(destino, conteudo);
  }
});

after(() => {});

/* ------------------------------------------------------------------ dublês */

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers }
  });
}

/**
 * Supabase + webhook falsos. `rpc` responde por nome de função; `webhook` decide o que o n8n
 * falso faz. Toda chamada fica em `chamadas`, com o corpo já parseado.
 */
function createFakeBackend({ rpc = {}, webhook } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const endereco = String(url);
    const chamada = {
      url: endereco,
      method: init.method || "GET",
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined
    };
    chamadas.push(chamada);

    if (endereco.startsWith(WEBHOOK_URL)) {
      return webhook ? await webhook(chamada) : jsonResponse({ ok: true });
    }

    const nome = endereco.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (nome) {
      const resposta = rpc[nome];
      if (typeof resposta === "function") return await resposta(chamada);
      if (resposta !== undefined) return jsonResponse(resposta);
      if (nome === "pesquisa_registrar_evento") return new Response(null, { status: 204 });
      if (nome === "pesquisa_salvar") return jsonResponse({ novo: false, aplicado: true, concluiu_agora: false, status: "em_andamento" });
    }
    return jsonResponse({ message: "rota inesperada no teste" }, 404);
  };
  return { chamadas, fetchImpl };
}

function fakeResolver(resultado = "ok") {
  const consultas = [];
  const resolveEmailDomain = async (domain) => {
    consultas.push(domain);
    return typeof resultado === "function" ? resultado(domain) : resultado;
  };
  return { consultas, resolveEmailDomain };
}

function app({ backend = createFakeBackend(), resolver = fakeResolver(), ...options } = {}) {
  const server = createServerApp({
    rootDirectory: root,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    fetchImpl: backend.fetchImpl,
    resolveEmailDomain: resolver.resolveEmailDomain,
    ...options
  });
  return { server, backend, resolver };
}

function postJson(appUrl, rota, body, headers = {}) {
  return fetch(`${appUrl}${rota}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

// fetch normaliza "/../" na URL; para testar path traversal de verdade o caminho vai cru.
function rawGet(appUrl, caminho, headers = {}) {
  const { port } = new URL(appUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: caminho, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const SESSAO = "0b6f2c9e-5a1d-4c3b-9e8f-7a6b5c4d3e2f";
const VISITANTE = "1c7a3d0f-6b2e-4d4c-8f9a-8b7c6d5e4f3a";

function corpoSalvar(extra = {}) {
  return {
    id: SESSAO,
    visitante_id: VISITANTE,
    seq: 1,
    contato: { nome: "  Maria   da Silva ", whatsapp: "11912345678", email: " Maria@Gmail.com " },
    respostas: {},
    pergunta_atual: "perfil",
    tempos: { contato: 12 },
    rastreio: { page_url: "https://pesquisa.exemplo/pesquisa?utm_source=instagram", utm_source: "instagram", dispositivo: "mobile" },
    ...extra
  };
}

/** Todas as obrigatórias respondidas para o perfil (primeira alternativa de cada). */
function respostasCompletasCuidador() {
  return {
    perfil: "Cuidador(a)",
    idade: "45 a 54 anos",
    estado: "Minas Gerais",
    localidade: "Cidade do interior",
    tempo_area: "4 a 6 anos",
    situacao_profissional: "Trabalho informalmente",
    trabalha_saude: "Sim, exclusivamente",
    ambientes: ["Hospital", "Home care"],
    renda_atual: "R$ 1.501 a R$ 2.500",
    maior_dificuldade: "Baixo salário",
    situacao_incomoda: "Trabalho muito e ganho pouco",
    seguranca: 6,
    inseguranca_situacoes: ["Medicamentos"],
    objetivo_12m: "Ganhar mais",
    renda_desejada: "R$ 3.001 a R$ 5.000",
    evolucao_carreira: "Aumento de salário",
    frequencia_investimento: "Raramente",
    maior_investimento: "Até R$ 100",
    disposicao_investimento: "R$ 101 a R$ 300",
    criterio_compra: "Preço",
    objecoes: ["Falta de dinheiro", "Falta de tempo"],
    formato_aprendizado: ["Aulas gravadas"],
    tempo_estudo: "1 a 3 horas",
    periodo_estudo: ["Noite"],
    fontes_informacao: ["Instagram", "WhatsApp"],
    tipos_conteudo: ["Cuidados com idosos"],
    como_conheceu: "Instagram",
    tempo_acompanha: "1 a 3 meses",
    frase_desejo: "trabalhar em home care",
    frase_bloqueio: "não tenho curso",
    cuidador_realidade: "Cuido de alguém da minha família",
    cuidador_dificuldade: "Administrar medicamentos"
  };
}

/* ================================================================== estático e rotas */

test("/ redireciona para /pesquisa-icp levando a query (UTMs)", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  const comQuery = await fetch(`${appUrl}/?utm_source=instagram&utm_campaign=icp%20set&fbclid=abc`, { redirect: "manual" });
  assert.equal(comQuery.status, 302);
  assert.equal(comQuery.headers.get("location"), "/pesquisa-icp?utm_source=instagram&utm_campaign=icp%20set&fbclid=abc");

  const semQuery = await fetch(`${appUrl}/`, { redirect: "manual" });
  assert.equal(semQuery.status, 302);
  assert.equal(semQuery.headers.get("location"), "/pesquisa-icp");

  // Seguindo o redirect, chega na pesquisa com a query intacta.
  const seguido = await fetch(`${appUrl}/?utm_source=ig`);
  assert.equal(seguido.status, 200);
  assert.equal(new URL(seguido.url).search, "?utm_source=ig");
  assert.match(await seguido.text(), /<main id="app">pesquisa<\/main>/);
});

test("/pesquisa (endereço antigo) é 301 para /pesquisa-icp com a query", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));
  for (const rota of ["/pesquisa", "/pesquisa/"]) {
    const response = await fetch(`${appUrl}${rota}?utm_source=ig&fbclid=x`, { redirect: "manual" });
    assert.equal(response.status, 301, rota);
    assert.equal(response.headers.get("location"), "/pesquisa-icp?utm_source=ig&fbclid=x");
  }
  const semQuery = await fetch(`${appUrl}/pesquisa`, { redirect: "manual" });
  assert.equal(semQuery.headers.get("location"), "/pesquisa-icp");
});

test("SITE_URL: og:url, canonical e imagem absoluta só quando configurado", async () => {
  const html = '<!doctype html><html><head><meta property="og:image" content="/img/og-pesquisa.jpg" /><meta name="twitter:image" content="/img/og-pesquisa.jpg" /></head><body></body></html>';
  const pasta = await mkdtemp(path.join(tmpdir(), "ev-pesquisa-site-"));
  await writeFile(path.join(pasta, "pesquisa.html"), html);

  const sem = await listen(createServerApp({ rootDirectory: pasta, metaPixelId: "off" }));
  assert.equal(await (await fetch(`${sem}/pesquisa-icp`)).text(), html);

  const com = await listen(createServerApp({ rootDirectory: pasta, metaPixelId: "off", siteUrl: "https://pesquisa.exemplo.com.br/" }));
  const texto = await (await fetch(`${com}/pesquisa-icp`)).text();
  assert.match(texto, /<meta property="og:image" content="https:\/\/pesquisa\.exemplo\.com\.br\/img\/og-pesquisa\.jpg" \/>/);
  assert.match(texto, /<meta name="twitter:image" content="https:\/\/pesquisa\.exemplo\.com\.br\/img\/og-pesquisa\.jpg" \/>/);
  assert.match(texto, /<meta property="og:url" content="https:\/\/pesquisa\.exemplo\.com\.br\/pesquisa-icp" \/>/);
  assert.match(texto, /<link rel="canonical" href="https:\/\/pesquisa\.exemplo\.com\.br\/pesquisa-icp" \/>/);

  // Valor que não é endereço http(s) não entra na página.
  const ruim = await listen(createServerApp({ rootDirectory: pasta, metaPixelId: "off", siteUrl: 'javascript:alert(1)"' }));
  assert.equal(await (await fetch(`${ruim}/pesquisa-icp`)).text(), html);
});

test("/pesquisa-icp e /pesquisa-icp/ servem a pesquisa com Pixel, CSP e cabeçalhos de segurança", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  for (const rota of ["/pesquisa-icp", "/pesquisa-icp/", "/pesquisa-icp?utm_source=x", "/pesquisa.html"]) {
    const response = await fetch(`${appUrl}${rota}`);
    const html = await response.text();
    assert.equal(response.status, 200, rota);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    // Pixel padrão da Enfermagem de Valor, injetado antes de </head>.
    assert.match(html, /fbq\('init', '538380380948773'\);\nfbq\('track', 'PageView'\);/);
    assert.match(html, /connect\.facebook\.net\/en_US\/fbevents\.js/);
    assert.match(html, /<!-- End Meta Pixel Code --><\/head>/);
    assert.equal((html.match(/fbq\('init'/g) || []).length, 1);

    assert.equal(
      response.headers.get("content-security-policy"),
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://connect.facebook.net; img-src 'self' data: https://www.facebook.com; connect-src 'self' https://www.facebook.com https://connect.facebook.net; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("x-robots-tag"), null);
  }
});

test("META_PIXEL_ID: outro id é respeitado, 'off' e valor estranho desligam", async () => {
  const outro = await listen(createServerApp({ rootDirectory: root, metaPixelId: "123456789012345" }));
  assert.match(await (await fetch(`${outro}/pesquisa-icp`)).text(), /fbq\('init', '123456789012345'\)/);

  for (const metaPixelId of ["off", "OFF", "", "123'); alert(1); ('"]) {
    const appUrl = await listen(createServerApp({ rootDirectory: root, metaPixelId }));
    const html = await (await fetch(`${appUrl}/pesquisa-icp`)).text();
    assert.doesNotMatch(html, /fbq|facebook/, JSON.stringify(metaPixelId));
    assert.equal(html, HTML_PESQUISA);
  }
});

test("/painel serve o painel sem Pixel, com noindex, no-referrer, sem moldura e CSP fechada", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  for (const rota of ["/painel", "/painel/", "/painel.html"]) {
    const response = await fetch(`${appUrl}${rota}`);
    const html = await response.text();
    assert.equal(response.status, 200, rota);
    assert.equal(html, HTML_PAINEL);
    assert.doesNotMatch(html, /fbq|facebook/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const csp = response.headers.get("content-security-policy");
    assert.equal(
      csp,
      "default-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    assert.doesNotMatch(csp, /facebook|unsafe-inline' https/);
  }

  for (const rota of ["/js/painel.js", "/css/painel.css"]) {
    const response = await fetch(`${appUrl}${rota}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", rota);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet", rota);
  }
});

test("cache: fontes imutáveis por 1 ano, imagens 1 dia, html/js/css sem cache", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));
  const cache = async (rota) => (await fetch(`${appUrl}${rota}`)).headers.get("cache-control");

  assert.equal(await cache("/fonts/parkinsans-latin.woff2"), "public, max-age=31536000, immutable");
  assert.equal(await cache("/img/ev-logo-color.png"), "public, max-age=86400");
  assert.equal(await cache("/js/pesquisa.js"), "no-cache");
  assert.equal(await cache("/css/pesquisa.css"), "no-cache");
  assert.equal(await cache("/pesquisa-icp"), "no-cache");

  const fonte = await fetch(`${appUrl}/fonts/parkinsans-latin.woff2`);
  assert.equal(fonte.headers.get("content-type"), "font/woff2");
  assert.equal(await fonte.text(), "wOF2-falso");
});

test("/favicon.ico, /health e robots.txt", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  const favicon = await fetch(`${appUrl}/favicon.ico`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("content-type"), "image/png");
  assert.equal(await favicon.text(), "favicon-falso");

  const health = await fetch(`${appUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get("cache-control"), "no-store");

  const robots = await fetch(`${appUrl}/robots.txt`);
  assert.equal(robots.headers.get("content-type"), "text/plain; charset=utf-8");
});

test("compressão br/gzip para texto, identidade quando o cliente não aceita, HEAD sem corpo", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));
  const original = `console.log(${JSON.stringify("x".repeat(4000))});`;

  const br = await rawGet(appUrl, "/js/pesquisa.js", { "Accept-Encoding": "gzip, br" });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(br.headers.vary, "Accept-Encoding");
  assert.equal(brotliDecompressSync(br.body).toString(), original);
  assert.ok(br.body.length < original.length / 4);

  const gz = await rawGet(appUrl, "/js/pesquisa.js", { "Accept-Encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gz.body).toString(), original);

  const semBr = await rawGet(appUrl, "/js/pesquisa.js", { "Accept-Encoding": "br;q=0, gzip" });
  assert.equal(semBr.headers["content-encoding"], "gzip");

  const cru = await rawGet(appUrl, "/js/pesquisa.js", { "Accept-Encoding": "identity" });
  assert.equal(cru.headers["content-encoding"], undefined);
  assert.equal(cru.body.toString(), original);

  // Pesquisa comprimida também leva o Pixel (a transformação acontece antes da compressão).
  const html = await rawGet(appUrl, "/pesquisa-icp", { "Accept-Encoding": "br" });
  assert.match(brotliDecompressSync(html.body).toString(), /fbq\('init', '538380380948773'\)/);

  // Imagem não é recomprimida.
  const png = await rawGet(appUrl, "/img/ev-logo-color.png", { "Accept-Encoding": "br" });
  assert.equal(png.headers["content-encoding"], undefined);

  const head = await fetch(`${appUrl}/pesquisa-icp`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("arquivos privados nunca são servidos", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  for (const rota of [
    "/package.json",
    "/package-lock.json",
    "/supabase.sql",
    "/server.mjs",
    "/README.md",
    "/DEPLOY.md",
    "/Dockerfile",
    "/railway.toml",
    "/.env",
    "/.env.example",
    "/.git/config",
    "/img/.oculto.png",
    "/scripts/gerar-senha-painel.mjs",
    "/scripts/util.js",
    "/tests/server.test.mjs",
    "/tests/dados.json",
    "/node_modules/pacote/index.js",
    "/node_modules/pacote/package.json",
    "/nao-existe.html",
    "/js",
    "/img/"
  ]) {
    const response = await fetch(`${appUrl}${rota}`);
    assert.equal(response.status, 404, rota);
    const texto = await response.text();
    assert.doesNotMatch(texto, /segredo/, rota);
  }
});

test("path traversal e caminhos maliciosos não escapam da raiz", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  for (const caminho of [
    "/../../../../etc/passwd",
    "/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    "/js/..%2f..%2f..%2fetc%2fpasswd",
    "/js/%2e%2e/package.json",
    "/js/../server.mjs",
    "/img/..%5c..%5cpackage.json",
    "/pesquisa.html%00.png",
    "/%E0%A4%A",
    "/..%2f.env"
  ]) {
    const response = await rawGet(appUrl, caminho);
    assert.notEqual(response.status, 200, caminho);
    assert.ok([400, 403, 404].includes(response.status), `${caminho} → ${response.status}`);
    assert.doesNotMatch(response.body.toString(), /segredo|root:/, caminho);
  }
});

test("métodos: POST no estático é 405; API desconhecida é 404 JSON", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  const post = await fetch(`${appUrl}/pesquisa-icp`, { method: "POST" });
  assert.equal(post.status, 405);

  const api = await fetch(`${appUrl}/api/nao-existe`);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { ok: false, error: "not_found" });

  for (const rota of ["/api/pesquisa/evento", "/api/pesquisa/salvar"]) {
    const get = await fetch(`${appUrl}${rota}`);
    assert.equal(get.status, 405, rota);
    assert.equal(get.headers.get("allow"), "POST");
  }
});

/* ================================================================== POST /api/pesquisa/evento */

test("evento: 415 sem JSON, 413 corpo grande, 400 JSON quebrado, 422 corpo que não é objeto", async () => {
  const { server } = app();
  const appUrl = await listen(server);

  const semJson = await fetch(`${appUrl}/api/pesquisa/evento`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "visitante_id=x"
  });
  assert.equal(semJson.status, 415);
  assert.deepEqual(await semJson.json(), { ok: false, error: "unsupported_media_type" });

  const grande = await postJson(appUrl, "/api/pesquisa/evento", { visitante_id: VISITANTE, evento: "visita", page_url: "x".repeat(70 * 1024) });
  assert.equal(grande.status, 413);
  assert.deepEqual(await grande.json(), { ok: false, error: "payload_too_large" });

  const quebrado = await postJson(appUrl, "/api/pesquisa/evento", "{visitante_id:");
  assert.equal(quebrado.status, 400);
  assert.deepEqual(await quebrado.json(), { ok: false, error: "invalid_json" });

  for (const corpo of ["[]", "null", '"texto"', "42"]) {
    const response = await postJson(appUrl, "/api/pesquisa/evento", corpo);
    assert.equal(response.status, 422, corpo);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_body" });
  }
});

test("evento: UUID e evento inválidos → 422", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);

  for (const corpo of [
    { visitante_id: "nao-e-uuid", evento: "visita" },
    { visitante_id: `${VISITANTE}0`, evento: "visita" },
    { visitante_id: VISITANTE, evento: "compra" },
    { visitante_id: VISITANTE },
    { evento: "inicio" }
  ]) {
    const response = await postJson(appUrl, "/api/pesquisa/evento", corpo);
    assert.equal(response.status, 422, JSON.stringify(corpo));
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_event" });
  }
  assert.equal(backend.chamadas.length, 0);
});

test("evento: sem banco configurado → 503 database_not_configured", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));
  const response = await postJson(appUrl, "/api/pesquisa/evento", { visitante_id: VISITANTE, evento: "visita" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "database_not_configured" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("evento: chama a RPC com service_role e o rastreio limpo", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/pesquisa/evento", {
    visitante_id: VISITANTE.toUpperCase(),
    evento: "inicio",
    page_url: "  https://pesquisa.exemplo/pesquisa?utm_source=ig  ",
    referrer: "https://l.instagram.com/",
    dispositivo: "geladeira",
    utm_source: "instagram",
    utm_medium: "",
    utm_campaign: "c".repeat(600),
    utm_content: 42,
    fbclid: "fb-123",
    gclid: null,
    extra: "ignorado"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");

  assert.equal(backend.chamadas.length, 1);
  const [chamada] = backend.chamadas;
  assert.equal(chamada.url, `${SUPABASE_URL}/rest/v1/rpc/pesquisa_registrar_evento`);
  assert.equal(chamada.method, "POST");
  assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  assert.equal(chamada.headers.Authorization, `Bearer ${SUPABASE_KEY}`);
  assert.equal(chamada.headers["Content-Type"], "application/json");
  assert.deepEqual(chamada.body, {
    p_visitante: VISITANTE,
    p_evento: "inicio",
    p_dados: {
      pesquisa: "icp-escola-ev",
      page_url: "https://pesquisa.exemplo/pesquisa?utm_source=ig",
      referrer: "https://l.instagram.com/",
      dispositivo: null,
      utm_source: "instagram",
      utm_medium: null,
      utm_campaign: "c".repeat(500),
      utm_content: null,
      utm_term: null,
      fbclid: "fb-123",
      gclid: null
    }
  });
});

test("evento: falha do banco → 502 sem vazar detalhe", async () => {
  const backend = createFakeBackend({ rpc: { pesquisa_registrar_evento: () => jsonResponse({ message: "detalhe interno" }, 500) } });
  const { server } = app({ backend });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/pesquisa/evento", { visitante_id: VISITANTE, evento: "visita" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "database_unavailable" });

  const lento = createFakeBackend({ rpc: { pesquisa_registrar_evento: () => Promise.reject(new Error("rede caiu")) } });
  const appUrl2 = await listen(app({ backend: lento }).server);
  const falha = await postJson(appUrl2, "/api/pesquisa/evento", { visitante_id: VISITANTE, evento: "visita" });
  assert.equal(falha.status, 502);
});

test("evento: rate limit de 60/min por IP, pelo último X-Forwarded-For", async () => {
  const { server } = app();
  const appUrl = await listen(server);
  const corpo = { visitante_id: VISITANTE, evento: "visita" };

  for (let i = 0; i < 60; i += 1) {
    // O primeiro item do XFF é escrito pelo cliente: trocá-lo a cada vez não burla o limite.
    const response = await postJson(appUrl, "/api/pesquisa/evento", corpo, { "X-Forwarded-For": `10.0.0.${i}, 200.1.1.1` });
    assert.equal(response.status, 200, `requisição ${i + 1}`);
  }
  const bloqueada = await postJson(appUrl, "/api/pesquisa/evento", corpo, { "X-Forwarded-For": "9.9.9.9, 200.1.1.1" });
  assert.equal(bloqueada.status, 429);
  assert.deepEqual(await bloqueada.json(), { ok: false, error: "too_many_requests" });

  // Outro IP real segue livre.
  const outro = await postJson(appUrl, "/api/pesquisa/evento", corpo, { "X-Forwarded-For": "200.2.2.2" });
  assert.equal(outro.status, 200);
});

test("evento: a janela do rate limit anda com o relógio injetado", async () => {
  let agora = Date.parse("2026-09-21T12:00:00Z");
  const { server } = app({ now: () => agora });
  const appUrl = await listen(server);
  const corpo = { visitante_id: VISITANTE, evento: "visita" };

  for (let i = 0; i < 60; i += 1) await postJson(appUrl, "/api/pesquisa/evento", corpo);
  assert.equal((await postJson(appUrl, "/api/pesquisa/evento", corpo)).status, 429);
  agora += 61_000;
  assert.equal((await postJson(appUrl, "/api/pesquisa/evento", corpo)).status, 200);
});

/* ================================================================== POST /api/pesquisa/salvar */

test("salvar: sessão e seq inválidos → 422", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);

  for (const id of [undefined, "", "abc", `${SESSAO}x`, 123]) {
    const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ id }));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_session" });
  }
  for (const seq of [undefined, -1, 1.5, "3", 1_000_001, null]) {
    const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ seq }));
    assert.equal(response.status, 422, String(seq));
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_seq" });
  }
  assert.equal(backend.chamadas.length, 0);
});

test("salvar: contato inválido → 422 invalid_contact com a mensagem de cada campo", async () => {
  const { server, backend, resolver } = app();
  const appUrl = await listen(server);

  const tudoErrado = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ contato: { nome: "maria", whatsapp: "(11) 81234-5678", email: "maria@gmail.com.br" } }));
  assert.equal(tudoErrado.status, 422);
  assert.deepEqual(await tudoErrado.json(), {
    ok: false,
    error: "invalid_contact",
    campos: {
      nome: "Escreva também o seu sobrenome.",
      whatsapp: "O WhatsApp precisa ser um celular: depois do DDD, o número começa com 9.",
      email: "Confere o final do e-mail, parece que tem um erro de digitação."
    }
  });

  const vazio = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ contato: undefined }));
  assert.deepEqual((await vazio.json()).campos, {
    nome: "Escreva seu nome.",
    whatsapp: "Informe seu WhatsApp com DDD.",
    email: "Informe seu e-mail."
  });

  const casos = [
    [{ whatsapp: "119123456789" }, "whatsapp", "Faltam números: são 11 dígitos contando o DDD."],
    [{ whatsapp: "(20) 91234-5678" }, "whatsapp", "Esse DDD não existe. Confere o número?"],
    [{ whatsapp: "(11) 99999-9999" }, "whatsapp", "Confere o número, parece que não está completo."],
    [{ whatsapp: 11912345678 }, "whatsapp", "Informe seu WhatsApp com DDD."],
    [{ email: "maria@gmail" }, "email", "Confere o e-mail, parece que tem algo errado."],
    [{ nome: "Maria 2 Silva" }, "nome", "Confere o nome: use só letras."],
    [{ nome: `Maria ${"a".repeat(200)}` }, "nome", "Confere o nome: use só letras."]
  ];
  for (const [troca, campo, mensagem] of casos) {
    const contato = { nome: "Maria da Silva", whatsapp: "(11) 91234-5678", email: "maria@gmail.com", ...troca };
    const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ contato }));
    assert.equal(response.status, 422, JSON.stringify(troca));
    assert.deepEqual((await response.json()).campos, { [campo]: mensagem }, JSON.stringify(troca));
  }

  assert.equal(backend.chamadas.length, 0);
  assert.equal(resolver.consultas.length, 0);
});

test("salvar: domínio de e-mail sem MX/A → 422 com a mensagem de domínio; dúvida de DNS deixa passar", async () => {
  const resolver = fakeResolver((dominio) => {
    if (dominio === "nao-existe-mesmo.com.br") return "missing";
    if (dominio === "dns-lento.com.br") return "unknown";
    if (dominio === "dns-quebrado.com.br") throw new Error("SERVFAIL");
    return "ok";
  });
  const { server, backend } = app({ resolver });
  const appUrl = await listen(server);
  const contato = (email) => ({ nome: "Maria da Silva", whatsapp: "(11) 91234-5678", email });

  const ausente = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ contato: contato("maria@nao-existe-mesmo.com.br") }));
  assert.equal(ausente.status, 422);
  assert.deepEqual(await ausente.json(), {
    ok: false,
    error: "invalid_contact",
    campos: { email: "Não encontramos esse endereço de e-mail. Confere se está certinho?" }
  });
  assert.equal(backend.chamadas.length, 0);

  for (const email of ["maria@dns-lento.com.br", "maria@dns-quebrado.com.br", "maria@saude.sp.gov.br"]) {
    const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ contato: contato(email) }));
    assert.equal(response.status, 200, email);
  }
});

test("salvar: cache do DNS por domínio, e domínios conhecidos nem consultam", async () => {
  let agora = Date.parse("2026-09-21T12:00:00Z");
  const resolver = fakeResolver((dominio) => (dominio.startsWith("sumido") ? "missing" : dominio.startsWith("lento") ? "unknown" : "ok"));
  const { server } = app({ resolver, now: () => agora });
  const appUrl = await listen(server);
  const salvar = (email) =>
    postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ contato: { nome: "Maria da Silva", whatsapp: "(11) 91234-5678", email } }));

  await salvar("maria@gmail.com");
  await salvar("ana@hotmail.com");
  await salvar("ana@yahoo.com.br");
  assert.deepEqual(resolver.consultas, []);

  await salvar("maria@hospital.org.br");
  await salvar("joao@hospital.org.br");
  assert.equal((await salvar("x@sumido.com.br")).status, 422);
  assert.equal((await salvar("y@sumido.com.br")).status, 422);
  assert.deepEqual(resolver.consultas, ["hospital.org.br", "sumido.com.br"]);

  // "unknown" não fica em cache: a próxima pessoa ganha uma consulta nova.
  await salvar("a@lento.com.br");
  await salvar("b@lento.com.br");
  assert.deepEqual(resolver.consultas.slice(2), ["lento.com.br", "lento.com.br"]);

  // Depois de 1 hora o cache vence.
  agora += 60 * 60 * 1000 + 1;
  await salvar("c@hospital.org.br");
  assert.equal(resolver.consultas.at(-1), "hospital.org.br");
  assert.equal(resolver.consultas.length, 5);
});

test("salvar: contato válido sem banco → 503 (depois de validar)", async () => {
  const resolver = fakeResolver();
  const appUrl = await listen(createServerApp({ rootDirectory: root, resolveEmailDomain: resolver.resolveEmailDomain }));

  const ok = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar());
  assert.equal(ok.status, 503);
  assert.deepEqual(await ok.json(), { ok: false, error: "database_not_configured" });

  const invalido = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ contato: { nome: "x" } }));
  assert.equal(invalido.status, 422);
});

test("salvar: passo do contato grava na RPC exatamente o que a SPEC pede", async () => {
  const backend = createFakeBackend({ rpc: { pesquisa_salvar: { novo: true, aplicado: true, concluiu_agora: false, status: "em_andamento" } } });
  const { server } = app({ backend });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    status: "em_andamento",
    novo: true,
    aplicado: true,
    concluiu_agora: false,
    progresso: { total: 31, obrigatorias: 28, respondidas: 0, obrigatoriasRespondidas: 0, percentual: 0, completa: false }
  });

  assert.equal(backend.chamadas.length, 1);
  const [chamada] = backend.chamadas;
  assert.equal(chamada.url, `${SUPABASE_URL}/rest/v1/rpc/pesquisa_salvar`);
  assert.equal(chamada.method, "POST");
  assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  assert.equal(chamada.headers.Authorization, `Bearer ${SUPABASE_KEY}`);
  assert.deepEqual(chamada.body, {
    p: {
      id: SESSAO,
      pesquisa: "icp-escola-ev",
      pesquisa_versao: "1.0",
      visitante_id: VISITANTE,
      seq: 1,
      nome: "Maria da Silva",
      whatsapp: "(11) 91234-5678",
      whatsapp_digits: "11912345678",
      email: "maria@gmail.com",
      perfil: null,
      respostas: {},
      pergunta_atual: "perfil",
      etapa_atual: 1,
      posicao: 1,
      pergunta_posicao: "perfil",
      etapa_posicao: 1,
      respondidas: 0,
      obrigatorias: 28,
      obrigatorias_respondidas: 0,
      total_perguntas: 31,
      progresso_percentual: 0,
      completa: false,
      finalizou: false,
      tempos: { contato: 12 },
      page_url: "https://pesquisa.exemplo/pesquisa?utm_source=instagram",
      referrer: null,
      dispositivo: "mobile",
      utm_source: "instagram",
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
      fbclid: null,
      gclid: null
    }
  });
});

test("salvar: respostas passam pelo sanitizar, tempos e rastreio são filtrados", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);

  const response = await postJson(
    appUrl,
    "/api/pesquisa/salvar",
    JSON.stringify({
      ...corpoSalvar({
        visitante_id: "invalido",
        seq: 7,
        contato: { nome: "Maria da Silva", whatsapp: "+55 (11) 91234-5678", email: "maria@gmail.com" },
        respostas: {
          perfil: "Técnico(a) de enfermagem",
          idade: "35 a 44 anos",
          estado: "Atlântida",
          seguranca: "4",
          ambientes: ["Home care", "Hospital", "Ainda não sei"],
          cuidador_realidade: "Cuido de alguém da minha família",
          hack: "<script>",
          sonho: "\u0000Ter minha clínica  "
        },
        pergunta_atual: "idade",
        tempos: { perfil: 5.4, idade: -3, estado: 90_000, contato: "7", hack: 3, localidade: 10 },
        rastreio: { dispositivo: "tablet", fbclid: "f".repeat(1500), referrer: 7 }
      })
    })
      // __proto__ como CHAVE do JSON (é assim que chega do navegador), no corpo e nas respostas.
      .replace("{", '{"__proto__":{"poluido":true},')
      .replace('"respostas":{', '"respostas":{"__proto__":{"perfil":"Cuidador(a)","poluido":true},')
  );
  assert.equal(response.status, 200);
  const { p } = backend.chamadas[0].body;
  assert.equal(p.visitante_id, null);
  assert.equal(p.seq, 7);
  assert.equal(p.whatsapp, "(11) 91234-5678");
  assert.equal(p.perfil, "Técnico(a) de enfermagem");
  assert.deepEqual(p.respostas, {
    perfil: "Técnico(a) de enfermagem",
    idade: "35 a 44 anos",
    ambientes: ["Hospital", "Home care"],
    seguranca: 4,
    sonho: "Ter minha clínica"
  });
  assert.deepEqual(p.tempos, { perfil: 5, localidade: 10 });
  assert.equal(p.dispositivo, "tablet");
  assert.equal(p.fbclid.length, 1000);
  assert.equal(p.referrer, null);
  assert.equal(p.total_perguntas, 33);
  assert.equal(p.respondidas, 5);
  assert.equal({}.poluido, undefined);
});

test("salvar: pergunta_atual — visível aceita; escondida, inventada ou 'fim' antes da hora viram a primeira pendente", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);
  const ultimaP = () => backend.chamadas.at(-1).body.p;
  const salvar = (respostas, pergunta_atual) => postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas, pergunta_atual }));
  const cuidador = { perfil: "Cuidador(a)", idade: "45 a 54 anos" };

  await salvar(cuidador, "estado");
  assert.equal(ultimaP().pergunta_atual, "estado");
  assert.equal(ultimaP().posicao, 3);
  assert.equal(ultimaP().etapa_atual, 1);

  // Pergunta do bloco de técnico para uma cuidadora: não é visível.
  for (const pedida of ["tecnico_momento", "inventada", "fim", null, 42, "__proto__"]) {
    await salvar(cuidador, pedida);
    assert.equal(ultimaP().pergunta_atual, "estado", String(pedida));
  }

  // Tudo respondido: "fim" vale, com posição PERGUNTAS.length + 1 e a maior etapa visível.
  const completas = respostasCompletasCuidador();
  await salvar(completas, "fim");
  assert.equal(ultimaP().pergunta_atual, "fim");
  assert.equal(ultimaP().posicao, 40);
  assert.equal(ultimaP().pergunta_posicao, "fim");
  assert.equal(ultimaP().etapa_atual, 9);
  assert.equal(ultimaP().etapa_posicao, 9);
  assert.equal(ultimaP().completa, true);
  assert.equal(ultimaP().progresso_percentual, 100);

  // Completa, mas sem "fim" pedido e com pergunta atual inválida: a primeira pendente é nenhuma → "fim".
  await salvar(completas, "inventada");
  assert.equal(ultimaP().pergunta_atual, "fim");

  // Estudante (sem bloco 9): o "fim" fica na etapa 8.
  const estudante = { ...completas, perfil: "Estudante da área da saúde" };
  await salvar(estudante, "fim");
  assert.equal(ultimaP().etapa_atual, 8);
  assert.equal(ultimaP().total_perguntas, 31);
});

test("salvar: a posição não regride quando a pessoa volta para corrigir", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);
  const respostas = { ...respostasCompletasCuidador() };
  delete respostas.cuidador_realidade;
  delete respostas.cuidador_dificuldade;
  delete respostas.frase_desejo;
  delete respostas.frase_bloqueio;

  // Respondeu até a 28 e voltou para a 2 (idade).
  await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas, pergunta_atual: "idade" }));
  const { p } = backend.chamadas.at(-1).body;
  assert.equal(p.pergunta_atual, "idade");
  assert.equal(p.etapa_atual, 1);
  assert.equal(p.posicao, 28);
  assert.equal(p.pergunta_posicao, "tempo_acompanha");
  assert.equal(p.etapa_posicao, 7);

  // Para a frente, a tela atual manda.
  await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas, pergunta_atual: "sonho" }));
  const adiante = backend.chamadas.at(-1).body.p;
  assert.equal(adiante.posicao, 30);
  assert.equal(adiante.pergunta_posicao, "sonho");
  assert.equal(adiante.etapa_posicao, 8);
});

test("calcularPosicao e respostasLegiveis (funções puras exportadas)", () => {
  const vazio = calcularPosicao({}, undefined, { completa: false });
  assert.deepEqual(vazio, { pergunta_atual: "perfil", etapa_atual: 1, posicao: 1, pergunta_posicao: "perfil", etapa_posicao: 1 });

  const legiveis = respostasLegiveis({
    perfil: "Cuidador(a)",
    ambientes: ["Hospital", "Home care"],
    seguranca: 0,
    frase_desejo: "ter minha clínica",
    frase_bloqueio: "falta dinheiro",
    sonho: "Ser enfermeira"
  });
  assert.deepEqual(legiveis, [
    { numero: "1", pergunta: "Qual dessas opções representa melhor sua situação profissional atualmente?", resposta: "Cuidador(a)" },
    { numero: "8", pergunta: "Em qual ambiente você trabalha ou gostaria de trabalhar?", resposta: "Hospital, Home care" },
    { numero: "12", pergunta: "De 0 a 10, quanto você se sente seguro(a) para exercer sua profissão atualmente?", resposta: "0/10" },
    { numero: "30", pergunta: "Qual é o seu maior sonho profissional dentro da enfermagem ou do cuidado?", resposta: "Ser enfermeira" },
    { numero: "31", pergunta: "Complete a frase:", resposta: "Eu gostaria muito de ter minha clínica, mas ainda não consegui porque falta dinheiro" }
  ]);
  assert.deepEqual(respostasLegiveis({ frase_bloqueio: "tempo" }), [
    { numero: "31", pergunta: "Complete a frase:", resposta: "mas ainda não consegui porque tempo" }
  ]);
});

test("salvar: banco fora ou resposta estranha → 502", async () => {
  for (const pesquisa_salvar of [() => jsonResponse({ message: "x" }, 500), [], () => Promise.reject(new Error("timeout")), () => new Response("não é json", { status: 200 })]) {
    const backend = createFakeBackend({ rpc: { pesquisa_salvar } });
    const appUrl = await listen(app({ backend }).server);
    const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: "database_unavailable" });
  }
});

test("salvar: 415, 413 e rate limit de 120/min", async () => {
  const { server } = app();
  const appUrl = await listen(server);

  const texto = await fetch(`${appUrl}/api/pesquisa/salvar`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(texto.status, 415);

  const grande = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: { sonho: "x".repeat(65 * 1024) } }));
  assert.equal(grande.status, 413);

  // As duas acima já contaram? A de 415 não (recusada antes do limite); a de 413 sim.
  for (let i = 0; i < 119; i += 1) {
    const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar());
    assert.equal(response.status, 200, `requisição ${i + 2}`);
  }
  const bloqueada = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar());
  assert.equal(bloqueada.status, 429);
  assert.deepEqual(await bloqueada.json(), { ok: false, error: "too_many_requests" });
});

/* ================================================================== webhook */

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function aguardar(condicao, limiteMs = 2000) {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > limiteMs) throw new Error("condição não aconteceu a tempo");
    await esperar(5);
  }
}

/* ================================================================== webhook (SPEC seção 10) */

/** A linha que o banco devolve em `linha` quando a tentativa acaba de finalizar. */
function linhaFinalizada(extra = {}) {
  return {
    id: SESSAO,
    pesquisa: "icp-escola-ev",
    pesquisa_versao: "1.0",
    criado_em: "2026-09-21T15:20:00+00:00",
    finalizado_em: "2026-09-21T15:26:52+00:00",
    concluido_em: "2026-09-21T15:26:40+00:00",
    tempo_total_segundos: 400,
    nome: "Maria da Silva",
    whatsapp: "(11) 91234-5678",
    whatsapp_digits: "11912345678",
    whatsapp_internacional: "5511912345678",
    email: "maria@gmail.com",
    respostas: respostasCompletasCuidador(),
    // Primeiro toque: o banco guardou a origem da primeira visita, não a do último salvamento.
    utm_source: "instagram",
    utm_medium: "stories",
    utm_campaign: "icp",
    utm_content: null,
    utm_term: null,
    fbclid: "fb-1",
    gclid: null,
    page_url: "https://pesquisa.exemplo/pesquisa-icp?utm_source=instagram",
    referrer: "https://l.instagram.com/",
    dispositivo: "mobile",
    ...extra
  };
}

function respostaFinalizou(extra = {}) {
  return { novo: false, aplicado: true, concluiu_agora: false, finalizou_agora: true, status: "concluida", linha: linhaFinalizada(), ...extra };
}

const avisosDe = (backend) => backend.chamadas.filter((chamada) => chamada.url === WEBHOOK_URL);
const marcasDe = (backend) => backend.chamadas.filter((chamada) => chamada.method === "PATCH");

test("webhook: chegar ao fim manda UM aviso 'pesquisa_concluida' com o payload da SPEC e marca webhook_enviado_em", async () => {
  const backend = createFakeBackend({
    rpc: { pesquisa_salvar: respostaFinalizou() }
  });
  const fetchOriginal = backend.fetchImpl;
  backend.fetchImpl = async (url, init) => (init?.method === "PATCH" ? (backend.chamadas.push({ url: String(url), method: "PATCH", headers: init.headers, body: JSON.parse(init.body) }), new Response(null, { status: 204 })) : fetchOriginal(url, init));
  const agora = Date.parse("2026-09-21T15:27:00Z");
  const { server } = app({ backend, webhookUrl: WEBHOOK_URL, now: () => agora });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ seq: 40, respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
  assert.equal(response.status, 200);
  const salvar = backend.chamadas.find((chamada) => chamada.url.endsWith("/rpc/pesquisa_salvar"));
  assert.equal(salvar.body.p.finalizou, true);
  assert.equal(salvar.body.p.pergunta_atual, "fim");

  await aguardar(() => marcasDe(backend).length === 1);
  const avisos = avisosDe(backend);
  assert.equal(avisos.length, 1);
  assert.equal(avisos[0].method, "POST");
  assert.equal(avisos[0].headers["Content-Type"], "application/json");
  assert.equal(avisos[0].headers["User-Agent"], "ev-pesquisa/1.0");
  assert.equal(avisos[0].headers.apikey, undefined, "a chave do Supabase nunca vai para o webhook");

  const corpo = avisos[0].body;
  const { perguntas, respostas, ...resto } = corpo;
  assert.deepEqual(resto, {
    evento: "pesquisa_concluida",
    pesquisa: { id: "icp-escola-ev", versao: "1.0" },
    sessao_id: SESSAO,
    iniciada_em: "2026-09-21T15:20:00.000Z",
    concluida_em: "2026-09-21T15:26:52.000Z",
    tempo_total_segundos: 400,
    lead: {
      nome: "Maria da Silva",
      primeiro_nome: "Maria",
      whatsapp: "(11) 91234-5678",
      whatsapp_digits: "11912345678",
      whatsapp_internacional: "5511912345678",
      email: "maria@gmail.com"
    },
    perfil: "Cuidador(a)",
    utm: { utm_source: "instagram", utm_medium: "stories", utm_campaign: "icp", utm_content: null, utm_term: null },
    rastreio: {
      fbclid: "fb-1",
      gclid: null,
      page_url: "https://pesquisa.exemplo/pesquisa-icp?utm_source=instagram",
      referrer: "https://l.instagram.com/",
      dispositivo: "mobile"
    },
    enviado_em: "2026-09-21T15:27:00.000Z"
  });
  assert.deepEqual(respostas, respostasCompletasCuidador());

  // Todas as visíveis no caminho da cuidadora (31 comuns + B1, B2), na ordem, sem A/C/D.
  assert.equal(perguntas.length, 33);
  assert.deepEqual(perguntas.map((item) => item.numero).slice(-4), ["30", "31", "B1", "B2"]);
  assert.ok(!perguntas.some((item) => /^[ACD]\d$/.test(item.numero)));
  assert.deepEqual(perguntas[0], {
    numero: "1",
    id: "perfil",
    etapa: 1,
    etapa_titulo: "Sobre você",
    pergunta: "Qual dessas opções representa melhor sua situação profissional atualmente?",
    tipo: "unica",
    obrigatoria: true,
    resposta: "Cuidador(a)",
    resposta_texto: "Cuidador(a)",
    outro: null
  });
  const porId = Object.fromEntries(perguntas.map((item) => [item.id, item]));
  assert.deepEqual(porId.ambientes.resposta, ["Hospital", "Home care"]);
  assert.equal(porId.ambientes.resposta_texto, "Hospital, Home care");
  // `outro` continua em todo item (contrato com o n8n), sempre null: nenhuma pergunta tem "Outro".
  assert.ok(perguntas.every((item) => Object.prototype.hasOwnProperty.call(item, "outro") && item.outro === null));
  assert.ok(!perguntas.some((item) => /Outro/.test(item.resposta_texto)));
  assert.equal(porId.seguranca.resposta, 6);
  assert.equal(porId.seguranca.resposta_texto, "6/10");
  assert.deepEqual(porId.frase.resposta, { desejo: "trabalhar em home care", bloqueio: "não tenho curso" });
  assert.equal(porId.frase.resposta_texto, "Eu gostaria muito de trabalhar em home care, mas ainda não consegui porque não tenho curso");
  // Opcional não respondida entra com resposta null e texto vazio.
  assert.equal(porId.sonho.resposta, null);
  assert.equal(porId.sonho.resposta_texto, "");
  assert.equal(porId.sonho.obrigatoria, false);

  // A marca de entrega vai para a linha certa, com a hora do servidor.
  const [marca] = marcasDe(backend);
  assert.equal(marca.url, `${SUPABASE_URL}/rest/v1/pesquisa_respostas?id=eq.${SESSAO}`);
  assert.deepEqual(marca.body, { webhook_enviado_em: "2026-09-21T15:27:00.000Z" });
  assert.equal(marca.headers.apikey, SUPABASE_KEY);
});

test("webhook: nada no meio da pesquisa — nem lead novo, nem concluída sem chegar ao fim", async () => {
  let resposta = { novo: true, aplicado: true, concluiu_agora: false, finalizou_agora: false, status: "em_andamento" };
  const backend = createFakeBackend({ rpc: { pesquisa_salvar: () => jsonResponse(resposta) } });
  const appUrl = await listen(app({ backend, webhookUrl: WEBHOOK_URL }).server);

  await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar());
  // Tudo respondido (concluiu_agora), mas ainda nas abertas: não é o fim.
  resposta = { novo: false, aplicado: true, concluiu_agora: true, finalizou_agora: false, status: "concluida" };
  const r = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ seq: 2, respostas: respostasCompletasCuidador(), pergunta_atual: "sonho" }));
  assert.equal(r.status, 200);
  const ultima = backend.chamadas.filter((chamada) => chamada.url.endsWith("/rpc/pesquisa_salvar")).at(-1);
  assert.equal(ultima.body.p.finalizou, false);
  // "fim" pedido sem tudo respondido: o servidor nem manda finalizou.
  await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ seq: 3, respostas: { perfil: "Cuidador(a)" }, pergunta_atual: "fim" }));
  assert.equal(backend.chamadas.filter((chamada) => chamada.url.endsWith("/rpc/pesquisa_salvar")).at(-1).body.p.finalizou, false);
  await esperar(50);
  assert.equal(avisosDe(backend).length, 0);
});

test("webhook: n8n fora tenta 3 vezes (na hora, +3 s, +10 s); depois só loga, sem marcar", async () => {
  let tentativas = 0;
  const backend = createFakeBackend({
    rpc: { pesquisa_salvar: respostaFinalizou() },
    webhook: () => {
      tentativas += 1;
      return tentativas === 1 ? Promise.reject(new Error("n8n fora")) : jsonResponse({ erro: true }, 502);
    }
  });
  const { server } = app({ backend, webhookUrl: WEBHOOK_URL, webhookEsperasMs: [0, 30, 60] });
  const appUrl = await listen(server);
  const inicio = Date.now();
  const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
  assert.equal(response.status, 200);
  assert.ok(Date.now() - inicio < 1000);
  await aguardar(() => tentativas === 3);
  await esperar(80);
  assert.equal(tentativas, 3);
  assert.equal(marcasDe(backend).length, 0);

  // O padrão de produção é exatamente 0, 3 s e 10 s.
  const fonte = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../server.mjs", import.meta.url), "utf8"));
  assert.match(fonte, /WEBHOOK_ESPERAS_MS = Object\.freeze\(\[0, 3_000, 10_000\]\)/);
});

test("webhook: a segunda tentativa entregando para de tentar e marca", async () => {
  let tentativas = 0;
  const backend = createFakeBackend({
    rpc: { pesquisa_salvar: respostaFinalizou() },
    webhook: () => {
      tentativas += 1;
      return tentativas === 1 ? jsonResponse({}, 500) : jsonResponse({ ok: true });
    }
  });
  const original = backend.fetchImpl;
  backend.fetchImpl = async (url, init) => (init?.method === "PATCH" ? (backend.chamadas.push({ url: String(url), method: "PATCH", body: JSON.parse(init.body) }), new Response(null, { status: 204 })) : original(url, init));
  const appUrl = await listen(app({ backend, webhookUrl: WEBHOOK_URL, webhookEsperasMs: [0, 20, 40] }).server);
  await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
  await aguardar(() => marcasDe(backend).length === 1);
  await esperar(80);
  assert.equal(tentativas, 2);
});

test("webhook: sem await — n8n travado não atrasa nem derruba a gravação", async () => {
  const backend = createFakeBackend({ rpc: { pesquisa_salvar: respostaFinalizou() }, webhook: () => new Promise(() => {}) });
  const appUrl = await listen(app({ backend, webhookUrl: WEBHOOK_URL }).server);
  const inicio = Date.now();
  const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.ok(Date.now() - inicio < 1000, "a resposta não esperou o webhook");
  await aguardar(() => avisosDe(backend).length === 1);
});

test("webhook: sem endereço, ou 'off', nada é enviado", async () => {
  for (const webhookUrl of [undefined, "off", "OFF"]) {
    const backend = createFakeBackend({ rpc: { pesquisa_salvar: respostaFinalizou() } });
    const appUrl = await listen(app({ backend, ...(webhookUrl ? { webhookUrl } : {}) }).server);
    await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
    await esperar(50);
    assert.deepEqual(
      backend.chamadas.map((chamada) => chamada.url),
      [`${SUPABASE_URL}/rest/v1/rpc/pesquisa_salvar`]
    );
  }
});

test("webhook: linha ausente na resposta do banco cai nos dados da requisição", async () => {
  const backend = createFakeBackend({ rpc: { pesquisa_salvar: respostaFinalizou({ linha: null }) } });
  const agora = Date.parse("2026-09-21T15:27:00Z");
  const appUrl = await listen(app({ backend, webhookUrl: WEBHOOK_URL, now: () => agora }).server);
  await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
  await aguardar(() => avisosDe(backend).length === 1);
  const corpo = avisosDe(backend)[0].body;
  assert.equal(corpo.sessao_id, SESSAO);
  assert.equal(corpo.lead.whatsapp_internacional, "5511912345678");
  assert.equal(corpo.utm.utm_source, "instagram");
  assert.equal(corpo.concluida_em, "2026-09-21T15:27:00.000Z");
  assert.equal(corpo.iniciada_em, null);
});
