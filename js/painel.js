/*
 * painel.js — o /painel da pesquisa de ICP da Escola Enfermagem de Valor.
 *
 * Mesmo molde do /admin do quintino-landing: login → painel, api() que nunca lança, número de
 * sequência para resposta antiga não sobrescrever a nova, status aria-live, foco devolvido
 * depois de redesenhar, "Ver tudo" sem ir à rede.
 *
 * Duas regras que valem para o arquivo inteiro:
 *
 *   1. Nenhum número agregado sai das linhas carregadas na tela. Placar, funil, quadros, ICP e
 *      tráfego vêm de /api/painel/resumo (SQL sobre todas as respostas do recorte); a tabela
 *      cruzada vem de /api/painel/cruzamento. Os quatro filtros da barra do topo (período, perfil,
 *      situação e busca) valem para TODA requisição: números, lista, abertas e CSV mostram
 *      sempre o mesmo recorte. Acesso e clique em Começar não têm pessoa: só o período vale neles.
 *   2. O painel não tem lista própria de perguntas. Rótulos, ordem, alternativas, perfis e
 *      condicionais vêm de EVPesquisa (js/pesquisa-config.js), o mesmo arquivo que a pesquisa
 *      e o servidor usam. Mudou lá, mudou aqui.
 *
 * Tudo o que vem do banco passa por escapeHtml antes de virar HTML. Nada de dado pessoal no
 * console.
 */
(() => {
  "use strict";

  const EV = window.EVPesquisa;
  // As páginas de obrigado (js/obrigado-config.js). Sem ele, só a aba delas avisa do problema.
  const OBR = window.EVObrigado || null;
  // As páginas de inscrição com checkout na Hotmart (js/checkout-config.js). Mesma regra.
  const CHK = window.EVCheckout || null;
  const FUSO = "America/Sao_Paulo";
  const LIMITE_LISTA = 50;
  const LIMITE_ABERTAS = 30;
  const LIMITE_OUTRO = 20;
  const AUTO_MS = 60 * 1000;

  const loginView = document.querySelector("[data-login-view]");
  const panelView = document.querySelector("[data-panel-view]");
  const loginForm = document.getElementById("painel-login");
  const loginStatus = document.querySelector("[data-login-status]");
  const panelStatus = document.querySelector("[data-panel-status]");

  // Sem o config não há rótulo nem alternativa: melhor dizer isso do que desenhar um painel
  // com perguntas inventadas.
  if (!EV) {
    if (loginView) {
      loginView.hidden = false;
      loginStatus.textContent = "Não foi possível carregar a configuração da pesquisa. Recarregue a página.";
    }
    return;
  }

  const $ = (seletor, raiz = document) => raiz.querySelector(seletor);
  const $$ = (seletor, raiz = document) => Array.from(raiz.querySelectorAll(seletor));

  /* ================================================================== */
  /* Páginas do funil                                                     */
  /* ================================================================== */

  /**
   * O /painel vai englobar as próximas páginas do funil. Cada uma é UMA entrada aqui: id (o
   * mesmo do atributo data-pagina-conteudo no painel.html, onde mora o HTML dela), nome, rota
   * pública e as funções dela — `entrar` (monta e carrega na primeira vez; atualiza nas outras),
   * `atualizar` e `sair` (limpa dado pessoal da memória no logout). No banco, a coluna
   * `pesquisa` já separa os dados de cada formulário. Página nova = entrada nova + o bloco dela no
   * HTML + as rotas /api/painel/<id>/... dela; a da pesquisa não precisa ser reescrita.
   * As funções da pesquisa são ligadas mais abaixo, quando existem.
   */
  // `filtrar` = o período da barra mudou (vale para todas as páginas).
  //
  // Páginas de inscrição (js/checkout-config.js): UMA ABA POR PÁGINA, com o nome e a rota de lá,
  // nunca escritos à mão. Todas usam o MESMO bloco do painel.html (`conteudo: "inscricoes"`) e o
  // mesmo estado `ins`, que é limpo e recarregado quando se passa de uma página para outra. O id da
  // aba é "inscricoes-<id da página>"; o antigo ?pagina=inscricoes (de quando havia uma aba só) abre
  // a primeira, para link salvo não cair na pesquisa.
  const PAGINAS_CHECKOUT = CHK ? Array.from(CHK.LISTA) : [];
  const ABA_INSCRICOES_ANTIGA = "inscricoes";

  /** O host de uma página que mora em outro site ("io.escola..."); "" para as deste servidor. */
  function hostDaInscricao(pagina) {
    return pagina && pagina.origem ? String(pagina.origem).replace(/^https?:\/\//i, "").replace(/\/+$/, "") : "";
  }

  /** A rota como a equipe digita: página de outro site leva o host junto (io.escola.../rota). */
  function rotaDaInscricao(pagina) {
    if (!pagina) return "—";
    return `${hostDaInscricao(pagina)}${pagina.rota}`;
  }

  /** A mesma rota em HTML, com um ponto de quebra entre o host e o caminho (celular). */
  function rotaHtml(host, rota) {
    return host ? `${escapeHtml(host)}<wbr>${escapeHtml(rota)}` : escapeHtml(rota);
  }

  const PAGINAS = [
    { id: "pesquisa-icp", conteudo: "pesquisa-icp", nome: "Pesquisa ICP", rota: "/pesquisa-icp", entrar: null, atualizar: null, sair: null, filtrar: null },
    { id: "obrigado", conteudo: "obrigado", nome: "Páginas de obrigado", rota: "/obrigado-*", entrar: null, atualizar: null, sair: null, filtrar: null },
    { id: "perfis", conteudo: "perfis", nome: "Perfis atualizados", rota: "/atualizacao-perfil", entrar: null, atualizar: null, sair: null, filtrar: null },
    ...(PAGINAS_CHECKOUT.length
      ? PAGINAS_CHECKOUT.map((pagina) => ({
          id: `inscricoes-${pagina.id}`,
          conteudo: "inscricoes",
          nome: pagina.nome,
          rota: pagina.rota,
          host: hostDaInscricao(pagina),
          inscricao: pagina,
          entrar: null,
          atualizar: null,
          sair: null,
          filtrar: null
        }))
      : // Sem o config, a aba continua lá para dizer o que falta (ver carregarInscricoes).
        [{ id: ABA_INSCRICOES_ANTIGA, conteudo: "inscricoes", nome: "Inscrições", rota: "—", inscricao: null, entrar: null, atualizar: null, sair: null, filtrar: null }])
  ];
  const ABAS_INSCRICAO = PAGINAS.filter((pagina) => pagina.conteudo === "inscricoes");
  let paginaAtual = PAGINAS[0];

  /** A aba de um id da URL: o id exato, ou o apelido antigo da aba única de inscrições. */
  function paginaDoId(id) {
    const exata = PAGINAS.find((item) => item.id === id);
    if (exata) return exata;
    return id === ABA_INSCRICOES_ANTIGA ? ABAS_INSCRICAO[0] || null : null;
  }

  function pintarPaginas() {
    // Perfil, busca e situação só existem na pesquisa: nas outras abas a barra fica só com o período.
    const filtros = $("[data-filtros]");
    if (filtros) filtros.dataset.paginaAtiva = paginaAtual.id;
    const faixa = $("[data-paginas]");
    if (!faixa) return;
    // aria-controls aponta para o bloco de conteúdo (as abas de inscrição dividem um só), e o bloco
    // visível passa a ser rotulado pela aba aberta.
    faixa.innerHTML = PAGINAS.map((pagina) => {
      const ativa = pagina === paginaAtual;
      return `<button type="button" class="pagina" role="tab" id="pagina-${escapeHtml(pagina.id)}" aria-controls="pagina-${escapeHtml(
        pagina.conteudo
      )}-painel" aria-selected="${ativa}" tabindex="${ativa ? 0 : -1}" data-pagina="${escapeHtml(pagina.id)}"><span class="pagina-nome">${escapeHtml(
        pagina.nome
      )}</span><span class="pagina-rota">rota ${rotaHtml(pagina.host, pagina.rota)}</span></button>`;
    }).join("");
    $$("[data-pagina-conteudo]").forEach((bloco) => {
      bloco.hidden = bloco.dataset.paginaConteudo !== paginaAtual.conteudo;
      if (!bloco.hidden) bloco.setAttribute("aria-labelledby", `pagina-${paginaAtual.id}`);
    });
    // No celular a faixa rola de lado: a aba aberta precisa estar visível nela.
    mostrarAbaAtiva(faixa);
  }

  function trocarPagina(id) {
    const pagina = PAGINAS.find((item) => item.id === id);
    if (!pagina || pagina === paginaAtual) return;
    paginaAtual = pagina;
    pintarPaginas();
    escreverUrl();
    pintarAtualizado();
    if (typeof pagina.entrar === "function") pagina.entrar();
  }

  /** O período mudou: a página aberta recarrega com ele (as outras, quando forem abertas). */
  function aplicarPeriodo() {
    if (typeof paginaAtual.filtrar === "function") paginaAtual.filtrar();
  }

  /* ================================================================== */
  /* Vocabulário vindo do config                                          */
  /* ================================================================== */

  // Chave curta do perfil (tecnico, cuidador...) é o que vai na URL: link compartilhável e
  // legível. A API recebe o valor completo, que é o que está gravado no banco.
  const PERFIS = Object.entries(EV.PERFIL).map(([chave, valor]) => ({
    chave,
    valor,
    curto: EV.PERFIL_CURTO[valor] || valor
  }));
  const PERFIL_POR_CHAVE = new Map(PERFIS.map((perfil) => [perfil.chave, perfil]));
  const PERFIL_POR_VALOR = new Map(PERFIS.map((perfil) => [perfil.valor, perfil]));
  const ANALISAVEIS = EV.perguntasAnalisaveis();
  const INDICE_PERGUNTA = new Map(EV.PERGUNTAS.map((pergunta, indice) => [pergunta.id, indice]));

  function perfilCurto(valor) {
    if (!valor) return "Sem perfil";
    return EV.PERFIL_CURTO[valor] || valor;
  }

  /** "Pergunta 9" / "Pergunta B1" — como o documento da pesquisa numera. */
  function numeroDa(pergunta) {
    return pergunta ? pergunta.numero : "?";
  }

  const PERIODOS = {
    hoje: "Hoje",
    7: "Últimos 7 dias",
    30: "Últimos 30 dias",
    tudo: "Desde o começo",
    personalizado: "Período personalizado"
  };

  /* ================================================================== */
  /* Estado                                                               */
  /* ================================================================== */

  const state = {
    email: "",
    periodo: "tudo",
    de: "",
    ate: "",
    perfil: "", // chave curta ("tecnico"), "" = todos
    // Resumo sem filtro de perfil (contagem das abas, acesso/começo, cartões de ICP) e o do
    // perfil escolhido. Sem perfil escolhido os dois são o mesmo objeto.
    geral: null,
    resumo: null,
    geradoEm: "",
    resumoChave: "", // filtros do resumo que está na tela
    erroResumo: 0,
    carregouUmaVez: false,
    lista: { itens: [], total: 0, carregando: false, erro: 0, pronto: false },
    busca: "",
    status: "",
    abertos: new Set(),
    cruz: { linha: "perfil", coluna: "renda_atual", modo: "linha", dados: null, erro: 0, carregando: false },
    aberta: "problema",
    abertas: { itens: [], total: 0, erro: 0, carregando: false, pronto: false },
    abertasBusca: "",
    outros: new Map(), // id da pergunta → { itens, total, carregando, erro }
    etapasAbertas: new Set([1]),
    // Cartões de ICP abertos/fechados pela pessoa (chave do perfil → aberto?). Sem escolha:
    // todos abertos no computador, só o primeiro no celular (cinco cartões de 18 linhas empilhados
    // viram uma rolagem sem fim).
    icpEscolhas: new Map(),
    diaTabela: false,
    trafegoCampo: "utm_source",
    focoDepois: ""
  };

  const ABERTAS = {
    problema: { chaves: ["problema_unico"], pergunta: "problema_unico" },
    sonho: { chaves: ["sonho"], pergunta: "sonho" },
    frase: { chaves: ["frase_desejo", "frase_bloqueio"], pergunta: "frase" }
  };

  /* ================================================================== */
  /* Utilidades                                                           */
  /* ================================================================== */

  function escapeHtml(valor) {
    return String(valor == null ? "" : valor).replace(/[&<>"']/g, (caractere) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[caractere]);
  }

  const NUM = new Intl.NumberFormat("pt-BR");
  const DEC = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function n(valor) {
    return NUM.format(Number(valor) || 0);
  }

  function num(valor) {
    const numero = Number(valor);
    return Number.isFinite(numero) ? numero : 0;
  }

  /** Porcentagem inteira; "<1%" quando existe mas arredonda para zero (zero mentiria). */
  function pct(parte, base) {
    const p = num(parte);
    const b = num(base);
    if (!b) return "—";
    const valor = (p / b) * 100;
    if (p > 0 && valor < 0.5) return "<1%";
    return `${Math.round(valor)}%`;
  }

  function plural(quantidade, um, muitos) {
    return `${n(quantidade)} ${num(quantidade) === 1 ? um : muitos}`;
  }

  const FMT_DATA_HORA = new Intl.DateTimeFormat("pt-BR", {
    timeZone: FUSO,
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const FMT_HORA = new Intl.DateTimeFormat("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
  const FMT_YMD = new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" });

  function dataHora(valor) {
    if (!valor) return "—";
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? "—" : FMT_DATA_HORA.format(data).replace(",", "");
  }

  function hora(valor) {
    const data = valor ? new Date(valor) : new Date();
    return Number.isNaN(data.getTime()) ? "—" : FMT_HORA.format(data);
  }

  /** "12 s", "7 min 32 s", "1 h 05 min". */
  function duracao(segundos) {
    if (segundos == null || segundos === "") return "—";
    const total = Math.max(0, Math.round(num(segundos)));
    if (total < 60) return `${total} s`;
    const horas = Math.floor(total / 3600);
    const minutos = Math.floor((total % 3600) / 60);
    const resto = total % 60;
    if (horas) return `${horas} h ${String(minutos).padStart(2, "0")} min`;
    return resto ? `${minutos} min ${String(resto).padStart(2, "0")} s` : `${minutos} min`;
  }

  function whatsappLink(digitos) {
    const so = String(digitos || "").replace(/\D/g, "");
    return so ? `https://wa.me/55${so}` : "";
  }

  function origemTexto(item) {
    const partes = [item.utm_source, item.utm_campaign].filter(Boolean);
    return partes.length ? partes.join(" · ") : "direto";
  }

  /* ------------------------------------------------------------ Datas no fuso de Brasília */

  function hojeSP() {
    return FMT_YMD.format(new Date());
  }

  function ymdDe(valor) {
    const data = new Date(valor);
    return Number.isNaN(data.getTime()) ? "" : FMT_YMD.format(data);
  }

  function somarDias(ymd, dias) {
    const [ano, mes, dia] = ymd.split("-").map(Number);
    const data = new Date(Date.UTC(ano, mes - 1, dia + dias));
    return data.toISOString().slice(0, 10);
  }

  function ymdValido(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return false;
    return somarDias(ymd, 0) === ymd;
  }

  /**
   * Meia-noite de Brasília daquele dia, em ISO (UTC). O deslocamento é lido do próprio
   * navegador via Intl ("GMT-3"), e não fixado: se o horário de verão voltar, o painel não
   * passa a cortar o dia uma hora antes. Navegador sem shortOffset cai no -03:00 de hoje.
   */
  function inicioDoDia(ymd) {
    let deslocamento = "-03:00";
    try {
      const partes = new Intl.DateTimeFormat("en-US", { timeZone: FUSO, timeZoneName: "shortOffset" })
        .formatToParts(new Date(`${ymd}T12:00:00Z`));
      const nome = (partes.find((parte) => parte.type === "timeZoneName") || {}).value || "";
      const achou = nome.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
      if (achou) deslocamento = `${achou[1]}${achou[2].padStart(2, "0")}:${achou[3] || "00"}`;
    } catch {
      /* fica o padrão */
    }
    return new Date(`${ymd}T00:00:00${deslocamento}`).toISOString();
  }

  /** Recorte de tempo atual: { desde, ate } em ISO e o primeiro/último dia (inclusivo). */
  function intervalo() {
    const hoje = hojeSP();
    switch (state.periodo) {
      case "hoje":
        return { desde: inicioDoDia(hoje), ate: "", primeiro: hoje, ultimo: hoje };
      case "7":
      case "30": {
        const primeiro = somarDias(hoje, -(Number(state.periodo) - 1));
        return { desde: inicioDoDia(primeiro), ate: "", primeiro, ultimo: hoje };
      }
      case "personalizado":
        if (ymdValido(state.de) && ymdValido(state.ate)) {
          return {
            desde: inicioDoDia(state.de),
            // [desde, ate): o "até" do formulário é inclusivo, então o corte é a meia-noite
            // do dia seguinte.
            ate: inicioDoDia(somarDias(state.ate, 1)),
            primeiro: state.de,
            ultimo: state.ate
          };
        }
        return { desde: "", ate: "", primeiro: "", ultimo: "" };
      default:
        return { desde: "", ate: "", primeiro: "", ultimo: hoje };
    }
  }

  function rotuloPeriodo() {
    if (state.periodo === "personalizado" && ymdValido(state.de) && ymdValido(state.ate)) {
      return `De ${dataCurta(state.de, true)} a ${dataCurta(state.ate, true)}`;
    }
    return PERIODOS[state.periodo] || "Período selecionado";
  }

  function dataCurta(ymd, comAno) {
    const [ano, mes, dia] = String(ymd).split("-");
    return comAno ? `${dia}/${mes}/${ano}` : `${dia}/${mes}`;
  }

  const DIAS_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

  function diaSemana(ymd) {
    const [ano, mes, dia] = ymd.split("-").map(Number);
    return DIAS_SEMANA[new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay()];
  }

  /* ------------------------------------------------------------ Rede */

  // Nunca lança: sem rede, devolve status 0 para a tela continuar utilizável.
  async function api(caminho, opcoes = {}) {
    try {
      const resposta = await fetch(caminho, {
        credentials: "same-origin",
        headers: { Accept: "application/json", ...(opcoes.body ? { "Content-Type": "application/json" } : {}) },
        ...opcoes
      });
      let corpo = {};
      try {
        corpo = await resposta.json();
      } catch {
        corpo = {};
      }
      if (!corpo || typeof corpo !== "object") corpo = {};
      return { status: resposta.status, ok: resposta.ok && corpo.ok !== false, body: corpo };
    } catch {
      return { status: 0, ok: false, body: {} };
    }
  }

  function mensagemErro(status) {
    if (status === 0) return "Sem conexão com o servidor. Verifique a internet e tente de novo.";
    if (status === 503) return "O banco de dados ainda não está configurado no servidor.";
    if (status === 429) return "Muitas requisições seguidas. Espere um instante e tente de novo.";
    if (status === 422) return "O filtro escolhido não é válido. Confira as datas e tente de novo.";
    return "Não foi possível carregar os dados agora. Tente de novo em instantes.";
  }

  /** Os filtros da barra (período, perfil, situação e busca) como query string. */
  function parametros({ comPerfil = true } = {}) {
    const params = new URLSearchParams();
    const { desde, ate } = intervalo();
    if (desde) params.set("desde", desde);
    if (ate) params.set("ate", ate);
    const perfil = PERFIL_POR_CHAVE.get(state.perfil);
    if (comPerfil && perfil) params.set("perfil", perfil.valor);
    if (state.status) params.set("status", state.status);
    const busca = state.busca.trim();
    if (busca) params.set("busca", busca);
    return params;
  }

  const STATUS_ROTULO = { concluida: "Responderam tudo", em_andamento: "Em andamento" };

  /** Algum filtro que só existe para quem se identificou (perfil, situação ou busca)? */
  function filtroDePessoa() {
    return Boolean(state.perfil || state.status || state.busca.trim());
  }

  /** Marca dos números de acesso quando há filtro de pessoa: eles não mudam com esses filtros. */
  function seloSemFiltro() {
    return filtroDePessoa()
      ? '<span class="selo-todos" title="Acesso e clique em Começar não têm nome nem perfil: só o período vale aqui">sem filtro de pessoa<span class="visualmente-oculto">: acesso não tem nome nem perfil</span></span>'
      : "";
  }

  /** "“maria” · responderam tudo · técnicos" — para legendas. Vazio sem filtro de pessoa. */
  function descricaoFiltroPessoa() {
    const partes = [];
    const busca = state.busca.trim();
    if (busca) partes.push(`“${busca}”`);
    if (state.status) partes.push(STATUS_ROTULO[state.status].toLowerCase());
    const perfil = PERFIL_POR_CHAVE.get(state.perfil);
    if (perfil) partes.push(perfil.curto.toLowerCase());
    return partes.join(" · ");
  }

  /* ------------------------------------------------------------ Foco */

  /**
   * Redesenha um bloco inteiro sem perder o foco do teclado. Todo controle que pode ser
   * recriado tem um data-foco estável; depois do innerHTML, o foco volta para o de mesma chave.
   */
  function redesenhar(alvo, html) {
    if (!alvo) return;
    const ativo = document.activeElement;
    const chave = ativo && alvo.contains(ativo) && ativo.closest("[data-foco]")
      ? ativo.closest("[data-foco]").getAttribute("data-foco")
      : "";
    alvo.innerHTML = html;
    const pedido = state.focoDepois;
    const procurar = pedido || chave;
    if (procurar) {
      const novo = alvo.querySelector(`[data-foco="${CSS.escape(procurar)}"]`);
      if (novo) {
        novo.focus({ preventScroll: true });
        if (pedido) state.focoDepois = "";
      }
    }
  }

  function esqueleto(linhas = 5) {
    return `<div class="esqueleto" aria-hidden="true">${"<span></span>".repeat(linhas)}</div>`;
  }

  function vazioHtml(titulo, texto) {
    return `<div class="vazio"><strong>${escapeHtml(titulo)}</strong>${texto ? `<span>${escapeHtml(texto)}</span>` : ""}</div>`;
  }

  function erroHtml(status, acao, chaveFoco) {
    return `<div class="erro" role="alert"><strong>Não deu para carregar esta parte.</strong><span>${escapeHtml(
      mensagemErro(status)
    )}</span><button type="button" class="botao botao-leve botao-pequeno" data-repetir="${escapeHtml(acao)}" data-foco="${escapeHtml(
      chaveFoco || `repetir-${acao}`
    )}">Tentar de novo</button></div>`;
  }

  /* ================================================================== */
  /* Login e sessão                                                       */
  /* ================================================================== */

  function mostrarLogin(mensagem) {
    pararAuto();
    loginView.hidden = false;
    panelView.hidden = true;
    loginStatus.textContent = mensagem || "";
    const email = document.getElementById("login-email");
    if (email) email.focus();
  }

  function mostrarPainel() {
    loginView.hidden = true;
    panelView.hidden = false;
    $("[data-conta-email]").textContent = state.email;
    const titulo = $("[data-panel-title]");
    if (titulo) titulo.focus({ preventScroll: true });
    iniciarAuto();
  }

  /** Troca de sessão: TODAS as páginas do funil soltam o que têm de dado pessoal na memória. */
  function limparTodas() {
    for (const pagina of PAGINAS) if (typeof pagina.sair === "function") pagina.sair();
  }

  function sessaoExpirou() {
    limparTodas();
    mostrarLogin("Sua sessão expirou. Entre de novo.");
  }

  function limparDados() {
    // Troca de sessão não pode deixar dado pessoal da anterior na memória da página.
    state.geral = null;
    state.resumo = null;
    state.carregouUmaVez = false;
    state.lista = { itens: [], total: 0, carregando: false, erro: 0, pronto: false };
    state.abertas = { itens: [], total: 0, erro: 0, carregando: false, pronto: false };
    state.cruz.dados = null;
    state.outros.clear();
    state.abertos.clear();
    // Invalida tudo que ainda estiver em voo.
    seq.resumo++;
    seq.lista++;
    seq.cruz++;
    seq.abertas++;
  }

  loginForm.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const botao = loginForm.querySelector('button[type="submit"]');
    const email = document.getElementById("login-email").value.trim();
    const senha = document.getElementById("login-senha").value;

    if (!email || !senha) {
      loginStatus.textContent = "Preencha e-mail e senha.";
      (email ? document.getElementById("login-senha") : document.getElementById("login-email")).focus();
      return;
    }

    botao.disabled = true;
    loginStatus.textContent = "Entrando...";
    const { status, ok, body } = await api("/api/painel/login", {
      method: "POST",
      body: JSON.stringify({ email, senha })
    });
    botao.disabled = false;

    if (ok) {
      state.email = body.email || email;
      document.getElementById("login-senha").value = "";
      loginStatus.textContent = "";
      mostrarPainel();
      paginaAtual.entrar();
      return;
    }

    loginStatus.textContent =
      status === 0
        ? "Sem conexão com o servidor. Verifique a internet e tente de novo."
        : status === 429
          ? "Muitas tentativas. Espere alguns minutos e tente de novo."
          : status === 503
            ? "O painel ainda não está configurado no servidor."
            : status === 401
              ? "E-mail ou senha incorretos."
              : "Não foi possível entrar agora. Tente de novo em instantes.";
    document.getElementById("login-senha").focus();
  });

  $("[data-sair]").addEventListener("click", async () => {
    await api("/api/painel/logout", { method: "POST", body: JSON.stringify({}) });
    state.email = "";
    limparTodas();
    mostrarLogin("Você saiu do painel.");
  });

  /* ================================================================== */
  /* URL ⇄ filtros                                                        */
  /* ================================================================== */

  function lerUrl() {
    const params = new URLSearchParams(window.location.search);
    const pagina = paginaDoId(params.get("pagina"));
    if (pagina) paginaAtual = pagina;
    const periodo = params.get("periodo");
    if (periodo && Object.prototype.hasOwnProperty.call(PERIODOS, periodo)) state.periodo = periodo;
    if (state.periodo === "personalizado") {
      const de = params.get("de") || "";
      const ate = params.get("ate") || "";
      if (ymdValido(de) && ymdValido(ate) && de <= ate) {
        state.de = de;
        state.ate = ate;
      } else {
        state.periodo = "tudo";
      }
    }
    const perfil = params.get("perfil") || "";
    state.perfil = PERFIL_POR_CHAVE.has(perfil) ? perfil : "";
    const status = params.get("status") || "";
    state.status = Object.prototype.hasOwnProperty.call(STATUS_ROTULO, status) ? status : "";
    state.busca = (params.get("busca") || "").slice(0, 80);
  }

  /** Filtro vira query string: o link pode ser mandado para outra pessoa e recarregado. */
  function escreverUrl() {
    const params = new URLSearchParams();
    if (paginaAtual !== PAGINAS[0]) params.set("pagina", paginaAtual.id);
    if (state.periodo !== "tudo") params.set("periodo", state.periodo);
    if (state.periodo === "personalizado") {
      params.set("de", state.de);
      params.set("ate", state.ate);
    }
    if (state.perfil) params.set("perfil", state.perfil);
    if (state.status) params.set("status", state.status);
    if (state.busca.trim()) params.set("busca", state.busca.trim());
    const texto = params.toString();
    const url = `${window.location.pathname}${texto ? `?${texto}` : ""}${window.location.hash}`;
    try {
      window.history.replaceState(null, "", url);
    } catch {
      /* webview sem history: o filtro só não fica no link */
    }
  }

  /* ================================================================== */
  /* Carregamento                                                         */
  /* ================================================================== */

  // Sequências separadas por bloco: a resposta antiga de um bloco nunca sobrescreve a nova.
  const seq = { resumo: 0, lista: 0, cruz: 0, abertas: 0, obrigado: 0, inscricoes: 0, perfis: 0 };
  let emVoo = 0;

  function ocupado(delta) {
    emVoo = Math.max(0, emVoo + delta);
    $("[data-atualizar]").disabled = emVoo > 0;
  }

  function carregarTudo() {
    // Detalhes de "Outro" pertencem ao recorte anterior: fecham junto com ele.
    state.outros.clear();
    atualizarCsv();
    pintarFiltros();
    carregarResumo();
    carregarLista({ reiniciar: true });
    carregarCruzamento();
    carregarAbertas({ reiniciar: true });
  }

  /** Atualizar (botão ou automático): mesmos filtros, sem desmontar o que a pessoa abriu. */
  function atualizar({ automatico = false } = {}) {
    carregarResumo();
    carregarCruzamento();
    // A lista só recarrega se a pessoa não foi além da primeira página: não dá para arrancar
    // de baixo dela as linhas que ela está lendo. Os "Ver tudo" abertos sobrevivem (são por id).
    if (!automatico || state.lista.itens.length <= LIMITE_LISTA) carregarLista({ reiniciar: true });
    if (!automatico) carregarAbertas({ reiniciar: true });
    recarregarOutros();
  }

  async function carregarResumo() {
    const minha = ++seq.resumo;
    const secoes = $$("[data-agregado]");
    secoes.forEach((secao) => secao.setAttribute("aria-busy", "true"));
    if (!state.carregouUmaVez) pintarEsqueletos();
    panelStatus.textContent = "Carregando...";
    delete panelStatus.dataset.estado;
    ocupado(1);

    const comPerfil = Boolean(state.perfil);
    const chave = parametros().toString();
    const pedidos = [api(`/api/painel/resumo?${parametros({ comPerfil: false })}`)];
    if (comPerfil) pedidos.push(api(`/api/painel/resumo?${parametros()}`));
    const [geral, doPerfil] = await Promise.all(pedidos);
    ocupado(-1);

    if (minha !== seq.resumo) return;
    secoes.forEach((secao) => secao.removeAttribute("aria-busy"));

    if (geral.status === 401 || (doPerfil && doPerfil.status === 401)) {
      sessaoExpirou();
      return;
    }

    const falhou = !geral.ok || !geral.body.resumo || (comPerfil && (!doPerfil.ok || !doPerfil.body.resumo));
    if (falhou) {
      const status = !geral.ok ? geral.status : doPerfil ? doPerfil.status : 502;
      state.erroResumo = status || 0;
      panelStatus.dataset.estado = "erro";
      panelStatus.textContent = mensagemErro(status);
      // Sem dado bom, os números anteriores (de outro recorte) não podem ficar na tela.
      state.geral = null;
      state.resumo = null;
      pintarAgregados();
      return;
    }

    state.erroResumo = 0;
    state.geral = normalizarResumo(geral.body.resumo);
    state.resumo = comPerfil ? normalizarResumo(doPerfil.body.resumo) : state.geral;
    state.geradoEm = (comPerfil ? doPerfil.body.gerado_em : geral.body.gerado_em) || new Date().toISOString();
    state.carregouUmaVez = true;
    state.resumoChave = chave;
    panelStatus.textContent = "";
    pintarAgregados();
  }

  /** Garante as listas (o contrato diz [] e nunca null, mas o painel não aposta nisso). */
  function normalizarResumo(bruto) {
    const r = bruto && typeof bruto === "object" ? bruto : {};
    const listas = ["por_etapa", "pararam_em", "perfis", "distribuicoes", "responderam", "escalas", "por_dia", "trafego"];
    const saida = { ...r };
    for (const chave of listas) saida[chave] = Array.isArray(r[chave]) ? r[chave] : [];
    return saida;
  }

  /* ================================================================== */
  /* Pintura dos agregados                                                */
  /* ================================================================== */

  function pintarEsqueletos() {
    $("[data-placar]").innerHTML = Array.from({ length: 6 }, () => `<li>${esqueleto(3)}</li>`).join("");
    for (const seletor of ["[data-funil]", "[data-dia]", "[data-paradas]", "[data-icp]", "[data-perguntas]", "[data-trafego]"]) {
      $(seletor).innerHTML = esqueleto(6);
    }
  }

  function pintarAgregados() {
    pintarFiltros();
    pintarAtualizado();
    const vazioGeral = $("[data-vazio-geral]");
    const r = state.resumo;

    if (!r) {
      vazioGeral.hidden = true;
      $$(".secao").forEach((secao) => {
        secao.hidden = false;
      });
      $(".atalhos").hidden = false;
      const html = erroHtml(state.erroResumo, "resumo", "repetir-resumo");
      $("[data-placar]").innerHTML = "";
      for (const seletor of ["[data-funil]", "[data-dia]", "[data-paradas]", "[data-icp]", "[data-perguntas]", "[data-trafego]"]) {
        redesenhar($(seletor), seletor === "[data-funil]" ? `<li>${html}</li>` : html);
      }
      $("[data-funil-nota]").textContent = "";
      $("[data-copiar-icp]").disabled = true;
      return;
    }

    const semNada = num(state.geral.visitantes) === 0 && num(state.geral.pessoas) === 0;
    vazioGeral.hidden = !semNada;
    // Recorte sem ninguém: uma mensagem só, em vez de nove seções cheias de zero.
    $$(".secao").forEach((secao) => {
      secao.hidden = semNada;
    });
    $(".atalhos").hidden = semNada;
    if (semNada) {
      vazioGeral.innerHTML = `
        <img src="/img/ev-icone-color.png" alt="" width="64" height="64">
        <h2>Nenhuma resposta ${state.periodo === "tudo" ? "ainda" : "neste período"}</h2>
        <p>${
          state.periodo === "tudo"
            ? "Assim que alguém abrir a pesquisa, os números aparecem aqui. O link da pesquisa é /pesquisa-icp."
            : "Ninguém acessou a pesquisa no período escolhido. Tente um período maior, ou “Tudo”."
        }</p>`;
    }

    $("[data-periodo-rotulo]").textContent = `${rotuloPeriodo()} · atualizado às ${hora(state.geradoEm)}`;
    pintarPlacar();
    pintarFunil();
    pintarDia();
    pintarParadas();
    pintarIcp();
    pintarPerguntas();
    pintarTrafego();
  }

  // A barra é de todas as páginas: mostra a hora dos números da página aberta. As abas de inscrição
  // dividem o estado `ins`: a hora só vale se os números na memória forem da aba aberta.
  function pintarAtualizado() {
    const alvo = $("[data-atualizado]");
    const gerado =
      paginaAtual.conteudo === "obrigado"
        ? obr.geradoEm
        : paginaAtual.conteudo === "perfis"
          ? perf.geradoEm
          : paginaAtual.conteudo === "inscricoes"
          ? ins.pagina === paginaAtual.inscricao
            ? ins.geradoEm
            : ""
          : state.geradoEm;
    alvo.textContent = gerado ? `Atualizado às ${hora(gerado)}` : "—";
  }

  /* ------------------------------------------------------------ Filtros */

  function pintarFiltros() {
    // Busca e situação vêm também da URL: o campo mostra o que está valendo (sem atropelar quem
    // está digitando).
    const campoBusca = $("[data-busca]");
    if (document.activeElement !== campoBusca && campoBusca.value !== state.busca) campoBusca.value = state.busca;
    campoBusca.classList.toggle("ativo", Boolean(state.busca.trim()));
    $("[data-status]").value = state.status;
    $("[data-status]").classList.toggle("ativo", Boolean(state.status));
    pintarFiltroAtivo();

    $$("[data-periodo]").forEach((botao) => {
      botao.setAttribute("aria-pressed", String(botao.dataset.periodo === state.periodo));
    });
    const datas = $("[data-datas]");
    datas.hidden = state.periodo !== "personalizado";
    if (!datas.hidden) {
      const hoje = hojeSP();
      $("[data-data-de]").max = hoje;
      $("[data-data-ate]").max = hoje;
      if (state.de && !$("[data-data-de]").value) $("[data-data-de]").value = state.de;
      if (state.ate && !$("[data-data-ate]").value) $("[data-data-ate]").value = state.ate;
    }

    // A contagem das abas vem sempre do resumo SEM perfil: com "Técnicos" escolhido, as outras
    // abas continuam dizendo quantas pessoas têm.
    const contagem = new Map();
    let totalGeral = null;
    if (state.geral) {
      totalGeral = num(state.geral.pessoas);
      for (const linha of state.geral.perfis) contagem.set(linha.perfil, num(linha.total));
    }
    const abas = [{ chave: "", curto: "Todos", total: totalGeral }].concat(
      PERFIS.map((perfil) => ({ chave: perfil.chave, curto: perfil.curto, total: state.geral ? contagem.get(perfil.valor) || 0 : null }))
    );
    const container = $("[data-perfis]");
    redesenhar(
      container,
      abas
        .map((aba) => {
          const ativo = aba.chave === state.perfil;
          return `<button type="button" class="perfil-aba" role="tab" aria-selected="${ativo}" tabindex="${ativo ? 0 : -1}" data-perfil="${escapeHtml(
            aba.chave
          )}" data-foco="perfil-${escapeHtml(aba.chave || "todos")}">${escapeHtml(aba.curto)}${
            aba.total == null ? "" : `<span class="n" aria-label="${escapeHtml(plural(aba.total, "pessoa", "pessoas"))}">${n(aba.total)}</span>`
          }</button>`;
        })
        .join("")
    );
    mostrarAbaAtiva(container);
  }

  /** Aviso "Filtrando: ..." com o botão de limpar. Some quando não há filtro de pessoa. */
  function pintarFiltroAtivo() {
    const alvo = $("[data-filtro-ativo]");
    const descricao = descricaoFiltroPessoa();
    alvo.hidden = !descricao;
    if (!descricao) {
      alvo.innerHTML = "";
      return;
    }
    const r = state.resumo;
    // Só mostra a contagem quando ela é deste recorte (e não do anterior, ainda na tela).
    const quantos = r && state.resumoChave === parametros().toString() ? ` · <strong>${escapeHtml(plural(r.pessoas, "pessoa", "pessoas"))}</strong>` : "";
    redesenhar(
      alvo,
      `<span class="filtro-ativo-texto">Filtrando: ${escapeHtml(descricao)}${quantos}</span><button type="button" class="botao-texto" data-limpar-filtros data-foco="limpar-filtros">Limpar filtros</button>`
    );
  }

  /** Faixa rolável (celular): traz a aba escolhida para dentro da faixa, sem rolar a página. */
  function mostrarAbaAtiva(container) {
    const ativa = container.querySelector('[aria-selected="true"]');
    if (ativa && container.scrollWidth > container.clientWidth) {
      const caixa = container.getBoundingClientRect();
      const r = ativa.getBoundingClientRect();
      const esquerda = r.left - caixa.left + container.scrollLeft;
      const direita = esquerda + r.width;
      if (esquerda < container.scrollLeft) container.scrollLeft = Math.max(0, esquerda - 24);
      else if (direita > container.scrollLeft + container.clientWidth) container.scrollLeft = direita - container.clientWidth + 24;
    }
    sinalizarRolagem(container);
  }

  /**
   * Faixas que rolam de lado (perfis, período, abas, menu de seções): esmaecem a borda do lado
   * em que ainda há conteúdo, para ninguém achar que as opções acabaram ali.
   */
  function sinalizarRolagem(faixa) {
    const resto = faixa.scrollWidth - faixa.clientWidth - faixa.scrollLeft;
    faixa.classList.toggle("rola-dir", resto > 2);
    faixa.classList.toggle("rola-esq", faixa.scrollLeft > 2);
  }

  function ligarFaixasRolaveis() {
    const faixas = () => $$(".paginas, .perfis, .segmentado, .abas, .atalhos");
    for (const faixa of faixas()) faixa.addEventListener("scroll", () => sinalizarRolagem(faixa), { passive: true });
    const todas = () => faixas().forEach(sinalizarRolagem);
    window.addEventListener("resize", todas, { passive: true });
    // Também quando a faixa aparece (o painel começa escondido atrás do login) ou muda de tamanho.
    if (typeof ResizeObserver === "function") {
      const observador = new ResizeObserver((entradas) =>
        entradas.forEach((e) => (e.target.matches(".perfis, .paginas") ? mostrarAbaAtiva(e.target) : sinalizarRolagem(e.target)))
      );
      faixas().forEach((faixa) => observador.observe(faixa));
    }
    todas();
    // Fontes da web chegam depois e mudam as larguras.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(todas).catch(() => {});
  }

  /* ------------------------------------------------------------ Placar */

  function pintarPlacar() {
    const g = state.geral;
    const r = state.resumo;
    const comPerfil = Boolean(state.perfil);
    const perfil = PERFIL_POR_CHAVE.get(state.perfil);
    const filtrado = filtroDePessoa();
    const todos = seloSemFiltro();

    const visitantes = num(g.visitantes);
    const comecaram = num(g.comecaram);
    const pessoasGeral = num(g.pessoas);
    const pessoas = num(r.pessoas);
    const concluidas = num(r.concluidas);
    const repetidas = Math.max(0, num(r.tentativas) - pessoas);

    const itens = [
      {
        rotulo: "Acessaram",
        valor: n(visitantes),
        detalhe: `${plural(g.visitas, "visita", "visitas")} no total · visitantes únicos`,
        extra: todos
      },
      {
        rotulo: "Começaram",
        valor: n(comecaram),
        detalhe: `<strong>${pct(comecaram, visitantes)}</strong> de quem acessou`,
        extra: todos
      },
      comPerfil
        ? {
            rotulo: "Se identificaram",
            valor: n(pessoas),
            detalhe: `<strong>${pct(pessoas, pessoasGeral)}</strong> de todos que se identificaram (${n(pessoasGeral)})`,
            extra: `<span class="selo-todos">${escapeHtml(perfil.curto)}</span>`
          }
        : filtrado
          ? {
              // Busca/situação: comparar com o acesso de todos não diz nada.
              rotulo: "Se identificaram",
              valor: n(pessoas),
              detalhe: "com os filtros escolhidos",
              extra: `<span class="selo-todos">${escapeHtml(descricaoFiltroPessoa())}</span>`
            }
          : {
              rotulo: "Se identificaram",
              valor: n(pessoas),
              detalhe: `<strong>${pct(pessoas, comecaram)}</strong> de quem começou`
            },
      {
        rotulo: "Responderam tudo",
        valor: n(concluidas),
        detalhe: `<strong>${pct(concluidas, pessoas)}</strong> de quem se identificou`,
        destaque: true
      },
      {
        rotulo: "Tempo mediano",
        valor: r.tempo_mediano_segundos == null ? "—" : duracao(r.tempo_mediano_segundos),
        texto: true,
        detalhe: r.tempo_mediano_segundos == null ? "ninguém concluiu ainda" : "do contato até a última resposta, entre quem concluiu"
      },
      {
        rotulo: "Tentativas repetidas",
        valor: n(repetidas),
        detalhe: repetidas
          ? `${plural(r.tentativas, "tentativa", "tentativas")} para ${plural(pessoas, "pessoa", "pessoas")} · a lista mostra a mais completa`
          : "ninguém começou de novo com o mesmo WhatsApp"
      }
    ];

    $("[data-placar]").innerHTML = itens
      .map(
        (item) => `<li${item.destaque ? ' class="destaque"' : ""}>
          <span class="rotulo">${escapeHtml(item.rotulo)}</span>
          <span class="valor${item.texto ? " valor-texto" : ""}">${escapeHtml(item.valor)}</span>
          <span class="detalhe">${item.detalhe}</span>${item.extra || ""}
        </li>`
      )
      .join("");
  }

  /* ------------------------------------------------------------ Funil */

  function pintarFunil() {
    const g = state.geral;
    const r = state.resumo;
    const comPerfil = filtroDePessoa();
    const porEtapa = new Map(r.por_etapa.map((linha) => [num(linha.etapa), num(linha.chegaram)]));

    const degraus = [];
    // Acesso e começo não têm pessoa (nem perfil, nem nome): com perfil, situação ou busca, o
    // funil começa em quem se identificou, para não comparar um recorte com o tráfego de todos.
    if (!comPerfil) {
      degraus.push({ rotulo: "Acessaram a pesquisa", valor: num(g.visitantes) });
      degraus.push({ rotulo: "Clicaram em Começar", valor: num(g.comecaram) });
    }
    degraus.push({ rotulo: "Se identificaram", sub: "nome, WhatsApp e e-mail", valor: num(r.pessoas) });
    for (let etapa = 2; etapa <= 9; etapa++) {
      const info = EV.etapaPorNumero(etapa);
      degraus.push({
        rotulo: `Chegaram à etapa ${etapa}`,
        sub: etapa === 9 ? `${info ? info.titulo : ""} · só quem tem bloco próprio; concluídas contam` : info ? info.titulo : "",
        valor: porEtapa.get(etapa) || 0
      });
    }
    degraus.push({ rotulo: "Responderam tudo", valor: num(r.concluidas), fim: true });

    const base = degraus[0].valor;
    let maior = null;
    degraus.forEach((degrau, indice) => {
      if (!indice) return;
      const anterior = degraus[indice - 1];
      const queda = anterior.valor - degrau.valor;
      if (queda > 0 && (!maior || queda > maior.queda)) {
        maior = { indice, queda, taxa: anterior.valor ? queda / anterior.valor : 0, de: anterior.rotulo, para: degrau.rotulo };
      }
    });

    const baseRotulo = comPerfil ? "de quem se identificou" : "de quem acessou";
    const html = degraus
      .map((degrau, indice) => {
        const largura = base ? Math.min(100, (degrau.valor / base) * 100) : 0;
        const etiqueta =
          maior && maior.indice === indice
            ? `<span class="queda"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24"><path d="M12 5v14m0 0-6-6m6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>maior queda: −${n(
                maior.queda
              )} (${Math.round(maior.taxa * 100)}% de quem estava no passo anterior)</span>`
            : "";
        return `<li class="linha-barra${degrau.fim ? " fim" : ""}">
          <span class="rotulo">${escapeHtml(degrau.rotulo)}${degrau.sub ? `<small>${escapeHtml(degrau.sub)}</small>` : ""}</span>
          <span class="trilho" role="img" aria-label="${escapeHtml(`${degrau.rotulo}: ${n(degrau.valor)}, ${pct(degrau.valor, base)} ${baseRotulo}`)}"><span style="width:${largura.toFixed(
          2
        )}%"></span></span>
          <span class="num"><strong>${n(degrau.valor)}</strong><span>${indice ? pct(degrau.valor, base) : "100%"}</span></span>
          ${etiqueta}
        </li>`;
      })
      .join("");
    redesenhar($("[data-funil]"), html);

    $("[data-funil-sub]").textContent = comPerfil
      ? `Só ${descricaoFiltroPessoa()}. Barras proporcionais a quem se identificou; cada pessoa conta no ponto mais distante que alcançou.`
      : "Barras proporcionais a quem acessou. Cada pessoa conta no ponto mais distante que alcançou.";

    const nota = $("[data-funil-nota]");
    if (!base) {
      nota.textContent = "Sem ninguém no primeiro passo deste recorte, ainda não há funil para mostrar.";
    } else if (maior) {
      nota.innerHTML = `A maior perda está entre <strong>${escapeHtml(maior.de.toLowerCase())}</strong> e <strong>${escapeHtml(
        maior.para.toLowerCase()
      )}</strong>: ${escapeHtml(plural(maior.queda, "pessoa", "pessoas"))}. ${
        comPerfil
          ? "Acesso e clique em Começar não entram aqui: eles não têm nome nem perfil, então não dá para filtrar."
          : "As porcentagens são sobre quem acessou; a etiqueta compara com o passo anterior."
      }`;
    } else {
      nota.textContent = "Ninguém se perdeu entre um passo e outro neste recorte.";
    }
  }

  /* ------------------------------------------------------------ Por dia */

  function eixoLimpo(maximo) {
    if (maximo <= 4) return { topo: Math.max(maximo, 1), passo: 1 };
    const bruto = maximo / 4;
    const potencia = 10 ** Math.floor(Math.log10(bruto));
    const passo = [1, 2, 2.5, 5, 10].map((m) => m * potencia).find((p) => p >= bruto);
    return { topo: Math.ceil(maximo / passo) * passo, passo };
  }

  const SERIES_DIA = [
    { chave: "visitantes", rotulo: "Visitantes", classe: "s1" },
    { chave: "pessoas", rotulo: "Se identificaram", classe: "s2" },
    { chave: "concluidas", rotulo: "Responderam tudo", classe: "s3" }
  ];

  let diasDoGrafico = [];

  function pintarDia() {
    const r = state.resumo;
    const porDia = new Map(r.por_dia.map((linha) => [String(linha.dia).slice(0, 10), linha]));
    const { primeiro, ultimo } = intervalo();
    const diasComDado = Array.from(porDia.keys()).sort();
    const inicio = primeiro || diasComDado[0] || ultimo;
    const fim = ultimo && (!diasComDado.length || ultimo >= diasComDado[diasComDado.length - 1]) ? ultimo : diasComDado[diasComDado.length - 1] || ultimo;
    const alvo = $("[data-dia]");

    // Dia sem ninguém entra como zero: um buraco no eixo esconderia justamente o dia parado.
    const dias = [];
    if (inicio && fim) {
      let dia = inicio;
      let guarda = 0;
      while (dia <= fim && guarda < 800) {
        const linha = porDia.get(dia) || {};
        dias.push({ dia, visitantes: num(linha.visitantes), pessoas: num(linha.pessoas), concluidas: num(linha.concluidas) });
        dia = somarDias(dia, 1);
        guarda++;
      }
    }
    diasDoGrafico = dias;

    const totais = SERIES_DIA.map((serie) => dias.reduce((soma, dia) => soma + dia[serie.chave], 0));
    const maximo = Math.max(0, ...dias.map((dia) => Math.max(dia.visitantes, dia.pessoas, dia.concluidas)));

    if (!dias.length || !maximo) {
      redesenhar(alvo, vazioHtml("Nenhum movimento no período.", "Quando alguém acessar a pesquisa, o dia aparece aqui."));
      return;
    }

    const legenda = `<ul class="dia-legenda" aria-label="Legenda">${SERIES_DIA.map(
      (serie, indice) =>
        `<li><i class="amostra ${serie.classe}" aria-hidden="true"></i>${escapeHtml(serie.rotulo)} <strong>${n(totais[indice])}</strong>${
          serie.chave === "visitantes" ? seloSemFiltro() : ""
        }</li>`
    ).join("")}</ul>`;

    const tabela = `<div class="tabela-rolagem"><table>
      <caption>Por dia, horário de Brasília</caption>
      <thead><tr><th scope="col">Dia</th>${SERIES_DIA.map((serie) => `<th scope="col" class="n">${escapeHtml(serie.rotulo)}</th>`).join("")}</tr></thead>
      <tbody>${dias
        .slice()
        .reverse()
        .map(
          (dia) =>
            `<tr><th scope="row">${escapeHtml(`${dataCurta(dia.dia, true)} · ${diaSemana(dia.dia)}`)}</th>${SERIES_DIA.map(
              (serie) => `<td class="n">${n(dia[serie.chave])}</td>`
            ).join("")}</tr>`
        )
        .join("")}</tbody>
      <tfoot><tr><th scope="row">Total</th>${totais.map((total) => `<td class="n">${n(total)}</td>`).join("")}</tr></tfoot>
    </table></div>`;

    const botao = $("[data-dia-tabela]");
    botao.setAttribute("aria-expanded", String(state.diaTabela));
    botao.textContent = state.diaTabela ? "Ver como gráfico" : "Ver como tabela";

    if (state.diaTabela) {
      redesenhar(alvo, legenda + tabela);
      return;
    }

    const { topo, passo } = eixoLimpo(maximo);
    const ticks = [];
    for (let valor = 0; valor <= topo + 1e-9; valor += passo) ticks.push(valor);
    const altura = (valor) => `${((valor / topo) * 100).toFixed(2)}%`;

    // Rótulos do eixo X: no máximo ~7, sempre com o primeiro e o último dia.
    // Um rótulo a cada ~64px de largura (7 no computador, 5 no celular).
    const cabem = Math.max(3, Math.min(7, Math.floor((alvo.clientWidth || 600) / 64)));
    const saltos = Math.max(1, Math.ceil(dias.length / cabem));
    const rotulosX = dias
      .map((dia, indice) => ({ dia, indice }))
      .filter(({ indice }) => indice === 0 || indice === dias.length - 1 || (indice % saltos === 0 && dias.length - 1 - indice >= saltos * 0.8))
      .map(({ dia, indice }) => {
        const posicao = ((indice + 0.5) / dias.length) * 100;
        const classe = dias.length > 1 && indice === 0 ? "inicio" : dias.length > 1 && indice === dias.length - 1 ? "fim" : "";
        const esquerda = classe === "inicio" ? 0 : classe === "fim" ? 100 : posicao;
        return `<span class="${classe}" style="left:${esquerda.toFixed(2)}%">${escapeHtml(dataCurta(dia.dia))}</span>`;
      })
      .join("");

    const colunas = dias
      .map(
        (dia, indice) =>
          `<div class="coluna" data-dia-i="${indice}">${SERIES_DIA.map(
            (serie) =>
              dia[serie.chave]
                ? `<i class="${serie.classe}${dia[serie.chave] / topo < 0.03 ? " baixa" : ""}" style="height:${altura(dia[serie.chave])}"></i>`
                : ""
          ).join("")}</div>`
      )
      .join("");

    const resumoAria = `Gráfico de colunas por dia, de ${dataCurta(dias[0].dia, true)} a ${dataCurta(
      dias[dias.length - 1].dia,
      true
    )}. Total: ${SERIES_DIA.map((serie, indice) => `${serie.rotulo.toLowerCase()} ${n(totais[indice])}`).join(", ")}. Use “Ver como tabela” para os números de cada dia.`;

    redesenhar(
      alvo,
      `${legenda}
      <div class="grafico-dia" role="img" aria-label="${escapeHtml(resumoAria)}">
        <div class="eixo-y" aria-hidden="true">${ticks.map((valor) => `<span style="bottom:${altura(valor)}">${n(valor)}</span>`).join("")}</div>
        <div class="plot" data-plot-dia>
          ${ticks.slice(1).map((valor) => `<div class="grade" style="bottom:${altura(valor)}"></div>`).join("")}
          <div class="colunas">${colunas}</div>
        </div>
        <div class="eixo-x" aria-hidden="true">${rotulosX}</div>
      </div>`
    );
  }

  /* ------------------------------------------------------------ Tooltip do gráfico por dia */

  const dica = $("[data-dica]");

  function mostrarDica(html, x, y) {
    dica.innerHTML = html;
    dica.hidden = false;
    const largura = dica.offsetWidth;
    const alturaDica = dica.offsetHeight;
    const esquerda = Math.min(window.innerWidth - largura - 8, Math.max(8, x + 14));
    const topo = y - alturaDica - 12 < 8 ? y + 16 : y - alturaDica - 12;
    dica.style.left = `${esquerda}px`;
    dica.style.top = `${topo}px`;
  }

  function esconderDica() {
    dica.hidden = true;
    $$(".coluna.ativa").forEach((coluna) => coluna.classList.remove("ativa"));
  }

  const CORES_SERIE = ["var(--serie-1)", "var(--serie-2)", "var(--serie-3)"];

  $("[data-dia]").addEventListener("pointermove", (evento) => {
    const coluna = evento.target instanceof Element ? evento.target.closest("[data-dia-i]") : null;
    if (!coluna) {
      esconderDica();
      return;
    }
    const dia = diasDoGrafico[Number(coluna.dataset.diaI)];
    if (!dia) return;
    $$(".coluna.ativa").forEach((item) => item !== coluna && item.classList.remove("ativa"));
    coluna.classList.add("ativa");
    // Valor na frente, rótulo atrás (o leitor já sabe a série e quer o número).
    const linhas = SERIES_DIA.map(
      (serie, indice) =>
        `<div class="dica-linha"><span><i class="traco" style="background:${CORES_SERIE[indice]}"></i>${escapeHtml(serie.rotulo)}</span><strong>${n(
          dia[serie.chave]
        )}</strong></div>`
    ).join("");
    mostrarDica(`<div class="dica-titulo">${escapeHtml(`${diaSemana(dia.dia)}, ${dataCurta(dia.dia, true)}`)}</div>${linhas}`, evento.clientX, evento.clientY);
  });
  $("[data-dia]").addEventListener("pointerleave", esconderDica);
  window.addEventListener("scroll", esconderDica, { passive: true });

  $("[data-dia-tabela]").addEventListener("click", () => {
    state.diaTabela = !state.diaTabela;
    if (state.resumo) pintarDia();
  });

  /* ------------------------------------------------------------ Onde param */

  function pintarParadas() {
    const r = state.resumo;
    const alvo = $("[data-paradas]");
    const emAndamento = r.pararam_em.reduce((soma, linha) => soma + num(linha.total), 0);
    const linhas = r.pararam_em
      .filter((linha) => num(linha.total) > 0)
      .map((linha) => {
        const pergunta = EV.perguntaPorId(linha.pergunta);
        return {
          id: linha.pergunta,
          pergunta,
          total: num(linha.total),
          ordem: linha.pergunta === "fim" ? 9999 : INDICE_PERGUNTA.has(linha.pergunta) ? INDICE_PERGUNTA.get(linha.pergunta) : 9000
        };
      })
      .sort((a, b) => a.ordem - b.ordem);

    $("[data-param-sub]").textContent = emAndamento
      ? `${plural(emAndamento, "pessoa se identificou e ainda não terminou", "pessoas se identificaram e ainda não terminaram")}. Cada uma aparece na pergunta que estava na tela quando parou. As 3 perguntas com mais gente parada estão em destaque.`
      : "Quem se identificou e ainda não terminou: a pergunta que estava na tela quando parou.";

    if (!linhas.length) {
      redesenhar(alvo, vazioHtml("Ninguém parado no meio.", num(r.pessoas) ? "Todo mundo que se identificou neste recorte terminou." : "Ainda ninguém se identificou neste recorte."));
      return;
    }

    const top3 = new Set(
      linhas
        .slice()
        .sort((a, b) => b.total - a.total)
        .slice(0, 3)
        .map((linha) => linha.id)
    );
    const maior = Math.max(...linhas.map((linha) => linha.total));
    const html = `<ol class="barras">${linhas
      .map((linha) => {
        const titulo = linha.pergunta
          ? `Pergunta ${numeroDa(linha.pergunta)} · ${linha.pergunta.analise}`
          : linha.id === "fim"
            ? "Tela final"
            : `Pergunta “${linha.id}” (versão anterior)`;
        const etapa = linha.pergunta ? EV.etapaPorNumero(linha.pergunta.etapa) : null;
        const destaque = top3.has(linha.id);
        return `<li class="linha-barra${destaque ? " lider" : " fora"}">
          <span class="rotulo">${escapeHtml(titulo)}${etapa ? `<small>Etapa ${etapa.n} · ${escapeHtml(etapa.titulo)}</small>` : ""}</span>
          <span class="trilho" role="img" aria-label="${escapeHtml(`${titulo}: ${plural(linha.total, "pessoa parada", "pessoas paradas")}, ${pct(linha.total, emAndamento)} de quem está em andamento`)}"><span style="width:${(
          (linha.total / maior) *
          100
        ).toFixed(2)}%"></span></span>
          <span class="num"><strong>${n(linha.total)}</strong><span>${pct(linha.total, emAndamento)}</span></span>
        </li>`;
      })
      .join("")}</ol>
      <p class="nota">Porcentagem sobre as ${escapeHtml(plural(emAndamento, "pessoa em andamento", "pessoas em andamento"))}. Em destaque (mais escuras), as 3 perguntas onde mais gente parou.</p>`;
    redesenhar(alvo, html);
  }

  /* ------------------------------------------------------------ Índices das distribuições */

  /**
   * Organiza as linhas do resumo por chave. `perfil` = null soma todos os perfis (os perfis
   * são disjuntos — cada pessoa tem um só — então a soma das contagens distintas é exata).
   */
  function indexar(resumo, perfil) {
    const filtra = (linha) => perfil === undefined || linha.perfil === perfil;
    const dist = new Map();
    for (const linha of resumo.distribuicoes) {
      if (!filtra(linha)) continue;
      const porValor = dist.get(linha.chave) || new Map();
      const valor = String(linha.valor);
      porValor.set(valor, (porValor.get(valor) || 0) + num(linha.total));
      dist.set(linha.chave, porValor);
    }
    const responderam = new Map();
    for (const linha of resumo.responderam) {
      if (!filtra(linha)) continue;
      responderam.set(linha.chave, (responderam.get(linha.chave) || 0) + num(linha.total));
    }
    const escalas = new Map();
    for (const linha of resumo.escalas) {
      if (!filtra(linha)) continue;
      const atual = escalas.get(linha.chave) || { soma: 0, total: 0 };
      atual.soma += num(linha.media) * num(linha.total);
      atual.total += num(linha.total);
      escalas.set(linha.chave, atual);
    }
    return { dist, responderam, escalas };
  }

  /** Média da escala: exata pelo histograma; cai na média do banco se o histograma faltar. */
  function mediaEscala(indice, pergunta) {
    const porValor = indice.dist.get(pergunta.id);
    if (porValor && porValor.size) {
      let soma = 0;
      let total = 0;
      for (const [valor, quantidade] of porValor) {
        const numero = Number(valor);
        if (!Number.isFinite(numero)) continue;
        soma += numero * quantidade;
        total += quantidade;
      }
      if (total) return { media: soma / total, total };
    }
    const escala = indice.escalas.get(pergunta.id);
    return escala && escala.total ? { media: escala.soma / escala.total, total: escala.total } : null;
  }

  function ordenadoPorTotal(porValor) {
    return Array.from(porValor || [])
      .map(([valor, total]) => ({ valor, total }))
      .sort((a, b) => b.total - a.total || a.valor.localeCompare(b.valor, "pt-BR"));
  }

  function regioesDe(porValor) {
    const regioes = new Map(EV.REGIOES.map((regiao) => [regiao, 0]));
    for (const [estado, total] of porValor || []) {
      const regiao = EV.regiaoDoEstado(estado);
      if (regiao) regioes.set(regiao, regioes.get(regiao) + total);
    }
    return regioes;
  }

  /* ------------------------------------------------------------ ICP por perfil */

  /** Resumo de uma variável do ICP num perfil: { texto, pc } ou null (ninguém respondeu). */
  function linhaIcp(indice, pergunta) {
    const base = indice.responderam.get(pergunta.id) || 0;
    if (pergunta.tipo === "escala") {
      const media = mediaEscala(indice, pergunta);
      if (!media) return null;
      return { texto: `${DEC.format(media.media)}/10`, pc: `média de ${plural(media.total, "resposta", "respostas")}` };
    }
    const ordenado = ordenadoPorTotal(indice.dist.get(pergunta.id));
    if (!ordenado.length || !base) return null;
    const baseTexto = `de quem respondeu (${n(base)})`;
    if (pergunta.tipo === "multipla") {
      const dois = ordenado.slice(0, 2);
      return {
        texto: dois.map((item) => `${item.valor} (${pct(item.total, base)})`).join(" + "),
        pc: `as 2 mais marcadas, % ${baseTexto}`
      };
    }
    const lider = ordenado[0];
    const linha = { texto: lider.valor, pc: `${pct(lider.total, base)} ${baseTexto}` };
    if (pergunta.id === "estado") {
      const regioes = Array.from(regioesDe(indice.dist.get("estado"))).sort((a, b) => b[1] - a[1]);
      if (regioes.length && regioes[0][1]) {
        linha.regiao = { texto: `Região ${regioes[0][0]}`, pc: `${pct(regioes[0][1], base)} ${baseTexto}` };
      }
    }
    return linha;
  }

  function dadosIcp() {
    const g = state.geral;
    const r = state.resumo;
    const perfis = state.perfil ? [PERFIL_POR_CHAVE.get(state.perfil)] : PERFIS;
    const fonte = state.perfil ? r : g;
    const totais = new Map(fonte.perfis.map((linha) => [linha.perfil, linha]));
    return perfis
      .map((perfil) => {
        const linhaPerfil = totais.get(perfil.valor);
        const total = linhaPerfil ? num(linhaPerfil.total) : 0;
        if (!total) return null;
        const indice = indexar(fonte, perfil.valor);
        const variaveis = EV.ICP_VARIAVEIS.map((id) => EV.perguntaPorId(id))
          .filter(Boolean)
          .map((pergunta) => ({ pergunta, linha: linhaIcp(indice, pergunta) }));
        return { perfil, total, concluidas: num(linhaPerfil.concluidas), variaveis };
      })
      .filter(Boolean);
  }

  function pintarIcp() {
    const alvo = $("[data-icp]");
    const cartoes = dadosIcp();
    alvo.classList.toggle("unico", Boolean(state.perfil));
    $("[data-copiar-icp]").disabled = !cartoes.length;

    if (!cartoes.length) {
      redesenhar(alvo, vazioHtml("Ainda sem perfis para resumir.", "O cartão de cada perfil aparece quando a primeira pessoa daquele perfil responder a pergunta 1."));
      return;
    }

    const largo = window.matchMedia("(min-width: 720px)").matches;
    const html = cartoes
      .map(({ perfil, total, concluidas, variaveis }, indice) => {
        const itens = variaveis
          .map(({ pergunta, linha }) => {
            if (!linha) return `<div><dt>${escapeHtml(pergunta.analise)}</dt><dd class="sem">ninguém respondeu ainda</dd></div>`;
            const regiao = linha.regiao
              ? `<div><dt>Região</dt><dd>${escapeHtml(linha.regiao.texto)} <span class="pc">· ${escapeHtml(linha.regiao.pc)}</span></dd></div>`
              : "";
            return `<div><dt>${escapeHtml(pergunta.analise)}</dt><dd>${escapeHtml(linha.texto)} <span class="pc">· ${escapeHtml(linha.pc)}</span></dd></div>${regiao}`;
          })
          .join("");
        const aberto = state.icpEscolhas.has(perfil.chave) ? state.icpEscolhas.get(perfil.chave) : largo || indice === 0 || Boolean(state.perfil);
        return `<details class="icp-cartao" data-icp-perfil="${escapeHtml(perfil.chave)}"${aberto ? " open" : ""}>
          <summary class="icp-cabeca" data-foco="icp-${escapeHtml(perfil.chave)}">
            <h3>${escapeHtml(perfil.curto)}</h3>
            <p><strong>${escapeHtml(plural(total, "pessoa", "pessoas"))}</strong> · ${pct(concluidas, total)} responderam tudo (${n(concluidas)})</p>
          </summary>
          <dl class="icp-lista">${itens}</dl>
        </details>`;
      })
      .join("");
    redesenhar(alvo, html);
  }

  $("[data-icp]").addEventListener(
    "toggle",
    (evento) => {
      const cartao = evento.target instanceof Element ? evento.target.closest("[data-icp-perfil]") : null;
      if (cartao && evento.target === cartao) state.icpEscolhas.set(cartao.dataset.icpPerfil, cartao.open);
    },
    true
  );

  /** Texto puro, para colar no WhatsApp ou no Docs. */
  function textoIcp() {
    const cartoes = dadosIcp();
    const cabeca = `ICP — Pesquisa da Escola Enfermagem de Valor\n${rotuloPeriodo()} · gerado em ${dataHora(state.geradoEm)}\n`;
    const blocos = cartoes.map(({ perfil, total, concluidas, variaveis }) => {
      const linhas = [`*${perfil.curto}* — ${plural(total, "pessoa", "pessoas")}, ${pct(concluidas, total)} responderam tudo`];
      for (const { pergunta, linha } of variaveis) {
        if (!linha) continue;
        linhas.push(`• ${pergunta.analise}: ${linha.texto} (${linha.pc})`);
        if (linha.regiao) linhas.push(`• Região: ${linha.regiao.texto} (${linha.regiao.pc})`);
      }
      return linhas.join("\n");
    });
    return `${cabeca}\n${blocos.join("\n\n")}\n\nPorcentagens sobre quem respondeu cada pergunta naquele perfil.`;
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      // Webview sem Clipboard API: o jeito antigo ainda funciona na maioria.
      const area = document.createElement("textarea");
      area.value = texto;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  }

  $("[data-copiar-icp]").addEventListener("click", async () => {
    if (!state.resumo) return;
    const ok = await copiar(textoIcp());
    const aviso = $("[data-copiado]");
    aviso.textContent = ok ? "Resumo copiado. É só colar no WhatsApp ou no Docs." : "Não deu para copiar automaticamente neste navegador.";
    window.clearTimeout(aviso._timer);
    aviso._timer = window.setTimeout(() => {
      aviso.textContent = "";
    }, 5000);
  });

  /* ------------------------------------------------------------ Respostas por pergunta */

  function barrasHtml(linhas, base, rotuloBase) {
    const maior = Math.max(0, ...linhas.map((linha) => linha.total));
    return `<ol class="barras">${linhas
      .map((linha) => {
        const largura = maior ? (linha.total / maior) * 100 : 0;
        const classe = !linha.total ? " zero" : linha.total === maior ? " lider" : "";
        return `<li class="linha-barra${classe}">
          <span class="rotulo">${escapeHtml(linha.rotulo)}${linha.sub ? `<small>${escapeHtml(linha.sub)}</small>` : ""}</span>
          <span class="trilho" role="img" aria-label="${escapeHtml(`${linha.rotulo}: ${n(linha.total)}, ${pct(linha.total, base)} ${rotuloBase}`)}"><span style="width:${largura.toFixed(
          2
        )}%"></span></span>
          <span class="num"><strong>${n(linha.total)}</strong><span>${pct(linha.total, base)}</span></span>
        </li>`;
      })
      .join("")}</ol>`;
  }

  function quadroHtml(pergunta, indice) {
    const base = indice.responderam.get(pergunta.id) || 0;
    const porValor = indice.dist.get(pergunta.id) || new Map();
    const chips = [`<span class="chip forte">${escapeHtml(plural(base, "respondeu", "responderam"))}</span>`];
    if (pergunta.tipo === "multipla") chips.push('<span class="chip">cada pessoa pode marcar mais de uma</span>');
    if (pergunta.visivelSe) {
      const so = pergunta.visivelSe.valores.map((valor) => perfilCurto(valor)).join(", ");
      chips.push(`<span class="chip">só para ${escapeHtml(so.toLowerCase())}</span>`);
    }
    const nota = pergunta.nota ? `<p class="quadro-nota">${escapeHtml(pergunta.nota)}</p>` : "";
    let corpo = "";
    let classe = "";

    if (!base) {
      corpo = vazioHtml("Ninguém respondeu ainda.", "");
    } else if (pergunta.tipo === "escala") {
      corpo = histogramaHtml(pergunta, indice, porValor, base);
    } else if (pergunta.tipo === "lista") {
      classe = " largo estado";
      // Todos os 27, do mais para o menos citado; empate em ordem alfabética.
      const linhas = pergunta.opcoes
        .map((opcao) => ({ rotulo: opcao, sub: "", total: porValor.get(opcao) || 0 }))
        .sort((a, b) => b.total - a.total || a.rotulo.localeCompare(b.rotulo, "pt-BR"));
      const regioes = Array.from(regioesDe(porValor)).map(([regiao, total]) => ({ rotulo: regiao, total }));
      corpo = `${barrasHtml(linhas, base, "de quem respondeu")}
        <div class="sub-bloco"><h5>Por região</h5>${barrasHtml(
          regioes.sort((a, b) => b.total - a.total),
          base,
          "de quem respondeu"
        )}</div>`;
    } else {
      const linhas = pergunta.opcoes.map((opcao) => ({ rotulo: opcao, total: porValor.get(opcao) || 0 }));
      // Valor gravado que não é mais alternativa (edição anterior da pesquisa): aparece no fim,
      // em vez de sumir da conta.
      for (const [valor, total] of porValor) {
        if (!pergunta.opcoes.includes(valor)) linhas.push({ rotulo: valor, sub: "alternativa de versão anterior", total });
      }
      corpo = barrasHtml(linhas, base, pergunta.tipo === "multipla" ? "de quem respondeu marcaram" : "de quem respondeu");
    }

    // Genérico por `pergunta.outro`: hoje nenhuma pergunta tem "Outro" (decisão do cliente), então
    // o link "Ver o que escreveram em Outro" não aparece em quadro nenhum.
    let outro = "";
    if (pergunta.outro && base) {
      const quantos = porValor.get(pergunta.outro) || 0;
      if (quantos) outro = outroHtml(pergunta, quantos);
    }

    return `<article class="quadro${classe}" id="q-${escapeHtml(pergunta.id)}">
      <div class="quadro-cabeca">
        <p class="quadro-num">Pergunta ${escapeHtml(pergunta.numero)}</p>
        <h4>${escapeHtml(pergunta.texto)}</h4>
        <div class="quadro-meta">${chips.join("")}</div>
        ${nota}
      </div>
      ${corpo}
      ${outro}
    </article>`;
  }

  function histogramaHtml(pergunta, indice, porValor, base) {
    const media = mediaEscala(indice, pergunta);
    const valores = [];
    for (let valor = pergunta.min; valor <= pergunta.max; valor++) valores.push({ valor, total: porValor.get(String(valor)) || 0 });
    const maior = Math.max(1, ...valores.map((item) => item.total));
    const descricao = valores.map((item) => `${item.valor}: ${n(item.total)}`).join(", ");
    return `<div class="media"><strong>${media ? DEC.format(media.media) : "—"}</strong><span>média, de 0 a 10 · ${escapeHtml(plural(base, "resposta", "respostas"))}</span></div>
      <div class="histo" role="img" aria-label="${escapeHtml(`Quantas pessoas escolheram cada nota. ${descricao}.`)}">
        ${valores
          .map(
            (item) =>
              `<div class="histo-col" title="${escapeHtml(`${item.valor}: ${n(item.total)} (${pct(item.total, base)})`)}"><i style="height:${(
                (item.total / maior) *
                100
              ).toFixed(2)}%"></i>${item.total ? `<b style="bottom:${((item.total / maior) * 100).toFixed(2)}%">${n(item.total)}</b>` : ""}</div>`
          )
          .join("")}
      </div>
      <div class="histo-eixo" aria-hidden="true">${valores.map((item) => `<span>${item.valor}</span>`).join("")}</div>
      <div class="histo-legendas"><span>0 · ${escapeHtml(pergunta.legendaMin || "")}</span><span>${escapeHtml(pergunta.legendaMax || "")} · 10</span></div>
      <div class="tabela-rolagem visualmente-oculto"><table><caption>${escapeHtml(pergunta.analise)}</caption><thead><tr><th scope="col">Nota</th><th scope="col">Pessoas</th><th scope="col">%</th></tr></thead><tbody>${valores
        .map((item) => `<tr><th scope="row">${item.valor}</th><td>${n(item.total)}</td><td>${pct(item.total, base)}</td></tr>`)
        .join("")}</tbody></table></div>`;
  }

  function outroHtml(pergunta, quantos) {
    const estado = state.outros.get(pergunta.id);
    const aberto = Boolean(estado);
    const botao = `<button type="button" class="botao-texto" aria-expanded="${aberto}" aria-controls="outro-${escapeHtml(pergunta.id)}" data-outro="${escapeHtml(
      pergunta.id
    )}" data-foco="outro-${escapeHtml(pergunta.id)}">${aberto ? "Esconder o que escreveram em Outro" : `Ver o que escreveram em Outro (${n(quantos)})`}</button>`;
    if (!aberto) return `<div class="outro">${botao}</div>`;
    return `<div class="outro">${botao}<div class="outro-painel" id="outro-${escapeHtml(pergunta.id)}">${outroCorpo(pergunta, estado)}</div></div>`;
  }

  function outroCorpo(pergunta, estado) {
    if (estado.erro && !estado.itens.length) return erroHtml(estado.erro, `outro:${pergunta.id}`, `repetir-outro-${pergunta.id}`);
    if (!estado.itens.length && estado.carregando) return esqueleto(3);
    if (!estado.itens.length) return vazioHtml("Nenhum complemento escrito neste recorte.", "");
    const chave = EV.chaveOutro(pergunta);
    const lista = `<ul class="textos">${estado.itens
      .map((item) => textoItemHtml(item, `<blockquote>${escapeHtml((item.textos || {})[chave] || "")}</blockquote>`))
      .join("")}</ul>`;
    const falta = estado.total - estado.itens.length;
    const mais =
      falta > 0
        ? `<div class="mais"><p>Mostrando ${n(estado.itens.length)} de ${n(estado.total)}</p><button type="button" class="botao botao-leve botao-pequeno" data-outro-mais="${escapeHtml(
            pergunta.id
          )}" data-foco="outro-mais-${escapeHtml(pergunta.id)}" ${estado.carregando ? "disabled" : ""}>${estado.carregando ? "Carregando..." : "Carregar mais"}</button></div>`
        : `<div class="mais"><p>${escapeHtml(plural(estado.total, "complemento", "complementos"))}</p></div>`;
    const erro = estado.erro ? `<p class="nota" role="alert">${escapeHtml(mensagemErro(estado.erro))}</p>` : "";
    return lista + erro + mais;
  }

  function pintarPerguntas() {
    const r = state.resumo;
    const alvo = $("[data-perguntas]");
    const indice = indexar(r, undefined);
    const porEtapa = new Map();
    for (const pergunta of EV.PERGUNTAS) {
      const lista = porEtapa.get(pergunta.etapa) || [];
      lista.push(pergunta);
      porEtapa.set(pergunta.etapa, lista);
    }
    const html = EV.ETAPAS.map((etapa) => {
      const perguntas = porEtapa.get(etapa.n) || [];
      const analisaveis = perguntas.filter((pergunta) => ANALISAVEIS.includes(pergunta));
      const aberta = state.etapasAbertas.has(etapa.n);
      const resumoEtapa = analisaveis.length
        ? `${analisaveis.length} ${analisaveis.length === 1 ? "pergunta" : "perguntas"}`
        : "perguntas abertas, veja em Respostas abertas";
      const corpo = analisaveis.length
        ? `<div class="quadros">${analisaveis.map((pergunta) => quadroHtml(pergunta, indice)).join("")}</div>`
        : `<div class="quadros"><p class="nota">As perguntas ${perguntas
            .map((pergunta) => pergunta.numero)
            .join(", ")} são de texto livre. Leia o que as pessoas escreveram em <a href="#sec-abertas">Respostas abertas</a>.</p></div>`;
      return `<details class="etapa" data-etapa="${etapa.n}"${aberta ? " open" : ""}>
        <summary data-foco="etapa-${etapa.n}"><span class="etapa-nome">Etapa ${etapa.n} · ${escapeHtml(etapa.titulo)}<small>${escapeHtml(resumoEtapa)}</small></span></summary>
        ${corpo}
      </details>`;
    }).join("");
    redesenhar(alvo, html);
  }

  // O acordeão lembra o que a pessoa abriu: a atualização automática não fecha nada.
  $("[data-perguntas]").addEventListener(
    "toggle",
    (evento) => {
      const etapa = evento.target instanceof Element ? evento.target.closest("[data-etapa]") : null;
      if (!etapa || evento.target !== etapa) return;
      const numero = Number(etapa.dataset.etapa);
      if (etapa.open) state.etapasAbertas.add(numero);
      else state.etapasAbertas.delete(numero);
    },
    true
  );

  function redesenharQuadro(perguntaId) {
    const pergunta = EV.perguntaPorId(perguntaId);
    const quadro = document.getElementById(`q-${perguntaId}`);
    if (!pergunta || !quadro || !state.resumo) return;
    const temporario = document.createElement("div");
    const ativo = document.activeElement;
    const chave = ativo && quadro.contains(ativo) && ativo.closest("[data-foco]") ? ativo.closest("[data-foco]").getAttribute("data-foco") : "";
    temporario.innerHTML = quadroHtml(pergunta, indexar(state.resumo, undefined));
    const novo = temporario.firstElementChild;
    quadro.replaceWith(novo);
    const procurar = state.focoDepois || chave;
    if (procurar) {
      const alvo = novo.querySelector(`[data-foco="${CSS.escape(procurar)}"]`);
      if (alvo) {
        alvo.focus({ preventScroll: true });
        state.focoDepois = "";
      }
    }
  }

  async function carregarOutro(perguntaId, { mais = false } = {}) {
    const pergunta = EV.perguntaPorId(perguntaId);
    if (!pergunta || !pergunta.outro) return;
    let estado = state.outros.get(perguntaId);
    if (!estado || !mais) {
      estado = { itens: mais && estado ? estado.itens : [], total: estado ? estado.total : 0, carregando: false, erro: 0, seq: estado ? estado.seq : 0 };
      state.outros.set(perguntaId, estado);
    }
    const minha = ++estado.seq;
    estado.carregando = true;
    estado.erro = 0;
    redesenharQuadro(perguntaId);

    const params = parametros();
    params.set("chaves", EV.chaveOutro(pergunta));
    params.set("limite", String(LIMITE_OUTRO));
    params.set("offset", String(mais ? estado.itens.length : 0));
    const { ok, status, body } = await api(`/api/painel/abertas?${params}`);

    // Fechado no meio do caminho, ou uma requisição mais nova já saiu: descarta.
    if (state.outros.get(perguntaId) !== estado || minha !== estado.seq) return;
    estado.carregando = false;
    if (status === 401) {
      sessaoExpirou();
      return;
    }
    if (!ok) {
      estado.erro = status || 0;
    } else {
      const itens = Array.isArray(body.itens) ? body.itens : [];
      estado.itens = mais ? estado.itens.concat(itens) : itens;
      estado.total = num(body.total);
    }
    redesenharQuadro(perguntaId);
  }

  function recarregarOutros() {
    for (const id of Array.from(state.outros.keys())) carregarOutro(id);
  }

  $("[data-perguntas]").addEventListener("click", (evento) => {
    const alvo = evento.target instanceof Element ? evento.target : null;
    if (!alvo) return;
    const botaoOutro = alvo.closest("[data-outro]");
    if (botaoOutro) {
      const id = botaoOutro.dataset.outro;
      state.focoDepois = `outro-${id}`;
      if (state.outros.has(id)) {
        state.outros.delete(id);
        redesenharQuadro(id);
      } else {
        carregarOutro(id);
      }
      return;
    }
    const mais = alvo.closest("[data-outro-mais]");
    if (mais) {
      state.focoDepois = `outro-mais-${mais.dataset.outroMais}`;
      carregarOutro(mais.dataset.outroMais, { mais: true });
      return;
    }
  });

  /* ------------------------------------------------------------ Tráfego */

  const CAMPOS_TRAFEGO = {
    utm_source: "Origem (utm_source)",
    utm_campaign: "Campanha (utm_campaign)",
    utm_medium: "Mídia (utm_medium)",
    utm_content: "Anúncio (utm_content)",
    dispositivo: "Dispositivo"
  };

  const NOMES_DISPOSITIVO = { mobile: "Celular", tablet: "Tablet", desktop: "Computador", "(desconhecido)": "(desconhecido)" };

  function taxaHtml(parte, base) {
    if (!base) return '<span class="taxa">—</span>';
    const valor = Math.min(100, (parte / base) * 100);
    return `<span class="taxa"><span>${pct(parte, base)}</span><i aria-hidden="true"><b style="width:${valor.toFixed(1)}%"></b></i></span>`;
  }

  function pintarTrafego() {
    const r = state.resumo;
    const alvo = $("[data-trafego]");
    $$("[data-campo]").forEach((botao) => botao.setAttribute("aria-pressed", String(botao.dataset.campo === state.trafegoCampo)));
    const linhas = r.trafego
      .filter((linha) => linha.campo === state.trafegoCampo)
      .map((linha) => ({ valor: String(linha.valor), visitantes: num(linha.visitantes), pessoas: num(linha.pessoas), concluidas: num(linha.concluidas) }));

    if (!linhas.length) {
      redesenhar(alvo, `<div class="trafego-tabela">${vazioHtml("Nenhum acesso neste recorte.", "")}</div>`);
      return;
    }
    const comPerfil = filtroDePessoa();
    const total = linhas.reduce(
      (soma, linha) => ({ visitantes: soma.visitantes + linha.visitantes, pessoas: soma.pessoas + linha.pessoas, concluidas: soma.concluidas + linha.concluidas }),
      { visitantes: 0, pessoas: 0, concluidas: 0 }
    );
    const nome = (valor) => (state.trafegoCampo === "dispositivo" ? NOMES_DISPOSITIVO[valor] || valor : valor);
    const html = `<div class="tabela-rolagem trafego-tabela"><table>
      <caption>${escapeHtml(CAMPOS_TRAFEGO[state.trafegoCampo])}${comPerfil ? ` · identificados e concluídas só de ${escapeHtml(descricaoFiltroPessoa())}; visitantes sem filtro de pessoa` : ""}</caption>
      <thead><tr>
        <th scope="col">${escapeHtml(state.trafegoCampo === "dispositivo" ? "Dispositivo" : "Valor")}</th>
        <th scope="col" class="n">Visitantes</th>
        <th scope="col" class="n">Identificados</th>
        <th scope="col" class="n">Concluídas</th>
        <th scope="col" class="n col-taxa">Identificados ÷ visitantes</th>
        <th scope="col" class="n col-taxa">Concluídas ÷ identificados</th>
      </tr></thead>
      <tbody>${linhas
        .map(
          (linha) => `<tr>
          <th scope="row">${escapeHtml(nome(linha.valor))}</th>
          <td class="n">${n(linha.visitantes)}</td>
          <td class="n">${n(linha.pessoas)}${comPerfil || !linha.visitantes ? "" : `<span class="taxa-curta"> · ${pct(linha.pessoas, linha.visitantes)}</span>`}</td>
          <td class="n">${n(linha.concluidas)}${linha.pessoas ? `<span class="taxa-curta"> · ${pct(linha.concluidas, linha.pessoas)}</span>` : ""}</td>
          <td class="n col-taxa">${comPerfil ? "—" : taxaHtml(linha.pessoas, linha.visitantes)}</td>
          <td class="n col-taxa">${taxaHtml(linha.concluidas, linha.pessoas)}</td>
        </tr>`
        )
        .join("")}</tbody>
    </table></div>
    <p class="nota">${
      comPerfil
        ? "Com perfil, situação ou busca escolhidos, a taxa de identificação fica de fora: o acesso não tem nome nem perfil, e dividir um recorte pelo tráfego de todos daria um número sem sentido."
        : `“(sem utm)” é quem chegou sem parâmetro de campanha (link direto, bio, compartilhamento). Até 30 valores por campo, dos que mais trouxeram gente. Somando a tabela: ${n(
            total.visitantes
          )} visitantes, ${n(total.pessoas)} identificados, ${n(total.concluidas)} concluídas.`
    }</p>`;
    redesenhar(alvo, html);
  }

  $("[data-trafego-campos]").addEventListener("click", (evento) => {
    const botao = evento.target instanceof Element ? evento.target.closest("[data-campo]") : null;
    if (!botao) return;
    state.trafegoCampo = botao.dataset.campo;
    if (state.resumo) pintarTrafego();
    else $$("[data-campo]").forEach((item) => item.setAttribute("aria-pressed", String(item === botao)));
  });

  /* ================================================================== */
  /* Cruzamento                                                           */
  /* ================================================================== */

  function montarSelects() {
    const opcoes = EV.ETAPAS.map((etapa) => {
      const perguntas = ANALISAVEIS.filter((pergunta) => pergunta.etapa === etapa.n);
      if (!perguntas.length) return "";
      return `<optgroup label="${escapeHtml(`Etapa ${etapa.n} · ${etapa.titulo}`)}">${perguntas
        .map((pergunta) => `<option value="${escapeHtml(pergunta.id)}">${escapeHtml(`${pergunta.numero}. ${pergunta.analise}`)}</option>`)
        .join("")}</optgroup>`;
    }).join("");
    $("[data-cruz-linha]").innerHTML = opcoes;
    $("[data-cruz-coluna]").innerHTML = opcoes;
    $("[data-cruz-linha]").value = state.cruz.linha;
    $("[data-cruz-coluna]").value = state.cruz.coluna;
  }

  async function carregarCruzamento() {
    const minha = ++seq.cruz;
    const alvo = $("[data-cruzamento]");
    const cartao = alvo.closest(".cartao");
    if (state.cruz.linha === state.cruz.coluna) {
      state.cruz.dados = null;
      redesenhar(alvo, vazioHtml("Escolha duas perguntas diferentes.", "Linhas e colunas precisam ser perguntas diferentes para o cruzamento fazer sentido."));
      return;
    }
    state.cruz.carregando = true;
    if (!state.cruz.dados) redesenhar(alvo, esqueleto(6));
    cartao.setAttribute("aria-busy", "true");

    const params = parametros();
    params.set("linha", state.cruz.linha);
    params.set("coluna", state.cruz.coluna);
    const { ok, status, body } = await api(`/api/painel/cruzamento?${params}`);
    if (minha !== seq.cruz) return;
    cartao.removeAttribute("aria-busy");
    state.cruz.carregando = false;

    if (status === 401) {
      sessaoExpirou();
      return;
    }
    if (!ok || !body.cruzamento) {
      state.cruz.dados = null;
      state.cruz.erro = status || 0;
      redesenhar(alvo, erroHtml(status, "cruzamento"));
      return;
    }
    state.cruz.erro = 0;
    state.cruz.dados = body.cruzamento;
    pintarCruzamento();
  }

  /**
   * Rampa sequencial da ameixa, contínua, do quase branco até o tom médio. Para no tom em que a
   * tinta berinjela ainda passa AA (4,6:1): o número dentro da célula fica legível em todas, sem
   * troca de cor de texto no meio (que faria 21% parecer tão escuro quanto 34%).
   */
  function corCelula(t) {
    const claro = [246, 236, 239];
    const escuro = [174, 143, 161];
    const cor = claro.map((canal, i) => Math.round(canal + (escuro[i] - canal) * Math.max(0, Math.min(1, t))));
    return { fundo: `rgb(${cor.join(",")})`, texto: "var(--ink)" };
  }

  /** Ordem das alternativas: a da pergunta; perfil usa a ordem de PERFIL; extras no fim. */
  function ordemDe(perguntaId, valores) {
    const pergunta = EV.perguntaPorId(perguntaId);
    const ordem = pergunta && pergunta.opcoes ? pergunta.opcoes.map(String) : pergunta && pergunta.tipo === "escala" ? Array.from({ length: pergunta.max - pergunta.min + 1 }, (_, i) => String(pergunta.min + i)) : [];
    const presentes = new Set(valores.map(String));
    const saida = ordem.filter((valor) => presentes.has(valor));
    for (const valor of valores.map(String)) if (!saida.includes(valor)) saida.push(valor);
    return saida;
  }

  function rotuloValor(perguntaId, valor) {
    if (perguntaId === "perfil") return perfilCurto(valor);
    const pergunta = EV.perguntaPorId(perguntaId);
    if (pergunta && pergunta.tipo === "escala") return `Nota ${valor}`;
    return valor;
  }

  function pintarCruzamento() {
    const alvo = $("[data-cruzamento]");
    $$("[data-modo]").forEach((botao) => botao.setAttribute("aria-pressed", String(botao.dataset.modo === state.cruz.modo)));
    const dados = state.cruz.dados;
    if (!dados) return;
    const linhaP = EV.perguntaPorId(dados.linha) || EV.perguntaPorId(state.cruz.linha);
    const colunaP = EV.perguntaPorId(dados.coluna) || EV.perguntaPorId(state.cruz.coluna);
    const base = num(dados.base);
    const totLinha = new Map((dados.linhas || []).map((item) => [String(item.valor), num(item.total)]));
    const totColuna = new Map((dados.colunas || []).map((item) => [String(item.valor), num(item.total)]));
    const celulas = new Map((dados.celulas || []).map((item) => [`${item.linha}\u0000${item.coluna}`, num(item.total)]));

    if (!base) {
      redesenhar(alvo, vazioHtml("Ninguém respondeu as duas perguntas neste recorte.", linhaP && colunaP && (linhaP.visivelSe || colunaP.visivelSe) ? "Uma delas é só para um perfil: confira se o outro lado não é de outro perfil." : ""));
      return;
    }

    // Linha/coluna sem ninguém sai da tabela (os 27 estados virariam 20 linhas de zero).
    const linhas = ordemDe(dados.linha, Array.from(totLinha.keys()).filter((valor) => totLinha.get(valor) > 0));
    const colunas = ordemDe(dados.coluna, Array.from(totColuna.keys()).filter((valor) => totColuna.get(valor) > 0));
    const modo = state.cruz.modo;

    const valorDe = (l, c) => celulas.get(`${l}\u0000${c}`) || 0;
    const exibido = (l, c) => {
      const total = valorDe(l, c);
      if (modo === "linha") return totLinha.get(l) ? total / totLinha.get(l) : 0;
      if (modo === "coluna") return totColuna.get(c) ? total / totColuna.get(c) : 0;
      return total;
    };
    let maximo = 0;
    for (const l of linhas) for (const c of colunas) maximo = Math.max(maximo, exibido(l, c));

    const texto = (l, c) => {
      const total = valorDe(l, c);
      if (modo === "numeros") return n(total);
      if (!total) return "0%";
      return pct(total, modo === "linha" ? totLinha.get(l) : totColuna.get(c));
    };

    const multipla = [linhaP, colunaP].some((pergunta) => pergunta && pergunta.tipo === "multipla");
    const baseModo =
      modo === "linha"
        ? `Cada linha soma quem deu aquela resposta em “${linhaP ? linhaP.analise : dados.linha}”${multipla ? " (pergunta de marcar várias: a linha pode passar de 100%)" : ""}.`
        : modo === "coluna"
          ? `Cada coluna soma quem deu aquela resposta em “${colunaP ? colunaP.analise : dados.coluna}”${multipla ? " (pergunta de marcar várias: a coluna pode passar de 100%)" : ""}.`
          : "Número de pessoas em cada combinação.";

    const cabecalho = `<tr><th scope="col">${escapeHtml(linhaP ? linhaP.analise : dados.linha)} ↓ · ${escapeHtml(colunaP ? colunaP.analise : dados.coluna)} →</th>${colunas
      .map((c) => `<th scope="col">${escapeHtml(rotuloValor(dados.coluna, c))}</th>`)
      .join("")}<th scope="col" class="n">Total</th></tr>`;

    const corpo = linhas
      .map((l) => {
        const celulasHtml = colunas
          .map((c) => {
            const valor = exibido(l, c);
            const t = maximo ? valor / maximo : 0;
            const { fundo, texto: tinta } = valorDe(l, c) ? corCelula(t) : { fundo: "transparent", texto: "var(--ink-soft)" };
            const titulo = `${rotuloValor(dados.linha, l)} × ${rotuloValor(dados.coluna, c)}: ${plural(valorDe(l, c), "pessoa", "pessoas")}`;
            return `<td class="celula" style="background:${fundo};color:${tinta}" title="${escapeHtml(titulo)}">${texto(l, c)}</td>`;
          })
          .join("");
        return `<tr><th scope="row">${escapeHtml(rotuloValor(dados.linha, l))}</th>${celulasHtml}<td class="n">${n(totLinha.get(l))}</td></tr>`;
      })
      .join("");

    const rodape = `<tr><th scope="row">Total</th>${colunas.map((c) => `<td class="n">${n(totColuna.get(c))}</td>`).join("")}<td class="n">${n(base)}</td></tr>`;

    const ocultas =
      (linhaP && linhaP.opcoes ? linhaP.opcoes.length - linhas.length : 0) + (colunaP && colunaP.opcoes ? colunaP.opcoes.length - colunas.length : 0);

    redesenhar(
      alvo,
      `<p class="cruz-base"><strong>${escapeHtml(plural(base, "pessoa", "pessoas"))} com as duas respostas</strong> · ${escapeHtml(rotuloPeriodo())}${
        filtroDePessoa() ? ` · só ${escapeHtml(descricaoFiltroPessoa())}` : ""
      }. ${escapeHtml(baseModo)}</p>
      <div class="tabela-rolagem"><table class="cruz">
        <thead>${cabecalho}</thead>
        <tbody>${corpo}</tbody>
        <tfoot>${rodape}</tfoot>
      </table></div>
      <div class="escala-legenda"><span>menos</span><i aria-hidden="true"></i><span>mais</span>${
        ocultas > 0 ? `<span>· ${escapeHtml(plural(ocultas, "alternativa sem ninguém ficou oculta", "alternativas sem ninguém ficaram ocultas"))}</span>` : ""
      }</div>`
    );
  }

  $("[data-cruz-linha]").addEventListener("change", (evento) => {
    state.cruz.linha = evento.target.value;
    carregarCruzamento();
  });
  $("[data-cruz-coluna]").addEventListener("change", (evento) => {
    state.cruz.coluna = evento.target.value;
    carregarCruzamento();
  });
  $("[data-cruz-modos]").addEventListener("click", (evento) => {
    const botao = evento.target instanceof Element ? evento.target.closest("[data-modo]") : null;
    if (!botao) return;
    state.cruz.modo = botao.dataset.modo;
    if (state.cruz.dados) pintarCruzamento();
    else $$("[data-modo]").forEach((item) => item.setAttribute("aria-pressed", String(item === botao)));
  });

  /* ================================================================== */
  /* Respostas abertas                                                    */
  /* ================================================================== */

  function textoItemHtml(item, conteudo) {
    return `<li class="texto">${conteudo}<div class="quem"><strong>${escapeHtml(item.nome || "Sem nome")}</strong><span>${escapeHtml(
      perfilCurto(item.perfil)
    )}</span><span>${escapeHtml(dataHora(item.criado_em))}</span>${item.status === "concluida" ? "<span>respondeu tudo</span>" : ""}</div></li>`;
  }

  /** Marca o termo buscado sem abrir brecha: escapa primeiro, depois envolve os trechos. */
  function realcar(texto, termo) {
    const seguro = escapeHtml(texto);
    if (!termo) return seguro;
    const alvo = escapeHtml(termo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return seguro.replace(new RegExp(alvo, "gi"), (achado) => `<mark>${achado}</mark>`);
  }

  function normalizarBusca(texto) {
    return String(texto || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function conteudoAberta(item) {
    const textos = item.textos || {};
    const termo = state.abertasBusca.trim();
    if (state.aberta === "frase") {
      const desejo = textos.frase_desejo;
      const bloqueio = textos.frase_bloqueio;
      return `<blockquote><em>Eu gostaria muito de</em> ${desejo ? realcar(desejo, termo) : "<em>—</em>"}<em>, mas ainda não consegui porque</em> ${
        bloqueio ? realcar(bloqueio, termo) : "<em>—</em>"
      }</blockquote>`;
    }
    const chave = ABERTAS[state.aberta].chaves[0];
    return `<blockquote>${realcar(textos[chave] || "", termo)}</blockquote>`;
  }

  function pintarAbertas() {
    const alvo = $("[data-abertas]");
    const config = ABERTAS[state.aberta];
    const pergunta = EV.perguntaPorId(config.pergunta);
    $("[data-aberta-pergunta]").textContent = pergunta ? `${pergunta.numero}. ${pergunta.texto}` : "";
    const painel = $("[data-abertas-painel]");
    painel.setAttribute("aria-labelledby", `aba-${state.aberta}`);
    $$("[data-aberta]").forEach((aba) => {
      const ativo = aba.dataset.aberta === state.aberta;
      aba.setAttribute("aria-selected", String(ativo));
      aba.tabIndex = ativo ? 0 : -1;
    });

    const a = state.abertas;
    if (a.erro && !a.itens.length) {
      redesenhar(alvo, erroHtml(a.erro, "abertas"));
      return;
    }
    if (!a.pronto) {
      redesenhar(alvo, esqueleto(6));
      return;
    }
    if (!a.itens.length) {
      redesenhar(alvo, vazioHtml("Ninguém escreveu nesta pergunta ainda.", "É opcional: aparece aqui assim que alguém responder."));
      return;
    }

    // Busca local: filtra o que já veio, sem ir à rede. Deixa claro que é só sobre o carregado.
    const termo = normalizarBusca(state.abertasBusca.trim());
    const visiveis = termo
      ? a.itens.filter((item) => normalizarBusca(Object.values(item.textos || {}).join(" ") + " " + (item.nome || "")).includes(termo))
      : a.itens;
    const falta = a.total - a.itens.length;
    const lista = visiveis.length
      ? `<ul class="textos">${visiveis.map((item) => textoItemHtml(item, conteudoAberta(item))).join("")}</ul>`
      : vazioHtml("Nada encontrado no que já carregou.", falta > 0 ? "Carregue mais respostas para buscar nelas também." : "");
    const contagem = termo
      ? `${plural(visiveis.length, "resposta encontrada", "respostas encontradas")} entre as ${n(a.itens.length)} carregadas (de ${n(a.total)})`
      : `Mostrando ${n(a.itens.length)} de ${plural(a.total, "resposta", "respostas")}`;
    const mais = `<div class="mais"><p>${escapeHtml(contagem)}</p>${
      falta > 0
        ? `<button type="button" class="botao botao-leve botao-pequeno" data-abertas-mais data-foco="abertas-mais" ${a.carregando ? "disabled" : ""}>${
            a.carregando ? "Carregando..." : "Carregar mais"
          }</button>`
        : ""
    }</div>`;
    const erro = a.erro ? `<p class="nota" role="alert">${escapeHtml(mensagemErro(a.erro))}</p>` : "";
    redesenhar(alvo, lista + erro + mais);
  }

  async function carregarAbertas({ reiniciar = false } = {}) {
    const minha = ++seq.abertas;
    if (reiniciar) state.abertas = { itens: [], total: 0, erro: 0, carregando: true, pronto: false };
    state.abertas.carregando = true;
    state.abertas.erro = 0;
    pintarAbertas();

    const params = parametros();
    params.set("chaves", ABERTAS[state.aberta].chaves.join(","));
    params.set("limite", String(LIMITE_ABERTAS));
    params.set("offset", String(state.abertas.itens.length));
    const { ok, status, body } = await api(`/api/painel/abertas?${params}`);
    if (minha !== seq.abertas) return;
    state.abertas.carregando = false;
    if (status === 401) {
      sessaoExpirou();
      return;
    }
    if (!ok) {
      state.abertas.erro = status || 0;
      state.abertas.pronto = true;
    } else {
      const itens = Array.isArray(body.itens) ? body.itens : [];
      state.abertas.itens = state.abertas.itens.concat(itens);
      state.abertas.total = num(body.total);
      state.abertas.pronto = true;
    }
    pintarAbertas();
  }

  const abasAbertas = $$("[data-aberta]");
  function trocarAberta(chave) {
    if (!ABERTAS[chave] || chave === state.aberta) return;
    state.aberta = chave;
    carregarAbertas({ reiniciar: true });
  }
  abasAbertas.forEach((aba, indice) => {
    aba.addEventListener("click", () => trocarAberta(aba.dataset.aberta));
    aba.addEventListener("keydown", (evento) => {
      const passo = evento.key === "ArrowRight" ? 1 : evento.key === "ArrowLeft" ? -1 : 0;
      if (!passo) return;
      evento.preventDefault();
      const proxima = abasAbertas[(indice + passo + abasAbertas.length) % abasAbertas.length];
      proxima.focus();
      trocarAberta(proxima.dataset.aberta);
    });
  });

  $("[data-abertas-busca]").addEventListener("input", (evento) => {
    state.abertasBusca = evento.target.value;
    pintarAbertas();
  });

  $("[data-abertas]").addEventListener("click", (evento) => {
    const alvo = evento.target instanceof Element ? evento.target : null;
    if (!alvo) return;
    if (alvo.closest("[data-abertas-mais]")) {
      state.focoDepois = "abertas-mais";
      carregarAbertas();
    }
  });

  /* ================================================================== */
  /* Pessoas                                                              */
  /* ================================================================== */

  // A lista usa exatamente os filtros da barra do topo (período, perfil, situação e busca).
  function parametrosLista() {
    return parametros();
  }

  /** O CSV sai com os MESMOS filtros da tela (período, perfil, situação, busca). */
  function atualizarCsv() {
    const params = parametrosLista();
    if ($("[data-csv-tentativas]").checked) params.set("tentativas", "todas");
    $("[data-csv]").href = `/api/painel/exportar.csv?${params}`;
  }

  async function carregarLista({ reiniciar = false } = {}) {
    const minha = ++seq.lista;
    const lista = state.lista;
    lista.carregando = true;
    lista.erro = 0;
    if (!lista.pronto) pintarLista();
    else pintarContador();
    $("[data-lista]").setAttribute("aria-busy", "true");

    const params = parametrosLista();
    params.set("limite", String(LIMITE_LISTA));
    params.set("offset", String(reiniciar ? 0 : lista.itens.length));
    const { ok, status, body } = await api(`/api/painel/respostas?${params}`);
    if (minha !== seq.lista) return;
    $("[data-lista]").removeAttribute("aria-busy");
    lista.carregando = false;

    if (status === 401) {
      sessaoExpirou();
      return;
    }
    if (!ok) {
      lista.erro = status || 0;
      if (reiniciar) {
        lista.itens = [];
        lista.total = 0;
      }
      lista.pronto = true;
      pintarLista();
      return;
    }
    const itens = Array.isArray(body.itens) ? body.itens : [];
    lista.itens = reiniciar ? itens : lista.itens.concat(itens);
    lista.total = num(body.total);
    lista.pronto = true;
    pintarLista();
  }

  function pintarContador() {
    const lista = state.lista;
    const alvo = $("[data-contador]");
    if (!lista.pronto) {
      alvo.textContent = "Carregando pessoas...";
      return;
    }
    if (lista.erro && !lista.itens.length) {
      alvo.textContent = "";
      return;
    }
    const filtrado = state.busca.trim() || state.status;
    alvo.innerHTML = `Mostrando <strong>${n(lista.itens.length)}</strong> de <strong>${n(lista.total)}</strong> ${
      num(lista.total) === 1 ? "pessoa" : "pessoas"
    }${filtrado ? " com estes filtros" : ""}${lista.carregando ? " · atualizando..." : ""}`;
  }

  function statusSelo(item) {
    if (item.status === "concluida") return '<span class="selo ok"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>Respondeu tudo</span>';
    const pergunta = EV.perguntaPorId(item.pergunta_max) || EV.perguntaPorId(item.pergunta_atual);
    const onde = pergunta ? `Parou na pergunta ${pergunta.numero}` : "Em andamento";
    return `<span class="selo meio" title="${escapeHtml(pergunta ? pergunta.analise : "")}">${escapeHtml(`${onde} · ${num(item.progresso_percentual)}% respondido`)}</span>`;
  }

  function pessoaHtml(item) {
    const aberto = state.abertos.has(item.id);
    const link = whatsappLink(item.whatsapp_digits);
    const telefone = item.whatsapp
      ? link
        ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>${escapeHtml(
            item.whatsapp
          )}<span class="visualmente-oculto"> (abre o WhatsApp)</span></a>`
        : `<span>${escapeHtml(item.whatsapp)}</span>`
      : "<span>sem WhatsApp</span>";
    const tentativas = num(item.tentativas);
    const repetidas = tentativas > 1 ? `<span class="selo rep">${escapeHtml(`${n(tentativas)} tentativas`)}</span>` : "";
    const idSeguro = escapeHtml(item.id);
    return `<article class="pessoa" data-pessoa="${idSeguro}">
      <div class="pessoa-cabeca">
        <div class="pessoa-quem">
          <span class="pessoa-nome">${escapeHtml(item.nome || "Sem nome")}</span>
          <span class="pessoa-meta">${escapeHtml(dataHora(item.criado_em))} · ${escapeHtml(perfilCurto(item.perfil))}</span>
        </div>
        <div class="pessoa-contato">${telefone}<span>${escapeHtml(item.email || "sem e-mail")}</span></div>
        <div class="pessoa-selos">${statusSelo(item)}${repetidas}</div>
        <div class="pessoa-acoes">
          <span class="pessoa-origem">${escapeHtml(origemTexto(item))}</span>
          <button type="button" class="botao-texto" aria-expanded="${aberto}" aria-controls="det-${idSeguro}" data-ver="${idSeguro}" data-foco="ver-${idSeguro}">${aberto ? "Fechar" : "Ver tudo"}</button>
        </div>
      </div>
      ${aberto ? detalhePessoaHtml(item) : ""}
    </article>`;
  }

  /** Para qual página de obrigado o perfil da pessoa leva (quem não terminou ainda vai ao terminar). */
  function paginaObrigadoTexto(item) {
    const pagina = OBR && item.perfil ? OBR.paginaDoPerfil(item.perfil) : null;
    if (!pagina) return "";
    return `${pagina.nome} (${pagina.rota})${item.finalizado_em ? "" : " · vai para ela ao terminar"}`;
  }

  /** Texto de uma resposta para leitura humana, com o complemento do "Outro". */
  function valorLegivel(pergunta, respostas) {
    if (pergunta.tipo === "frase") {
      const [desejo, bloqueio] = pergunta.partes.map((parte) => respostas[parte.id]);
      if (!desejo && !bloqueio) return null;
      return `${pergunta.partes[0].antes} ${desejo || "—"}, ${pergunta.partes[1].antes} ${bloqueio || "—"}`;
    }
    const valor = respostas[pergunta.id];
    if (valor == null || valor === "" || (Array.isArray(valor) && !valor.length)) return null;
    const complemento = pergunta.outro ? respostas[EV.chaveOutro(pergunta)] : "";
    const comOutro = (texto) => (texto === pergunta.outro && complemento ? `${texto}: ${complemento}` : texto);
    if (Array.isArray(valor)) return valor.map((item) => `• ${comOutro(String(item))}`).join("\n");
    if (pergunta.tipo === "escala") return `${valor}/10`;
    return comOutro(String(valor));
  }

  function detalhePessoaHtml(item) {
    const respostas = item.respostas && typeof item.respostas === "object" ? item.respostas : {};
    const tempos = item.tempos && typeof item.tempos === "object" ? item.tempos : {};
    let etapaAtual = 0;
    const linhas = [];
    for (const pergunta of EV.PERGUNTAS) {
      // Condicional de outro perfil nem aparece: a cuidadora não tem "pergunta do técnico".
      if (pergunta.visivelSe && !EV.estaVisivel(pergunta, respostas)) continue;
      if (pergunta.etapa !== etapaAtual) {
        etapaAtual = pergunta.etapa;
        const etapa = EV.etapaPorNumero(etapaAtual);
        linhas.push(`<li class="etapa-rotulo">Etapa ${etapaAtual} · ${escapeHtml(etapa ? etapa.titulo : "")}</li>`);
      }
      const valor = valorLegivel(pergunta, respostas);
      const tempo = tempos[pergunta.id];
      linhas.push(`<li class="resposta">
        <span class="pergunta"><b>${escapeHtml(pergunta.numero)}.</b> ${escapeHtml(pergunta.texto)}</span>
        <span class="valor${valor == null ? " vazio-valor" : ""}">${valor == null ? "—" : escapeHtml(valor)}</span>
        <span class="tempo">${tempo != null ? escapeHtml(duracao(tempo)) : ""}</span>
      </li>`);
    }

    // Chave gravada que não é mais pergunta (versão anterior): mostra, não esconde.
    const conhecidas = new Set(EV.PERGUNTAS.flatMap((pergunta) => EV.chavesDaPergunta(pergunta)));
    const estranhas = Object.keys(respostas).filter((chave) => !conhecidas.has(chave));
    const extras = estranhas.length
      ? `<p class="detalhe-titulo">Respostas de versão anterior</p><dl class="grade-dados">${estranhas
          .map((chave) => `<div><dt>${escapeHtml(chave)}</dt><dd>${escapeHtml(Array.isArray(respostas[chave]) ? respostas[chave].join(", ") : respostas[chave])}</dd></div>`)
          .join("")}</dl>`
      : "";

    const pergunta = EV.perguntaPorId(item.pergunta_atual);
    const dados = [
      ["Situação", item.status === "concluida" ? "Respondeu tudo" : "Em andamento"],
      ["Progresso", `${num(item.progresso_percentual)}% · ${n(item.obrigatorias_respondidas)} de ${n(item.obrigatorias)} obrigatórias · ${n(item.respondidas)} de ${n(item.total_perguntas)} respondidas`],
      ["Tela atual", item.pergunta_atual === "fim" ? "Tela final" : pergunta ? `Pergunta ${pergunta.numero} · ${pergunta.analise}` : item.pergunta_atual],
      ["Tempo no contato", tempos.contato != null ? duracao(tempos.contato) : ""],
      ["Tempo total", item.tempo_total_segundos != null ? duracao(item.tempo_total_segundos) : item.status === "concluida" ? "" : "ainda não concluiu"],
      ["Se identificou em", dataHora(item.criado_em)],
      ["Última resposta", dataHora(item.ultima_resposta_em)],
      ["Concluiu em", item.concluido_em ? dataHora(item.concluido_em) : ""],
      ["Chegou à tela final em", item.finalizado_em ? dataHora(item.finalizado_em) : ""],
      ["Página de obrigado", paginaObrigadoTexto(item)],
      [
        "Enviado ao n8n",
        item.webhook_enviado_em
          ? `Enviado ao n8n em ${dataHora(item.webhook_enviado_em)}`
          : item.finalizado_em
            ? "Ainda não confirmado pelo n8n"
            : ""
      ],
      ["Tentativas com este WhatsApp", n(item.tentativas || 1)],
      ["WhatsApp internacional", item.whatsapp_internacional],
      ["Dispositivo", NOMES_DISPOSITIVO[item.dispositivo] || item.dispositivo],
      ["utm_source", item.utm_source],
      ["utm_medium", item.utm_medium],
      ["utm_campaign", item.utm_campaign],
      ["utm_content", item.utm_content],
      ["utm_term", item.utm_term],
      ["fbclid", item.fbclid],
      ["gclid", item.gclid],
      ["Página", item.page_url],
      ["Veio de (referrer)", item.referrer],
      ["Id da sessão", item.id],
      ["Versão da pesquisa", item.pesquisa_versao]
    ].filter(([, valor]) => valor != null && valor !== "");

    return `<div class="pessoa-detalhe" id="det-${escapeHtml(item.id)}">
      <p class="detalhe-titulo">Respostas, na ordem da pesquisa</p>
      <ol class="respostas">${linhas.join("")}</ol>
      ${extras}
      <p class="detalhe-titulo">Progresso e rastreio</p>
      <dl class="grade-dados">${dados.map(([rotulo, valor]) => `<div><dt>${escapeHtml(rotulo)}</dt><dd>${escapeHtml(valor)}</dd></div>`).join("")}</dl>
    </div>`;
  }

  function pintarLista() {
    const alvo = $("[data-lista]");
    const lista = state.lista;
    pintarContador();
    if (!lista.pronto) {
      redesenhar(alvo, esqueleto(8));
      return;
    }
    if (lista.erro && !lista.itens.length) {
      redesenhar(alvo, erroHtml(lista.erro, "lista"));
      return;
    }
    if (!lista.itens.length) {
      const filtrado = state.busca.trim() || state.status;
      redesenhar(
        alvo,
        vazioHtml(
          filtrado ? "Ninguém encontrado com estes filtros." : "Ninguém se identificou neste recorte ainda.",
          filtrado ? "Confira a busca ou troque a situação para “Todas”." : "As pessoas aparecem aqui assim que deixam nome, WhatsApp e e-mail."
        )
      );
      return;
    }
    const falta = lista.total - lista.itens.length;
    const mais = `<div class="mais">${
      falta > 0
        ? `<button type="button" class="botao botao-leve" data-lista-mais data-foco="lista-mais" ${lista.carregando ? "disabled" : ""}>${
            lista.carregando ? "Carregando..." : `Carregar mais ${n(Math.min(LIMITE_LISTA, falta))}`
          }</button>`
        : `<p>Essas são todas.</p>`
    }</div>`;
    const erro = lista.erro ? `<p class="nota" role="alert">${escapeHtml(mensagemErro(lista.erro))}</p>` : "";
    redesenhar(alvo, `<div class="pessoas">${lista.itens.map(pessoaHtml).join("")}</div>${erro}${mais}`);
  }

  $("[data-lista]").addEventListener("click", (evento) => {
    const alvo = evento.target instanceof Element ? evento.target : null;
    if (!alvo) return;
    const ver = alvo.closest("[data-ver]");
    if (ver) {
      // Abre sem ir à rede: todas as colunas da pessoa já vieram na lista.
      const id = ver.dataset.ver;
      if (state.abertos.has(id)) state.abertos.delete(id);
      else state.abertos.add(id);
      state.focoDepois = `ver-${id}`;
      pintarLista();
      return;
    }
    if (alvo.closest("[data-lista-mais]")) {
      state.focoDepois = "lista-mais";
      carregarLista();
    }
  });

  $("[data-csv-tentativas]").addEventListener("change", atualizarCsv);

  /* ================================================================== */
  /* Filtros: eventos                                                     */
  /* ================================================================== */

  $("[data-periodos]").addEventListener("click", (evento) => {
    const botao = evento.target instanceof Element ? evento.target.closest("[data-periodo]") : null;
    if (!botao) return;
    const periodo = botao.dataset.periodo;
    if (periodo === "personalizado") {
      // Só abre o formulário; o recorte muda quando as duas datas forem aplicadas.
      $$("[data-periodo]").forEach((item) => item.setAttribute("aria-pressed", String(item === botao)));
      const datas = $("[data-datas]");
      datas.hidden = false;
      const de = $("[data-data-de]");
      const ate = $("[data-data-ate]");
      const hoje = hojeSP();
      de.max = hoje;
      ate.max = hoje;
      if (!de.value) de.value = state.de || somarDias(hoje, -13);
      if (!ate.value) ate.value = state.ate || hoje;
      de.focus();
      return;
    }
    if (periodo === state.periodo) {
      $("[data-datas]").hidden = true;
      pintarFiltros();
      return;
    }
    state.periodo = periodo;
    $("[data-datas-erro]").textContent = "";
    escreverUrl();
    pintarFiltros();
    aplicarPeriodo();
  });

  $("[data-datas]").addEventListener("submit", (evento) => {
    evento.preventDefault();
    const de = $("[data-data-de]").value;
    const ate = $("[data-data-ate]").value;
    const erro = $("[data-datas-erro]");
    if (!ymdValido(de) || !ymdValido(ate)) {
      erro.textContent = "Escolha as duas datas.";
      return;
    }
    if (de > ate) {
      erro.textContent = "A data inicial precisa ser antes da final.";
      return;
    }
    erro.textContent = "";
    state.periodo = "personalizado";
    state.de = de;
    state.ate = ate;
    escreverUrl();
    pintarFiltros();
    aplicarPeriodo();
  });

  function trocarPerfil(chave) {
    if (chave === state.perfil) return;
    state.perfil = chave;
    escreverUrl();
    carregarTudo();
  }

  $("[data-perfis]").addEventListener("click", (evento) => {
    const aba = evento.target instanceof Element ? evento.target.closest("[data-perfil]") : null;
    if (!aba) return;
    state.focoDepois = `perfil-${aba.dataset.perfil || "todos"}`;
    trocarPerfil(aba.dataset.perfil);
  });

  $("[data-perfis]").addEventListener("keydown", (evento) => {
    const passo = evento.key === "ArrowRight" ? 1 : evento.key === "ArrowLeft" ? -1 : 0;
    if (!passo) return;
    const abas = $$("[data-perfil]");
    const atual = abas.indexOf(document.activeElement);
    if (atual < 0) return;
    evento.preventDefault();
    const proxima = abas[(atual + passo + abas.length) % abas.length];
    state.focoDepois = `perfil-${proxima.dataset.perfil || "todos"}`;
    proxima.focus();
    trocarPerfil(proxima.dataset.perfil);
  });

  // Busca e situação são filtros como o período e o perfil: mudam TODOS os números.
  let timerBusca = 0;
  $("[data-busca]").addEventListener("input", (evento) => {
    const valor = evento.target.value;
    window.clearTimeout(timerBusca);
    timerBusca = window.setTimeout(() => {
      if (valor.trim() === state.busca.trim()) {
        state.busca = valor;
        return;
      }
      state.busca = valor;
      escreverUrl();
      // A busca é da aba aberta: na pesquisa recarrega tudo, na de perfis recarrega os perfis.
      aplicarPeriodo();
    }, 400);
  });
  $("[data-busca]").addEventListener("keydown", (evento) => {
    // Enter aplica na hora, sem esperar o debounce.
    if (evento.key !== "Enter") return;
    evento.preventDefault();
    window.clearTimeout(timerBusca);
    const valor = evento.target.value;
    if (valor.trim() === state.busca.trim()) return;
    state.busca = valor;
    escreverUrl();
    aplicarPeriodo();
  });
  $("[data-status]").addEventListener("change", (evento) => {
    state.status = evento.target.value;
    escreverUrl();
    carregarTudo();
  });
  $("[data-filtro-ativo]").addEventListener("click", (evento) => {
    if (!(evento.target instanceof Element) || !evento.target.closest("[data-limpar-filtros]")) return;
    window.clearTimeout(timerBusca);
    state.busca = "";
    state.status = "";
    state.perfil = "";
    $("[data-busca]").value = "";
    escreverUrl();
    carregarTudo();
    $("[data-busca]").focus();
  });

  $("[data-atualizar]").addEventListener("click", () => paginaAtual.atualizar());

  document.addEventListener("click", (evento) => {
    const repetir = evento.target instanceof Element ? evento.target.closest("[data-repetir]") : null;
    if (!repetir) return;
    const acao = repetir.dataset.repetir;
    if (acao === "resumo") carregarResumo();
    else if (acao === "lista") carregarLista({ reiniciar: true });
    else if (acao === "cruzamento") carregarCruzamento();
    else if (acao === "abertas") carregarAbertas({ reiniciar: !state.abertas.itens.length });
    else if (acao === "obrigado") carregarObrigado();
    else if (acao === "inscricoes") carregarInscricoes();
    else if (acao === "perfis") carregarPerfis();
    else if (acao.startsWith("outro:")) carregarOutro(acao.slice(6));
  });

  /* ------------------------------------------------------------ Atualização automática */

  let timerAuto = 0;
  let ultimaAuto = Date.now();

  function iniciarAuto() {
    pararAuto();
    ultimaAuto = Date.now();
    timerAuto = window.setInterval(tickAuto, AUTO_MS);
  }

  function pararAuto() {
    if (timerAuto) window.clearInterval(timerAuto);
    timerAuto = 0;
  }

  function tickAuto() {
    // Só com a aba visível, o painel aberto, a caixa marcada e nada em voo: aba esquecida em
    // segundo plano não fica martelando o banco.
    if (!$("[data-auto]").checked || document.visibilityState !== "visible" || panelView.hidden || emVoo > 0) return;
    ultimaAuto = Date.now();
    paginaAtual.atualizar({ automatico: true });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - ultimaAuto >= AUTO_MS) tickAuto();
  });

  /* ================================================================== */
  /* Páginas de obrigado                                                  */
  /* ================================================================== */

  /*
   * Uma aba para as 3 páginas /obrigado-* (js/obrigado-config.js). Números de
   * /api/painel/paginas (SQL paginas_resumo, no período da barra): pesquisas concluídas
   * atribuídas à página pelo perfil → pessoas que chegaram → pessoas que clicaram no grupo.
   * Nada de dado pessoal aqui: os eventos das páginas não têm nome, WhatsApp nem e-mail.
   */
  const obr = { dados: null, erro: 0, pronto: false, geradoEm: "", diasTodos: new Set() };
  // "Por dia" mostra as duas últimas semanas; o resto abre num clique (período "Tudo" tem meses).
  const DIAS_VISIVEIS = 14;

  function limparObrigado() {
    obr.dados = null;
    obr.erro = 0;
    obr.pronto = false;
    obr.geradoEm = "";
    obr.diasTodos.clear();
    seq.obrigado++;
  }

  async function carregarObrigado() {
    const alvo = $("[data-obrigado]");
    const secao = $("[data-obrigado-secao]");
    const status = $("[data-obrigado-status]");
    if (!OBR) {
      redesenhar(
        alvo,
        `<div class="erro" role="alert"><strong>Não foi possível carregar a configuração das páginas de obrigado.</strong><span>Recarregue a página. Se continuar, confira se o arquivo js/obrigado-config.js foi publicado.</span></div>`
      );
      return;
    }

    const minha = ++seq.obrigado;
    const params = new URLSearchParams();
    const { desde, ate } = intervalo();
    if (desde) params.set("desde", desde);
    if (ate) params.set("ate", ate);

    secao.setAttribute("aria-busy", "true");
    // Esqueleto só na primeira vez; nas recargas o desenho anterior fica esmaecido.
    if (!obr.pronto) redesenhar(alvo, `<div class="obr-lista">${OBR.LISTA.map(() => `<div class="cartao">${esqueleto(7)}</div>`).join("")}</div>`);
    status.textContent = "Carregando...";
    delete status.dataset.estado;
    ocupado(1);
    const resposta = await api(`/api/painel/paginas${params.toString() ? `?${params}` : ""}`);
    ocupado(-1);
    if (minha !== seq.obrigado) return;
    secao.removeAttribute("aria-busy");

    if (resposta.status === 401) {
      sessaoExpirou();
      return;
    }
    if (!resposta.ok || !Array.isArray(resposta.body.paginas)) {
      // Sem dado bom, os números de outro período não podem ficar na tela.
      obr.dados = null;
      obr.erro = resposta.status || 0;
      obr.pronto = false;
      status.dataset.estado = "erro";
      status.textContent = mensagemErro(obr.erro);
      pintarObrigado();
      return;
    }

    obr.dados = resposta.body.paginas;
    obr.erro = 0;
    obr.pronto = true;
    obr.geradoEm = resposta.body.gerado_em || new Date().toISOString();
    status.textContent = "";
    pintarObrigado();
  }

  /** "<b>80%</b> das 100 ..." com a base dita por extenso; sem base, diz por que não há porcentagem. */
  function taxaComBase(parte, base, textoBase, semBase) {
    if (!num(base)) return escapeHtml(semBase);
    return `<strong>${pct(parte, base)}</strong> ${escapeHtml(textoBase.replace("{n}", n(base)))}`;
  }

  function linkDoGrupoHtml(pagina) {
    if (OBR.linkValido(pagina.link)) {
      const curto = String(pagina.link).replace(/^https:\/\//, "");
      return `<p class="obr-grupo"><span>Grupo:</span> <a href="${escapeHtml(pagina.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
        curto
      )}<span class="visualmente-oculto"> (abre o WhatsApp)</span></a></p>`;
    }
    return `<p class="obr-grupo obr-sem-link" data-sem-link><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.5M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span><strong>Link do grupo ainda não configurado.</strong> A página não mostra botão quebrado: avisa que o link chega pelo WhatsApp. Cole o convite em js/obrigado-config.js.</span></p>`;
  }

  function funilObrigadoHtml(pagina, linha) {
    const atribuidas = num(linha.atribuidas);
    const visitantes = num(linha.visitantes);
    const clicaram = num(linha.clicaram);
    const perfis = Array.from(pagina.perfis).map((perfil) => perfilCurto(perfil).toLowerCase()).join(" e ");
    const etapas = [
      {
        chave: "atribuidas",
        rotulo: "Pesquisas concluídas atribuídas",
        sub: `base: quem terminou a pesquisa como ${escapeHtml(perfis)} e foi levado para esta página`,
        valor: atribuidas
      },
      {
        chave: "visitantes",
        rotulo: "Chegaram à página",
        sub: `${taxaComBase(visitantes, atribuidas, "das {n} pesquisas concluídas atribuídas", "sem pesquisa concluída atribuída no período")} · ${escapeHtml(plural(linha.visitas, "visita", "visitas"))} no total`,
        valor: visitantes
      },
      {
        chave: "clicaram",
        rotulo: "Clicaram no grupo",
        sub: `${taxaComBase(clicaram, visitantes, "das {n} pessoas que chegaram", "ninguém chegou à página no período")}${
          atribuidas ? ` · ${pct(clicaram, atribuidas)} das concluídas` : ""
        } · ${escapeHtml(plural(linha.cliques, "clique", "cliques"))} no total`,
        valor: clicaram,
        fim: true
      }
    ];
    const topo = Math.max(1, ...etapas.map((etapa) => etapa.valor));
    const itens = etapas
      .map(
        (etapa) => `<li class="linha-barra${etapa.fim ? " fim" : ""}${etapa.valor ? "" : " zero"}" data-etapa="${etapa.chave}">
          <span class="rotulo">${escapeHtml(etapa.rotulo)}<small>${etapa.sub}</small></span>
          <span class="trilho" role="img" aria-label="${escapeHtml(`${etapa.rotulo}: ${n(etapa.valor)}`)}"><span style="width:${((etapa.valor / topo) * 100).toFixed(2)}%"></span></span>
          <span class="num"><strong>${n(etapa.valor)}</strong></span>
        </li>`
      )
      .join("");
    const notas = [];
    if (visitantes > atribuidas) {
      notas.push(
        "Chegou mais gente do que as pesquisas atribuídas no período: quem abriu o link de novo em outro aparelho, recebeu o link direto ou terminou a pesquisa antes do período escolhido."
      );
    }
    notas.push("Pessoas únicas pelo aparelho: recarregar a página ou clicar duas vezes não conta de novo.");
    return `<ol class="funil obr-funil">${itens}</ol><p class="nota">${notas.map(escapeHtml).join(" ")}</p>`;
  }

  /** Linhas por perfil: os perfis da página primeiro (ordem do config), depois outros e "sem perfil". */
  function linhasPorPerfil(pagina, linha) {
    const dados = Array.isArray(linha.por_perfil) ? linha.por_perfil : [];
    const porPerfil = new Map(dados.map((item) => [item.perfil == null ? null : String(item.perfil), item]));
    const ordem = Array.from(pagina.perfis);
    for (const item of dados) {
      const chave = item.perfil == null ? null : String(item.perfil);
      if (chave !== null && !ordem.includes(chave)) ordem.push(chave);
    }
    if (porPerfil.has(null)) ordem.push(null);
    return ordem.map((perfil) => {
      const item = porPerfil.get(perfil) || {};
      return {
        rotulo: perfil === null ? "Sem perfil (abriu o link direto)" : perfilCurto(perfil),
        daPagina: perfil !== null && pagina.perfis.includes(perfil),
        atribuidas: num(item.atribuidas),
        visitantes: num(item.visitantes),
        clicaram: num(item.clicaram)
      };
    });
  }

  function clicaramCelula(clicaram, visitantes) {
    return `${n(clicaram)}${visitantes ? `<span class="taxa-inline"> · ${pct(clicaram, visitantes)}</span>` : ""}`;
  }

  function divisoesObrigadoHtml(pagina, linha) {
    const perfis = linhasPorPerfil(pagina, linha);
    const tabelaPerfis = `<div class="tabela-rolagem"><table>
      <caption>${
        pagina.perfis.length > 1
          ? `${escapeHtml(Array.from(pagina.perfis).map(perfilCurto).join(" e "))} dividem esta página, mas contam separados.`
          : "Pelo perfil respondido na pesquisa."
      }</caption>
      <thead><tr><th scope="col">Perfil</th><th scope="col" class="n">Concluídas</th><th scope="col" class="n">Chegaram</th><th scope="col" class="n">Clicaram</th></tr></thead>
      <tbody>${perfis
        .map(
          (item) => `<tr${item.daPagina ? "" : ' class="fora-da-pagina"'}><th scope="row">${escapeHtml(item.rotulo)}</th><td class="n">${
            item.daPagina ? n(item.atribuidas) : "—"
          }</td><td class="n">${n(item.visitantes)}</td><td class="n">${clicaramCelula(item.clicaram, item.visitantes)}</td></tr>`
        )
        .join("")}</tbody>
    </table></div>`;

    const origens = (Array.isArray(linha.por_origem) ? linha.por_origem : []).map((item) => ({
      rotulo: String(item.utm_source == null ? "(sem utm)" : item.utm_source),
      visitantes: num(item.visitantes),
      clicaram: num(item.clicaram)
    }));
    const tabelaOrigens = origens.length
      ? `<div class="tabela-rolagem"><table>
      <caption>“(sem utm)” = chegou sem parâmetro de campanha.</caption>
      <thead><tr><th scope="col">Origem</th><th scope="col" class="n">Chegaram</th><th scope="col" class="n">Clicaram</th></tr></thead>
      <tbody>${origens
        .map((item) => `<tr><th scope="row">${escapeHtml(item.rotulo)}</th><td class="n">${n(item.visitantes)}</td><td class="n">${clicaramCelula(item.clicaram, item.visitantes)}</td></tr>`)
        .join("")}</tbody>
    </table></div>`
      : vazioHtml("Sem acessos neste período.", "");

    // Mais recente primeiro: quem abre o painel quer ver hoje e ontem sem rolar.
    const dias = (Array.isArray(linha.por_dia) ? linha.por_dia : [])
      .map((item) => ({ dia: String(item.dia).slice(0, 10), visitantes: num(item.visitantes), clicaram: num(item.clicaram) }))
      .filter((item) => ymdValido(item.dia))
      .sort((a, b) => b.dia.localeCompare(a.dia));
    const todos = obr.diasTodos.has(pagina.id);
    const mostrados = todos ? dias : dias.slice(0, DIAS_VISIVEIS);
    const botaoDias =
      dias.length > DIAS_VISIVEIS
        ? `<button type="button" class="botao-texto obr-mais-dias" data-obr-dias="${escapeHtml(pagina.id)}" data-foco="obr-dias-${escapeHtml(pagina.id)}" aria-expanded="${todos}">${
            todos ? `Mostrar só os ${DIAS_VISIVEIS} mais recentes` : `Ver todos os ${n(dias.length)} dias`
          }</button>`
        : "";
    const tabelaDias = dias.length
      ? `<div class="tabela-rolagem"><table>
      <caption>Horário de Brasília${dias.length > mostrados.length ? ` · os ${DIAS_VISIVEIS} dias mais recentes de ${n(dias.length)}` : ""}.</caption>
      <thead><tr><th scope="col">Dia</th><th scope="col" class="n">Chegaram</th><th scope="col" class="n">Clicaram</th></tr></thead>
      <tbody>${mostrados
        .map(
          (item) => `<tr><th scope="row">${escapeHtml(`${dataCurta(item.dia)} · ${diaSemana(item.dia)}`)}</th><td class="n">${n(item.visitantes)}</td><td class="n">${clicaramCelula(
            item.clicaram,
            item.visitantes
          )}</td></tr>`
        )
        .join("")}</tbody>
    </table></div>${botaoDias}`
      : vazioHtml("Sem acessos neste período.", "");

    return `<div class="obr-divisoes">
      <div class="obr-divisao" data-divisao="perfil"><h4>Por perfil</h4>${tabelaPerfis}</div>
      <div class="obr-divisao" data-divisao="origem"><h4>Por origem</h4>${tabelaOrigens}</div>
      <div class="obr-divisao" data-divisao="dia"><h4>Por dia</h4>${tabelaDias}</div>
    </div>`;
  }

  function cartaoObrigadoHtml(pagina, linha) {
    const perfis = Array.from(pagina.perfis).map((perfil) => perfilCurto(perfil)).join(" · ");
    const vazia = !num(linha.atribuidas) && !num(linha.visitas) && !num(linha.cliques);
    const corpo = vazia
      ? vazioHtml(
          state.periodo === "tudo" ? "Ninguém passou por esta página ainda." : "Ninguém passou por esta página neste período.",
          "Ela recebe quem termina a pesquisa com um destes perfis. Os números aparecem aqui assim que a primeira pessoa chegar."
        )
      : `${funilObrigadoHtml(pagina, linha)}${divisoesObrigadoHtml(pagina, linha)}`;
    return `<article class="cartao obr-cartao" data-obrigado-pagina="${escapeHtml(pagina.id)}" aria-labelledby="obr-${escapeHtml(pagina.id)}">
      <header class="obr-cabeca">
        <div class="obr-titulo">
          <h3 id="obr-${escapeHtml(pagina.id)}">${escapeHtml(pagina.nome)}</h3>
          <p class="obr-meta"><span class="obr-rota">${escapeHtml(pagina.rota)}</span><span class="obr-perfis">${escapeHtml(perfis)}</span></p>
        </div>
        ${linkDoGrupoHtml(pagina)}
      </header>
      ${corpo}
    </article>`;
  }

  $("[data-obrigado]").addEventListener("click", (evento) => {
    const botao = evento.target instanceof Element ? evento.target.closest("[data-obr-dias]") : null;
    if (!botao || !obr.dados) return;
    const id = botao.dataset.obrDias;
    if (obr.diasTodos.has(id)) obr.diasTodos.delete(id);
    else obr.diasTodos.add(id);
    state.focoDepois = `obr-dias-${id}`;
    pintarObrigado();
  });

  function pintarObrigado() {
    const alvo = $("[data-obrigado]");
    $("[data-obrigado-periodo]").textContent = obr.geradoEm && obr.dados ? `${rotuloPeriodo()} · atualizado às ${hora(obr.geradoEm)}` : rotuloPeriodo();
    pintarAtualizado();
    if (!obr.dados) {
      redesenhar(alvo, erroHtml(obr.erro, "obrigado", "repetir-obrigado"));
      return;
    }
    const porId = new Map(obr.dados.filter((linha) => linha && typeof linha === "object").map((linha) => [String(linha.pagina), linha]));
    const linhas = OBR.LISTA.map((pagina) => porId.get(pagina.id) || {});
    const semNada = linhas.every((linha) => !num(linha.atribuidas) && !num(linha.visitas) && !num(linha.cliques));
    const total = linhas.reduce(
      (soma, linha) => ({ atribuidas: soma.atribuidas + num(linha.atribuidas), visitantes: soma.visitantes + num(linha.visitantes), clicaram: soma.clicaram + num(linha.clicaram) }),
      { atribuidas: 0, visitantes: 0, clicaram: 0 }
    );
    const topo = semNada
      ? `<div class="vazio-geral obr-vazio" data-obrigado-vazio>
          <img src="/img/ev-icone-color.png" alt="" width="64" height="64">
          <h3>${state.periodo === "tudo" ? "Ninguém chegou às páginas de obrigado ainda" : "Ninguém chegou às páginas de obrigado neste período"}</h3>
          <p>${
            state.periodo === "tudo"
              ? "Quem terminar a pesquisa é levado para a página do perfil dela, e os números aparecem aqui."
              : "Tente um período maior, ou “Tudo”."
          }</p>
        </div>`
      : `<ul class="placar obr-placar" aria-label="Todas as páginas de obrigado somadas">
          <li><span class="rotulo">Pesquisas concluídas</span><span class="valor">${n(total.atribuidas)}</span><span class="detalhe">levadas a uma das páginas</span></li>
          <li><span class="rotulo">Chegaram às páginas</span><span class="valor">${n(total.visitantes)}</span><span class="detalhe"><strong>${pct(total.visitantes, total.atribuidas)}</strong> das concluídas</span></li>
          <li class="destaque"><span class="rotulo">Clicaram no grupo</span><span class="valor">${n(total.clicaram)}</span><span class="detalhe"><strong>${pct(total.clicaram, total.visitantes)}</strong> de quem chegou</span></li>
        </ul>`;
    redesenhar(alvo, `${topo}<div class="obr-lista">${OBR.LISTA.map((pagina, indice) => cartaoObrigadoHtml(pagina, linhas[indice])).join("")}</div>`);
  }

  /* ================================================================== */
  /* Inscrições com checkout na Hotmart                                   */
  /* ================================================================== */

  /*
   * Uma aba por página de inscrição (js/checkout-config.js), todas no mesmo bloco do HTML e no
   * mesmo estado `ins`. `ins.pagina` diz de QUAL página são os números na memória, e trocar de
   * página limpa tudo antes de pedir a outra: o número de uma nunca aparece na aba da outra, nem
   * por um instante, nem por resposta atrasada (seq.inscricoes).
   *
   * Números de /api/painel/inscricoes?pagina=<id> (SQL inscricoes_resumo, no período da barra), em
   * dois lados que a tela mantém separados, porque respondem perguntas diferentes:
   *
   *   . o do FORMULÁRIO: inscritos → cliques no checkout → compras de inscritos (inscrição que um
   *     aviso da Hotmart casou pelo e-mail ou pelo telefone), com a receita delas, as divisões por
   *     UTM (origem, mídia, campanha, conteúdo, termo) e por dia. Uma dessas UTMs é o `sck` da
   *     página (CHK.sckDaPagina: utm_term na Viver de Furo, utm_content na Imersão GPS) e vem
   *     marcada, porque é o valor que volta no relatório de vendas da Hotmart.
   *   . o da HOTMART: as vendas que ela avisou para o produto da página (vendas, vendas_receita,
   *     vendas_por_sck), inclusive de quem comprou sem passar pelo formulário. É o "de onde veio
   *     cada venda": pelo sck que a Hotmart devolveu, com quantas casaram com uma inscrição.
   *
   * Servidor com o SQL antigo (sem por_midia, por_conteudo, vendas...): o que falta some da tela e
   * o resto funciona igual.
   */
  const ins = { pagina: null, resumo: null, itens: [], total: 0, erro: 0, pronto: false, carregando: false, geradoEm: "", diasTodos: new Set() };
  const LIMITE_INSCRITOS = 50;

  const MOEDA = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

  function dinheiro(valor) {
    return MOEDA.format(num(valor));
  }

  /** A UTM que vira `sck` na página. Config antigo, sem sckDaPagina: utm_term, como era. */
  function sckDe(pagina) {
    return CHK && typeof CHK.sckDaPagina === "function" ? CHK.sckDaPagina(pagina) : "utm_term";
  }

  function limparInscricoes() {
    ins.pagina = null;
    ins.resumo = null;
    ins.itens = [];
    ins.total = 0;
    ins.erro = 0;
    ins.pronto = false;
    ins.carregando = false;
    ins.geradoEm = "";
    ins.diasTodos.clear();
    seq.inscricoes++;
  }

  /**
   * Entrar, atualizar ou mudar o período numa aba de inscrição. Se a memória é de OUTRA página,
   * ela é limpa primeiro (esqueleto em vez do número da outra) e o que estava em voo é descartado.
   */
  function abrirInscricao(pagina) {
    if (ins.pagina !== pagina) {
      limparInscricoes();
      ins.pagina = pagina;
    }
    carregarInscricoes();
  }

  function parametrosInscricoes() {
    const params = new URLSearchParams();
    if (ins.pagina) params.set("pagina", ins.pagina.id);
    const { desde, ate } = intervalo();
    if (desde) params.set("desde", desde);
    if (ate) params.set("ate", ate);
    return params;
  }

  /** O CSV de inscrições sai com a MESMA página e o MESMO período da tela. */
  function atualizarCsvInscricoes() {
    const alvo = $("[data-inscricoes-csv]");
    if (!alvo) return;
    const params = parametrosInscricoes();
    alvo.href = `/api/painel/exportar-inscricoes.csv${params.toString() ? `?${params}` : ""}`;
  }

  async function carregarInscricoes({ mais = false } = {}) {
    const alvo = $("[data-inscricoes]");
    const secao = $("[data-inscricoes-secao]");
    const status = $("[data-inscricoes-status]");
    if (!CHK || !PAGINAS_CHECKOUT.length) {
      redesenhar(
        alvo,
        `<div class="erro" role="alert"><strong>Não foi possível carregar a configuração das páginas de inscrição.</strong><span>Recarregue a página. Se continuar, confira se o arquivo js/checkout-config.js foi publicado.</span></div>`
      );
      return;
    }
    if (!ins.pagina) return;

    const minha = ++seq.inscricoes;
    const params = parametrosInscricoes();
    params.set("limite", String(LIMITE_INSCRITOS));
    params.set("offset", String(mais ? ins.itens.length : 0));
    atualizarCsvInscricoes();

    secao.setAttribute("aria-busy", "true");
    ins.carregando = true;
    // Esqueleto só na primeira vez (de cada página); nas recargas o desenho anterior fica esmaecido.
    if (!ins.pronto) {
      $("[data-inscricoes-periodo]").textContent = rotuloPeriodo();
      redesenhar(alvo, `<div class="ins-lista"><div class="cartao">${esqueleto(7)}</div></div>`);
    }
    status.textContent = "Carregando...";
    delete status.dataset.estado;
    ocupado(1);
    const resposta = await api(`/api/painel/inscricoes?${params}`);
    ocupado(-1);
    if (minha !== seq.inscricoes) return;
    secao.removeAttribute("aria-busy");
    ins.carregando = false;

    if (resposta.status === 401) {
      sessaoExpirou();
      return;
    }
    if (!resposta.ok || !resposta.body.resumo || !Array.isArray(resposta.body.resumo.paginas)) {
      // Sem dado bom, os números de outro período não podem ficar na tela.
      ins.resumo = null;
      ins.itens = [];
      ins.total = 0;
      ins.erro = resposta.status || 0;
      ins.pronto = false;
      status.dataset.estado = "erro";
      status.textContent = mensagemErro(ins.erro);
      pintarInscricoes();
      return;
    }

    const itens = Array.isArray(resposta.body.itens) ? resposta.body.itens : [];
    ins.resumo = resposta.body.resumo;
    ins.itens = mais ? ins.itens.concat(itens) : itens;
    ins.total = num(resposta.body.total);
    ins.erro = 0;
    ins.pronto = true;
    ins.geradoEm = resposta.body.gerado_em || new Date().toISOString();
    status.textContent = "";
    pintarInscricoes();
  }

  /** A linha do resumo da página aberta (página sem nenhum número vira zeros). */
  function linhaDaPagina() {
    const linhas = ins.resumo && Array.isArray(ins.resumo.paginas) ? ins.resumo.paginas : [];
    return linhas.find((linha) => linha && typeof linha === "object" && String(linha.pagina) === ins.pagina.id) || {};
  }

  /**
   * Os números da página, já com os buracos do SQL antigo tapados. `temHotmart` = o banco já conta
   * as vendas do lado da Hotmart (vendas / vendas_por_sck); sem isso, o bloco delas não aparece.
   *
   * "Sem inscrição": com o lado da Hotmart, o compras_sem_inscricao do resumo (pedido com ?pagina=)
   * usa a MESMA régua das vendas (= vendas − casadas) e conta TODAS, e não só as do top 50 da tabela
   * por sck. Número que não cabe nas vendas (resposta fora do contrato) cai na soma da tabela.
   */
  function numerosDaPagina(linha, resumo) {
    const temHotmart = Object.prototype.hasOwnProperty.call(linha, "vendas") || Array.isArray(linha.vendas_por_sck);
    const porSck = (Array.isArray(linha.vendas_por_sck) ? linha.vendas_por_sck : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        sck: item.sck == null || String(item.sck).trim() === "" ? "(sem sck)" : String(item.sck),
        vendas: num(item.vendas),
        receita: num(item.receita),
        casadas: num(item.casadas)
      }));
    const vendas = num(linha.vendas);
    const doBanco = resumo && typeof resumo === "object" ? Number(resumo.compras_sem_inscricao) : NaN;
    const casadas =
      Number.isInteger(doBanco) && doBanco >= 0 && doBanco <= vendas
        ? vendas - doBanco
        : Math.min(vendas, porSck.reduce((soma, item) => soma + item.casadas, 0));
    return {
      inscritos: num(linha.inscritos),
      cliques: num(linha.cliques),
      compras: num(linha.compras),
      receita: num(linha.receita),
      temHotmart,
      vendas,
      vendasReceita: num(linha.vendas_receita),
      porSck,
      vendasCasadas: casadas,
      vendasSemInscricao: vendas - casadas
    };
  }

  function porInscrito(parte, inscritos) {
    return (parte / inscritos).toFixed(1).replace(".", ",");
  }

  function placarInscricaoHtml(t) {
    const itens = [
      `<li data-placar-ins="inscritos"><span class="rotulo">Inscritos</span><span class="valor">${n(t.inscritos)}</span><span class="detalhe">deixaram o contato no formulário</span></li>`,
      `<li data-placar-ins="cliques"><span class="rotulo">Cliques no checkout</span><span class="valor">${n(t.cliques)}</span><span class="detalhe">${escapeHtml(
        t.inscritos ? `${porInscrito(t.cliques, t.inscritos)} por inscrito` : "sem inscrito no período"
      )}</span></li>`,
      `<li class="destaque" data-placar-ins="compras"><span class="rotulo">Compras de inscritos</span><span class="valor">${n(t.compras)}</span><span class="detalhe">${
        t.inscritos ? `<strong>${pct(t.compras, t.inscritos)}</strong> dos ${n(t.inscritos)} inscritos` : "sem inscrito no período"
      } · ${escapeHtml(dinheiro(t.receita))}</span></li>`
    ];
    if (t.temHotmart) {
      const detalhe = !t.vendas
        ? "nenhuma venda avisada no período"
        : `${dinheiro(t.vendasReceita)} · ${t.vendasSemInscricao ? `${n(t.vendasSemInscricao)} sem inscrição` : "todas com inscrição"}`;
      itens.push(
        `<li data-placar-ins="vendas"><span class="rotulo">Vendas na Hotmart</span><span class="valor">${n(t.vendas)}</span><span class="detalhe">${escapeHtml(detalhe)}</span></li>`
      );
    } else {
      // SQL antigo: sem o lado da Hotmart, o quarto número volta a ser a receita das compras.
      itens.push(
        `<li data-placar-ins="receita"><span class="rotulo">Receita</span><span class="valor">${escapeHtml(dinheiro(t.receita))}</span><span class="detalhe">${escapeHtml(
          t.compras ? `${dinheiro(t.receita / t.compras)} por compra` : "nenhuma compra ainda"
        )}</span></li>`
      );
    }
    return `<ul class="placar ins-placar" aria-label="Números da página no período">${itens.join("")}</ul>`;
  }

  function funilInscricaoHtml(t) {
    const etapas = [
      {
        chave: "inscritos",
        rotulo: "Inscritos",
        sub: "base: quem deixou nome, WhatsApp e e-mail no formulário",
        valor: t.inscritos
      },
      {
        chave: "cliques",
        rotulo: "Cliques no checkout",
        sub: `${escapeHtml(plural(t.cliques, "abertura", "aberturas"))} da página de pagamento · quem envia o formulário de novo soma aqui, sem virar inscrito novo`,
        valor: t.cliques
      },
      {
        chave: "compras",
        rotulo: "Compras de inscritos",
        sub: `${taxaComBase(t.compras, t.inscritos, "dos {n} inscritos", "sem inscrito no período")} · casadas com o aviso da Hotmart`,
        valor: t.compras,
        fim: true
      }
    ];
    const topo = Math.max(1, ...etapas.map((etapa) => etapa.valor));
    const itens = etapas
      .map(
        (etapa) => `<li class="linha-barra${etapa.fim ? " fim" : ""}${etapa.valor ? "" : " zero"}" data-etapa="${etapa.chave}">
          <span class="rotulo">${escapeHtml(etapa.rotulo)}<small>${etapa.sub}</small></span>
          <span class="trilho" role="img" aria-label="${escapeHtml(`${etapa.rotulo}: ${n(etapa.valor)}`)}"><span style="width:${((etapa.valor / topo) * 100).toFixed(2)}%"></span></span>
          <span class="num"><strong>${n(etapa.valor)}</strong></span>
        </li>`
      )
      .join("");
    return `<ol class="funil ins-funil">${itens}</ol><p class="nota">Um inscrito é uma pessoa por página (WhatsApp e e-mail): voltar e enviar de novo soma clique, não inscrito. A compra é casada pelo e-mail ou pelos últimos 8 dígitos do telefone que a pessoa digitou na Hotmart, e conta quem se inscreveu no período, tenha comprado quando for.</p>`;
  }

  /**
   * O lado da Hotmart: "de onde veio cada venda", pelo sck que ela devolveu. Conta também quem
   * comprou sem passar pelo formulário, por isso é MAIOR ou igual às compras de inscritos.
   */
  function hotmartHtml(pagina, t) {
    const id = escapeHtml(pagina.id);
    const sck = sckDe(pagina);
    const tabela = t.porSck.length
      ? `<div class="tabela-rolagem"><table>
          <caption>O sck é o ${escapeHtml(sck)} que a página mandou para o checkout; “(sem sck)” = venda que chegou sem ele (link direto da Hotmart, por exemplo). “Com inscrição” = casadas com alguém do formulário.</caption>
          <thead><tr><th scope="col">sck</th><th scope="col" class="n">Vendas</th><th scope="col" class="n">Receita</th><th scope="col" class="n">Com inscrição</th></tr></thead>
          <tbody>${t.porSck
            .map(
              (item) => `<tr${item.sck === "(sem sck)" ? ' class="ins-sem-sck"' : ""}><th scope="row">${escapeHtml(item.sck)}</th><td class="n">${n(item.vendas)}</td><td class="n">${escapeHtml(
                dinheiro(item.receita)
              )}</td><td class="n">${n(item.casadas)}</td></tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : vazioHtml(
          state.periodo === "tudo" ? "Nenhuma venda avisada pela Hotmart ainda." : "Nenhuma venda avisada pela Hotmart neste período.",
          "As vendas chegam pelo aviso da Hotmart no endereço /api/hotmart/venda assim que alguém paga."
        );
    const casadas = t.vendas
      ? `<p class="ins-hotmart-casadas" data-vendas-casadas><strong>${n(t.vendasCasadas)}</strong> ${
          t.vendasCasadas === 1 ? "casada" : "casadas"
        } com inscrição · <strong>${n(t.vendasSemInscricao)}</strong> sem inscrição</p>`
      : "";
    return `<section class="ins-hotmart" data-ins-hotmart aria-labelledby="ins-hotmart-${id}">
      <div class="ins-hotmart-cabeca">
        <h4 id="ins-hotmart-${id}">Vendas na Hotmart<span>de onde veio cada venda</span></h4>
        <p class="ins-hotmart-total"><strong data-vendas>${n(t.vendas)}</strong> ${t.vendas === 1 ? "venda" : "vendas"} · <strong data-vendas-receita>${escapeHtml(
          dinheiro(t.vendasReceita)
        )}</strong></p>
      </div>
      <p class="ins-hotmart-texto">Toda venda que a Hotmart avisou para o produto desta página, contada no dia em que foi aprovada, inclusive de quem comprou sem passar pelo formulário (link direto, outro e-mail e outro telefone). Reembolso, cancelamento e chargeback até o fim do período saem da conta. As “compras de inscritos” do funil são só as que casaram com alguém do formulário.</p>
      ${casadas}${tabela}
    </section>`;
  }

  // As divisões por UTM dos inscritos. `lista` é o campo do resumo; a que é o sck da página ganha
  // "(sck)" no título e a legenda do relatório da Hotmart.
  const DIVISOES_INSCRICAO = [
    { chave: "origem", campo: "utm_source", lista: "por_origem", titulo: "Origem", legenda: "utm_source do anúncio. “(sem utm)” = chegou sem parâmetro de campanha." },
    { chave: "midia", campo: "utm_medium", lista: "por_midia", titulo: "Mídia", legenda: "utm_medium: o tipo de tráfego (pago, stories, bio, lista)." },
    { chave: "campanha", campo: "utm_campaign", lista: "por_campanha", titulo: "Campanha", legenda: "utm_campaign do anúncio." },
    { chave: "conteudo", campo: "utm_content", lista: "por_conteudo", titulo: "Conteúdo", legenda: "utm_content: o criativo do anúncio." },
    { chave: "termo", campo: "utm_term", lista: "por_termo", titulo: "Termo", legenda: "utm_term: o público ou a palavra-chave." }
  ];

  function tabelaDivisaoHtml(titulo, chave, itens, legenda) {
    const linhas = (Array.isArray(itens) ? itens : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({
        rotulo: String(item[chave] == null || item[chave] === "" ? "(sem utm)" : item[chave]),
        inscritos: num(item.inscritos),
        compras: num(item.compras)
      }));
    return linhas.length
      ? `<div class="tabela-rolagem"><table>
          <caption>${escapeHtml(legenda)}</caption>
          <thead><tr><th scope="col">${escapeHtml(titulo)}</th><th scope="col" class="n">Inscritos</th><th scope="col" class="n">Compras</th></tr></thead>
          <tbody>${linhas
            .map(
              (item) => `<tr><th scope="row">${escapeHtml(item.rotulo)}</th><td class="n">${n(item.inscritos)}</td><td class="n">${n(item.compras)}${
                item.inscritos ? `<span class="taxa-inline"> · ${pct(item.compras, item.inscritos)}</span>` : ""
              }</td></tr>`
            )
            .join("")}</tbody>
        </table></div>`
      : vazioHtml("Sem inscrição neste período.", "");
  }

  function tabelaDiasHtml(pagina, linha) {
    // Mais recente primeiro: quem abre o painel quer ver hoje e ontem sem rolar.
    const dias = (Array.isArray(linha.por_dia) ? linha.por_dia : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({ dia: String(item.dia).slice(0, 10), inscritos: num(item.inscritos), compras: num(item.compras) }))
      .filter((item) => ymdValido(item.dia))
      .sort((a, b) => b.dia.localeCompare(a.dia));
    if (!dias.length) return vazioHtml("Sem inscrição neste período.", "");
    const todos = ins.diasTodos.has(pagina.id);
    const mostrados = todos ? dias : dias.slice(0, DIAS_VISIVEIS);
    const botao =
      dias.length > DIAS_VISIVEIS
        ? `<button type="button" class="botao-texto ins-mais-dias" data-ins-dias="${escapeHtml(pagina.id)}" data-foco="ins-dias-${escapeHtml(pagina.id)}" aria-expanded="${todos}">${
            todos ? `Mostrar só os ${DIAS_VISIVEIS} mais recentes` : `Ver todos os ${n(dias.length)} dias`
          }</button>`
        : "";
    return `<div class="tabela-rolagem"><table>
      <caption>Horário de Brasília${dias.length > mostrados.length ? ` · os ${DIAS_VISIVEIS} dias mais recentes de ${n(dias.length)}` : ""}. Inscritos pelo dia do cadastro, compras pelo dia da compra.</caption>
      <thead><tr><th scope="col">Dia</th><th scope="col" class="n">Inscritos</th><th scope="col" class="n">Compras</th></tr></thead>
      <tbody>${mostrados
        .map(
          (item) => `<tr><th scope="row">${escapeHtml(`${dataCurta(item.dia)} · ${diaSemana(item.dia)}`)}</th><td class="n">${n(item.inscritos)}</td><td class="n">${n(
            item.compras
          )}</td></tr>`
        )
        .join("")}</tbody>
    </table></div>${botao}`;
  }

  function divisoesInscricaoHtml(pagina, linha) {
    const sck = sckDe(pagina);
    // SQL antigo não manda por_midia nem por_conteudo: a divisão que não veio simplesmente não aparece.
    const divisoes = DIVISOES_INSCRICAO.filter((divisao) => Array.isArray(linha[divisao.lista]))
      .map((divisao) => {
        const ehSck = divisao.campo === sck;
        const legenda = ehSck ? `O ${divisao.campo} vai para a Hotmart como sck: é o criativo que aparece no relatório de vendas de lá.` : divisao.legenda;
        return `<div class="ins-divisao${ehSck ? " ins-divisao-sck" : ""}" data-divisao="${divisao.chave}"${ehSck ? " data-sck" : ""}><h5>Por ${escapeHtml(
          divisao.titulo.toLowerCase()
        )}${ehSck ? ' <span class="marca-sck">(sck)</span>' : ""}</h5>${tabelaDivisaoHtml(divisao.titulo, divisao.campo, linha[divisao.lista], legenda)}</div>`;
      })
      .join("");
    return `<section class="ins-bloco" aria-labelledby="ins-divisoes-${escapeHtml(pagina.id)}">
      <div class="ins-bloco-cabeca">
        <h4 id="ins-divisoes-${escapeHtml(pagina.id)}">Inscritos por UTM e por dia</h4>
        <p>De onde vieram as pessoas do formulário e quantas delas compraram. Só quem se inscreveu tem UTM completa; a venda sem inscrição aparece acima, pelo sck.</p>
      </div>
      <div class="ins-divisoes">
        ${divisoes}
        <div class="ins-divisao" data-divisao="dia"><h5>Por dia</h5>${tabelaDiasHtml(pagina, linha)}</div>
      </div>
    </section>`;
  }

  function cartaoInscricaoHtml(pagina, linha, t) {
    const id = escapeHtml(pagina.id);
    const sck = sckDe(pagina);
    const vazia = !t.inscritos && !t.cliques && !(t.temHotmart && t.vendas);
    const corpo = vazia
      ? vazioHtml(
          state.periodo === "tudo" ? "Ninguém se inscreveu nesta página ainda." : "Ninguém se inscreveu nesta página neste período.",
          "Assim que a primeira pessoa enviar o formulário, os números aparecem aqui."
        )
      : `${funilInscricaoHtml(t)}${t.temHotmart ? hotmartHtml(pagina, t) : ""}${divisoesInscricaoHtml(pagina, linha)}`;
    return `<article class="cartao ins-cartao" data-inscricao-pagina="${id}" aria-labelledby="ins-${id}">
      <header class="ins-cabeca">
        <div class="ins-titulo">
          <h3 id="ins-${id}">${escapeHtml(pagina.nome)}</h3>
          <p class="ins-meta"><span class="ins-rota" title="${escapeHtml(rotaDaInscricao(pagina))}">${rotaHtml(hostDaInscricao(pagina), pagina.rota)}</span><span class="ins-produto">${escapeHtml(
            pagina.produto || ""
          )}</span><span class="ins-sck-da-pagina" data-sck-da-pagina="${escapeHtml(sck)}">sck = ${escapeHtml(sck)}</span></p>
        </div>
      </header>
      ${corpo}
    </article>`;
  }

  const EVENTOS_COMPRA = {
    PURCHASE_APPROVED: "Compra aprovada",
    PURCHASE_COMPLETE: "Compra concluída",
    PURCHASE_CANCELED: "Cancelada",
    PURCHASE_REFUNDED: "Reembolsada",
    PURCHASE_CHARGEBACK: "Chargeback",
    PURCHASE_PROTEST: "Em disputa",
    PURCHASE_BILLET_PRINTED: "Boleto gerado",
    PURCHASE_OUT_OF_SHOPPING_CART: "Abandonou o checkout",
    PURCHASE_DELAYED: "Pagamento atrasado",
    PURCHASE_EXPIRED: "Pagamento expirado"
  };

  function rotuloEvento(evento) {
    const chave = String(evento || "");
    return Object.prototype.hasOwnProperty.call(EVENTOS_COMPRA, chave) ? EVENTOS_COMPRA[chave] : chave || "—";
  }

  function comprasRecentesHtml(t) {
    const compras = (Array.isArray(ins.resumo?.compras_recentes) ? ins.resumo.compras_recentes : []).filter((compra) => compra && typeof compra === "object");
    // Com o lado da Hotmart, o aviso usa o MESMO número do placar (vendas que valem e não casaram:
    // a que virou reembolso ou chargeback já saiu). SQL antigo: a contagem de compras aprovadas.
    const semInscricao = t.temHotmart ? t.vendasSemInscricao : num(ins.resumo?.compras_sem_inscricao);
    const frase = t.temHotmart
      ? plural(semInscricao, "venda da Hotmart não casou", "vendas da Hotmart não casaram")
      : plural(semInscricao, "compra aprovada não casou", "compras aprovadas não casaram");
    const aviso = semInscricao
      ? `<p class="ins-aviso" data-ins-aviso><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M12 8v5m0 3.5v.5M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg><span><strong>${escapeHtml(
          frase
        )} com nenhuma inscrição.</strong> Ou a pessoa comprou por outro link, ou digitou na Hotmart um e-mail e um telefone diferentes dos do formulário. O aviso inteiro está guardado no banco.</span></p>`
      : "";
    const corpo = compras.length
      ? `<div class="tabela-rolagem"><table>
          <caption>Os 20 avisos mais recentes da Hotmart no período.</caption>
          <thead><tr><th scope="col">Quando</th><th scope="col">Quem</th><th scope="col" class="n">Valor</th><th scope="col">Casou</th></tr></thead>
          <tbody>${compras
            .map((compra) => {
              const casou = compra.casou === true;
              // O evento vai embaixo da data e o sck embaixo do nome: numa tela de 390px seis
              // colunas não cabem, e o que importa (quando, quem, quanto, casou) continua inteiro.
              // SQL antigo não manda o sck: aí a linha fica sem ele.
              const temSck = Object.prototype.hasOwnProperty.call(compra, "sck");
              const sck = temSck
                ? `<small class="ins-sck" data-sck-aviso>${compra.sck == null || String(compra.sck).trim() === "" ? "sem sck" : `sck ${escapeHtml(compra.sck)}`}</small>`
                : "";
              return `<tr${casou ? "" : ' class="ins-orfa"'}>
                <th scope="row">${escapeHtml(dataHora(compra.recebido_em))}<small>${escapeHtml(rotuloEvento(compra.evento))}</small></th>
                <td>${escapeHtml(compra.comprador_nome || compra.comprador_email || "—")}${sck}</td>
                <td class="n">${compra.valor == null ? "—" : escapeHtml(dinheiro(compra.valor))}</td>
                <td>${
                  // No celular o selo encurta para sim/não (a coluna já se chama "Casou"): com um
                  // "Reembolsada" na primeira coluna, "com inscrição" não cabia em 390px.
                  casou
                    ? '<span class="selo ok"><span class="so-largo">com inscrição</span><span class="so-estreito">sim</span></span>'
                    : '<span class="selo meio" title="Nenhuma inscrição com este e-mail nem com estes últimos 8 dígitos de telefone"><span class="so-largo">sem inscrição</span><span class="so-estreito">não</span></span>'
                }</td>
              </tr>`;
            })
            .join("")}</tbody>
        </table></div>`
      : vazioHtml(
          state.periodo === "tudo" ? "Nenhum aviso de venda recebido ainda." : "Nenhum aviso de venda neste período.",
          "Os avisos chegam da Hotmart no endereço /api/hotmart/venda assim que alguém paga."
        );
    return `<article class="cartao ins-compras" aria-labelledby="ins-compras-titulo">
      <div class="cartao-cabeca">
        <h3 id="ins-compras-titulo">Compras recentes</h3>
        <p class="cartao-sub">Cada aviso da Hotmart para o produto desta página (aprovada, boleto, reembolso, abandono), com o sck que ela devolveu. Só compra aprovada marca o inscrito como comprador.</p>
      </div>
      ${aviso}${corpo}
    </article>`;
  }

  function inscritoHtml(item, sck) {
    const link = whatsappLink(item.whatsapp_digits);
    const telefone = item.whatsapp
      ? link
        ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>${escapeHtml(
            item.whatsapp
          )}<span class="visualmente-oculto"> (abre o WhatsApp)</span></a>`
        : `<span>${escapeHtml(item.whatsapp)}</span>`
      : "<span>sem WhatsApp</span>";
    const comprou = Boolean(item.comprou_em);
    const selo = comprou
      ? `<span class="selo ok"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>${escapeHtml(
          `Comprou · ${dataHora(item.comprou_em)}`
        )}</span>${item.compra_valor == null ? "" : `<span class="selo rep">${escapeHtml(dinheiro(item.compra_valor))}</span>`}`
      : `<span class="selo meio"${item.compra_status ? ` title="${escapeHtml(`Último aviso da Hotmart: ${item.compra_status}`)}"` : ""}>Não comprou${
          item.compra_status ? ` · ${escapeHtml(String(item.compra_status).toLowerCase())}` : ""
        }</span>`;
    const cliques = num(item.cliques);
    // O valor que foi para a Hotmart como sck (a UTM da página): é o que o relatório de lá mostra.
    const valorSck = typeof item[sck] === "string" && item[sck].trim() ? item[sck].trim() : "";
    return `<article class="pessoa ins-pessoa" data-inscrito="${escapeHtml(item.id)}">
      <div class="pessoa-cabeca">
        <div class="pessoa-quem">
          <span class="pessoa-nome">${escapeHtml(item.nome || "Sem nome")}</span>
          <span class="pessoa-meta">${escapeHtml(`${dataHora(item.criado_em)} · ${plural(cliques, "clique no checkout", "cliques no checkout")}`)}</span>
        </div>
        <div class="pessoa-contato">${telefone}<span>${escapeHtml(item.email || "sem e-mail")}</span></div>
        <div class="pessoa-selos">${selo}</div>
        <div class="pessoa-acoes">
          <span class="pessoa-origem">${escapeHtml(origemTexto(item))}${valorSck ? ` · <span class="ins-sck-valor" title="${escapeHtml(`${sck}, que foi para a Hotmart como sck`)}">sck ${escapeHtml(valorSck)}</span>` : ""}</span>
        </div>
      </div>
    </article>`;
  }

  function listaInscritosHtml(pagina) {
    const sck = sckDe(pagina);
    const corpo = ins.itens.length
      ? `${ins.itens.map((item) => inscritoHtml(item, sck)).join("")}${
          ins.itens.length < ins.total
            ? `<button type="button" class="botao botao-leve ins-mais" data-ins-mais data-foco="ins-mais"${ins.carregando ? " disabled" : ""}>${
                ins.carregando ? "Carregando..." : `Carregar mais ${n(Math.min(LIMITE_INSCRITOS, ins.total - ins.itens.length))}`
              }</button>`
            : ""
        }`
      : vazioHtml(
          state.periodo === "tudo" ? "Nenhuma inscrição ainda." : "Nenhuma inscrição neste período.",
          "Cada pessoa que envia o formulário aparece aqui, com o WhatsApp pronto para conversar."
        );
    return `<article class="cartao ins-pessoas" aria-labelledby="ins-pessoas-titulo">
      <div class="cartao-cabeca">
        <h3 id="ins-pessoas-titulo">Inscritos</h3>
        <p class="cartao-sub" data-ins-contador>Mostrando <strong>${n(ins.itens.length)}</strong> de <strong>${n(ins.total)}</strong> ${
          ins.total === 1 ? "pessoa" : "pessoas"
        }, das mais recentes para as mais antigas.</p>
      </div>
      <div class="ins-pessoas-lista">${corpo}</div>
    </article>`;
  }

  function pintarInscricoes() {
    const alvo = $("[data-inscricoes]");
    $("[data-inscricoes-periodo]").textContent =
      ins.geradoEm && ins.resumo ? `${rotuloPeriodo()} · atualizado às ${hora(ins.geradoEm)}` : rotuloPeriodo();
    pintarAtualizado();
    if (!ins.resumo || !ins.pagina) {
      redesenhar(alvo, erroHtml(ins.erro, "inscricoes", "repetir-inscricoes"));
      return;
    }

    const pagina = ins.pagina;
    const linha = linhaDaPagina();
    const t = numerosDaPagina(linha, ins.resumo);
    const semNada = !t.inscritos && !t.cliques && !(t.temHotmart && t.vendas);
    const topo = semNada
      ? `<div class="vazio-geral ins-vazio" data-inscricoes-vazio>
          <img src="/img/ev-icone-color.png" alt="" width="64" height="64">
          <h3>${state.periodo === "tudo" ? "Ninguém se inscreveu ainda" : "Ninguém se inscreveu neste período"}</h3>
          <p>${
            state.periodo === "tudo"
              ? "Quem enviar o formulário da página de inscrição aparece aqui, com o clique no checkout e a compra."
              : "Tente um período maior, ou “Tudo”."
          }</p>
        </div>`
      : placarInscricaoHtml(t);

    redesenhar(alvo, `${topo}<div class="ins-lista">${cartaoInscricaoHtml(pagina, linha, t)}</div>${comprasRecentesHtml(t)}${listaInscritosHtml(pagina)}`);
  }

  $("[data-inscricoes]").addEventListener("click", (evento) => {
    const alvo = evento.target instanceof Element ? evento.target : null;
    if (!alvo) return;
    const dias = alvo.closest("[data-ins-dias]");
    if (dias && ins.resumo) {
      const id = dias.dataset.insDias;
      if (ins.diasTodos.has(id)) ins.diasTodos.delete(id);
      else ins.diasTodos.add(id);
      state.focoDepois = `ins-dias-${id}`;
      pintarInscricoes();
      return;
    }
    if (alvo.closest("[data-ins-mais]") && !ins.carregando) {
      state.focoDepois = "ins-mais";
      carregarInscricoes({ mais: true });
    }
  });

  /* ================================================================== */
  /* Perfis atualizados (/atualizacao-perfil)                             */
  /* ================================================================== */

  // A página curta do WhatsApp: contato e profissão, nada mais. Mora na MESMA tabela da pesquisa
  // (coluna `pesquisa`), e por isso tem aba própria em vez de se misturar com o ICP.
  const LIMITE_PERFIS = 100;
  const perf = {
    itens: [],
    total: 0,
    respondentes: 0,
    porPerfil: [],
    perfil: "", // o valor cheio do perfil ("Cuidador(a)"), como está no banco; "" = todas
    erro: 0,
    pronto: false,
    carregando: false,
    geradoEm: ""
  };

  function limparPerfis() {
    perf.itens = [];
    perf.total = 0;
    perf.respondentes = 0;
    perf.porPerfil = [];
    perf.erro = 0;
    perf.pronto = false;
    perf.carregando = false;
    perf.geradoEm = "";
    seq.perfis++;
  }

  function parametrosPerfis() {
    const params = new URLSearchParams();
    const { desde, ate } = intervalo();
    if (desde) params.set("desde", desde);
    if (ate) params.set("ate", ate);
    const busca = state.busca.trim();
    if (busca) params.set("busca", busca);
    if (perf.perfil) params.set("perfil", perf.perfil);
    return params;
  }

  /** As abas de profissão do bloco: "Todas" e uma por profissão, cada uma com o seu número. */
  function abasPerfilHtml() {
    const abas = [{ valor: "", curto: "Todas", total: perf.respondentes }].concat(
      perf.porPerfil.map((item) => ({
        valor: item.perfil,
        curto: EV.PERFIL_CURTO[item.perfil] || item.perfil,
        total: num(item.total)
      }))
    );
    return `<div class="perfis" role="tablist" aria-label="Profissão" data-perfis-abas>${abas
      .map((aba) => {
        const ativo = aba.valor === perf.perfil;
        return `<button type="button" class="perfil-aba" role="tab" aria-selected="${ativo}" tabindex="${ativo ? 0 : -1}" data-perfil-aba="${escapeHtml(
          aba.valor
        )}" data-foco="perfil-aba-${escapeHtml(aba.valor || "todas")}">${escapeHtml(aba.curto)}<span class="n" aria-label="${escapeHtml(
          plural(aba.total, "pessoa", "pessoas")
        )}">${n(aba.total)}</span></button>`;
      })
      .join("")}</div>`;
  }

  function placarPerfisHtml() {
    const total = perf.respondentes;
    const maior = perf.porPerfil.reduce((melhor, item) => (num(item.total) > num(melhor.total) ? item : melhor), { total: 0, perfil: "" });
    const itens = [
      `<li class="destaque"><span class="rotulo">Perfis atualizados</span><span class="valor">${n(total)}</span><span class="detalhe">${escapeHtml(
        state.busca.trim() ? "pessoas encontradas na busca" : "pessoas que disseram quem são"
      )}</span></li>`,
      `<li><span class="rotulo">Profissão mais comum</span><span class="valor">${escapeHtml(
        total && maior.perfil ? EV.PERFIL_CURTO[maior.perfil] || maior.perfil : "—"
      )}</span><span class="detalhe">${escapeHtml(total && maior.perfil ? `${pct(num(maior.total), total)} de ${n(total)}` : "ninguém ainda")}</span></li>`
    ];
    return `<ul class="placar ins-placar" aria-label="Números dos perfis no período">${itens.join("")}</ul>`;
  }

  function perfilPessoaHtml(item) {
    const link = whatsappLink(item.whatsapp_digits);
    const telefone = item.whatsapp
      ? link
        ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>${escapeHtml(
            item.whatsapp
          )}<span class="visualmente-oculto"> (abre o WhatsApp)</span></a>`
        : `<span>${escapeHtml(item.whatsapp)}</span>`
      : "<span>sem WhatsApp</span>";
    // O código interno é o que vai para o UnniChat e para o CRM: mostrar os dois evita conferência
    // no banco quando alguém desconfia do que a automação recebeu.
    const codigo = EV.PERFIL_CODIGO[item.perfil] || "";
    const profissao = item.perfil
      ? `<span class="selo rep" title="${escapeHtml(codigo ? `Vai para o UnniChat como ${codigo}` : item.perfil)}">${escapeHtml(item.perfil)}</span>`
      : `<span class="selo meio">Sem profissão</span>`;
    // O aviso que inicia a sequência no WhatsApp. Só aparece quando ainda NÃO saiu: o normal é
    // sair em segundos, então um selo em cada linha seria ruído.
    const aviso = item.webhook_enviado_em
      ? ""
      : `<span class="selo meio" title="O aviso que inicia a sequência no WhatsApp ainda não foi entregue. O servidor tenta de novo sozinho, de 10 em 10 minutos, por até 7 dias.">Aviso pendente</span>`;
    return `<article class="pessoa" data-perfil-pessoa="${escapeHtml(item.id)}">
      <div class="pessoa-cabeca">
        <div class="pessoa-quem">
          <span class="pessoa-nome">${escapeHtml(item.nome || "Sem nome")}</span>
          <span class="pessoa-meta">${escapeHtml(dataHora(item.criado_em))}</span>
        </div>
        <div class="pessoa-contato">${telefone}<span>${escapeHtml(item.email || "sem e-mail")}</span></div>
        <div class="pessoa-selos">${profissao}${aviso}</div>
        <div class="pessoa-acoes"><span class="pessoa-origem">${escapeHtml(origemTexto(item))}</span></div>
      </div>
    </article>`;
  }

  function listaPerfisHtml() {
    const corpo = perf.itens.length
      ? `${perf.itens.map(perfilPessoaHtml).join("")}${
          perf.itens.length < perf.total
            ? `<button type="button" class="botao botao-leve ins-mais" data-perfis-mais data-foco="perfis-mais"${perf.carregando ? " disabled" : ""}>${
                perf.carregando ? "Carregando..." : `Carregar mais ${n(Math.min(LIMITE_PERFIS, perf.total - perf.itens.length))}`
              }</button>`
            : ""
        }`
      : vazioHtml(
          state.busca.trim()
            ? "Ninguém encontrado com essa busca."
            : state.periodo === "tudo"
              ? "Ninguém atualizou o perfil ainda."
              : "Ninguém atualizou o perfil neste período.",
          "Cada pessoa que termina a página /atualizacao-perfil aparece aqui, com o WhatsApp pronto para conversar."
        );
    return `<article class="cartao ins-pessoas" aria-labelledby="perfis-pessoas-titulo">
      <div class="cartao-cabeca">
        <h3 id="perfis-pessoas-titulo">Quem atualizou</h3>
        <p class="cartao-sub">Mostrando <strong>${n(perf.itens.length)}</strong> de <strong>${n(perf.total)}</strong> ${
          perf.total === 1 ? "pessoa" : "pessoas"
        }, das mais recentes para as mais antigas.</p>
      </div>
      <div class="ins-pessoas-lista">${corpo}</div>
    </article>`;
  }

  function pintarPerfis() {
    const alvo = $("[data-perfis-corpo]");
    $("[data-perfis-periodo]").textContent = perf.geradoEm && perf.pronto ? `${rotuloPeriodo()} · atualizado às ${hora(perf.geradoEm)}` : rotuloPeriodo();
    pintarAtualizado();
    if (!perf.pronto) {
      redesenhar(alvo, erroHtml(perf.erro, "perfis", "repetir-perfis"));
      return;
    }
    redesenhar(alvo, `${placarPerfisHtml()}${abasPerfilHtml()}${listaPerfisHtml()}`);
  }

  async function carregarPerfis({ mais = false } = {}) {
    const alvo = $("[data-perfis-corpo]");
    const secao = $("[data-perfis-secao]");
    const status = $("[data-perfis-status]");

    const minha = ++seq.perfis;
    const params = parametrosPerfis();
    params.set("limite", String(LIMITE_PERFIS));
    params.set("offset", String(mais ? perf.itens.length : 0));

    secao.setAttribute("aria-busy", "true");
    perf.carregando = true;
    // Esqueleto só na primeira vez; nas recargas o desenho anterior fica esmaecido.
    if (!perf.pronto) {
      $("[data-perfis-periodo]").textContent = rotuloPeriodo();
      redesenhar(alvo, `<div class="ins-lista"><div class="cartao">${esqueleto(6)}</div></div>`);
    }
    status.textContent = "Carregando...";
    delete status.dataset.estado;
    ocupado(1);
    const resposta = await api(`/api/painel/perfis?${params}`);
    ocupado(-1);
    if (minha !== seq.perfis) return;
    secao.removeAttribute("aria-busy");
    perf.carregando = false;

    if (resposta.status === 401) {
      sessaoExpirou();
      return;
    }
    if (!resposta.ok || !Array.isArray(resposta.body.itens)) {
      // Sem dado bom, o número de outro recorte não pode ficar na tela.
      perf.itens = [];
      perf.total = 0;
      perf.respondentes = 0;
      perf.porPerfil = [];
      perf.erro = resposta.status || 0;
      perf.pronto = false;
      status.dataset.estado = "erro";
      status.textContent = mensagemErro(perf.erro);
      pintarPerfis();
      return;
    }

    const itens = resposta.body.itens;
    perf.itens = mais ? perf.itens.concat(itens) : itens;
    perf.total = num(resposta.body.total);
    perf.respondentes = num(resposta.body.respondentes);
    perf.porPerfil = Array.isArray(resposta.body.por_perfil) ? resposta.body.por_perfil : [];
    perf.erro = 0;
    perf.pronto = true;
    perf.geradoEm = resposta.body.gerado_em || "";
    status.textContent = "";
    pintarPerfis();
  }

  function trocarPerfilAba(valor) {
    if (valor === perf.perfil) return;
    perf.perfil = valor;
    perf.itens = [];
    perf.total = 0;
    carregarPerfis();
  }

  $("[data-perfis-corpo]").addEventListener("click", (evento) => {
    const alvo = evento.target instanceof Element ? evento.target : null;
    if (!alvo) return;
    const aba = alvo.closest("[data-perfil-aba]");
    if (aba) {
      state.focoDepois = `perfil-aba-${aba.dataset.perfilAba || "todas"}`;
      trocarPerfilAba(aba.dataset.perfilAba || "");
      return;
    }
    if (alvo.closest("[data-perfis-mais]") && !perf.carregando) {
      state.focoDepois = "perfis-mais";
      carregarPerfis({ mais: true });
    }
  });

  $("[data-perfis-corpo]").addEventListener("keydown", (evento) => {
    const passo = evento.key === "ArrowRight" ? 1 : evento.key === "ArrowLeft" ? -1 : 0;
    if (!passo) return;
    const abas = $$("[data-perfil-aba]");
    const atual = abas.indexOf(document.activeElement);
    if (atual < 0) return;
    evento.preventDefault();
    const proxima = abas[(atual + passo + abas.length) % abas.length];
    state.focoDepois = `perfil-aba-${proxima.dataset.perfilAba || "todas"}`;
    proxima.focus();
    trocarPerfilAba(proxima.dataset.perfilAba || "");
  });

  /* ================================================================== */
  /* Registro da pesquisa na faixa de páginas                             */
  /* ================================================================== */

  Object.assign(PAGINAS[0], {
    entrar: () => carregarTudo(),
    atualizar: (opcoes) => atualizar(opcoes),
    sair: () => limparDados(),
    filtrar: () => carregarTudo()
  });

  Object.assign(PAGINAS[1], {
    entrar: () => carregarObrigado(),
    atualizar: () => carregarObrigado(),
    sair: () => limparObrigado(),
    filtrar: () => carregarObrigado()
  });

  Object.assign(paginaDoId("perfis"), {
    entrar: () => carregarPerfis(),
    atualizar: () => carregarPerfis(),
    sair: () => limparPerfis(),
    filtrar: () => carregarPerfis()
  });

  // Uma aba por página de inscrição, todas com as mesmas funções: o que muda é a página que elas
  // entregam a abrirInscricao (null quando o config não carregou; aí a aba só avisa).
  for (const aba of ABAS_INSCRICAO) {
    Object.assign(aba, {
      entrar: () => abrirInscricao(aba.inscricao),
      atualizar: () => abrirInscricao(aba.inscricao),
      sair: () => limparInscricoes(),
      filtrar: () => abrirInscricao(aba.inscricao)
    });
  }

  $("[data-paginas]").addEventListener("click", (evento) => {
    const aba = evento.target instanceof Element ? evento.target.closest("[data-pagina]") : null;
    if (aba) trocarPagina(aba.dataset.pagina);
  });
  // Teclado como no padrão de abas: setas andam (dando a volta), Home e End vão às pontas.
  $("[data-paginas]").addEventListener("keydown", (evento) => {
    const indice = PAGINAS.indexOf(paginaAtual);
    let destino = -1;
    if (evento.key === "ArrowRight") destino = (indice + 1) % PAGINAS.length;
    else if (evento.key === "ArrowLeft") destino = (indice - 1 + PAGINAS.length) % PAGINAS.length;
    else if (evento.key === "Home") destino = 0;
    else if (evento.key === "End") destino = PAGINAS.length - 1;
    if (destino < 0) return;
    const proxima = PAGINAS[destino];
    evento.preventDefault();
    trocarPagina(proxima.id);
    const botao = document.getElementById(`pagina-${proxima.id}`);
    if (botao) botao.focus();
  });

  /* ================================================================== */
  /* Início                                                               */
  /* ================================================================== */

  lerUrl();
  // Link antigo (?pagina=inscricoes, de quando havia uma aba de inscrição só): abre a primeira e
  // a URL passa a dizer qual é, para o link copiado daqui em diante já sair com o id novo.
  if (new URLSearchParams(window.location.search).get("pagina") === ABA_INSCRICOES_ANTIGA && paginaAtual.id !== ABA_INSCRICOES_ANTIGA) escreverUrl();
  pintarPaginas();
  montarSelects();
  pintarFiltros();
  atualizarCsv();
  ligarFaixasRolaveis();

  (async () => {
    const { ok, body, status } = await api("/api/painel/sessao");
    if (ok && body.email) {
      state.email = body.email;
      mostrarPainel();
      paginaAtual.entrar();
      return;
    }
    mostrarLogin(status === 0 ? "Sem conexão com o servidor. Verifique a internet e tente de novo." : status === 503 ? "O painel ainda não está configurado no servidor." : "");
  })();
})();
