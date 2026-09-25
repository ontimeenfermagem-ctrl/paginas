// Apoio das suítes tests/e2e/formulario.e2e.mjs e tests/e2e/obrigado.e2e.mjs: sobe um servidor
// estático mínimo (as páginas e as rotas públicas, com a mesma CSP da produção), abre "celulares"
// no Chromium e intercepta /api/* no navegador, para simular cada resposta do servidor (200, 422,
// 5xx, rede caída) sem depender de Postgres nem do server.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export { assert };

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "pesquisa-config.js"), "utf8"), contexto);
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "obrigado-config.js"), "utf8"), contexto);
/** O EVPesquisa de verdade, o mesmo arquivo que o navegador carrega. */
export const P = contexto.EVPesquisa;
/** O EVObrigado de verdade (as 3 páginas de obrigado). */
export const O = contexto.EVObrigado;

export const CONTATO = { nome: "maria  da silva", whatsapp: "11912345678", email: "maria@gmail.com" };

export const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A CSP da pesquisa em produção (server.mjs): script inline só o do Pixel, nada de CDN. */
const CSP = [
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

/** As rotas públicas que o server.mjs serve: a pesquisa e as 3 páginas de obrigado. */
const ROTAS = new Map([
  ["/pesquisa-icp", "/pesquisa.html"],
  ["/pesquisa-icp/", "/pesquisa.html"],
  ...O.LISTA.flatMap((pagina) => [
    [pagina.rota, "/obrigado.html"],
    [`${pagina.rota}/`, "/obrigado.html"]
  ])
]);

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml"
};

/**
 * Servidor estático das páginas, em porta livre. Sem Supabase (a API é interceptada no navegador
 * e nunca chega aqui) e sem Pixel (os testes de Pixel instalam um fbq falso). Não usa o
 * server.mjs: as regras de tela não podem depender do servidor estar no meio de uma mudança.
 * Qualquer rota fora da lista (ex.: /obrigado-qualquer) cai no obrigado.html se começar com
 * /obrigado-, para testar a "rota desconhecida" da própria página.
 */
export async function subirServidor() {
  const server = http.createServer(async (req, res) => {
    try {
      const caminho = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const arquivo = ROTAS.get(caminho) || (caminho.startsWith("/obrigado-") ? "/obrigado.html" : caminho);
      const completo = path.resolve(RAIZ, `.${arquivo}`);
      const tipo = TIPOS[path.extname(completo)];
      if (!tipo || !completo.startsWith(RAIZ + path.sep) || !(await stat(completo)).isFile()) throw new Error("404");
      const cabecalhos = { "Content-Type": tipo, "Cache-Control": "no-cache" };
      if (tipo.startsWith("text/html")) cabecalhos["Content-Security-Policy"] = CSP;
      res.writeHead(200, cabecalhos);
      res.end(await readFile(completo));
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"ok":false,"error":"not_found"}');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async fechar() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/** route.fulfill/abort de uma requisição que a página já cancelou (saiu da página) não é erro. */
async function responderRota(route, acao) {
  try {
    await acao(route);
  } catch {
    // a página foi embora (redirecionamento para o obrigado) antes da resposta
  }
}

/**
 * Intercepta /api/pesquisa/* e /api/pagina/evento. `modo.salvar(corpo, n)` pode devolver
 * {status, json}, "abort" (rede caída) ou nada (200 padrão). Devolve o registro do que chegou:
 * `salvar` e `evento` (formulário) e `pagina` (eventos das páginas de obrigado).
 */
export async function interceptar(page, modo = {}) {
  const reg = { salvar: [], evento: [], pagina: [], abortados: 0 };
  await page.route("**/api/pagina/**", async (route) => {
    let corpo = null;
    try {
      corpo = JSON.parse(route.request().postData() || "null");
    } catch {
      corpo = null;
    }
    reg.pagina.push(corpo);
    await responderRota(route, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
  });
  await page.route("**/api/pesquisa/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let corpo = null;
    try {
      corpo = JSON.parse(req.postData() || "null");
    } catch {
      corpo = null;
    }
    if (url.pathname.endsWith("/evento")) {
      reg.evento.push(corpo);
      return responderRota(route, (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));
    }
    if (url.pathname.endsWith("/salvar")) {
      const n = reg.salvar.length;
      const r = modo.salvar ? await modo.salvar(corpo, n) : null;
      if (r === "abort") {
        reg.abortados += 1;
        return responderRota(route, (rota) => rota.abort("internetdisconnected"));
      }
      reg.salvar.push(corpo);
      if (r && r.status) {
        return responderRota(route, (rota) =>
          rota.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.json || {}) })
        );
      }
      return responderRota(route, (rota) =>
        rota.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, status: "em_andamento", novo: n === 0, concluiu_agora: false, progresso: {} })
        })
      );
    }
    return responderRota(route, (r) => r.fulfill({ status: 404, body: "{}" }));
  });
  // Nada de chamada externa nos testes: nem Pixel, nem o link do grupo (que hoje é o distribuidor
  // Sendflow e, com o config REAL, aparece nas páginas de obrigado que estes fluxos atravessam).
  await page.route(/facebook\.(net|com)|sndflw\.com|chat\.whatsapp\.com|wa\.me/, (rota) => rota.abort());
  return reg;
}

export async function novaPagina(browser, { largura = 390, altura = 844, reduzir = false, mobile = true } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: largura, height: altura },
    deviceScaleFactor: 2,
    hasTouch: mobile && largura < 768,
    isMobile: mobile && largura < 768,
    reducedMotion: reduzir ? "reduce" : "no-preference",
    locale: "pt-BR"
  });
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (erro) => erros.push(String(erro)));
  // "Failed to load resource" é o próprio Chrome registrando os 4xx/5xx/abort que os testes simulam.
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().startsWith("Failed to load resource")) erros.push(msg.text());
  });
  return { ctx, page, erros };
}

/* ------------------------------------------------------------------ dirigindo o formulário */

/** Roda no navegador: a tela atual. Nas páginas de obrigado (depois do redirecionamento), "obrigado". */
function telaNoNavegador() {
  if (/^\/obrigado-/.test(location.pathname)) return { id: "obrigado", tipo: "obrigado" };
  const t = document.getElementById("tela-pergunta");
  if (!t) return { id: "?", tipo: "?" };
  if (!t.hidden) return { id: t.dataset.pergunta, tipo: t.dataset.tipo };
  for (const n of ["boasvindas", "contato", "fim"]) {
    const tela = document.getElementById("tela-" + n);
    if (tela && !tela.hidden) return { id: n, tipo: n };
  }
  return { id: "?", tipo: "?" };
}

/** A tela atual. Aguenta a troca de página no meio (o fim redireciona para o obrigado). */
export async function perguntaAtual(page) {
  for (let i = 0; i < 40; i += 1) {
    try {
      return await page.evaluate(telaNoNavegador);
    } catch (erro) {
      if (!/context was destroyed|navigat/i.test(String(erro))) throw erro;
      await esperar(50);
    }
  }
  throw new Error("a página não parou de navegar");
}

export async function esperarTrocar(page, idAnterior) {
  const limite = Date.now() + 5000;
  for (;;) {
    const { id } = await perguntaAtual(page);
    if (id && id !== "?" && id !== idAnterior) return id;
    if (Date.now() > limite) throw new Error(`a tela não saiu de "${idAnterior}"`);
    await esperar(40);
  }
}

export async function preencherContato(page, c = CONTATO) {
  await page.fill("#campo-nome", c.nome);
  await page.fill("#campo-whatsapp", "");
  await page.type("#campo-whatsapp", c.whatsapp);
  await page.fill("#campo-email", c.email);
  await page.click("#botao-contato");
}

/**
 * Responde a pergunta da tela. `escolhas[id]` força um valor (string, array ou número; `null` em
 * texto = pular). Sem escolha: a primeira alternativa (única), a segunda (múltipla), 7 (escala).
 */
export async function responder(page, escolhas = {}) {
  const { id, tipo } = await perguntaAtual(page);
  const e = escolhas[id];
  const opcao = (v) => page.locator(`#tela-pergunta .opcao[data-valor="${v}"]`);
  if (tipo === "unica") {
    if (e) await opcao(e).click();
    else await page.locator("#tela-pergunta .opcao").first().click();
  } else if (tipo === "multipla") {
    if (Array.isArray(e)) for (const v of e) await opcao(v).click();
    else await page.locator("#tela-pergunta .opcao").nth(1).click();
    await page.click("#botao-continuar");
  } else if (tipo === "escala") {
    await page.click(`#tela-pergunta .escala-numero[data-valor="${e ?? 7}"]`);
  } else if (tipo === "lista") {
    await page.selectOption("#tela-pergunta select", e || "São Paulo");
    await page.click("#botao-continuar");
  } else if (tipo === "texto") {
    if (e === null) await page.click("#botao-pular");
    else {
      await page.fill("#tela-pergunta textarea", e || `Resposta de ${id}`);
      await page.click("#botao-continuar");
    }
  } else if (tipo === "frase") {
    const areas = page.locator("#tela-pergunta textarea");
    await areas.nth(0).fill("ser enfermeira");
    await areas.nth(1).fill("falta tempo");
    await page.click("#botao-continuar");
  } else throw new Error("tela inesperada " + id);
  await esperarTrocar(page, id);
  return id;
}

/** Responde até concluir: para na tela de fim ou já na página de obrigado. */
export async function responderAteOFim(page, escolhas = {}, limite = 60) {
  const vistos = [];
  for (let i = 0; i < limite; i += 1) {
    const { id } = await perguntaAtual(page);
    if (id === "fim" || id === "obrigado") return vistos;
    vistos.push(await responder(page, escolhas));
  }
  throw new Error("não chegou ao fim: " + vistos.join(","));
}

/** Responde até a pergunta `alvo` estar na tela (sem responder a ela). */
export async function responderAte(page, alvo, escolhas = {}, limite = 60) {
  for (let i = 0; i < limite; i += 1) {
    const { id } = await perguntaAtual(page);
    if (id === alvo) return;
    if (id === "fim" || id === "obrigado") throw new Error(`passou de "${alvo}" sem vê-la`);
    await responder(page, escolhas);
  }
  throw new Error(`não chegou a "${alvo}"`);
}

/** Espera o redirecionamento para a página de obrigado `rota` e devolve a URL de chegada. */
export async function esperarObrigado(page, rota, timeout = 8000) {
  await page.waitForURL((url) => url.pathname === rota, { timeout });
  await page.waitForSelector("#ob-pagina:not([hidden])", { timeout });
  return new URL(page.url());
}

export async function lerRascunho(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("ev_pesquisa_icp_v1") || "null"));
}
