/*
 * atualizacao.js — /atualizacao-perfil: contato + profissão, nada além disso.
 *
 * É o caminho curto do UnniChat: template no WhatsApp → "Atualizar perfil" → esta página. Duas
 * telas (contato, profissão), gravação no MESMO lugar da pesquisa (POST /api/atualizacao-perfil →
 * pesquisa_salvar, com pesquisa = "atualizacao-perfil") e, no fim, a mesma página de obrigado da
 * pesquisa de ICP, escolhida pelo perfil. Depois disso o GET /api/leads/perfil devolve a profissão
 * para o UnniChat seguir no funil certo.
 *
 * Reaproveita, sem reescrever: EVLeadRules (nome, WhatsApp, e-mail, máscara e mensagens),
 * EVPesquisa.PERFIL (os quatro rótulos, na ordem da pesquisa) e EVObrigado (para onde cada perfil
 * vai). Os padrões de storage, primeiro toque, pixel e "botão que não foge do dedo" são os mesmos
 * do js/inscricao.js.
 */
(function () {
  "use strict";

  const L = window.EVLeadRules;
  const P = window.EVPesquisa;
  const O = window.EVObrigado;
  if (!L || !P || !O) return;

  const API = "/api/atualizacao-perfil";
  const CHAVE_VISITANTE = "ev_pesquisa_visitante";
  const CHAVE_RASTREIO = "ev_atualizacao_rastreio_v1";
  const CHAVE_CONTATO = "ev_atualizacao_v1";
  /** Depois disto, seguir vale mais do que esperar o servidor confirmar. */
  const TIMEOUT_MS = 4000;
  const CAMPANHA = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"];
  const TETO = { page_url: 2048, referrer: 2048, fbclid: 1000, gclid: 1000 };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CHAVE_MENSAGEM = { nome: "name", whatsapp: "phone", email: "email" };
  const ORDEM = ["nome", "whatsapp", "email"];

  const $ = (id) => document.getElementById(id);

  const form = $("form-contato");
  const campos = { nome: $("campo-nome"), whatsapp: $("campo-whatsapp"), email: $("campo-email") };
  const status = $("contato-status");
  const statusPerfil = $("perfil-status");
  const botao = $("botao-continuar");
  const passos = { contato: $("passo-contato"), perfil: $("passo-perfil") };
  const listaOpcoes = $("opcoes-perfil");
  const tituloPerfil = $("perfil-titulo");
  const avisoVivo = $("ins-aviso");
  const sugestao = {
    caixa: $("sugestao-email"),
    valor: $("sugestao-valor"),
    sim: $("sugestao-sim"),
    nao: $("sugestao-nao")
  };

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
      // Cheio ou bloqueado: a página funciona igual, só não lembra da pessoa.
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

  /** As UTMs e os cliques de anúncio da URL atual (sem depender de URLSearchParams do config). */
  function daUrl() {
    const params = new URLSearchParams(window.location.search);
    const dados = {};
    for (const campo of CAMPANHA) {
      const valor = (params.get(campo) || "").trim();
      if (valor) dados[campo] = valor.slice(0, 500);
    }
    return dados;
  }

  /** Campanha é um BLOCO só: a primeira visita manda, e nunca se mistura com a seguinte. */
  function blocoDeCampanha() {
    const agora = daUrl();
    const guardado = lerJson(CHAVE_RASTREIO);
    if (guardado && CAMPANHA.some((campo) => typeof guardado[campo] === "string" && guardado[campo])) return guardado;
    if (CAMPANHA.some((campo) => agora[campo])) gravarJson(CHAVE_RASTREIO, agora);
    return agora;
  }

  const CAMPANHA_DESTA_PESSOA = blocoDeCampanha();

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

  /** A query que segue para a página de obrigado: as UTMs e os cliques de anúncio. */
  function queryDeOrigem() {
    const partes = [];
    for (const campo of CAMPANHA) {
      const valor = CAMPANHA_DESTA_PESSOA[campo];
      if (valor) partes.push(`${encodeURIComponent(campo)}=${encodeURIComponent(valor)}`);
    }
    return partes.length ? `?${partes.join("&")}` : "";
  }

  function pixel(tipo, evento, dados) {
    if (typeof window.fbq !== "function") return;
    try {
      if (dados) window.fbq(tipo, evento, dados);
      else window.fbq(tipo, evento);
    } catch {
      // Bloqueador de anúncio não pode atrapalhar a atualização.
    }
  }

  function anunciar(mensagem) {
    if (!avisoVivo) return;
    avisoVivo.textContent = "";
    window.setTimeout(() => {
      avisoVivo.textContent = mensagem;
    }, 30);
  }

  /* ================================================================== */
  /* Estado                                                              */
  /* ================================================================== */

  const visitanteId = visitanteDoAparelho();
  // O id da atualização é o da tentativa no banco: o mesmo aparelho corrigindo algo cai na mesma
  // linha (a chave de verdade é pesquisa + WhatsApp, mas reaproveitar o id evita linha órfã).
  const guardado = lerJson(CHAVE_CONTATO) || {};
  let sessaoId = UUID.test(String(guardado.id || "")) ? guardado.id : novoUuid();
  let contato = null;
  let tentouEnviar = false;
  let enviando = false;
  let emailDispensado = "";
  let whatsappAnterior = "";

  // Voltou depois de já ter preenchido? Os campos vêm prontos, sem enviar nada sozinho.
  if (guardado.contato && typeof guardado.contato === "object") {
    campos.nome.value = String(guardado.contato.nome || "");
    campos.whatsapp.value = L.formatPhone(String(guardado.contato.whatsapp || ""));
    campos.email.value = String(guardado.contato.email || "");
    whatsappAnterior = campos.whatsapp.value;
  }

  /**
   * O contato que o UnniChat já tem, vindo no link (?nome=&telefone=&email=): a pessoa chega com os
   * campos prontos e só confere. O que ela mesma corrigiu aqui antes tem preferência — o link só
   * preenche campo vazio —, tudo passa pela mesma régua dos campos digitados, e nada é enviado
   * sozinho: ela ainda aperta CONTINUAR e escolhe a profissão.
   */
  (function preencherDoLink() {
    const params = new URLSearchParams(window.location.search);
    const nome = (params.get("nome") || "").trim();
    const telefone = (params.get("telefone") || params.get("whatsapp") || "").trim();
    const email = (params.get("email") || "").trim();

    if (nome && !campos.nome.value.trim()) campos.nome.value = L.formatName(nome.slice(0, 120));
    if (telefone && !campos.whatsapp.value.trim()) {
      const formatado = L.formatPhone(telefone);
      // Número que não vira WhatsApp brasileiro (DDI de fora, variável não substituída) não entra:
      // melhor o campo vazio do que a pessoa corrigindo lixo.
      if (!L.phoneError(formatado)) {
        campos.whatsapp.value = formatado;
        whatsappAnterior = formatado;
      }
    }
    if (email && !campos.email.value.trim()) campos.email.value = L.normalizeEmail(email.slice(0, 254));
  })();

  /* ================================================================== */
  /* Validação (a mesma régua da pesquisa e da inscrição)                */
  /* ================================================================== */

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

  // O clique encerra o "apertando", nunca um timer: navegador lento atrasava a volta e o blur
  // seguinte deixava de validar.
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
    const sugerido = sugestao.valor.textContent.trim();
    if (sugerido) {
      campos.email.value = sugerido;
      emailDispensado = "";
      mostrarErro("email", "");
    }
    sugestao.caixa.hidden = true;
    campos.email.focus();
  });

  sugestao.nao.addEventListener("click", () => {
    emailDispensado = L.normalizeEmail(campos.email.value);
    sugestao.caixa.hidden = true;
    campos.email.focus();
  });

  /* ================================================================== */
  /* Passo 1 → passo 2                                                   */
  /* ================================================================== */

  form.addEventListener("submit", (evento) => {
    evento.preventDefault();
    tentouEnviar = true;
    status.textContent = "";

    let primeiroErro = null;
    for (const campo of ORDEM) if (validarCampo(campo) && !primeiroErro) primeiroErro = campo;
    if (primeiroErro) {
      if (L.emailError(campos.email.value) === "typo") atualizarSugestao(primeiroErro === "email");
      campos[primeiroErro].focus();
      return;
    }

    // Sugestão pendente (gmial.com): a pessoa escolhe corrigir ou manter antes de seguir.
    if (atualizarSugestao(true)) {
      sugestao.sim.focus();
      anunciar(`Você quis dizer ${sugestao.valor.textContent}?`);
      return;
    }

    contato = {
      nome: L.formatName(campos.nome.value),
      whatsapp: L.formatPhone(campos.whatsapp.value),
      email: L.normalizeEmail(campos.email.value)
    };
    campos.whatsapp.value = contato.whatsapp;
    gravarJson(CHAVE_CONTATO, { id: sessaoId, contato });
    pixel("track", "Lead");

    passos.contato.hidden = true;
    passos.perfil.hidden = false;
    window.scrollTo({ top: 0, behavior: "auto" });
    tituloPerfil.focus();
    anunciar("Agora escolha a sua profissão.");
  });

  /* ================================================================== */
  /* Passo 2: a profissão                                                */
  /* ================================================================== */

  // Os quatro rótulos saem da pergunta 1 da pesquisa: uma lista só no projeto.
  const PERFIS = P.perguntaPorId("perfil")?.opcoes || Object.values(P.PERFIL);

  for (const rotulo of PERFIS) {
    const botaoOpcao = document.createElement("button");
    botaoOpcao.type = "button";
    botaoOpcao.className = "opcao";
    botaoOpcao.setAttribute("role", "radio");
    botaoOpcao.setAttribute("aria-checked", "false");
    botaoOpcao.dataset.valor = rotulo;
    const marca = document.createElement("span");
    marca.className = "opcao-marca";
    marca.setAttribute("aria-hidden", "true");
    const texto = document.createElement("span");
    texto.textContent = rotulo;
    botaoOpcao.append(marca, texto);
    botaoOpcao.addEventListener("click", () => escolher(rotulo, botaoOpcao));
    listaOpcoes.append(botaoOpcao);
  }

  /** Para onde a pessoa vai depois, com as UTMs preservadas. */
  function destinoDoPerfil(perfil) {
    const pagina = O.paginaDoPerfil(perfil);
    return pagina ? `${pagina.rota}${queryDeOrigem()}` : `/${queryDeOrigem()}`;
  }

  async function escolher(perfil, botaoOpcao) {
    if (enviando || !contato) return;
    enviando = true;
    for (const outro of listaOpcoes.querySelectorAll(".opcao")) outro.setAttribute("aria-checked", "false");
    botaoOpcao.setAttribute("aria-checked", "true");
    listaOpcoes.setAttribute("aria-busy", "true");
    statusPerfil.textContent = "Salvando…";

    const corpo = {
      id: sessaoId,
      visitante_id: visitanteId,
      contato,
      perfil,
      rastreio: rastreioAtual()
    };

    let camposComErro = null;
    try {
      const controle = new AbortController();
      const relogio = window.setTimeout(() => controle.abort(), TIMEOUT_MS);
      const resposta = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corpo),
        keepalive: true,
        signal: controle.signal
      });
      window.clearTimeout(relogio);
      if (resposta.status === 422) {
        const json = await resposta.json().catch(() => null);
        if (json && json.error === "invalid_contact") camposComErro = json.campos || {};
      }
    } catch {
      // Rede caída ou demora: a pessoa não pode ficar presa. Segue para o obrigado e o envio vai
      // de novo em keepalive logo abaixo.
      try {
        const blob = new Blob([JSON.stringify(corpo)], { type: "application/json" });
        navigator.sendBeacon?.(API, blob);
      } catch {
        // sem sendBeacon: o registro se perde, mas o fluxo da pessoa continua
      }
    }

    if (camposComErro) {
      // O contato foi recusado pelo servidor (e-mail inexistente, por exemplo): volta ao passo 1.
      enviando = false;
      listaOpcoes.removeAttribute("aria-busy");
      statusPerfil.textContent = "";
      passos.perfil.hidden = true;
      passos.contato.hidden = false;
      mostrarErrosDoServidor(camposComErro);
      return;
    }

    pixel("trackCustom", "perfil_atualizado", { perfil: valorInterno(perfil) });
    window.location.replace(destinoDoPerfil(perfil));
  }

  function valorInterno(perfil) {
    const mapa = P.PERFIL_CODIGO;
    return Object.prototype.hasOwnProperty.call(mapa, perfil) ? mapa[perfil] : null;
  }

  // O teclado anda pelos cartões como num grupo de opções de verdade.
  listaOpcoes.addEventListener("keydown", (evento) => {
    const atuais = Array.from(listaOpcoes.querySelectorAll(".opcao"));
    const indice = atuais.indexOf(document.activeElement);
    if (indice === -1) return;
    const passo = evento.key === "ArrowDown" || evento.key === "ArrowRight" ? 1 : evento.key === "ArrowUp" || evento.key === "ArrowLeft" ? -1 : 0;
    if (!passo) return;
    evento.preventDefault();
    atuais[(indice + passo + atuais.length) % atuais.length].focus();
  });

  document.body.classList.add("pronto");
})();
