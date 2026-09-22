// O painel /painel no Chromium, de ponta a ponta na tela, com a API do painel interceptada no
// navegador e respondida por fixtures coerentes com o contrato (tests/e2e/apoio/painel-fixtures.mjs:
// 800 pessoas e 1.320 visitantes gerados com semente fixa, e os agregados que o SQL devolveria).
//
// As páginas vêm do server.mjs de verdade (CSP, cabeçalhos, allowlist); os números do SQL de
// verdade são provados em sql.e2e.mjs e no fluxo.e2e.mjs. Aqui: login e seus erros, placar, funil,
// abas dos 5 perfis, filtros e URL, corrida de respostas, sessão expirada, atualização automática,
// lista e "Ver tudo", quadros, cruzamento, abertas, tráfego, copiar ICP, estados vazio/erro/sem
// rede, celular e desktop, e nenhum erro de JavaScript.
//
//   node --test tests/e2e/painel.e2e.mjs                 (precisa só do Playwright; sem Docker)
//   E2E_SCREENS=/uma/pasta node --test ...               (também tira as capturas de tela)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createServerApp } from "../../server.mjs";
import { abertas, cruzamento, EV, gerar, lista, painel } from "./apoio/painel-fixtures.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TELAS = process.env.E2E_SCREENS ? path.join(process.env.E2E_SCREENS, "painel") : "";

let servidor;
let BASE;
let browser;

before(async () => {
  // Sem banco e sem login configurados: a API do painel é toda interceptada no navegador.
  servidor = createServerApp({ rootDirectory: RAIZ, metaPixelId: "off", resolveEmailDomain: async () => "ok" });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  BASE = `http://127.0.0.1:${servidor.address().port}`;
  browser = await chromium.launch();
  if (TELAS) fs.mkdirSync(TELAS, { recursive: true });
});

after(async () => {
  await browser?.close().catch(() => {});
  if (servidor) {
    servidor.closeAllConnections?.();
    await new Promise((resolve) => servidor.close(resolve));
  }
});

const DADOS = gerar();
const VAZIO = { visitantes: [], pessoas: [] };

// Cada checagem é uma asserção (a primeira que falha derruba o cenário) e é contada: o último
// teste confere que nenhuma foi pulada.
let checagens = 0;
function confere(condicao, mensagem) {
  assert.ok(condicao, mensagem);
  checagens += 1;
}

// Tudo o que o painel pediu à API, em todos os cenários (o `mock.chamadas` de cada um é zerado).
const todasAsChamadas = [];

/** Mock da API do painel, com botões para simular cada falha do contrato. */
function criarMock(page, { dados = DADOS, logado = true } = {}) {
  const mock = {
    logado,
    dados,
    chamadas: [],
    forcar: {}, // rota → status
    atraso: {}, // rota → ms (ou função(url) → ms)
    login: "ok",
    async instalar() {
      await page.route("**/api/painel/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const rota = url.pathname.replace("/api/painel/", "");
        mock.chamadas.push({ rota, url: url.pathname + url.search, metodo: req.method() });
        todasAsChamadas.push(url.pathname + url.search);
        const atraso = typeof mock.atraso[rota] === "function" ? mock.atraso[rota](url) : mock.atraso[rota];
        if (atraso) await new Promise((ok) => setTimeout(ok, atraso));
        const json = (status, corpo) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(corpo) });
        if (rota === "login") {
          const corpo = JSON.parse(req.postData() || "{}");
          if (mock.login === "429") return json(429, { ok: false, error: "rate_limited" });
          if (mock.login === "503") return json(503, { ok: false, error: "painel_not_configured" });
          if (corpo.email === "equipe@escola.com" && corpo.senha === "certa") {
            mock.logado = true;
            return json(200, { ok: true, email: corpo.email });
          }
          return json(401, { ok: false, error: "invalid_credentials" });
        }
        if (rota === "logout") {
          mock.logado = false;
          return json(200, { ok: true });
        }
        if (mock.offline) return route.abort("internetdisconnected");
        if (!mock.logado) return json(401, { ok: false, error: "unauthorized" });
        if (mock.forcar[rota]) return json(mock.forcar[rota], { ok: false, error: "db_error" });
        if (rota === "sessao") return json(200, { ok: true, email: "equipe@escola.com" });
        const q = Object.fromEntries(url.searchParams);
        if (q.perfil && !Object.values(EV.PERFIL).includes(q.perfil)) return json(422, { ok: false, error: "invalid_filters" });
        for (const k of ["desde", "ate"]) if (q[k] && Number.isNaN(Date.parse(q[k]))) return json(422, { ok: false, error: "invalid_filters" });
        if (q.status && !["concluida", "em_andamento"].includes(q.status)) return json(422, { ok: false, error: "invalid_filters" });
        const filtros = { desde: q.desde, ate: q.ate, perfil: q.perfil, status: q.status, busca: q.busca };
        if (rota === "resumo") return json(200, { ok: true, resumo: painel(mock.dados, filtros), gerado_em: new Date().toISOString() });
        if (rota === "cruzamento") {
          const ids = EV.perguntasAnalisaveis().map((p) => p.id);
          if (!ids.includes(q.linha) || !ids.includes(q.coluna) || q.linha === q.coluna) return json(422, { ok: false, error: "invalid_filters" });
          return json(200, { ok: true, cruzamento: cruzamento(mock.dados, filtros, q.linha, q.coluna) });
        }
        if (rota === "abertas") {
          const chaves = (q.chaves || "").split(",");
          if (!chaves.every((c) => EV.chavesTexto().includes(c))) return json(422, { ok: false, error: "invalid_filters" });
          const r = abertas(mock.dados, filtros, chaves, Number(q.limite || 200), Number(q.offset || 0));
          return json(200, { ok: true, ...r });
        }
        if (rota === "respostas") {
          const r = lista(mock.dados, filtros, { status: q.status, busca: q.busca, limite: Number(q.limite || 100), offset: Number(q.offset || 0) });
          return json(200, { ok: true, ...r });
        }
        return json(404, { ok: false, error: "not_found" });
      });
    }
  };
  return mock;
}

async function novaPagina(browser, { largura = 1280, altura = 800, logado = true, dados, url = "/painel" } = {}) {
  const contexto = await browser.newContext({ viewport: { width: largura, height: altura }, deviceScaleFactor: largura < 500 ? 2 : 1, timezoneId: "America/Sao_Paulo", locale: "pt-BR", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await contexto.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // "Failed to load resource" é o log do próprio navegador para 4xx/5xx esperados no cenário.
    if ((m.type() === "error" || m.type() === "warning") && !m.text().startsWith("Failed to load resource")) erros.push(`console.${m.type()}: ${m.text()}`);
  });
  const mock = criarMock(page, { dados, logado });
  await mock.instalar();
  await page.goto(BASE + url);
  return { page, mock, erros, contexto };
}

const esperarCalmo = (page) => page.waitForFunction(() => !document.querySelector("[aria-busy='true']") && !document.querySelector(".esqueleto"), null, { timeout: 8000 });

// Capturas só com E2E_SCREENS definido.
async function tela(page, nome, opcoes = {}) {
  if (!TELAS) return;
  await page.screenshot({ path: `${TELAS}/${nome}.png`, fullPage: opcoes.full ?? false, ...(opcoes.clip ? { clip: opcoes.clip } : {}) });
}
async function recorte(page, seletor, nome) {
  if (!TELAS) return;
  const el = page.locator(seletor).first();
  await el.scrollIntoViewIfNeeded();
  await el.screenshot({ path: `${TELAS}/${nome}.png` });
}

/** Um cenário = um teste; cada um abre e fecha os próprios contextos do navegador. */
const cenario = (nome, fn) => test(nome, fn);

/* ---------------------------------------------------------------- Login */
cenario("login", async () => {
  const { page, mock, erros } = await novaPagina(browser, { logado: false, largura: 390, altura: 844 });
  await page.waitForSelector("[data-login-view]:not([hidden])");
  await tela(page, "login-390");
  await page.click("button[type=submit]");
  confere((await page.textContent("[data-login-status]")).includes("Preencha"), "login vazio pede para preencher");
  await page.fill("#login-email", "equipe@escola.com");
  await page.fill("#login-senha", "errada");
  await page.click("button[type=submit]");
  await page.waitForFunction(() => document.querySelector("[data-login-status]").textContent.includes("incorretos"));
  confere(true, "401 mostra e-mail ou senha incorretos");
  await tela(page, "login-erro-390");
  mock.login = "429";
  await page.click("button[type=submit]");
  await page.waitForFunction(() => document.querySelector("[data-login-status]").textContent.includes("Muitas tentativas"));
  confere(true, "429 mostra muitas tentativas");
  mock.login = "503";
  await page.click("button[type=submit]");
  await page.waitForFunction(() => document.querySelector("[data-login-status]").textContent.includes("não está configurado"));
  confere(true, "503 mostra painel não configurado");
  mock.login = "ok";
  await page.fill("#login-senha", "certa");
  await page.click("button[type=submit]");
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  confere((await page.inputValue("#login-senha")) === "", "senha apagada depois do login");
  confere((await page.textContent("[data-conta-email]")) === "equipe@escola.com", "e-mail logado no topo");
  confere(erros.length === 0, `sem erros no console (${erros.join(" | ")})`);
  await page.context().close();

  const desk = await novaPagina(browser, { logado: false });
  await desk.page.waitForSelector("[data-login-view]:not([hidden])");
  await tela(desk.page, "login-1280");
  await desk.page.context().close();
});

/* ---------------------------------------------------------------- Painel completo e números */
cenario("painel-completo", async () => {
  for (const [largura, altura] of [[1280, 800], [390, 844]]) {
    const { page, erros, mock } = await novaPagina(browser, { largura, altura });
    await page.waitForSelector("[data-panel-view]:not([hidden])");
    await esperarCalmo(page);
    const sufixo = largura;
    await tela(page, `painel-full-${sufixo}`, { full: true });
    await tela(page, `painel-topo-${sufixo}`);
    for (const [sel, nome] of [
      ["[data-placar]", "placar"],
      ["[data-funil]", "funil"],
      ["[data-dia]", "por-dia"],
      ["[data-paradas]", "paradas"],
      ["#sec-icp", "icp"],
      ["#sec-perguntas .etapa[data-etapa='1']", "perguntas-etapa1"],
      ["#sec-cruzamento", "cruzamento"],
      ["#sec-abertas", "abertas"],
      ["#sec-trafego", "trafego"],
      ["#sec-pessoas", "pessoas"]
    ]) {
      await recorte(page, sel, `${nome}-${sufixo}`);
    }
    // Sem rolagem horizontal da página.
    const larguraDoc = await page.evaluate(() => document.documentElement.scrollWidth);
    confere(larguraDoc <= largura, `sem rolagem horizontal em ${largura}px (scrollWidth ${larguraDoc})`);

    if (largura === 1280) {
      const r = painel(DADOS, {});
      const placar = await page.$$eval("[data-placar] li .valor", (els) => els.map((e) => e.textContent.trim()));
      const fmt = (x) => new Intl.NumberFormat("pt-BR").format(x);
      confere(placar[0] === fmt(r.visitantes), `placar acessaram = ${r.visitantes} (${placar[0]})`);
      confere(placar[1] === fmt(r.comecaram), `placar começaram = ${r.comecaram}`);
      confere(placar[2] === fmt(r.pessoas), `placar identificaram = ${r.pessoas}`);
      confere(placar[3] === fmt(r.concluidas), `placar concluíram = ${r.concluidas}`);
      confere(placar[5] === fmt(r.tentativas - r.pessoas), `tentativas repetidas = ${r.tentativas - r.pessoas}`);
      const detalhe = await page.$$eval("[data-placar] li .detalhe", (els) => els.map((e) => e.textContent));
      confere(detalhe[3].includes(`${Math.round((r.concluidas / r.pessoas) * 100)}%`) && detalhe[3].includes("de quem se identificou"), "% concluídas com base explícita");
      // Abas de perfil com contagem.
      const abas = await page.$$eval("[data-perfil]", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
      // Todos + os 5 perfis (sem "Outro"), na ordem do config.
      confere(abas.length === 6 && abas[0].includes("Todos") && abas[0].includes("800"), `abas de perfil: ${abas.join(" / ")}`);
      const chavesAbas = await page.$$eval("[data-perfis] [data-perfil]", (els) => els.map((e) => e.dataset.perfil));
      confere(JSON.stringify(chavesAbas) === JSON.stringify(["", ...Object.keys(EV.PERFIL)]), `abas na ordem dos perfis (${chavesAbas.join(",")})`);
      const tec = r.perfis.find((p) => p.perfil === EV.PERFIL.tecnico).total;
      confere(abas.some((a) => a.includes("Técnicos de enfermagem") && a.includes(String(tec))), "aba Técnicos com a contagem certa");
      // Funil: 13 degraus e 1 etiqueta de maior queda.
      const degraus = await page.$$eval("[data-funil] > li", (els) => els.length);
      confere(degraus === 12, `funil tem 12 degraus (${degraus})`);
      const quedas = await page.$$eval("[data-funil] .queda", (els) => els.map((e) => e.textContent));
      confere(quedas.length === 1, `uma etiqueta de maior queda (${quedas.join()})`);
      // Paradas: ordem do questionário.
      const paradas = await page.$$eval("[data-paradas] .rotulo", (els) => els.map((e) => e.firstChild.textContent));
      const ordem = paradas.map((t) => EV.PERGUNTAS.findIndex((p) => t.includes(`· ${p.analise}`)));
      confere(ordem.every((v, i) => i === 0 || v > ordem[i - 1]), "paradas na ordem do questionário");
      const lideres = await page.$$eval("[data-paradas] .linha-barra.lider", (els) => els.length);
      confere(lideres === 3, `3 destaques nas paradas (${lideres})`);
      // ICP: 5 cartões (um por perfil com gente) — sem "sem perfil".
      const cartoes = await page.$$eval(".icp-cartao h3", (els) => els.map((e) => e.textContent));
      confere(JSON.stringify(cartoes) === JSON.stringify(Object.values(EV.PERFIL).map((v) => EV.PERFIL_CURTO[v])), `5 cartões de ICP (${cartoes.join(", ")})`);
      // Quadro da idade: todas as alternativas, % de quem respondeu.
      const idade = await page.$$eval("#q-idade .linha-barra", (els) => els.map((e) => e.querySelector(".rotulo").textContent));
      confere(JSON.stringify(idade) === JSON.stringify(EV.perguntaPorId("idade").opcoes), "quadro idade com todas as alternativas na ordem");
      const respIdade = r.responderam.filter((x) => x.chave === "idade").reduce((s, x) => s + x.total, 0);
      const chipIdade = await page.textContent("#q-idade .chip.forte");
      confere(chipIdade.includes(new Intl.NumberFormat("pt-BR").format(respIdade)), `quadro idade: ${chipIdade}`);
      // Nenhuma chave de texto livre em quadro.
      const quadros = await page.$$eval(".quadro", (els) => els.map((e) => e.id));
      confere(quadros.length === EV.perguntasAnalisaveis().length, `um quadro por pergunta analisável (${quadros.length})`);
      // XSS: nome malicioso não executa.
      await page.fill("[data-busca]", "Joana");
      await page.waitForFunction(() => document.querySelectorAll("[data-pessoa]").length === 1, null, { timeout: 5000 });
      const xss = await page.evaluate(() => window.__xss);
      confere(xss === undefined, "nome com <img onerror> não executa (escapeHtml)");
      const nomeTexto = await page.textContent("[data-pessoa] .pessoa-nome");
      confere(nomeTexto.includes("<img"), "nome malicioso aparece como texto");
      await page.fill("[data-busca]", "");
    }
    confere(erros.length === 0, `sem erros no console em ${largura}px (${erros.join(" | ")})`);
    // Nenhum dado pessoal no console: não houve log algum.
    await page.context().close();
  }
});

/* ---------------------------------------------------------------- Filtros: perfil, período, URL */
cenario("filtros", async () => {
  const { page, mock, erros } = await novaPagina(browser);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  mock.chamadas = [];
  await page.click("[data-perfil='tecnico']");
  await esperarCalmo(page);
  const url = new URL(page.url());
  confere(url.searchParams.get("perfil") === "tecnico", `URL ganhou ?perfil=tecnico (${url.search})`);
  const resumos = mock.chamadas.filter((c) => c.rota === "resumo");
  confere(resumos.length === 2 && resumos.some((c) => c.url.includes("perfil=T%C3%A9cnico")), "resumo pedido com e sem perfil");
  confere(mock.chamadas.some((c) => c.rota === "respostas" && c.url.includes("perfil=")), "lista recarregada com perfil");
  confere(mock.chamadas.some((c) => c.rota === "cruzamento" && c.url.includes("perfil=")), "cruzamento recarregado com perfil");
  const r = painel(DADOS, { perfil: EV.PERFIL.tecnico });
  const placar = await page.$$eval("[data-placar] li .valor", (els) => els.map((e) => e.textContent.trim()));
  confere(placar[2] === String(r.pessoas), `identificados do perfil = ${r.pessoas} (${placar[2]})`);
  const selos = await page.$$eval("[data-placar] .selo-todos", (els) => els.map((e) => e.textContent));
  confere(selos.filter((s) => s.startsWith("sem filtro de pessoa")).length === 2, `acesso e começo marcados como sem filtro de pessoa (${selos.join(" | ")})`);
  const degraus = await page.$$eval("[data-funil] > li", (els) => els.length);
  confere(degraus === 10, `funil do perfil começa em se identificaram (${degraus} degraus)`);
  const cartoes = await page.$$eval(".icp-cartao", (els) => els.length);
  confere(cartoes === 1, "só o cartão do perfil");
  confere((await page.getAttribute("[data-perfil='tecnico']", "aria-selected")) === "true", "aba técnico selecionada");
  confere((await page.evaluate(() => document.activeElement && document.activeElement.dataset.perfil)) === "tecnico", "foco fica na aba clicada");
  await tela(page, "filtro-tecnico-1280");
  await recorte(page, "#sec-icp", "icp-tecnico-1280");
  await recorte(page, "#sec-visao", "visao-tecnico-1280");
  const csv = await page.getAttribute("[data-csv]", "href");
  confere(csv.includes("perfil=T%C3%A9cnico"), `CSV com perfil (${csv})`);

  // Período 7 dias.
  mock.chamadas = [];
  await page.click("[data-periodo='7']");
  await esperarCalmo(page);
  const u2 = new URL(page.url());
  confere(u2.searchParams.get("periodo") === "7" && u2.searchParams.get("perfil") === "tecnico", `URL ${u2.search}`);
  const desde = new URL(BASE + mock.chamadas.find((c) => c.rota === "resumo").url).searchParams.get("desde");
  const esperado = new Date(Date.now() - 6 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  confere(desde && new Date(desde).toLocaleString("en-CA", { timeZone: "America/Sao_Paulo", hour12: false }).startsWith(`${esperado}, 00:00`), `desde = meia-noite SP de ${esperado} (${desde})`);
  const colunas = await page.$$eval(".coluna", (els) => els.length);
  confere(colunas === 7, `por dia com 7 colunas (${colunas})`);
  confere((await page.textContent("[data-periodo-rotulo]")).includes("Últimos 7 dias"), "rótulo do período");

  // Recarregar mantém.
  await page.reload();
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  confere((await page.getAttribute("[data-periodo='7']", "aria-pressed")) === "true" && (await page.getAttribute("[data-perfil='tecnico']", "aria-selected")) === "true", "recarregar mantém período e perfil");

  // Personalizado.
  await page.click("[data-periodo='personalizado']");
  confere(await page.isVisible("[data-datas]"), "personalizado abre as datas");
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const dez = new Date(Date.now() - 9 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  await page.fill("[data-data-de]", hoje);
  await page.fill("[data-data-ate]", dez);
  await page.click("[data-datas] button[type=submit]");
  confere((await page.textContent("[data-datas-erro]")).includes("antes"), "data invertida recusada");
  await page.fill("[data-data-de]", dez);
  await page.fill("[data-data-ate]", hoje);
  mock.chamadas = [];
  await page.click("[data-datas] button[type=submit]");
  await esperarCalmo(page);
  const u3 = new URL(page.url());
  confere(u3.searchParams.get("periodo") === "personalizado" && u3.searchParams.get("de") === dez && u3.searchParams.get("ate") === hoje, `URL personalizado ${u3.search}`);
  const chamada = new URL(BASE + mock.chamadas.find((c) => c.rota === "resumo").url).searchParams;
  confere(chamada.get("ate") && new Date(chamada.get("ate")).getTime() - new Date(chamada.get("desde")).getTime() === 10 * 86400000, "personalizado: [de, ate+1) = 10 dias");
  confere((await page.$$eval(".coluna", (els) => els.length)) === 10, "10 colunas no por dia");
  await tela(page, "filtro-personalizado-1280");

  // Voltar para Tudo / Todos.
  await page.click("[data-periodo='tudo']");
  await page.click("[data-perfil='']");
  await esperarCalmo(page);
  confere(new URL(page.url()).search === "", `URL limpa (${new URL(page.url()).search})`);
  confere(erros.length === 0, `sem erros no console (${erros.join(" | ")})`);
  await page.context().close();

  // URL inválida cai no padrão.
  const x = await novaPagina(browser, { url: "/painel?periodo=abc&perfil=hacker" });
  await x.page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(x.page);
  confere((await x.page.getAttribute("[data-periodo='tudo']", "aria-pressed")) === "true", "período inválido na URL vira Tudo");
  confere(!x.mock.chamadas.some((c) => c.url.includes("hacker")), "perfil inválido na URL não vai para a API");
  await x.page.context().close();
});

/* ---------------------------------------------------------------- Sequência: resposta antiga depois da nova */
cenario("corrida", async () => {
  const { page, mock, erros } = await novaPagina(browser);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  // O resumo do perfil cuidador demora 1,5s; o de enfermeiro é instantâneo. Clica cuidador e
  // logo enfermeiro: a resposta velha (cuidador) chega depois e não pode pintar a tela.
  mock.atraso.resumo = (url) => (url.searchParams.get("perfil") === EV.PERFIL.cuidador ? 1500 : 0);
  mock.atraso.respostas = (url) => (url.searchParams.get("perfil") === EV.PERFIL.cuidador ? 1500 : 0);
  await page.click("[data-perfil='cuidador']");
  await page.waitForTimeout(100);
  await page.click("[data-perfil='enfermeiro']");
  await page.waitForTimeout(2200);
  const r = painel(DADOS, { perfil: EV.PERFIL.enfermeiro });
  const placar = await page.$$eval("[data-placar] li .valor", (els) => els.map((e) => e.textContent.trim()));
  confere(placar[2] === String(r.pessoas), `resposta antiga não sobrescreve (mostra enfermeiros ${r.pessoas}: ${placar[2]})`);
  const cartao = await page.textContent(".icp-cartao h3");
  confere(cartao === "Enfermeiros", `cartão ICP é de Enfermeiros (${cartao})`);
  const perfis = await page.$$eval("[data-pessoa] .pessoa-meta", (els) => els.map((e) => e.textContent));
  confere(perfis.length > 0 && perfis.every((t) => t.includes("Enfermeiros")), "lista só com enfermeiros");
  mock.atraso = {};
  confere(erros.length === 0, `sem erros (${erros.join(" | ")})`);
  await page.context().close();
});

/* ---------------------------------------------------------------- Sessão expira no meio */
cenario("sessao", async () => {
  const { page, mock } = await novaPagina(browser);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  mock.logado = false;
  await page.click("[data-atualizar]");
  await page.waitForSelector("[data-login-view]:not([hidden])");
  confere((await page.textContent("[data-login-status]")).includes("Sua sessão expirou"), "401 no meio volta ao login com 'Sua sessão expirou'");
  confere((await page.$$("[data-pessoa]")).length === 0 || (await page.isHidden("[data-panel-view]")), "painel escondido");
  await tela(page, "sessao-expirou-1280");
  await page.fill("#login-email", "equipe@escola.com");
  await page.fill("#login-senha", "certa");
  await page.click("button[type=submit]");
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  confere((await page.$$("[data-pessoa]")).length === 50, "entra de novo e recarrega");
  // Logout.
  await page.click("[data-sair]");
  await page.waitForSelector("[data-login-view]:not([hidden])");
  confere((await page.textContent("[data-login-status]")).includes("Você saiu"), "sair mostra 'Você saiu do painel'");
  await page.context().close();
});

/* ---------------------------------------------------------------- Auto-atualização */
cenario("auto", async () => {
  const contexto = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "America/Sao_Paulo" });
  const page = await contexto.newPage();
  await page.clock.install();
  const mock = criarMock(page);
  await mock.instalar();
  await page.goto(BASE + "/painel");
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await page.clock.runFor(500);
  await esperarCalmo(page);
  const antes = mock.chamadas.filter((c) => c.rota === "resumo").length;
  await page.clock.runFor(61000);
  await page.waitForTimeout(300);
  await esperarCalmo(page);
  const depois = mock.chamadas.filter((c) => c.rota === "resumo").length;
  confere(depois === antes + 1, `auto-atualização após 60s (${antes} → ${depois})`);
  await page.uncheck("[data-auto]");
  await page.clock.runFor(61000);
  await page.waitForTimeout(300);
  confere(mock.chamadas.filter((c) => c.rota === "resumo").length === depois, "desligado: não atualiza");
  // "Carregar mais" + auto não derruba a lista longa.
  await page.check("[data-auto]");
  await page.click("[data-lista-mais]");
  await page.waitForFunction(() => document.querySelectorAll("[data-pessoa]").length === 100);
  const primeiro = await page.getAttribute("[data-pessoa] [data-ver]", "data-ver");
  await page.click(`[data-ver="${primeiro}"]`);
  await page.clock.runFor(61000);
  await page.waitForTimeout(400);
  confere((await page.$$("[data-pessoa]")).length === 100, "auto não reinicia a lista depois de carregar mais");
  confere(await page.isVisible(`#det-${primeiro}`), "detalhe aberto sobrevive à atualização");
  await contexto.close();
});

/* ---------------------------------------------------------------- Busca e situação: filtros de verdade */
cenario("filtros-de-pessoa", async () => {
  const fmt = (x) => new Intl.NumberFormat("pt-BR").format(x);
  const placarDe = (page) => page.$$eval("[data-placar] li .valor", (els) => els.map((e) => e.textContent.trim()));
  const ROTAS = ["resumo", "respostas", "cruzamento", "abertas"];
  const todasLevam = (mock, trecho) => ROTAS.every((rota) => mock.chamadas.some((c) => c.rota === rota) && mock.chamadas.filter((c) => c.rota === rota).every((c) => c.url.includes(trecho)));

  for (const [largura, altura] of [[1280, 800], [390, 844]]) {
    const { page, mock, erros } = await novaPagina(browser, { largura, altura });
    await page.waitForSelector("[data-panel-view]:not([hidden])");
    await esperarCalmo(page);
    const geral = painel(DADOS, {});
    // A busca e a situação moram na barra de filtros do topo, junto de período e perfil.
    confere((await page.locator("[data-filtros] [data-busca]").count()) === 1 && (await page.locator("[data-filtros] [data-status]").count()) === 1, `${largura}: busca e situação na barra de filtros`);
    confere((await page.locator("#sec-pessoas [data-busca], #sec-pessoas [data-status]").count()) === 0, `${largura}: nada de busca própria na seção Pessoas`);
    confere(await page.isVisible("[data-filtros] [data-busca]"), `${largura}: busca visível`);
    confere(await page.isHidden("[data-filtro-ativo]"), `${largura}: sem aviso de filtro no começo`);
    const corpo = await page.textContent("body");
    confere(!/não mudam os números/.test(corpo) && !/busca e a lista não/.test(corpo), `${largura}: nenhum texto dizendo que a busca não muda os números`);
    confere(corpo.includes("Todos os números respeitam os filtros escolhidos"), `${largura}: rodapé verdadeiro`);

    // Busca por nome: debounce, TODAS as requisições levam a busca, placar muda.
    mock.chamadas = [];
    await page.type("[data-busca]", "maria", { delay: 40 });
    await page.waitForTimeout(650);
    await esperarCalmo(page);
    const resumos = mock.chamadas.filter((c) => c.rota === "resumo");
    confere(resumos.length === 1, `${largura}: debounce faz um resumo só (${resumos.length})`);
    confere(todasLevam(mock, "busca=maria"), `${largura}: resumo, lista, cruzamento e abertas levam busca=maria`);
    const rBusca = painel(DADOS, { busca: "maria" });
    confere(rBusca.pessoas > 0 && rBusca.pessoas < geral.pessoas, `fixture: busca recorta (${rBusca.pessoas} de ${geral.pessoas})`);
    let placar = await placarDe(page);
    confere(placar[0] === fmt(geral.visitantes), `${largura}: acessaram não muda com a busca (${placar[0]})`);
    confere(placar[2] === fmt(rBusca.pessoas), `${largura}: identificados com busca = ${rBusca.pessoas} (${placar[2]})`);
    confere(placar[3] === fmt(rBusca.concluidas), `${largura}: concluídas com busca = ${rBusca.concluidas} (${placar[3]})`);
    confere(placar[5] === fmt(rBusca.tentativas - rBusca.pessoas), `${largura}: tentativas repetidas com busca`);
    const selos = await page.$$eval("[data-placar] .selo-todos", (els) => els.map((e) => e.textContent));
    confere(selos.filter((x) => x.startsWith("sem filtro de pessoa")).length === 2, `${largura}: acesso e começo marcados sem filtro de pessoa (${selos.join(" | ")})`);
    const aviso = (await page.textContent("[data-filtro-ativo]")).replace(/\s+/g, " ");
    confere(aviso.includes("Filtrando") && aviso.includes("maria") && aviso.includes(fmt(rBusca.pessoas)) && aviso.includes("Limpar filtros"), `${largura}: aviso de filtro (${aviso})`);
    confere(new URL(page.url()).searchParams.get("busca") === "maria", `${largura}: URL guarda a busca`);
    confere((await page.getAttribute("[data-csv]", "href")).includes("busca=maria"), `${largura}: CSV leva a busca`);
    confere((await page.$$eval("[data-funil] > li", (els) => els.length)) === 10, `${largura}: funil filtrado começa em se identificaram`);
    const contador = (await page.textContent("[data-contador]")).replace(/\s+/g, " ");
    confere(contador.includes(`de ${fmt(rBusca.pessoas)}`), `${largura}: lista e placar batem (${contador})`);

    // Situação: soma com a busca.
    mock.chamadas = [];
    await page.selectOption("[data-status]", "concluida");
    await esperarCalmo(page);
    const rAmbos = painel(DADOS, { busca: "maria", status: "concluida" });
    confere(todasLevam(mock, "status=concluida") && todasLevam(mock, "busca=maria"), `${largura}: requisições levam status e busca`);
    placar = await placarDe(page);
    confere(placar[2] === fmt(rAmbos.pessoas) && placar[3] === fmt(rAmbos.pessoas), `${largura}: só concluídas (${placar[2]}/${placar[3]} = ${rAmbos.pessoas})`);
    confere((await page.textContent("[data-filtro-ativo]")).includes("responderam tudo"), `${largura}: aviso cita a situação`);
    let u = new URL(page.url());
    confere(u.searchParams.get("status") === "concluida" && u.searchParams.get("busca") === "maria", `${largura}: URL ${u.search}`);
    await tela(page, `filtro-pessoa-${largura}`);
    const larguraDoc = await page.evaluate(() => document.documentElement.scrollWidth);
    confere(larguraDoc <= largura, `${largura}: sem rolagem horizontal com filtro (${larguraDoc})`);

    // Recarregar mantém busca e situação (campo preenchido e requisições filtradas).
    mock.chamadas = [];
    await page.reload();
    await page.waitForSelector("[data-panel-view]:not([hidden])");
    await esperarCalmo(page);
    confere((await page.inputValue("[data-busca]")) === "maria" && (await page.inputValue("[data-status]")) === "concluida", `${largura}: recarregar mantém busca e situação`);
    confere(todasLevam(mock, "status=concluida") && todasLevam(mock, "busca=maria"), `${largura}: depois de recarregar, tudo filtrado`);
    confere((await placarDe(page))[2] === fmt(rAmbos.pessoas), `${largura}: placar filtrado depois de recarregar`);

    // Em andamento, sem busca.
    await page.fill("[data-busca]", "");
    await page.selectOption("[data-status]", "em_andamento");
    await page.waitForTimeout(600);
    await esperarCalmo(page);
    const rAnd = painel(DADOS, { status: "em_andamento" });
    placar = await placarDe(page);
    confere(placar[2] === fmt(rAnd.pessoas) && placar[3] === "0", `${largura}: em andamento (${placar[2]}, concluídas ${placar[3]})`);
    u = new URL(page.url());
    confere(u.searchParams.get("status") === "em_andamento" && !u.searchParams.has("busca"), `${largura}: URL sem busca vazia (${u.search})`);

    // Busca por telefone (com máscara) acha a pessoa, e os números mudam para 1.
    const alvo = DADOS.pessoas.find((p) => p.status === "em_andamento" && !DADOS.pessoas.some((o) => o !== p && o.whatsapp_digits === p.whatsapp_digits));
    await page.fill("[data-busca]", alvo.whatsapp);
    await page.waitForTimeout(600);
    await esperarCalmo(page);
    confere(painel(DADOS, { status: "em_andamento", busca: alvo.whatsapp }).pessoas === 1, "fixture: WhatsApp com máscara acha 1 pessoa");
    confere((await placarDe(page))[2] === "1", `${largura}: busca por WhatsApp muda o placar para 1`);
    confere((await page.locator(`[data-pessoa="${alvo.id}"]`).count()) === 1, `${largura}: busca por WhatsApp acha a pessoa`);

    // Limpar filtros: tudo volta.
    mock.chamadas = [];
    await page.click("[data-limpar-filtros]");
    await esperarCalmo(page);
    placar = await placarDe(page);
    confere(placar[2] === fmt(geral.pessoas) && placar[3] === fmt(geral.concluidas), `${largura}: limpar filtros volta ao total`);
    confere(await page.isHidden("[data-filtro-ativo]"), `${largura}: aviso some`);
    u = new URL(page.url());
    confere(!u.searchParams.has("busca") && !u.searchParams.has("status"), `${largura}: URL limpa (${u.search})`);
    confere(mock.chamadas.filter((c) => c.rota === "resumo").every((c) => !c.url.includes("busca=") && !c.url.includes("status=")), `${largura}: resumo sem filtro de pessoa`);
    confere(erros.length === 0, `${largura}: sem erros (${erros.join(" | ")})`);
    await page.context().close();
  }

  // Link compartilhado com filtros: a primeira carga já vem filtrada.
  const { page, mock } = await novaPagina(browser, { url: `/painel?busca=${encodeURIComponent("ana")}&status=concluida&perfil=tecnico` });
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  const rUrl = painel(DADOS, { busca: "ana", status: "concluida", perfil: EV.PERFIL.tecnico });
  confere((await placarDe(page))[2] === fmt(rUrl.pessoas), `link com filtros: identificados = ${rUrl.pessoas}`);
  confere(mock.chamadas.filter((c) => c.rota === "resumo").every((c) => c.url.includes("busca=ana") && c.url.includes("status=concluida")), "link com filtros: os dois resumos levam busca e situação");
  const csv = await page.getAttribute("[data-csv]", "href");
  confere(csv.includes("busca=ana") && csv.includes("status=concluida") && csv.includes("perfil="), `link com filtros: CSV com os quatro filtros (${csv})`);
  await page.context().close();
});

/* ---------------------------------------------------------------- Lista: busca, carregar mais, ver tudo */
cenario("lista", async () => {
  const { page, mock, erros } = await novaPagina(browser);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  confere((await page.textContent("[data-contador]")).replace(/\s+/g, " ").includes("Mostrando 50 de 800"), "contador Mostrando 50 de 800");
  await page.click("[data-lista-mais]");
  await page.waitForFunction(() => document.querySelectorAll("[data-pessoa]").length === 100);
  confere((await page.evaluate(() => document.activeElement && document.activeElement.dataset.foco)) === "lista-mais", "foco volta ao Carregar mais");
  confere(mock.chamadas.some((c) => c.rota === "respostas" && c.url.includes("offset=50")), "carregar mais usa offset=50");
  // Busca com debounce: digitar rápido faz UMA chamada.
  mock.chamadas = [];
  await page.type("[data-busca]", "maria", { delay: 60 });
  await page.waitForTimeout(700);
  const buscas = mock.chamadas.filter((c) => c.rota === "respostas");
  confere(buscas.length === 1 && buscas[0].url.includes("busca=maria"), `busca com debounce: ${buscas.length} chamada(s)`);
  const csv = await page.getAttribute("[data-csv]", "href");
  confere(csv.includes("busca=maria"), "CSV leva a busca");
  await page.fill("[data-busca]", "");
  await page.selectOption("[data-status]", "em_andamento");
  await esperarCalmo(page);
  await page.check("[data-csv-tentativas]");
  const csv2 = await page.getAttribute("[data-csv]", "href");
  confere(csv2.includes("status=em_andamento") && csv2.includes("tentativas=todas"), `CSV com status e tentativas (${csv2})`);
  const selos = await page.$$eval("[data-pessoa] .selo.meio", (els) => els.map((e) => e.textContent));
  confere(selos.length > 0 && selos.every((s) => /Parou na pergunta \w+ · \d+%/.test(s)), `selos de parada (${selos[0]})`);
  await page.selectOption("[data-status]", "");
  await esperarCalmo(page);

  // Ver tudo: uma pessoa de cada perfil (concluída), conferindo o condicional.
  const porPerfil = {};
  for (const p of DADOS.pessoas) if (p.status === "concluida" && p.perfil && !porPerfil[p.perfil] && p.nome.indexOf("<") < 0) porPerfil[p.perfil] = p;
  for (const [perfil, pessoa] of Object.entries(porPerfil)) {
    await page.fill("[data-busca]", pessoa.email);
    await page.waitForFunction((id) => document.querySelectorAll("[data-pessoa]").length === 1 && document.querySelector(`[data-pessoa="${id}"]`), pessoa.id, { timeout: 5000 });
    await page.click(`[data-ver="${pessoa.id}"]`);
    const det = page.locator(`#det-${pessoa.id}`);
    await det.waitFor();
    const texto = await det.textContent();
    const visiveis = EV.perguntasVisiveis(pessoa.respostas);
    const invisiveis = EV.PERGUNTAS.filter((q) => q.visivelSe && !visiveis.includes(q));
    const linhas = await det.locator(".resposta").count();
    confere(linhas === visiveis.length, `${EV.PERFIL_CURTO[perfil]}: ${linhas} perguntas no Ver tudo (esperado ${visiveis.length})`);
    confere(invisiveis.every((q) => !texto.includes(q.texto)) || invisiveis.every((q) => visiveis.some((v) => v.texto === q.texto)), `${EV.PERFIL_CURTO[perfil]}: condicional de outro perfil não aparece`);
    confere(texto.includes(pessoa.id) && texto.includes("1.0"), `${EV.PERFIL_CURTO[perfil]}: id da sessão e versão`);
    confere(!texto.includes("Outro:"), `${EV.PERFIL_CURTO[perfil]}: nenhuma resposta "Outro: ..."`);
    confere((await page.evaluate(() => document.activeElement && document.activeElement.dataset.foco)) === `ver-${pessoa.id}`, `${EV.PERFIL_CURTO[perfil]}: foco no botão Fechar`);
    const chave = Object.keys(EV.PERFIL).find((k) => EV.PERFIL[k] === perfil);
    await recorte(page, `[data-pessoa="${pessoa.id}"]`, `ver-tudo-${chave}-1280`);
  }
  // Ver tudo de uma pessoa em andamento: "—" nas não respondidas.
  const parada = DADOS.pessoas.find((p) => p.status === "em_andamento" && p.perfil === EV.PERFIL.tecnico && p.progresso_percentual > 30);
  await page.fill("[data-busca]", parada.email);
  await page.waitForFunction((id) => document.querySelectorAll("[data-pessoa]").length === 1 && document.querySelector(`[data-pessoa="${id}"]`), parada.id);
  await page.click(`[data-ver="${parada.id}"]`);
  const vazias = await page.locator(`#det-${parada.id} .valor.vazio-valor`).count();
  confere(vazias > 0, `em andamento mostra "—" nas não respondidas (${vazias})`);
  await recorte(page, `[data-pessoa="${parada.id}"]`, "ver-tudo-em-andamento-1280");
  // Link do WhatsApp.
  const wa = await page.getAttribute(`[data-pessoa="${parada.id}"] .pessoa-contato a`, "href");
  const rel = await page.getAttribute(`[data-pessoa="${parada.id}"] .pessoa-contato a`, "rel");
  confere(wa === `https://wa.me/55${parada.whatsapp_digits}` && rel === "noopener noreferrer", `link wa.me (${wa})`);
  // Busca sem resultado.
  await page.fill("[data-busca]", "zzzzzz-ninguem");
  await page.waitForFunction(() => document.querySelector("[data-lista] .vazio"));
  confere(true, "busca sem resultado mostra estado vazio");
  await recorte(page, "#sec-pessoas", "pessoas-busca-vazia-1280");
  confere(erros.length === 0, `sem erros (${erros.join(" | ")})`);
  await page.context().close();

  // Mobile: ver tudo.
  const m = await novaPagina(browser, { largura: 390, altura: 844 });
  await m.page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(m.page);
  const pessoa = porPerfil[EV.PERFIL.cuidador];
  await m.page.fill("[data-busca]", pessoa.email);
  await m.page.waitForFunction((id) => document.querySelectorAll("[data-pessoa]").length === 1 && document.querySelector(`[data-pessoa="${id}"]`), pessoa.id);
  await m.page.click(`[data-ver="${pessoa.id}"]`);
  await recorte(m.page, `[data-pessoa="${pessoa.id}"]`, "ver-tudo-cuidador-390");
  await m.page.context().close();
});

/* ---------------------------------------------------------------- Outro, cruzamento, abertas, ICP copiar */
cenario("interacoes", async () => {
  const { page, mock, erros } = await novaPagina(browser);
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(page);
  // Sem "Outro" em pergunta nenhuma: nenhum link "Ver o que escreveram em Outro", nenhuma
  // alternativa "Outro" nos quadros, e o painel nunca pede complemento de Outro à API.
  confere((await page.locator("[data-outro]").count()) === 0, "nenhum botão de Outro");
  confere(!(await page.textContent("[data-perguntas]")).includes("escreveram em Outro"), "nenhum 'Ver o que escreveram em Outro'");
  const perfisQuadro = await page.$$eval("#q-perfil .linha-barra .rotulo", (els) => els.map((e) => e.firstChild.textContent.trim()));
  confere(JSON.stringify(perfisQuadro) === JSON.stringify(Object.values(EV.PERFIL)), `quadro do perfil com os 5 perfis (${perfisQuadro.join(" / ")})`);
  await recorte(page, "#q-perfil", "quadro-perfil-1280");
  // Etapa 2 começa fechada: abre a múltipla dos ambientes.
  await page.click("[data-etapa='2'] > summary");
  const ambientes = await page.$$eval("#q-ambientes .linha-barra .rotulo", (els) => els.map((e) => e.firstChild.textContent.trim()));
  confere(JSON.stringify(ambientes) === JSON.stringify(EV.perguntaPorId("ambientes").opcoes), "quadro dos ambientes com todas as alternativas, sem Outro");
  await recorte(page, "#q-ambientes", "quadro-ambientes-1280");

  // Acordeão: abrir etapa 3 (escala) e 9 (condicionais).
  await page.click("[data-etapa='3'] > summary");
  await page.click("[data-etapa='9'] > summary");
  await recorte(page, "#q-seguranca", "quadro-escala-1280");
  await recorte(page, "#q-estado", "quadro-estado-1280");
  await recorte(page, "#q-cuidador_dificuldade", "quadro-condicional-1280");
  const chipCond = await page.textContent("#q-cuidador_dificuldade .quadro-meta");
  confere(chipCond.includes("só para cuidadores"), `condicional mostra "só para cuidadores" (${chipCond.trim()})`);
  const notaA2 = await page.textContent("#q-auxiliar_documentos");
  confere(notaA2.includes("Não usar esta resposta"), "nota da pergunta aparece");
  const multi = await page.textContent("#q-objecoes .quadro-meta");
  confere(multi.includes("cada pessoa pode marcar mais de uma"), "multipla avisa que pode marcar mais de uma");
  const est = await page.$$eval("#q-estado > .barras > li", (els) => els.length);
  confere(est === 27, `estado com 27 linhas (${est})`);
  // Atualizar não fecha a etapa aberta.
  await page.click("[data-atualizar]");
  await esperarCalmo(page);
  await page.waitForTimeout(300);
  confere(await page.evaluate(() => document.querySelector("[data-etapa='9']").open), "atualizar mantém etapa aberta");
  confere(await page.evaluate(() => document.querySelector("[data-etapa='2']").open), "atualizar mantém a etapa 2 aberta");

  // Cruzamento.
  const base = cruzamento(DADOS, {}, "perfil", "renda_atual").base;
  const txtBase = await page.textContent(".cruz-base");
  confere(txtBase.includes(`${new Intl.NumberFormat("pt-BR").format(base)} pessoas com as duas respostas`), `base do cruzamento (${txtBase.slice(0, 60)})`);
  await page.click("[data-modo='coluna']");
  await recorte(page, "#sec-cruzamento", "cruzamento-coluna-1280");
  await page.click("[data-modo='numeros']");
  const celula = await page.$$eval(".cruz tbody tr:first-child td.celula", (els) => els.map((e) => e.textContent));
  confere(celula.every((t) => /^\d+$/.test(t.replace(/\./g, ""))), "modo números mostra contagens");
  mock.chamadas = [];
  await page.selectOption("[data-cruz-linha]", "objecoes");
  await page.selectOption("[data-cruz-coluna]", "disposicao_investimento");
  await esperarCalmo(page);
  confere(mock.chamadas.some((c) => c.rota === "cruzamento" && c.url.includes("linha=objecoes") && c.url.includes("coluna=disposicao_investimento")), "cruzamento recarrega com os selects");
  await page.click("[data-modo='linha']");
  await recorte(page, "#sec-cruzamento", "cruzamento-objecoes-1280");
  await page.selectOption("[data-cruz-coluna]", "objecoes");
  confere((await page.textContent("[data-cruzamento]")).includes("duas perguntas diferentes"), "mesma pergunta nos dois selects pede diferentes");
  await page.selectOption("[data-cruz-coluna]", "seguranca");
  await esperarCalmo(page);
  await recorte(page, "#sec-cruzamento", "cruzamento-escala-1280");

  // Abertas.
  await page.click("[data-aberta='frase']");
  await esperarCalmo(page);
  const frase = await page.textContent("[data-abertas] .texto blockquote");
  confere(frase.startsWith("Eu gostaria muito de") && frase.includes("mas ainda não consegui porque"), `frase junta (${frase.slice(0, 80)})`);
  await page.fill("[data-abertas-busca]", "dinheiro");
  const achados = await page.$$eval("[data-abertas] .texto", (els) => els.length);
  confere(achados > 0 && (await page.$$eval("[data-abertas] mark", (els) => els.length)) > 0, `busca local destaca (${achados})`);
  await recorte(page, "#sec-abertas", "abertas-frase-1280");
  await page.fill("[data-abertas-busca]", "");
  await page.click("[data-aberta='problema']");
  await esperarCalmo(page);
  mock.chamadas = [];
  await page.click("[data-abertas-mais]");
  await page.waitForFunction(() => document.querySelectorAll("[data-abertas] .texto").length === 60);
  confere(mock.chamadas.some((c) => c.rota === "abertas" && c.url.includes("offset=30")), "abertas carregar mais offset=30");

  // Tráfego.
  await page.click("[data-campo='utm_campaign']");
  await recorte(page, "#sec-trafego", "trafego-campanha-1280");
  await page.click("[data-campo='dispositivo']");
  confere((await page.textContent("[data-trafego]")).includes("Celular"), "dispositivo traduzido");

  // Copiar ICP.
  await page.click("[data-copiar-icp]");
  const copiado = await page.evaluate(() => navigator.clipboard.readText());
  confere(copiado.includes("*Técnicos de enfermagem*") && copiado.includes("Idade:") && copiado.includes("de quem respondeu"), "copiar resumo do ICP gera texto puro");
  if (TELAS) fs.writeFileSync(path.join(TELAS, "icp-copiado.txt"), copiado);
  confere((await page.textContent("[data-copiado]")).includes("copiado"), "aviso de copiado");

  // Tabela do por dia.
  await page.click("[data-dia-tabela]");
  confere((await page.$$("[data-dia] table tbody tr")).length > 10, "por dia vira tabela");
  await recorte(page, "[data-dia]", "por-dia-tabela-1280");
  await page.click("[data-dia-tabela]");
  // Tooltip.
  const col = page.locator(".coluna").last();
  await col.scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  const caixa = await col.boundingBox();
  await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height - 20);
  await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height - 30);
  confere(await page.isVisible("[data-dica]"), "tooltip no por dia");
  await tela(page, "por-dia-tooltip-1280", { clip: await (async () => {
    const b = await page.locator("[data-dia]").boundingBox();
    return { x: b.x - 10, y: b.y - 10, width: b.width + 20, height: b.height + 20 };
  })() });
  confere(erros.length === 0, `sem erros (${erros.join(" | ")})`);
  await page.context().close();

  // Mobile das mesmas partes.
  const m = await novaPagina(browser, { largura: 390, altura: 844 });
  await m.page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(m.page);
  await m.page.click("[data-etapa='3'] > summary");
  await recorte(m.page, "#q-seguranca", "quadro-escala-390");
  await recorte(m.page, "#q-estado", "quadro-estado-390");
  await recorte(m.page, "#q-perfil", "quadro-perfil-390");
  await m.page.click("[data-aberta='frase']");
  await esperarCalmo(m.page);
  await recorte(m.page, "#sec-abertas", "abertas-frase-390");
  await m.page.evaluate(() => window.scrollTo(0, 1400));
  await m.page.waitForTimeout(200);
  await tela(m.page, "filtros-presos-390");
  const larguraDoc = await m.page.evaluate(() => document.documentElement.scrollWidth);
  confere(larguraDoc <= 390, `sem rolagem horizontal no celular depois de interações (${larguraDoc})`);
  confere(m.erros.length === 0, `sem erros mobile (${m.erros.join(" | ")})`);
  await m.page.context().close();
});

/* ---------------------------------------------------------------- Vazio e erros */
cenario("estados", async () => {
  for (const largura of [1280, 390]) {
    const { page, erros } = await novaPagina(browser, { dados: VAZIO, largura, altura: largura === 390 ? 844 : 800 });
    await page.waitForSelector("[data-panel-view]:not([hidden])");
    await esperarCalmo(page);
    confere(await page.isVisible("[data-vazio-geral]"), `estado vazio geral (${largura})`);
    confere((await page.textContent("[data-lista]")).includes("Ninguém se identificou"), "lista vazia");
    confere((await page.textContent("[data-icp]")).includes("Ainda sem perfis"), "ICP vazio");
    confere((await page.textContent("[data-cruzamento]")).includes("Ninguém respondeu as duas"), "cruzamento vazio");
    await tela(page, `vazio-${largura}`, { full: true });
    confere(erros.length === 0, `sem erros no vazio (${erros.join(" | ")})`);
    await page.context().close();
  }

  const { page, mock, erros } = await novaPagina(browser);
  mock.forcar.resumo = 502;
  mock.forcar.respostas = 502;
  mock.forcar.cruzamento = 502;
  mock.forcar.abertas = 502;
  await page.waitForSelector("[data-panel-view]:not([hidden])");
  await page.waitForSelector("[data-lista] .erro");
  await page.waitForSelector("[data-icp] .erro");
  confere((await page.textContent("[data-panel-status]")).includes("Não foi possível carregar"), "502 no status");
  confere((await page.$$(".erro [data-repetir]")).length >= 5, "botões Tentar de novo");
  await tela(page, "erro-502-1280", { full: true });
  delete mock.forcar.resumo;
  delete mock.forcar.respostas;
  delete mock.forcar.cruzamento;
  delete mock.forcar.abertas;
  await page.click("[data-icp] [data-repetir]");
  await esperarCalmo(page);
  confere((await page.$$(".icp-cartao")).length === 5, "tentar de novo recupera o resumo");
  await page.click("[data-lista] [data-repetir]");
  await page.waitForFunction(() => document.querySelectorAll("[data-pessoa]").length === 50);
  confere(true, "tentar de novo recupera a lista");
  // 503.
  mock.forcar.resumo = 503;
  await page.click("[data-atualizar]");
  await page.waitForFunction(() => document.querySelector("[data-panel-status]").textContent.includes("não está configurado"));
  confere(true, "503 diz banco não configurado");
  // Sem rede.
  delete mock.forcar.resumo;
  mock.offline = true;
  await page.click("[data-atualizar]");
  await page.waitForFunction(() => document.querySelector("[data-panel-status]").textContent.includes("Sem conexão"));
  confere(true, "sem rede não lança e avisa");
  mock.offline = false;
  const naoEsperados = erros.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|502|503/.test(e));
  confere(naoEsperados.length === 0, `só erros de rede esperados (${naoEsperados.join(" | ")})`);
  await page.context().close();

  // Carregando (esqueleto).
  const c = await novaPagina(browser, { largura: 390, altura: 844 });
  c.mock.atraso.resumo = 4000;
  await c.page.waitForSelector("[data-panel-view]:not([hidden])");
  await c.page.waitForTimeout(300);
  await tela(c.page, "carregando-390");
  await c.page.context().close();
});


test("todas as checagens rodaram", () => {
  // 9 cenários acima; o número exato muda quando um cenário ganha checagem, o piso não.
  assert.ok(checagens >= 130, `só ${checagens} checagens rodaram`);
  assert.ok(todasAsChamadas.length > 100);
  assert.deepEqual(todasAsChamadas.filter((url) => /_outro/.test(url)), [], "o painel nunca pede complemento de Outro");
  console.log(`# painel: ${checagens} checagens`);
});
