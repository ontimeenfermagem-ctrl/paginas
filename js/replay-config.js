/*
 * replay-config.js — as páginas de replay ("sala de aula"), como dado.
 *
 * ESTE É O ÚNICO ARQUIVO PARA MUDAR TEXTO, AULA, MATERIAL OU CERTIFICADO DE UMA PÁGINA DE REPLAY.
 * A página (replay-afericao.html + js/replay.js), o servidor (rota, CSP do player, gravação) e o
 * painel leem daqui. Trocar o link do vídeo ou do PDF é mexer só aqui, rodar os testes e publicar.
 *
 * Como funciona a sala: a pessoa cai na página, preenche UMA vez o formulário de acesso (nome,
 * WhatsApp, e-mail e profissão) e a aula libera. A inscrição vai para o mesmo lugar de todo lead
 * do projeto — a tabela da pesquisa, com o id `pesquisa` desta página —, e aparece no /painel com
 * as UTMs de primeiro toque.
 *
 * Depende de js/pesquisa-config.js (EVPesquisa) carregado antes: as opções de profissão são as
 * MESMAS quatro da pergunta 1 da pesquisa, para o público não ser recortado de dois jeitos.
 */
(function (root) {
  "use strict";

  const P = root.EVPesquisa;

  /*
   * PROVEDORES DE VÍDEO aceitos. O `iframe` é montado só quando a pessoa toca no play (nada de
   * terceiro carrega antes disso), e o host de cada um entra no CSP da página pelo servidor — por
   * isso a lista é fechada: provedor novo = uma entrada aqui + o host no CSP_REPLAY do server.mjs.
   */
  const PROVEDORES = Object.freeze({
    youtube: Object.freeze({
      nome: "YouTube",
      // nocookie: não grava cookie de rastreio antes do play.
      url: (id) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1`,
      capa: (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/maxresdefault.jpg`,
      idValido: (id) => /^[A-Za-z0-9_-]{6,20}$/.test(String(id || ""))
    }),
    vimeo: Object.freeze({
      nome: "Vimeo",
      url: (id) => `https://player.vimeo.com/video/${encodeURIComponent(id)}?autoplay=1&title=0&byline=0&portrait=0`,
      capa: () => "",
      idValido: (id) => /^[0-9]{6,12}(\/[A-Za-z0-9]+)?$/.test(String(id || ""))
    }),
    panda: Object.freeze({
      nome: "Panda Video",
      // O Panda dá o endereço inteiro do player (player-vz-xxxx.tv.pandavideo.com.br/.../embed).
      url: (id) => String(id || ""),
      capa: () => "",
      idValido: (id) => /^https:\/\/player-[a-z0-9-]+\.tv\.pandavideo\.com\.br\/[A-Za-z0-9/_-]+/.test(String(id || ""))
    })
  });

  /** O vídeo está configurado? Enquanto não estiver, a página avisa em vez de mostrar caixa vazia. */
  function videoValido(video) {
    const v = video || {};
    const provedor = Object.prototype.hasOwnProperty.call(PROVEDORES, v.provedor) ? PROVEDORES[v.provedor] : null;
    return Boolean(provedor && provedor.idValido(v.id));
  }

  /** O endereço do player (só chamado no clique do play). "" = não configurado. */
  function urlDoVideo(video) {
    return videoValido(video) ? PROVEDORES[video.provedor].url(video.id) : "";
  }

  /**
   * A capa da aula: a imagem escolhida no config ganha do que o provedor oferece. Cai para "" e a
   * página desenha a capa própria dela (fundo da marca com o número da aula).
   */
  function capaDaAula(aula) {
    const a = aula || {};
    if (typeof a.capa === "string" && a.capa) return a.capa;
    return videoValido(a.video) ? PROVEDORES[a.video.provedor].capa(a.video.id) : "";
  }

  /** Link de material só vale https (nada de javascript: num href que veio de config). */
  function linkValido(link) {
    return /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/[^\s"'<>]*$/i.test(String(link || "").trim());
  }

  /* ================================================================== */
  /* As páginas                                                          */
  /* ================================================================== */

  const PAGINAS = Object.freeze({
    afericao: Object.freeze({
      id: "afericao",
      rota: "/replay-afericao",
      // Id da "pesquisa" com que a inscrição é gravada, e por onde o painel separa esta sala.
      pesquisa: "replay-afericao",
      // Nome interno, que aparece na aba do painel.
      nome: "Replay — Aula de Aferição",

      eyebrow: "Sala de aula · Escola Enfermagem de Valor",
      titulo: "Aula de Aferição da profissão",
      descricao:
        "Esta é a sua sala de aula. Reveja a aula quantas vezes quiser e baixe o material que a Iza preparou para você acompanhar cada passo.",
      // Os números do topo. `valor` é o que aparece grande; `rotulo`, embaixo.
      numeros: Object.freeze([
        Object.freeze({ valor: "1", rotulo: "aula ao vivo" }),
        Object.freeze({ valor: "3h", rotulo: "de duração" }),
        Object.freeze({ valor: "30/09", rotulo: "gravada ao vivo" })
      ]),

      /* O formulário que libera a sala. */
      acesso: Object.freeze({
        titulo: "Libere o acesso à sala",
        apoio: "Preencha uma vez e a aula abre. É o mesmo cadastro que a gente usa para te avisar das próximas.",
        cta: "QUERO ASSISTIR A AULA",
        perguntaPerfil: "Hoje você é:",
        // Depois de liberar, a sala continua aberta neste aparelho por este tempo.
        lembrarDias: 90
      }),

      /*
       * AS AULAS. Hoje é uma; a página aguenta mais sem mexer em código (a lista manda).
       * `video.provedor` = youtube | vimeo | panda, e `video.id` = o id (ou, no Panda, o endereço
       * inteiro do player). Vazio = a página mostra "estamos preparando o replay" em vez de um
       * quadro preto.
       */
      aulas: Object.freeze([
        Object.freeze({
          id: "aula-1",
          numero: "Aula 1",
          titulo: "Aferição da profissão por tempo de serviço",
          descricao:
            "O caminho completo da aferição: o que é, quem pode seguir por ele, como a experiência de anos no plantão pode ser considerada, quais documentos comprovam esse tempo e quais são os próximos passos para se tornar técnica de enfermagem.",
          duracao: "3 horas",
          quando: "30 de setembro",
          capa: "",
          video: Object.freeze({ provedor: "youtube", id: "" })
        })
      ]),

      /*
       * O MATERIAL. Cada item é um botão de download. Link do Drive, do site, de onde for — só
       * https. Lista vazia = a seção inteira não aparece.
       */
      material: Object.freeze({
        titulo: "Material da aula",
        apoio: "Baixe e acompanhe a aula com ele do lado.",
        itens: Object.freeze([
          Object.freeze({
            id: "apostila",
            titulo: "Apostila da Aula de Aferição",
            tipo: "PDF",
            descricao: "O resumo dos passos, os documentos que comprovam o tempo de serviço e um checklist para você conferir a sua situação.",
            link: ""
          })
        ])
      }),

      /*
       * O CERTIFICADO. `ativo: false` = a seção existe no HTML mas fica escondida (hidden), sem
       * ocupar espaço e sem ser lida por leitor de tela. Para ligar: `ativo: true` e o `link` do
       * formulário de emissão.
       */
      certificado: Object.freeze({
        ativo: false,
        titulo: "Conquiste seu certificado de 3 horas",
        apoio: "Assista à aula até o fim e libere o seu certificado de participação.",
        cta: "EMITIR MEU CERTIFICADO",
        horas: "3 horas",
        link: "",
        imagem: "/img/certificado-afericao.svg"
      }),

      rodape: "Escola Enfermagem de Valor · conteúdo para profissionais e futuras profissionais de enfermagem."
    })
  });

  const LISTA = Object.freeze(Object.values(PAGINAS));
  const POR_ROTA = new Map(LISTA.map((pagina) => [pagina.rota, pagina]));

  /** A página de uma rota pública ("/replay-afericao", com ou sem barra no fim), ou null. */
  function paginaDaRota(caminho) {
    const limpo = String(caminho || "").replace(/\/+$/, "") || "/";
    return POR_ROTA.get(limpo) || null;
  }

  function paginaPorId(id) {
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(PAGINAS, id) ? PAGINAS[id] : null;
  }

  /** As opções de profissão do formulário: as MESMAS quatro da pergunta 1 da pesquisa. */
  function perfis() {
    const pergunta = P && typeof P.perguntaPorId === "function" ? P.perguntaPorId("perfil") : null;
    if (pergunta && Array.isArray(pergunta.opcoes) && pergunta.opcoes.length) return pergunta.opcoes.slice();
    return P ? Object.values(P.PERFIL) : [];
  }

  /** Só os itens de material com link de verdade — é o que a página desenha. */
  function materialDaPagina(pagina) {
    const material = pagina && pagina.material ? pagina.material : null;
    const itens = material && Array.isArray(material.itens) ? material.itens : [];
    return itens.filter((item) => linkValido(item.link));
  }

  /** O certificado aparece? Só com `ativo` ligado E link de emissão válido. */
  function certificadoVisivel(pagina) {
    const c = pagina && pagina.certificado ? pagina.certificado : null;
    return Boolean(c && c.ativo === true && linkValido(c.link));
  }

  root.EVReplay = Object.freeze({
    PROVEDORES,
    PAGINAS,
    LISTA,
    paginaDaRota,
    paginaPorId,
    perfis,
    videoValido,
    urlDoVideo,
    capaDaAula,
    linkValido,
    materialDaPagina,
    certificadoVisivel
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
