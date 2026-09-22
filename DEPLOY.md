# Deploy — Pesquisa de ICP + painel

Um serviço só no Railway (este repositório, com o `Dockerfile` na raiz) e um projeto no Supabase. Não há build, `npm install` nem banco para administrar no Railway: o servidor não tem dependências e todos os dados ficam no Supabase.

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

O que o arquivo cria (tudo com o prefixo `pesquisa_`, para não esbarrar em nada que o projeto venha a ter):

- tabelas `pesquisa_visitas` e `pesquisa_respostas`, com **RLS ligado e sem políticas**;
- views `pesquisa_pessoas` (uma linha por pessoa) e `pesquisa_planilha` (uma coluna por pergunta), as duas `security_invoker`;
- funções `pesquisa_salvar`, `pesquisa_registrar_evento`, `pesquisa_painel`, `pesquisa_cruzamento`, `pesquisa_abertas` e `pesquisa_valores`, executáveis **só pela service_role**.

No Supabase, tudo o que nasce no schema `public` ganha acesso automático da chave pública (anon). O arquivo revoga esse acesso em cada tabela, view e função: a chave pública do projeto não lê, não grava e não executa nada da pesquisa. Isso é testado em `tests/e2e/sql.e2e.mjs` contra um Postgres com os mesmos grants padrão do Supabase.

**Pode rodar de novo.** O arquivo é idempotente: não apaga resposta nenhuma, só recria views e funções. Sempre que o `supabase.sql` mudar no repositório, rode-o inteiro outra vez **antes** de publicar o servidor novo.

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
   | `PESQUISA_WEBHOOK_URL` | opcional: vazio = `https://n8n.tecnicadevalor.com.br/webhook/pesquisa-icp`; outro endereço troca; `off` desliga. Recebe **um** aviso `pesquisa_concluida` por pessoa, quando ela chega à tela de fim |
   | `SITE_URL` | opcional, mas recomendado assim que o domínio existir (ex.: `https://pesquisa.seudominio.com.br`): a prévia do link no WhatsApp ganha imagem com endereço absoluto, `og:url` e `canonical` |
   | `META_PIXEL_ID` | opcional: vazio = `538380380948773` (pixel da Enfermagem de Valor); `off` desliga |

   `PORT` não precisa: o Railway define sozinho.
4. **Deploy**. No log deve aparecer `Servidor iniciado na porta ...`. Cada linha começando com `Aviso:` é uma variável que ficou faltando (o log nunca mostra o valor de um segredo).

---

## 5. Domínio

O domínio ainda não foi decidido, e nada no código depende dele. Abaixo, `SEU-DOMINIO` é o que for escolhido (por exemplo `pesquisa.escolaenfermagemdevalor.com.br`).

1. Railway > serviço > **Settings > Networking > Custom Domain** > digite `SEU-DOMINIO`.
2. O Railway mostra um registro **CNAME** (e às vezes um TXT de verificação). Crie esses registros no provedor de DNS do domínio `escolaenfermagemdevalor.com.br`, exatamente como aparecem. Se o DNS estiver na Cloudflare, deixe o registro **sem proxy** (nuvem cinza) — com o proxy ligado, o limite de tentativas por IP passa a enxergar o IP da Cloudflare.
3. Espere o selo verde e o certificado HTTPS no Railway (costuma levar de minutos a uma hora).

4. Cadastre `SITE_URL=https://SEU-DOMINIO` nas variáveis do Railway (a prévia do WhatsApp precisa da imagem com endereço completo).

A pesquisa mora em `https://SEU-DOMINIO/pesquisa-icp`. A raiz `https://SEU-DOMINIO/` redireciona para ela mantendo as UTMs, e o endereço antigo `/pesquisa` também (301). Nos anúncios e no link da bio, use UTMs, por exemplo:

```
https://SEU-DOMINIO/pesquisa-icp?utm_source=instagram&utm_medium=bio&utm_campaign=pesquisa-icp
```

O painel fica em `https://SEU-DOMINIO/painel`.

---

## 6. Checklist depois do deploy

Faça pelo celular, de preferência abrindo o link de dentro do Instagram ou do WhatsApp (é onde o público vai estar).

- [ ] `https://SEU-DOMINIO/health` responde `{"ok":true}`.
- [ ] Abrir `https://SEU-DOMINIO/?utm_source=teste&utm_campaign=deploy`: vai para `/pesquisa-icp` e a URL mantém as UTMs. Logo, foto da Iza e botão "Começar" aparecem.
- [ ] O link colado no WhatsApp mostra a prévia com imagem e título.
- [ ] Contato: WhatsApp sem DDD, e-mail `maria@gmial.com` e nome com número são recusados com mensagem clara; o e-mail com erro de digitação sugere a correção.
- [ ] Contato válido (use um número seu) → a pesquisa começa. Responda 3 ou 4 perguntas e **feche a página**.
- [ ] No Supabase > Table Editor > `pesquisa_respostas`: a linha está lá, com nome, WhatsApp formatado `(xx) xxxxx-xxxx`, e-mail, as respostas dadas e `utm_source = teste`. Em `pesquisa_visitas`, o visitante com `comecou_em` preenchido.
- [ ] Reabrir o link no mesmo celular: aparece "Que bom te ver de novo" e "Continuar de onde parei" volta para a pergunta certa.
- [ ] Painel: login com e-mail e senha; senha errada é recusada. O placar mostra 1 acesso, 1 começou, 1 se identificou; a lista de pessoas mostra "Parou na pergunta N". O filtro de período "Hoje" traz a resposta.
- [ ] Termine a pesquisa: tela de obrigado; no painel, "Responderam tudo" = 1 e o selo "Respondeu tudo" na lista.
- [ ] **Baixar CSV** abre no Excel/Planilhas com acentos certos, uma coluna por pergunta.
- [ ] n8n: chegou **um** aviso `pesquisa_concluida` (só no fim, nada no meio), com o lead, as UTMs e todas as perguntas do caminho. No painel, o "Ver tudo" da pessoa mostra "Enviado ao n8n em ..." (e o CSV, a coluna `enviado_n8n_em`).
- [ ] Pixel: no Gerenciador de Eventos da Meta (Testar eventos), aparecem `PageView`, `Lead` e `PesquisaConcluida` da página `/pesquisa-icp`.
- [ ] A chave pública não lê nada. Troque `ANON` pela chave anon (ela é pública mesmo) e rode:

  ```bash
  curl -s "https://wfqnxedkuxvvcfofsmpq.supabase.co/rest/v1/pesquisa_pessoas?select=nome" \
    -H "apikey: ANON" -H "Authorization: Bearer ANON"
  ```

  Tem que responder erro de permissão (`permission denied` / 401), **nunca** uma lista.

Depois do teste, apague os dados de teste no SQL Editor, para não sujar os números do lançamento (troque pelo WhatsApp que você usou, só os dígitos):

```sql
delete from public.pesquisa_respostas where whatsapp_digits = '11999999999';
delete from public.pesquisa_visitas where utm_source = 'teste';
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

Datas ficam gravadas em UTC. Para ver no horário de Brasília: `criado_em at time zone 'America/Sao_Paulo'`.

---

## Operação

- **Trocar a senha do painel:** gere de novo (passo 3) e atualize `PAINEL_SENHA_HASH` no Railway.
- **Derrubar todas as sessões abertas** (perdeu um celular logado, por exemplo): troque `PAINEL_SESSAO_SEGREDO`.
- **Mudar uma pergunta:** veja "Mudar uma pergunta" no `README.md` (é só `js/pesquisa-config.js` + subir a `VERSAO`).
- **A pesquisa responde erro ao gravar / painel com erro 502:** confira se o `supabase.sql` foi rodado no projeto certo e se a chave é a service_role. Se o log do Railway falar em função não encontrada logo depois de rodar o SQL, rode no SQL Editor `notify pgrst, 'reload schema';`.
- **Painel responde 503:** falta alguma das variáveis `SUPABASE_*` ou `PAINEL_*` (o log do deploy lista qual, com `Aviso:`).
