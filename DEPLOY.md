# Deploy — Pesquisa de ICP + páginas de obrigado + inscrição/checkout (Viver de Furo e Imersão GPS) + painel

Um serviço só no Railway (este repositório, com o `Dockerfile` na raiz) e um projeto no Supabase. Não há build, `npm install` nem banco para administrar no Railway: o servidor não tem dependências e todos os dados ficam no Supabase.

A página de venda da Imersão GPS é **outro** serviço (repositório `whatsapp-atendimento-centralizado`, em `https://io.escolaenfermagemdevalor.com.br`): ela só manda o formulário para o `/api/inscricao` daqui. A ordem de publicação dela está na seção 5.3.

Ordem recomendada: **banco → senha do painel → Railway → domínio → checklist**.

---

## 1. Banco: rodar o `supabase.sql`

Projeto sugerido: **"Painel - Lançamentos"** (ref `wfqnxedkuxvvcfofsmpq`), criado hoje e ainda vazio.

1. Supabase > projeto **Painel - Lançamentos** > **SQL Editor** > **New query**.
2. Cole o conteúdo **inteiro** de `supabase.sql` e clique em **Run**. Deve terminar com "Success. No rows returned".
3. Confira, na mesma tela, com uma query nova:

   ```sql
   select public.pesquisa_painel();
   ```

   Tem que voltar um JSON com tudo zerado (`"visitantes" : 0, "pessoas" : 0, ...`).

O que o arquivo cria (tudo com os prefixos `pesquisa_` e `pagina_`/`paginas_`, para não esbarrar em nada que o projeto venha a ter):

- tabelas `pesquisa_visitas`, `pesquisa_respostas` e `pagina_eventos` (visitas e cliques no grupo das páginas de obrigado), com **RLS ligado e sem políticas**;
- views `pesquisa_pessoas` (uma linha por pessoa) e `pesquisa_planilha` (uma coluna por pergunta), as duas `security_invoker`;
- tabelas `inscricoes` (uma linha por pessoa em cada página de inscrição) e `compras` (um evento da Hotmart por linha, com o **payload cru**), também com RLS ligado e sem políticas;
- funções `pesquisa_salvar`, `pesquisa_registrar_evento`, `pesquisa_painel`, `pesquisa_cruzamento`, `pesquisa_abertas`, `pesquisa_valores`, `pagina_registrar_evento`, `paginas_resumo`, `inscricao_salvar`, `hotmart_registrar_compra` e `inscricoes_resumo`, executáveis **só pela service_role**.

**Banco que já tem a pesquisa rodando (atualização das páginas de obrigado):** rode o `supabase.sql` inteiro de novo (é idempotente) **ou** só a seção "5. Páginas de obrigado" do fim do arquivo — ela é autossuficiente e termina com `notify pgrst, 'reload schema'`. Faça isso **antes** de publicar o servidor novo; sem a tabela, as páginas abrem normalmente, mas as visitas e os cliques não são contados e a aba "Páginas de obrigado" do painel responde erro. Para conferir:

```sql
select public.paginas_resumo(null, null, '{"Cuidador(a)": "cuidador"}'::jsonb);
```

Tem que voltar `{"paginas" : [{"pagina" : "cuidador", "visitas" : 0, ...}]}`.

**Banco que já tem a pesquisa rodando (atualização da página de inscrição + webhook da Hotmart):** rode o `supabase.sql` inteiro de novo **ou** só a seção **"6. Inscrições com checkout na Hotmart"** do fim do arquivo — ela é autossuficiente e termina com `notify pgrst, 'reload schema'`. Faça isso **antes** de publicar o servidor novo; sem as tabelas, a página de inscrição responde 502 ao enviar o formulário e a aba de inscrições do painel dá erro. Para conferir:

```sql
select public.inscricoes_resumo(null, null, 'viver-de-furo');
```

Tem que voltar `{"paginas" : [{"pagina" : "viver-de-furo", "inscritos" : 0, "cliques" : 0, "compras" : 0, ...}], "compras_sem_inscricao" : 0, "compras_recentes" : []}`.

**Banco que já tem as inscrições rodando (atualização da Imersão GPS: venda casada pela página do produto, `sck` da Hotmart e vendas por `sck`):** rode de novo a seção **6** (ou o arquivo inteiro) **antes** de publicar o servidor novo. Ela troca `hotmart_registrar_compra` e `inscricoes_resumo` (mesma assinatura), acrescenta as colunas `pagina_por` e `evento_em` em `compras` e completa os avisos antigos a partir do payload (logo abaixo), sem apagar nada. Por que antes: o SQL novo funciona com o servidor antigo, mas o contrário não — com a função antiga, a venda de um ingresso do GPS casaria com uma inscrição da Viver de Furo que tivesse o mesmo e-mail, e o painel novo ficaria sem as divisões por mídia e conteúdo e sem o bloco "Vendas na Hotmart" (ele esconde o que o resumo não manda). Para conferir:

```sql
select public.inscricoes_resumo(null, null, 'imersao-gps');
```

Tem que voltar `{"paginas" : [{"pagina" : "imersao-gps", "inscritos" : 0, "cliques" : 0, "compras" : 0, "receita" : 0.00, "taxa_compra" : 0, "por_origem" : [], "por_midia" : [], "por_campanha" : [], "por_conteudo" : [], "por_termo" : [], "vendas" : 0, "vendas_receita" : 0.00, "vendas_por_sck" : [], "por_dia" : []}], "compras_sem_inscricao" : 0, "compras_recentes" : []}`. Sem `por_midia`, `por_conteudo` e `vendas_por_sck` na resposta, a função antiga ainda está lá.

**Avisos da Hotmart gravados antes desta versão.** A versão anterior de `hotmart_registrar_compra` gravava em `compras.pagina` a página da **inscrição** que casou, qualquer que fosse o produto (e null quando não casava), e deixava o `sck` null. Rodar a seção 6 já resolve o principal sozinho, sem apagar nada e sem precisar de comando à mão (rodar de novo não muda nada: só preenche o que está vazio):

- cria as colunas `pagina_por` e `evento_em` em `compras`;
- completa os avisos antigos a partir do `payload` cru: o `sck` (`data.purchase.origin.sck`), o `src` (`origin.src`), a `oferta` do carrinho abandonado (`data.offer.code`) e o `evento_em` (o `creation_date`, em milissegundos ou em segundos);
- os avisos antigos ficam com `pagina_por` null, e a função nova **nunca aprende com eles** de qual página é um produto (nem com o produto `0`, dos testes da Hotmart). O aviso antigo da Imersão Viver de Furo de Orelha (produto `8519248`) que casou com uma inscrita da Viver de Furo não ensina mais que "o `8519248` é da Viver de Furo": a próxima venda desse produto entra com `pagina` null e não marca ninguém.

Confira:

```sql
select pagina, pagina_por, produto_id, produto_nome, oferta, count(*) as avisos,
       count(inscricao_id) as casados, count(sck) as com_sck, count(evento_em) as com_evento_em
from public.compras
group by 1, 2, 3, 4, 5
order by pagina_por nulls first, pagina nulls last, avisos desc;
```

As linhas com `pagina_por` vazio são os avisos antigos. `com_evento_em` tem que ser igual a `avisos` (todo aviso da Hotmart traz `creation_date`); `com_sck` só fica menor quando o aviso chegou sem `sck` (link sem UTM, carrinho abandonado). Na versão anterior só existia a Viver de Furo: entre os avisos antigos, toda linha com `pagina = 'viver-de-furo'` tem que ser do produto `2332962` ou da oferta `7j2nqptq`. Se for, acabou.

**O que ainda é à mão (opcional, uma vez).** O arquivo não mexe na `pagina` nem no `inscricao_id` dos avisos antigos, nem nas inscrições. Se a conferência mostrar aviso antigo de **outro produto** com `pagina = 'viver-de-furo'` (a Imersão Viver de Furo de Orelha, um teste com produto `0`), ele não ensina mais nada, mas:

- ainda aparece na aba da Viver de Furo: em "Compras recentes" e, se estiver aprovado, em "Vendas na Hotmart", como venda casada e com o valor do outro produto;
- a inscrita com quem ele casou pode ter ficado marcada como compradora por causa do outro produto (ou desmarcada pelo reembolso dele), com o valor e a transação dele.

De quebra, o aviso antigo do **próprio** produto da Viver de Furo que não casou com ninguém ficou com `pagina` null, fora da aba. Para deixar os avisos como a função nova teria gravado, rode (pode repetir: só pega o que ainda está no formato antigo, `pagina_por` null):

```sql
-- 1. Aviso antigo de outro produto, gravado com a página da inscrição que casou: vira produto de fora.
update public.compras
set pagina = null, inscricao_id = null
where pagina_por is null and pagina = 'viver-de-furo'
  and oferta is distinct from '7j2nqptq'
  and produto_id is distinct from '2332962';

-- 2. Aviso antigo do produto da Viver de Furo que não casou com ninguém: ganha a página.
update public.compras
set pagina = 'viver-de-furo'
where pagina_por is null and pagina is null
  and (oferta = '7j2nqptq' or produto_id = '2332962');
```

**Depois** do passo 1 (antes dele esta consulta não acha ninguém), veja quem ficou com o estado de compra de outro produto, isto é, a transação guardada na inscrição é de um aviso que não é da página dela:

```sql
select i.nome, i.email, i.comprou_em, i.compra_status, i.compra_valor, i.compra_transacao,
       c.produto_id, c.produto_nome
from public.inscricoes as i
cross join lateral (
  select c.produto_id, c.produto_nome from public.compras as c
  where c.transacao = i.compra_transacao and c.pagina is distinct from i.pagina
  limit 1
) as c;
```

Vazio = nada a fazer. Senão, o comando abaixo refaz o estado de compra **só dessas** inscritas, a partir dos avisos do produto da página delas e com a régua da função (o último evento, pela hora do evento, decide; o valor é o da última aprovação). Quem só comprou o outro produto volta a "não comprou"; quem comprou os dois fica com a data, o valor e a transação do produto da página; quem foi desmarcada pelo reembolso do outro volta a ser compradora. Ninguém mais é tocado, e o comando devolve o antes e o depois de cada uma. Rodar de novo não muda nada.

```sql
-- 3. Refaz o estado de compra de quem ficou com o de outro produto.
with alvo as (
  select i.id, i.comprou_em as comprou_em_antes, i.compra_valor as valor_antes,
         i.compra_transacao as transacao_antes,
         u.evento, u.status, u.transacao, u.aprovado_em, u.momento, a.valor, a.moeda
  from public.inscricoes as i
  -- O último evento de compra do produto da página dela: é ele que decide.
  left join lateral (
    select c.evento, c.status, c.transacao, c.aprovado_em,
           coalesce(c.evento_em, c.aprovado_em, c.pedido_em, c.recebido_em) as momento
    from public.compras as c
    where c.inscricao_id = i.id and c.pagina = i.pagina
      and c.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE', 'PURCHASE_CANCELED',
                       'PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_PROTEST')
    order by momento desc, c.recebido_em desc, c.id desc
    limit 1
  ) as u on true
  -- O valor da última aprovação (o reembolso não apaga o valor, como na função).
  left join lateral (
    select c.valor, c.moeda
    from public.compras as c
    where c.inscricao_id = i.id and c.pagina = i.pagina and c.valor is not null
      and c.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE')
    order by coalesce(c.evento_em, c.aprovado_em, c.pedido_em, c.recebido_em) desc,
             c.recebido_em desc, c.id desc
    limit 1
  ) as a on true
  where exists (select 1 from public.compras as c
                where c.transacao = i.compra_transacao and c.pagina is distinct from i.pagina)
)
update public.inscricoes as i set
  comprou_em = case when alvo.evento in ('PURCHASE_APPROVED', 'PURCHASE_COMPLETE')
                    then coalesce(alvo.aprovado_em, alvo.momento) end,
  compra_status = coalesce(alvo.status, alvo.evento),
  compra_valor = alvo.valor,
  compra_moeda = alvo.moeda,
  compra_transacao = alvo.transacao,
  compra_evento_em = alvo.momento,
  atualizado_em = now()
from alvo
where i.id = alvo.id
returning i.nome, i.email, alvo.comprou_em_antes, i.comprou_em, alvo.valor_antes, i.compra_valor,
          alvo.transacao_antes, i.compra_transacao;
```

No Supabase, tudo o que nasce no schema `public` ganha acesso automático da chave pública (anon). O arquivo revoga esse acesso em cada tabela, view e função: a chave pública do projeto não lê, não grava e não executa nada da pesquisa. Isso é testado em `tests/e2e/sql.e2e.mjs` contra um Postgres com os mesmos grants padrão do Supabase.

**Pode rodar de novo.** O arquivo é idempotente: não apaga resposta nenhuma, só recria views e funções (e, nos avisos antigos da Hotmart, preenche o que está vazio). Sempre que o `supabase.sql` mudar no repositório, rode-o inteiro outra vez **antes** de publicar o servidor novo.

---

## 2. Chaves do Supabase

Em **Project Settings > API Keys** (aba **Legacy API keys**) e **Project Settings > Data API**:

| Onde | O quê | Vai para |
| --- | --- | --- |
| Project URL | `https://wfqnxedkuxvvcfofsmpq.supabase.co` | `SUPABASE_URL` |
| aba **API Keys** > **Secret keys** (`sb_secret_...`) **ou** aba **Legacy API keys** > linha **service_role** > Reveal (`eyJ...`) | a chave secreta do projeto | `SUPABASE_SERVICE_ROLE_KEY` |

A chave secreta nova (`sb_secret_...`) não é um JWT, mas funciona do mesmo jeito: o servidor a manda em `apikey` e em `Authorization: Bearer`, e o gateway do Supabase troca por service_role. Não use a **anon** / **publishable**: com ela a pesquisa não grava e o painel entra, mas não enxerga nenhum dado (é exatamente o bloqueio do passo 1 funcionando). A service_role ignora as regras de segurança do banco: ela existe **só** nas variáveis do Railway — nunca em arquivo, commit, print ou mensagem.

---

## 3. Senha do painel

Na pasta do projeto, com Node 20 ou superior:

```bash
npm run painel:senha -- "a-senha-que-voce-quer"
```

Use pelo menos 10 caracteres. O comando imprime duas linhas prontas:

```
PAINEL_SENHA_HASH=scrypt$16384$8$1$...
PAINEL_SESSAO_SEGREDO=...
```

A senha em si não é guardada em lugar nenhum, só o hash. Guarde a senha num gerenciador de senhas e passe para a equipe por um canal privado.

---

## 4. Railway

1. **New Project > Deploy from GitHub repo** > `ontimeenfermagem-ctrl/paginas` (ou **+ New > GitHub Repo** dentro de um projeto que já exista).
2. Em **Settings** do serviço:
   - **Root Directory:** vazio.
   - **Config File Path:** `/railway.toml` (ele já diz: build pelo `Dockerfile`, healthcheck em `/health`, reinício automático em falha).
   - **Build Command** e **Start Command:** vazios.
3. Em **Variables** > **Raw Editor**, cole e preencha:

   | Variável | Valor |
   | --- | --- |
   | `SUPABASE_URL` | `https://wfqnxedkuxvvcfofsmpq.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | a service_role do passo 2 |
   | `PAINEL_EMAIL` | o e-mail de login do painel |
   | `PAINEL_SENHA_HASH` | a linha do passo 3 (cole como está, sem aspas) |
   | `PAINEL_SESSAO_SEGREDO` | a linha do passo 3 |
   | `PESQUISA_WEBHOOK_URL` | opcional: vazio = `https://n8n.tecnicadevalor.com.br/webhook/pesquisa-icp`; outro endereço troca; `off` desliga. Recebe **um** aviso `pesquisa_concluida` por pessoa, quando ela chega à tela de fim. Se o n8n estiver fora, o servidor reenvia sozinho (varredura 30 s depois de subir e a cada 10 min, até 7 dias). A varredura também manda quem respondeu todas as obrigatórias e fechou antes da tela de fim, depois de 30 min parada |
   | `PERFIL_WEBHOOK_URL` | opcional: vazio = `https://n8n.tecnicadevalor.com.br/webhook/perfil-atualizado`; outro endereço troca (pode ser o gatilho do UnniChat); `off` desliga. Recebe **um** aviso `perfil_atualizado` por pessoa, no instante em que ela escolhe a profissão na `/atualizacao-perfil`. Se o destino estiver fora, a varredura reenvia |
   | `GPS_WEBHOOK_URL` | opcional: vazio = `https://n8n.tecnicadevalor.com.br/webhook/gps-outubro`; outro endereço troca; `off` desliga. Recebe **um** aviso `inscricao` por pessoa inscrita na página da Imersão GPS (contato, as 5 UTMs, sck, rastreio e o link do checkout). Se o n8n estiver fora, a varredura reenvia (marca em `inscricoes.webhook_enviado_em`) |
   | `SITE_URL` | opcional, recomendado assim que o domínio existir (ex.: `https://pesquisa.seudominio.com.br`): fixa o endereço do `og:url`, do `canonical` e da imagem da prévia do WhatsApp. Sem ele, o servidor usa o endereço pelo qual a página foi pedida (cabeçalho `X-Forwarded-Host`/`Host`, validado), então a prévia já sai com imagem no domínio do Railway |
   | `HOTMART_HOTTOK` | o *Hottok* da Hotmart (Ferramentas > Webhook/Postback > aba **Autenticação**). Sem ele **e** sem `HOTMART_WEBHOOK_CHAVE`, `POST /api/hotmart/venda` responde 503 |
   | `HOTMART_WEBHOOK_CHAVE` | um segredo **nosso**, que vai na URL do webhook (`?chave=...`). Gere com `node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"` |
   | `HOTMART_WEBHOOK_CHAVE_2` | opcional: uma segunda chave, para um produto separado. As duas valem no mesmo endereço (cada uma com o seu `?chave=`), e assim dá para trocar ou desligar o aviso de um produto sem mexer no do outro |
   | `META_PIXEL_ID` | opcional: vazio = `538380380948773` (pixel da Enfermagem de Valor); `off` desliga |
   | `INSCRICAO_ORIGENS` | opcional: sites de **fora** que também podem mandar o formulário para o `POST /api/inscricao` (CORS), separados por vírgula, com `https://` e sem barra no fim — por exemplo o preview do Railway da página de venda ou `http://localhost:3001` para testar na sua máquina. A de produção (`https://io.escolaenfermagemdevalor.com.br`) **já vem** do `js/checkout-config.js` e não precisa estar aqui. Vazio = só as do config |

   `PORT` não precisa: o Railway define sozinho.
4. **Deploy**. No log deve aparecer `Servidor iniciado na porta ...`. Cada linha começando com `Aviso:` é uma variável que ficou faltando (o log nunca mostra o valor de um segredo).

---

## 5. Domínio

O domínio ainda não foi decidido, e nada no código depende dele. Abaixo, `SEU-DOMINIO` é o que for escolhido (por exemplo `pesquisa.escolaenfermagemdevalor.com.br`).

1. Railway > serviço > **Settings > Networking > Custom Domain** > digite `SEU-DOMINIO`.
2. O Railway mostra um registro **CNAME** (e às vezes um TXT de verificação). Crie esses registros no provedor de DNS do domínio `escolaenfermagemdevalor.com.br`, exatamente como aparecem. Se o DNS estiver na Cloudflare, deixe o registro **sem proxy** (nuvem cinza) — com o proxy ligado, o limite de tentativas por IP passa a enxergar o IP da Cloudflare.
3. Espere o selo verde e o certificado HTTPS no Railway (costuma levar de minutos a uma hora).

4. Cadastre `SITE_URL=https://SEU-DOMINIO` nas variáveis do Railway: sem ele a prévia do WhatsApp já funciona (usa o endereço da requisição), mas com ele o `canonical` aponta sempre para o domínio oficial, mesmo quando alguém abre pelo endereço `*.up.railway.app`.

As páginas de obrigado ficam em `https://SEU-DOMINIO/obrigado-afericao`, `/obrigado-cuidador` e `/obrigado-evento-outubro` (a pesquisa leva cada pessoa para a do perfil dela, com as UTMs).

A pesquisa mora em `https://SEU-DOMINIO/pesquisa-icp`. A raiz `https://SEU-DOMINIO/` redireciona para ela mantendo as UTMs, e o endereço antigo `/pesquisa` também (301). Nos anúncios e no link da bio, use UTMs, por exemplo:

```
https://SEU-DOMINIO/pesquisa-icp?utm_source=instagram&utm_medium=bio&utm_campaign=pesquisa-icp
```

O painel fica em `https://SEU-DOMINIO/painel`.

---

## 5.1 Links dos grupos de WhatsApp

Os convites dos três grupos ficam em `js/obrigado-config.js`, no objeto `LINKS_GRUPOS` (`afericao`, `cuidador`, `evento_outubro`). Cole cada convite (`https://chat.whatsapp.com/...`), rode `npm test`, faça commit e deploy — não há variável de ambiente nem SQL para isso. Enquanto um link estiver vazio, a página correspondente avisa que o link chega pelo WhatsApp (sem botão quebrado) e o painel mostra "Link do grupo ainda não configurado" no cartão dela.

---

## 5.2 Webhook de venda da Hotmart

A página `/viver-de-furo-inscricao` (e a página de venda da Imersão GPS, do outro site) grava a inscrição e manda a pessoa para o checkout; quem diz que a venda aconteceu é a Hotmart, no webhook. **Nada disso passa pelo n8n.** Um endereço só recebe os avisos de todas as páginas: cada aviso é atribuído à página do **produto** (oferta ou id do produto em `js/checkout-config.js`) e só casa com inscrição dessa página; venda de produto que não é de página nenhuma (a Formação vendida no fim da imersão, um order bump) é gravada e não marca ninguém (o porquê está em "De qual página é cada venda", no `README.md`).

**O endereço para colar na Hotmart:**

```
https://SEU-DOMINIO/api/hotmart/venda?chave=O-VALOR-DE-HOTMART_WEBHOOK_CHAVE
```

(em produção hoje: `https://lp.escolaenfermagemdevalor.com.br/api/hotmart/venda?chave=...`)

Para um **produto separado**, dá para usar um endereço próprio: cadastre a segunda chave como `HOTMART_WEBHOOK_CHAVE_2` e cole `...?chave=O-VALOR-DE-HOTMART_WEBHOOK_CHAVE_2` no webhook daquele produto. O endpoint é o mesmo e as duas chaves valem ao mesmo tempo; ter uma por produto serve para saber de onde veio cada aviso e para poder trocar (ou desligar) um sem derrubar o outro. Quem separa os números no painel continua sendo o **produto** do aviso, não a chave.

1. Gere a chave e cadastre-a no Railway como `HOTMART_WEBHOOK_CHAVE` (veja o passo 4). Ela existe para o endereço funcionar **no minuto em que for colado**, antes de o hottok estar configurado.
2. Hotmart > **Ferramentas > Webhook (Postback)** > **Cadastrar webhook**: cole o endereço acima, escolha a **versão 2.0** e marque os eventos de compra — no mínimo **Compra aprovada**, **Compra completa**, **Compra cancelada**, **Reembolso**, **Chargeback** (e **Disputa**, que também desmarca). Boleto gerado e carrinho abandonado também podem ser marcados: eles são gravados, mas não marcam ninguém como comprador. Se o webhook foi cadastrado **por produto** (e não para todos), o produto de cada página precisa estar na lista: hoje o Furo de orelha humanizado (Viver de Furo) **e a Imersão GPS do Plantão Sem Medo** — sem ele, as vendas dos ingressos não chegam aqui.
3. Na aba **Autenticação** da mesma tela, copie o **Hottok** e cadastre-o no Railway como `HOTMART_HOTTOK`. A partir daí, o aviso é aceito tanto pelo header `X-HOTMART-HOTTOK` quanto pela `?chave=` — basta **uma** das duas bater.

**Como testar sem esperar uma venda de verdade** (troque o endereço e a chave). O corpo segue o formato **real** dos avisos da Hotmart (Webhook 2.0.0, conferido nos avisos gravados em `compras.payload`): `data.product.id` é o id **numérico** do produto (`2332962`, e não o código `Y74893363S` do link), a oferta vem em `data.purchase.offer.code` e o `sck` em `data.purchase.origin.sck`:

```bash
curl -i -X POST "https://SEU-DOMINIO/api/hotmart/venda?chave=SUA-CHAVE" \
  -H 'Content-Type: application/json' \
  -d '{"id":"teste-1","event":"PURCHASE_APPROVED","version":"2.0.0","creation_date":1758600000000,
       "data":{"product":{"id":2332962,"name":"Furo de orelha humanizado"},
               "buyer":{"name":"Maria da Silva","email":"maria@gmail.com","checkout_phone_code":"55","checkout_phone":"11912345678"},
               "purchase":{"transaction":"HP-TESTE-1","status":"APPROVED","order_date":1758600000000,"approved_date":1758600060000,
                           "price":{"value":197,"currency_value":"BRL"},"offer":{"code":"7j2nqptq"},
                           "origin":{"sck":"criativo-07"}}}}'
```

- Resposta esperada: `200 {"ok":true}`.
- Chave errada: `401`. Nenhuma das duas variáveis cadastradas: `503`. `GET` no endereço: `405`.
- Mandar **o mesmo corpo de novo** não duplica nada (a chave é `transacao` + `evento`) — é o que faz o reenvio da Hotmart ser seguro.
- No banco, o aviso entra com `pagina = 'viver-de-furo'` e `pagina_por = 'config'` (pela oferta `7j2nqptq`), `sck = 'criativo-07'` e `evento_em` = o `creation_date` (23/09/2025 01:00, horário de Brasília). Trocando a oferta e o produto por outros (`"offer":{"code":"outra"}`, `"id":9999999`), ele entra com `pagina` null e não casa com ninguém: é o "produto de fora".
- Confira no painel, aba da Viver de Furo: a compra aparece em "Compras recentes". Se o e-mail/telefone do teste não existir como inscrito **dessa página**, ela aparece marcada como **"sem inscrição"** — é exatamente o aviso que o cliente precisa ver.
- Para apagar o teste do banco: `delete from public.compras where transacao = 'HP-TESTE-1';` (e, se ele tiver casado com alguém, `update public.inscricoes set comprou_em = null, compra_status = null, compra_valor = null, compra_moeda = null, compra_transacao = null, compra_evento_em = null where compra_transacao = 'HP-TESTE-1';`). Apague sempre: um aviso com página ensina ao banco de qual página é aquele produto (passo 3 do casamento).

---

## 5.3 Imersão GPS (página de venda em outro site)

A página de venda mora no repositório `whatsapp-atendimento-centralizado` (Express no Railway, `https://io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso`). O que fica **aqui** é a gravação do lead e das UTMs (`POST /api/inscricao`, com CORS para aquele site), o webhook das vendas e a aba do painel. Em `js/checkout-config.js` ela é a página `imersao-gps`: `sck` = `utm_content`, e-mail só `.com`/`.com.br`, checkout `https://pay.hotmart.com/R107667362D?off=l0r77by6&checkoutMode=10`.

**Ordem de publicação** (cada passo funciona com o anterior já no ar, e não o contrário):

1. **Banco:** rode de novo a seção 6 do `supabase.sql` no Supabase e confira com `select public.inscricoes_resumo(null, null, 'imersao-gps');` (o JSON esperado está na seção 1). Na primeira vez, rode também a conferência de "Avisos da Hotmart gravados antes desta versão", logo abaixo dele: o arquivo já completa os avisos antigos sozinho, e a correção à mão de lá só é preciso se a conferência mostrar aviso antigo de outro produto na Viver de Furo.
2. **Este servidor (paginas):** publique. Confira o CORS de fora:

   ```bash
   curl -si -X OPTIONS https://lp.escolaenfermagemdevalor.com.br/api/inscricao \
     -H 'Origin: https://io.escolaenfermagemdevalor.com.br' -H 'Access-Control-Request-Method: POST'
   ```

   Tem que voltar `204` com `access-control-allow-origin: https://io.escolaenfermagemdevalor.com.br`. Com outro `Origin`, `403`.
3. **A página de venda (repositório `whatsapp-atendimento-centralizado`):** publique por último. Antes do passo 2, o `/api/inscricao` daqui ainda não aceita o formulário vindo de lá (o navegador bloqueia pelo CORS): a página ainda abre o checkout sozinha, com as UTMs e o `sck` (é o plano B dela quando a API falha ou demora mais de 3,5 s), mas o lead não é gravado.

**Na Hotmart:**

- O webhook `/api/hotmart/venda` (seção 5.2) precisa receber também o produto da Imersão GPS: se ele foi cadastrado por produto, inclua o da Imersão GPS do Plantão Sem Medo, com os mesmos eventos mínimos (aprovada, completa, cancelada, reembolso, chargeback).
- Depois da **primeira venda**, pegue o id numérico do produto e cole em `hotmart.produtos` da `imersao-gps` no `js/checkout-config.js` (e na cópia da página de venda). É opcional — a oferta `l0r77by6` já basta —, mas com o id uma venda por outra oferta do mesmo produto (lote novo, link de afiliado) é reconhecida mesmo sem ninguém ter passado pelo formulário:

  ```sql
  select distinct produto_id, produto_nome from public.compras where oferta = 'l0r77by6';
  ```

- **Troca de lote:** troque o link (`off=` novo, mesmo `R107667362D`) nos botões da página de venda e publique **só ela**. O servidor aceita a oferta nova do botão (mesmo produto) e o aviso de venda com ela é reconhecido pelos links que as inscrições abriram. Para não depender disso, acrescente a oferta nova em `hotmart.ofertas` no `js/checkout-config.js` e publique aqui também.

**Checklist do GPS** (pelo celular, como o da seção 6):

- [ ] Abrir `https://io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso?utm_source=teste&utm_medium=cpc&utm_campaign=deploy&utm_term=publico&utm_content=criativo-07`, tocar num botão de compra: abre o pré-formulário "Falta pouco, preciosa!" (nome completo, WhatsApp com DDD com a máscara `(11) 91234-5678`, e-mail) no lugar do checkout.
- [ ] E-mail `maria@hospital.org.br` é recusado com "Use um e-mail que termine em .com ou .com.br."; `maria@gmail.con` ganha a sugestão de correção; WhatsApp sem DDD e nome sem sobrenome são recusados.
- [ ] Preencher com um contato seu e enviar: o checkout da Hotmart abre **com nome, e-mail e telefone preenchidos** e a URL dele tem `off=l0r77by6`, `checkoutMode=10`, as 5 UTMs (`utm_source=teste`, `utm_medium=cpc`, `utm_campaign=deploy`, `utm_term=publico`, `utm_content=criativo-07`) e **`sck=criativo-07`** (o `utm_content`, e não o `utm_term`).
- [ ] No Supabase, `select pagina, email, utm_content, checkout_url from public.inscricoes where pagina = 'imersao-gps' order by criado_em desc limit 5;` mostra a inscrição com o `checkout_url` exato que abriu.
- [ ] O webhook, no formato real, com a oferta do GPS (troque o endereço, a chave e o e-mail pelo que você usou no formulário):

  ```bash
  curl -i -X POST "https://lp.escolaenfermagemdevalor.com.br/api/hotmart/venda?chave=SUA-CHAVE" \
    -H 'Content-Type: application/json' \
    -d '{"id":"teste-gps-1","event":"PURCHASE_APPROVED","version":"2.0.0","creation_date":1790000000000,
         "data":{"product":{"id":1,"name":"Imersão GPS do Plantão Sem Medo"},
                 "buyer":{"name":"Maria da Silva","email":"SEU-EMAIL@gmail.com","checkout_phone_code":"55","checkout_phone":"11912345678"},
                 "purchase":{"transaction":"HP-TESTE-GPS-1","status":"APPROVED","order_date":1790000000000,"approved_date":1790000060000,
                             "price":{"value":5,"currency_value":"BRL"},"offer":{"code":"l0r77by6"},
                             "origin":{"sck":"criativo-07"}}}}'
  ```

  Responde `200 {"ok":true}`; a compra é reconhecida pela oferta (o `"id":1` é de mentira — não use `0`, que é o produto dos testes da própria Hotmart) e casa com a sua inscrição do GPS pelo e-mail.
- [ ] Painel > aba **Imersão GPS — ingressos** (rota `io.escolaenfermagemdevalor.com.br/igps_set_lp_26-ingresso`, "sck = utm_content"): 1 inscrito, 1 clique no checkout, 1 compra de inscrito; em "Inscritos por UTM e por dia", "Por conteúdo (sck)" com `criativo-07`; o bloco "Vendas na Hotmart" com 1 venda e, na tabela por `sck`, `criativo-07` = 1 venda, 1 com inscrição; "Compras recentes" com o aviso casado e "sck criativo-07". A aba da Viver de Furo não mostra essa compra.
- [ ] Apague os testes: `delete from public.compras where transacao = 'HP-TESTE-GPS-1';`, `delete from public.inscricoes where pagina = 'imersao-gps' and email = 'SEU-EMAIL@gmail.com';`.

---

## 5.4 UnniChat — atualização de perfil pelo WhatsApp

O caminho curto para descobrir a profissão de quem já está na base, sem pedir a pesquisa inteira. São três peças, todas já no ar:

| Peça | O que é |
|---|---|
| `https://SEU-DOMINIO/atualizacao-perfil` | a página curta: contato e profissão, duas telas, ~40 segundos |
| `GET https://SEU-DOMINIO/api/leads/perfil?telefone=...` | a consulta do UnniChat: devolve a profissão em código interno |
| `UNNICHAT_API_KEY` | a chave que o UnniChat manda no header `X-API-Key` (variável do Railway) |

**O link que vai na mensagem**, com o contato que o UnniChat já tem — a pessoa chega com os campos prontos e só confere:

```
https://SEU-DOMINIO/atualizacao-perfil?nome={{nome_do_contato}}&telefone={{telefone_do_contato}}&utm_source=unnichat&utm_medium=whatsapp&utm_campaign=atualizar-perfil
```

O link só **preenche** (nada é gravado por abrir a página): a pessoa ainda aperta CONTINUAR e escolhe a profissão. `?email=` também é aceito. Campo que ela já tinha corrigido aqui antes ganha do link, e telefone que não vira WhatsApp brasileiro (variável não substituída, número de fora) é ignorado em vez de entrar torto. As UTMs seguem para a página de obrigado e aparecem no painel, aba **Perfis atualizados**.

**A consulta**, no nó de requisição HTTP: método `GET`, header `X-API-Key: <UNNICHAT_API_KEY>`, e a resposta

```json
{ "success": true, "responded": true, "phone": "5545999999999", "profession": "tecnico_enfermagem" }
```

`profession` é sempre um destes quatro: `auxiliar_atendente`, `cuidador`, `tecnico_enfermagem`, `enfermeiro`. E os três estados que o fluxo precisa distinguir:

| Situação | HTTP | Como reconhecer |
|---|---|---|
| já disse a profissão | 200 | `responded: true` e `profession` preenchido |
| está na base, sem profissão ainda | 200 | `responded: false`, `profession: null` |
| não conhecemos esse telefone | 404 | cai na saída de **falha** do nó |

Para o fluxo, **falha e `responded: false` são a mesma decisão**: ainda não sabemos quem é, então manda (ou remanda) o convite.

**O aviso de quem acabou de responder.** Quando a pessoa escolhe a profissão, o servidor manda na hora um `POST` para `PERFIL_WEBHOOK_URL` (padrão: o n8n em `/webhook/perfil-atualizado`; pode apontar direto para o gatilho do UnniChat). É ele que inicia a sequência — ninguém precisa ficar perguntando "já respondeu?".

```json
{
  "evento": "perfil_atualizado",
  "origem": "atualizacao-perfil",
  "lead": {
    "nome": "Maria da Silva",
    "primeiro_nome": "Maria",
    "whatsapp": "(11) 91234-5678",
    "whatsapp_digits": "11912345678",
    "whatsapp_internacional": "5511912345678",
    "email": "maria@gmail.com"
  },
  "perfil": "Cuidador(a)",
  "perfil_codigo": "cuidador",
  "segmento": "PERFIL_CUIDADOR",
  "pagina_obrigado": { "id": "cuidador", "rota": "/obrigado-cuidador", "nome": "...", "grupo": "..." },
  "utm": { "utm_source": "unnichat", "utm_medium": "whatsapp", "utm_campaign": "atualizar-perfil", "utm_content": null, "utm_term": null },
  "rastreio": { "fbclid": null, "gclid": null, "page_url": "...", "referrer": null, "dispositivo": "mobile" },
  "lead_id": "...", "atualizado_em": "...", "enviado_em": "..."
}
```

Um aviso por pessoa (a segunda vez que a mesma linha fecha não dispara de novo). Três tentativas na hora; o que não for entregue fica marcado como pendente e a varredura reenvia por até 7 dias — então, se o destino ainda não existir quando alguém responder, o aviso **chega assim que ele for criado**.

**Os dois fluxos, na ordem que funciona:**

*Fluxo 1 — o disparo:*

1. **Broadcast** com a lista.
2. **Requisição HTTP** (a consulta acima) — *antes* do template. Quem já respondeu sai do fluxo aqui, e o disparo não incomoda quem já está mapeado.
3. **Envio de template** com os dois botões ("Atualizar perfil" / "Agora não").
4. Botão **Atualizar perfil** → **Envio de mensagem** com o link de cima. O fluxo 1 acaba aqui.
5. Botão **Agora não** → mensagem curta e fim.

*Fluxo 2 — quem acabou de responder* (gatilho: o `perfil_atualizado` acima, direto ou passando pelo n8n):

1. **Gatilho** com o telefone (`lead.whatsapp_internacional`) e, se o gatilho aceitar variáveis, o `perfil_codigo` e o `lead.primeiro_nome` já vêm junto.
2. Se o gatilho não carregar variáveis: **uma Requisição HTTP** na consulta acima — aqui ela sempre responde `responded: true`, porque a pessoa acabou de gravar.
3. **Condição** por `perfil_codigo` → a sequência de cada profissão.

Aqui **não precisa de template**: quem clicou no botão do template abriu a janela de 24 horas (o clique conta como mensagem da pessoa), e a resposta chega minutos depois. Mensagem livre resolve, com o nome na variável.

---

## 6. Checklist depois do deploy

Faça pelo celular, de preferência abrindo o link de dentro do Instagram ou do WhatsApp (é onde o público vai estar).

- [ ] `https://SEU-DOMINIO/health` responde `{"ok":true}`.
- [ ] Abrir `https://SEU-DOMINIO/?utm_source=teste&utm_campaign=deploy`: vai para `/pesquisa-icp` e a URL mantém as UTMs. Logo, foto da Iza e botão "Começar" aparecem.
- [ ] O link colado no WhatsApp mostra a prévia com imagem e título.
- [ ] Contato: WhatsApp sem DDD, e-mail `maria@gmial.com` e nome com número são recusados com mensagem clara; o e-mail com erro de digitação sugere a correção.
- [ ] Abrir `https://SEU-DOMINIO/viver-de-furo-inscricao?utm_source=teste&utm_term=criativo-07`, preencher e enviar: o checkout da Hotmart abre **com nome, e-mail e telefone preenchidos** e a URL dele tem `off=7j2nqptq`, `checkoutMode=10`, `utm_source=teste`, `utm_term=criativo-07` e `sck=criativo-07`.
- [ ] Enviar o formulário de novo com o mesmo contato: no painel, a pessoa continua **uma** inscrita e os "cliques no checkout" sobem para 2.
- [ ] O `curl` de teste do webhook (seção 5.2) responde `200 {"ok":true}` e a compra aparece na aba da Viver de Furo do painel.
- [ ] Imersão GPS (página de venda no outro site): checklist próprio na seção 5.3.
- [ ] Contato válido (use um número seu) → a pesquisa começa. Responda 3 ou 4 perguntas e **feche a página**.
- [ ] No Supabase > Table Editor > `pesquisa_respostas`: a linha está lá, com nome, WhatsApp formatado `(xx) xxxxx-xxxx`, e-mail, as respostas dadas e `utm_source = teste`. Em `pesquisa_visitas`, o visitante com `comecou_em` preenchido.
- [ ] Reabrir o link no mesmo celular: aparece "Que bom te ver de novo" e "Continuar de onde parei" volta para a pergunta certa.
- [ ] Painel: login com e-mail e senha; senha errada é recusada. O placar mostra 1 acesso, 1 começou, 1 se identificou; a lista de pessoas mostra "Parou na pergunta N". O filtro de período "Hoje" traz a resposta.
- [ ] Termine a pesquisa: você é levado para a página de obrigado do seu perfil (ex.: Cuidador(a) → `/obrigado-cuidador?utm_source=teste&utm_campaign=deploy`, com as UTMs), que mostra só o grupo daquele perfil. No painel, "Responderam tudo" = 1 e o selo "Respondeu tudo" na lista; no "Ver tudo", "Página de obrigado".
- [ ] Clique no botão do grupo. Painel > aba **Páginas de obrigado**: no cartão da sua página, "Pesquisas concluídas atribuídas" = 1, "Chegaram à página" = 1 e "Clicaram no grupo" = 1 (as outras duas páginas zeradas). Cartão com link vazio mostra "Link do grupo ainda não configurado".
- [ ] `https://SEU-DOMINIO/obrigado-x` e `https://SEU-DOMINIO/obrigado.html` respondem 404.
- [ ] **Baixar CSV** abre no Excel/Planilhas com acentos certos, uma coluna por pergunta.
- [ ] n8n: chegou **um** aviso `pesquisa_concluida` (só no fim, nada no meio), com o lead, as UTMs, todas as perguntas do caminho, `perfil_codigo`, `segmento` e `pagina_obrigado`. No painel, o "Ver tudo" da pessoa mostra "Enviado ao n8n em ..." (e o CSV, a coluna `enviado_n8n_em`).
- [ ] Pixel: no Gerenciador de Eventos da Meta (Testar eventos), aparecem `PageView`, `Lead` e `PesquisaConcluida` da página `/pesquisa-icp`.
- [ ] A chave pública não lê nada. Troque `ANON` pela chave anon (ela é pública mesmo) e rode:

  ```bash
  curl -s "https://wfqnxedkuxvvcfofsmpq.supabase.co/rest/v1/pesquisa_pessoas?select=nome" \
    -H "apikey: ANON" -H "Authorization: Bearer ANON"
  ```

  Tem que responder erro de permissão (`permission denied` / 401), **nunca** uma lista. O mesmo com `pagina_eventos?select=pagina` no lugar de `pesquisa_pessoas?select=nome`.

Depois do teste, apague os dados de teste no SQL Editor, para não sujar os números do lançamento (troque pelo WhatsApp que você usou, só os dígitos):

```sql
delete from public.pesquisa_respostas where whatsapp_digits = '11999999999';
delete from public.pesquisa_visitas where utm_source = 'teste';
delete from public.pagina_eventos where utm_source = 'teste';
```

---

## 7. Ler os dados direto no Supabase

O painel e o CSV cobrem o dia a dia. Para análises livres, a view **`pesquisa_planilha`** tem uma linha por pessoa (a tentativa mais completa dela) e **uma coluna por pergunta**, com os mesmos ids de `js/pesquisa-config.js`. Múltipla escolha vem como lista (`text[]`), a escala de 0 a 10 como número e o resto como texto. Pergunta que não se aplica ao perfil da pessoa fica vazia.

No **SQL Editor** (o botão **Export** do resultado baixa em CSV):

```sql
-- Todo mundo, mais recentes primeiro
select * from public.pesquisa_planilha order by criado_em desc;

-- Só quem respondeu tudo
select nome, whatsapp, email, perfil, idade, estado, renda_atual, objetivo_12m
from public.pesquisa_planilha
where status = 'concluida';

-- Quantas pessoas por perfil, e quantas terminaram
select perfil, count(*) as pessoas, count(*) filter (where status = 'concluida') as concluiram
from public.pesquisa_planilha
group by perfil order by pessoas desc;

-- Uma pergunta de múltipla escolha, contando cada alternativa marcada
select objecao, count(*) as pessoas
from public.pesquisa_planilha, unnest(objecoes) as objecao
group by objecao order by pessoas desc;

-- Média de segurança profissional (0 a 10) por perfil
select perfil, round(avg(seguranca), 1) as media, count(seguranca) as responderam
from public.pesquisa_planilha
group by perfil;

-- As respostas abertas
select nome, perfil, problema_unico, sonho, frase_desejo, frase_bloqueio
from public.pesquisa_planilha
where coalesce(problema_unico, sonho, frase_desejo, frase_bloqueio) is not null
order by criado_em desc;
```

Outras fontes, se precisar:

- `pesquisa_pessoas`: igual à planilha, mas com as respostas num campo `respostas` (JSON) e todos os campos técnicos (tempos por pergunta, posição máxima, etc.).
- `pesquisa_respostas`: **todas** as tentativas, inclusive as repetidas da mesma pessoa.
- `pesquisa_visitas`: quem abriu a página, com origem e se clicou em "Começar".
- `pagina_eventos`: cada visita e cada clique no grupo das páginas de obrigado (`pagina`, `evento`, `perfil`, origem). Ex.: `select pagina, perfil, count(*) filter (where evento = 'clique_grupo') as cliques from public.pagina_eventos group by 1, 2;`

Datas ficam gravadas em UTC. Para ver no horário de Brasília: `criado_em at time zone 'America/Sao_Paulo'`.

---

## Operação

- **Trocar a senha do painel:** gere de novo (passo 3) e atualize **os dois**, `PAINEL_SENHA_HASH` e
  `PAINEL_SESSAO_SEGREDO`, no Railway. Trocar só o hash não derruba quem já está logado: a sessão
  aberta (inclusive num aparelho perdido) continua valendo por até 8 h. Trocar o segredo derruba
  todas na hora. "Sair" no painel apaga o cookie daquele aparelho, mas não invalida o token.
- **Derrubar todas as sessões abertas** (perdeu um celular logado, por exemplo): troque `PAINEL_SESSAO_SEGREDO`.
- **Mudar uma pergunta:** veja "Mudar uma pergunta" no `README.md` (é só `js/pesquisa-config.js` + subir a `VERSAO`).
- **Trocar link de grupo, texto ou rota de uma página de obrigado:** só `js/obrigado-config.js` (seção 5.1).
- **Trocar o lote da Imersão GPS:** o link novo vai nos botões da página de venda (outro repositório); aqui, opcionalmente, a oferta nova em `hotmart.ofertas` (seção 5.3).
- **Mudou `js/checkout-config.js` ou `js/lead-rules.js`:** a página de venda da Imersão GPS leva uma cópia dos dois — copie para lá e publique as duas.
- **Testar a página de venda num preview ou na sua máquina:** cadastre o endereço dela em `INSCRICAO_ORIGENS` do servidor que vai receber o formulário (passo 4); sem isso o navegador bloqueia o envio pelo CORS. O endereço da API fica no `data-api` do formulário da página (`#pf-form`, hoje `https://lp.escolaenfermagemdevalor.com.br/api/inscricao`): para testar contra um servidor daqui na sua máquina, troque-o só na cópia local. Preview apontando para o servidor de produção grava no banco de verdade: apague os testes depois.
- **Formulário da Imersão GPS com erro de CORS no console do navegador:** confira se a página está sendo aberta pelo endereço oficial (`https://io.escolaenfermagemdevalor.com.br`, sem `www`) ou por um endereço cadastrado em `INSCRICAO_ORIGENS`, e se o servidor daqui já é a versão com o CORS (o `curl -X OPTIONS` da seção 5.3 responde `204`).
- **A pesquisa responde erro ao gravar / painel com erro 502:** confira se o `supabase.sql` foi rodado no projeto certo e se a chave é a service_role. Se o log do Railway falar em função não encontrada logo depois de rodar o SQL, rode no SQL Editor `notify pgrst, 'reload schema';`.
- **Painel responde 503:** falta alguma das variáveis `SUPABASE_*` ou `PAINEL_*` (o log do deploy lista qual, com `Aviso:`).
