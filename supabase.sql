-- Banco da pesquisa de ICP da Escola Enfermagem de Valor (formulário /pesquisa + painel /painel).
--
-- COMO RODAR: Supabase > SQL Editor > New query > cole o arquivo INTEIRO > Run.
-- O arquivo é idempotente: rodar de novo (por exemplo, depois de atualizar o repositório) não apaga
-- nenhuma resposta e deixa o banco igual ao que está descrito aqui. Não há drop table em lugar nenhum.
--
-- Quem lê e escreve nestas tabelas é SÓ o servidor (server.mjs), com a chave service_role.
-- Por isso:
--   . Row Level Security ligada e SEM políticas: nenhuma chave pública (anon) nem usuário logado
--     do Supabase (authenticated) lê ou escreve uma linha sequer. A service_role tem BYPASSRLS e
--     continua funcionando normalmente.
--   . Além do RLS, os grants de anon/authenticated são revogados em tabela, view e função. No
--     Supabase, tudo o que nasce em public recebe grant automático para anon — e uma VIEW não
--     respeita o RLS da tabela a menos que seja security_invoker. As duas barreiras juntas fazem
--     com que um esquecimento em uma delas não vire vazamento de telefone e e-mail.
--
-- Os nomes, colunas, parâmetros e o formato do JSON de cada função são contrato com o server.mjs e
-- com o painel (js/painel.js). Mudou aqui? Mude lá também — e rode tests/e2e/sql.e2e.mjs.


-- ============================================================================================
-- 1. pesquisa_visitas — uma linha por VISITANTE (id gerado no navegador e guardado no aparelho)
--
-- É o topo do funil: quantas pessoas abriram a pesquisa e quantas clicaram em "Começar". Não tem
-- dado pessoal nenhum — só origem do tráfego —, e é por isso que dá para contar quem nunca se
-- identificou.
-- ============================================================================================
create table if not exists public.pesquisa_visitas (
  visitante_id uuid primary key,
  pesquisa text not null default 'icp-escola-ev',
  criado_em timestamptz not null default now(),      -- primeira visita
  atualizado_em timestamptz not null default now(),  -- última visita ou clique
  visitas integer not null default 1,                -- quantas vezes a página foi aberta
  comecou_em timestamptz,                            -- primeiro clique em "Começar"
  page_url text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  gclid text,
  dispositivo text                                   -- 'mobile' | 'tablet' | 'desktop'
);

-- O painel sempre recorta por período: "visitantes de hoje", "dos últimos 7 dias".
create index if not exists pesquisa_visitas_pesquisa_criado_em_idx
  on public.pesquisa_visitas (pesquisa, criado_em desc);


-- ============================================================================================
-- 2. pesquisa_respostas — uma linha por TENTATIVA (id = sessão gerada no navegador)
--
-- A linha nasce quando o contato (nome, WhatsApp, e-mail) é aceito e é ATUALIZADA a cada
-- resposta: é assim que "tudo o que a pessoa respondeu até onde parou" fica no banco, mesmo que
-- ela feche a página no meio. Quem responde duas vezes (outro aparelho, "começar do zero") vira
-- duas tentativas; a view pesquisa_pessoas junta as tentativas pelo WhatsApp.
-- ============================================================================================
create table if not exists public.pesquisa_respostas (
  id uuid primary key,
  pesquisa text not null default 'icp-escola-ev',
  pesquisa_versao text not null,
  visitante_id uuid,
  criado_em timestamptz not null default now(),      -- quando o contato foi aceito
  atualizado_em timestamptz not null default now(),
  ultima_resposta_em timestamptz,
  -- Primeira vez que a tentativa ficou completa. Nunca volta a null: se a pessoa trocar o perfil
  -- depois de terminar, a pesquisa dela continua contando como concluída.
  concluido_em timestamptz,
  -- 'concluida' é pegajoso pelo mesmo motivo.
  status text not null default 'em_andamento' check (status in ('em_andamento', 'concluida')),
  -- Número de ordem do salvamento, dado pelo navegador. Só aplica se for MAIOR que o gravado:
  -- uma requisição atrasada (rede ruim, fila re-tentando) nunca sobrescreve um estado mais novo.
  seq integer not null default 0,
  nome text not null,
  whatsapp text not null,                            -- "(11) 91234-5678"
  whatsapp_digits text not null,                     -- "11912345678"
  -- Pronto para wa.me e para o CRM, sem ninguém precisar concatenar o 55 na mão.
  whatsapp_internacional text generated always as ('55' || whatsapp_digits) stored,
  email text not null,
  perfil text,                                       -- = respostas->>'perfil', coluna para filtrar rápido
  respostas jsonb not null default '{}'::jsonb,      -- saída de EVPesquisa.sanitizar()
  pergunta_atual text,                               -- tela em que a pessoa está agora (id ou 'fim')
  etapa_atual smallint not null default 0,
  -- O ponto MAIS DISTANTE alcançado (índice 1-based em PERGUNTAS; 'fim' = total + 1). Nunca
  -- diminui: quem volta para corrigir uma resposta não "desanda" no funil.
  posicao_max smallint not null default 0,
  pergunta_max text,
  etapa_max smallint not null default 0,
  respondidas smallint not null default 0,
  obrigatorias smallint not null default 0,
  obrigatorias_respondidas smallint not null default 0,
  total_perguntas smallint not null default 0,
  progresso_percentual smallint not null default 0,
  tempos jsonb not null default '{}'::jsonb,         -- segundos por pergunta {id: n}
  tempo_total_segundos integer,                      -- criado_em -> concluido_em, gravado uma vez
  page_url text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  gclid text,
  dispositivo text
);

-- Colunas que chegaram depois da primeira versão da tabela. "add column if not exists" deixa o
-- arquivo rodar de novo em banco que já tem a tabela antiga, sem apagar nada.
--   finalizado_em       primeira vez que a pessoa CHEGOU à tela de fim (nunca volta a null). É o
--                       gatilho do único aviso ao n8n por tentativa.
--   webhook_enviado_em  quando o n8n confirmou (2xx) o recebimento desse aviso.
alter table public.pesquisa_respostas add column if not exists finalizado_em timestamptz;
alter table public.pesquisa_respostas add column if not exists webhook_enviado_em timestamptz;

-- Lista do painel e recorte por período.
create index if not exists pesquisa_respostas_pesquisa_criado_em_idx
  on public.pesquisa_respostas (pesquisa, criado_em desc);
-- A view pesquisa_pessoas agrupa por (pesquisa, whatsapp_digits); a busca por telefone também.
create index if not exists pesquisa_respostas_pesquisa_whatsapp_idx
  on public.pesquisa_respostas (pesquisa, whatsapp_digits);
create index if not exists pesquisa_respostas_pesquisa_perfil_idx
  on public.pesquisa_respostas (pesquisa, perfil);
create index if not exists pesquisa_respostas_pesquisa_status_idx
  on public.pesquisa_respostas (pesquisa, status);

alter table public.pesquisa_visitas enable row level security;
alter table public.pesquisa_respostas enable row level security;

-- Tabela criada em public nasce com grant para anon e authenticated no Supabase. O RLS sem política
-- já bloqueia as linhas; o revoke tira até a possibilidade de tentar.
revoke all on table public.pesquisa_visitas from public, anon, authenticated;
revoke all on table public.pesquisa_respostas from public, anon, authenticated;
grant select, insert, update, delete on table public.pesquisa_visitas to service_role;
grant select, insert, update, delete on table public.pesquisa_respostas to service_role;


-- ============================================================================================
-- 3. Views
--
-- São recriadas a cada execução (drop + create) porque "create or replace view" não aceita mudar
-- colunas de lugar: assim uma coluna nova no futuro entra sem ninguém precisar apagar nada na mão.
-- A planilha depende da view de pessoas, então cai primeiro.
-- ============================================================================================
drop view if exists public.pesquisa_planilha;
drop view if exists public.pesquisa_pessoas;

-- pesquisa_pessoas — uma linha por PESSOA (WhatsApp), escolhendo a tentativa mais avançada:
-- concluída antes de em andamento; depois a que chegou mais longe; depois a que tem mais
-- respostas; depois a mais recente. O id no fim só desempata de forma estável (mesma pessoa,
-- mesma linha, em toda consulta).
--
-- `tentativas` é uma window function, que o Postgres calcula ANTES do distinct on: por isso ela
-- conta todas as tentativas do WhatsApp, e não só a que sobrou.
--
-- security_invoker = true: a view consulta a tabela com as permissões de QUEM consulta a view, e
-- não do dono dela (postgres, que ignora RLS). Sem isto, um grant esquecido em anon vazaria tudo.
create view public.pesquisa_pessoas
with (security_invoker = true)
as
select distinct on (r.pesquisa, r.whatsapp_digits)
  r.*,
  (count(*) over (partition by r.pesquisa, r.whatsapp_digits))::int as tentativas
from public.pesquisa_respostas as r
order by
  r.pesquisa,
  r.whatsapp_digits,
  (r.status = 'concluida') desc,
  r.posicao_max desc,
  r.respondidas desc,
  r.atualizado_em desc,
  r.id;

-- pesquisa_planilha — uma coluna por pergunta, para analisar direto no SQL Editor, no Metabase ou
-- exportando do próprio Supabase (Table Editor > Export). Os ids das colunas são os mesmos de
-- js/pesquisa-config.js. Pergunta de múltipla escolha vira text[]; escala vira número; o resto é
-- texto. Pergunta que não se aplica ao perfil (ou que a pessoa ainda não respondeu) fica null.
-- Sem colunas <id>_outro: por decisão do cliente nenhuma pergunta tem "Outro" (só respostas concretas).
create view public.pesquisa_planilha
with (security_invoker = true)
as
select
  id,
  pesquisa,
  pesquisa_versao,
  criado_em,
  atualizado_em,
  ultima_resposta_em,
  concluido_em,
  finalizado_em,
  webhook_enviado_em,
  status,
  progresso_percentual,
  respondidas,
  obrigatorias,
  obrigatorias_respondidas,
  total_perguntas,
  pergunta_atual,
  pergunta_max,
  etapa_max,
  tentativas,
  tempo_total_segundos,
  nome,
  whatsapp,
  whatsapp_digits,
  whatsapp_internacional,
  email,
  -- Etapa 1 — Sobre você
  respostas ->> 'perfil' as perfil,                                               -- 1
  respostas ->> 'idade' as idade,                                                 -- 2
  respostas ->> 'estado' as estado,                                               -- 3
  respostas ->> 'localidade' as localidade,                                       -- 4
  respostas ->> 'tempo_area' as tempo_area,                                       -- 5
  -- Etapa 2 — Seu momento profissional
  respostas ->> 'situacao_profissional' as situacao_profissional,                 -- 6
  respostas ->> 'trabalha_saude' as trabalha_saude,                               -- 7
  case when jsonb_typeof(respostas -> 'ambientes') = 'array'                      -- 8
    then array(select jsonb_array_elements_text(respostas -> 'ambientes')) end as ambientes,
  respostas ->> 'renda_atual' as renda_atual,                                     -- 9
  -- Etapa 3 — Suas dificuldades
  respostas ->> 'maior_dificuldade' as maior_dificuldade,                         -- 10
  respostas ->> 'situacao_incomoda' as situacao_incomoda,                         -- 11
  (respostas ->> 'seguranca')::smallint as seguranca,                             -- 12
  case when jsonb_typeof(respostas -> 'inseguranca_situacoes') = 'array'          -- 13
    then array(select jsonb_array_elements_text(respostas -> 'inseguranca_situacoes')) end as inseguranca_situacoes,
  -- Etapa 4 — Onde você quer chegar
  respostas ->> 'objetivo_12m' as objetivo_12m,                                   -- 14
  respostas ->> 'renda_desejada' as renda_desejada,                               -- 15
  respostas ->> 'evolucao_carreira' as evolucao_carreira,                         -- 16
  -- Etapa 5 — Cursos e investimento
  respostas ->> 'frequencia_investimento' as frequencia_investimento,             -- 17
  respostas ->> 'maior_investimento' as maior_investimento,                       -- 18
  respostas ->> 'disposicao_investimento' as disposicao_investimento,             -- 19
  respostas ->> 'criterio_compra' as criterio_compra,                             -- 20
  case when jsonb_typeof(respostas -> 'objecoes') = 'array'                       -- 21
    then array(select jsonb_array_elements_text(respostas -> 'objecoes')) end as objecoes,
  -- Etapa 6 — Como você prefere aprender
  case when jsonb_typeof(respostas -> 'formato_aprendizado') = 'array'            -- 22
    then array(select jsonb_array_elements_text(respostas -> 'formato_aprendizado')) end as formato_aprendizado,
  respostas ->> 'tempo_estudo' as tempo_estudo,                                   -- 23
  case when jsonb_typeof(respostas -> 'periodo_estudo') = 'array'                 -- 24
    then array(select jsonb_array_elements_text(respostas -> 'periodo_estudo')) end as periodo_estudo,
  -- Etapa 7 — Conteúdo e relacionamento com a Iza
  case when jsonb_typeof(respostas -> 'fontes_informacao') = 'array'              -- 25
    then array(select jsonb_array_elements_text(respostas -> 'fontes_informacao')) end as fontes_informacao,
  case when jsonb_typeof(respostas -> 'tipos_conteudo') = 'array'                 -- 26
    then array(select jsonb_array_elements_text(respostas -> 'tipos_conteudo')) end as tipos_conteudo,
  respostas ->> 'como_conheceu' as como_conheceu,                                 -- 27
  respostas ->> 'tempo_acompanha' as tempo_acompanha,                             -- 28
  -- Etapa 8 — Perguntas abertas
  respostas ->> 'problema_unico' as problema_unico,                               -- 29
  respostas ->> 'sonho' as sonho,                                                 -- 30
  respostas ->> 'frase_desejo' as frase_desejo,                                   -- 31 "Eu gostaria muito de"
  respostas ->> 'frase_bloqueio' as frase_bloqueio,                               -- 31 "mas ainda não consegui porque"
  -- Etapa 9 — Perguntas específicas do perfil
  respostas ->> 'auxiliar_situacao' as auxiliar_situacao,                         -- A1
  respostas ->> 'auxiliar_documentos' as auxiliar_documentos,                     -- A2
  respostas ->> 'cuidador_realidade' as cuidador_realidade,                       -- B1
  respostas ->> 'cuidador_dificuldade' as cuidador_dificuldade,                   -- B2
  respostas ->> 'tecnico_momento' as tecnico_momento,                             -- C1
  respostas ->> 'tecnico_objetivo' as tecnico_objetivo,                           -- C2
  respostas ->> 'enfermeiro_interesse' as enfermeiro_interesse,                   -- D1
  respostas ->> 'enfermeiro_caminho' as enfermeiro_caminho,                       -- D2
  -- Origem
  dispositivo,
  utm_source,
  utm_medium,
  utm_campaign,
  utm_content,
  utm_term,
  fbclid,
  gclid,
  page_url,
  referrer,
  visitante_id
from public.pesquisa_pessoas;

revoke all on table public.pesquisa_pessoas from public, anon, authenticated;
revoke all on table public.pesquisa_planilha from public, anon, authenticated;
grant select on table public.pesquisa_pessoas to service_role;
grant select on table public.pesquisa_planilha to service_role;


-- ============================================================================================
-- 4. Funções
--
-- Todas são security invoker (rodam com as permissões de quem chama — a service_role) e fixam o
-- search_path, para que ninguém consiga trocar uma tabela por outra de mesmo nome em outro schema.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- pesquisa_valores: os valores "contáveis" de uma resposta, um por linha.
--   "25 a 34 anos"          -> 25 a 34 anos
--   7                       -> 7
--   ["Hospital","Clínica"]  -> Hospital / Clínica
-- É o que deixa as perguntas de múltipla escolha serem contadas junto com as de escolha única.
-- Elementos repetidos num array saem uma vez só: cada pessoa conta no máximo uma vez por valor, e
-- as contagens podem usar count(*) em vez de count(distinct), que é bem mais caro.
--
-- ATENÇÃO: pesquisa_painel e pesquisa_cruzamento repetem esta mesma expressão por dentro, em vez
-- de chamar a função. Função com "set search_path" nunca é embutida (inlined) pelo Postgres, e a
-- chamada, feita uma vez por resposta de cada pessoa, deixava o painel 3x mais lento com 20 mil
-- respostas. Mudou a regra aqui? Mude lá também (procure por "= pesquisa_valores").
-- --------------------------------------------------------------------------------------------
create or replace function public.pesquisa_valores(v jsonb)
returns setof text
language sql
immutable
set search_path = public
as $$
  select distinct e #>> '{}'
  from jsonb_array_elements(case when jsonb_typeof(v) = 'array' then v else jsonb_build_array(v) end) as e
  where jsonb_typeof(e) in ('string', 'number', 'boolean');
$$;


-- --------------------------------------------------------------------------------------------
-- pesquisa_registrar_evento: 'visita' (a página abriu) ou 'inicio' (clicou em "Começar").
--
-- Uma linha por visitante, com upsert: recarregar a página soma visitas, mas não cria visitante
-- novo. O rastreio é de PRIMEIRO toque — quem chegou pelo anúncio e voltou depois pelo link direto
-- continua creditado ao anúncio; campo que estava vazio é preenchido.
--
-- A linha nasce com visitas = 1 mesmo quando o primeiro evento que chega é 'inicio': se alguém
-- clicou em começar, a página abriu pelo menos uma vez (o aviso de visita é que se perdeu na rede).
-- --------------------------------------------------------------------------------------------
create or replace function public.pesquisa_registrar_evento(p_visitante uuid, p_evento text, p_dados jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  d jsonb := coalesce(p_dados, '{}'::jsonb);
begin
  if p_visitante is null then
    raise exception 'pesquisa_registrar_evento: visitante obrigatório' using errcode = '22023';
  end if;
  if p_evento is null or p_evento not in ('visita', 'inicio') then
    raise exception 'pesquisa_registrar_evento: evento inválido (%)', p_evento using errcode = '22023';
  end if;

  insert into public.pesquisa_visitas as v (
    visitante_id, pesquisa, visitas, comecou_em,
    page_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, gclid, dispositivo
  ) values (
    p_visitante,
    coalesce(nullif(btrim(d ->> 'pesquisa'), ''), 'icp-escola-ev'),
    1,
    case when p_evento = 'inicio' then now() end,
    -- nullif(btrim()): string vazia gravada contaria como "já preenchido" e travaria o primeiro toque.
    nullif(btrim(d ->> 'page_url'), ''),
    nullif(btrim(d ->> 'referrer'), ''),
    nullif(btrim(d ->> 'utm_source'), ''),
    nullif(btrim(d ->> 'utm_medium'), ''),
    nullif(btrim(d ->> 'utm_campaign'), ''),
    nullif(btrim(d ->> 'utm_content'), ''),
    nullif(btrim(d ->> 'utm_term'), ''),
    nullif(btrim(d ->> 'fbclid'), ''),
    nullif(btrim(d ->> 'gclid'), ''),
    nullif(btrim(d ->> 'dispositivo'), '')
  )
  on conflict (visitante_id) do update set
    visitas = v.visitas + (p_evento = 'visita')::int,
    atualizado_em = now(),
    comecou_em = coalesce(v.comecou_em, excluded.comecou_em),
    page_url = coalesce(v.page_url, excluded.page_url),
    referrer = coalesce(v.referrer, excluded.referrer),
    -- Campanha (utm_* + fbclid + gclid) é UM bloco de primeiro toque: se a primeira visita tinha
    -- qualquer um deles, fica o bloco dela inteiro; senão entra o bloco da visita nova. Campo a
    -- campo misturaria visitas diferentes numa atribuição que não existiu.
    utm_source = case when (v.utm_source, v.utm_medium, v.utm_campaign, v.utm_content, v.utm_term, v.fbclid, v.gclid) is null then excluded.utm_source else v.utm_source end,
    utm_medium = case when (v.utm_source, v.utm_medium, v.utm_campaign, v.utm_content, v.utm_term, v.fbclid, v.gclid) is null then excluded.utm_medium else v.utm_medium end,
    utm_campaign = case when (v.utm_source, v.utm_medium, v.utm_campaign, v.utm_content, v.utm_term, v.fbclid, v.gclid) is null then excluded.utm_campaign else v.utm_campaign end,
    utm_content = case when (v.utm_source, v.utm_medium, v.utm_campaign, v.utm_content, v.utm_term, v.fbclid, v.gclid) is null then excluded.utm_content else v.utm_content end,
    utm_term = case when (v.utm_source, v.utm_medium, v.utm_campaign, v.utm_content, v.utm_term, v.fbclid, v.gclid) is null then excluded.utm_term else v.utm_term end,
    fbclid = case when (v.utm_source, v.utm_medium, v.utm_campaign, v.utm_content, v.utm_term, v.fbclid, v.gclid) is null then excluded.fbclid else v.fbclid end,
    gclid = case when (v.utm_source, v.utm_medium, v.utm_campaign, v.utm_content, v.utm_term, v.fbclid, v.gclid) is null then excluded.gclid else v.gclid end,
    dispositivo = coalesce(v.dispositivo, excluded.dispositivo);
end;
$$;


-- --------------------------------------------------------------------------------------------
-- pesquisa_salvar: gravação progressiva de uma tentativa. Chamada a cada resposta.
--
-- `p` já vem inteiro calculado pelo servidor (contato validado, respostas sanitizadas, progresso,
-- posição). Aqui mora só o que PRECISA ser atômico: a ordem dos salvamentos (seq), o que nunca
-- regride (posição máxima, status concluída, data de conclusão) e o primeiro toque do rastreio.
--
-- Devolve {novo, aplicado, concluiu_agora, finalizou_agora, status} e, SÓ quando finalizou_agora,
-- `linha` = a linha inteira gravada. `finalizou` (o servidor manda true quando a pessoa chegou à
-- tela de fim com tudo respondido) grava finalizado_em uma vez só; finalizou_agora é true só nessa
-- transição, dentro da trava da linha — é o que garante UM aviso ao n8n por tentativa, mesmo com
-- dois salvamentos simultâneos. A `linha` leva o rastreio de PRIMEIRO toque e as datas do banco
-- para o aviso, em vez do que veio no último salvamento.
-- --------------------------------------------------------------------------------------------
create or replace function public.pesquisa_salvar(p jsonb)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_id uuid := (p ->> 'id')::uuid;
  v_seq integer := coalesce((p ->> 'seq')::integer, 0);
  v_completa boolean := coalesce((p ->> 'completa')::boolean, false);
  -- Só finaliza quem está completo: a tela de fim sem tudo respondido não existe.
  v_finalizou boolean := coalesce((p ->> 'finalizou')::boolean, false) and coalesce((p ->> 'completa')::boolean, false);
  v_posicao smallint := coalesce((p ->> 'posicao')::smallint, 0);
  v_etapa_posicao smallint := coalesce((p ->> 'etapa_posicao')::smallint, 0);
  v_status_antes text;
  v_status_depois text;
  v_finalizado_antes timestamptz;
  v_finalizado_depois timestamptz;
  v_aplicado boolean;
  v_finalizou_agora boolean;
begin
  if v_id is null then
    raise exception 'pesquisa_salvar: id obrigatório' using errcode = '22023';
  end if;

  -- 1. Primeira gravação da tentativa. "do nothing" em vez de "do update" porque o update precisa
  --    da regra do seq, que não cabe num on conflict. Se dois inserts chegarem juntos, o segundo
  --    espera o primeiro terminar, não insere nada e cai no passo 2 — nada se perde.
  insert into public.pesquisa_respostas (
    id, pesquisa, pesquisa_versao, visitante_id, seq,
    nome, whatsapp, whatsapp_digits, email, perfil, respostas,
    pergunta_atual, etapa_atual, posicao_max, pergunta_max, etapa_max,
    respondidas, obrigatorias, obrigatorias_respondidas, total_perguntas, progresso_percentual,
    tempos, ultima_resposta_em, status, concluido_em, tempo_total_segundos, finalizado_em,
    page_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, gclid, dispositivo
  ) values (
    v_id,
    coalesce(nullif(p ->> 'pesquisa', ''), 'icp-escola-ev'),
    p ->> 'pesquisa_versao',
    (p ->> 'visitante_id')::uuid,
    v_seq,
    p ->> 'nome',
    p ->> 'whatsapp',
    p ->> 'whatsapp_digits',
    p ->> 'email',
    nullif(p ->> 'perfil', ''),
    coalesce(p -> 'respostas', '{}'::jsonb),
    p ->> 'pergunta_atual',
    coalesce((p ->> 'etapa_atual')::smallint, 0),
    v_posicao,
    p ->> 'pergunta_posicao',
    v_etapa_posicao,
    coalesce((p ->> 'respondidas')::smallint, 0),
    coalesce((p ->> 'obrigatorias')::smallint, 0),
    coalesce((p ->> 'obrigatorias_respondidas')::smallint, 0),
    coalesce((p ->> 'total_perguntas')::smallint, 0),
    coalesce((p ->> 'progresso_percentual')::smallint, 0),
    coalesce(p -> 'tempos', '{}'::jsonb),
    now(),
    -- Pode nascer completa: rascunho que ficou no aparelho sem internet e chega todo de uma vez.
    case when v_completa then 'concluida' else 'em_andamento' end,
    case when v_completa then now() end,
    case when v_completa then 0 end,
    case when v_finalizou then now() end,
    nullif(btrim(p ->> 'page_url'), ''),
    nullif(btrim(p ->> 'referrer'), ''),
    nullif(btrim(p ->> 'utm_source'), ''),
    nullif(btrim(p ->> 'utm_medium'), ''),
    nullif(btrim(p ->> 'utm_campaign'), ''),
    nullif(btrim(p ->> 'utm_content'), ''),
    nullif(btrim(p ->> 'utm_term'), ''),
    nullif(btrim(p ->> 'fbclid'), ''),
    nullif(btrim(p ->> 'gclid'), ''),
    nullif(btrim(p ->> 'dispositivo'), '')
  )
  on conflict (id) do nothing
  returning status into v_status_depois;

  if found then
    return json_build_object(
      'novo', true,
      'aplicado', true,
      'concluiu_agora', v_status_depois = 'concluida',
      'finalizou_agora', v_finalizou,
      'status', v_status_depois,
      'linha', case when v_finalizou
        then (select row_to_json(x) from public.pesquisa_respostas as x where x.id = v_id) end
    );
  end if;

  -- 2. A tentativa já existe. O "for update" trava a linha: o status lido aqui é o mesmo que o
  --    update abaixo vai ver, e concluiu_agora não sai true duas vezes para salvamentos simultâneos.
  select status, finalizado_em into v_status_antes, v_finalizado_antes
  from public.pesquisa_respostas
  where id = v_id
  for update;

  -- Dentro do SET, toda coluna citada tem o valor ANTIGO da linha — é o que faz os greatest() e os
  -- coalesce() abaixo funcionarem.
  update public.pesquisa_respostas as r set
    seq = v_seq,
    pesquisa_versao = coalesce(p ->> 'pesquisa_versao', r.pesquisa_versao),
    visitante_id = coalesce(r.visitante_id, (p ->> 'visitante_id')::uuid),
    nome = p ->> 'nome',
    whatsapp = p ->> 'whatsapp',
    whatsapp_digits = p ->> 'whatsapp_digits',
    email = p ->> 'email',
    perfil = nullif(p ->> 'perfil', ''),
    -- Respostas são substituídas, não mescladas: o servidor já tirou as órfãs (troca de perfil) e
    -- mesclar ressuscitaria resposta que não vale mais.
    respostas = coalesce(p -> 'respostas', '{}'::jsonb),
    pergunta_atual = p ->> 'pergunta_atual',
    etapa_atual = coalesce((p ->> 'etapa_atual')::smallint, 0),
    posicao_max = greatest(r.posicao_max, v_posicao),
    pergunta_max = case when v_posicao > r.posicao_max then p ->> 'pergunta_posicao' else r.pergunta_max end,
    etapa_max = greatest(r.etapa_max, v_etapa_posicao),
    respondidas = coalesce((p ->> 'respondidas')::smallint, 0),
    obrigatorias = coalesce((p ->> 'obrigatorias')::smallint, 0),
    obrigatorias_respondidas = coalesce((p ->> 'obrigatorias_respondidas')::smallint, 0),
    total_perguntas = coalesce((p ->> 'total_perguntas')::smallint, 0),
    progresso_percentual = coalesce((p ->> 'progresso_percentual')::smallint, 0),
    -- Tempos são mesclados: o navegador manda o acumulado, e uma chave que por algum motivo não
    -- veio não apaga o tempo já medido.
    tempos = r.tempos || coalesce(p -> 'tempos', '{}'::jsonb),
    atualizado_em = now(),
    ultima_resposta_em = now(),
    status = case when r.status = 'concluida' or v_completa then 'concluida' else 'em_andamento' end,
    concluido_em = coalesce(r.concluido_em, case when v_completa then now() end),
    finalizado_em = coalesce(r.finalizado_em, case when v_finalizou then now() end),
    tempo_total_segundos = case
      when r.concluido_em is null and v_completa
        then greatest(0, extract(epoch from now() - r.criado_em))::int
      else r.tempo_total_segundos
    end,
    page_url = coalesce(r.page_url, nullif(btrim(p ->> 'page_url'), '')),
    referrer = coalesce(r.referrer, nullif(btrim(p ->> 'referrer'), '')),
    -- Campanha como UM bloco de primeiro toque (ver pesquisa_registrar_evento).
    utm_source = case when (r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.fbclid, r.gclid) is null then nullif(btrim(p ->> 'utm_source'), '') else r.utm_source end,
    utm_medium = case when (r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.fbclid, r.gclid) is null then nullif(btrim(p ->> 'utm_medium'), '') else r.utm_medium end,
    utm_campaign = case when (r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.fbclid, r.gclid) is null then nullif(btrim(p ->> 'utm_campaign'), '') else r.utm_campaign end,
    utm_content = case when (r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.fbclid, r.gclid) is null then nullif(btrim(p ->> 'utm_content'), '') else r.utm_content end,
    utm_term = case when (r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.fbclid, r.gclid) is null then nullif(btrim(p ->> 'utm_term'), '') else r.utm_term end,
    fbclid = case when (r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.fbclid, r.gclid) is null then nullif(btrim(p ->> 'fbclid'), '') else r.fbclid end,
    gclid = case when (r.utm_source, r.utm_medium, r.utm_campaign, r.utm_content, r.utm_term, r.fbclid, r.gclid) is null then nullif(btrim(p ->> 'gclid'), '') else r.gclid end,
    dispositivo = coalesce(r.dispositivo, nullif(btrim(p ->> 'dispositivo'), ''))
  where r.id = v_id
    and r.seq < v_seq
  returning r.status, r.finalizado_em into v_status_depois, v_finalizado_depois;

  v_aplicado := found;
  if not v_aplicado then
    -- seq velho ou repetido (reenvio da fila): nada muda, e a resposta diz o status real.
    v_status_depois := v_status_antes;
    v_finalizado_depois := v_finalizado_antes;
  end if;
  v_finalizou_agora := v_finalizado_antes is null and v_finalizado_depois is not null;

  return json_build_object(
    'novo', false,
    'aplicado', v_aplicado,
    'concluiu_agora', v_status_antes <> 'concluida' and v_status_depois = 'concluida',
    'finalizou_agora', v_finalizou_agora,
    'status', v_status_depois,
    'linha', case when v_finalizou_agora
      then (select row_to_json(x) from public.pesquisa_respostas as x where x.id = v_id) end
  );
end;
$$;


-- --------------------------------------------------------------------------------------------
-- pesquisa_painel: TODOS os números do painel numa ida ao banco, contados sobre o período inteiro
-- (e nunca sobre as linhas que couberam na tela).
--
--   pessoas     = pesquisa_pessoas com criado_em em [p_desde, p_ate) e do perfil pedido
--   visitantes  = pesquisa_visitas com criado_em em [p_desde, p_ate) — SEM filtro de perfil, porque
--                 o perfil só existe depois da pergunta 1: não dá para saber o perfil de quem só abriu.
--   pesquisa    = só 'icp-escola-ev': a coluna `pesquisa` separa os formulários, e as páginas que
--                 vierem depois (o /painel já tem a faixa de páginas) gravam com o id delas. As
--                 funções desta pesquisa conhecem as perguntas desta pesquisa; página nova ganha as
--                 suas. O mesmo filtro está em pesquisa_cruzamento e pesquisa_abertas.
--   p_ignorar   = chaves de texto livre (o servidor passa EVPesquisa.chavesTexto()): contar
--                 "quantas pessoas escreveram exatamente esta frase" não diz nada e só pesa.
--
-- Os CTEs usados mais de uma vez são materializados uma vez só pelo Postgres, e o jsonb_each das
-- respostas (a parte cara) acontece uma vez e alimenta distribuições, "responderam" e escalas.
-- Ordenações de texto usam collate "C" para o resultado não depender do idioma do servidor.
-- --------------------------------------------------------------------------------------------
create or replace function public.pesquisa_painel(
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_perfil text default null,
  p_ignorar text[] default '{}'
)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with
  pessoas as materialized (
    select *
    from public.pesquisa_pessoas
    where pesquisa = 'icp-escola-ev'
      and (p_desde is null or criado_em >= p_desde)
      and (p_ate is null or criado_em < p_ate)
      and (p_perfil is null or perfil = p_perfil)
  ),
  visitantes as materialized (
    select *
    from public.pesquisa_visitas
    where pesquisa = 'icp-escola-ev'
      and (p_desde is null or criado_em >= p_desde)
      and (p_ate is null or criado_em < p_ate)
  ),
  -- Uma linha por (pessoa, chave respondida), já sem as chaves de texto livre.
  itens as materialized (
    select p.id, p.perfil, e.key as chave, e.value as v
    from pessoas as p
    cross join lateral jsonb_each(p.respostas) as e
    where not (e.key = any (coalesce(p_ignorar, '{}'::text[])))
  ),
  -- Uma linha por (pessoa, chave, valor): a múltipla escolha vira uma linha por alternativa.
  -- = pesquisa_valores(i.v), escrito por extenso para o Postgres embutir no plano (ver lá).
  -- Resposta simples vai direto (é a maioria, e fica sem subconsulta); só o array é aberto.
  valores as (
    select perfil, chave, v #>> '{}' as valor
    from itens
    where jsonb_typeof(v) in ('string', 'number', 'boolean')
    union all
    select i.perfil, i.chave, x.valor
    from itens as i
    cross join lateral (
      select distinct e #>> '{}' as valor
      from jsonb_array_elements(i.v) as e
      where jsonb_typeof(e) in ('string', 'number', 'boolean')
    ) as x
    where jsonb_typeof(i.v) = 'array'
  ),
  -- Cada campo de origem vira uma linha: (campo, valor) para visitantes e para pessoas.
  origem_visitantes as (
    select o.campo, o.ordem,
           case when o.campo = 'dispositivo'
             then coalesce(nullif(btrim(o.valor), ''), '(desconhecido)')
             else coalesce(nullif(btrim(o.valor), ''), '(sem utm)') end as valor
    from visitantes as v
    cross join lateral (values
      ('utm_source', 1, v.utm_source),
      ('utm_medium', 2, v.utm_medium),
      ('utm_campaign', 3, v.utm_campaign),
      ('utm_content', 4, v.utm_content),
      ('dispositivo', 5, v.dispositivo)
    ) as o(campo, ordem, valor)
  ),
  origem_pessoas as (
    select o.campo, o.ordem, p.status,
           case when o.campo = 'dispositivo'
             then coalesce(nullif(btrim(o.valor), ''), '(desconhecido)')
             else coalesce(nullif(btrim(o.valor), ''), '(sem utm)') end as valor
    from pessoas as p
    cross join lateral (values
      ('utm_source', 1, p.utm_source),
      ('utm_medium', 2, p.utm_medium),
      ('utm_campaign', 3, p.utm_campaign),
      ('utm_content', 4, p.utm_content),
      ('dispositivo', 5, p.dispositivo)
    ) as o(campo, ordem, valor)
  ),
  trafego as (
    select campo, ordem, valor,
           sum(visitantes)::int as visitantes,
           sum(pessoas)::int as pessoas,
           sum(concluidas)::int as concluidas
    from (
      select campo, ordem, valor, 1 as visitantes, 0 as pessoas, 0 as concluidas from origem_visitantes
      union all
      select campo, ordem, valor, 0, 1, (status = 'concluida')::int from origem_pessoas
    ) as t
    group by campo, ordem, valor
  ),
  trafego_top as (
    select *,
           row_number() over (
             partition by campo
             order by pessoas desc, visitantes desc, valor collate "C"
           ) as posicao
    from trafego
  ),
  -- Dia no fuso de São Paulo: em UTC o dia vira às 21h e a campanha da noite cairia no dia seguinte.
  dias as (
    select dia, sum(visitantes)::int as visitantes, sum(pessoas)::int as pessoas, sum(concluidas)::int as concluidas
    from (
      select (criado_em at time zone 'America/Sao_Paulo')::date as dia, 1 as visitantes, 0 as pessoas, 0 as concluidas
      from visitantes
      union all
      select (criado_em at time zone 'America/Sao_Paulo')::date, 0, 1, 0
      from pessoas
      union all
      select (concluido_em at time zone 'America/Sao_Paulo')::date, 0, 0, 1
      from pessoas
      where status = 'concluida' and concluido_em is not null
    ) as d
    group by dia
  )
  select json_build_object(
    'desde', p_desde,
    'ate', p_ate,
    'perfil', p_perfil,

    'visitantes', (select count(*)::int from visitantes),
    'visitas', (select coalesce(sum(visitas), 0)::int from visitantes),
    'comecaram', (select count(*)::int from visitantes where comecou_em is not null),

    'pessoas', (select count(*)::int from pessoas),
    -- Sem deduplicar: é a conta de quantas vezes a pesquisa foi aberta com contato preenchido.
    'tentativas', (
      select count(*)::int
      from public.pesquisa_respostas
      where pesquisa = 'icp-escola-ev'
        and (p_desde is null or criado_em >= p_desde)
        and (p_ate is null or criado_em < p_ate)
        and (p_perfil is null or perfil = p_perfil)
    ),
    'concluidas', (select count(*)::int from pessoas where status = 'concluida'),
    'com_perfil', (select count(*)::int from pessoas where perfil is not null),

    'tempo_mediano_segundos', (
      select round(percentile_cont(0.5) within group (order by tempo_total_segundos))::int
      from pessoas
      where status = 'concluida' and tempo_total_segundos is not null
    ),

    -- Quem terminou conta em todas as etapas, mesmo a 9, que nem todo perfil tem.
    'por_etapa', (
      select json_agg(json_build_object('etapa', n, 'chegaram', (
        select count(*)::int from pessoas where etapa_max >= n or status = 'concluida'
      )) order by n)
      from generate_series(1, 9) as n
    ),

    -- Em ordem de questionário (min(posicao_max)), que é a ordem em que o painel desenha.
    'pararam_em', (
      select coalesce(json_agg(json_build_object('pergunta', pergunta_max, 'total', total) order by posicao, pergunta_max collate "C"), '[]'::json)
      from (
        select pergunta_max, min(posicao_max) as posicao, count(*)::int as total
        from pessoas
        where status = 'em_andamento' and pergunta_max is not null
        group by pergunta_max
      ) as x
    ),

    'perfis', (
      select coalesce(json_agg(json_build_object('perfil', perfil, 'total', total, 'concluidas', concluidas)
                               order by total desc, perfil collate "C" nulls last), '[]'::json)
      from (
        select perfil, count(*)::int as total, count(*) filter (where status = 'concluida')::int as concluidas
        from pessoas
        group by perfil
      ) as x
    ),

    -- `valores` já traz cada valor uma vez por pessoa, então count(*) = pessoas distintas.
    'distribuicoes', (
      select coalesce(json_agg(json_build_object('perfil', perfil, 'chave', chave, 'valor', valor, 'total', total)
                               order by perfil collate "C" nulls last, chave collate "C", total desc, valor collate "C"), '[]'::json)
      from (
        select perfil, chave, valor, count(*)::int as total
        from valores
        group by perfil, chave, valor
      ) as d
    ),

    'responderam', (
      select coalesce(json_agg(json_build_object('perfil', perfil, 'chave', chave, 'total', total)
                               order by perfil collate "C" nulls last, chave collate "C"), '[]'::json)
      from (
        select perfil, chave, count(*)::int as total
        from itens
        group by perfil, chave
      ) as r
    ),

    'escalas', (
      select coalesce(json_agg(json_build_object('perfil', perfil, 'chave', chave, 'media', media, 'total', total)
                               order by perfil collate "C" nulls last, chave collate "C"), '[]'::json)
      from (
        select perfil, chave, round(avg((v #>> '{}')::numeric), 1) as media, count(*)::int as total
        from itens
        where jsonb_typeof(v) = 'number'
        group by perfil, chave
      ) as e
    ),

    'por_dia', (
      select coalesce(json_agg(json_build_object('dia', dia, 'visitantes', visitantes, 'pessoas', pessoas, 'concluidas', concluidas)
                               order by dia), '[]'::json)
      from dias
    ),

    'trafego', (
      select coalesce(json_agg(json_build_object('campo', campo, 'valor', valor, 'visitantes', visitantes,
                                                 'pessoas', pessoas, 'concluidas', concluidas)
                               order by ordem, posicao), '[]'::json)
      from trafego_top
      where posicao <= 30
    )
  );
$$;


-- --------------------------------------------------------------------------------------------
-- pesquisa_cruzamento: tabela cruzada entre duas perguntas ("perfil x renda atual").
-- Entram só as pessoas do recorte que responderam as DUAS perguntas (a "base"). Em múltipla
-- escolha a pessoa aparece em cada alternativa que marcou; `linhas` e `colunas` contam pessoas
-- distintas, para o "% da linha" e o "% da coluna" terem o denominador certo.
-- --------------------------------------------------------------------------------------------
create or replace function public.pesquisa_cruzamento(
  p_linha text,
  p_coluna text,
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_perfil text default null
)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with
  pessoas as (
    select id, respostas
    from public.pesquisa_pessoas
    where pesquisa = 'icp-escola-ev'
      and (p_desde is null or criado_em >= p_desde)
      and (p_ate is null or criado_em < p_ate)
      and (p_perfil is null or perfil = p_perfil)
      and respostas ? p_linha
      and respostas ? p_coluna
  ),
  -- = pesquisa_valores() das duas respostas, escrito por extenso para o Postgres embutir no plano
  -- (ver o comentário da pesquisa_valores).
  pares as materialized (
    select p.id, l.valor as linha, c.valor as coluna
    from pessoas as p
    cross join lateral (
      select distinct e #>> '{}' as valor
      from jsonb_array_elements(case when jsonb_typeof(p.respostas -> p_linha) = 'array'
                                     then p.respostas -> p_linha
                                     else jsonb_build_array(p.respostas -> p_linha) end) as e
      where jsonb_typeof(e) in ('string', 'number', 'boolean')
    ) as l
    cross join lateral (
      select distinct e #>> '{}' as valor
      from jsonb_array_elements(case when jsonb_typeof(p.respostas -> p_coluna) = 'array'
                                     then p.respostas -> p_coluna
                                     else jsonb_build_array(p.respostas -> p_coluna) end) as e
      where jsonb_typeof(e) in ('string', 'number', 'boolean')
    ) as c
  )
  select json_build_object(
    'linha', p_linha,
    'coluna', p_coluna,
    'base', (select count(distinct id)::int from pares),
    -- Cada (pessoa, linha, coluna) aparece uma vez só, então count(*) já é "pessoas".
    'celulas', (
      select coalesce(json_agg(json_build_object('linha', linha, 'coluna', coluna, 'total', total)
                               order by linha collate "C", coluna collate "C"), '[]'::json)
      from (select linha, coluna, count(*)::int as total from pares group by linha, coluna) as x
    ),
    'linhas', (
      select coalesce(json_agg(json_build_object('valor', linha, 'total', total)
                               order by total desc, linha collate "C"), '[]'::json)
      from (select linha, count(distinct id)::int as total from pares group by linha) as x
    ),
    'colunas', (
      select coalesce(json_agg(json_build_object('valor', coluna, 'total', total)
                               order by total desc, coluna collate "C"), '[]'::json)
      from (select coluna, count(distinct id)::int as total from pares group by coluna) as x
    )
  );
$$;


-- --------------------------------------------------------------------------------------------
-- pesquisa_abertas: as respostas escritas (perguntas abertas e frase; hoje nenhuma pergunta tem "Outro"), paginadas,
-- mais recentes primeiro. `textos` traz só as chaves pedidas que a pessoa de fato escreveu.
-- --------------------------------------------------------------------------------------------
create or replace function public.pesquisa_abertas(
  p_chaves text[],
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_perfil text default null,
  p_limite int default 200,
  p_offset int default 0
)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with
  base as materialized (
    select p.id, p.nome, p.perfil, p.whatsapp, p.email, p.criado_em, p.status, t.textos
    from public.pesquisa_pessoas as p
    cross join lateral (
      select jsonb_object_agg(k.chave, p.respostas -> k.chave) as textos
      from unnest(coalesce(p_chaves, '{}'::text[])) as k(chave)
      where jsonb_typeof(p.respostas -> k.chave) = 'string'
        and btrim(p.respostas ->> k.chave) <> ''
    ) as t
    where p.pesquisa = 'icp-escola-ev'
      and (p_desde is null or p.criado_em >= p_desde)
      and (p_ate is null or p.criado_em < p_ate)
      and (p_perfil is null or p.perfil = p_perfil)
      -- ?| usa só o jsonb da linha e descarta rápido quem não escreveu nada.
      and p.respostas ?| coalesce(p_chaves, '{}'::text[])
      and t.textos is not null
  ),
  pagina as (
    select *
    from base
    order by criado_em desc, id desc
    limit greatest(1, least(500, coalesce(p_limite, 200)))
    offset greatest(0, coalesce(p_offset, 0))
  )
  select json_build_object(
    'total', (select count(*)::int from base),
    'itens', (
      select coalesce(json_agg(json_build_object(
        'id', id, 'nome', nome, 'perfil', perfil, 'whatsapp', whatsapp, 'email', email,
        'criado_em', criado_em, 'status', status, 'textos', textos
      ) order by criado_em desc, id desc), '[]'::json)
      from pagina
    )
  );
$$;


-- --------------------------------------------------------------------------------------------
-- Permissões das funções. Função criada em public nasce com EXECUTE para PUBLIC (e, no Supabase,
-- para anon e authenticated): sem o revoke, qualquer pessoa com a chave pública do projeto leria
-- o painel inteiro pelo /rest/v1/rpc. Só o servidor (service_role) executa.
-- --------------------------------------------------------------------------------------------
revoke all on function public.pesquisa_valores(jsonb) from public, anon, authenticated;
revoke all on function public.pesquisa_registrar_evento(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.pesquisa_salvar(jsonb) from public, anon, authenticated;
revoke all on function public.pesquisa_painel(timestamptz, timestamptz, text, text[]) from public, anon, authenticated;
revoke all on function public.pesquisa_cruzamento(text, text, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.pesquisa_abertas(text[], timestamptz, timestamptz, text, int, int) from public, anon, authenticated;

grant execute on function public.pesquisa_valores(jsonb) to service_role;
grant execute on function public.pesquisa_registrar_evento(uuid, text, jsonb) to service_role;
grant execute on function public.pesquisa_salvar(jsonb) to service_role;
grant execute on function public.pesquisa_painel(timestamptz, timestamptz, text, text[]) to service_role;
grant execute on function public.pesquisa_cruzamento(text, text, timestamptz, timestamptz, text) to service_role;
grant execute on function public.pesquisa_abertas(text[], timestamptz, timestamptz, text, int, int) to service_role;

-- Sem isto, as rotas novas do /rest/v1 respondem 404 até o PostgREST reler o esquema sozinho — e o
-- formulário passaria os primeiros minutos sem gravar nada.
notify pgrst, 'reload schema';
