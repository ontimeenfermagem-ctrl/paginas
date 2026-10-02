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
  const ICONE_FORA =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 5h5v5m0-5-8 8M10 5H5v14h14v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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

  /*
   * A PORTA ANTES DE TUDO (acesso.portaPrimeiro): trancada, a página é só a capa e o formulário —
   * nada de quadro com cadeado, de sumário nem de vitrine. Preenchida, o resto aparece. Sem a
   * opção (a aferição), vale o desenho de sempre: a foto de abertura trancada dá vontade.
   */
  const PORTA_PRIMEIRO = Boolean(pagina.acesso && pagina.acesso.portaPrimeiro === true);
  const portaFechada = () => PORTA_PRIMEIRO && !liberada;

  function mostrarSala() {
    if (!PORTA_PRIMEIRO) return;
    for (const id of ["aula", "abertura-legenda"]) {
      const el = $(id);
      if (el) el.hidden = portaFechada();
    }
  }

  function desenharSumario() {
    const secao = $("sumario");
    const lista = $("sumario-lista");
    const itens = Array.isArray(pagina.sumario) ? pagina.sumario : [];
    if (!secao || !lista) return;
    if (!itens.length || portaFechada()) {
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

  // A aula da página: é ela que dá o título da matéria e que o botão da oferta vigia.
  const aula = (Array.isArray(pagina.aulas) && pagina.aulas[0]) || null;
  // O que o quadro mostra agora: a aula ou um dos conteúdos do dia (o card que a pessoa tocou).
  let emCartaz = aula;
  let tocando = false;
  // A aula estava aberta da última vez que o quadro a desenhou? Na hora da live, muda sozinho.
  let quadroDaAulaAberto = true;

  function desenharQuadro() {
    const alvo = $("abertura-quadro");
    const atual = emCartaz;
    if (!alvo || !atual) return;
    // O player que estava aqui sai da tela: o player limpo para os relógios dele, e o vigia da
    // oferta não tem mais o que medir.
    if (playerAtual) {
      playerAtual.destruir();
      playerAtual = null;
    }
    alvo.textContent = "";
    tocando = false;
    window.clearTimeout(relogioOferta);
    window.clearInterval(vigiaOferta);

    const quadro = document.createElement("button");
    quadro.type = "button";
    quadro.className = "abertura-quadro";
    // Short (9:16) em pé; aula e vídeo deitado no 16:9 de sempre.
    if (atual.vertical) quadro.classList.add("vertical");
    quadro.id = "quadro";

    const capa = R.capaDaAula(atual);
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
    const temVideo = R.videoValido(atual.video);
    let seloDaAgenda = null;
    // A aula com hora para abrir (a live): até lá, a thumb inteira e o selo com a data.
    const agendada = atual === aula && !R.aulaAberta(aula, Date.now());
    quadroDaAulaAberto = atual === aula ? !agendada : quadroDaAulaAberto;

    if (!liberada) {
      // Trancada: a foto de abertura aparece SEMPRE. É ela que dá vontade.
      centro.classList.add("abertura-trava");
      centro.append(icone(ICONE_CADEADO, ""));
      const legenda = document.createElement("p");
      legenda.className = "abertura-texto";
      legenda.textContent = (pagina.acesso && pagina.acesso.trava) || "A aula inteira está aqui";
      centro.append(legenda);
      quadro.setAttribute("aria-label", "Liberar o acesso para assistir à aula");
      quadro.addEventListener("click", irParaPorta);
    } else if (agendada) {
      // Ainda não é a hora: nada a tocar. A thumb é a estrela — inteira, sem nada por cima — e o
      // selo logo EMBAIXO dela diz quando abre (a contagem regressiva troca só o texto dele).
      quadro.classList.add("agendada");
      quadro.setAttribute("aria-disabled", "true");
      const libera = R.instanteDe(aula.liberaEm);
      seloDaAgenda = document.createElement("p");
      seloDaAgenda.className = "abertura-agenda";
      seloDaAgenda.dataset.libera = String(libera);
      const texto = document.createElement("span");
      texto.className = "abertura-agenda-texto";
      texto.textContent = `Ao vivo · ${R.rotuloDaLiberacao(libera, Date.now())}`;
      seloDaAgenda.append(icone(ICONE_CADEADO, ""), texto);
      quadro.setAttribute("aria-label", `${atual.titulo}: abre ${R.rotuloDaLiberacao(libera, Date.now())}`);
    } else if (temVideo) {
      const play = document.createElement("span");
      play.className = "abertura-play";
      play.append(icone(ICONE_PLAY, ""));
      centro.append(play);
      const legenda = document.createElement("p");
      legenda.className = "abertura-texto";
      legenda.textContent = atual === aula ? "Assistir a aula" : `Assistir · ${atual.rotulo}`;
      centro.append(legenda);
      quadro.setAttribute("aria-label", `Assistir: ${atual.titulo}`);
      quadro.addEventListener("click", () => tocar(quadro));
    } else {
      // Liberada, mas sem vídeo no config: o quadro avisa, não finge. A aula que ainda não
      // aconteceu diz o que acontece (o `aviso` dela, no config) em vez de prometer replay.
      quadro.setAttribute("aria-disabled", "true");
      const legenda = document.createElement("p");
      legenda.className = "abertura-texto";
      const aviso = typeof atual.aviso === "string" ? atual.aviso.trim() : "";
      legenda.textContent = aviso || "Estamos preparando o replay desta aula. Volte em instantes 💜";
      centro.append(legenda);
    }

    quadro.append(centro);
    alvo.append(quadro);
    if (seloDaAgenda) alvo.append(seloDaAgenda);

    // Um conteúdo tomou o quadro, mas a aula tem vídeo: o caminho de volta fica sempre à mão (o
    // tocar() troca só o quadro, então este botão continua embaixo do player).
    if (liberada && atual !== aula && aula) {
      const voltar = document.createElement("button");
      voltar.type = "button";
      voltar.className = "abertura-voltar";
      voltar.textContent = "Voltar para a aula principal";
      voltar.addEventListener("click", () => {
        emCartaz = aula;
        desenharQuadro();
        // A aula toca na hora se já abriu e tem vídeo; senão, o quadro mostra a capa dela.
        const quadroDaAula = $("quadro");
        if (quadroDaAula && R.aulaAberta(aula, Date.now()) && R.videoValido(aula.video)) tocar(quadroDaAula);
        desenharConteudos({ forcar: true });
        if (playerAtual) focarPlayer();
        else if ($("quadro")) $("quadro").focus({ preventScroll: true });
      });
      alvo.append(voltar);
    }
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

  /**
   * `controle` é o player limpo, quando é ele que está no quadro: ele já tem o player da API, e um
   * segundo YT.Player no mesmo iframe brigaria com o primeiro.
   */
  function vigiarOferta(frame, controle) {
    if (!OFERTA || ofertaAberta || !aula) return;
    relogioOferta = window.setTimeout(() => abrirOferta(), OFERTA.aposSegundos * 1000);
    if (aula.video.provedor !== "youtube") return;
    // A API respondeu: quem manda agora é o minuto do vídeo, e não o relógio.
    const medir = (player) => {
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
    };
    if (controle) {
      controle.quandoPronto(medir);
      return;
    }
    try {
      carregarApiDoYoutube(() => {
        try {
          const player = new window.YT.Player(frame, { events: { onReady: () => medir(player) } });
        } catch {
          // A API carregou mas não aceitou o player: fica o relógio.
        }
      });
    } catch {
      // Script bloqueado: fica o relógio.
    }
  }

  /* ================================================================== */
  /* O player limpo: o YouTube sem nada do YouTube                       */
  /* ================================================================== */
  /*
   * Liga com `playerLimpo: true` no config da sala, e só para vídeo do YouTube. O iframe nasce sem
   * os controles do YouTube (controls=0) e MAIS ALTO que o quadro: o vídeo se ajusta pela largura, e
   * as faixas de cima e de baixo — onde o YouTube desenha o título, o logo e o "assistir no
   * YouTube" — ficam fora da área visível. Por cima vai uma camada da página, que recebe todos os
   * toques: ninguém clica em nada do YouTube. Pausado ou no fim, a capa da aula cobre o vídeo (e,
   * com ela, as sugestões que o YouTube mostra). Os controles são os da Escola: tocar e pausar, a
   * barra do tempo, o som e a tela cheia.
   *
   * Duas saídas de emergência, de propósito:
   *  - o navegador não deixou o vídeo começar sozinho (o iPhone, às vezes): a camada fica "furada"
   *    até o vídeo começar, e o toque passa para o próprio vídeo — é o único jeito de o iPhone
   *    aceitar o play com som. Começou, a camada volta a cobrir tudo;
   *  - a API do YouTube não carregou (bloqueador, rede ruim): sem ela os nossos botões não mandam em
   *    nada, então o player volta a ser o do YouTube, com os controles dele. A aula toca do mesmo jeito.
   */
  const ICONE_PAUSA = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M7 5h3.6v14H7zm6.4 0H17v14h-3.6z" fill="currentColor"/></svg>';
  const ICONE_SOM =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6m2.6-8.6a7.8 7.8 0 0 1 0 11.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICONE_MUDO =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const ICONE_TELA =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICONE_TELA_SAIR =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 4v5H4m16 0h-5V4m0 16v-5h5M4 15h5v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICONE_DE_NOVO =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4.7h4.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // O player limpo que está no quadro agora (a página tem um quadro só).
  let playerAtual = null;

  function tempoLegivel(segundos) {
    const total = Math.max(0, Math.floor(Number(segundos) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function trocarIcone(botao, iconeHtml, rotulo) {
    botao.textContent = "";
    botao.append(icone(iconeHtml, ""));
    botao.setAttribute("aria-label", rotulo);
    botao.title = rotulo;
  }

  function botaoDoPlayer(classe, rotulo, iconeHtml) {
    const botao = document.createElement("button");
    botao.type = "button";
    botao.className = `player-botao ${classe}`;
    trocarIcone(botao, iconeHtml, rotulo);
    return botao;
  }

  /** Foco de TECLADO dentro do player: com ele, os controles não se escondem. */
  function focoDeTeclado(caixa) {
    const ativo = document.activeElement;
    if (!ativo || ativo === caixa || !caixa.contains(ativo)) return false;
    try {
      return ativo.matches(":focus-visible");
    } catch {
      return true;
    }
  }

  /**
   * Monta o player limpo no lugar do `quadro` e devolve o controle dele: { frame, quandoPronto(fn),
   * focar(), destruir() }. Devolve null quando o vídeo não é do YouTube (o tocar() usa o comum).
   */
  function montarPlayerLimpo(quadro, atual) {
    const url = atual.video && atual.video.provedor === "youtube" ? R.urlDoVideo(atual.video, { limpo: true }) : "";
    if (!url) return null;

    const caixa = document.createElement("div");
    caixa.className = "abertura-quadro player-limpo";
    if (atual.vertical) caixa.classList.add("vertical");
    caixa.dataset.estado = "carregando";

    const frame = document.createElement("iframe");
    // O origin faz o YouTube só aceitar ordem DESTA página.
    frame.src = `${url}&origin=${encodeURIComponent(window.location.origin)}`;
    frame.title = atual.titulo;
    frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture";
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    // O teclado não entra no player do YouTube: quem manda são os nossos botões.
    frame.tabIndex = -1;

    const capa = document.createElement("div");
    capa.className = "player-capa";
    const fonteDaCapa = R.capaDaAula(atual);
    if (fonteDaCapa) {
      const img = document.createElement("img");
      img.src = fonteDaCapa;
      img.alt = "";
      img.decoding = "async";
      img.addEventListener("error", () => img.remove());
      capa.append(img);
    }

    const camada = document.createElement("div");
    camada.className = "player-camada";

    const centro = document.createElement("div");
    centro.className = "player-centro";
    const grande = document.createElement("span");
    grande.className = "player-grande";
    grande.setAttribute("aria-hidden", "true");
    const giro = document.createElement("span");
    giro.className = "player-giro";
    giro.setAttribute("aria-hidden", "true");
    const dica = document.createElement("p");
    dica.className = "player-dica";
    centro.append(grande, giro, dica);

    const controles = document.createElement("div");
    controles.className = "player-controles";
    const botaoTocar = botaoDoPlayer("player-botao-tocar", "Tocar", ICONE_PLAY);
    const barra = document.createElement("input");
    barra.type = "range";
    barra.className = "player-barra";
    barra.min = "0";
    barra.max = "1000";
    barra.step = "1";
    barra.value = "0";
    barra.setAttribute("aria-label", "Posição do vídeo");
    const tempo = document.createElement("span");
    tempo.className = "player-tempo";
    tempo.textContent = "0:00";
    const botaoSom = botaoDoPlayer("player-botao-som", "Tirar o som", ICONE_SOM);
    controles.append(botaoTocar, barra, tempo, botaoSom);
    // Tela cheia só onde o navegador deixa pôr uma <div> em tela cheia (o iPhone não deixa).
    const podeTelaCheia = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    const botaoTela = podeTelaCheia ? botaoDoPlayer("player-botao-tela", "Tela cheia", ICONE_TELA) : null;
    if (botaoTela) controles.append(botaoTela);

    caixa.append(frame, capa, camada, centro, controles);
    quadro.replaceWith(caixa);

    let player = null;
    let pronto = false;
    let destruido = false;
    let duracao = 0;
    let arrastando = false;
    let ultimoToque = "";
    let vigia = 0;
    let relogioOcioso = 0;
    let relogioEspera = 0;
    let relogioApi = 0;
    let relogioRecem = 0;
    // O último estado que o YouTube contou: "carregando" (3) quer dizer que o play automático veio
    // e o vídeo só está baixando — não é hora de pedir o toque.
    let ultimoCodigo = -2;
    const naFila = [];

    const chamar = (acao) => {
      try {
        acao();
      } catch {
        // O player ainda não respondeu: o próximo toque tenta de novo.
      }
    };

    function pintarTempo(segundos) {
      const fracao = duracao > 0 ? Math.min(1, Math.max(0, segundos / duracao)) : 0;
      barra.value = String(Math.round(fracao * 1000));
      barra.style.setProperty("--feito", `${(fracao * 100).toFixed(2)}%`);
      const texto = `${tempoLegivel(segundos)} / ${tempoLegivel(duracao)}`;
      if (tempo.textContent !== texto) tempo.textContent = texto;
      barra.setAttribute("aria-valuetext", `${tempoLegivel(segundos)} de ${tempoLegivel(duracao)}`);
    }

    function lerTempo() {
      if (!player || arrastando) return;
      let segundos = 0;
      try {
        segundos = Number(player.getCurrentTime()) || 0;
        duracao = Number(player.getDuration()) || duracao;
      } catch {
        return;
      }
      pintarTempo(segundos);
    }

    function pararVigia() {
      window.clearInterval(vigia);
      vigia = 0;
    }

    function acordar() {
      caixa.classList.remove("ocioso");
      window.clearTimeout(relogioOcioso);
      if (caixa.dataset.estado !== "tocando") return;
      relogioOcioso = window.setTimeout(() => {
        if (!destruido && caixa.dataset.estado === "tocando" && !focoDeTeclado(caixa)) caixa.classList.add("ocioso");
      }, 2600);
    }

    function estado(novo) {
      caixa.dataset.estado = novo;
      const tocandoAgora = novo === "tocando";
      if (tocandoAgora) trocarIcone(botaoTocar, ICONE_PAUSA, "Pausar");
      else if (novo === "fim") trocarIcone(botaoTocar, ICONE_DE_NOVO, "Assistir de novo");
      else trocarIcone(botaoTocar, ICONE_PLAY, "Tocar");
      grande.textContent = "";
      grande.append(icone(tocandoAgora ? ICONE_PAUSA : novo === "fim" ? ICONE_DE_NOVO : ICONE_PLAY, ""));
      /*
       * A cada play, o YouTube mostra o botão de pausa DELE no meio do vídeo (medido: de 0,3 s até
       * ~3,8 s depois do play, no começo e na volta da pausa). Nesse tempo o nosso fica por cima, no
       * mesmo lugar (o centro do iframe é o centro do quadro), e some devagar depois — para quem
       * assiste, é o player da página dizendo "está tocando".
       */
      window.clearTimeout(relogioRecem);
      caixa.classList.toggle("recem", tocandoAgora);
      if (tocandoAgora) {
        relogioRecem = window.setTimeout(() => {
          if (!destruido) caixa.classList.remove("recem");
        }, 4600);
      }
      dica.textContent =
        novo === "aguardando"
          ? "Toque no vídeo para começar"
          : novo === "fim"
            ? "Assistir de novo"
            : novo === "erro"
              ? "Não deu para carregar este vídeo agora. Tente de novo em instantes."
              : "";
      if (tocandoAgora) {
        if (!vigia) vigia = window.setInterval(lerTempo, 250);
        acordar();
      } else {
        pararVigia();
        window.clearTimeout(relogioOcioso);
        caixa.classList.remove("ocioso");
      }
    }

    function tocarOuPausar() {
      if (!player || !pronto) return;
      const agora = caixa.dataset.estado;
      if (agora === "tocando") {
        chamar(() => player.pauseVideo());
        return;
      }
      if (agora === "fim") chamar(() => player.seekTo(0, true));
      chamar(() => player.playVideo());
      // Se o navegador não deixar (o play não vem), o próximo toque vai direto para o vídeo.
      window.clearTimeout(relogioEspera);
      relogioEspera = window.setTimeout(() => {
        if (!destruido && caixa.dataset.estado !== "tocando") estado("aguardando");
      }, 1500);
    }

    camada.addEventListener("pointerdown", (evento) => {
      ultimoToque = evento.pointerType || "";
    });
    camada.addEventListener("click", () => {
      // No celular, com os controles escondidos, o primeiro toque só traz os controles de volta.
      if (ultimoToque === "touch" && caixa.dataset.estado === "tocando" && caixa.classList.contains("ocioso")) {
        acordar();
        return;
      }
      tocarOuPausar();
      acordar();
    });
    botaoTocar.addEventListener("click", tocarOuPausar);
    caixa.addEventListener("pointermove", acordar);
    caixa.addEventListener("focusin", acordar);

    barra.addEventListener("input", () => {
      arrastando = true;
      pintarTempo((Number(barra.value) / 1000) * duracao);
      acordar();
    });
    barra.addEventListener("change", () => {
      arrastando = false;
      if (player && duracao > 0) chamar(() => player.seekTo((Number(barra.value) / 1000) * duracao, true));
    });

    botaoSom.addEventListener("click", () => {
      if (!player || !pronto) return;
      let mudo = false;
      try {
        mudo = Boolean(player.isMuted());
      } catch {
        mudo = false;
      }
      chamar(() => (mudo ? player.unMute() : player.mute()));
      trocarIcone(botaoSom, mudo ? ICONE_SOM : ICONE_MUDO, mudo ? "Tirar o som" : "Ligar o som");
    });

    const emTelaCheia = () => (document.fullscreenElement || document.webkitFullscreenElement) === caixa;
    const aoMudarTela = () => {
      if (!destruido && botaoTela) {
        const cheia = emTelaCheia();
        trocarIcone(botaoTela, cheia ? ICONE_TELA_SAIR : ICONE_TELA, cheia ? "Sair da tela cheia" : "Tela cheia");
      }
    };
    if (botaoTela) {
      botaoTela.addEventListener("click", () => {
        try {
          const pedido = emTelaCheia()
            ? (document.exitFullscreen || document.webkitExitFullscreen).call(document)
            : (caixa.requestFullscreen || caixa.webkitRequestFullscreen).call(caixa);
          if (pedido && typeof pedido.catch === "function") pedido.catch(() => {});
        } catch {
          // Sem tela cheia neste navegador: o vídeo continua no quadro.
        }
      });
      document.addEventListener("fullscreenchange", aoMudarTela);
      document.addEventListener("webkitfullscreenchange", aoMudarTela);
    }

    function aoFicarPronto(evento) {
      if (destruido) return;
      window.clearTimeout(relogioApi);
      if (evento && evento.target) player = evento.target;
      pronto = true;
      try {
        duracao = Number(player.getDuration()) || 0;
      } catch {
        duracao = 0;
      }
      pintarTempo(0);
      for (const avisar of naFila.splice(0)) chamar(() => avisar(player));
      esperarOPlay();
    }

    // O play automático não veio (o navegador não deixou): o toque passa a ir para o vídeo. Se o
    // YouTube ainda está baixando o vídeo, espera mais um pouco antes de pedir o toque.
    function esperarOPlay() {
      window.clearTimeout(relogioEspera);
      relogioEspera = window.setTimeout(() => {
        if (destruido || caixa.dataset.estado !== "carregando") return;
        if (ultimoCodigo === 3) esperarOPlay();
        else estado("aguardando");
      }, 2200);
    }

    function aoMudarEstado(evento) {
      if (destruido) return;
      const codigo = evento && typeof evento.data === "number" ? evento.data : -2;
      ultimoCodigo = codigo;
      caixa.classList.toggle("carregando-video", codigo === 3);
      if (codigo === 1) {
        window.clearTimeout(relogioEspera);
        estado("tocando");
      } else if (codigo === 2) {
        estado("pausado");
        lerTempo();
      } else if (codigo === 0) {
        estado("fim");
        pintarTempo(duracao);
      }
    }

    // Sem a API, os nossos botões não mandam em nada: volta o player do YouTube, com os controles dele.
    function semApi() {
      if (destruido || pronto) return;
      caixa.classList.add("sem-api");
      caixa.dataset.estado = "sem-api";
      frame.tabIndex = 0;
      frame.setAttribute("allowfullscreen", "");
      frame.src = R.urlDoVideo(atual.video);
    }

    relogioApi = window.setTimeout(semApi, 6000);
    try {
      carregarApiDoYoutube(() => {
        if (destruido || caixa.classList.contains("sem-api")) return;
        try {
          player = new window.YT.Player(frame, {
            events: { onReady: aoFicarPronto, onStateChange: aoMudarEstado, onError: () => estado("erro") }
          });
        } catch {
          semApi();
        }
      });
    } catch {
      semApi();
    }
    estado("carregando");

    return {
      frame,
      quandoPronto(avisar) {
        if (pronto && player) chamar(() => avisar(player));
        else naFila.push(avisar);
      },
      focar() {
        if (caixa.classList.contains("sem-api")) frame.focus({ preventScroll: true });
        else botaoTocar.focus({ preventScroll: true });
      },
      destruir() {
        destruido = true;
        pararVigia();
        window.clearTimeout(relogioOcioso);
        window.clearTimeout(relogioEspera);
        window.clearTimeout(relogioApi);
        window.clearTimeout(relogioRecem);
        document.removeEventListener("fullscreenchange", aoMudarTela);
        document.removeEventListener("webkitfullscreenchange", aoMudarTela);
      }
    };
  }

  function tocar(quadro) {
    const atual = emCartaz;
    const url = atual ? R.urlDoVideo(atual.video) : "";
    if (!url) return;
    // A sala com player limpo e vídeo do YouTube: o nosso player. Senão, o do provedor.
    const controle = pagina.playerLimpo === true ? montarPlayerLimpo(quadro, atual) : null;
    let frame = controle ? controle.frame : null;
    if (!controle) {
      const moldura = document.createElement("div");
      moldura.className = "abertura-quadro";
      if (atual.vertical) moldura.classList.add("vertical");
      frame = document.createElement("iframe");
      frame.src = url;
      frame.title = atual.titulo;
      // Tela cheia só pelo allowfullscreen: com "fullscreen" também no allow, o Chrome avisa que um
      // dos dois é ignorado.
      frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture";
      frame.setAttribute("allowfullscreen", "");
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      moldura.append(frame);
      quadro.replaceWith(moldura);
    }
    playerAtual = controle;
    tocando = true;
    // A oferta é o momento da AULA: conteúdo de aquecimento não abre o botão.
    if (atual === aula) vigiarOferta(frame, controle);
    // A decoração sai da frente enquanto a aula roda (só decoração: texto nenhum perde contraste).
    document.body.classList.add("assistindo");
    pixel("trackCustom", "replay_play", { pagina: pagina.id, aula: atual.id });
    anunciar(atual === aula ? "A aula começou." : `${atual.titulo} começou.`);
  }

  /* ================================================================== */
  /* Os conteúdos: um card por dia                                       */
  /* ================================================================== */
  /*
   * Os cards de js/replay-config.js (conteudos). Cada um abre sozinho na data dele (o config diz
   * quando, R.conteudosDaPagina diz o estado). Com a sala trancada, os cards aparecem mesmo assim —
   * a vitrine dá vontade, como a foto de abertura — e o toque leva ao formulário. Liberada, o card
   * de vídeo toca NO QUADRO lá de cima (o mesmo player da aula); o de link abre em outra aba.
   */
  let assinaturaConteudos = "";
  let relogioConteudos = 0;

  function conteudosAgora() {
    return R.conteudosDaPagina(pagina, Date.now());
  }

  /** O conteúdo no formato que o quadro entende: a thumb do card vira a capa do player. */
  function comoAula(item) {
    return { id: item.id, titulo: R.nomeDoConteudo(item), rotulo: item.rotulo, capa: item.imagem, video: item.video, vertical: item.vertical };
  }

  /**
   * O que o quadro mostra quando a sala abre: a aula, se ela já tem vídeo; senão o conteúdo
   * liberado mais recente (o do dia); senão a aula, com o aviso dela.
   */
  function escolherEmCartaz() {
    // A aula principal vem PRIMEIRO, mesmo antes da hora dela (o quadro mostra a capa e a data).
    if (aula) return aula;
    let melhor = null;
    for (const item of conteudosAgora()) {
      if (item.estado === "liberado" && item.video && (!melhor || item.liberaEm >= melhor.liberaEm)) melhor = item;
    }
    return melhor ? comoAula(melhor) : aula;
  }

  function irParaPorta() {
    const porta = $("porta");
    if (!porta) return;
    porta.scrollIntoView({ behavior: "smooth", block: "center" });
    const primeiro = $("campo-nome");
    if (primeiro) window.setTimeout(() => primeiro.focus({ preventScroll: true }), 320);
  }

  /** O foco vai para o player que acabou de nascer: é lá que a pessoa está agora. */
  function focarPlayer() {
    if (playerAtual) {
      playerAtual.focar();
      return;
    }
    const frame = document.querySelector("#aula iframe");
    if (frame) frame.focus({ preventScroll: true });
  }

  function assistirConteudo(item) {
    const secao = $("aula");
    // O card que já está tocando só leva até o player: tocar de novo voltaria o vídeo ao zero.
    if (!(tocando && emCartaz && emCartaz !== aula && emCartaz.id === item.id)) {
      emCartaz = comoAula(item);
      desenharQuadro();
      const quadro = $("quadro");
      if (quadro) tocar(quadro);
      // Os cards só depois do play: com nada tocando, o redesenho trocaria a escolha da pessoa
      // pelo conteúdo do dia.
      desenharConteudos({ forcar: true });
    }
    if (secao) secao.scrollIntoView({ behavior: "smooth", block: "center" });
    focarPlayer();
  }

  function cardDoConteudo(item) {
    const li = document.createElement("li");
    li.className = "conteudo";
    li.dataset.conteudo = item.id;
    li.dataset.estado = item.estado;
    // O instante em que abre, para a contagem regressiva trocar só o texto, sem redesenhar o card.
    li.dataset.libera = String(item.liberaEm);
    if (item.destaque) li.classList.add("conteudo--destaque");
    if (item.vertical) li.classList.add("conteudo--vertical");
    const noQuadro = Boolean(emCartaz && emCartaz.id === item.id);

    let cartao;
    let acao = "";
    let iconeHtml = ICONE_CADEADO;
    if (item.estado === "liberado" && !liberada) {
      // Já abriu, mas a sala está trancada: o card é o da aula liberada (colorido, com o play, sem
      // cadeado nenhum), e o toque leva ao formulário — preenchido, ESTA aula começa a tocar.
      cartao = document.createElement("button");
      cartao.type = "button";
      cartao.addEventListener("click", () => {
        conteudoPedido = item.id;
        irParaPorta();
      });
      acao = "Assistir agora";
      iconeHtml = item.video ? ICONE_PLAY : ICONE_FORA;
    } else if (item.estado === "liberado" && item.video) {
      cartao = document.createElement("button");
      cartao.type = "button";
      if (noQuadro) cartao.setAttribute("aria-current", "true");
      cartao.addEventListener("click", () => assistirConteudo(item));
      acao = noQuadro ? "No quadro lá em cima" : "Assistir agora";
      iconeHtml = ICONE_PLAY;
    } else if (item.estado === "liberado") {
      cartao = document.createElement("a");
      cartao.href = item.link;
      cartao.target = "_blank";
      cartao.rel = "noopener noreferrer";
      cartao.addEventListener("click", () => pixel("trackCustom", "replay_conteudo", { pagina: pagina.id, conteudo: item.id }));
      acao = "Abrir";
      iconeHtml = ICONE_FORA;
    } else {
      // Trancado (ainda não é a hora) ou chegando (é a hora, mas o vídeo não subiu): preto e
      // branco, com o cadeado, e nada a tocar — um <div>, não botão nem link.
      cartao = document.createElement("div");
      const quando = R.rotuloDaLiberacao(item.liberaEm, Date.now());
      acao = item.estado === "chegando" || !quando ? "Em breve" : `Abre ${quando}`;
    }
    cartao.className = "conteudo-cartao";

    // A arte: o número da marca fica SEMPRE por baixo; a imagem do config cobre quando existe, e
    // some se o arquivo ainda não subiu — o card nunca mostra buraco.
    const arte = document.createElement("span");
    arte.className = "conteudo-arte";
    const numero = document.createElement("span");
    numero.className = "conteudo-numero";
    numero.setAttribute("aria-hidden", "true");
    numero.textContent = item.marca || String(item.numero).padStart(2, "0");
    arte.append(numero);
    if (item.imagem) {
      const img = document.createElement("img");
      img.src = item.imagem;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => img.remove());
      arte.append(img);
    }
    if (item.novo) {
      const selo = document.createElement("span");
      selo.className = "conteudo-novo";
      selo.textContent = "Novo";
      arte.append(selo);
    }
    const marcaDoIcone = icone(iconeHtml, "conteudo-icone");
    marcaDoIcone.dataset.icone = iconeHtml === ICONE_PLAY ? "play" : iconeHtml === ICONE_FORA ? "fora" : "cadeado";
    arte.append(marcaDoIcone);

    const texto = document.createElement("span");
    texto.className = "conteudo-texto";
    const rotulo = document.createElement("span");
    rotulo.className = "conteudo-rotulo";
    rotulo.textContent = item.rotulo;
    texto.append(rotulo);
    if (item.titulo) {
      const titulo = document.createElement("strong");
      titulo.className = "conteudo-titulo";
      titulo.textContent = item.titulo;
      texto.append(titulo);
    }
    const estado = document.createElement("span");
    estado.className = "conteudo-estado";
    estado.textContent = acao;
    texto.append(estado);

    cartao.append(arte, texto);
    li.append(cartao);
    return li;
  }

  /*
   * A VITRINE: os cards deslizam de lado em qualquer tela — no celular com o dedo, no computador com
   * as setas (ou a roda e o trackpad). Ela vai de borda a borda da tela, com o primeiro card
   * alinhado à coluna do texto; os pontinhos embaixo dizem onde a pessoa está e levam a cada aula.
   */
  let conteudoPedido = "";
  let quadroDeRolagem = 0;

  const semMovimento = () => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };

  function atualizarSetas() {
    const lista = $("conteudos-lista");
    const antes = $("vitrine-antes");
    const depois = $("vitrine-depois");
    if (!lista || !antes || !depois) return;
    const transborda = lista.scrollWidth > lista.clientWidth + 1;
    antes.hidden = !transborda;
    depois.hidden = !transborda;
    if (!transborda) return;
    antes.disabled = lista.scrollLeft <= 2;
    depois.disabled = lista.scrollLeft + lista.clientWidth >= lista.scrollWidth - 2;
  }

  /** Os pontinhos acesos são os cards que estão (quase inteiros) na tela. */
  function marcarPontos() {
    const lista = $("conteudos-lista");
    const pontos = $("vitrine-pontos");
    if (!lista || !pontos || pontos.hidden) return;
    const janela = lista.getBoundingClientRect();
    const naTela = new Set();
    for (const li of lista.children) {
      const caixa = li.getBoundingClientRect();
      const dentro = Math.min(caixa.right, janela.right) - Math.max(caixa.left, janela.left);
      if (caixa.width > 0 && dentro >= caixa.width * 0.6) naTela.add(li.dataset.conteudo);
    }
    for (const ponto of pontos.children) ponto.setAttribute("aria-current", naTela.has(ponto.dataset.conteudo) ? "true" : "false");
  }

  function irParaCard(id) {
    const lista = $("conteudos-lista");
    const li = lista ? Array.from(lista.children).find((el) => el.dataset.conteudo === id) : null;
    if (!li) return;
    const respiro = parseFloat(window.getComputedStyle(lista).scrollPaddingLeft) || 0;
    lista.scrollTo({ left: Math.max(0, li.offsetLeft - respiro), behavior: semMovimento() ? "auto" : "smooth" });
  }

  function deslizar(sentido) {
    const lista = $("conteudos-lista");
    if (!lista) return;
    const vitrine = $("vitrine");
    // Um passo é a largura da COLUNA (o que se vê entre as setas), não a da tela inteira.
    const coluna = vitrine && vitrine.parentElement ? vitrine.parentElement.clientWidth : lista.clientWidth;
    lista.scrollBy({ left: sentido * Math.max(160, coluna * 0.9), behavior: semMovimento() ? "auto" : "smooth" });
  }

  function desenharPontos(itens) {
    const pontos = $("vitrine-pontos");
    if (!pontos) return;
    pontos.textContent = "";
    for (const item of itens) {
      const ponto = document.createElement("button");
      ponto.type = "button";
      ponto.className = "vitrine-ponto";
      ponto.dataset.conteudo = item.id;
      ponto.setAttribute("aria-label", `Ir para ${R.nomeDoConteudo(item)}`);
      ponto.addEventListener("click", () => irParaCard(item.id));
      pontos.append(ponto);
    }
    pontos.hidden = itens.length < 2;
  }

  /**
   * Mede a vitrine: quanto ela sangra para cada lado (--borda, da borda da coluna até a borda da
   * tela), se transborda (aí a lista entra no Tab — o Safari não deixa o teclado rolar um contêiner
   * sem foco), as setas e os pontinhos.
   */
  function ajustarVitrine() {
    const secao = $("conteudos");
    const lista = $("conteudos-lista");
    if (!secao || !lista || secao.hidden) return;
    const vitrine = $("vitrine");
    if (vitrine && vitrine.parentElement) {
      const sobra = Math.max(0, (document.documentElement.clientWidth - vitrine.parentElement.clientWidth) / 2);
      vitrine.style.setProperty("--borda", `${Math.floor(sobra)}px`);
    }
    if (lista.scrollWidth > lista.clientWidth + 1) lista.tabIndex = 0;
    else lista.removeAttribute("tabindex");
    atualizarSetas();
    marcarPontos();
  }

  window.addEventListener("resize", ajustarVitrine);
  (() => {
    const lista = $("conteudos-lista");
    if (lista) {
      lista.addEventListener(
        "scroll",
        () => {
          if (quadroDeRolagem) return;
          quadroDeRolagem = window.requestAnimationFrame(() => {
            quadroDeRolagem = 0;
            atualizarSetas();
            marcarPontos();
          });
        },
        { passive: true }
      );
    }
    const antes = $("vitrine-antes");
    const depois = $("vitrine-depois");
    if (antes) antes.addEventListener("click", () => deslizar(-1));
    if (depois) depois.addEventListener("click", () => deslizar(1));
  })();

  /*
   * A CONTAGEM REGRESSIVA: de tempos em tempos, só o texto dos cards trancados muda ("Abre em
   * 1h 09min" → "Abre em 1h 08min"). Nada é redesenhado — quem destrava o card na hora certa é o
   * agendarConteudos.
   */
  let relogioContagem = 0;

  function atualizarContagem() {
    const agora = Date.now();
    for (const selo of document.querySelectorAll(".abertura-agenda[data-libera]")) {
      const quando = R.rotuloDaLiberacao(Number(selo.dataset.libera), agora);
      const texto = selo.querySelector(".abertura-agenda-texto");
      if (texto && quando && texto.textContent !== `Ao vivo · ${quando}`) texto.textContent = `Ao vivo · ${quando}`;
    }
    for (const li of document.querySelectorAll('#conteudos-lista > li[data-estado="trancado"], #conteudos-destaque > li[data-estado="trancado"]')) {
      const quando = R.rotuloDaLiberacao(Number(li.dataset.libera), agora);
      const estado = li.querySelector(".conteudo-estado");
      if (estado && quando && estado.textContent !== `Abre ${quando}`) estado.textContent = `Abre ${quando}`;
    }
  }

  /** Quando o próximo conteúdo abre com a página aberta, o card destrava sem recarregar. */
  function agendarConteudos() {
    window.clearTimeout(relogioConteudos);
    const agora = Date.now();
    let proxima = R.proximaLiberacao(pagina, agora);
    // A hora da aula principal (a live) também redesenha a sala, sem ninguém atualizar a página.
    const daAula = aula ? R.instanteDe(aula.liberaEm) : NaN;
    if (Number.isFinite(daAula) && daAula > agora && (proxima === null || daAula < proxima)) proxima = daAula;
    if (proxima === null) return;
    const espera = proxima - Date.now() + 1000;
    // O setTimeout não aguenta mais de ~24 dias: o que abre depois disso fica para a próxima visita.
    if (espera > 0 && espera < 2147483647) relogioConteudos = window.setTimeout(() => desenharConteudos(), espera);
  }

  function desenharConteudos({ forcar = false } = {}) {
    const secao = $("conteudos");
    const lista = $("conteudos-lista");
    if (!secao || !lista) return;
    const fio = $("fio-conteudos");
    const nav = $("nav-conteudos");
    const itens = conteudosAgora();
    agendarConteudos();

    // A porta fechada esconde a vitrine inteira (e o card em destaque).
    if (portaFechada()) {
      secao.hidden = true;
      if (fio) fio.hidden = true;
      if (nav) nav.hidden = true;
      for (const id of ["conteudos-destaque", "fio-destaque"]) {
        const el = $(id);
        if (el) el.hidden = true;
      }
      return;
    }

    // Chegou a hora da aula principal com o quadro parado nela: o quadro troca a capa pelo play.
    if (liberada && !tocando && emCartaz === aula && aula && R.aulaAberta(aula, Date.now()) !== quadroDaAulaAberto) {
      desenharQuadro();
    }

    if (!itens.length) {
      secao.hidden = true;
      if (fio) fio.hidden = true;
      if (nav) nav.hidden = true;
      return;
    }

    // Abriu conteúdo novo com a sala aberta e nada tocando: o quadro passa para o do dia. (Com
    // vídeo tocando, nada muda no quadro — só os cards.)
    if (liberada && !tocando) {
      const melhor = escolherEmCartaz();
      if (melhor && (!emCartaz || melhor.id !== emCartaz.id)) {
        emCartaz = melhor;
        desenharQuadro();
      }
    }

    // Só redesenha quando algo mudou: o card que está com o foco não o perde à toa.
    const assinatura = [liberada ? 1 : 0, emCartaz ? emCartaz.id : ""]
      .concat(itens.map((item) => `${item.id}:${item.estado}:${item.novo ? 1 : 0}`))
      .join("|");
    if (!forcar && assinatura === assinaturaConteudos) return;
    assinaturaConteudos = assinatura;

    const c = pagina.conteudos || {};
    escreverTexto("conteudos-rotulo", c.titulo || "Conteúdos");
    const apoio = $("conteudos-apoio");
    if (apoio) {
      apoio.textContent = c.apoio || "";
      apoio.hidden = !c.apoio;
    }
    // Redesenhar troca os nós: quem estava com o foco num card volta para o MESMO card (pelo id,
    // comparado como valor — nada de seletor montado com texto do config).
    // O card em destaque (a live) sai da vitrine e fica sozinho, largo, no bloco dele.
    const listaDestaque = $("conteudos-destaque");
    const ativo = document.activeElement;
    const liFocado = ativo && ativo.closest ? ativo.closest("li[data-conteudo]") : null;
    const idFocado =
      liFocado && (lista.contains(liFocado) || (listaDestaque && listaDestaque.contains(liFocado))) ? liFocado.dataset.conteudo : "";

    const daVitrine = listaDestaque ? itens.filter((item) => !item.destaque) : itens;
    const emDestaque = listaDestaque ? itens.filter((item) => item.destaque) : [];

    lista.textContent = "";
    for (const item of daVitrine) lista.append(cardDoConteudo(item));
    if (listaDestaque) {
      listaDestaque.textContent = "";
      for (const item of emDestaque) listaDestaque.append(cardDoConteudo(item));
      listaDestaque.hidden = emDestaque.length === 0;
      const fioDestaque = $("fio-destaque");
      if (fioDestaque) fioDestaque.hidden = emDestaque.length === 0;
    }
    const vitrine = $("vitrine");
    if (vitrine) vitrine.classList.toggle("vitrine--vertical", daVitrine.some((item) => item.vertical));
    desenharPontos(daVitrine);

    secao.hidden = false;
    if (fio) fio.hidden = false;
    if (nav) nav.hidden = false;
    ajustarVitrine();
    if (!relogioContagem) relogioContagem = window.setInterval(atualizarContagem, 20000);

    if (idFocado) {
      const todos = Array.from(lista.children).concat(listaDestaque ? Array.from(listaDestaque.children) : []);
      const li = todos.find((el) => el.dataset.conteudo === idFocado);
      const alvo = li ? li.querySelector("button, a") : null;
      if (alvo) alvo.focus({ preventScroll: true });
    }
  }

  // Quem deixa a aba aberta e volta no dia seguinte encontra o card do dia já destravado.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) desenharConteudos();
  });

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
    mostrarSala();
    desenharSumario();
    emCartaz = escolherEmCartaz();
    desenharQuadro();
    desenharConteudos({ forcar: true });
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
      // Tocou numa aula liberada antes de preencher: é ELA que começa agora.
      const pedido = conteudoPedido ? conteudosAgora().find((item) => item.id === conteudoPedido) : null;
      conteudoPedido = "";
      if (pedido && pedido.estado === "liberado" && pedido.video) assistirConteudo(pedido);
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
    mostrarSala();
    desenharQuadro();
    desenharConteudos();
    // Trancada, o mural serve só para a contagem (prova social) — nenhum texto de terceiro chega.
    carregarMural({ reiniciar: true });
  }

  document.body.classList.add("pronto");
})();
