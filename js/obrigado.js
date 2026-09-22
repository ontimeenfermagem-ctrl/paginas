/*
 * obrigado.js — monta a página de obrigado certa a partir da rota (obrigado.html).
 *
 * Uma página, três rotas (/obrigado-afericao, /obrigado-cuidador, /obrigado-evento-outubro).
 * Texto, botão e link do grupo vêm de EVObrigado (js/obrigado-config.js); esta página nunca
 * mostra o link de outro grupo e nunca mostra botão quebrado.
 *
 * Registra dois eventos em /api/pagina/evento: "visita" ao abrir e "clique_grupo" ao tocar no
 * botão. O clique NUNCA espera a rede: o link abre na hora e o registro vai com keepalive.
 */
(function () {
  "use strict";

  const P = window.EVPesquisa;
  const O = window.EVObrigado;
  if (!P || !O) return;

  const CHAVE_VISITANTE = "ev_pesquisa_visitante";
  const CHAVE_RASCUNHO = "ev_pesquisa_icp_v1";
  const API_EVENTO = "/api/pagina/evento";
  const CAMPANHA = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "gclid"];
  const TETO = { page_url: 2048, referrer: 2048, fbclid: 1000, gclid: 1000 };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const $ = (id) => document.getElementById(id);
  const emDesenvolvimento = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

  /* ------------------------------------------------ armazenamento (webview pode bloquear) */

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
      // Sem storage a página funciona igual; só não reconhece o aparelho da próxima vez.
    }
  }

  /** O rascunho da pesquisa neste aparelho (quem acabou de responder). Nunca lança. */
  function lerRascunho() {
    try {
      const bruto = JSON.parse(lerStorage(CHAVE_RASCUNHO) || "null");
      return bruto && typeof bruto === "object" ? bruto : null;
    } catch {
      return null;
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

  /** O mesmo visitante da pesquisa; quem chega aqui sem ter passado por ela ganha um agora. */
  function visitanteDoAparelho() {
    const guardado = lerStorage(CHAVE_VISITANTE);
    if (guardado && UUID.test(guardado)) return guardado;
    const novo = novoUuid();
    gravarStorage(CHAVE_VISITANTE, novo);
    return novo;
  }

  /* ------------------------------------------------ rastreio */

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
   * UTMs e ids de clique da URL atual (o formulário repassa os dele no redirecionamento). Sem
   * nenhum na URL, vale o bloco de primeiro toque guardado no rascunho — inteiro, sem misturar
   * campanha de uma visita com a de outra (mesma regra do formulário).
   */
  function rastreio(rascunho) {
    const query = new URLSearchParams(window.location.search);
    const daUrl = {};
    for (const campo of CAMPANHA) daUrl[campo] = texto(query.get(campo), campo);
    const salvo = rascunho && rascunho.rastreio && typeof rascunho.rastreio === "object" ? rascunho.rastreio : {};
    const usarUrl = CAMPANHA.some((campo) => daUrl[campo]);
    const dados = {
      // Sem o #: âncora não diz nada sobre a origem.
      page_url: texto(window.location.origin + window.location.pathname + window.location.search, "page_url"),
      referrer: texto(document.referrer, "referrer"),
      dispositivo: dispositivo()
    };
    for (const campo of CAMPANHA) {
      dados[campo] = usarUrl ? daUrl[campo] : typeof salvo[campo] === "string" ? texto(salvo[campo], campo) : null;
    }
    return dados;
  }

  /* ------------------------------------------------ envio de eventos */

  function enviarEvento(corpoObjeto, { beacon = false } = {}) {
    const corpo = JSON.stringify(corpoObjeto);
    try {
      if (typeof window.fetch === "function") {
        window
          .fetch(API_EVENTO, {
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
    if (!beacon) return;
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(API_EVENTO, new Blob([corpo], { type: "application/json" }));
    } catch {
      // Contagem de clique não vale um botão quebrado.
    }
  }

  function pixel(evento, dados) {
    if (typeof window.fbq !== "function") return;
    try {
      window.fbq("trackCustom", evento, dados);
    } catch {
      // Bloqueador de anúncio não pode atrapalhar o clique.
    }
  }

  /* ------------------------------------------------ montagem */

  function montarDesconhecida() {
    document.title = "Página não encontrada | Escola Enfermagem de Valor";
    $("ob-desconhecida").hidden = false;
  }

  /** "Pesquisa concluída! Agora..." → "Pesquisa concluída, Maria! Agora..." (sem nome: exata). */
  function headlineComNome(headline, nome) {
    if (!nome) return headline;
    const i = headline.indexOf("!");
    if (i <= 0) return `${nome}, ${headline}`;
    return `${headline.slice(0, i)}, ${nome}${headline.slice(i)}`;
  }

  function montar(pagina) {
    const rascunho = lerRascunho();
    const contato = rascunho && rascunho.contato && typeof rascunho.contato === "object" ? rascunho.contato : null;
    const nome = contato ? P.primeiroNome(String(contato.nome || "").slice(0, 60)).slice(0, 30) : "";

    // Perfil e sessão só quando o rascunho é desta página: um aparelho que respondeu como técnica
    // e abriu o link do grupo de cuidadores não vira "técnica que visitou a página de cuidador".
    const perfilRascunho =
      rascunho && rascunho.respostas && typeof rascunho.respostas.perfil === "string" ? rascunho.respostas.perfil : null;
    const perfil = perfilRascunho && pagina.perfis.includes(perfilRascunho) ? perfilRascunho : null;
    const sessaoId = perfil && contato && UUID.test(String(rascunho.id || "")) ? rascunho.id : null;
    const codigoPerfil = (perfil && P.PERFIL_CODIGO && P.PERFIL_CODIGO[perfil]) || "";

    document.title = `${pagina.nome} | Escola Enfermagem de Valor`;
    // Trechos curtos entre " · " ficam inteiros na quebra de linha ("dia 28" nunca se separa);
    // um trecho longo quebra normal, senão não caberia em 320px.
    const eyebrow = $("ob-eyebrow");
    eyebrow.textContent = "";
    pagina.eyebrow.split(" · ").forEach((trecho, i) => {
      if (i > 0) eyebrow.append(" · ");
      const parte = document.createElement("span");
      if (trecho.length <= 18) parte.className = "inteiro";
      parte.textContent = trecho;
      eyebrow.append(parte);
    });
    $("ob-titulo").textContent = headlineComNome(pagina.headline, nome);
    $("ob-sub").textContent = pagina.subheadline;
    $("ob-intro").textContent = pagina.introducao;
    const lista = $("ob-topicos");
    lista.textContent = "";
    for (const topico of pagina.topicos) {
      const item = document.createElement("li");
      item.textContent = topico;
      lista.append(item);
    }

    const botoes = [$("ob-cta"), $("ob-cta-fim")];
    const temLink = O.linkValido(pagina.link);
    for (const botao of botoes) {
      botao.querySelector("[data-cta-texto]").textContent = pagina.cta;
      if (temLink) {
        botao.href = pagina.link;
        botao.hidden = false;
      } else {
        botao.removeAttribute("href");
        botao.hidden = true;
      }
    }
    $("ob-nota").hidden = !temLink;
    $("ob-aviso").hidden = temLink;
    if (!temLink && emDesenvolvimento) {
      console.info(`[obrigado] O link do grupo "${pagina.grupo}" ainda não foi configurado em js/obrigado-config.js (LINKS_GRUPOS).`);
    }

    $("ob-pagina").hidden = false;
    $("ob-rodape").hidden = false;

    const base = {
      pagina: pagina.id,
      visitante_id: visitanteDoAparelho(),
      sessao_id: sessaoId,
      perfil
    };
    const dadosRastreio = rastreio(rascunho);
    enviarEvento(Object.assign({ evento: "visita" }, base, dadosRastreio));

    if (temLink) {
      const aoClicar = () => {
        // Nada de preventDefault nem await: o WhatsApp abre na hora, o registro vai por trás.
        enviarEvento(Object.assign({ evento: "clique_grupo" }, base, dadosRastreio), { beacon: true });
        pixel("clique_grupo_whatsapp", { grupo: pagina.grupo, perfil: codigoPerfil });
      };
      for (const botao of botoes) botao.addEventListener("click", aoClicar);
    }
  }

  function iniciar() {
    let pagina = null;
    try {
      pagina = O.paginaDaRota(window.location.pathname);
    } catch {
      pagina = null;
    }
    if (!pagina) {
      montarDesconhecida();
      return;
    }
    montar(pagina);
  }

  iniciar();
})();
