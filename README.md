# Virtus Acompanha

Protótipo funcional para cadastro de pacientes, envio de link de formulário por WhatsApp e acompanhamento da classificação clínica.

## Rodar localmente

```bash
python server.py
```

Depois abra:

```text
http://127.0.0.1:4176/index.html
```

## Como funciona

- O painel lista os pacientes acompanhados.
- A aba Cadastro cria um paciente pendente e gera link de WhatsApp.
- O link do WhatsApp leva para um formulário vinculado ao paciente.
- Ao responder, o paciente sai de Pendente e recebe classificação Verde, Amarelo ou Vermelho.
- Em desenvolvimento local, os dados podem ficar em `data/patients.json`.
- Em hospedagem online, os dados ficam no PostgreSQL configurado em `DATABASE_URL`.

## Publicação na Netlify

O projeto também inclui `netlify.toml`, `package.json` e a função `netlify/functions/api.js`.

### Opção recomendada sem Render pago

1. Faça **Push origin** no GitHub Desktop.
2. Crie uma conta em `https://www.netlify.com`.
3. Na Netlify, escolha **Add new site** > **Import an existing project**.
4. Conecte o GitHub e selecione o repositório `virtus-acompanha`.
5. Confirme as configurações:

```text
Build command: npm run build
Publish directory: dist
Functions directory: netlify/functions
```

6. Configure as variáveis de ambiente na Netlify:

```text
ADMIN_PASSWORD=uma-senha-forte-para-a-equipe
SESSION_SECRET=um-texto-longo-aleatorio-com-pelo-menos-32-caracteres
DATABASE_URL=url-do-banco-postgresql-do-supabase
ALLOWED_ORIGINS=https://seu-site.netlify.app
```

7. Faça o deploy.

Os endpoints `/api/...` são redirecionados para a função Netlify automaticamente. A tela do app continua usando os mesmos caminhos de API.

### Importante na Netlify

- Mantenha `DATABASE_URL`, `ADMIN_PASSWORD` e `SESSION_SECRET` sempre configurados.
- Use a URL do Supabase com pooler quando possível.
- Depois que o site Netlify estiver ativo, teste login, cadastro, WhatsApp, formulário, histórico, auditoria e exportação CSV.

## Publicação no Render

O projeto ainda mantém `render.yaml`, `Procfile` e `requirements.txt` para quem quiser continuar usando Render.

### Opção recomendada

1. Crie uma conta em `https://render.com`.
2. Coloque esta pasta em um repositório no GitHub.
3. No Render, escolha **New** > **Blueprint**.
4. Conecte o repositório do GitHub.
5. Confirme o serviço `virtus-acompanha`.
6. Aguarde o deploy terminar.

O Render vai usar automaticamente:

```text
HOST=0.0.0.0 python server.py
```

Depois de publicado, abra o link gerado pelo Render. Os links do WhatsApp passarão a usar esse domínio público.

### Variáveis de ambiente

Configure no Render:

```text
ADMIN_PASSWORD=uma-senha-forte-para-a-equipe
SESSION_SECRET=um-texto-longo-aleatorio
DATABASE_URL=url-do-banco-postgresql
ALLOWED_ORIGINS=https://seu-dominio.example
```

- `ADMIN_PASSWORD` ativa o login obrigatório do painel administrativo em produção.
- `SESSION_SECRET` protege a sessão do login. Use pelo menos 32 caracteres aleatórios.
- `DATABASE_URL` ativa o banco online PostgreSQL e é obrigatório em produção.
- `ALLOWED_ORIGINS` é opcional e permite domínios adicionais para ações autenticadas quando houver domínio customizado.

### Importante

Sem `DATABASE_URL`, o app só usa `data/patients.json` em desenvolvimento local. Em produção, a aplicação encerra a inicialização se `ADMIN_PASSWORD`, `SESSION_SECRET` ou `DATABASE_URL` não estiverem configurados.

O servidor só publica `index.html`, `styles.css` e `app.js`. Arquivos em `data/`, planilhas em `outputs/` e arquivos internos não são servidos pelo app.

## Controles de segurança aplicados

- Login obrigatório em produção.
- Sessão assinada com cookie `HttpOnly`, `SameSite=Strict` e `Secure` em produção.
- Rate limit simples contra força bruta no login.
- Limite de tamanho de requisição JSON.
- Validação de origem para ações que alteram dados.
- Tokens aleatórios nos links públicos dos formulários.
- Validação e normalização dos campos de pacientes e respostas.
- Headers de segurança: CSP, HSTS em produção, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` e `Permissions-Policy`.
- Logs com parâmetros sensíveis redigidos.
- Falha segura em produção quando banco ou segredos essenciais não estão configurados.

## Riscos residuais

- O projeto ainda precisa de uma conta de banco PostgreSQL gerenciada, backup e política de retenção.
- O controle de acesso é por uma senha administrativa única; para uso real com múltiplos profissionais, recomenda-se autenticação por usuário, MFA e perfis de autorização.
- Auditoria formal LGPD/segurança e testes externos de invasão não foram executados.
- Monitoramento, alertas e trilha de auditoria detalhada dependem de infraestrutura externa.
