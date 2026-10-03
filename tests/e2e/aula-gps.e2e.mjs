// A sala da Imersão GPS (/pagina-de-aula-gps) no Chromium: a vitrine das mini aulas, o player limpo
// e a live.
//
// A página é servida pelo server.mjs de verdade (CSP com o hash do Pixel, cabeçalhos, estático); o
// POST da inscrição e o GET do mural são interceptados no navegador. O RELÓGIO é sempre o do
// teste (page.clock): data de verdade aqui viraria bomba-relógio. Os cards também são do teste: o
// js/replay-config.js servido tem o bloco `conteudos` trocado por um fixo (6 Shorts de 30/09 a
// 05/10, à meia-noite; vídeo, nome e link só onde o cenário pede), e as thumbs respondem 404 —
// então o arquivo do projeto pode mudar de vídeo, de nome e de data sem quebrar nada aqui. A aula
// principal (a live) é a do config de verdade, a não ser que o cenário troque a hora ou o vídeo. E o YouTube é um falso no MESMO endereço da API de verdade (passa pela CSP de verdade),
// que toca, pausa, avança e pode recusar o play ou nem carregar. O que este arquivo protege:
//
//   - a porta antes de tudo: sem o formulário, só a capa e ele; depois, a aula principal (a live,
//     agendada até a hora dela) e, embaixo, a vitrine;
//   - a vitrine: desliza de lado (setas no computador, dedo no celular), pontinhos, os Shorts em
//     pé; trancado em preto e branco, com cadeado e sem link; liberado colorido e sem cadeado;
//   - a data de cada card é a de Brasília, em qualquer fuso, com a contagem regressiva andando;
//   - o player limpo: nada do YouTube recebe toque, os controles são os da página, a capa cobre o
//     vídeo pausado; o play que o navegador recusa vira "toque no vídeo"; sem a API, volta o player
//     do YouTube;
//   - na sala sem a porta primeiro, o card liberado tocado antes do formulário toca depois dele;
//     conteúdo não abre a oferta; a aula principal tem sempre o caminho de volta e abre sozinha na
//     hora dela, sem atualizar a página;
//   - os comentários logo embaixo das mini aulas;
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
const DIAS = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"];

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
 * link } } (o resto vazio); `aulaVideo` = id do YouTube da aula principal; `aulaLiberaEm` = a hora
 * dela; `oferta` = segundos até o botão; `material` = um item com link no "Para levar";
 * `portaPrimeiro: false` = a sala sem a porta antes de tudo. O arquivo do projeto não muda.
 */
function configDoTeste({ conteudos = {}, aulaVideo = "", aulaLiberaEm = "", oferta = null, material = false, portaPrimeiro = true } = {}) {
  const itens = DIAS.map((dia, i) => {
    const m = conteudos[i + 1] || {};
    return {
      id: `conteudo-${i + 1}`,
      titulo: m.titulo || "",
      imagem: `/img/aula-gps/conteudo-${i + 1}.jpg`,
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
      saida = trocar(saida, /(aulas: Object\.freeze\(\[[\s\S]*?video: Object\.freeze\(\{ provedor: "youtube", id: )""/, `$1${JSON.stringify(aulaVideo)}`);
    }
    if (aulaLiberaEm) {
      saida = trocar(saida, /(aulas: Object\.freeze\(\[[\s\S]*?liberaEm: )"[^"]*"/, `$1${JSON.stringify(aulaLiberaEm)}`);
    }
    if (!portaPrimeiro) saida = trocar(saida, "portaPrimeiro: true", "portaPrimeiro: false");
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
 * window.__playBloqueado; com window.__bufferMs, o play passa antes por "carregando" (3), como o
 * de verdade numa rede lenta; window.__onReadyMs atrasa o player ficar pronto;
 * window.__minutoDoVideo manda no tempo; o último seekTo fica em window.__yt.seek.
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
  self.playVideo = function () {
    if (window.__playBloqueado) return;
    if (window.__bufferMs) { mudar(3); setTimeout(function () { if (estado === 3) mudar(1); }, window.__bufferMs); }
    else mudar(1);
  };
  self.pauseVideo = function () { mudar(2); };
  self.seekTo = function (s) { tempo = s; window.__yt.seek = s; };
  self.mute = function () { mudo = true; };
  self.unMute = function () { mudo = false; };
  self.isMuted = function () { return mudo; };
  self.destroy = function () {};
  // Para o teste mandar um estado como o YouTube manda (0 = fim).
  self.__mudar = mudar;
  setTimeout(function () {
    if (eventos.onReady) eventos.onReady({ target: self });
    if (!window.__autoplayBloqueado) setTimeout(function () { mudar(3); setTimeout(function () { mudar(1); }, 40); }, 20);
  }, window.__onReadyMs || 0);
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

/* ------------------------------------------------------------------ a porta antes de tudo */

test("trancada: a porta vem antes de tudo — só a capa e o formulário, nada de quadro nem vitrine", async () => {
  const { page, ctx, erros } = await abrir({ config: COM_VIDEOS });
  assert.equal(await page.textContent("#sala-titulo"), GPS.titulo.replace(/<\/?em>/g, ""));
  assert.ok(await page.isVisible("#porta"), "o formulário está na tela");
  assert.ok(await page.isHidden("#aula"), "o quadro (com cadeado ou não) não aparece antes da porta");
  assert.ok(await page.isHidden("#abertura-legenda"));
  assert.ok(await page.isHidden("#conteudos"), "a vitrine também não");
  assert.ok(await page.isHidden("#fio-conteudos"));
  assert.ok(await page.isHidden("#mural"), "nem o mural");
  // O formulário é a primeira coisa depois da capa.
  const primeiraCoisa = await page.evaluate(() => {
    const capa = document.querySelector(".capa").getBoundingClientRect().bottom;
    const porta = document.querySelector("#porta").getBoundingClientRect().top;
    return Math.round(porta - capa);
  });
  assert.ok(primeiraCoisa >= 0 && primeiraCoisa < 80, `a porta logo depois da capa (${primeiraCoisa}px)`);
  // A profissão continua no formulário.
  assert.equal(await page.locator("#opcoes-perfil .opcao").count(), 4);
  assert.ok(await semRolagemLateral(page));
  await tela(page, "porta-390");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("liberar: a inscrição vai como aula-gps, e a sala abre com a aula principal no topo e as mini aulas embaixo", async () => {
  const { page, ctx, erros, enviados } = await abrir({ config: COM_VIDEOS, arte: true });
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

  // A aula principal (a live) é a primeira coisa: agendada, com a thumb e o selo da data.
  assert.ok(await page.isVisible("#aula"));
  assert.equal(await page.locator(".abertura-quadro.agendada").count(), 1);
  assert.equal(await page.getAttribute(".abertura-quadro .abertura-capa", "src"), GPS.aulas[0].capa);
  assert.equal((await page.textContent(".abertura-agenda-texto")).trim(), "Ao vivo · quarta, 07/10, às 20h");
  assert.equal(await page.getAttribute(".abertura-quadro", "aria-disabled"), "true", "nada a tocar antes da hora");

  // Embaixo dela, a vitrine; o card do dia é só um card (o quadro é da aula principal).
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.deepEqual(await estados(page), ["liberado", "liberado", "liberado", "liberado", "trancado", "trancado"]);
  assert.equal(await card(page, 4).locator(".conteudo-novo").count(), 1, "o do dia leva o selo Novo");
  assert.match(await card(page, 4).textContent(), /Assistir agora/);
  assert.ok(await page.isVisible("#nav-conteudos"), "o atalho das mini aulas aparece no topo");
  const ordem = await page.evaluate(() => {
    const depois = (a, b) => Boolean(document.querySelector(a).compareDocumentPosition(document.querySelector(b)) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { vitrineDepoisDaAula: depois("#aula", "#conteudos"), muralDepoisDaVitrine: depois("#conteudos", "#mural") };
  });
  assert.deepEqual(ordem, { vitrineDepoisDaAula: true, muralDepoisDaVitrine: true });
  await page.waitForSelector("#mural:not([hidden])");
  await tela(page, "aberta-390");
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("voltando depois: a sala já abre direto (o aparelho lembra), sem o formulário", async () => {
  const { page, ctx, enviados } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.ok(await page.isHidden("#porta"));
  assert.ok(await page.isVisible("#aula"));
  assert.deepEqual(enviados, [], "nada é gravado de novo");
  await ctx.close();
});

/* ------------------------------------------------------------------ a vitrine */

test("a vitrine: os Shorts em pé, cada um com a sua data; trancado em preto e branco, com cadeado e sem clique", async () => {
  const { page, ctx, erros } = await abrir({ acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.equal(await page.locator("#conteudos-lista > li").count(), 6);
  assert.ok(await page.isHidden("#conteudos-destaque"), "sem card em destaque: a live é a aula principal");
  // 1 a 4 já passaram da data, mas ainda não têm vídeo: "em breve". 5 e 6: o dia de Brasília.
  assert.deepEqual(await estados(page), ["chegando", "chegando", "chegando", "chegando", "trancado", "trancado"]);
  assert.deepEqual(await rotulosDeEstado(page), ["Em breve", "Em breve", "Em breve", "Em breve", "Abre em 14h", "Abre segunda, 05/10"]);
  assert.equal(await page.locator("#conteudos-lista a, #conteudos-lista button").count(), 0, "nada para tocar sem conteúdo");
  assert.equal(await page.locator('#conteudos-lista .conteudo-icone[data-icone="cadeado"]').count(), 6, "todos com o cadeado");
  await page.waitForFunction(() => !document.querySelector("#conteudos-lista > li:first-child img"));
  assert.deepEqual(await page.$$eval("#conteudos-lista .conteudo-numero", (els) => els.map((el) => el.textContent)), ["01", "02", "03", "04", "05", "06"]);

  const proporcoes = await page.$$eval("#conteudos-lista .conteudo-arte", (els) =>
    els.map((el) => Math.round((el.getBoundingClientRect().height / el.getBoundingClientRect().width) * 100) / 100)
  );
  assert.ok(proporcoes.every((p) => Math.abs(p - 16 / 9) < 0.03), `em pé: ${proporcoes}`);

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
  await tela(page, "vitrine-390");
  assert.deepEqual(erros, [], "nenhum erro de JS nem recusa de CSP");
  await ctx.close();
});

test("sala sem a porta primeiro: o card liberado é colorido e sem cadeado; tocado, leva ao formulário e toca DEPOIS dele", async () => {
  const config = configDoTeste({ conteudos: { 3: { titulo: "Domínio emocional", video: "aaaaaaaaaa3" } }, portaPrimeiro: false });
  const { page, ctx, erros, enviados } = await abrir({ config, arte: true });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.ok(await page.isVisible("#aula"), "sem a porta primeiro, o quadro trancado aparece (como na aferição)");
  const terceiro = card(page, 3);
  assert.equal(await terceiro.getAttribute("data-estado"), "liberado");
  assert.match(await terceiro.textContent(), /Assistir agora/);
  assert.equal(await terceiro.locator('.conteudo-icone[data-icone="play"]').count(), 1, "o play, e não o cadeado");
  await page.waitForFunction(() => {
    const img = document.querySelectorAll("#conteudos-lista > li")[2].querySelector("img");
    return img && img.complete && img.naturalWidth > 0;
  });
  assert.equal(await terceiro.locator("img").evaluate((img) => getComputedStyle(img).filter), "none", "em cor");

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

/* ------------------------------------------------------------------ a aula principal */

test("a mini aula toca no quadro do topo, e 'Voltar para a aula principal' devolve a live agendada", async () => {
  const { page, ctx, erros } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  await page.waitForSelector(".player-limpo");
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa1/);
  const quadro = await page.locator(".player-limpo").boundingBox();
  assert.ok(quadro.height > quadro.width * 1.6, "o Short toca em pé");
  assert.equal(await card(page, 1).locator("button").getAttribute("aria-current"), "true");
  assert.match(await card(page, 1).textContent(), /No quadro lá em cima/);

  assert.equal(await page.evaluate(() => document.body.classList.contains("assistindo")), true, "tocando, a decoração sai da frente");
  await page.click(".abertura-voltar");
  assert.equal(await page.locator(".abertura-quadro.agendada").count(), 1, "a live de volta no topo");
  assert.equal(await page.locator("#aula iframe").count(), 0, "o Short saiu do quadro");
  assert.equal(await page.evaluate(() => document.body.classList.contains("assistindo")), false, "sem vídeo, o topo volta ao normal");
  assert.equal(await page.locator(".abertura-voltar").count(), 0);
  assert.equal(await page.locator('#conteudos-lista [aria-current="true"]').count(), 0);
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("na hora da live, com a página aberta: o selo conta o tempo e o quadro abre sozinho, sem atualizar a página", async () => {
  const config = configDoTeste({ aulaVideo: "cccccccccc7", aulaLiberaEm: "2026-10-03T20:00:00-03:00" });
  const { page, ctx, erros } = await abrir({
    config,
    acesso: acessoEm(new Date("2026-10-03T19:58:00-03:00")),
    agora: new Date("2026-10-03T19:58:00-03:00"),
    relogio: "instalado"
  });
  await page.clock.pauseAt(new Date("2026-10-03T19:58:30-03:00"));
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.equal((await page.textContent(".abertura-agenda-texto")).trim(), "Ao vivo · em 2min");
  await page.clock.runFor(61000);
  assert.equal((await page.textContent(".abertura-agenda-texto")).trim(), "Ao vivo · em instantes");
  assert.match(await page.getAttribute("#quadro", "aria-label"), /abre em instantes$/, "o leitor de tela ouve a mesma contagem do selo");
  await page.focus("#quadro");

  await page.clock.runFor(30000);
  await page.waitForFunction(() => !document.querySelector(".abertura-quadro.agendada"));
  assert.match(await page.textContent(".abertura-quadro"), /Assistir a aula/);
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "quadro", "quem estava no quadro continua nele");
  await page.click("#quadro");
  assert.match(await page.getAttribute("#aula iframe", "src"), /\/embed\/cccccccccc7\?/);
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("aula principal com vídeo e oferta: conteúdo não abre o botão, e a volta devolve a aula com a oferta", async () => {
  const config = configDoTeste({
    conteudos: { 1: { titulo: "Os dispositivos sem medo", video: "aaaaaaaaaa1" } },
    aulaVideo: "bbbbbbbbbb0",
    aulaLiberaEm: "2026-10-01T20:00:00-03:00",
    oferta: 2
  });
  const { page, ctx, erros } = await abrir({ config, acesso: acessoEm(SABADO) });
  await page.evaluate(() => (window.__minutoDoVideo = 30));
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.match(await page.textContent(".abertura-quadro"), /Assistir a aula/, "aberta e com vídeo, a aula vem primeiro");

  // O conteúdo toma o quadro: a oferta (que é da AULA) não abre, nem passados os 2 segundos dela.
  await card(page, 1).locator("button").click();
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa1/);
  await page.waitForTimeout(2600);
  assert.ok(await page.isHidden("#oferta"), "conteúdo de aquecimento não abre o botão da oferta");

  // E a volta: o botão embaixo do player devolve a aula, que já toca e volta a vigiar a oferta.
  await page.click(".abertura-voltar");
  assert.match(await page.getAttribute("#aula iframe", "src"), /bbbbbbbbbb0/);
  await page.waitForSelector("#oferta:not([hidden])", { timeout: 4000 });
  assert.equal(await page.getAttribute("#oferta-botao", "href"), "https://pay.hotmart.com/teste");
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

  await page.click(".player-botao-som");
  assert.equal(await page.getAttribute(".player-botao-som", "aria-label"), "Ligar o som");
  assert.equal(await page.evaluate(() => window.__yt.players.at(-1).isMuted()), true);
  await page.click(".player-botao-som");
  assert.equal(await page.getAttribute(".player-botao-som", "aria-label"), "Tirar o som");
  assert.equal(await page.locator(".player-botao-tela").count(), 1, "tela cheia onde o navegador deixa");
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

test("player limpo: com o YouTube só demorando para ficar pronto (rede fraca), nada de trocar de player", async () => {
  const { page, ctx } = await abrir({
    config: COM_VIDEOS,
    acesso: acessoEm(new Date(SABADO.getTime() - 60000)),
    agora: new Date(SABADO.getTime() - 60000),
    relogio: "instalado"
  });
  await page.evaluate(() => (window.__onReadyMs = 9000));
  await page.clock.pauseAt(SABADO);
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  // A API chegou na hora; o player é que demora 9 s. Aos 6,5 s, nada de 'sem-api'.
  await page.clock.runFor(6500);
  assert.equal(await estadoDoPlayer(page), "carregando");
  assert.ok((await page.getAttribute("#aula iframe", "src")).includes("controls=0"), "o player limpo continua");
  await page.clock.runFor(3000);
  assert.equal(await estadoDoPlayer(page), "tocando");
  assert.equal(await page.$eval(".player-limpo", (el) => el.classList.contains("sem-api")), false);
  await ctx.close();
});

test("player limpo: continuar com o YouTube baixando (rede lenta) não pede o toque nem fura a camada", async () => {
  const { page, ctx } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  await page.waitForFunction(() => document.querySelector(".player-limpo")?.dataset.estado === "tocando");
  await page.click(".player-camada");
  assert.equal(await estadoDoPlayer(page), "pausado");
  // O play volta passando 2,5 s em "carregando" (3): o relógio do 'aguardando' não pode disparar.
  await page.evaluate(() => (window.__bufferMs = 2500));
  await page.click(".player-botao-tocar");
  const vistos = new Set();
  for (let i = 0; i < 14; i++) {
    vistos.add(await estadoDoPlayer(page));
    await page.waitForTimeout(200);
  }
  assert.ok(!vistos.has("aguardando"), `estados vistos: ${[...vistos]}`);
  assert.equal(await estadoDoPlayer(page), "tocando");
  assert.equal(await noMeioDoPlayer(page), "player-camada");
  await ctx.close();
});

test("player limpo no celular deitado: o player em pé é estreito, e todos os controles cabem nele", async () => {
  const { page, ctx } = await abrir({ largura: 844, altura: 390, config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  await page.waitForFunction(() => document.querySelector(".player-limpo")?.dataset.estado === "tocando");
  await page.click(".player-camada");
  const fora = await page.evaluate(() => {
    const caixa = document.querySelector(".player-limpo").getBoundingClientRect();
    return Array.from(document.querySelectorAll(".player-controles button, .player-barra"))
      .filter((el) => getComputedStyle(el).display !== "none")
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left < caixa.left - 0.5 || r.right > caixa.right + 0.5;
      })
      .map((el) => el.className);
  });
  assert.deepEqual(fora, [], "nenhum controle cortado");
  await ctx.close();
});

test("no fim do vídeo: a capa volta, a dica 'Assistir de novo' tem fundo próprio e o toque recomeça", async () => {
  const { page, ctx } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").click();
  await page.waitForFunction(() => document.querySelector(".player-limpo")?.dataset.estado === "tocando");
  // O YouTube avisa o fim (0).
  await page.evaluate(() => window.__yt.players.at(-1).__mudar(0));
  assert.equal(await estadoDoPlayer(page), "fim");
  assert.equal(await page.textContent(".player-dica"), "Assistir de novo");
  // A dica tem a tarja escura: lê bem em cima da thumb clara do Short.
  const fundo = await page.$eval(".player-dica", (el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(fundo, "rgba(0, 0, 0, 0)", `fundo da dica: ${fundo}`);
  assert.equal(await page.$eval(".player-capa", (el) => getComputedStyle(el).visibility), "visible", "a capa cobre as sugestões do fim");
  // Tocar de novo volta ao começo.
  await page.click(".player-camada");
  assert.equal(await page.evaluate(() => window.__yt.seek), 0);
  assert.equal(await estadoDoPlayer(page), "tocando");
  await ctx.close();
});

test("a gravação que entra no config depois da live chega a quem está com a página aberta", async () => {
  const LIVE_JA_FOI = "2026-10-03T08:00:00-03:00";
  const versao = { comGravacao: false };
  // O config servido muda no meio do teste, como num deploy com o link da gravação.
  const config = (texto) =>
    configDoTeste({ aulaLiberaEm: LIVE_JA_FOI, ...(versao.comGravacao ? { aulaVideo: "dddddddddd8" } : {}) })(texto);
  const { page, ctx, erros } = await abrir({ config, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.equal((await page.textContent(".abertura-quadro")).trim(), GPS.aulas[0].aviso, "sem a gravação, o aviso");
  // A tarja do aviso: legível em cima das letras da thumb.
  assert.notEqual(await page.$eval(".abertura-texto", (el) => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");

  // O link entra no config; a pessoa volta para a aba: a página percebe e recarrega sozinha.
  versao.comGravacao = true;
  await page.waitForTimeout(300);
  await Promise.all([page.waitForEvent("load"), page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")))]);
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.match(await page.textContent(".abertura-quadro"), /Assistir a aula/, "a gravação apareceu sem ninguém atualizar");
  await page.click("#quadro");
  assert.match(await page.getAttribute("#aula iframe", "src"), /\/embed\/dddddddddd8\?/);
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("card de link abre em outra aba; tocar de novo o card que está tocando não volta o vídeo ao zero", async () => {
  const { page, ctx, erros } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  const link = card(page, 2).locator("a");
  assert.equal(await link.getAttribute("href"), "https://drive.google.com/file/d/abc/view");
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match(await link.getAttribute("rel"), /noopener/);
  assert.equal(await card(page, 2).locator('.conteudo-icone[data-icone="fora"]').count(), 1);

  await card(page, 3).locator("button").click();
  await page.$eval("#aula iframe", (frame) => (frame.dataset.marca = "o-mesmo"));
  await card(page, 3).locator("button").click();
  assert.equal(await page.getAttribute("#aula iframe", "data-marca"), "o-mesmo", "o player não foi recriado");
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa3/);
  assert.deepEqual(erros, []);
  await ctx.close();
});

test("pelo teclado: ativar um card leva o foco aos controles do player, e o redesenho não tira o foco do card", async () => {
  const { page, ctx } = await abrir({ config: COM_VIDEOS, acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  await card(page, 1).locator("button").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains("player-botao-tocar"));
  assert.match(await page.getAttribute("#aula iframe", "src"), /aaaaaaaaaa1/);

  await card(page, 3).locator("button").focus();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(await page.evaluate(() => document.activeElement.closest("li")?.dataset.conteudo), "conteudo-3");
  await ctx.close();
});

/* ------------------------------------------------------------------ o relógio dos cards */

test("na hora, com a página aberta: o card do dia destrava sozinho, sem atualizar a página", async () => {
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

  await page.clock.runFor(5000);
  await page.waitForFunction(() => document.querySelectorAll("#conteudos-lista > li")[4].dataset.estado === "liberado");
  assert.equal(await card(page, 5).locator(".conteudo-novo").count(), 1);
  assert.equal(await card(page, 5).locator('.conteudo-icone[data-icone="play"]').count(), 1, "liberado: sem cadeado");
  assert.match(await card(page, 5).textContent(), /Assistir agora/);
  assert.equal(await page.locator(".abertura-quadro.agendada").count(), 1, "a aula principal continua no topo");
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
  const { page, ctx } = await abrir({ fuso: "Asia/Tokyo", acesso: acessoEm(SABADO) });
  await page.waitForSelector("#conteudos:not([hidden])");
  assert.deepEqual(await estados(page), ["chegando", "chegando", "chegando", "chegando", "trancado", "trancado"]);
  assert.deepEqual((await rotulosDeEstado(page)).slice(4), ["Abre em 14h", "Abre segunda, 05/10"]);
  assert.equal((await page.textContent(".abertura-agenda-texto")).trim(), "Ao vivo · quarta, 07/10, às 20h");
  await ctx.close();
});

test("a contagem regressiva anda sozinha, trocando só o texto", async () => {
  const { page, ctx } = await abrir({ relogio: "instalado", agora: new Date(SABADO.getTime() - 60000), acesso: acessoEm(SABADO) });
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
  assert.equal(await page.locator(".vitrine-ponto").count(), 6, "um pontinho por aula");
  const acesosNoComeco = await page.$$eval('.vitrine-ponto[aria-current="true"]', (els) => els.map((el) => el.dataset.conteudo));
  assert.ok(acesosNoComeco.includes("conteudo-1"));

  await page.click("#vitrine-depois");
  await page.waitForFunction(() => document.querySelector("#conteudos-lista").scrollLeft > 100);
  await page.waitForFunction(() => !document.querySelector("#vitrine-antes").disabled);
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
  await page.$eval(".player-limpo", (el) => el.classList.add("ocioso"));
  await page.tap(".player-camada");
  assert.equal(await estadoDoPlayer(page), "tocando");
  assert.equal(await page.$eval(".player-limpo", (el) => el.classList.contains("ocioso")), false);
  await page.tap(".player-camada");
  assert.equal(await estadoDoPlayer(page), "pausado");
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
  // O selo da live fica EMBAIXO da thumb (nada por cima da arte), inteiro e dentro da tela.
  const selo = await page.evaluate(() => {
    const s = document.querySelector(".abertura-agenda").getBoundingClientRect();
    const q = document.querySelector(".abertura-quadro").getBoundingClientRect();
    const texto = document.querySelector(".abertura-agenda-texto");
    return { abaixo: s.top >= q.bottom - 0.5, dentro: s.left >= 0 && s.right <= document.documentElement.clientWidth, inteiro: texto.scrollWidth <= texto.clientWidth + 1 };
  });
  assert.deepEqual(selo, { abaixo: true, dentro: true, inteiro: true });
  assert.ok(await semRolagemLateral(page), "o topo não empurra a página para o lado");
  await tela(page, "aberta-320");
  assert.deepEqual(erros, []);
  await ctx.close();
});
