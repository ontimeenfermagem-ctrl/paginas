// A página de inscrição /viver-de-furo-inscricao no Chromium, com /api/inscricao interceptado no
// navegador: validação dos 3 campos, máscara do WhatsApp, corpo exato do contrato, ida para a URL
// devolvida pelo servidor, 422 que segura a pessoa, plano B quando o servidor demora ou cai
// (URL montada aqui, com as UTMs, sck=utm_term e o contato), Pixel, acessibilidade e responsivo.
//
// Servidor estático próprio (como o obrigado.e2e), com a rota do EVCheckout mapeada para o HTML.
//
//   node --test tests/e2e/inscricao.e2e.mjs      (precisa só do Playwright; sem Docker)
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import vm from "node:vm";

import { chromium } from "playwright";

import { assert, esperar, novaPagina, RAIZ } from "./apoio/formulario.mjs";

/* ------------------------------------------------------------------ os contratos de verdade */

const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "lead-rules.js"), "utf8"), contexto);
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "checkout-config.js"), "utf8"), contexto);
/** O EVCheckout de verdade, o mesmo arquivo que o navegador carrega. */
const C = contexto.EVCheckout;
const PAGINA = C.PAGINAS["viver-de-furo"];
const HTML = "/viver-de-furo-inscricao.html";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTATO = { nome: "maria  da silva", whatsapp: "11912345678", email: "maria@gmail.com" };
const LIMPO = { nome: "maria da silva", whatsapp: "(11) 91234-5678", email: "maria@gmail.com" };
const UTM =
  "?utm_source=meta&utm_medium=cpc&utm_campaign=furo-set&utm_term=publico-frio&utm_content=criativo-3&fbclid=fb123";
/** O que o SERVIDOR devolveria: a página tem que obedecer a esta URL, e não montar a dela. */
const CHECKOUT_DO_SERVIDOR = `${PAGINA.checkout}&sck=do-servidor&name=Maria+Da+Silva`;

/* ------------------------------------------------------------------ servidor estático */

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml"
};

/** A mesma CSP das outras páginas públicas: nada de CDN, script inline só o do Pixel. */
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

const ROTAS = new Map([
  [PAGINA.rota, HTML],
  [`${PAGINA.rota}/`, HTML]
]);

async function subirServidor() {
  const server = http.createServer(async (req, res) => {
    try {
      const caminho = decodeURIComponent(new URL(req.url, "http://x").pathname);
      const arquivo = ROTAS.get(caminho) || caminho;
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

let servidor;
let base;
let browser;

before(async () => {
  servidor = await subirServidor();
  base = servidor.base;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close().catch(() => {});
  await servidor?.fechar();
});

/* ------------------------------------------------------------------ interceptação da API */

/**
 * Intercepta POST /api/inscricao. `modo(corpo, n)` pode devolver {status, json}, {atraso},
 * "abort" (rede caída), "mudo" (nunca responde) ou nada (200 com o checkout do servidor).
 * Devolve o registro: `corpos` (o que chegou) e `keepalive` (quantos vieram com keepalive).
 */
async function interceptar(page, modo) {
  const reg = { corpos: [], abortados: 0 };
  await page.route("**/api/inscricao", async (route) => {
    let corpo = null;
    try {
      corpo = JSON.parse(route.request().postData() || "null");
    } catch {
      corpo = null;
    }
    const n = reg.corpos.length;
    reg.corpos.push(corpo);
    const r = modo ? await modo(corpo, n) : null;
    try {
      if (r === "mudo") return; // nunca responde: a página tem que seguir sem ele
      if (r === "abort") {
        reg.abortados += 1;
        return await route.abort("internetdisconnected");
      }
      if (r && r.atraso) await esperar(r.atraso);
      if (r && r.status) {
        return await route.fulfill({
          status: r.status,
          contentType: "application/json",
          body: JSON.stringify(r.json || {})
        });
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, checkout: CHECKOUT_DO_SERVIDOR })
      });
    } catch {
      // A página já foi embora para o checkout antes da resposta: não é erro.
    }
  });
  await page.route(/facebook\.(net|com)/, (rota) => rota.abort());
  return reg;
}

/** Um caso = um "celular" limpo, com a API e o checkout interceptados e sem erro de console. */
function caso(nome, fn, opts = {}) {
  test(nome, async () => {
    const { ctx, page, erros } = await novaPagina(browser, opts);
    const reg = await interceptar(page, opts.api);
    // Nenhum envio sai para a Hotmart de verdade.
    await ctx.route(/pay\.hotmart\.com/, (rota) =>
      rota.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<title>checkout</title><h1>Checkout</h1>" })
    );
    try {
      await fn(page, reg, ctx);
      assert.deepEqual(erros, [], "erros no console");
    } finally {
      await ctx.close();
    }
  });
}

async function abrir(page, query = "") {
  await page.goto(base + PAGINA.rota + query);
  await page.waitForSelector("#form-inscricao");
  await page.waitForFunction(() => document.title.includes("Inscrição ·"));
}

const textoDe = (page, seletor) => page.locator(seletor).evaluate((el) => el.textContent.trim());

async function preencher(page, c = CONTATO) {
  await page.fill("#campo-nome", c.nome);
  await page.fill("#campo-whatsapp", "");
  await page.type("#campo-whatsapp", c.whatsapp);
  await page.fill("#campo-email", c.email);
}

/** Espera a página sair para a Hotmart e devolve a URL de chegada. */
async function esperarCheckout(page, timeout = 8000) {
  await page.waitForURL(/pay\.hotmart\.com/, { timeout });
  return new URL(page.url());
}

/* ================================================================== */
/* 1. A página                                                         */
/* ================================================================== */

caso("monta com o produto do EVCheckout: uma linha de contexto, um h1 e o botão verde", async (page) => {
  await abrir(page);
  assert.equal(await page.title(), `Inscrição · ${PAGINA.produto} | Escola Enfermagem de Valor`);
  assert.equal(await textoDe(page, "#ins-eyebrow"), `Inscrição · ${PAGINA.produto}`);
  assert.equal(await textoDe(page, "h1"), "Garanta sua vaga");
  assert.equal(await page.locator("h1:visible").count(), 1);
  assert.equal(await page.locator("main").count(), 1);
  assert.equal(await textoDe(page, "#botao-ir-texto"), "IR PARA O PAGAMENTO");
  assert.equal(await textoDe(page, ".ins-seguro"), "Pagamento pelo checkout oficial da Hotmart");

  // Nada de conteúdo longo: só os 3 campos.
  assert.equal(await page.locator("#form-inscricao input").count(), 3);
  const rotulos = await page.$$eval("#form-inscricao label", (ls) => ls.map((l) => [l.getAttribute("for"), l.textContent]));
  assert.deepEqual(rotulos, [
    ["campo-nome", "Nome completo"],
    ["campo-whatsapp", "WhatsApp com DDD"],
    ["campo-email", "E-mail"]
  ]);
  // O botão é verde de verdade (o mesmo das páginas de obrigado) e o texto é branco.
  const cores = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById("botao-ir"));
    return [s.backgroundImage, s.color];
  });
  assert.match(cores[0], /rgb\(24, 157, 75\)/);
  assert.equal(cores[1], "rgb(255, 255, 255)");
  // Nenhum script inline (a CSP da produção não deixaria).
  assert.equal(await page.locator("script:not([src])").count(), 0);
});

caso(
  "botão visível sem rolar em 360x640, com largura total e altura de alvo grande",
  async (page) => {
    await abrir(page);
    const caixa = await page.locator("#botao-ir").boundingBox();
    assert.ok(caixa.y >= 0 && caixa.y + caixa.height <= 640, `botão em ${JSON.stringify(caixa)}`);
    assert.ok(caixa.height >= 56, `botão grande: ${caixa.height}`);
    assert.ok(caixa.width >= 360 - 2 * 20 - 1, `largura total no celular: ${caixa.width}`);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  },
  { largura: 360, altura: 640 }
);

/* ================================================================== */
/* 2. Validação                                                        */
/* ================================================================== */

caso("nome sem sobrenome: erro no campo com role=alert, foco no nome e nenhum envio", async (page, reg) => {
  await abrir(page);
  await preencher(page, Object.assign({}, CONTATO, { nome: "Maria" }));
  await page.click("#botao-ir");
  assert.equal(await textoDe(page, "#erro-nome"), "Escreva também o seu sobrenome.");
  assert.equal(await page.getAttribute("#erro-nome", "role"), "alert");
  assert.equal(await page.getAttribute("#campo-nome", "aria-invalid"), "true");
  assert.equal(await page.evaluate(() => document.activeElement.id), "campo-nome");
  assert.equal(await page.locator('[data-campo="nome"].tem-erro').count(), 1);
  await esperar(250);
  assert.equal(reg.corpos.length, 0, "não envia com erro");
  assert.ok(!page.url().includes("hotmart"));

  // Corrigiu: o erro some na hora, sem esperar sair do campo.
  await page.fill("#campo-nome", "Maria Silva");
  assert.equal(await page.isHidden("#erro-nome"), true);
});

caso("DDD que não existe e celular sem o 9: cada um com a sua mensagem", async (page, reg) => {
  await abrir(page);
  await preencher(page, Object.assign({}, CONTATO, { whatsapp: "00912345678" }));
  await page.click("#botao-ir");
  assert.equal(await textoDe(page, "#erro-whatsapp"), "Esse DDD não existe. Confere o número?");
  assert.equal(await page.evaluate(() => document.activeElement.id), "campo-whatsapp");

  await page.fill("#campo-whatsapp", "");
  await page.type("#campo-whatsapp", "11812345678");
  await page.click("#botao-ir");
  assert.equal(
    await textoDe(page, "#erro-whatsapp"),
    "O WhatsApp precisa ser um celular: depois do DDD, o número começa com 9."
  );

  await page.fill("#campo-whatsapp", "");
  await page.type("#campo-whatsapp", "1191234");
  await page.click("#botao-ir");
  assert.equal(await textoDe(page, "#erro-whatsapp"), "Faltam números: são 11 dígitos contando o DDD.");
  await esperar(200);
  assert.equal(reg.corpos.length, 0);
});

caso("máscara do WhatsApp enquanto digita, e o backspace não fica preso no separador", async (page) => {
  await abrir(page);
  await page.type("#campo-whatsapp", "11");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(11");
  await page.type("#campo-whatsapp", "91234");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(11) 91234");
  await page.type("#campo-whatsapp", "5678");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(11) 91234-5678");
  // Colado com +55 e pontuação: vira o mesmo número.
  await page.fill("#campo-whatsapp", "+55 (11) 91234-5678");
  await page.dispatchEvent("#campo-whatsapp", "input");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(11) 91234-5678");
  // Apagar anda dígito a dígito: a máscara nunca "devolve" o número que a pessoa acabou de tirar.
  await page.press("#campo-whatsapp", "Backspace");
  await page.press("#campo-whatsapp", "Backspace");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(11) 91234-56");
  for (let i = 0; i < 7; i += 1) await page.press("#campo-whatsapp", "Backspace");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(11");
});

caso("e-mail com erro de digitação certo (gmail.con): bloqueia e oferece a correção", async (page, reg) => {
  await abrir(page);
  await preencher(page, Object.assign({}, CONTATO, { email: "maria@gmail.con" }));
  await page.click("#botao-ir");
  assert.equal(await textoDe(page, "#erro-email"), "Confere o final do e-mail, parece que tem um erro de digitação.");
  assert.equal(await page.isVisible("#sugestao-email"), true);
  assert.equal(await textoDe(page, "#sugestao-valor"), "maria@gmail.com");
  assert.equal(await page.isHidden("#sugestao-nao"), true, '"está certo" não é opção num domínio que não existe');
  await esperar(200);
  assert.equal(reg.corpos.length, 0);

  await page.click("#sugestao-sim");
  assert.equal(await page.inputValue("#campo-email"), "maria@gmail.com");
  assert.equal(await page.isHidden("#erro-email"), true);
  assert.equal(await page.isHidden("#sugestao-email"), true);
  await page.click("#botao-ir");
  await esperarCheckout(page);
  assert.equal(reg.corpos[0].contato.email, "maria@gmail.com");
});

caso("e-mail parecido (gmial.com): pergunta antes de seguir; 'está certo' passa direto", async (page, reg) => {
  await abrir(page);
  await preencher(page, Object.assign({}, CONTATO, { email: "maria@gmial.com" }));
  await page.click("#botao-ir");
  assert.equal(await page.isVisible("#sugestao-email"), true);
  assert.equal(await textoDe(page, "#sugestao-valor"), "maria@gmail.com");
  assert.equal(await page.isVisible("#sugestao-nao"), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "sugestao-sim");
  await esperar(200);
  assert.equal(reg.corpos.length, 0, "a sugestão segura o envio uma vez");

  await page.click("#sugestao-nao");
  assert.equal(await page.isHidden("#sugestao-email"), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), "botao-ir");
  await page.click("#botao-ir");
  await esperarCheckout(page);
  assert.equal(reg.corpos[0].contato.email, "maria@gmial.com", "quem confirma segue com o e-mail dela");
});

/* ================================================================== */
/* 3. Envio                                                            */
/* ================================================================== */

caso("envio manda o corpo exato do contrato e vai para a URL que o SERVIDOR devolveu", async (page, reg) => {
  await abrir(page, UTM);
  await preencher(page);
  await page.click("#botao-ir");
  const url = await esperarCheckout(page);
  assert.equal(url.href, CHECKOUT_DO_SERVIDOR, "a URL do servidor ganha da montada aqui");

  assert.equal(reg.corpos.length, 1);
  const corpo = reg.corpos[0];
  assert.deepEqual(Object.keys(corpo).sort(), ["contato", "id", "pagina", "rastreio", "visitante_id"]);
  assert.equal(corpo.pagina, "viver-de-furo");
  assert.match(corpo.id, UUID);
  assert.match(corpo.visitante_id, UUID);
  assert.deepEqual(corpo.contato, LIMPO);
  assert.deepEqual(corpo.rastreio, {
    page_url: `${base}${PAGINA.rota}${UTM}`,
    referrer: null,
    dispositivo: "mobile",
    utm_source: "meta",
    utm_medium: "cpc",
    utm_campaign: "furo-set",
    utm_content: "criativo-3",
    utm_term: "publico-frio",
    fbclid: "fb123",
    gclid: null
  });
});

caso(
  "dois toques seguidos no botão (o dedo apressado) mandam um envio só",
  async (page, reg) => {
    await abrir(page);
    await preencher(page);
    // Os dois toques saem juntos, sem a espera de "elemento clicável" do Playwright no meio.
    await page.$eval("#botao-ir", (b) => {
      b.click();
      b.click();
    });
    await page.waitForFunction(() => document.getElementById("botao-ir").disabled);
    await page.$eval("#botao-ir", (b) => b.click());
    await esperarCheckout(page);
    assert.equal(reg.corpos.length, 1, "um envio só");
  },
  { api: async () => ({ atraso: 600 }) }
);

caso(
  "enquanto espera o servidor, o botão mostra 'Abrindo o pagamento…' e fica travado",
  async (page) => {
    await abrir(page);
    await preencher(page);
    await page.click("#botao-ir");
    await page.waitForFunction(() => document.getElementById("botao-ir").disabled);
    assert.equal(await textoDe(page, "#botao-ir-texto"), "Abrindo o pagamento…");
    assert.equal(await page.getAttribute("#botao-ir", "aria-busy"), "true");
    assert.equal(await page.isVisible("#botao-ir .botao-carregando"), true);
    await esperarCheckout(page);
  },
  { api: async () => ({ atraso: 900 }) }
);

caso(
  "422 invalid_contact: erros nos campos, foco no primeiro e a pessoa NÃO sai da página",
  async (page, reg) => {
    await abrir(page);
    await preencher(page);
    await page.click("#botao-ir");
    await page.waitForSelector("#erro-email:not([hidden])");
    assert.equal(await textoDe(page, "#erro-email"), "Não encontramos esse endereço de e-mail. Confere se está certinho?");
    assert.equal(await page.evaluate(() => document.activeElement.id), "campo-email");
    assert.equal(await page.getAttribute("#campo-email", "aria-invalid"), "true");
    // O botão volta a funcionar e a pessoa continua aqui.
    assert.equal(await page.locator("#botao-ir").isDisabled(), false);
    assert.equal(await textoDe(page, "#botao-ir-texto"), "IR PARA O PAGAMENTO");
    await esperar(400);
    assert.ok(!page.url().includes("hotmart"), "422 segura a venda");
    assert.equal(reg.corpos.length, 1);
  },
  {
    api: async () => ({
      status: 422,
      json: {
        ok: false,
        error: "invalid_contact",
        campos: { email: "Não encontramos esse endereço de e-mail. Confere se está certinho?" }
      }
    })
  }
);

/* ================================================================== */
/* 4. Plano B: nada trava a venda                                      */
/* ================================================================== */

/** Confere a URL montada no navegador: oferta, modo, UTMs, sck=utm_term e o contato. */
function conferirUrlMontada(url) {
  assert.equal(url.origin + url.pathname, "https://pay.hotmart.com/Y74893363S");
  // A oferta sai do próprio link do config (o campo `oferta` separado deixou de existir): é a mesma
  // que o webhook usa para reconhecer a venda como desta página.
  assert.equal(url.searchParams.get("off"), C.ofertaDoLink(PAGINA.checkout));
  assert.ok(PAGINA.hotmart.ofertas.includes(url.searchParams.get("off")), "a oferta do link é uma das que o webhook reconhece");
  assert.equal(url.searchParams.get("checkoutMode"), "10");
  assert.equal(url.searchParams.get("utm_source"), "meta");
  assert.equal(url.searchParams.get("utm_medium"), "cpc");
  assert.equal(url.searchParams.get("utm_campaign"), "furo-set");
  assert.equal(url.searchParams.get("utm_term"), "publico-frio");
  assert.equal(url.searchParams.get("utm_content"), "criativo-3");
  assert.equal(url.searchParams.get("sck"), "publico-frio", "o utm_term vira o sck");
  assert.equal(url.searchParams.get("name"), "Maria da Silva");
  assert.equal(url.searchParams.get("email"), "maria@gmail.com");
  assert.equal(url.searchParams.get("phoneac"), "11");
  assert.equal(url.searchParams.get("phonenumber"), "912345678");
}

for (const [nome, api] of [
  ["servidor mudo (demora acima de 3,5s)", async () => "mudo"],
  ["rede caída", async () => "abort"],
  ["503", async () => ({ status: 503, json: { ok: false, error: "unavailable" } })],
  ["429", async () => ({ status: 429, json: { ok: false, error: "rate_limited" } })],
  ["200 sem checkout no corpo", async () => ({ status: 200, json: { ok: true } })]
]) {
  caso(
    `plano B com ${nome}: vai para a URL montada no navegador, com o POST em keepalive`,
    async (page, reg) => {
      await abrir(page, UTM);
      await preencher(page);
      const inicio = Date.now();
      await page.click("#botao-ir");
      const url = await esperarCheckout(page, 12000);
      const levou = Date.now() - inicio;
      assert.ok(levou < 8000, `demorou ${levou}ms para abrir o checkout`);
      conferirUrlMontada(url);
      // O servidor recebe o lead assim mesmo (o segundo POST sai com keepalive).
      assert.ok(reg.corpos.length >= 1, "o POST foi tentado");
      const primeiro = reg.corpos[0];
      if (primeiro) assert.deepEqual(primeiro.contato, LIMPO);
    },
    { api }
  );
}

caso(
  "servidor mudo: a espera é de uns 3,5s, não mais",
  async (page) => {
    await abrir(page, UTM);
    await preencher(page);
    const inicio = Date.now();
    await page.click("#botao-ir");
    await esperarCheckout(page, 12000);
    const levou = Date.now() - inicio;
    assert.ok(levou >= 3000 && levou <= 7000, `esperou ${levou}ms (o limite é ~3,5s)`);
  },
  { api: async () => "mudo" }
);

/* ================================================================== */
/* 5. Pixel, storage e volta                                           */
/* ================================================================== */

caso("Pixel: contato recusado não vira Lead", async (page) => {
  await page.addInitScript(() => {
    window.__px = [];
    window.fbq = (...a) => window.__px.push(JSON.parse(JSON.stringify(a)));
  });
  await abrir(page);
  await preencher(page, Object.assign({}, CONTATO, { nome: "Maria" }));
  await page.click("#botao-ir");
  await esperar(200);
  assert.deepEqual(await page.evaluate(() => window.__px), []);
});

caso("Pixel: Lead quando o contato é aceito e clique_checkout antes de sair, nessa ordem", async (page) => {
  // O Pixel escreve FORA do navegador: o último evento sai junto com a troca de página, e um
  // window.__px lido depois já teria ido embora com o documento antigo.
  const eventos = [];
  await page.exposeFunction("__px", (argumentos) => {
    eventos.push(argumentos);
  });
  await page.addInitScript(() => {
    window.fbq = (...a) => window.__px(a);
  });
  await abrir(page);
  await preencher(page);
  await page.click("#botao-ir");
  const url = await esperarCheckout(page);
  assert.equal(url.href, CHECKOUT_DO_SERVIDOR);
  assert.deepEqual(eventos, [
    ["track", "Lead"],
    ["trackCustom", "clique_checkout", { pagina: "viver-de-furo" }]
  ]);
});

caso("quem volta do checkout encontra os campos preenchidos e o botão liberado", async (page, reg) => {
  await abrir(page, UTM);
  await preencher(page);
  await page.click("#botao-ir");
  await esperarCheckout(page);

  await page.goBack();
  await page.waitForSelector("#form-inscricao");
  await page.waitForFunction(() => !document.getElementById("botao-ir").disabled);
  assert.equal(await page.inputValue("#campo-nome"), "maria da silva");
  assert.equal(await page.inputValue("#campo-whatsapp"), "(11) 91234-5678");
  assert.equal(await page.inputValue("#campo-email"), "maria@gmail.com");
  assert.equal(await textoDe(page, "#botao-ir-texto"), "IR PARA O PAGAMENTO");
  await esperar(250);
  assert.equal(reg.corpos.length, 1, "voltar não reenvia nada sozinho");

  // Numa visita nova (recarregando do zero) os campos também voltam preenchidos.
  await page.goto(base + PAGINA.rota);
  await page.waitForSelector("#form-inscricao");
  assert.equal(await page.inputValue("#campo-email"), "maria@gmail.com");
});

caso("rastreio de PRIMEIRO toque: a segunda visita, sem UTM, mantém a campanha da primeira", async (page, reg) => {
  await abrir(page, UTM);
  await page.goto(base + PAGINA.rota);
  await page.waitForSelector("#form-inscricao");
  await preencher(page);
  await page.click("#botao-ir");
  await esperarCheckout(page);
  const { rastreio } = reg.corpos[0];
  assert.equal(rastreio.utm_source, "meta");
  assert.equal(rastreio.utm_campaign, "furo-set");
  assert.equal(rastreio.fbclid, "fb123");
  assert.equal(rastreio.page_url, `${base}${PAGINA.rota}`, "page_url é o da visita atual");
});

caso("sem localStorage (webview bloqueado): valida, envia e sai do mesmo jeito", async (page, reg) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("bloqueado");
      }
    });
  });
  await abrir(page, UTM);
  await preencher(page);
  await page.click("#botao-ir");
  await esperarCheckout(page);
  assert.equal(reg.corpos.length, 1);
  assert.match(reg.corpos[0].visitante_id, UUID);
  assert.equal(reg.corpos[0].rastreio.utm_source, "meta");
});

/* ================================================================== */
/* 6. Acessibilidade e responsivo                                      */
/* ================================================================== */

caso(
  "teclado: pular para o conteúdo, os 3 campos e o botão, todos com foco visível",
  async (page) => {
    await abrir(page);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.className), "pular-link");
    for (const id of ["campo-nome", "campo-whatsapp", "campo-email", "botao-ir"]) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement.id), id);
      const anel = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement);
        return { estilo: s.outlineStyle, largura: parseFloat(s.outlineWidth) || 0, sombra: s.boxShadow };
      });
      const temAnel = (anel.estilo !== "none" && anel.largura >= 2) || /rgb\(112, 76, 99\)/.test(anel.sombra);
      assert.ok(temAnel, `sem anel de foco em ${id}: ${JSON.stringify(anel)}`);
    }
    // Enter no nome e no WhatsApp anda para o campo seguinte, em vez de enviar pela metade.
    await page.focus("#campo-nome");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "campo-whatsapp");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "campo-email");
  },
  { largura: 1280, altura: 800, mobile: false }
);

caso("Enter no e-mail envia o formulário", async (page, reg) => {
  await abrir(page);
  await preencher(page);
  await page.focus("#campo-email");
  await page.keyboard.press("Enter");
  await esperarCheckout(page);
  assert.equal(reg.corpos.length, 1);
});

for (const [largura, altura] of [
  [320, 568],
  [360, 640],
  [390, 844],
  [768, 1024],
  [1280, 800]
]) {
  caso(
    `sem rolagem horizontal em ${largura}px e alvos de toque >= 44px (inclusive com erro na tela)`,
    async (page) => {
      await abrir(page, UTM);
      const semRolagem = async (quando) => {
        const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        assert.ok(w[0] <= w[1], `${quando}: ${w}`);
      };
      const alvos = async (quando) => {
        const pequenos = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a, button, input"))
            .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44)
            .map((e) => e.id || e.className)
        );
        assert.deepEqual(pequenos, [], quando);
      };
      await semRolagem("vazio");
      await alvos("vazio");

      // Com os três erros e a sugestão de e-mail abertos (a tela mais cheia que existe aqui).
      await preencher(page, { nome: "Maria", whatsapp: "0012345678", email: "maria@gmial.com" });
      await page.click("#botao-ir");
      await page.waitForSelector("#erro-nome:not([hidden])");
      await page.fill("#campo-nome", "Maria da Silva");
      await page.fill("#campo-whatsapp", "(11) 91234-5678");
      await page.click("#botao-ir");
      await page.waitForSelector("#sugestao-email:not([hidden])");
      await semRolagem("com erro");
      await alvos("com erro");
    },
    { largura, altura, mobile: largura < 768 }
  );
}

caso(
  "movimento reduzido: a sugestão não sacode",
  async (page) => {
    await abrir(page);
    await preencher(page, Object.assign({}, CONTATO, { email: "maria@gmial.com" }));
    await page.click("#botao-ir");
    await page.waitForSelector("#sugestao-email:not([hidden])");
    const duracao = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.getElementById("sugestao-email")).animationDuration)
    );
    assert.ok(duracao < 0.01, `a animação continuou rodando: ${duracao}s`);
  },
  { reduzir: true }
);
