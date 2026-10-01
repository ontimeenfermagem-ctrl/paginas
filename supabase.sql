-- Banco da pesquisa de ICP da Escola Enfermagem de Valor (formulário /pesquisa-icp, as 3 páginas de
-- obrigado /obrigado-* e o painel /painel).
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
-- novo. A visita (endereço, referência e campanha, em bloco) é a do ÚLTIMO evento: quem volta por
-- outro link passa a ter a campanha desse link, e quem volta sem UTM fica sem UTM.
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
    -- A visita é a do ÚLTIMO evento, em bloco: campanha de uma visita nunca se mistura com a de
    -- outra. Evento sem endereço (não veio de uma página aberta) não mexe na visita guardada.
    page_url = coalesce(excluded.page_url, v.page_url),
    referrer = case when excluded.page_url is not null then excluded.referrer else v.referrer end,
    utm_source = case when excluded.page_url is not null then excluded.utm_source else v.utm_source end,
    utm_medium = case when excluded.page_url is not null then excluded.utm_medium else v.utm_medium end,
    utm_campaign = case when excluded.page_url is not null then excluded.utm_campaign else v.utm_campaign end,
    utm_content = case when excluded.page_url is not null then excluded.utm_content else v.utm_content end,
    utm_term = case when excluded.page_url is not null then excluded.utm_term else v.utm_term end,
    fbclid = case when excluded.page_url is not null then excluded.fbclid else v.fbclid end,
    gclid = case when excluded.page_url is not null then excluded.gclid else v.gclid end,
    dispositivo = coalesce(excluded.dispositivo, v.dispositivo);
end;
$$;


-- --------------------------------------------------------------------------------------------
-- pesquisa_salvar: gravação progressiva de uma tentativa. Chamada a cada resposta.
--
-- `p` já vem inteiro calculado pelo servidor (contato validado, respostas sanitizadas, progresso,
-- posição). Aqui mora só o que PRECISA ser atômico: a ordem dos salvamentos (seq), o que nunca
-- regride (posição máxima, status concluída, data de conclusão) e a visita do rastreio.
--
-- Devolve {novo, aplicado, concluiu_agora, finalizou_agora, status} e, SÓ quando finalizou_agora,
-- `linha` = a linha inteira gravada. `finalizou` (o servidor manda true quando a pessoa chegou à
-- tela de fim com tudo respondido) grava finalizado_em uma vez só; finalizou_agora é true só nessa
-- transição, dentro da trava da linha — é o que garante UM aviso ao n8n por tentativa, mesmo com
-- dois salvamentos simultâneos. A `linha` leva o rastreio gravado (o da última visita) e as datas
-- do banco para o aviso.
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
  -- Este salvamento traz uma VISITA? (o navegador sempre manda o endereço; uma integração que
  -- decide a origem, como a DM do Instagram, manda a campanha). Então a visita guardada passa a
  -- ser a dele, em bloco. Salvamento sem nada disso não mexe na origem.
  v_visita boolean := nullif(btrim(p ->> 'page_url'), '') is not null
    or coalesce(
      nullif(btrim(p ->> 'utm_source'), ''), nullif(btrim(p ->> 'utm_medium'), ''),
      nullif(btrim(p ->> 'utm_campaign'), ''), nullif(btrim(p ->> 'utm_content'), ''),
      nullif(btrim(p ->> 'utm_term'), ''), nullif(btrim(p ->> 'fbclid'), ''), nullif(btrim(p ->> 'gclid'), '')
    ) is not null;
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
    -- A visita é a do ÚLTIMO salvamento que trouxe uma (ver v_visita), em bloco.
    page_url = case when v_visita then coalesce(nullif(btrim(p ->> 'page_url'), ''), r.page_url) else r.page_url end,
    referrer = case when v_visita then nullif(btrim(p ->> 'referrer'), '') else r.referrer end,
    utm_source = case when v_visita then nullif(btrim(p ->> 'utm_source'), '') else r.utm_source end,
    utm_medium = case when v_visita then nullif(btrim(p ->> 'utm_medium'), '') else r.utm_medium end,
    utm_campaign = case when v_visita then nullif(btrim(p ->> 'utm_campaign'), '') else r.utm_campaign end,
    utm_content = case when v_visita then nullif(btrim(p ->> 'utm_content'), '') else r.utm_content end,
    utm_term = case when v_visita then nullif(btrim(p ->> 'utm_term'), '') else r.utm_term end,
    fbclid = case when v_visita then nullif(btrim(p ->> 'fbclid'), '') else r.fbclid end,
    gclid = case when v_visita then nullif(btrim(p ->> 'gclid'), '') else r.gclid end,
    dispositivo = coalesce(nullif(btrim(p ->> 'dispositivo'), ''), r.dispositivo)
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
-- Filtros de PESSOA (perfil, status e busca) valem para tudo que tem pessoa: pessoas, tentativas,
-- funil a partir de "se identificaram", distribuições, dias e tráfego (colunas de pessoas).
-- Visitantes (acessaram/visitas/começaram e a coluna de visitantes) não têm nome, e-mail nem
-- perfil: só o período vale para eles.
--   p_status        = null | 'em_andamento' | 'concluida'
--   p_busca         = trecho do nome ou do e-mail (sem diferenciar maiúsculas); strpos, e não LIKE,
--                     para nenhum caractere digitado virar curinga
--   p_busca_digitos = os dígitos da busca quando ela parece telefone (o servidor decide)
--
-- A assinatura mudou (parâmetros novos no fim): o drop da antiga evita duas versões sobrecarregadas,
-- que deixariam o /rest/v1/rpc ambíguo. "if exists" mantém o arquivo idempotente.
drop function if exists public.pesquisa_painel(timestamptz, timestamptz, text, text[]);
create or replace function public.pesquisa_painel(
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_perfil text default null,
  p_ignorar text[] default '{}',
  p_status text default null,
  p_busca text default null,
  p_busca_digitos text default null
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
      and (p_status is null or status = p_status)
      and (coalesce(p_busca, '') = ''
           or strpos(lower(coalesce(nome, '')), lower(p_busca)) > 0
           or strpos(lower(coalesce(email, '')), lower(p_busca)) > 0
           or (coalesce(p_busca_digitos, '') <> '' and strpos(coalesce(whatsapp_digits, ''), p_busca_digitos) > 0))
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
        -- Mesmo recorte de pessoa, aplicado a cada tentativa (status/contato da própria linha).
        and (p_status is null or status = p_status)
        and (coalesce(p_busca, '') = ''
             or strpos(lower(coalesce(nome, '')), lower(p_busca)) > 0
             or strpos(lower(coalesce(email, '')), lower(p_busca)) > 0
             or (coalesce(p_busca_digitos, '') <> '' and strpos(coalesce(whatsapp_digits, ''), p_busca_digitos) > 0))
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
-- p_status / p_busca / p_busca_digitos: mesmo recorte de pessoa da pesquisa_painel. Assinatura nova:
-- a antiga sai antes (idempotente).
drop function if exists public.pesquisa_cruzamento(text, text, timestamptz, timestamptz, text);
create or replace function public.pesquisa_cruzamento(
  p_linha text,
  p_coluna text,
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_perfil text default null,
  p_status text default null,
  p_busca text default null,
  p_busca_digitos text default null
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
      and (p_status is null or status = p_status)
      and (coalesce(p_busca, '') = ''
           or strpos(lower(coalesce(nome, '')), lower(p_busca)) > 0
           or strpos(lower(coalesce(email, '')), lower(p_busca)) > 0
           or (coalesce(p_busca_digitos, '') <> '' and strpos(coalesce(whatsapp_digits, ''), p_busca_digitos) > 0))
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
-- p_status / p_busca / p_busca_digitos: mesmo recorte de pessoa da pesquisa_painel (no fim da lista,
-- depois de p_limite/p_offset). Assinatura nova: a antiga sai antes (idempotente).
drop function if exists public.pesquisa_abertas(text[], timestamptz, timestamptz, text, int, int);
create or replace function public.pesquisa_abertas(
  p_chaves text[],
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_perfil text default null,
  p_limite int default 200,
  p_offset int default 0,
  p_status text default null,
  p_busca text default null,
  p_busca_digitos text default null
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
      and (p_status is null or p.status = p_status)
      and (coalesce(p_busca, '') = ''
           or strpos(lower(coalesce(p.nome, '')), lower(p_busca)) > 0
           or strpos(lower(coalesce(p.email, '')), lower(p_busca)) > 0
           or (coalesce(p_busca_digitos, '') <> '' and strpos(coalesce(p.whatsapp_digits, ''), p_busca_digitos) > 0))
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
revoke all on function public.pesquisa_painel(timestamptz, timestamptz, text, text[], text, text, text) from public, anon, authenticated;
revoke all on function public.pesquisa_cruzamento(text, text, timestamptz, timestamptz, text, text, text, text) from public, anon, authenticated;
revoke all on function public.pesquisa_abertas(text[], timestamptz, timestamptz, text, int, int, text, text, text) from public, anon, authenticated;

grant execute on function public.pesquisa_valores(jsonb) to service_role;
grant execute on function public.pesquisa_registrar_evento(uuid, text, jsonb) to service_role;
grant execute on function public.pesquisa_salvar(jsonb) to service_role;
grant execute on function public.pesquisa_painel(timestamptz, timestamptz, text, text[], text, text, text) to service_role;
grant execute on function public.pesquisa_cruzamento(text, text, timestamptz, timestamptz, text, text, text, text) to service_role;
grant execute on function public.pesquisa_abertas(text[], timestamptz, timestamptz, text, int, int, text, text, text) to service_role;


-- ============================================================================================
-- 5. Páginas de obrigado (/obrigado-afericao, /obrigado-cuidador, /obrigado-evento-outubro)
--
-- Quem termina a pesquisa é levado para UMA das três páginas, pelo perfil (js/obrigado-config.js).
-- pagina_eventos guarda uma linha por EVENTO: 'visita' (a página abriu) e 'clique_grupo' (clicou em
-- "Entrar no grupo"). Sem dado pessoal: ids do aparelho e da tentativa, o perfil (Técnico e
-- Enfermeiro dividem a página do evento, mas são contados separados) e a origem do tráfego.
-- Mesmas barreiras das tabelas da pesquisa: RLS sem política + revoke de anon/authenticated.
--
-- Este bloco é autossuficiente: pode ser colado sozinho num banco que já tem as seções 1 a 4.
-- ============================================================================================
create table if not exists public.pagina_eventos (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  -- id da página em js/obrigado-config.js ('afericao' | 'cuidador' | 'evento_outubro'). O servidor
  -- só aceita as páginas que existem; aqui fica só o formato, para página nova não pedir SQL novo.
  pagina text not null check (pagina ~ '^[a-z0-9_]{1,60}$'),
  evento text not null check (evento in ('visita', 'clique_grupo')),
  visitante_id uuid,                                 -- o mesmo id de aparelho da pesquisa_visitas
  sessao_id uuid,                                    -- a tentativa (pesquisa_respostas.id), se veio
  perfil text,                                       -- rótulo da pergunta 1, como gravado na pesquisa
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

-- O painel sempre lê uma página num período.
create index if not exists pagina_eventos_pagina_criado_em_idx
  on public.pagina_eventos (pagina, criado_em desc);

alter table public.pagina_eventos enable row level security;
revoke all on table public.pagina_eventos from public, anon, authenticated;
grant select, insert, update, delete on table public.pagina_eventos to service_role;
-- A sequência do id também nasce com grant para anon no Supabase: fora.
revoke all on sequence public.pagina_eventos_id_seq from public, anon, authenticated;
grant usage, select on sequence public.pagina_eventos_id_seq to service_role;


-- --------------------------------------------------------------------------------------------
-- pagina_registrar_evento: grava um evento de página de obrigado. `p` já vem validado pelo
-- servidor ({pagina, evento, visitante_id, sessao_id, perfil, page_url, referrer, utm_*, fbclid,
-- gclid, dispositivo}); aqui a regra é só não gravar lixo: texto vazio vira null e um id que não é
-- uuid vira null em vez de derrubar a gravação.
-- --------------------------------------------------------------------------------------------
create or replace function public.pagina_registrar_evento(p jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  d jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_pagina text := nullif(btrim(d ->> 'pagina'), '');
  v_evento text := nullif(btrim(d ->> 'evento'), '');
  v_visitante text := nullif(btrim(d ->> 'visitante_id'), '');
  v_sessao text := nullif(btrim(d ->> 'sessao_id'), '');
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
begin
  if v_pagina is null then
    raise exception 'pagina_registrar_evento: página obrigatória' using errcode = '22023';
  end if;
  if v_evento is null or v_evento not in ('visita', 'clique_grupo') then
    raise exception 'pagina_registrar_evento: evento inválido (%)', v_evento using errcode = '22023';
  end if;

  insert into public.pagina_eventos (
    pagina, evento, visitante_id, sessao_id, perfil,
    page_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    fbclid, gclid, dispositivo
  ) values (
    v_pagina,
    v_evento,
    case when v_visitante ~ uuid_re then v_visitante::uuid end,
    case when v_sessao ~ uuid_re then v_sessao::uuid end,
    nullif(btrim(d ->> 'perfil'), ''),
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
  );
end;
$$;


-- --------------------------------------------------------------------------------------------
-- paginas_resumo: os números das páginas de obrigado para o painel, contados sobre o período
-- inteiro. Eventos entram por criado_em em [p_desde, p_ate).
--
--   p_mapa      = {rótulo do perfil: id da página}, montado pelo servidor a partir de
--                 js/obrigado-config.js. As páginas da resposta são os valores do mapa — sempre
--                 todas, mesmo sem nenhum evento (zeros e listas vazias).
--   visitas     = eventos 'visita' (recarregar conta de novo)
--   visitantes  = quem abriu, sem repetir: o id do aparelho; evento sem id conta como uma pessoa
--                 ('evento-' || id), para ninguém sumir da conta
--   cliques     = eventos 'clique_grupo'; clicaram = quem clicou, sem repetir (mesma chave)
--   atribuidas  = pessoas (pesquisa_pessoas, uma por WhatsApp) desta pesquisa que CHEGARAM à tela
--                 de fim no período (finalizado_em) e cujo perfil leva a esta página — é quem foi
--                 redirecionado para ela
--   por_perfil  = visitantes, clicaram e atribuidas por perfil (null = abriu sem perfil, ex.: link
--                 direto); por_origem = por utm_source ('(sem utm)' quando vazio, as 30 maiores);
--                 por_dia = por dia no fuso de São Paulo
-- --------------------------------------------------------------------------------------------
create or replace function public.paginas_resumo(
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_mapa jsonb default '{}'::jsonb
)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with
  mapa as (
    select m.key as perfil, btrim(m.value #>> '{}') as pagina
    from jsonb_each(case when jsonb_typeof(p_mapa) = 'object' then p_mapa else '{}'::jsonb end) as m
    where jsonb_typeof(m.value) = 'string'
      and btrim(m.value #>> '{}') <> ''
  ),
  paginas as (
    select distinct pagina from mapa
  ),
  eventos as materialized (
    select e.pagina,
           e.evento,
           e.perfil,
           coalesce(e.visitante_id::text, 'evento-' || e.id) as quem,
           coalesce(nullif(btrim(e.utm_source), ''), '(sem utm)') as origem,
           (e.criado_em at time zone 'America/Sao_Paulo')::date as dia
    from public.pagina_eventos as e
    where e.pagina in (select pagina from paginas)
      and (p_desde is null or e.criado_em >= p_desde)
      and (p_ate is null or e.criado_em < p_ate)
  ),
  atribuidas as materialized (
    select m.pagina, p.perfil
    from public.pesquisa_pessoas as p
    join mapa as m on m.perfil = p.perfil
    where p.pesquisa = 'icp-escola-ev'
      and p.finalizado_em is not null
      and (p_desde is null or p.finalizado_em >= p_desde)
      and (p_ate is null or p.finalizado_em < p_ate)
  )
  select json_build_object('paginas', coalesce((
    select json_agg(json_build_object(
      'pagina', pg.pagina,
      'visitas', t.visitas,
      'visitantes', t.visitantes,
      'cliques', t.cliques,
      'clicaram', t.clicaram,
      'atribuidas', (select count(*)::int from atribuidas as a where a.pagina = pg.pagina),
      'por_perfil', (
        select coalesce(json_agg(json_build_object('perfil', x.perfil, 'visitantes', x.visitantes,
                                                   'clicaram', x.clicaram, 'atribuidas', x.atribuidas)
                                 order by x.visitantes desc, x.atribuidas desc, x.perfil collate "C" nulls last), '[]'::json)
        from (
          select u.perfil,
                 count(distinct u.quem) filter (where u.evento = 'visita')::int as visitantes,
                 count(distinct u.quem) filter (where u.evento = 'clique_grupo')::int as clicaram,
                 count(*) filter (where u.evento is null)::int as atribuidas
          from (
            select e.perfil, e.evento, e.quem from eventos as e where e.pagina = pg.pagina
            union all
            select a.perfil, null, null from atribuidas as a where a.pagina = pg.pagina
          ) as u
          group by u.perfil
        ) as x
      ),
      'por_origem', (
        select coalesce(json_agg(json_build_object('utm_source', x.origem, 'visitantes', x.visitantes, 'clicaram', x.clicaram)
                                 order by x.visitantes desc, x.clicaram desc, x.origem collate "C"), '[]'::json)
        from (
          select e.origem,
                 count(distinct e.quem) filter (where e.evento = 'visita')::int as visitantes,
                 count(distinct e.quem) filter (where e.evento = 'clique_grupo')::int as clicaram
          from eventos as e
          where e.pagina = pg.pagina
          group by e.origem
          order by 2 desc, 3 desc, e.origem collate "C"
          limit 30
        ) as x
      ),
      'por_dia', (
        select coalesce(json_agg(json_build_object('dia', x.dia, 'visitantes', x.visitantes, 'clicaram', x.clicaram)
                                 order by x.dia), '[]'::json)
        from (
          select e.dia,
                 count(distinct e.quem) filter (where e.evento = 'visita')::int as visitantes,
                 count(distinct e.quem) filter (where e.evento = 'clique_grupo')::int as clicaram
          from eventos as e
          where e.pagina = pg.pagina
          group by e.dia
        ) as x
      )
    ) order by array_position(array['afericao', 'cuidador', 'evento_outubro'], pg.pagina) nulls last, pg.pagina collate "C")
    from paginas as pg
    cross join lateral (
      select count(*) filter (where e.evento = 'visita')::int as visitas,
             count(distinct e.quem) filter (where e.evento = 'visita')::int as visitantes,
             count(*) filter (where e.evento = 'clique_grupo')::int as cliques,
             count(distinct e.quem) filter (where e.evento = 'clique_grupo')::int as clicaram
      from eventos as e
      where e.pagina = pg.pagina
    ) as t
  ), '[]'::json));
$$;

revoke all on function public.pagina_registrar_evento(jsonb) from public, anon, authenticated;
revoke all on function public.paginas_resumo(timestamptz, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.pagina_registrar_evento(jsonb) to service_role;
grant execute on function public.paginas_resumo(timestamptz, timestamptz, jsonb) to service_role;

-- Sem isto, as rotas novas do /rest/v1 respondem 404 até o PostgREST reler o esquema sozinho — e o
-- formulário passaria os primeiros minutos sem gravar nada.
notify pgrst, 'reload schema';


-- ============================================================================================
-- 6. Inscrições com checkout na Hotmart (/viver-de-furo-inscricao) e o aviso de venda
--
-- A página nova é só um formulário: nome, WhatsApp e e-mail. Ao enviar, o SERVIDOR monta o link
-- do checkout (js/checkout-config.js, montarUrlCheckout: as UTMs seguem, o utm_term vira também o
-- `sck`, e o contato vai na URL para o checkout abrir preenchido), grava a inscrição aqui e
-- devolve o link para o navegador abrir.
--
-- Depois a Hotmart avisa cada evento de compra no webhook POST /api/hotmart/venda. O payload CRU
-- fica em compras.payload (jsonb): se a Hotmart mudar um campo de lugar, nada se perde e dá para
-- reprocessar. Cada aviso é primeiro atribuído à PÁGINA do produto (oferta/produto do
-- js/checkout-config.js, ou a oferta dos links que as páginas abriram) e só então casado com uma
-- inscrição DAQUELA página, por e-mail OU pelos ÚLTIMOS 8 dígitos do telefone — o 9 e o DDI variam,
-- os 8 finais não. Venda de produto que não é de página nenhuma (a Formação vendida no fim da
-- imersão, um order bump) fica gravada e não mexe em inscrito nenhum.
--
-- Mesmas barreiras das outras seções: RLS ligado e SEM política, revoke de public/anon/
-- authenticated, grant só para service_role, funções security invoker com search_path fixo.
--
-- Este bloco é autossuficiente: pode ser colado sozinho num banco que já tem as seções 1 a 5.
-- ============================================================================================

-- --------------------------------------------------------------------------------------------
-- inscricoes — uma linha por PESSOA em cada página (pagina + WhatsApp + e-mail).
--
-- Reenviar o formulário (voltou, clicou de novo, abriu no outro aparelho) NÃO cria linha nova:
-- soma `cliques`, atualiza o link do checkout e a visita (endereço + campanha) passa a ser a do
-- ÚLTIMO envio. É isso que faz "inscritos" ser gente, e "cliques" ser clique.
-- --------------------------------------------------------------------------------------------
create table if not exists public.inscricoes (
  -- O id nasce no navegador (o mesmo padrão da pesquisa). Se ele repetir para outro contato, a
  -- função gera um novo: quem manda é a chave (pagina, whatsapp_digits, email).
  id uuid primary key,
  -- Id da página em js/checkout-config.js ('viver-de-furo'). Só o formato fica aqui: página nova
  -- no config não pede SQL novo.
  pagina text not null check (pagina ~ '^[a-z0-9_-]{1,60}$'),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  nome text,
  whatsapp text,                                     -- como a pessoa vê: (11) 91234-5678
  whatsapp_digits text,                              -- só dígitos, sem DDI: 11912345678
  -- Pronto para o wa.me e para casar com o telefone que a Hotmart manda.
  whatsapp_internacional text generated always as ('55' || whatsapp_digits) stored,
  email text,
  checkout_url text,                                 -- o link exato que foi aberto (com utm e sck)
  cliques integer not null default 1,                -- quantas vezes ela pediu o checkout
  clicou_em timestamptz,                             -- o último pedido
  visitante_id uuid,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,                                     -- ele OU o utm_content vira o `sck` (depende da página)
  fbclid text,
  gclid text,
  page_url text,
  referrer text,
  dispositivo text,                                  -- 'mobile' | 'tablet' | 'desktop'
  comprou_em timestamptz,                            -- preenchido pelo aviso de compra aprovada
  compra_status text,
  compra_valor numeric(12, 2),
  compra_moeda text,
  compra_transacao text,
  compra_evento_em timestamptz,                      -- o momento do evento que gravou o estado atual
  -- Entrega confirmada (2xx) do aviso de inscrição ao n8n, nas páginas que têm webhook (a Imersão
  -- GPS). null = ainda não entregue: a varredura do servidor reenvia.
  webhook_enviado_em timestamptz
);

-- Banco que já tinha a tabela: a coluna entra sem mexer em nada.
alter table public.inscricoes add column if not exists webhook_enviado_em timestamptz;

-- A chave de verdade: a mesma pessoa na mesma página é UMA inscrição.
create unique index if not exists inscricoes_chave_idx
  on public.inscricoes (pagina, whatsapp_digits, email);
-- Lista do painel e recorte por período.
create index if not exists inscricoes_pagina_criado_em_idx
  on public.inscricoes (pagina, criado_em desc);
-- O casamento da compra procura por telefone e por e-mail.
create index if not exists inscricoes_whatsapp_digits_idx on public.inscricoes (whatsapp_digits);
create index if not exists inscricoes_email_idx on public.inscricoes (email);

-- --------------------------------------------------------------------------------------------
-- compras — uma linha por EVENTO de compra recebido da Hotmart (Webhook 2.0).
--
-- Guarda os campos que o painel usa E o payload cru. A mesma (transacao, evento) chegando duas
-- vezes (a Hotmart repete quando não recebe 2xx na hora) não vira duas linhas nem conta duas vezes.
-- --------------------------------------------------------------------------------------------
create table if not exists public.compras (
  id bigint generated always as identity primary key,
  recebido_em timestamptz not null default now(),
  evento text not null,                              -- PURCHASE_APPROVED, PURCHASE_REFUNDED, ...
  hotmart_id text,                                   -- o id do aviso, na Hotmart
  transacao text,                                    -- HP1234567890 — a compra
  status text,
  produto_id text,
  produto_nome text,
  oferta text,                                       -- o código da oferta (off=)
  valor numeric(12, 2),
  moeda text,
  comprador_nome text,
  comprador_email text,
  comprador_telefone text,
  comprador_digits text,                             -- só dígitos, para casar com a inscrição
  sck text,                                          -- o sck que a Hotmart devolveu (purchase.origin.sck)
  src text,
  pedido_em timestamptz,
  aprovado_em timestamptz,
  inscricao_id uuid,                                 -- null = compra que não casou com ninguém
  pagina text,                                       -- a página do PRODUTO (null = produto de fora)
  pagina_por text,                                   -- como a página foi achada (ver abaixo)
  evento_em timestamptz,                             -- a hora do EVENTO na Hotmart (creation_date)
  payload jsonb not null
);

-- Banco que já tinha a tabela (versão anterior): as duas colunas entram sem mexer em nada.
--   pagina_por = 'config' (a oferta/produto está no js/checkout-config.js), 'oferta' (a oferta de um
--                link que uma inscrição abriu) ou 'produto' (um aviso anterior do mesmo produto).
--                null = aviso gravado pela versão ANTERIOR, em que `pagina` era a página da inscrição
--                que casou, qualquer que fosse o produto: por isso nunca se aprende com ele.
--   evento_em  = quando o evento aconteceu na Hotmart. É por ele, e não pela chegada, que se sabe o
--                estado de uma venda: a Hotmart reenvia aviso velho depois do novo.
alter table public.compras add column if not exists pagina_por text;
alter table public.compras add column if not exists evento_em timestamptz;

-- Avisos gravados antes desta versão, completados a partir do payload cru (idempotente: só preenche
-- o que está vazio). O sck ficava null porque a versão anterior não lia purchase.origin.sck; a oferta
-- do carrinho abandonado vem em data.offer; a hora do evento é o creation_date (epoch em ms).
update public.compras set sck = btrim(payload #>> '{data,purchase,origin,sck}')
where sck is null and nullif(btrim(payload #>> '{data,purchase,origin,sck}'), '') is not null;
update public.compras set src = btrim(payload #>> '{data,purchase,origin,src}')
where src is null and nullif(btrim(payload #>> '{data,purchase,origin,src}'), '') is not null;
update public.compras set oferta = btrim(payload #>> '{data,offer,code}')
where oferta is null and nullif(btrim(payload #>> '{data,offer,code}'), '') is not null;
update public.compras
set evento_em = to_timestamp(case when (payload ->> 'creation_date')::numeric > 100000000000
                                  then (payload ->> 'creation_date')::numeric / 1000
                                  else (payload ->> 'creation_date')::numeric end)
where evento_em is null and (payload ->> 'creation_date') ~ '^[0-9]{10,16}$';

-- Idempotência. Parcial porque evento sem transação (um payload estranho) não pode bloquear os
-- outros: sem transação, cada aviso é uma linha.
create unique index if not exists compras_transacao_evento_idx
  on public.compras (transacao, evento)
  where transacao is not null;
create index if not exists compras_recebido_em_idx on public.compras (recebido_em desc);
create index if not exists compras_comprador_email_idx on public.compras (comprador_email);
create index if not exists compras_comprador_digits_idx on public.compras (comprador_digits);

-- --------------------------------------------------------------------------------------------
-- inscricoes_parciais — quem COMEÇOU o formulário e (ainda) não enviou.
--
-- Uma linha por aparelho em cada página (pagina + visitante_id), gravada enquanto a pessoa digita.
-- Serve para uma coisa só: a equipe ver no painel quem parou no meio e ir atrás pelo WhatsApp.
--
-- Nada aqui encosta em `inscricoes`. Rascunho é rascunho: pode ter só o nome, telefone pela
-- metade, e-mail sem arroba. Quem enviou de verdade ganha `concluido_em` e some da lista.
-- --------------------------------------------------------------------------------------------
create table if not exists public.inscricoes_parciais (
  id bigint generated always as identity primary key,
  -- Id da página em js/checkout-config.js — o mesmo formato de inscricoes.pagina.
  pagina text not null check (pagina ~ '^[a-z0-9_-]{1,60}$'),
  -- O visitante do aparelho (ev_pesquisa_visitante), que é o que existe antes do contato.
  visitante_id uuid not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  -- Preenchido por inscricao_salvar quando a pessoa termina. null = ainda não terminou.
  concluido_em timestamptz,
  nome text,
  whatsapp text,                                     -- do jeito que a pessoa digitou até agora
  whatsapp_digits text,                              -- só dígitos, pode estar incompleto
  email text,
  -- Em qual campo ela estava quando parou: 'nome' | 'whatsapp' | 'email'.
  ultimo_campo text check (ultimo_campo is null or ultimo_campo in ('nome', 'whatsapp', 'email')),
  toques integer not null default 1,                 -- quantas vezes o rascunho foi gravado
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  fbclid text,
  gclid text,
  page_url text,
  referrer text,
  dispositivo text
);

-- Um rascunho por aparelho em cada página: digitar mais não cria linha nova.
create unique index if not exists inscricoes_parciais_chave_idx
  on public.inscricoes_parciais (pagina, visitante_id);
-- A lista do painel: os que pararam por último primeiro.
create index if not exists inscricoes_parciais_pagina_atualizado_idx
  on public.inscricoes_parciais (pagina, atualizado_em desc);
-- inscricoes_parciais_abertas casa o rascunho com a inscrição pelo visitante.
create index if not exists inscricoes_visitante_id_idx on public.inscricoes (visitante_id);

-- --------------------------------------------------------------------------------------------
-- inscricoes_parciais_abertas — só quem REALMENTE não terminou.
--
-- Duas travas, e de propósito: `concluido_em is null` (o carimbo que inscricao_salvar põe) E
-- nenhuma inscrição da mesma página com o mesmo visitante, e-mail ou telefone. A segunda existe
-- por causa da corrida real: o rascunho que a pessoa deixou ao sair da página pode chegar DEPOIS
-- do envio, e sozinho o carimbo deixaria um comprador na lista de "não terminou".
-- --------------------------------------------------------------------------------------------
create or replace view public.inscricoes_parciais_abertas
with (security_invoker = true) as
select
  r.id,
  r.pagina,
  r.visitante_id,
  r.criado_em,
  r.atualizado_em,
  r.nome,
  r.whatsapp,
  r.whatsapp_digits,
  r.email,
  r.ultimo_campo,
  r.toques,
  r.utm_source,
  r.utm_medium,
  r.utm_campaign,
  r.utm_content,
  r.utm_term,
  r.fbclid,
  r.gclid,
  r.page_url,
  r.referrer,
  r.dispositivo
from public.inscricoes_parciais as r
where r.concluido_em is null
  and not exists (
    select 1
    from public.inscricoes as i
    where i.pagina = r.pagina
      and (
        i.visitante_id = r.visitante_id
        or (r.email is not null and i.email = r.email)
        or (r.whatsapp_digits is not null and i.whatsapp_digits = r.whatsapp_digits)
      )
  );

alter table public.inscricoes enable row level security;
alter table public.compras enable row level security;
revoke all on table public.inscricoes from public, anon, authenticated;
revoke all on table public.compras from public, anon, authenticated;
grant select, insert, update, delete on table public.inscricoes to service_role;
grant select, insert, update, delete on table public.compras to service_role;
alter table public.inscricoes_parciais enable row level security;
revoke all on table public.inscricoes_parciais from public, anon, authenticated;
grant select, insert, update, delete on table public.inscricoes_parciais to service_role;
revoke all on table public.inscricoes_parciais_abertas from public, anon, authenticated;
grant select on table public.inscricoes_parciais_abertas to service_role;
revoke all on sequence public.inscricoes_parciais_id_seq from public, anon, authenticated;
grant usage, select on sequence public.inscricoes_parciais_id_seq to service_role;
-- A sequência do id de compras também nasce com grant para anon no Supabase: fora.
revoke all on sequence public.compras_id_seq from public, anon, authenticated;
grant usage, select on sequence public.compras_id_seq to service_role;


-- --------------------------------------------------------------------------------------------
-- inscricao_salvar: grava (ou atualiza) a inscrição e devolve {ok, novo, id}.
--
-- `p` já vem validado pelo servidor (contato pelas mesmas regras da tela, link do checkout montado
-- por EVCheckout.montarUrlCheckout). Aqui mora só o que precisa ser atômico:
--   . a mesma pessoa na mesma página é UMA linha (chave única), com `cliques` somando;
--   . o rastreio é o do ÚLTIMO envio, e em BLOCO — a campanha inteira da visita, nunca meia
--     campanha de cada visita. Sem UTM no último envio = sem UTM (nada antigo fica grudado).
-- --------------------------------------------------------------------------------------------
create or replace function public.inscricao_salvar(p jsonb)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  d jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_pagina text := nullif(btrim(d ->> 'pagina'), '');
  v_digits text := nullif(btrim(d ->> 'whatsapp_digits'), '');
  v_email text := lower(nullif(btrim(d ->> 'email'), ''));
  v_id_pedido text := nullif(btrim(d ->> 'id'), '');
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_visitante uuid := case when nullif(btrim(d ->> 'visitante_id'), '') ~ uuid_re then (d ->> 'visitante_id')::uuid end;
  v_id uuid;
  v_novo boolean := false;
begin
  if v_pagina is null then
    raise exception 'inscricao_salvar: página obrigatória' using errcode = '22023';
  end if;
  if v_digits is null or v_email is null then
    raise exception 'inscricao_salvar: WhatsApp e e-mail obrigatórios' using errcode = '22023';
  end if;

  -- 1. Já existe? Soma o clique e a visita passa a ser a deste envio.
  update public.inscricoes as i set
    nome = coalesce(nullif(btrim(d ->> 'nome'), ''), i.nome),
    whatsapp = coalesce(nullif(btrim(d ->> 'whatsapp'), ''), i.whatsapp),
    checkout_url = coalesce(nullif(btrim(d ->> 'checkout_url'), ''), i.checkout_url),
    cliques = i.cliques + 1,
    clicou_em = now(),
    atualizado_em = now(),
    visitante_id = coalesce(i.visitante_id, case when nullif(btrim(d ->> 'visitante_id'), '') ~ uuid_re then (d ->> 'visitante_id')::uuid end),
    dispositivo = coalesce(nullif(btrim(d ->> 'dispositivo'), ''), i.dispositivo),
    -- A visita é a do ÚLTIMO envio, em bloco: endereço, referência e campanha saem juntos da mesma
    -- visita. Sem UTM nesta visita = sem UTM na inscrição — nenhuma campanha antiga fica grudada.
    page_url = coalesce(nullif(btrim(d ->> 'page_url'), ''), i.page_url),
    referrer = nullif(btrim(d ->> 'referrer'), ''),
    utm_source = nullif(btrim(d ->> 'utm_source'), ''),
    utm_medium = nullif(btrim(d ->> 'utm_medium'), ''),
    utm_campaign = nullif(btrim(d ->> 'utm_campaign'), ''),
    utm_content = nullif(btrim(d ->> 'utm_content'), ''),
    utm_term = nullif(btrim(d ->> 'utm_term'), ''),
    fbclid = nullif(btrim(d ->> 'fbclid'), ''),
    gclid = nullif(btrim(d ->> 'gclid'), '')
  where i.pagina = v_pagina and i.whatsapp_digits = v_digits and i.email = v_email
  returning i.id into v_id;

  if not found then
    -- 2. Primeira vez. O id do navegador só vale se ainda não existir aqui: a mesma pessoa que
    --    corrige o e-mail e reenvia manda o MESMO id para um contato diferente.
    insert into public.inscricoes (
      id, pagina, nome, whatsapp, whatsapp_digits, email, checkout_url, cliques, clicou_em,
      visitante_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid,
      page_url, referrer, dispositivo
    ) values (
      case
        when v_id_pedido ~ uuid_re and not exists (select 1 from public.inscricoes as x where x.id = v_id_pedido::uuid)
          then v_id_pedido::uuid
        else gen_random_uuid()
      end,
      v_pagina,
      nullif(btrim(d ->> 'nome'), ''),
      nullif(btrim(d ->> 'whatsapp'), ''),
      v_digits,
      v_email,
      nullif(btrim(d ->> 'checkout_url'), ''),
      1,
      now(),
      case when nullif(btrim(d ->> 'visitante_id'), '') ~ uuid_re then (d ->> 'visitante_id')::uuid end,
      nullif(btrim(d ->> 'utm_source'), ''),
      nullif(btrim(d ->> 'utm_medium'), ''),
      nullif(btrim(d ->> 'utm_campaign'), ''),
      nullif(btrim(d ->> 'utm_content'), ''),
      nullif(btrim(d ->> 'utm_term'), ''),
      nullif(btrim(d ->> 'fbclid'), ''),
      nullif(btrim(d ->> 'gclid'), ''),
      nullif(btrim(d ->> 'page_url'), ''),
      nullif(btrim(d ->> 'referrer'), ''),
      nullif(btrim(d ->> 'dispositivo'), '')
    )
    on conflict (pagina, whatsapp_digits, email) do nothing
    returning id into v_id;
    v_novo := found;

    -- 3. Corrida: outro envio inseriu a mesma pessoa entre o passo 1 e o 2. Conta o clique nela.
    if not v_novo then
      update public.inscricoes as i set cliques = i.cliques + 1, clicou_em = now(), atualizado_em = now()
      where i.pagina = v_pagina and i.whatsapp_digits = v_digits and i.email = v_email
      returning i.id into v_id;
    end if;
  end if;

  -- 4. Terminou: o rascunho dela sai da lista de "não terminaram". Fecha pelo visitante E pelo
  --    contato, porque quem começou num aparelho e enviou noutro é a mesma pessoa. Na MESMA
  --    transação do insert: não existe instante em que a inscrição já conta e o rascunho ainda
  --    está aberto.
  update public.inscricoes_parciais as r set concluido_em = now()
  where r.pagina = v_pagina
    and r.concluido_em is null
    and (
      (v_visitante is not null and r.visitante_id = v_visitante)
      or r.email = v_email
      or r.whatsapp_digits = v_digits
    );

  return json_build_object('ok', true, 'novo', v_novo, 'id', v_id);
end;
$$;


-- --------------------------------------------------------------------------------------------
-- inscricao_parcial_salvar: grava o RASCUNHO de quem está digitando e devolve {ok, id}.
--
-- Chamado enquanto a pessoa preenche, várias vezes, e por isso é curto e tolerante: nada aqui
-- valida contato (rascunho por definição está incompleto) e nada aqui lança por causa de um campo
-- feio. Obrigatórios só a página e o visitante, que são a chave.
--
-- Duas regras que fazem a lista do painel ser confiável:
--   . campo vazio NUNCA apaga o que já foi digitado (a pessoa que limpa o campo para corrigir não
--     perde o que tinha);
--   . `concluido_em` não é tocado aqui — um rascunho atrasado, chegando depois do envio, não
--     ressuscita ninguém como "não terminou".
-- --------------------------------------------------------------------------------------------
create or replace function public.inscricao_parcial_salvar(p jsonb)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  d jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_pagina text := nullif(btrim(d ->> 'pagina'), '');
  uuid_re constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_visitante uuid := case when nullif(btrim(d ->> 'visitante_id'), '') ~ uuid_re then (d ->> 'visitante_id')::uuid end;
  v_campo text := nullif(btrim(d ->> 'ultimo_campo'), '');
  v_id bigint;
begin
  if v_pagina is null then
    raise exception 'inscricao_parcial_salvar: página obrigatória' using errcode = '22023';
  end if;
  if v_visitante is null then
    raise exception 'inscricao_parcial_salvar: visitante obrigatório' using errcode = '22023';
  end if;
  if v_campo is not null and v_campo not in ('nome', 'whatsapp', 'email') then
    v_campo := null;
  end if;

  -- Um único comando: sem janela entre "existe?" e "grava", mesmo com dois toques ao mesmo tempo.
  insert into public.inscricoes_parciais as r (
    pagina, visitante_id, nome, whatsapp, whatsapp_digits, email, ultimo_campo,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid,
    page_url, referrer, dispositivo
  ) values (
    v_pagina,
    v_visitante,
    nullif(btrim(d ->> 'nome'), ''),
    nullif(btrim(d ->> 'whatsapp'), ''),
    nullif(btrim(d ->> 'whatsapp_digits'), ''),
    lower(nullif(btrim(d ->> 'email'), '')),
    v_campo,
    nullif(btrim(d ->> 'utm_source'), ''),
    nullif(btrim(d ->> 'utm_medium'), ''),
    nullif(btrim(d ->> 'utm_campaign'), ''),
    nullif(btrim(d ->> 'utm_content'), ''),
    nullif(btrim(d ->> 'utm_term'), ''),
    nullif(btrim(d ->> 'fbclid'), ''),
    nullif(btrim(d ->> 'gclid'), ''),
    nullif(btrim(d ->> 'page_url'), ''),
    nullif(btrim(d ->> 'referrer'), ''),
    nullif(btrim(d ->> 'dispositivo'), '')
  )
  on conflict (pagina, visitante_id) do update set
    -- coalesce(novo, velho): o que veio vazio não apaga o que já estava lá.
    nome = coalesce(excluded.nome, r.nome),
    whatsapp = coalesce(excluded.whatsapp, r.whatsapp),
    whatsapp_digits = coalesce(excluded.whatsapp_digits, r.whatsapp_digits),
    email = coalesce(excluded.email, r.email),
    ultimo_campo = coalesce(excluded.ultimo_campo, r.ultimo_campo),
    toques = r.toques + 1,
    atualizado_em = now(),
    dispositivo = coalesce(excluded.dispositivo, r.dispositivo),
    -- A visita é a do ÚLTIMO toque, em bloco, igual a inscricao_salvar.
    page_url = coalesce(excluded.page_url, r.page_url),
    referrer = excluded.referrer,
    utm_source = excluded.utm_source,
    utm_medium = excluded.utm_medium,
    utm_campaign = excluded.utm_campaign,
    utm_content = excluded.utm_content,
    utm_term = excluded.utm_term,
    fbclid = excluded.fbclid,
    gclid = excluded.gclid
  returning r.id into v_id;

  return json_build_object('ok', true, 'id', v_id);
end;
$$;


-- --------------------------------------------------------------------------------------------
-- hotmart_registrar_compra: grava o aviso de venda e marca (ou desmarca) a inscrição.
--
-- `p` vem do servidor com os campos já extraídos do payload da Hotmart e o payload CRU em
-- `payload`. Devolve {ok, novo, casou, inscricao_id, pagina}.
--
--   pagina = de qual página é o PRODUTO. Nesta ordem:
--              1. p.pagina, que o servidor tira do js/checkout-config.js (oferta ou id do produto);
--              0. a mesma transação num aviso anterior (fica na mesma página e na mesma inscrição);
--              2. a oferta (off=) do link de checkout que o PRÓPRIO comprador (mesmo e-mail ou 8
--                 últimos dígitos) abriu numa página — é o que faz a oferta de um lote novo ser
--                 reconhecida sem mexer no config. Só do próprio comprador: o link gravado vem do
--                 /api/inscricao, que qualquer um chama; uma inscrição inventada com a oferta da
--                 Formação não pode transformar a Formação dos outros em ingresso;
--              3. o mesmo produto num aviso anterior que o CONFIG reconheceu (pagina_por 'config').
--                 Nem 'oferta' nem 'produto' ensinam (não se espalha um erro), nem aviso da versão
--                 anterior (pagina_por null: nele `pagina` era a página da inscrição que casou,
--                 qualquer que fosse o produto), nem o produto '0' (o "Enviar teste" da Hotmart).
--            Nenhuma das três = produto de fora (a Formação, um order bump): o aviso é gravado com
--            pagina null e NÃO casa com inscrição nenhuma — senão a compra do curso marcaria o
--            ingresso como comprado, com o valor do curso, e o reembolso dele desmarcaria.
--   novo   = false quando o mesmo (transacao, evento) já estava gravado. A Hotmart repete o aviso
--            até receber 2xx; repetir não pode virar duas compras nem somar duas vezes.
--   casou  = achou, NA PÁGINA do produto, a inscrição pelo e-mail (igual, minúsculo) OU pelos
--            ÚLTIMOS 8 dígitos do telefone. Havendo mais de uma, vale a do e-mail, e depois a mais
--            recente.
--
-- Só PURCHASE_APPROVED e PURCHASE_COMPLETE marcam comprou_em. Cancelamento, reembolso, chargeback
-- e disputa limpam comprou_em e guardam o status. Um evento MAIS ANTIGO do que o que já está
-- gravado não sobrescreve o estado atual (a Hotmart pode reenviar um aviso velho depois do novo).
-- --------------------------------------------------------------------------------------------
create or replace function public.hotmart_registrar_compra(p jsonb)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  d jsonb := case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end;
  v_evento text := nullif(btrim(d ->> 'evento'), '');
  v_transacao text := nullif(btrim(d ->> 'transacao'), '');
  v_email text := lower(nullif(btrim(d ->> 'comprador_email'), ''));
  v_digits text := nullif(regexp_replace(coalesce(d ->> 'comprador_digits', ''), '[^0-9]', '', 'g'), '');
  v_fim8 text := case when length(nullif(regexp_replace(coalesce(d ->> 'comprador_digits', ''), '[^0-9]', '', 'g'), '')) >= 8
                      then right(regexp_replace(d ->> 'comprador_digits', '[^0-9]', '', 'g'), 8) end;
  v_pedido_em timestamptz := (nullif(btrim(d ->> 'pedido_em'), ''))::timestamptz;
  v_aprovado_em timestamptz := (nullif(btrim(d ->> 'aprovado_em'), ''))::timestamptz;
  v_evento_em timestamptz := (nullif(btrim(d ->> 'evento_em'), ''))::timestamptz;
  v_oferta text := nullif(btrim(d ->> 'oferta'), '');
  v_produto text := nullif(btrim(d ->> 'produto_id'), '');
  v_momento timestamptz;
  v_inscricao_id uuid;
  v_pagina text := nullif(btrim(d ->> 'pagina'), '');
  v_pagina_por text;
  v_compra_id bigint;
  v_novo boolean;
  v_outra record;
  aprovados constant text[] := array['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'];
  cancelados constant text[] := array['PURCHASE_CANCELED', 'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_PROTEST'];
begin
  if v_evento is null then
    raise exception 'hotmart_registrar_compra: evento obrigatório' using errcode = '22023';
  end if;
  v_momento := coalesce(v_evento_em, v_aprovado_em, v_pedido_em, now());

  -- 0. A mesma venda já chegou antes (APPROVED antes do COMPLETE, do REFUNDED...)? Fica na mesma
  --    inscrição e na mesma página: casar de novo a cada aviso podia cair em outra inscrição da
  --    mesma pessoa (reenviou o formulário com outro WhatsApp) e contar uma venda duas vezes.
  --    Aviso da versão anterior (pagina_por null) só vale se for da mesma página que o servidor já
  --    mandou: a página dele era a da inscrição que casou, qualquer que fosse o produto.
  if v_pagina is not null then
    v_pagina_por := 'config';
  end if;
  if v_transacao is not null then
    select c.inscricao_id, c.pagina, c.pagina_por into v_outra
    from public.compras as c
    where c.transacao = v_transacao
      and c.pagina is not null
      and (c.pagina_por is not null or c.pagina = v_pagina)
    order by (c.inscricao_id is not null) desc, c.id
    limit 1;
    if found and (v_pagina is null or v_outra.pagina = v_pagina) then
      v_inscricao_id := v_outra.inscricao_id;
      if v_pagina is null then
        v_pagina := v_outra.pagina;
        v_pagina_por := v_outra.pagina_por;
      end if;
    end if;
  end if;

  -- 1. De qual página é este produto? O servidor já mandou o que o config sabe; senão, a oferta
  --    de um link que o PRÓPRIO comprador abriu numa página (lote novo); senão, um aviso anterior
  --    do mesmo produto que o config reconheceu. Nada aqui aprende com dado que qualquer um pode
  --    mandar ao /api/inscricao: uma inscrição inventada com a oferta da Formação no link não faz a
  --    Formação dos outros virar ingresso.
  if v_pagina is null and v_oferta is not null and (v_email is not null or v_fim8 is not null) then
    select i.pagina into v_pagina
    from public.inscricoes as i
    where i.checkout_url is not null
      and substring(i.checkout_url from '[?&]off=([^&#]+)') = v_oferta
      and ((v_email is not null and lower(i.email) = v_email)
        or (v_fim8 is not null and i.whatsapp_digits is not null and right(i.whatsapp_digits, 8) = v_fim8))
    order by (v_email is not null and lower(i.email) = v_email) desc, i.criado_em desc
    limit 1;
    if v_pagina is not null then v_pagina_por := 'oferta'; end if;
  end if;
  if v_pagina is null and v_produto is not null and v_produto <> '0' then
    select c.pagina into v_pagina
    from public.compras as c
    where c.produto_id = v_produto and c.pagina is not null and c.pagina_por = 'config'
    order by c.recebido_em desc, c.id desc
    limit 1;
    if v_pagina is not null then v_pagina_por := 'produto'; end if;
  end if;

  -- 2. De quem é esta compra, NA página do produto? E-mail primeiro; senão, os últimos 8 dígitos
  --    do telefone. Produto de fora (v_pagina null) não casa com ninguém.
  if v_pagina is not null and v_inscricao_id is null then
    select i.id into v_inscricao_id
    from public.inscricoes as i
    where i.pagina = v_pagina
      and ((v_email is not null and lower(i.email) = v_email)
        or (v_fim8 is not null and i.whatsapp_digits is not null and right(i.whatsapp_digits, 8) = v_fim8))
    order by (v_email is not null and lower(i.email) = v_email) desc, i.criado_em desc
    limit 1;
  end if;

  -- 3. Grava o aviso. O mesmo (transacao, evento) só entra uma vez.
  insert into public.compras (
    evento, hotmart_id, transacao, status, produto_id, produto_nome, oferta, valor, moeda,
    comprador_nome, comprador_email, comprador_telefone, comprador_digits, sck, src,
    pedido_em, aprovado_em, inscricao_id, pagina, pagina_por, evento_em, payload
  ) values (
    v_evento,
    nullif(btrim(d ->> 'hotmart_id'), ''),
    v_transacao,
    nullif(btrim(d ->> 'status'), ''),
    v_produto,
    nullif(btrim(d ->> 'produto_nome'), ''),
    v_oferta,
    (nullif(btrim(d ->> 'valor'), ''))::numeric,
    nullif(btrim(d ->> 'moeda'), ''),
    nullif(btrim(d ->> 'comprador_nome'), ''),
    v_email,
    nullif(btrim(d ->> 'comprador_telefone'), ''),
    v_digits,
    nullif(btrim(d ->> 'sck'), ''),
    nullif(btrim(d ->> 'src'), ''),
    v_pedido_em,
    v_aprovado_em,
    v_inscricao_id,
    v_pagina,
    v_pagina_por,
    v_momento,
    case when jsonb_typeof(d -> 'payload') is null then '{}'::jsonb else d -> 'payload' end
  )
  on conflict (transacao, evento) where transacao is not null do nothing
  returning id into v_compra_id;
  v_novo := found;

  -- 4. Marca a inscrição. Aviso repetido não mexe em nada, e aviso sem transação também não (um
  --    payload estranho não entra em "vendas", então também não vira "compra de inscrito").
  --    O estado segue a TRANSAÇÃO: quem comprou duas vezes (ou um 2º ingresso no order bump) fica
  --    com a primeira compra; reembolso de uma transação só desmarca se for a que está marcada, e aí
  --    a inscrição volta para outra transação dela que continua aprovada, se houver.
  if v_novo and v_inscricao_id is not null and v_transacao is not null then
    if v_evento = any (aprovados) then
      update public.inscricoes as i set
        comprou_em = coalesce(v_aprovado_em, v_momento),
        compra_status = coalesce(nullif(btrim(d ->> 'status'), ''), v_evento),
        compra_valor = coalesce((nullif(btrim(d ->> 'valor'), ''))::numeric, i.compra_valor),
        compra_moeda = coalesce(nullif(btrim(d ->> 'moeda'), ''), i.compra_moeda),
        compra_transacao = v_transacao,
        compra_evento_em = v_momento,
        atualizado_em = now()
      where i.id = v_inscricao_id
        and (
          -- a mesma transação: vale o evento mais novo
          (i.compra_transacao = v_transacao and (i.compra_evento_em is null or i.compra_evento_em <= v_momento))
          -- outra transação: só se a pessoa não está com uma compra valendo
          or (i.compra_transacao is distinct from v_transacao and i.comprou_em is null)
        );
    elsif v_evento = any (cancelados) then
      update public.inscricoes as i set
        comprou_em = null,
        compra_status = coalesce(nullif(btrim(d ->> 'status'), ''), v_evento),
        compra_transacao = v_transacao,
        compra_evento_em = v_momento,
        atualizado_em = now()
      where i.id = v_inscricao_id
        and (i.compra_transacao is null or i.compra_transacao = v_transacao)
        and (i.compra_evento_em is null or i.compra_evento_em <= v_momento);
      if found then
        -- Outra transação desta inscrição que continua aprovada (último evento dela, pela hora do
        -- evento, é compra aprovada/completa)? A inscrição volta a ser compradora por ela.
        select t.transacao, t.aprovada_em, t.valor, t.moeda, t.status into v_outra
        from (
          select c.transacao,
                 (array_agg(c.evento order by coalesce(c.evento_em, c.recebido_em) desc, c.id desc))[1] as ultimo,
                 min(coalesce(c.aprovado_em, c.evento_em, c.recebido_em)) filter (where c.evento = any (aprovados)) as aprovada_em,
                 (array_agg(c.valor order by coalesce(c.evento_em, c.recebido_em) desc, c.id desc)
                    filter (where c.evento = any (aprovados) and c.valor is not null))[1] as valor,
                 (array_agg(c.moeda order by coalesce(c.evento_em, c.recebido_em) desc, c.id desc)
                    filter (where c.evento = any (aprovados) and c.moeda is not null))[1] as moeda,
                 (array_agg(coalesce(c.status, c.evento) order by coalesce(c.evento_em, c.recebido_em) desc, c.id desc)
                    filter (where c.evento = any (aprovados)))[1] as status
          from public.compras as c
          where c.inscricao_id = v_inscricao_id
            and c.transacao is not null
            and c.transacao <> v_transacao
            and c.evento = any (aprovados || cancelados)
          group by c.transacao
        ) as t
        where t.ultimo = any (aprovados)
        order by t.aprovada_em, t.transacao
        limit 1;
        if found then
          update public.inscricoes as i set
            comprou_em = v_outra.aprovada_em,
            compra_status = v_outra.status,
            compra_valor = coalesce(v_outra.valor, i.compra_valor),
            compra_moeda = coalesce(v_outra.moeda, i.compra_moeda),
            compra_transacao = v_outra.transacao,
            atualizado_em = now()
          where i.id = v_inscricao_id;
        end if;
      end if;
    end if;
  end if;

  return json_build_object(
    'ok', true,
    'novo', v_novo,
    'casou', v_inscricao_id is not null,
    'inscricao_id', v_inscricao_id,
    'pagina', v_pagina
  );
end;
$$;


-- --------------------------------------------------------------------------------------------
-- inscricoes_resumo: os números da aba de inscrições do painel, numa ida ao banco.
--
--   p_desde/p_ate  = recorte por inscricoes.criado_em, em [p_desde, p_ate)
--   p_pagina       = uma página do js/checkout-config.js; null = todas as que têm inscrição
--
--   inscritos      = pessoas (uma linha por pagina+WhatsApp+e-mail)
--   cliques        = quantas vezes o checkout foi pedido (reenviar o formulário soma aqui)
--   compras        = inscritos com comprou_em preenchido
--   receita        = soma de compra_valor desses inscritos
--   taxa_compra    = compras / inscritos em PORCENTAGEM, com 1 casa (ex.: 12.5)
--   por_origem / por_midia / por_campanha / por_conteudo / por_termo = utm_source, utm_medium,
--                    utm_campaign, utm_content e utm_term dos inscritos ('(sem utm)' quando vazio).
--                    Uma delas vira o `sck` no checkout (utm_term na Viver de Furo, utm_content na
--                    Imersão GPS): é por ela que se sabe qual criativo vendeu.
--   vendas / vendas_receita / vendas_por_sck = o lado da HOTMART: transações do produto da página
--                    APROVADAS no período e que continuam aprovadas (o último evento delas até o fim
--                    do período, pela hora do evento, é compra aprovada/completa: reembolso,
--                    cancelamento e chargeback tiram), com o `sck` que a Hotmart devolveu. Conta
--                    também quem comprou sem passar pelo formulário (casadas = quantas têm inscrição).
--   por_dia        = inscritos pelo dia da INSCRIÇÃO e compras pelo dia da COMPRA, no fuso de
--                    São Paulo (um dia pode ter compra sem inscrição nova, e vice-versa)
--   compras_sem_inscricao = as vendas acima que não casaram com ninguém (comprou pelo link de outro
--                    lugar, ou com outro e-mail e outro telefone) = vendas − casadas
--   compras_recentes = os 20 avisos mais recentes do período, com `casou` e o `sck`
--
-- Com p_pagina, os avisos são só os do produto DAQUELA página: a venda de outro produto (a
-- Formação, um order bump, a outra página) não aparece como "sem inscrição" aqui.
--
-- Listas vazias voltam como [], nunca null.
-- --------------------------------------------------------------------------------------------
create or replace function public.inscricoes_resumo(
  p_desde timestamptz default null,
  p_ate timestamptz default null,
  p_pagina text default null
)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  with
  base as materialized (
    select i.*
    from public.inscricoes as i
    where (p_pagina is null or i.pagina = p_pagina)
      and (p_desde is null or i.criado_em >= p_desde)
      and (p_ate is null or i.criado_em < p_ate)
  ),
  eventos as materialized (
    select c.*
    from public.compras as c
    where (p_pagina is null or c.pagina = p_pagina)
      and (p_desde is null or c.recebido_em >= p_desde)
      and (p_ate is null or c.recebido_em < p_ate)
  ),
  -- Cada venda (transação) do lado da Hotmart. O ESTADO sai do histórico inteiro dela até o fim do
  -- período (não só dos avisos do período), na ordem em que os eventos ACONTECERAM (evento_em, que a
  -- Hotmart manda; a chegada só desempata): um APPROVED velho reenviado depois do REFUNDED não
  -- ressuscita a venda. A venda conta no período da PRIMEIRA aprovação: o PURCHASE_COMPLETE (fim da
  -- garantia, dias depois) não faz uma venda antiga aparecer como venda de hoje.
  historico as materialized (
    select c.*, coalesce(c.evento_em, c.recebido_em) as momento
    from public.compras as c
    where (p_pagina is null or c.pagina = p_pagina)
      -- pela hora do EVENTO: a venda de 23:59 cujo aviso chega 00:00 continua no dia dela
      and (p_ate is null or coalesce(c.evento_em, c.recebido_em) < p_ate)
      and c.transacao is not null
      and c.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE', 'PURCHASE_CANCELED', 'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_PROTEST')
  ),
  vendas as materialized (
    select v.*
    from (
      select h.transacao,
             (array_agg(h.evento order by h.momento desc, h.recebido_em desc, h.id desc))[1] as evento,
             (array_agg(h.pagina order by h.momento desc, h.recebido_em desc, h.id desc))[1] as pagina,
             (array_agg(h.sck order by h.momento desc, h.recebido_em desc, h.id desc)
                filter (where nullif(btrim(h.sck), '') is not null))[1] as sck,
             (array_agg(h.valor order by h.momento desc, h.recebido_em desc, h.id desc)
                filter (where h.valor is not null and h.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE')))[1] as valor,
             (array_agg(h.inscricao_id order by h.momento desc, h.recebido_em desc, h.id desc)
                filter (where h.inscricao_id is not null))[1] as inscricao_id,
             min(coalesce(h.aprovado_em, h.momento)) filter (where h.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE')) as aprovada_em
      from historico as h
      group by h.transacao
    ) as v
    where v.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE')
      and v.aprovada_em is not null
      and (p_desde is null or v.aprovada_em >= p_desde)
      and (p_ate is null or v.aprovada_em < p_ate)
  ),
  -- Com p_pagina, só ela (mesmo zerada). Sem, toda página que teve inscrição OU venda no período.
  paginas as (
    select p_pagina as pagina where p_pagina is not null
    union
    select distinct b.pagina from base as b where p_pagina is null
    union
    select distinct vs.pagina from vendas as vs where p_pagina is null and vs.pagina is not null
  )
  select json_build_object(
    'paginas', coalesce((
      select json_agg(json_build_object(
        'pagina', pg.pagina,
        'inscritos', t.inscritos,
        'cliques', t.cliques,
        'compras', t.compras,
        'receita', t.receita,
        'taxa_compra', case when t.inscritos > 0 then round(t.compras::numeric * 100 / t.inscritos, 1) else 0 end,
        'por_origem', (
          select coalesce(json_agg(json_build_object('utm_source', x.valor, 'inscritos', x.inscritos, 'compras', x.compras)
                                   order by x.inscritos desc, x.compras desc, x.valor collate "C"), '[]'::json)
          from (
            -- O top 50 sai de uma subconsulta nomeada: "collate" precisa de uma coluna de verdade,
            -- e não do apelido do select.
            select * from (
              select coalesce(nullif(btrim(b.utm_source), ''), '(sem utm)') as valor,
                     count(*)::int as inscritos,
                     count(*) filter (where b.comprou_em is not null)::int as compras
              from base as b where b.pagina = pg.pagina group by 1
            ) as y
            order by y.inscritos desc, y.compras desc, y.valor collate "C"
            limit 50
          ) as x
        ),
        'por_midia', (
          select coalesce(json_agg(json_build_object('utm_medium', x.valor, 'inscritos', x.inscritos, 'compras', x.compras)
                                   order by x.inscritos desc, x.compras desc, x.valor collate "C"), '[]'::json)
          from (
            select * from (
              select coalesce(nullif(btrim(b.utm_medium), ''), '(sem utm)') as valor,
                     count(*)::int as inscritos,
                     count(*) filter (where b.comprou_em is not null)::int as compras
              from base as b where b.pagina = pg.pagina group by 1
            ) as y
            order by y.inscritos desc, y.compras desc, y.valor collate "C"
            limit 50
          ) as x
        ),
        'por_campanha', (
          select coalesce(json_agg(json_build_object('utm_campaign', x.valor, 'inscritos', x.inscritos, 'compras', x.compras)
                                   order by x.inscritos desc, x.compras desc, x.valor collate "C"), '[]'::json)
          from (
            -- O top 50 sai de uma subconsulta nomeada: "collate" precisa de uma coluna de verdade,
            -- e não do apelido do select.
            select * from (
              select coalesce(nullif(btrim(b.utm_campaign), ''), '(sem utm)') as valor,
                     count(*)::int as inscritos,
                     count(*) filter (where b.comprou_em is not null)::int as compras
              from base as b where b.pagina = pg.pagina group by 1
            ) as y
            order by y.inscritos desc, y.compras desc, y.valor collate "C"
            limit 50
          ) as x
        ),
        'por_conteudo', (
          select coalesce(json_agg(json_build_object('utm_content', x.valor, 'inscritos', x.inscritos, 'compras', x.compras)
                                   order by x.inscritos desc, x.compras desc, x.valor collate "C"), '[]'::json)
          from (
            select * from (
              select coalesce(nullif(btrim(b.utm_content), ''), '(sem utm)') as valor,
                     count(*)::int as inscritos,
                     count(*) filter (where b.comprou_em is not null)::int as compras
              from base as b where b.pagina = pg.pagina group by 1
            ) as y
            order by y.inscritos desc, y.compras desc, y.valor collate "C"
            limit 50
          ) as x
        ),
        'por_termo', (
          select coalesce(json_agg(json_build_object('utm_term', x.valor, 'inscritos', x.inscritos, 'compras', x.compras)
                                   order by x.inscritos desc, x.compras desc, x.valor collate "C"), '[]'::json)
          from (
            -- O top 50 sai de uma subconsulta nomeada: "collate" precisa de uma coluna de verdade,
            -- e não do apelido do select.
            select * from (
              select coalesce(nullif(btrim(b.utm_term), ''), '(sem utm)') as valor,
                     count(*)::int as inscritos,
                     count(*) filter (where b.comprou_em is not null)::int as compras
              from base as b where b.pagina = pg.pagina group by 1
            ) as y
            order by y.inscritos desc, y.compras desc, y.valor collate "C"
            limit 50
          ) as x
        ),
        'vendas', v.vendas,
        'vendas_receita', v.receita,
        'vendas_por_sck', (
          select coalesce(json_agg(json_build_object('sck', x.valor, 'vendas', x.vendas, 'receita', x.receita, 'casadas', x.casadas)
                                   order by x.vendas desc, x.receita desc, x.valor collate "C"), '[]'::json)
          from (
            select * from (
              select coalesce(nullif(btrim(vs.sck), ''), '(sem sck)') as valor,
                     count(*)::int as vendas,
                     coalesce(sum(vs.valor), 0)::numeric(12, 2) as receita,
                     count(*) filter (where vs.inscricao_id is not null)::int as casadas
              from vendas as vs
              where vs.pagina = pg.pagina and vs.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE')
              group by 1
            ) as y
            order by y.vendas desc, y.receita desc, y.valor collate "C"
            -- É por venda, não por pessoa: com utm_content={{ad.name}} passa fácil de 50 criativos,
            -- e a tabela cortada não somaria o total.
            limit 500
          ) as x
        ),
        'por_dia', (
          select coalesce(json_agg(json_build_object('dia', x.dia, 'inscritos', x.inscritos, 'compras', x.compras)
                                   order by x.dia), '[]'::json)
          from (
            select u.dia, sum(u.ins)::int as inscritos, sum(u.com)::int as compras
            from (
              select (b.criado_em at time zone 'America/Sao_Paulo')::date as dia, 1 as ins, 0 as com
              from base as b where b.pagina = pg.pagina
              union all
              select (b.comprou_em at time zone 'America/Sao_Paulo')::date, 0, 1
              from base as b where b.pagina = pg.pagina and b.comprou_em is not null
            ) as u
            group by u.dia
          ) as x
        )
      ) order by pg.pagina collate "C")
      from paginas as pg
      cross join lateral (
        select count(*)::int as inscritos,
               coalesce(sum(b.cliques), 0)::int as cliques,
               count(*) filter (where b.comprou_em is not null)::int as compras,
               coalesce(sum(b.compra_valor) filter (where b.comprou_em is not null), 0)::numeric(12, 2) as receita
        from base as b
        where b.pagina = pg.pagina
      ) as t
      cross join lateral (
        select count(*)::int as vendas, coalesce(sum(vs.valor), 0)::numeric(12, 2) as receita
        from vendas as vs
        where vs.pagina = pg.pagina and vs.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE')
      ) as v
    ), '[]'::json),
    -- As vendas de cima que não casaram com inscrição nenhuma: a mesma régua de vendas (uma por
    -- transação, reembolso tira, conta no período da aprovação). Sem p_pagina entram também as de
    -- produto de fora (pagina null), que não são de página nenhuma.
    'compras_sem_inscricao', (
      select count(*)::int from vendas as vs where vs.inscricao_id is null
    ),
    'compras_recentes', coalesce((
      select json_agg(json_build_object(
        'recebido_em', x.recebido_em,
        'evento_em', x.evento_em,
        'evento', x.evento,
        'status', x.status,
        'comprador_nome', x.comprador_nome,
        'comprador_email', x.comprador_email,
        'valor', x.valor,
        'pagina', x.pagina,
        'sck', x.sck,
        'casou', x.inscricao_id is not null
      ) order by x.recebido_em desc, x.id desc)
      from (select * from eventos order by recebido_em desc, id desc limit 20) as x
    ), '[]'::json)
  );
$$;

revoke all on function public.inscricao_salvar(jsonb) from public, anon, authenticated;
revoke all on function public.inscricao_parcial_salvar(jsonb) from public, anon, authenticated;
revoke all on function public.hotmart_registrar_compra(jsonb) from public, anon, authenticated;
revoke all on function public.inscricoes_resumo(timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.inscricao_salvar(jsonb) to service_role;
grant execute on function public.inscricao_parcial_salvar(jsonb) to service_role;
grant execute on function public.hotmart_registrar_compra(jsonb) to service_role;
grant execute on function public.inscricoes_resumo(timestamptz, timestamptz, text) to service_role;

-- De novo, porque este bloco pode ser colado sozinho: sem isto, /rest/v1/rpc/inscricao_salvar
-- responde 404 até o PostgREST reler o esquema sozinho — e a página passaria os primeiros minutos
-- sem gravar inscrição nenhuma.
notify pgrst, 'reload schema';


-- ============================================================================================
-- 7. Comentários das salas de aula (/replay-*)
--
-- Um mural por sala: quem liberou a aula escreve, a Iza responde do perfil dela (com selo) e a
-- moderação esconde ou exclui. Hospedado aqui, sem serviço de terceiro — o texto é nosso, a
-- remoção é nossa, e a página continua sem carregar nada de fora.
--
-- Três decisões que carregam o resto:
--
--   1. O ID É DO SERVIDOR (identity), e não do navegador. É o contrário do pesquisa_salvar de
--      propósito: aqui a linha é PÚBLICA, e chave escolhida pelo cliente entregaria a ele o espaço
--      de chaves e um oráculo de existência. A paginação do mural é keyset por esse id.
--   2. A RESPOSTA DA IZA É LINHA FILHA da mesma tabela (resposta_a), com admin = true. Só
--      replay_comentario_responder escreve true, e ela exige o e-mail da sessão do painel: a rota
--      pública não tem como forjar o selo.
--   3. MODERAÇÃO POR ESTADO, não por delete. `oculto` é reversível (o texto continua no painel);
--      `excluido` é definitivo e APAGA o texto, mantendo a linha para a resposta da Iza não virar
--      órfã. `delete from` fica reservado a pedido de titular (LGPD), e a self-FK leva a resposta.
--
-- Mesmas barreiras das outras seções: RLS ligado e SEM política, revoke de public/anon/
-- authenticated, grant só para service_role, funções security invoker com search_path fixo.
--
-- Este bloco é autossuficiente: pode ser colado sozinho num banco que já tem as seções 1 a 6.
-- ============================================================================================

create table if not exists public.replay_comentarios (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  -- O id de PESQUISA da sala ('replay-afericao'), que é a mesma chave que separa as salas em
  -- pesquisa_respostas.pesquisa e nas abas do painel.
  sala text not null check (sala ~ '^[a-z0-9_-]{1,60}$'),
  -- Quem escreveu: a linha de pesquisa_respostas que liberou a sala. Não é credencial (o id vem do
  -- navegador), é rastro — serve para o painel saber com quem falar e para juntar comentário e lead.
  sessao_id uuid,
  visitante_id uuid,
  -- O nome COMPLETO fica aqui para o painel; o público lê só o abreviado da view.
  autor_nome text not null,
  autor_exibicao text not null,
  autor_perfil text,
  resposta_a bigint references public.replay_comentarios (id) on delete cascade,
  admin boolean not null default false,
  admin_email text,
  texto text not null,
  estado text not null default 'visivel' check (estado in ('visivel', 'em_revisao', 'oculto', 'excluido')),
  moderado_em timestamptz,
  moderado_por text
);

-- Banco que já tinha a tabela: nada a alterar hoje (a seção nasceu completa).

-- O mural público: comentários de topo visíveis de uma sala, os mais novos primeiro. Parcial
-- porque é exatamente o recorte que a página lê — respostas e escondidos não pesam no índice.
create index if not exists replay_comentarios_mural_idx
  on public.replay_comentarios (sala, id desc)
  where resposta_a is null and estado = 'visivel';
-- A moderação: a mesma sala com TODOS os estados.
create index if not exists replay_comentarios_sala_idx
  on public.replay_comentarios (sala, id desc);
-- As respostas de cada comentário de topo.
create index if not exists replay_comentarios_resposta_idx
  on public.replay_comentarios (resposta_a)
  where resposta_a is not null;
-- "quantos comentários esta pessoa escreveu": o freio de repetição e a ficha do lead no painel.
create index if not exists replay_comentarios_sessao_idx
  on public.replay_comentarios (sessao_id, criado_em desc)
  where sessao_id is not null;

alter table public.replay_comentarios enable row level security;
-- Tabela criada em public nasce com grant para anon e authenticated no Supabase. O RLS sem
-- política já bloqueia as linhas; o revoke tira até a possibilidade de tentar.
revoke all on table public.replay_comentarios from public, anon, authenticated;
revoke all on sequence public.replay_comentarios_id_seq from public, anon, authenticated;
grant select, insert, update, delete on table public.replay_comentarios to service_role;
grant usage, select on sequence public.replay_comentarios_id_seq to service_role;

-- --------------------------------------------------------------------------------------------
-- replay_comentarios_publicos — o que a página pode ver.
--
-- Só 'visivel', e só as colunas que a tela desenha: sem sessao_id, sem visitante_id, sem
-- admin_email, sem o nome completo. A listagem pública lê SÓ esta view e a do painel lê a tabela —
-- dois caminhos diferentes para que o filtro de estado seja impossível de esquecer no Node.
--
-- security_invoker = true: a view consulta a tabela com a permissão de QUEM consulta, e não do
-- dono dela. Sem isto, um grant esquecido em anon vazaria o mural inteiro.
-- --------------------------------------------------------------------------------------------
drop view if exists public.replay_comentarios_publicos;

create view public.replay_comentarios_publicos
with (security_invoker = true)
as
select
  id,
  criado_em,
  sala,
  resposta_a,
  admin,
  autor_exibicao,
  autor_perfil,
  texto
from public.replay_comentarios
where estado = 'visivel';

revoke all on table public.replay_comentarios_publicos from public, anon, authenticated;
grant select on table public.replay_comentarios_publicos to service_role;

-- --------------------------------------------------------------------------------------------
-- replay_comentario_publicar(p jsonb) — o comentário de quem liberou a sala.
--
-- A função IGNORA `admin` e `resposta_a` do payload de propósito: por aqui não se forja selo nem
-- se responde como a Iza. O nome vem de pesquisa_respostas (que o Node já conferiu), não do corpo.
--
-- Freio de repetição por sessão: 20 segundos entre comentários e o mesmo texto recusado em 24h. Não
-- é segurança (o id de sessão vem do navegador) — é o que impede toque duplo e martelada de F5. O
-- freio que vale é o limitador por IP do servidor.
-- --------------------------------------------------------------------------------------------
create or replace function public.replay_comentario_publicar(p jsonb)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sala text := nullif(btrim(p ->> 'sala'), '');
  v_sessao uuid := (p ->> 'sessao_id')::uuid;
  v_texto text := btrim(p ->> 'texto');
  v_estado text := coalesce(nullif(p ->> 'estado', ''), 'visivel');
  v_ultimo timestamptz;
  v_id bigint;
begin
  if v_sala is null or v_texto is null or char_length(v_texto) < 2 then
    raise exception 'comentario_invalido' using errcode = '22023';
  end if;
  if v_estado not in ('visivel', 'em_revisao') then
    raise exception 'estado_invalido' using errcode = '22023';
  end if;

  if v_sessao is not null then
    select max(criado_em) into v_ultimo
    from public.replay_comentarios
    where sessao_id = v_sessao and sala = v_sala and not admin;

    if v_ultimo is not null and now() - v_ultimo < interval '20 seconds' then
      raise exception 'muito_rapido' using errcode = '22023';
    end if;

    if exists (
      select 1 from public.replay_comentarios
      where sessao_id = v_sessao and sala = v_sala and texto = v_texto and criado_em > now() - interval '24 hours'
    ) then
      raise exception 'repetido' using errcode = '22023';
    end if;
  end if;

  insert into public.replay_comentarios (
    sala, sessao_id, visitante_id, autor_nome, autor_exibicao, autor_perfil, texto, estado
  ) values (
    v_sala,
    v_sessao,
    (p ->> 'visitante_id')::uuid,
    p ->> 'autor_nome',
    p ->> 'autor_exibicao',
    nullif(p ->> 'autor_perfil', ''),
    v_texto,
    v_estado
  )
  returning id into v_id;

  return json_build_object('id', v_id, 'estado', v_estado);
end;
$$;

-- --------------------------------------------------------------------------------------------
-- replay_comentario_responder(p jsonb) — a resposta da Iza.
--
-- Só esta função escreve admin = true, e ela exige o e-mail da sessão do painel (o Node só chama
-- depois de validar o cookie). Responde a uma RAIZ: resposta de resposta é recusada, então o mural
-- tem um nível e não uma árvore.
-- --------------------------------------------------------------------------------------------
create or replace function public.replay_comentario_responder(p jsonb)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sala text := nullif(btrim(p ->> 'sala'), '');
  v_alvo bigint := (p ->> 'resposta_a')::bigint;
  v_texto text := btrim(p ->> 'texto');
  v_email text := nullif(btrim(p ->> 'admin_email'), '');
  v_raiz record;
  v_id bigint;
begin
  if v_sala is null or v_alvo is null or v_texto is null or char_length(v_texto) < 2 then
    raise exception 'comentario_invalido' using errcode = '22023';
  end if;
  if v_email is null then
    raise exception 'sem_admin' using errcode = '22023';
  end if;

  select id, resposta_a, estado into v_raiz
  from public.replay_comentarios
  where id = v_alvo and sala = v_sala;

  if not found then
    raise exception 'comentario_nao_encontrado' using errcode = '22023';
  end if;
  if v_raiz.resposta_a is not null then
    raise exception 'resposta_de_resposta' using errcode = '22023';
  end if;

  insert into public.replay_comentarios (
    sala, resposta_a, admin, admin_email, autor_nome, autor_exibicao, autor_perfil, texto, estado
  ) values (
    v_sala,
    v_alvo,
    true,
    v_email,
    p ->> 'autor_nome',
    p ->> 'autor_exibicao',
    nullif(p ->> 'autor_perfil', ''),
    v_texto,
    'visivel'
  )
  returning id into v_id;

  return json_build_object('id', v_id, 'resposta_a', v_alvo);
end;
$$;

-- --------------------------------------------------------------------------------------------
-- replay_comentario_moderar(p jsonb) — esconder, mostrar de novo e excluir.
--
-- Esconder um comentário de topo esconde as RESPOSTAS dele no mesmo update: senão a resposta da
-- Iza continuaria no ar sozinha, sem a pergunta. Excluir apaga o texto e mantém a linha.
-- --------------------------------------------------------------------------------------------
create or replace function public.replay_comentario_moderar(p jsonb)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sala text := nullif(btrim(p ->> 'sala'), '');
  v_id bigint := (p ->> 'id')::bigint;
  v_acao text := nullif(btrim(p ->> 'acao'), '');
  v_por text := nullif(btrim(p ->> 'por'), '');
  v_estado text;
  v_afetadas int;
begin
  if v_sala is null or v_id is null then
    raise exception 'comentario_invalido' using errcode = '22023';
  end if;
  v_estado := case v_acao
    when 'esconder' then 'oculto'
    when 'mostrar' then 'visivel'
    when 'excluir' then 'excluido'
    else null
  end;
  if v_estado is null then
    raise exception 'acao_invalida' using errcode = '22023';
  end if;

  if not exists (select 1 from public.replay_comentarios where id = v_id and sala = v_sala) then
    raise exception 'comentario_nao_encontrado' using errcode = '22023';
  end if;

  update public.replay_comentarios
     set estado = v_estado,
         -- Excluir é definitivo: o texto sai do banco, e a linha fica para a resposta da Iza não
         -- virar órfã e para o painel continuar sabendo que houve moderação.
         texto = case when v_acao = 'excluir' then '' else texto end,
         moderado_em = now(),
         moderado_por = v_por
   where (id = v_id or resposta_a = v_id)
     and sala = v_sala;

  get diagnostics v_afetadas = row_count;
  return json_build_object('id', v_id, 'estado', v_estado, 'linhas', v_afetadas);
end;
$$;

revoke all on function public.replay_comentario_publicar(jsonb) from public, anon, authenticated;
revoke all on function public.replay_comentario_responder(jsonb) from public, anon, authenticated;
revoke all on function public.replay_comentario_moderar(jsonb) from public, anon, authenticated;
grant execute on function public.replay_comentario_publicar(jsonb) to service_role;
grant execute on function public.replay_comentario_responder(jsonb) to service_role;
grant execute on function public.replay_comentario_moderar(jsonb) to service_role;

-- De novo, porque este bloco pode ser colado sozinho.
notify pgrst, 'reload schema';
