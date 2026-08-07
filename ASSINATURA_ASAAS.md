# Assinatura do FinançasPro com Asaas

O aplicativo oferece 14 dias gratuitos por conta e, depois, exige uma assinatura mensal de R$ 19,99.

## Ambientes

- Sandbox: `https://api-sandbox.asaas.com/v3`
- Produção: `https://api.asaas.com/v3`

Use uma conta e uma API Key exclusivas do Sandbox durante os testes. A chave deve começar com `$aact_hmlg_`. Nunca coloque a chave no `index.html`, no Git ou em mensagens.

## Secrets do Firebase

- `ASAAS_API_KEY`: API Key do ambiente atual.
- `ASAAS_WEBHOOK_TOKEN`: token forte, com pelo menos 32 caracteres, criado por nós para validar os webhooks.

## Fluxo

1. `createSubscription` cria um checkout recorrente mensal de cartão no Asaas.
2. O UID do Firebase é enviado em `externalReference`.
3. O cliente é redirecionado para a página hospedada pelo Asaas.
4. O webhook `asaasWebhook` recebe `CHECKOUT_PAID` e libera o acesso.
5. `refreshSubscriptionStatus` permite uma conferência manual do checkout.
6. `cancelSubscription` localiza a recorrência vinculada ao checkout, remove a assinatura no Asaas e impede novas cobranças.
7. O motivo fica registrado em `subscriptionCancellations` e no documento de acesso do usuário.

No cancelamento, o usuário mantém o acesso até o fim do período mensal já pago. Depois dessa data, as regras do Firestore bloqueiam automaticamente o uso dos dados do aplicativo.

O documento `entitlements/{uid}` continua sendo a fonte da verdade. O cliente pode lê-lo, mas apenas as Cloud Functions podem criá-lo ou alterá-lo.

## Webhook

Cadastre a URL publicada de `asaasWebhook` no Sandbox e acompanhe os eventos:

- `CHECKOUT_PAID`
- `CHECKOUT_CANCELED`
- `CHECKOUT_EXPIRED`

Configure no Asaas o mesmo valor de `ASAAS_WEBHOOK_TOKEN` como token de autenticação. O Asaas o enviará no header `asaas-access-token`.

## Produção

Depois da homologação completa, troque a API Key pela chave de produção, defina `ASAAS_API_URL=https://api.asaas.com/v3`, configure o webhook na conta de produção e publique novamente as Functions.
