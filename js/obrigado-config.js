/*
 * obrigado-config.js — as 3 páginas de obrigado da pesquisa de ICP, como dado.
 *
 * ESTE É O ÚNICO ARQUIVO PARA MUDAR TEXTO, ROTA OU LINK DE GRUPO DAS PÁGINAS DE OBRIGADO.
 * (Com uma ressalva: o link de hoje é do distribuidor Sendflow, então PARA QUAL GRUPO ele manda se
 * troca no painel do Sendflow, sem deploy. E a mensagem do WhatsApp que o n8n dispara leva uma
 * cópia do link — mudar aqui não muda lá.)
 * A página (obrigado.html + js/obrigado.js), o formulário (redireciona ao terminar), o servidor
 * (rotas, eventos, aviso ao n8n) e o painel leem daqui.
 *
 * Regra do cliente: 4 perfis de público → 3 páginas de obrigado → 3 grupos de WhatsApp.
 * Técnico(a) e Enfermeiro(a) dividem a mesma página e o mesmo grupo, mas continuam separados no
 * banco, no CSV e no n8n (o perfil é gravado como foi respondido).
 *
 * Depende de js/pesquisa-config.js (EVPesquisa) carregado antes.
 */
(function (root) {
  "use strict";

  const P = root.EVPesquisa;

  /*
   * LINKS DOS GRUPOS DE WHATSAPP, um por página. Valem duas formas: o convite direto do grupo
   * (https://chat.whatsapp.com/...) ou o link do DISTRIBUIDOR que o cliente usa, o Sendflow
   * (https://sndflw.com/i/<id>), que manda cada pessoa para o grupo que ainda tem vaga — é por
   * isso que a mesma URL serve para todo mundo e o destino pode ser trocado sem novo deploy.
   * Vazio = a página não mostra botão quebrado: avisa que o link chega pelo WhatsApp.
   *
   * ATENÇÃO ao colar: link trocado de página falha em SILÊNCIO (o botão funciona e leva a pessoa
   * ao grupo errado). O nome do grupo de destino é a única conferência que vale — os três de hoje
   * são "Aula de Aferição", "Cuidador de Valor" e "Nova Era da Enfermagem", na ordem abaixo.
   */
  const LINKS_GRUPOS = Object.freeze({
    afericao: "https://sndflw.com/i/VGB8x5AIcIMERWpr2ydB",
    cuidador: "https://sndflw.com/i/ALkroj4SlIzsy4KJvlwz",
    evento_outubro: "https://sndflw.com/i/hxQV77EZKwpS62QXVLb8"
  });

  const PAGINAS = Object.freeze({
    afericao: Object.freeze({
      id: "afericao",
      rota: "/obrigado-afericao",
      nome: "Obrigado — Aula de Aferição",
      perfis: Object.freeze([P.PERFIL.auxiliar]),
      grupo: "afericao",
      eyebrow: "Aula ao vivo · dia 30 · 20h · on-line",
      headline: "Pesquisa concluída! Agora falta só um passo. 💜",
      subheadline:
        "Entre no grupo da aula ao vivo do dia 30, às 20h, para receber todas as informações e o acesso ao encontro.",
      introducao: "Na aula, a gente vai falar sobre:",
      topicos: Object.freeze([
        "o que é a aferição da profissão por tempo de serviço;",
        "quem pode seguir por esse caminho;",
        "como a experiência profissional pode ser considerada;",
        "formas de comprovação da experiência;",
        "documentos que podem ser necessários;",
        "análise de cada situação;",
        "possíveis próximos passos para se tornar técnica de enfermagem."
      ]),
      cta: "ENTRAR NO GRUPO DA AULA",
      link: LINKS_GRUPOS.afericao
    }),
    cuidador: Object.freeze({
      id: "cuidador",
      rota: "/obrigado-cuidador",
      nome: "Obrigado — Formação Técnica Cuidador de Valor",
      perfis: Object.freeze([P.PERFIL.cuidador]),
      grupo: "cuidador",
      eyebrow: "Formação Técnica Cuidador de Valor",
      headline: "Pesquisa concluída! Temos um próximo passo especial para você. 💜",
      subheadline:
        "Entre no grupo especial para receber em primeira mão as informações sobre a Formação Técnica Cuidador de Valor.",
      introducao: "No grupo, a gente vai compartilhar:",
      topicos: Object.freeze([
        "data da apresentação;",
        "detalhes da formação;",
        "conteúdos de preparação;",
        "informações sobre a proposta da formação;",
        "próximos passos para quem deseja se desenvolver profissionalmente como cuidador."
      ]),
      cta: "ENTRAR NO GRUPO CUIDADOR DE VALOR",
      link: LINKS_GRUPOS.cuidador
    }),
    evento_outubro: Object.freeze({
      id: "evento_outubro",
      rota: "/obrigado-evento-outubro",
      nome: "Obrigado — Evento Gratuito de Outubro",
      perfis: Object.freeze([P.PERFIL.tecnico, P.PERFIL.enfermeiro]),
      grupo: "evento_outubro",
      eyebrow: "Evento gratuito · 26 de outubro",
      headline: "Pesquisa concluída! Seu próximo passo está aqui. 💜",
      subheadline:
        "Entre no grupo oficial do evento gratuito do dia 26 de outubro para receber todas as informações e conteúdos de preparação.",
      introducao: "O evento poderá abordar temas como:",
      topicos: Object.freeze([
        "prática profissional;",
        "procedimentos;",
        "dispositivos;",
        "segurança no plantão;",
        "intercorrências;",
        "valorização profissional;",
        "novas possibilidades de atuação;",
        "liderança;",
        "home care;",
        "cuidado com idosos;",
        "pacientes dependentes;",
        "atendimento de pessoas com autismo;",
        "formação e capacitação profissional."
      ]),
      cta: "ENTRAR NO GRUPO DO EVENTO",
      link: LINKS_GRUPOS.evento_outubro
    })
  });

  const LISTA = Object.freeze(Object.values(PAGINAS));
  const POR_ROTA = new Map(LISTA.map((pagina) => [pagina.rota, pagina]));

  /** Página de obrigado de um perfil (rótulo gravado na resposta 1). null se não houver. */
  function paginaDoPerfil(perfil) {
    return LISTA.find((pagina) => pagina.perfis.includes(perfil)) || null;
  }

  /** Página a partir do caminho da URL ("/obrigado-cuidador" ou "/obrigado-cuidador/"). */
  function paginaDaRota(caminho) {
    const limpo = String(caminho || "").replace(/\/+$/, "") || "/";
    return POR_ROTA.get(limpo) || null;
  }

  /*
   * Convite direto do WhatsApp, ou o distribuidor de grupo do cliente (Sendflow). O portão é a
   * LISTA DE HOSTS, ancorada em ^...$ e com o ponto escapado: assim `javascript:`, `http://`,
   * "sndflw.com.site-de-golpe.com", "sndflw.com@golpe.com" e "golpe.com/sndflw.com/i/x" ficam de
   * fora. Query e fragmento são aceitos porque convite real vem com eles (?text=, #). O host tem
   * que vir em minúsculas, como as duas ferramentas entregam.
   */
  const CONVITE_WHATSAPP = /^https:\/\/(chat\.whatsapp\.com|wa\.me)\/[A-Za-z0-9_-]+\/?(?:[?#][!-~]*)?$/;
  const DISTRIBUIDOR_GRUPO = /^https:\/\/(?:www\.)?sndflw\.com\/i\/[A-Za-z0-9_-]+\/?(?:[?#][!-~]*)?$/;

  /**
   * O link do grupo só vale se for uma das duas formas acima. O trim() existe porque link colado
   * do WhatsApp costuma vir com espaço ou quebra de linha no fim, e sem ele a página esconderia o
   * botão sem dizer por quê.
   */
  function linkValido(link) {
    const valor = String(link || "").trim();
    return valor.length <= 300 && (CONVITE_WHATSAPP.test(valor) || DISTRIBUIDOR_GRUPO.test(valor));
  }

  root.EVObrigado = Object.freeze({
    LINKS_GRUPOS,
    PAGINAS,
    LISTA,
    paginaDoPerfil,
    paginaDaRota,
    linkValido
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
