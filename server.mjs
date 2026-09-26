/*
 * server.mjs — servidor da Pesquisa de ICP da Escola Enfermagem de Valor.
 *
 * Node puro, sem dependência nenhuma (mesmo molde do quintino-landing): serve a pesquisa e o
 * painel como arquivos estáticos, recebe a gravação progressiva das respostas e entrega ao
 * painel os números calculados no Postgres (Supabase, via REST com a chave service_role, que
 * só existe aqui no servidor).
 *
 * As regras de negócio NÃO moram aqui: js/pesquisa-config.js (perguntas, sanitização,
 * progresso), js/obrigado-config.js (as 3 páginas de obrigado e qual perfil cai em qual) e
 * js/lead-rules.js (nome, WhatsApp, e-mail) são os mesmos arquivos que rodam no navegador,
 * carregados com vm. O que a tela aceita é exatamente o que o servidor grava.
 */
import { createHmac, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { createReadStream, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const MAX_BODY_BYTES = 64 * 1024;
const WEBHOOK_TIMEOUT_MS = 10_000;
// Webhook do n8n que recebe a pesquisa concluída (mesmo padrão do LEAD_WEBHOOK_ENDPOINT do
// quintino). PESQUISA_WEBHOOK_URL troca o endereço; "off" desliga. Só o processo de verdade usa
// este padrão: createServerApp começa com "" para teste nenhum disparar um aviso real.
const DEFAULT_WEBHOOK_URL = "https://n8n.tecnicadevalor.com.br/webhook/pesquisa-icp";
// Aviso de PERFIL ATUALIZADO (/atualizacao-perfil): sai no instante em que a pessoa escolhe a
// profissão. Serve para UMA coisa só — fazer a conversa continuar sozinha depois que a pessoa sai
// da conversa e preenche a página. Quem pergunta "quem é essa pessoa?" (o UnniChat, o ManyChat)
// já tem o GET /api/leads/perfil, e quem coleta tudo dentro da própria conversa (o ManyChat) não
// precisa de nada disso.
//
// Por isso nasce DESLIGADO: sem PERFIL_WEBHOOK_URL, nenhum aviso sai e nada fica pendente. Para
// ligar, é só pôr o endereço (o webhook do n8n ou o gatilho do UnniChat) na variável.
const EXEMPLO_PERFIL_WEBHOOK_URL = "https://n8n.tecnicadevalor.com.br/webhook/perfil-atualizado";
// Webhooks do n8n que recebem cada inscrição NOVA, por página de inscrição (id do
// js/checkout-config.js). Ficam aqui, e não no config, porque o config é público (vai para o
// navegador e para a cópia da página de venda): endereço de webhook exposto é convite para spam.
// GPS_WEBHOOK_URL troca o da Imersão GPS; "off" desliga. Como o da pesquisa, só o processo de
// verdade usa este padrão: createServerApp começa sem nenhum.
const DEFAULT_WEBHOOKS_INSCRICAO = Object.freeze({ "imersao-gps": "https://n8n.tecnicadevalor.com.br/webhook/gps-outubro" });
// Três tentativas: na hora, 3 s depois e 10 s depois. Um n8n reiniciando ou um 502 passageiro do
// proxy não fazem o lead sumir; depois disso fica só no log (e webhook_enviado_em fica null, o
// que o painel mostra).
const WEBHOOK_ESPERAS_MS = Object.freeze([0, 3_000, 10_000]);
const SUPABASE_TIMEOUT_MS = 10_000;
// Entradas do cache de HTML/JS/CSS comprimidos (arquivos x codificações x origens da pesquisa).
const RESPONSE_CACHE_MAX = 200;

// Pixel da Enfermagem de Valor, o mesmo das outras páginas da marca. "off" desliga.
const DEFAULT_META_PIXEL_ID = "538380380948773";

// application/json não é aceito em formulário HTML: exigir esse tipo bloqueia envio a partir de outro site.
const JSON_CONTENT_TYPE_PATTERN = /^application\/json\b/i;
const FORMATTED_PHONE_PATTERN = /^\(\d{2}\) \d{5}-\d{4}$/;
// Qualquer versão de UUID: o id nasce no navegador (crypto.randomUUID ou o fallback com
// getRandomValues), e recusar por causa do dígito de versão só perderia resposta.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Uma visita e um clique em "Começar" por carregamento: 60/min cobre IP compartilhado de operadora.
// As páginas de obrigado (visita e clique no grupo) têm um limite próprio com os mesmos números.
const EVENTO_RATE_LIMIT_MAX = 240;
const EVENTO_RATE_LIMIT_WINDOW_MS = 60_000;
// A pesquisa grava a cada resposta (39 perguntas em ~7 minutos, mais re-tentativas da fila):
// Cerca de 2 gravações por pergunta: 600/min por IP deixa folga para ~10 pessoas ao mesmo tempo
// atrás do mesmo IP de operadora (CGNAT), comum em disparo de campanha.
const SALVAR_RATE_LIMIT_MAX = 600;
const SALVAR_RATE_LIMIT_WINDOW_MS = 60_000;
// A página de inscrição grava uma vez por envio (mais os reenvios de quem volta e clica de novo).
const INSCRICAO_RATE_LIMIT_MAX = 240;
const INSCRICAO_RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 5_000;

// O payload da Hotmart é grande (produto, comprador, comissões, assinatura) e guardamos ele CRU.
// 256 KB dá folga de sobra sem virar porta aberta.
const HOTMART_MAX_BODY_BYTES = 256 * 1024;
// Só evento de compra interessa (PURCHASE_APPROVED, PURCHASE_REFUNDED, PURCHASE_BILLET_PRINTED...).
// Prefixo, e não lista fechada: evento novo da Hotmart que comece com PURCHASE_ já entra gravado.
const HOTMART_EVENTO_COMPRA = /^PURCHASE_[A-Z_]+$/;

const SEQ_MAX = 1_000_000;
const TEMPO_MAX_SEGUNDOS = 86_400;
const DISPOSITIVOS = new Set(["mobile", "tablet", "desktop"]);

const PAINEL_COOKIE = "ev_painel";
const PAINEL_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PAINEL_LOGIN_MAX = 10;
const PAINEL_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const PAINEL_LIST_MAX = 500;
const PAINEL_LIST_PADRAO = 100;
const ABERTAS_PADRAO = 200;
// Tamanho da página que o CSV busca no PostgREST. É também o teto padrão de linhas por
// requisição do Supabase: pedir mais do que isso voltaria cortado sem aviso.
const EXPORT_PAGE_SIZE = 1_000;

const STATUS_VALIDOS = new Set(["em_andamento", "concluida"]);
// Eventos das páginas de obrigado: a página abriu, ou a pessoa clicou em "Entrar no grupo".
const EVENTOS_PAGINA = new Set(["visita", "clique_grupo"]);

// Verificação de domínio do e-mail: pega "maria@gmial.com.br" que passou pela regra de formato.
const DNS_TIMEOUT_MS = 3_000;
const DNS_CACHE_TTL_MS = 60 * 60 * 1000;
const DNS_CACHE_MAX = 5_000;

const CSP_PESQUISA = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://connect.facebook.net",
  "img-src 'self' data: https://www.facebook.com",
  "connect-src 'self' https://www.facebook.com https://connect.facebook.net",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

// O painel não carrega nada de fora nem roda script inline: mesmo que um texto vindo do banco
// escapasse do escapeHtml, o navegador não o executaria.
const CSP_PAINEL = [
  "default-src 'self'",
  "script-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

// Só estes tipos são públicos: código do servidor, configurações e documentação nunca são servidos.
const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"]
]);

// .json está na lista de tipos (manifesto, por exemplo), então os .json da raiz que são do
// projeto precisam ser barrados pelo nome.
const PRIVATE_ROOT_FILES = new Set(["package.json", "package-lock.json", "supabase.sql", "server.mjs", "Dockerfile"]);
const PRIVATE_DIRECTORIES = new Set(["scripts", "tests", "node_modules"]);

const IMAGE_EXTENSIONS = new Set([".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
// Texto sai comprimido; imagens raster e fontes já são comprimidas.
const compressibleExtensions = new Set([".css", ".html", ".js", ".json", ".svg", ".txt", ".xml"]);

// O painel e o que ele carrega: não indexar, sem Referer, sem moldura.
const PAINEL_PATHS = new Set(["/painel.html", "/js/painel.js", "/css/painel.css"]);
const PESQUISA_PAGE = "/pesquisa.html";
const PAINEL_PAGE = "/painel.html";
// A rota pública da pesquisa. O arquivo continua pesquisa.html; o endereço antigo (/pesquisa)
// redireciona para cá, para nenhum link já compartilhado quebrar.
const PESQUISA_ROTA = "/pesquisa-icp";
const PESQUISA_ROTAS_ANTIGAS = new Set(["/pesquisa", "/pesquisa/"]);
// As 3 páginas de obrigado são UM arquivo (obrigado.html); a rota diz qual delas mostrar. As rotas
// vêm de js/obrigado-config.js (mais abaixo, em routeAliases).
const OBRIGADO_PAGE = "/obrigado.html";
// Atualização de perfil: o caminho curto do UnniChat (contato + profissão). Grava na mesma tabela
// da pesquisa, com um id de pesquisa próprio, para não misturar com o mapeamento de ICP.
const PERFIL_ROTA = "/atualizacao-perfil";
const PERFIL_PAGE = "/atualizacao-perfil.html";
const PESQUISA_ATUALIZACAO = "atualizacao-perfil";
// Leads que o ManyChat coleta na DM do Instagram. Mesma tabela, id de pesquisa próprio: eles não
// se misturam com o ICP nem com a página de atualização, e a varredura de webhook não os toca
// (quem ramifica o funil desses é o próprio ManyChat).
const PESQUISA_MANYCHAT = "manychat-instagram";
// A origem NÃO vem do cliente: tudo que entra por aquela rota é DM do Instagram, via ManyChat.
// Vai nas colunas de origem que o projeto já tem (as UTMs de primeiro toque), e não em coluna nova.
const ORIGEM_MANYCHAT = Object.freeze({
  utm_source: "instagram",
  utm_medium: "instagram_dm",
  utm_campaign: "manychat"
});

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
// Assíncrono de propósito: scrypt síncrono trava o event loop e derrubaria a pesquisa a cada login.
const scryptAsync = promisify(scrypt);

/* ------------------------------------------------------------------------------------------ */
/* Regras compartilhadas com o navegador                                                       */
/* ------------------------------------------------------------------------------------------ */

// Lidos do diretório DESTE arquivo, e não do rootDirectory: nos testes o estático vem de uma
// pasta de mentira, mas a regra que valida a gravação tem que ser sempre a de verdade.
function loadBrowserScript(relativePath, globalName, context = {}) {
  const source = readFileSync(path.join(moduleDirectory, relativePath), "utf8");
  if (!vm.isContext(context)) vm.createContext(context);
  vm.runInContext(source, context, { filename: relativePath });
  if (!context[globalName]) throw new Error(`${relativePath} não definiu ${globalName}`);
  return context[globalName];
}

// UM contexto para todos os configs, na ordem em que o navegador os carrega: obrigado-config.js lê
// EVPesquisa (os rótulos dos perfis) e checkout-config.js lê EVLeadRules (para formatar o contato
// que vai na URL do checkout). O contexto NÃO tem URL nem URLSearchParams — é justamente por isso
// que checkout-config.js monta a query string na mão (ver tests/checkout-config.test.mjs).
const contextoNavegador = {};
const leadRules = loadBrowserScript("js/lead-rules.js", "EVLeadRules", contextoNavegador);
const pesquisa = loadBrowserScript("js/pesquisa-config.js", "EVPesquisa", contextoNavegador);
const obrigado = loadBrowserScript("js/obrigado-config.js", "EVObrigado", contextoNavegador);
const checkout = loadBrowserScript("js/checkout-config.js", "EVCheckout", contextoNavegador);

const PERGUNTAS = pesquisa.PERGUNTAS;
const POSICAO_FIM = PERGUNTAS.length + 1;
const INDICE_PERGUNTA = new Map(PERGUNTAS.map((pergunta, indice) => [pergunta.id, indice + 1]));
const PERFIS_VALIDOS = new Set(Object.values(pesquisa.PERFIL));
// Na aba de perfis entram também os GRUPOS (hoje "enfermagem", do ManyChat): eles são profissão
// gravada como qualquer outra, só não separam as duas. Ficam fora dos filtros da pesquisa de ICP.
const PERFIS_CONTADOS = Object.freeze([
  ...Object.values(pesquisa.PERFIL),
  ...Object.values(pesquisa.PERFIL_GRUPO).map((grupo) => grupo.rotulo)
]);
const PERFIS_CONTADOS_SET = new Set(PERFIS_CONTADOS);
const CHAVES_TEXTO = Array.from(pesquisa.chavesTexto());
const CHAVES_TEXTO_SET = new Set(CHAVES_TEXTO);
const IDS_ANALISAVEIS = new Set(pesquisa.perguntasAnalisaveis().map((pergunta) => pergunta.id));
const CHAVES_TEMPO = new Set([...INDICE_PERGUNTA.keys(), "contato"]);
const DOMINIOS_CONHECIDOS = new Set(leadRules.KNOWN_DOMAINS);

// Páginas de obrigado: id → página, rota pública → arquivo, e o mapa {perfil: id da página} que o
// painel manda ao SQL para atribuir cada pesquisa concluída à página para onde ela foi.
const PAGINAS_OBRIGADO = new Map(Array.from(obrigado.LISTA, (pagina) => [pagina.id, pagina]));
const ROTAS_OBRIGADO = new Set(Array.from(obrigado.LISTA, (pagina) => pagina.rota));
const MAPA_PERFIL_PAGINA = Object.freeze(
  Object.fromEntries(Array.from(obrigado.LISTA).flatMap((pagina) => Array.from(pagina.perfis, (perfil) => [perfil, pagina.id])))
);

// Páginas de inscrição com checkout na Hotmart (js/checkout-config.js). Nada aqui usa o nome de
// nenhuma: a LISTA manda. Cada rota de página que mora AQUI serve o arquivo de mesmo nome
// (/viver-de-furo-inscricao → viver-de-furo-inscricao.html). Página com `origem` mora em outro site
// (a venda da Imersão GPS): não tem arquivo aqui, só manda o formulário para o /api/inscricao.
const PAGINAS_CHECKOUT = Array.from(checkout.LISTA);
const PAGINAS_CHECKOUT_LOCAIS = PAGINAS_CHECKOUT.filter((pagina) => !pagina.origem);
const ARQUIVO_INSCRICAO = new Map(PAGINAS_CHECKOUT_LOCAIS.map((pagina) => [pagina.rota, `${pagina.rota}.html`]));
// O caminho do arquivo → a rota pública dele (para og:url, canonical e o cache do estático).
const ROTA_DA_INSCRICAO = new Map(PAGINAS_CHECKOUT_LOCAIS.map((pagina) => [`${pagina.rota}.html`, pagina.rota]));

const routeAliases = new Map([
  [PESQUISA_ROTA, PESQUISA_PAGE],
  [`${PESQUISA_ROTA}/`, PESQUISA_PAGE],
  ...Array.from(ROTAS_OBRIGADO).flatMap((rota) => [
    [rota, OBRIGADO_PAGE],
    [`${rota}/`, OBRIGADO_PAGE]
  ]),
  ...Array.from(ARQUIVO_INSCRICAO).flatMap(([rota, arquivo]) => [
    [rota, arquivo],
    [`${rota}/`, arquivo]
  ]),
  [PERFIL_ROTA, PERFIL_PAGE],
  [`${PERFIL_ROTA}/`, PERFIL_PAGE],
  ["/painel", PAINEL_PAGE],
  ["/painel/", PAINEL_PAGE],
  ["/favicon.ico", "/img/favicon-32.png"]
]);

/** Valor de um mapa por perfil (PERFIL_CODIGO, PERFIL_SEGMENTO), sem cair em chave herdada. */
function valorDoPerfil(mapa, perfil) {
  return typeof perfil === "string" && Object.prototype.hasOwnProperty.call(mapa, perfil) ? mapa[perfil] : null;
}

/** A página de obrigado para onde o perfil é levado ao terminar, no formato do aviso ao n8n. */
function paginaObrigadoDoPerfil(perfil) {
  const pagina = typeof perfil === "string" ? obrigado.paginaDoPerfil(perfil) : null;
  return pagina ? { id: pagina.id, rota: pagina.rota, nome: pagina.nome, grupo: pagina.grupo } : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Utilidades                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Resposta de uma palavra só, para ferramenta que não sabe ler JSON (ver ?formato=texto). */
function sendTexto(response, statusCode, palavra) {
  const data = Buffer.from(`${palavra}\n`, "utf8");
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": data.length,
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(data);
}

function sendJson(response, statusCode, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": data.length,
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(data);
}

function methodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  sendJson(response, 405, { ok: false, error: "method_not_allowed" });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value, maxLength = 2_048) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function nullableString(value, maxLength = 2_048) {
  return safeString(value, maxLength) || null;
}

// Datas do painel chegam na query string: só entram na consulta se forem datas de verdade.
function isoDateOrNull(value) {
  const text = nullableString(value, 100);
  const parsed = text ? Date.parse(text) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("payload_too_large"), { statusCode: 413 }));
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid_json"), { statusCode: 400 }));
      }
    });

    request.on("error", reject);
  });
}

// Lê o corpo e já responde os erros de transporte (413, 400, 422 para quem não manda objeto).
// Devolve null quando a resposta já foi enviada.
async function readObjectBody(request, response, maxBytes = MAX_BODY_BYTES) {
  let body;
  try {
    body = await readJsonBody(request, maxBytes);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 400;
    sendJson(response, statusCode, { ok: false, error: error?.message === "payload_too_large" ? "payload_too_large" : "invalid_json" });
    return null;
  }
  if (!isPlainObject(body)) {
    sendJson(response, 422, { ok: false, error: "invalid_body" });
    return null;
  }
  return body;
}

function acceptsJsonBody(request, response) {
  if (JSON_CONTENT_TYPE_PATTERN.test(String(request.headers["content-type"] || ""))) return true;
  sendJson(response, 415, { ok: false, error: "unsupported_media_type" });
  return false;
}

/*
 * CORS do POST /api/inscricao. A página de venda da Imersão GPS mora em outro site
 * (io.escolaenfermagemdevalor.com.br) e manda o formulário para cá. Só as origens da lista
 * (js/checkout-config.js ORIGENS + INSCRICAO_ORIGENS, para teste e preview) recebem
 * Access-Control-Allow-Origin; sem cookie, sem credencial.
 *
 * De uma origem liberada, o corpo JSON também é aceito como text/plain: é o "simple request" do
 * navegador — sem preflight (uma ida a menos antes do checkout) e o único tipo que o
 * navigator.sendBeacon consegue mandar de outro site. De qualquer outra origem, continua valendo
 * só application/json, que um formulário HTML de outro site não consegue enviar.
 */
const TEXT_PLAIN_PATTERN = /^text\/plain\b/i;

export function normalizarOrigem(valor) {
  const texto = String(valor ?? "").trim().toLowerCase().replace(/\/+$/, "");
  return /^https?:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/.test(texto) ? texto : "";
}

function origemLiberada(request, options) {
  const origem = normalizarOrigem(primeiroValor(request.headers.origin));
  return origem && options.origensInscricao.has(origem) ? origem : "";
}

function aceitaCorpoDaInscricao(request, response, options) {
  const tipo = String(request.headers["content-type"] || "");
  if (JSON_CONTENT_TYPE_PATTERN.test(tipo)) return true;
  if (TEXT_PLAIN_PATTERN.test(tipo) && origemLiberada(request, options)) return true;
  sendJson(response, 415, { ok: false, error: "unsupported_media_type" });
  return false;
}

/** Cabeçalhos CORS da origem liberada (antes de qualquer resposta) e o preflight. true = já respondeu. */
function corsDaInscricao(request, response, options) {
  const origem = origemLiberada(request, options);
  if (origem) {
    response.setHeader("Access-Control-Allow-Origin", origem);
    response.setHeader("Vary", "Origin");
  }
  if (request.method !== "OPTIONS") return false;
  if (!origem) {
    sendJson(response, 403, { ok: false, error: "origin_not_allowed" });
    return true;
  }
  response.writeHead(204, {
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    // 2 h é o teto do Chrome: o preflight não se repete a cada envio.
    "Access-Control-Max-Age": "7200",
    "Cache-Control": "no-store"
  });
  response.end();
  return true;
}

// O proxy (Railway) acrescenta o IP real à DIREITA do X-Forwarded-For; tudo o que vem antes é
// texto escrito pelo próprio cliente. Usar o primeiro item deixaria o limite ser burlado com um header.
function clientKey(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",");
  const nearest = forwarded[forwarded.length - 1].trim();
  return nearest || request.socket?.remoteAddress || "desconhecido";
}

// Limite simples por IP, por instância do servidor: contém laços de envio sem atrapalhar uso normal.
function createRateLimiter({ windowMs, max, now }) {
  const windows = new Map();

  return (request) => {
    const key = clientKey(request);
    const agora = now();
    const entry = windows.get(key);

    if (!entry || agora - entry.startedAt > windowMs) {
      windows.set(key, { startedAt: agora, count: 1 });

      if (windows.size > RATE_LIMIT_MAX_KEYS) {
        for (const [mapKey, value] of windows) {
          if (agora - value.startedAt > windowMs) windows.delete(mapKey);
        }
        // Teto rígido: sob enxurrada de chaves novas, as mais antigas saem antes de a memória crescer.
        for (const mapKey of windows.keys()) {
          if (windows.size <= RATE_LIMIT_MAX_KEYS) break;
          if (mapKey !== key) windows.delete(mapKey);
        }
      }

      return true;
    }

    entry.count += 1;
    return entry.count <= max;
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Supabase (PostgREST). A chave service_role só existe aqui.                                  */
/* ------------------------------------------------------------------------------------------ */

function supabaseEnabled(config) {
  return Boolean(config.supabaseUrl && config.supabaseKey);
}

async function supabaseRequest(config, restPath, { method = "GET", body, headers = {} } = {}) {
  const url = new URL(`/rest/v1/${restPath}`, config.supabaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);

  try {
    const response = await config.fetchImpl(url, {
      method,
      headers: {
        apikey: config.supabaseKey,
        Authorization: `Bearer ${config.supabaseKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });

    // Só o status vai para o erro (e dali para o log): o corpo de erro do PostgREST pode citar
    // valores da linha, e dado pessoal não entra em log.
    if (!response.ok) throw new Error(`supabase_${response.status}`);
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function callRpc(config, name, args) {
  return await supabaseRequest(config, `rpc/${name}`, { method: "POST", body: args });
}

// A função devolve um objeto. Qualquer outra coisa é banco fora do esperado, e é melhor dizer
// isso (502) do que desenhar um painel de zeros.
async function readObjectResponse(supabaseResponse) {
  const data = await supabaseResponse.json();
  if (!isPlainObject(data)) throw new Error("supabase_unexpected_shape");
  return data;
}

function totalFromContentRange(supabaseResponse, fallback) {
  const range = String(supabaseResponse.headers.get("content-range") || "");
  const total = Number.parseInt(range.split("/")[1], 10);
  return Number.isFinite(total) ? total : fallback;
}

/* ------------------------------------------------------------------------------------------ */
/* Webhook (n8n)                                                                               */
/* ------------------------------------------------------------------------------------------ */

async function forwardToWebhook({ payload, webhookUrl, fetchImpl }) {
  let endpoint;
  try {
    endpoint = new URL(webhookUrl);
  } catch {
    throw new Error("invalid_webhook_configuration");
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("invalid_webhook_configuration");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  // Um aviso pendurado não segura o processo no desligamento (deploy): a gravação já terminou.
  timeout.unref?.();

  try {
    const webhookResponse = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "ev-pesquisa/1.0"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!webhookResponse.ok) throw new Error(`webhook_${webhookResponse.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Verificação do domínio do e-mail                                                            */
/* ------------------------------------------------------------------------------------------ */

const DNS_AUSENTE = new Set(["ENODATA", "ENOTFOUND"]);

/**
 * "ok" | "missing" | "unknown". Só "missing" bloqueia, e só quando o DNS disse com todas as
 * letras que o domínio não tem para onde entregar e-mail. Timeout, DNS fora do ar, qualquer
 * dúvida: "unknown", e a pessoa segue — perder uma resposta por causa de DNS lento é pior do que
 * aceitar um e-mail que talvez não exista.
 */
export function createDnsEmailDomainResolver({ timeoutMs = DNS_TIMEOUT_MS } = {}) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });

  async function consultar(fn) {
    try {
      const registros = await fn();
      return Array.isArray(registros) && registros.length ? "ok" : "missing";
    } catch (error) {
      return DNS_AUSENTE.has(error?.code) ? "missing" : "unknown";
    }
  }

  async function verificar(domain) {
    try {
      const mx = await resolver.resolveMx(domain);
      if (Array.isArray(mx) && mx.length) {
        // "Null MX" (RFC 7505, um único registro apontando para "."): o domínio declara que não
        // recebe e-mail.
        return mx.every((registro) => !registro.exchange || registro.exchange === ".") ? "missing" : "ok";
      }
    } catch (error) {
      if (!DNS_AUSENTE.has(error?.code)) return "unknown";
    }

    // Sem MX, o e-mail ainda é entregue no próprio endereço do domínio (A/AAAA).
    const [v4, v6] = await Promise.all([
      consultar(() => resolver.resolve4(domain)),
      consultar(() => resolver.resolve6(domain))
    ]);
    if (v4 === "ok" || v6 === "ok") return "ok";
    if (v4 === "unknown" || v6 === "unknown") return "unknown";
    return "missing";
  }

  return async (domain) => {
    let timer;
    const limite = new Promise((resolve) => {
      timer = setTimeout(() => resolve("unknown"), timeoutMs);
    });
    try {
      return await Promise.race([verificar(domain), limite]);
    } finally {
      clearTimeout(timer);
      // Uma consulta que estourou o tempo não pode ficar pendurada segurando o socket.
      resolver.cancel();
    }
  };
}

// Cache por domínio: o mesmo "gmail.com" do vizinho não precisa de DNS de novo. "unknown" não
// entra no cache — era um problema passageiro, a próxima pessoa merece uma consulta nova.
function createCachedDomainChecker(resolveEmailDomain, now) {
  const cache = new Map();

  return async (domain) => {
    if (!domain) return "unknown";
    if (DOMINIOS_CONHECIDOS.has(domain)) return "ok";

    const agora = now();
    const guardado = cache.get(domain);
    if (guardado && guardado.expira > agora) return guardado.resultado;
    if (guardado) cache.delete(domain);

    let resultado;
    try {
      resultado = await resolveEmailDomain(domain);
    } catch {
      resultado = "unknown";
    }
    if (resultado !== "ok" && resultado !== "missing") return "unknown";

    cache.set(domain, { resultado, expira: agora + DNS_CACHE_TTL_MS });
    // Map guarda ordem de inserção: os primeiros são os mais antigos.
    for (const chave of cache.keys()) {
      if (cache.size <= DNS_CACHE_MAX) break;
      cache.delete(chave);
    }
    return resultado;
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Pesquisa: evento e gravação progressiva                                                     */
/* ------------------------------------------------------------------------------------------ */

function normalizarRastreio(fonte) {
  const r = isPlainObject(fonte) ? fonte : {};
  return {
    page_url: nullableString(r.page_url, 2_048),
    referrer: nullableString(r.referrer, 2_048),
    dispositivo: DISPOSITIVOS.has(r.dispositivo) ? r.dispositivo : null,
    utm_source: nullableString(r.utm_source, 500),
    utm_medium: nullableString(r.utm_medium, 500),
    utm_campaign: nullableString(r.utm_campaign, 500),
    utm_content: nullableString(r.utm_content, 500),
    utm_term: nullableString(r.utm_term, 500),
    fbclid: nullableString(r.fbclid, 1_000),
    gclid: nullableString(r.gclid, 1_000)
  };
}

function normalizarUuid(valor) {
  return typeof valor === "string" && UUID_PATTERN.test(valor) ? valor.toLowerCase() : null;
}

/**
 * Valida o contato com as MESMAS regras da tela. Devolve { contato } ou { campos } com as
 * mensagens prontas, para a tela mostrar no campo certo. `opcoes.somenteComBr` é a régua de e-mail
 * de uma página de inscrição (js/checkout-config.js, emailSomenteComBr); a pesquisa não passa nada.
 */
export function validarContato(fonte, opcoes = {}) {
  const c = isPlainObject(fonte) ? fonte : {};
  const campos = {};

  const nome = leadRules.normalizeName(typeof c.nome === "string" ? c.nome : "");
  // Um nome de 150 letras não é nome: é colagem errada, e a coluna não precisa guardar isso.
  let erroNome = nome.length > 150 ? "invalid" : leadRules.nameError(nome);
  // `nomeSimples`: aceita nome sem sobrenome. Vale só para integração de fora (ManyChat), onde a
  // pessoa não vê o erro nem tem como corrigir — o resto do projeto continua exigindo o sobrenome.
  if (erroNome === "surname" && opcoes && opcoes.nomeSimples === true) erroNome = "";
  if (erroNome) campos.nome = leadRules.message("name", erroNome);

  const whatsappBruto = typeof c.whatsapp === "string" ? c.whatsapp.slice(0, 40) : "";
  const whatsapp = leadRules.formatPhone(whatsappBruto);
  // phoneError sobre o valor cru: formatPhone corta no 11º dígito, e um número com dígito a
  // mais passaria como válido depois de formatado.
  const erroWhatsapp =
    leadRules.phoneError(whatsappBruto) || (FORMATTED_PHONE_PATTERN.test(whatsapp) ? "" : "incomplete");
  if (erroWhatsapp) campos.whatsapp = leadRules.message("phone", erroWhatsapp);

  const email = leadRules.normalizeEmail(typeof c.email === "string" ? c.email : "");
  const erroEmail = leadRules.emailError(email, { somenteComBr: Boolean(opcoes && opcoes.somenteComBr === true) });
  if (erroEmail) campos.email = leadRules.message("email", erroEmail);

  if (Object.keys(campos).length) return { campos };
  const digits = whatsapp.replace(/\D/g, "");
  // "maria da silva" e "MARIA DA SILVA" vão para o banco, o painel, o CSV e o n8n como
  // "Maria da Silva": a equipe copia o nome direto para a mensagem de WhatsApp.
  return { contato: { nome: leadRules.formatName(nome), whatsapp, whatsapp_digits: digits, email } };
}

function normalizarTempos(fonte) {
  const tempos = {};
  if (!isPlainObject(fonte)) return tempos;
  for (const chave of Object.keys(fonte)) {
    if (!CHAVES_TEMPO.has(chave)) continue;
    const bruto = fonte[chave];
    if (typeof bruto !== "number" || !Number.isFinite(bruto)) continue;
    const segundos = Math.round(bruto);
    if (segundos >= 0 && segundos <= TEMPO_MAX_SEGUNDOS) tempos[chave] = segundos;
  }
  return tempos;
}

function maiorEtapaVisivel(respostas) {
  return pesquisa.perguntasVisiveis(respostas).reduce((maior, pergunta) => Math.max(maior, pergunta.etapa), 0);
}

function descreverPosicao(id, respostas) {
  if (id === "fim") return { posicao: POSICAO_FIM, pergunta: "fim", etapa: maiorEtapaVisivel(respostas) };
  const pergunta = pesquisa.perguntaPorId(id);
  return { posicao: INDICE_PERGUNTA.get(id), pergunta: id, etapa: pergunta.etapa };
}

/**
 * Onde a pessoa está (pergunta_atual) e até onde ela chegou (posição). A posição é a MAIOR entre
 * a tela atual e a última pergunta respondida: quem volta para corrigir a pergunta 3 depois de
 * responder a 20 continua contando como "chegou à 20" no funil.
 */
export function calcularPosicao(respostas, perguntaAtualPedida, progresso) {
  const visiveis = pesquisa.perguntasVisiveis(respostas);
  const idsVisiveis = new Set(visiveis.map((pergunta) => pergunta.id));

  let perguntaAtual;
  if (perguntaAtualPedida === "fim" && progresso.completa) perguntaAtual = "fim";
  else if (typeof perguntaAtualPedida === "string" && idsVisiveis.has(perguntaAtualPedida)) perguntaAtual = perguntaAtualPedida;
  else perguntaAtual = pesquisa.primeiraPendente(respostas)?.id || "fim";

  const atual = descreverPosicao(perguntaAtual, respostas);

  let ultimaRespondida = null;
  for (const pergunta of visiveis) {
    if (pesquisa.perguntaRespondida(pergunta, respostas)) ultimaRespondida = pergunta.id;
  }
  const respondida = ultimaRespondida ? descreverPosicao(ultimaRespondida, respostas) : null;
  const maior = respondida && respondida.posicao > atual.posicao ? respondida : atual;

  return {
    pergunta_atual: perguntaAtual,
    etapa_atual: atual.etapa,
    posicao: maior.posicao,
    pergunta_posicao: maior.pergunta,
    etapa_posicao: maior.etapa
  };
}

function valorComOutro(pergunta, respostas, valor) {
  const complemento = pergunta.outro ? respostas[pesquisa.chaveOutro(pergunta)] : undefined;
  return valor === pergunta.outro && complemento ? `${pergunta.outro}: ${complemento}` : valor;
}

function textoDaFrase(pergunta, desejo, bloqueio) {
  const [parteDesejo, parteBloqueio] = pergunta.partes;
  if (desejo && bloqueio) return `${parteDesejo.antes} ${desejo}, ${parteBloqueio.antes} ${bloqueio}`;
  if (desejo) return `${parteDesejo.antes} ${desejo}`;
  if (bloqueio) return `${parteBloqueio.antes} ${bloqueio}`;
  return "";
}

/**
 * Cada pergunta do CAMINHO da pessoa (as condicionais de outro perfil não entram), na ordem do
 * questionário, com o valor cru e o texto legível. Opcional não respondida entra com resposta
 * null e texto "" — quem lê no n8n vê que ela pulou, em vez de achar que a pergunta não existe.
 */
export function perguntasDoCaminho(respostas) {
  // Array.from: o array vem do contexto do vm, e o .map dele criaria um array daquele "realm".
  return Array.from(pesquisa.perguntasVisiveis(respostas)).map((pergunta) => {
    const etapa = pesquisa.etapaPorNumero(pergunta.etapa);
    let resposta = null;
    let respostaTexto = "";
    // `outro` fica no payload (sempre null hoje: por decisão do cliente nenhuma pergunta tem
    // "Outro") para o contrato com o n8n não mudar se uma pergunta voltar a ter complemento.
    let outro = null;

    if (pergunta.tipo === "frase") {
      const [desejo, bloqueio] = pergunta.partes.map((parte) => (typeof respostas[parte.id] === "string" ? respostas[parte.id] : null));
      if (desejo || bloqueio) resposta = { desejo, bloqueio };
      respostaTexto = textoDaFrase(pergunta, desejo, bloqueio);
    } else {
      const valor = respostas[pergunta.id];
      if (pergunta.outro && typeof respostas[pesquisa.chaveOutro(pergunta)] === "string" && pesquisa.outroMarcado(pergunta, respostas)) {
        outro = respostas[pesquisa.chaveOutro(pergunta)];
      }
      if (Array.isArray(valor)) {
        resposta = valor.slice();
        respostaTexto = valor.map((item) => valorComOutro(pergunta, respostas, item)).join(", ");
      } else if (typeof valor === "number") {
        resposta = valor;
        respostaTexto = pergunta.tipo === "escala" ? `${valor}/${pergunta.max}` : String(valor);
      } else if (typeof valor === "string") {
        resposta = valor;
        respostaTexto = valorComOutro(pergunta, respostas, valor);
      }
    }

    return {
      numero: pergunta.numero,
      id: pergunta.id,
      etapa: pergunta.etapa,
      etapa_titulo: etapa ? etapa.titulo : "",
      pergunta: pergunta.texto,
      tipo: pergunta.tipo,
      obrigatoria: pergunta.obrigatoria === true,
      resposta,
      resposta_texto: respostaTexto,
      outro
    };
  });
}

/** As respostas em texto corrido (só as respondidas), na ordem da pesquisa. */
export function respostasLegiveis(respostas) {
  return perguntasDoCaminho(respostas)
    .filter((item) => item.resposta_texto)
    .map((item) => ({ numero: item.numero, pergunta: item.pergunta, resposta: item.resposta_texto }));
}

function textoOuNull(valor) {
  return typeof valor === "string" && valor.trim() ? valor : null;
}

function isoOuNull(valor) {
  if (!valor) return null;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data.toISOString();
}

/**
 * O aviso de pesquisa concluída (SPEC seção 10). Datas, rastreio e respostas vêm da LINHA
 * gravada (primeiro toque, relógio do banco); o que foi calculado nesta requisição só entra se a
 * linha faltar algum campo.
 */
export function montarPayloadWebhook({ linha, id, contato, respostas, rastreio, agora }) {
  const l = isPlainObject(linha) ? linha : {};
  const resp = isPlainObject(l.respostas) ? l.respostas : respostas;
  const campo = (nome) => textoOuNull(l[nome]) ?? textoOuNull(rastreio?.[nome]);
  const digits = textoOuNull(l.whatsapp_digits) ?? contato.whatsapp_digits;
  const nome = textoOuNull(l.nome) ?? contato.nome;
  const perfil = typeof resp.perfil === "string" ? resp.perfil : null;

  return {
    evento: "pesquisa_concluida",
    pesquisa: { id: textoOuNull(l.pesquisa) ?? pesquisa.ID, versao: textoOuNull(l.pesquisa_versao) ?? pesquisa.VERSAO },
    sessao_id: textoOuNull(l.id) ?? id,
    iniciada_em: isoOuNull(l.criado_em),
    concluida_em: isoOuNull(l.finalizado_em) ?? isoOuNull(l.concluido_em) ?? new Date(agora).toISOString(),
    tempo_total_segundos: Number.isFinite(l.tempo_total_segundos) ? l.tempo_total_segundos : null,
    lead: {
      nome,
      primeiro_nome: pesquisa.primeiroNome(nome),
      whatsapp: textoOuNull(l.whatsapp) ?? contato.whatsapp,
      whatsapp_digits: digits,
      whatsapp_internacional: textoOuNull(l.whatsapp_internacional) ?? `55${digits}`,
      email: textoOuNull(l.email) ?? contato.email
    },
    perfil,
    // Valor interno e etiqueta de CRM do perfil (Técnico e Enfermeiro seguem separados), e a
    // página de obrigado para onde a pessoa foi levada.
    perfil_codigo: valorDoPerfil(pesquisa.PERFIL_CODIGO, perfil),
    segmento: valorDoPerfil(pesquisa.PERFIL_SEGMENTO, perfil),
    pagina_obrigado: paginaObrigadoDoPerfil(perfil),
    utm: {
      utm_source: campo("utm_source"),
      utm_medium: campo("utm_medium"),
      utm_campaign: campo("utm_campaign"),
      utm_content: campo("utm_content"),
      utm_term: campo("utm_term")
    },
    rastreio: {
      fbclid: campo("fbclid"),
      gclid: campo("gclid"),
      page_url: campo("page_url"),
      referrer: campo("referrer"),
      dispositivo: campo("dispositivo")
    },
    respostas: resp,
    perguntas: perguntasDoCaminho(resp),
    enviado_em: new Date(agora).toISOString()
  };
}

/**
 * O aviso de perfil atualizado. É o gatilho da sequência no WhatsApp: leva o contato formatado e a
 * profissão nos três formatos (rótulo da tela, código interno e etiqueta de CRM), com as UTMs.
 * Não leva respostas de pesquisa porque esta página não tem nenhuma — só contato e profissão.
 */
export function montarPayloadPerfil({ linha, id, contato, perfil, rastreio, agora }) {
  const l = isPlainObject(linha) ? linha : {};
  const campo = (nome) => textoOuNull(l[nome]) ?? textoOuNull(rastreio?.[nome]);
  const digits = textoOuNull(l.whatsapp_digits) ?? textoOuNull(contato?.whatsapp_digits);
  const nome = textoOuNull(l.nome) ?? textoOuNull(contato?.nome);
  const escolhido = textoOuNull(l.perfil) ?? (typeof perfil === "string" ? perfil : null);

  return {
    evento: "perfil_atualizado",
    origem: PESQUISA_ATUALIZACAO,
    lead_id: textoOuNull(l.id) ?? textoOuNull(id),
    atualizado_em: isoOuNull(l.finalizado_em) ?? isoOuNull(l.concluido_em) ?? new Date(agora).toISOString(),
    lead: {
      nome,
      primeiro_nome: nome ? pesquisa.primeiroNome(nome) : null,
      whatsapp: textoOuNull(l.whatsapp) ?? textoOuNull(contato?.whatsapp),
      whatsapp_digits: digits,
      whatsapp_internacional: textoOuNull(l.whatsapp_internacional) ?? (digits ? `55${digits}` : null),
      email: textoOuNull(l.email) ?? textoOuNull(contato?.email)
    },
    perfil: escolhido,
    perfil_codigo: valorDoPerfil(pesquisa.PERFIL_CODIGO, escolhido),
    segmento: valorDoPerfil(pesquisa.PERFIL_SEGMENTO, escolhido),
    pagina_obrigado: paginaObrigadoDoPerfil(escolhido),
    utm: {
      utm_source: campo("utm_source"),
      utm_medium: campo("utm_medium"),
      utm_campaign: campo("utm_campaign"),
      utm_content: campo("utm_content"),
      utm_term: campo("utm_term")
    },
    rastreio: {
      fbclid: campo("fbclid"),
      gclid: campo("gclid"),
      page_url: campo("page_url"),
      referrer: campo("referrer"),
      dispositivo: campo("dispositivo")
    },
    enviado_em: new Date(agora).toISOString()
  };
}

function esperar(ms) {
  return new Promise((resolve) => {
    // unref: uma espera entre tentativas não segura o processo num deploy.
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Sem await de quem chama: o aviso ao n8n nunca atrasa nem derruba a gravação. Até três
 * tentativas; com 2xx, marca webhook_enviado_em na linha. Falha final só vai para o log, sem dado
 * pessoal.
 */
async function avisarWebhook(options, dados) {
  const payload = montarPayloadWebhook({ ...dados, agora: options.now() });
  const esperas = options.webhookEsperasMs;

  for (let tentativa = 0; tentativa < esperas.length; tentativa += 1) {
    if (esperas[tentativa] > 0) await esperar(esperas[tentativa]);
    try {
      await forwardToWebhook({ payload, webhookUrl: options.webhookUrl, fetchImpl: options.fetchImpl });
    } catch (error) {
      console.error(`Falha ao avisar o webhook (tentativa ${tentativa + 1} de ${esperas.length}): ${error?.message || "erro"}`);
      continue;
    }

    await marcarEnviado(options, dados.id);
    return true;
  }
  return false;
}

/**
 * Esta PESSOA já recebeu o aviso alguma vez? A garantia é por telefone, não por linha: a mesma
 * pessoa preenchendo de novo (outro aparelho, outro navegador, link aberto duas vezes) cria outra
 * tentativa no banco, e sem isto ela receberia a sequência duas vezes no WhatsApp.
 *
 * Na dúvida (banco fora), responde `false`: um aviso repetido incomoda menos do que a pessoa ficar
 * sem a sequência.
 */
async function perfilJaAvisado(options, linha) {
  const digits = textoOuNull(linha?.whatsapp_digits);
  const id = textoOuNull(linha?.id);
  if (!digits) return false;
  const consulta = [
    "select=id",
    `pesquisa=eq.${encodeURIComponent(PESQUISA_ATUALIZACAO)}`,
    `whatsapp_digits=eq.${encodeURIComponent(digits)}`,
    "webhook_enviado_em=not.is.null",
    ...(id ? [`id=neq.${encodeURIComponent(id)}`] : []),
    "limit=1"
  ].join("&");
  try {
    const linhas = await (await supabaseRequest(options, `pesquisa_respostas?${consulta}`)).json();
    return Array.isArray(linhas) && linhas.length > 0;
  } catch (error) {
    console.error(`Aviso do perfil: falha ao conferir se a pessoa já foi avisada: ${error?.message || "erro"}`);
    return false;
  }
}

/**
 * Sem await de quem chama: a pessoa vai para a página de obrigado na hora e o aviso segue sozinho.
 * Mesmas três tentativas do aviso da pesquisa; com 2xx marca webhook_enviado_em na linha, e o que
 * não chegar a varredura reenvia.
 */
async function avisarPerfil(options, dados) {
  // Mesma pessoa já avisada: nada sai, e esta linha fica marcada para a varredura não tentar
  // de novo amanhã.
  if (await perfilJaAvisado(options, { whatsapp_digits: dados.linha?.whatsapp_digits ?? dados.contato?.whatsapp_digits, id: dados.id })) {
    await marcarEnviado(options, dados.id);
    return false;
  }
  const payload = montarPayloadPerfil({ ...dados, agora: options.now() });
  const esperas = options.webhookEsperasMs;

  for (let tentativa = 0; tentativa < esperas.length; tentativa += 1) {
    if (esperas[tentativa] > 0) await esperar(esperas[tentativa]);
    try {
      await forwardToWebhook({ payload, webhookUrl: options.perfilWebhookUrl, fetchImpl: options.fetchImpl });
    } catch (error) {
      console.error(`Falha ao avisar o webhook do perfil (tentativa ${tentativa + 1} de ${esperas.length}): ${error?.message || "erro"}`);
      continue;
    }
    await marcarEnviado(options, dados.id);
    return true;
  }
  return false;
}

async function marcarEnviado(options, id) {
  try {
    await supabaseRequest(options, `pesquisa_respostas?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { webhook_enviado_em: new Date(options.now()).toISOString() },
      headers: { Prefer: "return=minimal" }
    });
  } catch (error) {
    console.error(`Aviso entregue, mas falhou ao marcar webhook_enviado_em: ${error?.message || "erro"}`);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Aviso de inscrição ao n8n (páginas com webhook: a Imersão GPS)                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * O aviso de inscrição nova. Sai da LINHA gravada em inscricoes (ou do mesmo conteúdo, montado na
 * hora da gravação): contato formatado, UTMs de primeiro toque, o sck que foi para a Hotmart e o
 * link do checkout que a pessoa abriu.
 */
export function montarPayloadInscricao({ linha, agora }) {
  const l = isPlainObject(linha) ? linha : {};
  const pagina = checkout.paginaPorId(l.pagina);
  const digits = textoOuNull(l.whatsapp_digits);
  const nome = textoOuNull(l.nome);
  const campoSck = checkout.sckDaPagina(pagina);
  let sck = null;
  try {
    sck = textoOuNull(new URL(String(l.checkout_url || "")).searchParams.get("sck"));
  } catch {
    // Sem link gravado: fica a UTM que a página manda como sck.
  }
  return {
    evento: "inscricao",
    pagina: pagina
      ? {
          id: pagina.id,
          nome: pagina.nome,
          produto: pagina.produto,
          rota: pagina.rota,
          url: pagina.origem ? `${pagina.origem}${pagina.rota}` : pagina.rota
        }
      : { id: textoOuNull(l.pagina) },
    inscricao_id: textoOuNull(l.id),
    inscrito_em: isoOuNull(l.criado_em) ?? new Date(agora).toISOString(),
    lead: {
      nome,
      primeiro_nome: nome ? pesquisa.primeiroNome(nome) : null,
      whatsapp: textoOuNull(l.whatsapp),
      whatsapp_digits: digits,
      whatsapp_internacional: digits ? `55${digits}` : null,
      email: textoOuNull(l.email)
    },
    utm: {
      utm_source: textoOuNull(l.utm_source),
      utm_medium: textoOuNull(l.utm_medium),
      utm_campaign: textoOuNull(l.utm_campaign),
      utm_content: textoOuNull(l.utm_content),
      utm_term: textoOuNull(l.utm_term)
    },
    sck: sck ?? textoOuNull(l[campoSck]),
    rastreio: {
      fbclid: textoOuNull(l.fbclid),
      gclid: textoOuNull(l.gclid),
      page_url: textoOuNull(l.page_url),
      referrer: textoOuNull(l.referrer),
      dispositivo: textoOuNull(l.dispositivo)
    },
    checkout_url: textoOuNull(l.checkout_url),
    enviado_em: new Date(agora).toISOString()
  };
}

async function marcarInscricaoEnviada(options, id) {
  try {
    await supabaseRequest(options, `inscricoes?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { webhook_enviado_em: new Date(options.now()).toISOString() },
      headers: { Prefer: "return=minimal" }
    });
  } catch (error) {
    console.error(`Aviso de inscrição entregue, mas falhou ao marcar webhook_enviado_em: ${error?.message || "erro"}`);
  }
}

/**
 * Sem await de quem chama: o aviso nunca atrasa a ida ao checkout. As mesmas três tentativas do
 * aviso da pesquisa; com 2xx marca webhook_enviado_em. O que não chegar, a varredura reenvia.
 */
async function avisarInscricao(options, linha) {
  const webhookUrl = options.webhooksInscricao[linha.pagina];
  if (!webhookUrl) return false;
  const payload = montarPayloadInscricao({ linha, agora: options.now() });
  const esperas = options.webhookEsperasMs;
  for (let tentativa = 0; tentativa < esperas.length; tentativa += 1) {
    if (esperas[tentativa] > 0) await esperar(esperas[tentativa]);
    try {
      await forwardToWebhook({ payload, webhookUrl, fetchImpl: options.fetchImpl });
    } catch (error) {
      console.error(`Falha ao avisar o webhook da inscrição (tentativa ${tentativa + 1} de ${esperas.length}): ${error?.message || "erro"}`);
      continue;
    }
    await marcarInscricaoEnviada(options, linha.id);
    return true;
  }
  return false;
}

/**
 * Varredura das inscrições das páginas com webhook que ficaram sem webhook_enviado_em (n8n fora nas
 * três tentativas, servidor reiniciado no meio): mesma janela e mesmo ritmo da varredura da
 * pesquisa (de 7 dias a 2 minutos atrás, 25 por vez, 30 s depois de subir e a cada 10 min).
 */
function criarReenvioInscricoes(options, { atrasoInicialMs = REENVIO_ATRASO_INICIAL_MS, intervaloMs = REENVIO_INTERVALO_MS } = {}) {
  let emCurso = null;
  let parado = false;
  let inicial = null;
  let periodico = null;

  async function varrer() {
    const paginas = Object.keys(options.webhooksInscricao);
    if (!paginas.length) return { pendentes: 0, entregues: 0 };
    const agora = options.now();
    const consulta = [
      "select=*",
      `pagina=in.(${paginas.map(encodeURIComponent).join(",")})`,
      "webhook_enviado_em=is.null",
      `criado_em=gte.${new Date(agora - REENVIO_JANELA_MAX_MS).toISOString()}`,
      `criado_em=lte.${new Date(agora - REENVIO_JANELA_MIN_MS).toISOString()}`,
      "order=criado_em.asc",
      `limit=${REENVIO_LIMITE}`
    ].join("&");

    let linhas;
    try {
      linhas = await (await supabaseRequest(options, `inscricoes?${consulta}`)).json();
    } catch (error) {
      console.error(`Reenvio de inscrições ao n8n: falha ao buscar pendentes: ${error?.message || "erro"}`);
      return { pendentes: 0, entregues: 0 };
    }
    if (!Array.isArray(linhas)) return { pendentes: 0, entregues: 0 };

    let entregues = 0;
    for (const linha of linhas) {
      if (parado) break;
      if (!isPlainObject(linha) || !linha.id || !options.webhooksInscricao[linha.pagina]) continue;
      try {
        await forwardToWebhook({
          payload: montarPayloadInscricao({ linha, agora: options.now() }),
          webhookUrl: options.webhooksInscricao[linha.pagina],
          fetchImpl: options.fetchImpl
        });
      } catch (error) {
        console.error(`Reenvio de inscrições ao n8n: falha ao entregar: ${error?.message || "erro"}`);
        continue;
      }
      await marcarInscricaoEnviada(options, linha.id);
      entregues += 1;
    }
    if (linhas.length) console.log(`Reenvio de inscrições ao n8n: ${entregues} de ${linhas.length} pendente(s) entregue(s).`);
    return { pendentes: linhas.length, entregues };
  }

  function executar() {
    if (parado) return Promise.resolve({ pendentes: 0, entregues: 0 });
    if (emCurso) return emCurso;
    emCurso = varrer()
      .catch((error) => {
        console.error(`Reenvio de inscrições ao n8n: falha inesperada: ${error?.message || "erro"}`);
        return { pendentes: 0, entregues: 0 };
      })
      .finally(() => {
        emCurso = null;
      });
    return emCurso;
  }

  function iniciar() {
    if (parado || inicial || periodico) return;
    inicial = setTimeout(() => {
      inicial = null;
      if (parado) return;
      executar();
      periodico = setInterval(executar, intervaloMs);
      periodico.unref?.();
    }, atrasoInicialMs);
    inicial.unref?.();
  }

  function parar() {
    parado = true;
    clearTimeout(inicial);
    clearInterval(periodico);
    inicial = null;
    periodico = null;
  }

  return { executar, iniciar, parar, emCurso: () => emCurso };
}

/* ------------------------------------------------------------------------------------------ */
/* Reenvio automático ao n8n                                                                   */
/* ------------------------------------------------------------------------------------------ */

// 30 s depois de subir e depois a cada 10 min. Só olha tentativas finalizadas entre 7 dias e
// 2 minutos atrás: os 2 minutos deixam as três tentativas imediatas (0, 3 s, 10 s, cada uma com
// até 10 s de timeout) terminarem antes, para as duas não mandarem o mesmo aviso.
const REENVIO_ATRASO_INICIAL_MS = 30_000;
const REENVIO_INTERVALO_MS = 10 * 60_000;
const REENVIO_JANELA_MAX_MS = 7 * 24 * 60 * 60_000;
const REENVIO_JANELA_MIN_MS = 2 * 60_000;
const REENVIO_LIMITE = 25;
// Concluída (tudo o obrigatório respondido) sem chegar à tela de fim: espera 30 min parada antes
// de mandar, para não atropelar quem ainda está escrevendo as abertas opcionais.
const REENVIO_ABANDONO_MS = 30 * 60_000;

/** A mesma montagem do aviso normal, a partir só da linha gravada (rastreio de primeiro toque). */
function payloadDaLinha(linha, agora) {
  const contato = {
    nome: linha.nome ?? null,
    whatsapp: linha.whatsapp ?? null,
    whatsapp_digits: linha.whatsapp_digits ?? null,
    email: linha.email ?? null
  };
  const respostas = isPlainObject(linha.respostas) ? linha.respostas : {};
  return montarPayloadWebhook({ linha, id: linha.id, contato, respostas, rastreio: {}, agora });
}

function payloadPerfilDaLinha(linha, agora) {
  return montarPayloadPerfil({ linha, id: linha.id, contato: null, perfil: linha.perfil, rastreio: {}, agora });
}

/** Para onde vai a linha pendente e o que sai nela: as duas pesquisas usam a mesma varredura. */
function destinoDaLinha(options, linha, agora) {
  return linha.pesquisa === PESQUISA_ATUALIZACAO
    ? { webhookUrl: options.perfilWebhookUrl, payload: payloadPerfilDaLinha(linha, agora) }
    : { webhookUrl: options.webhookUrl, payload: payloadDaLinha(linha, agora) };
}

/**
 * Varredura que reenvia ao n8n as tentativas finalizadas que ficaram sem webhook_enviado_em (n8n
 * fora nas três tentativas, ou servidor reiniciado no meio). Uma tentativa por linha; em 2xx marca
 * a linha. Nunca roda duas ao mesmo tempo. Falha vai só para o log, sem dado pessoal.
 */
function criarReenvio(options, { atrasoInicialMs = REENVIO_ATRASO_INICIAL_MS, intervaloMs = REENVIO_INTERVALO_MS } = {}) {
  let emCurso = null;
  let parado = false;
  let inicial = null;
  let periodico = null;

  async function varrer() {
    const agora = options.now();
    const desde = new Date(agora - REENVIO_JANELA_MAX_MS).toISOString();
    const ate = new Date(agora - REENVIO_JANELA_MIN_MS).toISOString();
    const parada = new Date(agora - REENVIO_ABANDONO_MS).toISOString();
    // Dois casos: (a) chegou à tela de fim e o aviso não saiu; (b) respondeu tudo o que é
    // obrigatório (status concluida) mas fechou antes da tela de fim — por exemplo, na pergunta
    // aberta opcional — e está parada há 30 min. O painel conta (b) como concluída, então o n8n
    // também precisa recebê-la.
    const filtro =
      `(and(finalizado_em.gte.${desde},finalizado_em.lte.${ate}),` +
      `and(finalizado_em.is.null,status.eq.concluida,concluido_em.gte.${desde},atualizado_em.lte.${parada}))`;
    // Só as pesquisas que TÊM para onde avisar: com o webhook desligado, a linha não fica sendo
    // relida para sempre.
    const pesquisas = [options.webhookUrl ? pesquisa.ID : "", options.perfilWebhookUrl ? PESQUISA_ATUALIZACAO : ""].filter(Boolean);
    if (!pesquisas.length) return { pendentes: 0, entregues: 0 };
    const consulta = [
      "select=*",
      `pesquisa=in.(${pesquisas.map(encodeURIComponent).join(",")})`,
      "webhook_enviado_em=is.null",
      `or=${encodeURIComponent(filtro)}`,
      "order=criado_em.asc",
      `limit=${REENVIO_LIMITE}`
    ].join("&");

    let linhas;
    try {
      linhas = await (await supabaseRequest(options, `pesquisa_respostas?${consulta}`)).json();
    } catch (error) {
      console.error(`Reenvio ao n8n: falha ao buscar pendentes: ${error?.message || "erro"}`);
      return { pendentes: 0, entregues: 0 };
    }
    if (!Array.isArray(linhas)) return { pendentes: 0, entregues: 0 };

    let entregues = 0;
    for (const linha of linhas) {
      if (parado) break;
      if (!isPlainObject(linha) || !linha.id) continue;
      const { webhookUrl, payload } = destinoDaLinha(options, linha, options.now());
      if (!webhookUrl) continue;
      // A mesma pessoa pode ter preenchido duas vezes: só a primeira linha vira aviso.
      if (linha.pesquisa === PESQUISA_ATUALIZACAO && (await perfilJaAvisado(options, linha))) {
        await marcarEnviado(options, linha.id);
        continue;
      }
      try {
        await forwardToWebhook({ payload, webhookUrl, fetchImpl: options.fetchImpl });
      } catch (error) {
        console.error(`Reenvio ao n8n: falha ao entregar: ${error?.message || "erro"}`);
        continue;
      }
      await marcarEnviado(options, linha.id);
      entregues += 1;
    }
    if (linhas.length) console.log(`Reenvio ao n8n: ${entregues} de ${linhas.length} pendente(s) entregue(s).`);
    return { pendentes: linhas.length, entregues };
  }

  function executar() {
    if (parado) return Promise.resolve({ pendentes: 0, entregues: 0 });
    if (emCurso) return emCurso;
    emCurso = varrer()
      .catch((error) => {
        console.error(`Reenvio ao n8n: falha inesperada: ${error?.message || "erro"}`);
        return { pendentes: 0, entregues: 0 };
      })
      .finally(() => {
        emCurso = null;
      });
    return emCurso;
  }

  function iniciar() {
    if (parado || inicial || periodico) return;
    inicial = setTimeout(() => {
      inicial = null;
      if (parado) return;
      executar();
      periodico = setInterval(executar, intervaloMs);
      periodico.unref?.();
    }, atrasoInicialMs);
    inicial.unref?.();
  }

  function parar() {
    parado = true;
    clearTimeout(inicial);
    clearInterval(periodico);
    inicial = null;
    periodico = null;
  }

  return { executar, iniciar, parar, emCurso: () => emCurso };
}

async function handleEvento(request, response, options) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if (!acceptsJsonBody(request, response)) return;

  if (!options.allowEvento(request)) {
    sendJson(response, 429, { ok: false, error: "too_many_requests" });
    return;
  }

  const body = await readObjectBody(request, response);
  if (!body) return;

  const visitante = normalizarUuid(body.visitante_id);
  const evento = body.evento === "visita" || body.evento === "inicio" ? body.evento : null;
  if (!visitante || !evento) {
    sendJson(response, 422, { ok: false, error: "invalid_event" });
    return;
  }

  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  try {
    await callRpc(options, "pesquisa_registrar_evento", {
      p_visitante: visitante,
      p_evento: evento,
      p_dados: { pesquisa: pesquisa.ID, ...normalizarRastreio(body) }
    });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error(`Falha ao registrar evento: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
  }
}

/**
 * Visita e clique no grupo das páginas de obrigado. Sem dado pessoal: só a página, o evento, os
 * ids do aparelho e da tentativa, o perfil (para separar Técnico de Enfermeiro na página do evento)
 * e a origem. Página ou evento fora da lista → 422; o resto, se vier estranho, vira null.
 */
async function handlePaginaEvento(request, response, options) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if (!acceptsJsonBody(request, response)) return;

  if (!options.allowPaginaEvento(request)) {
    sendJson(response, 429, { ok: false, error: "too_many_requests" });
    return;
  }

  const body = await readObjectBody(request, response);
  if (!body) return;

  const pagina = typeof body.pagina === "string" && PAGINAS_OBRIGADO.has(body.pagina) ? body.pagina : null;
  const evento = typeof body.evento === "string" && EVENTOS_PAGINA.has(body.evento) ? body.evento : null;
  if (!pagina || !evento) {
    sendJson(response, 422, { ok: false, error: "invalid_event" });
    return;
  }

  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  try {
    await callRpc(options, "pagina_registrar_evento", {
      p: {
        pagina,
        evento,
        visitante_id: normalizarUuid(body.visitante_id),
        sessao_id: normalizarUuid(body.sessao_id),
        perfil: typeof body.perfil === "string" && PERFIS_VALIDOS.has(body.perfil) ? body.perfil : null,
        ...normalizarRastreio(body)
      }
    });
    sendJson(response, 200, { ok: true });
  } catch (error) {
    console.error(`Falha ao registrar evento da página de obrigado: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
  }
}

async function handleSalvar(request, response, options) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if (!acceptsJsonBody(request, response)) return;

  if (!options.allowSalvar(request)) {
    sendJson(response, 429, { ok: false, error: "too_many_requests" });
    return;
  }

  const body = await readObjectBody(request, response);
  if (!body) return;

  // 1. Sessão e ordem do salvamento.
  const id = normalizarUuid(body.id);
  if (!id) {
    sendJson(response, 422, { ok: false, error: "invalid_session" });
    return;
  }
  if (!Number.isInteger(body.seq) || body.seq < 0 || body.seq > SEQ_MAX) {
    sendJson(response, 422, { ok: false, error: "invalid_seq" });
    return;
  }

  // 2. Contato, com as regras da tela e depois o DNS do domínio.
  const validacao = validarContato(body.contato);
  if (validacao.campos) {
    sendJson(response, 422, { ok: false, error: "invalid_contact", campos: validacao.campos });
    return;
  }
  const { contato } = validacao;
  if ((await options.checkEmailDomain(leadRules.emailDomain(contato.email))) === "missing") {
    sendJson(response, 422, {
      ok: false,
      error: "invalid_contact",
      campos: { email: leadRules.MESSAGES.email.domain }
    });
    return;
  }

  // Validado antes de olhar o banco: sem Supabase a tela ainda recebe o erro de contato certo.
  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  // 3–6. Respostas, posição, tempos, rastreio — tudo recalculado aqui, nada confiado ao navegador.
  // JSON.parse(JSON.stringify()) traz para este "realm" os objetos criados dentro do vm.
  const respostas = JSON.parse(JSON.stringify(pesquisa.sanitizar(body.respostas)));
  const progresso = JSON.parse(JSON.stringify(pesquisa.progresso(respostas)));
  const posicao = calcularPosicao(respostas, body.pergunta_atual, progresso);
  const tempos = normalizarTempos(body.tempos);
  const rastreio = normalizarRastreio(body.rastreio);

  const p = {
    id,
    pesquisa: pesquisa.ID,
    pesquisa_versao: pesquisa.VERSAO,
    visitante_id: normalizarUuid(body.visitante_id),
    seq: body.seq,
    ...contato,
    perfil: typeof respostas.perfil === "string" ? respostas.perfil : null,
    respostas,
    pergunta_atual: posicao.pergunta_atual,
    etapa_atual: posicao.etapa_atual,
    posicao: posicao.posicao,
    pergunta_posicao: posicao.pergunta_posicao,
    etapa_posicao: posicao.etapa_posicao,
    respondidas: progresso.respondidas,
    obrigatorias: progresso.obrigatorias,
    obrigatorias_respondidas: progresso.obrigatoriasRespondidas,
    total_perguntas: progresso.total,
    progresso_percentual: progresso.percentual,
    completa: progresso.completa,
    // Chegou à tela de fim com tudo respondido: é o gatilho do aviso único ao n8n.
    finalizou: posicao.pergunta_atual === "fim" && progresso.completa,
    tempos,
    ...rastreio
  };

  // 7. Grava.
  let resultado;
  try {
    resultado = await readObjectResponse(await callRpc(options, "pesquisa_salvar", { p }));
  } catch (error) {
    console.error(`Falha ao salvar resposta: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
    return;
  }

  const novo = resultado.novo === true;
  const concluiuAgora = resultado.concluiu_agora === true;
  const finalizouAgora = resultado.finalizou_agora === true;
  const status = STATUS_VALIDOS.has(resultado.status) ? resultado.status : progresso.completa ? "concluida" : "em_andamento";

  // 8. Aviso ao n8n: UM por tentativa, só quando a pessoa chega ao fim (o banco decide, dentro da
  //    trava da linha, se esta é a primeira chegada). Sem await.
  //    Se a varredura já mandou esta tentativa (concluída e parada nas abertas; ela voltou depois),
  //    não manda de novo.
  const jaEnviada = isPlainObject(resultado.linha) && resultado.linha.webhook_enviado_em != null;
  if (options.webhookUrl && finalizouAgora && !jaEnviada) {
    avisarWebhook(options, { linha: resultado.linha, id, contato, respostas, rastreio }).catch((error) => {
      console.error(`Falha inesperada no aviso ao webhook: ${error?.message || "erro"}`);
    });
  }

  sendJson(response, 200, {
    ok: true,
    status,
    novo,
    aplicado: resultado.aplicado !== false,
    concluiu_agora: concluiuAgora,
    progresso
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Inscrição com checkout na Hotmart                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * POST /api/inscricao — o formulário das páginas de inscrição: /viver-de-furo-inscricao (daqui) e o
 * pré-formulário da venda da Imersão GPS (de outro site, por CORS; ver corsDaInscricao).
 *
 * Quem monta o link do checkout é o SERVIDOR (EVCheckout.montarUrlCheckout), e é essa URL que a
 * resposta devolve: o navegador não remonta nada, então uma UTM não se perde por causa de um
 * bloqueador nem um campo do contato chega diferente do que foi gravado. O contato passa pela
 * MESMA régua do /api/pesquisa/salvar, inclusive a checagem de domínio do e-mail.
 */
async function handleInscricao(request, response, options) {
  if (corsDaInscricao(request, response, options)) return;
  if (request.method !== "POST") return methodNotAllowed(response, "POST, OPTIONS");
  if (!aceitaCorpoDaInscricao(request, response, options)) return;

  if (!options.allowInscricao(request)) {
    sendJson(response, 429, { ok: false, error: "too_many_requests" });
    return;
  }

  const body = await readObjectBody(request, response);
  if (!body) return;

  // Contra a LISTA, e não pelo id cru: paginaPorId lê um objeto literal, e "toString" devolveria
  // uma função herdada.
  const pagina = PAGINAS_CHECKOUT.find((item) => item.id === body.pagina) || null;
  if (!pagina) {
    sendJson(response, 422, { ok: false, error: "invalid_page" });
    return;
  }

  const validacao = validarContato(body.contato, { somenteComBr: pagina.emailSomenteComBr === true });
  if (validacao.campos) {
    sendJson(response, 422, { ok: false, error: "invalid_contact", campos: validacao.campos });
    return;
  }
  const { contato } = validacao;
  if ((await options.checkEmailDomain(leadRules.emailDomain(contato.email))) === "missing") {
    sendJson(response, 422, { ok: false, error: "invalid_contact", campos: { email: leadRules.MESSAGES.email.domain } });
    return;
  }

  // Validado antes de olhar o banco: sem Supabase a tela ainda recebe o erro de contato certo.
  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  const rastreio = normalizarRastreio(body.rastreio);
  // `checkout` = o link do botão que a pessoa tocou. Só vale a oferta dele, e só se for do mesmo
  // produto do config (troca de lote sem mexer aqui); qualquer outra coisa usa o link do config.
  const checkoutUrl = checkout.urlDoCheckout(pagina, { base: body.checkout, utm: rastreio, contato });

  const gravada = {
    id: normalizarUuid(body.id),
    pagina: pagina.id,
    visitante_id: normalizarUuid(body.visitante_id),
    ...contato,
    checkout_url: checkoutUrl,
    ...rastreio
  };
  let salvo = null;
  try {
    const resposta = await callRpc(options, "inscricao_salvar", { p: gravada });
    salvo = await resposta.json().catch(() => null);
  } catch (error) {
    console.error(`Falha ao salvar inscrição: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
    return;
  }

  sendJson(response, 200, { ok: true, checkout: checkoutUrl });

  // Inscrição NOVA numa página com webhook (a Imersão GPS): o n8n recebe uma vez por pessoa. Quem
  // reenvia o formulário (voltou do checkout, mandou de novo) soma clique, não aviso. Depois da
  // resposta, e sem await: o checkout nunca espera o n8n.
  if (options.webhooksInscricao[pagina.id] && isPlainObject(salvo) && salvo.novo === true && normalizarUuid(salvo.id)) {
    avisarInscricao(options, { ...gravada, id: normalizarUuid(salvo.id), criado_em: new Date(options.now()).toISOString() }).catch((error) => {
      console.error(`Falha inesperada no aviso da inscrição: ${error?.message || "erro"}`);
    });
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Webhook de venda da Hotmart                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Comparação de segredo em tempo constante (o tamanho já é público pelo tempo de resposta). */
function segredoIgual(recebido, esperado) {
  const a = Buffer.from(String(recebido ?? ""), "utf8");
  const b = Buffer.from(String(esperado ?? ""), "utf8");
  if (!b.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Data da Hotmart: epoch em milissegundos (o normal), epoch em segundos ou texto ISO. Qualquer
 * outra coisa vira null — um campo de data estranho não pode derrubar o aviso.
 */
export function dataHotmart(valor) {
  if (typeof valor === "number" && Number.isFinite(valor)) {
    const data = new Date(valor > 1e11 ? valor : valor * 1_000);
    return Number.isNaN(data.getTime()) ? null : data.toISOString();
  }
  if (typeof valor === "string" && valor.trim()) {
    const texto = valor.trim();
    if (/^\d{10,16}$/.test(texto)) return dataHotmart(Number(texto));
    const data = new Date(texto);
    return Number.isNaN(data.getTime()) ? null : data.toISOString();
  }
  return null;
}

function numeroOuNull(valor) {
  const numero = typeof valor === "string" ? Number(valor.replace(",", ".")) : valor;
  return typeof numero === "number" && Number.isFinite(numero) ? numero : null;
}

function texto(valor, tamanho = 500) {
  if (typeof valor === "number" && Number.isFinite(valor)) return String(valor);
  return nullableString(valor, tamanho);
}

function primeiroTexto(valores, tamanho = 500) {
  for (const valor of valores) {
    const limpo = texto(valor, tamanho);
    if (limpo) return limpo;
  }
  return null;
}

/** O sck que foi de fato no link do checkout aberto (o último, se a pessoa enviou mais de uma vez). */
function sckDoLink(url) {
  try {
    return new URL(String(url || "")).searchParams.get("sck") || "";
  } catch {
    return "";
  }
}

/**
 * Os campos que importam do payload da Hotmart (Webhook 2.0), tolerando as variações de formato:
 * o comprador vem em data.buyer OU em data.purchase.buyer; a oferta em data.purchase.offer OU em
 * data.offer (aviso de carrinho abandonado); o rastreio em data.purchase.origin.{sck,src} (é onde
 * os avisos reais trazem), com data.purchase.tracking e data.purchase.sckPaymentLink de reserva.
 * O que não for reconhecido não se perde: o payload CRU vai inteiro para compras.payload.
 */
export function extrairVendaHotmart(corpo) {
  const b = isPlainObject(corpo) ? corpo : {};
  const d = isPlainObject(b.data) ? b.data : {};
  const purchase = isPlainObject(d.purchase) ? d.purchase : {};
  const buyer = isPlainObject(d.buyer) ? d.buyer : isPlainObject(purchase.buyer) ? purchase.buyer : {};
  const product = isPlainObject(d.product) ? d.product : {};
  const price = isPlainObject(purchase.price) ? purchase.price : {};
  const offer = isPlainObject(purchase.offer) ? purchase.offer : isPlainObject(d.offer) ? d.offer : {};
  const origin = isPlainObject(purchase.origin) ? purchase.origin : {};
  const tracking = isPlainObject(purchase.tracking) ? purchase.tracking : {};

  // checkout_phone_code é o DDI (55) e vem separado do número: juntar é o que faz os dígitos
  // baterem com o WhatsApp da inscrição.
  const ddi = texto(buyer.checkout_phone_code, 10) || "";
  const numero = texto(buyer.checkout_phone, 40) || texto(buyer.phone, 40) || "";
  const telefone = numero && ddi && !numero.replace(/\D/g, "").startsWith(ddi.replace(/\D/g, "")) ? `${ddi}${numero}` : numero;

  return {
    // Só texto vira evento: um `event` numérico é payload estranho, e vira 422 em vez de "42".
    evento: (nullableString(b.event, 60) || "").toUpperCase(),
    hotmart_id: texto(b.id, 120),
    evento_em: dataHotmart(b.creation_date),
    transacao: texto(purchase.transaction, 120),
    status: texto(purchase.status, 60),
    produto_id: texto(product.id ?? product.ucode, 120),
    // Só para reconhecer a página (EVCheckout.paginaDaVenda): o SQL não tem coluna para ele.
    produto_ucode: texto(product.ucode, 120),
    produto_nome: texto(product.name, 300),
    oferta: texto(offer.code ?? offer.key, 120),
    valor: numeroOuNull(price.value ?? price.total),
    moeda: texto(price.currency_value ?? price.currency_code, 10),
    comprador_nome: texto(buyer.name, 200),
    comprador_email: leadRules.normalizeEmail(texto(buyer.email, 254) || "") || null,
    comprador_telefone: telefone || null,
    comprador_digits: telefone ? leadRules.normalizePhoneDigits(telefone) || null : null,
    // O primeiro NÃO VAZIO: origin.sck = "" não pode esconder o sck que veio numa das reservas.
    sck: primeiroTexto([origin.sck, tracking.source_sck, purchase.sckPaymentLink, tracking.external_code], 500),
    src: primeiroTexto([origin.src, tracking.source], 500),
    pedido_em: dataHotmart(purchase.order_date),
    aprovado_em: dataHotmart(purchase.approved_date)
  };
}

/**
 * POST /api/hotmart/venda — o endereço que o cliente cola na Hotmart.
 *
 * Autentica pelo header X-HOTMART-HOTTOK (o token da aba Autenticação) OU por ?chave= (um segredo
 * nosso, para o endereço já funcionar antes de o hottok estar configurado). Sem nenhuma das duas
 * variáveis: 503 — melhor a Hotmart reter e reenviar do que aceitar aviso de qualquer um.
 * Content-Type não é exigido de propósito: quem manda é um servidor da Hotmart, autenticado por
 * segredo, e recusar por causa de um cabeçalho perderia venda.
 */
async function handleHotmartVenda(request, response, options) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");

  const hottok = String(options.hotmartHottok || "").trim();
  // Uma chave por produto: o endereço que o cliente cola na Hotmart é o mesmo, com ?chave= própria.
  // Assim dá para desligar (ou trocar) o aviso de um produto sem mexer no dos outros.
  const chaves = String(options.hotmartChave || "")
    .split(",")
    .map((valor) => valor.trim())
    .filter(Boolean);
  if (!hottok && !chaves.length) {
    sendJson(response, 503, { ok: false, error: "webhook_not_configured" });
    return;
  }

  const recebido = request.headers["x-hotmart-hottok"];
  const chaveDaUrl = new URL(request.url, "http://localhost").searchParams.get("chave");
  const autorizado = (hottok && segredoIgual(recebido, hottok)) || chaves.some((chave) => segredoIgual(chaveDaUrl, chave));
  if (!autorizado) {
    sendJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  const body = await readObjectBody(request, response, HOTMART_MAX_BODY_BYTES);
  if (!body) return;

  const venda = extrairVendaHotmart(body);
  if (!venda.evento) {
    sendJson(response, 422, { ok: false, error: "invalid_event" });
    return;
  }
  // Aviso que não é de compra (acesso ao clube, assinatura) é aceito e ignorado: responder erro
  // faria a Hotmart reenviar para sempre.
  if (!HOTMART_EVENTO_COMPRA.test(venda.evento)) {
    sendJson(response, 200, { ok: true, ignorado: true });
    return;
  }

  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  // De qual página é este produto (pela oferta ou pelo id do produto, no config). null = produto que
  // o config não conhece: o SQL ainda tenta reconhecer pela oferta dos links que as páginas abriram.
  const paginaDaVenda = checkout.paginaDaVenda(venda);

  let resultado;
  try {
    resultado = await readObjectResponse(
      await callRpc(options, "hotmart_registrar_compra", { p: { ...venda, pagina: paginaDaVenda ? paginaDaVenda.id : null, payload: body } })
    );
  } catch (error) {
    // 502 de propósito: a Hotmart reenvia o aviso, e nenhuma venda se perde.
    console.error(`Falha ao registrar compra da Hotmart: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
    return;
  }

  if (resultado.casou !== true) {
    // Sem dado pessoal no log: só o evento e a transação.
    console.warn(`Compra sem inscrição correspondente (${venda.evento}${venda.transacao ? ` ${venda.transacao}` : ""}).`);
  }
  sendJson(response, 200, { ok: true });
}

/* ------------------------------------------------------------------------------------------ */
/* Painel: sessão                                                                              */
/* ------------------------------------------------------------------------------------------ */

function painelConfigured(config) {
  return Boolean(config.painelEmail && config.painelSenhaHash && config.painelSessaoSegredo);
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  if (!expected.length) return false;

  try {
    const derived = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function signSession(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function readSession(token, secret, agora) {
  const [data, signature, ...resto] = String(token || "").split(".");
  if (!data || !signature || resto.length) return null;

  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  const received = Buffer.from(signature);
  const control = Buffer.from(expected);
  if (received.length !== control.length || !timingSafeEqual(received, control)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return isPlainObject(payload) && typeof payload.exp === "number" && payload.exp > agora ? payload : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

// Secure sempre, menos no servidor local de desenvolvimento: o cabeçalho de protocolo é escrito
// pelo cliente, então não pode ser ele a decidir se o cookie de sessão pode trafegar em claro.
function sessionCookie(value, request, maxAgeSeconds) {
  const host = String(request.headers.host || "").replace(/:\d+$/, "");
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(host);
  const httpsProxy = String(request.headers["x-forwarded-proto"] || "").includes("https");
  const secure = !local || httpsProxy ? "; Secure" : "";
  return `${PAINEL_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function requirePainel(request, response, config) {
  if (!painelConfigured(config)) {
    sendJson(response, 503, { ok: false, error: "painel_not_configured" });
    return null;
  }

  const token = parseCookies(request.headers.cookie).get(PAINEL_COOKIE);
  const session = readSession(token, config.painelSessaoSegredo, config.now());
  if (!session) {
    sendJson(response, 401, { ok: false, error: "unauthorized" });
    return null;
  }
  return session;
}

async function handleLogin(request, response, options) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if (!acceptsJsonBody(request, response)) return;

  if (!painelConfigured(options)) {
    sendJson(response, 503, { ok: false, error: "painel_not_configured" });
    return;
  }

  if (!options.allowLogin(request)) {
    sendJson(response, 429, { ok: false, error: "too_many_attempts" });
    return;
  }

  const body = await readObjectBody(request, response);
  if (!body) return;

  const email = safeString(body.email, 254).toLowerCase();
  const senha = typeof body.senha === "string" ? body.senha.slice(0, 1_024) : "";

  const emailOk = email === String(options.painelEmail).trim().toLowerCase();
  // A senha é conferida mesmo com e-mail errado: o tempo de resposta não pode dizer qual dos dois errou.
  const senhaOk = await verifyPassword(senha, options.painelSenhaHash);

  if (!emailOk || !senhaOk) {
    sendJson(response, 401, { ok: false, error: "invalid_credentials" });
    return;
  }

  const token = signSession({ email, exp: options.now() + PAINEL_SESSION_TTL_MS }, options.painelSessaoSegredo);
  sendJson(response, 200, { ok: true, email }, { "Set-Cookie": sessionCookie(token, request, PAINEL_SESSION_TTL_MS / 1000) });
}

function handleLogout(request, response) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  // Exigir JSON impede que um formulário em outro site derrube a sessão.
  if (!acceptsJsonBody(request, response)) return;
  sendJson(response, 200, { ok: true }, { "Set-Cookie": sessionCookie("", request, 0) });
}

/* ------------------------------------------------------------------------------------------ */
/* Painel: filtros e consultas                                                                 */
/* ------------------------------------------------------------------------------------------ */

class FiltroInvalido extends Error {}

function invalido() {
  throw new FiltroInvalido("invalid_filters");
}

// Recusar filtro que não faz sentido é melhor do que devolver a base inteira com cara de filtrada.
function lerPeriodo(params) {
  const desdeTexto = safeString(params.get("desde"), 100);
  const ateTexto = safeString(params.get("ate"), 100);
  const desde = isoDateOrNull(desdeTexto);
  const ate = isoDateOrNull(ateTexto);
  if ((desdeTexto && !desde) || (ateTexto && !ate)) invalido();
  return { desde, ate };
}

function lerFiltrosComuns(params) {
  const { desde, ate } = lerPeriodo(params);

  const perfilTexto = params.get("perfil");
  const perfil = perfilTexto ? perfilTexto : null;
  if (perfil !== null && !PERFIS_VALIDOS.has(perfil)) invalido();

  return { desde, ate, perfil };
}

function lerInteiro(params, nome, { padrao, minimo, maximo }) {
  const texto = safeString(params.get(nome), 12);
  if (!texto) return padrao;
  if (!/^\d+$/.test(texto)) invalido();
  const numero = Number(texto);
  if (numero < minimo) invalido();
  return maximo === undefined ? numero : Math.min(numero, maximo);
}

function lerStatus(params) {
  const status = safeString(params.get("status"), 40);
  if (status && !STATUS_VALIDOS.has(status)) invalido();
  return status || null;
}

// Vírgula, parênteses, * e % são sintaxe do PostgREST/ILIKE; aspas e barra quebrariam o or=().
function lerBusca(params) {
  return safeString(params.get("busca"), 80).replace(/[,()*%"\\]/g, "").trim();
}

// Só procura no telefone quando a busca PARECE telefone (dígitos, espaço, +, ponto, traço).
// Tirar os dígitos de "edna.4@hotmail.com" daria "4", e a lista traria todo WhatsApp com 4.
function digitosDaBusca(busca) {
  if (!busca || !/^[\d\s+.-]+$/.test(busca)) return "";
  return leadRules.normalizePhoneDigits(busca) || "";
}

/**
 * Filtros de pessoa (status e busca) para as RPCs do painel: os mesmos da lista e do CSV, para os
 * números e a lista mostrarem sempre o mesmo recorte. Vazio vai como null (= sem filtro).
 */
function filtrosDePessoaRpc(params) {
  const status = lerStatus(params);
  const busca = lerBusca(params);
  const digitos = digitosDaBusca(busca);
  return { p_status: status, p_busca: busca || null, p_busca_digitos: digitos || null };
}

/** Filtros de lista (respostas e CSV) em query do PostgREST. */
function filtrosPostgrest(query, { desde, ate, perfil, status, busca }) {
  // A coluna `pesquisa` separa os formulários: o painel desta pesquisa só lê as linhas dela.
  query.set("pesquisa", `eq.${pesquisa.ID}`);
  if (desde) query.append("criado_em", `gte.${desde}`);
  if (ate) query.append("criado_em", `lt.${ate}`);
  if (perfil) query.set("perfil", `eq.${perfil}`);
  if (status) query.set("status", `eq.${status}`);
  if (busca) {
    const filtros = [`nome.ilike.*${busca}*`, `email.ilike.*${busca}*`];
    const digits = digitosDaBusca(busca);
    if (digits) filtros.push(`whatsapp_digits.ilike.*${digits}*`);
    query.set("or", `(${filtros.join(",")})`);
  }
}

/**
 * Molde comum das rotas GET do painel: método, sessão, banco, filtros (422) e erro do banco (502,
 * logado sem dado pessoal). `executar` recebe os parâmetros e devolve o corpo da resposta.
 */
async function rotaDoPainel(request, response, options, rotulo, executar) {
  if (request.method !== "GET") return methodNotAllowed(response, "GET");
  if (!requirePainel(request, response, options)) return;

  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  const params = new URL(request.url, "http://localhost").searchParams;
  let corpo;
  try {
    corpo = await executar(params);
  } catch (error) {
    if (error instanceof FiltroInvalido) {
      sendJson(response, 422, { ok: false, error: "invalid_filters" });
      return;
    }
    console.error(`Falha ao consultar ${rotulo}: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
    return;
  }
  sendJson(response, 200, { ok: true, ...corpo });
}

function handleResumo(request, response, options) {
  return rotaDoPainel(request, response, options, "o resumo", async (params) => {
    const { desde, ate, perfil } = lerFiltrosComuns(params);
    const pessoa = filtrosDePessoaRpc(params);
    const resumo = await readObjectResponse(
      await callRpc(options, "pesquisa_painel", {
        p_desde: desde,
        p_ate: ate,
        p_perfil: perfil,
        // Texto livre não tem "valor mais comum": fica fora das distribuições.
        p_ignorar: CHAVES_TEXTO,
        ...pessoa
      })
    );
    return { resumo, gerado_em: new Date(options.now()).toISOString() };
  });
}

function handleRespostas(request, response, options) {
  return rotaDoPainel(request, response, options, "as respostas", async (params) => {
    const filtros = lerFiltrosComuns(params);
    const status = lerStatus(params);
    const busca = lerBusca(params);
    const limite = lerInteiro(params, "limite", { padrao: PAINEL_LIST_PADRAO, minimo: 1, maximo: PAINEL_LIST_MAX });
    const offset = lerInteiro(params, "offset", { padrao: 0, minimo: 0 });

    const query = new URLSearchParams();
    query.set("select", "*");
    // id desempata quem entrou no mesmo instante: sem ele, "Carregar mais" repetiria ou pularia gente.
    query.set("order", "criado_em.desc,id.desc");
    query.set("limit", String(limite));
    query.set("offset", String(offset));
    filtrosPostgrest(query, { ...filtros, status, busca });

    const supabaseResponse = await supabaseRequest(options, `pesquisa_pessoas?${query.toString()}`, {
      headers: { Prefer: "count=exact" }
    });
    const itens = await supabaseResponse.json();
    if (!Array.isArray(itens)) throw new Error("supabase_unexpected_shape");
    return { total: totalFromContentRange(supabaseResponse, offset + itens.length), itens };
  });
}

function handleAbertas(request, response, options) {
  return rotaDoPainel(request, response, options, "as respostas abertas", async (params) => {
    const filtros = lerFiltrosComuns(params);
    const chaves = safeString(params.get("chaves"), 1_000)
      .split(",")
      .map((chave) => chave.trim())
      .filter(Boolean);
    if (!chaves.length || chaves.some((chave) => !CHAVES_TEXTO_SET.has(chave))) invalido();
    const pessoa = filtrosDePessoaRpc(params);
    const limite = lerInteiro(params, "limite", { padrao: ABERTAS_PADRAO, minimo: 1, maximo: PAINEL_LIST_MAX });
    const offset = lerInteiro(params, "offset", { padrao: 0, minimo: 0 });

    const resultado = await readObjectResponse(
      await callRpc(options, "pesquisa_abertas", {
        p_chaves: Array.from(new Set(chaves)),
        p_desde: filtros.desde,
        p_ate: filtros.ate,
        p_perfil: filtros.perfil,
        p_limite: limite,
        p_offset: offset,
        ...pessoa
      })
    );
    return {
      total: Number.isFinite(resultado.total) ? resultado.total : 0,
      itens: Array.isArray(resultado.itens) ? resultado.itens : []
    };
  });
}

function handleCruzamento(request, response, options) {
  return rotaDoPainel(request, response, options, "o cruzamento", async (params) => {
    const filtros = lerFiltrosComuns(params);
    const linha = params.get("linha") || "";
    const coluna = params.get("coluna") || "";
    if (!IDS_ANALISAVEIS.has(linha) || !IDS_ANALISAVEIS.has(coluna) || linha === coluna) invalido();
    const pessoa = filtrosDePessoaRpc(params);

    const cruzamento = await readObjectResponse(
      await callRpc(options, "pesquisa_cruzamento", {
        p_linha: linha,
        p_coluna: coluna,
        p_desde: filtros.desde,
        p_ate: filtros.ate,
        p_perfil: filtros.perfil,
        ...pessoa
      })
    );
    return { cruzamento };
  });
}

/**
 * Páginas de obrigado: visitantes, cliques no grupo e pesquisas concluídas atribuídas a cada uma,
 * no período da barra. Só o período vale aqui: a página não tem nome, situação nem busca.
 */
function handlePaginas(request, response, options) {
  return rotaDoPainel(request, response, options, "as páginas de obrigado", async (params) => {
    const { desde, ate } = lerPeriodo(params);
    const resultado = await readObjectResponse(
      await callRpc(options, "paginas_resumo", { p_desde: desde, p_ate: ate, p_mapa: MAPA_PERFIL_PAGINA })
    );
    if (!Array.isArray(resultado.paginas)) throw new Error("supabase_unexpected_shape");
    return { paginas: resultado.paginas, gerado_em: new Date(options.now()).toISOString() };
  });
}

/** A página de inscrição pedida no filtro (?pagina=). Vazio = todas. Página que não existe → 422. */
function lerPaginaCheckout(params) {
  const pedida = safeString(params.get("pagina"), 60);
  if (!pedida) return null;
  const pagina = PAGINAS_CHECKOUT.find((item) => item.id === pedida);
  if (!pagina) invalido();
  return pagina.id;
}

/**
 * Inscrições e compras da(s) página(s) de checkout: os números vêm do SQL (inscricoes_resumo, o
 * período inteiro) e a lista de inscritos vem da tabela, paginada — os mesmos filtros nos dois.
 */
function handleInscricoesPainel(request, response, options) {
  return rotaDoPainel(request, response, options, "as inscrições", async (params) => {
    const { desde, ate } = lerPeriodo(params);
    const pagina = lerPaginaCheckout(params);
    const limite = lerInteiro(params, "limite", { padrao: PAINEL_LIST_PADRAO, minimo: 1, maximo: PAINEL_LIST_MAX });
    const offset = lerInteiro(params, "offset", { padrao: 0, minimo: 0 });

    const query = new URLSearchParams();
    query.set("select", "*");
    // id desempata quem entrou no mesmo instante: sem ele, "Carregar mais" repetiria ou pularia gente.
    query.set("order", "criado_em.desc,id.desc");
    query.set("limit", String(limite));
    query.set("offset", String(offset));
    if (pagina) query.set("pagina", `eq.${pagina}`);
    if (desde) query.append("criado_em", `gte.${desde}`);
    if (ate) query.append("criado_em", `lt.${ate}`);

    // As duas idas ao banco vão juntas: os números e a lista chegam no mesmo tempo de uma.
    const [resumoResponse, listaResponse] = await Promise.all([
      callRpc(options, "inscricoes_resumo", { p_desde: desde, p_ate: ate, p_pagina: pagina }),
      supabaseRequest(options, `inscricoes?${query.toString()}`, { headers: { Prefer: "count=exact" } })
    ]);
    const resumo = await readObjectResponse(resumoResponse);
    if (!Array.isArray(resumo.paginas)) throw new Error("supabase_unexpected_shape");
    const itens = await listaResponse.json();
    if (!Array.isArray(itens)) throw new Error("supabase_unexpected_shape");

    return {
      resumo,
      itens,
      total: totalFromContentRange(listaResponse, offset + itens.length),
      gerado_em: new Date(options.now()).toISOString()
    };
  });
}

// Só o que a aba de perfis mostra: a página curta não tem respostas para trazer junto.
const PERFIS_COLUNAS = [
  "id",
  "criado_em",
  "atualizado_em",
  "concluido_em",
  "nome",
  "whatsapp",
  "whatsapp_digits",
  "email",
  "perfil",
  // De qual origem veio a linha (a página curta do WhatsApp ou a DM do Instagram).
  "pesquisa",
  // Se a sequência do WhatsApp já foi disparada para esta pessoa (o aviso perfil_atualizado).
  "webhook_enviado_em",
  "dispositivo",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "tentativas"
].join(",");

/**
 * Perfis atualizados (/atualizacao-perfil): quem veio do WhatsApp e disse só contato e profissão.
 *
 * Mora na MESMA tabela da pesquisa, separado pela coluna `pesquisa` — por isso a lista sai da
 * mesma view e nada aqui encosta nos números do ICP. Um pedido devolve o recorte inteiro: a lista
 * paginada, o total e quantos por profissão, todos com os mesmos filtros (período, busca e
 * profissão mudam TODOS os números, como nas outras abas).
 */
function handlePerfisPainel(request, response, options) {
  return rotaDoPainel(request, response, options, "os perfis atualizados", async (params) => {
    const { desde, ate } = lerPeriodo(params);
    const busca = lerBusca(params);
    const perfilPedido = params.get("perfil") || null;
    if (perfilPedido !== null && !PERFIS_CONTADOS_SET.has(perfilPedido)) invalido();
    const limite = lerInteiro(params, "limite", { padrao: PAINEL_LIST_PADRAO, minimo: 1, maximo: PAINEL_LIST_MAX });
    const offset = lerInteiro(params, "offset", { padrao: 0, minimo: 0 });

    // O recorte comum: cada consulta parte daqui, então um filtro vale para a lista e para as contagens.
    const recorte = () => {
      const query = new URLSearchParams();
      // As duas origens de "contato + profissão": a página curta do WhatsApp e a DM do Instagram.
      // A coluna de origem da lista (utm_source) diz qual é qual, linha por linha.
      query.set("pesquisa", `in.(${PESQUISA_ATUALIZACAO},${PESQUISA_MANYCHAT})`);
      if (desde) query.append("criado_em", `gte.${desde}`);
      if (ate) query.append("criado_em", `lt.${ate}`);
      if (busca) {
        const filtros = [`nome.ilike.*${busca}*`, `email.ilike.*${busca}*`];
        const digits = digitosDaBusca(busca);
        if (digits) filtros.push(`whatsapp_digits.ilike.*${digits}*`);
        query.set("or", `(${filtros.join(",")})`);
      }
      return query;
    };

    const lista = recorte();
    lista.set("select", PERFIS_COLUNAS);
    // id desempata quem entrou no mesmo instante: sem ele, "Carregar mais" repetiria ou pularia gente.
    lista.set("order", "criado_em.desc,id.desc");
    lista.set("limit", String(limite));
    lista.set("offset", String(offset));
    if (perfilPedido) lista.set("perfil", `eq.${perfilPedido}`);

    // Uma contagem por profissão, sem trazer linha nenhuma (limit=0): o número vem no Content-Range.
    // A contagem ignora o filtro de profissão de propósito — os quatro cartões continuam visíveis.
    const profissoes = Array.from(PERFIS_CONTADOS);
    const contagens = profissoes.map((nome) => {
      const query = recorte();
      query.set("select", "id");
      query.set("perfil", `eq.${nome}`);
      query.set("limit", "0");
      return query;
    });

    const pedir = (query) => supabaseRequest(options, `pesquisa_pessoas?${query.toString()}`, { headers: { Prefer: "count=exact" } });
    // Tudo junto: os números e a lista chegam no tempo de uma consulta só.
    const [listaResponse, ...contagemResponses] = await Promise.all([pedir(lista), ...contagens.map(pedir)]);

    const itens = await listaResponse.json();
    if (!Array.isArray(itens)) throw new Error("supabase_unexpected_shape");
    const porPerfil = profissoes.map((nome, indice) => {
      const grupo = pesquisa.grupoDoRotulo(nome);
      return {
        perfil: nome,
        codigo: pesquisa.codigoDoPerfil(nome),
        // Rótulo curto da aba. Só vem para grupo: das quatro profissões, o painel já tem o dele.
        ...(grupo ? { curto: grupo.curto } : {}),
        total: totalFromContentRange(contagemResponses[indice], 0)
      };
    });

    return {
      itens,
      // Sem webhook configurado não existe "aviso pendente" — a lista não pode acusar uma entrega
      // que ninguém pediu.
      aviso_ativo: Boolean(options.perfilWebhookUrl),
      total: totalFromContentRange(listaResponse, offset + itens.length),
      // Sem filtro de profissão o total é a soma dos quatro; com filtro, `total` é só a fatia.
      respondentes: porPerfil.reduce((soma, item) => soma + item.total, 0),
      por_perfil: porPerfil,
      gerado_em: new Date(options.now()).toISOString()
    };
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Exportação CSV                                                                              */
/* ------------------------------------------------------------------------------------------ */

const FORMATO_BRASILIA = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
const DIA_BRASILIA = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export function dataHoraBrasilia(valor) {
  if (!valor) return "";
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return "";
  const partes = Object.fromEntries(FORMATO_BRASILIA.formatToParts(data).map((parte) => [parte.type, parte.value]));
  return `${partes.day}/${partes.month}/${partes.year} ${partes.hour}:${partes.minute}`;
}

// Planilha interpreta célula que começa com = + - @ (e tab/CR) como fórmula: um nome digitado
// como "=HYPERLINK(...)" viraria link malicioso no Excel de quem abrir o arquivo.
export function celulaCsv(valor) {
  let texto = valor === null || valor === undefined ? "" : String(valor);
  if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
  return `"${texto.replace(/"/g, '""')}"`;
}

function valorDaChave(respostas, chave) {
  const valor = respostas[chave];
  if (Array.isArray(valor)) return valor.join(" | ");
  if (typeof valor === "number" || typeof valor === "string") return valor;
  return "";
}

function rotuloDaPergunta(id) {
  if (id === "fim") return "Fim";
  const pergunta = pesquisa.perguntaPorId(id);
  return pergunta ? `${pergunta.numero}. ${pergunta.analise}` : id || "";
}

function respostasDaLinha(linha) {
  return isPlainObject(linha.respostas) ? linha.respostas : {};
}

// A coluna `perfil` espelha respostas.perfil; a resposta vale se a coluna faltar.
function perfilDaLinha(linha) {
  return typeof linha.perfil === "string" ? linha.perfil : respostasDaLinha(linha).perfil;
}

/** As colunas do CSV, na ordem do contrato (SPEC seção 5.3). */
export const COLUNAS_CSV = (() => {
  const colunas = [
    ["id", (l) => l.id],
    ["criado_em", (l) => dataHoraBrasilia(l.criado_em)],
    ["concluido_em", (l) => dataHoraBrasilia(l.concluido_em)],
    ["status", (l) => l.status],
    ["progresso_percentual", (l) => l.progresso_percentual],
    ["parou_em", (l) => (l.status === "concluida" ? "" : rotuloDaPergunta(l.pergunta_max))],
    ["tentativas", (l) => l.tentativas],
    ["nome", (l) => l.nome],
    ["whatsapp", (l) => l.whatsapp],
    ["whatsapp_internacional", (l) => l.whatsapp_internacional],
    ["email", (l) => l.email],
    // Código do perfil (CRM) e a página de obrigado para onde o perfil leva (id de obrigado-config).
    ["perfil_codigo", (l) => valorDoPerfil(pesquisa.PERFIL_CODIGO, perfilDaLinha(l)) ?? ""],
    ["pagina_obrigado", (l) => paginaObrigadoDoPerfil(perfilDaLinha(l))?.id ?? ""]
  ];

  for (const pergunta of PERGUNTAS) {
    if (pergunta.tipo === "frase") {
      for (const parte of pergunta.partes) {
        colunas.push([`${pergunta.numero}. ${parte.antes}`, (l) => valorDaChave(respostasDaLinha(l), parte.id)]);
      }
      continue;
    }
    const rotulo = `${pergunta.numero}. ${pergunta.analise}`;
    colunas.push([rotulo, (l) => valorDaChave(respostasDaLinha(l), pergunta.id)]);
    // Coluna do complemento só para pergunta com "Outro" — hoje nenhuma tem.
    if (pergunta.outro) {
      const chave = pesquisa.chaveOutro(pergunta);
      colunas.push([`${rotulo} (Outro)`, (l) => valorDaChave(respostasDaLinha(l), chave)]);
    }
  }

  colunas.push(
    ["regiao", (l) => pesquisa.regiaoDoEstado(respostasDaLinha(l).estado) || ""],
    [
      "tempo_total_min",
      (l) =>
        Number.isFinite(l.tempo_total_segundos)
          ? String(Math.round(l.tempo_total_segundos / 6) / 10).replace(".", ",")
          : ""
    ]
  );
  for (const campo of [
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
    "pesquisa_versao"
  ]) {
    colunas.push([campo, (l) => l[campo]]);
  }
  // Quando o n8n confirmou o aviso de pesquisa concluída (vazio = não chegou ou não se aplica).
  colunas.push(["enviado_n8n_em", (l) => dataHoraBrasilia(l.webhook_enviado_em)]);

  return Object.freeze(colunas.map(([cabecalho, valor]) => Object.freeze({ cabecalho, valor })));
})();

export function linhaCsv(valores) {
  return `${valores.map(celulaCsv).join(";")}\r\n`;
}

function escrever(response, texto) {
  return new Promise((resolve) => {
    if (response.write(texto)) resolve();
    else response.once("drain", resolve);
  });
}

/**
 * Molde comum dos dois CSV do painel: 302 para quem clicou com a sessão vencida, 401/503/422,
 * primeira página antes do cabeçalho HTTP (para o erro do banco ainda virar 502) e corte da
 * conexão se o banco cair no meio, em vez de uma planilha pela metade parecendo completa.
 */
async function exportarCsv(request, response, options, { rotulo, colunas, nomeArquivo, paginaDeDados }) {
  if (request.method !== "GET") return methodNotAllowed(response, "GET");
  // O botão "Baixar CSV" é um link comum: com a sessão vencida, o navegador baixaria o JSON do
  // erro como se fosse a planilha. Quem veio de um clique (pede HTML) volta para o login.
  if (
    painelConfigured(options) &&
    /text\/html/i.test(String(request.headers.accept || "")) &&
    !readSession(parseCookies(request.headers.cookie).get(PAINEL_COOKIE), options.painelSessaoSegredo, options.now())
  ) {
    response.writeHead(302, { Location: "/painel", "Cache-Control": "no-store" });
    response.end();
    return;
  }
  if (!requirePainel(request, response, options)) return;

  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  const params = new URL(request.url, "http://localhost").searchParams;
  let pagina;
  try {
    pagina = paginaDeDados(params);
  } catch {
    sendJson(response, 422, { ok: false, error: "invalid_filters" });
    return;
  }

  let linhas;
  try {
    linhas = await pagina(0);
  } catch (error) {
    console.error(`Falha ao exportar ${rotulo}: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
    return;
  }

  let cancelado = false;
  response.on("close", () => {
    cancelado = true;
  });

  const dia = DIA_BRASILIA.format(new Date(options.now()));
  // O nome pode depender do filtro (o CSV de cada página de inscrição sai com o id dela).
  const nome = typeof nomeArquivo === "function" ? nomeArquivo(params) : nomeArquivo;
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${nome}-${dia}.csv"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  // BOM: sem ele o Excel abre o UTF-8 como Latin-1 e "Técnico" vira "TÃ©cnico".
  await escrever(response, `﻿${linhaCsv(colunas.map((coluna) => coluna.cabecalho))}`);

  let offset = 0;
  try {
    for (;;) {
      for (const linha of linhas) {
        if (cancelado) return;
        await escrever(response, linhaCsv(colunas.map((coluna) => coluna.valor(linha))));
      }
      if (linhas.length < EXPORT_PAGE_SIZE || cancelado) break;
      offset += EXPORT_PAGE_SIZE;
      linhas = await pagina(offset);
    }
    response.end();
  } catch (error) {
    console.error(`Falha ao exportar ${rotulo} no meio: ${error?.message || "erro"}`);
    response.destroy();
  }
}

function handleExportarCsv(request, response, options) {
  return exportarCsv(request, response, options, {
    rotulo: "o CSV da pesquisa",
    colunas: COLUNAS_CSV,
    nomeArquivo: "pesquisa-icp",
    paginaDeDados: (params) => {
      const tentativas = safeString(params.get("tentativas"), 20);
      if (tentativas && tentativas !== "todas") invalido();
      // "todas" = cada tentativa numa linha (tabela crua); o padrão é uma linha por pessoa (view).
      const base = tentativas === "todas" ? "pesquisa_respostas" : "pesquisa_pessoas";
      const filtros = { ...lerFiltrosComuns(params), status: lerStatus(params), busca: lerBusca(params) };
      return (offset) => {
        const query = new URLSearchParams();
        query.set("select", "*");
        query.set("order", "criado_em.asc,id.asc");
        query.set("limit", String(EXPORT_PAGE_SIZE));
        query.set("offset", String(offset));
        filtrosPostgrest(query, filtros);
        return supabaseRequest(options, `${base}?${query.toString()}`).then(async (resposta) => {
          const linhas = await resposta.json();
          if (!Array.isArray(linhas)) throw new Error("supabase_unexpected_shape");
          return linhas;
        });
      };
    }
  });
}

/**
 * As colunas do CSV de inscrições. `sck` é a UTM que a página da linha escolheu (utm_term na Viver
 * de Furo, utm_content na Imersão GPS): é ela que vai no link do checkout e volta no aviso de venda
 * da Hotmart — a coluna existe com o nome que o cliente vê no relatório de lá.
 */
export const COLUNAS_CSV_INSCRICOES = Object.freeze(
  [
    ["data", (l) => dataHoraBrasilia(l.criado_em)],
    ["nome", (l) => l.nome],
    ["whatsapp", (l) => l.whatsapp],
    ["whatsapp_internacional", (l) => l.whatsapp_internacional],
    ["email", (l) => l.email],
    ["pagina", (l) => l.pagina],
    ["cliques", (l) => l.cliques],
    ["comprou_em", (l) => dataHoraBrasilia(l.comprou_em)],
    ["compra_status", (l) => l.compra_status],
    ["compra_valor", (l) => (l.compra_valor == null || l.compra_valor === "" ? "" : String(l.compra_valor).replace(".", ","))],
    ["compra_transacao", (l) => l.compra_transacao],
    ["utm_source", (l) => l.utm_source],
    ["utm_medium", (l) => l.utm_medium],
    ["utm_campaign", (l) => l.utm_campaign],
    ["utm_term", (l) => l.utm_term],
    ["utm_content", (l) => l.utm_content],
    // O sck que foi para a Hotmart: o do link aberto (a pessoa pode ter voltado por outro link, com
    // outra UTM, e aberto o checkout de novo); sem link gravado, a UTM que a página escolheu.
    ["sck", (l) => sckDoLink(l.checkout_url) || l[checkout.sckDaPagina(checkout.paginaPorId(l.pagina))]],
    ["fbclid", (l) => l.fbclid],
    ["gclid", (l) => l.gclid],
    ["page_url", (l) => l.page_url],
    ["referrer", (l) => l.referrer],
    ["dispositivo", (l) => l.dispositivo]
  ].map(([cabecalho, valor]) => Object.freeze({ cabecalho, valor }))
);

function handleExportarInscricoesCsv(request, response, options) {
  return exportarCsv(request, response, options, {
    rotulo: "o CSV de inscrições",
    colunas: COLUNAS_CSV_INSCRICOES,
    // inscricoes-imersao-gps-AAAA-MM-DD.csv: os CSVs das duas abas não saem com o mesmo nome. O id
    // já passou por lerPaginaCheckout (só [a-z0-9_-]), então pode ir no cabeçalho.
    nomeArquivo: (params) => {
      const pedida = safeString(params.get("pagina"), 60);
      return PAGINAS_CHECKOUT.some((item) => item.id === pedida) ? `inscricoes-${pedida}` : "inscricoes";
    },
    paginaDeDados: (params) => {
      const { desde, ate } = lerPeriodo(params);
      const pagina = lerPaginaCheckout(params);
      // Ordem crescente: com offset, quem se inscrever durante a exportação entra no FIM da lista,
      // e nenhuma linha já baixada escorrega de página.
      return (offset) => {
        const query = new URLSearchParams();
        query.set("select", "*");
        query.set("order", "criado_em.asc,id.asc");
        query.set("limit", String(EXPORT_PAGE_SIZE));
        query.set("offset", String(offset));
        if (pagina) query.set("pagina", `eq.${pagina}`);
        if (desde) query.append("criado_em", `gte.${desde}`);
        if (ate) query.append("criado_em", `lt.${ate}`);
        return supabaseRequest(options, `inscricoes?${query.toString()}`).then(async (resposta) => {
          const linhas = await resposta.json();
          if (!Array.isArray(linhas)) throw new Error("supabase_unexpected_shape");
          return linhas;
        });
      };
    }
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Estático                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function metaPixelCode(pixelId) {
  return `<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${pixelId}');
fbq('track', 'PageView');
</script>
<noscript><img height="1" width="1" style="display:none"
src="https://www.facebook.com/tr?id=${pixelId}&ev=PageView&noscript=1"
/></noscript>
<!-- End Meta Pixel Code -->`;
}

function escapeAttr(valor) {
  return String(valor).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Endereço público do site: SITE_URL quando existe; senão, a origem derivada da requisição (ver
 * origemDaRequisicao). Com ele, a prévia do link no WhatsApp ganha og:url, canonical e a imagem
 * com endereço absoluto — o WhatsApp não monta prévia com imagem de caminho relativo. Sem origem
 * válida, a página sai como está no arquivo.
 */
function metaDoSite(source, siteUrl, rota = PESQUISA_ROTA) {
  if (!siteUrl) return source;
  const pagina = `${siteUrl}${rota}`;
  // Imagem da prévia com caminho relativo ("/img/..."): vira endereço absoluto.
  const absoluta = (_, antes, caminho, depois) => `${antes}${escapeAttr(`${siteUrl}${caminho}`)}${depois}`;
  return source
    .replace(/(<meta property="og:image" content=")(\/[^"/][^"]*)(")/, absoluta)
    .replace(/(<meta name="twitter:image" content=")(\/[^"/][^"]*)(")/, absoluta)
    .replace(
      "</head>",
      `<meta property="og:url" content="${escapeAttr(pagina)}" />\n<link rel="canonical" href="${escapeAttr(pagina)}" />\n</head>`
    );
}

// hostname[:porta] e nada mais: letras, dígitos, hífen e pontos. Sem espaço, @, barra ou aspas —
// o valor vai parar num atributo HTML e numa chave de cache.
const HOST_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/;

function primeiroValor(cabecalho) {
  const texto = Array.isArray(cabecalho) ? cabecalho[0] : cabecalho;
  return String(texto ?? "").split(",")[0].trim();
}

/**
 * Sem SITE_URL, a origem pública vem da requisição: X-Forwarded-Host (o proxy do Railway) ou
 * Host; protocolo de X-Forwarded-Proto se for http/https, senão http só para localhost. Host fora
 * do padrão → "" (a página sai sem og:url/canonical, como no arquivo).
 */
export function origemDaRequisicao(headers = {}) {
  const host = (primeiroValor(headers["x-forwarded-host"]) || primeiroValor(headers.host)).toLowerCase();
  if (!host || host.length > 260 || !HOST_PATTERN.test(host)) return "";
  const nome = host.replace(/:\d+$/, "");
  const protoCabecalho = primeiroValor(headers["x-forwarded-proto"]).toLowerCase();
  const proto =
    protoCabecalho === "http" || protoCabecalho === "https"
      ? protoCabecalho
      : nome === "localhost" || nome === "127.0.0.1"
        ? "http"
        : "https";
  return `${proto}://${host}`;
}

// O Pixel entra só na pesquisa e nas páginas de obrigado. O painel tem dado pessoal na tela: nada
// de terceiros ali. `rota` é o endereço público (as 3 páginas de obrigado são o mesmo arquivo).
function transformPage(source, pathname, pixelId, siteUrl, rota) {
  const inscricao = ROTA_DA_INSCRICAO.get(pathname) || "";
  if (pathname !== PESQUISA_PAGE && pathname !== OBRIGADO_PAGE && pathname !== PERFIL_PAGE && !inscricao) return source;
  const rotaDaPagina =
    pathname === OBRIGADO_PAGE ? rota : pathname === PERFIL_PAGE ? PERFIL_ROTA : inscricao || PESQUISA_ROTA;
  let saida = metaDoSite(source, siteUrl, rotaDaPagina);
  if (pixelId && !saida.includes("fbq('init'")) saida = saida.replace("</head>", `${metaPixelCode(pixelId)}</head>`);
  return saida;
}

function negotiateEncoding(acceptEncoding) {
  const weights = new Map();

  for (const part of String(acceptEncoding || "").split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    const weight = quality ? Number.parseFloat(quality.slice(2)) : 1;
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }

  const accepts = (encoding) => (weights.get(encoding) ?? weights.get("*") ?? 0) > 0;
  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  return "identity";
}

async function buildResponseBody({ filePath, pathname, extension, encoding, pixelId, siteUrl, rota }) {
  let data = await readFile(filePath);
  if (extension === ".html") data = Buffer.from(transformPage(data.toString("utf8"), pathname, pixelId, siteUrl, rota));

  if (encoding === "br") {
    return await brotliCompressAsync(data, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length
      }
    });
  }
  if (encoding === "gzip") return await gzipAsync(data, { level: 9 });
  return data;
}

function staticHeaders(pathname, extension) {
  const headers = {
    "Content-Type": contentTypes.get(extension),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  };

  const doPainel = PAINEL_PATHS.has(pathname);
  // Página de obrigado não é porta de entrada: sem índice de busca (quem chega é quem terminou).
  if (pathname === OBRIGADO_PAGE || pathname === PERFIL_PAGE) headers["X-Robots-Tag"] = "noindex, nofollow, noarchive";
  if (doPainel) {
    // O X-Robots-Tag repete no cabeçalho o que a meta tag diz no HTML. O no-referrer impede que o
    // endereço do painel vaze quando alguém clica, de dentro dele, no WhatsApp de um lead.
    headers["X-Robots-Tag"] = "noindex, nofollow, noarchive, nosnippet";
    headers["Referrer-Policy"] = "no-referrer";
    headers["X-Frame-Options"] = "DENY";
  }

  if (extension === ".html") {
    headers["Content-Security-Policy"] = doPainel ? CSP_PAINEL : CSP_PESQUISA;
    if (!doPainel) headers["X-Frame-Options"] = "DENY";
  }

  // Fontes não mudam nunca: cache longo de verdade. HTML, JS e CSS sem cache: é campanha no ar,
  // correção precisa valer na hora. Imagens: um dia.
  if (pathname.startsWith("/fonts/")) headers["Cache-Control"] = "public, max-age=31536000, immutable";
  else if (IMAGE_EXTENSIONS.has(extension)) headers["Cache-Control"] = "public, max-age=86400";
  else headers["Cache-Control"] = "no-cache";

  return headers;
}

async function serveStatic(request, response, config) {
  if (!["GET", "HEAD"].includes(request.method || "")) return methodNotAllowed(response, "GET, HEAD");

  let requestedPath;
  try {
    requestedPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch {
    sendJson(response, 400, { ok: false, error: "invalid_path" });
    return;
  }

  if (requestedPath.includes("\0")) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  // /obrigado* só existe nas rotas das páginas de obrigado: /obrigado.html direto, /obrigado-x ou
  // /obrigado-cuidador-velho não abrem nada (nem uma página de obrigado sem segmento).
  if (requestedPath.startsWith("/obrigado") && routeAliases.get(requestedPath) !== OBRIGADO_PAGE) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  const resolvedRoot = path.resolve(config.rootDirectory);
  const filePath = path.resolve(resolvedRoot, `.${routeAliases.get(requestedPath) || requestedPath}`);
  if (!filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  // O caminho canônico evita que variações da URL (ex.: /./pesquisa.html) escapem das regras abaixo.
  const segments = path.relative(resolvedRoot, filePath).split(path.sep);
  const pathname = `/${segments.join("/")}`;
  const extension = path.extname(filePath).toLowerCase();

  // O arquivo das páginas de obrigado só sai pelas rotas dele, qualquer que seja o caminho que
  // levou até ele (ex.: /js/..%2Fobrigado.html).
  if (pathname === OBRIGADO_PAGE && routeAliases.get(requestedPath) !== OBRIGADO_PAGE) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  if (
    !contentTypes.has(extension) ||
    segments.some((segment) => segment.startsWith(".")) ||
    (segments.length === 1 && PRIVATE_ROOT_FILES.has(segments[0])) ||
    PRIVATE_DIRECTORIES.has(segments[0])
  ) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }
  if (!fileStats.isFile()) {
    sendJson(response, 404, { ok: false, error: "not_found" });
    return;
  }

  const headers = staticHeaders(pathname, extension);

  if (compressibleExtensions.has(extension)) {
    const encoding = negotiateEncoding(request.headers["accept-encoding"]);
    // Só a pesquisa e as páginas de obrigado dependem da origem. Sem SITE_URL ela vem da
    // requisição, e por isso ENTRA NA CHAVE do cache: um Host forjado só muda a página de quem o
    // forjou, nunca a de outra pessoa. A rota também entra: as 3 páginas de obrigado são o mesmo
    // arquivo com og:url/canonical diferentes.
    const comOrigem = pathname === PESQUISA_PAGE || pathname === OBRIGADO_PAGE || ROTA_DA_INSCRICAO.has(pathname);
    const origem = comOrigem ? config.siteUrl || origemDaRequisicao(request.headers) : "";
    const rota = pathname === OBRIGADO_PAGE ? requestedPath.replace(/\/+$/, "") : "";
    // Cada arquivo é transformado e comprimido uma única vez por versão (mtime + tamanho).
    const cacheKey = [filePath, fileStats.mtimeMs, fileStats.size, encoding, origem, rota].join("|");
    let body = config.responseBodyCache.get(cacheKey);
    if (!body) {
      body = buildResponseBody({ filePath, pathname, extension, encoding, pixelId: config.metaPixelId, siteUrl: origem, rota });
      config.responseBodyCache.set(cacheKey, body);
      body.catch(() => config.responseBodyCache.delete(cacheKey));
      // Teto do cache: com a origem na chave, alguém mandando mil Hosts diferentes não enche a
      // memória — sai a entrada mais antiga (a próxima requisição dela só recomprime).
      while (config.responseBodyCache.size > RESPONSE_CACHE_MAX) {
        config.responseBodyCache.delete(config.responseBodyCache.keys().next().value);
      }
    }
    const data = await body;

    headers["Vary"] = "Accept-Encoding";
    if (encoding !== "identity") headers["Content-Encoding"] = encoding;
    headers["Content-Length"] = data.length;
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : data);
    return;
  }

  headers["Content-Length"] = fileStats.size;
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

/* ------------------------------------------------------------------------------------------ */
/* Aplicação                                                                                   */
/* ------------------------------------------------------------------------------------------ */

// "https://pesquisa.exemplo.com.br/" → "https://pesquisa.exemplo.com.br". Qualquer outra coisa
// (sem protocolo http/https, com caminho estranho) desliga as metas absolutas em vez de quebrar a página.
function normalizarSiteUrl(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto) return "";
  try {
    const url = new URL(texto);
    if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) return "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** Só páginas que existem no config, só http(s), e "off"/vazio = sem webhook. */
function normalizarWebhooksInscricao(fonte) {
  const saida = {};
  if (!isPlainObject(fonte)) return saida;
  for (const pagina of PAGINAS_CHECKOUT) {
    const valor = typeof fonte[pagina.id] === "string" ? fonte[pagina.id].trim() : "";
    if (!valor || valor.toLowerCase() === "off") continue;
    try {
      const url = new URL(valor);
      if (url.protocol === "https:" || url.protocol === "http:") saida[pagina.id] = url.toString();
    } catch {
      // Endereço torto: sem webhook para esta página (e o aviso de configuração no log do processo).
    }
  }
  return saida;
}

function normalizarPixelId(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto || texto.toLowerCase() === "off") return "";
  // Só dígitos: o id vai parar dentro de um <script>, então nada além de número entra ali.
  return /^\d{5,20}$/.test(texto) ? texto : "";
}

/* ------------------------------------------------------------------------------------------ */
/* POST /api/atualizacao-perfil — o caminho curto do UnniChat                                   */
/*                                                                                              */
/* Contato + profissão, nada mais. Grava na MESMA tabela da pesquisa (pesquisa_salvar), com      */
/* pesquisa = "atualizacao-perfil": a view pesquisa_pessoas continua sendo uma linha por pessoa  */
/* por pesquisa, o GET /api/leads/perfil acha as duas, e os números do painel de ICP não são     */
/* contaminados por quem respondeu só uma pergunta.                                             */
/* ------------------------------------------------------------------------------------------ */

async function handleAtualizacaoPerfil(request, response, options) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");
  if (!acceptsJsonBody(request, response)) return;

  if (!options.allowSalvar(request)) {
    sendJson(response, 429, { ok: false, error: "too_many_requests" });
    return;
  }

  const body = await readObjectBody(request, response);
  if (!body) return;

  const validacao = validarContato(body.contato);
  if (validacao.campos) {
    sendJson(response, 422, { ok: false, error: "invalid_contact", campos: validacao.campos });
    return;
  }
  const { contato } = validacao;
  if ((await options.checkEmailDomain(leadRules.emailDomain(contato.email))) === "missing") {
    sendJson(response, 422, { ok: false, error: "invalid_contact", campos: { email: leadRules.MESSAGES.email.domain } });
    return;
  }

  // O perfil vem como o rótulo da tela e é conferido contra a pergunta 1 da pesquisa: uma lista só
  // no projeto. O código interno (auxiliar_atendente, cuidador, ...) sai do mesmo PERFIL_CODIGO.
  const perfil = typeof body.perfil === "string" ? body.perfil.trim() : "";
  const profession = valorDoPerfil(pesquisa.PERFIL_CODIGO, perfil);
  if (!profession) {
    sendJson(response, 422, { ok: false, error: "invalid_perfil" });
    return;
  }

  if (!supabaseEnabled(options)) {
    sendJson(response, 503, { ok: false, error: "database_not_configured" });
    return;
  }

  const rastreio = normalizarRastreio(body.rastreio);
  const paginaObrigado = paginaObrigadoDoPerfil(perfil);

  const p = {
    id: normalizarUuid(body.id) || randomUUID(),
    pesquisa: PESQUISA_ATUALIZACAO,
    pesquisa_versao: pesquisa.VERSAO,
    visitante_id: normalizarUuid(body.visitante_id),
    // seq alto e fixo: esta pesquisa tem uma resposta só, e um reenvio nunca "volta no tempo".
    seq: 1,
    ...contato,
    perfil,
    respostas: { perfil },
    pergunta_atual: "fim",
    etapa_atual: 1,
    posicao: 1,
    pergunta_posicao: "fim",
    etapa_posicao: 1,
    respondidas: 1,
    obrigatorias: 1,
    obrigatorias_respondidas: 1,
    total_perguntas: 1,
    progresso_percentual: 100,
    completa: true,
    finalizou: true,
    tempos: {},
    ...rastreio
  };

  let resultado;
  try {
    resultado = await readObjectResponse(await callRpc(options, "pesquisa_salvar", { p }));
  } catch (error) {
    console.error(`Falha ao salvar a atualização de perfil: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
    return;
  }

  // O gatilho da sequência no WhatsApp, UMA vez por pessoa: finalizou_agora só vem true quando
  // esta linha fecha pela primeira vez. Sem await — quem está na tela não espera o n8n.
  if (resultado.finalizou_agora === true && options.perfilWebhookUrl) {
    avisarPerfil(options, { linha: resultado.linha, id: p.id, contato, perfil, rastreio }).catch((error) => {
      console.error(`Falha inesperada ao avisar o webhook do perfil: ${error?.message || "erro"}`);
    });
  }

  console.log(`atualizacao-perfil: perfil ${profession} gravado`);
  sendJson(response, 200, { ok: true, profession, obrigado: paginaObrigado ? paginaObrigado.rota : null });
}

/* ------------------------------------------------------------------------------------------ */
/* POST /api/integrations/manychat/lead — o lead que vem da DM do Instagram                    */
/*                                                                                              */
/* O ManyChat coleta nome, e-mail, telefone e profissão na conversa e manda UM post. Aqui nada é */
/* inventado: contato passa pelo validarContato (a mesma régua da pesquisa e da inscrição), a    */
/* profissão vira um dos rótulos do projeto (ou o GRUPO "enfermagem", quando a DM não separa     */
/* técnica de enfermeira) e a gravação é o mesmo pesquisa_salvar de todo o resto. A ramificação  */
/* do funil continua no ManyChat: o servidor só guarda e responde.                              */
/* ------------------------------------------------------------------------------------------ */

/** Chave de comparação de profissão: sem acento, sem caixa e sem pontuação. */
function chaveDoPerfil(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * O que a automação manda -> o rótulo que vai para a coluna `perfil`.
 *
 * Aceita os códigos internos (os quatro do projeto e o grupo), os rótulos da tela e as variações
 * que a DM costuma escrever. O que não estiver aqui é recusado: melhor um 400 do que um lead com
 * profissão adivinhada.
 */
const PERFIL_DA_AUTOMACAO = new Map(
  [
    // Auxiliar / antiga atendente
    [pesquisa.PERFIL.auxiliar, ["auxiliar_atendente", "auxiliar", "atendente", "auxiliar/antiga atendente", "auxiliar ou antiga atendente", "auxiliar de enfermagem", "atendente de enfermagem", pesquisa.PERFIL.auxiliar]],
    // Cuidador
    [pesquisa.PERFIL.cuidador, ["cuidador", "cuidadora", "cuidador(a)", "cuidador de idosos", pesquisa.PERFIL.cuidador]],
    // As duas profissões separadas, para quando a DM perguntar qual das duas
    [pesquisa.PERFIL.tecnico, ["tecnico_enfermagem", "tecnico", "tecnica", "tecnico de enfermagem", "tecnica de enfermagem", pesquisa.PERFIL.tecnico]],
    [pesquisa.PERFIL.enfermeiro, ["enfermeiro", "enfermeira", "enfermeiro(a)", pesquisa.PERFIL.enfermeiro]],
    // O grupo: a DM só perguntou "enfermagem" e não sabe qual das duas
    [
      pesquisa.PERFIL_GRUPO.enfermagem.rotulo,
      ["enfermagem", "tecnico de enfermagem/enfermeiro", "tecnico_enfermagem_ou_enfermeiro", "tecnicos e enfermeiros", pesquisa.PERFIL_GRUPO.enfermagem.rotulo]
    ]
  ].flatMap(([rotulo, entradas]) => entradas.map((entrada) => [chaveDoPerfil(entrada), rotulo]))
);

function perfilDaAutomacao(valor) {
  const chave = chaveDoPerfil(valor);
  return chave && PERFIL_DA_AUTOMACAO.has(chave) ? PERFIL_DA_AUTOMACAO.get(chave) : null;
}

/**
 * A MESMA pessoa que já entrou por aqui, para não duplicar lead. Na ordem que o cliente pediu:
 * id do ManyChat, telefone e e-mail — três consultas curtas, todas em colunas indexadas, e a
 * primeira que achar manda. Procura só dentro dos leads do ManyChat: a linha da pessoa na pesquisa
 * de ICP ou na atualização por WhatsApp é outra coisa e não pode ser sobrescrita por aqui.
 */
async function leadManychatExistente(options, { contactId, digits, email }) {
  const base = `pesquisa_respostas?pesquisa=eq.${encodeURIComponent(PESQUISA_MANYCHAT)}&select=id,seq,criado_em&order=criado_em.asc&limit=1`;
  const buscas = [
    contactId ? `&respostas->>manychat_contact_id=eq.${encodeURIComponent(contactId)}` : "",
    digits ? `&whatsapp_digits=eq.${encodeURIComponent(digits)}` : "",
    email ? `&email=eq.${encodeURIComponent(email)}` : ""
  ].filter(Boolean);

  for (const busca of buscas) {
    const linha = await primeiraLinha(options, `${base}${busca}`);
    if (linha && linha.id) return linha;
  }
  return null;
}

async function handleManychatLead(request, response, options) {
  if (request.method !== "POST") return methodNotAllowed(response, "POST");

  const recusar = (status, erro, extra = {}) => sendJson(response, status, { success: false, error: erro, ...extra });

  // Chave no header (padrão do projeto) ou em ?chave=, para ferramenta que só deixa preencher a URL.
  if (!options.manychatApiKey) return recusar(503, "api_key_not_configured");
  const chaveDaUrl = new URL(request.url, "http://localhost").searchParams.get("chave");
  const chave = String(request.headers["x-api-key"] || chaveDaUrl || "");
  if (!segredoIgual(chave, options.manychatApiKey)) return recusar(401, "unauthorized");

  if (!options.allowSalvar(request)) return recusar(429, "too_many_requests");

  // Corpo lido aqui (e não pelo readObjectBody) para o ManyChat receber SEMPRE o mesmo contrato:
  // qualquer corpo que não sirva é 400 { success: false, error: "invalid_payload" }.
  let body;
  try {
    body = await readJsonBody(request, MAX_BODY_BYTES);
  } catch (error) {
    return recusar(Number(error?.statusCode) === 413 ? 413 : 400, error?.message === "payload_too_large" ? "payload_too_large" : "invalid_payload");
  }
  if (!isPlainObject(body)) return recusar(400, "invalid_payload");

  // Erro nº 1 de quem monta a automação: a variável chega CRUA ("{{cuf_10976209}}") porque o campo
  // está vazio para aquele contato, ou porque o teste rodou sem contato de teste. Sem esta checagem
  // a resposta seria "Confere o nome: use só letras", que não ajuda ninguém a achar o problema.
  const cru = ["nome", "email", "telefone", "whatsapp", "phone", "profissao", "perfil", "profession", "origem_detalhe", "anuncio"]
    .filter((campo) => typeof body[campo] === "string" && /\{\{.*\}\}/.test(body[campo]));
  if (cru.length) {
    console.warn(`manychat/lead: variável não substituída em ${cru.join(", ")}`);
    return recusar(400, "unsubstituted_variable", {
      campos_crus: cru,
      dica: "O ManyChat mandou a variável no lugar do valor. Esse campo está vazio para o contato de teste — escolha um contato que já respondeu a DM, ou preencha os campos dele antes de testar."
    });
  }

  // O contato passa pela régua de sempre: maiúsculas certas, telefone em (DD) 9xxxx-xxxx + dígitos,
  // e-mail minúsculo e com formato válido. Só o sobrenome não é exigido aqui: na DM não existe
  // segunda chance — quem responde "Maria" perderia a vaga em vez de virar lead.
  const validacao = validarContato(
    { nome: body.nome, whatsapp: body.telefone ?? body.whatsapp ?? body.phone, email: body.email },
    { nomeSimples: true }
  );
  if (validacao.campos) return recusar(400, "invalid_payload", { campos: validacao.campos });
  const { contato } = validacao;

  if ((await options.checkEmailDomain(leadRules.emailDomain(contato.email))) === "missing") {
    return recusar(400, "invalid_payload", { campos: { email: leadRules.MESSAGES.email.domain } });
  }

  const perfil = perfilDaAutomacao(body.profissao ?? body.perfil ?? body.profession);
  if (!perfil) return recusar(400, "invalid_payload", { campos: { profissao: "Profissão não reconhecida." } });
  const profession = pesquisa.codigoDoPerfil(perfil);

  if (!supabaseEnabled(options)) return recusar(503, "database_not_configured");

  const contactId = textoOuNull(typeof body.manychat_contact_id === "string" || typeof body.manychat_contact_id === "number" ? String(body.manychat_contact_id).slice(0, 120) : "");

  let existente;
  try {
    existente = await leadManychatExistente(options, { contactId, digits: contato.whatsapp_digits, email: contato.email });
  } catch (error) {
    console.error(`Falha ao procurar o lead do ManyChat: ${error?.message || "erro"}`);
    return recusar(502, "database_unavailable");
  }

  const id = existente ? existente.id : randomUUID();
  const p = {
    id,
    pesquisa: PESQUISA_MANYCHAT,
    pesquisa_versao: pesquisa.VERSAO,
    // seq sempre maior que o da linha: é o que faz pesquisa_salvar aplicar a atualização.
    seq: existente ? Number(existente.seq || 0) + 1 : 1,
    ...contato,
    perfil,
    // O id do ManyChat mora no jsonb que já existe (respostas), junto da profissão: nada de coluna
    // nem migration para guardar um identificador externo.
    respostas: contactId ? { perfil, manychat_contact_id: contactId } : { perfil },
    pergunta_atual: "fim",
    etapa_atual: 1,
    posicao: 1,
    pergunta_posicao: "fim",
    etapa_posicao: 1,
    respondidas: 1,
    obrigatorias: 1,
    obrigatorias_respondidas: 1,
    total_perguntas: 1,
    progresso_percentual: 100,
    completa: true,
    // Sem finalizou: este lead não dispara aviso ao n8n — o ManyChat já continua a conversa dele.
    finalizou: false,
    tempos: {},
    // Origem decidida AQUI, nunca pelo corpo do pedido. São colunas de primeiro toque: numa
    // atualização, o pesquisa_salvar guarda a origem que já estava lá.
    ...ORIGEM_MANYCHAT,
    // De onde no Instagram: qual post, automação ou palavra-chave trouxe a pessoa (utm_content) e
    // qual anúncio (utm_term). São os dois campos que o ManyChat PODE mandar — o resto da origem
    // continua sendo do servidor. Vazio não atrapalha nada.
    utm_content: textoOuNull(typeof body.origem_detalhe === "string" ? body.origem_detalhe.slice(0, 200) : ""),
    utm_term: textoOuNull(typeof body.anuncio === "string" ? body.anuncio.slice(0, 200) : "")
  };

  try {
    await callRpc(options, "pesquisa_salvar", { p });
  } catch (error) {
    console.error(`Falha ao salvar o lead do ManyChat: ${error?.message || "erro"}`);
    return recusar(502, "database_unavailable");
  }

  const action = existente ? "updated" : "created";
  console.log(`manychat/lead: ${action} ${telefoneNoLog(contato.whatsapp_digits)} perfil ${profession}`);
  sendJson(response, 200, {
    success: true,
    action,
    lead_id: id,
    profession,
    phone: `55${contato.whatsapp_digits}`,
    source: ORIGEM_MANYCHAT.utm_source
  });
}

/* ------------------------------------------------------------------------------------------ */
/* GET /api/leads/perfil — a consulta do UnniChat                                              */
/*                                                                                              */
/* O UnniChat dispara o template no WhatsApp, a pessoa responde a pesquisa aqui e ele volta para */
/* perguntar UMA coisa: que profissão este telefone escolheu na pergunta 1. Com isso ele escolhe */
/* o funil (aferição, cuidador, evento). Por isso a resposta é mínima e a consulta é um índice:  */
/* `perfil` já é COLUNA em pesquisa_respostas (não precisa abrir o JSON das respostas) e         */
/* whatsapp_digits é indexado. O código interno sai do mesmo PERFIL_CODIGO que o n8n e o CSV já  */
/* usam, então os quatro valores nunca saem de sincronia com a tela.                            */
/* ------------------------------------------------------------------------------------------ */

// ?formato=texto: cada situação vira UMA palavra, para a condição do fluxo comparar direto.
const PALAVRA_DO_ERRO = Object.freeze({
  lead_not_found: "nao_encontrado",
  invalid_phone: "telefone_invalido",
  invalid_id: "id_invalido",
  unauthorized: "nao_autorizado",
  too_many_requests: "muitas_consultas",
  api_key_not_configured: "erro",
  database_not_configured: "erro",
  database_unavailable: "erro"
});

const LEADS_RATE_LIMIT_MAX = 1200;
const LEADS_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * O telefone como o banco guarda: DDD + número, sem o 55 e sem o zero de operadora.
 *
 * Reaproveita normalizePhoneDigits (a mesma régua da tela), que já resolve "+55 45 99999-9999" e
 * "045999999999". O corte extra do 55 cobre o formato que o UnniChat manda (5545999999999, 13
 * dígitos, e 554599999999, 12, de número antigo sem o nono).
 */
function telefoneParaDigitos(bruto) {
  let digitos = leadRules.normalizePhoneDigits(String(bruto || "").slice(0, 40));
  if (digitos.length > 11 && digitos.startsWith("55")) digitos = digitos.slice(2);
  return digitos;
}

/** Telefone no log sem virar cadastro exposto: 5545*****999. */
function telefoneNoLog(digitos) {
  if (!digitos) return "(vazio)";
  const cheio = `55${digitos}`;
  return `${cheio.slice(0, 4)}${"*".repeat(Math.max(0, cheio.length - 7))}${cheio.slice(-3)}`;
}

/** A primeira linha de uma consulta PostgREST, ou null. */
async function primeiraLinha(options, restPath) {
  const resposta = await supabaseRequest(options, restPath);
  const linhas = await resposta.json();
  return Array.isArray(linhas) && linhas.length ? linhas[0] : null;
}

/**
 * Responde ao UnniChat. `idDireto` vem da rota /api/leads/perfil/<id> (a tentativa da pesquisa);
 * sem ele, a busca é pelo telefone, que é o caminho principal.
 *
 * Nunca 500 por lead que ainda não respondeu: quem existe e não respondeu volta 200 com
 * responded=false, e só telefone que não existe em lugar nenhum volta 404.
 */
async function handleLeadPerfil(request, response, options, idDireto = "") {
  if (request.method !== "GET") return methodNotAllowed(response, "GET");

  const params = new URL(request.url, "http://localhost").searchParams;
  // Ferramenta de automação que só deixa preencher a URL não manda header nem lê JSON. Para ela:
  // a chave vai em ?chave= (como no webhook da Hotmart) e ?formato=texto devolve UMA palavra —
  // a profissão, ou o porquê de não ter. Quem manda header e lê JSON continua igual.
  const modoTexto = String(params.get("formato") || "").trim().toLowerCase() === "texto";
  const semLead = (status, erro, telefone = null) =>
    modoTexto
      ? // "não encontrado" em texto é 200 de propósito: é resposta, não erro, e assim a condição
        // do fluxo compara palavra com palavra sem depender da saída de falha do nó.
        sendTexto(response, erro === "lead_not_found" ? 200 : status, PALAVRA_DO_ERRO[erro] || "erro")
      : sendJson(response, status, { success: false, responded: false, phone: telefone, profession: null, error: erro });
  const comPerfil = (corpo) => (modoTexto ? sendTexto(response, 200, corpo.profession || "sem_perfil") : sendJson(response, 200, corpo));

  if (!options.unnichatApiKey) return semLead(503, "api_key_not_configured");
  const chave = String(request.headers["x-api-key"] || params.get("chave") || "");
  if (!segredoIgual(chave, options.unnichatApiKey)) return semLead(401, "unauthorized");

  if (!options.allowLeads(request)) return semLead(429, "too_many_requests");
  if (!supabaseEnabled(options)) return semLead(503, "database_not_configured");

  const digitos = idDireto ? "" : telefoneParaDigitos(params.get("telefone") ?? params.get("phone") ?? "");
  const telefone = digitos ? `55${digitos}` : null;

  if (!idDireto && digitos.length < 10) {
    console.log(`leads/perfil: telefone inválido (${telefoneNoLog(digitos)})`);
    return semLead(422, "invalid_phone", telefone);
  }
  if (idDireto && !UUID_PATTERN.test(idDireto)) return semLead(422, "invalid_id");

  try {
    const filtro = idDireto
      ? `id=eq.${encodeURIComponent(idDireto)}`
      : // As três origens: o mapeamento completo (/pesquisa-icp), a atualização curta
        // (/atualizacao-perfil) e o lead da DM do Instagram (ManyChat). Quem respondeu em mais de
        // uma volta pela linha que TEM perfil.
        `pesquisa=in.(${encodeURIComponent(pesquisa.ID)},${encodeURIComponent(PESQUISA_ATUALIZACAO)},${encodeURIComponent(PESQUISA_MANYCHAT)})` +
        `&whatsapp_digits=eq.${encodeURIComponent(digitos)}&order=perfil.asc.nullslast,atualizado_em.desc`;
    const pessoa = await primeiraLinha(
      options,
      `pesquisa_pessoas?${filtro}&select=id,whatsapp_digits,whatsapp_internacional,perfil,concluido_em&limit=1`
    );

    if (pessoa) {
      // codigoDoPerfil entende as quatro profissões E o grupo "enfermagem" (lead do ManyChat).
      const profession = pesquisa.codigoDoPerfil(pessoa.perfil);
      const phone = pessoa.whatsapp_internacional || (pessoa.whatsapp_digits ? `55${pessoa.whatsapp_digits}` : telefone);
      console.log(
        `leads/perfil: ${telefoneNoLog(pessoa.whatsapp_digits || digitos)} respondeu a pesquisa; profissão ${profession || "(ainda não escolheu)"}`
      );
      return comPerfil({ success: true, responded: Boolean(profession), phone, profession: profession ?? null });
    }

    // Quem entrou por uma página de inscrição (Viver de Furo, Imersão GPS) existe como lead, mas
    // ainda não respondeu a pesquisa: é responded=false, não "não existe".
    if (!idDireto) {
      const inscrito = await primeiraLinha(
        options,
        `inscricoes?whatsapp_digits=eq.${encodeURIComponent(digitos)}&select=id,whatsapp_internacional&limit=1`
      );
      if (inscrito) {
        console.log(`leads/perfil: ${telefoneNoLog(digitos)} é lead de inscrição e ainda não respondeu a pesquisa`);
        return comPerfil({ success: true, responded: false, phone: inscrito.whatsapp_internacional || telefone, profession: null });
      }
    }

    console.log(`leads/perfil: ${idDireto ? `id ${idDireto}` : telefoneNoLog(digitos)} não encontrado`);
    return semLead(404, "lead_not_found", telefone);
  } catch (error) {
    console.error(`Falha ao consultar o perfil do lead: ${error?.message || "erro"}`);
    return semLead(502, "database_unavailable", telefone);
  }
}

/**
 * Tudo injetável para teste. Sem credenciais explícitas, nada é gravado nem encaminhado — evita
 * envio acidental a partir de testes e scripts.
 */
export function createServerApp({
  rootDirectory = moduleDirectory,
  supabaseUrl = "",
  supabaseKey = "",
  painelEmail = "",
  painelSenhaHash = "",
  painelSessaoSegredo = "",
  // Webhook de venda da Hotmart. Sem nenhuma das duas, POST /api/hotmart/venda responde 503.
  hotmartHottok = "",
  hotmartChave = "",
  // Chave que o UnniChat manda no header X-API-Key para consultar o perfil de um telefone.
  unnichatApiKey = "",
  // Chave que o ManyChat manda no header X-API-Key ao entregar um lead da DM do Instagram.
  manychatApiKey = "",
  webhookUrl = "",
  // Para onde vai o aviso de perfil atualizado (/atualizacao-perfil). Vazio = ninguém é avisado.
  perfilWebhookUrl = "",
  webhookEsperasMs = WEBHOOK_ESPERAS_MS,
  siteUrl = "",
  // Origens extras que podem mandar o POST /api/inscricao (além das `origem` do checkout-config).
  origensInscricao = [],
  // { id da página: URL do webhook do n8n } — cada inscrição nova daquela página vai para lá.
  webhooksInscricao = {},
  // Reenvio automático ao n8n: desligado por padrão (teste nenhum dispara varredura sozinho).
  // true liga com 30 s / 10 min; um objeto { atrasoInicialMs, intervaloMs } troca os tempos.
  reenvio = false,
  metaPixelId = DEFAULT_META_PIXEL_ID,
  fetchImpl = globalThis.fetch,
  resolveEmailDomain = createDnsEmailDomainResolver(),
  now = () => Date.now()
} = {}) {
  const agora = () => {
    const valor = now();
    return valor instanceof Date ? valor.getTime() : Number(valor);
  };

  const options = {
    rootDirectory,
    supabaseUrl,
    supabaseKey,
    painelEmail,
    painelSenhaHash,
    painelSessaoSegredo,
    hotmartHottok,
    hotmartChave,
    unnichatApiKey: String(unnichatApiKey || "").trim(),
    manychatApiKey: String(manychatApiKey || "").trim(),
    webhookUrl: String(webhookUrl || "").trim().toLowerCase() === "off" ? "" : webhookUrl,
    perfilWebhookUrl:
      String(perfilWebhookUrl || "").trim().toLowerCase() === "off" ? "" : String(perfilWebhookUrl || "").trim(),
    webhookEsperasMs: Array.isArray(webhookEsperasMs) && webhookEsperasMs.length ? webhookEsperasMs : WEBHOOK_ESPERAS_MS,
    siteUrl: normalizarSiteUrl(siteUrl),
    webhooksInscricao: normalizarWebhooksInscricao(webhooksInscricao),
    origensInscricao: new Set(
      [...checkout.ORIGENS, ...(Array.isArray(origensInscricao) ? origensInscricao : [])].map(normalizarOrigem).filter(Boolean)
    ),
    metaPixelId: normalizarPixelId(metaPixelId),
    fetchImpl,
    now: agora,
    checkEmailDomain: createCachedDomainChecker(resolveEmailDomain, agora),
    responseBodyCache: new Map(),
    allowEvento: createRateLimiter({ windowMs: EVENTO_RATE_LIMIT_WINDOW_MS, max: EVENTO_RATE_LIMIT_MAX, now: agora }),
    allowPaginaEvento: createRateLimiter({ windowMs: EVENTO_RATE_LIMIT_WINDOW_MS, max: EVENTO_RATE_LIMIT_MAX, now: agora }),
    allowSalvar: createRateLimiter({ windowMs: SALVAR_RATE_LIMIT_WINDOW_MS, max: SALVAR_RATE_LIMIT_MAX, now: agora }),
    allowInscricao: createRateLimiter({ windowMs: INSCRICAO_RATE_LIMIT_WINDOW_MS, max: INSCRICAO_RATE_LIMIT_MAX, now: agora }),
    allowLogin: createRateLimiter({ windowMs: PAINEL_LOGIN_WINDOW_MS, max: PAINEL_LOGIN_MAX, now: agora }),
    allowLeads: createRateLimiter({ windowMs: LEADS_RATE_LIMIT_WINDOW_MS, max: LEADS_RATE_LIMIT_MAX, now: agora })
  };

  const rotas = new Map([
    ["/api/pesquisa/evento", handleEvento],
    ["/api/pesquisa/salvar", handleSalvar],
    ["/api/pagina/evento", handlePaginaEvento],
    ["/api/inscricao", handleInscricao],
    ["/api/hotmart/venda", handleHotmartVenda],
    ["/api/integrations/manychat/lead", handleManychatLead],
    ["/api/atualizacao-perfil", handleAtualizacaoPerfil],
    ["/api/leads/perfil", handleLeadPerfil],
    ["/api/painel/login", handleLogin],
    ["/api/painel/logout", handleLogout],
    [
      "/api/painel/sessao",
      (request, response) => {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        const session = requirePainel(request, response, options);
        if (session) sendJson(response, 200, { ok: true, email: session.email });
      }
    ],
    ["/api/painel/resumo", handleResumo],
    ["/api/painel/respostas", handleRespostas],
    ["/api/painel/abertas", handleAbertas],
    ["/api/painel/cruzamento", handleCruzamento],
    ["/api/painel/paginas", handlePaginas],
    ["/api/painel/inscricoes", handleInscricoesPainel],
    ["/api/painel/perfis", handlePerfisPainel],
    ["/api/painel/exportar.csv", handleExportarCsv],
    ["/api/painel/exportar-inscricoes.csv", handleExportarInscricoesCsv]
  ]);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");

      if (url.pathname === "/") {
        // A raiz é o link que vai nos anúncios: o redirect leva junto a query (UTMs, fbclid).
        response.writeHead(302, { Location: `${PESQUISA_ROTA}${url.search}`, "Cache-Control": "no-cache" });
        response.end();
        return;
      }

      if (PESQUISA_ROTAS_ANTIGAS.has(url.pathname)) {
        // Endereço antigo da pesquisa: 301 para o novo, com a query (os UTMs do link antigo valem).
        response.writeHead(301, { Location: `${PESQUISA_ROTA}${url.search}`, "Cache-Control": "no-cache" });
        response.end();
        return;
      }

      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }

      const rota = rotas.get(url.pathname);
      if (rota) {
        await rota(request, response, options);
        return;
      }

      // /api/leads/perfil/<id da tentativa>: mesmo handler, buscando pelo id em vez do telefone.
      if (url.pathname.startsWith("/api/leads/perfil/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/leads/perfil/".length)).trim();
        await handleLeadPerfil(request, response, options, id);
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }

      await serveStatic(request, response, options);
    } catch (error) {
      console.error(`Erro inesperado: ${error?.message || "erro"}`);
      if (!response.headersSent) sendJson(response, 500, { ok: false, error: "internal_error" });
      else response.destroy();
    }
  });

  // Sem webhook nenhum (pesquisa e perfil) ou sem banco, não há o que reenviar: a varredura nem existe.
  if (reenvio && (options.webhookUrl || options.perfilWebhookUrl) && supabaseEnabled(options)) {
    const varredura = criarReenvio(options, reenvio === true ? {} : reenvio);
    server.reenvio = varredura;
    server.on("listening", () => varredura.iniciar());
    server.on("close", () => varredura.parar());
  } else {
    server.reenvio = null;
  }
  // A mesma ideia para as inscrições das páginas com webhook (a Imersão GPS).
  if (reenvio && Object.keys(options.webhooksInscricao).length && supabaseEnabled(options)) {
    const varreduraInscricoes = criarReenvioInscricoes(options, reenvio === true ? {} : reenvio);
    server.reenvioInscricoes = varreduraInscricoes;
    server.on("listening", () => varreduraInscricoes.iniciar());
    server.on("close", () => varreduraInscricoes.parar());
  } else {
    server.reenvioInscricoes = null;
  }
  return server;
}

/**
 * Lê o .env ao lado do server.mjs, se existir: linhas CHAVE=VALOR, ignora comentário (#) e linha
 * vazia, tira aspas em volta do valor e NUNCA sobrescreve variável que já veio do ambiente (no
 * Railway as variáveis vêm do painel dele, e elas mandam). Parser mínimo de propósito: sem
 * dependência, e sem expandir $ — o hash scrypt tem $ e precisa chegar inteiro.
 */
export function carregarEnv(caminho, env = process.env) {
  let texto;
  try {
    texto = readFileSync(caminho, "utf8");
  } catch {
    return 0;
  }
  let carregadas = 0;
  for (const linhaBruta of texto.split(/\r?\n/)) {
    const linha = linhaBruta.trim();
    if (!linha || linha.startsWith("#")) continue;
    const semExport = linha.startsWith("export ") ? linha.slice(7).trim() : linha;
    const igual = semExport.indexOf("=");
    if (igual < 1) continue;
    const chave = semExport.slice(0, igual).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) continue;
    let valor = semExport.slice(igual + 1).trim();
    const aspas = valor[0];
    if ((aspas === '"' || aspas === "'") && valor.length >= 2 && valor.endsWith(aspas)) valor = valor.slice(1, -1);
    if (env[chave] !== undefined) continue;
    env[chave] = valor;
    carregadas += 1;
  }
  return carregadas;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  carregarEnv(path.join(moduleDirectory, ".env"));
  const env = process.env;
  const port = Number.parseInt(env.PORT || "3000", 10);
  const metaPixelId = env.META_PIXEL_ID === undefined || env.META_PIXEL_ID === "" ? DEFAULT_META_PIXEL_ID : env.META_PIXEL_ID;

  // Um aviso por configuração ausente, sem nunca imprimir o valor de um segredo.
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("Aviso: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY ausentes — a pesquisa responde 503 ao gravar e o painel fica sem dados.");
  }
  for (const nome of ["PAINEL_EMAIL", "PAINEL_SENHA_HASH", "PAINEL_SESSAO_SEGREDO"]) {
    if (!env[nome]) console.warn(`Aviso: ${nome} ausente — o login do painel responde 503.`);
  }
  const webhookEnv = String(env.PESQUISA_WEBHOOK_URL || "").trim();
  const webhookUrl = webhookEnv.toLowerCase() === "off" ? "" : webhookEnv || DEFAULT_WEBHOOK_URL;
  if (!webhookUrl) console.warn("Aviso: PESQUISA_WEBHOOK_URL=off — nenhuma pesquisa concluída será enviada ao n8n.");
  const perfilEnv = String(env.PERFIL_WEBHOOK_URL || "").trim();
  const perfilWebhookUrl = perfilEnv.toLowerCase() === "off" ? "" : perfilEnv;
  if (!perfilWebhookUrl) {
    console.log(`PERFIL_WEBHOOK_URL não configurada: quem atualizar o perfil é gravado normalmente, e nenhum aviso é disparado (exemplo de endereço: ${EXEMPLO_PERFIL_WEBHOOK_URL}).`);
  }
  if (!normalizarSiteUrl(env.SITE_URL)) console.warn("Aviso: SITE_URL ausente — og:url, canonical e a imagem da prévia usam o endereço de cada requisição (Host/X-Forwarded-Host).");
  if (!normalizarPixelId(metaPixelId)) console.warn("Aviso: Meta Pixel desligado (META_PIXEL_ID = off ou inválido).");

  if (String(env.GPS_WEBHOOK_URL || "").trim().toLowerCase() === "off") {
    console.warn("Aviso: GPS_WEBHOOK_URL=off — as inscrições da Imersão GPS não vão para o n8n (só para o painel).");
  }
  if (!env.HOTMART_HOTTOK && !env.HOTMART_WEBHOOK_CHAVE) {
    console.warn("Aviso: HOTMART_HOTTOK e HOTMART_WEBHOOK_CHAVE ausentes — o webhook de venda da Hotmart responde 503 e nenhuma compra é registrada.");
  }

  if (!env.UNNICHAT_API_KEY) {
    console.warn("Aviso: UNNICHAT_API_KEY ausente — GET /api/leads/perfil responde 503 e o UnniChat não consulta o perfil.");
  }

  if (!env.MANYCHAT_API_KEY) {
    console.warn("Aviso: MANYCHAT_API_KEY ausente — POST /api/integrations/manychat/lead responde 503 e nenhum lead do Instagram é gravado.");
  }

  const server = createServerApp({
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    painelEmail: env.PAINEL_EMAIL || "",
    painelSenhaHash: env.PAINEL_SENHA_HASH || "",
    painelSessaoSegredo: env.PAINEL_SESSAO_SEGREDO || "",
    hotmartHottok: env.HOTMART_HOTTOK || "",
    // Uma variável por produto, todas aceitas no mesmo endereço (cada uma vira um ?chave= próprio).
    hotmartChave: [env.HOTMART_WEBHOOK_CHAVE, env.HOTMART_WEBHOOK_CHAVE_2].map((valor) => String(valor || "").trim()).filter(Boolean).join(","),
    unnichatApiKey: env.UNNICHAT_API_KEY || "",
    manychatApiKey: env.MANYCHAT_API_KEY || "",
    webhookUrl,
    perfilWebhookUrl,
    siteUrl: env.SITE_URL || "",
    origensInscricao: String(env.INSCRICAO_ORIGENS || "").split(","),
    webhooksInscricao: {
      ...DEFAULT_WEBHOOKS_INSCRICAO,
      ...(env.GPS_WEBHOOK_URL !== undefined && env.GPS_WEBHOOK_URL !== "" ? { "imersao-gps": env.GPS_WEBHOOK_URL } : {})
    },
    metaPixelId,
    reenvio: true
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Servidor iniciado na porta ${server.address().port}.`);
  });

  // O Railway manda SIGTERM no deploy: termina o que está em voo em vez de cortar uma gravação.
  process.on("SIGTERM", () => {
    server.reenvio?.parar();
    server.reenvioInscricoes?.parar();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
