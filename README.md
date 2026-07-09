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
- Os dados ficam em `data/patients.json`.

## Publicação no Render

O projeto já inclui `render.yaml`, `Procfile` e `requirements.txt`.

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
```

- `ADMIN_PASSWORD` ativa o login do painel administrativo.
- `SESSION_SECRET` protege a sessão do login.
- `DATABASE_URL` ativa o banco online PostgreSQL.

### Importante

Sem `DATABASE_URL`, o app usa `data/patients.json` como fallback para teste e demonstração. Em hospedagem gratuita, esses dados podem não ser permanentes após reinícios do serviço.
