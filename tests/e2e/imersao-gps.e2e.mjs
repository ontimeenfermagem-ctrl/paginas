// A Imersão GPS de ponta a ponta no servidor e no banco, sem nada falso no caminho dos dados:
//
//   página de venda (OUTRO site: io.escolaenfermagemdevalor.com.br) → POST /api/inscricao (CORS)
//   Hotmart → POST /api/hotmart/venda?chave=…   (o aviso no formato REAL do Webhook 2.0.0)
//   equipe  → GET /api/painel/inscricoes?pagina=imersao-gps   (com login)
//
//   server.mjs de verdade → PostgREST → Postgres 17 (tests/e2e/stack.mjs, via Docker)
//
// A mesma pessoa se inscreve também na Viver de Furo, e no fim da imersão compra um produto que
// página nenhuma conhece (a Formação): nenhuma das duas coisas pode marcar o ingresso errado, e o
// painel do GPS mostra de qual criativo (sck = utm_content) veio cada ingresso vendido.
//
//   node --test tests/e2e/imersao-gps.e2e.mjs      (precisa de Docker; não usa o Playwright)
//
// Os passos dependem uns dos outros, na ordem (a, b, c...), como no fluxo.e2e.mjs. O DNS do e-mail
// é o único dublê (todo domínio "existe"). Nenhum dado sai da máquina.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { createServerApp } from "../../server.mjs";
import { startStack } from "./stack.mjs";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ------------------------------------------------------------------ os contratos de verdade */

// Os mesmos arquivos que o servidor e as páginas carregam: rota, origem, link, oferta e a UTM do
// sck saem daqui, e não de uma cópia no teste.
const contexto = {};
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "lead-rules.js"), "utf8"), contexto);
vm.runInNewContext(readFileSync(path.join(RAIZ, "js", "checkout-config.js"), "utf8"), contexto);
const C = contexto.EVCheckout;
const L = contexto.EVLeadRules;
const GPS = C.PAGINAS["imersao-gps"];
const VIVER = C.PAGINAS["viver-de-furo"];
const ORIGEM = GPS.origem;

const CHAVE = "chave-do-webhook-de-teste";
const PAINEL_EMAIL = "equipe@escola-teste.com.br";
const PAINEL_SENHA = "senha-de-teste-do-painel";

/** Maria como ela digita (espaços, maiúsculas) e como tem que chegar no banco. */
const MARIA_DIGITADA = { nome: "  maria   da silva ", whatsapp: "(11) 91234-5678", email: " Maria@Gmail.com " };
const MARIA = { nome: "Maria da Silva", whatsapp: "(11) 91234-5678", digits: "11912345678", email: "maria@gmail.com" };

const RASTREIO_GPS = Object.freeze({
  page_url: `${ORIGEM}${GPS.rota}?utm_source=facebook&utm_content=criativo-gps-07`,
  referrer: "https://www.instagram.com/",
  dispositivo: "mobile",
  utm_source: "facebook",
  utm_medium: "cpc",
  utm_campaign: "igps-set-26",
  utm_term: "publico-quente",
  utm_content: "criativo-gps-07",
  fbclid: "IwAR-gps-1",
  gclid: null
});

const RASTREIO_VIVER = Object.freeze({
  page_url: "https://lp.escolaenfermagemdevalor.com.br/viver-de-furo-inscricao?utm_source=instagram",
  referrer: null,
  dispositivo: "mobile",
  utm_source: "instagram",
  utm_medium: "stories",
  utm_campaign: "furo-set",
  utm_term: "criativo-furo-02",
  utm_content: "video-furo",
  fbclid: null,
  gclid: null
});

// O ingresso: o id NUMÉRICO do produto é o que a Hotmart manda em data.product.id. O config do GPS
// ainda não tem o id (produtos: []), então é a oferta do link que reconhece a venda.
const PRODUTO_GPS = { id: 6123456, ucode: "7b0f3c2e-gps0-4000-8000-000000000001", nome: GPS.produto };
// A Formação vendida no fim da imersão: produto e oferta que página nenhuma conhece.
const PRODUTO_FORMACAO = { id: 9999999, ucode: "7b0f3c2e-form-4000-8000-000000000002", nome: "Formação Enfermagem de Valor" };

const HORA_INGRESSO = Date.parse("2026-10-07T20:00:00-03:00");
const HORA_FORMACAO = Date.parse("2026-10-07T22:30:00-03:00");

/* ------------------------------------------------------------------ ciclo de vida */

let stack;
let server;
let base;
const ids = {};

function hashDaSenha(senha) {
  // O mesmo formato do scripts/gerar-senha-painel.mjs: scrypt$N$r$p$sal$hash.
  const sal = randomBytes(16);
  const hash = scryptSync(senha, sal, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 16384, 8, 1, sal.toString("hex"), hash.toString("hex")].join("$");
}

before(async () => {
  stack = await startStack();
  server = createServerApp({
    supabaseUrl: stack.supabaseUrl,
    supabaseKey: stack.serviceKey,
    painelEmail: PAINEL_EMAIL,
    painelSenhaHash: hashDaSenha(PAINEL_SENHA),
    painelSessaoSegredo: randomBytes(32).toString("hex"),
    hotmartChave: CHAVE,
    metaPixelId: "off",
    resolveEmailDomain: async () => "ok"
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (stack) await stack.stop();
});

/* ------------------------------------------------------------------ ajudantes */

async function pedir(metodo, caminho, { corpo, headers = {} } = {}) {
  const resposta = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : typeof corpo === "string" ? corpo : JSON.stringify(corpo)
  });
  const texto = await resposta.text();
  let json = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    json = texto;
  }
  return { status: resposta.status, headers: resposta.headers, json };
}

/** Uma tabela lida pelo PostgREST com a service_role (os tipos chegam como JSON: número é número). */
async function linhas(caminho) {
  const resposta = await fetch(`${stack.supabaseUrl}/rest/v1/${caminho}`, {
    headers: { apikey: stack.serviceKey, Authorization: `Bearer ${stack.serviceKey}` }
  });
  assert.equal(resposta.status, 200, caminho);
  return resposta.json();
}

/** O corpo que a página de venda do GPS manda (o mesmo contrato do /viver-de-furo-inscricao). */
function corpoGps(extra = {}) {
  return {
    id: randomUUID(),
    pagina: GPS.id,
    visitante_id: randomUUID(),
    contato: MARIA_DIGITADA,
    rastreio: RASTREIO_GPS,
    // O link do botão que a pessoa tocou (troca de lote sem mexer no servidor).
    checkout: GPS.checkout,
    ...extra
  };
}

/** Do outro site, como texto: o "simple request" (sem preflight) que a página e o sendBeacon usam. */
function doOutroSite(corpo, origem = ORIGEM) {
  return pedir("POST", "/api/inscricao", {
    corpo,
    headers: { Origin: origem, "Content-Type": "text/plain;charset=UTF-8" }
  });
}

/** O aviso de compra no formato REAL da Hotmart (Webhook 2.0.0), como os gravados em produção. */
function avisoHotmart({ evento = "PURCHASE_APPROVED", status = "APPROVED", transacao, produto, oferta, valor, sck, comprador = MARIA, quando }) {
  return {
    id: randomUUID(),
    creation_date: quando,
    event: evento,
    version: "2.0.0",
    data: {
      product: { id: produto.id, ucode: produto.ucode, name: produto.nome, has_co_production: false, is_physical_product: false },
      affiliates: [{ affiliate_code: "", name: "" }],
      buyer: {
        email: comprador.email,
        name: comprador.nome,
        first_name: comprador.nome.split(" ")[0],
        last_name: comprador.nome.split(" ").slice(1).join(" "),
        checkout_phone_code: "55",
        checkout_phone: comprador.digits,
        address: { country: "Brasil", country_iso: "BR" },
        document: "00000000000",
        document_type: "CPF"
      },
      producer: { name: "Escola Enfermagem de Valor", legal_nature: "Pessoa Jurídica" },
      commissions: [
        { value: Math.round(valor * 82) / 100, source: "PRODUCER", currency_value: "BRL" },
        { value: Math.round(valor * 18) / 100, source: "MARKETPLACE", currency_value: "BRL" }
      ],
      purchase: {
        approved_date: evento === "PURCHASE_APPROVED" || evento === "PURCHASE_COMPLETE" ? quando : undefined,
        full_price: { value: valor, currency_value: "BRL" },
        price: { value: valor, currency_value: "BRL" },
        original_offer_price: { value: valor, currency_value: "BRL" },
        checkout_country: { name: "Brasil", iso: "BR" },
        order_bump: { is_order_bump: false },
        // É AQUI que os avisos reais trazem o sck (e não em purchase.tracking).
        origin: { sck },
        order_date: quando - 60_000,
        status,
        transaction: transacao,
        payment: { installments_number: 1, type: "PIX" },
        offer: { code: oferta, name: "Lote 1", description: "" },
        invoice_by: "HOTMART",
        subscription_anticipation_purchase: false,
        is_funnel: false,
        business_model: "I"
      }
    }
  };
}

function avisar(aviso, chave = CHAVE) {
  return pedir("POST", `/api/hotmart/venda?chave=${encodeURIComponent(chave)}`, {
    corpo: aviso,
    headers: { "Content-Type": "application/json" }
  });
}

/** O estado da compra numa inscrição. */
async function estado(id) {
  const [linha] = await linhas(`inscricoes?id=eq.${id}&select=comprou_em,compra_status,compra_valor,compra_transacao,compra_evento_em`);
  return linha;
}

const SEM_COMPRA = { comprou_em: null, compra_status: null, compra_valor: null, compra_transacao: null, compra_evento_em: null };

async function entrarNoPainel() {
  const r = await pedir("POST", "/api/painel/login", {
    corpo: { email: PAINEL_EMAIL, senha: PAINEL_SENHA },
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cookie = String(r.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^ev_painel=.+/);
  return cookie;
}

/* ================================================================== */
/* a) A página de venda, em outro site, manda o formulário            */
/* ================================================================== */

test("a) o preflight da origem do GPS passa; o de outra origem é recusado", async () => {
  const liberado = await pedir("OPTIONS", "/api/inscricao", {
    headers: { Origin: ORIGEM, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" }
  });
  assert.equal(liberado.status, 204);
  assert.equal(liberado.headers.get("access-control-allow-origin"), ORIGEM);
  assert.equal(liberado.headers.get("access-control-allow-methods"), "POST");
  assert.equal(liberado.headers.get("access-control-allow-headers"), "Content-Type");

  const estranho = await pedir("OPTIONS", "/api/inscricao", {
    headers: { Origin: "https://site-qualquer.com.br", "Access-Control-Request-Method": "POST" }
  });
  assert.equal(estranho.status, 403);
  assert.equal(estranho.headers.get("access-control-allow-origin"), null);
});

test("b) POST /api/inscricao do GPS em text/plain: 200 com CORS, e o checkout é o do GPS com sck = utm_content", async () => {
  const r = await doOutroSite(JSON.stringify(corpoGps()));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGEM, "sem isto o navegador esconde a resposta da página");
  assert.match(String(r.headers.get("vary")), /Origin/);
  assert.equal(r.json.ok, true);

  const url = new URL(r.json.checkout);
  assert.equal(url.origin + url.pathname, "https://pay.hotmart.com/R107667362D");
  assert.equal(url.searchParams.get("off"), C.ofertaDoLink(GPS.checkout));
  assert.ok(GPS.hotmart.ofertas.includes(url.searchParams.get("off")), "a oferta do link é uma que o webhook reconhece");
  assert.equal(url.searchParams.get("checkoutMode"), "10");
  for (const chave of C.UTMS) assert.equal(url.searchParams.get(chave), RASTREIO_GPS[chave], chave);
  assert.equal(C.sckDaPagina(GPS), "utm_content");
  assert.equal(url.searchParams.get("sck"), "criativo-gps-07", "no GPS o utm_content vira o sck");
  assert.equal(url.searchParams.get("name"), MARIA.nome);
  assert.equal(url.searchParams.get("email"), MARIA.email);
  assert.equal(url.searchParams.get("phoneac"), "11");
  assert.equal(url.searchParams.get("phonenumber"), "912345678");
  assert.equal(url.searchParams.get("fbclid"), null, "fbclid fica só com a gente");

  // A linha gravada: página do GPS, contato normalizado, o link EXATO devolvido e as UTMs.
  const gravadas = await linhas("inscricoes?select=*");
  assert.equal(gravadas.length, 1);
  const [linha] = gravadas;
  ids.gps = linha.id;
  assert.equal(linha.pagina, "imersao-gps");
  assert.equal(linha.nome, MARIA.nome);
  assert.equal(linha.email, MARIA.email);
  assert.equal(linha.whatsapp, MARIA.whatsapp);
  assert.equal(linha.whatsapp_digits, MARIA.digits);
  assert.equal(linha.checkout_url, r.json.checkout);
  assert.equal(linha.cliques, 1);
  assert.equal(linha.utm_source, "facebook");
  assert.equal(linha.utm_medium, "cpc");
  assert.equal(linha.utm_campaign, "igps-set-26");
  assert.equal(linha.utm_content, "criativo-gps-07");
  assert.equal(linha.utm_term, "publico-quente");
  assert.equal(linha.fbclid, "IwAR-gps-1");
  assert.equal(linha.page_url, RASTREIO_GPS.page_url);
  assert.equal(linha.referrer, RASTREIO_GPS.referrer);
  assert.equal(linha.dispositivo, "mobile");
  assert.equal(linha.comprou_em, null);
});

test("c) o e-mail do GPS precisa terminar em .com ou .com.br: 422 legível pela página (com CORS) e nada gravado", async () => {
  const r = await doOutroSite(JSON.stringify(corpoGps({ contato: { ...MARIA_DIGITADA, email: "maria@hospital.org.br" } })));
  assert.equal(r.status, 422);
  assert.equal(r.headers.get("access-control-allow-origin"), ORIGEM, "a página precisa ler o erro para mostrar no campo");
  assert.equal(r.json.error, "invalid_contact");
  assert.equal(r.json.campos.email, L.MESSAGES.email.com_br);

  // De outro site qualquer, texto puro continua recusado (415) e sem CORS.
  const estranho = await doOutroSite(JSON.stringify(corpoGps()), "https://site-qualquer.com.br");
  assert.equal(estranho.status, 415);
  assert.equal(estranho.headers.get("access-control-allow-origin"), null);

  assert.equal((await linhas("inscricoes?select=id")).length, 1, "nenhuma linha nova");
});

test("d) a mesma Maria se inscreve depois na Viver de Furo (mesmo site, JSON): outra inscrição, sck = utm_term", async () => {
  const r = await pedir("POST", "/api/inscricao", {
    corpo: { id: randomUUID(), pagina: VIVER.id, visitante_id: randomUUID(), contato: MARIA_DIGITADA, rastreio: RASTREIO_VIVER },
    headers: { "Content-Type": "application/json" }
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.headers.get("access-control-allow-origin"), null, "mesmo site: nada de CORS");
  const url = new URL(r.json.checkout);
  assert.equal(url.origin + url.pathname, "https://pay.hotmart.com/Y74893363S");
  assert.equal(url.searchParams.get("sck"), "criativo-furo-02", "na Viver de Furo o sck continua o utm_term");

  const gravadas = await linhas("inscricoes?select=id,pagina,email,whatsapp_digits,criado_em&order=criado_em.asc");
  assert.deepEqual(gravadas.map((l) => [l.pagina, l.email, l.whatsapp_digits]), [
    ["imersao-gps", MARIA.email, MARIA.digits],
    ["viver-de-furo", MARIA.email, MARIA.digits]
  ]);
  ids.viver = gravadas[1].id;
  // A da Viver é a MAIS RECENTE: é ela que um casamento sem olhar a página escolheria.
  assert.ok(new Date(gravadas[1].criado_em) > new Date(gravadas[0].criado_em));
});

/* ================================================================== */
/* e) A Hotmart avisa a venda do ingresso                              */
/* ================================================================== */

test("e) o aviso real do ingresso casa com a inscrição do GPS; a da Viver de Furo não é marcada", async () => {
  const aviso = avisoHotmart({
    transacao: "HP16015479281022",
    produto: PRODUTO_GPS,
    oferta: "l0r77by6",
    valor: 5,
    sck: "criativo-gps-07",
    quando: HORA_INGRESSO
  });

  // Sem a chave, nada entra.
  const semChave = await avisar(aviso, "chave-errada");
  assert.equal(semChave.status, 401);
  assert.equal((await linhas("compras?select=id")).length, 0);

  const r = await avisar(aviso);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true });

  const [compra] = await linhas("compras?select=*");
  assert.equal(compra.evento, "PURCHASE_APPROVED");
  assert.equal(compra.transacao, "HP16015479281022");
  assert.equal(compra.status, "APPROVED");
  assert.equal(compra.produto_id, "6123456", "o id numérico vira texto");
  assert.equal(compra.oferta, "l0r77by6");
  assert.equal(Number(compra.valor), 5);
  assert.equal(compra.moeda, "BRL");
  assert.equal(compra.sck, "criativo-gps-07", "o sck sai de data.purchase.origin.sck");
  assert.equal(compra.pagina, "imersao-gps");
  assert.equal(compra.inscricao_id, ids.gps);
  assert.equal(compra.comprador_email, MARIA.email);
  // checkout_phone_code (55) + checkout_phone: o telefone guarda o DDI; os dígitos, o número
  // nacional, igual ao whatsapp_digits da inscrição.
  assert.equal(compra.comprador_telefone, `55${MARIA.digits}`);
  assert.equal(compra.comprador_digits, MARIA.digits);
  assert.equal(new Date(compra.aprovado_em).getTime(), HORA_INGRESSO);
  assert.equal(compra.payload.version, "2.0.0", "o payload cru fica guardado inteiro");
  assert.equal(compra.payload.data.purchase.origin.sck, "criativo-gps-07");

  const ingresso = await estado(ids.gps);
  assert.equal(new Date(ingresso.comprou_em).getTime(), HORA_INGRESSO);
  assert.equal(ingresso.compra_status, "APPROVED");
  assert.equal(Number(ingresso.compra_valor), 5);
  assert.equal(ingresso.compra_transacao, "HP16015479281022");
  assert.deepEqual(await estado(ids.viver), SEM_COMPRA, "a inscrição da Viver de Furo continua sem compra");

  // A Hotmart repete o aviso até receber 2xx: repetir não duplica.
  assert.equal((await avisar({ ...aviso, id: randomUUID() })).status, 200);
  assert.equal((await linhas("compras?select=id")).length, 1);
});

test("f) um aviso de OUTRO produto (id 9999999, oferta desconhecida) para a mesma Maria não marca ninguém, nem o reembolso dele", async () => {
  const ingressoAntes = await estado(ids.gps);
  const formacao = {
    transacao: "HP99999999999001",
    produto: PRODUTO_FORMACAO,
    oferta: "zzform01",
    valor: 1997,
    sck: "HOTMART_SALES_AGENT",
    quando: HORA_FORMACAO
  };

  const r = await avisar(avisoHotmart(formacao));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [gravada] = await linhas("compras?transacao=eq.HP99999999999001&select=pagina,inscricao_id,produto_id,sck,valor");
  assert.deepEqual(
    { pagina: gravada.pagina, inscricao_id: gravada.inscricao_id, produto_id: gravada.produto_id, sck: gravada.sck },
    { pagina: null, inscricao_id: null, produto_id: "9999999", sck: "HOTMART_SALES_AGENT" },
    "gravada, de fora, sem casar"
  );
  assert.deepEqual(await estado(ids.gps), ingressoAntes, "o ingresso não vira 'comprou a Formação' nem ganha R$ 1.997");
  assert.deepEqual(await estado(ids.viver), SEM_COMPRA);

  // O reembolso da Formação, depois, também não desmarca o ingresso.
  const reembolso = await avisar(avisoHotmart({ ...formacao, evento: "PURCHASE_REFUNDED", status: "REFUNDED", quando: HORA_FORMACAO + 86_400_000 }));
  assert.equal(reembolso.status, 200);
  assert.deepEqual(await estado(ids.gps), ingressoAntes);
  assert.deepEqual(await estado(ids.viver), SEM_COMPRA);
  assert.equal((await linhas("compras?select=id")).length, 3);
});

/* ================================================================== */
/* g) O painel mostra de onde veio cada ingresso                       */
/* ================================================================== */

test("g) /api/painel/inscricoes?pagina=imersao-gps (com login) traz vendas_por_sck com o criativo, e só avisos do GPS", async () => {
  const semLogin = await pedir("GET", `/api/painel/inscricoes?pagina=${GPS.id}`);
  assert.equal(semLogin.status, 401);

  const cookie = await entrarNoPainel();
  const r = await pedir("GET", `/api/painel/inscricoes?pagina=${GPS.id}`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true);

  const { resumo } = r.json;
  assert.equal(resumo.paginas.length, 1);
  const [gps] = resumo.paginas;
  assert.equal(gps.pagina, "imersao-gps");
  assert.deepEqual([gps.inscritos, gps.cliques, gps.compras, Number(gps.receita)], [1, 1, 1, 5]);
  assert.equal(gps.vendas, 1);
  assert.equal(Number(gps.vendas_receita), 5);
  assert.deepEqual(gps.vendas_por_sck, [{ sck: "criativo-gps-07", vendas: 1, receita: 5, casadas: 1 }]);
  assert.deepEqual(gps.por_conteudo, [{ utm_content: "criativo-gps-07", inscritos: 1, compras: 1 }]);
  assert.deepEqual(gps.por_midia, [{ utm_medium: "cpc", inscritos: 1, compras: 1 }]);
  assert.deepEqual(gps.por_termo, [{ utm_term: "publico-quente", inscritos: 1, compras: 1 }]);

  // A Formação (e o reembolso dela) é de fora: não entra como "compra sem inscrição" do GPS.
  assert.equal(resumo.compras_sem_inscricao, 0);
  assert.deepEqual(
    resumo.compras_recentes.map((c) => [c.evento, c.pagina, c.sck, c.casou, Number(c.valor)]),
    [["PURCHASE_APPROVED", "imersao-gps", "criativo-gps-07", true, 5]]
  );

  // A lista de inscritos da aba: só a Maria do GPS, já com a compra.
  assert.equal(r.json.total, 1);
  assert.equal(r.json.itens.length, 1);
  assert.equal(r.json.itens[0].id, ids.gps);
  assert.equal(r.json.itens[0].pagina, "imersao-gps");
  assert.ok(r.json.itens[0].comprou_em);

  // Na aba da Viver de Furo, a mesma Maria aparece inscrita e SEM compra.
  const viver = await pedir("GET", `/api/painel/inscricoes?pagina=${VIVER.id}`, { headers: { Cookie: cookie } });
  assert.equal(viver.status, 200);
  const [pagina] = viver.json.resumo.paginas;
  assert.deepEqual([pagina.pagina, pagina.inscritos, pagina.compras, pagina.vendas], ["viver-de-furo", 1, 0, 0]);
  assert.deepEqual(pagina.vendas_por_sck, []);
  assert.deepEqual(viver.json.resumo.compras_recentes, []);
});

/* ================================================================== */
/* h) Troca de lote: só os botões da página mudam                      */
/* ================================================================== */

test("h) lote novo: o botão abre outra oferta do MESMO produto, e a venda dela ainda casa com a inscrição do GPS", async () => {
  const ANA_DIGITADA = { nome: "ana souza", whatsapp: "(21) 99876-5432", email: "ana.souza@hotmail.com.br" };
  const rastreioAna = { ...RASTREIO_GPS, utm_content: "criativo-gps-09" };

  // Um link de OUTRO produto no botão não consegue desviar o checkout: vale o do config.
  const desvio = await doOutroSite(
    JSON.stringify(corpoGps({ contato: ANA_DIGITADA, rastreio: rastreioAna, checkout: "https://pay.hotmart.com/OUTROPRODUTO?off=xyz12345" }))
  );
  assert.equal(desvio.status, 200, JSON.stringify(desvio.json));
  assert.equal(new URL(desvio.json.checkout).pathname, "/R107667362D");
  assert.equal(new URL(desvio.json.checkout).searchParams.get("off"), C.ofertaDoLink(GPS.checkout));

  // Ela volta e toca o botão do lote 2: é esse o último link aberto, o que fica gravado.
  const lote2 = "https://pay.hotmart.com/R107667362D?off=lote2abc&checkoutMode=10";
  const r = await doOutroSite(JSON.stringify(corpoGps({ contato: ANA_DIGITADA, rastreio: rastreioAna, checkout: lote2 })));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const url = new URL(r.json.checkout);
  assert.equal(url.origin + url.pathname, "https://pay.hotmart.com/R107667362D");
  assert.equal(url.searchParams.get("off"), "lote2abc");
  assert.equal(url.searchParams.get("sck"), "criativo-gps-09");

  const [ana] = await linhas(`inscricoes?email=eq.${encodeURIComponent("ana.souza@hotmail.com.br")}&select=id,pagina,cliques,checkout_url`);
  assert.equal(ana.pagina, "imersao-gps");
  assert.equal(ana.cliques, 2, "o segundo envio soma clique na mesma inscrição");
  assert.equal(ana.checkout_url, r.json.checkout);

  // A venda do lote 2: o config não conhece a oferta (o servidor manda pagina null), mas o banco
  // reconhece a venda como do GPS pelo off= do link que a inscrição abriu.
  assert.equal(C.paginaDaVenda({ oferta: "lote2abc", produto_id: String(PRODUTO_GPS.id) }), null, "o config ainda não sabe do lote 2");
  const venda = await avisar(
    avisoHotmart({
      transacao: "HP16015479281099",
      produto: PRODUTO_GPS,
      oferta: "lote2abc",
      valor: 10,
      sck: "criativo-gps-09",
      comprador: { nome: "Ana Souza", email: "ana.souza@hotmail.com.br", digits: "21998765432" },
      quando: HORA_INGRESSO + 3_600_000
    })
  );
  assert.equal(venda.status, 200);
  const [gravada] = await linhas("compras?transacao=eq.HP16015479281099&select=pagina,inscricao_id,sck");
  assert.deepEqual(gravada, { pagina: "imersao-gps", inscricao_id: ana.id, sck: "criativo-gps-09" });
  assert.equal(Number((await estado(ana.id)).compra_valor), 10);
  assert.equal(Number((await estado(ids.gps)).compra_valor), 5, "a Maria continua com o ingresso dela");

  const cookie = await entrarNoPainel();
  const painel = await pedir("GET", `/api/painel/inscricoes?pagina=${GPS.id}`, { headers: { Cookie: cookie } });
  const [gps] = painel.json.resumo.paginas;
  assert.equal(gps.vendas, 2);
  assert.equal(Number(gps.vendas_receita), 15);
  assert.deepEqual(gps.vendas_por_sck, [
    { sck: "criativo-gps-09", vendas: 1, receita: 10, casadas: 1 },
    { sck: "criativo-gps-07", vendas: 1, receita: 5, casadas: 1 }
  ]);
});
