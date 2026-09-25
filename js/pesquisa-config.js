/*
 * pesquisa-config.js — a pesquisa de ICP da Escola Enfermagem de Valor, inteira, como dado.
 *
 * ESTE É O ÚNICO ARQUIVO PARA MUDAR PERGUNTA, ALTERNATIVA, ORDEM OU OBRIGATORIEDADE.
 * O formulário (js/pesquisa.js), o servidor (server.mjs) e o painel (js/painel.js) leem daqui.
 * O servidor carrega este mesmo arquivo com vm, então a regra que vale na tela é a mesma que
 * vale na gravação — nada de duas listas de alternativas saindo de sincronia.
 *
 * Mexeu em pergunta ou alternativa? Suba a VERSAO. Cada resposta fica gravada com a versão em
 * que foi dada, e comparar uma edição com a outra continua possível.
 *
 * As funções no fim do arquivo são puras (sem DOM, sem rede) e testadas em tests/.
 */
(function (root) {
  "use strict";

  const ID = "icp-escola-ev";
  const VERSAO = "1.0";

  /*
   * "Outro" com campo "qual?" (<id>_outro). HOJE NENHUMA PERGUNTA USA: o cliente decidiu que a
   * pesquisa só aceita respostas concretas, então nenhuma alternativa abre texto livre. O mecanismo
   * (chaveOutro, outroMarcado, complemento em sanitizar/erroDaPergunta, campo na tela, coluna no CSV)
   * continua genérico por `pergunta.outro` e volta a funcionar se uma pergunta ganhar `outro: OUTRO`.
   */
  const OUTRO = "Outro";
  /** Teto das respostas abertas. Folgado para um desabafo, curto para não virar redação. */
  const MAX_TEXTO = 1000;
  /** Teto do complemento de "Outro". */
  const MAX_OUTRO = 200;
  /** Menos que isto no complemento de "Outro" não diz nada ("a", "."). */
  const MIN_OUTRO = 2;

  /* ================================================================== */
  /* Perfis — a pergunta 1 decide quais blocos condicionais aparecem.   */
  /* ================================================================== */

  // Quatro perfis, por decisão do cliente: "Estudante da área da saúde" e "Outro" saíram. Cada perfil
  // tem um bloco próprio na etapa 9 e leva a uma página de obrigado (js/obrigado-config.js).
  const PERFIL = Object.freeze({
    auxiliar: "Auxiliar ou antiga atendente de enfermagem",
    cuidador: "Cuidador(a)",
    tecnico: "Técnico(a) de enfermagem",
    enfermeiro: "Enfermeiro(a)"
  });

  /**
   * Valor interno de cada perfil, sem acento, para CRM, automações e o n8n: o rótulo da tela pode
   * mudar de texto, o código não. `segmento` é a etiqueta de público no CRM.
   */
  const PERFIL_CODIGO = Object.freeze({
    [PERFIL.auxiliar]: "auxiliar_atendente",
    [PERFIL.cuidador]: "cuidador",
    [PERFIL.tecnico]: "tecnico_enfermagem",
    [PERFIL.enfermeiro]: "enfermeiro"
  });
  const PERFIL_SEGMENTO = Object.freeze({
    [PERFIL.auxiliar]: "PERFIL_AUXILIAR_ATENDENTE",
    [PERFIL.cuidador]: "PERFIL_CUIDADOR",
    [PERFIL.tecnico]: "PERFIL_TECNICO",
    [PERFIL.enfermeiro]: "PERFIL_ENFERMEIRO"
  });

  /** Como o perfil aparece no meio de uma frase ("perguntas só pra quem é ..."). */
  const PERFIL_NA_FRASE = Object.freeze({
    [PERFIL.auxiliar]: "auxiliar ou atendente de enfermagem",
    [PERFIL.cuidador]: "cuidador(a)",
    [PERFIL.tecnico]: "técnico(a) de enfermagem",
    [PERFIL.enfermeiro]: "enfermeiro(a)"
  });

  /**
   * GRUPOS de perfil, para automação de fora que NÃO separa duas profissões — hoje o ManyChat, no
   * Instagram, pergunta só "enfermagem" (técnica e enfermeira caem no mesmo fluxo dele).
   *
   * Ficam fora de PERFIL e de PERFIL_CODIGO de propósito: a pergunta 1 da pesquisa continua com
   * quatro opções e o painel continua com quatro cartões. O grupo existe só para NÃO inventar
   * informação — quem disse "enfermagem" não disse qual das duas, e gravar "Técnico(a) de
   * enfermagem" para uma enfermeira erraria o CRM em silêncio.
   */
  const PERFIL_GRUPO = Object.freeze({
    enfermagem: Object.freeze({
      codigo: "enfermagem",
      rotulo: "Enfermagem (técnica ou enfermeira)",
      curto: "Enfermagem (sem separar)",
      segmento: "PERFIL_ENFERMAGEM",
      perfis: Object.freeze([PERFIL.tecnico, PERFIL.enfermeiro])
    })
  });

  const GRUPO_POR_ROTULO = Object.freeze(
    Object.fromEntries(Object.values(PERFIL_GRUPO).map((grupo) => [grupo.rotulo, grupo]))
  );

  /** O grupo de um rótulo gravado no banco ("Enfermagem (técnica ou enfermeira)"), ou null. */
  function grupoDoRotulo(rotulo) {
    return typeof rotulo === "string" && Object.prototype.hasOwnProperty.call(GRUPO_POR_ROTULO, rotulo)
      ? GRUPO_POR_ROTULO[rotulo]
      : null;
  }

  /** O grupo de um código interno ("enfermagem"), ou null. */
  function grupoDoCodigo(codigo) {
    return typeof codigo === "string" && Object.prototype.hasOwnProperty.call(PERFIL_GRUPO, codigo)
      ? PERFIL_GRUPO[codigo]
      : null;
  }

  /**
   * Código interno de um perfil gravado, seja uma das quatro profissões ou um grupo. É o que sai
   * para o UnniChat, o ManyChat, o n8n e o CRM.
   */
  function codigoDoPerfil(rotulo) {
    if (typeof rotulo !== "string") return null;
    if (Object.prototype.hasOwnProperty.call(PERFIL_CODIGO, rotulo)) return PERFIL_CODIGO[rotulo];
    const grupo = grupoDoRotulo(rotulo);
    return grupo ? grupo.codigo : null;
  }

  /** Etiqueta de CRM de um perfil gravado (profissão ou grupo). */
  function segmentoDoPerfil(rotulo) {
    if (typeof rotulo !== "string") return null;
    if (Object.prototype.hasOwnProperty.call(PERFIL_SEGMENTO, rotulo)) return PERFIL_SEGMENTO[rotulo];
    const grupo = grupoDoRotulo(rotulo);
    return grupo ? grupo.segmento : null;
  }

  /** Rótulo curto para abas, cartões e gráficos do painel. */
  const PERFIL_CURTO = Object.freeze({
    [PERFIL.auxiliar]: "Auxiliares e antigas atendentes",
    [PERFIL.cuidador]: "Cuidadores",
    [PERFIL.tecnico]: "Técnicos de enfermagem",
    [PERFIL.enfermeiro]: "Enfermeiros"
  });

  /* ================================================================== */
  /* Estados e regiões                                                   */
  /* ================================================================== */

  const ESTADOS = Object.freeze([
    { nome: "Acre", uf: "AC", regiao: "Norte" },
    { nome: "Alagoas", uf: "AL", regiao: "Nordeste" },
    { nome: "Amapá", uf: "AP", regiao: "Norte" },
    { nome: "Amazonas", uf: "AM", regiao: "Norte" },
    { nome: "Bahia", uf: "BA", regiao: "Nordeste" },
    { nome: "Ceará", uf: "CE", regiao: "Nordeste" },
    { nome: "Distrito Federal", uf: "DF", regiao: "Centro-Oeste" },
    { nome: "Espírito Santo", uf: "ES", regiao: "Sudeste" },
    { nome: "Goiás", uf: "GO", regiao: "Centro-Oeste" },
    { nome: "Maranhão", uf: "MA", regiao: "Nordeste" },
    { nome: "Mato Grosso", uf: "MT", regiao: "Centro-Oeste" },
    { nome: "Mato Grosso do Sul", uf: "MS", regiao: "Centro-Oeste" },
    { nome: "Minas Gerais", uf: "MG", regiao: "Sudeste" },
    { nome: "Pará", uf: "PA", regiao: "Norte" },
    { nome: "Paraíba", uf: "PB", regiao: "Nordeste" },
    { nome: "Paraná", uf: "PR", regiao: "Sul" },
    { nome: "Pernambuco", uf: "PE", regiao: "Nordeste" },
    { nome: "Piauí", uf: "PI", regiao: "Nordeste" },
    { nome: "Rio de Janeiro", uf: "RJ", regiao: "Sudeste" },
    { nome: "Rio Grande do Norte", uf: "RN", regiao: "Nordeste" },
    { nome: "Rio Grande do Sul", uf: "RS", regiao: "Sul" },
    { nome: "Rondônia", uf: "RO", regiao: "Norte" },
    { nome: "Roraima", uf: "RR", regiao: "Norte" },
    { nome: "Santa Catarina", uf: "SC", regiao: "Sul" },
    { nome: "São Paulo", uf: "SP", regiao: "Sudeste" },
    { nome: "Sergipe", uf: "SE", regiao: "Nordeste" },
    { nome: "Tocantins", uf: "TO", regiao: "Norte" }
  ]);

  const REGIOES = Object.freeze(["Norte", "Nordeste", "Centro-Oeste", "Sudeste", "Sul"]);

  /* ================================================================== */
  /* Etapas — a "Estrutura sugerida de etapas" do documento da pesquisa. */
  /* `fala` é a frase curta da Escola que abre cada etapa, no tom de     */
  /* conversa. {nome} vira o primeiro nome; {perfil}, o perfil na frase. */
  /* ================================================================== */

  const ETAPAS = Object.freeze([
    { n: 1, titulo: "Sobre você", fala: "Pra começar, a gente quer te conhecer um pouquinho, {nome}." },
    { n: 2, titulo: "Seu momento profissional", fala: "Agora conta pra gente como está o seu trabalho hoje." },
    {
      n: 3,
      titulo: "Suas dificuldades",
      fala: "Essa parte é muito importante. Responda com sinceridade: aqui ninguém julga ninguém."
    },
    { n: 4, titulo: "Onde você quer chegar", fala: "Agora vamos falar do futuro que você quer construir, {nome}." },
    { n: 5, titulo: "Cursos e investimento", fala: "Passamos da metade! Agora, sobre cursos e formações." },
    { n: 6, titulo: "Como você prefere aprender", fala: "A gente quer montar as aulas do jeito que funciona pra você." },
    {
      n: 7,
      titulo: "Conteúdo e relacionamento com a Iza",
      fala: "Falta pouco! Conta pra gente onde você acompanha conteúdo de enfermagem."
    },
    {
      n: 8,
      titulo: "Perguntas abertas",
      fala: "Estas são abertas e opcionais, mas são as respostas que a gente mais lê com carinho."
    },
    {
      n: 9,
      titulo: "Perguntas específicas do seu perfil",
      fala: "Pra fechar, {nome}, algumas perguntas só pra quem é {perfil}."
    }
  ]);

  /* ================================================================== */
  /* Perguntas, na ordem em que aparecem.                                */
  /*                                                                     */
  /*   id          chave em `respostas` (e no CSV, e nas funções do SQL) */
  /*   numero      como o documento da pesquisa numera (1 a 31, A1..D2)  */
  /*   etapa       1 a 9                                                 */
  /*   tipo        unica | multipla | lista | escala | texto | frase     */
  /*   analise     rótulo curto para painel e cabeçalho do CSV           */
  /*   outro       alternativa que abre o campo "qual?" (<id>_outro);    */
  /*               hoje nenhuma pergunta tem (decisão do cliente)        */
  /*   exclusivas  em `multipla`, alternativas que não combinam com as   */
  /*               outras: marcar uma desmarca o resto                   */
  /*   visivelSe   { pergunta, valores }: só aparece se a resposta dada  */
  /*               àquela pergunta estiver na lista                      */
  /*   nota        observação interna do documento; só o painel mostra  */
  /* ================================================================== */

  const somente = (...perfis) => ({ pergunta: "perfil", valores: perfis });

  const PERGUNTAS = Object.freeze(
    [
      /* ---------------------------------------------- Etapa 1 — Sobre você */
      {
        id: "perfil",
        numero: "1",
        etapa: 1,
        tipo: "unica",
        obrigatoria: true,
        analise: "Perfil profissional",
        texto: "Qual dessas opções representa melhor sua situação profissional atualmente?",
        opcoes: [
          PERFIL.auxiliar,
          PERFIL.cuidador,
          PERFIL.tecnico,
          PERFIL.enfermeiro
        ],
        nota: "Pergunta principal de segmentação: decide quais perguntas específicas (blocos A a D) aparecem."
      },
      {
        id: "idade",
        numero: "2",
        etapa: 1,
        tipo: "unica",
        obrigatoria: true,
        analise: "Idade",
        texto: "Qual é a sua idade?",
        opcoes: ["Até 24 anos", "25 a 34 anos", "35 a 44 anos", "45 a 54 anos", "55 anos ou mais"]
      },
      {
        id: "estado",
        numero: "3",
        etapa: 1,
        tipo: "lista",
        obrigatoria: true,
        analise: "Estado",
        texto: "Em qual estado você mora?",
        placeholder: "Selecione o seu estado",
        opcoes: ESTADOS.map((estado) => estado.nome)
      },
      {
        id: "localidade",
        numero: "4",
        etapa: 1,
        tipo: "unica",
        obrigatoria: true,
        analise: "Onde mora",
        texto: "Você mora em:",
        opcoes: ["Capital", "Região metropolitana", "Cidade do interior", "Zona rural"]
      },
      {
        id: "tempo_area",
        numero: "5",
        etapa: 1,
        tipo: "unica",
        obrigatoria: true,
        analise: "Tempo na área da saúde",
        texto: "Há quanto tempo você atua ou tem contato com a área da saúde?",
        opcoes: ["Ainda não atuo", "Menos de 1 ano", "1 a 3 anos", "4 a 6 anos", "7 a 10 anos", "Mais de 10 anos"],
        nota:
          "Só para análise de ICP. No fluxo comercial de aferição, o tempo de experiência não deve impedir auxiliares ou antigas atendentes de avançarem para a aula."
      },

      /* ------------------------------ Etapa 2 — Seu momento profissional */
      {
        id: "situacao_profissional",
        numero: "6",
        etapa: 2,
        tipo: "unica",
        obrigatoria: true,
        analise: "Situação profissional",
        texto: "Qual é a sua situação profissional atualmente?",
        opcoes: [
          "Trabalho com carteira assinada",
          "Trabalho como PJ",
          "Trabalho como autônomo(a)",
          "Trabalho por plantões",
          "Trabalho informalmente",
          "Estou desempregado(a)",
          "Estou estudando",
          "Estou afastado(a) da profissão"
        ]
      },
      {
        id: "trabalha_saude",
        numero: "7",
        etapa: 2,
        tipo: "unica",
        obrigatoria: true,
        analise: "Trabalha na saúde hoje",
        texto: "Hoje você trabalha diretamente na área da saúde?",
        opcoes: ["Sim, exclusivamente", "Sim, mas também tenho outra atividade", "Não, mas já trabalhei", "Nunca trabalhei"]
      },
      {
        id: "ambientes",
        numero: "8",
        etapa: 2,
        tipo: "multipla",
        obrigatoria: true,
        analise: "Ambientes de trabalho",
        texto: "Em qual ambiente você trabalha ou gostaria de trabalhar?",
        opcoes: [
          "Hospital",
          "Clínica",
          "UPA / pronto atendimento",
          "UBS / posto de saúde",
          "Home care",
          "Casa de repouso / instituição de longa permanência",
          "Atendimento particular",
          "Cuidado de familiares",
          "Ainda não sei"
        ],
        exclusivas: ["Ainda não sei"]
      },
      {
        id: "renda_atual",
        numero: "9",
        etapa: 2,
        tipo: "unica",
        obrigatoria: true,
        analise: "Renda atual",
        texto: "Aproximadamente quanto você recebe por mês atualmente?",
        opcoes: [
          "Até R$ 1.500",
          "R$ 1.501 a R$ 2.500",
          "R$ 2.501 a R$ 3.500",
          "R$ 3.501 a R$ 5.000",
          "R$ 5.001 a R$ 7.500",
          "Acima de R$ 7.500",
          "Prefiro não responder"
        ]
      },

      /* ------------------------------------- Etapa 3 — Suas dificuldades */
      {
        id: "maior_dificuldade",
        numero: "10",
        etapa: 3,
        tipo: "unica",
        obrigatoria: true,
        analise: "Maior dificuldade",
        texto: "Qual é hoje a sua MAIOR dificuldade profissional?",
        opcoes: [
          "Falta de conhecimento prático",
          "Medo de cometer erros",
          "Insegurança durante os plantões",
          "Dificuldade para conseguir emprego",
          "Baixo salário",
          "Falta de reconhecimento",
          "Falta de experiência",
          "Dificuldade com procedimentos ou dispositivos",
          "Não saber como crescer profissionalmente",
          "Falta de formação ou certificação"
        ]
      },
      {
        id: "situacao_incomoda",
        numero: "11",
        etapa: 3,
        tipo: "unica",
        obrigatoria: true,
        analise: "Situação que mais incomoda",
        texto: "Qual dessas situações mais incomoda você atualmente?",
        opcoes: [
          "Trabalho muito e ganho pouco",
          "Tenho conhecimento, mas não sou valorizado(a)",
          "Tenho medo de assumir determinadas responsabilidades",
          "Não consigo boas oportunidades",
          "Sinto que minha carreira está parada",
          "Preciso me qualificar, mas não sei por onde começar",
          "Quero mudar de área dentro da saúde",
          "Não me sinto preparado(a) para situações de emergência"
        ]
      },
      {
        id: "seguranca",
        numero: "12",
        etapa: 3,
        tipo: "escala",
        obrigatoria: true,
        analise: "Segurança profissional (0 a 10)",
        texto: "De 0 a 10, quanto você se sente seguro(a) para exercer sua profissão atualmente?",
        min: 0,
        max: 10,
        legendaMin: "Extremamente inseguro(a)",
        legendaMax: "Totalmente seguro(a)"
      },
      {
        id: "inseguranca_situacoes",
        numero: "13",
        etapa: 3,
        tipo: "multipla",
        obrigatoria: true,
        analise: "Situações que geram insegurança",
        texto: "Qual situação mais gera insegurança para você?",
        opcoes: [
          "Procedimentos",
          "Medicamentos",
          "Dispositivos",
          "Intercorrências ou emergências",
          "Comunicação com familiares",
          "Comunicação com equipe médica",
          "Liderança de equipe",
          "Cuidado domiciliar",
          "Cuidado com idosos",
          "Pacientes dependentes",
          "Pessoas com autismo"
        ]
      },

      /* --------------------------------- Etapa 4 — Onde você quer chegar */
      {
        id: "objetivo_12m",
        numero: "14",
        etapa: 4,
        tipo: "unica",
        obrigatoria: true,
        analise: "Objetivo em 12 meses",
        texto:
          "Qual seria a principal mudança que você gostaria de conquistar profissionalmente nos próximos 12 meses?",
        opcoes: [
          "Ganhar mais",
          "Conseguir meu primeiro emprego na área",
          "Conseguir um emprego melhor",
          "Sentir mais segurança trabalhando",
          "Me tornar técnico(a) de enfermagem",
          "Trabalhar em hospital",
          "Trabalhar com home care",
          "Trabalhar como cuidador(a)",
          "Abrir meu próprio negócio ou atendimento",
          "Me especializar",
          "Assumir posição de liderança"
        ]
      },
      {
        id: "renda_desejada",
        numero: "15",
        etapa: 4,
        tipo: "unica",
        obrigatoria: true,
        analise: "Renda desejada",
        texto: "Quanto você gostaria de ganhar mensalmente trabalhando na área da saúde?",
        opcoes: [
          "Até R$ 3.000",
          "R$ 3.001 a R$ 5.000",
          "R$ 5.001 a R$ 7.000",
          "R$ 7.001 a R$ 10.000",
          "Mais de R$ 10.000"
        ]
      },
      {
        id: "evolucao_carreira",
        numero: "16",
        etapa: 4,
        tipo: "unica",
        obrigatoria: true,
        analise: "O que seria evoluir na carreira",
        texto: "O que mais faria você sentir que sua carreira evoluiu?",
        opcoes: [
          "Aumento de salário",
          "Reconhecimento profissional",
          "Mais segurança técnica",
          "Uma nova formação",
          "Conseguir um emprego melhor",
          "Ter mais liberdade de horários",
          "Trabalhar por conta própria",
          "Poder cuidar melhor dos pacientes",
          "Ser referência na minha área"
        ]
      },

      /* --------------------------------- Etapa 5 — Cursos e investimento */
      {
        id: "frequencia_investimento",
        numero: "17",
        etapa: 5,
        tipo: "unica",
        obrigatoria: true,
        analise: "Frequência de investimento em cursos",
        texto: "Você costuma investir em cursos ou capacitações profissionais?",
        opcoes: ["Sim, várias vezes ao ano", "Sim, uma ou duas vezes por ano", "Raramente", "Nunca investi"]
      },
      {
        id: "maior_investimento",
        numero: "18",
        etapa: 5,
        tipo: "unica",
        obrigatoria: true,
        analise: "Ticket já investido",
        texto: "Quanto você já investiu no curso ou formação mais caro que comprou?",
        opcoes: [
          "Nunca comprei",
          "Até R$ 100",
          "R$ 101 a R$ 300",
          "R$ 301 a R$ 500",
          "R$ 501 a R$ 1.000",
          "R$ 1.001 a R$ 2.000",
          "Mais de R$ 2.000"
        ]
      },
      {
        id: "disposicao_investimento",
        numero: "19",
        etapa: 5,
        tipo: "unica",
        obrigatoria: true,
        analise: "Ticket disposto a investir",
        texto:
          "Quanto você estaria disposto(a) a investir em uma formação que realmente pudesse melhorar sua carreira e renda?",
        opcoes: [
          "Até R$ 100",
          "R$ 101 a R$ 300",
          "R$ 301 a R$ 500",
          "R$ 501 a R$ 1.000",
          "R$ 1.001 a R$ 2.000",
          "Mais de R$ 2.000",
          "Dependeria do resultado que a formação proporciona"
        ]
      },
      {
        id: "criterio_compra",
        numero: "20",
        etapa: 5,
        tipo: "unica",
        obrigatoria: true,
        analise: "O que mais pesa na compra",
        texto: "O que mais pesa na sua decisão de comprar um curso?",
        opcoes: [
          "Preço",
          "Possibilidade de parcelamento",
          "Certificado",
          "Reconhecimento da instituição",
          "Experiência do professor",
          "Conteúdo prático",
          "Depoimentos de outros alunos",
          "Possibilidade de conseguir emprego",
          "Possibilidade de aumentar minha renda",
          "Suporte durante o curso"
        ]
      },
      {
        id: "objecoes",
        numero: "21",
        etapa: 5,
        tipo: "multipla",
        obrigatoria: true,
        analise: "Objeções de compra",
        texto: "O que normalmente impede você de comprar uma formação?",
        opcoes: [
          "Falta de dinheiro",
          "Medo de não conseguir pagar",
          "Falta de tempo",
          "Medo de comprar e não aprender",
          "Já comprei cursos que não funcionaram",
          "Não sei se o certificado terá valor",
          "Não sei se realmente conseguirei trabalhar na área",
          "Preciso conversar com meu marido, esposa ou família",
          "Não confio em cursos on-line",
          "Nada me impede se eu enxergar valor"
        ],
        exclusivas: ["Nada me impede se eu enxergar valor"]
      },

      /* ---------------------------- Etapa 6 — Como você prefere aprender */
      {
        id: "formato_aprendizado",
        numero: "22",
        etapa: 6,
        tipo: "multipla",
        obrigatoria: true,
        analise: "Formato de aprendizado preferido",
        texto: "Como você prefere aprender?",
        opcoes: [
          "Aulas gravadas",
          "Aulas ao vivo",
          "Presencialmente",
          "Mistura de aulas gravadas e ao vivo",
          "Material escrito ou apostilas",
          "Aulas práticas",
          "Mentoria ou acompanhamento"
        ]
      },
      {
        id: "tempo_estudo",
        numero: "23",
        etapa: 6,
        tipo: "unica",
        obrigatoria: true,
        analise: "Tempo de estudo por semana",
        texto: "Quanto tempo você conseguiria dedicar aos estudos por semana?",
        opcoes: ["Menos de 1 hora", "1 a 3 horas", "4 a 6 horas", "7 a 10 horas", "Mais de 10 horas"]
      },
      {
        id: "periodo_estudo",
        numero: "24",
        etapa: 6,
        tipo: "multipla",
        obrigatoria: true,
        analise: "Período de estudo",
        texto: "Em qual período você normalmente consegue estudar?",
        opcoes: ["Manhã", "Tarde", "Noite", "Madrugada", "Finais de semana", "Varia conforme meus plantões"]
      },

      /* ---------------- Etapa 7 — Conteúdo e relacionamento com a Iza */
      {
        id: "fontes_informacao",
        numero: "25",
        etapa: 7,
        tipo: "multipla",
        obrigatoria: true,
        analise: "Onde busca informação",
        texto: "Onde você mais busca informações sobre enfermagem e saúde?",
        opcoes: [
          "Instagram",
          "TikTok",
          "YouTube",
          "Facebook",
          "Google",
          "WhatsApp",
          "Telegram",
          "Cursos",
          "Colegas de profissão"
        ]
      },
      {
        id: "tipos_conteudo",
        numero: "26",
        etapa: 7,
        tipo: "multipla",
        obrigatoria: true,
        analise: "Conteúdo que chama atenção",
        texto: "Que tipo de conteúdo mais chama sua atenção?",
        opcoes: [
          "Técnicas e procedimentos",
          "Casos reais",
          "Erros comuns",
          "Conteúdo sobre carreira",
          "Salários e oportunidades",
          "Concursos",
          "Empregos",
          "Home care",
          "Cuidados com idosos",
          "Autismo",
          "Emergências",
          "Dispositivos",
          "Histórias de transformação"
        ]
      },
      {
        id: "como_conheceu",
        numero: "27",
        etapa: 7,
        tipo: "unica",
        obrigatoria: true,
        analise: "Como conheceu a Iza",
        texto: "Como você conheceu a Iza Gonçalves?",
        opcoes: [
          "Instagram",
          "Facebook",
          "TikTok",
          "YouTube",
          "Anúncio",
          "Indicação",
          "WhatsApp",
          "Evento ou aula",
          "Já fui aluno(a)"
        ]
      },
      {
        id: "tempo_acompanha",
        numero: "28",
        etapa: 7,
        tipo: "unica",
        obrigatoria: true,
        analise: "Tempo acompanhando a Iza",
        texto: "Há quanto tempo você acompanha a Iza?",
        opcoes: ["Conheci agora", "Menos de 1 mês", "1 a 3 meses", "3 a 6 meses", "6 meses a 1 ano", "Mais de 1 ano"]
      },

      /* ------------------------------------ Etapa 8 — Perguntas abertas */
      {
        id: "problema_unico",
        numero: "29",
        etapa: 8,
        tipo: "texto",
        obrigatoria: false,
        analise: "O único problema que resolveria",
        texto: "Se você pudesse resolver apenas UM problema da sua vida profissional hoje, qual seria?",
        placeholder: "Escreva do seu jeito..."
      },
      {
        id: "sonho",
        numero: "30",
        etapa: 8,
        tipo: "texto",
        obrigatoria: false,
        analise: "Maior sonho profissional",
        texto: "Qual é o seu maior sonho profissional dentro da enfermagem ou do cuidado?",
        placeholder: "Pode sonhar alto..."
      },
      {
        id: "frase",
        numero: "31",
        etapa: 8,
        tipo: "frase",
        obrigatoria: false,
        analise: "Complete a frase",
        texto: "Complete a frase:",
        partes: [
          { id: "frase_desejo", antes: "Eu gostaria muito de", placeholder: "o que você quer conquistar" },
          { id: "frase_bloqueio", antes: "mas ainda não consegui porque", placeholder: "o que está te travando" }
        ]
      },

      /* ------------------ Etapa 9 — Perguntas específicas do seu perfil */

      /* A. Auxiliar ou antiga atendente de enfermagem */
      {
        id: "auxiliar_situacao",
        numero: "A1",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Auxiliar: situação atual",
        texto: "Qual dessas situações representa você atualmente?",
        opcoes: [
          "Trabalho atualmente como auxiliar ou atendente",
          "Já trabalhei, mas não trabalho mais",
          "Estou procurando oportunidade",
          "Gostaria de me tornar técnico(a) de enfermagem"
        ],
        visivelSe: somente(PERFIL.auxiliar)
      },
      {
        id: "auxiliar_documentos",
        numero: "A2",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Auxiliar: documentos que comprovam a atuação",
        texto: "Você possui documentos que comprovem que já trabalhou na área?",
        opcoes: ["Sim", "Tenho alguns documentos", "Não sei", "Não possuo"],
        visivelSe: somente(PERFIL.auxiliar),
        nota: "Não usar esta resposta para impedir o avanço para a aula de aferição. Serve só para mapear o perfil."
      },

      /* B. Cuidador(a) */
      {
        id: "cuidador_realidade",
        numero: "B1",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Cuidador: realidade",
        texto: "Qual dessas opções representa melhor sua realidade?",
        opcoes: [
          "Trabalho profissionalmente como cuidador(a)",
          "Cuido de alguém da minha família",
          "Trabalho como cuidador(a) e também cuido de um familiar",
          "Quero começar a trabalhar como cuidador(a)"
        ],
        visivelSe: somente(PERFIL.cuidador)
      },
      {
        id: "cuidador_dificuldade",
        numero: "B2",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Cuidador: maior dificuldade",
        texto: "Qual é sua maior dificuldade como cuidador(a)?",
        opcoes: [
          "Saber o que fazer em uma emergência",
          "Administrar medicamentos",
          "Higiene e banho no leito",
          "Mobilidade do paciente",
          "Alimentação",
          "Dispositivos",
          "Comunicação com a família",
          "Conseguir clientes",
          "Definir quanto cobrar",
          "Sentir segurança cuidando sozinho(a)"
        ],
        visivelSe: somente(PERFIL.cuidador)
      },

      /* C. Técnico(a) de enfermagem */
      {
        id: "tecnico_momento",
        numero: "C1",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Técnico: momento atual",
        texto: "Hoje, qual dessas situações mais representa você?",
        opcoes: [
          "Já trabalho e me sinto seguro(a)",
          "Já trabalho, mas ainda sinto insegurança",
          "Sou formado(a), mas ainda tenho medo de trabalhar",
          "Estou procurando uma oportunidade",
          "Ainda estou fazendo o curso técnico"
        ],
        visivelSe: somente(PERFIL.tecnico)
      },
      {
        id: "tecnico_objetivo",
        numero: "C2",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Técnico: maior objetivo",
        texto: "Qual é seu maior objetivo hoje?",
        opcoes: [
          "Conseguir meu primeiro emprego",
          "Trabalhar em hospital",
          "Trabalhar com home care",
          "Fazer mais plantões",
          "Ganhar mais",
          "Me especializar",
          "Perder o medo dos procedimentos",
          "Me sentir seguro(a) em intercorrências",
          "Empreender na área"
        ],
        visivelSe: somente(PERFIL.tecnico)
      },

      /* D. Enfermeiro(a) */
      {
        id: "enfermeiro_interesse",
        numero: "D1",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Enfermeiro: principal interesse",
        texto: "Qual é o seu principal interesse atualmente?",
        opcoes: [
          "Atualização prática e procedimentos",
          "Liderança e supervisão de equipes",
          "Home care e cuidado domiciliar",
          "Formação e capacitação profissional",
          "Cuidado de idosos e pessoas com autismo"
        ],
        visivelSe: somente(PERFIL.enfermeiro)
      },
      {
        id: "enfermeiro_caminho",
        numero: "D2",
        etapa: 9,
        tipo: "unica",
        obrigatoria: true,
        analise: "Enfermeiro: caminho profissional",
        texto: "Qual caminho profissional mais interessa a você hoje?",
        opcoes: [
          "Assistência",
          "Gestão ou liderança",
          "Home care",
          "Educação ou treinamentos",
          "Empreendedorismo",
          "Especialização",
          "Atendimento particular",
          "Ainda estou decidindo"
        ],
        visivelSe: somente(PERFIL.enfermeiro)
      }
    ].map((pergunta) => Object.freeze(pergunta))
  );

  /**
   * As variáveis que o documento pede para cruzar ("DADOS IMPORTANTES PARA ANÁLISE POSTERIOR"),
   * na ordem do documento. É daqui que o painel monta o cartão de ICP de cada perfil.
   */
  const ICP_VARIAVEIS = Object.freeze([
    "idade",
    "estado",
    "localidade",
    "situacao_profissional",
    "renda_atual",
    "maior_dificuldade",
    "inseguranca_situacoes",
    "seguranca",
    "objetivo_12m",
    "renda_desejada",
    "maior_investimento",
    "disposicao_investimento",
    "objecoes",
    "formato_aprendizado",
    "fontes_informacao",
    "como_conheceu",
    "tempo_acompanha"
  ]);

  /* ================================================================== */
  /* Índices                                                             */
  /* ================================================================== */

  const POR_ID = new Map(PERGUNTAS.map((pergunta) => [pergunta.id, pergunta]));
  const ESTADO_POR_NOME = new Map(ESTADOS.map((estado) => [estado.nome, estado]));

  function perguntaPorId(id) {
    return POR_ID.get(id) || null;
  }

  function etapaPorNumero(n) {
    return ETAPAS.find((etapa) => etapa.n === n) || null;
  }

  function chaveOutro(pergunta) {
    return `${pergunta.id}_outro`;
  }

  /** Todas as chaves que uma pergunta pode escrever em `respostas`. */
  function chavesDaPergunta(pergunta) {
    if (pergunta.tipo === "frase") return pergunta.partes.map((parte) => parte.id);
    return pergunta.outro ? [pergunta.id, chaveOutro(pergunta)] : [pergunta.id];
  }

  /** Chaves de texto livre: perguntas abertas, partes da frase e complementos de "Outro" (hoje nenhum). */
  function chavesTexto() {
    const chaves = [];
    for (const pergunta of PERGUNTAS) {
      if (pergunta.tipo === "texto") chaves.push(pergunta.id);
      else if (pergunta.tipo === "frase") chaves.push(...pergunta.partes.map((parte) => parte.id));
      if (pergunta.outro) chaves.push(chaveOutro(pergunta));
    }
    return chaves;
  }

  /** Perguntas que dá para contar e cruzar (tudo menos texto livre). */
  function perguntasAnalisaveis() {
    return PERGUNTAS.filter((pergunta) => pergunta.tipo !== "texto" && pergunta.tipo !== "frase");
  }

  /* ================================================================== */
  /* Visibilidade                                                        */
  /* ================================================================== */

  function estaVisivel(pergunta, respostas) {
    const regra = pergunta.visivelSe;
    if (!regra) return true;
    const valor = respostas ? respostas[regra.pergunta] : undefined;
    return typeof valor === "string" && regra.valores.includes(valor);
  }

  function perguntasVisiveis(respostas) {
    const r = respostas || {};
    return PERGUNTAS.filter((pergunta) => estaVisivel(pergunta, r));
  }

  /** Etapas que têm pelo menos uma pergunta visível, em ordem ("Etapa 3 de 8"). */
  function etapasVisiveis(respostas) {
    const numeros = new Set(perguntasVisiveis(respostas).map((pergunta) => pergunta.etapa));
    return ETAPAS.filter((etapa) => numeros.has(etapa.n));
  }

  /* ================================================================== */
  /* Limpeza e validação dos valores                                     */
  /* ================================================================== */

  function textoLimpo(valor, maximo) {
    if (typeof valor !== "string") return undefined;
    // Normaliza quebras de linha e tira caracteres de controle, que não têm o que fazer numa resposta.
    const limpo = valor
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .trim()
      .slice(0, maximo)
      .trim();
    return limpo || undefined;
  }

  /**
   * O valor de uma pergunta, validado contra a própria pergunta. Devolve undefined quando não serve
   * — alternativa que não existe, número fora da escala, lista vazia — e quem chama descarta.
   */
  function valorValido(pergunta, valor) {
    switch (pergunta.tipo) {
      case "unica":
      case "lista":
        return typeof valor === "string" && pergunta.opcoes.includes(valor) ? valor : undefined;

      case "multipla": {
        if (!Array.isArray(valor)) return undefined;
        const marcadas = new Set(valor.filter((item) => typeof item === "string"));
        // Ordem canônica (a da pergunta), sem repetição: o mesmo conjunto de marcações vira sempre
        // o mesmo valor, na tela, no banco e no CSV.
        let lista = pergunta.opcoes.filter((opcao) => marcadas.has(opcao));
        // Exclusiva junto com outras é estado impossível pela tela. Se chegar assim, ficam as
        // outras, que dizem mais do que "ainda não sei".
        const exclusivas = pergunta.exclusivas || [];
        if (lista.length > 1 && lista.some((opcao) => exclusivas.includes(opcao))) {
          lista = lista.filter((opcao) => !exclusivas.includes(opcao));
        }
        return lista.length ? lista : undefined;
      }

      case "escala": {
        const numero = typeof valor === "string" && valor.trim() !== "" ? Number(valor) : valor;
        return Number.isInteger(numero) && numero >= pergunta.min && numero <= pergunta.max ? numero : undefined;
      }

      case "texto":
        return textoLimpo(valor, MAX_TEXTO);

      default:
        return undefined;
    }
  }

  function outroMarcado(pergunta, respostas) {
    if (!pergunta.outro) return false;
    const valor = respostas[pergunta.id];
    return Array.isArray(valor) ? valor.includes(pergunta.outro) : valor === pergunta.outro;
  }

  /**
   * Tira de `respostas` tudo o que não vale mais: resposta de pergunta que deixou de aparecer
   * (trocou o perfil de Técnico para Cuidador, as do bloco C somem) e complemento de "Outro"
   * quando o "Outro" foi desmarcado. Sem isto o relatório diria que uma cuidadora respondeu
   * perguntas de técnica.
   */
  function limparOrfas(respostas) {
    const entrada = respostas || {};
    const saida = {};
    for (const pergunta of perguntasVisiveis(entrada)) {
      for (const chave of chavesDaPergunta(pergunta)) {
        if (!Object.prototype.hasOwnProperty.call(entrada, chave)) continue;
        if (chave === chaveOutro(pergunta) && !outroMarcado(pergunta, entrada)) continue;
        saida[chave] = entrada[chave];
      }
    }
    return saida;
  }

  /**
   * Recebe respostas cruas (do navegador, de um rascunho antigo, de qualquer lugar) e devolve só
   * o que é válido: chave conhecida, valor dentro das alternativas, texto aparado e com teto,
   * sem órfãs. É a mesma função no navegador e no servidor.
   */
  function sanitizar(entrada) {
    const bruto = entrada && typeof entrada === "object" && !Array.isArray(entrada) ? entrada : {};
    const limpo = {};

    for (const pergunta of PERGUNTAS) {
      if (pergunta.tipo === "frase") {
        for (const parte of pergunta.partes) {
          const texto = textoLimpo(bruto[parte.id], MAX_TEXTO);
          if (texto !== undefined) limpo[parte.id] = texto;
        }
        continue;
      }

      const valor = valorValido(pergunta, bruto[pergunta.id]);
      if (valor !== undefined) limpo[pergunta.id] = valor;

      if (pergunta.outro) {
        const detalhe = textoLimpo(bruto[chaveOutro(pergunta)], MAX_OUTRO);
        if (detalhe !== undefined) limpo[chaveOutro(pergunta)] = detalhe;
      }
    }

    return limparOrfas(limpo);
  }

  /* ================================================================== */
  /* Resposta completa, erro e progresso                                 */
  /* ================================================================== */

  function detalheOutroOk(pergunta, respostas) {
    const detalhe = respostas[chaveOutro(pergunta)];
    return typeof detalhe === "string" && detalhe.trim().length >= MIN_OUTRO;
  }

  /** A pergunta tem resposta aproveitável? "Outro" sem dizer qual não conta. */
  function perguntaRespondida(pergunta, respostas) {
    const r = respostas || {};
    if (pergunta.tipo === "frase") {
      return pergunta.partes.some((parte) => typeof r[parte.id] === "string" && r[parte.id].trim() !== "");
    }
    if (valorValido(pergunta, r[pergunta.id]) === undefined) return false;
    if (outroMarcado(pergunta, r) && !detalheOutroOk(pergunta, r)) return false;
    return true;
  }

  const MENSAGEM_VAZIA = {
    unica: "Escolha uma opção para continuar.",
    lista: "Escolha o seu estado para continuar.",
    multipla: "Escolha pelo menos uma opção para continuar.",
    escala: "Escolha um número de 0 a 10 para continuar.",
    texto: "Escreva sua resposta para continuar.",
    frase: "Complete a frase para continuar."
  };

  /**
   * O que impede de seguir nesta pergunta, em palavras para a tela. Vazio = pode seguir.
   * Pergunta opcional em branco pode seguir; "Outro" sem complemento nunca pode.
   */
  function erroDaPergunta(pergunta, respostas) {
    const r = respostas || {};
    const temAlgo =
      pergunta.tipo === "frase"
        ? pergunta.partes.some((parte) => typeof r[parte.id] === "string" && r[parte.id].trim() !== "")
        : valorValido(pergunta, r[pergunta.id]) !== undefined;

    if (!temAlgo) return pergunta.obrigatoria ? MENSAGEM_VAZIA[pergunta.tipo] : "";
    if (outroMarcado(pergunta, r) && !detalheOutroOk(pergunta, r)) {
      return "Você marcou “Outro”: conta pra gente qual é.";
    }
    return "";
  }

  /**
   * Onde a pessoa está na pesquisa, calculado só a partir das respostas.
   *
   *   total                 perguntas visíveis no caminho dela (depende do perfil)
   *   obrigatorias          quantas dessas são obrigatórias
   *   respondidas           visíveis com resposta aproveitável (inclui abertas)
   *   obrigatoriasRespondidas
   *   percentual            0 a 100, sobre as obrigatórias (as abertas são opcionais e não podem
   *                         impedir ninguém de chegar a 100%)
   *   completa              todas as obrigatórias do caminho respondidas
   */
  function progresso(respostas) {
    const r = respostas || {};
    const visiveis = perguntasVisiveis(r);
    const obrigatorias = visiveis.filter((pergunta) => pergunta.obrigatoria);
    const respondidas = visiveis.filter((pergunta) => perguntaRespondida(pergunta, r)).length;
    const obrigatoriasRespondidas = obrigatorias.filter((pergunta) => perguntaRespondida(pergunta, r)).length;
    // Sem o perfil respondido, o bloco específico ainda não entrou na conta: não dá para dizer
    // que a pesquisa está completa só porque a lista visível ficou menor.
    const perfilOk = perguntaRespondida(POR_ID.get("perfil"), r);
    const completa = perfilOk && obrigatoriasRespondidas === obrigatorias.length;

    return {
      total: visiveis.length,
      obrigatorias: obrigatorias.length,
      respondidas,
      obrigatoriasRespondidas,
      percentual: completa
        ? 100
        : Math.min(99, Math.floor((obrigatoriasRespondidas / Math.max(obrigatorias.length, 1)) * 100)),
      completa
    };
  }

  /** A primeira pergunta visível que ainda impede de concluir (para retomar um rascunho). */
  function primeiraPendente(respostas) {
    const r = respostas || {};
    return perguntasVisiveis(r).find((pergunta) => erroDaPergunta(pergunta, r) !== "") || null;
  }

  /* ================================================================== */
  /* Texto                                                               */
  /* ================================================================== */

  function primeiroNome(nome) {
    const primeiro = String(nome || "").trim().split(/\s+/)[0] || "";
    if (!primeiro) return "";
    return primeiro.charAt(0).toLocaleUpperCase("pt-BR") + primeiro.slice(1).toLocaleLowerCase("pt-BR");
  }

  /**
   * Troca {nome} e {perfil}. Sem nome, a vírgula que o acompanhava some junto (", {nome}." vira
   * "."), para a frase não ficar com um buraco.
   */
  function interpolar(texto, { nome = "", perfil = "" } = {}) {
    const primeiro = primeiroNome(nome);
    let saida = String(texto || "");
    saida = primeiro ? saida.replace(/\{nome\}/g, primeiro) : saida.replace(/,?\s*\{nome\}/g, "");
    saida = saida.replace(/\{perfil\}/g, PERFIL_NA_FRASE[perfil] || "da sua área");
    return saida;
  }

  function regiaoDoEstado(nome) {
    const estado = ESTADO_POR_NOME.get(nome);
    return estado ? estado.regiao : null;
  }

  function ufDoEstado(nome) {
    const estado = ESTADO_POR_NOME.get(nome);
    return estado ? estado.uf : null;
  }

  root.EVPesquisa = Object.freeze({
    ID,
    VERSAO,
    OUTRO,
    MAX_TEXTO,
    MAX_OUTRO,
    MIN_OUTRO,
    PERFIL,
    PERFIL_NA_FRASE,
    PERFIL_CURTO,
    PERFIL_CODIGO,
    PERFIL_SEGMENTO,
    PERFIL_GRUPO,
    grupoDoRotulo,
    grupoDoCodigo,
    codigoDoPerfil,
    segmentoDoPerfil,
    ESTADOS,
    REGIOES,
    ETAPAS,
    PERGUNTAS,
    ICP_VARIAVEIS,
    perguntaPorId,
    etapaPorNumero,
    chaveOutro,
    chavesDaPergunta,
    chavesTexto,
    perguntasAnalisaveis,
    estaVisivel,
    perguntasVisiveis,
    etapasVisiveis,
    valorValido,
    outroMarcado,
    limparOrfas,
    sanitizar,
    perguntaRespondida,
    erroDaPergunta,
    progresso,
    primeiraPendente,
    primeiroNome,
    interpolar,
    regiaoDoEstado,
    ufDoEstado
  });
})(typeof globalThis !== "undefined" ? globalThis : window);
