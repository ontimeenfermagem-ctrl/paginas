/*
 * js/checkout-config.js — o contrato que leva as UTMs e o contato até o checkout da Hotmart.
 *
 * O config é carregado com vm num contexto VAZIO, EXATAMENTE como o server.mjs o carrega: sem
 * `URL`, sem `URLSearchParams`, sem `fetch`, sem `document`. É o ponto do arquivo — a versão
 * anterior usava URLSearchParams e, dentro do vm, devolvia o link SEM parâmetro nenhum, em
 * silêncio. O primeiro teste prova que essas classes de fato não existem ali dentro; todos os
 * outros rodam nesse mesmo contexto.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const contexto = vm.createContext({});
for (const arquivo of ["js/lead-rules.js", "js/checkout-config.js"]) {
  vm.runInContext(readFileSync(new URL(`../${arquivo}`, import.meta.url), "utf8"), contexto, { filename: arquivo });
}
const C = contexto.EVCheckout;
const L = contexto.EVLeadRules;

const BASE = "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&checkoutMode=10";

/** Os parâmetros da URL montada, lidos aqui fora com URL de verdade (o config não usa nenhuma). */
function paramsDe(url) {
  const busca = new URL(url).searchParams;
  return Object.fromEntries(busca);
}

function ordemDe(url) {
  return Array.from(new URL(url).searchParams.keys());
}

const UTMS_CHEIAS = {
  utm_source: "facebook",
  utm_medium: "cpc",
  utm_campaign: "viver-de-furo-set",
  utm_term: "criativo-07",
  utm_content: "anuncio-b"
};

/* ------------------------------------------------------------------ o contexto do servidor */

test("o config roda num contexto sem URL nem URLSearchParams (é assim que o servidor o carrega)", () => {
  assert.equal(contexto.URL, undefined);
  assert.equal(contexto.URLSearchParams, undefined);
  assert.equal(contexto.fetch, undefined);
  assert.equal(contexto.document, undefined);
  assert.ok(C, "EVCheckout foi definido");
  assert.ok(L, "EVLeadRules foi definido (o config depende dele para formatar o contato)");
  // Prova de verdade: montar uma URL LÁ DENTRO devolve parâmetros, e não o link pelado.
  const dentro = vm.runInContext(
    `EVCheckout.montarUrlCheckout(${JSON.stringify(BASE)}, { utm: { utm_source: "facebook" } })`,
    contexto
  );
  assert.ok(dentro.includes("utm_source=facebook"), dentro);
});

test("a lista de páginas é o contrato do servidor e do painel", () => {
  assert.ok(C.LISTA.length >= 1);
  for (const pagina of C.LISTA) {
    assert.match(pagina.rota, /^\/[a-z0-9-]+$/, `rota de ${pagina.id}`);
    assert.match(pagina.checkout, /^https:\/\/pay\.hotmart\.com\//, `checkout de ${pagina.id}`);
    assert.equal(C.paginaDaRota(pagina.rota), pagina);
    assert.equal(C.paginaDaRota(`${pagina.rota}/`), pagina);
    assert.equal(C.paginaPorId(pagina.id), pagina);
  }
  assert.equal(C.paginaDaRota("/nao-existe"), null);
  assert.equal(C.paginaPorId("nao-existe"), null);
  // paginaPorId lê um objeto literal, então uma chave HERDADA ("toString") não devolve null. Por
  // isso quem recebe id de fora (o servidor, no POST /api/inscricao) confere contra a LISTA.
  assert.equal(C.LISTA.includes(C.paginaPorId("toString")), false);
  assert.deepEqual(Array.from(C.UTMS), ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
});

/* ------------------------------------------------------------------ montarUrlCheckout */

test("preserva off e checkoutMode do link do cliente e acrescenta as 5 UTMs", () => {
  const url = C.montarUrlCheckout(BASE, { utm: UTMS_CHEIAS });
  const params = paramsDe(url);

  assert.equal(params.off, "7j2nqptq");
  assert.equal(params.checkoutMode, "10");
  assert.equal(params.utm_source, "facebook");
  assert.equal(params.utm_medium, "cpc");
  assert.equal(params.utm_campaign, "viver-de-furo-set");
  assert.equal(params.utm_term, "criativo-07");
  assert.equal(params.utm_content, "anuncio-b");
  // O que já estava no link vem primeiro; as UTMs entram na ordem do contrato.
  assert.deepEqual(ordemDe(url), ["off", "checkoutMode", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "sck"]);
  assert.ok(url.startsWith("https://pay.hotmart.com/Y74893363S?"));
});

test("o sck é o utm_term (é por ele que o cliente sabe qual criativo vendeu)", () => {
  assert.equal(paramsDe(C.montarUrlCheckout(BASE, { utm: UTMS_CHEIAS })).sck, "criativo-07");

  // Sem utm_term não se inventa sck — nem a partir do utm_content, nem do utm_campaign.
  const semTermo = paramsDe(
    C.montarUrlCheckout(BASE, { utm: { utm_source: "facebook", utm_campaign: "c", utm_content: "anuncio-b" } })
  );
  assert.equal(semTermo.sck, undefined);
  assert.equal(semTermo.utm_content, "anuncio-b");

  // Espaço em volta não conta como termo.
  assert.equal(paramsDe(C.montarUrlCheckout(BASE, { utm: { utm_term: "   " } })).sck, undefined);
});

test("UTM vazia, só com espaços ou que não é texto não entra na URL", () => {
  const url = C.montarUrlCheckout(BASE, {
    utm: { utm_source: "", utm_medium: "   ", utm_campaign: null, utm_content: 42, utm_term: "criativo-07" }
  });
  const params = paramsDe(url);
  assert.deepEqual(Object.keys(params), ["off", "checkoutMode", "utm_term", "sck"]);
  assert.equal(params.utm_term, "criativo-07");
  // Espaços nas pontas de uma UTM de verdade são aparados.
  assert.equal(paramsDe(C.montarUrlCheckout(BASE, { utm: { utm_source: "  facebook  " } })).utm_source, "facebook");
});

test("fbclid e gclid ficam com a gente: não viram parâmetro do checkout", () => {
  const url = C.montarUrlCheckout(BASE, {
    utm: { ...UTMS_CHEIAS, fbclid: "IwAR-teste", gclid: "Cj0KCQ-teste" }
  });
  assert.equal(url.includes("fbclid"), false, url);
  assert.equal(url.includes("gclid"), false, url);
});

test("o contato vai na URL para o checkout abrir preenchido (nome formatado, e-mail minúsculo)", () => {
  const params = paramsDe(
    C.montarUrlCheckout(BASE, {
      contato: { nome: "  maria da silva  ", email: "  MARIA@GMAIL.COM ", whatsapp: "(11) 91234-5678" }
    })
  );
  assert.equal(params.name, "Maria da Silva");
  assert.equal(params.email, "maria@gmail.com");
  assert.equal(params.phoneac, "11");
  assert.equal(params.phonenumber, "912345678");
});

test("o WhatsApp é quebrado em phoneac (DDD) + phonenumber, com +55, com zero e com 10 dígitos", () => {
  const casos = [
    ["+55 (21) 99876-5432", "21", "998765432"],
    ["5521998765432", "21", "998765432"],
    ["021999998888", "21", "999998888"],
    ["(31) 3222-1010", "31", "32221010"], // fixo de 10 dígitos: ainda assim vai separado
    ["11912345678", "11", "912345678"]
  ];
  for (const [entrada, ac, numero] of casos) {
    const params = paramsDe(C.montarUrlCheckout(BASE, { contato: { whatsapp: entrada } }));
    assert.equal(params.phoneac, ac, entrada);
    assert.equal(params.phonenumber, numero, entrada);
  }

  // Menos de 10 dígitos não é telefone: nada vai, em vez de mandar um DDD solto.
  for (const curto of ["119123", "", "   ", null, undefined]) {
    const params = paramsDe(C.montarUrlCheckout(BASE, { contato: { whatsapp: curto } }));
    assert.equal(params.phoneac, undefined, String(curto));
    assert.equal(params.phonenumber, undefined, String(curto));
  }
});

test("contato vazio não cria parâmetro vazio", () => {
  assert.equal(C.montarUrlCheckout(BASE, { contato: { nome: "  ", email: "", whatsapp: "" } }), BASE);
  assert.equal(C.montarUrlCheckout(BASE, {}), BASE);
  assert.equal(C.montarUrlCheckout(BASE), BASE);
  assert.equal(C.montarUrlCheckout(BASE, { utm: null, contato: null }), BASE);
});

test("parâmetro repetido é sobrescrito, nunca duplicado", () => {
  const comUtmVelha = "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&utm_source=antigo&sck=antigo&name=Fulano";
  const url = C.montarUrlCheckout(comUtmVelha, {
    utm: { utm_source: "facebook", utm_term: "criativo-07" },
    contato: { nome: "maria da silva" }
  });
  const busca = new URL(url).searchParams;
  assert.deepEqual(busca.getAll("utm_source"), ["facebook"]);
  assert.deepEqual(busca.getAll("sck"), ["criativo-07"]);
  assert.deepEqual(busca.getAll("name"), ["Maria da Silva"]);
  assert.deepEqual(ordemDe(url), ["off", "utm_source", "sck", "name", "utm_term"], "cada chave aparece uma vez, no lugar em que já estava");
});

test("acento, espaço e & do contato são codificados (o link não quebra)", () => {
  const url = C.montarUrlCheckout(BASE, {
    utm: { utm_campaign: "promoção & desconto", utm_term: "criativo 07" },
    contato: { nome: "joão d'ávila souza", email: "joao+teste@gmail.com" }
  });
  assert.ok(!url.includes(" "), url);
  const params = paramsDe(url);
  assert.equal(params.utm_campaign, "promoção & desconto");
  assert.equal(params.utm_term, "criativo 07");
  assert.equal(params.sck, "criativo 07");
  assert.equal(params.name, "João D'Ávila Souza");
  assert.equal(params.email, "joao+teste@gmail.com");
});

test("o hash do link é preservado, e os parâmetros entram ANTES dele", () => {
  const url = C.montarUrlCheckout(`${BASE}#formulario`, { utm: { utm_source: "facebook", utm_term: "t" } });
  assert.ok(url.endsWith("#formulario"), url);
  assert.equal(paramsDe(url).utm_source, "facebook");
  assert.equal(paramsDe(url).sck, "t");
  assert.equal(url.indexOf("utm_source") < url.indexOf("#"), true);
});

test("link torto volta igual: travar o clique é pior do que perder a UTM", () => {
  for (const torto of ["", "   ", "pay.hotmart.com/X", "/relativo?a=1", "javascript:alert(1)", "ftp://x/y", null, undefined, 42]) {
    const saida = C.montarUrlCheckout(torto, { utm: UTMS_CHEIAS, contato: { nome: "maria silva" } });
    assert.equal(saida, torto == null ? "" : String(torto), String(torto));
  }
});

test("link sem query nenhuma ganha a query inteira", () => {
  const url = C.montarUrlCheckout("https://pay.hotmart.com/Y74893363S", { utm: { utm_source: "ig" } });
  assert.equal(url, "https://pay.hotmart.com/Y74893363S?utm_source=ig");
});

/* ------------------------------------------------------------------ rastreioDaUrl */

test("rastreioDaUrl guarda só as 5 UTMs, o fbclid e o gclid", () => {
  // Spread: o objeto nasce DENTRO do vm, e o deepStrictEqual tropeçaria no protótipo de lá.
  const rastreio = {
    ...C.rastreioDaUrl(
      "?utm_source=facebook&utm_medium=cpc&utm_campaign=set&utm_term=criativo-07&utm_content=b&fbclid=abc&gclid=def&outro=x&utm_source_extra=y"
    )
  };
  assert.deepEqual(rastreio, {
    utm_source: "facebook",
    utm_medium: "cpc",
    utm_campaign: "set",
    utm_term: "criativo-07",
    utm_content: "b",
    fbclid: "abc",
    gclid: "def"
  });

  assert.deepEqual({ ...C.rastreioDaUrl("utm_source=ig") }, { utm_source: "ig" }, "com ou sem a interrogação");
  assert.deepEqual({ ...C.rastreioDaUrl("") }, {});
  assert.deepEqual({ ...C.rastreioDaUrl(null) }, {});
  assert.deepEqual({ ...C.rastreioDaUrl("?utm_source=&utm_term=%20") }, {}, "vazio não vira rastreio");
  assert.deepEqual({ ...C.rastreioDaUrl("?utm_source=meta%20ads") }, { utm_source: "meta ads" }, "valor codificado volta decodificado");
  assert.equal(C.rastreioDaUrl(`?utm_term=${"x".repeat(900)}`).utm_term.length, 500, "valor gigante é cortado em 500");
});

test("o que rastreioDaUrl guarda é o que montarUrlCheckout leva ao checkout", () => {
  const rastreio = C.rastreioDaUrl("?utm_source=facebook&utm_term=criativo-07&fbclid=abc");
  const params = paramsDe(C.montarUrlCheckout(BASE, { utm: rastreio }));
  assert.equal(params.utm_source, "facebook");
  assert.equal(params.utm_term, "criativo-07");
  assert.equal(params.sck, "criativo-07");
  assert.equal(params.fbclid, undefined);
});
