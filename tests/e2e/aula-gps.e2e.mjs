// A sala da Imersão GPS (/pagina-de-aula-gps) no Chromium: a vitrine das mini aulas, o player limpo
// e a live.
//
// A página é servida pelo server.mjs de verdade (CSP com o hash do Pixel, cabeçalhos, estático); o
// POST da inscrição e o GET do mural são interceptados no navegador. O RELÓGIO é sempre o do
// teste (page.clock): data de verdade aqui viraria bomba-relógio. Os cards também são do teste: o
// js/replay-config.js servido tem o bloco `conteudos` trocado por um fixo (6 Shorts de 30/09 a
// 05/10 e a live em 06/10, à meia-noite; vídeo, nome e link só onde o cenário pede), e as thumbs
// respondem 404 — então o arquivo do projeto pode mudar de vídeo, de nome e de data sem quebrar
// nada aqui. E o YouTube é um falso no MESMO endereço da API de verdade (passa pela CSP de verdade),
// que toca, pausa, avança e pode recusar o play ou nem carregar. O que este arquivo protege:
//
//   - a vitrine: desliza de lado (setas no computador, dedo no celular), pontinhos, os Shorts em
//     pé; trancado em preto e branco, com cadeado e sem link; liberado colorido e sem cadeado;
//   - a data de cada card é a de Brasília, em qualquer fuso, com a contagem regressiva andando;
//   - o player limpo: nada do YouTube recebe toque, os controles são os da página, a capa cobre o
//     vídeo pausado; o play que o navegador recusa vira "toque no vídeo"; sem a API, volta o player
//     do YouTube;
//   - o card liberado antes do formulário começa a tocar depois dele; conteúdo não abre a oferta, e
//     a aula com vídeo tem sempre o caminho de volta;
//   - os comentários logo embaixo das mini aulas; a live em destaque;
//   - nada de rolagem horizontal, e nenhum erro de CSP no console.
//
//   node --test tests/e2e/aula-gps.e2e.mjs        (precisa só do Playwright; sem Docker)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { chromium, devices } from "playwright";

import { createServerApp } from "../../server.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// O config de verdade, só para os TEXTOS esperados (trava, aviso, título) — assim mudar a copy
// não quebra o teste.
const contexto = {};
for (const arquivo of ["lead-rules.js", "pesquisa-config.js", "replay-config.js"]) {
  vm.runInNewContext(readFileSync(path.join(RAIZ, "js", arquivo), "utf8"), contexto);
}
const GPS = contexto.EVReplay.PAGINAS["aula-gps"];

const TELAS = process.env.E2E_SCREENS ? path.join(process.env.E2E_SCREENS, "aula-gps") : "";
const ROTA = "/pagina-de-aula-gps";
const CHAVE_ACESSO = "ev_replay_acesso_aula-gps_v1";

// 03/10, sábado, 10h em Brasília: os conteúdos 1 a 4 já passaram da data, o 5 abre no domingo.
const SABADO = new Date("2026-10-03T10:00:00-03:00");
const DIAS = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"];

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

/** Troca um trecho do config servido, e grita se o trecho não existir mais (o teste não mente). */
function trocar(texto, padrao, novo) {
  const saida = texto.replace(padrao, novo);
  assert.notEqual(saida, texto, `o config servido não tem mais ${padrao}`);
  return saida;
}

/**
 * O js/replay-config.js como o navegador recebe neste teste. `conteudos` = { 1: { titulo, video,
 * link } } (o resto vazio); `aulaVideo` = id do YouTube da aula; `oferta` = segundos até o botão;
 * `material` = um item com link no "Para levar". O arquivo do projeto não muda.
 */
function configDoTeste({ conteudos = {}, aulaVideo = "", oferta = null, material = false } = {}) {
  const itens = DIAS.map((dia, i) => {
    const m = conteudos[i + 1] || {};
    // O 7º é como a live da sala de verdade: deitado, rótulo próprio, a marca e o card em destaque.
    const live = i === DIAS.length - 1;
    return {
      id: live ? "live" : `conteudo-${i + 1}`,
      ...(live ? { rotulo: "Live principal", destaque: true, formato: "horizontal", marca: "06/10" } : {}),
      titulo: m.titulo || "",
      imagem: live ? "/img/aula-gps/live.jpg" : `/img/aula-gps/conteudo-${i + 1}.jpg`,
      liberaEm: `${dia}T00:00:00-03:00`,
      video: { provedor: "youtube", id: m.video || "" },
      link: m.link || ""
    };
  });
  const bloco = { titulo: "Aquecimento", rotulo: "Conteúdo", formato: "vertical", apoio: "Um por dia.", itens };
  return (texto) => {
    // O bloco INTEIRO dos conteúdos (nome da série, formato, textos e itens) é do teste.
    let saida = trocar(texto, /conteudos: Object\.freeze\(\{[\s\S]*?\n {6}\}\),/, () => `conteudos: ${JSON.stringify(bloco)},`);
    if (aulaVideo) {
      saida = trocar(saida, /(id: "aula-gps",[\s\S]*?video: Object\.freeze\(\{ provedor: "youtube", id: )""/, `$1${JSON.stringify(aulaVideo)}`);
    }
    if (oferta !== null) {
      saida = trocar(
        saida,
        'oferta: Object.freeze({ ativo: false, rotulo: "", link: "", aposSegundos: 20 * 60 })',
        `oferta: { ativo: true, rotulo: "Quero minha vaga", link: "https://pay.hotmart.com/teste", aposSegundos: ${oferta} }`
      );
    }
    if (material) {
      saida = trocar(
        saida,
        'material: Object.freeze({ titulo: "Para levar", apoio: "", itens: Object.freeze([]) })',
        'material: { titulo: "Para levar", apoio: "", itens: [{ id: "guia", titulo: "Guia rápido", tipo: "PDF", link: "https://drive.google.com/file/d/guia/view" }] }'
      );
    }
    return saida;
  };
}

const VAZIO = configDoTeste();
const COM_VIDEOS = configDoTeste({
  conteudos: {
    1: { titulo: "Os dispositivos sem medo", video: "aaaaaaaaaa1" },
    2: { titulo: "O guia rápido do plantão", link: "https://drive.google.com/file/d/abc/view" },
    3: { titulo: "Domínio emocional", video: "aaaaaaaaaa3" },
    4: { titulo: "Direitos e deveres", video: "aaaaaaaaaa4" },
    5: { titulo: "O plantão de alta complexidade", video: "aaaaaaaaaa5" }
  }
});

function acessoEm(quando) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    liberado: true,
    // O "em" é do relógio do TESTE: com o real, a sala de 90 dias podia parecer vencida.
    em: quando.getTime(),
    contato: { nome: "Joana de Souza", whatsapp: "(21) 99876-5432", email: "joana@gmail.com" },
    perfil: "Técnico(a) de enfermagem"
  };
}

/*
 * O YouTube falso: a mesma API (YT.Player sobre o iframe que já existe), com 90 s de vídeo. Toca
 * sozinho, a não ser que window.__autoplayBloqueado; o playVideo() não toca se
 * window.__playBloqueado; window.__minutoDoVideo manda no tempo; o último seekTo fica em
 * window.__yt.seek.
 */
const YOUTUBE_FALSO = `
window.__yt = { seek: null, players: [] };
window.YT = { Player: function (el, opcoes) {
  var self = this, estado = -1, mudo = false, tempo = 0, eventos = (opcoes && opcoes.events) || {};
  window.__yt.players.push(self);
  function mudar(n) { estado = n; if (eventos.onStateChange) eventos.onStateChange({ data: n, target: self }); }
  self.getCurrentTime = function () { return typeof window.__minutoDoVideo === "number" ? window.__minutoDoVideo : tempo; };
  self.getDuration = function () { return 90; };
  self.getPlayerState = function () { return estado; };
  self.playVideo = function () { if (!window.__playBloqueado) mudar(1); };
  self.pauseVideo = function () { mudar(2); };
  self.seekTo = function (s) { tempo = s; window.__yt.seek = s; };
  self.mute = function () { mudo = true; };
  self.unMute = function () { mudo = false; };
  self.isMuted = function () { return mudo; };
  self.destroy = function () {};
  setTimeout(function () {
    if (eventos.onReady) eventos.onReady({ target: self });
    if (!window.__autoplayBloqueado) setTimeout(function () { mudar(3); setTimeout(function () { mudar(1); }, 40); }, 20);
  }, 0);
} };
if (typeof window.onYouTubeIframeAPIReady === "function") window.onYouTubeIframeAPIReady();`;

async function abrir({
  largura = 390,
  altura = 900,
  agora = SABADO,
  relogio = "parado",
  fuso = "America/Sao_Paulo",
  acesso = null,
  config = VAZIO,
  arte = false,
  celular = false,
  youtube = "falso"
} = {}) {
  const ctx = await browser.newContext({
    ...(celular ? devices["Pixel 7"] : { viewport: { width: largura, height: altura } }),
    locale: "pt-BR",
    timezoneId: fuso
  });
  const page = await ctx.newPage();
  // Parado: Date fixo e os timers andando. Instalado: só o teste anda o relógio (pauseAt/runFor).
  if (relogio === "parado") await page.clock.setFixedTime(agora);
  else await page.clock.install({ time: agora });

  const erros = [];
  page.on("pageerror", (e) => erros.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const texto = m.text();
    // "Failed to load resource" é o log do navegador para o que o teste aborta e para a thumb que
    // ainda não subiu (404): o card cai no número, que é o comportamento esperado.
    if ((m.type() === "error" || m.type() === "warning") && !texto.startsWith("Failed to load resource")) {
      erros.push(`console.${m.type()}: ${texto}`);
    }
  });
  await ctx.route(/facebook\.(net|com)|i\.ytimg\.com/, (rota) => rota.abort());
  await ctx.route(/youtube-nocookie\.com/, (rota) => rota.fulfill({ status: 200, contentType: "text/html", body: "<title>vídeo</title>" }));
  await page.route("https://www.youtube.com/iframe_api", (rota) =>
    youtube === "falso" ? rota.fulfill({ status: 200, contentType: "text/javascript", body: YOUTUBE_FALSO }) : rota.abort()
  );
  await page.route(/\/js\/replay-config\.js/, async (rota) => {
    const resposta = await rota.fetch();
    await rota.fulfill({ response: resposta, body: config(await resposta.text()) });
  });
  // As thumbs: 404 (ainda não subiram), a não ser que o cenário peça todas no lugar.
  const jpg = readFileSync(path.join(RAIZ, "img", "og-pesquisa.jpg"));
  await page.route(/\/img\/aula-gps\//, (rota) =>
    arte ? rota.fulfill({ status: 200, contentType: "image/jpeg", body: jpg }) : rota.fulfill({ status: 404, contentType: "text/plain", body: "" })
  );
  const enviados = [];
  await page.route("**/api/replay/inscricao", async (rota) => {
    enviados.push(JSON.parse(rota.request().postData() || "{}"));
    await rota.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, acesso: true, pagina: "aula-gps" }) });
  });
  await page.route("**/api/replay/comentarios**", (rota) =>
    rota.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, pagina: "aula-gps", total: 0, admin: false, proximo: null, itens: [] }) })
  );
  if (acesso) await page.addInitScript(([chave, valor]) => localStorage.setItem(chave, valor), [CHAVE_ACESSO, JSON.stringify(acesso)]);
  await page.goto(`${BASE}${ROTA}?utm_source=whatsapp&utm_medium=grupo&utm_campaign=gps`);
  await page.waitForSelector("#sala-titulo");
  return { page, ctx, erros, enviados };
}

const TODOS = "#conteudos-lista > li, #conteudos-destaque > li";
const estados = (page) => page.$$eval(TODOS, (lis) => lis.map((li) => li.dataset.estado));
const rotulosDeEstado = (page) => page.$$eval(TODOS, (lis) => lis.map((li) => li.querySelector(".conteudo-estado").textContent.trim()));
const card = (page, numero) => page.locator(TODOS).nth(numero - 1);
const estadoDoPlayer = (page) => page.$eval(".player-limpo", (el) => el.dataset.estado);

async function tela(page, nome) {
  if (TELAS) await page.screenshot({ path: `${TELAS}/${nome}.png`, fullPage: true });
}

async function semRolagemLateral(page) {
  return await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

/** O que está no MEIO do player: a camada da página (ninguém toca o YouTube) ou o iframe. */
const noMeioDoPlayer = (page) =>
  page.evaluate(() => {
    // O meio tem que estar na tela (a página rola até o player devagar).
    document.querySelector(".player-limpo").scrollIntoView({ block: "center", behavior: "instant" });
    const caixa = document.querySelector(".player-limpo").getBoundingClientRect();
    const el = document.elementFromPoint(caixa.left + caixa.width / 2, caixa.top + caixa.height / 2);
    return el ? el.className || el.tagName : "";
  });

/* ------------------------------------------------------------------ a vitrine trancada */

test("trancada: a vitrine mostra os 6 Shorts em pé e a live em destaque, cada um com a sua data", async () => {
  const { page, ctx, erros } = await abrir();
  assert.equal(await page.textContent("#sala-titulo"), GPS.titulo.replace(/<\/?em>/g, ""));
  assert.equal(await page.locator(".abertura-quadro .abertura-trava").count(), 1, "o quadro aparece trancado");
  assert.ok(await page.isVisible("#porta"), "o formulário está na tela");
  assert.ok(await page.isHidden("#mural"), "o mural não aparece trancado");

  await page.waitForSelector("#conteudos:not([hidden])");
  assert.equal(await page.locator("#conteudos-lista > li").count(), 6, "seis na vitrine");
  assert.equal(await page.locator("#conteudos-destaque > li").count(), 1, "a live fora dela, em destaque");
  assert.ok(await page.isVisible("#fio-destaque"));
  // 1 a 4 já passaram da data, mas ainda não têm vídeo: "em breve". 5 em diante: o dia de Brasília.
  assert.deepEqual(await estados(page), ["chegando", "chegando", "chegando", "chegando", "trancado", "trancado", "trancado"]);
  assert.deepEqual(await rotulosDeEstado(page), [
    "Em breve",
    "Em breve",
    "Em breve",
    "Em breve",
    "Abre em 14h",
    "Abre segunda, 05/10",
    "Abre terça, 06/10"
  ]);
  assert.deepEqual(
    await page.$$eval("#conteudos-lista .conteudo-rotulo, #conteudos-destaque .conteudo-rotulo", (els) => els.map((el) => el.textContent)),
    ["Conteúdo 1", "Conteúdo 2", "Conteúdo 3", "Conteúdo 4", "Conteúdo 5", "Conteúdo 6", "Live principal"]
  );
  assert.equal(await page.locator("#conteudos-lista a, #conteudos-lista button, #conteudos-destaque a, #conteudos-destaque button").count(), 0, "nada para tocar sem conteúdo");
  assert.equal(await page.locator('.conteudo-icone[data-icone="cadeado"]').count(), 7, "todos com o cadeado");

  // A thumb ainda não subiu (404): o card fica com o número da marca (ou a marca da live).
  await page.waitForFunction(() => !document.querySelector("#conteudos-lista > li:first-child img"));
  assert.deepEqual(await page.$$eval(".conteudo-numero", (els) => els.map((el) => el.textContent)), ["01", "02", "03", "04", "05", "06", "06/10"]);

  // Os Shorts em pé (9:16); a live deitada (16:9).
  const proporcoes = await page.$$eval(".conteudo-arte", (els) =>
    els.map((el) => Math.round((el.getBoundingClientRect().height / el.getBoundingClientRect().width) * 100) / 100)
  );
  assert.ok(proporcoes.slice(0, 6).every((p) => Math.abs(p - 16 / 9) < 0.03), `em pé: ${proporcoes}`);
  assert.ok(Math.abs(proporcoes[6] - 9 / 16) < 0.03, `a live deitada: ${proporcoes[6]}`);

  // A vitrine vai de borda a borda da tela, com o primeiro card na coluna do texto, e desliza.
  const vitrine = await page.evaluate(() => {
    const lista = document.querySelector("#conteudos-lista");
    const primeiro = lista.querySelector("li").getBoundingClientRect();
    return {
      largura: Math.round(lista.getBoundingClientRect().width),
      tela: document.documentElement.clientWidth,
      rola: lista.scrollWidth > lista.clientWidth,
      tab: lista.getAttribute("tabindex"),
      esquerda: Math.round(primeiro.left)
    };
  });
  assert.equal(vitrine.largura, vitrine.tela, "de borda a borda");
  assert.ok(vitrine.rola, "tem mais cards do que cabem");
  assert.equal(vitrine.tab, "0", "transbordando, a vitrine entra no Tab (é o que deixa o Safari rolar pelo teclado)");
  assert.equal(vitrine.esquerda, 20, "o primeiro card começa no gutter");
  assert.ok(await semRolagemLateral(page), "sem rolagem horizontal na página");

  await tela(page, "trancada-390");
  assert.deepEqual(erros, [], "nenhum erro de JS nem recusa de CSP");
  await ctx.close();
});

test("trancada: o card liberado é colorido e sem cadeado; tocado, leva ao formulário e toca DEPOIS dele", async () => {
  const { page, ctx, erros, enviados } = await abrir({ config: COM_VIDEOS, arte: true });
  await page.waitForSelector("#conteudos:not([hidden])");
  const terceiro = card(page, 3);
  assert.equal(await terceiro.getAttribute("data-estado"), "liberado");
  assert.match(await terceiro.textContent(), /Domínio emocional/);
  assert.match(await terceiro.textContent(), /Assistir agora/);
  assert.equal(await terceiro.locator('.conteudo-icone[data-icone="play"]').count(), 1, "o play, e não o cadeado");
  await page.waitForFunction(() => {
    const img = document.querySelectorAll("#conteudos-lista > li")[2].querySelector("img");
    return img && img.complete && img.naturalWidth > 0;
  });
  assert.equal(await terceiro.locator("img").evaluate((img) => getComputedStyle(img).filter), "none", "em cor");
  // O card do link também não entrega o link a quem não liberou a sala.
  assert.equal(await page.locator("#conteudos-lista a").count(), 0);

  await terceiro.locator("button").click();
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === "campo-nome");
  assert.equal(await page.locator("#aula iframe").count(), 0, "nenhum player nasce com a sala trancada");

  await page.fill("#campo-nome", "joana de souza");
  await page.fill("#campo-whatsapp", "21998765432");
  await page.fill("#campo-email", "joana@gmail.com");
  await page.click('#opcoes-perfil .opcao:has-text("Técnico")');
  await page.click("#botao-acesso");
  await page.waitForSelector(".player-limpo");
  assert.equal(enviados.length, 1);
  assert.match(await page.getAttribute("#aula iframe", "src"), /\/embed\/aaaaaaaaaa3\?/, "é a aula que a pessoa tocou que começa");
  assert.deepEqual(erros, []);
  await ctx.close();
});

/* ------------------------------------------------------------------ liberando */

test("liberar: a inscrição vai como aula-gps, e o quadro em pé já mostra o conteúdo do dia", async () => {
  const { page, ctx, erros, enviados } = await abrir({ config: COM_VIDEOS });
  await page.fill("#campo-nome", "joana de souza");
  await page.fill("#campo-whatsapp", "21998765432");
  await page.fill("#campo-email", "joana@gmail.com");
  await page.click('#opcoes-perfil .opcao:has-text("Técnico")');
  await page.click("#botao-acesso");
  await page.waitForSelector("#porta", { state: "hidden" });

  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].pagina, "aula-gps", "é o id que acha a sala no servidor");
  assert.equal(enviados[0].contato.nome, "Joana de Souza");
  assert.equal(enviados[0].perfil, "Técnico(a) de enfermagem", "a profissão continua no formulário");
  assert.equal(enviados[0].rastreio.utm_source, "whatsapp");
  assert.equal(enviados[0].rastreio.utm_campaign, "gps");

  // A aula ainda não tem vídeo: o quadro toca o conteúdo liberado mais recente (o 4, de hoje), EM PÉ.
  assert.match(await page.textContent(".abertura-quadro"), /Assistir · Conteúdo 4/);
  const quadro = await page.locator(".abertura-quadro").boundingBox();
  assert.ok(quadro.height > quadro.width * 1.6, "o Short toca em pé");
  assert.equal(await card(page, 4).locator(".conteudo-novo").count(), 1, "o do dia leva o selo Novo");
  assert.equal(await card(page, 4).locator("button").getAttribute("aria-current"), "true");
  assert.match(await card(page, 4).textContent(), /No quadro lá em cima/);
  assert.ok(await page.isVisible("#nav-conteudos"), "o atalho das mini aulas aparece no topo");
  assert.equal(await page.locator(".abertura-voltar").count(), 0, "sem vídeo da aula, não há para onde voltar");
  assert.deepEqual(await estados(page), ["liberado", "liberado", "liberado", "liberado", "trancado", "trancado", "trancado"]);

  // Os comentários vêm logo embaixo das mini aulas, e a live depois deles.
  await page.waitForSelector("#mural:not([hidden])");
  const ordem = await page.evaluate(() => {
    const depois = (a, b) => Boolean(document.querySelector(a).compareDocumentPosition(document.querySelector(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { muralDepoisDaVitrine: depois("#conteudos", "#mural"), liveDepoisDoMural: depois("#mural", "#conteudos-destaque") };
  });
  assert.deepEqual(ordem, { muralDepoisDaVitrine: true, liveDepoisDoMural: true });
  await tela(page, "aberta-390");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("liberada sem nenhum conteúdo cadastrado: o quadro mostra o aviso da aula, e não promete replay", async () => {
  const { page, ctx, erros } = await abrir({ acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  const quadro = await page.textContent(".abertura-quadro");
  assert.equal(quadro.trim(), GPS.aulas[0].aviso);
  assert.doesNotMatch(quadro, /replay/i);
  assert.deepEqual(erros, []);
  await ctx.close();
});

/* ------------------------------------------------------------------ o player limpo */

test("player limpo: o YouTube sem os controles dele, a camada da página por cima e os nossos controles", async () => {
  const { page, ctx, erros } = await abrir({ largura: 1280, altura: 1000, config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  await page.waitForFunction(() => document.querySelector(".player-limpo")?.dataset.estado === "tocando");

  const src = await page.getAttribute("#aula iframe", "src");
  assert.match(src, /youtube-nocookie\.com\/embed\/aaaaaaaaaa1\?/, "o vídeo do conteúdo 1");
  for (const parametro of ["controls=0", "disablekb=1", "fs=0", "iv_load_policy=3", "rel=0", "enablejsapi=1"]) assert.ok(src.includes(parametro), parametro);
  assert.match(src, /origin=http%3A%2F%2F127\.0\.0\.1/, "o YouTube só aceita ordem desta página");
  assert.equal(await page.getAttribute("#aula iframe", "tabindex"), "-1", "o teclado não entra no YouTube");
  assert.equal(await page.getAttribute("#aula iframe", "title"), "Conteúdo 1: Os dispositivos sem medo");
  assert.equal(await noMeioDoPlayer(page), "player-camada", "o toque no vídeo é da página, nunca do YouTube");
  assert.ok(await page.$eval(".player-limpo", (el) => el.classList.contains("recem")), "nos primeiros segundos, o nosso botão fica por cima do do YouTube");

  // O iframe é maior que o quadro: as faixas do título e do logo do YouTube ficam de fora.
  // (Medido por dentro da moldura: o iframe se posiciona a partir da borda de dentro.)
  const medidas = await page.evaluate(() => {
    const el = document.querySelector(".player-limpo");
    const caixa = el.getBoundingClientRect();
    const borda = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
    const frame = el.querySelector("iframe").getBoundingClientRect();
    return { acima: Math.round(caixa.top + borda - frame.top), abaixo: Math.round(frame.bottom - (caixa.bottom - borda)) };
  });
  assert.deepEqual(medidas, { acima: 80, abaixo: 80 });

  // Pausar pela camada: a capa cobre o vídeo (e as sugestões do YouTube).
  await page.click(".player-camada");
  assert.equal(await estadoDoPlayer(page), "pausado");
  assert.equal(await page.$eval(".player-capa", (el) => getComputedStyle(el).visibility), "visible");
  assert.equal(await page.getAttribute(".player-botao-tocar", "aria-label"), "Tocar");
  // Tocar pelo botão.
  await page.click(".player-botao-tocar");
  assert.equal(await estadoDoPlayer(page), "tocando");
  assert.equal(await page.getAttribute(".player-botao-tocar", "aria-label"), "Pausar");

  // O tempo: a barra e o relógio seguem o vídeo; arrastar a barra leva o vídeo junto.
  await page.evaluate(() => (window.__minutoDoVideo = 30));
  await page.waitForFunction(() => document.querySelector(".player-tempo").textContent === "0:30 / 1:30");
  assert.equal(await page.$eval(".player-barra", (el) => el.value), "333");
  await page.evaluate(() => (window.__minutoDoVideo = undefined));
  await page.$eval(".player-barra", (el) => {
    el.value = "500";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await page.evaluate(() => window.__yt.seek), 45);

  // O som.
  await page.click(".player-botao-som");
  assert.equal(await page.getAttribute(".player-botao-som", "aria-label"), "Ligar o som");
  assert.equal(await page.evaluate(() => window.__yt.players.at(-1).isMuted()), true);
  await page.click(".player-botao-som");
  assert.equal(await page.getAttribute(".player-botao-som", "aria-label"), "Tirar o som");
  assert.equal(await page.locator(".player-botao-tela").count(), 1, "tela cheia onde o navegador deixa");

  assert.ok(await page.isHidden("#oferta"), "conteúdo de aquecimento não abre o botão da oferta");
  await tela(page, "player-1280");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("player limpo: com o play recusado pelo navegador, a camada fura e o toque chega ao vídeo", async () => {
  const { page, ctx } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.addInitScript(() => {
    window.__autoplayBloqueado = true;
  });
  await page.reload();
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  await page.waitForFunction(() => document.querySelector(".player-limpo")?.dataset.estado === "aguardando", null, { timeout: 5000 });
  assert.equal(await page.textContent(".player-dica"), "Toque no vídeo para começar");
  assert.equal(await noMeioDoPlayer(page), "IFRAME", "o toque passa para o vídeo (o único jeito de o iPhone aceitar som)");

  // O vídeo começou (pelo toque dentro dele): a camada volta a cobrir tudo.
  await page.evaluate(() => window.__yt.players.at(-1).playVideo());
  assert.equal(await estadoDoPlayer(page), "tocando");
  assert.equal(await noMeioDoPlayer(page), "player-camada");
  await ctx.close();
});

test("player limpo: sem a API do YouTube, volta o player do YouTube com os controles dele", async () => {
  const { page, ctx } = await abrir({
    config: COM_VIDEOS,
    acesso: acessoEm(new Date(SABADO.getTime() - 60000)),
    agora: new Date(SABADO.getTime() - 60000),
    relogio: "instalado",
    youtube: "fora"
  });
  await page.clock.pauseAt(SABADO);
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  assert.equal(await estadoDoPlayer(page), "carregando");
  await page.clock.runFor(6500);
  assert.equal(await estadoDoPlayer(page), "sem-api");
  const src = await page.getAttribute("#aula iframe", "src");
  assert.match(src, /\/embed\/aaaaaaaaaa1\?/);
  assert.ok(!src.includes("controls=0"), "com os controles do YouTube, a aula toca");
  assert.equal(await page.isHidden(".player-camada"), true);
  assert.equal(await page.isHidden(".player-controles"), true);
  await ctx.close();
});

test("card de vídeo toca no quadro lá de cima; card de link abre em outra aba", async () => {
  const { page, ctx, erros } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.ok(await page.isHidden("#porta"), "quem já liberou volta com a sala aberta");

  await card(page, 1).locator("button").click();
  assert.match(await page.getAttribute("#aula iframe", "src"), /youtube-nocookie\.com\/embed\/aaaaaaaaaa1\?/);
  assert.equal(await card(page, 1).locator("button").getAttribute("aria-current"), "true");
  assert.equal(await page.locator('#conteudos-lista [aria-current="true"]').count(), 1, "só um no quadro");

  const link = card(page, 2).locator("a");
  assert.equal(await link.getAttribute("href"), "https://drive.google.com/file/d/abc/view");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match(await link.getAttribute("rel"), /noopener/);
  assert.equal(await card(page, 2).locator('.conteudo-icone[data-icone="fora"]').count(), 1);
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("tocar de novo o card que está tocando não volta o vídeo ao zero", async () => {
  const { page, ctx } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 3).locator("button").click();
  await page.$eval("#aula iframe", (frame) => (frame.dataset.marca = "o-mesmo"));
  await card(page, 3).locator("button").click();
  assert.equal(await page.getAttribute("#aula iframe", "data-marca"), "o-mesmo", "o player não foi recriado");
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa3/);
  await ctx.close();
});

test("pelo teclado: ativar um card leva o foco aos controles do player, e o redesenho não tira o foco do card", async () => {
  const { page, ctx } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains("player-botao-tocar"));
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa1/);

  // Redesenho por visibilitychange (o mesmo caminho da hora de abrir): o foco continua no card 3.
  await card(page, 3).locator("button").focus();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(await page.evaluate(() => document.activeElement.closest("li")?.dataset.conteudo), "conteudo-3");
  await ctx.close();
});

test("aula com vídeo e oferta: conteúdo não abre o botão, e 'Voltar para a aula' devolve a aula com a oferta", async () => {
  const config = configDoTeste({ conteudos: { 1: { titulo: "Os dispositivos sem medo", video: "aaaaaaaaaa1" } }, aulaVideo: "bbbbbbbbbb0", oferta: 2 });
  const { page, ctx, erros } = await abrir({ config, acesso: acessoEm(SABADO) });
  await page.evaluate(() => (window.__minutoDoVideo = 30));
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.match(await page.textContent(".abertura-quadro"), /Assistir a aula/, "com vídeo, a aula vem primeiro");

  // O conteúdo toma o quadro: a oferta (que é da AULA) não abre, nem passados os 2 segundos dela.
  await card(page, 1).locator("button").click();
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa1/);
  await page.waitForTimeout(2600);
  assert.ok(await page.isHidden("#oferta"), "conteúdo de aquecimento não abre o botão da oferta");

  // E a volta: o botão embaixo do player devolve a aula, que volta a vigiar a oferta.
  await page.click(".abertura-voltar");
  assert.match(await page.getAttribute("#aula iframe", "src"), /bbbbbbbbbb0/);
  assert.equal(await page.locator(".abertura-voltar").count(), 0, "com a aula no quadro, o botão some");
  await page.waitForSelector("#oferta:not([hidden])", { timeout: 4000 });
  assert.equal(await page.getAttribute("#oferta-botao", "href"), "https://pay.hotmart.com/teste");
  assert.deepEqual(erros, []);
  await ctx.close();
});

/* ------------------------------------------------------------------ o relógio */

test("na hora, com a página aberta: o card do dia destrava sozinho e o quadro parado passa para ele", async () => {
  const { page, ctx, erros } = await abrir({
    config: COM_VIDEOS,
    acesso: acessoEm(new Date("2026-10-03T23:59:00-03:00")),
    agora: new Date("2026-10-03T23:59:00-03:00"),
    relogio: "instalado"
  });
  // Daqui em diante só o teste anda o relógio: nada vira antes da hora por máquina lenta.
  await page.clock.pauseAt(new Date("2026-10-03T23:59:58-03:00"));
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.equal(await card(page, 5).getAttribute("data-estado"), "trancado");
  assert.match(await card(page, 5).textContent(), /Abre em instantes/);
  assert.match(await page.textContent(".abertura-quadro"), /Assistir · Conteúdo 4/, "o do dia, antes da virada");

  await page.clock.runFor(5000);
  await page.waitForFunction(() => document.querySelectorAll("#conteudos-lista > li")[4].dataset.estado === "liberado");
  assert.equal(await card(page, 5).locator(".conteudo-novo").count(), 1);
  assert.equal(await card(page, 5).locator('.conteudo-icone[data-icone="play"]').count(), 1, "liberado: sem cadeado");
  // Nada tocando: o quadro passa sozinho para o conteúdo que acabou de abrir.
  assert.match(await page.textContent(".abertura-quadro"), /Assistir · Conteúdo 5/);
  assert.match(await card(page, 5).textContent(), /No quadro lá em cima/);
  assert.match(await card(page, 4).textContent(), /Assistir agora/);
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("na hora, com um vídeo tocando: o card novo abre, e o vídeo da pessoa continua no quadro", async () => {
  const { page, ctx, erros } = await abrir({
    config: COM_VIDEOS,
    acesso: acessoEm(new Date("2026-10-03T23:59:00-03:00")),
    agora: new Date("2026-10-03T23:59:00-03:00"),
    relogio: "instalado"
  });
  await page.clock.pauseAt(new Date("2026-10-03T23:59:58-03:00"));
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  await page.$eval("#aula iframe", (frame) => (frame.dataset.marca = "o-mesmo"));

  await page.clock.runFor(5000);
  await page.waitForFunction(() => document.querySelectorAll("#conteudos-lista > li")[4].dataset.estado === "liberado");
  assert.equal(await page.getAttribute("#aula iframe", "data-marca"), "o-mesmo", "o player não foi trocado");
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa1/);
  assert.match(await card(page, 5).textContent(), /Assistir agora/);
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("aparelho em outro fuso: as datas e o que abriu continuam os de Brasília", async () => {
  // 10h de sábado em Brasília são 22h de sábado em Tóquio.
  const { page, ctx } = await abrir({ fuso: "Asia/Tokyo" });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.deepEqual(await estados(page), ["chegando", "chegando", "chegando", "chegando", "trancado", "trancado", "trancado"]);
  assert.deepEqual((await rotulosDeEstado(page)).slice(4), ["Abre em 14h", "Abre segunda, 05/10", "Abre terça, 06/10"]);
  await ctx.close();
});

test("a contagem regressiva anda sozinha, trocando só o texto", async () => {
  const { page, ctx } = await abrir({ relogio: "instalado", agora: new Date(SABADO.getTime() - 60000) });
  await page.clock.pauseAt(SABADO);
  await page.waitForSelector("#conteudos:not([hidden])");
  const quinto = card(page, 5);
  await quinto.evaluate((li) => (li.dataset.marca = "o-mesmo"));
  assert.equal((await quinto.locator(".conteudo-estado").textContent()).trim(), "Abre em 14h");
  await page.clock.runFor(61000);
  assert.equal((await quinto.locator(".conteudo-estado").textContent()).trim(), "Abre em 13h 59min");
  assert.equal(await quinto.getAttribute("data-marca"), "o-mesmo", "o card não foi redesenhado");
  await ctx.close();
});

/* ------------------------------------------------------------------ a vitrine no computador e no celular */

test("computador: as setas deslizam a vitrine, e os pontinhos dizem onde ela está e levam até a aula", async () => {
  const { page, ctx, erros } = await abrir({ largura: 1280, altura: 1000, config: COM_VIDEOS, acesso: acessoEm(SABADO), arte: true });
  await page.waitForSelector("#conteudos:not([hidden])");
  await page.locator("#vitrine").scrollIntoViewIfNeeded();
  assert.ok(await page.isVisible("#vitrine-depois"), "com mouse, as setas aparecem");
  assert.equal(await page.isDisabled("#vitrine-antes"), true, "no começo, a seta de voltar some");
  assert.equal(await page.locator(".vitrine-ponto").count(), 6, "um pontinho por aula da vitrine (a live é à parte)");
  const acesosNoComeco = await page.$$eval('.vitrine-ponto[aria-current="true"]', (els) => els.map((el) => el.dataset.conteudo));
  assert.ok(acesosNoComeco.includes("conteudo-1"));

  await page.click("#vitrine-depois");
  await page.waitForFunction(() => document.querySelector("#conteudos-lista").scrollLeft > 100);
  await page.waitForFunction(() => !document.querySelector("#vitrine-antes").disabled);

  // O último pontinho leva até a última aula, e a seta de avançar some no fim.
  await page.locator(".vitrine-ponto").last().click();
  await page.waitForFunction(() => {
    const lista = document.querySelector("#conteudos-lista");
    return lista.scrollLeft + lista.clientWidth >= lista.scrollWidth - 2;
  });
  await page.waitForFunction(() => document.querySelector("#vitrine-depois").disabled);
  assert.equal(await page.getAttribute(".vitrine-ponto:last-child", "aria-current"), "true");

  // A thumb liberada em cor e sem cadeado; a trancada em preto e branco, com cadeado e sem clique.
  await page.waitForFunction(() => Array.from(document.querySelectorAll("#conteudos-lista img")).every((img) => img.complete && img.naturalWidth > 0));
  const filtros = await page.$$eval("#conteudos-lista > li", (lis) => lis.map((li) => getComputedStyle(li.querySelector("img")).filter));
  assert.equal(filtros[0], "none");
  assert.match(filtros[4], /grayscale\(1\)/);
  assert.equal(await card(page, 5).locator("a, button").count(), 0);

  // A live, em destaque, na largura da coluna e deitada.
  const live = await page.$eval("#conteudos-destaque .conteudo-arte", (el) => {
    const r = el.getBoundingClientRect();
    return { largura: Math.round(r.width), proporcao: Math.round((r.height / r.width) * 100) / 100 };
  });
  assert.ok(live.largura >= 600 && live.largura <= 680, `na coluna (${live.largura}px)`);
  assert.ok(Math.abs(live.proporcao - 9 / 16) < 0.03);
  assert.ok(await semRolagemLateral(page));
  await tela(page, "vitrine-1280");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("celular: sem setas (o dedo desliza), com os pontinhos; e o primeiro toque no player só traz os controles", async () => {
  const { page, ctx, erros } = await abrir({ celular: true, config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.equal(await page.isVisible("#vitrine-depois"), false, "no toque, nada de setas");
  assert.ok(await page.isVisible("#vitrine-pontos"));

  await card(page, 1).locator("button").tap();
  await page.waitForFunction(() => document.querySelector(".player-limpo")?.dataset.estado === "tocando");
  // Controles escondidos (ocioso): o primeiro toque só os traz de volta, e o vídeo segue.
  await page.$eval(".player-limpo", (el) => el.classList.add("ocioso"));
  await page.tap(".player-camada");
  assert.equal(await estadoDoPlayer(page), "tocando");
  assert.equal(await page.$eval(".player-limpo", (el) => el.classList.contains("ocioso")), false);
  // Com os controles na tela, o toque pausa.
  await page.tap(".player-camada");
  assert.equal(await estadoDoPlayer(page), "pausado");
  assert.equal(await page.locator(".player-botao-tela").count(), 1);
  assert.ok(await semRolagemLateral(page));
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("320px: título com palavra longa quebra dentro do card, e o topo com quatro atalhos não estoura", async () => {
  const config = configDoTeste({
    conteudos: {
      1: { titulo: "Antibioticoterapia na prática", video: "aaaaaaaaaa1" },
      2: { titulo: "Eletrocardiograma sem medo", video: "aaaaaaaaaa2" },
      3: { titulo: "Farmacovigilância no plantão", video: "aaaaaaaaaa3" }
    },
    material: true
  });
  const { page, ctx, erros } = await abrir({ largura: 320, altura: 800, config, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.ok(await page.isVisible("#nav-material"), "o quarto atalho está no topo");

  const vazamentos = await page.$$eval("#conteudos-lista > li", (lis) =>
    lis.flatMap((li) => {
      const borda = li.getBoundingClientRect().right;
      const titulo = li.querySelector(".conteudo-titulo");
      return titulo && titulo.getBoundingClientRect().right > borda + 0.5 ? [li.dataset.conteudo] : [];
    })
  );
  assert.deepEqual(vazamentos, [], "nenhum título passa da borda do card");

  const logo = await page.$eval(".expediente-marca", (img) => Math.round(img.getBoundingClientRect().width));
  assert.ok(logo >= 40, `o logo não é esmagado (${logo}px)`);
  assert.ok(await semRolagemLateral(page), "o topo não empurra a página para o lado");
  await tela(page, "aberta-320");
  assert.deepEqual(erros, []);
  await ctx.close();
});
