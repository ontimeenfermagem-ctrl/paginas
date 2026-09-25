// As 3 páginas de obrigado (/obrigado-afericao, /obrigado-cuidador, /obrigado-evento-outubro) no
// Chromium, com a API interceptada no navegador: texto exato do js/obrigado-config.js, só o botão
// do próprio grupo, botão visível sem rolar no celular, aviso quando o link ainda não foi
// configurado, eventos "visita" e "clique_grupo", Pixel e nenhuma rolagem horizontal.
//
// Os links dos grupos são injetados trocando o js/obrigado-config.js servido (page.route), então
// a suíte vale com o arquivo real vazio ou já preenchido.
//
//   node --test tests/e2e/obrigado.e2e.mjs      (precisa só do Playwright; sem Docker)
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { chromium } from "playwright";

import { assert, esperar, interceptar, novaPagina, O, P, RAIZ, subirServidor } from "./apoio/formulario.mjs";

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

const CONFIG_ORIGINAL = readFileSync(path.join(RAIZ, "js", "obrigado-config.js"), "utf8");

/**
 * Links de teste, um por grupo, para provar que uma página nunca mostra o link de outra. Dois no
 * formato do distribuidor (Sendflow), que é o que está em produção, e um convite direto do
 * WhatsApp, para a outra forma continuar exercida.
 */
const LINKS = {
  afericao: "https://sndflw.com/i/TesteAfericao123",
  cuidador: "https://chat.whatsapp.com/TesteCuidador456",
  evento_outubro: "https://sndflw.com/i/TesteEvento789"
};
const VAZIOS = { afericao: "", cuidador: "", evento_outubro: "" };

/** O obrigado-config.js com o bloco LINKS_GRUPOS trocado. */
function configCom(links) {
  const bloco = /const LINKS_GRUPOS = Object\.freeze\(\{[\s\S]*?\}\);/;
  assert.match(CONFIG_ORIGINAL, bloco, "o bloco LINKS_GRUPOS mudou de formato");
  const novo = `const LINKS_GRUPOS = Object.freeze(${JSON.stringify(links)});`;
  return CONFIG_ORIGINAL.replace(bloco, novo);
}

async function servirConfig(page, links) {
  await page.route("**/js/obrigado-config.js", (rota) =>
    rota.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: configCom(links) })
  );
}

/** Rascunho de quem acabou de responder a pesquisa neste aparelho. */
function rascunho(perfil, extra = {}) {
  return Object.assign(
    {
      versao: P.VERSAO,
      id: "3f1b2c4d-5e6f-4a1b-8c2d-9e0f1a2b3c4d",
      seq: 40,
      contato: { nome: "maria da silva", whatsapp: "(11) 91234-5678", email: "maria@gmail.com" },
      respostas: { perfil },
      pergunta_atual: "fim",
      rastreio: { utm_source: "instagram", utm_medium: "stories", utm_campaign: "icp-set", fbclid: "abc123" },
      concluida: true
    },
    extra
  );
}
const VISITANTE = "0b4c9a8e-1d2f-4e3a-9b5c-6d7e8f9a0b1c";

async function comRascunho(page, r) {
  await page.addInitScript(
    ([chave, valor, visitante]) => {
      try {
        localStorage.setItem(chave, valor);
        localStorage.setItem("ev_pesquisa_visitante", visitante);
      } catch {
        // sem storage neste teste
      }
    },
    ["ev_pesquisa_icp_v1", JSON.stringify(r), VISITANTE]
  );
}

/**
 * Um caso = um "celular" limpo com a API interceptada e o config servido com `links`; no fim,
 * nenhum erro de JavaScript.
 */
function caso(nome, fn, opts = {}) {
  test(nome, async () => {
    const { ctx, page, erros } = await novaPagina(browser, opts);
    const reg = await interceptar(page);
    await servirConfig(page, opts.links || VAZIOS);
    // Nenhum clique sai para o WhatsApp nem para o distribuidor de verdade.
    await ctx.route(/chat\.whatsapp\.com|wa\.me|sndflw\.com/, (rota) =>
      rota.fulfill({ status: 200, contentType: "text/html", body: "<title>grupo</title>" })
    );
    try {
      await fn(page, reg, ctx);
      assert.deepEqual(erros, [], "erros no console");
    } finally {
      await ctx.close();
    }
  });
}

async function ate(fn, timeout = 4000) {
  const limite = Date.now() + timeout;
  for (;;) {
    const valor = await fn();
    if (valor) return valor;
    if (Date.now() > limite) throw new Error("não aconteceu a tempo: " + fn);
    await esperar(40);
  }
}

async function abrir(page, rota, query = "") {
  await page.goto(base + rota + query);
  await page.waitForSelector("#ob-pagina:not([hidden])");
}

const textoDe = (page, seletor) => page.locator(seletor).evaluate((el) => el.textContent);

/* ------------------------------------------------------------------ conteúdo e CTA de cada página */

const UTM = "?utm_source=meta&utm_campaign=campanha-x&utm_content=criativo-y";

for (const pagina of O.LISTA) {
  caso(`${pagina.rota}: texto exato do config, aviso sem link, "visita" com as UTMs`, async (page, reg) => {
    await abrir(page, pagina.rota, UTM + "#topo");
    assert.equal(await page.title(), `${pagina.nome} | Escola Enfermagem de Valor`);
    assert.equal(await textoDe(page, "#ob-eyebrow"), pagina.eyebrow);
    assert.equal(await textoDe(page, "#ob-titulo"), pagina.headline, "sem rascunho: a headline exata do cliente");
    assert.equal(await textoDe(page, "#ob-sub"), pagina.subheadline);
    assert.equal(await textoDe(page, "#ob-intro"), pagina.introducao);
    assert.deepEqual(await page.$$eval("#ob-topicos li", (itens) => itens.map((li) => li.textContent)), [...pagina.topicos]);
    assert.equal(await page.locator("h1:visible").count(), 1);
    assert.equal(await page.locator("main").count(), 1);

    // Link não configurado: nenhum botão (nem quebrado), o aviso no lugar.
    assert.equal(await page.isVisible("#ob-aviso"), true);
    assert.equal((await textoDe(page, "#ob-aviso")).trim(), "O link do grupo chega no seu WhatsApp em instantes.");
    assert.equal(await page.locator(".botao-whats:visible").count(), 0);
    // Por host não envelhece bem (hoje tem o Sendflow): nenhum link para FORA do nosso domínio.
    assert.equal(await page.locator('a[href^="http"]:not([href*="escolaenfermagemdevalor"]), a[href="#"]').count(), 0);

    const visita = await ate(() => reg.pagina.find((e) => e.evento === "visita"));
    assert.equal(reg.pagina.length, 1);
    assert.equal(visita.pagina, pagina.id);
    assert.equal(visita.utm_source, "meta");
    assert.equal(visita.utm_campaign, "campanha-x");
    assert.equal(visita.utm_content, "criativo-y");
    assert.equal(visita.utm_medium, null);
    assert.equal(visita.fbclid, null);
    assert.equal(visita.page_url, `${base}${pagina.rota}${UTM}`, "page_url sem o #");
    assert.equal(visita.dispositivo, "mobile");
    assert.match(visita.visitante_id, /^[0-9a-f-]{36}$/);
    assert.equal(visita.sessao_id, null, "sem rascunho, sem sessão");
    assert.equal(visita.perfil, null);
    for (const campo of ["referrer", "utm_term", "gclid"]) assert.ok(campo in visita, campo);
  });

  caso(
    `${pagina.rota}: com link, só o botão do próprio grupo (duas vezes), nunca o de outro`,
    async (page) => {
      await abrir(page, pagina.rota);
      const hrefs = await page.$$eval("a.botao-whats", (as) => as.map((a) => [a.getAttribute("href"), a.target, a.rel, a.textContent.trim()]));
      assert.deepEqual(hrefs, [
        [LINKS[pagina.grupo], "_blank", "noopener", pagina.cta],
        [LINKS[pagina.grupo], "_blank", "noopener", pagina.cta]
      ]);
      assert.equal(await page.locator(".botao-whats:visible").count(), 2);
      assert.equal(await page.isHidden("#ob-aviso"), true);
      // Nenhum link de outro grupo em lugar nenhum da página montada.
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      for (const [grupo, link] of Object.entries(LINKS)) {
        if (grupo !== pagina.grupo) assert.ok(!html.includes(link), `link de ${grupo} apareceu em ${pagina.rota}`);
      }
      // O ícone do WhatsApp é SVG inline (nada de imagem de fora) e decorativo.
      assert.equal(await page.locator("#ob-cta svg[aria-hidden='true']").count(), 1);
    },
    { links: LINKS }
  );

  for (const [largura, altura] of [
    [360, 640],
    [390, 844]
  ]) {
    caso(
      `${pagina.rota}: botão visível sem rolar em ${largura}x${altura} (com e sem link)`,
      async (page) => {
        await comRascunho(page, rascunho(pagina.perfis[0]));
        await abrir(page, pagina.rota);
        const caixa = await page.locator("#ob-cta").boundingBox();
        assert.ok(caixa.y >= 0 && caixa.y + caixa.height <= altura, `botão em ${JSON.stringify(caixa)} (tela ${altura})`);
        assert.ok(caixa.width >= largura - 2 * 20 - 1, `largura total no celular: ${caixa.width}`);
        assert.ok(caixa.height >= 60, `botão grande: ${caixa.height}`);
        assert.equal(await page.evaluate(() => window.scrollY), 0);
        // Sem link: o aviso ocupa o mesmo lugar e também aparece sem rolar.
        await servirConfig(page, VAZIOS);
        await page.reload();
        await page.waitForSelector("#ob-aviso:not([hidden])");
        const aviso = await page.locator("#ob-aviso").boundingBox();
        assert.ok(aviso.y + aviso.height <= altura, `aviso em ${JSON.stringify(aviso)}`);
      },
      { largura, altura, links: LINKS }
    );
  }
}

/* ------------------------------------------------------------------ clique */

caso(
  "clique abre o grupo na hora e registra clique_grupo (keepalive) + Pixel com o código do perfil",
  async (page, reg, ctx) => {
    await page.addInitScript(() => {
      window.__px = [];
      window.fbq = (...a) => window.__px.push(JSON.parse(JSON.stringify(a)));
    });
    await comRascunho(page, rascunho(P.PERFIL.enfermeiro));
    await abrir(page, "/obrigado-evento-outubro", "?utm_source=whatsapp&utm_campaign=lista");
    assert.equal(await textoDe(page, "#ob-titulo"), "Pesquisa concluída, Maria! Seu próximo passo está aqui. 💜");
    const [grupo] = await Promise.all([ctx.waitForEvent("page"), page.click("#ob-cta")]);
    await grupo.waitForLoadState("domcontentloaded");
    assert.equal(grupo.url(), LINKS.evento_outubro);
    const clique = await ate(() => reg.pagina.find((e) => e.evento === "clique_grupo"));
    const visita = reg.pagina.find((e) => e.evento === "visita");
    assert.equal(clique.pagina, "evento_outubro");
    assert.equal(clique.perfil, P.PERFIL.enfermeiro, "técnico e enfermeiro seguem separados");
    assert.equal(clique.sessao_id, "3f1b2c4d-5e6f-4a1b-8c2d-9e0f1a2b3c4d");
    assert.equal(clique.visitante_id, VISITANTE);
    assert.equal(visita.visitante_id, VISITANTE);
    assert.equal(clique.utm_source, "whatsapp", "a URL atual ganha do rascunho");
    assert.equal(clique.utm_campaign, "lista");
    assert.equal(clique.fbclid, null, "sem misturar campanhas");
    assert.deepEqual(await page.evaluate(() => window.__px), [
      ["trackCustom", "clique_grupo_whatsapp", { grupo: "evento_outubro", perfil: "enfermeiro" }]
    ]);
    // O botão de baixo faz o mesmo.
    const [grupo2] = await Promise.all([ctx.waitForEvent("page"), page.click("#ob-cta-fim")]);
    await grupo2.waitForLoadState("domcontentloaded");
    assert.equal(grupo2.url(), LINKS.evento_outubro);
    await ate(() => reg.pagina.filter((e) => e.evento === "clique_grupo").length === 2);
  },
  { links: LINKS }
);

caso(
  "clique não espera a rede: com a API travada, o grupo abre do mesmo jeito",
  async (page, reg, ctx) => {
    await page.route("**/api/pagina/**", () => {}); // nunca responde
    await abrir(page, "/obrigado-afericao");
    const inicio = Date.now();
    const [grupo] = await Promise.all([ctx.waitForEvent("page"), page.click("#ob-cta")]);
    await grupo.waitForLoadState("domcontentloaded");
    assert.ok(Date.now() - inicio < 3000);
    assert.equal(grupo.url(), LINKS.afericao);
  },
  { links: LINKS }
);

/* ------------------------------------------------------------------ rascunho e rastreio */

caso("sem UTM na URL: vale o rastreio de primeiro toque do rascunho; técnico conta como técnico", async (page, reg) => {
  await comRascunho(page, rascunho(P.PERFIL.tecnico));
  await abrir(page, "/obrigado-evento-outubro");
  const visita = await ate(() => reg.pagina.find((e) => e.evento === "visita"));
  assert.equal(visita.utm_source, "instagram");
  assert.equal(visita.utm_medium, "stories");
  assert.equal(visita.utm_campaign, "icp-set");
  assert.equal(visita.fbclid, "abc123");
  assert.equal(visita.perfil, P.PERFIL.tecnico);
  assert.equal(visita.sessao_id, "3f1b2c4d-5e6f-4a1b-8c2d-9e0f1a2b3c4d");
});

caso("rascunho de outro perfil: a página não se atribui o perfil nem a sessão", async (page, reg) => {
  await comRascunho(page, rascunho(P.PERFIL.cuidador));
  await abrir(page, "/obrigado-afericao");
  const visita = await ate(() => reg.pagina.find((e) => e.evento === "visita"));
  assert.equal(visita.pagina, "afericao");
  assert.equal(visita.perfil, null);
  assert.equal(visita.sessao_id, null);
});

caso("nome estranho no rascunho vira texto, nunca HTML", async (page) => {
  await comRascunho(page, rascunho(P.PERFIL.cuidador, { contato: { nome: "<img src=x onerror=alert(1)> silva" } }));
  await abrir(page, "/obrigado-cuidador");
  assert.equal(await page.locator("#ob-titulo img").count(), 0);
  assert.match(await textoDe(page, "#ob-titulo"), /^Pesquisa concluída, <img!/);
});

caso("sem localStorage (webview bloqueado): monta, headline exata e registra a visita", async (page, reg) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("bloqueado");
      }
    });
  });
  await abrir(page, "/obrigado-cuidador");
  assert.equal(await textoDe(page, "#ob-titulo"), O.PAGINAS.cuidador.headline);
  const visita = await ate(() => reg.pagina.find((e) => e.evento === "visita"));
  assert.match(visita.visitante_id, /^[0-9a-f-]{36}$/);
});

caso("link que não é convite do WhatsApp conta como não configurado", async (page) => {
  await abrir(page, "/obrigado-cuidador");
  assert.equal(await page.isVisible("#ob-aviso"), true);
  assert.equal(await page.locator(".botao-whats:visible").count(), 0);
}, { links: { afericao: "", cuidador: "https://exemplo.com/grupo", evento_outubro: "javascript:alert(1)" } });

// Os enganos que vão acontecer de verdade agora que o link é de um distribuidor: http sem TLS,
// link cortado no meio e sufixo de domínio parecido. Nenhum vira botão.
caso("link do distribuidor torto também conta como não configurado", async (page) => {
  for (const rota of ["/obrigado-afericao", "/obrigado-cuidador", "/obrigado-evento-outubro"]) {
    await abrir(page, rota);
    assert.equal(await page.isVisible("#ob-aviso"), true, rota);
    assert.equal(await page.locator(".botao-whats:visible").count(), 0, rota);
  }
}, {
  links: {
    afericao: "http://sndflw.com/i/hxQV77EZKwpS62QXVLb8",
    cuidador: "https://sndflw.com/i",
    evento_outubro: "https://sndflw.com.site-de-golpe.com/i/abc12345"
  }
});

/* ------------------------------------------------------------------ rota desconhecida, barra final */

caso("rota desconhecida: mensagem simples com link para a pesquisa, sem evento", async (page, reg) => {
  await page.goto(base + "/obrigado-qualquer-coisa");
  await page.waitForSelector("#ob-desconhecida:not([hidden])");
  assert.equal(await page.isHidden("#ob-pagina"), true);
  assert.equal(await page.getAttribute('#ob-desconhecida a[href="/pesquisa-icp"]', "href"), "/pesquisa-icp");
  assert.equal(await page.locator("h1:visible").count(), 1);
  await esperar(300);
  assert.equal(reg.pagina.length, 0);
});

caso("barra no fim da rota também vale", async (page) => {
  await abrir(page, "/obrigado-cuidador/");
  assert.equal(await textoDe(page, "#ob-titulo"), O.PAGINAS.cuidador.headline);
});

/* ------------------------------------------------------------------ acessibilidade e movimento */

caso(
  "teclado: pular para o conteúdo, depois o botão do grupo com foco visível",
  async (page) => {
    await abrir(page, "/obrigado-afericao");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.className), "pular-link");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.id), "ob-cta");
    const sombra = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
    assert.match(sombra, /rgb\(57, 43, 56\)/, "anel de foco na cor da tinta");
  },
  { largura: 1280, altura: 800, mobile: false, links: LINKS }
);

caso(
  "movimento reduzido: o anel pulsante some",
  async (page) => {
    await abrir(page, "/obrigado-cuidador");
    const anel = await page.evaluate(() => getComputedStyle(document.getElementById("ob-cta"), "::after").display);
    assert.equal(anel, "none");
  },
  { reduzir: true, links: LINKS }
);

for (const [largura, altura] of [
  [320, 568],
  [360, 640],
  [390, 844],
  [768, 1024],
  [1280, 800]
]) {
  caso(
    `sem rolagem horizontal em ${largura}px (3 páginas, com e sem link) e alvos de toque >= 44px`,
    async (page) => {
      for (const links of [LINKS, VAZIOS]) {
        await servirConfig(page, links);
        for (const pagina of O.LISTA) {
          await abrir(page, pagina.rota);
          const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
          assert.ok(w[0] <= w[1], `${pagina.rota}: ${w}`);
          const pequenos = await page.evaluate(() =>
            Array.from(document.querySelectorAll("a, button"))
              .filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44)
              .map((e) => e.id || e.className)
          );
          assert.deepEqual(pequenos, []);
        }
      }
    },
    { largura, altura, mobile: largura < 768 }
  );
}
