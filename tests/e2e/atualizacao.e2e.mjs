// A /atualizacao-perfil no Chromium: o link do UnniChat chega com o contato pronto.
//
// A página é servida pelo server.mjs de verdade; o POST /api/atualizacao-perfil é interceptado no
// navegador (o banco tem suíte própria). Aqui: o que o link preenche, o que ele NÃO preenche, e o
// caminho inteiro até a página de obrigado do perfil escolhido.
//
//   node --test tests/e2e/atualizacao.e2e.mjs        (precisa só do Playwright; sem Docker)
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createServerApp } from "../../server.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROTA = "/atualizacao-perfil";

let servidor;
let BASE;
let browser;

before(async () => {
  servidor = createServerApp({ rootDirectory: RAIZ, metaPixelId: "off", resolveEmailDomain: async () => "ok" });
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  BASE = `http://127.0.0.1:${servidor.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  if (servidor) {
    servidor.closeAllConnections?.();
    await new Promise((resolve) => servidor.close(resolve));
  }
});

/** Abre a página no celular, com o POST interceptado, e devolve o que ficou nos campos. */
async function abrir(query, { storage = "" } = {}) {
  const contexto = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "pt-BR" });
  const page = await contexto.newPage();
  const erros = [];
  const enviados = [];
  page.on("pageerror", (e) => erros.push(e.message));
  await page.route("**/api/atualizacao-perfil", async (route) => {
    enviados.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, profession: "tecnico_enfermagem" }) });
  });
  if (storage) await page.addInitScript((v) => localStorage.setItem("ev_atualizacao_v1", v), storage);
  await page.goto(`${BASE}${ROTA}${query}`);
  await page.waitForSelector("#campo-nome");
  const campos = async () =>
    await page.evaluate(() => ({
      nome: document.getElementById("campo-nome").value,
      whatsapp: document.getElementById("campo-whatsapp").value,
      email: document.getElementById("campo-email").value
    }));
  return { page, contexto, erros, enviados, campos };
}

test("o link do UnniChat chega com nome e WhatsApp prontos, e nada é enviado sozinho", async () => {
  const { contexto, erros, enviados, campos } = await abrir("?nome=maria%20da%20silva&telefone=5511988880001&utm_source=unnichat&utm_medium=whatsapp");
  assert.deepEqual(await campos(), { nome: "Maria da Silva", whatsapp: "(11) 98888-0001", email: "" });
  assert.deepEqual(enviados, [], "a página não grava nada só por ter sido aberta");
  assert.deepEqual(erros, []);
  await contexto.close();
});

test("e-mail no link também entra, normalizado, e o +55 com máscara é aceito", async () => {
  const { contexto, campos } = await abrir("?nome=Ana&telefone=%2B55%2011%2099999-8888&email=ANA%40Gmail.com");
  assert.deepEqual(await campos(), { nome: "Ana", whatsapp: "(11) 99999-8888", email: "ana@gmail.com" });
  await contexto.close();
});

test("variável não substituída ou número de fora não entra no campo", async () => {
  for (const telefone of ["%7B%7Btelefone_do_contato%7D%7D", "12345", "%2B1%20415%20555%200123"]) {
    const { contexto, campos } = await abrir(`?nome=Ana%20Souza&telefone=${telefone}`);
    const valores = await campos();
    assert.equal(valores.whatsapp, "", telefone);
    assert.equal(valores.nome, "Ana Souza", `${telefone}: o nome continua vindo`);
    await contexto.close();
  }
});

test("o que a pessoa já digitou aqui ganha do link", async () => {
  const guardado = JSON.stringify({
    id: "11111111-1111-4111-8111-111111111111",
    contato: { nome: "Joana Pereira", whatsapp: "(21) 97777-1234", email: "joana@gmail.com" }
  });
  const { contexto, campos } = await abrir("?nome=Maria&telefone=5511988880001&email=maria@gmail.com", { storage: guardado });
  assert.deepEqual(await campos(), { nome: "Joana Pereira", whatsapp: "(21) 97777-1234", email: "joana@gmail.com" });
  await contexto.close();
});

test("do link à página de obrigado: só falta o e-mail e a profissão", async () => {
  const { page, contexto, erros, enviados } = await abrir("?nome=maria%20da%20silva&telefone=5511988880001&utm_source=unnichat&utm_campaign=atualizar-perfil");
  await page.fill("#campo-email", "maria@gmail.com");
  await page.click("#botao-continuar");
  await page.waitForSelector("#passo-perfil:not([hidden])");
  await page.click(".opcao:has-text('Técnico(a) de enfermagem')");
  await page.waitForURL(/obrigado-evento-outubro/);

  const destino = new URL(page.url());
  assert.equal(destino.pathname, "/obrigado-evento-outubro", "o técnico vai para a página do evento");
  assert.equal(destino.searchParams.get("utm_source"), "unnichat", "as UTMs seguem para o obrigado");
  assert.equal(destino.searchParams.get("utm_campaign"), "atualizar-perfil");

  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].contato.nome, "Maria da Silva");
  assert.equal(enviados[0].contato.whatsapp, "(11) 98888-0001");
  assert.equal(enviados[0].contato.email, "maria@gmail.com");
  assert.equal(enviados[0].perfil, "Técnico(a) de enfermagem");
  assert.equal(enviados[0].rastreio.utm_source, "unnichat");
  assert.deepEqual(erros, []);
  await contexto.close();
});
