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

## Publicação no Cloudflare

O ambiente de produção é o Cloudflare Pages + Functions (ver `CLOUDFLARE.md` para o passo a passo completo: build, variáveis, Hyperdrive apontando para o Supabase Pooler).

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
