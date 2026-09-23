/*
 * inscricao.js — a página de inscrição rápida (viver-de-furo-inscricao.html).
 *
 * Três campos e um botão: ao enviar, a pessoa vai para o checkout da Hotmart já preenchido, com as
 * UTMs desta página (e o utm_term também como sck). Quem manda no link, no nome do produto e na
 * rota é EVCheckout (js/checkout-config.js); quem manda na validação é EVLeadRules
 * (js/lead-rules.js) — os mesmos dois arquivos que o servidor carrega.
 *
 * Princípio que guia tudo aqui: NADA pode travar a venda. O POST /api/inscricao existe para o
 * cliente ter o lead e casar a compra depois, mas se o servidor demorar, cair ou responder erro, a
 * página monta a URL do checkout sozinha (EVCheckout.montarUrlCheckout), manda o POST em keepalive
 * e sai assim mesmo. A única resposta que segura a pessoa é o 422 de contato inválido.
 */
(function () {
  "use strict";

  const L = window.EVLeadRules;
  const C = window.EVCheckout;
  if (!L || !C) return;

  const pagina = C.paginaDaRota(window.location.pathname) || C.paginaPorId("viver-de-furo");
  if (!pagina) return;

  /* ================================================================== */
  /* Constantes                                                          */
  /* ================================================================== */

  const API = "/api/inscricao";
  /** O mesmo visitante da pesquisa e das páginas de obrigado. */
  const CHAVE_VISITANTE = "ev_pesquisa_visitante";
  /** Rastreio de PRIMEIRO toque desta página (bloco inteiro, nunca campo a campo). */
  const CHAVE_RASTREIO = "ev_inscricao_rastreio_v1";
  /** Quem já se inscreveu neste aparelho: os campos voltam preenchidos. */
  const CHAVE_INSCRICAO = "ev_inscricao_v1";

  /** Esperou mais que isto pelo servidor? Vai para o checkout montado aqui mesmo. */
  const TIMEOUT_MS = 3500;

  const CAMPANHA = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"];
  const TETO = { page_url: 2048, referrer: 2048, fbclid: 1000, gclid: 1000 };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CHAVE_MENSAGEM = { nome: "name", whatsapp: "phone", email: "email" };
  const ORDEM = ["nome", "whatsapp", "email"];

  const $ = (id) => document.getElementById(id);

  const form = $("form-inscricao");
  const campos = { nome: $("campo-nome"), whatsapp: $("campo-whatsapp"), email: $("campo-email") };
  const status = $("ins-status");
  const botao = $("botao-ir");
  const botaoTexto = $("botao-ir-texto");
  const avisoVivo = $("ins-aviso");
  const sugestao = {
    caixa: $("sugestao-email"),
    valor: $("sugestao-valor"),
    sim: $("sugestao-sim"),
    nao: $("sugestao-nao")
  };
  if (!form || !botao || !campos.nome || !campos.whatsapp || !campos.email) return;

  const ROTULO_BOTAO = botaoTexto.textContent.trim() || "IR PARA O PAGAMENTO";

  /* ================================================================== */
  /* Armazenamento — sempre em try/catch                                 */
  /* ================================================================== */
  // Navegador anônimo do iPhone e alguns webviews jogam exceção só de tocar no localStorage.

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
      // Cheio ou bloqueado: a inscrição funciona igual, só não lembra da pessoa.
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

  /* ================================================================== */
  /* Identificadores                                                     */
  /* ================================================================== */

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

  /**
   * A campanha é um BLOCO só: se a primeira visita a esta página trouxe qualquer utm/fbclid/gclid,
   * fica o bloco dela inteiro. Misturar campo a campo creditaria uma campanha do Facebook à bio do
   * Instagram. Mesma regra do js/pesquisa.js.
   */
  function blocoDeCampanha() {
    const daUrl = C.rastreioDaUrl(window.location.search);
    const guardado = lerJson(CHAVE_RASTREIO);
    if (guardado && CAMPANHA.some((campo) => typeof guardado[campo] === "string" && guardado[campo])) return guardado;
    if (CAMPANHA.some((campo) => daUrl[campo])) gravarJson(CHAVE_RASTREIO, daUrl);
    return daUrl;
  }

  // O primeiro toque é registrado AO ABRIR a página, e não no envio: quem chega pelo anúncio,
  // sai e volta direto tem a campanha certa mesmo sem ter preenchido nada da primeira vez.
  const CAMPANHA_DESTA_PESSOA = blocoDeCampanha();

  function rastreioAtual() {
    const bloco = CAMPANHA_DESTA_PESSOA;
    const dados = {
      // Sem o #: âncora não diz nada sobre a origem e pode carregar lixo.
      page_url: texto(window.location.origin + window.location.pathname + window.location.search, "page_url"),
      referrer: texto(document.referrer, "referrer"),
      dispositivo: dispositivo()
    };
    for (const campo of CAMPANHA) {
      dados[campo] = typeof bloco[campo] === "string" ? texto(bloco[campo], campo) : null;
    }
    return dados;
  }

  /** Só as UTMs, do jeito que montarUrlCheckout espera. */
  function utmDoRastreio(rastreio) {
    const utm = {};
    for (const campo of C.UTMS) if (rastreio[campo]) utm[campo] = rastreio[campo];
    return utm;
  }

  /* ================================================================== */
  /* Pixel                                                               */
  /* ================================================================== */

  function pixel(tipo, evento, dados) {
    if (typeof window.fbq !== "function") return;
    try {
      if (dados) window.fbq(tipo, evento, dados);
      else window.fbq(tipo, evento);
    } catch {
      // Bloqueador de anúncio não pode atrapalhar a venda.
    }
  }

  /* ================================================================== */
  /* Montagem da página a partir do EVCheckout                           */
  /* ================================================================== */

  const produto = $("ins-produto");
  if (produto && pagina.produto) produto.textContent = pagina.produto;
  if (pagina.produto) document.title = `Inscrição · ${pagina.produto} | Escola Enfermagem de Valor`;

  function anunciar(mensagem) {
    if (!avisoVivo) return;
    avisoVivo.textContent = "";
    window.setTimeout(() => {
      avisoVivo.textContent = mensagem;
    }, 30);
  }

  /* ================================================================== */
  /* Validação                                                           */
  /* ================================================================== */

  let tentouEnviar = false;
  let enviando = false;
  let emailDispensado = ""; // e-mail que a pessoa confirmou estar certo apesar da sugestão
  let whatsappAnterior = "";
  let leadRastreado = false;

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
    for (const campo of ORDEM) {
      const mensagem = camposErro && typeof camposErro[campo] === "string" ? camposErro[campo] : "";
      mostrarErro(campo, mensagem);
      if (mensagem && !primeiro) primeiro = campo;
    }
    if (primeiro) campos[primeiro].focus();
    else status.textContent = "Confere os seus dados, por favor.";
  }

  // Quem sai do campo tocando no botão não pode ver o botão fugir do dedo: mostrar erro no blur
  // empurra o botão para baixo e o toque cai no vazio. Nesse caso o blur não mexe na tela — o
  // próprio envio valida e mostra tudo. Quem encerra o "apertando" é o CLIQUE, e não um timer.
  let apertandoEnviar = false;
  let soltarTimer = 0;
  function soltarEnviar() {
    window.clearTimeout(soltarTimer);
    apertandoEnviar = false;
  }
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
      // Corrigiu? O erro some na hora, sem esperar sair do campo.
      if (form.querySelector(`[data-campo="${campo}"]`).classList.contains("tem-erro") && !erroLocal(campo)) {
        mostrarErro(campo, "");
      }
      status.textContent = "";
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
    botao.focus();
  });

  /* ================================================================== */
  /* Campos preenchidos de quem já passou por aqui                       */
  /* ================================================================== */

  (function preencherDoAparelho() {
    const guardado = lerJson(CHAVE_INSCRICAO);
    const contato = guardado && typeof guardado.contato === "object" ? guardado.contato : null;
    if (!contato) return;
    if (typeof contato.nome === "string") campos.nome.value = L.normalizeName(contato.nome);
    if (typeof contato.whatsapp === "string") campos.whatsapp.value = L.formatPhone(contato.whatsapp);
    if (typeof contato.email === "string") campos.email.value = L.normalizeEmail(contato.email);
    whatsappAnterior = campos.whatsapp.value;
    // Nada é enviado sozinho: a pessoa confere e toca no botão.
  })();

  /* ================================================================== */
  /* Envio                                                               */
  /* ================================================================== */

  function carregando(sim) {
    enviando = sim;
    botao.disabled = sim;
    botao.setAttribute("aria-busy", sim ? "true" : "false");
    botaoTexto.textContent = sim ? "Abrindo o pagamento…" : ROTULO_BOTAO;
  }

  // Voltando do checkout pelo botão "voltar" (inclusive do bfcache): o botão volta a funcionar.
  window.addEventListener("pageshow", () => {
    if (enviando) carregando(false);
  });

  /** Fire-and-forget com keepalive: sobrevive à troca de página para o checkout. */
  function avisarServidorEIr(corpo) {
    try {
      if (typeof window.fetch === "function") {
        window
          .fetch(API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: corpo,
            credentials: "same-origin",
            keepalive: true
          })
          .catch(() => {});
        return;
      }
    } catch {
      // fetch recusado (keepalive sem suporte em webview antigo): tenta o beacon abaixo.
    }
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(API, new Blob([corpo], { type: "application/json" }));
    } catch {
      // Sem jeito de avisar: a venda vale mais que o registro.
    }
  }

  function irParaOCheckout(url) {
    pixel("trackCustom", "clique_checkout", { pagina: pagina.id });
    anunciar("Abrindo o pagamento.");
    // href e não replace: a pessoa pode querer voltar para conferir o que digitou.
    window.location.href = url;
  }

  form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    if (enviando) return;
    tentouEnviar = true;
    status.textContent = "";

    let primeiroErro = null;
    for (const campo of ORDEM) {
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
    // A tela passa a mostrar exatamente o que vai ser enviado (e o que volta se a pessoa voltar).
    campos.nome.value = contato.nome;
    campos.whatsapp.value = contato.whatsapp;
    campos.email.value = contato.email;
    whatsappAnterior = contato.whatsapp;

    const rastreio = rastreioAtual();
    const corpo = JSON.stringify({
      pagina: pagina.id,
      id: novoUuid(),
      visitante_id: visitanteDoAparelho(),
      contato,
      rastreio
    });

    // Contato aceito pela mesma régua do servidor: o lead conta agora, mesmo se a rede cair.
    if (!leadRastreado) {
      leadRastreado = true;
      pixel("track", "Lead");
    }
    gravarJson(CHAVE_INSCRICAO, { inscrito: true, pagina: pagina.id, contato, em: new Date().toISOString() });

    carregando(true);

    let destino = "";
    const controle = typeof window.AbortController === "function" ? new AbortController() : null;
    const relogio = window.setTimeout(() => {
      try {
        if (controle) controle.abort();
      } catch {
        // abort não suportado: o plano B entra pelo catch do fetch ou pela resposta tardia.
      }
    }, TIMEOUT_MS);

    try {
      const resposta = await window.fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: corpo,
        credentials: "same-origin",
        signal: controle ? controle.signal : undefined
      });
      window.clearTimeout(relogio);

      if (resposta.status === 422) {
        const dados = await resposta.json().catch(() => null);
        if (dados && dados.error === "invalid_contact") {
          carregando(false);
          mostrarErrosDoServidor(dados.campos);
          return;
        }
      } else if (resposta.ok) {
        const dados = await resposta.json().catch(() => null);
        if (dados && dados.ok && typeof dados.checkout === "string" && /^https?:\/\//i.test(dados.checkout)) {
          destino = dados.checkout;
        }
      }
    } catch {
      // Rede caída, servidor mudo ou demora acima do TIMEOUT_MS: o plano B resolve.
    }
    window.clearTimeout(relogio);

    if (!destino) {
      // Plano B: a mesma URL que o servidor montaria, montada aqui. A venda não espera ninguém.
      destino = C.montarUrlCheckout(pagina.checkout, { utm: utmDoRastreio(rastreio), contato });
      avisarServidorEIr(corpo);
    }

    irParaOCheckout(destino);
  });
})();
