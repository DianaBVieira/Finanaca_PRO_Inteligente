# FinançasPro

Aplicativo web de gestão financeira pessoal e planejamento anual, desenvolvido pela **Utopia Desenvolvimentos**.

O FinançasPro permite organizar receitas, despesas, cartões de crédito, metas e diagnósticos financeiros. O acesso é controlado por conta de usuário, com 14 dias de teste gratuito e assinatura mensal processada pelo Asaas.

## Estado atual do projeto

- Aplicativo publicado: <https://financas-pro-3c21e.web.app/>
- Projeto Firebase: `financas-pro-3c21e`
- Ambiente de pagamento atual: **Asaas Sandbox**
- Plano configurado: **FinançasPro Mensal — R$ 19,99/mês**
- Teste gratuito: **14 dias por conta**
- Checkout de teste: funcionando
- Pagamento de teste: aprovado
- Liberação automática por webhook: funcionando
- Perfil do usuário e situação do plano: funcionando
- Cancelamento pelo perfil: implementado e validado no Sandbox
- Alterações locais: ainda não foram organizadas em um commit final no Git

Última atualização deste documento: **05/08/2026**.

## Funcionalidades do aplicativo

### Conta do usuário

- Cadastro com nome, e-mail e senha.
- Login com e-mail e senha.
- Login com Google.
- Recuperação de senha.
- Dados financeiros separados por usuário.
- Perfil acessível pelo ícone/nome no cabeçalho.
- Perfil com nome, e-mail, plano atual e situação do acesso.
- Botão de sair dentro do perfil.
- Interface responsiva para computador e celular.
- Manifesto PWA para instalação como aplicativo.

### Gestão financeira

- Controle anual dividido por meses.
- Cadastro e edição de categorias de receitas e despesas.
- Cálculo de receitas totais, despesas totais, faturas e saldo líquido.
- Replicação dos valores do mês atual para os meses seguintes.
- Controle opcional da sobra do mês anterior.
- Cadastro, edição e exclusão de cartões de crédito.
- Visão mensal dos cartões.
- Fatura anual consolidada por cartão.
- Exportação e importação de backup dos dados.

### Gráficos, metas e diagnóstico

- Evolução anual de receitas e despesas.
- Distribuição das despesas do mês.
- Meta média de poupança.
- Saldo acumulado no ano.
- Taxa real de poupança.
- Recomendações automáticas de saúde financeira.

### Importação de fatura com IA

- Importação de PDF, JPG e PNG.
- Leitura dos lançamentos com Google Gemini.
- Sugestão automática de categoria.
- Edição, exclusão e inclusão manual dos itens importados.
- Resumo dos gastos por categoria.

> A chave do Gemini é informada pelo próprio usuário e fica salva somente no navegador, sem criptografia. Ela não deve ser adicionada ao código ou ao Git.

### Tutorial

- Tour guiado pelas principais áreas do aplicativo.
- Controles adaptados para desktop e celular.

## Acesso, teste gratuito e assinatura

O documento `entitlements/{uid}` do Firestore é a fonte de verdade sobre o acesso de cada conta.

Situações utilizadas:

- `trialing`: teste gratuito em andamento.
- `authorized` ou `active`: assinatura ativa.
- `canceled`: assinatura cancelada, com acesso até `accessEndsAt`.
- outros estados: acesso inativo ou aguardando confirmação.

Fluxo atual:

1. O usuário cria uma conta ou entra no aplicativo.
2. `initializeTrial` cria uma única cortesia de 14 dias para o UID.
3. Enquanto o teste estiver válido, as regras do Firestore permitem usar os dados financeiros.
4. Ao clicar em **Assinar com Asaas**, `createSubscription` cria um checkout recorrente mensal.
5. O usuário paga na página segura do Asaas.
6. O Asaas envia `CHECKOUT_PAID` para `asaasWebhook`.
7. O webhook valida o token e altera o acesso para `authorized`.
8. O cabeçalho e o perfil passam a mostrar **Assinatura ativa**.

O botão **Já paguei — verificar acesso** executa uma consulta complementar por `refreshSubscriptionStatus`. No Sandbox, a consulta de pagamentos por sessão de checkout pode retornar uma lista vazia mesmo depois da aprovação; por isso o webhook é o mecanismo principal de confirmação.

## Cancelamento

O cancelamento fica no perfil e segue este fluxo:

1. O usuário abre o perfil.
2. Clica em **Cancelar assinatura**.
3. Uma segunda confirmação é exibida.
4. O motivo do cancelamento é obrigatório.
5. `cancelSubscription` identifica a recorrência vinculada à própria conta.
6. A assinatura recorrente é removida no Asaas, interrompendo cobranças futuras.
7. O motivo é salvo para análise.
8. O acesso permanece disponível até o fim do período mensal já pago.

Registros envolvidos:

- `entitlements/{uid}`: situação do acesso, identificação do checkout/assinatura, motivo e data final de acesso.
- `subscriptionCancellations/{id}`: histórico administrativo do cancelamento.

### Situação do teste de cancelamento

A primeira tentativa encontrou uma limitação de um checkout antigo: o Asaas confirmou o pagamento, mas não retornou pagamentos na consulta por `checkoutSession`, e o identificador da assinatura não havia sido gravado no Firestore.

Foi publicada uma correção em `cancelSubscription` que procura a assinatura, nesta ordem:

1. identificador já salvo no Firestore;
2. assinatura presente no pagamento do checkout;
3. referência interna do usuário;
4. cliente do Asaas correspondente ao e-mail ou à referência da própria conta;
5. assinatura mensal ativa de R$ 19,99 desse cliente.

A função somente prossegue quando encontra uma correspondência única e segura.

O teste foi repetido com sucesso no Sandbox: a recorrência foi cancelada, o perfil passou a exibir **Cancelado**, o cabeçalho passou a informar a data final do acesso e nenhuma nova cobrança será criada. O acesso foi preservado até o fim do período já pago.

## Cloud Functions

As funções ficam em `functions/index.js`.

| Função | Tipo | Responsabilidade |
| --- | --- | --- |
| `initializeTrial` | Callable | Cria o teste gratuito de 14 dias uma única vez. |
| `createSubscription` | Callable | Cria o checkout recorrente mensal no Asaas. |
| `refreshSubscriptionStatus` | Callable | Faz a conferência manual do pagamento. |
| `cancelSubscription` | Callable | Cancela a recorrência e registra o motivo, preservando o período pago. |
| `asaasWebhook` | HTTP | Recebe e valida eventos de checkout do Asaas. |

Região publicada: `us-central1`.

URL do webhook:

```text
https://us-central1-financas-pro-3c21e.cloudfunctions.net/asaasWebhook
```

## Configuração do webhook no Asaas

Configuração usada no Sandbox:

- API: `v3`
- Tipo de envio: sequencial
- Fila de sincronização: ativada
- Token de autenticação: o mesmo valor armazenado no secret `ASAAS_WEBHOOK_TOKEN`
- Eventos necessários:
  - `CHECKOUT_PAID`
  - `CHECKOUT_CANCELED`
  - `CHECKOUT_EXPIRED`

O Asaas envia o token no cabeçalho `asaas-access-token`. O webhook rejeita requisições sem o valor correto.

## Segurança

- `ASAAS_API_KEY` e `ASAAS_WEBHOOK_TOKEN` ficam no Secret Manager do Firebase.
- Nenhuma chave do Asaas deve ser colocada no `index.html`, no README, no Git ou em capturas de tela.
- O cliente pode ler somente o próprio `entitlements/{uid}`.
- O cliente não pode alterar diretamente o status do plano.
- Apenas as Cloud Functions podem criar ou modificar direitos de acesso.
- Os dados financeiros em `users/{uid}` só podem ser lidos e gravados pelo próprio usuário enquanto houver acesso válido.
- Depois de um cancelamento, as regras mantêm o acesso somente até `accessEndsAt`.
- Todas as demais coleções ficam bloqueadas por padrão.

## Estrutura do projeto

```text
.
├── index.html                 # Interface e lógica principal do aplicativo
├── manifest.json              # Configuração PWA
├── assets/                    # Logos, ícones e imagens
├── functions/
│   ├── index.js               # Integração Firebase/Asaas
│   ├── package.json
│   └── package-lock.json
├── firestore.rules            # Regras de segurança
├── firebase.json              # Hosting, Functions e Firestore
├── .firebaserc                # Projeto Firebase padrão
├── ASSINATURA_ASAAS.md        # Notas específicas da assinatura
└── README.md                  # Documentação geral
```

## Tecnologias

- HTML, CSS e JavaScript.
- Tailwind CSS carregado por CDN.
- Chart.js.
- Font Awesome.
- Firebase Authentication.
- Cloud Firestore.
- Firebase Cloud Functions de 2ª geração.
- Firebase Hosting.
- Firebase Secret Manager.
- Asaas API v3.
- Google Gemini para leitura opcional de faturas.

## Configuração para desenvolvimento

### Pré-requisitos

- Node.js compatível com o runtime das Functions.
- Firebase CLI autenticado.
- Acesso ao projeto Firebase `financas-pro-3c21e`.
- Conta Sandbox do Asaas para testes.

### Dependências das Functions

```powershell
cd functions
npm install
cd ..
```

### Secrets do Firebase

Os comandos solicitam o valor de forma interativa. Não coloque o valor diretamente na linha de comando.

```powershell
firebase functions:secrets:set ASAAS_API_KEY --project financas-pro-3c21e
firebase functions:secrets:set ASAAS_WEBHOOK_TOKEN --project financas-pro-3c21e
```

Secrets utilizados:

- `ASAAS_API_KEY`: chave da API do ambiente atual.
- `ASAAS_WEBHOOK_TOKEN`: token forte compartilhado apenas entre Asaas e o webhook.

Variáveis de ambiente relevantes:

- `ASAAS_API_URL`: URL base da API.
- `APP_URL`: URL para a qual o checkout retorna.

Valores atuais/padrão de teste:

```text
ASAAS_API_URL=https://api-sandbox.asaas.com/v3
APP_URL=https://financas-pro-3c21e.web.app/
```

O arquivo `functions/.env` está ignorado pelo Git e não deve conter dados destinados a versionamento.

## Verificações antes de publicar

```powershell
node --check functions/index.js
git diff --check
```

Também devem ser testados manualmente:

- cadastro, login, Google e recuperação de senha;
- criação do teste gratuito;
- isolamento dos dados entre duas contas;
- criação do checkout;
- pagamento no Sandbox;
- recebimento do webhook;
- atualização do cabeçalho e do perfil;
- cancelamento com motivo;
- preservação do acesso até o fim do período pago;
- bloqueio depois do vencimento;
- visualização em celular e computador;
- exportação/importação de backup;
- importação de fatura com Gemini.

## Publicação

Publicação completa:

```powershell
firebase deploy --only functions,firestore:rules,hosting --project financas-pro-3c21e
```

Publicações isoladas:

```powershell
firebase deploy --only functions --project financas-pro-3c21e
firebase deploy --only firestore:rules --project financas-pro-3c21e
firebase deploy --only hosting --project financas-pro-3c21e
```

## Correções já realizadas

- Instalação e configuração do Firebase CLI.
- Projeto Firebase atualizado para o plano Blaze.
- Ajustes de permissões IAM para publicação das Functions.
- Publicação do Hosting, Firestore Rules e Cloud Functions.
- Liberação pública controlada das funções HTTP necessárias.
- Criação do teste gratuito de 14 dias.
- Tela de assinatura e bloqueio depois do período permitido.
- Primeira integração com Mercado Pago e diagnóstico dos erros de checkout/teste.
- Migração do meio de pagamento para Asaas.
- Criação e proteção da API Key do Asaas.
- Criação e proteção do token de webhook.
- Correção do token do webhook que provocava respostas `401 Unauthorized`.
- Correção da fila penalizada do webhook.
- Pagamento Sandbox aprovado.
- Liberação automática do acesso pelo webhook validada.
- Correção do retorno do checkout para o Firebase Hosting em novos checkouts; checkouts antigos ainda podem conter a antiga URL do GitHub Pages.
- Correção do indicador visual que continuava mostrando dias gratuitos depois do pagamento.
- Inclusão do perfil com nome, e-mail e situação do plano.
- Transferência do botão de sair para dentro do perfil.
- Inclusão da confirmação e do motivo obrigatório no cancelamento.
- Registro administrativo dos cancelamentos.
- Manutenção do acesso até o fim do período já pago.
- Busca segura da assinatura antiga pelo cliente vinculado ao e-mail/referência da conta.
- Cancelamento Sandbox validado de ponta a ponta: recorrência removida, motivo registrado, perfil atualizado e acesso preservado até a data final.

## Etapas que ainda faltam

### Prioridade alta

1. Verificar o documento `entitlements/{uid}` e o registro em `subscriptionCancellations` após o cancelamento validado.
2. Fazer um teste completo com uma nova conta: cadastro → teste → pagamento → webhook → cancelamento.
3. Revisar as mudanças e criar o commit no Git.

### Preparação para produção

1. Finalizar a validação cadastral da conta Asaas de produção.
2. Criar uma API Key de produção.
3. Substituir o secret `ASAAS_API_KEY` pela chave de produção.
4. Alterar `ASAAS_API_URL` para `https://api.asaas.com/v3`.
5. Criar o webhook também no ambiente de produção com o token correto.
6. Confirmar que as URLs de retorno apontam para `https://financas-pro-3c21e.web.app/`.
7. Publicar novamente as Functions.
8. Fazer uma compra real controlada e validar liberação, renovação e cancelamento.
9. Conferir política de privacidade, termos de uso, suporte, reembolso e tratamento de dados antes da divulgação pública.

### Melhorias técnicas recomendadas

- Atualizar o runtime das Functions: o Node.js 20 foi descontinuado para novos ciclos em 30/04/2026 e será desativado em 30/10/2026.
- Atualizar `firebase-functions` e testar possíveis mudanças de compatibilidade.
- Substituir o Tailwind via CDN por uma compilação própria para produção.
- Mover os arquivos públicos para uma pasta dedicada, como `public/`, em vez de publicar a raiz do projeto.
- Melhorar a persistência do Firestore para uso simultâneo em várias abas.
- Armazenar o identificador do cliente e da assinatura do Asaas assim que forem criados/recebidos.
- Acrescentar eventos de pagamento/assinatura ao webhook para conciliação mais completa.
- Implementar testes automatizados para acesso, webhook, renovação e cancelamento.
- Avaliar armazenamento mais seguro para a chave do Gemini, pois hoje ela fica no navegador do usuário.

## Observações importantes

- O projeto está em Sandbox; cobranças de teste não representam recebimentos reais.
- Não misture credenciais de Sandbox com credenciais de produção.
- Não remova o documento `entitlements` manualmente para reiniciar testes sem avaliar os efeitos no acesso.
- Não compartilhe API Keys, tokens, senhas ou dados de cartão em mensagens, prints ou commits.
- Antes de alterações no fluxo financeiro, preserve os dados existentes e valide em Sandbox.
