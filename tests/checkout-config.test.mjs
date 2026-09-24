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
import { existsSync, readFileSync } from "node:fs";
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
  assert.ok(C.LISTA.length >= 2);
  for (const pagina of C.LISTA) {
    // "_" entra: a rota da venda da Imersão GPS (/igps_set_lp_26-ingresso) é o endereço que já está
    // no ar no outro site e nos anúncios; não dá para trocar por hífen.
    assert.match(pagina.rota, /^\/[a-z0-9_-]+$/, `rota de ${pagina.id}`);
    assert.match(pagina.checkout, /^https:\/\/pay\.hotmart\.com\//, `checkout de ${pagina.id}`);
    assert.equal(C.paginaDaRota(pagina.rota), pagina);
    assert.equal(C.paginaDaRota(`${pagina.rota}/`), pagina);
    assert.equal(C.paginaPorId(pagina.id), pagina);
  }
  assert.equal(C.paginaDaRota("/nao-existe"), null);
  assert.equal(C.paginaPorId("nao-existe"), null);
  // paginaPorId confere a chave com hasOwnProperty: uma chave HERDADA do Object não vira página.
  for (const herdada of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    assert.equal(C.paginaPorId(herdada), null, herdada);
  }
  for (const vazio of ["", null, undefined, 0]) assert.equal(C.paginaPorId(vazio), null, String(vazio));
  assert.deepEqual(Array.from(C.UTMS), ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
  assert.equal(C.SCK_PADRAO, "utm_term");
});

test("cada página diz de qual UTM sai o sck, qual régua de e-mail usa e como a venda é reconhecida", () => {
  // Array.from: o array nasce aqui fora, e o deepStrictEqual não tropeça no protótipo do vm.
  const ids = Array.from(C.LISTA, (pagina) => pagina.id);
  const rotas = Array.from(C.LISTA, (pagina) => pagina.rota);
  assert.equal(new Set(ids).size, ids.length, "ids repetidos");
  assert.equal(new Set(rotas).size, rotas.length, "rotas repetidas");
  assert.deepEqual(Object.keys(C.PAGINAS), ids, "a chave de PAGINAS é o id da página");

  for (const pagina of C.LISTA) {
    assert.ok(C.UTMS.includes(pagina.sck), `sck de ${pagina.id}`);
    assert.equal(typeof pagina.emailSomenteComBr, "boolean", `emailSomenteComBr de ${pagina.id}`);
    assert.ok(Array.isArray(pagina.hotmart.ofertas) && Array.isArray(pagina.hotmart.produtos), `hotmart de ${pagina.id}`);
    // A oferta do link do config é reconhecida no aviso de venda: sem isso a venda chegaria sem página.
    assert.ok(pagina.hotmart.ofertas.includes(C.ofertaDoLink(pagina.checkout)), `oferta do checkout de ${pagina.id}`);
    assert.equal(C.paginaDaVenda({ oferta: C.ofertaDoLink(pagina.checkout) }), pagina, `venda da oferta de ${pagina.id}`);
    // Os campos antigos (um só código de oferta/produto) saíram: quem ler deles leria undefined.
    assert.equal(pagina.oferta, undefined, `oferta solta em ${pagina.id}`);
    assert.equal(pagina.hotmart_produto, undefined, `hotmart_produto em ${pagina.id}`);
    // `origem` só existe em página de outro site, e já no formato do cabeçalho Origin.
    if (pagina.origem !== undefined) assert.match(pagina.origem, /^https:\/\/[a-z0-9.-]+$/, `origem de ${pagina.id}`);
    assert.ok(Object.isFrozen(pagina) && Object.isFrozen(pagina.hotmart) && Object.isFrozen(pagina.hotmart.ofertas), `${pagina.id} congelada`);
  }
  // Uma oferta não pode ser de duas páginas: o aviso de venda iria para a primeira, em silêncio.
  const ofertas = C.LISTA.flatMap((pagina) => Array.from(pagina.hotmart.ofertas));
  assert.equal(new Set(ofertas).size, ofertas.length, "oferta em duas páginas");
  const produtos = C.LISTA.flatMap((pagina) => Array.from(pagina.hotmart.produtos));
  assert.equal(new Set(produtos).size, produtos.length, "produto em duas páginas");
});

test("imersao-gps: mora no outro site, sck = utm_content, e-mail só .com/.com.br, oferta l0r77by6", () => {
  const gps = C.paginaPorId("imersao-gps");
  assert.ok(gps);
  assert.equal(gps.rota, "/igps_set_lp_26-ingresso");
  assert.equal(C.paginaDaRota("/igps_set_lp_26-ingresso"), gps);
  assert.equal(gps.origem, "https://io.escolaenfermagemdevalor.com.br");
  assert.equal(gps.checkout, "https://pay.hotmart.com/R107667362D?off=l0r77by6&checkoutMode=10");
  assert.equal(gps.sck, "utm_content");
  assert.equal(C.sckDaPagina(gps), "utm_content");
  assert.equal(gps.emailSomenteComBr, true);
  assert.deepEqual(Array.from(gps.hotmart.ofertas), ["l0r77by6"]);
  assert.deepEqual(Array.from(gps.hotmart.produtos), []);
  assert.equal(typeof gps.nome, "string");
  assert.equal(typeof gps.produto, "string");
});

test("viver-de-furo: continua no utm_term, aceita qualquer domínio e reconhece o produto 2332962", () => {
  const viver = C.paginaPorId("viver-de-furo");
  assert.ok(viver);
  assert.equal(viver.rota, "/viver-de-furo-inscricao");
  assert.equal(viver.origem, undefined, "mora aqui: o servidor serve o arquivo dela");
  assert.equal(viver.sck, "utm_term");
  assert.equal(C.sckDaPagina(viver), "utm_term");
  assert.equal(viver.emailSomenteComBr, false);
  assert.deepEqual(Array.from(viver.hotmart.ofertas), ["7j2nqptq"]);
  assert.deepEqual(Array.from(viver.hotmart.produtos), ["2332962"]);
});

test("ORIGENS: só as páginas de outro site, sem repetição, congelada", () => {
  assert.deepEqual(Array.from(C.ORIGENS), ["https://io.escolaenfermagemdevalor.com.br"]);
  assert.ok(Object.isFrozen(C.ORIGENS));
  assert.deepEqual(
    Array.from(C.ORIGENS),
    Array.from(new Set(C.LISTA.filter((pagina) => pagina.origem).map((pagina) => pagina.origem)))
  );
});

test("sckDaPagina: a UTM da página; sem página, sem sck ou com valor estranho, o padrão utm_term", () => {
  assert.equal(C.sckDaPagina({ sck: "utm_content" }), "utm_content");
  assert.equal(C.sckDaPagina({ sck: "utm_source" }), "utm_source", "qualquer uma das 5 UTMs vale");
  for (const estranha of [null, undefined, {}, { sck: "" }, { sck: "fbclid" }, { sck: "gclid" }, { sck: "UTM_CONTENT" }, { sck: " utm_content" }, { sck: 42 }, { sck: ["utm_content"] }, { sck: "toString" }, "utm_content"]) {
    assert.equal(C.sckDaPagina(estranha), "utm_term", JSON.stringify(estranha));
  }
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

test("sem `sck` nas opções, o sck é o utm_term (o comportamento de antes, o da Viver de Furo)", () => {
  assert.equal(paramsDe(C.montarUrlCheckout(BASE, { utm: UTMS_CHEIAS })).sck, "criativo-07");

  // Sem utm_term não se inventa sck — nem a partir do utm_content, nem do utm_campaign.
  const semTermo = paramsDe(
    C.montarUrlCheckout(BASE, { utm: { utm_source: "facebook", utm_campaign: "c", utm_content: "anuncio-b" } })
  );
  assert.equal(semTermo.sck, undefined);
  assert.equal(semTermo.utm_content, "anuncio-b");

  // Espaço em volta não conta como termo.
  assert.equal(paramsDe(C.montarUrlCheckout(BASE, { utm: { utm_term: "   " } })).sck, undefined);

  // sck: "utm_term" explícito, vazio ou estranho dá o mesmo que não passar nada.
  const semSck = C.montarUrlCheckout(BASE, { utm: UTMS_CHEIAS });
  for (const sck of ["utm_term", undefined, null, "", "fbclid", "sck", 42]) {
    assert.equal(C.montarUrlCheckout(BASE, { utm: UTMS_CHEIAS, sck }), semSck, String(sck));
  }
});

test('sck: "utm_content" (Imersão GPS): o utm_content vira o sck e o utm_term segue só como UTM', () => {
  const url = C.montarUrlCheckout(BASE, { utm: UTMS_CHEIAS, sck: "utm_content" });
  const params = paramsDe(url);
  assert.equal(params.sck, "anuncio-b");
  assert.equal(params.utm_content, "anuncio-b");
  assert.equal(params.utm_term, "criativo-07", "as 5 UTMs continuam indo iguais");
  assert.deepEqual(ordemDe(url), ["off", "checkoutMode", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "sck"]);

  // Sem utm_content não há sck — nem caindo para o utm_term.
  const semConteudo = paramsDe(C.montarUrlCheckout(BASE, { utm: { utm_term: "criativo-07" }, sck: "utm_content" }));
  assert.equal(semConteudo.sck, undefined);
  assert.equal(semConteudo.utm_term, "criativo-07");
  assert.equal(paramsDe(C.montarUrlCheckout(BASE, { utm: { utm_content: "  " }, sck: "utm_content" })).sck, undefined);
  // Aparado, como as UTMs.
  assert.equal(paramsDe(C.montarUrlCheckout(BASE, { utm: { utm_content: "  anuncio-b " }, sck: "utm_content" })).sck, "anuncio-b");
  // Um sck que já estava no link é trocado, não duplicado.
  const busca = new URL(C.montarUrlCheckout(`${BASE}&sck=velho`, { utm: UTMS_CHEIAS, sck: "utm_content" })).searchParams;
  assert.deepEqual(busca.getAll("sck"), ["anuncio-b"]);
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

/* ------------------------------------------------------------------ "%" solto */

test('"%" solto numa URL colada à mão não lança (nem no link, nem na busca, nem no botão)', () => {
  // decodeURIComponent("%E0") lança URIError; o config guarda o texto cru e segue.
  const torta = "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&x=%E0&y=100%";
  let url;
  assert.doesNotThrow(() => {
    url = C.montarUrlCheckout(torta, { utm: { utm_source: "facebook", utm_term: "t" } });
  });
  assert.ok(url.startsWith("https://pay.hotmart.com/Y74893363S?off=7j2nqptq&"), url);
  assert.equal(paramsDe(url).utm_source, "facebook");
  assert.equal(paramsDe(url).sck, "t");

  assert.deepEqual({ ...C.rastreioDaUrl("?utm_source=%E0&utm_term=criativo-07&utm_campaign=50%") }, {
    utm_source: "%E0",
    utm_term: "criativo-07",
    utm_campaign: "50%"
  });
  assert.equal(C.ofertaDoLink("https://pay.hotmart.com/R107667362D?off=%E0"), "");
  const gps = C.PAGINAS["imersao-gps"];
  assert.equal(C.baseDoCheckout(gps, "https://pay.hotmart.com/R107667362D?off=lote2&z=%"), "https://pay.hotmart.com/R107667362D?off=lote2&checkoutMode=10");
  assert.doesNotThrow(() => C.urlDoCheckout(gps, { base: "https://pay.hotmart.com/R107667362D?off=%E0%", utm: { utm_content: "%" } }));
});

/* ------------------------------------------------------------------ ofertaDoLink */

test("ofertaDoLink: o off= do link, só com letras, dígitos, _ e - (até 40)", () => {
  assert.equal(C.ofertaDoLink(BASE), "7j2nqptq");
  assert.equal(C.ofertaDoLink("https://pay.hotmart.com/R107667362D?checkoutMode=10&off=l0r77by6"), "l0r77by6", "em qualquer posição");
  assert.equal(C.ofertaDoLink("https://pay.hotmart.com/R107667362D?off=lote_2-B#x"), "lote_2-B");
  assert.equal(C.ofertaDoLink("https://pay.hotmart.com/X?off=%20abc%20"), "abc", "aparado");
  assert.equal(C.ofertaDoLink("https://pay.hotmart.com/X?off=primeira&off=segunda"), "primeira", "vale o primeiro");
  assert.equal(C.ofertaDoLink(`https://pay.hotmart.com/X?off=${"a".repeat(40)}`), "a".repeat(40));

  for (const sem of [
    "https://pay.hotmart.com/X",
    "https://pay.hotmart.com/X?checkoutMode=10",
    "https://pay.hotmart.com/X?off=",
    "https://pay.hotmart.com/X?off",
    "https://pay.hotmart.com/X?offer=abc",
    "https://pay.hotmart.com/X?off=abc%20def",
    "https://pay.hotmart.com/X?off=%3Cscript%3E",
    "https://pay.hotmart.com/X?off=a%2Fb",
    "https://pay.hotmart.com/X?off=a.b",
    `https://pay.hotmart.com/X?off=${"a".repeat(41)}`,
    "",
    null,
    undefined,
    42
  ]) {
    assert.equal(C.ofertaDoLink(sem), "", String(sem));
  }
});

/* ------------------------------------------------------------------ baseDoCheckout */

test("baseDoCheckout: o link do botão do MESMO produto troca só off e checkoutMode", () => {
  const gps = C.PAGINAS["imersao-gps"];
  // Lote novo: outra oferta do mesmo produto.
  assert.equal(C.baseDoCheckout(gps, "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10"), "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10");
  assert.equal(C.baseDoCheckout(gps, "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=6"), "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=6");
  // Sem checkoutMode (ou com um que não é número curto), fica o do config.
  for (const modo of ["", "&checkoutMode=", "&checkoutMode=abc", "&checkoutMode=1234", "&checkoutMode=-1"]) {
    assert.equal(C.baseDoCheckout(gps, `https://pay.hotmart.com/R107667362D?off=lote2abc${modo}`), "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10", modo);
  }
  // Nada além disso passa do botão para o checkout: nem UTM, nem sck, nem contato, nem hash.
  assert.equal(
    C.baseDoCheckout(gps, " https://pay.hotmart.com/R107667362D?utm_source=outro&sck=forjado&name=X&off=lote2abc#topo "),
    "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10"
  );
  // O mesmo link do config volta igual.
  assert.equal(C.baseDoCheckout(gps, gps.checkout), gps.checkout);
  // Maiúsculas diferentes no caminho: é o mesmo produto, e o caminho que sai é o do config.
  assert.equal(C.baseDoCheckout(gps, "https://PAY.HOTMART.COM/r107667362d?off=lote2abc"), "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10");
});

test("baseDoCheckout: outro produto, outro host, sem off, off estranho ou texto enorme → o link do config", () => {
  const gps = C.PAGINAS["imersao-gps"];
  const viver = C.PAGINAS["viver-de-furo"];
  for (const pedido of [
    "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&checkoutMode=10", // o produto da outra página
    "https://pay.hotmart.com/OUTRO123X?off=lote2abc",
    "https://pay.hotmart.com/R107667362D/?off=lote2abc", // caminho diferente (barra no fim)
    "https://pay.hotmart.com/R107667362D/extra?off=lote2abc",
    "http://pay.hotmart.com/R107667362D?off=lote2abc", // sem https
    "https://pay.hotmart.com.evil.com/R107667362D?off=lote2abc",
    "https://evil.com/R107667362D?off=lote2abc",
    "https://evil.com/?u=https://pay.hotmart.com/R107667362D&off=lote2abc",
    "https://pay.hotmart.com/R107667362D", // sem off
    "https://pay.hotmart.com/R107667362D?checkoutMode=6",
    "https://pay.hotmart.com/R107667362D?off=",
    "https://pay.hotmart.com/R107667362D?off=lote%202",
    "https://pay.hotmart.com/R107667362D?off=%22%3E%3Cscript%3E",
    `https://pay.hotmart.com/R107667362D?off=${"a".repeat(41)}`,
    `https://pay.hotmart.com/R107667362D?off=lote2abc&x=${"a".repeat(2048)}`, // mais de 2048 caracteres
    "",
    "   ",
    "javascript:alert(1)",
    null,
    undefined,
    42,
    { off: "lote2abc" }
  ]) {
    assert.equal(C.baseDoCheckout(gps, pedido), gps.checkout, String(pedido).slice(0, 80));
  }
  // E o link do GPS não serve de base para a Viver de Furo.
  assert.equal(C.baseDoCheckout(viver, "https://pay.hotmart.com/R107667362D?off=l0r77by6"), viver.checkout);
  // Exatamente 2048 ainda vale.
  const noLimite = `https://pay.hotmart.com/R107667362D?off=lote2abc&x=`;
  assert.equal(C.baseDoCheckout(gps, noLimite + "a".repeat(2048 - noLimite.length)), "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10");
  // Sem página (ou página sem checkout), não há de onde partir.
  assert.equal(C.baseDoCheckout(null, gps.checkout), "");
  assert.equal(C.baseDoCheckout({}, gps.checkout), "");
});

/* ------------------------------------------------------------------ urlDoCheckout */

test("urlDoCheckout: base do botão (validada) + UTMs + contato + o sck da página", () => {
  const gps = C.PAGINAS["imersao-gps"];
  const viver = C.PAGINAS["viver-de-furo"];
  const contato = { nome: "maria da silva", email: "Maria@Gmail.com", whatsapp: "(11) 91234-5678" };

  const url = C.urlDoCheckout(gps, { utm: UTMS_CHEIAS, contato });
  assert.equal(url, C.montarUrlCheckout(gps.checkout, { utm: UTMS_CHEIAS, contato, sck: "utm_content" }));
  const params = paramsDe(url);
  assert.ok(url.startsWith("https://pay.hotmart.com/R107667362D?off=l0r77by6&checkoutMode=10&"), url);
  assert.equal(params.sck, "anuncio-b", "no GPS o sck é o utm_content");
  assert.equal(params.utm_term, "criativo-07");
  assert.equal(params.name, "Maria da Silva");
  assert.equal(params.email, "maria@gmail.com");
  assert.equal(params.phoneac, "11");
  assert.equal(params.phonenumber, "912345678");

  // Na Viver de Furo, o mesmo rastreio vira sck = utm_term.
  const daViver = paramsDe(C.urlDoCheckout(viver, { utm: UTMS_CHEIAS, contato }));
  assert.equal(daViver.sck, "criativo-07");
  assert.equal(daViver.off, "7j2nqptq");

  // Botão de lote novo: só a oferta muda.
  const lote = paramsDe(C.urlDoCheckout(gps, { base: "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10", utm: UTMS_CHEIAS }));
  assert.equal(lote.off, "lote2abc");
  assert.equal(lote.sck, "anuncio-b");
  // Botão de outro produto: ignorado.
  assert.equal(paramsDe(C.urlDoCheckout(gps, { base: viver.checkout, utm: UTMS_CHEIAS })).off, "l0r77by6");

  // Sem opções, o link do config puro; sem página, nada.
  assert.equal(C.urlDoCheckout(gps), gps.checkout);
  assert.equal(C.urlDoCheckout(gps, {}), gps.checkout);
  assert.equal(C.urlDoCheckout(null, { utm: UTMS_CHEIAS }), "");
});

test("o que rastreioDaUrl guarda na venda do GPS chega ao checkout com o utm_content no sck", () => {
  const rastreio = C.rastreioDaUrl("?utm_source=facebook&utm_medium=cpc&utm_campaign=gps&utm_term=publico-1&utm_content=criativo-gps-03&fbclid=abc");
  const params = paramsDe(C.urlDoCheckout(C.PAGINAS["imersao-gps"], { utm: rastreio }));
  assert.equal(params.sck, "criativo-gps-03");
  assert.equal(params.utm_term, "publico-1");
  assert.equal(params.fbclid, undefined);
  // E dentro do vm (onde o servidor roda) dá o mesmo.
  const dentro = vm.runInContext(
    `EVCheckout.urlDoCheckout(EVCheckout.PAGINAS["imersao-gps"], { utm: EVCheckout.rastreioDaUrl(${JSON.stringify("?utm_content=criativo-gps-03")}) })`,
    contexto
  );
  assert.equal(paramsDe(dentro).sck, "criativo-gps-03");
});

/* ------------------------------------------------------------------ paginaDaVenda */

test("paginaDaVenda: pela oferta, senão pelo id (ou ucode) do produto; desconhecido → null", () => {
  const gps = C.PAGINAS["imersao-gps"];
  const viver = C.PAGINAS["viver-de-furo"];

  assert.equal(C.paginaDaVenda({ oferta: "l0r77by6" }), gps);
  assert.equal(C.paginaDaVenda({ oferta: "7j2nqptq" }), viver);
  assert.equal(C.paginaDaVenda({ oferta: "  l0r77by6 " }), gps, "aparada");
  // O id do produto vem numérico no aviso real (data.product.id): texto ou número, tanto faz.
  assert.equal(C.paginaDaVenda({ produto_id: "2332962" }), viver);
  assert.equal(C.paginaDaVenda({ produto_id: 2332962 }), viver);
  assert.equal(C.paginaDaVenda({ produto_id: null, produto_ucode: "2332962" }), viver, "o ucode é conferido contra a mesma lista");
  // Oferta desconhecida (lote novo que o config ainda não tem) com produto conhecido: vale o produto.
  assert.equal(C.paginaDaVenda({ oferta: "lote-novo", produto_id: "2332962" }), viver);
  // Oferta de uma página e produto de outra: vale a oferta.
  assert.equal(C.paginaDaVenda({ oferta: "l0r77by6", produto_id: "2332962" }), gps);
  assert.equal(C.paginaDaVenda({ oferta: "7j2nqptq", produto_id: "999", produto_ucode: "x" }), viver);

  // Produto que não é de página nenhuma: a Formação, um order bump, o produto 0 dos testes da Hotmart.
  for (const venda of [
    { oferta: "outra-oferta", produto_id: "8519248" },
    { produto_id: "0" },
    { produto_id: 0 },
    { oferta: "", produto_id: "", produto_ucode: "" },
    { oferta: 42 },
    { oferta: "L0R77BY6X" },
    {},
    null,
    undefined
  ]) {
    assert.equal(C.paginaDaVenda(venda), null, JSON.stringify(venda));
  }
});

/*
 * A página de venda da Imersão GPS (repo whatsapp-atendimento-centralizado) leva CÓPIAS de
 * js/lead-rules.js e js/checkout-config.js, com 3 linhas de cabeçalho a mais. Cópia que ficou para
 * trás valida o formulário com uma régua e grava com outra. Sem o outro repo ao lado (CI, outra
 * máquina), o teste é pulado; PAGINA_GPS_JS aponta para outra pasta.
 */
const PASTA_DA_COPIA = process.env.PAGINA_GPS_JS
  ? new URL(`file://${process.env.PAGINA_GPS_JS.replace(/\/?$/, "/")}`)
  : new URL("../../whatsapp-atendimento-centralizado/public/igps_set_lp_26-ingresso/js/", import.meta.url);

for (const arquivo of ["lead-rules.js", "checkout-config.js"]) {
  const copia = new URL(arquivo, PASTA_DA_COPIA);
  test(`a cópia de js/${arquivo} na página de venda do GPS é igual ao original (menos o cabeçalho)`, { skip: !existsSync(copia) && "repo da página de venda não está ao lado" }, () => {
    const linhas = readFileSync(copia, "utf8").split("\n");
    assert.ok(linhas[0].startsWith(`/* CÓPIA de paginas/js/${arquivo} `), `a 1ª linha diz de onde veio: ${linhas[0]}`);
    assert.ok(linhas[2].trimEnd().endsWith("*/"), "o cabeçalho tem 3 linhas");
    const original = readFileSync(new URL(`../js/${arquivo}`, import.meta.url), "utf8");
    assert.equal(linhas.slice(3).join("\n"), original, `copie js/${arquivo} de novo para ${PASTA_DA_COPIA.pathname}`);
  });
}
