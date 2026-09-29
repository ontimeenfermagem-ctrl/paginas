/*
 * replay.js — a sala de aula (/replay-afericao): o formulário que libera, a aula e o material.
 *
 * Nada de texto aqui: tudo vem de js/replay-config.js (EVReplay), pela ROTA em que a página está
 * aberta. O formulário usa a mesma régua de contato do resto do projeto (EVLeadRules) e as mesmas
 * quatro profissões da pergunta 1 da pesquisa (EVPesquisa).
 *
 * A sala abre depois de UM envio e continua aberta neste aparelho pelos dias que o config disser —
 * quem voltar pelo link amanhã não preenche de novo. O player de terceiro só é montado no clique
 * do play: antes disso, nada de fora carrega.
 */
(function () {
  "use strict";

  const L = window.EVLeadRules;
  const P = window.EVPesquisa;
  const R = window.EVReplay;
  if (!L || !P || !R) return;

  const pagina = R.paginaDaRota(window.location.pathname);
  if (!pagina) return;

  const API = "/api/replay/inscricao";
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

  const $ = (id) => document.getElementById(id);

  const form = $("form-acesso");
  const campos = { nome: $("campo-nome"), whatsapp: $("campo-whatsapp"), email: $("campo-email") };
  const status = $("acesso-status");
  const botao = $("botao-acesso");
  const listaOpcoes = $("opcoes-perfil");
  const erroPerfil = $("erro-perfil");
  const avisoVivo = $("sala-aviso");
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
  const acessoGuardado = lerJson(CHAVE_ACESSO) || {};
  let sessaoId = UUID.test(String(acessoGuardado.id || "")) ? acessoGuardado.id : novoUuid();
  let perfilEscolhido = "";
  let tentouEnviar = false;
  let enviando = false;
  let emailDispensado = "";
  let whatsappAnterior = "";

  /** A sala já foi liberada neste aparelho, e ainda vale? */
  function acessoValido() {
    const dias = Number(pagina.acesso && pagina.acesso.lembrarDias) || 0;
    const quando = Number(acessoGuardado.em) || 0;
    if (!acessoGuardado.liberado || !quando) return false;
    if (!dias) return true;
    return Date.now() - quando < dias * DIA_MS;
  }

  // Voltou depois de já ter preenchido: os campos vêm prontos (útil quando o acesso expirou).
  if (acessoGuardado.contato && typeof acessoGuardado.contato === "object") {
    campos.nome.value = String(acessoGuardado.contato.nome || "");
    campos.whatsapp.value = L.formatPhone(String(acessoGuardado.contato.whatsapp || ""));
    campos.email.value = String(acessoGuardado.contato.email || "");
    whatsappAnterior = campos.whatsapp.value;
  }
  if (typeof acessoGuardado.perfil === "string") perfilEscolhido = acessoGuardado.perfil;

  /* ================================================================== */
  /* Desenho da página                                                   */
  /* ================================================================== */

  function escreverTexto(id, valor) {
    const alvo = $(id);
    if (alvo) alvo.textContent = valor || "";
  }

  function desenharTopo() {
    escreverTexto("sala-eyebrow", pagina.eyebrow);
    escreverTexto("sala-titulo", pagina.titulo);
    escreverTexto("sala-descricao", pagina.descricao);
    escreverTexto("sala-rodape-texto", pagina.rodape);

    const numeros = $("sala-numeros");
    numeros.textContent = "";
    for (const item of pagina.numeros || []) {
      const li = document.createElement("li");
      const b = document.createElement("b");
      b.textContent = item.valor;
      const span = document.createElement("span");
      span.textContent = item.rotulo;
      li.append(b, span);
      numeros.append(li);
    }

    const acesso = pagina.acesso || {};
    escreverTexto("acesso-titulo", acesso.titulo);
    escreverTexto("acesso-apoio", acesso.apoio);
    escreverTexto("perfil-titulo", acesso.perguntaPerfil);
    escreverTexto("botao-acesso-texto", acesso.cta);
  }

  const ICONE_PLAY =
    '<svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';

  /** O quadro do vídeo: capa + play. O iframe só nasce no clique (nada de fora carrega antes). */
  function quadroDaAula(aula) {
    const quadro = document.createElement("button");
    quadro.type = "button";
    quadro.className = "sala-quadro";
    quadro.dataset.aula = aula.id;

    const capa = R.capaDaAula(aula);
    if (capa) {
      const img = document.createElement("img");
      img.className = "sala-quadro-capa";
      img.src = capa;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      // Capa que não carrega (vídeo privado, thumb inexistente) não deixa buraco na tela.
      img.addEventListener("error", () => img.remove());
      quadro.append(img);
    }

    const centro = document.createElement("div");
    centro.className = "sala-quadro-centro";
    const temVideo = R.videoValido(aula.video);

    if (temVideo) {
      const play = document.createElement("span");
      play.className = "sala-play";
      play.innerHTML = ICONE_PLAY;
      const legenda = document.createElement("p");
      legenda.className = "sala-quadro-texto";
      legenda.textContent = `Assistir · ${aula.duracao || ""}`.replace(/ · $/, "");
      centro.append(play, legenda);
      quadro.setAttribute("aria-label", `Assistir: ${aula.titulo}`);
      quadro.addEventListener("click", () => tocar(quadro, aula));
    } else {
      // Sem vídeo no config: o quadro avisa, não finge.
      quadro.setAttribute("aria-disabled", "true");
      const legenda = document.createElement("p");
      legenda.className = "sala-quadro-texto";
      legenda.textContent = "Estamos preparando o replay desta aula. Volte em instantes 💜";
      centro.append(legenda);
    }

    quadro.append(centro);
    return quadro;
  }

  function tocar(quadro, aula) {
    const url = R.urlDoVideo(aula.video);
    if (!url) return;
    const frame = document.createElement("iframe");
    frame.src = url;
    frame.title = aula.titulo;
    frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen";
    frame.setAttribute("allowfullscreen", "");
    frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    // O botão vira moldura: o iframe toma o lugar da capa e o clique não volta a disparar.
    quadro.textContent = "";
    quadro.replaceWith(
      (() => {
        const moldura = document.createElement("div");
        moldura.className = "sala-quadro";
        moldura.append(frame);
        return moldura;
      })()
    );
    pixel("trackCustom", "replay_play", { pagina: pagina.id, aula: aula.id });
    anunciar("A aula começou.");
  }

  function desenharAulas() {
    const alvo = $("lista-aulas");
    alvo.textContent = "";
    for (const aula of pagina.aulas || []) {
      const artigo = document.createElement("article");
      artigo.className = "sala-aula";
      artigo.append(quadroDaAula(aula));

      const corpo = document.createElement("div");
      corpo.className = "sala-aula-corpo";

      const topo = document.createElement("div");
      topo.className = "sala-aula-topo";
      for (const [texto, classe] of [
        [aula.numero, "sala-etiqueta"],
        [aula.duracao ? `${aula.duracao} de aula` : "", "sala-etiqueta ouro"],
        [aula.quando ? `ao vivo em ${aula.quando}` : "", "sala-etiqueta"]
      ]) {
        if (!texto) continue;
        const tag = document.createElement("span");
        tag.className = classe;
        tag.textContent = texto;
        topo.append(tag);
      }

      const h3 = document.createElement("h3");
      h3.textContent = aula.titulo;
      const p = document.createElement("p");
      p.textContent = aula.descricao;
      corpo.append(topo, h3, p);
      artigo.append(corpo);
      alvo.append(artigo);
    }
  }

  const ICONE_PDF =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3v11m0 0-4-4m4 4 4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function desenharMaterial() {
    const itens = R.materialDaPagina(pagina);
    const secao = $("material");
    const navMaterial = $("nav-material");
    if (!itens.length) {
      secao.hidden = true;
      if (navMaterial) navMaterial.hidden = true;
      return;
    }
    const material = pagina.material || {};
    escreverTexto("material-titulo", material.titulo);
    escreverTexto("material-apoio", material.apoio);

    const alvo = $("lista-material");
    alvo.textContent = "";
    for (const item of itens) {
      const link = document.createElement("a");
      link.className = "sala-baixar";
      link.href = item.link;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.dataset.material = item.id;

      const icone = document.createElement("span");
      icone.className = "sala-baixar-icone";
      icone.innerHTML = ICONE_PDF;

      const bloco = document.createElement("span");
      bloco.className = "sala-baixar-texto";
      if (item.tipo) {
        const tipo = document.createElement("span");
        tipo.className = "sala-baixar-tipo";
        tipo.textContent = item.tipo;
        bloco.append(tipo);
      }
      const titulo = document.createElement("strong");
      titulo.textContent = item.titulo;
      bloco.append(titulo);
      if (item.descricao) {
        const desc = document.createElement("span");
        desc.textContent = item.descricao;
        bloco.append(desc);
      }

      link.append(icone, bloco);
      link.addEventListener("click", () => pixel("trackCustom", "replay_material", { pagina: pagina.id, material: item.id }));
      alvo.append(link);
    }
    if (navMaterial) navMaterial.hidden = false;
  }

  function desenharCertificado() {
    const secao = $("certificado");
    const nav = $("nav-certificado");
    if (!R.certificadoVisivel(pagina)) {
      // Escondido de verdade: some da tela, do Ctrl+F e do leitor de tela.
      secao.hidden = true;
      if (nav) nav.hidden = true;
      return;
    }
    const c = pagina.certificado;
    escreverTexto("certificado-titulo", c.titulo);
    escreverTexto("certificado-apoio", c.apoio);
    escreverTexto("certificado-cta-texto", c.cta);
    const cta = $("certificado-cta");
    cta.href = c.link;
    const imagem = $("certificado-imagem");
    if (c.imagem) imagem.src = c.imagem;
    else imagem.remove();
    secao.hidden = false;
    if (nav) nav.hidden = false;
  }

  /* ================================================================== */
  /* Trancar e abrir                                                     */
  /* ================================================================== */

  function abrirSala({ recemLiberado = false } = {}) {
    $("secao-acesso").hidden = true;
    $("aulas").hidden = false;
    desenharAulas();
    desenharMaterial();
    desenharCertificado();
    const nav = $("sala-nav");
    if (nav) nav.hidden = false;
    if (recemLiberado) {
      anunciar("Acesso liberado. A aula está abaixo.");
      const aulas = $("aulas");
      aulas.scrollIntoView({ behavior: "smooth", block: "start" });
      const titulo = $("aulas-titulo");
      if (titulo) {
        titulo.setAttribute("tabindex", "-1");
        titulo.focus({ preventScroll: true });
      }
    }
  }

  /* ================================================================== */
  /* Validação (a mesma régua da pesquisa e da inscrição)                */
  /* ================================================================== */

  function mostrarErro(campo, mensagem) {
    const caixa = $(`erro-${campo}`);
    const grupo = form.querySelector(`[data-campo="${campo}"]`);
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

  // O clique encerra o "apertando", nunca um timer (navegador lento atrasava a volta e o blur
  // seguinte deixava de validar).
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
  /* As quatro profissões                                                */
  /* ================================================================== */

  function desenharPerfis() {
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
      const texto = document.createElement("span");
      texto.textContent = rotulo;
      opcao.append(marca, texto);
      opcao.addEventListener("click", () => escolherPerfil(rotulo));
      listaOpcoes.append(opcao);
    }
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
    status.textContent = "";
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

  /* ================================================================== */
  /* Envio                                                               */
  /* ================================================================== */

  form.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    if (enviando) return;
    tentouEnviar = true;
    status.textContent = "";

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

    // Sugestão pendente (gmial.com): a pessoa escolhe corrigir ou manter antes de seguir.
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
    status.textContent = "Liberando…";

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
      if (resposta.status === 422 || resposta.status === 400) {
        const json = await resposta.json().catch(() => null);
        if (json && json.campos) camposComErro = json.campos;
      }
    } catch {
      // Rede caída ou demora: a pessoa não fica presa na porta. A sala abre e o registro vai de
      // novo em keepalive.
      try {
        const blob = new Blob([JSON.stringify(corpo)], { type: "application/json" });
        navigator.sendBeacon?.(API, blob);
      } catch {
        // sem sendBeacon: o registro se perde, mas o acesso da pessoa continua
      }
    }

    enviando = false;
    botao.disabled = false;
    botao.removeAttribute("aria-busy");
    status.textContent = "";

    if (camposComErro) {
      mostrarErrosDoServidor(camposComErro);
      return;
    }

    gravarJson(CHAVE_ACESSO, { id: sessaoId, liberado: true, em: Date.now(), contato, perfil: perfilEscolhido });
    pixel("track", "Lead");
    pixel("trackCustom", "replay_acesso", { pagina: pagina.id, perfil: P.PERFIL_CODIGO[perfilEscolhido] || null });
    abrirSala({ recemLiberado: true });
  });

  /* ================================================================== */
  /* Início                                                             */
  /* ================================================================== */

  desenharTopo();
  desenharPerfis();
  if (acessoValido()) abrirSala();
  document.body.classList.add("pronto");
})();
