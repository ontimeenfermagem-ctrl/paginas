// A sala de aula (/replay-afericao) no Chromium: a matéria, a trava, o mural e a moderação.
//
// A página é servida pelo server.mjs de verdade (CSP com o hash do Pixel, cabeçalhos, estático); o
// POST da inscrição e o GET do mural são interceptados no navegador, com fixtures. O que este
// arquivo protege, e que nenhum teste de servidor pega:
//
//   - a foto de abertura aparece TRANCADA (é ela que dá vontade) e a matéria/o mural não existem
//     na página antes do acesso;
//   - texto de terceiro NUNCA vira HTML (o comentário com <img onerror> sai como texto);
//   - o selo azul e a foto da Iza vêm do config, e os três pontinhos só existem para admin;
//   - carga horária não aparece em lugar nenhum da tela;
//   - nada de rolagem horizontal em 390px, e nenhum erro de CSP no console.
//
//   node --test tests/e2e/replay.e2e.mjs        (precisa só do Playwright; sem Docker)
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createServerApp } from "../../server.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TELAS = process.env.E2E_SCREENS ? path.join(process.env.E2E_SCREENS, "replay") : "";

let servidor;
let BASE;
let browser;

before(async () => {
  // Pixel LIGADO de propósito: é assim que o hash do CSP é exercido de verdade.
  servidor = createServerApp({ rootDirectory: RAIZ, metaPixelId: "538380380948773", resolveEmailDomain: async () => "ok" });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  BASE = `http://127.0.0.1:${servidor.address().port}`;
  browser = await chromium.launch();
  if (TELAS) (await import("node:fs")).mkdirSync(TELAS, { recursive: true });
});

after(async () => {
  await browser?.close().catch(() => {});
  if (servidor) {
    servidor.closeAllConnections?.();
    await new Promise((resolve) => servidor.close(resolve));
  }
});

async function abrir({ largura = 390, altura = 900, comentarios = null, acesso = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: largura, height: altura }, locale: "pt-BR" });
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const texto = m.text();
    // "Failed to load resource" é o log do próprio navegador para o que o teste aborta.
    if ((m.type() === "error" || m.type() === "warning") && !texto.startsWith("Failed to load resource")) {
      erros.push(`console.${m.type()}: ${texto}`);
    }
  });
  await ctx.route(/facebook\.(net|com)|i\.ytimg\.com/, (rota) => rota.abort());
  const enviados = [];
  await page.route("**/api/replay/inscricao", async (rota) => {
    enviados.push(JSON.parse(rota.request().postData() || "{}"));
    await rota.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, acesso: true, profession: "auxiliar_atendente" })
    });
  });
  await page.route("**/api/replay/comentarios**", async (rota) => {
    if (!comentarios) return rota.fulfill({ status: 404, contentType: "application/json", body: '{"ok":false}' });
    await rota.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(comentarios) });
  });
  if (acesso) await page.addInitScript((v) => localStorage.setItem("ev_replay_acesso_afericao_v1", v), JSON.stringify(acesso));
  await page.goto(`${BASE}/replay-afericao?utm_source=instagram&utm_medium=bio&utm_campaign=replay`);
  await page.waitForSelector("#sala-titulo");
  return { page, ctx, erros, enviados };
}

const ACESSO_LIBERADO = {
  id: "11111111-1111-4111-8111-111111111111",
  liberado: true,
  em: Date.now(),
  contato: { nome: "Maria da Silva", whatsapp: "(11) 98123-4567", email: "maria@gmail.com" },
  perfil: "Cuidador(a)"
};

function comentariosFalsos({ admin = false } = {}) {
  return {
    ok: true,
    pagina: "afericao",
    total: 2,
    admin,
    proximo: null,
    itens: [
      {
        id: 2,
        criado_em: new Date(Date.now() - 3600e3).toISOString(),
        autor: { nome: "Maria S.", perfil: "Cuidador(a)" },
        texto: "Assisti duas vezes!\nMuito clara.",
        admin: false,
        estado: "visivel",
        respostas: [{ id: 3, criado_em: new Date(Date.now() - 1800e3).toISOString(), texto: "Que bom, Maria! 💜", admin: true }]
      },
      {
        id: 1,
        criado_em: new Date(Date.now() - 86400e3).toISOString(),
        autor: { nome: "Ana P.", perfil: "Enfermeiro(a)" },
        // O teste que importa: isto tem que sair como TEXTO.
        texto: "<img src=x onerror=alert(1)>",
        admin: false,
        estado: "visivel",
        respostas: []
      }
    ]
  };
}

async function tela(page, nome) {
  if (TELAS) await page.screenshot({ path: `${TELAS}/${nome}.png`, fullPage: true });
}

/* ------------------------------------------------------------------ trancada */

test("trancada: a foto de abertura convida, e a matéria e o mural não existem na página", async () => {
  const { page, ctx, erros } = await abrir();
  assert.match(await page.textContent("#sala-titulo"), /Aferição/);
  assert.equal(await page.locator("#sala-titulo em").count(), 1, "uma palavra em peso leve no título");
  assert.ok(await page.isVisible("#capa-credito img"), "a foto da Iza na linha de crédito");
  assert.equal(await page.locator("#capa-credito .selo-verificado").count(), 1, "o selo na capa");
  assert.ok(await page.isVisible(".abertura-quadro"), "a foto de abertura aparece trancada");
  assert.match(await page.textContent(".abertura-quadro"), /aula inteira está aqui/);
  assert.ok(await page.isVisible("#sumario"), "o sumário aparece antes do acesso");
  assert.ok(await page.isVisible("#porta"), "o formulário está na tela");
  assert.ok(await page.isHidden("#materia"), "a matéria não aparece trancada");
  assert.ok(await page.isHidden("#mural"), "o mural não aparece trancado");

  // Carga horária não existe na tela: é o que o cliente pediu.
  const texto = await page.textContent("body");
  assert.doesNotMatch(texto, /\b3\s*h\b|3 horas|carga hor/i);

  // A grade de sangria: a foto rompe a margem, o texto fica na coluna de leitura.
  const larguras = await page.evaluate(() => ({
    janela: document.documentElement.clientWidth,
    abertura: Math.round(document.querySelector(".abertura").getBoundingClientRect().width),
    capa: Math.round(document.querySelector(".capa").getBoundingClientRect().width)
  }));
  assert.equal(larguras.abertura, larguras.janela, "a foto de abertura sangra de borda a borda");
  assert.ok(larguras.capa < larguras.janela, "o texto não sangra");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "sem rolagem horizontal");

  // A luz do fundo está andando (e é CSS, não script).
  assert.equal(await page.locator(".luz i, .luz b").count(), 2);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".luz i")).animationName), "luz-rosa");

  await tela(page, "trancada-390");
  assert.deepEqual(erros, [], "nenhum erro de JS nem recusa de CSP");
  await ctx.close();
});

test("trancada: nada é enviado sem profissão nem com dados tortos", async () => {
  const { page, ctx, enviados } = await abrir();
  await page.click("#botao-acesso");
  assert.ok(!(await page.isHidden("#erro-nome")), "sem nome, o erro aparece");
  await page.fill("#campo-nome", "Maria da Silva");
  await page.fill("#campo-whatsapp", "(11) 98123-4567");
  await page.fill("#campo-email", "maria@gmail.com");
  await page.click("#botao-acesso");
  assert.ok(!(await page.isHidden("#erro-perfil")), "sem profissão, a sala não abre");
  assert.deepEqual(enviados, []);
  assert.ok(await page.isHidden("#materia"));
  await ctx.close();
});

test("trancada: da resposta do mural sai só a CONTAGEM, nunca texto de terceiro", async () => {
  const { page, ctx } = await abrir({ comentarios: comentariosFalsos() });
  await page.waitForSelector("#porta-conversa:not([hidden])");
  assert.match(await page.textContent("#porta-conversa"), /2 comentários/);
  assert.ok(await page.isHidden("#mural"), "o mural continua fora da página");
  assert.equal(await page.locator(".carta").count(), 0, "nenhuma carta no DOM");
  const texto = await page.textContent("body");
  assert.doesNotMatch(texto, /Assisti duas vezes/, "o texto de quem comentou não chega a quem não tem acesso");
  await ctx.close();
});

/* ------------------------------------------------------------------ liberando */

test("liberar: a inscrição vai com as UTMs, a sala abre e o mural aparece", async () => {
  const { page, ctx, erros, enviados } = await abrir({ comentarios: comentariosFalsos() });
  await page.fill("#campo-nome", "maria da silva");
  await page.fill("#campo-whatsapp", "11981234567");
  await page.fill("#campo-email", " MARIA@GMAIL.COM ");
  await page.click('#opcoes-perfil .opcao:has-text("Auxiliar")');
  await page.click("#botao-acesso");
  await page.waitForSelector("#mural:not([hidden])");

  assert.equal(enviados.length, 1);
  const enviado = enviados[0];
  assert.equal(enviado.pagina, "afericao");
  assert.equal(enviado.contato.nome, "Maria da Silva", "nome formatado");
  assert.equal(enviado.contato.whatsapp, "(11) 98123-4567");
  assert.equal(enviado.contato.email, "maria@gmail.com");
  assert.match(enviado.perfil, /^Auxiliar/);
  assert.equal(enviado.rastreio.utm_source, "instagram");
  assert.equal(enviado.rastreio.utm_campaign, "replay");

  assert.ok(await page.isHidden("#porta"), "o formulário sai da tela");
  assert.ok(await page.isVisible("#materia-titulo"));
  assert.match(await page.textContent("#mural-compositor"), /Comentando como Maria da Silva/);
  await tela(page, "aberta-390");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("voltar depois: a sala já está aberta e nada é gravado de novo", async () => {
  const { page, ctx, enviados } = await abrir({ comentarios: comentariosFalsos(), acesso: ACESSO_LIBERADO });
  await page.waitForSelector("#mural:not([hidden])");
  assert.ok(await page.isHidden("#porta"));
  assert.deepEqual(enviados, []);
  await ctx.close();
});

/* ------------------------------------------------------------------ o mural */

test("mural: texto de terceiro sai como TEXTO, e a resposta da Iza vem do config", async () => {
  const { page, ctx, erros } = await abrir({ comentarios: comentariosFalsos(), acesso: ACESSO_LIBERADO });
  await page.waitForSelector("#cartas .carta");

  assert.equal(await page.locator("#cartas .carta").count(), 2);
  // XSS: a tag escrita por quem comentou aparece na tela, e NÃO no DOM.
  assert.match(await page.textContent('[data-comentario="1"] .carta-texto'), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.locator('[data-comentario="1"] img').count(), 0, "nada de tag criada a partir do texto");

  // A resposta da Iza: o único bloco pintado, com o rosto e o selo do CONFIG.
  assert.equal(await page.locator(".carta-resposta").count(), 1);
  assert.equal(await page.locator(".carta-resposta .selo-verificado").count(), 1);
  assert.equal(await page.getAttribute(".carta-resposta img", "src"), "/img/iza-avatar.jpg");
  assert.match(await page.textContent(".carta-resposta"), /Izabel Gonçalves/);
  // O selo diz de quem é: não é selo de rede social.
  assert.match(await page.getAttribute(".carta-resposta .selo-verificado", "aria-label"), /Escola Enfermagem de Valor/);

  // Sem sessão do painel não existe moderação na tela.
  assert.equal(await page.locator(".carta-menu").count(), 0, "sem três pontinhos para quem não é admin");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("mural: o admin vê os três pontinhos, e excluir pede dois toques", async () => {
  const { page, ctx, erros } = await abrir({ comentarios: comentariosFalsos({ admin: true }), acesso: ACESSO_LIBERADO });
  await page.waitForSelector("#cartas .carta");

  // Um por carta (2) mais um na resposta da Iza.
  assert.equal(await page.locator(".carta-menu").count(), 3);
  await page.click('[data-comentario="2"] .carta-quem .carta-menu');
  const acoes = await page.$$eval(".carta-acoes button", (els) => els.map((e) => e.textContent.trim()));
  assert.equal(acoes.length, 3);
  assert.match(acoes[0], /Responder como Izabel/);
  assert.match(acoes[1], /Esconder do público/);
  assert.match(acoes[2], /^Excluir$/);

  // Excluir é destrutivo: o primeiro toque só avisa o que vai acontecer.
  await page.click(".carta-acoes button.perigo");
  assert.match(await page.textContent(".carta-acoes button.perigo"), /Confirmar exclusão/);

  // Responder abre o compositor da Iza, com o rosto e o selo dela.
  await page.keyboard.press("Escape");
  await page.click('[data-comentario="2"] .carta-quem .carta-menu');
  await page.click('.carta-acoes button:has-text("Responder como Izabel")');
  await page.waitForSelector('[data-comentario="2"] .compositor textarea');
  assert.match(await page.textContent('[data-comentario="2"] .compositor'), /Respondendo como Izabel Gonçalves/);
  await tela(page, "admin-390");
  assert.deepEqual(erros, []);
  await ctx.close();
});

/* ------------------------------------------------------------------ desktop */

test("desktop: a foto de abertura rompe a margem e o texto fica na coluna de leitura", async () => {
  const { page, ctx, erros } = await abrir({ largura: 1280, altura: 1000, comentarios: comentariosFalsos(), acesso: ACESSO_LIBERADO });
  await page.waitForSelector("#mural:not([hidden])");
  const larguras = await page.evaluate(() => ({
    abertura: Math.round(document.querySelector(".abertura").getBoundingClientRect().width),
    capa: Math.round(document.querySelector(".capa").getBoundingClientRect().width)
  }));
  assert.ok(larguras.abertura > larguras.capa + 200, `a foto é bem mais larga que o texto (${larguras.abertura} vs ${larguras.capa})`);
  assert.ok(larguras.capa <= 680, "a coluna de leitura respeita a medida do impresso");
  await tela(page, "aberta-1280");
  assert.deepEqual(erros, []);
  await ctx.close();
});

/* ------------------------------------------------------------------ a oferta (o botão do minuto 20) */

/*
 * A API do YouTube é trocada por uma falsa, servida no MESMO endereço da verdadeira (e portanto
 * passando pela CSP de verdade do servidor): o player falso devolve o minuto que o teste mandar.
 */
async function youtubeFalso(page) {
  await page.route("https://www.youtube.com/iframe_api", (rota) =>
    rota.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: `window.YT = { Player: function (el, opts) {
        this.getCurrentTime = function () { return window.__minutoDoVideo || 0; };
        var self = this;
        setTimeout(function () { opts.events.onReady({ target: self }); }, 0);
      } };
      if (typeof window.onYouTubeIframeAPIReady === "function") window.onYouTubeIframeAPIReady();`
    })
  );
  await page.route(/youtube-nocookie\.com/, (rota) => rota.fulfill({ status: 200, contentType: "text/html", body: "<title>aula</title>" }));
}

test("oferta: o botão só aparece quando o VÍDEO chega aos 20 minutos, com o link do checkout", async () => {
  const { page, ctx, erros } = await abrir({ acesso: ACESSO_LIBERADO });
  await youtubeFalso(page);
  assert.ok(await page.isHidden("#oferta"), "antes do play não existe botão");

  await page.click("#quadro");
  const src = await page.getAttribute("#aula iframe", "src");
  assert.match(src, /youtube-nocookie\.com\/embed\/JlocdK7VGpU\?/, "a aula certa");
  assert.match(src, /enablejsapi=1/, "sem isto a página não sabe o minuto do vídeo");

  // Aos 10 minutos, nada.
  await page.evaluate(() => (window.__minutoDoVideo = 600));
  await page.waitForTimeout(1600);
  assert.ok(await page.isHidden("#oferta"), "aos 10 minutos o botão ainda não existe");

  // Aos 20, o botão aparece.
  await page.evaluate(() => (window.__minutoDoVideo = 1200));
  await page.waitForSelector("#oferta:not([hidden])", { timeout: 4000 });
  assert.equal(await page.getAttribute("#oferta-botao", "href"), "https://www.io.tecnicodevalor.com.br/10Vad");
  assert.equal((await page.textContent("#oferta-rotulo")).trim(), "Quero ser técnica de enfermagem");
  assert.equal(await page.getAttribute("#oferta-botao", "target"), "_blank", "a aula continua aberta atrás");
  await tela(page, "oferta-390");
  assert.deepEqual(erros, [], "a API do YouTube passa pela CSP da página");

  // Voltou depois: o botão já está lá, sem precisar assistir de novo.
  await page.reload();
  await page.waitForSelector("#oferta:not([hidden])", { timeout: 4000 });
  assert.ok(await page.isVisible("#oferta-botao"));
  await ctx.close();
});

test("oferta: sala trancada não mostra o botão, mesmo para quem já chegou nele antes", async () => {
  const { page, ctx } = await abrir();
  await page.evaluate(() => localStorage.setItem("ev_replay_oferta_afericao", "1"));
  await page.reload();
  await page.waitForSelector("#sala-titulo");
  assert.ok(await page.isHidden("#oferta"));
  await ctx.close();
});
