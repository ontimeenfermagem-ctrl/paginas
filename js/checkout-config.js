/*
 * checkout-config.js — as páginas de inscrição que levam a um checkout da Hotmart.
 *
 * ESTE É O ÚNICO ARQUIVO PARA MUDAR LINK DE CHECKOUT, ROTA OU TEXTO DESSAS PÁGINAS.
 * A página (js/inscricao.js), o servidor (rotas, gravação, webhook de venda) e o painel leem daqui.
 * A página de venda da Imersão GPS, que mora em outro site (repo whatsapp-atendimento-centralizado),
 * leva uma CÓPIA deste arquivo e do js/lead-rules.js: mudou aqui, copie para lá.
 *
 * `montarUrlCheckout` é pura e testada: é ela que leva as UTMs e os dados de contato até a
 * Hotmart. Mesma ideia do checkout-hotmart.ts do site da Escola: as UTMs seguem iguais e UMA delas
 * vira também o `sck` — qual delas é escolha de cada página (`sck`): na Viver de Furo o cliente
 * pediu o utm_term; na Imersão GPS é o utm_content, como no site da Escola. O contato vai junto,
 * para o checkout já abrir preenchido.
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

  /** De qual UTM sai o `sck` quando a página não diz (o padrão da primeira página, Viver de Furo). */
  const SCK_PADRAO = "utm_term";

  /*
   * Cada página:
   *
   *   id, rota, nome, produto  → o que o painel mostra; `id` é o que vai para o banco.
   *   origem                   → só para página que mora em OUTRO site: o endereço dela
   *                              (https://host, sem barra no fim). Este servidor não serve arquivo
   *                              nenhum para ela; só libera o POST /api/inscricao vindo de lá (CORS).
   *   checkout                 → o link do checkout, com a oferta (off=) e o modo que o cliente usa.
   *                              A página pode pedir outra oferta do MESMO produto (troca de lote):
   *                              ver baseDoCheckout.
   *   sck                      → qual UTM vira o `sck` (utm_term ou utm_content).
   *   emailSomenteComBr        → true = o e-mail precisa terminar em .com ou .com.br.
   *   hotmart.ofertas/produtos → como o aviso de venda da Hotmart é reconhecido como DESTA página:
   *                              pelo código da oferta (purchase.offer.code, o off= do link) ou pelo
   *                              id NUMÉRICO do produto (data.product.id — não é o código do link).
   *                              Venda de produto que não é de página nenhuma (a Formação vendida no
   *                              fim da imersão, um order bump) é gravada, mas não marca inscrito.
   */
  const PAGINAS = Object.freeze({
    "viver-de-furo": Object.freeze({
      id: "viver-de-furo",
      rota: "/viver-de-furo-inscricao",
      nome: "Viver de Furo — inscrição",
      produto: "Viver de Furo de Orelha",
      checkout: "https://pay.hotmart.com/Y74893363S?off=7j2nqptq&checkoutMode=10",
      // Pedido do cliente: nesta página o utm_term vira o sck.
      sck: "utm_term",
      emailSomenteComBr: false,
      // 2332962 = "Furo de orelha humanizado", o produto que o off=7j2nqptq vende (visto nos avisos
      // reais gravados em compras).
      hotmart: Object.freeze({ ofertas: Object.freeze(["7j2nqptq"]), produtos: Object.freeze(["2332962"]) })
    }),
    "imersao-gps": Object.freeze({
      id: "imersao-gps",
      rota: "/igps_set_lp_26-ingresso",
      origem: "https://io.escolaenfermagemdevalor.com.br",
      nome: "Imersão GPS — ingressos",
      produto: "Imersão GPS do Plantão Sem Medo",
      // Lote 1 (R$ 5,00). Troca de lote: o link novo vai nos botões da página de venda, e o aviso da
      // Hotmart com a oferta nova é reconhecido sozinho (ver hotmart_registrar_compra no SQL).
      checkout: "https://pay.hotmart.com/R107667362D?off=l0r77by6&checkoutMode=10",
      // Como no site da Escola: o utm_content (o criativo do anúncio) vira o sck.
      sck: "utm_content",
      emailSomenteComBr: true,
      // O id numérico do produto aparece no primeiro aviso de venda (compras.produto_id): cole aqui
      // quando souber. Até lá, a oferta basta.
      hotmart: Object.freeze({ ofertas: Object.freeze(["l0r77by6"]), produtos: Object.freeze([]) })
    })
  });

  const LISTA = Object.freeze(Object.values(PAGINAS));
  const POR_ROTA = new Map(LISTA.map((pagina) => [pagina.rota, pagina]));

  /** Os sites de fora que podem mandar o formulário para o /api/inscricao deste servidor. */
  const ORIGENS = Object.freeze(Array.from(new Set(LISTA.map((pagina) => pagina.origem).filter(Boolean))));

  function paginaDaRota(caminho) {
    const limpo = String(caminho || "").replace(/\/+$/, "") || "/";
    return POR_ROTA.get(limpo) || null;
  }

  function paginaPorId(id) {
    const chave = String(id || "");
    return Object.prototype.hasOwnProperty.call(PAGINAS, chave) ? PAGINAS[chave] : null;
  }

  /** A UTM que vira `sck` nesta página (utm_term se a página não disser, ou disser algo estranho). */
  function sckDaPagina(pagina) {
    const escolhida = pagina && typeof pagina.sck === "string" ? pagina.sck : "";
    return UTMS.includes(escolhida) ? escolhida : SCK_PADRAO;
  }

  /*
   * A query string é montada na mão, sem `URL` nem `URLSearchParams`: no servidor este arquivo é
   * carregado com vm num contexto que NÃO tem essas classes, e a versão anterior devolvia o link
   * sem parâmetro nenhum, em silêncio. Só String, encodeURIComponent e split rodam nos dois lados.
   */
  function decodificar(texto) {
    try {
      return decodeURIComponent(texto.replace(/\+/g, " "));
    } catch {
      // "%E0" solto numa URL colada à mão: fica o texto cru, em vez de derrubar quem chamou.
      return texto;
    }
  }

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
      pares.push([decodificar(chave), decodificar(valor)]);
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

  function lerParametro(url, chave) {
    const par = separar(url).pares.find((item) => item[0] === chave);
    return par ? par[1] : "";
  }

  /**
   * A URL final do checkout.
   *
   *   utm      → as UTMs da página seguem iguais; a UTM escolhida em `sck` (utm_term se não vier)
   *              vira TAMBÉM o `sck`, que é o campo que a Hotmart guarda na venda e devolve no
   *              relatório e no aviso de compra.
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

    const origemDoSck = UTMS.includes(o.sck) ? o.sck : SCK_PADRAO;
    const sck = typeof utm[origemDoSck] === "string" ? utm[origemDoSck].trim() : "";
    if (sck) definir(partes.pares, "sck", sck);

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

  /** O código da oferta (off=) de um link de checkout; "" se não tiver. */
  function ofertaDoLink(url) {
    const oferta = lerParametro(url, "off").trim();
    return /^[A-Za-z0-9_-]{1,40}$/.test(oferta) ? oferta : "";
  }

  /**
   * O link de onde o checkout parte. A página pode mandar o link do botão que a pessoa tocou
   * (`pedido`): ele vale só se for do MESMO produto do config (mesmo caminho em pay.hotmart.com),
   * e dele sai só a oferta (off=) e o checkoutMode. É o que deixa trocar de lote mexendo só nos
   * botões da página, sem que alguém consiga mandar o checkout para outro lugar.
   */
  function baseDoCheckout(pagina, pedido) {
    const padrao = pagina && typeof pagina.checkout === "string" ? pagina.checkout : "";
    const texto = typeof pedido === "string" ? pedido.trim() : "";
    if (!padrao || !texto || texto.length > 2048) return padrao;

    const doPadrao = separar(padrao);
    const doPedido = separar(texto);
    if (doPedido.caminho.toLowerCase() !== doPadrao.caminho.toLowerCase()) return padrao;

    const oferta = ofertaDoLink(texto);
    if (!oferta) return padrao;
    definir(doPadrao.pares, "off", oferta);
    const modo = lerParametro(texto, "checkoutMode").trim();
    if (/^\d{1,3}$/.test(modo)) definir(doPadrao.pares, "checkoutMode", modo);
    return juntar(doPadrao);
  }

  /** A URL do checkout de uma página, com a régua dela (link base e UTM do sck). */
  function urlDoCheckout(pagina, opcoes) {
    const o = opcoes || {};
    return montarUrlCheckout(baseDoCheckout(pagina, o.base), { utm: o.utm, contato: o.contato, sck: sckDaPagina(pagina) });
  }

  /**
   * De qual página é um aviso de venda da Hotmart: pela oferta, e senão pelo id do produto.
   * Recebe os campos já extraídos do payload ({oferta, produto_id, produto_ucode}); null = produto
   * que não é de página nenhuma.
   */
  function paginaDaVenda(venda) {
    const v = venda || {};
    const oferta = typeof v.oferta === "string" ? v.oferta.trim() : "";
    const produtos = [v.produto_id, v.produto_ucode]
      .map((valor) => (valor == null ? "" : String(valor).trim()))
      .filter(Boolean);
    if (oferta) {
      const pelaOferta = LISTA.find((pagina) => pagina.hotmart && pagina.hotmart.ofertas.includes(oferta));
      if (pelaOferta) return pelaOferta;
    }
    if (produtos.length) {
      const peloProduto = LISTA.find((pagina) => pagina.hotmart && pagina.hotmart.produtos.some((id) => produtos.includes(String(id))));
      if (peloProduto) return peloProduto;
    }
    return null;
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
    SCK_PADRAO,
    PAGINAS,
    LISTA,
    ORIGENS,
    paginaDaRota,
    paginaPorId,
    sckDaPagina,
    montarUrlCheckout,
    ofertaDoLink,
    baseDoCheckout,
    urlDoCheckout,
    paginaDaVenda,
    rastreioDaUrl
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
