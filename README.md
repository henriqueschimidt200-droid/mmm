# Mental AI

Aplicação web com login, cinco personas de IA, assinatura Stripe e Premium vitalício por código.

## Instalação

1. Instale Node.js 20+.
2. Rode `npm install`.
3. Copie `.env.example` para `.env`.
4. Preencha as variáveis do `.env`.
5. Rode `npm start`.

## OpenAI

`OPENAI_API_KEY` fica somente no servidor. O modelo padrão é `gpt-5.6-luna`; você pode trocar `OPENAI_MODEL` por outro modelo disponível na sua conta.

## Stripe

Crie três Prices recorrentes no Stripe e coloque os respectivos IDs em:

- `STRIPE_PRICE_MONTHLY`
- `STRIPE_PRICE_QUARTERLY`
- `STRIPE_PRICE_ANNUAL`

Configure um endpoint de webhook apontando para:

`https://SEU-DOMINIO/api/stripe/webhook`

Use o Signing Secret fornecido pelo Stripe em `STRIPE_WEBHOOK_SECRET`.

Eventos recomendados:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.paused`
- `customer.subscription.resumed`
- `invoice.paid`
- `invoice.payment_failed`

O servidor só libera Premium de assinatura quando o estado da assinatura recebido pelo Stripe é `active` ou `trialing`. Cancelamentos/falhas são sincronizados pelos webhooks.

## Premium vitalício

Defina `PREMIUM_CODE` no `.env`. O código não fica mais escrito no JavaScript/HTML público.

## Segurança antes de produção

- Use HTTPS.
- Use um `JWT_SECRET` longo e aleatório.
- Nunca envie `.env` para GitHub.
- Use as chaves `sk_test_...` do Stripe para testes e troque para chaves live somente quando estiver tudo validado.
- Configure o webhook do Stripe e teste os eventos antes de cobrar clientes reais.
- Faça backup do `mental-ai.sqlite` ou migre para PostgreSQL quando a aplicação crescer.
