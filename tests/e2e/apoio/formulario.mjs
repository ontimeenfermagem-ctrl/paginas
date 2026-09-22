// Apoio da suíte tests/e2e/formulario.e2e.mjs: sobe o server.mjs de verdade (só para servir as
// páginas, sem banco), abre "celulares" no Chromium e intercepta /api/pesquisa/* no navegador, para
// simular cada resposta do servidor (200, 422, 5xx, rede caída) sem depender de Postgres.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { createServerApp } from "../../../server.mjs";

export { assert };

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "pesquisa-config.js"), "utf8"), contexto);
/** O EVPesquisa de verdade, o mesmo arquivo que o navegador carrega. */
export const P = contexto.EVPesquisa;

export const CONTATO = { nome: "maria  da silva", whatsapp: "11912345678", email: "maria@gmail.com" };

export const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * O servidor de produção servindo as páginas, em porta livre. Sem Supabase (a API é
 * interceptada no navegador e nunca chega aqui), sem Pixel (os testes de Pixel instalam um fbq
 * falso) e com DNS falso (nenhuma consulta sai da máquina).
 */
export async function subirServidor() {
  const server = createServerApp({ rootDirectory: RAIZ, metaPixelId: "off", resolveEmailDomain: async () => "ok" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async fechar() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/**
 * Intercepta /api/pesquisa/*. `modo.salvar(corpo, n)` pode devolver {status, json}, "abort"
 * (rede caída) ou nada (200 padrão). Devolve o registro do que chegou.
 */
export async function interceptar(page, modo = {}) {
  const reg = { salvar: [], evento: [], abortados: 0 };
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
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    }
    if (url.pathname.endsWith("/salvar")) {
      const n = reg.salvar.length;
      const r = modo.salvar ? await modo.salvar(corpo, n) : null;
      if (r === "abort") {
        reg.abortados += 1;
        return route.abort("internetdisconnected");
      }
      reg.salvar.push(corpo);
      if (r && r.status) return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.json || {}) });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, status: "em_andamento", novo: n === 0, concluiu_agora: false, progresso: {} })
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  // Nada de chamada externa (Pixel) nos testes.
  await page.route(/facebook\.(net|com)/, (rota) => rota.abort());
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

export async function perguntaAtual(page) {
  return page.evaluate(() => {
    const t = document.getElementById("tela-pergunta");
    if (!t.hidden) return { id: t.dataset.pergunta, tipo: t.dataset.tipo };
    for (const n of ["boasvindas", "contato", "fim"]) if (!document.getElementById("tela-" + n).hidden) return { id: n, tipo: n };
    return { id: "?", tipo: "?" };
  });
}

export async function esperarTrocar(page, idAnterior) {
  await page.waitForFunction(
    (a) => {
      const t = document.getElementById("tela-pergunta");
      const atual = !t.hidden ? t.dataset.pergunta : ["boasvindas", "contato", "fim"].find((n) => !document.getElementById("tela-" + n).hidden);
      return atual && atual !== a;
    },
    idAnterior,
    { timeout: 5000 }
  );
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

export async function responderAteOFim(page, escolhas = {}, limite = 60) {
  const vistos = [];
  for (let i = 0; i < limite; i += 1) {
    const { id } = await perguntaAtual(page);
    if (id === "fim") return vistos;
    vistos.push(await responder(page, escolhas));
  }
  throw new Error("não chegou ao fim: " + vistos.join(","));
}

export async function lerRascunho(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("ev_pesquisa_icp_v1") || "null"));
}
