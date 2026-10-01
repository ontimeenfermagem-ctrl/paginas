/*
 * replay-config.js — as salas de aula ("matéria de capa"), como dado.
 *
 * ESTE É O ÚNICO ARQUIVO PARA MUDAR TEXTO, AULA, MATERIAL OU CERTIFICADO DE UMA PÁGINA DE REPLAY.
 * A página (replay-afericao.html + js/replay.js), o servidor (rota, CSP do player, gravação) e o
 * painel leem daqui. Trocar o link do vídeo ou do PDF é mexer só aqui, rodar os testes e publicar.
 *
 * A página é uma matéria de revista: capa com a linha de crédito da Iza, o vídeo como foto de
 * abertura (que aparece SEMPRE, trancada, para dar vontade antes do formulário), o texto na medida
 * do impresso e o mural de comentários como a página de cartas. Carga horária não aparece em
 * lugar nenhum da tela — por decisão do cliente.
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
   * isso a lista é fechada: provedor novo = uma entrada aqui + o host no cspDoReplay do server.mjs.
   */
  const PROVEDORES = Object.freeze({
    youtube: Object.freeze({
      nome: "YouTube",
      // nocookie: não grava cookie de rastreio antes do play.
      // enablejsapi: é o que deixa a página saber em que minuto a aula está (o botão da oferta).
      url: (id) =>
        `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&modestbranding=1&playsinline=1&enablejsapi=1`,
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

  /**
   * QUEM RESPONDE COM SELO. O nome, o papel e a foto da resposta da Iza saem daqui — nunca da API
   * e nunca do que alguém digita. O servidor só marca a linha como `admin`; o rosto e o selo são
   * desenhados a partir deste bloco, que mora no código.
   */
  const ADMIN = Object.freeze({
    nome: "Izabel Gonçalves",
    papel: "Escola Enfermagem de Valor",
    avatar: "/img/iza-avatar.jpg",
    // O texto do selo, que o leitor de tela lê: deixa claro que é verificado DA ESCOLA, e não de
    // uma rede social.
    selo: "Perfil verificado da Escola Enfermagem de Valor"
  });

  /** O está configurado? Enquanto não estiver, a página avisa em vez de mostrar caixa vazia. */
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
   * página desenha o fundo da marca no lugar.
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
      // Id da "pesquisa" com que a inscrição é gravada, e por onde o painel e os comentários
      // separam esta sala.
      pesquisa: "replay-afericao",
      // Nome interno, que aparece na aba do painel.
      nome: "Replay — Aula de Aferição",

      /* ------------------------------------------------------------ a capa */
      // A linha do expediente, no alto: é a "edição" da matéria.
      edicao: "Edição de setembro · aula ao vivo",
      eyebrow: "Sala de aula",
      // <em> vira a palavra em peso leve ameixa dentro do título pesado. UMA por título.
      titulo: "A aula da <em>Aferição</em>",
      // O standfirst: a linha de apoio da capa, em medida curta.
      apoio: "Como a sua experiência de anos no plantão pode ser reconhecida como profissão — o caminho inteiro, sem juridiquês.",
      // A legenda da foto de abertura, como numa revista.
      legenda: "A aula ao vivo, na íntegra. Grave este link: ele abre a sala sempre que você quiser rever.",

      /* ------------------------------------------------------------ o acesso */
      acesso: Object.freeze({
        rotulo: "Acesso à sala",
        titulo: "Destrave esta tela",
        apoio: "Preencha uma vez e a aula abre. É o mesmo cadastro que a gente usa para te avisar das próximas.",
        cta: "QUERO ASSISTIR A AULA",
        perguntaPerfil: "Hoje você é:",
        // Depois de liberar, a sala continua aberta neste aparelho por este tempo.
        lembrarDias: 90,
        // O que a foto de abertura diz enquanto está trancada.
        trava: "A aula inteira está aqui"
      }),

      /*
       * AS AULAS. Hoje é uma; a página aguenta mais sem mexer em código (a lista manda).
       * `video.provedor` = youtube | vimeo | panda, e `video.id` = o id (ou, no Panda, o endereço
       * inteiro do player). Vazio = a página mostra "estamos preparando o replay" DEPOIS do
       * acesso — antes dele, quem manda é a trava.
       */
      aulas: Object.freeze([
        Object.freeze({
          id: "aula-1",
          titulo: "Aferição da profissão por tempo de serviço",
          capa: "",
          video: Object.freeze({ provedor: "youtube", id: "JlocdK7VGpU" })
        })
      ]),

      /*
       * A OFERTA: o botão que aparece logo abaixo da aula quando o VÍDEO chega em `aposSegundos`
       * (o momento em que a Iza abre a oferta). Antes disso ele não existe na tela. Pausar não
       * conta; adiantar o vídeo até lá conta. Quem já chegou lá uma vez neste aparelho encontra
       * o botão aberto ao voltar. `link` só https. `ativo: false` = sem botão.
       */
      oferta: Object.freeze({
        ativo: true,
        rotulo: "Quero ser técnica de enfermagem",
        link: "https://www.io.tecnicodevalor.com.br/10Vad",
        aposSegundos: 20 * 60
      }),

      /*
       * O SUMÁRIO ("O que você vai ver"): a lista numerada que dá vontade de assistir. Entrou no
       * lugar da carga horária — em vez de dizer quanto tempo dura, diz o que a aula entrega.
       * Lista vazia = a caixa inteira desaparece.
       */
      sumario: Object.freeze([
        "o que é a aferição da profissão por tempo de serviço, em português claro;",
        "quem pode seguir por esse caminho — e quem ainda não pode;",
        "como os anos de plantão podem ser considerados;",
        "quais documentos comprovam a sua experiência;",
        "o que fazer quando falta registro de um período;",
        "os próximos passos para se tornar técnica de enfermagem."
      ]),

      /*
       * A MATÉRIA: a descrição da aula, um parágrafo por item. O cliente entrega o texto depois —
       * enquanto a lista estiver vazia, a seção não aparece e a página continua inteira (a capa, o
       * sumário e o vídeo já contam a história).
       */
      materia: Object.freeze([]),

      /*
       * O OLHO (pull quote): uma frase que rompe a coluna de leitura. Vazio = não aparece.
       * `depois` = depois de qual parágrafo da matéria ele entra (1 = depois do primeiro).
       */
      olho: Object.freeze({ texto: "", quem: ADMIN.nome, depois: 2 }),

      /*
       * O MATERIAL. Cada item é uma linha de download. Link do Drive, do site, de onde for — só
       * https. Lista vazia (ou sem link) = a seção inteira não aparece.
       */
      material: Object.freeze({
        titulo: "Para levar",
        apoio: "O material da aula, para acompanhar com ele do lado.",
        itens: Object.freeze([
          Object.freeze({
            id: "apostila",
            titulo: "Apostila da Aula de Aferição",
            tipo: "PDF",
            descricao: "Os passos, os documentos que comprovam o tempo de serviço e um checklist da sua situação.",
            link: ""
          })
        ])
      }),

      /*
       * O MURAL DE COMENTÁRIOS ("Cartas das alunas"). Hospedado por nós: o texto é nosso e a
       * remoção é nossa. `ativo: false` desliga a seção inteira.
       */
      comentarios: Object.freeze({
        ativo: true,
        titulo: "O que as alunas estão dizendo",
        apoio: "Conte o que você entendeu, pergunte o que ficou faltando. A Iza responde por aqui.",
        cta: "PUBLICAR",
        placeholder: "Escreva sua dúvida ou o que você achou da aula…",
        // Comentário com link entra em conferência em vez de ir direto ao ar: é o vetor de spam.
        moderarLinks: true,
        vazio: "Seja a primeira a comentar. A Iza lê tudo por aqui."
      }),

      /*
       * O CERTIFICADO. `ativo: false` = a seção existe no HTML mas fica escondida (hidden), sem
       * ocupar espaço e sem ser lida por leitor de tela. Para ligar: `ativo: true` e o `link` do
       * formulário de emissão. (A carga horária aqui é a do DOCUMENTO, não da tela: certificado
       * sem horas não serve para nada.)
       */
      certificado: Object.freeze({
        ativo: false,
        titulo: "Conquiste seu certificado",
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
  const POR_PESQUISA = new Map(LISTA.map((pagina) => [pagina.pesquisa, pagina]));

  /** A página de uma rota pública ("/replay-afericao", com ou sem barra no fim), ou null. */
  function paginaDaRota(caminho) {
    const limpo = String(caminho || "").replace(/\/+$/, "") || "/";
    return POR_ROTA.get(limpo) || null;
  }

  function paginaPorId(id) {
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(PAGINAS, id) ? PAGINAS[id] : null;
  }

  /** A página de um id de pesquisa ("replay-afericao"), ou null. */
  function paginaPorPesquisa(pesquisa) {
    return POR_PESQUISA.get(String(pesquisa || "")) || null;
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

  /**
   * A oferta da página, pronta para usar: {rotulo, link, aposSegundos}, ou null quando está
   * desligada ou o config está torto (link que não é https, tempo que não é número).
   */
  function ofertaDaPagina(pagina) {
    const o = pagina && pagina.oferta ? pagina.oferta : null;
    if (!o || o.ativo !== true) return null;
    const rotulo = typeof o.rotulo === "string" ? o.rotulo.trim() : "";
    const link = typeof o.link === "string" ? o.link.trim() : "";
    const aposSegundos = Number(o.aposSegundos);
    if (!rotulo || !linkValido(link) || !Number.isFinite(aposSegundos) || aposSegundos < 0) return null;
    return Object.freeze({ rotulo, link, aposSegundos });
  }

  /** O mural aparece? */
  function comentariosAtivos(pagina) {
    const c = pagina && pagina.comentarios ? pagina.comentarios : null;
    return Boolean(c && c.ativo === true);
  }

  root.EVReplay = Object.freeze({
    PROVEDORES,
    ADMIN,
    PAGINAS,
    LISTA,
    paginaDaRota,
    paginaPorId,
    paginaPorPesquisa,
    perfis,
    videoValido,
    urlDoVideo,
    capaDaAula,
    linkValido,
    materialDaPagina,
    certificadoVisivel,
    comentariosAtivos,
    ofertaDaPagina
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
