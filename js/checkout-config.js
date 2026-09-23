/*
 * checkout-config.js — as páginas de inscrição que levam a um checkout da Hotmart.
 *
 * ESTE É O ÚNICO ARQUIVO PARA MUDAR LINK DE CHECKOUT, ROTA OU TEXTO DESSAS PÁGINAS.
 * A página (js/inscricao.js), o servidor (rotas, gravação, webhook de venda) e o painel leem daqui.
 *
 * `montarUrlCheckout` é pura e testada: é ela que leva as UTMs e os dados de contato até a
 * Hotmart. Mesma ideia do checkout-hotmart.ts do site da Escola, com duas diferenças pedidas
 * pelo cliente: o `sck` vem do utm_term (e não do utm_content) e o contato vai junto, para o
 * checkout já abrir preenchido.
 *
 * Parâmetros de pré-preenchimento aceitos pela Hotmart (Central de Ajuda, "Como configurar meus
 * parâmetros da Página de Pagamento"): name, email, phoneac (o DDD) e phonenumber (o número SEM o
 * DDD). Por isso o WhatsApp é quebrado em dois.
 */
(function (root) {
  "use strict";

  const L = root.EVLeadRules;

  /** As UTMs que seguem para o checkout, na ordem em que entram na URL. */
  const UTMS = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);

  const PAGINAS = Object.freeze({
    "viver-de-furo": Object.freeze({
      id: "viver-de-furo",
      rota: "/viver-de-furo-inscricao",
      nome: "Viver de Furo — inscrição",
      produto: "Viver de Furo de Orelha",
      // O link de checkout do cliente, com a oferta e o modo de checkout que ele já usa.
      checkout: "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&checkoutMode=10",
      // Código da oferta (off=) e do produto: é assim que o aviso de venda da Hotmart é casado
      // com esta página, quando a mesma conta vende mais de um produto.
      oferta: "7j2nqptq",
      hotmart_produto: "Y74893363S"
    })
  });

  const LISTA = Object.freeze(Object.values(PAGINAS));
  const POR_ROTA = new Map(LISTA.map((pagina) => [pagina.rota, pagina]));

  function paginaDaRota(caminho) {
    const limpo = String(caminho || "").replace(/\/+$/, "") || "/";
    return POR_ROTA.get(limpo) || null;
  }

  function paginaPorId(id) {
    return PAGINAS[String(id || "")] || null;
  }

  /*
   * A query string é montada na mão, sem `URL` nem `URLSearchParams`: no servidor este arquivo é
   * carregado com vm num contexto que NÃO tem essas classes, e a versão anterior devolvia o link
   * sem parâmetro nenhum, em silêncio. Só String, encodeURIComponent e split rodam nos dois lados.
   */
  function separar(base) {
    const texto = String(base || "");
    const semHash = texto.split("#");
    const hash = semHash.length > 1 ? `#${semHash.slice(1).join("#")}` : "";
    const partes = semHash[0].split("?");
    const caminho = partes[0];
    const pares = [];
    for (const pedaco of partes.slice(1).join("?").split("&")) {
      if (!pedaco) continue;
      const igual = pedaco.indexOf("=");
      const chave = igual === -1 ? pedaco : pedaco.slice(0, igual);
      const valor = igual === -1 ? "" : pedaco.slice(igual + 1);
      pares.push([decodeURIComponent(chave.replace(/\+/g, " ")), decodeURIComponent(valor.replace(/\+/g, " "))]);
    }
    return { caminho, pares, hash };
  }

  function juntar(partes) {
    const query = partes.pares
      .map(([chave, valor]) => `${encodeURIComponent(chave)}=${encodeURIComponent(valor)}`)
      .join("&");
    return partes.caminho + (query ? `?${query}` : "") + partes.hash;
  }

  function definir(pares, chave, valor) {
    const existente = pares.findIndex((par) => par[0] === chave);
    if (existente === -1) pares.push([chave, valor]);
    else pares[existente][1] = valor;
  }

  /**
   * A URL final do checkout.
   *
   *   utm      → as UTMs da página seguem iguais; o utm_term vira TAMBÉM o `sck`, que é o campo
   *              que a Hotmart guarda na venda e devolve no relatório e no aviso de compra.
   *   contato  → nome, e-mail e WhatsApp vão na URL para o checkout abrir preenchido. O telefone
   *              é quebrado em phoneac (DDD) + phonenumber (o resto), como a Hotmart espera.
   *
   * Nunca lança: o que já estava no link (off, checkoutMode) é preservado, e um link sem "http"
   * volta como veio, porque travar o clique é pior.
   */
  function montarUrlCheckout(base, opcoes) {
    const o = opcoes || {};
    const texto = String(base || "");
    if (!/^https?:\/\/[^/\s?#]+/i.test(texto)) return texto;

    const partes = separar(texto);
    const utm = o.utm || {};
    for (const chave of UTMS) {
      const valor = typeof utm[chave] === "string" ? utm[chave].trim() : "";
      if (valor) definir(partes.pares, chave, valor);
    }

    // Pedido do cliente: o utm_term também vira o sck.
    const termo = typeof utm.utm_term === "string" ? utm.utm_term.trim() : "";
    if (termo) definir(partes.pares, "sck", termo);

    const contato = o.contato || {};
    // formatName: "maria da silva" chega no checkout como "Maria da Silva".
    const nome = L ? L.formatName(contato.nome) : String(contato.nome || "").trim();
    if (nome) definir(partes.pares, "name", nome);

    const email = L ? L.normalizeEmail(contato.email) : String(contato.email || "").trim().toLowerCase();
    if (email) definir(partes.pares, "email", email);

    const digitos = L
      ? L.normalizePhoneDigits(contato.whatsapp)
      : String(contato.whatsapp || "").replace(/\D/g, "");
    if (digitos.length >= 10) {
      definir(partes.pares, "phoneac", digitos.slice(0, 2));
      definir(partes.pares, "phonenumber", digitos.slice(2));
    }

    return juntar(partes);
  }

  /** As UTMs e os cliques de anúncio que a página guarda e repassa (recebe "?a=1&b=2" ou "a=1&b=2"). */
  function rastreioDaUrl(busca) {
    const { pares } = separar(`x?${String(busca || "").replace(/^\?/, "")}`);
    const rastreio = {};
    for (const [chave, valor] of pares) {
      if (!UTMS.includes(chave) && chave !== "fbclid" && chave !== "gclid") continue;
      const limpo = String(valor || "").trim();
      if (limpo) rastreio[chave] = limpo.slice(0, 500);
    }
    return rastreio;
  }

  root.EVCheckout = Object.freeze({
    UTMS,
    PAGINAS,
    LISTA,
    paginaDaRota,
    paginaPorId,
    montarUrlCheckout,
    rastreioDaUrl
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
