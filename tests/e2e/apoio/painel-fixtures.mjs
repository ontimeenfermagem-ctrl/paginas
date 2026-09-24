// Apoio da suíte tests/e2e/painel.e2e.mjs.
//
// Gera um conjunto realista e determinístico (semente fixa) de visitantes, pessoas, eventos das
// páginas de obrigado, inscrições das DUAS páginas com checkout (Viver de Furo e Imersão GPS) e
// avisos da Hotmart no formato da tabela `compras`, e reproduz, em JS, o que as funções SQL
// devolvem (pesquisa_painel, pesquisa_cruzamento, pesquisa_abertas, paginas_resumo,
// inscricoes_resumo) e a view pesquisa_pessoas para /respostas. Usa o EVPesquisa, o EVObrigado e o
// EVCheckout de verdade (via vm, no mesmo contexto, como no navegador). As funções SQL em si são
// provadas contra o Postgres em sql.e2e.mjs; aqui o assunto é a TELA do painel. O espelho de
// inscricoes_resumo segue a seção 6 do supabase.sql (inclusive as ordens e a régua das vendas: o
// estado de cada transação pela hora do EVENTO no histórico até o fim do período, contada no
// período da primeira aprovação): mudou lá, muda aqui.
//
// Só os 4 perfis e alternativas concretas: nenhuma pergunta tem "Outro", e "Estudante" saiu
// (decisões do cliente).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(RAIZ, "js", "pesquisa-config.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(RAIZ, "js", "obrigado-config.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(RAIZ, "js", "lead-rules.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(RAIZ, "js", "checkout-config.js"), "utf8"), ctx);
export const EV = ctx.EVPesquisa;
export const OBR = ctx.EVObrigado;
export const CHK = ctx.EVCheckout;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FMT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
export const diaSP = (iso) => FMT.format(new Date(iso));

const NOMES = ["Maria", "Ana", "Juliana", "Patrícia", "Fernanda", "Cláudia", "Rosângela", "Luciana", "Sandra", "Adriana", "Josiane", "Kelly", "Tatiane", "Simone", "Aparecida", "Edna", "Marcos", "José", "Carlos", "Rafael", "Débora", "Elaine", "Vanessa", "Cristiane", "Priscila", "Rita", "Solange", "Ivone"];
const SOBRENOMES = ["da Silva", "Santos", "Oliveira", "Souza", "Pereira", "Costa", "Rodrigues", "Almeida", "Nascimento", "Lima", "Araújo", "Ferreira", "Carvalho", "Gomes", "Martins", "Ribeiro", "Barbosa", "Rocha"];
const DOMINIOS = ["gmail.com", "gmail.com", "gmail.com", "hotmail.com", "outlook.com", "yahoo.com.br", "icloud.com", "saude.sp.gov.br"];
const DDD = ["11", "21", "31", "71", "81", "85", "41", "51", "61", "62", "91", "27", "48", "98", "83"];

const PROBLEMAS = [
  "Perder o medo de puncionar acesso venoso. Travo toda vez que o paciente é idoso e a veia é fina.",
  "Conseguir um emprego fixo. Faço plantão extra há 3 anos e não tenho estabilidade nenhuma.",
  "Ganhar o suficiente pra não precisar de dois empregos. Tô exausta.",
  "Saber agir numa parada cardiorrespiratória sem congelar.",
  "Ter segurança pra cuidar de paciente com traqueostomia em casa.",
  "Ser valorizada pela chefia. Faço tudo e ninguém reconhece.",
  "Voltar pra área depois de 8 anos afastada cuidando dos meus filhos.",
  "Aprender a calcular medicação sem ter que pedir ajuda pra colega.",
  "Ter o COREN regularizado e conseguir trabalhar como técnica.",
  "Conseguir clientes particulares como cuidadora e saber quanto cobrar.",
  "Lidar com família de paciente que fica em cima o tempo todo.",
  "Passar num concurso da prefeitura.",
  "Entender de sondas e dispositivos, porque no home care cai tudo em cima da gente."
];
const SONHOS = [
  "Trabalhar na UTI de um hospital grande.",
  "Abrir minha própria empresa de home care e empregar outras cuidadoras.",
  "Ser enfermeira. Já sou técnica há 12 anos e quero fazer faculdade.",
  "Ser referência em cuidado de idosos na minha cidade.",
  "Dar aula em curso técnico e formar gente boa.",
  "Trabalhar só com atendimento particular e ter horário pra minha família.",
  "Ser chefe de equipe e mostrar que dá pra liderar com respeito.",
  "Me especializar em autismo e atender crianças.",
  "Trabalhar fora do Brasil como enfermeira.",
  "Ter uma renda de R$ 8 mil fazendo o que eu amo."
];
const DESEJOS = [
  "trabalhar em hospital",
  "fazer o curso técnico",
  "ter meu próprio atendimento particular",
  "ganhar pelo menos R$ 5 mil por mês",
  "me sentir segura nos plantões",
  "me especializar em home care",
  "voltar a trabalhar na enfermagem",
  "fazer faculdade de enfermagem"
];
const BLOQUEIOS = [
  "não tenho dinheiro pra pagar curso agora",
  "trabalho 12x36 e não sobra tempo",
  "tenho medo de errar e prejudicar alguém",
  "cuido da minha mãe acamada",
  "não sei por onde começar",
  "já comprei curso que não servia pra nada",
  "falta experiência e ninguém dá a primeira chance",
  "meu marido acha que não vale a pena"
];
const PERFIL_PESOS = [
  ["tecnico", 30],
  ["cuidador", 22],
  ["auxiliar", 15],
  ["enfermeiro", 13]
];

export function gerar({ seed = 7, pessoas: totalPessoas = 800, agora = new Date() } = {}) {
  const r = rng(seed);
  const escolhe = (lista) => lista[Math.floor(r() * lista.length)];
  const pesado = (pares) => {
    const soma = pares.reduce((s, [, p]) => s + p, 0);
    let x = r() * soma;
    for (const [v, p] of pares) if ((x -= p) <= 0) return v;
    return pares[pares.length - 1][0];
  };
  // Distribuição com "pico" em algum lugar: dá gráfico com forma, não ruído uniforme.
  const comPico = (opcoes, pico) =>
    pesado(opcoes.map((o, i) => [o, 1 + 6 * Math.exp(-((i - pico) ** 2) / 3)]));

  const agoraMs = agora.getTime();
  const DIA = 86400000;
  const visitantes = [];
  const respostas = [];

  function carimbo(diasAtras) {
    // Mais movimento nos últimos dias (campanha subindo) e em horário comercial/noite.
    const base = agoraMs - diasAtras * DIA - r() * DIA * 0.9;
    return new Date(Math.min(base, agoraMs - 60000)).toISOString();
  }
  const diasAtras = () => (r() < 0.06 ? 15 + Math.floor(r() * 25) : Math.floor(Math.pow(r(), 1.3) * 14));

  const rastreio = () => {
    const x = r();
    if (x < 0.45) return { utm_source: "instagram", utm_medium: escolhe(["stories", "bio", "reels"]), utm_campaign: escolhe(["pesquisa-icp-stories", "pesquisa-icp-reels"]), utm_content: null };
    if (x < 0.7) return { utm_source: "facebook", utm_medium: "paid", utm_campaign: "icp-set26", utm_content: escolhe(["video-iza-01", "carrossel-02", "estatico-03"]) };
    if (x < 0.85) return { utm_source: "whatsapp", utm_medium: "lista", utm_campaign: "lista-vip", utm_content: null };
    return { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null };
  };
  const disp = () => pesado([["mobile", 85], ["tablet", 5], ["desktop", 10]]);

  // Visitantes que nunca se identificaram.
  for (let i = 0; i < 520; i++) {
    const criado = carimbo(diasAtras());
    visitantes.push({ visitante_id: `v-extra-${i}`, criado_em: criado, visitas: 1 + (r() < 0.3 ? 1 + Math.floor(r() * 3) : 0), comecou_em: r() < 0.35 ? criado : null, ...rastreio(), dispositivo: disp() });
  }

  const seguranca = { tecnico: 4.5, cuidador: 6, auxiliar: 5, enfermeiro: 7 };
  for (let i = 0; i < totalPessoas; i++) {
    const chavePerfil = pesado(PERFIL_PESOS);
    const perfil = EV.PERFIL[chavePerfil];
    const criado = carimbo(diasAtras());
    const rast = rastreio();
    const dispositivo = disp();
    const visitante_id = `v-${i}`;
    visitantes.push({ visitante_id, criado_em: criado, visitas: 1 + (r() < 0.4 ? 1 + Math.floor(r() * 4) : 0), comecou_em: criado, ...rast, dispositivo });

    const completa = r() < 0.58;
    const bruto = { perfil };
    const visiveis = EV.perguntasVisiveis(bruto);
    // Onde para (se não completa): mais gente cai nas etapas do meio (dificuldade, investimento).
    let parada = completa ? Infinity : pesado(visiveis.map((p, k) => [k, k === 0 ? 3 : 1 + (p.etapa === 2 ? 2 : 0) + (p.etapa === 5 ? 4 : 0) + (p.id === "renda_atual" ? 5 : 0)]));
    const tempos = { contato: 15 + Math.floor(r() * 50) };
    for (let k = 0; k < visiveis.length; k++) {
      const p = visiveis[k];
      if (k >= parada) break;
      if (p.id === "perfil") {
        tempos.perfil = 4 + Math.floor(r() * 20);
        continue;
      }
      tempos[p.id] = 3 + Math.floor(r() * 35);
      if (p.tipo === "unica" || p.tipo === "lista") {
        let opcoes = p.opcoes;
        let pico = { idade: chavePerfil === "tecnico" ? 2 : 3, renda_atual: chavePerfil === "enfermeiro" ? 3 : 1, disposicao_investimento: 2, maior_investimento: 2 }[p.id];
        if (pico === undefined) pico = Math.floor(r() * opcoes.length);
        let v = p.id === "estado" ? pesado(opcoes.map((o) => [o, { "São Paulo": 22, "Minas Gerais": 11, "Rio de Janeiro": 9, Bahia: 8, Pernambuco: 5, Ceará: 5, Paraná: 5, "Rio Grande do Sul": 4, Goiás: 3, Pará: 3 }[o] || 1])) : comPico(opcoes, pico);
        bruto[p.id] = v;
      } else if (p.tipo === "multipla") {
        const qtd = 1 + Math.floor(r() * 3);
        const set = new Set();
        for (let j = 0; j < qtd; j++) set.add(comPico(p.opcoes, p.id === "fontes_informacao" ? 0 : Math.floor(r() * 4)));
        bruto[p.id] = Array.from(set);
      } else if (p.tipo === "escala") {
        const m = seguranca[chavePerfil];
        bruto[p.id] = Math.max(0, Math.min(10, Math.round(m + (r() + r() + r() - 1.5) * 3)));
      } else if (p.tipo === "texto") {
        if (r() < 0.7) bruto[p.id] = escolhe(p.id === "sonho" ? SONHOS : PROBLEMAS);
      } else if (p.tipo === "frase") {
        if (r() < 0.6) {
          bruto.frase_desejo = escolhe(DESEJOS);
          if (r() < 0.9) bruto.frase_bloqueio = escolhe(BLOQUEIOS);
        }
      }
    }
    // Parou antes da pergunta 1: identificou-se e não escolheu perfil.
    if (parada === 0) {
      delete bruto.perfil;
    }
    const resp = EV.sanitizar(bruto);
    const prog = EV.progresso(resp);
    const vis = EV.perguntasVisiveis(resp);
    const pend = EV.primeiraPendente(resp);
    const perguntaMax = prog.completa ? "fim" : pend ? pend.id : "fim";
    const pMax = EV.perguntaPorId(perguntaMax);
    const etapaMax = prog.completa ? Math.max(...vis.map((p) => p.etapa)) : pMax.etapa;
    const tentativasN = r() < 0.08 ? 2 : 1;
    const nome = `${escolhe(NOMES)} ${escolhe(SOBRENOMES)}${r() < 0.3 ? " " + escolhe(SOBRENOMES) : ""}`;
    const ddd = escolhe(DDD);
    const digitos = `${ddd}9${String(10000000 + Math.floor(r() * 89999999)).slice(0, 8)}`;
    const whatsapp = `(${digitos.slice(0, 2)}) ${digitos.slice(2, 7)}-${digitos.slice(7)}`;
    const email = `${nome.split(" ")[0].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()}.${i}@${escolhe(DOMINIOS)}`;
    const tempoTotal = prog.completa ? 240 + Math.floor(r() * 700) : null;
    const concluido = prog.completa ? new Date(Math.min(new Date(criado).getTime() + tempoTotal * 1000, agoraMs - 1000)).toISOString() : null;
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const linha = {
      id,
      pesquisa: "icp-escola-ev",
      pesquisa_versao: "1.0",
      visitante_id,
      criado_em: criado,
      atualizado_em: concluido || criado,
      ultima_resposta_em: concluido || criado,
      concluido_em: concluido,
      // Quem completou chegou à tela de fim (e foi levado à página de obrigado) na mesma hora.
      finalizado_em: concluido,
      status: prog.completa ? "concluida" : "em_andamento",
      seq: 10,
      nome,
      whatsapp,
      whatsapp_digits: digitos,
      whatsapp_internacional: `55${digitos}`,
      email,
      perfil: resp.perfil || null,
      respostas: resp,
      pergunta_atual: perguntaMax,
      etapa_atual: etapaMax,
      posicao_max: perguntaMax === "fim" ? EV.PERGUNTAS.length + 1 : EV.PERGUNTAS.indexOf(pMax) + 1,
      pergunta_max: perguntaMax,
      etapa_max: etapaMax,
      respondidas: prog.respondidas,
      obrigatorias: prog.obrigatorias,
      obrigatorias_respondidas: prog.obrigatoriasRespondidas,
      total_perguntas: prog.total,
      progresso_percentual: prog.percentual,
      tempos,
      tempo_total_segundos: tempoTotal,
      page_url: `https://pesquisa.exemplo.com.br/pesquisa-icp${rast.utm_source ? `?utm_source=${rast.utm_source}&utm_campaign=${rast.utm_campaign}` : ""}`,
      referrer: rast.utm_source === "instagram" ? "https://l.instagram.com/" : rast.utm_source === "facebook" ? "https://m.facebook.com/" : null,
      ...rast,
      utm_term: null,
      fbclid: rast.utm_source === "facebook" ? `IwAR${Math.floor(r() * 1e12)}` : null,
      gclid: null,
      dispositivo,
      tentativas: tentativasN
    };
    respostas.push(linha);
  }
  // Uma pessoa com nome malicioso para testar escape.
  respostas[3].nome = `<img src=x onerror="window.__xss=1">Joana "Teste" & Cia`;
  respostas[3].respostas = { ...respostas[3].respostas };

  // Páginas de obrigado: semente própria, para não mexer na sequência das pessoas acima. ~82% de
  // quem terminou chega à página (1 em 5 recarrega), ~60% de quem chegou clica no grupo (às vezes
  // duas vezes); mais uns acessos diretos, sem perfil, alguns sem id de aparelho.
  const r2 = rng(seed + 101);
  const eventos = [];
  let idEvento = 0;
  const evento = (dados) => eventos.push({ id: ++idEvento, ...dados });
  for (const p of respostas) {
    const pagina = p.finalizado_em ? OBR.paginaDoPerfil(p.perfil) : null;
    if (!pagina || r2() > 0.82) continue;
    const base = new Date(p.finalizado_em).getTime();
    const quando = (segundos) => new Date(Math.min(base + segundos * 1000, agoraMs - 500)).toISOString();
    const comum = { pagina: pagina.id, visitante_id: p.visitante_id, perfil: p.perfil, utm_source: p.utm_source, dispositivo: p.dispositivo };
    evento({ ...comum, evento: "visita", criado_em: quando(2) });
    if (r2() < 0.2) evento({ ...comum, evento: "visita", criado_em: quando(90) });
    if (r2() < 0.6) {
      evento({ ...comum, evento: "clique_grupo", criado_em: quando(20) });
      if (r2() < 0.15) evento({ ...comum, evento: "clique_grupo", criado_em: quando(25) });
    }
  }
  for (let i = 0; i < 24; i++) {
    const pagina = OBR.LISTA[i % OBR.LISTA.length];
    const criado = carimbo(Math.floor(r2() * 10));
    const comum = { pagina: pagina.id, visitante_id: i % 4 === 0 ? null : `v-direto-${i}`, perfil: null, utm_source: i % 3 === 0 ? "whatsapp" : null, dispositivo: "mobile" };
    evento({ ...comum, evento: "visita", criado_em: criado });
    if (i % 2 === 0) evento({ ...comum, evento: "clique_grupo", criado_em: criado });
  }
  // Páginas de inscrição com checkout (js/checkout-config.js), cada uma com semente própria, de
  // novo para não mexer na sequência de cima. Os avisos da Hotmart vêm no formato da tabela
  // `compras`: id sequencial (o de gravação), transação, evento, a hora em que o evento aconteceu na
  // Hotmart (evento_em, o creation_date) e a da chegada (recebido_em, alguns segundos depois), a
  // data de aprovação da compra (aprovado_em, que a Hotmart repete em todo evento da mesma compra),
  // o sck que ela devolveu, a página do PRODUTO (null = produto de fora) com o jeito como ela foi
  // achada (pagina_por; null = aviso da versão anterior da tabela) e se casou com uma inscrição.
  const inscricoes = [];
  const compras = [];
  let idCompra = 0;
  const depois = (iso, ms) => new Date(Math.min(new Date(iso).getTime() + ms, agoraMs - 500)).toISOString();
  // O link do checkout que a pessoa abriu por último (inscricoes.checkout_url), montado pela régua da
  // página (CHK.urlDoCheckout). A inscrição guarda as UTMs do PRIMEIRO toque, e o link, as do envio
  // mais recente: quem voltou pelo lembrete do WhatsApp e mandou o formulário de novo foi para a
  // Hotmart com sck=lembrete-wpp, embora a UTM gravada seja a do anúncio. Algumas inscrições antigas
  // não têm o link (gravadas antes da coluna). Sem sorteio: não mexe na sequência das sementes.
  const REENVIO = { utm_source: "whatsapp", utm_medium: "lembrete", utm_campaign: "lembrete-vip", utm_term: "lembrete-wpp", utm_content: "lembrete-wpp" };
  const linkDoCheckout = (pagina, inscricao, i) => {
    if (i % 29 === 11) return null;
    const utm = i % 20 === 3 ? REENVIO : inscricao;
    inscricao._reenviou = i % 20 === 3;
    const campos = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];
    return CHK.urlDoCheckout(pagina, {
      utm: Object.fromEntries(campos.filter((k) => utm[k]).map((k) => [k, utm[k]])),
      contato: { nome: inscricao.nome, email: inscricao.email, whatsapp: inscricao.whatsapp_digits }
    });
  };
  /** O sck que a Hotmart devolve na venda: o do link aberto por último (a UTM da página, sem ele). */
  const sckQueFoi = (inscricao, campo) => (inscricao._reenviou ? REENVIO[campo] : inscricao[campo]);
  /** Grava um aviso. Sem recebido_em, ele chega de 1,5 a 20 s depois do evento. */
  const aviso = (dados) => {
    const id = ++idCompra;
    const linha = {
      id,
      transacao: null,
      status: null,
      valor: null,
      sck: null,
      comprador_nome: null,
      comprador_email: null,
      aprovado_em: null,
      inscricao_id: null,
      pagina_por: dados.pagina ? "config" : null,
      casou: false,
      ...dados
    };
    if (!linha.recebido_em) linha.recebido_em = depois(linha.evento_em, 1500 + (id % 9) * 2300);
    compras.push(linha);
    return linha;
  };
  // Reembolso/chargeback: a Hotmart repete a data de aprovação da compra; o estado do inscrito
  // passa a ser o do evento mais novo (como faz hotmart_registrar_compra).
  const marcarDesfeita = (inscricao, evento, status, quando) => {
    aviso({ evento_em: quando, aprovado_em: inscricao.comprou_em, evento, status, transacao: inscricao.compra_transacao, comprador_nome: inscricao.nome, comprador_email: inscricao.email, valor: inscricao.compra_valor, sck: inscricao._sck, pagina: inscricao.pagina, inscricao_id: inscricao.id, casou: true });
    inscricao.comprou_em = null;
    inscricao.compra_status = status;
    inscricao.compra_evento_em = quando;
  };

  // --- Viver de Furo: 120 inscritos, ~18% comprando, o utm_term é o sck. Mais 2 vendas do mesmo
  //     produto que NÃO casam (outro link, outro e-mail), 1 reembolso e 1 venda de produto de fora.
  const r3 = rng(seed + 202);
  const VDF = CHK.PAGINAS["viver-de-furo"];
  const ORIGENS = [
    { utm_source: "facebook", utm_medium: "paid", utm_campaign: "viver-de-furo-set", utm_term: "criativo-07" },
    { utm_source: "facebook", utm_medium: "paid", utm_campaign: "viver-de-furo-set", utm_term: "criativo-09" },
    { utm_source: "instagram", utm_medium: "bio", utm_campaign: "bio-perfil", utm_term: null },
    { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null }
  ];
  for (let i = 0; i < 120; i++) {
    const criado = carimbo(Math.floor(Math.pow(r3(), 1.4) * 12));
    const origem = ORIGENS[Math.floor(Math.pow(r3(), 1.5) * ORIGENS.length)];
    const comprou = r3() < 0.18;
    const nome = `${NOMES[Math.floor(r3() * NOMES.length)]} ${SOBRENOMES[Math.floor(r3() * SOBRENOMES.length)]}`;
    const digits = `${DDD[Math.floor(r3() * DDD.length)]}9${String(10000000 + Math.floor(r3() * 89999999))}`.slice(0, 11);
    const valor = [97, 197, 297][Math.floor(r3() * 3)];
    const compradoEm = comprou ? new Date(Math.min(new Date(criado).getTime() + 600000, agoraMs - 1000)).toISOString() : null;
    const inscricao = {
      id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      pagina: VDF.id,
      criado_em: criado,
      atualizado_em: criado,
      nome,
      whatsapp: `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`,
      whatsapp_digits: digits,
      whatsapp_internacional: `55${digits}`,
      email: `${nome.split(" ")[0].toLowerCase()}${i}@${DOMINIOS[Math.floor(r3() * DOMINIOS.length)]}`,
      cliques: 1 + (r3() < 0.25 ? 1 : 0) + (r3() < 0.08 ? 1 : 0),
      clicou_em: criado,
      comprou_em: compradoEm,
      compra_status: comprou ? "APPROVED" : null,
      compra_valor: comprou ? valor : null,
      compra_transacao: comprou ? `HP${100000 + i}` : null,
      compra_evento_em: compradoEm,
      ...origem,
      utm_content: null,
      fbclid: null,
      gclid: null,
      page_url: `https://lp.exemplo${VDF.rota}`,
      referrer: null,
      dispositivo: "mobile"
    };
    inscricao.checkout_url = linkDoCheckout(VDF, inscricao, i);
    inscricoes.push(inscricao);
    if (comprou) {
      // Venda de mais de 8 dias: gravada pela versão ANTERIOR da tabela (pagina_por null; o evento_em
      // veio do creation_date do payload, no backfill do supabase.sql).
      const antiga = new Date(compradoEm).getTime() < agoraMs - 8 * DIA;
      aviso({ evento_em: compradoEm, aprovado_em: compradoEm, evento: "PURCHASE_APPROVED", status: "APPROVED", transacao: inscricao.compra_transacao, comprador_nome: nome, comprador_email: inscricao.email, valor, sck: sckQueFoi(inscricao, "utm_term"), pagina: VDF.id, pagina_por: antiga ? null : "config", inscricao_id: inscricao.id, casou: true });
    }
  }
  // Comprou por outro link: a Hotmart devolve o sck dela (visto nos avisos reais) ou nenhum.
  for (let i = 0; i < 2; i++) {
    const quando = carimbo(i);
    aviso({ evento_em: quando, aprovado_em: quando, evento: "PURCHASE_APPROVED", status: "APPROVED", transacao: `HPVF-FORA-${i + 1}`, comprador_nome: `Comprou Por Fora ${i + 1}`, comprador_email: `porfora${i}@gmail.com`, valor: 197, sck: i === 0 ? "HOTMART_SALES_AGENT" : null, pagina: VDF.id });
  }
  // Produto que não é de página nenhuma (a Formação, um order bump): gravado, mas fora das abas.
  const formacao = carimbo(2);
  aviso({ evento_em: formacao, aprovado_em: formacao, evento: "PURCHASE_APPROVED", status: "APPROVED", transacao: "HPFORA-FORMACAO-1", comprador_nome: "Comprou A Formação", comprador_email: "formacao@gmail.com", valor: 997, sck: null, pagina: null });
  // Um reembolso, e o APPROVED dele chegou DEPOIS do REFUNDED (a primeira entrega falhou e a Hotmart
  // repetiu 6 horas depois, e ganhou id novo). Pela hora do EVENTO, o último foi o reembolso: a
  // venda sai da conta e a inscrição continua desmarcada (o aviso velho não sobrescreve o estado).
  const reembolsadaVdf = inscricoes.find((i) => i.pagina === VDF.id && i.comprou_em && new Date(i.comprou_em).getTime() < agoraMs - 3 * DIA);
  if (reembolsadaVdf) {
    reembolsadaVdf._sck = sckQueFoi(reembolsadaVdf, "utm_term");
    const [{ id: _primeiraEntrega, recebido_em: _chegada, ...aprovada }] = compras.splice(
      compras.findIndex((c) => c.transacao === reembolsadaVdf.compra_transacao),
      1
    );
    const reembolso = depois(reembolsadaVdf.comprou_em, 2 * DIA);
    marcarDesfeita(reembolsadaVdf, "PURCHASE_REFUNDED", "REFUNDED", reembolso);
    aviso({ ...aprovada, recebido_em: depois(reembolso, 6 * 3600000) });
  }
  // Um aviso antigo cujo payload não tinha creation_date nem approved_date: sem evento_em nem
  // aprovado_em, a hora que vale é a da chegada (coalesce(evento_em, recebido_em) no SQL), inclusive
  // para o comprou_em que ele gravou no inscrito.
  const semHora = compras.find((c) => c.pagina === VDF.id && c.pagina_por === null && c.inscricao_id && c.transacao !== reembolsadaVdf?.compra_transacao);
  if (semHora) {
    semHora.evento_em = null;
    semHora.aprovado_em = null;
    const dono = inscricoes.find((i) => i.id === semHora.inscricao_id);
    dono.comprou_em = semHora.recebido_em;
    dono.compra_evento_em = semHora.recebido_em;
  }

  // --- Imersão GPS (página de outro site): 90 inscritos, e-mail só .com/.com.br, ~30% comprando o
  //     ingresso (lote 1 R$ 5, lote 2 R$ 10), o utm_content é o sck. Mais: vendas sem inscrição
  //     (outro e-mail, link direto sem sck, a própria Hotmart), um chargeback, um reembolso, compras
  //     completas (a mesma transação duas vezes), boleto e abandono, e um criativo com HTML no nome.
  const r4 = rng(seed + 303);
  const GPS = CHK.PAGINAS["imersao-gps"];
  const ORIGENS_GPS = [
    { utm_source: "facebook", utm_medium: "paid", utm_campaign: "igps-set26-frio", utm_term: "publico-frio", utm_content: "video-iza-01" },
    { utm_source: "facebook", utm_medium: "paid", utm_campaign: "igps-set26-frio", utm_term: "publico-frio", utm_content: "carrossel-02" },
    { utm_source: "facebook", utm_medium: "paid", utm_campaign: "igps-set26-quente", utm_term: "lookalike-alunas", utm_content: "video-iza-01" },
    { utm_source: "instagram", utm_medium: "stories", utm_campaign: "igps-organico", utm_term: null, utm_content: "stories-contagem" },
    { utm_source: "whatsapp", utm_medium: "lista", utm_campaign: "lista-vip", utm_term: null, utm_content: null },
    { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null }
  ];
  const DOMINIOS_GPS = ["gmail.com", "gmail.com", "gmail.com", "hotmail.com", "outlook.com", "yahoo.com.br", "uol.com.br", "icloud.com"];
  const XSS_SCK = `<img src=x onerror="window.__xss=2">criativo`;
  for (let i = 0; i < 90; i++) {
    const criado = i === 7 ? new Date(agoraMs - 3 * 3600000).toISOString() : carimbo(Math.floor(Math.pow(r4(), 1.3) * 9));
    const origem = i === 7 ? { ...ORIGENS_GPS[0], utm_content: XSS_SCK } : ORIGENS_GPS[Math.floor(Math.pow(r4(), 1.4) * ORIGENS_GPS.length)];
    const comprou = i === 7 || r4() < 0.3;
    const nome = `${NOMES[Math.floor(r4() * NOMES.length)]} ${SOBRENOMES[Math.floor(r4() * SOBRENOMES.length)]}`;
    const digits = `${DDD[Math.floor(r4() * DDD.length)]}9${String(10000000 + Math.floor(r4() * 89999999))}`.slice(0, 11);
    const valor = r4() < 0.7 ? 5 : 10;
    const compradoEm = comprou ? new Date(Math.min(new Date(criado).getTime() + 420000, agoraMs - 1000)).toISOString() : null;
    const inscricao = {
      id: `30000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      pagina: GPS.id,
      criado_em: criado,
      atualizado_em: criado,
      nome,
      whatsapp: `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`,
      whatsapp_digits: digits,
      whatsapp_internacional: `55${digits}`,
      email: `${nome.split(" ")[0].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()}.gps${i}@${DOMINIOS_GPS[Math.floor(r4() * DOMINIOS_GPS.length)]}`,
      cliques: 1 + (r4() < 0.3 ? 1 : 0),
      clicou_em: criado,
      comprou_em: compradoEm,
      compra_status: comprou ? "APPROVED" : null,
      compra_valor: comprou ? valor : null,
      compra_transacao: comprou ? `HPGPS${200000 + i}` : null,
      compra_evento_em: compradoEm,
      ...origem,
      fbclid: origem.utm_source === "facebook" ? `IwAR-gps-${i}` : null,
      gclid: null,
      page_url: `${GPS.origem}${GPS.rota}`,
      referrer: null,
      dispositivo: i % 9 === 0 ? "desktop" : "mobile"
    };
    inscricao.checkout_url = linkDoCheckout(GPS, inscricao, i);
    inscricoes.push(inscricao);
    if (comprou) {
      // A do criativo com HTML no nome chegou 2 h depois do evento (o webhook estava fora do ar e a
      // Hotmart repetiu): em "Compras recentes", o "Quando" é a hora do EVENTO, não a da chegada.
      aviso({ evento_em: compradoEm, aprovado_em: compradoEm, ...(i === 7 ? { recebido_em: depois(compradoEm, 2 * 3600000) } : {}), evento: "PURCHASE_APPROVED", status: "APPROVED", transacao: inscricao.compra_transacao, comprador_nome: nome, comprador_email: inscricao.email, valor, sck: sckQueFoi(inscricao, "utm_content"), pagina: GPS.id, inscricao_id: inscricao.id, casou: true });
    }
  }
  const compradasGps = inscricoes.filter((i) => i.pagina === GPS.id && i.comprou_em);
  // Garantia vencida: a Hotmart manda PURCHASE_COMPLETE da MESMA transação (uma venda, não duas),
  // dias depois e com a data de aprovação de antes: a venda continua no dia em que foi APROVADA, e
  // não aparece como venda do dia da completa. O segundo chegou sem o sck: a venda fica com o do
  // APPROVED (o sck mais recente que veio preenchido).
  for (const [k, inscricao] of compradasGps.filter((i) => new Date(i.comprou_em).getTime() < agoraMs - 2 * DIA).slice(0, 2).entries()) {
    const completa = depois(inscricao.comprou_em, 7 * DIA);
    aviso({ evento_em: completa, aprovado_em: inscricao.comprou_em, evento: "PURCHASE_COMPLETE", status: "COMPLETE", transacao: inscricao.compra_transacao, comprador_nome: inscricao.nome, comprador_email: inscricao.email, valor: inscricao.compra_valor, sck: k === 1 ? null : sckQueFoi(inscricao, "utm_content"), pagina: GPS.id, inscricao_id: inscricao.id, casou: true });
    inscricao.compra_status = "COMPLETE";
    inscricao.compra_evento_em = completa;
  }
  const reembolsadaGps = compradasGps.filter((i) => new Date(i.comprou_em).getTime() < agoraMs - 2 * DIA)[2];
  if (reembolsadaGps) {
    reembolsadaGps._sck = sckQueFoi(reembolsadaGps, "utm_content");
    marcarDesfeita(reembolsadaGps, "PURCHASE_REFUNDED", "REFUNDED", depois(reembolsadaGps.comprou_em, DIA));
  }
  // Vendas do ingresso que não casam com ninguém: clicou no anúncio mas pagou com outro e-mail e
  // outro telefone (sck do criativo), link direto da Hotmart (sem sck), a própria Hotmart vendendo.
  for (const [dias, fora] of [
    [1, { transacao: "HPGPS-FORA-1", comprador_nome: "Bruna Outro E-mail", comprador_email: "bruna.outro@gmail.com", valor: 5, sck: "video-iza-01" }],
    [2, { transacao: "HPGPS-FORA-2", comprador_nome: "Link Direto", comprador_email: "direto@hotmail.com", valor: 10, sck: null }],
    [3, { transacao: "HPGPS-FORA-3", comprador_nome: "Afiliada Hotmart", comprador_email: "afiliada@outlook.com", valor: 5, sck: "HOTMART_SALES_AGENT" }]
  ]) {
    const quando = carimbo(dias);
    aviso({ evento_em: quando, aprovado_em: quando, evento: "PURCHASE_APPROVED", status: "APPROVED", ...fora, pagina: GPS.id });
  }
  // Aprovada e depois chargeback: sai das vendas.
  const aprovadaChargeback = carimbo(5);
  const contestado = { transacao: "HPGPS-FORA-4", comprador_nome: "Cartão Contestado", comprador_email: "contestado@gmail.com", valor: 5, sck: "carrossel-02", aprovado_em: aprovadaChargeback, pagina: GPS.id };
  aviso({ evento_em: aprovadaChargeback, evento: "PURCHASE_APPROVED", status: "APPROVED", ...contestado });
  aviso({ evento_em: depois(aprovadaChargeback, DIA), evento: "PURCHASE_CHARGEBACK", status: "CHARGEBACK", ...contestado });
  // Boleto gerado e checkout abandonado de quem se inscreveu e não pagou: aviso, não venda.
  const naoCompraramGps = inscricoes.filter((i) => i.pagina === GPS.id && !i.compra_transacao);
  if (naoCompraramGps[0]) {
    const x = naoCompraramGps[0];
    aviso({ evento_em: depois(x.criado_em, 300000), evento: "PURCHASE_BILLET_PRINTED", status: "BILLET_PRINTED", transacao: "HPGPS-BOLETO-1", comprador_nome: x.nome, comprador_email: x.email, valor: 10, sck: x.utm_content, pagina: GPS.id, inscricao_id: x.id, casou: true });
  }
  if (naoCompraramGps[1]) {
    const x = naoCompraramGps[1];
    aviso({ evento_em: depois(x.criado_em, 240000), evento: "PURCHASE_OUT_OF_SHOPPING_CART", status: null, transacao: null, comprador_nome: x.nome, comprador_email: x.email, valor: null, sck: null, pagina: GPS.id, inscricao_id: x.id, casou: true });
  }
  for (const inscricao of inscricoes) {
    delete inscricao._sck;
    delete inscricao._reenviou;
  }
  return { visitantes, pessoas: respostas, eventos, inscricoes, compras };
}

/* ------------------------------------------------------------------ Agregados (espelho do SQL) */

function noRecorte(iso, desde, ate) {
  const t = new Date(iso).getTime();
  if (desde && t < new Date(desde).getTime()) return false;
  if (ate && t >= new Date(ate).getTime()) return false;
  return true;
}

function valores(v) {
  if (typeof v === "string") return [v];
  if (typeof v === "number" || typeof v === "boolean") return [String(v)];
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").map(String);
  return [];
}

/** Busca como o servidor + SQL: nome/e-mail por trecho; dígitos só quando parece telefone. */
function casaBusca(p, busca) {
  // O servidor tira a sintaxe do PostgREST antes (vírgula, parênteses, *, %, aspas, barra).
  const b = String(busca || "").slice(0, 80).replace(/[,()*%"\\]/g, "").trim();
  if (!b) return true;
  const baixo = b.toLowerCase();
  if (p.nome.toLowerCase().includes(baixo) || p.email.toLowerCase().includes(baixo)) return true;
  if (!/^[\d\s+.-]+$/.test(b)) return false;
  let dig = b.replace(/\D/g, "");
  if (dig.length >= 12 && dig.startsWith("55")) dig = dig.slice(2);
  return Boolean(dig) && p.whatsapp_digits.includes(dig);
}

// Perfil, situação e busca são filtros de PESSOA; visitante (acesso) só tem período.
export function recorte(dados, { desde, ate, perfil, status, busca }) {
  const pessoas = dados.pessoas.filter(
    (p) => noRecorte(p.criado_em, desde, ate) && (!perfil || p.perfil === perfil) && (!status || p.status === status) && casaBusca(p, busca)
  );
  const visitantes = dados.visitantes.filter((v) => noRecorte(v.criado_em, desde, ate));
  return { pessoas, visitantes };
}

export function painel(dados, filtros) {
  const { pessoas, visitantes } = recorte(dados, filtros);
  const ignorar = new Set(EV.chavesTexto());
  const conc = pessoas.filter((p) => p.status === "concluida");
  const tempos = conc.map((p) => p.tempo_total_segundos).sort((a, b) => a - b);
  const mediana = tempos.length ? Math.round(tempos.length % 2 ? tempos[(tempos.length - 1) / 2] : (tempos[tempos.length / 2 - 1] + tempos[tempos.length / 2]) / 2) : null;
  const porEtapa = [];
  for (let e = 1; e <= 9; e++) porEtapa.push({ etapa: e, chegaram: pessoas.filter((p) => p.etapa_max >= e || p.status === "concluida").length });
  const parados = new Map();
  for (const p of pessoas) if (p.status === "em_andamento") parados.set(p.pergunta_max, (parados.get(p.pergunta_max) || 0) + 1);
  const perfis = new Map();
  for (const p of pessoas) {
    const k = p.perfil;
    const a = perfis.get(k) || { perfil: k, total: 0, concluidas: 0 };
    a.total++;
    if (p.status === "concluida") a.concluidas++;
    perfis.set(k, a);
  }
  const dist = new Map();
  const resp = new Map();
  const esc = new Map();
  for (const p of pessoas) {
    for (const [chave, v] of Object.entries(p.respostas)) {
      if (ignorar.has(chave)) continue;
      const kr = `${p.perfil}\u0000${chave}`;
      resp.set(kr, (resp.get(kr) || 0) + 1);
      for (const valor of new Set(valores(v))) {
        const kd = `${p.perfil}\u0000${chave}\u0000${valor}`;
        dist.set(kd, (dist.get(kd) || 0) + 1);
      }
      if (typeof v === "number") {
        const e = esc.get(kr) || { s: 0, n: 0 };
        e.s += v;
        e.n++;
        esc.set(kr, e);
      }
    }
  }
  const sp = (k) => k.split("\u0000");
  const perfilDe = (x) => (x === "null" ? null : x);
  const dias = new Map();
  const dia = (d) => {
    if (!dias.has(d)) dias.set(d, { dia: d, visitantes: 0, pessoas: 0, concluidas: 0 });
    return dias.get(d);
  };
  for (const v of visitantes) dia(diaSP(v.criado_em)).visitantes++;
  for (const p of pessoas) dia(diaSP(p.criado_em)).pessoas++;
  for (const p of conc) dia(diaSP(p.concluido_em)).concluidas++;
  const trafego = [];
  for (const campo of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "dispositivo"]) {
    const vazio = campo === "dispositivo" ? "(desconhecido)" : "(sem utm)";
    const m = new Map();
    const pega = (valor) => {
      const k = valor && String(valor).trim() ? String(valor).trim() : vazio;
      if (!m.has(k)) m.set(k, { campo, valor: k, visitantes: 0, pessoas: 0, concluidas: 0 });
      return m.get(k);
    };
    for (const v of visitantes) pega(v[campo]).visitantes++;
    for (const p of pessoas) {
      const a = pega(p[campo]);
      a.pessoas++;
      if (p.status === "concluida") a.concluidas++;
    }
    trafego.push(...Array.from(m.values()).sort((a, b) => b.pessoas - a.pessoas || b.visitantes - a.visitantes).slice(0, 30));
  }
  return {
    desde: filtros.desde || null,
    ate: filtros.ate || null,
    perfil: filtros.perfil || null,
    visitantes: visitantes.length,
    visitas: visitantes.reduce((s, v) => s + v.visitas, 0),
    comecaram: visitantes.filter((v) => v.comecou_em).length,
    pessoas: pessoas.length,
    tentativas: pessoas.reduce((s, p) => s + p.tentativas, 0),
    concluidas: conc.length,
    com_perfil: pessoas.filter((p) => p.perfil).length,
    tempo_mediano_segundos: mediana,
    por_etapa: porEtapa,
    pararam_em: Array.from(parados, ([pergunta, total]) => ({ pergunta, total })),
    perfis: Array.from(perfis.values()),
    distribuicoes: Array.from(dist, ([k, total]) => {
      const [perfil, chave, valor] = sp(k);
      return { perfil: perfilDe(perfil), chave, valor, total };
    }),
    responderam: Array.from(resp, ([k, total]) => {
      const [perfil, chave] = sp(k);
      return { perfil: perfilDe(perfil), chave, total };
    }),
    escalas: Array.from(esc, ([k, e]) => {
      const [perfil, chave] = sp(k);
      return { perfil: perfilDe(perfil), chave, media: Math.round((e.s / e.n) * 10) / 10, total: e.n };
    }),
    por_dia: Array.from(dias.values()).sort((a, b) => a.dia.localeCompare(b.dia)),
    trafego
  };
}

export function cruzamento(dados, filtros, linha, coluna) {
  const { pessoas } = recorte(dados, filtros);
  const cel = new Map();
  const lin = new Map();
  const col = new Map();
  let base = 0;
  for (const p of pessoas) {
    const vl = [...new Set(valores(p.respostas[linha]))];
    const vc = [...new Set(valores(p.respostas[coluna]))];
    if (!vl.length || !vc.length) continue;
    base++;
    for (const a of vl) lin.set(a, (lin.get(a) || 0) + 1);
    for (const b of vc) col.set(b, (col.get(b) || 0) + 1);
    for (const a of vl) for (const b of vc) cel.set(`${a}\u0000${b}`, (cel.get(`${a}\u0000${b}`) || 0) + 1);
  }
  return {
    linha,
    coluna,
    base,
    celulas: Array.from(cel, ([k, total]) => {
      const [l, c] = k.split("\u0000");
      return { linha: l, coluna: c, total };
    }),
    linhas: Array.from(lin, ([valor, total]) => ({ valor, total })),
    colunas: Array.from(col, ([valor, total]) => ({ valor, total }))
  };
}

export function abertas(dados, filtros, chaves, limite = 200, offset = 0) {
  const { pessoas } = recorte(dados, filtros);
  const com = pessoas
    .filter((p) => chaves.some((c) => typeof p.respostas[c] === "string" && p.respostas[c].trim()))
    .sort((a, b) => b.criado_em.localeCompare(a.criado_em));
  return {
    total: com.length,
    itens: com.slice(offset, offset + limite).map((p) => ({
      id: p.id,
      nome: p.nome,
      perfil: p.perfil,
      whatsapp: p.whatsapp,
      email: p.email,
      criado_em: p.criado_em,
      status: p.status,
      textos: Object.fromEntries(chaves.filter((c) => p.respostas[c]).map((c) => [c, p.respostas[c]]))
    }))
  };
}

export function lista(dados, filtros, { status, busca, limite = 100, offset = 0 }) {
  let { pessoas } = recorte(dados, { ...filtros, status: status ?? filtros.status, busca: busca ?? filtros.busca });
  pessoas = pessoas.slice().sort((a, b) => b.criado_em.localeCompare(a.criado_em) || b.id.localeCompare(a.id));
  return { total: pessoas.length, itens: pessoas.slice(offset, offset + limite) };
}

/**
 * Espelho de paginas_resumo(p_desde, p_ate, p_mapa): uma entrada por página de obrigado, na ordem
 * do config, com zeros e listas vazias quando ninguém passou por ela.
 */
export function paginas(dados, { desde, ate } = {}) {
  const mapa = new Map();
  for (const pagina of OBR.LISTA) for (const perfil of pagina.perfis) mapa.set(perfil, pagina.id);
  const eventos = (dados.eventos || []).filter((e) => noRecorte(e.criado_em, desde, ate));
  const atribuidas = dados.pessoas.filter((p) => p.finalizado_em && noRecorte(p.finalizado_em, desde, ate) && mapa.has(p.perfil));
  const quem = (e) => e.visitante_id ?? `evento-${e.id}`;
  const distintos = (lista) => new Set(lista.map(quem)).size;
  const agrupar = (lista, chave) => {
    const grupos = new Map();
    for (const item of lista) {
      const k = chave(item);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(item);
    }
    return grupos;
  };
  return Array.from(OBR.LISTA, (pagina) => {
    const ev = eventos.filter((e) => e.pagina === pagina.id);
    const visitas = ev.filter((e) => e.evento === "visita");
    const cliques = ev.filter((e) => e.evento === "clique_grupo");
    const atr = atribuidas.filter((p) => mapa.get(p.perfil) === pagina.id);
    const perfis = new Set([...ev.map((e) => e.perfil ?? null), ...atr.map((p) => p.perfil)]);
    return {
      pagina: pagina.id,
      visitas: visitas.length,
      visitantes: distintos(visitas),
      cliques: cliques.length,
      clicaram: distintos(cliques),
      atribuidas: atr.length,
      por_perfil: Array.from(perfis, (perfil) => ({
        perfil,
        visitantes: distintos(visitas.filter((e) => (e.perfil ?? null) === perfil)),
        clicaram: distintos(cliques.filter((e) => (e.perfil ?? null) === perfil)),
        atribuidas: atr.filter((p) => p.perfil === perfil).length
      })).sort((a, b) => b.visitantes - a.visitantes),
      por_origem: Array.from(agrupar(ev, (e) => (e.utm_source && String(e.utm_source).trim()) || "(sem utm)"), ([utm_source, lista]) => ({
        utm_source,
        visitantes: distintos(lista.filter((e) => e.evento === "visita")),
        clicaram: distintos(lista.filter((e) => e.evento === "clique_grupo"))
      })).sort((a, b) => b.visitantes - a.visitantes || b.clicaram - a.clicaram),
      por_dia: Array.from(agrupar(ev, (e) => diaSP(e.criado_em)), ([dia, lista]) => ({
        dia,
        visitantes: distintos(lista.filter((e) => e.evento === "visita")),
        clicaram: distintos(lista.filter((e) => e.evento === "clique_grupo"))
      })).sort((a, b) => a.dia.localeCompare(b.dia))
    };
  });
}


/* ------------------------------------------------------------------ Inscrições (espelho do SQL) */

const diaDe = (iso) => diaSP(iso);
const APROVADOS = ["PURCHASE_APPROVED", "PURCHASE_COMPLETE"];
const DESFECHOS = [...APROVADOS, "PURCHASE_CANCELED", "PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST"];
const ms = (iso) => new Date(iso).getTime();
/** Ordem de chegada do SQL: recebido_em desc, id desc (o mais recente primeiro). */
const porChegada = (a, b) => ms(b.recebido_em) - ms(a.recebido_em) || b.id - a.id;
/** coalesce(evento_em, recebido_em): quando o evento ACONTECEU (aviso sem a hora do evento: a chegada). */
const momento = (c) => ms(c.evento_em ?? c.recebido_em);
/** Ordem do histórico de uma venda no SQL: momento desc, recebido_em desc, id desc. */
const porMomento = (a, b) => momento(b) - momento(a) || porChegada(a, b);
/** btrim(x) do SQL: tira só espaços das pontas. */
const btrim = (valor) => String(valor).replace(/^ +| +$/g, "");
/** nullif(btrim(x), '') is not null */
const preenchido = (valor) => valor != null && btrim(valor) !== "";
const centavos = (valor) => Math.round(valor * 100) / 100;
/** `collate "C"` do SQL: ordem de byte (os valores das fixtures são ASCII). */
const ordemC = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Os CTEs `historico` e `vendas` de inscricoes_resumo: uma linha por VENDA (transação) do lado da
 * Hotmart que conta no recorte.
 *   . histórico = TODOS os avisos de compra/desfazimento da transação (do produto da página, se há
 *     p_pagina) cujo EVENTO aconteceu antes de p_ate (coalesce(evento_em, recebido_em) < p_ate: a
 *     venda de 23:59 cujo aviso chega 00:00, ou reenviado dias depois, fica no dia dela) — sem
 *     cortar em p_desde;
 *   . estado = o evento mais recente pela hora do EVENTO (coalesce(evento_em, recebido_em); a
 *     chegada e o id desempatam): o APPROVED reenviado depois do REFUNDED não ressuscita a venda;
 *   . sck = o mais recente preenchido; valor = o mais recente de aprovada/completa; inscricao_id =
 *     o mais recente não nulo; aprovada_em = a PRIMEIRA aprovação (coalesce(aprovado_em, momento));
 *   . conta se o estado é aprovada/completa e aprovada_em está em [p_desde, p_ate).
 */
function vendasDoRecorte(compras, { desde, ate, pagina }) {
  const historico = compras
    .filter((c) => (!pagina || c.pagina === pagina) && (!ate || momento(c) < ms(ate)) && c.transacao != null && DESFECHOS.includes(c.evento))
    .sort(porMomento);
  const porTransacao = new Map();
  for (const h of historico) {
    if (!porTransacao.has(h.transacao)) porTransacao.set(h.transacao, []);
    porTransacao.get(h.transacao).push(h);
  }
  const vendas = [];
  for (const [transacao, avisos] of porTransacao) {
    const [ultimo] = avisos;
    if (!APROVADOS.includes(ultimo.evento)) continue;
    const aprovados = avisos.filter((h) => APROVADOS.includes(h.evento));
    const aprovadaEm = Math.min(...aprovados.map((h) => ms(h.aprovado_em ?? h.evento_em ?? h.recebido_em)));
    if ((desde && aprovadaEm < ms(desde)) || (ate && aprovadaEm >= ms(ate))) continue;
    vendas.push({
      transacao,
      evento: ultimo.evento,
      pagina: ultimo.pagina ?? null,
      sck: avisos.find((h) => preenchido(h.sck))?.sck ?? null,
      valor: aprovados.find((h) => h.valor != null)?.valor ?? null,
      inscricao_id: avisos.find((h) => h.inscricao_id != null)?.inscricao_id ?? null,
      aprovada_em: new Date(aprovadaEm).toISOString()
    });
  }
  return vendas;
}

/**
 * O que inscricoes_resumo(p_desde, p_ate, p_pagina) devolve, calculado em JS sobre as fixtures.
 * Mesmo contrato do supabase.sql (seção 6): inscritos pela data da inscrição; com p_pagina, os
 * avisos são só os do produto daquela página; `vendas` (e vendas_receita, vendas_por_sck e
 * compras_sem_inscricao) saem de vendasDoRecorte, a régua do SQL; compras_recentes são os avisos
 * que CHEGARAM no período.
 */
export function inscricoesResumo(dados, { desde, ate, pagina } = {}) {
  const todas = (dados.inscricoes || []).filter(
    (i) => noRecorte(i.criado_em, desde, ate) && (!pagina || i.pagina === pagina)
  );
  const eventos = (dados.compras || [])
    .filter((c) => noRecorte(c.recebido_em, desde, ate) && (!pagina || c.pagina === pagina))
    .sort(porChegada);
  const vendas = vendasDoRecorte(dados.compras || [], { desde, ate, pagina });
  // Com p_pagina, só ela (mesmo zerada). Sem, toda página que teve inscrição OU venda no período.
  const paginas = pagina
    ? [pagina]
    : Array.from(new Set([...todas.map((i) => i.pagina), ...vendas.map((v) => v.pagina).filter((p) => p != null)])).sort(ordemC);

  const divisao = (lista, campo, chave) => {
    const grupos = new Map();
    for (const i of lista) {
      const k = preenchido(i[campo]) ? btrim(i[campo]) : "(sem utm)";
      if (!grupos.has(k)) grupos.set(k, { inscritos: 0, compras: 0 });
      const g = grupos.get(k);
      g.inscritos += 1;
      if (i.comprou_em) g.compras += 1;
    }
    return Array.from(grupos, ([valor, g]) => ({ [chave]: valor, inscritos: g.inscritos, compras: g.compras }))
      .sort((a, b) => b.inscritos - a.inscritos || b.compras - a.compras || ordemC(a[chave], b[chave]))
      .slice(0, 50);
  };

  const porSck = (lista) => {
    const grupos = new Map();
    for (const v of lista) {
      const k = preenchido(v.sck) ? btrim(v.sck) : "(sem sck)";
      if (!grupos.has(k)) grupos.set(k, { vendas: 0, receita: 0, casadas: 0 });
      const g = grupos.get(k);
      g.vendas += 1;
      g.receita += Number(v.valor || 0);
      if (v.inscricao_id != null) g.casadas += 1;
    }
    // limit 500 no SQL: é por venda, e com utm_content={{ad.name}} passa fácil de 50 criativos.
    return Array.from(grupos, ([sck, g]) => ({ sck, vendas: g.vendas, receita: centavos(g.receita), casadas: g.casadas }))
      .sort((a, b) => b.vendas - a.vendas || b.receita - a.receita || ordemC(a.sck, b.sck))
      .slice(0, 500);
  };

  return {
    paginas: paginas.map((id) => {
      const minhas = todas.filter((i) => i.pagina === id);
      const compradas = minhas.filter((i) => i.comprou_em);
      const minhasVendas = vendas.filter((v) => v.pagina === id);
      const dias = new Map();
      for (const i of minhas) {
        const d = diaDe(i.criado_em);
        if (!dias.has(d)) dias.set(d, { inscritos: 0, compras: 0 });
        dias.get(d).inscritos += 1;
      }
      for (const i of compradas) {
        const d = diaDe(i.comprou_em);
        if (!dias.has(d)) dias.set(d, { inscritos: 0, compras: 0 });
        dias.get(d).compras += 1;
      }
      const inscritos = minhas.length;
      return {
        pagina: id,
        inscritos,
        cliques: minhas.reduce((s, i) => s + i.cliques, 0),
        compras: compradas.length,
        receita: centavos(compradas.reduce((s, i) => s + Number(i.compra_valor || 0), 0)),
        taxa_compra: inscritos ? Math.round((compradas.length / inscritos) * 1000) / 10 : 0,
        por_origem: divisao(minhas, "utm_source", "utm_source"),
        por_midia: divisao(minhas, "utm_medium", "utm_medium"),
        por_campanha: divisao(minhas, "utm_campaign", "utm_campaign"),
        por_conteudo: divisao(minhas, "utm_content", "utm_content"),
        por_termo: divisao(minhas, "utm_term", "utm_term"),
        vendas: minhasVendas.length,
        vendas_receita: centavos(minhasVendas.reduce((s, v) => s + Number(v.valor || 0), 0)),
        vendas_por_sck: porSck(minhasVendas),
        por_dia: Array.from(dias, ([dia, g]) => ({ dia, ...g })).sort((a, b) => a.dia.localeCompare(b.dia))
      };
    }),
    // As vendas de cima que não casaram com ninguém (= vendas − casadas; a reembolsada já saiu). Sem
    // p_pagina entram também as de produto de fora (pagina null).
    compras_sem_inscricao: vendas.filter((v) => v.inscricao_id == null).length,
    // Os que CHEGARAM no período (recebido_em), e com a hora do EVENTO na Hotmart (evento_em; null
    // no aviso antigo sem creation_date).
    compras_recentes: eventos.slice(0, 20).map((c) => ({
      recebido_em: c.recebido_em,
      evento_em: c.evento_em ?? null,
      evento: c.evento,
      status: c.status,
      comprador_nome: c.comprador_nome,
      comprador_email: c.comprador_email,
      valor: c.valor,
      pagina: c.pagina,
      sck: c.sck,
      casou: c.inscricao_id != null
    }))
  };
}

/**
 * O mesmo resumo como o SQL ANTIGO (o de produção antes de por_midia, por_conteudo e das vendas)
 * devolvia. Com `dados`, também o compras_sem_inscricao e o compras_recentes de lá: AVISOS de compra
 * aprovada/completa no período que não casaram (um por aviso, reembolsada inclusive) e os avisos do
 * período, os de produto de fora (pagina null) junto com os da página, sem o sck e sem o evento_em
 * (só a hora da chegada); e, sem p_pagina, só as páginas que tiveram inscrição.
 */
export function comoSqlAntigo(resumo, dados, { desde, ate, pagina } = {}) {
  const antigo = {
    ...resumo,
    paginas: resumo.paginas.map((linha) => {
      const { por_midia, por_conteudo, vendas, vendas_receita, vendas_por_sck, ...resto } = linha;
      return resto;
    }),
    compras_recentes: resumo.compras_recentes.map((compra) => {
      const { sck, evento_em, ...resto } = compra;
      return resto;
    })
  };
  if (!dados) return antigo;
  const eventos = (dados.compras || [])
    .filter((c) => noRecorte(c.recebido_em, desde, ate) && (!pagina || c.pagina === pagina || c.pagina == null))
    .sort(porChegada);
  return {
    ...antigo,
    paginas: antigo.paginas.filter((linha) => pagina || linha.inscritos > 0),
    compras_sem_inscricao: eventos.filter((c) => c.inscricao_id == null && APROVADOS.includes(c.evento)).length,
    compras_recentes: eventos.slice(0, 20).map((c) => ({
      recebido_em: c.recebido_em,
      evento: c.evento,
      status: c.status,
      comprador_nome: c.comprador_nome,
      comprador_email: c.comprador_email,
      valor: c.valor,
      pagina: c.pagina,
      casou: c.inscricao_id != null
    }))
  };
}

/** A lista de inscritos de /api/painel/inscricoes (mais recentes primeiro). */
export function listaInscricoes(dados, { desde, ate, pagina } = {}, { limite = 100, offset = 0 } = {}) {
  const todas = (dados.inscricoes || [])
    .filter((i) => noRecorte(i.criado_em, desde, ate) && (!pagina || i.pagina === pagina))
    .sort((a, b) => b.criado_em.localeCompare(a.criado_em) || b.id.localeCompare(a.id));
  return { itens: todas.slice(offset, offset + limite), total: todas.length };
}
