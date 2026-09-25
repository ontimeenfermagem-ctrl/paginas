/*
 * server.mjs — rotas públicas: estático, redirect, pixel, cabeçalhos, as duas APIs da pesquisa, as
 * páginas de obrigado (rotas /obrigado-* e POST /api/pagina/evento), a inscrição com checkout na
 * Hotmart (POST /api/inscricao, inclusive o CORS da venda da Imersão GPS, que mora em outro site) e
 * o webhook de venda da Hotmart (POST /api/hotmart/venda).
 *
 * Nada sai da máquina: o Supabase e o webhook são um fetch falso que grava as chamadas, e o DNS
 * do e-mail é um resolvedor falso. O estático vem de uma pasta temporária com arquivos de
 * mentira (o HTML de verdade é de outro pedaço do projeto); as regras (lead-rules e
 * pesquisa-config) são as de verdade, lidas pelo servidor do próprio repositório.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import vm from "node:vm";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import {
  createServerApp,
  respostasLegiveis,
  calcularPosicao,
  extrairVendaHotmart,
  dataHotmart,
  montarPayloadInscricao,
  montarPayloadWebhook,
  origemDaRequisicao,
  normalizarOrigem,
  validarContato
} from "../server.mjs";

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
const HTML_OBRIGADO = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta property="og:image" content="/img/og-pesquisa.jpg"><title>Obrigado</title></head><body><main id="obrigado">obrigado</main></body></html>';
const HTML_INSCRICAO =
  '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta property="og:image" content="/img/og-inscricao.jpg"><title>Inscrição</title></head><body><main id="app">inscrição</main></body></html>';
const HTML_PAINEL = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>Painel</title></head><body>painel</body></html>';

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ev-pesquisa-estatico-"));
  const arquivos = {
    "pesquisa.html": HTML_PESQUISA,
    "obrigado.html": HTML_OBRIGADO,
    "obrigado-velho.html": "<html>segredo</html>",
    "viver-de-furo-inscricao.html": HTML_INSCRICAO,
    // A venda da Imersão GPS mora em OUTRO site. O arquivo existe aqui de propósito: a rota dela não
    // pode apontar para ele (ver o teste da rota /igps_set_lp_26-ingresso).
    "igps_set_lp_26-ingresso.html": HTML_INSCRICAO,
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
      if (nome === "pagina_registrar_evento") return new Response(null, { status: 204 });
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

const HTML_OG = '<!doctype html><html><head><meta property="og:image" content="/img/og-pesquisa.jpg" /><meta name="twitter:image" content="/img/og-pesquisa.jpg" /></head><body></body></html>';

async function pastaOg() {
  const pasta = await mkdtemp(path.join(tmpdir(), "ev-pesquisa-site-"));
  await writeFile(path.join(pasta, "pesquisa.html"), HTML_OG);
  return pasta;
}

async function textoCom(appUrl, headers) {
  return (await rawGet(appUrl, "/pesquisa-icp", headers)).body.toString("utf8");
}

function assertOrigem(texto, origem) {
  const e = origem.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  assert.match(texto, new RegExp(`<meta property="og:image" content="${e}\\/img\\/og-pesquisa\\.jpg" \\/>`));
  assert.match(texto, new RegExp(`<meta name="twitter:image" content="${e}\\/img\\/og-pesquisa\\.jpg" \\/>`));
  assert.match(texto, new RegExp(`<meta property="og:url" content="${e}\\/pesquisa-icp" \\/>`));
  assert.match(texto, new RegExp(`<link rel="canonical" href="${e}\\/pesquisa-icp" \\/>`));
}

test("SITE_URL: og:url, canonical e imagem absoluta; SITE_URL manda mesmo com Host/X-Forwarded-Host", async () => {
  const pasta = await pastaOg();
  const com = await listen(createServerApp({ rootDirectory: pasta, metaPixelId: "off", siteUrl: "https://pesquisa.exemplo.com.br/" }));
  assertOrigem(await (await fetch(`${com}/pesquisa-icp`)).text(), "https://pesquisa.exemplo.com.br");
  const forjado = await textoCom(com, { Host: "outro.site.com", "X-Forwarded-Host": "mais-um.com", "X-Forwarded-Proto": "http" });
  assertOrigem(forjado, "https://pesquisa.exemplo.com.br");
  assert.ok(!/outro\.site|mais-um/.test(forjado));

  // Valor que não é endereço http(s) não entra na página: cai na origem da requisição.
  const ruim = await listen(createServerApp({ rootDirectory: pasta, metaPixelId: "off", siteUrl: 'javascript:alert(1)"' }));
  const texto = await textoCom(ruim, { Host: "pesquisa.valida.com.br" });
  assert.ok(!texto.includes("javascript"));
  assertOrigem(texto, "https://pesquisa.valida.com.br");
});

test("sem SITE_URL: origem vem do Host (http para localhost/127.0.0.1, https para o resto)", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: await pastaOg(), metaPixelId: "off" }));
  const { port } = new URL(appUrl);
  assertOrigem(await (await fetch(`${appUrl}/pesquisa-icp`)).text(), `http://127.0.0.1:${port}`);
  assertOrigem(await textoCom(appUrl, { Host: "localhost:3000" }), "http://localhost:3000");
  assertOrigem(await textoCom(appUrl, { Host: "Pesquisa.Exemplo.com.br" }), "https://pesquisa.exemplo.com.br");
  // Proxy (Railway): X-Forwarded-Host (primeiro valor) e X-Forwarded-Proto.
  assertOrigem(await textoCom(appUrl, { Host: "interno:8080", "X-Forwarded-Host": "pesquisa.ev.com.br, proxy.interno", "X-Forwarded-Proto": "https" }), "https://pesquisa.ev.com.br");
  assertOrigem(await textoCom(appUrl, { Host: "pesquisa.ev.com.br", "X-Forwarded-Proto": "http,https" }), "http://pesquisa.ev.com.br");
  // Proto que não é exatamente http/https é ignorado.
  assertOrigem(await textoCom(appUrl, { Host: "pesquisa.ev.com.br", "X-Forwarded-Proto": "javascript" }), "https://pesquisa.ev.com.br");
});

test("sem SITE_URL: Host malicioso não entra na página (sem og:url/canonical, imagem relativa)", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: await pastaOg(), metaPixelId: "off" }));
  const maliciosos = ['evil.com"><script>alert(1)</script>', "evil.com<x", "evil .com", "user@evil.com", "evil.com/caminho", "evil.com'x", "evil.com:porta"];
  for (const host of maliciosos) {
    assert.equal(origemDaRequisicao({ host }), "", host);
    assert.equal(origemDaRequisicao({ host: "ok.com", "x-forwarded-host": host }), "", `xfh ${host}`);
    const texto = await textoCom(appUrl, { Host: "boa.com.br", "X-Forwarded-Host": host });
    assert.equal(texto, HTML_OG, host);
  }
});

test("sem SITE_URL: dois Hosts seguidos não se misturam no cache (Host forjado não envenena ninguém)", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: await pastaOg(), metaPixelId: "off" }));
  for (const encoding of ["identity", "gzip", "br"]) {
    const ler = async (host) => {
      const r = await rawGet(appUrl, "/pesquisa-icp", { Host: host, "Accept-Encoding": encoding });
      if (encoding === "gzip") return gunzipSync(r.body).toString("utf8");
      if (encoding === "br") return brotliDecompressSync(r.body).toString("utf8");
      return r.body.toString("utf8");
    };
    assertOrigem(await ler("atacante.com"), "https://atacante.com");
    const legitimo = await ler("pesquisa.ev.com.br");
    assertOrigem(legitimo, "https://pesquisa.ev.com.br");
    assert.ok(!legitimo.includes("atacante"), encoding);
    assertOrigem(await ler("atacante.com"), "https://atacante.com");
  }
  // Mil Hosts diferentes não fazem o cache crescer sem limite: a página certa continua saindo.
  for (let i = 0; i < 250; i += 1) await ler250(appUrl, `h${i}.com`);
  assertOrigem(await textoCom(appUrl, { Host: "pesquisa.ev.com.br" }), "https://pesquisa.ev.com.br");
});

async function ler250(appUrl, host) {
  const r = await rawGet(appUrl, "/pesquisa-icp", { Host: host, "Accept-Encoding": "identity" });
  assert.ok(r.body.toString("utf8").includes(`https://${host}/pesquisa-icp`));
}

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

/* ================================================================== páginas de obrigado */

const ROTAS_OBRIGADO = ["/obrigado-afericao", "/obrigado-cuidador", "/obrigado-evento-outubro"];

test("/obrigado-* (com e sem barra) servem obrigado.html com Pixel, CSP da pesquisa, noindex, og/canonical da própria rota e no-cache", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));

  for (const base of ROTAS_OBRIGADO) {
    for (const rota of [base, `${base}/`, `${base}?utm_source=meta&utm_campaign=x`]) {
      const response = await fetch(`${appUrl}${rota}`);
      const html = await response.text();
      assert.equal(response.status, 200, rota);
      assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(html, /<main id="obrigado">obrigado<\/main>/);
      assert.match(html, /fbq\('init', '538380380948773'\);\nfbq\('track', 'PageView'\);/, rota);
      assert.equal((html.match(/fbq\('init'/g) || []).length, 1);
      assert.equal(
        response.headers.get("content-security-policy"),
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://connect.facebook.net; img-src 'self' data: https://www.facebook.com; connect-src 'self' https://www.facebook.com https://connect.facebook.net; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive", rota);
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("cache-control"), "no-cache");
      // og:url e canonical apontam para a página pedida (sem barra, sem query), e a imagem fica absoluta.
      assert.ok(html.includes(`<meta property="og:url" content="${appUrl}${base}" />`), rota);
      assert.ok(html.includes(`<link rel="canonical" href="${appUrl}${base}" />`), rota);
      assert.ok(html.includes(`<meta property="og:image" content="${appUrl}/img/og-pesquisa.jpg">`), rota);
    }
  }

  // HEAD responde sem corpo; POST não existe.
  const head = await fetch(`${appUrl}/obrigado-cuidador`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal((await fetch(`${appUrl}/obrigado-cuidador`, { method: "POST" })).status, 405);
});

test("/obrigado-*: SITE_URL manda no og:url; as 3 rotas (mesmo arquivo) não dividem o cache", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root, siteUrl: "https://pesquisa.exemplo.com.br/" }));
  for (const rota of [...ROTAS_OBRIGADO, ...ROTAS_OBRIGADO.map((r) => `${r}/`)]) {
    for (const encoding of ["br", "gzip", "identity"]) {
      const r = await rawGet(appUrl, rota, { "Accept-Encoding": encoding, Host: "malicioso.exemplo" });
      const corpo = encoding === "br" ? brotliDecompressSync(r.body) : encoding === "gzip" ? gunzipSync(r.body) : r.body;
      const html = corpo.toString("utf8");
      const esperado = `https://pesquisa.exemplo.com.br${rota.replace(/\/$/, "")}`;
      assert.ok(html.includes(`<meta property="og:url" content="${esperado}" />`), `${rota} ${encoding}`);
      assert.ok(html.includes(`<link rel="canonical" href="${esperado}" />`), `${rota} ${encoding}`);
      assert.doesNotMatch(html, /malicioso/);
    }
  }
});

test("/obrigado*: qualquer outra rota é 404 — inclusive o arquivo direto e caminhos tortos até ele", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));
  for (const caminho of [
    "/obrigado",
    "/obrigado/",
    "/obrigado-x",
    "/obrigado-estudante",
    "/obrigado-cuidador-velho",
    "/obrigado-afericao/extra",
    "/obrigado-afericao//",
    "/obrigado.html",
    "/obrigado-velho.html",
    "/Obrigado-afericao",
    "/js/..%2fobrigado.html",
    "/img/%2e%2e/obrigado.html",
    "/./obrigado.html"
  ]) {
    const response = await rawGet(appUrl, caminho);
    assert.equal(response.status, 404, caminho);
    assert.doesNotMatch(response.body.toString(), /obrigado<\/main>|segredo/, caminho);
  }
});

/* ================================================================== POST /api/pagina/evento */

const EVENTO_PAGINA = { pagina: "cuidador", evento: "visita", visitante_id: VISITANTE, sessao_id: SESSAO, perfil: "Cuidador(a)" };

test("pagina/evento: 405 sem POST, 415 sem JSON, 413 corpo grande, 400 JSON quebrado, 422 corpo que não é objeto", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);

  const get = await fetch(`${appUrl}/api/pagina/evento`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");

  const semJson = await fetch(`${appUrl}/api/pagina/evento`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(EVENTO_PAGINA)
  });
  assert.equal(semJson.status, 415);
  assert.deepEqual(await semJson.json(), { ok: false, error: "unsupported_media_type" });

  const grande = await postJson(appUrl, "/api/pagina/evento", { ...EVENTO_PAGINA, page_url: "x".repeat(70 * 1024) });
  assert.equal(grande.status, 413);
  assert.deepEqual(await grande.json(), { ok: false, error: "payload_too_large" });

  const quebrado = await postJson(appUrl, "/api/pagina/evento", "{pagina:");
  assert.equal(quebrado.status, 400);
  assert.deepEqual(await quebrado.json(), { ok: false, error: "invalid_json" });

  for (const corpo of ["[]", "null", '"cuidador"', "7"]) {
    const response = await postJson(appUrl, "/api/pagina/evento", corpo);
    assert.equal(response.status, 422, corpo);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_body" });
  }
  assert.equal(backend.chamadas.length, 0);
});

test("pagina/evento: página ou evento fora da lista → 422, sem ir ao banco", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);
  for (const corpo of [
    { ...EVENTO_PAGINA, pagina: "estudante" },
    { ...EVENTO_PAGINA, pagina: "/obrigado-cuidador" },
    { ...EVENTO_PAGINA, pagina: "Cuidador" },
    { ...EVENTO_PAGINA, pagina: ["cuidador"] },
    { ...EVENTO_PAGINA, pagina: undefined },
    { ...EVENTO_PAGINA, evento: "inicio" },
    { ...EVENTO_PAGINA, evento: "clique" },
    { ...EVENTO_PAGINA, evento: "VISITA" },
    { ...EVENTO_PAGINA, evento: undefined },
    { ...EVENTO_PAGINA, pagina: "__proto__" },
    { ...EVENTO_PAGINA, evento: "toString" }
  ]) {
    const response = await postJson(appUrl, "/api/pagina/evento", corpo);
    assert.equal(response.status, 422, JSON.stringify(corpo));
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_event" });
  }
  assert.equal(backend.chamadas.length, 0);
});

test("pagina/evento: sem banco configurado → 503 database_not_configured", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root }));
  const response = await postJson(appUrl, "/api/pagina/evento", EVENTO_PAGINA);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "database_not_configured" });
});

test("pagina/evento: grava via pagina_registrar_evento com service_role; uuid e perfil inválidos viram null, texto aparado com teto", async () => {
  const { server, backend } = app();
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/pagina/evento", {
    pagina: "evento_outubro",
    evento: "clique_grupo",
    visitante_id: VISITANTE.toUpperCase(),
    sessao_id: "nao-e-uuid",
    perfil: "Enfermeiro(a)",
    page_url: "  https://pesquisa.exemplo/obrigado-evento-outubro?utm_source=meta  ",
    referrer: "",
    dispositivo: "desktop",
    utm_source: "meta",
    utm_medium: "   ",
    utm_campaign: "c".repeat(600),
    utm_content: 42,
    utm_term: "termo",
    fbclid: "f".repeat(1_200),
    gclid: null,
    nome: "Maria (não é campo)"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");

  assert.equal(backend.chamadas.length, 1);
  const [chamada] = backend.chamadas;
  assert.equal(chamada.url, `${SUPABASE_URL}/rest/v1/rpc/pagina_registrar_evento`);
  assert.equal(chamada.method, "POST");
  assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  assert.equal(chamada.headers.Authorization, `Bearer ${SUPABASE_KEY}`);
  assert.deepEqual(chamada.body, {
    p: {
      pagina: "evento_outubro",
      evento: "clique_grupo",
      visitante_id: VISITANTE,
      sessao_id: null,
      perfil: "Enfermeiro(a)",
      page_url: "https://pesquisa.exemplo/obrigado-evento-outubro?utm_source=meta",
      referrer: null,
      dispositivo: "desktop",
      utm_source: "meta",
      utm_medium: null,
      utm_campaign: "c".repeat(500),
      utm_content: null,
      utm_term: "termo",
      fbclid: "f".repeat(1_000),
      gclid: null
    }
  });

  // Perfil desconhecido (inclusive o "Estudante" que saiu), dispositivo estranho e ids ausentes: null.
  for (const perfil of ["Estudante da área da saúde", "Outro", "__proto__", 3, null]) {
    await postJson(appUrl, "/api/pagina/evento", { pagina: "afericao", evento: "visita", perfil, dispositivo: "geladeira" });
    const { p } = backend.chamadas.at(-1).body;
    assert.deepEqual(
      { pagina: p.pagina, evento: p.evento, perfil: p.perfil, visitante_id: p.visitante_id, sessao_id: p.sessao_id, dispositivo: p.dispositivo },
      { pagina: "afericao", evento: "visita", perfil: null, visitante_id: null, sessao_id: null, dispositivo: null },
      String(perfil)
    );
  }
});

test("pagina/evento: falha do banco → 502 sem vazar detalhe", async () => {
  for (const resposta of [() => jsonResponse({ message: "detalhe interno" }, 500), () => Promise.reject(new Error("rede caiu"))]) {
    const backend = createFakeBackend({ rpc: { pagina_registrar_evento: resposta } });
    const appUrl = await listen(app({ backend }).server);
    const response = await postJson(appUrl, "/api/pagina/evento", EVENTO_PAGINA);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: "database_unavailable" });
  }
});

test("pagina/evento: rate limit próprio de 240/min por IP (a pesquisa não gasta o das páginas de obrigado)", async () => {
  let agora = Date.parse("2026-09-22T12:00:00Z");
  const { server } = app({ now: () => agora });
  const appUrl = await listen(server);

  // O limite da pesquisa esgotado não bloqueia a página de obrigado.
  for (let i = 0; i < 241; i += 1) await postJson(appUrl, "/api/pesquisa/evento", { visitante_id: VISITANTE, evento: "visita" });
  for (let i = 0; i < 240; i += 1) {
    const response = await postJson(appUrl, "/api/pagina/evento", EVENTO_PAGINA, { "X-Forwarded-For": `10.0.0.${i % 250}, 200.1.1.1` });
    assert.equal(response.status, 200, `requisição ${i + 1}`);
  }
  const bloqueada = await postJson(appUrl, "/api/pagina/evento", EVENTO_PAGINA, { "X-Forwarded-For": "9.9.9.9, 200.1.1.1" });
  assert.equal(bloqueada.status, 429);
  assert.deepEqual(await bloqueada.json(), { ok: false, error: "too_many_requests" });
  assert.equal((await postJson(appUrl, "/api/pagina/evento", EVENTO_PAGINA, { "X-Forwarded-For": "200.2.2.2" })).status, 200);
  agora += 61_000;
  assert.equal((await postJson(appUrl, "/api/pagina/evento", EVENTO_PAGINA, { "X-Forwarded-For": "200.1.1.1" })).status, 200);
});

test("META_PIXEL_ID: outro id é respeitado, 'off' e valor estranho desligam", async () => {
  const outro = await listen(createServerApp({ rootDirectory: root, metaPixelId: "123456789012345" }));
  assert.match(await (await fetch(`${outro}/pesquisa-icp`)).text(), /fbq\('init', '123456789012345'\)/);

  for (const metaPixelId of ["off", "OFF", "", "123'); alert(1); ('"]) {
    const appUrl = await listen(createServerApp({ rootDirectory: root, metaPixelId }));
    const html = await (await fetch(`${appUrl}/pesquisa-icp`)).text();
    assert.doesNotMatch(html, /fbq|facebook/, JSON.stringify(metaPixelId));
    // Sem SITE_URL entram og:url/canonical da origem da requisição; fora isso, o arquivo intacto.
    const origem = `${appUrl}/pesquisa-icp`;
    assert.equal(html, HTML_PESQUISA.replace("</head>", `<meta property="og:url" content="${origem}" />\n<link rel="canonical" href="${origem}" />\n</head>`));
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

test("evento: rate limit de 240/min por IP, pelo último X-Forwarded-For", async () => {
  const { server } = app();
  const appUrl = await listen(server);
  const corpo = { visitante_id: VISITANTE, evento: "visita" };

  for (let i = 0; i < 240; i += 1) {
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

  for (let i = 0; i < 240; i += 1) await postJson(appUrl, "/api/pesquisa/evento", corpo);
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

  // "Estudante" saiu da pergunta 1 (4 perfis): um rascunho velho com ele perde o perfil e o bloco
  // 9, "fim" não vale, e a pessoa volta para a pergunta 1.
  const estudante = { ...completas, perfil: "Estudante da área da saúde" };
  await salvar(estudante, "fim");
  assert.equal(ultimaP().perfil, null);
  assert.equal(ultimaP().completa, false);
  assert.equal(ultimaP().pergunta_atual, "perfil");
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

test("salvar: 415, 413 e rate limit de 600/min", async () => {
  const { server } = app();
  const appUrl = await listen(server);

  const texto = await fetch(`${appUrl}/api/pesquisa/salvar`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(texto.status, 415);

  const grande = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: { sonho: "x".repeat(65 * 1024) } }));
  assert.equal(grande.status, 413);

  // As duas acima já contaram? A de 415 não (recusada antes do limite); a de 413 sim.
  for (let i = 0; i < 599; i += 1) {
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
    perfil_codigo: "cuidador",
    segmento: "PERFIL_CUIDADOR",
    pagina_obrigado: { id: "cuidador", rota: "/obrigado-cuidador", nome: "Obrigado — Formação Técnica Cuidador de Valor", grupo: "cuidador" },
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

/* ================================================================== reenvio automático ao n8n */

/**
 * Banco falso para a varredura: GET em pesquisa_respostas devolve `pendentes`; PATCH responde
 * 204; o webhook decide por `webhook`. Toda chamada fica em `chamadas`.
 */
function backendReenvio({ pendentes = [], webhook } = {}) {
  const chamadas = [];
  const fetchImpl = async (url, init = {}) => {
    const endereco = String(url);
    const chamada = { url: endereco, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    chamadas.push(chamada);
    if (endereco.startsWith(WEBHOOK_URL)) return webhook ? await webhook(chamada) : jsonResponse({ ok: true });
    if (chamada.method === "PATCH") return new Response(null, { status: 204 });
    if (endereco.includes("/rest/v1/pesquisa_respostas?")) return jsonResponse(typeof pendentes === "function" ? await pendentes(chamada) : pendentes);
    return jsonResponse({ message: "rota inesperada no teste" }, 404);
  };
  return { chamadas, fetchImpl };
}

test("reenvio: busca só as pendentes (filtros PostgREST), manda o MESMO payload do envio normal e marca só no 2xx", async () => {
  const agora = Date.parse("2026-09-21T16:00:00Z");
  const outra = linhaFinalizada({ id: "2c8b4e1a-7d3f-4a5b-9c6d-0e1f2a3b4c5d", nome: "Ana Souza", whatsapp_digits: "21998765432" });
  let entregas = 0;
  const backend = backendReenvio({
    pendentes: [linhaFinalizada(), outra],
    webhook: (chamada) => {
      entregas += 1;
      return chamada.body.sessao_id === SESSAO ? jsonResponse({ ok: true }) : jsonResponse({}, 502);
    }
  });
  const server = createServerApp({ rootDirectory: root, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, webhookUrl: WEBHOOK_URL, fetchImpl: backend.fetchImpl, now: () => agora, reenvio: { atrasoInicialMs: 60_000, intervaloMs: 60_000 } });
  servers.push(server);
  assert.ok(server.reenvio);

  const resultado = await server.reenvio.executar();
  assert.deepEqual(resultado, { pendentes: 2, entregues: 1 });

  const [busca] = backend.chamadas;
  assert.equal(busca.method, "GET");
  const u = new URL(busca.url);
  assert.equal(u.pathname, "/rest/v1/pesquisa_respostas");
  assert.equal(busca.headers.apikey, SUPABASE_KEY);
  assert.equal(u.searchParams.get("select"), "*");
  // Sem o webhook de perfil configurado, a varredura procura só a pesquisa de ICP.
  assert.equal(u.searchParams.get("pesquisa"), "in.(icp-escola-ev)");
  assert.equal(u.searchParams.get("webhook_enviado_em"), "is.null");
  assert.equal(
    u.searchParams.get("or"),
    "(and(finalizado_em.gte.2026-09-14T16:00:00.000Z,finalizado_em.lte.2026-09-21T15:58:00.000Z)," +
      "and(finalizado_em.is.null,status.eq.concluida,concluido_em.gte.2026-09-14T16:00:00.000Z,atualizado_em.lte.2026-09-21T15:30:00.000Z))"
  );
  assert.equal(u.searchParams.get("order"), "criado_em.asc");
  assert.equal(u.searchParams.get("limit"), "25");

  assert.equal(entregas, 2);
  const avisos = backend.chamadas.filter((c) => c.url === WEBHOOK_URL);
  // Idêntico ao que o envio normal monta a partir da mesma linha.
  const esperado = montarPayloadWebhook({ linha: linhaFinalizada(), id: SESSAO, contato: {}, respostas: {}, rastreio: {}, agora });
  assert.deepEqual(avisos[0].body, esperado);
  assert.equal(avisos[0].body.evento, "pesquisa_concluida");
  assert.equal(avisos[0].body.lead.whatsapp_internacional, "5511912345678");
  assert.equal(avisos[0].body.perguntas.length, 33);
  assert.equal(avisos[0].headers.apikey, undefined);

  const marcas = backend.chamadas.filter((c) => c.method === "PATCH");
  assert.equal(marcas.length, 1, "PATCH só para a que o n8n confirmou");
  assert.equal(marcas[0].url, `${SUPABASE_URL}/rest/v1/pesquisa_respostas?id=eq.${SESSAO}`);
  assert.deepEqual(marcas[0].body, { webhook_enviado_em: "2026-09-21T16:00:00.000Z" });
});

test("reenvio: payload igual ao do envio imediato (mesma linha, mesmo relógio)", async () => {
  const agora = Date.parse("2026-09-21T15:27:00Z");
  const imediato = createFakeBackend({ rpc: { pesquisa_salvar: respostaFinalizou() } });
  const appUrl = await listen(app({ backend: imediato, webhookUrl: WEBHOOK_URL, now: () => agora }).server);
  await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
  await aguardar(() => avisosDe(imediato).length === 1);

  const backend = backendReenvio({ pendentes: [linhaFinalizada()] });
  const server = createServerApp({ rootDirectory: root, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, webhookUrl: WEBHOOK_URL, fetchImpl: backend.fetchImpl, now: () => agora, reenvio: true });
  servers.push(server);
  await server.reenvio.executar();
  assert.deepEqual(backend.chamadas.find((c) => c.url === WEBHOOK_URL).body, avisosDe(imediato)[0].body);
  // O reenvio leva os mesmos campos novos (mesma função de montagem).
  const reenviado = backend.chamadas.find((c) => c.url === WEBHOOK_URL).body;
  assert.equal(reenviado.perfil_codigo, "cuidador");
  assert.equal(reenviado.segmento, "PERFIL_CUIDADOR");
  assert.deepEqual(reenviado.pagina_obrigado, { id: "cuidador", rota: "/obrigado-cuidador", nome: "Obrigado — Formação Técnica Cuidador de Valor", grupo: "cuidador" });
});

test("payload do n8n: perfil_codigo, segmento e pagina_obrigado de cada perfil (Técnico e Enfermeiro: mesma página, códigos separados)", () => {
  const agora = Date.parse("2026-09-22T10:00:00Z");
  const evento = { id: "evento_outubro", rota: "/obrigado-evento-outubro", nome: "Obrigado — Evento Gratuito de Outubro", grupo: "evento_outubro" };
  const casos = [
    ["Auxiliar ou antiga atendente de enfermagem", "auxiliar_atendente", "PERFIL_AUXILIAR_ATENDENTE", { id: "afericao", rota: "/obrigado-afericao", nome: "Obrigado — Aula de Aferição", grupo: "afericao" }],
    ["Cuidador(a)", "cuidador", "PERFIL_CUIDADOR", { id: "cuidador", rota: "/obrigado-cuidador", nome: "Obrigado — Formação Técnica Cuidador de Valor", grupo: "cuidador" }],
    ["Técnico(a) de enfermagem", "tecnico_enfermagem", "PERFIL_TECNICO", evento],
    ["Enfermeiro(a)", "enfermeiro", "PERFIL_ENFERMEIRO", evento],
    // Sem perfil, perfil que saiu da pesquisa ou chave herdada: tudo null, nada inventado.
    [undefined, null, null, null],
    ["Estudante da área da saúde", null, null, null],
    ["constructor", null, null, null]
  ];
  for (const [perfil, codigo, segmento, pagina] of casos) {
    const respostas = perfil === undefined ? {} : { perfil };
    const payload = montarPayloadWebhook({ linha: linhaFinalizada({ respostas }), id: SESSAO, contato: {}, respostas: {}, rastreio: {}, agora });
    assert.equal(payload.perfil, perfil ?? null, String(perfil));
    assert.equal(payload.perfil_codigo, codigo, String(perfil));
    assert.equal(payload.segmento, segmento, String(perfil));
    assert.deepEqual(payload.pagina_obrigado, pagina, String(perfil));
  }
  // Ordem das chaves no JSON: os campos novos logo depois de `perfil`.
  const chaves = Object.keys(montarPayloadWebhook({ linha: linhaFinalizada(), id: SESSAO, contato: {}, respostas: {}, rastreio: {}, agora }));
  assert.deepEqual(chaves.slice(chaves.indexOf("perfil"), chaves.indexOf("perfil") + 4), ["perfil", "perfil_codigo", "segmento", "pagina_obrigado"]);
});

test("reenvio: não sobrepõe execuções; falha na busca só loga", async () => {
  let liberar;
  let buscas = 0;
  const backend = backendReenvio({
    pendentes: () => {
      buscas += 1;
      return new Promise((resolve) => {
        liberar = () => resolve([]);
      });
    }
  });
  const server = createServerApp({ rootDirectory: root, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, webhookUrl: WEBHOOK_URL, fetchImpl: backend.fetchImpl, reenvio: true });
  servers.push(server);
  const a = server.reenvio.executar();
  const b = server.reenvio.executar();
  assert.equal(a, b);
  await aguardar(() => typeof liberar === "function");
  liberar();
  await a;
  assert.equal(buscas, 1);

  const falha = backendReenvio({ pendentes: () => { throw new Error("banco fora"); } });
  const s2 = createServerApp({ rootDirectory: root, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, webhookUrl: WEBHOOK_URL, fetchImpl: falha.fetchImpl, reenvio: true });
  servers.push(s2);
  assert.deepEqual(await s2.reenvio.executar(), { pendentes: 0, entregues: 0 });
});

test("reenvio: timers — roda depois do atraso inicial e a cada intervalo; para ao fechar o servidor", async () => {
  const backend = backendReenvio({ pendentes: [] });
  const server = createServerApp({ rootDirectory: root, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, webhookUrl: WEBHOOK_URL, fetchImpl: backend.fetchImpl, reenvio: { atrasoInicialMs: 20, intervaloMs: 30 } });
  await listen(server);
  assert.equal(backend.chamadas.length, 0);
  await aguardar(() => backend.chamadas.length >= 3);
  await new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  });
  servers.splice(servers.indexOf(server), 1);
  const depois = backend.chamadas.length;
  await esperar(100);
  assert.equal(backend.chamadas.length, depois, "nada roda depois do close");
});

test("reenvio: desligado por padrão, sem webhook ('off'/vazio) ou sem Supabase", async () => {
  const backend = backendReenvio({ pendentes: [linhaFinalizada()] });
  const base = { rootDirectory: root, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, webhookUrl: WEBHOOK_URL, fetchImpl: backend.fetchImpl };
  const casos = [
    { ...base },
    { ...base, reenvio: { atrasoInicialMs: 1, intervaloMs: 5 }, webhookUrl: "off" },
    { ...base, reenvio: { atrasoInicialMs: 1, intervaloMs: 5 }, webhookUrl: "" },
    { ...base, reenvio: { atrasoInicialMs: 1, intervaloMs: 5 }, supabaseUrl: "" }
  ];
  for (const opcoes of casos) {
    const server = createServerApp(opcoes);
    assert.equal(server.reenvio, null);
    await listen(server);
  }
  await esperar(60);
  assert.equal(backend.chamadas.length, 0);
  // O processo de verdade liga (reenvio: true) e para no SIGTERM.
  const fonte = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../server.mjs", import.meta.url), "utf8"));
  assert.match(fonte, /metaPixelId,\n\s+reenvio: true\n\s+\}\);/);
  assert.match(fonte, /process\.on\("SIGTERM", \(\) => \{\n\s+server\.reenvio\?\.parar\(\);/);
});

/* ======================= concluída sem chegar à tela de fim (achado D1) */

test("webhook: se a varredura já mandou a tentativa (concluída e parada nas abertas), chegar ao fim depois não manda de novo", async () => {
  const backend = createFakeBackend({
    rpc: { pesquisa_salvar: respostaFinalizou({ linha: linhaFinalizada({ webhook_enviado_em: "2026-09-21T16:00:00+00:00" }) }) }
  });
  const { server } = app({ backend, webhookUrl: WEBHOOK_URL });
  const appUrl = await listen(server);
  const response = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar({ seq: 40, respostas: respostasCompletasCuidador(), pergunta_atual: "fim" }));
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(avisosDe(backend).length, 0);
});

test("reenvio: concluída que não chegou à tela de fim vai com concluida_em = concluido_em", async () => {
  const agora = Date.parse("2026-09-21T16:00:00Z");
  const backend = backendReenvio({ pendentes: [linhaFinalizada({ finalizado_em: null })] });
  const server = createServerApp({ rootDirectory: root, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, webhookUrl: WEBHOOK_URL, fetchImpl: backend.fetchImpl, now: () => agora, reenvio: true });
  servers.push(server);
  assert.deepEqual(await server.reenvio.executar(), { pendentes: 1, entregues: 1 });
  const [aviso] = backend.chamadas.filter((c) => c.url === WEBHOOK_URL);
  assert.equal(aviso.body.concluida_em, "2026-09-21T15:26:40.000Z");
  assert.equal(aviso.body.sessao_id, SESSAO);
});

test("contato: o nome é gravado com maiúsculas certas, seja como for digitado", () => {
  const r = validarContato({ nome: "MARIA DA SILVA", whatsapp: "(11) 91234-5678", email: "Maria@Gmail.com" });
  assert.equal(r.contato.nome, "Maria da Silva");
  assert.equal(r.contato.email, "maria@gmail.com");
});

/* ================================================================== inscrição + checkout Hotmart */

// O MESMO config que o servidor carrega, para o teste não repetir o link do checkout à mão.
const contextoCheckout = vm.createContext({});
for (const arquivo of ["js/lead-rules.js", "js/checkout-config.js"]) {
  vm.runInContext(readFileSync(new URL(`../${arquivo}`, import.meta.url), "utf8"), contextoCheckout, { filename: arquivo });
}
const CHECKOUT = contextoCheckout.EVCheckout;
// A primeira página que mora AQUI (sem `origem`): é ela que tem rota e arquivo neste servidor.
const PAGINA_INSCRICAO = CHECKOUT.LISTA.find((pagina) => !pagina.origem);
// A venda da Imersão GPS: mora no outro site e só manda o formulário para cá (CORS).
const PAGINA_GPS = CHECKOUT.PAGINAS["imersao-gps"];
const ORIGEM_GPS = PAGINA_GPS.origem;

function corpoInscricao(extra = {}) {
  return {
    pagina: PAGINA_INSCRICAO.id,
    id: SESSAO,
    visitante_id: VISITANTE,
    contato: { nome: "  maria   da silva ", whatsapp: "11912345678", email: " Maria@Gmail.com " },
    rastreio: {
      page_url: `https://lp.exemplo${PAGINA_INSCRICAO.rota}?utm_source=facebook`,
      referrer: "https://www.facebook.com/",
      dispositivo: "mobile",
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "viver-de-furo-set",
      utm_term: "criativo-07",
      utm_content: "anuncio-b",
      fbclid: "IwAR-teste"
    },
    ...extra
  };
}

function backendInscricao(extra = {}) {
  return createFakeBackend({ rpc: { inscricao_salvar: { ok: true, novo: true, id: SESSAO }, ...extra } });
}

test(`a rota ${PAGINA_INSCRICAO.rota} serve a página (com e sem barra), com Pixel, CSP, og/canonical e no-cache`, async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root, siteUrl: "https://lp.exemplo.com.br" }));

  for (const caminho of [PAGINA_INSCRICAO.rota, `${PAGINA_INSCRICAO.rota}/`]) {
    const response = await fetch(`${appUrl}${caminho}`);
    assert.equal(response.status, 200, caminho);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy") || "", /connect\.facebook\.net/);

    const html = await response.text();
    assert.match(html, /fbq\('init', '538380380948773'\)/, `pixel em ${caminho}`);
    assert.ok(html.includes(`<meta property="og:url" content="https://lp.exemplo.com.br${PAGINA_INSCRICAO.rota}" />`), caminho);
    assert.ok(html.includes(`<link rel="canonical" href="https://lp.exemplo.com.br${PAGINA_INSCRICAO.rota}" />`), caminho);
    // Imagem da prévia com caminho relativo vira absoluta (o WhatsApp não monta prévia sem isso).
    assert.ok(html.includes('content="https://lp.exemplo.com.br/img/og-inscricao.jpg"'), caminho);
  }
});

test("/api/inscricao: grava e devolve a URL do checkout montada no SERVIDOR", async () => {
  const backend = backendInscricao();
  const { server } = app({ backend });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/inscricao", corpoInscricao());
  assert.equal(response.status, 200);
  const corpo = await response.json();
  assert.deepEqual(Object.keys(corpo).sort(), ["checkout", "ok"]);
  assert.equal(corpo.ok, true);

  const url = new URL(corpo.checkout);
  assert.equal(`${url.origin}${url.pathname}`, PAGINA_INSCRICAO.checkout.split("?")[0]);
  assert.equal(url.searchParams.get("off"), "7j2nqptq");
  assert.equal(url.searchParams.get("checkoutMode"), "10");
  assert.equal(url.searchParams.get("utm_source"), "facebook");
  assert.equal(url.searchParams.get("utm_medium"), "cpc");
  assert.equal(url.searchParams.get("utm_campaign"), "viver-de-furo-set");
  assert.equal(url.searchParams.get("utm_term"), "criativo-07");
  assert.equal(url.searchParams.get("utm_content"), "anuncio-b");
  assert.equal(url.searchParams.get("sck"), "criativo-07", "o sck é o utm_term");
  assert.equal(url.searchParams.get("name"), "Maria da Silva", "nome formatado");
  assert.equal(url.searchParams.get("email"), "maria@gmail.com");
  assert.equal(url.searchParams.get("phoneac"), "11");
  assert.equal(url.searchParams.get("phonenumber"), "912345678");
  assert.equal(url.searchParams.get("fbclid"), null, "fbclid não vai para a Hotmart");
  // A URL do servidor é EXATAMENTE a do contrato.
  assert.equal(
    corpo.checkout,
    CHECKOUT.montarUrlCheckout(PAGINA_INSCRICAO.checkout, {
      utm: { utm_source: "facebook", utm_medium: "cpc", utm_campaign: "viver-de-furo-set", utm_term: "criativo-07", utm_content: "anuncio-b" },
      contato: { nome: "maria da silva", email: "maria@gmail.com", whatsapp: "11912345678" }
    })
  );

  const [chamada] = backend.chamadas;
  assert.match(chamada.url, /\/rest\/v1\/rpc\/inscricao_salvar$/);
  assert.equal(chamada.method, "POST");
  assert.equal(chamada.headers.apikey, SUPABASE_KEY);
  assert.deepEqual(chamada.body.p, {
    id: SESSAO,
    pagina: PAGINA_INSCRICAO.id,
    visitante_id: VISITANTE,
    // Contato normalizado pelas MESMAS regras da pesquisa.
    nome: "Maria da Silva",
    whatsapp: "(11) 91234-5678",
    whatsapp_digits: "11912345678",
    email: "maria@gmail.com",
    checkout_url: corpo.checkout,
    page_url: `https://lp.exemplo${PAGINA_INSCRICAO.rota}?utm_source=facebook`,
    referrer: "https://www.facebook.com/",
    dispositivo: "mobile",
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "viver-de-furo-set",
    utm_content: "anuncio-b",
    utm_term: "criativo-07",
    fbclid: "IwAR-teste",
    gclid: null
  });
});

test("/api/inscricao: sem UTM nenhuma, o link do cliente sai inteiro e sem sck", async () => {
  const { server } = app({ backend: backendInscricao() });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/inscricao", corpoInscricao({ rastreio: { dispositivo: "desktop" } }));
  const { checkout } = await response.json();
  const params = new URL(checkout).searchParams;
  assert.equal(params.get("off"), "7j2nqptq");
  assert.equal(params.get("checkoutMode"), "10");
  assert.equal(params.get("sck"), null);
  assert.equal(params.get("utm_source"), null);
  assert.equal(params.get("name"), "Maria da Silva");
});

test("/api/inscricao: método, tipo, corpo e página — 405, 415, 400, 413, 422", async () => {
  const { server } = app({ backend: backendInscricao() });
  const appUrl = await listen(server);

  const get = await fetch(`${appUrl}/api/inscricao`);
  assert.equal(get.status, 405);
  // OPTIONS também é método da rota: é o preflight do CORS da venda da Imersão GPS.
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  for (const metodo of ["PUT", "DELETE", "PATCH"]) {
    const response = await fetch(`${appUrl}/api/inscricao`, { method: metodo });
    assert.equal(response.status, 405, metodo);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS", metodo);
  }

  const semJson = await fetch(`${appUrl}/api/inscricao`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "pagina=viver-de-furo"
  });
  assert.equal(semJson.status, 415);

  const quebrado = await postJson(appUrl, "/api/inscricao", "{");
  assert.equal(quebrado.status, 400);

  const gigante = await postJson(appUrl, "/api/inscricao", { pagina: "x".repeat(70 * 1024) });
  assert.equal(gigante.status, 413);
  assert.deepEqual(await gigante.json(), { ok: false, error: "payload_too_large" });

  const lista = await postJson(appUrl, "/api/inscricao", "[]");
  assert.equal(lista.status, 422);
  assert.deepEqual(await lista.json(), { ok: false, error: "invalid_body" });

  // Página que não existe no config — inclusive uma chave herdada do Object.
  for (const pagina of ["outra-pagina", "", null, "toString", "constructor"]) {
    const response = await postJson(appUrl, "/api/inscricao", corpoInscricao({ pagina }));
    assert.equal(response.status, 422, String(pagina));
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_page" }, String(pagina));
  }
});

test("/api/inscricao: contato inválido volta 422 com as mensagens do EVLeadRules, campo a campo", async () => {
  const { server } = app({ backend: backendInscricao() });
  const appUrl = await listen(server);

  const response = await postJson(
    appUrl,
    "/api/inscricao",
    corpoInscricao({ contato: { nome: "Maria2", whatsapp: "1191234", email: "maria@" } })
  );
  assert.equal(response.status, 422);
  const corpo = await response.json();
  assert.equal(corpo.error, "invalid_contact");
  assert.deepEqual(Object.keys(corpo.campos).sort(), ["email", "nome", "whatsapp"]);
  assert.equal(corpo.campos.nome, "Confere o nome: use só letras.");
  assert.equal(corpo.campos.whatsapp, "Faltam números: são 11 dígitos contando o DDD.");
  assert.equal(corpo.campos.email, "Confere o e-mail, parece que tem algo errado.");

  // Sobrenome e celular: as mesmas regras da pesquisa.
  const semSobrenome = await postJson(appUrl, "/api/inscricao", corpoInscricao({ contato: { nome: "Maria", whatsapp: "11912345678", email: "maria@gmail.com" } }));
  assert.equal((await semSobrenome.json()).campos.nome, "Escreva também o seu sobrenome.");
  const fixo = await postJson(appUrl, "/api/inscricao", corpoInscricao({ contato: { nome: "Maria Silva", whatsapp: "1131234567", email: "maria@gmail.com" } }));
  assert.equal((await fixo.json()).campos.whatsapp, "Faltam números: são 11 dígitos contando o DDD.");
});

test("/api/inscricao: domínio de e-mail que não recebe mensagem volta 422 (mesmo resolvedor da pesquisa)", async () => {
  const resolver = fakeResolver((dominio) => (dominio === "escolainexistente.com.br" ? "missing" : "ok"));
  const backend = backendInscricao();
  const { server } = app({ backend, resolver });
  const appUrl = await listen(server);

  const response = await postJson(
    appUrl,
    "/api/inscricao",
    corpoInscricao({ contato: { nome: "Maria Silva", whatsapp: "11912345678", email: "maria@escolainexistente.com.br" } })
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "invalid_contact",
    campos: { email: "Não encontramos esse endereço de e-mail. Confere se está certinho?" }
  });
  assert.deepEqual(resolver.consultas, ["escolainexistente.com.br"]);
  assert.equal(backend.chamadas.length, 0, "nada foi gravado");
});

test("/api/inscricao: sem banco → 503; banco fora → 502 sem vazar detalhe", async () => {
  const semBanco = await listen(createServerApp({ rootDirectory: root, resolveEmailDomain: async () => "ok" }));
  const resposta503 = await postJson(semBanco, "/api/inscricao", corpoInscricao());
  assert.equal(resposta503.status, 503);
  assert.deepEqual(await resposta503.json(), { ok: false, error: "database_not_configured" });

  const backend = createFakeBackend({ rpc: { inscricao_salvar: () => jsonResponse({ message: "detalhe interno" }, 500) } });
  const appUrl = await listen(app({ backend }).server);
  const resposta502 = await postJson(appUrl, "/api/inscricao", corpoInscricao());
  assert.equal(resposta502.status, 502);
  assert.deepEqual(await resposta502.json(), { ok: false, error: "database_unavailable" });
});

test("/api/inscricao: rate limit próprio de 240/min por IP, sem atrapalhar a pesquisa", async () => {
  const { server } = app({ backend: backendInscricao() });
  const appUrl = await listen(server);

  for (let i = 0; i < 240; i += 1) {
    const response = await postJson(appUrl, "/api/inscricao", corpoInscricao(), { "X-Forwarded-For": `10.0.0.${i % 250}, 200.1.1.1` });
    assert.equal(response.status, 200, `requisição ${i + 1}`);
  }
  const bloqueada = await postJson(appUrl, "/api/inscricao", corpoInscricao(), { "X-Forwarded-For": "9.9.9.9, 200.1.1.1" });
  assert.equal(bloqueada.status, 429);
  assert.deepEqual(await bloqueada.json(), { ok: false, error: "too_many_requests" });

  // O limite é só desta rota: a pesquisa segue gravando no mesmo IP.
  const pesquisa = await postJson(appUrl, "/api/pesquisa/salvar", corpoSalvar(), { "X-Forwarded-For": "200.1.1.1" });
  assert.equal(pesquisa.status, 200);
  // E outro IP continua livre na própria rota.
  const outro = await postJson(appUrl, "/api/inscricao", corpoInscricao(), { "X-Forwarded-For": "200.2.2.2" });
  assert.equal(outro.status, 200);
});

/* ================================================================== inscrição da Imersão GPS (outro site → CORS) */

// O formulário da venda da Imersão GPS, do jeito que a página do outro site manda.
function corpoGps(extra = {}) {
  return corpoInscricao({
    pagina: PAGINA_GPS.id,
    contato: { nome: "  ana   souza ", whatsapp: "(21) 99876-5432", email: " Ana@Gmail.com " },
    rastreio: {
      page_url: `${ORIGEM_GPS}${PAGINA_GPS.rota}?utm_source=facebook`,
      referrer: "https://www.instagram.com/",
      dispositivo: "mobile",
      utm_source: "facebook",
      utm_medium: "cpc",
      utm_campaign: "gps-set",
      utm_term: "publico-quente",
      utm_content: "criativo-gps-03",
      fbclid: "IwAR-gps"
    },
    ...extra
  });
}

function preflight(appUrl, origem, headers = {}) {
  return fetch(`${appUrl}/api/inscricao`, {
    method: "OPTIONS",
    headers: {
      ...(origem === undefined ? {} : { Origin: origem }),
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
      ...headers
    }
  });
}

function assertComCors(response, origem, rotulo) {
  assert.equal(response.headers.get("access-control-allow-origin"), origem, rotulo);
  assert.equal(response.headers.get("vary"), "Origin", rotulo);
  // Sem cookie, sem credencial: o formulário não precisa, e liberar abriria a porta para o resto.
  assert.equal(response.headers.get("access-control-allow-credentials"), null, rotulo);
}

function assertSemCors(response, rotulo) {
  assert.equal(response.headers.get("access-control-allow-origin"), null, rotulo);
  assert.equal(response.headers.get("vary"), null, rotulo);
  assert.equal(response.headers.get("access-control-allow-methods"), null, rotulo);
}

test("CORS /api/inscricao: preflight da origem liberada → 204 com os cabeçalhos exatos, sem ir ao banco", async () => {
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend }).server);

  for (const extra of [{}, { "Access-Control-Request-Headers": "" }]) {
    const response = await preflight(appUrl, ORIGEM_GPS, extra);
    assert.equal(response.status, 204);
    assertComCors(response, ORIGEM_GPS);
    assert.equal(response.headers.get("access-control-allow-methods"), "POST");
    assert.equal(response.headers.get("access-control-allow-headers"), "Content-Type");
    assert.equal(response.headers.get("access-control-max-age"), "7200");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), "");
  }
  assert.equal(backend.chamadas.length, 0, "o preflight não grava nada");
});

test("CORS /api/inscricao: preflight de outra origem (ou sem Origin) → 403 origin_not_allowed, sem cabeçalho CORS", async () => {
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend }).server);

  for (const origem of [
    "https://evil.example",
    "https://lp.escolaenfermagemdevalor.com.br", // o próprio site não precisa de CORS
    "http://io.escolaenfermagemdevalor.com.br", // sem https
    "https://io.escolaenfermagemdevalor.com.br:8443",
    "https://io.escolaenfermagemdevalor.com.br.evil.com",
    "https://www.io.escolaenfermagemdevalor.com.br",
    "https://escolaenfermagemdevalor.com.br",
    "null",
    "",
    undefined
  ]) {
    const response = await preflight(appUrl, origem);
    assert.equal(response.status, 403, String(origem));
    assert.deepEqual(await response.json(), { ok: false, error: "origin_not_allowed" }, String(origem));
    assertSemCors(response, String(origem));
  }
  assert.equal(backend.chamadas.length, 0);
});

test("CORS /api/inscricao: da origem liberada, TODA resposta leva Access-Control-Allow-Origin e Vary", async () => {
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend }).server);
  const daOrigem = { Origin: ORIGEM_GPS };

  const ok = await postJson(appUrl, "/api/inscricao", corpoGps(), daOrigem);
  assert.equal(ok.status, 200);
  assertComCors(ok, ORIGEM_GPS, "200");
  assert.equal((await ok.json()).ok, true);

  const metodo = await fetch(`${appUrl}/api/inscricao`, { headers: daOrigem });
  assert.equal(metodo.status, 405);
  assert.equal(metodo.headers.get("allow"), "POST, OPTIONS");
  assertComCors(metodo, ORIGEM_GPS, "405");

  const tipo = await fetch(`${appUrl}/api/inscricao`, {
    method: "POST",
    headers: { ...daOrigem, "Content-Type": "application/x-www-form-urlencoded" },
    body: "pagina=imersao-gps"
  });
  assert.equal(tipo.status, 415);
  assertComCors(tipo, ORIGEM_GPS, "415");

  const quebrado = await postJson(appUrl, "/api/inscricao", "{", daOrigem);
  assert.equal(quebrado.status, 400);
  assertComCors(quebrado, ORIGEM_GPS, "400");

  const gigante = await postJson(appUrl, "/api/inscricao", { pagina: "x".repeat(70 * 1024) }, daOrigem);
  assert.equal(gigante.status, 413);
  assertComCors(gigante, ORIGEM_GPS, "413");

  const pagina = await postJson(appUrl, "/api/inscricao", corpoGps({ pagina: "outra" }), daOrigem);
  assert.equal(pagina.status, 422);
  assertComCors(pagina, ORIGEM_GPS, "422 invalid_page");

  const contato = await postJson(appUrl, "/api/inscricao", corpoGps({ contato: { nome: "Ana", whatsapp: "1", email: "x" } }), daOrigem);
  assert.equal(contato.status, 422);
  assertComCors(contato, ORIGEM_GPS, "422 invalid_contact");
  // Sem o cabeçalho, o navegador esconderia o corpo — e a tela não mostraria o erro no campo certo.
  assert.deepEqual(Object.keys((await contato.json()).campos).sort(), ["email", "nome", "whatsapp"]);

  // Banco fora (502) e sem banco (503) também: a tela precisa ler o erro para liberar o botão.
  const fora = createFakeBackend({ rpc: { inscricao_salvar: () => jsonResponse({ message: "x" }, 500) } });
  const appFora = await listen(app({ backend: fora }).server);
  const r502 = await postJson(appFora, "/api/inscricao", corpoGps(), daOrigem);
  assert.equal(r502.status, 502);
  assertComCors(r502, ORIGEM_GPS, "502");

  const semBanco = await listen(createServerApp({ rootDirectory: root, resolveEmailDomain: async () => "ok" }));
  const r503 = await postJson(semBanco, "/api/inscricao", corpoGps(), daOrigem);
  assert.equal(r503.status, 503);
  assertComCors(r503, ORIGEM_GPS, "503");
});

test("CORS /api/inscricao: o 429 do rate limit também leva o cabeçalho da origem liberada", async () => {
  const appUrl = await listen(app({ backend: backendInscricao() }).server);
  const cabecalhos = { Origin: ORIGEM_GPS, "X-Forwarded-For": "200.3.3.3" };
  for (let i = 0; i < 240; i += 1) {
    const response = await postJson(appUrl, "/api/inscricao", corpoGps(), cabecalhos);
    assert.equal(response.status, 200, `requisição ${i + 1}`);
  }
  const bloqueada = await postJson(appUrl, "/api/inscricao", corpoGps(), cabecalhos);
  assert.equal(bloqueada.status, 429);
  assertComCors(bloqueada, ORIGEM_GPS, "429");
  assert.deepEqual(await bloqueada.json(), { ok: false, error: "too_many_requests" });
  // O preflight não gasta nem é barrado pelo limite.
  const opcoes = await preflight(appUrl, ORIGEM_GPS, { "X-Forwarded-For": "200.3.3.3" });
  assert.equal(opcoes.status, 204);
});

test("CORS /api/inscricao: POST de outra origem (ou sem Origin) segue como antes, sem cabeçalho CORS", async () => {
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend }).server);

  // O servidor não barra o POST (quem barra a leitura da resposta é o navegador, e um JSON de outro
  // site já exigiria o preflight que responde 403): só não libera.
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "https://lp.escolaenfermagemdevalor.com.br" }, {}]) {
    const response = await postJson(appUrl, "/api/inscricao", corpoInscricao(), headers);
    assert.equal(response.status, 200, JSON.stringify(headers));
    assertSemCors(response, JSON.stringify(headers));

    const erro = await postJson(appUrl, "/api/inscricao", corpoInscricao({ pagina: "outra" }), headers);
    assert.equal(erro.status, 422, JSON.stringify(headers));
    assertSemCors(erro, JSON.stringify(headers));
  }
});

test("CORS: só o /api/inscricao responde à origem liberada (pesquisa, obrigado e Hotmart ficam como estavam)", async () => {
  const { server } = appHotmart({ backend: createFakeBackend() });
  const appUrl = await listen(server);
  const daOrigem = { Origin: ORIGEM_GPS };

  for (const rota of ["/api/pesquisa/salvar", "/api/pesquisa/evento", "/api/pagina/evento", "/api/hotmart/venda", "/api/painel/login"]) {
    const opcoes = await fetch(`${appUrl}${rota}`, { method: "OPTIONS", headers: { ...daOrigem, "Access-Control-Request-Method": "POST" } });
    assert.equal(opcoes.status, 405, rota);
    assertSemCors(opcoes, rota);

    const post = await postJson(appUrl, rota, "{", daOrigem);
    assertSemCors(post, rota);
  }
});

test("CORS /api/inscricao: text/plain (simple request, sendBeacon) só da origem liberada; de outra → 415", async () => {
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend }).server);
  const comoTexto = (headers, body = JSON.stringify(corpoGps())) =>
    fetch(`${appUrl}/api/inscricao`, { method: "POST", headers, body });

  // É o que o fetch do navegador manda com corpo string e sem Content-Type, e o que o sendBeacon manda.
  for (const tipo of ["text/plain;charset=UTF-8", "text/plain", "TEXT/PLAIN; charset=utf-8"]) {
    const response = await comoTexto({ Origin: ORIGEM_GPS, "Content-Type": tipo });
    assert.equal(response.status, 200, tipo);
    assertComCors(response, ORIGEM_GPS, tipo);
    assert.equal((await response.json()).ok, true, tipo);
  }
  assert.equal(backend.chamadas.length, 3);
  // Gravou igual ao JSON: mesmo `p`, mesmo checkout.
  const porJson = backendInscricao();
  const appJson = await listen(app({ backend: porJson }).server);
  await postJson(appJson, "/api/inscricao", corpoGps(), { Origin: ORIGEM_GPS });
  assert.deepEqual(backend.chamadas[0].body, porJson.chamadas[0].body);

  // Corpo quebrado em text/plain: o mesmo 400 do JSON.
  const quebrado = await comoTexto({ Origin: ORIGEM_GPS, "Content-Type": "text/plain" }, "{");
  assert.equal(quebrado.status, 400);
  assertComCors(quebrado, ORIGEM_GPS, "400");

  // De outra origem, ou sem Origin: text/plain continua 415 (um formulário HTML de outro site não
  // consegue mandar application/json; é isso que segura o POST cruzado).
  for (const headers of [{ Origin: "https://evil.example", "Content-Type": "text/plain" }, { "Content-Type": "text/plain;charset=UTF-8" }]) {
    const response = await comoTexto(headers);
    assert.equal(response.status, 415, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { ok: false, error: "unsupported_media_type" });
    assertSemCors(response, JSON.stringify(headers));
  }
  // Da origem liberada, outro tipo qualquer continua 415.
  for (const tipo of ["text/html", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded", "text/plainx"]) {
    const response = await comoTexto({ Origin: ORIGEM_GPS, "Content-Type": tipo });
    assert.equal(response.status, 415, tipo);
    assertComCors(response, ORIGEM_GPS, tipo);
  }
  assert.equal(backend.chamadas.length, 3, "nada além dos três primeiros foi gravado");
});

test("CORS /api/inscricao: origensInscricao acrescenta origens (normalizadas) sem tirar as do config", async () => {
  const { server } = app({
    backend: backendInscricao(),
    origensInscricao: ["https://preview.exemplo.com/", " HTTPS://Outra.Exemplo.com:8443 ", "lixo", "", null, "https://x.exemplo.com/caminho"]
  });
  const appUrl = await listen(server);

  for (const [origem, esperada] of [
    ["https://preview.exemplo.com", "https://preview.exemplo.com"],
    ["https://outra.exemplo.com:8443", "https://outra.exemplo.com:8443"],
    [ORIGEM_GPS, ORIGEM_GPS]
  ]) {
    const response = await preflight(appUrl, origem);
    assert.equal(response.status, 204, origem);
    assertComCors(response, esperada, origem);
    const post = await postJson(appUrl, "/api/inscricao", corpoGps(), { Origin: origem });
    assert.equal(post.status, 200, origem);
    assertComCors(post, esperada, origem);
  }
  // Lixo não vira origem: nem "lixo", nem uma origem com caminho.
  for (const origem of ["lixo", "https://x.exemplo.com", "https://outra.exemplo.com"]) {
    assert.equal((await preflight(appUrl, origem)).status, 403, origem);
  }

  // Sem a opção, a preview não passa; com algo que não é lista, a opção é ignorada.
  for (const origensInscricao of [undefined, "https://preview.exemplo.com", { a: "https://preview.exemplo.com" }]) {
    const outro = await listen(app({ backend: backendInscricao(), origensInscricao }).server);
    assert.equal((await preflight(outro, "https://preview.exemplo.com")).status, 403, JSON.stringify(origensInscricao));
    assert.equal((await preflight(outro, ORIGEM_GPS)).status, 204, JSON.stringify(origensInscricao));
  }
});

test("normalizarOrigem: minúsculas, sem barra no fim; o que não é esquema://host[:porta] vira vazio", () => {
  assert.equal(normalizarOrigem("https://io.escolaenfermagemdevalor.com.br/"), "https://io.escolaenfermagemdevalor.com.br");
  assert.equal(normalizarOrigem("HTTPS://IO.EscolaEnfermagemDeValor.com.BR"), "https://io.escolaenfermagemdevalor.com.br");
  assert.equal(normalizarOrigem("  https://preview.exemplo.com//  "), "https://preview.exemplo.com");
  assert.equal(normalizarOrigem("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normalizarOrigem("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(normalizarOrigem("https://meu-app.up.railway.app"), "https://meu-app.up.railway.app");
  for (const lixo of [
    "",
    "   ",
    null,
    undefined,
    42,
    {},
    "null",
    "io.escolaenfermagemdevalor.com.br",
    "//io.escolaenfermagemdevalor.com.br",
    "ftp://exemplo.com",
    "javascript:alert(1)",
    "https://",
    "https://exemplo.com/caminho",
    "https://exemplo.com?x=1",
    "https://exemplo.com#x",
    "https://usuario@exemplo.com",
    "https://exemplo .com",
    "https://*.exemplo.com",
    "https://exemplo..com",
    "https://exemplo.com:123456",
    "https://exemplo.com, https://outra.com"
  ]) {
    assert.equal(normalizarOrigem(lixo), "", String(lixo));
  }
});

test("Imersão GPS: grava pagina imersao-gps; o checkout é o do GPS e o sck é o utm_content", async () => {
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend }).server);

  const response = await postJson(appUrl, "/api/inscricao", corpoGps(), { Origin: ORIGEM_GPS });
  assert.equal(response.status, 200);
  const corpo = await response.json();
  assert.deepEqual(Object.keys(corpo).sort(), ["checkout", "ok"]);

  const url = new URL(corpo.checkout);
  assert.equal(`${url.origin}${url.pathname}`, "https://pay.hotmart.com/R107667362D");
  assert.equal(url.searchParams.get("off"), "l0r77by6");
  assert.equal(url.searchParams.get("checkoutMode"), "10");
  assert.equal(url.searchParams.get("utm_source"), "facebook");
  assert.equal(url.searchParams.get("utm_medium"), "cpc");
  assert.equal(url.searchParams.get("utm_campaign"), "gps-set");
  assert.equal(url.searchParams.get("utm_term"), "publico-quente");
  assert.equal(url.searchParams.get("utm_content"), "criativo-gps-03");
  assert.equal(url.searchParams.get("sck"), "criativo-gps-03", "no GPS o sck é o utm_content");
  assert.equal(url.searchParams.get("name"), "Ana Souza");
  assert.equal(url.searchParams.get("email"), "ana@gmail.com");
  assert.equal(url.searchParams.get("phoneac"), "21");
  assert.equal(url.searchParams.get("phonenumber"), "998765432");
  assert.equal(url.searchParams.get("fbclid"), null);
  assert.equal(
    corpo.checkout,
    CHECKOUT.urlDoCheckout(PAGINA_GPS, {
      utm: { utm_source: "facebook", utm_medium: "cpc", utm_campaign: "gps-set", utm_term: "publico-quente", utm_content: "criativo-gps-03" },
      contato: { nome: "ana souza", email: "ana@gmail.com", whatsapp: "21998765432" }
    })
  );

  const [chamada] = backend.chamadas;
  assert.match(chamada.url, /\/rest\/v1\/rpc\/inscricao_salvar$/);
  assert.deepEqual(chamada.body.p, {
    id: SESSAO,
    pagina: "imersao-gps",
    visitante_id: VISITANTE,
    nome: "Ana Souza",
    whatsapp: "(21) 99876-5432",
    whatsapp_digits: "21998765432",
    email: "ana@gmail.com",
    checkout_url: corpo.checkout,
    page_url: `${ORIGEM_GPS}${PAGINA_GPS.rota}?utm_source=facebook`,
    referrer: "https://www.instagram.com/",
    dispositivo: "mobile",
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "gps-set",
    utm_content: "criativo-gps-03",
    utm_term: "publico-quente",
    fbclid: "IwAR-gps",
    gclid: null
  });
});

test("o sck do GPS é o utm_content e o da Viver de Furo continua o utm_term (mesmo rastreio)", async () => {
  const appUrl = await listen(app({ backend: backendInscricao() }).server);
  const rastreio = { dispositivo: "mobile", utm_source: "ig", utm_term: "termo-1", utm_content: "conteudo-1" };

  const gps = await (await postJson(appUrl, "/api/inscricao", corpoGps({ rastreio }), { Origin: ORIGEM_GPS })).json();
  assert.equal(new URL(gps.checkout).searchParams.get("sck"), "conteudo-1");
  const viver = await (await postJson(appUrl, "/api/inscricao", corpoInscricao({ rastreio }))).json();
  assert.equal(new URL(viver.checkout).searchParams.get("sck"), "termo-1");

  // Sem a UTM da página, sem sck — nenhuma das duas cai para a outra UTM.
  const gpsSemConteudo = await (await postJson(appUrl, "/api/inscricao", corpoGps({ rastreio: { utm_term: "termo-1" } }), { Origin: ORIGEM_GPS })).json();
  assert.equal(new URL(gpsSemConteudo.checkout).searchParams.get("sck"), null);
  const viverSemTermo = await (await postJson(appUrl, "/api/inscricao", corpoInscricao({ rastreio: { utm_content: "conteudo-1" } }))).json();
  assert.equal(new URL(viverSemTermo.checkout).searchParams.get("sck"), null);
});

test("Imersão GPS: e-mail fora de .com/.com.br → 422 com a mensagem com_br; .com.br passa; a Viver de Furo segue aceitando", async () => {
  const resolver = fakeResolver();
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend, resolver }).server);
  const MENSAGEM = "Use um e-mail que termine em .com ou .com.br.";

  for (const email of ["ana@hospital.org", "ana@provedor.net", "ana@saude.sp.gov.br", "ana@usp.edu.br", "ana@empresa.com.pt"]) {
    const response = await postJson(appUrl, "/api/inscricao", corpoGps({ contato: { nome: "Ana Souza", whatsapp: "21998765432", email } }), { Origin: ORIGEM_GPS });
    assert.equal(response.status, 422, email);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_contact", campos: { email: MENSAGEM } }, email);
  }
  assert.deepEqual(resolver.consultas, [], "recusado antes de consultar o DNS");
  assert.equal(backend.chamadas.length, 0, "nada foi gravado");

  // Erro de digitação continua com a mensagem de digitação (a tela oferece a correção).
  const typo = await postJson(appUrl, "/api/inscricao", corpoGps({ contato: { nome: "Ana Souza", whatsapp: "21998765432", email: "ana@gmail.con" } }), { Origin: ORIGEM_GPS });
  assert.equal((await typo.json()).campos.email, "Confere o final do e-mail, parece que tem um erro de digitação.");

  // .com.br de hospital passa (e o DNS é consultado como na pesquisa).
  const comBr = await postJson(appUrl, "/api/inscricao", corpoGps({ contato: { nome: "Ana Souza", whatsapp: "21998765432", email: "Ana@Hospital.com.BR" } }), { Origin: ORIGEM_GPS });
  assert.equal(comBr.status, 200);
  assert.equal(backend.chamadas.at(-1).body.p.email, "ana@hospital.com.br");
  assert.equal(backend.chamadas.at(-1).body.p.pagina, "imersao-gps");
  assert.deepEqual(resolver.consultas, ["hospital.com.br"]);

  // A Viver de Furo não tem a régua: o mesmo .org passa.
  const viver = await postJson(appUrl, "/api/inscricao", corpoInscricao({ contato: { nome: "Ana Souza", whatsapp: "21998765432", email: "ana@hospital.org" } }));
  assert.equal(viver.status, 200);
  assert.equal(backend.chamadas.at(-1).body.p.pagina, PAGINA_INSCRICAO.id);
});

test("validarContato: { somenteComBr } liga a régua .com/.com.br; sem opção, nada muda", () => {
  const contato = { nome: "Ana Souza", whatsapp: "21998765432", email: "ana@hospital.org" };
  assert.deepEqual(validarContato(contato, { somenteComBr: true }), { campos: { email: "Use um e-mail que termine em .com ou .com.br." } });
  for (const opcoes of [undefined, {}, { somenteComBr: false }]) {
    assert.equal(validarContato(contato, opcoes).contato.email, "ana@hospital.org", JSON.stringify(opcoes));
  }
  assert.equal(validarContato({ ...contato, email: "ana@hospital.com.br" }, { somenteComBr: true }).contato.email, "ana@hospital.com.br");
});

test("validarContato: opções null (ou de tipo estranho) não lançam e valem como sem opção", () => {
  const contato = { nome: "Ana Souza", whatsapp: "21998765432", email: "ana@hospital.org" };
  for (const opcoes of [null, undefined, 0, "", "somenteComBr", true, 42, [], [true], { somenteComBr: "true" }, { somenteComBr: 1 }, Object.create(null)]) {
    const rotulo = opcoes === null ? "null" : typeof opcoes === "object" ? JSON.stringify(opcoes) ?? "sem protótipo" : String(opcoes);
    let resultado;
    assert.doesNotThrow(() => {
      resultado = validarContato(contato, opcoes);
    }, rotulo);
    assert.equal(resultado.contato.email, "ana@hospital.org", rotulo);
    assert.equal(resultado.campos, undefined, rotulo);
  }
  // Contato e opções null juntos: os três campos voltam com erro, sem lançar.
  const vazio = validarContato(null, null);
  assert.deepEqual(Object.keys(vazio.campos).sort(), ["email", "nome", "whatsapp"]);
  // Só o true de verdade liga a régua; e ela olha o domínio sem ligar para maiúsculas.
  assert.equal(validarContato(contato, { somenteComBr: true }).campos.email, "Use um e-mail que termine em .com ou .com.br.");
  for (const email of ["ANA@GMAIL.COM", "Ana@Hospital.COM.BR", "  ana@uol.Com.Br "]) {
    const r = validarContato({ ...contato, email }, { somenteComBr: true });
    assert.equal(r.campos, undefined, email);
    assert.equal(r.contato.email, email.trim().toLowerCase(), email);
  }
});

test("body.checkout: botão de lote novo do mesmo produto vira a base (off trocado); outro produto, outro site ou lixo é ignorado", async () => {
  const backend = backendInscricao();
  const appUrl = await listen(app({ backend }).server);
  const enviar = async (corpo, headers = { Origin: ORIGEM_GPS }) => {
    const response = await postJson(appUrl, "/api/inscricao", corpo, headers);
    assert.equal(response.status, 200);
    const { checkout } = await response.json();
    assert.equal(backend.chamadas.at(-1).body.p.checkout_url, checkout, "o que vai para a tela é o que foi gravado");
    return new URL(checkout);
  };

  const lote = await enviar(corpoGps({ checkout: "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10" }));
  assert.equal(`${lote.origin}${lote.pathname}`, "https://pay.hotmart.com/R107667362D");
  assert.equal(lote.searchParams.get("off"), "lote2abc");
  assert.equal(lote.searchParams.get("checkoutMode"), "10");
  assert.equal(lote.searchParams.get("sck"), "criativo-gps-03", "as UTMs e o sck seguem iguais");
  assert.equal(lote.searchParams.get("name"), "Ana Souza");

  // O botão não consegue trocar produto, site, UTM nem sck.
  for (const pedido of [
    CHECKOUT.PAGINAS["viver-de-furo"].checkout,
    "https://pay.hotmart.com/OUTRO123X?off=lote2abc",
    "https://evil.example/R107667362D?off=lote2abc",
    "https://pay.hotmart.com/R107667362D?off=%3Cx%3E",
    "https://pay.hotmart.com/R107667362D",
    `https://pay.hotmart.com/R107667362D?off=lote2abc&x=${"a".repeat(3000)}`,
    "",
    42,
    null,
    { off: "lote2abc" },
    ["https://pay.hotmart.com/R107667362D?off=lote2abc"]
  ]) {
    const url = await enviar(corpoGps({ checkout: pedido }));
    assert.equal(`${url.origin}${url.pathname}`, "https://pay.hotmart.com/R107667362D", String(pedido).slice(0, 60));
    assert.equal(url.searchParams.get("off"), "l0r77by6", String(pedido).slice(0, 60));
  }
  const forjado = await enviar(corpoGps({ checkout: "https://pay.hotmart.com/R107667362D?off=lote2abc&sck=forjado&utm_source=forjado" }));
  assert.equal(forjado.searchParams.get("off"), "lote2abc");
  assert.equal(forjado.searchParams.get("sck"), "criativo-gps-03");
  assert.equal(forjado.searchParams.get("utm_source"), "facebook");

  // Vale igual para a página daqui: oferta nova do MESMO produto da Viver de Furo.
  const viver = await enviar(corpoInscricao({ checkout: "https://pay.hotmart.com/Y74893363S?off=novaoferta&checkoutMode=10" }), {});
  assert.equal(viver.searchParams.get("off"), "novaoferta");
  assert.equal(viver.searchParams.get("sck"), "criativo-07");
  const viverComGps = await enviar(corpoInscricao({ checkout: PAGINA_GPS.checkout }), {});
  assert.equal(viverComGps.searchParams.get("off"), "7j2nqptq");
});

test("a rota /igps_set_lp_26-ingresso NÃO é servida aqui (a página mora no outro site); /viver-de-furo-inscricao continua", async () => {
  const appUrl = await listen(createServerApp({ rootDirectory: root, siteUrl: "https://lp.exemplo.com.br" }));

  for (const caminho of [PAGINA_GPS.rota, `${PAGINA_GPS.rota}/`]) {
    const response = await fetch(`${appUrl}${caminho}`);
    assert.equal(response.status, 404, caminho);
    assert.deepEqual(await response.json(), { ok: false, error: "not_found" }, caminho);
  }
  for (const caminho of ["/viver-de-furo-inscricao", "/viver-de-furo-inscricao/"]) {
    const response = await fetch(`${appUrl}${caminho}`);
    assert.equal(response.status, 200, caminho);
    assert.ok((await response.text()).includes("inscrição"), caminho);
  }
});

/* ================================================================== webhook de venda da Hotmart */

const HOTTOK = "hottok-de-teste-abcdef";
const CHAVE_WEBHOOK = "chave-de-url-de-teste-123456";

function payloadHotmart(extra = {}, dados = {}) {
  return {
    id: "aviso-1",
    event: "PURCHASE_APPROVED",
    version: "2.0.0",
    creation_date: 1_758_600_000_000,
    data: {
      product: { id: "Y74893363S", ucode: "abc-ucode", name: "Viver de Furo de Orelha" },
      buyer: { name: "Maria da Silva", email: "Maria@Gmail.com", checkout_phone_code: "55", checkout_phone: "11912345678" },
      purchase: {
        transaction: "HP1234567890",
        status: "APPROVED",
        order_date: 1_758_600_000_000,
        approved_date: 1_758_600_060_000,
        price: { value: 197, currency_value: "BRL" },
        offer: { code: "7j2nqptq" },
        payment: { type: "PIX", method: "PIX" },
        tracking: { source: "facebook", source_sck: "criativo-07", external_code: "xyz" },
        ...dados
      }
    },
    ...extra
  };
}

function backendHotmart(resposta = { ok: true, novo: true, casou: true, inscricao_id: SESSAO, pagina: "viver-de-furo" }) {
  return createFakeBackend({ rpc: { hotmart_registrar_compra: typeof resposta === "function" ? resposta : () => jsonResponse(resposta) } });
}

function appHotmart(opcoes = {}) {
  return app({ backend: backendHotmart(), hotmartHottok: HOTTOK, hotmartChave: CHAVE_WEBHOOK, ...opcoes });
}

test("hotmart: sem HOTMART_HOTTOK e sem HOTMART_WEBHOOK_CHAVE → 503 (a Hotmart reenvia depois)", async () => {
  const { server } = app({ backend: backendHotmart() });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart(), { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "webhook_not_configured" });
});

test("hotmart: hottok certo grava; hottok errado, ausente ou vazio → 401", async () => {
  const backend = backendHotmart();
  const { server } = app({ backend, hotmartHottok: HOTTOK });
  const appUrl = await listen(server);

  const ok = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart(), { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(backend.chamadas.length, 1);

  for (const headers of [{ "X-HOTMART-HOTTOK": "errado" }, { "X-HOTMART-HOTTOK": "" }, {}, { "X-HOTMART-HOTTOK": `${HOTTOK}x` }]) {
    const response = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart(), headers);
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { ok: false, error: "unauthorized" });
  }
  assert.equal(backend.chamadas.length, 1, "nada além do aviso autenticado foi gravado");
});

test("hotmart: a chave na URL funciona sozinha (antes de o hottok existir) e a errada não", async () => {
  const backend = backendHotmart();
  const { server } = app({ backend, hotmartChave: CHAVE_WEBHOOK });
  const appUrl = await listen(server);

  const ok = await postJson(appUrl, `/api/hotmart/venda?chave=${CHAVE_WEBHOOK}`, payloadHotmart());
  assert.equal(ok.status, 200);

  for (const query of ["", "?chave=", "?chave=errada", `?chave=${CHAVE_WEBHOOK}x`, "?outra=1"]) {
    const response = await postJson(appUrl, `/api/hotmart/venda${query}`, payloadHotmart());
    assert.equal(response.status, 401, query);
  }

  // Com as duas configuradas, qualquer uma das duas basta.
  const dois = await listen(appHotmart().server);
  assert.equal((await postJson(dois, `/api/hotmart/venda?chave=${CHAVE_WEBHOOK}`, payloadHotmart())).status, 200);
  assert.equal((await postJson(dois, "/api/hotmart/venda", payloadHotmart(), { "X-HOTMART-HOTTOK": HOTTOK })).status, 200);
  assert.equal((await postJson(dois, "/api/hotmart/venda?chave=errada", payloadHotmart(), { "X-HOTMART-HOTTOK": "errado" })).status, 401);
});

test("hotmart: GET responde 405 e não grava nada", async () => {
  const backend = backendHotmart();
  const { server } = app({ backend, hotmartHottok: HOTTOK, hotmartChave: CHAVE_WEBHOOK });
  const appUrl = await listen(server);

  const response = await fetch(`${appUrl}/api/hotmart/venda?chave=${CHAVE_WEBHOOK}`);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(backend.chamadas.length, 0);
});

test("hotmart: os campos vão para o SQL com o payload CRU junto", async () => {
  const backend = backendHotmart();
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  const payload = payloadHotmart();
  const response = await postJson(appUrl, "/api/hotmart/venda", payload, { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(response.status, 200);

  const [chamada] = backend.chamadas;
  assert.match(chamada.url, /\/rest\/v1\/rpc\/hotmart_registrar_compra$/);
  const p = chamada.body.p;
  assert.equal(p.evento, "PURCHASE_APPROVED");
  assert.equal(p.hotmart_id, "aviso-1");
  assert.equal(p.transacao, "HP1234567890");
  assert.equal(p.status, "APPROVED");
  assert.equal(p.produto_id, "Y74893363S");
  assert.equal(p.produto_nome, "Viver de Furo de Orelha");
  assert.equal(p.oferta, "7j2nqptq");
  assert.equal(p.valor, 197);
  assert.equal(p.moeda, "BRL");
  assert.equal(p.comprador_nome, "Maria da Silva");
  assert.equal(p.comprador_email, "maria@gmail.com", "e-mail minúsculo, como na inscrição");
  assert.equal(p.comprador_telefone, "5511912345678", "DDI + número");
  assert.equal(p.comprador_digits, "11912345678", "os mesmos dígitos gravados na inscrição");
  assert.equal(p.sck, "criativo-07");
  assert.equal(p.src, "facebook");
  assert.equal(p.evento_em, "2025-09-23T04:00:00.000Z");
  assert.equal(p.pedido_em, "2025-09-23T04:00:00.000Z");
  assert.equal(p.aprovado_em, "2025-09-23T04:01:00.000Z");
  assert.equal(p.produto_ucode, "abc-ucode");
  assert.equal(p.pagina, "viver-de-furo", "a oferta 7j2nqptq é da Viver de Furo (checkout-config)");
  assert.deepEqual(p.payload, payload, "o payload inteiro, do jeito que chegou");
  assert.deepEqual(
    Object.keys(p).sort(),
    [
      "aprovado_em", "comprador_digits", "comprador_email", "comprador_nome", "comprador_telefone", "evento", "evento_em",
      "hotmart_id", "moeda", "oferta", "pagina", "payload", "pedido_em", "produto_id", "produto_nome", "produto_ucode",
      "sck", "src", "status", "transacao", "valor"
    ],
    "o contrato com hotmart_registrar_compra"
  );
});

test("hotmart: comprador em data.purchase.buyer, sck em sckPaymentLink, datas ISO e telefone já com DDI", async () => {
  const backend = backendHotmart();
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  const payload = {
    id: "aviso-2",
    event: "PURCHASE_COMPLETE",
    data: {
      product: { ucode: "so-ucode", name: "Viver de Furo" },
      purchase: {
        transaction: "HP999",
        status: "COMPLETED",
        buyer: { name: "João Souza", email: "JOAO@GMAIL.COM", checkout_phone: "+55 (21) 99876-5432" },
        order_date: "2026-09-20T10:00:00Z",
        approved_date: "2026-09-20T10:05:00Z",
        price: { value: "197.50", currency_code: "BRL" },
        sckPaymentLink: "criativo-09"
      }
    }
  };
  assert.equal((await postJson(appUrl, `/api/hotmart/venda?chave=${CHAVE_WEBHOOK}`, payload)).status, 200);

  const p = backend.chamadas[0].body.p;
  assert.equal(p.evento, "PURCHASE_COMPLETE");
  assert.equal(p.produto_id, "so-ucode");
  assert.equal(p.comprador_nome, "João Souza");
  assert.equal(p.comprador_email, "joao@gmail.com");
  assert.equal(p.comprador_digits, "21998765432", "o +55 sai, como no formulário");
  assert.equal(p.sck, "criativo-09");
  assert.equal(p.valor, 197.5);
  assert.equal(p.moeda, "BRL");
  assert.equal(p.pedido_em, "2026-09-20T10:00:00.000Z");
  assert.equal(p.aprovado_em, "2026-09-20T10:05:00.000Z");
  assert.equal(p.evento_em, null, "sem creation_date, o momento fica por conta do banco");
});

test("hotmart: evento de cancelamento, reembolso e chargeback é gravado igual", async () => {
  const backend = backendHotmart({ ok: true, novo: true, casou: true, inscricao_id: SESSAO, pagina: "viver-de-furo" });
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  for (const evento of ["PURCHASE_CANCELED", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST", "PURCHASE_BILLET_PRINTED", "PURCHASE_OUT_OF_SHOPPING_CART"]) {
    const response = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart({ event: evento }), { "X-HOTMART-HOTTOK": HOTTOK });
    assert.equal(response.status, 200, evento);
    assert.deepEqual(await response.json(), { ok: true }, evento);
  }
  assert.deepEqual(
    backend.chamadas.map((chamada) => chamada.body.p.evento),
    ["PURCHASE_CANCELED", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST", "PURCHASE_BILLET_PRINTED", "PURCHASE_OUT_OF_SHOPPING_CART"]
  );
});

test("hotmart: aviso que não é de compra é aceito e ignorado; sem evento → 422", async () => {
  const backend = backendHotmart();
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  for (const evento of ["CLUB_FIRST_ACCESS", "SUBSCRIPTION_CANCELLATION", "UPDATE_SUBSCRIPTION_CHARGE_DATE"]) {
    const response = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart({ event: evento }), { "X-HOTMART-HOTTOK": HOTTOK });
    assert.equal(response.status, 200, evento);
    assert.deepEqual(await response.json(), { ok: true, ignorado: true }, evento);
  }
  assert.equal(backend.chamadas.length, 0, "nada disso vai para o banco");

  for (const corpo of [{ id: "x" }, { event: "" }, { event: 42 }]) {
    const response = await postJson(appUrl, "/api/hotmart/venda", corpo, { "X-HOTMART-HOTTOK": HOTTOK });
    assert.equal(response.status, 422, JSON.stringify(corpo));
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_event" });
  }
});

test("hotmart: aceita payload grande (256 KB) e corta acima disso", async () => {
  const backend = backendHotmart();
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  // Um payload de 100 KB (a Hotmart manda comissões, assinatura, dados do produtor...) passa.
  const grande = payloadHotmart({ extra_da_hotmart: "x".repeat(100 * 1024) });
  const ok = await postJson(appUrl, "/api/hotmart/venda", grande, { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(ok.status, 200);
  assert.equal(backend.chamadas[0].body.p.payload.extra_da_hotmart.length, 100 * 1024, "o extra desconhecido foi guardado inteiro");

  const enorme = payloadHotmart({ extra_da_hotmart: "x".repeat(300 * 1024) });
  const grandeDemais = await postJson(appUrl, "/api/hotmart/venda", enorme, { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(grandeDemais.status, 413);
  assert.deepEqual(await grandeDemais.json(), { ok: false, error: "payload_too_large" });
});

test("hotmart: banco fora → 502 (a Hotmart reenvia); sem banco → 503", async () => {
  const backend = createFakeBackend({ rpc: { hotmart_registrar_compra: () => jsonResponse({ message: "detalhe interno" }, 500) } });
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart(), { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "database_unavailable" });

  const semBanco = await listen(
    createServerApp({ rootDirectory: root, hotmartHottok: HOTTOK, resolveEmailDomain: async () => "ok" })
  );
  const resposta503 = await postJson(semBanco, "/api/hotmart/venda", payloadHotmart(), { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(resposta503.status, 503);
  assert.deepEqual(await resposta503.json(), { ok: false, error: "database_not_configured" });
});

test("hotmart: compra que não casou com inscrição ainda responde 200 (o banco guarda o aviso)", async () => {
  const backend = backendHotmart({ ok: true, novo: true, casou: false, inscricao_id: null, pagina: null });
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  const response = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart(), { "X-HOTMART-HOTTOK": HOTTOK });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

/*
 * O formato REAL do Webhook 2.0.0, como os avisos gravados em produção chegam: id do produto
 * NUMÉRICO (não é o código do link), a oferta em purchase.offer.code e o sck em
 * purchase.origin.sck — antes o servidor procurava o sck em purchase.tracking e gravava null.
 */
function avisoReal({ evento = "PURCHASE_APPROVED", produto = {}, purchase = {}, ...extra } = {}) {
  return {
    id: "5f0c3a1e-aviso-real",
    creation_date: 1_758_600_000_000,
    event: evento,
    version: "2.0.0",
    data: {
      product: { id: 2332962, ucode: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", name: "Furo de orelha humanizado", ...produto },
      buyer: { name: "Maria da Silva", email: "Maria@Gmail.com", checkout_phone_code: "55", checkout_phone: "11912345678" },
      purchase: {
        transaction: "HP1700000001",
        status: "APPROVED",
        offer: { code: "7j2nqptq", name: "Oferta principal" },
        origin: { sck: "HOTMART_SALES_AGENT" },
        price: { value: 197, currency_value: "BRL" },
        order_date: 1_758_600_000_000,
        approved_date: 1_758_600_060_000,
        ...purchase
      }
    },
    ...extra
  };
}

// Carrinho abandonado: vem SEM purchase; a oferta fica em data.offer.
function avisoCarrinho({ oferta = "l0r77by6", produto = { id: 7654321, name: "Imersão GPS do Plantão Sem Medo" } } = {}) {
  return {
    id: "carrinho-1",
    creation_date: 1_758_600_000_000,
    event: "PURCHASE_OUT_OF_SHOPPING_CART",
    version: "2.0.0",
    data: {
      offer: { code: oferta },
      product: produto,
      buyer: { name: "Ana Souza", email: "Ana@Gmail.com", phone: "21998765432" }
    }
  };
}

test("extrairVendaHotmart: formato REAL — sck em purchase.origin, oferta em offer.code, produto numérico e ucode", () => {
  const venda = extrairVendaHotmart(avisoReal());
  assert.equal(venda.evento, "PURCHASE_APPROVED");
  assert.equal(venda.transacao, "HP1700000001");
  assert.equal(venda.status, "APPROVED");
  assert.equal(venda.produto_id, "2332962", "o id numérico vira texto");
  assert.equal(venda.produto_ucode, "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  assert.equal(venda.produto_nome, "Furo de orelha humanizado");
  assert.equal(venda.oferta, "7j2nqptq");
  assert.equal(venda.sck, "HOTMART_SALES_AGENT", "o sck vem de purchase.origin.sck");
  assert.equal(venda.src, null);
  assert.equal(venda.valor, 197);
  assert.equal(venda.moeda, "BRL");
  assert.equal(venda.comprador_email, "maria@gmail.com");
  assert.equal(venda.comprador_digits, "11912345678");

  // O sck que o nosso checkout manda (o utm_content, no GPS) volta em origin.sck; o src também.
  const doGps = extrairVendaHotmart(avisoReal({ purchase: { offer: { code: "l0r77by6" }, origin: { sck: "criativo-gps-03", src: "facebook" } } }));
  assert.equal(doGps.sck, "criativo-gps-03");
  assert.equal(doGps.src, "facebook");
  assert.equal(doGps.oferta, "l0r77by6");

  // origin manda sobre tracking; sem origin (ou origin torto), tracking ainda vale.
  const osDois = extrairVendaHotmart(avisoReal({ purchase: { origin: { sck: "da-origin", src: "src-origin" }, tracking: { source_sck: "do-tracking", source: "src-tracking" } } }));
  assert.equal(osDois.sck, "da-origin");
  assert.equal(osDois.src, "src-origin");
  for (const origin of [undefined, "texto", [], null, {}]) {
    const reserva = extrairVendaHotmart(avisoReal({ purchase: { origin, tracking: { source_sck: "do-tracking", source: "src-tracking" } } }));
    assert.equal(reserva.sck, "do-tracking", JSON.stringify(origin));
    assert.equal(reserva.src, "src-tracking", JSON.stringify(origin));
  }

  // Produto sem id: o ucode faz as vezes dos dois.
  const soUcode = extrairVendaHotmart(avisoReal({ produto: { id: undefined } }));
  assert.equal(soUcode.produto_id, "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  assert.equal(soUcode.produto_ucode, "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b");
  // O produto 0 dos testes da Hotmart é "0", não "".
  assert.equal(extrairVendaHotmart(avisoReal({ produto: { id: 0 } })).produto_id, "0");
});

test("extrairVendaHotmart: sck e src são o primeiro NÃO VAZIO das fontes, na ordem", () => {
  const sckDe = (purchase) => extrairVendaHotmart(avisoReal({ purchase })).sck;
  const srcDe = (purchase) => extrairVendaHotmart(avisoReal({ purchase })).src;
  const tracking = { source_sck: "do-tracking", source: "src-tracking" };

  // origin.sck vazio (a chave existe, mas sem nada) não esconde a reserva: antes o ?? parava nele.
  for (const vazio of ["", "   ", "\t\n ", null, undefined]) {
    assert.equal(sckDe({ origin: { sck: vazio, src: vazio }, tracking }), "do-tracking", JSON.stringify(vazio));
    assert.equal(srcDe({ origin: { sck: vazio, src: vazio }, tracking }), "src-tracking", JSON.stringify(vazio));
  }

  // A ordem: origin.sck → tracking.source_sck → purchase.sckPaymentLink → tracking.external_code.
  const todas = {
    origin: { sck: "1-origin" },
    tracking: { source_sck: "2-tracking", external_code: "4-external" },
    sckPaymentLink: "3-link-de-pagamento"
  };
  assert.equal(sckDe(todas), "1-origin");
  assert.equal(sckDe({ ...todas, origin: { sck: " " } }), "2-tracking");
  assert.equal(sckDe({ ...todas, origin: {}, tracking: { source_sck: "", external_code: "4-external" } }), "3-link-de-pagamento");
  assert.equal(sckDe({ origin: { sck: "" }, tracking: { source_sck: "  ", external_code: "4-external" }, sckPaymentLink: "" }), "4-external");
  // Nada preenchido em lugar nenhum: null (vira "(sem sck)" no painel), nunca "".
  assert.equal(sckDe({ origin: { sck: "" }, tracking: { source_sck: " ", external_code: "" }, sckPaymentLink: "   " }), null);
  assert.equal(sckDe({ origin: undefined }), null);

  // Espaços em volta saem; o valor é cortado em 500.
  assert.equal(sckDe({ origin: { sck: "  criativo-gps-03  " } }), "criativo-gps-03");
  assert.equal(sckDe({ origin: { sck: "" }, sckPaymentLink: "\tcriativo-09 " }), "criativo-09");
  assert.equal(sckDe({ origin: { sck: "x".repeat(600) } }), "x".repeat(500));

  // Número vira texto (0 inclusive: é um valor, não ausência); NaN, Infinity e outros tipos pulam.
  assert.equal(sckDe({ origin: { sck: 12345 }, tracking }), "12345");
  assert.equal(sckDe({ origin: { sck: 0 }, tracking }), "0");
  assert.equal(sckDe({ origin: { sck: 1.5 } }), "1.5");
  for (const estranho of [Number.NaN, Infinity, -Infinity, true, false, {}, [], ["criativo"], { sck: "x" }]) {
    assert.equal(sckDe({ origin: { sck: estranho }, tracking }), "do-tracking", String(estranho));
  }
  assert.equal(srcDe({ origin: { src: 7 }, tracking }), "7");
  assert.equal(srcDe({ origin: { src: {} }, tracking }), "src-tracking");

  // O src tem só as duas fontes dele: sckPaymentLink e external_code nunca viram src.
  assert.equal(srcDe({ origin: { src: "" }, tracking: { source: "", external_code: "4-external" }, sckPaymentLink: "3-link" }), null);
  assert.equal(srcDe({ origin: { src: "  facebook " }, tracking }), "facebook");
  // E o src nunca vira sck.
  assert.equal(sckDe({ origin: { src: "facebook" }, tracking: { source: "facebook" } }), null);
});

test("hotmart: origin.sck vazio com o sck no tracking — o SQL recebe o do tracking (sck e src)", async () => {
  const backend = backendHotmart();
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  const casos = [
    [{ origin: { sck: "", src: "" } }, "criativo-07", "facebook"],
    [{ origin: { sck: "   ", src: "  " } }, "criativo-07", "facebook"],
    [{ origin: { sck: 987, src: 0 } }, "987", "0"],
    [{ origin: { sck: "", src: "" }, tracking: { source: "", source_sck: "" }, sckPaymentLink: "" }, null, null]
  ];
  for (const [dados] of casos) {
    const response = await postJson(appUrl, "/api/hotmart/venda", payloadHotmart({}, dados), { "X-HOTMART-HOTTOK": HOTTOK });
    assert.equal(response.status, 200, JSON.stringify(dados));
  }
  casos.forEach(([dados, sck, src], indice) => {
    const { p } = backend.chamadas[indice].body;
    assert.equal(p.sck, sck, JSON.stringify(dados));
    assert.equal(p.src, src, JSON.stringify(dados));
    assert.ok(Object.hasOwn(p, "sck") && Object.hasOwn(p, "src"), "as chaves vão sempre, mesmo null");
  });
});

test("extrairVendaHotmart: carrinho abandonado (sem purchase) — a oferta sai de data.offer", () => {
  const venda = extrairVendaHotmart(avisoCarrinho());
  assert.equal(venda.evento, "PURCHASE_OUT_OF_SHOPPING_CART");
  assert.equal(venda.oferta, "l0r77by6");
  assert.equal(venda.produto_id, "7654321");
  assert.equal(venda.produto_ucode, null);
  assert.equal(venda.transacao, null);
  assert.equal(venda.status, null);
  assert.equal(venda.sck, null);
  assert.equal(venda.valor, null);
  assert.equal(venda.comprador_nome, "Ana Souza");
  assert.equal(venda.comprador_email, "ana@gmail.com");
  assert.equal(venda.comprador_digits, "21998765432");

  // Com purchase.offer E data.offer, vale a da compra.
  const comAsDuas = avisoReal();
  comAsDuas.data.offer = { code: "outra-oferta" };
  assert.equal(extrairVendaHotmart(comAsDuas).oferta, "7j2nqptq");
  // data.offer torto não quebra nada.
  for (const offer of ["texto", [], null]) {
    const torto = avisoCarrinho();
    torto.data.offer = offer;
    assert.equal(extrairVendaHotmart(torto).oferta, null, JSON.stringify(offer));
  }
});

test("hotmart: o servidor manda ao SQL a página do produto (checkout-config), ou null quando o produto é de fora", async () => {
  const backend = backendHotmart();
  const { server } = appHotmart({ backend });
  const appUrl = await listen(server);

  const casos = [
    ["oferta do GPS", avisoReal({ produto: { id: 5550001 }, purchase: { offer: { code: "l0r77by6" } } }), "imersao-gps"],
    ["produto 2332962 com oferta que o config não tem", avisoReal({ purchase: { offer: { code: "lote-desconhecido" } } }), "viver-de-furo"],
    ["produto 2332962 sem oferta", avisoReal({ purchase: { offer: undefined } }), "viver-de-furo"],
    ["oferta do GPS com o produto da Viver: vale a oferta", avisoReal({ purchase: { offer: { code: "l0r77by6" } } }), "imersao-gps"],
    ["carrinho abandonado do GPS", avisoCarrinho(), "imersao-gps"],
    ["outro produto (Imersão Viver de Furo de Orelha)", avisoReal({ produto: { id: 8519248, ucode: "u-8519248" }, purchase: { offer: { code: "outra" } } }), null],
    ["produto 0 (teste da Hotmart)", avisoReal({ produto: { id: 0, ucode: "" }, purchase: { offer: { code: "teste" } } }), null],
    ["sem produto e sem oferta", { id: "vazio", event: "PURCHASE_APPROVED", data: { purchase: { transaction: "HP0" } } }, null]
  ];
  for (const [rotulo, payload] of casos) {
    const response = await postJson(appUrl, "/api/hotmart/venda", payload, { "X-HOTMART-HOTTOK": HOTTOK });
    assert.equal(response.status, 200, rotulo);
  }
  assert.equal(backend.chamadas.length, casos.length);
  casos.forEach(([rotulo, payload, pagina], indice) => {
    const p = backend.chamadas[indice].body.p;
    assert.ok(Object.hasOwn(p, "pagina"), `${rotulo}: a chave vai sempre, mesmo null`);
    assert.equal(p.pagina, pagina, rotulo);
    // Pela ida e volta do JSON: um campo `undefined` do dublê não existe no que a Hotmart manda.
    assert.deepEqual(p.payload, JSON.parse(JSON.stringify(payload)), `${rotulo}: payload cru`);
  });

  // O sck real chega ao SQL.
  assert.equal(backend.chamadas[0].body.p.sck, "HOTMART_SALES_AGENT");
  assert.equal(backend.chamadas[0].body.p.produto_id, "5550001");
});

test("extrairVendaHotmart: payload vazio, torto ou de outro formato nunca lança", () => {
  for (const corpo of [null, undefined, 42, "texto", [], {}, { data: null }, { data: { purchase: [] } }, { data: { buyer: "x" } }]) {
    const venda = extrairVendaHotmart(corpo);
    assert.equal(typeof venda, "object");
    assert.equal(venda.evento, "");
    assert.equal(venda.transacao, null);
    assert.equal(venda.comprador_digits, null);
  }
  // O evento sobe para maiúsculas: "purchase_approved" e "PURCHASE_APPROVED" são o mesmo aviso.
  assert.equal(extrairVendaHotmart({ event: "purchase_approved" }).evento, "PURCHASE_APPROVED");
});

test("dataHotmart: epoch em milissegundos, em segundos, ISO e lixo", () => {
  assert.equal(dataHotmart(1_758_600_000_000), "2025-09-23T04:00:00.000Z");
  assert.equal(dataHotmart(1_758_600_000), "2025-09-23T04:00:00.000Z");
  assert.equal(dataHotmart("1758600000000"), "2025-09-23T04:00:00.000Z");
  assert.equal(dataHotmart("2026-09-23T04:00:00Z"), "2026-09-23T04:00:00.000Z");
  for (const lixo of [null, undefined, "", "   ", "ontem", {}, [], Number.NaN, Infinity]) {
    assert.equal(dataHotmart(lixo), null, String(lixo));
  }
});


/* ================================================================== aviso de inscrição ao n8n */

const WEBHOOK_GPS = "https://n8n.exemplo.com.br/webhook/gps-outubro";

/** O banco falso da inscrição + o n8n do GPS + o PATCH que marca webhook_enviado_em. */
function backendGpsComN8n({ novo = true, n8n } = {}) {
  const base = createFakeBackend({ rpc: { inscricao_salvar: { ok: true, novo, id: SESSAO } } });
  const fetchImpl = async (url, init = {}) => {
    const endereco = String(url);
    if (endereco.startsWith(WEBHOOK_GPS)) {
      base.chamadas.push({ url: endereco, method: init.method, body: JSON.parse(init.body) });
      return n8n ? n8n() : jsonResponse({ ok: true });
    }
    if (/\/rest\/v1\/inscricoes\?id=eq\./.test(endereco)) {
      base.chamadas.push({ url: endereco, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(null, { status: 204 });
    }
    return base.fetchImpl(url, init);
  };
  return { chamadas: base.chamadas, fetchImpl };
}

const doN8n = (backend) => backend.chamadas.filter((c) => c.url.startsWith(WEBHOOK_GPS));
const marcacoes = (backend) => backend.chamadas.filter((c) => /\/rest\/v1\/inscricoes\?id=eq\./.test(c.url));

test("inscrição NOVA do GPS vai uma vez ao n8n com contato, UTMs, sck e checkout, e fica marcada como entregue", async () => {
  const backend = backendGpsComN8n();
  const appUrl = await listen(app({ backend, webhooksInscricao: { "imersao-gps": WEBHOOK_GPS }, webhookEsperasMs: [0] }).server);

  const response = await postJson(appUrl, "/api/inscricao", corpoGps());
  assert.equal(response.status, 200);
  await aguardar(() => marcacoes(backend).length === 1);

  const [aviso] = doN8n(backend);
  assert.equal(aviso.method, "POST");
  const p = aviso.body;
  assert.equal(p.evento, "inscricao");
  assert.deepEqual(p.pagina, {
    id: "imersao-gps",
    nome: PAGINA_GPS.nome,
    produto: PAGINA_GPS.produto,
    rota: PAGINA_GPS.rota,
    url: `${PAGINA_GPS.origem}${PAGINA_GPS.rota}`
  });
  assert.equal(p.inscricao_id, SESSAO);
  assert.deepEqual(p.lead, {
    nome: "Ana Souza",
    primeiro_nome: "Ana",
    whatsapp: "(21) 99876-5432",
    whatsapp_digits: "21998765432",
    whatsapp_internacional: "5521998765432",
    email: "ana@gmail.com"
  });
  assert.deepEqual(p.utm, {
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "gps-set",
    utm_content: "criativo-gps-03",
    utm_term: "publico-quente"
  });
  assert.equal(p.sck, "criativo-gps-03", "o sck do GPS é o utm_content");
  assert.equal(p.rastreio.fbclid, "IwAR-gps");
  assert.equal(p.rastreio.dispositivo, "mobile");
  assert.match(p.checkout_url, /^https:\/\/pay\.hotmart\.com\/R107667362D\?off=l0r77by6/);
  assert.match(p.checkout_url, /sck=criativo-gps-03/);
  assert.ok(Date.parse(p.inscrito_em) && Date.parse(p.enviado_em));

  const [marca] = marcacoes(backend);
  assert.equal(marca.method, "PATCH");
  assert.match(marca.url, new RegExp(`id=eq\\.${SESSAO}$`));
  assert.ok(Date.parse(marca.body.webhook_enviado_em));
});

test("reenvio do formulário (inscrição que já existia) não avisa o n8n de novo", async () => {
  const backend = backendGpsComN8n({ novo: false });
  const appUrl = await listen(app({ backend, webhooksInscricao: { "imersao-gps": WEBHOOK_GPS }, webhookEsperasMs: [0] }).server);
  assert.equal((await postJson(appUrl, "/api/inscricao", corpoGps())).status, 200);
  await esperar(80);
  assert.equal(doN8n(backend).length, 0);
  assert.equal(marcacoes(backend).length, 0);
});

test("a Viver de Furo não tem webhook: inscrição dela não vai para o n8n do GPS", async () => {
  const backend = backendGpsComN8n();
  const appUrl = await listen(app({ backend, webhooksInscricao: { "imersao-gps": WEBHOOK_GPS }, webhookEsperasMs: [0] }).server);
  assert.equal((await postJson(appUrl, "/api/inscricao", corpoInscricao())).status, 200);
  await esperar(80);
  assert.equal(doN8n(backend).length, 0);
});

test("sem webhook configurado (padrão), com 'off', endereço torto ou página que não existe: nada sai", async () => {
  for (const webhooksInscricao of [undefined, { "imersao-gps": "off" }, { "imersao-gps": "não é url" }, { "imersao-gps": "ftp://x" }, { "nao-existe": WEBHOOK_GPS }]) {
    const backend = backendGpsComN8n();
    const appUrl = await listen(app({ backend, webhookEsperasMs: [0], ...(webhooksInscricao ? { webhooksInscricao } : {}) }).server);
    assert.equal((await postJson(appUrl, "/api/inscricao", corpoGps())).status, 200);
    await esperar(60);
    assert.equal(doN8n(backend).length, 0, JSON.stringify(webhooksInscricao));
  }
});

test("n8n fora: a pessoa já recebeu o checkout (200), são 3 tentativas e a inscrição NÃO é marcada (a varredura reenvia)", async () => {
  const backend = backendGpsComN8n({ n8n: () => jsonResponse({ erro: "fora" }, 503) });
  const appUrl = await listen(app({ backend, webhooksInscricao: { "imersao-gps": WEBHOOK_GPS }, webhookEsperasMs: [0, 5, 5] }).server);
  const response = await postJson(appUrl, "/api/inscricao", corpoGps());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  await aguardar(() => doN8n(backend).length === 3);
  await esperar(40);
  assert.equal(marcacoes(backend).length, 0);
});

test("montarPayloadInscricao: sem checkout_url, o sck é a UTM que a página manda (utm_content no GPS)", () => {
  const p = montarPayloadInscricao({
    linha: { id: SESSAO, pagina: "imersao-gps", nome: "Rosa Lima", whatsapp_digits: "11977778888", utm_content: "criativo-x", utm_term: "t" },
    agora: Date.parse("2026-09-24T12:00:00Z")
  });
  assert.equal(p.sck, "criativo-x");
  assert.equal(p.lead.whatsapp_internacional, "5511977778888");
  assert.equal(p.inscrito_em, "2026-09-24T12:00:00.000Z");
  assert.equal(p.checkout_url, null);
});
