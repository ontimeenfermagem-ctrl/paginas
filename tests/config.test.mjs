/*
 * js/pesquisa-config.js contra o documento da pesquisa.
 *
 * A lista ESPERADA abaixo foi copiada do documento que o cliente mandou (pesquisa.md: número,
 * enunciado, tipo e alternativas, letra por letra). Ela mora aqui dentro, e não é lida do .md,
 * para o teste rodar em qualquer máquina. Se alguém mexer numa alternativa do config sem mexer
 * no documento (ou o contrário), é aqui que quebra.
 *
 * "Outro": o documento tem essa alternativa em 12 perguntas (1, 8, 10, 11, 13, 14, 21, 25, 26, 27,
 * B2 e C2), mas o cliente decidiu depois que a pesquisa só aceita respostas concretas (SPEC, seção
 * 13). A lista abaixo continua IGUAL ao documento, com "Outro", e o teste compara o config com o
 * documento MENOS "Outro" — assim fica registrado o que o cliente tirou, e mais nada pode sumir.
 *
 * "Estudante da área da saúde": também está no documento (pergunta 1), mas o cliente decidiu depois
 * que a pesquisa tem só 4 perfis — cada um leva a uma página de obrigado (js/obrigado-config.js).
 * Mesma regra do "Outro": a lista abaixo continua igual ao documento, e o teste tira o Estudante.
 *
 * O config roda no MESMO realm do teste (runInThisContext): assim o deepStrictEqual compara só
 * conteúdo, sem tropeçar em protótipo de outro contexto.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

vm.runInThisContext(readFileSync(new URL("../js/pesquisa-config.js", import.meta.url), "utf8"), {
  filename: "js/pesquisa-config.js"
});
const P = globalThis.EVPesquisa;

const AUXILIAR = "Auxiliar ou antiga atendente de enfermagem";
const CUIDADOR = "Cuidador(a)";
const TECNICO = "Técnico(a) de enfermagem";
const ENFERMEIRO = "Enfermeiro(a)";
// Saiu da pergunta 1 por decisão do cliente: um rascunho velho com ele não abre bloco nenhum.
const ESTUDANTE = "Estudante da área da saúde";

// Tipos do documento → tipos do config. "Resposta longa" é "texto"; a 31 ("Complete a frase",
// também "Resposta longa" no documento) virou "frase", com as duas lacunas do modelo do documento.
// `perfil` = "Exibir apenas se a resposta da pergunta 1 for: ...".
const DOCUMENTO = [
  { numero: "1", tipo: "unica", texto: "Qual dessas opções representa melhor sua situação profissional atualmente?", opcoes: ["Auxiliar ou antiga atendente de enfermagem", "Cuidador(a)", "Técnico(a) de enfermagem", "Enfermeiro(a)", "Estudante da área da saúde", "Outro"] },
  { numero: "2", tipo: "unica", texto: "Qual é a sua idade?", opcoes: ["Até 24 anos", "25 a 34 anos", "35 a 44 anos", "45 a 54 anos", "55 anos ou mais"] },
  { numero: "3", tipo: "lista", texto: "Em qual estado você mora?", opcoes: ["Acre", "Alagoas", "Amapá", "Amazonas", "Bahia", "Ceará", "Distrito Federal", "Espírito Santo", "Goiás", "Maranhão", "Mato Grosso", "Mato Grosso do Sul", "Minas Gerais", "Pará", "Paraíba", "Paraná", "Pernambuco", "Piauí", "Rio de Janeiro", "Rio Grande do Norte", "Rio Grande do Sul", "Rondônia", "Roraima", "Santa Catarina", "São Paulo", "Sergipe", "Tocantins"] },
  { numero: "4", tipo: "unica", texto: "Você mora em:", opcoes: ["Capital", "Região metropolitana", "Cidade do interior", "Zona rural"] },
  { numero: "5", tipo: "unica", texto: "Há quanto tempo você atua ou tem contato com a área da saúde?", opcoes: ["Ainda não atuo", "Menos de 1 ano", "1 a 3 anos", "4 a 6 anos", "7 a 10 anos", "Mais de 10 anos"] },
  { numero: "6", tipo: "unica", texto: "Qual é a sua situação profissional atualmente?", opcoes: ["Trabalho com carteira assinada", "Trabalho como PJ", "Trabalho como autônomo(a)", "Trabalho por plantões", "Trabalho informalmente", "Estou desempregado(a)", "Estou estudando", "Estou afastado(a) da profissão"] },
  { numero: "7", tipo: "unica", texto: "Hoje você trabalha diretamente na área da saúde?", opcoes: ["Sim, exclusivamente", "Sim, mas também tenho outra atividade", "Não, mas já trabalhei", "Nunca trabalhei"] },
  { numero: "8", tipo: "multipla", texto: "Em qual ambiente você trabalha ou gostaria de trabalhar?", opcoes: ["Hospital", "Clínica", "UPA / pronto atendimento", "UBS / posto de saúde", "Home care", "Casa de repouso / instituição de longa permanência", "Atendimento particular", "Cuidado de familiares", "Ainda não sei", "Outro"] },
  { numero: "9", tipo: "unica", texto: "Aproximadamente quanto você recebe por mês atualmente?", opcoes: ["Até R$ 1.500", "R$ 1.501 a R$ 2.500", "R$ 2.501 a R$ 3.500", "R$ 3.501 a R$ 5.000", "R$ 5.001 a R$ 7.500", "Acima de R$ 7.500", "Prefiro não responder"] },
  { numero: "10", tipo: "unica", texto: "Qual é hoje a sua MAIOR dificuldade profissional?", opcoes: ["Falta de conhecimento prático", "Medo de cometer erros", "Insegurança durante os plantões", "Dificuldade para conseguir emprego", "Baixo salário", "Falta de reconhecimento", "Falta de experiência", "Dificuldade com procedimentos ou dispositivos", "Não saber como crescer profissionalmente", "Falta de formação ou certificação", "Outro"] },
  { numero: "11", tipo: "unica", texto: "Qual dessas situações mais incomoda você atualmente?", opcoes: ["Trabalho muito e ganho pouco", "Tenho conhecimento, mas não sou valorizado(a)", "Tenho medo de assumir determinadas responsabilidades", "Não consigo boas oportunidades", "Sinto que minha carreira está parada", "Preciso me qualificar, mas não sei por onde começar", "Quero mudar de área dentro da saúde", "Não me sinto preparado(a) para situações de emergência", "Outro"] },
  { numero: "12", tipo: "escala", texto: "De 0 a 10, quanto você se sente seguro(a) para exercer sua profissão atualmente?", legendas: ["extremamente inseguro(a)", "totalmente seguro(a)"] },
  { numero: "13", tipo: "multipla", texto: "Qual situação mais gera insegurança para você?", opcoes: ["Procedimentos", "Medicamentos", "Dispositivos", "Intercorrências ou emergências", "Comunicação com familiares", "Comunicação com equipe médica", "Liderança de equipe", "Cuidado domiciliar", "Cuidado com idosos", "Pacientes dependentes", "Pessoas com autismo", "Outro"] },
  { numero: "14", tipo: "unica", texto: "Qual seria a principal mudança que você gostaria de conquistar profissionalmente nos próximos 12 meses?", opcoes: ["Ganhar mais", "Conseguir meu primeiro emprego na área", "Conseguir um emprego melhor", "Sentir mais segurança trabalhando", "Me tornar técnico(a) de enfermagem", "Trabalhar em hospital", "Trabalhar com home care", "Trabalhar como cuidador(a)", "Abrir meu próprio negócio ou atendimento", "Me especializar", "Assumir posição de liderança", "Outro"] },
  { numero: "15", tipo: "unica", texto: "Quanto você gostaria de ganhar mensalmente trabalhando na área da saúde?", opcoes: ["Até R$ 3.000", "R$ 3.001 a R$ 5.000", "R$ 5.001 a R$ 7.000", "R$ 7.001 a R$ 10.000", "Mais de R$ 10.000"] },
  { numero: "16", tipo: "unica", texto: "O que mais faria você sentir que sua carreira evoluiu?", opcoes: ["Aumento de salário", "Reconhecimento profissional", "Mais segurança técnica", "Uma nova formação", "Conseguir um emprego melhor", "Ter mais liberdade de horários", "Trabalhar por conta própria", "Poder cuidar melhor dos pacientes", "Ser referência na minha área"] },
  { numero: "17", tipo: "unica", texto: "Você costuma investir em cursos ou capacitações profissionais?", opcoes: ["Sim, várias vezes ao ano", "Sim, uma ou duas vezes por ano", "Raramente", "Nunca investi"] },
  { numero: "18", tipo: "unica", texto: "Quanto você já investiu no curso ou formação mais caro que comprou?", opcoes: ["Nunca comprei", "Até R$ 100", "R$ 101 a R$ 300", "R$ 301 a R$ 500", "R$ 501 a R$ 1.000", "R$ 1.001 a R$ 2.000", "Mais de R$ 2.000"] },
  { numero: "19", tipo: "unica", texto: "Quanto você estaria disposto(a) a investir em uma formação que realmente pudesse melhorar sua carreira e renda?", opcoes: ["Até R$ 100", "R$ 101 a R$ 300", "R$ 301 a R$ 500", "R$ 501 a R$ 1.000", "R$ 1.001 a R$ 2.000", "Mais de R$ 2.000", "Dependeria do resultado que a formação proporciona"] },
  { numero: "20", tipo: "unica", texto: "O que mais pesa na sua decisão de comprar um curso?", opcoes: ["Preço", "Possibilidade de parcelamento", "Certificado", "Reconhecimento da instituição", "Experiência do professor", "Conteúdo prático", "Depoimentos de outros alunos", "Possibilidade de conseguir emprego", "Possibilidade de aumentar minha renda", "Suporte durante o curso"] },
  { numero: "21", tipo: "multipla", texto: "O que normalmente impede você de comprar uma formação?", opcoes: ["Falta de dinheiro", "Medo de não conseguir pagar", "Falta de tempo", "Medo de comprar e não aprender", "Já comprei cursos que não funcionaram", "Não sei se o certificado terá valor", "Não sei se realmente conseguirei trabalhar na área", "Preciso conversar com meu marido, esposa ou família", "Não confio em cursos on-line", "Nada me impede se eu enxergar valor", "Outro"] },
  { numero: "22", tipo: "multipla", texto: "Como você prefere aprender?", opcoes: ["Aulas gravadas", "Aulas ao vivo", "Presencialmente", "Mistura de aulas gravadas e ao vivo", "Material escrito ou apostilas", "Aulas práticas", "Mentoria ou acompanhamento"] },
  { numero: "23", tipo: "unica", texto: "Quanto tempo você conseguiria dedicar aos estudos por semana?", opcoes: ["Menos de 1 hora", "1 a 3 horas", "4 a 6 horas", "7 a 10 horas", "Mais de 10 horas"] },
  { numero: "24", tipo: "multipla", texto: "Em qual período você normalmente consegue estudar?", opcoes: ["Manhã", "Tarde", "Noite", "Madrugada", "Finais de semana", "Varia conforme meus plantões"] },
  { numero: "25", tipo: "multipla", texto: "Onde você mais busca informações sobre enfermagem e saúde?", opcoes: ["Instagram", "TikTok", "YouTube", "Facebook", "Google", "WhatsApp", "Telegram", "Cursos", "Colegas de profissão", "Outro"] },
  { numero: "26", tipo: "multipla", texto: "Que tipo de conteúdo mais chama sua atenção?", opcoes: ["Técnicas e procedimentos", "Casos reais", "Erros comuns", "Conteúdo sobre carreira", "Salários e oportunidades", "Concursos", "Empregos", "Home care", "Cuidados com idosos", "Autismo", "Emergências", "Dispositivos", "Histórias de transformação", "Outro"] },
  { numero: "27", tipo: "unica", texto: "Como você conheceu a Iza Gonçalves?", opcoes: ["Instagram", "Facebook", "TikTok", "YouTube", "Anúncio", "Indicação", "WhatsApp", "Evento ou aula", "Já fui aluno(a)", "Outro"] },
  { numero: "28", tipo: "unica", texto: "Há quanto tempo você acompanha a Iza?", opcoes: ["Conheci agora", "Menos de 1 mês", "1 a 3 meses", "3 a 6 meses", "6 meses a 1 ano", "Mais de 1 ano"] },
  { numero: "29", tipo: "texto", texto: "Se você pudesse resolver apenas UM problema da sua vida profissional hoje, qual seria?" },
  { numero: "30", tipo: "texto", texto: "Qual é o seu maior sonho profissional dentro da enfermagem ou do cuidado?" },
  { numero: "31", tipo: "frase", texto: "Complete a frase:", partes: ["Eu gostaria muito de", "mas ainda não consegui porque"] },
  { numero: "A1", tipo: "unica", perfil: AUXILIAR, texto: "Qual dessas situações representa você atualmente?", opcoes: ["Trabalho atualmente como auxiliar ou atendente", "Já trabalhei, mas não trabalho mais", "Estou procurando oportunidade", "Gostaria de me tornar técnico(a) de enfermagem"] },
  { numero: "A2", tipo: "unica", perfil: AUXILIAR, texto: "Você possui documentos que comprovem que já trabalhou na área?", opcoes: ["Sim", "Tenho alguns documentos", "Não sei", "Não possuo"] },
  { numero: "B1", tipo: "unica", perfil: CUIDADOR, texto: "Qual dessas opções representa melhor sua realidade?", opcoes: ["Trabalho profissionalmente como cuidador(a)", "Cuido de alguém da minha família", "Trabalho como cuidador(a) e também cuido de um familiar", "Quero começar a trabalhar como cuidador(a)"] },
  { numero: "B2", tipo: "unica", perfil: CUIDADOR, texto: "Qual é sua maior dificuldade como cuidador(a)?", opcoes: ["Saber o que fazer em uma emergência", "Administrar medicamentos", "Higiene e banho no leito", "Mobilidade do paciente", "Alimentação", "Dispositivos", "Comunicação com a família", "Conseguir clientes", "Definir quanto cobrar", "Sentir segurança cuidando sozinho(a)", "Outro"] },
  { numero: "C1", tipo: "unica", perfil: TECNICO, texto: "Hoje, qual dessas situações mais representa você?", opcoes: ["Já trabalho e me sinto seguro(a)", "Já trabalho, mas ainda sinto insegurança", "Sou formado(a), mas ainda tenho medo de trabalhar", "Estou procurando uma oportunidade", "Ainda estou fazendo o curso técnico"] },
  { numero: "C2", tipo: "unica", perfil: TECNICO, texto: "Qual é seu maior objetivo hoje?", opcoes: ["Conseguir meu primeiro emprego", "Trabalhar em hospital", "Trabalhar com home care", "Fazer mais plantões", "Ganhar mais", "Me especializar", "Perder o medo dos procedimentos", "Me sentir seguro(a) em intercorrências", "Empreender na área", "Outro"] },
  { numero: "D1", tipo: "unica", perfil: ENFERMEIRO, texto: "Qual é o seu principal interesse atualmente?", opcoes: ["Atualização prática e procedimentos", "Liderança e supervisão de equipes", "Home care e cuidado domiciliar", "Formação e capacitação profissional", "Cuidado de idosos e pessoas com autismo"] },
  { numero: "D2", tipo: "unica", perfil: ENFERMEIRO, texto: "Qual caminho profissional mais interessa a você hoje?", opcoes: ["Assistência", "Gestão ou liderança", "Home care", "Educação ou treinamentos", "Empreendedorismo", "Especialização", "Atendimento particular", "Ainda estou decidindo"] }
];

// O documento MENOS "Outro" e, na pergunta 1, MENOS "Estudante" (decisões do cliente): é isto que o
// config tem que ter.
const REMOVIDAS_DA_1 = ["Estudante da área da saúde"];
const ESPERADO = DOCUMENTO.map((item) =>
  item.opcoes
    ? {
        ...item,
        opcoes: item.opcoes.filter((opcao) => opcao !== "Outro" && !(item.numero === "1" && REMOVIDAS_DA_1.includes(opcao)))
      }
    : item
);

// As 12 perguntas em que o documento tinha "Outro".
const COM_OUTRO_NO_DOCUMENTO = ["1", "8", "10", "11", "13", "14", "21", "25", "26", "27", "B2", "C2"];

// "Estrutura sugerida de etapas" do documento, e o bloco de cada pergunta.
const ETAPAS_DOCUMENTO = [
  "Sobre você",
  "Seu momento profissional",
  "Suas dificuldades",
  "Onde você quer chegar",
  "Cursos e investimento",
  "Como você prefere aprender",
  "Conteúdo e relacionamento com a Iza",
  "Perguntas abertas",
  "Perguntas específicas do seu perfil"
];

function etapaEsperada(numero) {
  if (/^[A-D]/.test(numero)) return 9;
  const n = Number(numero);
  if (n <= 5) return 1;
  if (n <= 9) return 2;
  if (n <= 13) return 3;
  if (n <= 16) return 4;
  if (n <= 21) return 5;
  if (n <= 24) return 6;
  if (n <= 28) return 7;
  return 8;
}

/** Respostas completas e válidas para um perfil: primeira alternativa de cada pergunta. */
function respostasCompletas(perfil) {
  let respostas = { perfil };
  for (const pergunta of P.perguntasVisiveis(respostas)) {
    if (pergunta.id === "perfil") continue;
    if (pergunta.tipo === "unica" || pergunta.tipo === "lista") respostas[pergunta.id] = pergunta.opcoes[0];
    else if (pergunta.tipo === "multipla") respostas[pergunta.id] = [pergunta.opcoes[0]];
    else if (pergunta.tipo === "escala") respostas[pergunta.id] = 5;
  }
  return respostas;
}

/* ----------------------------------------------------------- fidelidade ao documento */

test("as 39 perguntas do documento, na ordem, com número, enunciado e tipo exatos", () => {
  assert.equal(P.PERGUNTAS.length, 39);
  assert.deepEqual(
    P.PERGUNTAS.map((pergunta) => pergunta.numero),
    ESPERADO.map((esperada) => esperada.numero)
  );

  for (const [indice, esperada] of ESPERADO.entries()) {
    const pergunta = P.PERGUNTAS[indice];
    assert.equal(pergunta.texto, esperada.texto, `texto da ${esperada.numero}`);
    assert.equal(pergunta.tipo, esperada.tipo, `tipo da ${esperada.numero}`);
  }
});

test("todas as alternativas batem com o documento (menos \"Outro\" e, na 1, menos \"Estudante\"), letra por letra e na ordem", () => {
  for (const [indice, esperada] of ESPERADO.entries()) {
    const pergunta = P.PERGUNTAS[indice];
    if (esperada.opcoes) {
      assert.deepEqual([...pergunta.opcoes], esperada.opcoes, `alternativas da ${esperada.numero}`);
    } else {
      assert.equal(pergunta.opcoes, undefined, `a ${esperada.numero} não tem alternativas`);
    }
  }
});

test("sem \"Outro\" em pergunta nenhuma (decisão do cliente): nem alternativa, nem campo 'qual?'", () => {
  // O documento tinha "Outro" exatamente nestas 12 — confere que a lista acima é a do documento.
  assert.deepEqual(
    DOCUMENTO.filter((item) => item.opcoes && item.opcoes.includes("Outro")).map((item) => item.numero),
    COM_OUTRO_NO_DOCUMENTO
  );
  for (const pergunta of P.PERGUNTAS) {
    assert.equal(pergunta.outro, undefined, `${pergunta.numero}: propriedade 'outro'`);
    for (const opcao of pergunta.opcoes || []) {
      assert.doesNotMatch(opcao, /^outros?\b/i, `${pergunta.numero}: alternativa "${opcao}"`);
    }
    assert.ok(!P.chavesDaPergunta(pergunta).some((chave) => chave.endsWith("_outro")), pergunta.numero);
  }
  // As 12 perderam só o "Outro" (a 1 também o "Estudante"), e nenhuma outra pergunta mudou.
  for (const [indice, item] of DOCUMENTO.entries()) {
    if (!item.opcoes) continue;
    const perdeu = (COM_OUTRO_NO_DOCUMENTO.includes(item.numero) ? 1 : 0) + (item.numero === "1" ? REMOVIDAS_DA_1.length : 0);
    assert.equal(P.PERGUNTAS[indice].opcoes.length, item.opcoes.length - perdeu, item.numero);
  }
});

test("escala de 0 a 10 com as legendas do documento", () => {
  const seguranca = P.perguntaPorId("seguranca");
  assert.equal(seguranca.min, 0);
  assert.equal(seguranca.max, 10);
  const esperada = ESPERADO.find((item) => item.numero === "12");
  assert.equal(seguranca.legendaMin.toLocaleLowerCase("pt-BR"), esperada.legendas[0]);
  assert.equal(seguranca.legendaMax.toLocaleLowerCase("pt-BR"), esperada.legendas[1]);
});

test("a 31 tem as duas lacunas do modelo 'Eu gostaria muito de ___, mas ainda não consegui porque ___'", () => {
  const frase = P.perguntaPorId("frase");
  assert.deepEqual(
    frase.partes.map((parte) => parte.antes),
    ESPERADO.find((item) => item.numero === "31").partes
  );
  assert.deepEqual(
    frase.partes.map((parte) => parte.id),
    ["frase_desejo", "frase_bloqueio"]
  );
});

test("condicionais: blocos A a D só para o perfil do documento; o resto aparece para todos", () => {
  for (const [indice, esperada] of ESPERADO.entries()) {
    const pergunta = P.PERGUNTAS[indice];
    if (esperada.perfil) {
      assert.deepEqual(
        { pergunta: pergunta.visivelSe.pergunta, valores: [...pergunta.visivelSe.valores] },
        { pergunta: "perfil", valores: [esperada.perfil] },
        esperada.numero
      );
    } else {
      assert.equal(pergunta.visivelSe, undefined, esperada.numero);
    }
  }

  const ids = (perfil) => P.perguntasVisiveis({ perfil }).map((pergunta) => pergunta.numero);
  assert.deepEqual(ids(AUXILIAR).slice(31), ["A1", "A2"]);
  assert.deepEqual(ids(CUIDADOR).slice(31), ["B1", "B2"]);
  assert.deepEqual(ids(TECNICO).slice(31), ["C1", "C2"]);
  assert.deepEqual(ids(ENFERMEIRO).slice(31), ["D1", "D2"]);
  // Perfil que não existe mais (o antigo "Outro" ou "Estudante" de um rascunho velho) não abre bloco nenhum.
  assert.equal(ids(ESTUDANTE).length, 31);
  assert.equal(ids("Outro").length, 31);
  assert.equal(P.perguntasVisiveis({}).length, 31);
});

test("etapas: as 9 da estrutura sugerida, cada pergunta no bloco certo", () => {
  assert.deepEqual(
    P.ETAPAS.map((etapa) => etapa.titulo),
    ETAPAS_DOCUMENTO
  );
  assert.deepEqual(
    P.ETAPAS.map((etapa) => etapa.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
  );
  for (const pergunta of P.PERGUNTAS) {
    assert.equal(pergunta.etapa, etapaEsperada(pergunta.numero), pergunta.numero);
  }
  // Os 4 perfis têm bloco específico: a barra diz "de 9" para todo mundo.
  for (const perfil of Object.values(P.PERFIL)) assert.equal(P.etapasVisiveis({ perfil }).length, 9, perfil);
});

test("obrigatoriedade: principais obrigatórias, abertas opcionais (boas práticas do documento)", () => {
  for (const pergunta of P.PERGUNTAS) {
    const aberta = pergunta.tipo === "texto" || pergunta.tipo === "frase";
    assert.equal(pergunta.obrigatoria, !aberta, pergunta.numero);
  }
});

test("estrutura: ids e chaves únicos, exclusivas dentro das alternativas, os 4 perfis", () => {
  const ids = P.PERGUNTAS.map((pergunta) => pergunta.id);
  assert.equal(new Set(ids).size, ids.length);

  const chaves = P.PERGUNTAS.flatMap((pergunta) => P.chavesDaPergunta(pergunta));
  assert.equal(new Set(chaves).size, chaves.length);

  for (const pergunta of P.PERGUNTAS) {
    if (pergunta.opcoes) assert.equal(new Set(pergunta.opcoes).size, pergunta.opcoes.length, `${pergunta.numero}: alternativa repetida`);
    for (const exclusiva of pergunta.exclusivas || []) {
      assert.equal(pergunta.tipo, "multipla");
      assert.ok(pergunta.opcoes.includes(exclusiva), `${pergunta.numero}: exclusiva ${exclusiva}`);
    }
    if (pergunta.visivelSe) {
      const origem = P.perguntaPorId(pergunta.visivelSe.pergunta);
      assert.ok(origem, `${pergunta.numero}: visivelSe aponta para pergunta que não existe`);
      for (const valor of pergunta.visivelSe.valores) {
        assert.ok(origem.opcoes.includes(valor), `${pergunta.numero}: visivelSe com valor inexistente ${valor}`);
      }
      // A condição tem que vir ANTES, senão a pessoa nunca a responde a tempo.
      assert.ok(P.PERGUNTAS.indexOf(origem) < P.PERGUNTAS.indexOf(pergunta));
    }
    assert.ok(pergunta.analise && typeof pergunta.analise === "string", `${pergunta.numero}: rótulo de análise`);
  }

  assert.deepEqual(Object.values(P.PERFIL), ESPERADO[0].opcoes);
  assert.deepEqual(Object.keys(P.PERFIL), ["auxiliar", "cuidador", "tecnico", "enfermeiro"]);
  // Código interno e etiqueta de CRM de cada perfil (documento das páginas de obrigado).
  assert.deepEqual(P.PERFIL_CODIGO, {
    [AUXILIAR]: "auxiliar_atendente",
    [CUIDADOR]: "cuidador",
    [TECNICO]: "tecnico_enfermagem",
    [ENFERMEIRO]: "enfermeiro"
  });
  assert.deepEqual(P.PERFIL_SEGMENTO, {
    [AUXILIAR]: "PERFIL_AUXILIAR_ATENDENTE",
    [CUIDADOR]: "PERFIL_CUIDADOR",
    [TECNICO]: "PERFIL_TECNICO",
    [ENFERMEIRO]: "PERFIL_ENFERMEIRO"
  });
  assert.deepEqual(Object.keys(P.PERFIL_CURTO), Object.values(P.PERFIL));
  assert.deepEqual(Object.keys(P.PERFIL_NA_FRASE), Object.values(P.PERFIL));
  assert.deepEqual(
    P.ESTADOS.map((estado) => estado.nome),
    ESPERADO[2].opcoes
  );
  for (const perfil of Object.values(P.PERFIL)) {
    assert.ok(P.PERFIL_CURTO[perfil], perfil);
    assert.ok(P.PERFIL_NA_FRASE[perfil], perfil);
  }
});

test("variáveis de ICP e listas derivadas", () => {
  const analisaveis = new Set(P.perguntasAnalisaveis().map((pergunta) => pergunta.id));
  for (const id of P.ICP_VARIAVEIS) assert.ok(analisaveis.has(id), id);
  assert.ok(!analisaveis.has("problema_unico"));
  assert.ok(!analisaveis.has("frase"));
  assert.equal(analisaveis.size, 36);

  // Sem "Outro", as chaves de texto livre são só as abertas e as duas partes da frase, em ordem.
  assert.deepEqual(P.chavesTexto(), ["problema_unico", "sonho", "frase_desejo", "frase_bloqueio"]);
});

test("estados e regiões", () => {
  assert.equal(P.ESTADOS.length, 27);
  assert.equal(P.regiaoDoEstado("Minas Gerais"), "Sudeste");
  assert.equal(P.regiaoDoEstado("Distrito Federal"), "Centro-Oeste");
  assert.equal(P.regiaoDoEstado("Amapá"), "Norte");
  assert.equal(P.ufDoEstado("São Paulo"), "SP");
  assert.equal(P.regiaoDoEstado("Atlântida"), null);
  assert.equal(P.ufDoEstado(undefined), null);
  for (const estado of P.ESTADOS) assert.ok(P.REGIOES.includes(estado.regiao), estado.nome);
});

/* ----------------------------------------------------------- casos-limite da lógica */

test("sanitizar: troca de perfil limpa as respostas do bloco antigo", () => {
  const tecnico = P.sanitizar({ perfil: TECNICO, idade: "25 a 34 anos", tecnico_momento: "Estou procurando uma oportunidade", tecnico_objetivo: "Me especializar" });
  assert.equal(tecnico.tecnico_momento, "Estou procurando uma oportunidade");
  assert.equal(tecnico.tecnico_objetivo, "Me especializar");

  const cuidador = P.sanitizar({ ...tecnico, perfil: CUIDADOR });
  assert.deepEqual(cuidador, { perfil: CUIDADOR, idade: "25 a 34 anos" });
  assert.deepEqual(P.limparOrfas({ ...tecnico, perfil: CUIDADOR }), { perfil: CUIDADOR, idade: "25 a 34 anos" });
});

test("sanitizar: \"Outro\" de rascunho antigo (ou forjado) não é mais alternativa e o complemento some", () => {
  // Nada foi coletado com "Outro", mas um rascunho de teste no celular ou um POST forjado pode trazer.
  assert.deepEqual(P.sanitizar({ perfil: "Outro", perfil_outro: "Doula", idade: "25 a 34 anos" }), { idade: "25 a 34 anos" });
  assert.deepEqual(P.sanitizar({ perfil: CUIDADOR, perfil_outro: "Doula" }), { perfil: CUIDADOR });
  assert.deepEqual(
    P.sanitizar({ perfil: CUIDADOR, ambientes: ["Outro", "Hospital"], ambientes_outro: "Escola", maior_dificuldade: "Outro", maior_dificuldade_outro: "x" }),
    { perfil: CUIDADOR, ambientes: ["Hospital"] }
  );
  assert.equal(P.sanitizar({ perfil: CUIDADOR, ambientes: ["Outro"] }).ambientes, undefined);
  assert.equal(P.erroDaPergunta(P.perguntaPorId("perfil"), { perfil: "Outro" }), "Escolha uma opção para continuar.");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("ambientes"), { ambientes: ["Outro"] }), "Escolha pelo menos uma opção para continuar.");
});

/*
 * O mecanismo genérico de "Outro" continua no config (hoje nenhuma pergunta usa). As funções que
 * recebem a pergunta como argumento funcionam com uma pergunta sintética — é isso que garante que
 * ele volta a funcionar se um dia uma pergunta ganhar `outro`. (sanitizar/limparOrfas percorrem só
 * as perguntas reais e, sem pergunta com "Outro", não têm o que testar aqui.)
 */
const SINTETICA_UNICA = Object.freeze({ id: "teste", numero: "T1", etapa: 1, tipo: "unica", obrigatoria: true, analise: "Teste", texto: "Teste?", opcoes: ["A", "B", "Outro"], outro: "Outro" });
const SINTETICA_MULTIPLA = Object.freeze({ id: "teste_m", numero: "T2", etapa: 1, tipo: "multipla", obrigatoria: true, analise: "Teste", texto: "Teste?", opcoes: ["A", "B", "Outro"], outro: "Outro" });

test("mecanismo genérico de Outro (pergunta sintética): chave, marcado, respondida e erro", () => {
  assert.equal(P.chaveOutro(SINTETICA_UNICA), "teste_outro");
  assert.deepEqual(P.chavesDaPergunta(SINTETICA_UNICA), ["teste", "teste_outro"]);
  assert.deepEqual(P.chavesDaPergunta(P.perguntaPorId("idade")), ["idade"]);

  assert.equal(P.outroMarcado(SINTETICA_UNICA, { teste: "Outro" }), true);
  assert.equal(P.outroMarcado(SINTETICA_UNICA, { teste: "A" }), false);
  assert.equal(P.outroMarcado(SINTETICA_MULTIPLA, { teste_m: ["A", "Outro"] }), true);
  assert.equal(P.outroMarcado(P.perguntaPorId("perfil"), { perfil: "Outro" }), false);

  // "Outro" sem complemento (ou com uma letra só) não conta como respondida e explica o que falta.
  assert.equal(P.perguntaRespondida(SINTETICA_UNICA, { teste: "Outro" }), false);
  assert.match(P.erroDaPergunta(SINTETICA_UNICA, { teste: "Outro" }), /Outro/);
  assert.match(P.erroDaPergunta(SINTETICA_UNICA, { teste: "Outro", teste_outro: "a" }), /Outro/);
  assert.equal(P.erroDaPergunta(SINTETICA_UNICA, { teste: "Outro", teste_outro: "Doula" }), "");
  assert.equal(P.perguntaRespondida(SINTETICA_UNICA, { teste: "Outro", teste_outro: "Doula" }), true);
  assert.match(P.erroDaPergunta(SINTETICA_MULTIPLA, { teste_m: ["A", "Outro"] }), /Outro/);
  assert.equal(P.erroDaPergunta(SINTETICA_MULTIPLA, { teste_m: ["A", "Outro"], teste_m_outro: "Escola" }), "");
  // Complemento sem "Outro" marcado não atrapalha quem escolheu outra alternativa.
  assert.equal(P.erroDaPergunta(SINTETICA_UNICA, { teste: "A", teste_outro: "" }), "");
  assert.equal(P.valorValido(SINTETICA_MULTIPLA, ["Outro", "A"]).join(","), "A,Outro");
  assert.equal(P.MIN_OUTRO, 2);
  assert.equal(typeof P.MAX_OUTRO, "number");
});

test("sanitizar: múltipla em ordem canônica, sem repetição, e exclusiva não convive com as outras", () => {
  const base = { perfil: CUIDADOR };
  assert.deepEqual(P.sanitizar({ ...base, ambientes: ["Home care", "Hospital", "Hospital", 3, null] }).ambientes, ["Hospital", "Home care"]);
  assert.deepEqual(P.sanitizar({ ...base, ambientes: ["Hospital", "Ainda não sei"] }).ambientes, ["Hospital"]);
  assert.deepEqual(P.sanitizar({ ...base, ambientes: ["Ainda não sei"] }).ambientes, ["Ainda não sei"]);
  assert.deepEqual(P.sanitizar({ ...base, objecoes: ["Nada me impede se eu enxergar valor", "Falta de tempo"] }).objecoes, ["Falta de tempo"]);
  assert.equal(P.sanitizar({ ...base, ambientes: [] }).ambientes, undefined);
  assert.equal(P.sanitizar({ ...base, ambientes: "Hospital" }).ambientes, undefined);
  assert.equal(P.sanitizar({ ...base, ambientes: ["Shopping"] }).ambientes, undefined);
});

test("sanitizar: escala aceita '7' e recusa o que não é inteiro de 0 a 10", () => {
  const base = { perfil: CUIDADOR };
  assert.equal(P.sanitizar({ ...base, seguranca: "7" }).seguranca, 7);
  assert.equal(P.sanitizar({ ...base, seguranca: 0 }).seguranca, 0);
  assert.equal(P.sanitizar({ ...base, seguranca: 10 }).seguranca, 10);
  for (const invalido of ["7.5", 7.5, 11, "11", -1, "", " ", "sete", null, true, [7]]) {
    assert.equal(P.sanitizar({ ...base, seguranca: invalido }).seguranca, undefined, JSON.stringify(invalido));
  }
});

test("sanitizar: texto livre sem caracteres de controle, aparado e com teto", () => {
  const limpo = P.sanitizar({ perfil: CUIDADOR, sonho: "\u0000  Ter\u0007 minha\r\nclínica\t  ", problema_unico: "   ", frase_desejo: "a".repeat(5000) });
  assert.equal(limpo.sonho, "Ter minha\nclínica");
  assert.equal(limpo.problema_unico, undefined);
  assert.equal(limpo.frase_desejo.length, P.MAX_TEXTO);
  assert.equal(P.sanitizar({ perfil: CUIDADOR, sonho: 42 }).sonho, undefined);
});

test("sanitizar: chave desconhecida, alternativa inexistente e entrada que não é objeto somem", () => {
  assert.deepEqual(P.sanitizar({ perfil: CUIDADOR, hack: "x", idade: "200 anos", estado: "Atlântida", localidade: "Capital" }), { perfil: CUIDADOR, localidade: "Capital" });
  for (const entrada of [null, undefined, "perfil", 42, [], [{ perfil: CUIDADOR }]]) {
    assert.deepEqual(P.sanitizar(entrada), {}, JSON.stringify(entrada));
  }
  // Pergunta condicional sem o perfil certo não sobrevive.
  assert.deepEqual(P.sanitizar({ cuidador_realidade: "Cuido de alguém da minha família" }), {});
});

test("sanitizar: __proto__ vindo do JSON não polui nada", () => {
  const entrada = JSON.parse('{"__proto__": {"poluido": true, "perfil": "Cuidador(a)"}, "constructor": {"prototype": {"poluido": true}}, "idade": "25 a 34 anos"}');
  const limpo = P.sanitizar(entrada);
  assert.deepEqual(limpo, { idade: "25 a 34 anos" });
  assert.equal(Object.getPrototypeOf(limpo), Object.prototype);
  assert.equal({}.poluido, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(limpo, "__proto__"), false);
  assert.deepEqual(P.limparOrfas(entrada), { idade: "25 a 34 anos" });
});

test("progresso: vazio, completo por perfil, abertas não impedem os 100%", () => {
  assert.deepEqual(P.progresso({}), { total: 31, obrigatorias: 28, respondidas: 0, obrigatoriasRespondidas: 0, percentual: 0, completa: false });

  for (const perfil of [AUXILIAR, CUIDADOR, TECNICO, ENFERMEIRO]) {
    const completo = P.progresso(respostasCompletas(perfil));
    assert.deepEqual(completo, { total: 33, obrigatorias: 30, respondidas: 30, obrigatoriasRespondidas: 30, percentual: 100, completa: true }, perfil);
  }
  // "Estudante" de um rascunho antigo: o perfil some na sanitização, e a tentativa não completa.
  const estudante = P.sanitizar(respostasCompletas(ESTUDANTE));
  assert.equal(estudante.perfil, undefined);
  assert.equal(P.progresso(estudante).completa, false);

  // Abertas contam como respondidas, mas não são necessárias.
  const comAbertas = P.progresso({ ...respostasCompletas(CUIDADOR), sonho: "Ter minha clínica", frase_bloqueio: "falta dinheiro" });
  assert.equal(comAbertas.respondidas, 32);
  assert.equal(comAbertas.percentual, 100);
});

test("progresso: nunca 100% sem estar completa, e sem perfil não está completa", () => {
  const quase = respostasCompletas(TECNICO);
  delete quase.tecnico_objetivo;
  const p = P.progresso(quase);
  assert.equal(p.completa, false);
  assert.equal(p.percentual, 96);
  assert.equal(P.primeiraPendente(quase).id, "tecnico_objetivo");

  // 29 de 30: arredondaria para 97; e com 99,x% o teto é 99.
  const semPerfil = respostasCompletas(CUIDADOR);
  delete semPerfil.perfil;
  const sp = P.progresso(P.sanitizar(semPerfil));
  assert.equal(sp.completa, false);
  assert.ok(sp.percentual <= 99);
  assert.equal(P.primeiraPendente(P.sanitizar(semPerfil)).id, "perfil");

  // Perfil "Outro" (não existe mais): tudo o resto respondido, mas não completa — falta o perfil.
  const outro = P.sanitizar({ ...respostasCompletas("Outro"), perfil_outro: "Doula" });
  assert.equal(outro.perfil, undefined);
  assert.equal(P.progresso(outro).completa, false);
  assert.equal(P.primeiraPendente(outro).id, "perfil");
});

test("erroDaPergunta: mensagens por tipo; opcional em branco segue; frase com uma parte segue", () => {
  const vazio = {};
  assert.equal(P.erroDaPergunta(P.perguntaPorId("idade"), vazio), "Escolha uma opção para continuar.");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("estado"), vazio), "Escolha o seu estado para continuar.");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("ambientes"), vazio), "Escolha pelo menos uma opção para continuar.");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("seguranca"), vazio), "Escolha um número de 0 a 10 para continuar.");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("sonho"), vazio), "");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("frase"), vazio), "");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("frase"), { frase_bloqueio: "tempo" }), "");
  assert.equal(P.perguntaRespondida(P.perguntaPorId("frase"), { frase_bloqueio: "tempo" }), true);
  assert.equal(P.erroDaPergunta(P.perguntaPorId("seguranca"), { seguranca: 0 }), "");
  assert.equal(P.erroDaPergunta(P.perguntaPorId("idade"), { idade: "Outro" }), "Escolha uma opção para continuar.");
});

test("interpolar: primeiro nome capitalizado, vírgula some sem nome, perfil na frase", () => {
  const fala = P.etapaPorNumero(9).fala;
  assert.equal(P.interpolar(fala, { nome: "MARIA da silva", perfil: CUIDADOR }), "Pra fechar, Maria, algumas perguntas só pra quem é cuidador(a).");
  assert.equal(P.interpolar(fala, { perfil: TECNICO }), "Pra fechar, algumas perguntas só pra quem é técnico(a) de enfermagem.");
  assert.equal(P.interpolar(P.etapaPorNumero(1).fala, {}), "Pra começar, a gente quer te conhecer um pouquinho.");
  assert.equal(P.interpolar("{perfil}", { perfil: "desconhecido" }), "da sua área");
  assert.equal(P.interpolar("Oi {nome}! {nome}.", { nome: "  josé  " }), "Oi José! José.");
  assert.equal(P.interpolar(undefined), "");
  assert.equal(P.primeiroNome(""), "");
  assert.equal(P.primeiroNome("érica"), "Érica");
});

test("o config é imutável: ninguém altera pergunta em tempo de execução", () => {
  assert.ok(Object.isFrozen(P));
  assert.ok(Object.isFrozen(P.PERGUNTAS));
  assert.ok(P.PERGUNTAS.every((pergunta) => Object.isFrozen(pergunta)));
  assert.equal(P.ID, "icp-escola-ev");
  assert.equal(typeof P.VERSAO, "string");
});

/* ----------------------------------------------------------- páginas de obrigado */

test("obrigado-config: os 4 perfis caem em exatamente uma das 3 páginas; Técnico e Enfermeiro dividem a do evento", () => {
  vm.runInThisContext(readFileSync(new URL("../js/obrigado-config.js", import.meta.url), "utf8"), { filename: "js/obrigado-config.js" });
  const O = globalThis.EVObrigado;
  assert.ok(Object.isFrozen(O));
  assert.deepEqual(
    O.LISTA.map((pagina) => [pagina.id, pagina.rota, pagina.grupo]),
    [
      ["afericao", "/obrigado-afericao", "afericao"],
      ["cuidador", "/obrigado-cuidador", "cuidador"],
      ["evento_outubro", "/obrigado-evento-outubro", "evento_outubro"]
    ]
  );
  for (const perfil of Object.values(P.PERFIL)) {
    assert.equal(O.LISTA.filter((pagina) => pagina.perfis.includes(perfil)).length, 1, perfil);
  }
  assert.equal(O.paginaDoPerfil(AUXILIAR).id, "afericao");
  assert.equal(O.paginaDoPerfil(CUIDADOR).id, "cuidador");
  assert.equal(O.paginaDoPerfil(TECNICO).id, "evento_outubro");
  assert.equal(O.paginaDoPerfil(ENFERMEIRO).id, "evento_outubro");
  assert.equal(O.paginaDoPerfil(ESTUDANTE), null);
  assert.equal(O.paginaDoPerfil(undefined), null);
  // Mesma página, códigos de CRM separados.
  assert.notEqual(P.PERFIL_CODIGO[TECNICO], P.PERFIL_CODIGO[ENFERMEIRO]);
  assert.equal(O.paginaDaRota("/obrigado-cuidador/").id, "cuidador");
  assert.equal(O.paginaDaRota("/obrigado-x"), null);
  // Convite direto do WhatsApp e link do distribuidor (Sendflow) são as duas formas aceitas.
  for (const bom of [
    "https://chat.whatsapp.com/AbC123",
    "https://wa.me/5511999999999",
    "https://wa.me/5545991234567?text=Oi!%20(grupo)",
    "https://sndflw.com/i/hxQV77EZKwpS62QXVLb8",
    "https://www.sndflw.com/i/abc12345",
    "https://sndflw.com/i/abc12345/",
    "https://sndflw.com/i/abc12345?utm_source=obrigado",
    "  https://sndflw.com/i/abc12345\n"
  ]) {
    assert.equal(O.linkValido(bom), true, bom);
  }
  // O portão é a lista de hosts, ancorada: sufixo de domínio, userinfo, subdomínio, http e
  // esquema estranho não passam — e é isto que impede um link torto de virar botão.
  for (const ruim of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "",
    "   ",
    null,
    undefined,
    42,
    "http://sndflw.com/i/hxQV77EZKwpS62QXVLb8",
    "https://SNDFLW.com/i/abc12345",
    "https://sndflw.com.evil.com/i/abc12345",
    "https://sndflw.com@evil.com/i/abc12345",
    "https://evil.com/sndflw.com/i/abc12345",
    "https://chat.whatsapp.com.evil.com/AbC123",
    "https://sndflw.com",
    "https://sndflw.com/i",
    "https://sndflw.com//i/abc12345",
    "https://sndflw.com/dashboard",
    "https://exemplo.com/grupo",
    "https://chat.whatsapp.com/<script>alert(1)</script>",
    "https://sndflw.com/i/abc12345 https://evil.com",
    `https://sndflw.com/i/${"a".repeat(400)}`
  ]) {
    assert.equal(O.linkValido(ruim), false, String(ruim));
  }
});

test("obrigado-config: os 3 links de produção são válidos, distintos e um por página", () => {
  vm.runInThisContext(readFileSync(new URL("../js/obrigado-config.js", import.meta.url), "utf8"), { filename: "js/obrigado-config.js" });
  const O = globalThis.EVObrigado;
  // Este é o teste que transforma "link colado errado" em falha de CI em vez de falha silenciosa
  // na página (link inválido esconde o botão, e ninguém percebe).
  for (const pagina of O.LISTA) {
    assert.notEqual(pagina.link, "", `${pagina.id}: sem link`);
    assert.equal(O.linkValido(pagina.link), true, `${pagina.id}: link inválido (${pagina.link})`);
  }
  const links = O.LISTA.map((pagina) => pagina.link);
  assert.equal(new Set(links).size, links.length, "duas páginas com o mesmo link do grupo");
  assert.deepEqual(Object.keys(O.LINKS_GRUPOS), ["afericao", "cuidador", "evento_outubro"]);
});
