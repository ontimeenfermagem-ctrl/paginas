/*
 * pesquisa.js — o formulário conversacional da pesquisa de ICP (pesquisa.html).
 *
 * Toda regra de pergunta (quais aparecem, o que é resposta válida, progresso) vem de
 * EVPesquisa (js/pesquisa-config.js) e toda regra de contato vem de EVLeadRules
 * (js/lead-rules.js). Este arquivo só cuida de tela, rascunho no aparelho e envio. Assim o
 * servidor, que carrega os mesmos dois arquivos, nunca discorda do que a tela aceitou.
 *
 * Princípio que guia tudo aqui: nenhuma resposta pode se perder. O rascunho vai para o
 * localStorage a cada toque; o envio ao servidor passa por uma fila que re-tenta sozinha; e
 * quem fecha a aba no meio ainda manda o estado com keepalive.
 */
(function () {
  "use strict";

  const P = window.EVPesquisa;
  const L = window.EVLeadRules;
  if (!P || !L) return;
  // Páginas de obrigado (js/obrigado-config.js). Sem elas, a pesquisa termina na tela de fim.
  const O = window.EVObrigado || null;

  /* ================================================================== */
  /* Constantes                                                          */
  /* ================================================================== */

  const CHAVE_VISITANTE = "ev_pesquisa_visitante";
  const CHAVE_RASCUNHO = "ev_pesquisa_icp_v1";
  const API_SALVAR = "/api/pesquisa/salvar";
  const API_EVENTO = "/api/pesquisa/evento";

  /** Mais que isto esperando o servidor e a tela de contato segue sem ele (a fila re-tenta). */
  const TIMEOUT_MS = 12000;
  /** Pausa entre o toque na opção e a próxima pergunta: dá tempo de ver a marcação. */
  const ATRASO_AVANCO = 300;
  // Logo depois que uma pergunta aparece, as opções ignoram toques: quem toca duas vezes (achou
  // que o primeiro toque não pegou) não responde a pergunta seguinte sem vê-la.
  const TRAVA_TOQUE_MS = 500;
  /** Duração dos "três pontinhos" antes da fala de cada etapa. */
  const DIGITANDO_MS = 600;
  /** Texto livre vai ao servidor depois desta pausa na digitação (e sempre ao sair da tela). */
  const PAUSA_TEXTO_MS = 1200;
  const BACKOFF_INICIAL_MS = 2000;
  const BACKOFF_TETO_MS = 30000;
  /** Ao concluir, espera o servidor confirmar o último salvamento até isto antes de sair. */
  const ESPERA_SALVAR_FIM_MS = 2500;
  /** Na 1ª conclusão, fica ao menos isto no "obrigada" (o Pixel sai antes da troca de página). */
  const ESPERA_MINIMA_FIM_MS = 700;

  const CAMPOS_RASTREIO = [
    "page_url",
    "referrer",
    "dispositivo",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "fbclid",
    "gclid"
  ];
  const TETO_RASTREIO = { page_url: 2048, referrer: 2048, fbclid: 1000, gclid: 1000 };

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const INSTRUCAO = {
    unica: "Toque na opção que combina com você",
    multipla: "Pode marcar mais de uma",
    escala: "Toque em um número de 0 a 10",
    lista: "Escolha na lista",
    texto: "Escreva do seu jeito · opcional",
    frase: "Escreva do seu jeito · opcional"
  };

  const reduzMovimento = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ehDesktop = () => window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  /* ================================================================== */
  /* Elementos fixos da página                                           */
  /* ================================================================== */

  const $ = (id) => document.getElementById(id);

  const telas = {
    boasvindas: $("tela-boasvindas"),
    contato: $("tela-contato"),
    pergunta: $("tela-pergunta"),
    fim: $("tela-fim")
  };

  const topo = $("topo");
  const topoEtapa = $("topo-etapa");
  const topoPct = $("topo-pct");
  const barra = $("barra");
  const barraPreenchida = $("barra-preenchida");
  const salvamento = $("salvamento");
  const salvamentoTexto = $("salvamento-texto");
  const rodape = $("rodape");
  const botaoContinuar = $("botao-continuar");
  const botaoPular = $("botao-pular");
  const aviso = $("aviso");

  const form = $("form-contato");
  const campos = { nome: $("campo-nome"), whatsapp: $("campo-whatsapp"), email: $("campo-email") };
  const CHAVE_MENSAGEM = { nome: "name", whatsapp: "phone", email: "email" };

  /* ================================================================== */
  /* Armazenamento — sempre em try/catch                                 */
  /* ================================================================== */
  // Navegador anônimo do iPhone e alguns webviews jogam exceção só de tocar no localStorage.
  // Sem ele a pesquisa funciona igual; só não dá para retomar depois.

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
      // Cheio ou bloqueado: a pesquisa segue, só não retoma.
    }
  }

  /* ================================================================== */
  /* Identificadores                                                     */
  /* ================================================================== */

  function novoUuid() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === "function") {
      try {
        return c.randomUUID();
      } catch {
        // randomUUID só existe em contexto seguro; cai no getRandomValues.
      }
    }
    const bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    // Versão 4 e variante RFC 4122, para o servidor aceitar como UUID de verdade.
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
  /* Rastreio de primeiro toque                                          */
  /* ================================================================== */

  function dispositivo() {
    const largura = window.innerWidth || document.documentElement.clientWidth || 0;
    if (largura < 768) return "mobile";
    if (largura < 1024) return "tablet";
    return "desktop";
  }

  function textoRastreio(valor, campo) {
    if (valor == null) return null;
    const limpo = String(valor).trim().slice(0, TETO_RASTREIO[campo] || 500);
    return limpo || null;
  }

  function rastreioDestaVisita() {
    const query = new URLSearchParams(window.location.search);
    const dados = {
      // Sem o #: âncora não diz nada sobre a origem e pode carregar lixo.
      page_url: textoRastreio(window.location.origin + window.location.pathname + window.location.search, "page_url"),
      referrer: textoRastreio(document.referrer, "referrer"),
      dispositivo: dispositivo()
    };
    for (const campo of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"]) {
      dados[campo] = textoRastreio(query.get(campo), campo);
    }
    return dados;
  }

  /** O que já estava guardado ganha; a visita nova só preenche o que faltava. */
  // Campanha (utm_* + fbclid + gclid) é um bloco só de primeiro toque: se a primeira visita tinha
  // qualquer um, fica o bloco dela inteiro; senão, o da visita nova. Misturar campo a campo
  // creditaria uma campanha do Facebook à bio do Instagram, por exemplo.
  const CAMPOS_CAMPANHA = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"];

  function mesclarRastreio(antigo, novo) {
    const saida = {};
    const texto = (fonte, campo) => (fonte && typeof fonte[campo] === "string" && fonte[campo] ? fonte[campo] : null);
    const blocoAntigo = CAMPOS_CAMPANHA.some((campo) => texto(antigo, campo));
    for (const campo of CAMPOS_RASTREIO) {
      if (CAMPOS_CAMPANHA.includes(campo)) saida[campo] = blocoAntigo ? texto(antigo, campo) : (novo && novo[campo]) || null;
      else saida[campo] = texto(antigo, campo) || (novo && novo[campo]) || null;
    }
    if (!["mobile", "tablet", "desktop"].includes(saida.dispositivo)) saida.dispositivo = dispositivo();
    return saida;
  }

  /* ================================================================== */
  /* Rascunho                                                            */
  /* ================================================================== */
  // Um único objeto guarda tudo o que a pessoa já fez. É ele que vai para o localStorage e é
  // dele que sai o corpo de cada salvamento.

  function rascunhoNovo(rastreio, contato) {
    return {
      versao: P.VERSAO,
      id: novoUuid(),
      seq: 0,
      contato: contato || null,
      respostas: {},
      pergunta_atual: null,
      tempos: {},
      rastreio: rastreio,
      concluida: false,
      atualizado_em: new Date().toISOString(),
      // Campos só do aparelho (o servidor nunca vê):
      pendente: false, // tem mudança que o servidor ainda não confirmou
      puladas: [], // perguntas opcionais que a pessoa pulou (para não voltar a elas ao seguir)
      contato_invalido: null, // o servidor recusou o contato: {campo: mensagem}
      lead_rastreado: false,
      fim_rastreado: false
    };
  }

  function contatoValido(contato) {
    if (!contato || typeof contato !== "object") return null;
    const nome = L.normalizeName(contato.nome);
    const whatsapp = L.formatPhone(contato.whatsapp);
    const email = L.normalizeEmail(contato.email);
    if (L.nameError(nome) || L.phoneError(whatsapp) || L.emailError(email)) return null;
    return { nome, whatsapp, email };
  }

  function temposLimpos(tempos) {
    const saida = {};
    if (!tempos || typeof tempos !== "object") return saida;
    for (const chave of Object.keys(tempos)) {
      const valor = Number(tempos[chave]);
      if ((chave === "contato" || P.perguntaPorId(chave)) && Number.isFinite(valor) && valor >= 0) {
        saida[chave] = Math.min(valor, 86400);
      }
    }
    return saida;
  }

  /** Lê o rascunho guardado, desconfiando de tudo: pode ser de uma versão antiga ou editado à mão. */
  function carregarRascunho(rastreioAtual) {
    let bruto = null;
    try {
      bruto = JSON.parse(lerStorage(CHAVE_RASCUNHO) || "null");
    } catch {
      bruto = null;
    }
    if (!bruto || typeof bruto !== "object" || !UUID.test(String(bruto.id || ""))) {
      return rascunhoNovo(mesclarRastreio(null, rastreioAtual));
    }

    const r = rascunhoNovo(mesclarRastreio(bruto.rastreio, rastreioAtual));
    r.id = bruto.id;
    r.seq = Number.isInteger(bruto.seq) && bruto.seq >= 0 && bruto.seq < 1000000 ? bruto.seq : 0;
    r.contato = contatoValido(bruto.contato);
    r.respostas = P.sanitizar(bruto.respostas);
    r.pergunta_atual = typeof bruto.pergunta_atual === "string" ? bruto.pergunta_atual : null;
    r.tempos = temposLimpos(bruto.tempos);
    r.concluida = bruto.concluida === true;
    r.atualizado_em = typeof bruto.atualizado_em === "string" ? bruto.atualizado_em : r.atualizado_em;
    r.pendente = bruto.pendente === true;
    r.puladas = Array.isArray(bruto.puladas) ? bruto.puladas.filter((id) => P.perguntaPorId(id)) : [];
    r.contato_invalido =
      bruto.contato_invalido && typeof bruto.contato_invalido === "object" ? bruto.contato_invalido : null;
    r.lead_rastreado = bruto.lead_rastreado === true;
    r.fim_rastreado = bruto.fim_rastreado === true;
    return r;
  }

  function persistir() {
    r.atualizado_em = new Date().toISOString();
    gravarStorage(CHAVE_RASCUNHO, JSON.stringify(r));
  }

  /* ================================================================== */
  /* Estado em memória                                                   */
  /* ================================================================== */

  /**
   * /pesquisa-icp?nova=1 (link "Responder como outra pessoa" da página de obrigado): começa uma
   * resposta nova neste aparelho. O parâmetro sai da URL já aqui, para não entrar no rastreio e
   * para um recarregamento não apagar de novo.
   */
  function pedidoDeNovaResposta() {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("nova") !== "1") return false;
      url.searchParams.delete("nova");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      return true;
    } catch {
      return false;
    }
  }

  const NOVA_RESPOSTA = pedidoDeNovaResposta();
  const CARGA = novoUuid(); // identifica as entradas de histórico criadas por este carregamento
  const visitanteId = visitanteDoAparelho();
  let r = carregarRascunho(rastreioDestaVisita());
  persistir();

  let telaAtual = "boasvindas";
  let inicioRegistrado = false;
  const falasVistas = new Set(); // etapas cuja fala já "digitou" nesta visita
  const etapasRastreadas = new Set(); // etapas que já foram ao pixel nesta visita
  let redirecionado = false; // já saiu para a página de obrigado
  let saindoParaObrigado = false; // esperando o último salvamento para sair
  let travaAvanco = null; // timer do avanço automático (unica/escala)
  let travaToque = null; // timer que devolve o toque às opções de uma pergunta recém-montada
  let timerTexto = null;

  /* ================================================================== */
  /* Pixel e eventos                                                     */
  /* ================================================================== */

  function pixel(tipo, evento, dados) {
    if (typeof window.fbq !== "function") return;
    try {
      if (dados) window.fbq(tipo, evento, dados);
      else window.fbq(tipo, evento);
    } catch {
      // Bloqueador de anúncio não pode atrapalhar a pesquisa.
    }
  }

  /** Visita e clique em começar: fire-and-forget, com keepalive para sobreviver a um fechamento. */
  function enviarEvento(evento) {
    const corpo = Object.assign({ visitante_id: visitanteId, evento }, r.rastreio);
    try {
      fetch(API_EVENTO, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
        credentials: "same-origin",
        keepalive: true
      }).catch(() => {});
    } catch {
      // fetch ausente ou recusado: contagem de acesso não vale uma tela quebrada.
    }
  }

  function anunciar(texto) {
    aviso.textContent = "";
    // O atraso garante que o leitor de tela perceba a troca mesmo quando o texto se repete.
    window.setTimeout(() => {
      aviso.textContent = texto;
    }, 60);
  }

  /* ================================================================== */
  /* Tempo por tela                                                      */
  /* ================================================================== */
  // Conta só enquanto a página está visível: celular no bolso não é tempo pensando na pergunta.

  let cronometro = { chave: null, desde: 0 };

  function acumularTempo() {
    if (!cronometro.chave || !cronometro.desde) return;
    const agora = Date.now();
    const segundos = (agora - cronometro.desde) / 1000;
    if (segundos > 0) {
      const atual = Number(r.tempos[cronometro.chave]) || 0;
      r.tempos[cronometro.chave] = Math.min(86400, Math.round((atual + segundos) * 10) / 10);
    }
    cronometro.desde = document.visibilityState === "hidden" ? 0 : agora;
  }

  function iniciarCronometro(chave) {
    acumularTempo();
    cronometro = { chave, desde: chave && document.visibilityState !== "hidden" ? Date.now() : 0 };
  }

  function temposInteiros() {
    const saida = {};
    for (const chave of Object.keys(r.tempos)) saida[chave] = Math.max(0, Math.min(86400, Math.round(r.tempos[chave])));
    return saida;
  }

  /* ================================================================== */
  /* Envio ao servidor                                                   */
  /* ================================================================== */

  function corpoSalvar() {
    acumularTempo();
    r.respostas = P.sanitizar(r.respostas);
    r.seq += 1;
    persistir(); // o seq usado precisa estar gravado antes de sair, senão um recarregamento o repete
    return {
      id: r.id,
      visitante_id: visitanteId || null,
      seq: r.seq,
      contato: r.contato,
      respostas: r.respostas,
      pergunta_atual: r.pergunta_atual || "perfil",
      tempos: temposInteiros(),
      rastreio: r.rastreio
    };
  }

  /**
   * Um POST de salvamento. Nunca lança. Devolve o que a tela precisa saber:
   *   ok        gravado
   *   contato   o servidor recusou nome/WhatsApp/e-mail (campos: mensagens por campo)
   *   rede      sem internet, timeout, 5xx ou 429 — vale tentar de novo
   *   definitivo outro 4xx — tentar de novo daria o mesmo erro
   */
  async function postarSalvar(keepalive) {
    const corpo = JSON.stringify(corpoSalvar());
    const controle = typeof AbortController === "function" && !keepalive ? new AbortController() : null;
    const timer = controle ? window.setTimeout(() => controle.abort(), TIMEOUT_MS) : null;
    try {
      const resposta = await fetch(API_SALVAR, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: corpo,
        credentials: "same-origin",
        keepalive: Boolean(keepalive),
        signal: controle ? controle.signal : undefined
      });
      let dados = null;
      try {
        dados = await resposta.json();
      } catch {
        dados = null;
      }
      if (resposta.ok) return { tipo: "ok", dados };
      if (resposta.status === 422 && dados && dados.error === "invalid_contact") {
        return { tipo: "contato", campos: (dados && dados.campos) || {} };
      }
      if (resposta.status >= 500 || resposta.status === 429 || resposta.status === 408) return { tipo: "rede" };
      return { tipo: "definitivo" };
    } catch {
      return { tipo: "rede" };
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  /* ------------------------------------------------ fila de salvamento */
  // No máximo uma requisição em voo. O que muda durante o voo vira UMA próxima, sempre com o
  // estado mais novo (o corpo é montado na hora de sair). O servidor só aplica seq maior, então
  // uma resposta atrasada nunca desfaz uma mais nova.

  const fila = { emVoo: false, pendente: false, tentativas: 0, timer: null };

  function podeSalvar() {
    return Boolean(r.contato) && !r.contato_invalido;
  }

  function agendarSalvamento() {
    r.pendente = true;
    persistir();
    if (!podeSalvar()) return;
    fila.pendente = true;
    if (!fila.emVoo && !fila.timer) enviarFila();
  }

  async function enviarFila() {
    if (fila.timer) {
      window.clearTimeout(fila.timer);
      fila.timer = null;
    }
    if (fila.emVoo || !fila.pendente || !podeSalvar()) return;

    fila.pendente = false;
    fila.emVoo = true;
    mostrarSalvamento("salvando");
    const resultado = await postarSalvar(false);
    fila.emVoo = false;

    if (resultado.tipo === "ok" || resultado.tipo === "definitivo") {
      // "definitivo" não melhora tentando de novo; o rascunho local continua guardado.
      fila.tentativas = 0;
      if (!fila.pendente) {
        r.pendente = false;
        persistir();
        mostrarSalvamento(resultado.tipo === "ok" ? "salvo" : "ocioso");
      }
    } else if (resultado.tipo === "contato") {
      // Contato recusado depois de aceito (e-mail que deixou de existir, outra aba...): a fila
      // para até a pessoa corrigir, e nada do que ela respondeu se perde.
      fila.pendente = false;
      r.contato_invalido = resultado.campos;
      r.pendente = true;
      persistir();
      mostrarSalvamento("ocioso");
      irPara("contato", { direcao: "tras" });
      mostrarErrosDoServidor(resultado.campos);
      return;
    } else {
      fila.pendente = true;
      fila.tentativas += 1;
      mostrarSalvamento("offline");
      const espera = Math.min(BACKOFF_TETO_MS, BACKOFF_INICIAL_MS * 2 ** (fila.tentativas - 1));
      fila.timer = window.setTimeout(() => {
        fila.timer = null;
        enviarFila();
      }, espera);
      return;
    }

    if (fila.pendente) enviarFila();
  }

  /** Fechando ou escondendo a página: manda o que falta com keepalive, sem esperar resposta. */
  function despedida() {
    if (redirecionado) return; // a ida à página de obrigado já mandou o que faltava
    acumularTempo();
    persistir();
    if (!podeSalvar()) return;
    if (!(fila.pendente || fila.emVoo || r.pendente || fila.timer)) return;
    postarSalvar(true);
  }

  window.addEventListener("online", () => {
    if (fila.pendente && !fila.emVoo) {
      fila.tentativas = 0;
      enviarFila();
    }
  });

  window.addEventListener("pagehide", despedida);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      despedida();
    } else if (cronometro.chave) {
      cronometro.desde = Date.now();
    }
  });

  /* ------------------------------------------------ indicador de salvamento */

  function mostrarSalvamento(estado) {
    salvamento.dataset.estado = estado;
    const textos = {
      ocioso: "",
      salvando: "Salvando…",
      salvo: "Salvo",
      offline: "Sem internet — suas respostas estão guardadas neste aparelho"
    };
    const anterior = salvamentoTexto.textContent;
    salvamentoTexto.textContent = textos[estado] || "";
    if (estado === "offline" && anterior !== textos.offline) anunciar(textos.offline);
  }

  /* ================================================================== */
  /* Navegação                                                           */
  /* ================================================================== */

  function visiveis() {
    return P.perguntasVisiveis(r.respostas);
  }

  function ehPergunta(tela) {
    return Boolean(P.perguntaPorId(tela)) && visiveis().some((p) => p.id === tela);
  }

  function respondidaOuPulada(pergunta) {
    return P.perguntaRespondida(pergunta, r.respostas) || r.puladas.includes(pergunta.id);
  }

  /** Para onde vai quem termina tudo o que falta (ou a primeira que ainda impede de concluir). */
  function destinoFinal() {
    if (P.progresso(r.respostas).completa) return "fim";
    const pendente = P.primeiraPendente(r.respostas);
    return pendente ? pendente.id : "fim";
  }

  /**
   * A próxima tela depois de `id`. É a próxima pergunta ainda sem resposta — e não
   * simplesmente a seguinte — porque quem volta três perguntas para corrigir uma quer, ao
   * continuar, cair onde estava, e não repassar tudo.
   */
  function proximaTela(id) {
    const lista = visiveis();
    const indice = lista.findIndex((p) => p.id === id);
    for (let i = indice + 1; i < lista.length; i += 1) {
      if (!respondidaOuPulada(lista[i])) return lista[i].id;
    }
    return destinoFinal();
  }

  function telaAnterior(tela) {
    if (tela === "boasvindas") return null;
    if (tela === "contato") return "boasvindas";
    const lista = visiveis();
    if (tela === "fim") return lista.length ? lista[lista.length - 1].id : "contato";
    const indice = lista.findIndex((p) => p.id === tela);
    if (indice <= 0) return "contato";
    return lista[indice - 1].id;
  }

  /** Só abre uma pergunta se tudo o que é obrigatório antes dela já foi respondido. */
  function alcancavel(id) {
    if (!ehPergunta(id)) return false;
    const lista = visiveis();
    const pendente = P.primeiraPendente(r.respostas);
    if (!pendente) return true;
    return lista.findIndex((p) => p.id === id) <= lista.findIndex((p) => p.id === pendente.id);
  }

  function destinoRetomada() {
    if (r.contato_invalido || !r.contato) return "contato";
    if (r.pergunta_atual === "fim" && P.progresso(r.respostas).completa) return "fim";
    if (r.pergunta_atual && alcancavel(r.pergunta_atual)) return r.pergunta_atual;
    return destinoFinal();
  }

  /** Depois do contato aceito: a primeira pergunta sem resposta (numa pesquisa nova, a 1). */
  function destinoDepoisDoContato() {
    const lista = visiveis();
    const primeira = lista.find((p) => !respondidaOuPulada(p));
    return primeira ? primeira.id : destinoFinal();
  }

  /* ------------------------------------------------ histórico do navegador */
  // Uma entrada por tela. O "voltar" do celular volta uma pergunta em vez de sair da página;
  // na primeira tela ele deixa sair. O estado leva um número crescente e a marca deste
  // carregamento, para distinguir voltar de avançar e ignorar entradas de antes de um reload.

  let historicoN = 0;

  function historicoTrocar() {
    try {
      window.history.replaceState({ ev: historicoN, k: CARGA }, "");
    } catch {
      // webview sem History API: o botão Voltar da tela continua funcionando
    }
  }

  function historicoEmpurrar() {
    historicoN += 1;
    try {
      window.history.pushState({ ev: historicoN, k: CARGA }, "");
    } catch {
      historicoN -= 1;
    }
  }

  function voltar() {
    if (historicoN > 0) {
      window.history.back(); // o popstate faz a troca, e o histórico fica coerente
      return;
    }
    const anterior = telaAnterior(telaAtual);
    if (!anterior) return;
    irPara(anterior, { direcao: "tras", historico: "nenhum" });
    if (anterior !== "boasvindas") historicoEmpurrar();
  }

  window.addEventListener("popstate", (evento) => {
    if (redirecionado) return; // desfazendo o histórico a caminho do obrigado (trocarPorObrigado)
    const estado = evento.state || {};
    const n = typeof estado.ev === "number" ? estado.ev : 0;
    const desteCarregamento = estado.k === CARGA;

    if (desteCarregamento && n > historicoN) {
      // "Avançar" do navegador: não pula pergunta. Fica onde está.
      historicoN = n;
      return;
    }
    historicoN = desteCarregamento ? n : 0;

    if (telaAtual === "boasvindas") {
      if (desteCarregamento && n > 0) {
        historicoN = 0;
        window.history.go(-n);
      }
      return;
    }

    const anterior = telaAnterior(telaAtual) || "boasvindas";
    irPara(anterior, { direcao: "tras", historico: "nenhum" });
    if (anterior === "boasvindas") {
      if (desteCarregamento && n > 0) {
        historicoN = 0;
        window.history.go(-n);
      }
    } else if (historicoN === 0) {
      // Voltamos à entrada base mas ainda há tela para trás: rearma, senão o próximo "voltar" sai.
      historicoEmpurrar();
    }
  });

  /* ------------------------------------------------ troca de tela */

  function irPara(tela, opcoes) {
    const { direcao = "frente", historico = "empurrar" } = opcoes || {};

    if (travaAvanco) {
      window.clearTimeout(travaAvanco);
      travaAvanco = null;
    }
    if (timerTexto) {
      window.clearTimeout(timerTexto);
      timerTexto = null;
    }

    // Segurança: pergunta que não existe mais no caminho (perfil trocado) vira o destino certo.
    if (P.perguntaPorId(tela) && !ehPergunta(tela)) tela = destinoFinal();
    if (tela === "fim" && !P.progresso(r.respostas).completa) tela = destinoFinal();

    const anterior = telaAtual;
    telaAtual = tela;

    const ehQuestao = Boolean(P.perguntaPorId(tela));
    if (ehQuestao) r.pergunta_atual = tela;
    if (tela === "fim") {
      r.pergunta_atual = "fim";
      r.concluida = true;
    }
    iniciarCronometro(ehQuestao ? tela : tela === "contato" ? "contato" : null);

    for (const nome of Object.keys(telas)) telas[nome].hidden = true;
    let alvo;
    if (ehQuestao) {
      alvo = telas.pergunta;
      montarPergunta(P.perguntaPorId(tela));
    } else {
      alvo = telas[tela];
      if (tela === "boasvindas") montarBoasVindas(false);
      if (tela === "contato") montarContato();
      if (tela === "fim") montarFim();
    }
    alvo.hidden = false;
    configurarTopo(tela);
    configurarRodape(tela);
    animarEntrada(alvo, direcao);

    if (historico === "empurrar" && anterior !== tela) historicoEmpurrar();
    else if (historico === "trocar") historicoTrocar();

    window.scrollTo(0, 0);
    const titulo = alvo.querySelector("[data-titulo]") || alvo.querySelector("h1, h2");
    if (titulo && !(tela === "boasvindas" && anterior === "boasvindas")) {
      try {
        titulo.focus({ preventScroll: true });
      } catch {
        titulo.focus();
      }
    }

    persistir();
    if (ehQuestao || tela === "fim") {
      if (r.pendente || anterior !== tela) agendarSalvamento();
    }
    let primeiraConclusao = false;
    if (tela === "fim" && !r.fim_rastreado) {
      primeiraConclusao = true;
      r.fim_rastreado = true;
      persistir();
      const pagina = paginaDeObrigado();
      pixel("trackCustom", "PesquisaConcluida", { perfil: r.respostas.perfil || "" });
      pixel("trackCustom", "pesquisa_icp_concluida", {
        perfil: codigoDoPerfil(),
        pagina_obrigado: pagina ? pagina.id : ""
      });
    }
    if (tela === "fim") sairParaObrigado(primeiraConclusao ? ESPERA_MINIMA_FIM_MS : 0);
  }

  function animarEntrada(elemento, direcao) {
    elemento.classList.remove("entra-frente", "entra-tras");
    if (reduzMovimento()) return;
    // Força o reflow para a animação reiniciar mesmo quando a classe é a mesma.
    void elemento.offsetWidth;
    elemento.classList.add(direcao === "tras" ? "entra-tras" : "entra-frente");
  }

  /* ================================================================== */
  /* Cabeçalho e rodapé                                                  */
  /* ================================================================== */

  function configurarTopo(tela) {
    const ehQuestao = Boolean(P.perguntaPorId(tela));
    topo.hidden = !(ehQuestao || tela === "contato");
    document.body.classList.toggle("com-topo", !topo.hidden);
    if (topo.hidden) return;

    if (tela === "contato") {
      topoEtapa.innerHTML = "";
      const forte = document.createElement("strong");
      forte.textContent = "O passo inicial";
      topoEtapa.append(forte, document.createTextNode(" · seus dados"));
      definirBarra(0, "O passo inicial, antes da etapa 1");
      return;
    }

    const pergunta = P.perguntaPorId(tela);
    const etapas = P.etapasVisiveis(r.respostas);
    const indice = Math.max(0, etapas.findIndex((e) => e.n === pergunta.etapa));
    const etapa = etapas[indice] || P.etapaPorNumero(pergunta.etapa);
    // O número mostra onde a pessoa está no caminho dela (perguntas já passadas / total), e não
    // P.progresso().percentual: esse chega a 100% antes das abertas opcionais, e ver "100%" com
    // três perguntas pela frente confunde.
    const lista = visiveis();
    const posicao = Math.max(0, lista.findIndex((p) => p.id === pergunta.id));
    const pct = Math.min(99, Math.round((posicao / Math.max(lista.length, 1)) * 100));

    topoEtapa.innerHTML = "";
    const forte = document.createElement("strong");
    forte.textContent = `Etapa ${indice + 1} de ${etapas.length}`;
    topoEtapa.append(forte, document.createTextNode(` · ${etapa.titulo}`));
    definirBarra(pct, `Etapa ${indice + 1} de ${etapas.length}, ${pct}% do caminho`);
  }

  function definirBarra(pct, texto) {
    barraPreenchida.style.width = `${pct}%`;
    barra.setAttribute("aria-valuenow", String(pct));
    barra.setAttribute("aria-valuetext", texto);
    topoPct.textContent = `${pct}%`;
  }

  /** Rodapé fixo das perguntas: Continuar, e Pular nas abertas. */
  function configurarRodape(tela) {
    const pergunta = P.perguntaPorId(tela);
    if (!pergunta) {
      rodape.hidden = true;
      document.body.classList.remove("com-rodape");
      return;
    }
    const valor = r.respostas[pergunta.id];
    let mostrarContinuar = true;
    if (pergunta.tipo === "unica" || pergunta.tipo === "escala") {
      // Nas de toque único o toque já avança; o botão só aparece para quem voltou a uma
      // pergunta respondida ou marcou "Outro" (que precisa do complemento).
      mostrarContinuar = valor !== undefined;
    }
    const aberta = pergunta.tipo === "texto" || pergunta.tipo === "frase";
    const vazia = aberta && !P.perguntaRespondida(pergunta, r.respostas);
    botaoPular.hidden = !vazia;
    botaoContinuar.hidden = !mostrarContinuar;

    // Continuar "apagado" enquanto não dá para seguir, mas NÃO desabilitado: tocar nele explica o
    // que falta. Botão desabilitado de verdade só deixa a pessoa sem saber o que fazer.
    const bloqueado = mostrarContinuar && P.erroDaPergunta(pergunta, r.respostas) !== "";
    botaoContinuar.classList.toggle("apagado", bloqueado);

    rodape.hidden = !(mostrarContinuar || !botaoPular.hidden);
    document.body.classList.toggle("com-rodape", !rodape.hidden);
  }

  /* ================================================================== */
  /* Boas-vindas                                                         */
  /* ================================================================== */

  const bv = {
    titulo: $("bv-titulo"),
    texto: $("bv-texto"),
    botao: $("botao-comecar"),
    botaoTexto: $("botao-comecar-texto"),
    doZero: $("botao-do-zero")
  };
  const TEXTOS_BV = { titulo: bv.titulo.textContent, texto: bv.texto.textContent.replace(/\s+/g, " ").trim() };
  let modoRetomar = false;

  function montarBoasVindas(retomar) {
    modoRetomar = Boolean(retomar);
    if (!modoRetomar) {
      bv.titulo.textContent = TEXTOS_BV.titulo;
      bv.texto.textContent = TEXTOS_BV.texto;
      bv.botaoTexto.textContent = "Começar";
      bv.doZero.hidden = true;
      return;
    }
    const nome = P.primeiroNome(r.contato && r.contato.nome);
    const destino = destinoRetomada();
    const etapas = P.etapasVisiveis(r.respostas);
    const pergunta = P.perguntaPorId(destino);
    const indice = pergunta ? Math.max(0, etapas.findIndex((e) => e.n === pergunta.etapa)) : 0;
    bv.titulo.textContent = nome ? `Que bom te ver de novo, ${nome}!` : "Que bom te ver de novo!";
    bv.texto.textContent = `Você parou na etapa ${indice + 1} de ${etapas.length}. Suas respostas estão guardadas, é só continuar.`;
    bv.botaoTexto.textContent = "Continuar de onde parei";
    bv.doZero.hidden = false;
  }

  function registrarInicio() {
    if (inicioRegistrado) return;
    inicioRegistrado = true;
    enviarEvento("inicio");
    pixel("trackCustom", "PesquisaIniciada");
  }

  bv.botao.addEventListener("click", () => {
    registrarInicio();
    if (modoRetomar) {
      modoRetomar = false;
      const destino = destinoRetomada();
      irPara(destino);
      if (destino === "contato" && r.contato_invalido) mostrarErrosDoServidor(r.contato_invalido);
      return;
    }
    irPara("contato");
  });

  bv.doZero.addEventListener("click", () => {
    registrarInicio();
    // Nova tentativa (novo id): as respostas antigas ficam no servidor como estavam; o contato
    // vem preenchido para não ter que digitar tudo de novo.
    const contato = r.contato;
    r = rascunhoNovo(r.rastreio, null);
    persistir();
    preencherContato(contato);
    modoRetomar = false;
    irPara("contato");
  });

  /* ================================================================== */
  /* Contato                                                             */
  /* ================================================================== */

  const contatoStatus = $("contato-status");
  const botaoContato = $("botao-contato");
  const botaoContatoTexto = $("botao-contato-texto");
  const sugestao = {
    caixa: $("sugestao-email"),
    valor: $("sugestao-valor"),
    sim: $("sugestao-sim"),
    nao: $("sugestao-nao")
  };
  let tentouEnviar = false;
  let enviandoContato = false;
  let emailDispensado = ""; // e-mail que a pessoa confirmou estar certo apesar da sugestão
  let whatsappAnterior = "";

  function preencherContato(contato) {
    if (!contato) return;
    campos.nome.value = contato.nome || "";
    campos.whatsapp.value = L.formatPhone(contato.whatsapp || "");
    campos.email.value = contato.email || "";
    whatsappAnterior = campos.whatsapp.value;
  }

  function montarContato() {
    if (r.contato && !campos.nome.value && !campos.whatsapp.value && !campos.email.value) preencherContato(r.contato);
    contatoStatus.textContent = "";
    botaoContatoTexto.textContent = r.contato && Object.keys(r.respostas).length ? "Salvar e continuar" : "Começar a pesquisa";
  }

  function mostrarErro(campo, mensagem) {
    const caixa = $(`erro-${campo}`);
    const grupo = form.querySelector(`[data-campo="${campo}"]`);
    caixa.textContent = mensagem || "";
    caixa.hidden = !mensagem;
    campos[campo].setAttribute("aria-invalid", mensagem ? "true" : "false");
    grupo.classList.toggle("tem-erro", Boolean(mensagem));
  }

  function erroLocal(campo) {
    const valor = campos[campo].value;
    const codigo =
      campo === "nome" ? L.nameError(valor) : campo === "whatsapp" ? L.phoneError(valor) : L.emailError(valor);
    return L.message(CHAVE_MENSAGEM[campo], codigo);
  }

  function validarCampo(campo) {
    const mensagem = erroLocal(campo);
    mostrarErro(campo, mensagem);
    return mensagem;
  }

  function atualizarSugestao(destaque) {
    const valor = L.normalizeEmail(campos.email.value);
    const sugerido = valor ? L.suggestEmail(valor) : "";
    const codigo = L.emailError(valor);
    if (!sugerido || (valor === emailDispensado && codigo !== "typo")) {
      sugestao.caixa.hidden = true;
      sugestao.caixa.classList.remove("destaque");
      return "";
    }
    sugestao.valor.textContent = sugerido;
    // Com erro de digitação certo (gmail.con), "está certo" não é opção: o e-mail não existe.
    sugestao.nao.hidden = codigo === "typo";
    sugestao.caixa.hidden = false;
    sugestao.caixa.classList.toggle("destaque", Boolean(destaque));
    return sugerido;
  }

  function mostrarErrosDoServidor(camposErro) {
    let primeiro = null;
    for (const campo of ["nome", "whatsapp", "email"]) {
      const mensagem = camposErro && typeof camposErro[campo] === "string" ? camposErro[campo] : "";
      mostrarErro(campo, mensagem);
      if (mensagem && !primeiro) primeiro = campo;
    }
    if (primeiro) {
      campos[primeiro].focus();
    } else {
      contatoStatus.textContent = "Confere os seus dados, por favor.";
    }
  }

  // Quem sai do campo tocando no botão de enviar não pode ver o botão fugir do dedo: mostrar erro
  // ou sugestão no blur empurra o botão para baixo e o toque cai no vazio. Nesse caso o blur não
  // mexe na tela, e o próprio envio valida e mostra tudo.
  //
  // Quem encerra o "apertando" é o CLIQUE, e não um timer: em todo navegador o clique vem depois do
  // blur (no iPhone o blur chega nos eventos de mouse emulados, depois do pointerup). Com timer, um
  // navegador lento ou em segundo plano atrasava a volta, e o blur seguinte deixava de validar.
  let apertandoEnviar = false;
  let soltarTimer = 0;
  function soltarEnviar() {
    window.clearTimeout(soltarTimer);
    apertandoEnviar = false;
  }
  botaoContato.addEventListener("pointerdown", () => {
    apertandoEnviar = true;
    window.clearTimeout(soltarTimer);
    // Dedo que sai do botão sem clicar: a validação ao sair do campo volta sozinha.
    soltarTimer = window.setTimeout(soltarEnviar, 1000);
  });
  botaoContato.addEventListener("click", soltarEnviar, true);
  botaoContato.addEventListener("pointercancel", soltarEnviar);

  for (const campo of Object.keys(campos)) {
    campos[campo].addEventListener("blur", () => {
      if (apertandoEnviar) return;
      if (campos[campo].value.trim() || tentouEnviar) validarCampo(campo);
      if (campo === "email") atualizarSugestao(false);
    });
    campos[campo].addEventListener("input", () => {
      // Corrigiu? O erro some na hora, sem esperar sair do campo.
      if (form.querySelector(`[data-campo="${campo}"]`).classList.contains("tem-erro") && !erroLocal(campo)) {
        mostrarErro(campo, "");
      }
      contatoStatus.textContent = "";
    });
  }

  campos.whatsapp.addEventListener("input", () => {
    const formatado = L.formatPhoneWhileTyping(campos.whatsapp.value, whatsappAnterior);
    if (formatado !== campos.whatsapp.value) campos.whatsapp.value = formatado;
    whatsappAnterior = formatado;
  });

  campos.email.addEventListener("input", () => {
    if (!sugestao.caixa.hidden) atualizarSugestao(false);
  });

  // Enter no nome ou no WhatsApp passa para o próximo campo em vez de enviar pela metade.
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

  sugestao.sim.addEventListener("click", () => {
    campos.email.value = sugestao.valor.textContent;
    sugestao.caixa.hidden = true;
    sugestao.caixa.classList.remove("destaque");
    validarCampo("email");
    campos.email.focus();
  });

  sugestao.nao.addEventListener("click", () => {
    emailDispensado = L.normalizeEmail(campos.email.value);
    sugestao.caixa.hidden = true;
    sugestao.caixa.classList.remove("destaque");
    botaoContato.focus();
  });

  function contatoCarregando(sim) {
    enviandoContato = sim;
    botaoContato.classList.toggle("carregando", sim);
    botaoContato.setAttribute("aria-busy", sim ? "true" : "false");
    botaoContato.disabled = sim;
  }

  form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    if (enviandoContato) return;
    tentouEnviar = true;
    contatoStatus.textContent = "";

    let primeiroErro = null;
    for (const campo of ["nome", "whatsapp", "email"]) {
      if (validarCampo(campo) && !primeiroErro) primeiroErro = campo;
    }
    if (primeiroErro) {
      // Erro de digitação no e-mail já aparece com a correção pronta, mesmo que o foco vá antes
      // para outro campo com erro.
      if (L.emailError(campos.email.value) === "typo") atualizarSugestao(primeiroErro === "email");
      campos[primeiroErro].focus();
      return;
    }

    // Sugestão pendente (gmial.com): antes de seguir a pessoa escolhe corrigir ou manter.
    if (atualizarSugestao(true)) {
      sugestao.sim.focus();
      anunciar(`Você quis dizer ${sugestao.valor.textContent}?`);
      return;
    }

    const contato = {
      nome: L.normalizeName(campos.nome.value),
      whatsapp: L.formatPhone(campos.whatsapp.value),
      email: L.normalizeEmail(campos.email.value)
    };
    campos.whatsapp.value = contato.whatsapp;
    r.contato = contato;
    r.contato_invalido = null;
    const destino = destinoDepoisDoContato();
    r.pergunta_atual = destino === "fim" ? "fim" : destino;
    persistir();

    // O contato é a única tela que espera o servidor: é aqui que um e-mail inexistente volta.
    contatoCarregando(true);
    const resultado = await postarSalvar(false);
    contatoCarregando(false);

    if (resultado.tipo === "contato") {
      r.contato_invalido = resultado.campos;
      persistir();
      mostrarErrosDoServidor(resultado.campos);
      return;
    }

    if (resultado.tipo === "ok") {
      if (!fila.emVoo && !fila.pendente) {
        r.pendente = false;
        mostrarSalvamento("salvo");
      }
    } else if (resultado.tipo === "rede") {
      // Sem servidor agora: segue mesmo assim. O rascunho guarda e a fila re-tenta.
      r.pendente = true;
      fila.pendente = true;
      if (!fila.emVoo && !fila.timer) {
        fila.tentativas += 1;
        mostrarSalvamento("offline");
        fila.timer = window.setTimeout(() => {
          fila.timer = null;
          enviarFila();
        }, BACKOFF_INICIAL_MS);
      }
    }
    persistir();

    if (!r.lead_rastreado) {
      r.lead_rastreado = true;
      persistir();
      pixel("track", "Lead");
    }
    irPara(destino);
  });

  /* ================================================================== */
  /* Perguntas                                                           */
  /* ================================================================== */

  function el(tag, atributos, ...filhos) {
    const elemento = document.createElement(tag);
    if (atributos) {
      for (const [nome, valor] of Object.entries(atributos)) {
        if (valor === null || valor === undefined || valor === false) continue;
        if (nome === "class") elemento.className = valor;
        else if (nome === "text") elemento.textContent = valor;
        else elemento.setAttribute(nome, valor === true ? "" : String(valor));
      }
    }
    for (const filho of filhos) {
      if (filho === null || filho === undefined || filho === false) continue;
      elemento.append(filho instanceof Node ? filho : document.createTextNode(String(filho)));
    }
    return elemento;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function iconeCheck() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M5.5 12.5l4.2 4.2L18.5 8");
    svg.append(path);
    return svg;
  }

  const erroPergunta = $("erro-pergunta"); // role=alert, no rodapé, junto do botão

  function atualizarRespostas(mudancas) {
    r.respostas = P.sanitizar(Object.assign({}, r.respostas, mudancas));
    persistir();
  }

  function limparErro() {
    erroPergunta.textContent = "";
  }

  function mostrarErroPergunta(texto) {
    // Esvazia e preenche de novo para o role=alert anunciar mesmo com o mesmo texto.
    erroPergunta.textContent = "";
    window.setTimeout(() => {
      erroPergunta.textContent = texto;
    }, 30);
  }

  /** Primeira pergunta visível da etapa: é nela que aparece a fala da Escola. */
  function abreEtapa(pergunta) {
    const primeira = visiveis().find((p) => p.etapa === pergunta.etapa);
    return primeira && primeira.id === pergunta.id;
  }

  function montarFala(pergunta) {
    const etapa = P.etapaPorNumero(pergunta.etapa);
    const texto = P.interpolar(etapa.fala, {
      nome: r.contato ? r.contato.nome : "",
      perfil: r.respostas.perfil || ""
    });
    const conteudo = el("p", { class: "fala-texto" });
    const balao = el("div", { class: "fala-balao" }, el("p", { class: "fala-quem", text: "Escola Enfermagem de Valor" }), conteudo);
    const fala = el(
      "div",
      { class: "fala" },
      el("img", { class: "fala-avatar", src: "/img/ev-icone-color.png", alt: "", width: 155, height: 155 }),
      balao
    );

    const animar = !falasVistas.has(etapa.n) && !reduzMovimento();
    falasVistas.add(etapa.n);
    if (!animar) {
      conteudo.textContent = texto;
      return fala;
    }
    const pontos = el("span", { class: "digitando", "aria-hidden": "true" }, el("i"), el("i"), el("i"));
    conteudo.append(pontos);
    fala.classList.add("fala-digitando");
    window.setTimeout(() => {
      conteudo.textContent = texto;
      fala.classList.remove("fala-digitando");
    }, DIGITANDO_MS);
    return fala;
  }

  function montarPergunta(pergunta) {
    const tela = telas.pergunta;
    tela.innerHTML = "";
    tela.classList.add("tela-travada");
    if (travaToque) window.clearTimeout(travaToque);
    travaToque = window.setTimeout(() => {
      travaToque = null;
      tela.classList.remove("tela-travada");
    }, TRAVA_TOQUE_MS);
    tela.dataset.tipo = pergunta.tipo;
    tela.dataset.pergunta = pergunta.id;
    const idTitulo = `titulo-${pergunta.id}`;
    tela.setAttribute("aria-labelledby", idTitulo);

    if (abreEtapa(pergunta)) {
      tela.append(montarFala(pergunta));
      if (!etapasRastreadas.has(pergunta.etapa)) {
        etapasRastreadas.add(pergunta.etapa);
        pixel("trackCustom", "PesquisaEtapa", { etapa: pergunta.etapa });
      }
    }

    tela.append(
      el("h2", { class: "pergunta-titulo", id: idTitulo, tabindex: "-1", "data-titulo": true, text: pergunta.texto }),
      el("p", { class: "instrucao", id: `instrucao-${pergunta.id}`, text: INSTRUCAO[pergunta.tipo] || "" })
    );

    const corpo = el("div", { class: "pergunta-corpo" });
    tela.append(corpo);

    if (pergunta.tipo === "unica" || pergunta.tipo === "multipla") montarOpcoes(pergunta, corpo);
    else if (pergunta.tipo === "escala") montarEscala(pergunta, corpo);
    else if (pergunta.tipo === "lista") montarLista(pergunta, corpo);
    else if (pergunta.tipo === "texto") montarTexto(pergunta, corpo);
    else if (pergunta.tipo === "frase") montarFrase(pergunta, corpo);

    limparErro();
  }

  /* ------------------------------------------------ unica e multipla */

  function montarOpcoes(pergunta, corpo) {
    const multipla = pergunta.tipo === "multipla";
    const grupo = el("div", {
      class: `opcoes ${multipla ? "opcoes-multipla" : "opcoes-unica"}`,
      role: multipla ? "group" : "radiogroup",
      "aria-labelledby": `titulo-${pergunta.id}`,
      "aria-describedby": `instrucao-${pergunta.id}`
    });
    const botoes = [];

    for (const opcao of pergunta.opcoes) {
      const botao = el(
        "button",
        { type: "button", class: "opcao", role: multipla ? "checkbox" : "radio", "data-valor": opcao },
        el("span", { class: "opcao-marca", "aria-hidden": "true" }, iconeCheck()),
        el("span", { class: "opcao-texto", text: opcao })
      );
      botao.addEventListener("click", () => (multipla ? alternarMultipla(pergunta, opcao) : escolherUnica(pergunta, opcao)));
      botoes.push(botao);
      grupo.append(botao);
    }
    if (!multipla) navegacaoPorSetas(grupo, botoes);
    corpo.append(grupo);

    if (multipla) {
      corpo.append(el("p", { class: "contador-marcadas", id: `contador-${pergunta.id}`, "aria-live": "polite" }));
    }
    // Campo "qual?" do "Outro": genérico por `pergunta.outro`. Hoje nenhuma pergunta tem "Outro"
    // (decisão do cliente: só respostas concretas), então ele nunca é montado.
    if (pergunta.outro) corpo.append(montarOutro(pergunta));
    atualizarOpcoes(pergunta);
  }

  /**
   * Num radiogroup só a opção marcada (ou a primeira) fica no Tab; as setas passeiam entre as
   * opções. As setas só movem o foco: selecionar é Espaço/Enter, porque aqui selecionar avança
   * de pergunta, e passear com a seta não pode sair respondendo.
   */
  function navegacaoPorSetas(grupo, botoes) {
    grupo.addEventListener("keydown", (e) => {
      const indice = botoes.indexOf(document.activeElement);
      if (indice < 0) return;
      let proximo = -1;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") proximo = (indice + 1) % botoes.length;
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") proximo = (indice - 1 + botoes.length) % botoes.length;
      else if (e.key === "Home") proximo = 0;
      else if (e.key === "End") proximo = botoes.length - 1;
      if (proximo < 0) return;
      e.preventDefault();
      for (const b of botoes) b.tabIndex = -1;
      botoes[proximo].tabIndex = 0;
      botoes[proximo].focus();
    });
  }

  function valoresMarcados(pergunta) {
    const valor = r.respostas[pergunta.id];
    if (Array.isArray(valor)) return valor;
    return valor === undefined ? [] : [String(valor)];
  }

  function atualizarOpcoes(pergunta) {
    const tela = telas.pergunta;
    const marcados = valoresMarcados(pergunta);
    const botoes = Array.from(tela.querySelectorAll(".opcao"));
    for (const botao of botoes) {
      const ativo = marcados.includes(botao.dataset.valor);
      botao.setAttribute("aria-checked", ativo ? "true" : "false");
      botao.classList.toggle("ativa", ativo);
    }
    if (pergunta.tipo === "unica") {
      const foco = botoes.find((b) => b.classList.contains("ativa")) || botoes[0];
      for (const b of botoes) b.tabIndex = b === foco ? 0 : -1;
    }
    const contador = tela.querySelector(".contador-marcadas");
    if (contador) {
      contador.textContent = marcados.length ? `${marcados.length} ${marcados.length === 1 ? "marcada" : "marcadas"}` : "";
    }
    const outro = tela.querySelector(".outro");
    if (outro) outro.hidden = !P.outroMarcado(pergunta, r.respostas);
  }

  function montarOutro(pergunta) {
    const chave = P.chaveOutro(pergunta);
    const id = `campo-${chave}`;
    const entrada = el("input", {
      id,
      type: "text",
      class: "entrada",
      maxlength: P.MAX_OUTRO,
      autocomplete: "off",
      enterkeyhint: "next",
      placeholder: "Escreva aqui"
    });
    entrada.value = typeof r.respostas[chave] === "string" ? r.respostas[chave] : "";
    entrada.addEventListener("input", () => {
      // Guarda cru no campo e limpo nas respostas: não devolvemos o texto aparado para a caixa,
      // senão o espaço entre duas palavras sumiria enquanto a pessoa digita.
      atualizarRespostas({ [chave]: entrada.value });
      limparErro();
      configurarRodape(pergunta.id);
      agendarTexto();
    });
    entrada.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        continuar();
      }
    });
    return el(
      "div",
      { class: "outro", hidden: true },
      el("label", { for: id, text: "Qual? Conta pra gente" }),
      entrada
    );
  }

  /**
   * Rola só o necessário para `alvo` ficar entre o cabeçalho sticky e o rodapé fixo. O
   * scrollIntoView comum não conhece os dois e deixava o campo do "Outro" atrás do botão.
   */
  function garantirVisivel(alvo, atraso) {
    window.setTimeout(() => {
      const caixa = alvo.getBoundingClientRect();
      const teclado = document.body.classList.contains("teclado");
      const limiteBaixo = rodape.hidden || teclado ? window.innerHeight - 12 : rodape.getBoundingClientRect().top - 12;
      const limiteAlto = topo.hidden ? 12 : topo.getBoundingClientRect().bottom + 12;
      if (caixa.bottom > limiteBaixo) window.scrollBy(0, Math.min(caixa.bottom - limiteBaixo, caixa.top - limiteAlto));
      else if (caixa.top < limiteAlto) window.scrollBy(0, caixa.top - limiteAlto);
    }, atraso || 0);
  }

  function focarOutro() {
    const caixa = telas.pergunta.querySelector(".outro");
    const entrada = caixa && caixa.querySelector("input");
    if (!entrada) return;
    window.setTimeout(() => {
      entrada.focus({ preventScroll: true });
      garantirVisivel(caixa, 0);
    }, 50);
  }

  function escolherUnica(pergunta, opcao) {
    const mudancas = { [pergunta.id]: opcao };
    atualizarRespostas(mudancas);
    limparErro();
    atualizarOpcoes(pergunta);
    configurarRodape(pergunta.id);
    // Trocar o perfil muda quantas etapas existem: o cabeçalho acompanha na hora.
    configurarTopo(pergunta.id);
    agendarSalvamento();

    if (opcao === pergunta.outro) {
      focarOutro();
      return;
    }
    avancarEmInstantes(pergunta);
  }

  function avancarEmInstantes(pergunta) {
    if (travaAvanco) window.clearTimeout(travaAvanco);
    travaAvanco = window.setTimeout(() => {
      travaAvanco = null;
      if (telaAtual === pergunta.id) continuar();
    }, ATRASO_AVANCO);
  }

  function alternarMultipla(pergunta, opcao) {
    const atuais = valoresMarcados(pergunta);
    const exclusivas = pergunta.exclusivas || [];
    let nova;
    if (atuais.includes(opcao)) nova = atuais.filter((v) => v !== opcao);
    else if (exclusivas.includes(opcao)) nova = [opcao]; // "Ainda não sei" desmarca o resto
    else nova = atuais.filter((v) => !exclusivas.includes(v)).concat(opcao); // e vice-versa
    atualizarRespostas({ [pergunta.id]: nova });
    limparErro();
    atualizarOpcoes(pergunta);
    configurarRodape(pergunta.id);
    configurarTopo(pergunta.id);
    agendarSalvamento();
    if (opcao === pergunta.outro && nova.includes(opcao)) focarOutro();
  }

  /* ------------------------------------------------ escala */

  function montarEscala(pergunta, corpo) {
    const grupo = el("div", {
      class: "escala",
      role: "radiogroup",
      "aria-labelledby": `titulo-${pergunta.id}`,
      "aria-describedby": `legenda-${pergunta.id}`
    });
    const botoes = [];
    for (let n = pergunta.min; n <= pergunta.max; n += 1) {
      const rotulo =
        n === pergunta.min ? `${n}, ${pergunta.legendaMin}` : n === pergunta.max ? `${n}, ${pergunta.legendaMax}` : String(n);
      const botao = el("button", {
        type: "button",
        class: "escala-numero",
        role: "radio",
        "data-valor": n,
        "aria-label": rotulo,
        text: n
      });
      botao.addEventListener("click", () => {
        atualizarRespostas({ [pergunta.id]: n });
        limparErro();
        atualizarEscala(pergunta);
        configurarRodape(pergunta.id);
        configurarTopo(pergunta.id);
        agendarSalvamento();
        avancarEmInstantes(pergunta);
      });
      botoes.push(botao);
      grupo.append(botao);
    }
    navegacaoPorSetas(grupo, botoes);
    corpo.append(
      grupo,
      el(
        "div",
        { class: "escala-legendas", id: `legenda-${pergunta.id}` },
        el("span", {}, el("b", { text: String(pergunta.min) }), ` ${pergunta.legendaMin}`),
        el("span", {}, el("b", { text: String(pergunta.max) }), ` ${pergunta.legendaMax}`)
      )
    );
    atualizarEscala(pergunta);
  }

  function atualizarEscala(pergunta) {
    const valor = r.respostas[pergunta.id];
    const botoes = Array.from(telas.pergunta.querySelectorAll(".escala-numero"));
    for (const botao of botoes) {
      const ativo = Number(botao.dataset.valor) === valor;
      botao.setAttribute("aria-checked", ativo ? "true" : "false");
      botao.classList.toggle("ativa", ativo);
    }
    const foco = botoes.find((b) => b.classList.contains("ativa")) || botoes[0];
    for (const b of botoes) b.tabIndex = b === foco ? 0 : -1;
  }

  /* ------------------------------------------------ lista (estado) */

  function montarLista(pergunta, corpo) {
    const id = `campo-${pergunta.id}`;
    const select = el("select", {
      id,
      class: "lista",
      "aria-labelledby": `titulo-${pergunta.id}`,
      "aria-describedby": `instrucao-${pergunta.id}`
    });
    select.append(el("option", { value: "", text: pergunta.placeholder || "Selecione" }));
    for (const opcao of pergunta.opcoes) select.append(el("option", { value: opcao, text: opcao }));
    select.value = typeof r.respostas[pergunta.id] === "string" ? r.respostas[pergunta.id] : "";
    select.addEventListener("change", () => {
      atualizarRespostas({ [pergunta.id]: select.value || undefined });
      limparErro();
      configurarRodape(pergunta.id);
      configurarTopo(pergunta.id);
      agendarSalvamento();
    });
    corpo.append(el("div", { class: "lista-caixa" }, select));
  }

  /* ------------------------------------------------ texto e frase */

  function agendarTexto() {
    r.pendente = true;
    persistir();
    if (timerTexto) window.clearTimeout(timerTexto);
    timerTexto = window.setTimeout(() => {
      timerTexto = null;
      agendarSalvamento();
    }, PAUSA_TEXTO_MS);
  }

  function crescer(area) {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight + 2, 420)}px`;
  }

  function areaDeTexto(chave, placeholder, rotulo) {
    const id = `campo-${chave}`;
    const area = el("textarea", {
      id,
      class: "entrada area",
      rows: 4,
      maxlength: P.MAX_TEXTO,
      placeholder: placeholder || "",
      "aria-labelledby": rotulo,
      "aria-describedby": `contador-${chave}`
    });
    area.value = typeof r.respostas[chave] === "string" ? r.respostas[chave] : "";
    const contador = el("span", { class: "contador", id: `contador-${chave}` });
    const atualizarContador = () => {
      contador.textContent = `${area.value.length}/${P.MAX_TEXTO}`;
    };
    area.addEventListener("input", () => {
      atualizarRespostas({ [chave]: area.value });
      limparErro();
      atualizarContador();
      crescer(area);
      configurarRodape(telaAtual);
      agendarTexto();
    });
    atualizarContador();
    window.requestAnimationFrame(() => crescer(area));
    return { area, contador };
  }

  function montarTexto(pergunta, corpo) {
    const { area, contador } = areaDeTexto(pergunta.id, pergunta.placeholder, `titulo-${pergunta.id}`);
    corpo.append(el("div", { class: "texto-caixa" }, area, contador));
  }

  function montarFrase(pergunta, corpo) {
    for (const parte of pergunta.partes) {
      const idRotulo = `rotulo-${parte.id}`;
      const { area, contador } = areaDeTexto(parte.id, parte.placeholder, idRotulo);
      area.rows = 3;
      corpo.append(
        el(
          "div",
          { class: "frase-parte" },
          el("label", { class: "frase-rotulo", id: idRotulo, for: area.id, text: `${parte.antes}…` }),
          el("div", { class: "texto-caixa" }, area, contador)
        )
      );
    }
  }

  /* ------------------------------------------------ continuar e pular */

  function continuar() {
    const pergunta = P.perguntaPorId(telaAtual);
    if (!pergunta) return;
    const erro = P.erroDaPergunta(pergunta, r.respostas);
    if (erro) {
      mostrarErroPergunta(erro);
      // Leva o foco a onde se resolve: o complemento do "Outro" ou o primeiro controle.
      const alvo =
        (P.outroMarcado(pergunta, r.respostas) && telas.pergunta.querySelector(".outro input")) ||
        telas.pergunta.querySelector(".opcao, .escala-numero, select, textarea");
      if (alvo) {
        alvo.focus({ preventScroll: true });
        // Espera o rodapé crescer com a mensagem antes de medir.
        garantirVisivel(alvo.closest(".outro") || alvo, 80);
      }
      return;
    }
    // Opcional em branco com "Continuar" é o mesmo que pular: fica marcada para não reaparecer.
    const respondida = P.perguntaRespondida(pergunta, r.respostas);
    r.puladas = r.puladas.filter((id) => id !== pergunta.id);
    if (!respondida && !pergunta.obrigatoria) r.puladas.push(pergunta.id);
    irPara(proximaTela(pergunta.id));
  }

  function pular() {
    const pergunta = P.perguntaPorId(telaAtual);
    if (!pergunta || pergunta.obrigatoria) return;
    if (!r.puladas.includes(pergunta.id)) r.puladas.push(pergunta.id);
    irPara(proximaTela(pergunta.id));
  }

  // O conteúdo reserva embaixo exatamente a altura do rodapé fixo, para o último cartão nunca
  // ficar escondido atrás dele (a altura muda com a mensagem de erro e com o safe-area).
  if (typeof window.ResizeObserver === "function") {
    new window.ResizeObserver(() => {
      if (rodape.offsetHeight) document.documentElement.style.setProperty("--altura-rodape", `${rodape.offsetHeight}px`);
    }).observe(rodape);
  }

  botaoContinuar.addEventListener("click", continuar);
  botaoPular.addEventListener("click", pular);
  $("botao-voltar").addEventListener("click", voltar);

  // Enter no desktop continua; Shift+Enter quebra a linha nas respostas abertas.
  telas.pergunta.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const alvo = e.target;
    if (alvo.tagName === "TEXTAREA") {
      if (!ehDesktop()) return;
      e.preventDefault();
      continuar();
    } else if (alvo.tagName === "SELECT") {
      e.preventDefault();
      continuar();
    }
  });

  /* ================================================================== */
  /* Fim                                                                 */
  /* ================================================================== */

  function montarFim() {
    const nome = P.primeiroNome(r.contato && r.contato.nome);
    $("fim-saudacao").textContent = nome ? `Muito obrigada, ${nome}!` : "Muito obrigada!";
    // Com página de obrigado, esta tela só aparece de passagem: "fechar a página" seria o
    // conselho errado. A versão completa fica como plano B (perfil sem página).
    const vaiSair = Boolean(paginaDeObrigado());
    $("fim-abrindo").hidden = !vaiSair;
    $("fim-fechar").hidden = vaiSair;
  }

  /* ================================================================== */
  /* Página de obrigado                                                  */
  /* ================================================================== */
  // Concluir leva à página do segmento (js/obrigado-config.js), com as UTMs. Antes de sair, o
  // último salvamento (pergunta_atual "fim") precisa ter sido confirmado; se o servidor demorar,
  // a pessoa não fica presa: sai mesmo assim, e o estado vai junto com keepalive.

  function paginaDeObrigado() {
    if (!O) return null;
    try {
      return O.paginaDoPerfil(r.respostas.perfil) || null;
    } catch {
      return null;
    }
  }

  function codigoDoPerfil() {
    const perfil = r.respostas.perfil;
    return (perfil && P.PERFIL_CODIGO && P.PERFIL_CODIGO[perfil]) || "";
  }

  /**
   * UTMs e ids de clique para a página de obrigado: os da URL atual; sem nenhum na URL, o bloco de
   * primeiro toque do rascunho (inteiro, sem misturar campanhas, como em mesclarRastreio).
   */
  function consultaDeOrigem() {
    let query;
    try {
      query = new URLSearchParams(window.location.search);
    } catch {
      query = new URLSearchParams();
    }
    const daUrl = CAMPOS_CAMPANHA.map((campo) => [campo, textoRastreio(query.get(campo), campo)]);
    const usar = daUrl.some(([, valor]) => valor)
      ? daUrl
      : CAMPOS_CAMPANHA.map((campo) => [campo, textoRastreio(r.rastreio && r.rastreio[campo], campo)]);
    const saida = new URLSearchParams();
    for (const [campo, valor] of usar) if (valor) saida.set(campo, valor);
    const texto = saida.toString();
    return texto ? `?${texto}` : "";
  }

  function salvamentoEmDia() {
    return !podeSalvar() || (!r.pendente && !fila.emVoo && !fila.pendente && !fila.timer);
  }

  const pausa = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  /**
   * Sai para a página de obrigado SEM deixar a pesquisa no "voltar". Cada tela da pesquisa é uma
   * entrada no histórico; se a página de obrigado entrasse por cima delas, o "voltar" do celular
   * recarregaria a pesquisa, que (concluída) mandaria de novo para o obrigado — uma armadilha de
   * dezenas de toques. Então: desfaz as entradas desta visita e SUBSTITUI a primeira pelo obrigado.
   */
  function trocarPorObrigado(destino) {
    let saiu = false;
    const sair = () => {
      if (saiu) return;
      saiu = true;
      window.removeEventListener("popstate", sair);
      try {
        window.location.replace(destino);
      } catch {
        window.location.href = destino;
      }
    };
    const n = historicoN;
    if (n <= 0) return sair();
    historicoN = 0;
    window.addEventListener("popstate", sair);
    window.setTimeout(sair, 400); // navegador que não avisa o popstate: sai assim mesmo
    try {
      window.history.go(-n);
    } catch {
      sair();
    }
  }

  async function sairParaObrigado(minimoMs) {
    const pagina = paginaDeObrigado();
    if (!pagina || saindoParaObrigado || redirecionado) return;
    saindoParaObrigado = true;
    const inicio = Date.now();
    try {
      while (!salvamentoEmDia() && Date.now() - inicio < ESPERA_SALVAR_FIM_MS && telaAtual === "fim") await pausa(80);
      const falta = minimoMs - (Date.now() - inicio);
      if (falta > 0 && telaAtual === "fim") await pausa(falta);
      // Voltou uma pergunta, ou o servidor recusou o contato (a fila levou para a tela de contato):
      // fica. Quando chegar ao fim de novo, esta função roda outra vez.
      if (telaAtual !== "fim" || r.contato_invalido) return;
      if (!salvamentoEmDia()) despedida(); // servidor lento ou sem rede: vai com keepalive
      redirecionado = true;
      persistir();
      trocarPorObrigado(pagina.rota + consultaDeOrigem());
    } finally {
      saindoParaObrigado = false;
    }
  }

  /* ================================================================== */
  /* Teclado virtual                                                     */
  /* ================================================================== */
  // Com o teclado aberto no celular, um rodapé fixo ficaria em cima do campo. Enquanto há
  // campo de texto em foco num aparelho de toque, o rodapé volta para o fluxo da página.

  function ehCampoDeTexto(alvo) {
    if (!alvo) return false;
    if (alvo.tagName === "TEXTAREA") return true;
    return alvo.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(alvo.type);
  }

  document.addEventListener("focusin", (e) => {
    if (!ehCampoDeTexto(e.target) || ehDesktop()) return;
    document.body.classList.add("teclado");
    const alvo = e.target;
    window.setTimeout(() => {
      if (document.activeElement === alvo) alvo.scrollIntoView({ block: "center", behavior: "auto" });
    }, 350);
  });
  document.addEventListener("focusout", () => {
    window.setTimeout(() => {
      if (!ehCampoDeTexto(document.activeElement)) document.body.classList.remove("teclado");
    }, 60);
  });

  /* ================================================================== */
  /* Início                                                              */
  /* ================================================================== */

  function iniciar() {
    if (NOVA_RESPOSTA) {
      // Outra pessoa no mesmo aparelho: o que a anterior ainda não tinha mandado vai agora, e o
      // rascunho recomeça em branco. O rastreio (de onde o aparelho veio) continua.
      if (r.pendente && podeSalvar()) postarSalvar(true);
      r = rascunhoNovo(r.rastreio, null);
      persistir();
    }
    historicoTrocar();
    enviarEvento("visita");

    // Havia mudança não confirmada da última vez (sem internet, aba fechada): manda agora.
    if (r.pendente && podeSalvar()) {
      fila.pendente = true;
      enviarFila();
    }

    // Já concluiu neste aparelho: vai de novo para a página de obrigado dela (a tela de fim só
    // aparece de passagem, ou como plano B se o perfil não tiver página).
    if (r.concluida && r.contato && P.progresso(r.respostas).completa) {
      telaAtual = "fim";
      irPara("fim", { historico: "nenhum" });
      return;
    }

    const retomar = Boolean(r.contato);
    if (r.contato) preencherContato(r.contato);
    telas.boasvindas.hidden = false;
    montarBoasVindas(retomar);
    document.body.classList.add("pronto");
  }

  iniciar();
})();
