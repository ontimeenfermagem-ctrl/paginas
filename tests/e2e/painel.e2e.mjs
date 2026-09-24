// O painel /painel no Chromium, de ponta a ponta na tela, com a API do painel interceptada no
// navegador e respondida por fixtures coerentes com o contrato (tests/e2e/apoio/painel-fixtures.mjs:
// 800 pessoas e 1.320 visitantes gerados com semente fixa, e os agregados que o SQL devolveria).
//
// As páginas vêm do server.mjs de verdade (CSP, cabeçalhos, allowlist); os números do SQL de
// verdade são provados em sql.e2e.mjs e no fluxo.e2e.mjs. Aqui: login e seus erros, placar, funil,
// abas dos 4 perfis, a aba "Páginas de obrigado" (funil por página, % com base, perfis, origem,
// dia, link do grupo), UMA ABA POR PÁGINA DE INSCRIÇÃO (Viver de Furo e Imersão GPS: números do
// formulário e da Hotmart, divisões por UTM com o sck de cada página marcado, vendas por sck,
// troca de página sem número de uma na outra, teclado, link antigo ?pagina=inscricoes, servidor
// com o SQL antigo), filtros e URL, corrida de respostas, sessão expirada, atualização automática,
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
import { abertas, CHK, comoSqlAntigo, cruzamento, EV, gerar, inscricoesResumo, lista, listaInscricoes, OBR, paginas, painel } from "./apoio/painel-fixtures.mjs";

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
const VAZIO = { visitantes: [], pessoas: [], eventos: [], inscricoes: [], compras: [] };

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
    sqlAntigo: false, // true = /inscricoes responde como o SQL de antes (sem mídia, conteúdo e vendas)
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
        if (rota === "paginas") return json(200, { ok: true, paginas: paginas(mock.dados, filtros), gerado_em: new Date().toISOString() });
        if (rota === "inscricoes") {
          if (q.pagina && !CHK.LISTA.some((p) => p.id === q.pagina)) return json(422, { ok: false, error: "invalid_filters" });
          const recorte = { desde: q.desde, ate: q.ate, pagina: q.pagina };
          const listaIns = listaInscricoes(mock.dados, recorte, { limite: Number(q.limite || 100), offset: Number(q.offset || 0) });
          const resumo = inscricoesResumo(mock.dados, recorte);
          return json(200, { ok: true, resumo: mock.sqlAntigo ? comoSqlAntigo(resumo, mock.dados, recorte) : resumo, ...listaIns, gerado_em: new Date().toISOString() });
        }
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

async function novaPagina(browser, { largura = 1280, altura = 800, logado = true, dados, url = "/painel", antes } = {}) {
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
  if (antes) await antes(page);
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
      // Todos + os 4 perfis (sem "Outro" nem "Estudante"), na ordem do config.
      confere(abas.length === 5 && abas[0].includes("Todos") && abas[0].includes("800"), `abas de perfil: ${abas.join(" / ")}`);
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
      // ICP: 4 cartões (um por perfil com gente) — sem "sem perfil".
      const cartoes = await page.$$eval(".icp-cartao h3", (els) => els.map((e) => e.textContent));
      confere(JSON.stringify(cartoes) === JSON.stringify(Object.values(EV.PERFIL).map((v) => EV.PERFIL_CURTO[v])), `4 cartões de ICP (${cartoes.join(", ")})`);
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
    const paginaObrigado = OBR.paginaDoPerfil(perfil);
    confere(
      texto.includes("Página de obrigado") && texto.includes(`${paginaObrigado.nome} (${paginaObrigado.rota})`) && !texto.includes("ao terminar"),
      `${EV.PERFIL_CURTO[perfil]}: Ver tudo mostra a página de obrigado (${paginaObrigado.rota})`
    );
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
  confere(
    (await page.textContent(`#det-${parada.id}`)).includes("Obrigado — Evento Gratuito de Outubro (/obrigado-evento-outubro) · vai para ela ao terminar"),
    "em andamento: a página de obrigado para onde vai ao terminar"
  );
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
  confere((await page.$$(".icp-cartao")).length === Object.keys(EV.PERFIL).length, "tentar de novo recupera o resumo");
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

/* ---------------------------------------------------------------- Páginas de obrigado */
cenario("obrigado", async () => {
  const fmt = (x) => new Intl.NumberFormat("pt-BR").format(x);
  const pctTxt = (parte, base) => `${Math.round((parte / base) * 100)}%`;
  const numero = (page, id, etapa) => page.textContent(`[data-obrigado-pagina='${id}'] [data-etapa='${etapa}'] .num strong`).then((t) => t.trim());

  for (const [largura, altura] of [[1280, 800], [390, 844]]) {
    const { page, mock, erros } = await novaPagina(browser, { largura, altura });
    await page.waitForSelector("[data-panel-view]:not([hidden])");
    await esperarCalmo(page);

    const abas = await page.$$eval("[data-paginas] [data-pagina]", (els) => els.map((e) => `${e.dataset.pagina}|${e.textContent}`));
    confere(
      abas.length === 2 + CHK.LISTA.length && abas[0].startsWith("pesquisa-icp|") && abas[1] === "obrigado|Páginas de obrigadorota /obrigado-*",
      `faixa de páginas (${abas.join(" / ")})`
    );
    confere(!mock.chamadas.some((c) => c.rota === "paginas"), "a aba de obrigado só busca dados quando é aberta");

    mock.chamadas = [];
    await page.click("[data-paginas] [data-pagina='obrigado']");
    await page.waitForSelector("[data-obrigado] .obr-cartao [data-etapa]");
    await esperarCalmo(page);
    confere(new URL(page.url()).searchParams.get("pagina") === "obrigado", `a URL guarda a aba (${page.url()})`);
    confere((await page.getAttribute("#pagina-obrigado", "aria-selected")) === "true", "aba de obrigado selecionada");
    confere(await page.isHidden("[data-pagina-conteudo='pesquisa-icp']"), "conteúdo da pesquisa escondido");
    confere(await page.isVisible("[data-periodos]"), "o período continua na barra");
    confere((await page.isHidden("[data-perfis]")) && (await page.isHidden(".filtros-pessoa")), "perfil, busca e situação somem na aba de obrigado");
    confere(!mock.chamadas.some((c) => c.rota === "resumo"), "abrir a aba não recarrega a pesquisa");

    const r = paginas(DADOS, {});
    const ids = await page.$$eval("[data-obrigado-pagina]", (els) => els.map((e) => e.dataset.obrigadoPagina));
    confere(JSON.stringify(ids) === JSON.stringify(["afericao", "cuidador", "evento_outubro"]), `um cartão por página, na ordem (${ids})`);
    for (const linha of r) {
      const pagina = OBR.LISTA.find((p) => p.id === linha.pagina);
      const cartao = `[data-obrigado-pagina='${linha.pagina}']`;
      confere((await numero(page, linha.pagina, "atribuidas")) === fmt(linha.atribuidas), `${linha.pagina}: concluídas atribuídas = ${linha.atribuidas}`);
      confere((await numero(page, linha.pagina, "visitantes")) === fmt(linha.visitantes), `${linha.pagina}: chegaram = ${linha.visitantes}`);
      confere((await numero(page, linha.pagina, "clicaram")) === fmt(linha.clicaram), `${linha.pagina}: clicaram = ${linha.clicaram}`);
      const subChegaram = await page.textContent(`${cartao} [data-etapa='visitantes'] small`);
      confere(
        subChegaram.includes(`${pctTxt(linha.visitantes, linha.atribuidas)} das ${fmt(linha.atribuidas)} pesquisas concluídas atribuídas`) && subChegaram.includes(`${fmt(linha.visitas)} visitas no total`),
        `${linha.pagina}: % de quem chegou com a base explícita (${subChegaram})`
      );
      const subClicaram = await page.textContent(`${cartao} [data-etapa='clicaram'] small`);
      confere(
        subClicaram.includes(`${pctTxt(linha.clicaram, linha.visitantes)} das ${fmt(linha.visitantes)} pessoas que chegaram`) &&
          subClicaram.includes(`${pctTxt(linha.clicaram, linha.atribuidas)} das concluídas`),
        `${linha.pagina}: % de quem clicou com a base explícita (${subClicaram})`
      );
      const cabeca = await page.textContent(`${cartao} .obr-cabeca`);
      confere(cabeca.includes(pagina.nome) && cabeca.includes(pagina.rota), `${linha.pagina}: nome e rota no cartão`);
      confere(pagina.perfis.every((perfil) => cabeca.includes(EV.PERFIL_CURTO[perfil])), `${linha.pagina}: perfis que caem na página`);
      confere(cabeca.includes("Link do grupo ainda não configurado") && (await page.$$(`${cartao} .obr-grupo a`)).length === 0, `${linha.pagina}: aviso de link não configurado, sem link quebrado`);
      const origens = await page.$$eval(`${cartao} [data-divisao='origem'] tbody tr`, (trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent.trim())));
      const primeira = linha.por_origem[0];
      confere(origens.length === linha.por_origem.length && origens[0][0] === primeira.utm_source && origens[0][1] === fmt(primeira.visitantes), `${linha.pagina}: por origem (${origens[0]})`);
      const dias = await page.$$eval(`${cartao} [data-divisao='dia'] tbody tr`, (trs) => trs.length);
      confere(dias === Math.min(14, linha.por_dia.length), `${linha.pagina}: uma linha por dia, até 14 (${dias})`);
    }

    // Página do evento: Técnico e Enfermeiro na mesma página, contados separados.
    const evento = r.find((l) => l.pagina === "evento_outubro");
    const linhasPerfil = await page.$$eval("[data-obrigado-pagina='evento_outubro'] [data-divisao='perfil'] tbody tr", (trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent.trim())));
    for (const chave of ["tecnico", "enfermeiro"]) {
      const perfil = EV.PERFIL[chave];
      const esperado = evento.por_perfil.find((x) => x.perfil === perfil);
      const tr = linhasPerfil.find((l) => l[0] === EV.PERFIL_CURTO[perfil]);
      confere(
        tr && tr[1] === fmt(esperado.atribuidas) && tr[2] === fmt(esperado.visitantes) && tr[3] === `${fmt(esperado.clicaram)} · ${pctTxt(esperado.clicaram, esperado.visitantes)}`,
        `evento_outubro: ${chave} separado (${tr})`
      );
    }
    confere(linhasPerfil.some((l) => l[0] === "Sem perfil (abriu o link direto)" && l[1] === "—"), "acesso direto aparece como 'sem perfil'");
    confere((await page.textContent("[data-obrigado-pagina='evento_outubro'] [data-divisao='perfil'] caption")).includes("Técnicos de enfermagem e Enfermeiros dividem esta página"), "legenda da divisão na página do evento");

    // "Por dia": as 2 semanas mais recentes primeiro; o resto abre num clique, com o foco no botão.
    if (evento.por_dia.length > 14) {
      await page.click("[data-obr-dias='evento_outubro']");
      const todosDias = await page.$$eval("[data-obrigado-pagina='evento_outubro'] [data-divisao='dia'] tbody th", (ths) => ths.map((th) => th.textContent));
      confere(todosDias.length === evento.por_dia.length, `Ver todos os dias (${todosDias.length})`);
      confere((await page.evaluate(() => document.activeElement && document.activeElement.dataset.foco)) === "obr-dias-evento_outubro", "foco fica no botão dos dias");
      await page.click("[data-obr-dias='evento_outubro']");
    }

    const soma = r.reduce((t, l) => ({ a: t.a + l.atribuidas, v: t.v + l.visitantes, c: t.c + l.clicaram }), { a: 0, v: 0, c: 0 });
    const placar = await page.$$eval("[data-obrigado] .obr-placar .valor", (els) => els.map((e) => e.textContent.trim()));
    confere(JSON.stringify(placar) === JSON.stringify([fmt(soma.a), fmt(soma.v), fmt(soma.c)]), `placar somado (${placar})`);

    const larguraDoc = await page.evaluate(() => document.documentElement.scrollWidth);
    confere(larguraDoc <= largura, `obrigado: sem rolagem horizontal em ${largura}px (scrollWidth ${larguraDoc})`);
    const transbordam = await page.$$eval("[data-obrigado] .tabela-rolagem", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    confere(transbordam === 0, `obrigado: nenhuma tabela rola de lado em ${largura}px (${transbordam})`);
    await tela(page, `obrigado-${largura}`, { full: true });
    await recorte(page, "[data-obrigado-pagina='evento_outubro']", `obrigado-evento-${largura}`);

    if (largura === 1280) {
      // Período da barra: vale aqui e só recarrega a aba aberta.
      mock.chamadas = [];
      await page.click("[data-periodo='7']");
      await page.waitForFunction(() => document.querySelector("[data-periodo='7']").getAttribute("aria-pressed") === "true");
      await esperarCalmo(page);
      const chamada = mock.chamadas.find((c) => c.rota === "paginas");
      confere(chamada && chamada.url.includes("desde="), `período vai para a API (${chamada && chamada.url})`);
      confere(!mock.chamadas.some((c) => c.rota === "resumo"), "trocar o período na aba de obrigado não recarrega a pesquisa");
      const r7 = paginas(DADOS, { desde: new URL(BASE + chamada.url).searchParams.get("desde") });
      const e7 = r7.find((l) => l.pagina === "evento_outubro");
      await page.waitForFunction(
        (esperado) => document.querySelector("[data-obrigado-pagina='evento_outubro'] [data-etapa='atribuidas'] .num strong")?.textContent.trim() === esperado,
        fmt(e7.atribuidas)
      );
      confere((await numero(page, "evento_outubro", "clicaram")) === fmt(e7.clicaram), `7 dias: clicaram = ${e7.clicaram}`);
      confere((await page.textContent("[data-obrigado-periodo]")).includes("Últimos 7 dias"), "rótulo do período");
      confere(new URL(page.url()).searchParams.get("periodo") === "7", "período na URL");

      mock.chamadas = [];
      await page.click("[data-atualizar]");
      await esperarCalmo(page);
      confere(mock.chamadas.some((c) => c.rota === "paginas") && !mock.chamadas.some((c) => c.rota === "resumo"), "Atualizar recarrega só a aba aberta");

      // De volta à pesquisa: filtros de pessoa voltam, com o mesmo período.
      mock.chamadas = [];
      await page.click("[data-paginas] [data-pagina='pesquisa-icp']");
      await esperarCalmo(page);
      confere(await page.isVisible("[data-perfis]"), "abas de perfil voltam na pesquisa");
      const resumo = mock.chamadas.find((c) => c.rota === "resumo");
      confere(resumo && resumo.url.includes("desde="), "a pesquisa usa o mesmo período");
      confere(!new URL(page.url()).searchParams.has("pagina"), "aba padrão não vai para a URL");

      // Erro do banco: aviso, Tentar de novo e recuperação.
      mock.forcar.paginas = 502;
      await page.click("[data-paginas] [data-pagina='obrigado']");
      await page.waitForSelector("[data-obrigado] .erro [data-repetir='obrigado']");
      confere((await page.textContent("[data-obrigado-status]")).includes("Não foi possível carregar"), "502 avisa no status");
      confere((await page.$$("[data-obrigado] .obr-cartao")).length === 0, "sem número velho na tela depois do erro");
      await tela(page, "obrigado-erro-1280");
      delete mock.forcar.paginas;
      await page.click("[data-obrigado] [data-repetir='obrigado']");
      await page.waitForSelector("[data-obrigado] .obr-cartao [data-etapa]");
      confere((await page.textContent("[data-obrigado-status]")).trim() === "", "Tentar de novo recupera");

      // Sessão vencida: volta ao login.
      mock.logado = false;
      await page.click("[data-atualizar]");
      await page.waitForSelector("[data-login-view]:not([hidden])");
      confere((await page.textContent("[data-login-status]")).includes("sessão expirou"), "401 na aba de obrigado volta ao login");
    }
    const naoEsperados = erros.filter((e) => !/Failed to load resource|502/.test(e));
    confere(naoEsperados.length === 0, `obrigado: sem erros de JavaScript em ${largura}px (${naoEsperados.join(" | ")})`);
    await page.context().close();
  }

  // Aberta direto pela URL, sem ninguém ainda: estado vazio caprichado e cartões com a configuração.
  const v = await novaPagina(browser, { dados: VAZIO, url: "/painel?pagina=obrigado", largura: 390, altura: 844 });
  await v.page.waitForSelector("[data-obrigado-vazio]");
  confere((await v.page.textContent("[data-obrigado-vazio]")).includes("Ninguém chegou às páginas de obrigado ainda"), "vazio geral");
  confere((await v.page.$$eval("[data-obrigado] .obr-cartao .vazio", (els) => els.length)) === OBR.LISTA.length, "cada cartão diz que ninguém passou por ele");
  confere((await v.page.$$eval("[data-obrigado] .obr-cartao [data-sem-link]", (els) => els.length)) === OBR.LISTA.length, "vazio ainda mostra o aviso do link");
  confere(!v.mock.chamadas.some((c) => c.rota === "resumo"), "aberta direto na aba de obrigado, a pesquisa não carrega");
  confere((await v.page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "vazio sem rolagem horizontal em 390px");
  await tela(v.page, "obrigado-vazio-390", { full: true });
  confere(v.erros.length === 0, `vazio sem erros (${v.erros.join(" | ")})`);
  await v.page.context().close();

  // Link do grupo configurado: o config servido é trocado só neste navegador (o arquivo não muda).
  const LINK = "https://chat.whatsapp.com/AbCdEf123456";
  const c = await novaPagina(browser, {
    url: "/painel?pagina=obrigado",
    antes: (page) =>
      page.route("**/js/obrigado-config.js*", async (route) => {
        const original = await route.fetch();
        const corpo = (await original.text()).replace('afericao: ""', `afericao: "${LINK}"`);
        await route.fulfill({ response: original, body: corpo });
      })
  });
  await c.page.waitForSelector("[data-obrigado] .obr-cartao [data-etapa]");
  confere((await c.page.getAttribute("[data-obrigado-pagina='afericao'] .obr-grupo a", "href")) === LINK, "link configurado vira link do grupo");
  confere((await c.page.getAttribute("[data-obrigado-pagina='afericao'] .obr-grupo a", "rel")) === "noopener noreferrer", "link do grupo com rel seguro");
  confere((await c.page.$$("[data-obrigado-pagina='afericao'] [data-sem-link]")).length === 0, "página com link não mostra o aviso");
  confere((await c.page.$$("[data-obrigado] [data-sem-link]")).length === 2, "as outras duas continuam avisando");
  await recorte(c.page, "[data-obrigado-pagina='afericao'] .obr-cabeca", "obrigado-link-configurado-1280");
  confere(c.erros.length === 0, `link configurado sem erros (${c.erros.join(" | ")})`);
  await c.page.context().close();
});


/* ---------------------------------------------------------------- Inscrições e vendas: uma aba por página */
cenario("inscricoes", async () => {
  const fmt = (x) => new Intl.NumberFormat("pt-BR").format(x);
  // O real do Intl vem com espaço fino inquebrável: tudo é comparado com os espaços normalizados.
  const limpo = (t) => String(t).replace(/\s+/g, " ").trim();
  const moeda = (valor) => limpo(new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor));
  const VDF = CHK.PAGINAS["viver-de-furo"];
  const GPS = CHK.PAGINAS["imersao-gps"];
  const idAba = (pagina) => `inscricoes-${pagina.id}`;
  const cartao = (pagina) => `[data-inscricao-pagina='${pagina.id}']`;
  const texto = (page, seletor) => page.textContent(seletor).then(limpo);
  const tabela = (page, seletor) =>
    page.$$eval(`${seletor} tbody tr`, (trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent.replace(/\s+/g, " ").trim())));
  const DIVISOES = [
    ["origem", "por_origem", "utm_source"],
    ["midia", "por_midia", "utm_medium"],
    ["campanha", "por_campanha", "utm_campaign"],
    ["conteudo", "por_conteudo", "utm_content"],
    ["termo", "por_termo", "utm_term"]
  ];

  // Os dados que a fixture tem de ter para o cenário valer alguma coisa (senão o teste passa à toa).
  const rVdf = inscricoesResumo(DADOS, { pagina: VDF.id }).paginas[0];
  const rGps = inscricoesResumo(DADOS, { pagina: GPS.id }).paginas[0];
  confere(CHK.sckDaPagina(VDF) === "utm_term" && CHK.sckDaPagina(GPS) === "utm_content", "o sck é utm_term na Viver de Furo e utm_content na Imersão GPS");
  confere(rVdf.inscritos === 120 && rGps.inscritos === 90, `fixture: 120 e 90 inscritos (${rVdf.inscritos}, ${rGps.inscritos})`);
  confere(rGps.vendas > rGps.compras && rVdf.vendas > rVdf.compras, `fixture: a Hotmart tem venda sem inscrição (${rGps.vendas} > ${rGps.compras})`);
  confere(rGps.vendas_por_sck.reduce((s, x) => s + x.vendas, 0) === rGps.vendas, "fixture: vendas por sck somam as vendas");
  confere(rGps.vendas_por_sck.reduce((s, x) => s + x.casadas, 0) === rGps.compras, "fixture: as casadas da Hotmart são as compras de inscritos (no período inteiro)");
  confere(rGps.vendas_por_sck.some((x) => x.sck === "(sem sck)") && rGps.vendas_por_sck.some((x) => x.sck === "HOTMART_SALES_AGENT"), "fixture: venda sem sck e da própria Hotmart");
  // À mão: GPS = 32 ingressos casados, 1 reembolsado (sai), 3 vendas sem inscrição e 1 chargeback
  // (sai); a completa repete a transação e não soma. Viver de Furo = 16 casadas, 1 reembolso, 2 de fora.
  const aprovadasGps = new Set(DADOS.compras.filter((c) => c.pagina === GPS.id && c.evento === "PURCHASE_APPROVED").map((c) => c.transacao));
  const desfeitasGps = new Set(DADOS.compras.filter((c) => c.pagina === GPS.id && ["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK"].includes(c.evento)).map((c) => c.transacao));
  confere(rGps.vendas === aprovadasGps.size - desfeitasGps.size && desfeitasGps.size === 2, `vendas GPS contadas à mão: ${aprovadasGps.size} aprovadas - ${desfeitasGps.size} desfeitas = ${rGps.vendas}`);
  confere(rVdf.vendas === rVdf.compras + 2, `vendas Viver de Furo = compras + 2 de fora (${rVdf.vendas})`);
  confere(!inscricoesResumo(DADOS, { pagina: GPS.id }).compras_recentes.some((c) => c.pagina !== GPS.id), "fixture: a aba GPS só recebe avisos do produto dela");
  for (const pagina of [VDF, GPS]) {
    const r = inscricoesResumo(DADOS, { pagina: pagina.id });
    const [l] = r.paginas;
    confere(r.compras_sem_inscricao === l.vendas - l.vendas_por_sck.reduce((s, x) => s + x.casadas, 0), `fixture ${pagina.id}: compras_sem_inscricao = vendas − casadas (${r.compras_sem_inscricao})`);
  }
  // A régua das vendas do SQL (estado pela hora do EVENTO, contada no período da aprovação), com os
  // casos que a régua de antes ("último aviso que chegou no período") erraria:
  const avisosDe = (transacao) => DADOS.compras.filter((c) => c.transacao === transacao);
  const ms = (iso) => new Date(iso).getTime();
  //  . o APPROVED reenviado DEPOIS do REFUNDED (a primeira entrega falhou) não ressuscita a venda;
  const reenviada = DADOS.compras.find((c) => c.evento === "PURCHASE_REFUNDED" && avisosDe(c.transacao).some((a) => a.evento === "PURCHASE_APPROVED" && ms(a.recebido_em) > ms(c.recebido_em)));
  const aprovadasVdf = new Set(DADOS.compras.filter((c) => c.pagina === VDF.id && c.evento === "PURCHASE_APPROVED").map((c) => c.transacao));
  const desfeitasVdf = new Set(DADOS.compras.filter((c) => c.pagina === VDF.id && c.evento === "PURCHASE_REFUNDED").map((c) => c.transacao));
  confere(reenviada && reenviada.pagina === VDF.id && rVdf.vendas === aprovadasVdf.size - desfeitasVdf.size, `fixture: APPROVED que chegou depois do REFUNDED não conta (${rVdf.vendas} = ${aprovadasVdf.size} − ${desfeitasVdf.size})`);
  //  . a completa que chegou sem sck deixa a venda no sck da aprovada;
  const completaSemSck = DADOS.compras.find((c) => c.evento === "PURCHASE_COMPLETE" && !c.sck);
  const sckDaAprovada = avisosDe(completaSemSck.transacao).find((c) => c.evento === "PURCHASE_APPROVED").sck;
  const vendasGps = [...aprovadasGps].filter((t) => !desfeitasGps.has(t));
  const porSckAMao = {};
  for (const t of vendasGps) {
    const sck = avisosDe(t).find((c) => c.evento === "PURCHASE_APPROVED").sck || "(sem sck)";
    porSckAMao[sck] = (porSckAMao[sck] || 0) + 1;
  }
  confere(
    Boolean(sckDaAprovada) && rGps.vendas_por_sck.every((x) => porSckAMao[x.sck] === x.vendas) && Object.keys(porSckAMao).length === rGps.vendas_por_sck.length,
    `fixture: a completa sem sck fica no sck da aprovada (${sckDaAprovada})`
  );
  //  . e a completa, dias depois, não vira venda do período dela.
  const completa = DADOS.compras.find((c) => c.evento === "PURCHASE_COMPLETE");
  const depoisDaAprovacao = new Date(ms(completa.aprovado_em) + 60000).toISOString();
  const aprovadasDepois = vendasGps.filter((t) => ms(avisosDe(t).find((c) => c.evento === "PURCHASE_APPROVED").aprovado_em) >= ms(depoisDaAprovacao));
  confere(
    ms(completa.evento_em) > ms(depoisDaAprovacao) && inscricoesResumo(DADOS, { desde: depoisDaAprovacao, pagina: GPS.id }).paginas[0].vendas === aprovadasDepois.length,
    `fixture: a completa não vira venda do período dela (${aprovadasDepois.length})`
  );

  /** Confere a aba aberta inteira contra o que o SQL devolveria para esta página e recorte. */
  async function conferirAba(page, mock, pagina, recorte, rotulo) {
    const r = inscricoesResumo(DADOS, { ...recorte, pagina: pagina.id });
    const linha = r.paginas[0];
    const sck = CHK.sckDaPagina(pagina);
    const c = cartao(pagina);
    const pedido = mock.chamadas.filter((x) => x.rota === "inscricoes").at(-1);
    const q = new URL(BASE + pedido.url).searchParams;
    confere(q.get("pagina") === pagina.id && (q.get("desde") || "") === (recorte.desde || ""), `${rotulo}: pediu ?pagina=${pagina.id} (${pedido.url})`);
    confere((await page.$$("[data-inscricao-pagina]")).length === 1 && (await page.$$(c)).length === 1, `${rotulo}: um cartão só, o da página`);

    // Placar: formulário x Hotmart, lado a lado.
    const placar = await page.$$eval("[data-inscricoes] .ins-placar li", (lis) =>
      lis.map((li) => ({ chave: li.dataset.placarIns, valor: li.querySelector(".valor").textContent.trim(), detalhe: li.querySelector(".detalhe").textContent.replace(/\s+/g, " ").trim() }))
    );
    confere(placar.map((p) => p.chave).join() === "inscritos,cliques,compras,vendas", `${rotulo}: placar (${placar.map((p) => p.chave)})`);
    confere(placar[0].valor === fmt(linha.inscritos) && placar[1].valor === fmt(linha.cliques), `${rotulo}: placar inscritos ${linha.inscritos}, cliques ${linha.cliques}`);
    const taxa = `${Math.round((linha.compras / linha.inscritos) * 100)}% dos ${fmt(linha.inscritos)} inscritos`;
    confere(placar[2].valor === fmt(linha.compras) && placar[2].detalhe.includes(taxa) && placar[2].detalhe.includes(moeda(linha.receita)), `${rotulo}: compras de inscritos ${linha.compras} (${placar[2].detalhe})`);
    // O mesmo número do SQL: compras_sem_inscricao (= vendas − casadas quando a tabela tem todos os sck).
    const semInscricao = r.compras_sem_inscricao;
    confere(semInscricao === linha.vendas - linha.vendas_por_sck.reduce((s, x) => s + x.casadas, 0), `${rotulo}: sem inscrição = vendas − casadas (${semInscricao})`);
    confere(
      placar[3].valor === fmt(linha.vendas) && placar[3].detalhe.includes(moeda(linha.vendas_receita)) && placar[3].detalhe.includes(`${fmt(semInscricao)} sem inscrição`),
      `${rotulo}: vendas na Hotmart ${linha.vendas}, ${semInscricao} sem inscrição (${placar[3].detalhe})`
    );

    // Funil do formulário.
    const etapa = (nome) => texto(page, `${c} [data-etapa='${nome}'] .num strong`);
    confere((await etapa("inscritos")) === fmt(linha.inscritos) && (await etapa("cliques")) === fmt(linha.cliques) && (await etapa("compras")) === fmt(linha.compras), `${rotulo}: funil`);
    const subCompras = await texto(page, `${c} [data-etapa='compras'] .rotulo small`);
    confere(subCompras.includes(`${Math.round((linha.compras / linha.inscritos) * 100)}% dos ${fmt(linha.inscritos)} inscritos`), `${rotulo}: taxa com a base escrita (${subCompras})`);
    confere((await texto(page, `${c} [data-etapa='compras'] .rotulo`)).startsWith("Compras de inscritos"), `${rotulo}: o funil diz "compras de inscritos"`);

    // Lado da Hotmart: de onde veio cada venda, pelo sck.
    confere((await texto(page, `${c} [data-vendas]`)) === fmt(linha.vendas) && (await texto(page, `${c} [data-vendas-receita]`)) === moeda(linha.vendas_receita), `${rotulo}: total da Hotmart`);
    const textoHotmart = await texto(page, `${c} [data-ins-hotmart]`);
    confere(textoHotmart.includes("inclusive de quem comprou sem passar pelo formulário") && textoHotmart.includes("compras de inscritos"), `${rotulo}: a diferença entre vendas e compras de inscritos está escrita`);
    confere(
      (await texto(page, `${c} [data-vendas-casadas]`)) === `${fmt(linha.vendas - semInscricao)} ${linha.vendas - semInscricao === 1 ? "casada" : "casadas"} com inscrição · ${fmt(semInscricao)} sem inscrição`,
      `${rotulo}: casadas x sem inscrição`
    );
    const porSck = await tabela(page, `${c} [data-ins-hotmart]`);
    confere(porSck.length === linha.vendas_por_sck.length, `${rotulo}: ${linha.vendas_por_sck.length} linhas por sck`);
    confere(
      linha.vendas_por_sck.every((x, i) => porSck[i][0] === x.sck && porSck[i][1] === fmt(x.vendas) && porSck[i][2] === moeda(x.receita) && porSck[i][3] === fmt(x.casadas)),
      `${rotulo}: cada linha por sck (${porSck.map((l) => l.join("|")).join(" / ")})`
    );
    confere((await texto(page, `${c} [data-ins-hotmart] caption`)).includes(`O sck é o ${sck}`), `${rotulo}: a legenda diz de qual UTM sai o sck`);

    // Divisões dos inscritos por UTM, a do sck marcada.
    for (const [divisao, lista, campo] of DIVISOES) {
      const linhas = await tabela(page, `${c} [data-divisao='${divisao}']`);
      const dados = linha[lista];
      confere(
        linhas.length === dados.length && dados.every((x, i) => linhas[i][0] === String(x[campo]) && linhas[i][1] === fmt(x.inscritos) && linhas[i][2].startsWith(fmt(x.compras))),
        `${rotulo}: por ${divisao} (${linhas.map((l) => l[0]).join(", ")})`
      );
    }
    const marcadas = await page.$$eval(`${c} [data-divisao][data-sck]`, (els) => els.map((e) => ({ id: e.dataset.divisao, titulo: e.querySelector("h5").textContent, legenda: e.querySelector("caption")?.textContent || "" })));
    const esperada = sck === "utm_content" ? "conteudo" : "termo";
    confere(marcadas.length === 1 && marcadas[0].id === esperada && marcadas[0].titulo.includes("(sck)"), `${rotulo}: só a divisão ${esperada} é o sck (${JSON.stringify(marcadas)})`);
    confere(marcadas[0].legenda.includes(`O ${sck} vai para a Hotmart como sck: é o criativo que aparece no relatório de vendas de lá`), `${rotulo}: legenda do sck`);
    const outrosTitulos = await page.$$eval(`${c} [data-divisao]:not([data-sck]) h5`, (els) => els.map((e) => e.textContent));
    confere(outrosTitulos.length === 5 && outrosTitulos.every((t) => !t.includes("(sck)")), `${rotulo}: as outras divisões sem a marca (${outrosTitulos.join(" / ")})`);
    confere((await page.getAttribute(`${c} [data-sck-da-pagina]`, "data-sck-da-pagina")) === sck, `${rotulo}: o cartão diz qual UTM é o sck`);
    const dias = await page.$$eval(`${c} [data-divisao='dia'] tbody tr`, (trs) => trs.length);
    confere(dias === Math.min(14, linha.por_dia.length), `${rotulo}: por dia até 14 linhas (${dias})`);

    // Compras recentes: o sck de cada aviso, compacto embaixo do nome.
    const recentes = await tabela(page, "[data-inscricoes] .ins-compras");
    confere(recentes.length === r.compras_recentes.length, `${rotulo}: ${r.compras_recentes.length} avisos recentes`);
    const sckAvisos = await page.$$eval("[data-inscricoes] .ins-compras tbody tr [data-sck-aviso]", (els) => els.map((e) => e.textContent.trim()));
    confere(
      sckAvisos.length === r.compras_recentes.length && r.compras_recentes.every((x, i) => sckAvisos[i] === (x.sck ? `sck ${x.sck}` : "sem sck")),
      `${rotulo}: o sck de cada aviso (${sckAvisos.slice(0, 4).join(" / ")}...)`
    );
    const orfas = await page.$$eval("[data-inscricoes] .ins-compras tbody tr.ins-orfa", (trs) => trs.length);
    confere(orfas === r.compras_recentes.filter((x) => !x.casou).length, `${rotulo}: avisos sem inscrição destacados (${orfas})`);
    if (semInscricao) {
      const aviso = await texto(page, "[data-ins-aviso]");
      confere(aviso.includes(`${fmt(semInscricao)} ${semInscricao === 1 ? "venda da Hotmart não casou" : "vendas da Hotmart não casaram"}`), `${rotulo}: aviso com o mesmo número do placar (${aviso.slice(0, 60)})`);
    } else {
      confere((await page.$$("[data-ins-aviso]")).length === 0, `${rotulo}: sem venda órfã, sem aviso`);
    }

    // Inscritos: a origem mostra o valor do sck DESTA página.
    const listaEsperada = listaInscricoes(DADOS, { ...recorte, pagina: pagina.id }, { limite: 50 });
    const pessoas = await page.$$eval("[data-inscricoes] .ins-pessoa", (els) => els.map((e) => ({ id: e.dataset.inscrito, origem: e.querySelector(".pessoa-origem").textContent })));
    confere(pessoas.length === listaEsperada.itens.length && pessoas.every((p, i) => p.id === listaEsperada.itens[i].id), `${rotulo}: lista com os ${listaEsperada.itens.length} mais recentes`);
    confere(
      listaEsperada.itens.every((item, i) => (item[sck] ? pessoas[i].origem.includes(`sck ${item[sck]}`) : !pessoas[i].origem.includes("sck "))),
      `${rotulo}: origem mostra o ${sck} como sck`
    );
    const outra = sck === "utm_content" ? "utm_term" : "utm_content";
    confere(listaEsperada.itens.every((item, i) => !item[outra] || !pessoas[i].origem.includes(item[outra])), `${rotulo}: a outra UTM (${outra}) não aparece como sck`);
    confere((await texto(page, "[data-ins-contador]")).includes(`de ${fmt(listaEsperada.total)}`), `${rotulo}: contador`);
    const csv = new URL(BASE + (await page.getAttribute("[data-inscricoes-csv]", "href"))).searchParams;
    confere(csv.get("pagina") === pagina.id && (csv.get("desde") || "") === (recorte.desde || ""), `${rotulo}: CSV da página e do período`);
    return linha;
  }

  for (const largura of [1280, 390]) {
    const { page, mock, erros } = await novaPagina(browser, { largura, altura: largura < 500 ? 844 : 900 });
    await page.waitForSelector("[data-panel-view]:not([hidden])");
    await esperarCalmo(page);

    // Uma aba por página do js/checkout-config.js, com o nome e a rota de lá (host para a de fora).
    const abas = await page.$$eval("[data-paginas] [data-pagina]", (els) =>
      els.map((e) => ({ id: e.dataset.pagina, dom: e.id, role: e.getAttribute("role"), controla: e.getAttribute("aria-controls"), nome: e.querySelector(".pagina-nome").textContent, rota: e.querySelector(".pagina-rota").textContent }))
    );
    confere(JSON.stringify(abas.map((a) => a.id)) === JSON.stringify(["pesquisa-icp", "obrigado", idAba(VDF), idAba(GPS)]), `${largura}: faixa (${abas.map((a) => a.id).join(" / ")})`);
    confere(abas[2].nome === VDF.nome && abas[2].rota === `rota ${VDF.rota}`, `${largura}: aba Viver de Furo (${abas[2].nome} · ${abas[2].rota})`);
    confere(abas[3].nome === GPS.nome && abas[3].rota === "rota io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso", `${largura}: aba GPS com o host (${abas[3].rota})`);
    confere(abas.slice(2).every((a) => a.role === "tab" && a.controla === "pagina-inscricoes-painel" && a.dom === `pagina-${a.id}`), `${largura}: as duas abas controlam o mesmo bloco`);
    confere(!mock.chamadas.some((c) => c.rota === "inscricoes"), `${largura}: a aba de inscrição só busca dados quando é aberta`);

    // Viver de Furo.
    await page.click(`[data-paginas] [data-pagina='${idAba(VDF)}']`);
    await page.waitForSelector(`${cartao(VDF)} [data-etapa]`);
    await esperarCalmo(page);
    confere(new URL(page.url()).searchParams.get("pagina") === idAba(VDF), `${largura}: a URL guarda a aba (${new URL(page.url()).search})`);
    confere((await page.getAttribute(`#pagina-${idAba(VDF)}`, "aria-selected")) === "true" && (await page.getAttribute(`#pagina-${idAba(GPS)}`, "aria-selected")) === "false", `${largura}: aba Viver de Furo selecionada`);
    confere((await page.getAttribute("#pagina-inscricoes-painel", "aria-labelledby")) === `pagina-${idAba(VDF)}`, `${largura}: o bloco é rotulado pela aba aberta`);
    confere(await page.isHidden("[data-pagina-conteudo='pesquisa-icp']"), `${largura}: a pesquisa some`);
    confere((await page.isHidden("[data-perfis]")) && (await page.isHidden(".filtros-pessoa")), `${largura}: perfil, busca e situação somem`);
    await conferirAba(page, mock, VDF, {}, `${largura} Viver de Furo`);
    await tela(page, `inscricoes-viver-de-furo-${largura}`, { full: true });
    await recorte(page, cartao(VDF), `inscricoes-viver-de-furo-cartao-${largura}`);

    // Imersão GPS pelo teclado: a outra página é pedida e, enquanto não chega, nada da anterior fica.
    mock.atraso.inscricoes = (url) => (url.searchParams.get("pagina") === GPS.id ? 700 : 0);
    await page.focus(`#pagina-${idAba(VDF)}`);
    await page.keyboard.press("ArrowRight");
    confere((await page.$$(cartao(VDF))).length === 0 && (await page.$$("[data-inscricoes] .esqueleto")).length === 1, `${largura}: trocar de página limpa os números da anterior (esqueleto)`);
    confere((await page.evaluate(() => document.activeElement && document.activeElement.id)) === `pagina-${idAba(GPS)}`, `${largura}: a seta leva o foco para a aba GPS`);
    confere((await page.getAttribute("[data-inscricoes-csv]", "href")).includes(`pagina=${GPS.id}`), `${largura}: o CSV já é da página nova`);
    await page.waitForSelector(`${cartao(GPS)} [data-etapa]`);
    await esperarCalmo(page);
    mock.atraso = {};
    confere(new URL(page.url()).searchParams.get("pagina") === idAba(GPS), `${largura}: URL da aba GPS`);
    confere((await page.getAttribute("#pagina-inscricoes-painel", "aria-labelledby")) === `pagina-${idAba(GPS)}`, `${largura}: bloco rotulado pela aba GPS`);
    await conferirAba(page, mock, GPS, {}, `${largura} GPS`);
    // O criativo com HTML no nome aparece como texto em todos os lugares (escapeHtml).
    confere((await page.evaluate(() => window.__xss)) === undefined, `${largura}: sck com <img onerror> não executa`);
    confere((await page.textContent(`${cartao(GPS)} [data-divisao='conteudo']`)).includes("<img src=x"), `${largura}: sck malicioso aparece como texto`);

    // Sem rolagem horizontal, nem tabela transbordando, nas duas páginas.
    const larguraDoc = await page.evaluate(() => document.documentElement.scrollWidth);
    confere(larguraDoc <= largura, `${largura}: GPS sem rolagem horizontal (scrollWidth ${larguraDoc})`);
    const transbordam = await page.$$eval("[data-inscricoes] .tabela-rolagem", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    confere(transbordam === 0, `${largura}: GPS sem tabela rolando de lado (${transbordam})`);
    await tela(page, `inscricoes-gps-${largura}`, { full: true });
    await tela(page, `inscricoes-gps-topo-${largura}`);
    await recorte(page, `${cartao(GPS)} [data-ins-hotmart]`, `inscricoes-gps-hotmart-${largura}`);
    await recorte(page, `${cartao(GPS)} .ins-bloco`, `inscricoes-gps-divisoes-${largura}`);
    await recorte(page, "[data-inscricoes] .ins-compras", `inscricoes-gps-compras-${largura}`);
    await recorte(page, "[data-paginas]", `inscricoes-faixa-${largura}`);

    // De volta à Viver de Furo pelo clique: de novo sem resto da GPS.
    await page.click(`[data-paginas] [data-pagina='${idAba(VDF)}']`);
    await page.waitForSelector(`${cartao(VDF)} [data-etapa]`);
    await esperarCalmo(page);
    confere((await page.$$(cartao(GPS))).length === 0 && !(await page.textContent("[data-inscricoes]")).includes("video-iza-01"), `${largura}: Viver de Furo sem nada da GPS`);
    const larguraVdf = await page.evaluate(() => document.documentElement.scrollWidth);
    const transbordamVdf = await page.$$eval("[data-inscricoes] .tabela-rolagem", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    confere(larguraVdf <= largura && transbordamVdf === 0, `${largura}: Viver de Furo sem rolagem lateral (${larguraVdf}, ${transbordamVdf})`);

    if (largura === 1280) {
      // "Carregar mais" traz a página seguinte sem perder o que já estava na tela.
      await page.click("[data-ins-mais]");
      await page.waitForFunction(() => document.querySelectorAll("[data-inscricoes] .ins-pessoa").length > 50);
      confere((await page.$$("[data-inscricoes] .ins-pessoa")).length === 100, "Carregar mais soma mais 50");
      confere(mock.chamadas.some((c) => c.rota === "inscricoes" && c.url.includes("offset=50") && c.url.includes(`pagina=${VDF.id}`)), "Carregar mais pede a mesma página");

      // Resposta atrasada da página anterior não pinta a página nova.
      mock.atraso.inscricoes = (url) => (url.searchParams.get("pagina") === VDF.id ? 1500 : 0);
      await page.click("[data-atualizar]");
      await page.waitForTimeout(80);
      await page.click(`[data-paginas] [data-pagina='${idAba(GPS)}']`);
      await page.waitForTimeout(1900);
      await esperarCalmo(page);
      mock.atraso = {};
      confere((await page.$$(cartao(VDF))).length === 0 && (await page.$$(cartao(GPS))).length === 1, "resposta atrasada da Viver de Furo não sobrescreve a GPS");
      confere((await texto(page, `${cartao(GPS)} [data-etapa='inscritos'] .num strong`)) === fmt(rGps.inscritos), "a GPS continua com os números dela");

      // Período: vale na aba aberta, com a página junto; o CSV acompanha.
      mock.chamadas.length = 0;
      await page.click("[data-periodo='7']");
      await page.waitForFunction(() => document.querySelector("[data-periodo='7']").getAttribute("aria-pressed") === "true");
      await esperarCalmo(page);
      const chamada = mock.chamadas.find((c) => c.rota === "inscricoes");
      const desde = new URL(BASE + chamada.url).searchParams.get("desde");
      confere(Boolean(desde) && !mock.chamadas.some((c) => c.rota === "resumo"), `período de 7 dias só nesta aba (${chamada.url})`);
      const g7 = await conferirAba(page, mock, GPS, { desde }, "GPS 7 dias");
      confere(g7.inscritos < rGps.inscritos, `7 dias recorta (${g7.inscritos} de ${rGps.inscritos})`);
      confere((await page.textContent("[data-inscricoes-periodo]")).includes("Últimos 7 dias"), "rótulo do período");

      // Atualizar recarrega só esta aba, desta página.
      mock.chamadas.length = 0;
      await page.click("[data-atualizar]");
      await esperarCalmo(page);
      confere(mock.chamadas.length > 0 && mock.chamadas.every((c) => c.rota === "inscricoes" && c.url.includes(`pagina=${GPS.id}`)), "Atualizar recarrega só a aba aberta");

      // Teclado: Home vai para a primeira aba, End para a última, seta à esquerda volta uma.
      await page.focus(`#pagina-${idAba(GPS)}`);
      await page.keyboard.press("Home");
      await esperarCalmo(page);
      confere((await page.evaluate(() => document.activeElement.id)) === "pagina-pesquisa-icp" && (await page.isVisible("[data-perfis]")), "Home abre a pesquisa");
      await page.keyboard.press("End");
      await page.waitForSelector(`${cartao(GPS)} [data-etapa]`);
      confere((await page.evaluate(() => document.activeElement.id)) === `pagina-${idAba(GPS)}`, "End abre a última aba (GPS)");
      mock.chamadas.length = 0;
      await page.keyboard.press("ArrowLeft");
      await page.waitForSelector(`${cartao(VDF)} [data-etapa]`);
      await esperarCalmo(page);
      confere((await page.evaluate(() => document.activeElement.id)) === `pagina-${idAba(VDF)}`, "seta à esquerda volta para a Viver de Furo");
      const v7 = inscricoesResumo(DADOS, { desde, pagina: VDF.id }).paginas[0];
      confere((await texto(page, `${cartao(VDF)} [data-etapa='inscritos'] .num strong`)) === fmt(v7.inscritos), `Viver de Furo com o mesmo período (${v7.inscritos})`);
      confere(mock.chamadas.some((c) => c.rota === "inscricoes" && c.url.includes(`pagina=${VDF.id}`) && c.url.includes("desde=")), "o pedido leva página e período");

      // Erro e "Tentar de novo".
      await page.click("[data-paginas] [data-pagina='pesquisa-icp']");
      mock.forcar.inscricoes = 502;
      await page.click(`[data-paginas] [data-pagina='${idAba(GPS)}']`);
      await page.waitForSelector("[data-inscricoes] .erro [data-repetir='inscricoes']");
      confere((await page.textContent("[data-inscricoes-status]")).includes("Não foi possível carregar"), "502 avisa no status");
      confere((await page.$$("[data-inscricoes] .ins-cartao")).length === 0, "sem número velho na tela depois do erro");
      await tela(page, "inscricoes-erro-1280");
      delete mock.forcar.inscricoes;
      await page.click("[data-inscricoes] [data-repetir='inscricoes']");
      await page.waitForSelector(`${cartao(GPS)} [data-etapa]`);
      confere((await page.textContent("[data-inscricoes-status]")).trim() === "", "Tentar de novo recupera");

      // Sessão expirada volta ao login.
      mock.logado = false;
      await page.click("[data-atualizar]");
      await page.waitForSelector("[data-login-view]:not([hidden])");
      confere((await page.textContent("[data-login-status]")).includes("sessão expirou"), "401 na aba de inscrição volta ao login");
    }

    const naoEsperados = erros.filter((e) => !/Failed to load resource|502/.test(e));
    confere(naoEsperados.length === 0, `inscrição: sem erros de JavaScript em ${largura}px (${naoEsperados.join(" | ")})`);
    await page.context().close();
  }

  // Link salvo de antes (?pagina=inscricoes): abre a primeira página de inscrição e a URL passa a
  // dizer qual é.
  const antigo = await novaPagina(browser, { url: "/painel?pagina=inscricoes&periodo=7" });
  await antigo.page.waitForSelector(`${cartao(VDF)} [data-etapa]`);
  await esperarCalmo(antigo.page);
  const uAntigo = new URL(antigo.page.url()).searchParams;
  confere(uAntigo.get("pagina") === idAba(VDF) && uAntigo.get("periodo") === "7", `link antigo abre a Viver de Furo (${antigo.page.url()})`);
  confere((await antigo.page.getAttribute(`#pagina-${idAba(VDF)}`, "aria-selected")) === "true", "link antigo: aba selecionada");
  confere(antigo.mock.chamadas.some((c) => c.rota === "inscricoes" && c.url.includes(`pagina=${VDF.id}`)) && !antigo.mock.chamadas.some((c) => c.rota === "resumo"), "link antigo: pede a Viver de Furo e não carrega a pesquisa");
  confere(antigo.erros.length === 0, `link antigo sem erros (${antigo.erros.join(" | ")})`);
  await antigo.page.context().close();

  // Servidor novo com o SQL antigo (sem mídia, conteúdo e vendas): a aba não quebra.
  const velho = await novaPagina(browser, { largura: 390, altura: 844 });
  velho.mock.sqlAntigo = true;
  await velho.page.waitForSelector("[data-panel-view]:not([hidden])");
  await esperarCalmo(velho.page);
  for (const pagina of [GPS, VDF]) {
    await velho.page.click(`[data-paginas] [data-pagina='${idAba(pagina)}']`);
    await velho.page.waitForSelector(`${cartao(pagina)} [data-etapa]`);
    await esperarCalmo(velho.page);
    const linha = inscricoesResumo(DADOS, { pagina: pagina.id }).paginas[0];
    const chaves = await velho.page.$$eval("[data-inscricoes] .ins-placar li", (lis) => lis.map((li) => li.dataset.placarIns));
    confere(chaves.join() === "inscritos,cliques,compras,receita", `SQL antigo ${pagina.id}: o quarto número volta a ser a receita (${chaves})`);
    confere((await velho.page.$$("[data-ins-hotmart]")).length === 0, `SQL antigo ${pagina.id}: sem bloco da Hotmart`);
    const divisoes = await velho.page.$$eval(`${cartao(pagina)} [data-divisao]`, (els) => els.map((e) => e.dataset.divisao));
    confere(divisoes.join() === "origem,campanha,termo,dia", `SQL antigo ${pagina.id}: só as divisões que vieram (${divisoes})`);
    confere((await velho.page.$$("[data-inscricoes] [data-sck-aviso]")).length === 0, `SQL antigo ${pagina.id}: aviso sem sck não inventa "sem sck"`);
    // O aviso de órfãs continua com o número de lá: AVISOS aprovados sem inscrição (produto de fora e
    // reembolsada inclusive), com a frase de compra aprovada.
    const resumoAntigo = comoSqlAntigo(inscricoesResumo(DADOS, { pagina: pagina.id }), DADOS, { pagina: pagina.id });
    const avisoVelho = await texto(velho.page, "[data-ins-aviso]");
    confere(
      resumoAntigo.compras_sem_inscricao > 0 && avisoVelho.includes(`${fmt(resumoAntigo.compras_sem_inscricao)} ${resumoAntigo.compras_sem_inscricao === 1 ? "compra aprovada não casou" : "compras aprovadas não casaram"}`),
      `SQL antigo ${pagina.id}: aviso com o compras_sem_inscricao de lá (${avisoVelho.slice(0, 50)})`
    );
    confere((await tabela(velho.page, "[data-inscricoes] .ins-compras")).length === resumoAntigo.compras_recentes.length, `SQL antigo ${pagina.id}: ${resumoAntigo.compras_recentes.length} avisos recentes`);
    confere((await texto(velho.page, `${cartao(pagina)} [data-etapa='compras'] .num strong`)) === fmt(linha.compras), `SQL antigo ${pagina.id}: funil continua certo`);
    confere((await velho.page.evaluate(() => document.documentElement.scrollWidth)) <= 390, `SQL antigo ${pagina.id}: sem rolagem horizontal`);
  }
  await tela(velho.page, "inscricoes-sql-antigo-390", { full: true });
  confere(velho.erros.length === 0, `SQL antigo sem erros de JavaScript (${velho.erros.join(" | ")})`);
  await velho.page.context().close();

  // Aberta direto pela URL, sem ninguém inscrito ainda: estado vazio caprichado.
  const v = await novaPagina(browser, { dados: VAZIO, url: `/painel?pagina=${idAba(GPS)}`, largura: 390, altura: 844 });
  await v.page.waitForSelector("[data-inscricoes-vazio]");
  confere((await v.page.textContent("[data-inscricoes-vazio]")).includes("Ninguém se inscreveu ainda"), "vazio geral");
  confere((await v.page.$$eval(`${cartao(GPS)} .vazio`, (els) => els.length)) === 1, "o cartão diz que ninguém se inscreveu nele");
  confere((await v.page.textContent("[data-inscricoes] .ins-compras")).includes("Nenhum aviso de venda"), "compras recentes vazio explica de onde vêm os avisos");
  confere((await v.page.$$("[data-ins-aviso]")).length === 0, "sem compra órfã, sem aviso");
  confere(!v.mock.chamadas.some((c) => c.rota === "resumo"), "aberta direto na aba de inscrição, a pesquisa não carrega");
  confere((await v.page.evaluate(() => document.documentElement.scrollWidth)) <= 390, "vazio sem rolagem horizontal em 390px");
  await tela(v.page, "inscricoes-vazio-390", { full: true });
  confere(v.erros.length === 0, `vazio sem erros (${v.erros.join(" | ")})`);
  await v.page.context().close();

  // Só vendas, nenhum inscrito (a Hotmart vendeu antes de o formulário existir): o lado da Hotmart
  // aparece mesmo assim, e o do formulário diz que não tem ninguém.
  const soVendas = { ...VAZIO, compras: DADOS.compras.filter((c) => c.pagina === GPS.id && !c.inscricao_id) };
  const sv = inscricoesResumo(soVendas, { pagina: GPS.id }).paginas[0];
  confere(sv.vendas === 3 && sv.inscritos === 0, `fixture: 3 vendas sem inscrição, 0 inscritos (${sv.vendas})`);
  const s = await novaPagina(browser, { dados: soVendas, url: `/painel?pagina=${idAba(GPS)}`, largura: 390, altura: 844 });
  await s.page.waitForSelector(`${cartao(GPS)} [data-ins-hotmart]`);
  await esperarCalmo(s.page);
  confere((await s.page.$$("[data-inscricoes-vazio]")).length === 0, "só vendas: não diz que está tudo vazio");
  const placarSv = await s.page.$$eval("[data-inscricoes] .ins-placar li .valor", (els) => els.map((e) => e.textContent.trim()));
  confere(placarSv[0] === "0" && placarSv[3] === "3", `só vendas: 0 inscritos e 3 vendas (${placarSv})`);
  confere((await tabela(s.page, `${cartao(GPS)} [data-ins-hotmart]`)).length === sv.vendas_por_sck.length, "só vendas: a tabela por sck aparece");
  confere((await s.page.$$(`${cartao(GPS)} [data-divisao='origem'] .vazio`)).length === 1, "só vendas: divisões de inscritos vazias");
  confere(s.erros.length === 0, `só vendas sem erros (${s.erros.join(" | ")})`);
  await s.page.context().close();

  // Mais de 50 sck com venda: a tabela por sck traz todos (o SQL corta só em 500, porque é por
  // venda), e o "sem inscrição" é o do banco (compras_sem_inscricao conta todas).
  const inscritas = DADOS.inscricoes.filter((i) => i.pagina === GPS.id && i.comprou_em).slice(0, 5);
  const muitos = { ...VAZIO, inscricoes: inscritas, compras: [] };
  for (let k = 0; k < 55; k++) {
    const dona = k >= 50 ? inscritas[k - 50] : null;
    const quando = dona ? dona.comprou_em : new Date(Date.now() - (k + 1) * 3600000).toISOString();
    muitos.compras.push({
      id: k + 1,
      recebido_em: new Date(new Date(quando).getTime() + 2000).toISOString(),
      evento_em: quando,
      aprovado_em: quando,
      evento: "PURCHASE_APPROVED",
      status: "APPROVED",
      transacao: dona ? dona.compra_transacao : `HPMUITOS${k}`,
      valor: 5,
      sck: `criativo-${String(k).padStart(2, "0")}`,
      comprador_nome: dona ? dona.nome : `Compradora ${k}`,
      comprador_email: dona ? dona.email : `compradora${k}@gmail.com`,
      pagina: GPS.id,
      pagina_por: "config",
      inscricao_id: dona ? dona.id : null
    });
  }
  const rm = inscricoesResumo(muitos, { pagina: GPS.id });
  const lm = rm.paginas[0];
  confere(lm.vendas === 55 && lm.vendas_por_sck.length === 55 && lm.vendas_por_sck.filter((x) => x.casadas).length === 5 && rm.compras_sem_inscricao === 50, `fixture: 55 vendas, 55 linhas por sck (5 casadas), 50 sem inscrição (${rm.compras_sem_inscricao})`);
  const m = await novaPagina(browser, { dados: muitos, url: `/painel?pagina=${idAba(GPS)}`, largura: 390, altura: 844 });
  await m.page.waitForSelector(`${cartao(GPS)} [data-ins-hotmart]`);
  await esperarCalmo(m.page);
  const placarM = await m.page.$$eval("[data-inscricoes] .ins-placar li .detalhe", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  confere(placarM[3].includes("50 sem inscrição"), `mais de 50 sck: placar com as 50 sem inscrição do banco (${placarM[3]})`);
  confere((await texto(m.page, `${cartao(GPS)} [data-vendas-casadas]`)) === "5 casadas com inscrição · 50 sem inscrição", "mais de 50 sck: casadas x sem inscrição pelo banco, não pela tabela cortada");
  confere((await texto(m.page, "[data-ins-aviso]")).includes("50 vendas da Hotmart não casaram"), "mais de 50 sck: o aviso com o mesmo número");
  confere((await tabela(m.page, `${cartao(GPS)} [data-ins-hotmart]`)).length === 55, "mais de 50 sck: a tabela mostra todos os 55 sck (soma bate com o total)");
  confere(m.erros.length === 0, `mais de 50 sck sem erros (${m.erros.join(" | ")})`);
  await m.page.context().close();
});

test("todas as checagens rodaram", () => {
  // 11 cenários acima; o número exato muda quando um cenário ganha checagem, o piso não.
  assert.ok(checagens >= 240, `só ${checagens} checagens rodaram`);
  assert.ok(todasAsChamadas.length > 100);
  assert.deepEqual(todasAsChamadas.filter((url) => /_outro/.test(url)), [], "o painel nunca pede complemento de Outro");
  // Toda ida à API de inscrições diz de qual página: nenhuma aba pede "todas as páginas".
  const semPagina = todasAsChamadas.filter((url) => url.startsWith("/api/painel/inscricoes") && !new URLSearchParams(url.split("?")[1] || "").get("pagina"));
  assert.deepEqual(semPagina, [], "a aba de inscrição sempre pede ?pagina=");
  console.log(`# painel: ${checagens} checagens`);
});
