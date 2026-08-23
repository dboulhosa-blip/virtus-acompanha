# Publicacao no Cloudflare

Este projeto pode rodar no Cloudflare Pages com Functions e Supabase.

## Configuracao do Pages

- Build command: `npm run build`
- Build output directory: `dist`
- Functions directory: `functions`
- Compatibility date: `2026-08-23`
- Compatibility flag: `nodejs_compat`

## Variaveis e secrets

Configure no Cloudflare:

- `ADMIN_PASSWORD`: senha de entrada do painel do Virtus Acompanha.
- `SESSION_SECRET`: texto secreto com pelo menos 32 caracteres.
- `ALLOWED_ORIGINS`: URL publica do Cloudflare Pages, sem barra no final.

## Banco de dados

Crie um Hyperdrive apontando para o Supabase Pooler e vincule ao Pages/Worker com o nome:

- Binding: `HYPERDRIVE`

Formato da conexao do Supabase Pooler:

```text
postgresql://postgres.tnsvgpyaacwdyyhkcxew:SENHA_DO_BANCO@aws-1-sa-east-1.pooler.supabase.com:6543/postgres
```

Se a senha tiver caracteres especiais, mantenha a versao codificada que ja funcionou no Netlify.

## Teste

Depois do deploy, abra:

```text
https://SEU-SITE.pages.dev/api/health
```

Resultado esperado:

```json
{"ok":true,"database":"connected"}
```
