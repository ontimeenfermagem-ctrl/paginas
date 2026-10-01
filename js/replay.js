/*
 * replay.js — a sala de aula (/replay-*): a matéria, o formulário que libera, o material e o mural.
 *
 * Nada de texto aqui: tudo vem de js/replay-config.js (EVReplay), pela ROTA em que a página está
 * aberta. O formulário usa a mesma régua de contato do resto do projeto (EVLeadRules) e as mesmas
 * quatro profissões da pergunta 1 da pesquisa (EVPesquisa).
 *
 * Três regras que não se negociam neste arquivo:
 *
 * 1. TEXTO DE TERCEIRO NUNCA VIRA HTML. Comentário, nome, tudo que vem da API entra por
 *    createElement + textContent, nó por nó. Os ÚNICOS innerHTML do arquivo são as constantes de
 *    ícone declaradas aqui embaixo — nenhuma delas tem dado interpolado.
 * 2. O SELO E A FOTO DA IZA saem do config (EVReplay.ADMIN), nunca da API. A API só diz se a linha
 *    é `admin: true`; o rosto e o selo são desenhados a partir do código.
 * 3. O PLAYER SÓ NASCE NO CLIQUE. Antes disso, nada de terceiro é carregado.
 */
(function () {
  "use strict";

  const L = window.EVLeadRules;
  const P = window.EVPesquisa;
  const R = window.EVReplay;
  if (!L || !P || !R) return;

  const pagina = R.paginaDaRota(window.location.pathname);
  if (!pagina) return;

  const API_INSCRICAO = "/api/replay/inscricao";
  const API_COMENTARIOS = "/api/replay/comentarios";
  const API_COMENTARIO = "/api/replay/comentario";
  const API_MODERAR = "/api/painel/replay/comentario";
  const API_RESPONDER = "/api/painel/replay/resposta";

  const CHAVE_VISITANTE = "ev_pesquisa_visitante";
  const CHAVE_RASTREIO = `ev_replay_rastreio_${pagina.id}`;
  const CHAVE_ACESSO = `ev_replay_acesso_${pagina.id}_v1`;
  const TIMEOUT_MS = 6000;
  const CAMPANHA = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"];
  const TETO = { page_url: 2048, referrer: 2048, fbclid: 1000, gclid: 1000 };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CHAVE_MENSAGEM = { nome: "name", whatsapp: "phone", email: "email" };
  const ORDEM = ["nome", "whatsapp", "email"];
  const DIA_MS = 24 * 60 * 60 * 1000;
  const TEXTO_MAX = 1200;
  const POR_PAGINA = 10;

  const $ = (id) => document.getElementById(id);

  /* ================================================================== */
  /* Ícones (os ÚNICOS innerHTML do arquivo — constantes, sem dado)       */
  /* ================================================================== */

  const ICONE_PLAY = '<svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
  const ICONE_CADEADO =
    '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICONE_BAIXAR =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // O selo de verificado: um só desenho, sempre o mesmo, sempre do código.
  const ICONE_SELO =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.6l2.3 2.1 3.1-.3.9 3 2.7 1.6-1.1 2.9 1.1 2.9-2.7 1.6-.9 3-3.1-.3L12 20.4l-2.3-2.1-3.1.3-.9-3L3 14l1.1-2.9L3 8.2l2.7-1.6.9-3 3.1.3z"/><path fill="#fff" d="m10.9 14.7-2.7-2.6 1.1-1.1 1.6 1.5 3.9-3.9 1.1 1.1z"/></svg>';

  function icone(html, classe) {
    const span = document.createElement("span");
    span.className = classe || "";
    span.innerHTML = html;
    return span;
  }

  /** O selo, com o texto que o leitor de tela lê — e que diz que é da ESCOLA, não de rede social. */
  function seloVerificado() {
    const span = icone(ICONE_SELO, "selo-verificado");
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", R.ADMIN.selo);
    span.title = R.ADMIN.selo;
    return span;
  }

  /* ================================================================== */
  /* Storage à prova de webview                                          */
  /* ================================================================== */

  function lerStorage(chave) {
    try {
      return window.localStorage.getItem(chave);
    } catch {
      return null;
    }
  }

  function gravarStorage(chave, valor) {
    try {
      window.localStorage.setItem(chave, valor);
    } catch {
      // Cheio ou bloqueado: a sala abre igual, só não lembra na próxima visita.
    }
  }

  function lerJson(chave) {
    try {
      const bruto = JSON.parse(lerStorage(chave) || "null");
      return bruto && typeof bruto === "object" ? bruto : null;
    } catch {
      return null;
    }
  }

  function gravarJson(chave, valor) {
    try {
      gravarStorage(chave, JSON.stringify(valor));
    } catch {
      // Objeto que não vira JSON não pode derrubar a página.
    }
  }

  function novoUuid() {
    const c = window.crypto;
    try {
      if (c && typeof c.randomUUID === "function") return c.randomUUID();
    } catch {
      // randomUUID só existe em contexto seguro; cai no getRandomValues.
    }
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function visitanteDoAparelho() {
    const guardado = lerStorage(CHAVE_VISITANTE);
    if (guardado && UUID.test(guardado)) return guardado;
    const novo = novoUuid();
    gravarStorage(CHAVE_VISITANTE, novo);
    return novo;
  }

  /* ================================================================== */
  /* Rastreio da visita                                                  */
  /* ================================================================== */

  function texto(valor, campo) {
    if (valor == null) return null;
    const limpo = String(valor).trim().slice(0, TETO[campo] || 500);
    return limpo || null;
  }

  function dispositivo() {
    const largura = window.innerWidth || document.documentElement.clientWidth || 0;
    if (largura < 768) return "mobile";
    if (largura < 1024) return "tablet";
    return "desktop";
  }

  function daUrl() {
    const params = new URLSearchParams(window.location.search);
    const dados = {};
    for (const campo of CAMPANHA) {
      const valor = (params.get(campo) || "").trim();
      if (valor) dados[campo] = valor.slice(0, 500);
    }
    return dados;
  }

  /**
   * A campanha é a DESTA visita: exatamente a da URL aberta agora. Sem UTM na URL, sem UTM — nada
   * guardado de visita anterior entra no lugar. A campanha que ficava guardada no aparelho
   * (CHAVE_RASTREIO) não é mais lida: só apagada, para não sobrar lixo.
   */
  const CAMPANHA_DESTA_PESSOA = daUrl();
  try {
    window.localStorage.removeItem(CHAVE_RASTREIO);
  } catch {
    // Storage bloqueado: não há o que limpar.
  }

  function rastreioAtual() {
    const dados = {
      page_url: texto(window.location.origin + window.location.pathname + window.location.search, "page_url"),
      referrer: texto(document.referrer, "referrer"),
      dispositivo: dispositivo()
    };
    for (const campo of CAMPANHA) {
      dados[campo] = typeof CAMPANHA_DESTA_PESSOA[campo] === "string" ? texto(CAMPANHA_DESTA_PESSOA[campo], campo) : null;
    }
    return dados;
  }

  function pixel(tipo, evento, dados) {
    if (typeof window.fbq !== "function") return;
    try {
      if (dados) window.fbq(tipo, evento, dados);
      else window.fbq(tipo, evento);
    } catch {
      // Bloqueador de anúncio não pode atrapalhar a sala.
    }
  }

  function anunciar(mensagem) {
    const alvo = $("sala-aviso");
    if (!alvo) return;
    alvo.textContent = "";
    window.setTimeout(() => {
      alvo.textContent = mensagem;
    }, 30);
  }

  /* ================================================================== */
  /* Estado                                                              */
  /* ================================================================== */

  const visitanteId = visitanteDoAparelho();
  const acessoGuardado = lerJson(CHAVE_ACESSO) || {};
  const sessaoId = UUID.test(String(acessoGuardado.id || "")) ? acessoGuardado.id : novoUuid();
  let perfilEscolhido = typeof acessoGuardado.perfil === "string" ? acessoGuardado.perfil : "";
  let tentouEnviar = false;
  let enviando = false;
  let emailDispensado = "";
  let whatsappAnterior = "";
  let liberada = false;
  // Quem está na sala agora. Começa com o que ficou guardado e é atualizado no envio do formulário
  // — é daqui que sai o "Comentando como Maria da Silva" no mural.
  let contatoAtual = acessoGuardado.contato && typeof acessoGuardado.contato === "object" ? acessoGuardado.contato : null;

  // O mural
  const mural = { admin: false, itens: [], proximo: null, carregando: false, total: 0 };

  /** A sala já foi liberada neste aparelho, e ainda vale? */
  function acessoValido() {
    const dias = Number(pagina.acesso && pagina.acesso.lembrarDias) || 0;
    const quando = Number(acessoGuardado.em) || 0;
    if (!acessoGuardado.liberado || !quando) return false;
    if (!dias) return true;
    return Date.now() - quando < dias * DIA_MS;
  }

  /* ================================================================== */
  /* Desenho: a capa                                                     */
  /* ================================================================== */

  function escreverTexto(id, valor) {
    const alvo = $(id);
    if (alvo) alvo.textContent = valor || "";
  }

  /**
   * O título da capa aceita UMA palavra em <em> (peso leve, ameixa). Como o texto vem do config, e
   * não da API, dava para usar innerHTML — mas a regra do arquivo é uma só, para ninguém copiar o
   * padrão errado depois: nada de HTML por string. O título é partido e montado com createElement.
   */
  function escreverTitulo(id, bruto) {
    const alvo = $(id);
    if (!alvo) return;
    alvo.textContent = "";
    const partes = String(bruto || "").split(/<em>|<\/em>/);
    partes.forEach((parte, indice) => {
      if (!parte) return;
      // Índice ímpar = o que estava entre <em> e </em>.
      if (indice % 2 === 1) {
        const em = document.createElement("em");
        em.textContent = parte;
        alvo.append(em);
      } else {
        alvo.append(document.createTextNode(parte));
      }
    });
  }

  function desenharCapa() {
    escreverTexto("expediente-edicao", pagina.edicao);
    escreverTexto("sala-eyebrow", pagina.eyebrow);
    escreverTitulo("sala-titulo", pagina.titulo);
    escreverTexto("sala-apoio", pagina.apoio);
    escreverTexto("abertura-legenda", pagina.legenda);
    escreverTexto("colofao-texto", pagina.rodape);

    // A linha de crédito: o rosto e o selo da Iza, antes do mural.
    const credito = $("capa-credito");
    if (credito) {
      credito.textContent = "";
      const foto = document.createElement("img");
      foto.src = R.ADMIN.avatar;
      foto.alt = `Foto de ${R.ADMIN.nome}`;
      foto.width = 46;
      foto.height = 46;
      foto.loading = "eager";
      const bloco = document.createElement("div");
      bloco.className = "capa-credito-texto";
      const nome = document.createElement("p");
      nome.className = "capa-credito-nome";
      nome.append(document.createTextNode(R.ADMIN.nome), seloVerificado());
      const papel = document.createElement("p");
      papel.className = "capa-credito-papel";
      papel.textContent = R.ADMIN.papel;
      bloco.append(nome, papel);
      credito.append(foto, bloco);
    }

    const acesso = pagina.acesso || {};
    escreverTexto("porta-rotulo", acesso.rotulo);
    escreverTexto("porta-titulo", acesso.titulo);
    escreverTexto("porta-apoio", acesso.apoio);
    escreverTexto("perfil-titulo", acesso.perguntaPerfil);
    escreverTexto("botao-acesso-texto", acesso.cta);
  }

  function desenharSumario() {
    const secao = $("sumario");
    const lista = $("sumario-lista");
    const itens = Array.isArray(pagina.sumario) ? pagina.sumario : [];
    if (!secao || !lista) return;
    if (!itens.length) {
      secao.hidden = true;
      return;
    }
    lista.textContent = "";
    for (const item of itens) {
      const li = document.createElement("li");
      li.append(document.createTextNode(item));
      lista.append(li);
    }
    secao.hidden = false;
  }

  /* ================================================================== */
  /* Desenho: a foto de abertura                                         */
  /* ================================================================== */

  const aula = (Array.isArray(pagina.aulas) && pagina.aulas[0]) || null;

  function desenharQuadro() {
    const alvo = $("abertura-quadro");
    if (!alvo || !aula) return;
    alvo.textContent = "";

    const quadro = document.createElement("button");
    quadro.type = "button";
    quadro.className = "abertura-quadro";
    quadro.id = "quadro";

    const capa = R.capaDaAula(aula);
    if (capa) {
      const img = document.createElement("img");
      img.className = "abertura-capa";
      img.src = capa;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      // Capa que não carrega (vídeo privado, thumb inexistente) não deixa buraco na tela.
      img.addEventListener("error", () => img.remove());
      quadro.append(img);
    }

    const centro = document.createElement("div");
    centro.className = "abertura-centro";
    const temVideo = R.videoValido(aula.video);

    if (!liberada) {
      // Trancada: a foto de abertura aparece SEMPRE. É ela que dá vontade.
      centro.classList.add("abertura-trava");
      centro.append(icone(ICONE_CADEADO, ""));
      const legenda = document.createElement("p");
      legenda.className = "abertura-texto";
      legenda.textContent = (pagina.acesso && pagina.acesso.trava) || "A aula inteira está aqui";
      centro.append(legenda);
      quadro.setAttribute("aria-label", "Liberar o acesso para assistir à aula");
      quadro.addEventListener("click", () => {
        const porta = $("porta");
        if (!porta) return;
        porta.scrollIntoView({ behavior: "smooth", block: "center" });
        const primeiro = $("campo-nome");
        if (primeiro) window.setTimeout(() => primeiro.focus({ preventScroll: true }), 320);
      });
    } else if (temVideo) {
      const play = document.createElement("span");
      play.className = "abertura-play";
      play.append(icone(ICONE_PLAY, ""));
      centro.append(play);
      const legenda = document.createElement("p");
      legenda.className = "abertura-texto";
      legenda.textContent = "Assistir a aula";
      centro.append(legenda);
      quadro.setAttribute("aria-label", `Assistir: ${aula.titulo}`);
      quadro.addEventListener("click", () => tocar(quadro));
    } else {
      // Liberada, mas sem vídeo no config: o quadro avisa, não finge.
      quadro.setAttribute("aria-disabled", "true");
      const legenda = document.createElement("p");
      legenda.className = "abertura-texto";
      legenda.textContent = "Estamos preparando o replay desta aula. Volte em instantes 💜";
      centro.append(legenda);
    }

    quadro.append(centro);
    alvo.append(quadro);
    // Quem já chegou no momento da oferta neste aparelho encontra o botão aberto.
    if (liberada && lerStorage(CHAVE_OFERTA) === "1") abrirOferta({ chegando: false });
  }

  /* ================================================================== */
  /* A oferta: o botão que a aula libera                                 */
  /* ================================================================== */
  /*
   * O botão nasce escondido e aparece quando o VÍDEO passa de `aposSegundos` (js/replay-config.js,
   * oferta). Quem mede é a API oficial do YouTube: pausar não conta, adiantar até lá conta. Se a
   * API não carregar (bloqueador de anúncio, rede ruim, Vimeo/Panda), o plano B é o relógio — o
   * mesmo tempo contado desde o play. O relógio é cancelado assim que a API responde, para quem
   * pausou não ganhar o botão antes da hora.
   */
  const OFERTA = R.ofertaDaPagina(pagina);
  const CHAVE_OFERTA = `ev_replay_oferta_${pagina.id}`;
  const API_YOUTUBE = "https://www.youtube.com/iframe_api";
  let ofertaAberta = false;
  let relogioOferta = 0;
  let vigiaOferta = 0;

  function abrirOferta({ chegando = true } = {}) {
    if (!OFERTA || ofertaAberta) return;
    const caixa = $("oferta");
    const botao = $("oferta-botao");
    if (!caixa || !botao) return;
    ofertaAberta = true;
    window.clearTimeout(relogioOferta);
    window.clearInterval(vigiaOferta);
    botao.href = OFERTA.link;
    escreverTexto("oferta-rotulo", OFERTA.rotulo);
    caixa.classList.toggle("chegando", chegando);
    caixa.hidden = false;
    gravarStorage(CHAVE_OFERTA, "1");
    if (chegando) {
      pixel("trackCustom", "replay_oferta", { pagina: pagina.id, aula: aula ? aula.id : "" });
      anunciar(`Liberado logo abaixo da aula: ${OFERTA.rotulo}.`);
    }
  }

  function carregarApiDoYoutube(pronto) {
    if (window.YT && typeof window.YT.Player === "function") {
      pronto();
      return;
    }
    // A API chama esta função global quando termina de carregar; uma anterior (de outro script)
    // continua sendo chamada.
    const anterior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof anterior === "function") {
        try {
          anterior();
        } catch {
          // O erro de outro script não pode impedir o botão.
        }
      }
      pronto();
    };
    if (document.querySelector(`script[src="${API_YOUTUBE}"]`)) return;
    const script = document.createElement("script");
    script.src = API_YOUTUBE;
    script.async = true;
    document.head.append(script);
  }

  function vigiarOferta(frame) {
    if (!OFERTA || ofertaAberta || !aula) return;
    relogioOferta = window.setTimeout(() => abrirOferta(), OFERTA.aposSegundos * 1000);
    if (aula.video.provedor !== "youtube") return;
    try {
      carregarApiDoYoutube(() => {
        try {
          const player = new window.YT.Player(frame, {
            events: {
              onReady: () => {
                // A API respondeu: quem manda agora é o minuto do vídeo, e não o relógio.
                window.clearTimeout(relogioOferta);
                window.clearInterval(vigiaOferta);
                vigiaOferta = window.setInterval(() => {
                  let segundos = 0;
                  try {
                    segundos = Number(player.getCurrentTime()) || 0;
                  } catch {
                    segundos = 0;
                  }
                  if (segundos >= OFERTA.aposSegundos) abrirOferta();
                }, 1000);
              }
            }
          });
        } catch {
          // A API carregou mas não aceitou o player: fica o relógio.
        }
      });
    } catch {
      // Script bloqueado: fica o relógio.
    }
  }

  function tocar(quadro) {
    const url = R.urlDoVideo(aula.video);
    if (!url) return;
    const moldura = document.createElement("div");
    moldura.className = "abertura-quadro";
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = aula.titulo;
    // Tela cheia só pelo allowfullscreen: com "fullscreen" também no allow, o Chrome avisa que um
    // dos dois é ignorado.
    frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture";
    frame.setAttribute("allowfullscreen", "");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    moldura.append(frame);
    quadro.replaceWith(moldura);
    vigiarOferta(frame);
    // A decoração sai da frente enquanto a aula roda (só decoração: texto nenhum perde contraste).
    document.body.classList.add("assistindo");
    pixel("trackCustom", "replay_play", { pagina: pagina.id, aula: aula.id });
    anunciar("A aula começou.");
  }

  /* ================================================================== */
  /* Desenho: a matéria, o material                                      */
  /* ================================================================== */

  function desenharMateria() {
    const paragrafos = Array.isArray(pagina.materia) ? pagina.materia.filter(Boolean) : [];
    const fio = $("fio-materia");
    const titulo = $("materia-titulo");
    const corpo = $("materia");
    const olho = $("olho");

    if (titulo && aula) {
      titulo.textContent = aula.titulo;
      titulo.hidden = false;
    }
    if (fio) fio.hidden = false;

    if (corpo) {
      corpo.textContent = "";
      for (const p of paragrafos) {
        const el = document.createElement("p");
        el.textContent = p;
        corpo.append(el);
      }
      corpo.hidden = paragrafos.length === 0;
    }

    // O olho só aparece com frase no config.
    const frase = pagina.olho && typeof pagina.olho.texto === "string" ? pagina.olho.texto.trim() : "";
    if (olho) {
      if (!frase) {
        olho.hidden = true;
      } else {
        escreverTexto("olho-texto", frase);
        escreverTexto("olho-quem", (pagina.olho && pagina.olho.quem) || R.ADMIN.nome);
        olho.hidden = false;
      }
    }
  }

  function desenharMaterial() {
    const itens = R.materialDaPagina(pagina);
    const fio = $("fio-material");
    const apoio = $("material-apoio");
    const lista = $("material-lista");
    const nav = $("nav-material");
    if (!lista) return;

    if (!itens.length) {
      if (fio) fio.hidden = true;
      if (apoio) apoio.hidden = true;
      lista.hidden = true;
      if (nav) nav.hidden = true;
      return;
    }

    const material = pagina.material || {};
    escreverTexto("material-rotulo", material.titulo || "Para levar");
    if (apoio) {
      apoio.textContent = material.apoio || "";
      apoio.hidden = !material.apoio;
    }

    lista.textContent = "";
    for (const item of itens) {
      const li = document.createElement("li");
      li.className = "material-item";
      const link = document.createElement("a");
      link.className = "material-link";
      link.href = item.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      const losango = document.createElement("span");
      losango.className = "material-losango";
      losango.setAttribute("aria-hidden", "true");

      const bloco = document.createElement("span");
      const titulo = document.createElement("strong");
      titulo.textContent = item.titulo;
      bloco.append(titulo);
      if (item.descricao) {
        const desc = document.createElement("span");
        desc.textContent = item.descricao;
        bloco.append(desc);
      }

      const tipo = document.createElement("span");
      tipo.className = "material-tipo";
      tipo.append(icone(ICONE_BAIXAR, ""), document.createTextNode(` ${item.tipo || "Baixar"}`));

      link.append(losango, bloco, tipo);
      link.addEventListener("click", () => pixel("trackCustom", "replay_material", { pagina: pagina.id, material: item.id }));
      li.append(link);
      lista.append(li);
    }
    lista.hidden = false;
    if (fio) fio.hidden = false;
    if (nav) nav.hidden = false;
  }

  function desenharCertificado() {
    const secao = $("certificado");
    const fio = $("fio-certificado");
    if (!secao) return;
    if (!R.certificadoVisivel(pagina)) {
      // Escondido de verdade: some da tela, do Ctrl+F e do leitor de tela.
      secao.hidden = true;
      if (fio) fio.hidden = true;
      return;
    }
    const c = pagina.certificado;
    escreverTexto("certificado-titulo", c.titulo);
    escreverTexto("certificado-apoio", c.apoio);
    escreverTexto("certificado-cta-texto", c.cta);
    const cta = $("certificado-cta");
    if (cta) cta.href = c.link;
    const imagem = $("certificado-imagem");
    if (imagem) {
      if (c.imagem) imagem.src = c.imagem;
      else imagem.remove();
    }
    secao.hidden = false;
    if (fio) fio.hidden = false;
  }

  /* ================================================================== */
  /* O mural de cartas                                                   */
  /* ================================================================== */

  const RELATIVO = (() => {
    try {
      return new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
    } catch {
      return null;
    }
  })();

  function quando(iso) {
    const data = new Date(iso);
    if (Number.isNaN(data.getTime())) return "";
    const segundos = Math.round((data.getTime() - Date.now()) / 1000);
    const passos = [
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60]
    ];
    if (!RELATIVO) return data.toLocaleDateString("pt-BR");
    for (const [unidade, tamanho] of passos) {
      if (Math.abs(segundos) >= tamanho) return RELATIVO.format(Math.round(segundos / tamanho), unidade);
    }
    return "agora mesmo";
  }

  function inicialDe(nome) {
    const limpo = String(nome || "").trim();
    return limpo ? limpo[0].toUpperCase() : "?";
  }

  /** Uma carta. TODO texto da API entra por textContent — nunca por HTML. */
  function cartaHtml(item) {
    const li = document.createElement("li");
    li.className = "carta";
    li.dataset.comentario = String(item.id);
    if (item.estado && item.estado !== "visivel") li.dataset.estado = item.estado;

    const cabeca = document.createElement("header");
    cabeca.className = "carta-quem";

    const inicial = document.createElement("span");
    inicial.className = "carta-inicial";
    inicial.setAttribute("aria-hidden", "true");
    inicial.textContent = inicialDe(item.autor && item.autor.nome);

    const identidade = document.createElement("div");
    identidade.className = "carta-identidade";
    const nome = document.createElement("p");
    nome.className = "carta-nome";
    nome.textContent = (item.autor && item.autor.nome) || "Aluna";
    const meta = document.createElement("p");
    meta.className = "carta-quando";
    const time = document.createElement("time");
    time.dateTime = item.criado_em || "";
    time.textContent = quando(item.criado_em);
    meta.append(time);
    if (item.autor && item.autor.perfil) meta.append(document.createTextNode(` · ${item.autor.perfil}`));
    identidade.append(nome, meta);

    cabeca.append(inicial, identidade);

    // Os três pontinhos: SÓ quando o servidor disse que quem está olhando é admin.
    if (mural.admin) cabeca.append(menuDaCarta(item, li));

    const corpo = document.createElement("p");
    corpo.className = "carta-texto";
    corpo.textContent = item.texto || "";

    li.append(cabeca, corpo);

    if (item.estado === "oculto") {
      const etiqueta = document.createElement("span");
      etiqueta.className = "carta-etiqueta";
      etiqueta.textContent = "Fora do ar";
      li.append(etiqueta);
    }
    if (item.estado === "em_revisao") {
      const etiqueta = document.createElement("span");
      etiqueta.className = "carta-etiqueta";
      etiqueta.textContent = "Em conferência";
      li.append(etiqueta);
    }

    for (const resposta of Array.isArray(item.respostas) ? item.respostas : []) {
      li.append(respostaHtml(resposta, item, li));
    }
    return li;
  }

  /** A resposta da Iza: o rosto, o nome e o selo vêm do CONFIG; da API vem só o texto. */
  function respostaHtml(resposta, raiz, cartaEl) {
    const bloco = document.createElement("div");
    bloco.className = "carta-resposta";
    bloco.dataset.comentario = String(resposta.id);

    const foto = document.createElement("img");
    foto.src = R.ADMIN.avatar;
    foto.alt = `Foto de ${R.ADMIN.nome}`;
    foto.width = 40;
    foto.height = 40;
    foto.loading = "lazy";

    const lado = document.createElement("div");
    const nome = document.createElement("p");
    nome.className = "carta-nome";
    nome.append(document.createTextNode(R.ADMIN.nome), seloVerificado());
    const meta = document.createElement("p");
    meta.className = "carta-quando";
    const time = document.createElement("time");
    time.dateTime = resposta.criado_em || "";
    time.textContent = quando(resposta.criado_em);
    meta.append(time, document.createTextNode(` · ${R.ADMIN.papel}`));
    const corpo = document.createElement("p");
    corpo.className = "carta-texto";
    corpo.textContent = resposta.texto || "";
    lado.append(nome, meta, corpo);

    bloco.append(foto, lado);
    if (mural.admin) {
      const apagar = document.createElement("button");
      apagar.type = "button";
      apagar.className = "carta-menu";
      apagar.textContent = "⋯";
      apagar.setAttribute("aria-label", "Ações desta resposta");
      apagar.addEventListener("click", () => abrirMenu(apagar, resposta, cartaEl, { resposta: true }));
      bloco.append(apagar);
    }
    return bloco;
  }

  /* ---------------------------------------------------- o menu de três pontinhos */

  function menuDaCarta(item, cartaEl) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = "carta-menu";
    botao.textContent = "⋯";
    botao.setAttribute("aria-haspopup", "menu");
    botao.setAttribute("aria-expanded", "false");
    botao.setAttribute("aria-label", "Ações deste comentário");
    botao.addEventListener("click", () => abrirMenu(botao, item, cartaEl, {}));
    return botao;
  }

  function fecharMenus() {
    for (const aberto of document.querySelectorAll(".carta-acoes")) aberto.remove();
    for (const botao of document.querySelectorAll('.carta-menu[aria-expanded="true"]')) {
      botao.setAttribute("aria-expanded", "false");
    }
  }

  function abrirMenu(botao, item, cartaEl, { resposta = false } = {}) {
    const jaAberto = botao.getAttribute("aria-expanded") === "true";
    fecharMenus();
    if (jaAberto) return;
    botao.setAttribute("aria-expanded", "true");

    const menu = document.createElement("div");
    menu.className = "carta-acoes";
    menu.setAttribute("role", "menu");

    if (!resposta) {
      const responder = document.createElement("button");
      responder.type = "button";
      responder.setAttribute("role", "menuitem");
      responder.textContent = "Responder como Izabel";
      responder.addEventListener("click", () => {
        fecharMenus();
        abrirResposta(item, cartaEl);
      });
      menu.append(responder);
    }

    const oculto = item.estado === "oculto";
    const esconder = document.createElement("button");
    esconder.type = "button";
    esconder.setAttribute("role", "menuitem");
    esconder.textContent = oculto ? "Publicar de novo" : "Esconder do público";
    esconder.addEventListener("click", () => {
      fecharMenus();
      moderar(item, oculto ? "mostrar" : "esconder");
    });
    menu.append(esconder);

    // Excluir é destrutivo: dois toques, e o segundo diz o que vai acontecer.
    const excluir = document.createElement("button");
    excluir.type = "button";
    excluir.className = "perigo";
    excluir.setAttribute("role", "menuitem");
    excluir.textContent = "Excluir";
    let confirmando = false;
    excluir.addEventListener("click", () => {
      if (!confirmando) {
        confirmando = true;
        excluir.textContent = "Confirmar exclusão (não volta)";
        return;
      }
      fecharMenus();
      moderar(item, "excluir");
    });
    menu.append(excluir);

    botao.parentElement.append(menu);
    const primeiro = menu.querySelector("button");
    if (primeiro) primeiro.focus();
  }

  document.addEventListener("click", (evento) => {
    const alvo = evento.target instanceof Element ? evento.target : null;
    if (!alvo) return;
    if (!alvo.closest(".carta-acoes") && !alvo.closest(".carta-menu")) fecharMenus();
  });
  document.addEventListener("keydown", (evento) => {
    if (evento.key === "Escape") fecharMenus();
  });

  /* ---------------------------------------------------- responder como a Iza */

  function abrirResposta(item, cartaEl) {
    const antigo = cartaEl.querySelector(".compositor");
    if (antigo) {
      antigo.remove();
      return;
    }
    const caixa = document.createElement("div");
    caixa.className = "compositor";
    const quem = document.createElement("p");
    quem.className = "compositor-quem";
    const foto = document.createElement("img");
    foto.src = R.ADMIN.avatar;
    foto.alt = "";
    foto.width = 26;
    foto.height = 26;
    foto.style.borderRadius = "999px";
    quem.append(foto, document.createTextNode(`Respondendo como ${R.ADMIN.nome}`), seloVerificado());

    const area = document.createElement("textarea");
    area.maxLength = TEXTO_MAX;
    area.placeholder = "Sua resposta…";
    area.setAttribute("aria-label", `Responder como ${R.ADMIN.nome}`);

    const linha = document.createElement("div");
    linha.className = "compositor-linha";
    const aviso = document.createElement("span");
    aviso.className = "compositor-conta";
    const enviar = document.createElement("button");
    enviar.type = "button";
    enviar.className = "botao-checkout";
    const enviarTexto = document.createElement("span");
    enviarTexto.className = "botao-checkout-texto";
    enviarTexto.textContent = "RESPONDER";
    enviar.append(enviarTexto);
    linha.append(aviso, enviar);

    enviar.addEventListener("click", async () => {
      const valor = area.value.trim();
      if (valor.length < 2) {
        aviso.textContent = "Escreva a resposta.";
        area.focus();
        return;
      }
      enviar.disabled = true;
      aviso.textContent = "Publicando…";
      const resposta = await pedir(API_RESPONDER, { pagina: pagina.id, respondendo_id: item.id, texto: valor });
      enviar.disabled = false;
      if (!resposta.ok) {
        aviso.textContent = resposta.mensagem || "Não deu para publicar agora.";
        return;
      }
      caixa.remove();
      await carregarMural({ reiniciar: true });
      anunciar("Resposta publicada.");
    });

    caixa.append(quem, area, linha);
    cartaEl.append(caixa);
    area.focus();
  }

  /* ---------------------------------------------------- moderar */

  async function moderar(item, acao) {
    const resposta = await pedir(API_MODERAR, { pagina: pagina.id, id: item.id, acao });
    if (!resposta.ok) {
      anunciar(resposta.mensagem || "Não deu para moderar agora.");
      return;
    }
    await carregarMural({ reiniciar: true });
    anunciar(acao === "excluir" ? "Comentário excluído." : acao === "esconder" ? "Comentário fora do ar." : "Comentário no ar de novo.");
  }

  /* ---------------------------------------------------- o compositor público */

  function desenharCompositor() {
    const alvo = $("mural-compositor");
    if (!alvo) return;
    alvo.textContent = "";
    if (!liberada) return;

    const c = pagina.comentarios || {};
    const caixa = document.createElement("div");
    caixa.className = "compositor";

    const quem = document.createElement("p");
    quem.className = "compositor-quem";
    const inicial = document.createElement("span");
    inicial.className = "carta-inicial";
    inicial.setAttribute("aria-hidden", "true");
    inicial.style.width = "28px";
    inicial.style.height = "28px";
    inicial.style.fontSize = "12px";
    const nomeGuardado = (contatoAtual && contatoAtual.nome) || "";
    inicial.textContent = inicialDe(nomeGuardado);
    quem.append(inicial, document.createTextNode(nomeGuardado ? `Comentando como ${nomeGuardado}` : "Comentando na sala"));

    const area = document.createElement("textarea");
    area.id = "mural-texto";
    area.maxLength = TEXTO_MAX;
    area.placeholder = c.placeholder || "Escreva seu comentário…";
    area.setAttribute("aria-label", "Seu comentário");

    const linha = document.createElement("div");
    linha.className = "compositor-linha";
    const conta = document.createElement("span");
    conta.className = "compositor-conta";
    const enviar = document.createElement("button");
    enviar.type = "button";
    enviar.className = "botao-checkout";
    const enviarTexto = document.createElement("span");
    enviarTexto.className = "botao-checkout-texto";
    enviarTexto.textContent = c.cta || "PUBLICAR";
    enviar.append(enviarTexto);
    linha.append(conta, enviar);

    area.addEventListener("input", () => {
      const resta = TEXTO_MAX - area.value.length;
      conta.textContent = resta < 200 ? `${resta} caracteres` : "";
    });

    enviar.addEventListener("click", async () => {
      const valor = area.value.trim();
      if (valor.length < 2) {
        conta.textContent = "Escreva pelo menos duas letras.";
        area.focus();
        return;
      }
      enviar.disabled = true;
      conta.textContent = "Publicando…";
      const resposta = await pedir(API_COMENTARIO, {
        pagina: pagina.id,
        sessao_id: sessaoId,
        visitante_id: visitanteId,
        texto: valor
      });
      enviar.disabled = false;
      if (!resposta.ok) {
        conta.textContent = resposta.mensagem || "Não deu para publicar agora.";
        return;
      }
      area.value = "";
      conta.textContent = resposta.corpo && resposta.corpo.aviso === "em_conferencia" ? "Seu comentário passa por uma conferência rápida." : "";
      pixel("trackCustom", "replay_comentario", { pagina: pagina.id });
      await carregarMural({ reiniciar: true });
      anunciar("Comentário publicado.");
    });

    caixa.append(quem, area, linha);
    alvo.append(caixa);
  }

  /* ---------------------------------------------------- pedir e carregar */

  /** POST com JSON. Devolve { ok, corpo, mensagem } — nunca joga. */
  async function pedir(url, corpo) {
    try {
      const controle = new AbortController();
      const relogio = window.setTimeout(() => controle.abort(), TIMEOUT_MS);
      const resposta = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
        signal: controle.signal
      });
      window.clearTimeout(relogio);
      const json = await resposta.json().catch(() => null);
      if (!resposta.ok) {
        const campos = json && json.campos ? Object.values(json.campos)[0] : "";
        return { ok: false, corpo: json, mensagem: campos || mensagemDoErro(json && json.error) };
      }
      return { ok: true, corpo: json };
    } catch {
      return { ok: false, corpo: null, mensagem: "Sem conexão agora. Tente de novo." };
    }
  }

  function mensagemDoErro(erro) {
    if (erro === "muito_rapido") return "Espere alguns segundos antes de comentar de novo.";
    if (erro === "acesso_nao_liberado") return "Libere o acesso à sala para comentar.";
    if (erro === "invalid_text") return "Confere o texto do comentário.";
    if (erro === "too_many_requests") return "Muitos envios seguidos. Espere um pouquinho.";
    return "Não deu para publicar agora.";
  }

  async function carregarMural({ reiniciar = false, mais = false } = {}) {
    if (!R.comentariosAtivos(pagina)) return;
    const secao = $("mural");
    const fio = $("fio-mural");
    const nav = $("nav-mural");
    const lista = $("cartas");
    if (!secao || !lista) return;
    if (mural.carregando) return;
    mural.carregando = true;

    const params = new URLSearchParams({ pagina: pagina.id, limite: String(POR_PAGINA) });
    // O id de sessão é o que prova ao servidor que esta pessoa liberou a sala. Sem ele (ou com a
    // sala trancada), a resposta vem só com a contagem.
    if (liberada) params.set("sessao_id", sessaoId);
    if (mais && mural.proximo) params.set("antes", String(mural.proximo));

    let corpo = null;
    try {
      const resposta = await fetch(`${API_COMENTARIOS}?${params}`, { headers: { Accept: "application/json" } });
      corpo = resposta.ok ? await resposta.json().catch(() => null) : null;
    } catch {
      corpo = null;
    }
    mural.carregando = false;

    // Endpoint ainda não publicado, banco fora ou erro: a seção simplesmente não existe. Página de
    // lead não grita erro de infraestrutura.
    if (!corpo || corpo.ok !== true || !Array.isArray(corpo.itens)) {
      secao.hidden = true;
      if (fio) fio.hidden = true;
      if (nav) nav.hidden = true;
      return;
    }

    mural.admin = corpo.admin === true;
    mural.total = Number(corpo.total) || 0;

    /*
     * SALA TRANCADA: ninguém de fora lê texto de terceiro. Da resposta aproveita-se só a
     * CONTAGEM, para a prova social embaixo do botão — a seção do mural continua sem existir na
     * página. (O servidor também só manda os itens para quem tem acesso; esta é a segunda porta.)
     */
    if (!liberada) {
      secao.hidden = true;
      if (fio) fio.hidden = true;
      if (nav) nav.hidden = true;
      const conversa = $("porta-conversa");
      if (conversa) {
        if (mural.total > 0) {
          conversa.textContent =
            mural.total === 1 ? "Já tem 1 comentário na conversa da aula." : `Já são ${mural.total} comentários na conversa da aula.`;
          conversa.hidden = false;
        } else {
          conversa.hidden = true;
        }
      }
      return;
    }

    mural.proximo = corpo.proximo || null;
    mural.itens = reiniciar || !mais ? corpo.itens : mural.itens.concat(corpo.itens);

    const c = pagina.comentarios || {};
    escreverTexto("mural-rotulo", c.titulo || "Comentários");
    const apoio = $("mural-apoio");
    if (apoio) {
      apoio.textContent = c.apoio || "";
      apoio.hidden = !c.apoio;
    }

    lista.textContent = "";
    if (!mural.itens.length) {
      const vazio = document.createElement("p");
      vazio.className = "mural-apoio";
      vazio.textContent = c.vazio || "Ninguém comentou ainda.";
      lista.append(vazio);
    } else {
      for (const item of mural.itens) lista.append(cartaHtml(item));
    }

    const botaoMais = $("mural-mais");
    if (botaoMais) botaoMais.hidden = !mural.proximo;

    secao.hidden = false;
    if (fio) fio.hidden = false;
    if (nav) nav.hidden = false;
    desenharCompositor();

    const conversa = $("porta-conversa");
    if (conversa) conversa.hidden = true;
  }

  const botaoMais = $("mural-mais");
  if (botaoMais) botaoMais.addEventListener("click", () => carregarMural({ mais: true }));

  /* ================================================================== */
  /* Trancar e abrir                                                     */
  /* ================================================================== */

  function abrirSala({ recemLiberado = false } = {}) {
    liberada = true;
    const porta = $("porta");
    if (porta) porta.hidden = true;
    desenharQuadro();
    desenharMateria();
    desenharMaterial();
    desenharCertificado();
    const nav = $("sala-nav");
    if (nav) nav.hidden = false;
    carregarMural({ reiniciar: true });

    if (recemLiberado) {
      anunciar("Acesso liberado. A aula está aqui em cima.");
      const secao = $("aula");
      if (secao) secao.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  /* ================================================================== */
  /* Validação (a mesma régua da pesquisa e da inscrição)                */
  /* ================================================================== */

  const form = $("form-acesso");
  const campos = { nome: $("campo-nome"), whatsapp: $("campo-whatsapp"), email: $("campo-email") };
  const status = $("acesso-status");
  const botao = $("botao-acesso");
  const listaOpcoes = $("opcoes-perfil");
  const erroPerfil = $("erro-perfil");
  const sugestao = {
    caixa: $("sugestao-email"),
    valor: $("sugestao-valor"),
    sim: $("sugestao-sim"),
    nao: $("sugestao-nao")
  };

  function mostrarErro(campo, mensagem) {
    const caixa = $(`erro-${campo}`);
    const grupo = form ? form.querySelector(`[data-campo="${campo}"]`) : null;
    if (!caixa || !grupo) return;
    caixa.textContent = mensagem || "";
    caixa.hidden = !mensagem;
    if (campos[campo]) campos[campo].setAttribute("aria-invalid", mensagem ? "true" : "false");
    grupo.classList.toggle("tem-erro", Boolean(mensagem));
  }

  function erroLocal(campo) {
    const valor = campos[campo].value;
    const codigo = campo === "nome" ? L.nameError(valor) : campo === "whatsapp" ? L.phoneError(valor) : L.emailError(valor);
    return L.message(CHAVE_MENSAGEM[campo], codigo);
  }

  function validarCampo(campo) {
    const mensagem = erroLocal(campo);
    mostrarErro(campo, mensagem);
    return mensagem;
  }

  function atualizarSugestao(destaque) {
    if (!sugestao.caixa) return "";
    const valor = L.normalizeEmail(campos.email.value);
    const sugerido = valor ? L.suggestEmail(valor) : "";
    const codigo = L.emailError(valor);
    if (!sugerido || (valor === emailDispensado && codigo !== "typo")) {
      sugestao.caixa.hidden = true;
      sugestao.caixa.classList.remove("destaque");
      return "";
    }
    sugestao.valor.textContent = sugerido;
    sugestao.nao.hidden = codigo === "typo";
    sugestao.caixa.hidden = false;
    sugestao.caixa.classList.toggle("destaque", Boolean(destaque));
    return sugerido;
  }

  function mostrarErrosDoServidor(camposErro) {
    let primeiro = null;
    for (const campo of ORDEM) {
      const mensagem = camposErro && typeof camposErro[campo] === "string" ? camposErro[campo] : "";
      mostrarErro(campo, mensagem);
      if (mensagem && !primeiro) primeiro = campo;
    }
    if (primeiro) campos[primeiro].focus();
    else if (status) status.textContent = "Confere os seus dados, por favor.";
  }

  if (form && botao && listaOpcoes) {
    // Voltou depois de já ter preenchido: os campos vêm prontos.
    if (acessoGuardado.contato && typeof acessoGuardado.contato === "object") {
      campos.nome.value = String(acessoGuardado.contato.nome || "");
      campos.whatsapp.value = L.formatPhone(String(acessoGuardado.contato.whatsapp || ""));
      campos.email.value = String(acessoGuardado.contato.email || "");
      whatsappAnterior = campos.whatsapp.value;
    }

    // O clique encerra o "apertando", nunca um timer.
    let apertandoEnviar = false;
    let soltarTimer = 0;
    const soltarEnviar = () => {
      window.clearTimeout(soltarTimer);
      apertandoEnviar = false;
    };
    botao.addEventListener("pointerdown", () => {
      apertandoEnviar = true;
      window.clearTimeout(soltarTimer);
      soltarTimer = window.setTimeout(soltarEnviar, 1000);
    });
    botao.addEventListener("click", soltarEnviar, true);
    botao.addEventListener("pointercancel", soltarEnviar);

    for (const campo of ORDEM) {
      campos[campo].addEventListener("blur", () => {
        if (apertandoEnviar) return;
        if (campos[campo].value.trim() || tentouEnviar) validarCampo(campo);
        if (campo === "email") atualizarSugestao(false);
      });
      campos[campo].addEventListener("input", () => {
        if (form.querySelector(`[data-campo="${campo}"]`).classList.contains("tem-erro") && !erroLocal(campo)) {
          mostrarErro(campo, "");
        }
        if (status) status.textContent = "";
      });
    }

    campos.whatsapp.addEventListener("input", () => {
      const formatado = L.formatPhoneWhileTyping(campos.whatsapp.value, whatsappAnterior);
      if (formatado !== campos.whatsapp.value) campos.whatsapp.value = formatado;
      whatsappAnterior = formatado;
    });

    campos.email.addEventListener("input", () => {
      if (sugestao.caixa && !sugestao.caixa.hidden) atualizarSugestao(false);
    });

    campos.nome.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        campos.whatsapp.focus();
      }
    });
    campos.whatsapp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        campos.email.focus();
      }
    });

    if (sugestao.sim) {
      sugestao.sim.addEventListener("click", () => {
        const sugerido = sugestao.valor.textContent.trim();
        if (sugerido) {
          campos.email.value = sugerido;
          emailDispensado = "";
          mostrarErro("email", "");
        }
        sugestao.caixa.hidden = true;
        campos.email.focus();
      });
    }
    if (sugestao.nao) {
      sugestao.nao.addEventListener("click", () => {
        emailDispensado = L.normalizeEmail(campos.email.value);
        sugestao.caixa.hidden = true;
        campos.email.focus();
      });
    }

    /* ---------------------------------------------------- as quatro profissões */

    listaOpcoes.textContent = "";
    for (const rotulo of R.perfis()) {
      const opcao = document.createElement("button");
      opcao.type = "button";
      opcao.className = "opcao";
      opcao.setAttribute("role", "radio");
      opcao.setAttribute("aria-checked", rotulo === perfilEscolhido ? "true" : "false");
      opcao.dataset.valor = rotulo;
      const marca = document.createElement("span");
      marca.className = "opcao-marca";
      marca.setAttribute("aria-hidden", "true");
      const rotuloEl = document.createElement("span");
      rotuloEl.textContent = rotulo;
      opcao.append(marca, rotuloEl);
      opcao.addEventListener("click", () => escolherPerfil(rotulo));
      listaOpcoes.append(opcao);
    }

    function escolherPerfil(rotulo) {
      perfilEscolhido = rotulo;
      for (const opcao of listaOpcoes.querySelectorAll(".opcao")) {
        opcao.setAttribute("aria-checked", opcao.dataset.valor === rotulo ? "true" : "false");
      }
      if (erroPerfil) {
        erroPerfil.textContent = "";
        erroPerfil.hidden = true;
      }
      if (status) status.textContent = "";
    }

    listaOpcoes.addEventListener("keydown", (evento) => {
      const atuais = Array.from(listaOpcoes.querySelectorAll(".opcao"));
      const indice = atuais.indexOf(document.activeElement);
      if (indice === -1) return;
      const passo =
        evento.key === "ArrowDown" || evento.key === "ArrowRight" ? 1 : evento.key === "ArrowUp" || evento.key === "ArrowLeft" ? -1 : 0;
      if (!passo) return;
      evento.preventDefault();
      atuais[(indice + passo + atuais.length) % atuais.length].focus();
    });

    /* ---------------------------------------------------- envio */

    form.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      if (enviando) return;
      tentouEnviar = true;
      if (status) status.textContent = "";

      let primeiroErro = null;
      for (const campo of ORDEM) if (validarCampo(campo) && !primeiroErro) primeiroErro = campo;

      if (!perfilEscolhido) {
        if (erroPerfil) {
          erroPerfil.textContent = "Escolha a opção que combina com você.";
          erroPerfil.hidden = false;
        }
        if (!primeiroErro) {
          const primeira = listaOpcoes.querySelector(".opcao");
          if (primeira) primeira.focus();
          anunciar("Escolha a sua profissão para liberar a aula.");
          return;
        }
      }

      if (primeiroErro) {
        if (L.emailError(campos.email.value) === "typo") atualizarSugestao(primeiroErro === "email");
        campos[primeiroErro].focus();
        return;
      }

      if (atualizarSugestao(true)) {
        sugestao.sim.focus();
        anunciar(`Você quis dizer ${sugestao.valor.textContent}?`);
        return;
      }

      const contato = {
        nome: L.formatName(campos.nome.value),
        whatsapp: L.formatPhone(campos.whatsapp.value),
        email: L.normalizeEmail(campos.email.value)
      };
      campos.whatsapp.value = contato.whatsapp;

      const corpo = {
        id: sessaoId,
        visitante_id: visitanteId,
        pagina: pagina.id,
        contato,
        perfil: perfilEscolhido,
        rastreio: rastreioAtual()
      };

      enviando = true;
      botao.disabled = true;
      botao.setAttribute("aria-busy", "true");
      if (status) status.textContent = "Liberando…";

      let camposComErro = null;
      try {
        const controle = new AbortController();
        const relogio = window.setTimeout(() => controle.abort(), TIMEOUT_MS);
        const resposta = await fetch(API_INSCRICAO, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(corpo),
          keepalive: true,
          signal: controle.signal
        });
        window.clearTimeout(relogio);
        if (resposta.status === 422 || resposta.status === 400) {
          const json = await resposta.json().catch(() => null);
          if (json && json.campos) camposComErro = json.campos;
        }
      } catch {
        // Rede caída: a pessoa não fica presa na porta. A sala abre e o registro vai em keepalive.
        try {
          const blob = new Blob([JSON.stringify(corpo)], { type: "application/json" });
          navigator.sendBeacon?.(API_INSCRICAO, blob);
        } catch {
          // sem sendBeacon: o registro se perde, mas o acesso da pessoa continua
        }
      }

      enviando = false;
      botao.disabled = false;
      botao.removeAttribute("aria-busy");
      if (status) status.textContent = "";

      if (camposComErro) {
        mostrarErrosDoServidor(camposComErro);
        return;
      }

      contatoAtual = contato;
      gravarJson(CHAVE_ACESSO, { id: sessaoId, liberado: true, em: Date.now(), contato, perfil: perfilEscolhido });
      pixel("track", "Lead");
      pixel("trackCustom", "replay_acesso", { pagina: pagina.id, perfil: P.PERFIL_CODIGO[perfilEscolhido] || null });
      abrirSala({ recemLiberado: true });
    });
  }

  /* ================================================================== */
  /* Início                                                             */
  /* ================================================================== */

  desenharCapa();
  desenharSumario();

  if (acessoValido()) {
    abrirSala();
  } else {
    desenharQuadro();
    // Trancada, o mural serve só para a contagem (prova social) — nenhum texto de terceiro chega.
    carregarMural({ reiniciar: true });
  }

  document.body.classList.add("pronto");
})();
