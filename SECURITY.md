# Segurança — Onion

## Env vars (somente estas)

| Variável | Uso |
|----------|-----|
| `APP_ORIGIN` | Origem permitida para CSRF/Origin check |
| `TRUST_PROXY` | `1` no Vercel para ler IP de `X-Forwarded-For` |

Nenhuma outra variável de ambiente é necessária. Limites, timeouts e caps ficam hardcoded no código.

## Proteções mantidas (sem env extra)

- Token Discord: sem storage, limpeza pós-uso, mascaramento em erros/logs
- CSRF + cookies HttpOnly / Secure / SameSite=strict
- Validação de token e channel ID no backend
- Ownership: só apaga mensagens do `client.user.id` autenticado pelo token
- Rate limit e jobs em memória (por isolate)
- CSP com nonce, headers de segurança
- Logs só com jobId / status / duração / contagens

## Riscos aceitos nesta configuração

1. **Rate limit em memória no Vercel** — cada isolate tem seu próprio contador; não é global.
2. **Sem access code** — qualquer pessoa com a URL pode usar a ferramenta com um token.
3. **Selfbot / ToS Discord** — `discord.js-selfbot-v13` permanece (proposta do produto).
4. **Token no body HTTPS** — necessário ao fluxo; não é persistido.

## Dependência crítica

`discord.js-selfbot-v13` — mantida de propósito; viola ToS do Discord.
