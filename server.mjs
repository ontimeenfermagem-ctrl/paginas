/*
 * server.mjs — servidor da Pesquisa de ICP da Escola Enfermagem de Valor.
 *
 * Node puro, sem dependência nenhuma (mesmo molde do quintino-landing): serve a pesquisa e o
 * painel como arquivos estáticos, recebe a gravação progressiva das respostas e entrega ao
 * painel os números calculados no Postgres (Supabase, via REST com a chave service_role, que
 * só existe aqui no servidor).
 *
 * As regras de negócio NÃO moram aqui: js/pesquisa-config.js (perguntas, sanitização,
 * progresso) e js/lead-rules.js (nome, WhatsApp, e-mail) são os mesmos arquivos que rodam no
 * navegador, carregados com vm. O que a tela aceita é exatamente o que o servidor grava.
 */
import { createHmac, scrypt, timingSafeEqual } from "node:crypto";
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
const EVENTO_RATE_LIMIT_MAX = 240;
const EVENTO_RATE_LIMIT_WINDOW_MS = 60_000;
// A pesquisa grava a cada resposta (39 perguntas em ~7 minutos, mais re-tentativas da fila):
// Cerca de 2 gravações por pergunta: 600/min por IP deixa folga para ~10 pessoas ao mesmo tempo
// atrás do mesmo IP de operadora (CGNAT), comum em disparo de campanha.
const SALVAR_RATE_LIMIT_MAX = 600;
const SALVAR_RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 5_000;

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

const routeAliases = new Map([
  [PESQUISA_ROTA, PESQUISA_PAGE],
  [`${PESQUISA_ROTA}/`, PESQUISA_PAGE],
  ["/painel", PAINEL_PAGE],
  ["/painel/", PAINEL_PAGE],
  ["/favicon.ico", "/img/favicon-32.png"]
]);

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
// Assíncrono de propósito: scrypt síncrono trava o event loop e derrubaria a pesquisa a cada login.
const scryptAsync = promisify(scrypt);

/* ------------------------------------------------------------------------------------------ */
/* Regras compartilhadas com o navegador                                                       */
/* ------------------------------------------------------------------------------------------ */

// Lidos do diretório DESTE arquivo, e não do rootDirectory: nos testes o estático vem de uma
// pasta de mentira, mas a regra que valida a gravação tem que ser sempre a de verdade.
function loadBrowserScript(relativePath, globalName) {
  const source = readFileSync(path.join(moduleDirectory, relativePath), "utf8");
  const context = {};
  vm.runInNewContext(source, context, { filename: relativePath });
  if (!context[globalName]) throw new Error(`${relativePath} não definiu ${globalName}`);
  return context[globalName];
}

const leadRules = loadBrowserScript("js/lead-rules.js", "EVLeadRules");
const pesquisa = loadBrowserScript("js/pesquisa-config.js", "EVPesquisa");

const PERGUNTAS = pesquisa.PERGUNTAS;
const POSICAO_FIM = PERGUNTAS.length + 1;
const INDICE_PERGUNTA = new Map(PERGUNTAS.map((pergunta, indice) => [pergunta.id, indice + 1]));
const PERFIS_VALIDOS = new Set(Object.values(pesquisa.PERFIL));
const CHAVES_TEXTO = Array.from(pesquisa.chavesTexto());
const CHAVES_TEXTO_SET = new Set(CHAVES_TEXTO);
const IDS_ANALISAVEIS = new Set(pesquisa.perguntasAnalisaveis().map((pergunta) => pergunta.id));
const CHAVES_TEMPO = new Set([...INDICE_PERGUNTA.keys(), "contato"]);
const DOMINIOS_CONHECIDOS = new Set(leadRules.KNOWN_DOMAINS);

/* ------------------------------------------------------------------------------------------ */
/* Utilidades                                                                                  */
/* ------------------------------------------------------------------------------------------ */

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

async function readJsonBody(request) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
async function readObjectBody(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
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
 * mensagens prontas, para a tela mostrar no campo certo.
 */
export function validarContato(fonte) {
  const c = isPlainObject(fonte) ? fonte : {};
  const campos = {};

  const nome = leadRules.normalizeName(typeof c.nome === "string" ? c.nome : "");
  // Um nome de 150 letras não é nome: é colagem errada, e a coluna não precisa guardar isso.
  const erroNome = nome.length > 150 ? "invalid" : leadRules.nameError(nome);
  if (erroNome) campos.nome = leadRules.message("name", erroNome);

  const whatsappBruto = typeof c.whatsapp === "string" ? c.whatsapp.slice(0, 40) : "";
  const whatsapp = leadRules.formatPhone(whatsappBruto);
  // phoneError sobre o valor cru: formatPhone corta no 11º dígito, e um número com dígito a
  // mais passaria como válido depois de formatado.
  const erroWhatsapp =
    leadRules.phoneError(whatsappBruto) || (FORMATTED_PHONE_PATTERN.test(whatsapp) ? "" : "incomplete");
  if (erroWhatsapp) campos.whatsapp = leadRules.message("phone", erroWhatsapp);

  const email = leadRules.normalizeEmail(typeof c.email === "string" ? c.email : "");
  const erroEmail = leadRules.emailError(email);
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
    perfil: typeof resp.perfil === "string" ? resp.perfil : null,
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
    const consulta = [
      "select=*",
      `pesquisa=eq.${encodeURIComponent(pesquisa.ID)}`,
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
      try {
        await forwardToWebhook({ payload: payloadDaLinha(linha, options.now()), webhookUrl: options.webhookUrl, fetchImpl: options.fetchImpl });
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
function lerFiltrosComuns(params) {
  const desdeTexto = safeString(params.get("desde"), 100);
  const ateTexto = safeString(params.get("ate"), 100);
  const desde = isoDateOrNull(desdeTexto);
  const ate = isoDateOrNull(ateTexto);
  if ((desdeTexto && !desde) || (ateTexto && !ate)) invalido();

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
    // Só procura no telefone quando a busca PARECE telefone (dígitos, espaço, +, ponto, traço).
    // Tirar os dígitos de "edna.4@hotmail.com" daria "4", e a lista traria todo WhatsApp com 4.
    if (/^[\d\s+.-]+$/.test(busca)) {
      const digits = leadRules.normalizePhoneDigits(busca);
      if (digits) filtros.push(`whatsapp_digits.ilike.*${digits}*`);
    }
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
    const resumo = await readObjectResponse(
      await callRpc(options, "pesquisa_painel", {
        p_desde: desde,
        p_ate: ate,
        p_perfil: perfil,
        // Texto livre não tem "valor mais comum": fica fora das distribuições.
        p_ignorar: CHAVES_TEXTO
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
    const limite = lerInteiro(params, "limite", { padrao: ABERTAS_PADRAO, minimo: 1, maximo: PAINEL_LIST_MAX });
    const offset = lerInteiro(params, "offset", { padrao: 0, minimo: 0 });

    const resultado = await readObjectResponse(
      await callRpc(options, "pesquisa_abertas", {
        p_chaves: Array.from(new Set(chaves)),
        p_desde: filtros.desde,
        p_ate: filtros.ate,
        p_perfil: filtros.perfil,
        p_limite: limite,
        p_offset: offset
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

    const cruzamento = await readObjectResponse(
      await callRpc(options, "pesquisa_cruzamento", {
        p_linha: linha,
        p_coluna: coluna,
        p_desde: filtros.desde,
        p_ate: filtros.ate,
        p_perfil: filtros.perfil
      })
    );
    return { cruzamento };
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
    ["email", (l) => l.email]
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

async function handleExportarCsv(request, response, options) {
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
  let base;
  let filtros;
  try {
    const tentativas = safeString(params.get("tentativas"), 20);
    if (tentativas && tentativas !== "todas") invalido();
    // "todas" = cada tentativa numa linha (tabela crua); o padrão é uma linha por pessoa (view).
    base = tentativas === "todas" ? "pesquisa_respostas" : "pesquisa_pessoas";
    filtros = { ...lerFiltrosComuns(params), status: lerStatus(params), busca: lerBusca(params) };
  } catch {
    sendJson(response, 422, { ok: false, error: "invalid_filters" });
    return;
  }

  // Ordem crescente de propósito: com offset, quem se inscrever durante a exportação entra no
  // FIM da lista, e nenhuma linha já baixada escorrega de página (em ordem decrescente, cada
  // inscrição nova empurraria uma linha para a página seguinte e ela sairia repetida).
  function pagina(offset) {
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
  }

  // A primeira página vem antes do cabeçalho HTTP: se o banco falhar logo de cara, a resposta
  // ainda pode ser um 502 decente em vez de um arquivo vazio.
  let linhas;
  try {
    linhas = await pagina(0);
  } catch (error) {
    console.error(`Falha ao exportar o CSV: ${error?.message || "erro"}`);
    sendJson(response, 502, { ok: false, error: "database_unavailable" });
    return;
  }

  let cancelado = false;
  response.on("close", () => {
    cancelado = true;
  });

  const dia = DIA_BRASILIA.format(new Date(options.now()));
  response.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="pesquisa-icp-${dia}.csv"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });

  // BOM: sem ele o Excel abre o UTF-8 como Latin-1 e "Técnico" vira "TÃ©cnico".
  await escrever(response, `\uFEFF${linhaCsv(COLUNAS_CSV.map((coluna) => coluna.cabecalho))}`);

  let offset = 0;
  try {
    for (;;) {
      for (const linha of linhas) {
        if (cancelado) return;
        await escrever(response, linhaCsv(COLUNAS_CSV.map((coluna) => coluna.valor(linha))));
      }
      if (linhas.length < EXPORT_PAGE_SIZE || cancelado) break;
      offset += EXPORT_PAGE_SIZE;
      linhas = await pagina(offset);
    }
    response.end();
  } catch (error) {
    // O 200 já saiu. Cortar a conexão faz o navegador marcar o download como falho, em vez de
    // entregar uma planilha pela metade parecendo completa.
    console.error(`Falha ao exportar o CSV no meio: ${error?.message || "erro"}`);
    response.destroy();
  }
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
function metaDoSite(source, siteUrl) {
  if (!siteUrl) return source;
  const pagina = `${siteUrl}${PESQUISA_ROTA}`;
  const imagem = `${siteUrl}/img/og-pesquisa.jpg`;
  return source
    .replace(/(<meta property="og:image" content=")\/img\/og-pesquisa\.jpg(")/, `$1${escapeAttr(imagem)}$2`)
    .replace(/(<meta name="twitter:image" content=")\/img\/og-pesquisa\.jpg(")/, `$1${escapeAttr(imagem)}$2`)
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

// O Pixel entra só na pesquisa. O painel tem dado pessoal na tela: nada de terceiros ali.
function transformPage(source, pathname, pixelId, siteUrl) {
  if (pathname !== PESQUISA_PAGE) return source;
  let saida = metaDoSite(source, siteUrl);
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

async function buildResponseBody({ filePath, pathname, extension, encoding, pixelId, siteUrl }) {
  let data = await readFile(filePath);
  if (extension === ".html") data = Buffer.from(transformPage(data.toString("utf8"), pathname, pixelId, siteUrl));

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
    // Só a pesquisa depende da origem. Sem SITE_URL ela vem da requisição, e por isso ENTRA NA
    // CHAVE do cache: um Host forjado só muda a página de quem o forjou, nunca a de outra pessoa.
    const origem = pathname === PESQUISA_PAGE ? config.siteUrl || origemDaRequisicao(request.headers) : "";
    // Cada arquivo é transformado e comprimido uma única vez por versão (mtime + tamanho).
    const cacheKey = [filePath, fileStats.mtimeMs, fileStats.size, encoding, origem].join("|");
    let body = config.responseBodyCache.get(cacheKey);
    if (!body) {
      body = buildResponseBody({ filePath, pathname, extension, encoding, pixelId: config.metaPixelId, siteUrl: origem });
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

function normalizarPixelId(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto || texto.toLowerCase() === "off") return "";
  // Só dígitos: o id vai parar dentro de um <script>, então nada além de número entra ali.
  return /^\d{5,20}$/.test(texto) ? texto : "";
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
  webhookUrl = "",
  webhookEsperasMs = WEBHOOK_ESPERAS_MS,
  siteUrl = "",
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
    webhookUrl: String(webhookUrl || "").trim().toLowerCase() === "off" ? "" : webhookUrl,
    webhookEsperasMs: Array.isArray(webhookEsperasMs) && webhookEsperasMs.length ? webhookEsperasMs : WEBHOOK_ESPERAS_MS,
    siteUrl: normalizarSiteUrl(siteUrl),
    metaPixelId: normalizarPixelId(metaPixelId),
    fetchImpl,
    now: agora,
    checkEmailDomain: createCachedDomainChecker(resolveEmailDomain, agora),
    responseBodyCache: new Map(),
    allowEvento: createRateLimiter({ windowMs: EVENTO_RATE_LIMIT_WINDOW_MS, max: EVENTO_RATE_LIMIT_MAX, now: agora }),
    allowSalvar: createRateLimiter({ windowMs: SALVAR_RATE_LIMIT_WINDOW_MS, max: SALVAR_RATE_LIMIT_MAX, now: agora }),
    allowLogin: createRateLimiter({ windowMs: PAINEL_LOGIN_WINDOW_MS, max: PAINEL_LOGIN_MAX, now: agora })
  };

  const rotas = new Map([
    ["/api/pesquisa/evento", handleEvento],
    ["/api/pesquisa/salvar", handleSalvar],
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
    ["/api/painel/exportar.csv", handleExportarCsv]
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

  // Sem webhook ou sem banco, não há o que reenviar: a varredura nem existe.
  if (reenvio && options.webhookUrl && supabaseEnabled(options)) {
    const varredura = criarReenvio(options, reenvio === true ? {} : reenvio);
    server.reenvio = varredura;
    server.on("listening", () => varredura.iniciar());
    server.on("close", () => varredura.parar());
  } else {
    server.reenvio = null;
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
  if (!normalizarSiteUrl(env.SITE_URL)) console.warn("Aviso: SITE_URL ausente — og:url, canonical e a imagem da prévia usam o endereço de cada requisição (Host/X-Forwarded-Host).");
  if (!normalizarPixelId(metaPixelId)) console.warn("Aviso: Meta Pixel desligado (META_PIXEL_ID = off ou inválido).");

  const server = createServerApp({
    supabaseUrl: env.SUPABASE_URL || "",
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    painelEmail: env.PAINEL_EMAIL || "",
    painelSenhaHash: env.PAINEL_SENHA_HASH || "",
    painelSessaoSegredo: env.PAINEL_SESSAO_SEGREDO || "",
    webhookUrl,
    siteUrl: env.SITE_URL || "",
    metaPixelId,
    reenvio: true
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Servidor iniciado na porta ${server.address().port}.`);
  });

  // O Railway manda SIGTERM no deploy: termina o que está em voo em vez de cortar uma gravação.
  process.on("SIGTERM", () => {
    server.reenvio?.parar();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
