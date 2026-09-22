// Apoio da suíte tests/e2e/painel.e2e.mjs.
//
// Gera um conjunto realista e determinístico (semente fixa) de visitantes, pessoas e eventos das
// páginas de obrigado e reproduz, em JS, o que as funções SQL devolvem (pesquisa_painel,
// pesquisa_cruzamento, pesquisa_abertas, paginas_resumo) e a view pesquisa_pessoas para
// /respostas. Usa o EVPesquisa e o EVObrigado de verdade (via vm, no mesmo contexto, como no
// navegador). As funções SQL em si são provadas contra o Postgres em sql.e2e.mjs; aqui o assunto é
// a TELA do painel.
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
export const EV = ctx.EVPesquisa;
export const OBR = ctx.EVObrigado;

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
  return { visitantes, pessoas: respostas, eventos };
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
