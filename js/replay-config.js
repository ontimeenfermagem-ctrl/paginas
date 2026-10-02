/*
 * replay-config.js — as salas de aula ("matéria de capa"), como dado.
 *
 * ESTE É O ÚNICO ARQUIVO PARA MUDAR TEXTO, AULA, CONTEÚDOS, MATERIAL OU CERTIFICADO DE UMA SALA.
 * As páginas (o .html de mesmo nome da rota — replay-afericao.html, pagina-de-aula-gps.html — mais
 * js/replay.js), o servidor (rota, CSP do player, gravação) e o painel leem daqui. Trocar o link do
 * vídeo ou do PDF é mexer só aqui, rodar os testes e publicar.
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

  /**
   * O endereço do player (só chamado no clique do play). "" = não configurado. Com `{ limpo: true }`
   * e vídeo do YouTube, o player nasce sem nada do YouTube na tela: sem os controles (controls=0),
   * sem o teclado dele, sem a tela cheia dele, sem anotações e sem legenda forçada — os controles
   * passam a ser os da página (o player limpo do js/replay.js).
   */
  function urlDoVideo(video, opcoes) {
    if (!videoValido(video)) return "";
    const url = PROVEDORES[video.provedor].url(video.id);
    if (opcoes && opcoes.limpo === true && video.provedor === "youtube") {
      return `${url}&controls=0&disablekb=1&fs=0&iv_load_policy=3&cc_load_policy=0`;
    }
    return url;
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

  /**
   * Arte de card só vale arquivo DESTE site, em /img/ (o CSP da sala não carrega imagem de outro
   * host, e é o que garante que a arte fica salva aqui e não some junto com um link de fora).
   */
  function imagemValida(caminho) {
    const s = String(caminho || "").trim();
    return /^\/img\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(jpe?g|png|webp)$/i.test(s);
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
       * AS AULAS. O quadro de abertura mostra a PRIMEIRA da lista (conteúdos que abrem um por dia
       * vão em `conteudos` — ver a sala do GPS, mais abaixo).
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
    }),

    /*
     * A SALA DA IMERSÃO GPS (/pagina-de-aula-gps): a porta PRIMEIRO (sem o formulário, a página é
     * só a capa e ele); preenchida, a sala abre com a aula principal no topo — a live de quarta,
     * 07/10, às 20h — e, embaixo, a vitrine das 6 mini aulas (Shorts do YouTube) que abrem uma por
     * dia, às 20h, e os comentários. A chave do objeto TEM que ser igual ao `id` (é por ela que o
     * servidor acha a sala quando o formulário chega).
     */
    "aula-gps": Object.freeze({
      id: "aula-gps",
      rota: "/pagina-de-aula-gps",
      pesquisa: "pagina-de-aula-gps",
      // Na aba do painel. Não confundir com "Imersão GPS — ingressos", a da venda.
      nome: "Sala de aula — Imersão GPS",

      edicao: "Edição de outubro · Imersão GPS",
      eyebrow: "Sala de aula",
      titulo: "Imersão <em>GPS</em>",
      apoio: "O GPS do Plantão Sem Medo começa antes da live: seis mini aulas, uma por dia, para você chegar pronta.",
      legenda: "Grave este link: a live de quarta, 07/10, às 20h, é aqui. Até lá, uma mini aula nova por dia, logo abaixo.",

      /*
       * O PLAYER LIMPO: o vídeo do YouTube toca sem NADA do YouTube na tela — sem os controles, o
       * título, o logo, o "assistir no YouTube" e as sugestões do fim. Uma camada da página fica por
       * cima do player (ninguém clica em nada do YouTube) e os controles são os da Escola: tocar e
       * pausar, a barra do tempo, o som e a tela cheia. Só vale para vídeo do YouTube.
       */
      playerLimpo: true,

      acesso: Object.freeze({
        rotulo: "Acesso à sala",
        titulo: "Destrave esta tela",
        apoio: "Preencha uma vez e a sala abre: a live de quarta, 07/10, e as mini aulas que chegam uma por dia até lá.",
        cta: "QUERO ENTRAR NA SALA",
        perguntaPerfil: "Hoje você é:",
        lembrarDias: 90,
        trava: "As mini aulas estão aqui dentro",
        // A PORTA ANTES DE TUDO: trancada, a página é só a capa e o formulário — nada de quadro com
        // cadeado nem vitrine. Preenchido (uma vez por aparelho, por `lembrarDias`), abre o resto.
        portaPrimeiro: true
      }),

      /*
       * A AULA PRINCIPAL: a live de quarta, 07/10, às 20h. É a primeira coisa da sala, logo que a
       * porta abre, com a thumb dela (`capa`). Até `liberaEm`, o quadro mostra a thumb inteira e o
       * selo "Ao vivo" com a data (no dia, a contagem regressiva); na hora, abre sozinha, sem
       * ninguém atualizar a página: com o `video` (o id do YouTube da live), toca no player limpo;
       * sem ele, mostra o `aviso`. A página de venda promete o replay por 48h SÓ para quem comprou,
       * e esta sala abre para qualquer lead: o vídeo entra aqui só com o ok do cliente.
       */
      aulas: Object.freeze([
        Object.freeze({
          id: "live",
          titulo: "Ao vivo com Izabel Gonçalves",
          capa: "/img/aula-gps/live.jpg",
          liberaEm: "2026-10-07T20:00:00-03:00",
          video: Object.freeze({ provedor: "youtube", id: "" }),
          aviso: "A live com a Iza vai passar aqui."
        })
      ]),

      // Sem botão por enquanto: para ligar, `ativo: true`, o texto, o link https e o minuto da aula.
      oferta: Object.freeze({ ativo: false, rotulo: "", link: "", aposSegundos: 20 * 60 }),

      sumario: Object.freeze([]),

      /*
       * AS MINI AULAS E A LIVE. Cada card abre sozinho em `liberaEm` (data e hora de Brasília,
       * SEMPRE com o -03:00 no fim) — ninguém precisa publicar nada no dia. Antes disso ele fica em
       * preto e branco, com o cadeado e a data, e não é clicável; o próximo a abrir mostra a
       * contagem regressiva ("Abre em 2h 05min"). Com a página aberta na hora, ele destrava sozinho
       * — e, liberado, perde o cadeado e o preto e branco: fica colorido, com o play.
       *
       *   titulo   — o nome no card (em cima dele vai "Mini aula N", pelo `rotulo` da série).
       *   imagem   — a thumb, SALVA no projeto: img/aula-gps/… (as mini aulas são Shorts: 9:16,
       *              720×1280). Enquanto o arquivo não existe, o card desenha o número (ou a
       *              `marca`) sobre a cor da marca. Para TROCAR uma thumb depois, use um nome novo:
       *              o navegador guarda imagem por um dia.
       *   video    — o vídeo (do YouTube, só o id: em youtube.com/shorts/u7VIU4L28co é
       *              "u7VIU4L28co"). Toca no quadro lá de cima, sem sair da página.
       *   link     — em vez de vídeo, um endereço https (PDF, post, live de fora): abre em outra aba.
       *   formato  — "vertical" (Short) ou "horizontal"; sem ele, vale o `formato` da lista.
       *   rotulo   — só para quem não é da série (a live): o nome em cima do título.
       *   destaque — o card sai da vitrine e fica sozinho, largo, embaixo dela (a live).
       *   marca    — o texto grande do card enquanto a thumb não existe (sem ela, o número).
       * Passou da hora e ainda não tem vídeo nem link = o card fica trancado, dizendo "em breve".
       *
       * A liberação é na tela: quem abrir o código-fonte vê o que já estiver cadastrado aqui. O que
       * não pode vazar antes do dia entra no config só no dia.
       */
      conteudos: Object.freeze({
        titulo: "Mini aulas",
        rotulo: "Mini aula",
        formato: "vertical",
        apoio: "Uma mini aula nova por dia, sempre às 20h, até a live com a Iza na quarta, 07/10.",
        itens: Object.freeze([
          // Mini aula 1: liberada em 01/10.
          Object.freeze({
            id: "mini-aula-1",
            titulo: "Circuito do ventilador mecânico",
            imagem: "/img/aula-gps/mini-aula-1.jpg",
            liberaEm: "2026-10-01T20:00:00-03:00",
            video: Object.freeze({ provedor: "youtube", id: "u7VIU4L28co" }),
            link: ""
          }),
          // Mini aula 2: liberada em 02/10.
          Object.freeze({
            id: "mini-aula-2",
            titulo: "Cânula de traqueostomia por dentro",
            imagem: "/img/aula-gps/mini-aula-2.jpg",
            liberaEm: "2026-10-02T00:00:00-03:00",
            video: Object.freeze({ provedor: "youtube", id: "ngMgmVnKjAI" }),
            link: ""
          }),
          // Mini aula 3: sábado, 03/10, às 20h.
          Object.freeze({
            id: "mini-aula-3",
            titulo: "Responsabilidades no plantão",
            imagem: "/img/aula-gps/mini-aula-3.jpg",
            liberaEm: "2026-10-03T20:00:00-03:00",
            video: Object.freeze({ provedor: "youtube", id: "z8zAHMj13U8" }),
            link: ""
          }),
          // Mini aula 4: domingo, 04/10, às 20h.
          Object.freeze({
            id: "mini-aula-4",
            titulo: "Filtro umidificador",
            imagem: "/img/aula-gps/mini-aula-4.jpg",
            liberaEm: "2026-10-04T20:00:00-03:00",
            video: Object.freeze({ provedor: "youtube", id: "ko01OoIfZ5s" }),
            link: ""
          }),
          // Mini aula 5: segunda, 05/10, às 20h.
          Object.freeze({
            id: "mini-aula-5",
            titulo: "Higienização do frasco de dieta",
            imagem: "/img/aula-gps/mini-aula-5.jpg",
            liberaEm: "2026-10-05T20:00:00-03:00",
            video: Object.freeze({ provedor: "youtube", id: "ckpBe3kTK4g" }),
            link: ""
          }),
          // Mini aula 6: terça, 06/10, às 20h.
          Object.freeze({
            id: "mini-aula-6",
            titulo: "Materiais para o banho",
            imagem: "/img/aula-gps/mini-aula-6.jpg",
            liberaEm: "2026-10-06T20:00:00-03:00",
            video: Object.freeze({ provedor: "youtube", id: "f9ipe2ttj4w" }),
            link: ""
          })
        ])
      }),

      materia: Object.freeze([]),
      olho: Object.freeze({ texto: "", quem: ADMIN.nome, depois: 2 }),
      material: Object.freeze({ titulo: "Para levar", apoio: "", itens: Object.freeze([]) }),

      comentarios: Object.freeze({
        ativo: true,
        titulo: "O que as alunas estão dizendo",
        apoio: "Conte o que você achou das mini aulas e pergunte o que ficou faltando. A Iza responde por aqui.",
        cta: "PUBLICAR",
        placeholder: "Escreva sua dúvida ou o que você achou da mini aula…",
        moderarLinks: true,
        vazio: "Seja a primeira a comentar. A Iza lê tudo por aqui."
      }),

      certificado: Object.freeze({
        ativo: false,
        titulo: "Conquiste seu certificado",
        apoio: "Participe da imersão e libere o seu certificado de participação.",
        cta: "EMITIR MEU CERTIFICADO",
        horas: "",
        link: "",
        imagem: ""
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

  /* ================================================================== */
  /* Os conteúdos que abrem um por dia                                   */
  /* ================================================================== */

  const DIA_MS = 24 * 60 * 60 * 1000;
  // Brasília não tem horário de verão desde 2019: o fuso é -03:00 o ano inteiro. A conta é feita na
  // mão (e não com Intl) para dar o MESMO rótulo em qualquer aparelho, de qualquer fuso.
  const BRASILIA_MS = -3 * 60 * 60 * 1000;
  const SEMANA = Object.freeze(["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"]);

  /** O instante (ms) de uma data do config, ou NaN. Só vale data COM fuso escrito (o -03:00). */
  function instanteDe(valor) {
    const s = String(valor || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(s)) return NaN;
    return Date.parse(s);
  }

  /**
   * Os conteúdos da página no instante `agora` (ms), na ordem do config. Cada um sai com o
   * `estado`, que é o que a página desenha:
   *   "liberado" — passou da data e tem vídeo ou link;
   *   "chegando" — passou da data, mas o vídeo/link ainda não foi cadastrado (o card diz "em breve");
   *   "trancado" — ainda não chegou a data (ou a data está torta: trancado é o lado seguro).
   * `novo` = liberado há menos de um dia (o selo "Novo" do conteúdo do dia).
   */
  function conteudosDaPagina(pagina, agora) {
    const c = pagina && pagina.conteudos ? pagina.conteudos : null;
    const itens = c && Array.isArray(c.itens) ? c.itens : [];
    // O nome da série nos cards: "Aula bônus" vira "Aula bônus 1", "Aula bônus 2"…
    const serie = c && typeof c.rotulo === "string" && c.rotulo.trim() ? c.rotulo.trim() : "Conteúdo";
    const t = Number(agora);
    return itens.map((item, indice) => {
      const libera = instanteDe(item && item.liberaEm);
      const aberto = Number.isFinite(libera) && Number.isFinite(t) && t >= libera;
      const temVideo = videoValido(item && item.video);
      const link = item && linkValido(item.link) ? String(item.link).trim() : "";
      const estado = !aberto ? "trancado" : temVideo || link ? "liberado" : "chegando";
      return Object.freeze({
        id: String((item && item.id) || `conteudo-${indice + 1}`),
        numero: indice + 1,
        // Item com rótulo próprio (a live) não entra na contagem da série.
        rotulo: item && typeof item.rotulo === "string" && item.rotulo.trim() ? item.rotulo.trim() : `${serie} ${indice + 1}`,
        titulo: item && typeof item.titulo === "string" ? item.titulo.trim() : "",
        destaque: Boolean(item && item.destaque === true),
        // Short (9:16) ou vídeo deitado (16:9): do item, ou o padrão da lista.
        vertical: ((item && typeof item.formato === "string" && item.formato) || (c && c.formato) || "") === "vertical",
        marca: item && typeof item.marca === "string" ? item.marca.trim().slice(0, 12) : "",
        imagem: item && imagemValida(item.imagem) ? String(item.imagem).trim() : "",
        // O que ainda não abriu não leva o vídeo nem o link para a página.
        video: aberto && temVideo ? item.video : null,
        link: aberto ? link : "",
        liberaEm: libera,
        estado,
        novo: estado === "liberado" && t - libera < DIA_MS
      });
    });
  }

  /**
   * A aula (o quadro de abertura) já abriu? Sem `liberaEm`, sempre — é o caso da aferição. Com ele,
   * só do instante dele em diante; data torta (sem fuso) deixa fechada, como nos cards.
   */
  function aulaAberta(aula, agora) {
    if (!aula) return false;
    if (aula.liberaEm === undefined || aula.liberaEm === null || aula.liberaEm === "") return true;
    const libera = instanteDe(aula.liberaEm);
    const t = Number(agora);
    return Number.isFinite(libera) && Number.isFinite(t) && t >= libera;
  }

  /** O próximo instante (ms) em que algum conteúdo abre, ou null. É quando a página se redesenha. */
  function proximaLiberacao(pagina, agora) {
    const t = Number(agora);
    let proxima = null;
    for (const item of conteudosDaPagina(pagina, t)) {
      if (Number.isFinite(item.liberaEm) && item.liberaEm > t && (proxima === null || item.liberaEm < proxima)) {
        proxima = item.liberaEm;
      }
    }
    return proxima;
  }

  /** "Aula bônus 3" ou "Aula bônus 3: O nome dela" — o nome inteiro, para o player e o leitor de tela. */
  function nomeDoConteudo(item) {
    const rotulo =
      item && typeof item.rotulo === "string" && item.rotulo ? item.rotulo : `Conteúdo ${item && item.numero ? item.numero : ""}`.trim();
    return item && item.titulo ? `${rotulo}: ${item.titulo}` : rotulo;
  }

  /** "terça, 14/10" (ou "terça, 14/10, às 19h30" quando não é meia-noite), no horário de Brasília. */
  function rotuloDaData(instante) {
    if (!Number.isFinite(instante)) return "";
    const d = new Date(instante + BRASILIA_MS);
    const dois = (n) => String(n).padStart(2, "0");
    const dia = `${SEMANA[d.getUTCDay()]}, ${dois(d.getUTCDate())}/${dois(d.getUTCMonth() + 1)}`;
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    if (!h && !m) return dia;
    return `${dia}, às ${h}h${m ? dois(m) : ""}`;
  }

  /**
   * Quando abre, dito do jeito que a pessoa lê: "em 2h 05min" (menos de um dia: a contagem
   * regressiva), "amanhã, às 20h", ou o dia ("domingo, 04/10, às 20h"). Os dias são os de Brasília.
   */
  function rotuloDaLiberacao(instante, agora) {
    if (!Number.isFinite(instante)) return "";
    const t = Number(agora);
    if (!Number.isFinite(t)) return rotuloDaData(instante);
    const falta = instante - t;
    if (falta > 0 && falta < DIA_MS) {
      const minutos = Math.ceil(falta / 60000);
      if (minutos <= 1) return "em instantes";
      const h = Math.floor(minutos / 60);
      const m = minutos % 60;
      if (!h) return `em ${m}min`;
      return m ? `em ${h}h ${String(m).padStart(2, "0")}min` : `em ${h}h`;
    }
    const diaDe = (ms) => Math.floor((ms + BRASILIA_MS) / DIA_MS);
    if (diaDe(instante) - diaDe(t) === 1) {
      const completo = rotuloDaData(instante);
      const hora = completo.indexOf(", às ");
      return hora === -1 ? "amanhã" : `amanhã${completo.slice(hora)}`;
    }
    return rotuloDaData(instante);
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
    imagemValida,
    materialDaPagina,
    certificadoVisivel,
    comentariosAtivos,
    ofertaDaPagina,
    conteudosDaPagina,
    proximaLiberacao,
    nomeDoConteudo,
    rotuloDaData,
    rotuloDaLiberacao,
    aulaAberta,
    instanteDe
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
