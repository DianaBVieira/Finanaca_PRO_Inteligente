const {onCall, HttpsError, onRequest} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const asaasApiKey = defineSecret("ASAAS_API_KEY");
const asaasWebhookToken = defineSecret("ASAAS_WEBHOOK_TOKEN");
const appUrl = process.env.APP_URL || "https://financas-pro-3c21e.web.app/";
const asaasApiUrl = (process.env.ASAAS_API_URL || "https://api-sandbox.asaas.com/v3").replace(/\/$/, "");
const subscriptionAmount = 19.99;

// Painel central de clientes (projeto Supabase separado) — ver Painel_Central_Clientes/.
const ingestSharedSecret = defineSecret("INGEST_SHARED_SECRET");
const centralIngestUrl = process.env.CENTRAL_INGEST_URL ||
  "https://cgmaikugpjlpuwbubrcw.supabase.co/functions/v1/ingest-event";

// Best-effort: nunca deixa o webhook do Asaas falhar por causa do painel central.
async function notifyCentralPanel(payload) {
  const secret = ingestSharedSecret.value();
  if (!secret) return;
  try {
    await fetch(centralIngestUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json", "x-ingest-token": secret},
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("Falha ao notificar painel central", error);
  }
}

function requireUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na sua conta para continuar.");
  return request.auth;
}

function activeTrial(entitlement) {
  const trialEndsAt = entitlement?.trialEndsAt;
  return entitlement?.status === "trialing" &&
    trialEndsAt?.toMillis && trialEndsAt.toMillis() > Date.now();
}

function accessStatus(entitlement, asaasStatus) {
  if (asaasStatus === "PAID") return "authorized";
  return activeTrial(entitlement) ? "trialing" : String(asaasStatus || "inactive").toLowerCase();
}

async function asaasRequest(path, options = {}) {
  const response = await fetch(`${asaasApiUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      access_token: asaasApiKey.value(),
      "Content-Type": "application/json",
      "User-Agent": "FinancasPro/1.0 (Firebase Functions; sandbox)",
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Asaas API error", response.status, data);
    const description = data.errors?.[0]?.description;
    const error = new Error(description || `Asaas respondeu com status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const paidPaymentStatuses = new Set(["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH", "DUNNING_RECEIVED"]);

async function checkoutPayments(checkoutId) {
  const result = await asaasRequest(`/payments?checkoutSession=${encodeURIComponent(checkoutId)}&limit=100`);
  const payments = Array.isArray(result.data) ? result.data : [];
  console.info("Checkout payment lookup", {
    checkoutId,
    count: payments.length,
    statuses: payments.map((payment) => payment.status),
  });
  return payments;
}

async function checkoutPaymentStatus(checkoutId) {
  const payments = await checkoutPayments(checkoutId);
  const paidPayment = payments.find((payment) => paidPaymentStatuses.has(payment.status));
  return paidPayment ? "PAID" : (payments[0]?.status || "ACTIVE");
}

function subscriptionIdFromPayment(payment) {
  if (typeof payment?.subscription === "string") return payment.subscription;
  return payment?.subscription?.id || null;
}

function subscriptionMatchesPlan(subscription) {
  return Math.abs(Number(subscription?.value) - subscriptionAmount) < 0.01 &&
    (!subscription.billingType || subscription.billingType === "CREDIT_CARD") &&
    (!subscription.cycle || subscription.cycle === "MONTHLY");
}

async function findAsaasSubscription(uid, entitlement, email) {
  if (entitlement.asaasSubscriptionId) {
    try {
      const subscription = await asaasRequest(`/subscriptions/${encodeURIComponent(entitlement.asaasSubscriptionId)}`);
      return {subscription, payments: []};
    } catch (error) {
      if (error.status !== 404) throw error;
      if (entitlement.cancellationStartedAt) {
        const payments = entitlement.asaasCheckoutId ? await checkoutPayments(entitlement.asaasCheckoutId) : [];
        return {subscription: {id: entitlement.asaasSubscriptionId}, payments};
      }
    }
  }

  const payments = entitlement.asaasCheckoutId ? await checkoutPayments(entitlement.asaasCheckoutId) : [];
  const paymentSubscriptionId = payments.map(subscriptionIdFromPayment).find(Boolean);
  if (paymentSubscriptionId) {
    const subscription = await asaasRequest(`/subscriptions/${encodeURIComponent(paymentSubscriptionId)}`);
    return {subscription, payments};
  }

  const byReference = await asaasRequest(`/subscriptions?externalReference=${encodeURIComponent(uid)}&status=ACTIVE&limit=100`);
  const referenced = Array.isArray(byReference.data) ? byReference.data : [];
  if (referenced.length === 1) return {subscription: referenced[0], payments};

  const customersById = new Map();
  const customerIdsFromPayments = payments.map((payment) => payment.customer).filter(Boolean);
  customerIdsFromPayments.forEach((customerId) => customersById.set(customerId, {id: customerId}));

  if (email) {
    const byEmail = await asaasRequest(`/customers?email=${encodeURIComponent(email)}&limit=100`);
    const customers = Array.isArray(byEmail.data) ? byEmail.data : [];
    customers.forEach((customer) => customersById.set(customer.id, customer));
  }

  const byCustomerReference = await asaasRequest(`/customers?externalReference=${encodeURIComponent(uid)}&limit=100`);
  const referencedCustomers = Array.isArray(byCustomerReference.data) ? byCustomerReference.data : [];
  referencedCustomers.forEach((customer) => customersById.set(customer.id, customer));

  console.info("Asaas customer lookup for cancellation", {
    checkoutPaymentCustomers: customerIdsFromPayments.length,
    matchedCustomers: customersById.size,
  });

  const customerIds = [...customersById.keys()];
  const candidates = [];
  for (const customerId of customerIds) {
    const result = await asaasRequest(`/subscriptions?customer=${encodeURIComponent(customerId)}&billingType=CREDIT_CARD&status=ACTIVE&limit=100`);
    const subscriptions = Array.isArray(result.data) ? result.data : [];
    candidates.push(...subscriptions.filter(subscriptionMatchesPlan));
  }
  const uniqueCandidates = [...new Map(candidates.map((subscription) => [subscription.id, subscription])).values()];
  if (uniqueCandidates.length === 1) return {subscription: uniqueCandidates[0], payments};

  throw new Error("Não foi possível localizar com segurança a assinatura recorrente no Asaas.");
}

function cancellationAccessEnd(subscription, payments) {
  const candidates = [];
  if (subscription?.nextDueDate) {
    const nextDueDate = new Date(`${subscription.nextDueDate}T23:59:59-03:00`);
    if (!Number.isNaN(nextDueDate.getTime()) && nextDueDate.getTime() > Date.now()) candidates.push(nextDueDate);
  }

  const paidPayments = payments.filter((payment) => paidPaymentStatuses.has(payment.status));
  paidPayments.forEach((payment) => {
    const baseValue = payment.paymentDate || payment.confirmedDate || payment.clientPaymentDate || payment.dueDate;
    if (!baseValue) return;
    const baseDate = new Date(`${baseValue}T12:00:00-03:00`);
    if (Number.isNaN(baseDate.getTime())) return;
    baseDate.setMonth(baseDate.getMonth() + 1);
    candidates.push(baseDate);
  });

  if (!candidates.length) {
    const fallback = new Date();
    fallback.setMonth(fallback.getMonth() + 1);
    candidates.push(fallback);
  }
  return new Date(Math.max(...candidates.map((date) => date.getTime())));
}

exports.initializeTrial = onCall(
  {secrets: [ingestSharedSecret]},
  async (request) => {
    const auth = requireUser(request);
    const ref = db.collection("entitlements").doc(auth.uid);
    let created = false;
    let trialEndsAtIso = null;
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      if (snap.exists) return;
      const now = admin.firestore.Timestamp.now();
      const trialEndsAt = admin.firestore.Timestamp.fromMillis(now.toMillis() + 14 * 24 * 60 * 60 * 1000);
      transaction.create(ref, {
        uid: auth.uid,
        email: auth.token.email || null,
        status: "trialing",
        trialStartedAt: now,
        trialEndsAt,
        planAmount: subscriptionAmount,
        currency: "BRL",
        createdAt: now,
        updatedAt: now,
      });
      created = true;
      trialEndsAtIso = trialEndsAt.toDate().toISOString();
    });
    if (created) {
      // Só notifica o painel central na primeira vez (novo cliente de verdade).
      await notifyCentralPanel({
        app_slug: "financaspro",
        external_customer_id: auth.uid,
        email: auth.token.email || null,
        event_type: "trial_started",
        trial_ends_at: trialEndsAtIso,
        occurred_at: new Date().toISOString(),
      });
    }
    return {ok: true};
  },
);

exports.createSubscription = onCall(
  {secrets: [asaasApiKey]},
  async (request) => {
    const auth = requireUser(request);
    const email = auth.token.email;
    if (!email) throw new HttpsError("failed-precondition", "Sua conta precisa ter um e-mail.");

    const ref = db.collection("entitlements").doc(auth.uid);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("failed-precondition", "Período gratuito ainda não inicializado.");
    const entitlement = snap.data();
    const restartingCanceledSubscription = entitlement.status === "canceled";

    if (entitlement.asaasCheckoutId && !restartingCanceledSubscription) {
      const existingStatus = await checkoutPaymentStatus(entitlement.asaasCheckoutId);
      if (existingStatus === "PAID") {
        await ref.set({
          status: "authorized",
          asaasStatus: "PAID",
          accessEndsAt: admin.firestore.FieldValue.delete(),
          cancellationReason: admin.firestore.FieldValue.delete(),
          cancellationRequestedAt: admin.firestore.FieldValue.delete(),
          cancellationStartedAt: admin.firestore.FieldValue.delete(),
          reactivationPending: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        return {checkoutUrl: appUrl, status: "PAID"};
      }
      if (entitlement.asaasCheckoutUrl) {
        return {checkoutUrl: entitlement.asaasCheckoutUrl, status: existingStatus};
      }
    }

    let checkout;
    try {
      const firstChargeAt = new Date();
      const subscriptionEndsAt = new Date(firstChargeAt);
      subscriptionEndsAt.setUTCFullYear(subscriptionEndsAt.getUTCFullYear() + 10);
      const asaasDateTime = (date) => date.toISOString().replace("T", " ").slice(0, 19);
      checkout = await asaasRequest("/checkouts", {
        method: "POST",
        body: JSON.stringify({
          billingTypes: ["CREDIT_CARD"],
          chargeTypes: ["RECURRENT"],
          minutesToExpire: 60,
          externalReference: auth.uid,
          callback: {
            successUrl: appUrl,
            cancelUrl: appUrl,
            expiredUrl: appUrl,
          },
          items: [{
            externalReference: "financaspro-mensal",
            name: "FinançasPro",
            description: "Assinatura mensal do FinançasPro",
            quantity: 1,
            value: subscriptionAmount,
          }],
          subscription: {
            cycle: "MONTHLY",
            nextDueDate: asaasDateTime(firstChargeAt),
            endDate: asaasDateTime(subscriptionEndsAt),
          },
        }),
      });
    } catch (error) {
      console.error("Erro ao criar checkout Asaas", error);
      throw new HttpsError("internal", error.message || "Não foi possível criar a assinatura agora.");
    }

    if (!checkout.id || !checkout.link) {
      console.error("Resposta de checkout incompleta", checkout);
      throw new HttpsError("internal", "O Asaas não retornou o link de pagamento.");
    }

    await ref.set({
      paymentProvider: "asaas",
      asaasCheckoutId: checkout.id,
      asaasCheckoutUrl: checkout.link,
      asaasStatus: checkout.status,
      asaasSubscriptionId: admin.firestore.FieldValue.delete(),
      reactivationPending: restartingCanceledSubscription || admin.firestore.FieldValue.delete(),
      checkoutCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    return {checkoutUrl: checkout.link, status: checkout.status};
  }
);

exports.refreshSubscriptionStatus = onCall(
  {secrets: [asaasApiKey]},
  async (request) => {
    const auth = requireUser(request);
    const ref = db.collection("entitlements").doc(auth.uid);
    const snap = await ref.get();
    if (!snap.exists) return {status: "missing"};
    const entitlement = snap.data();
    if (!entitlement.asaasCheckoutId) return {status: entitlement.status};
    if (entitlement.status === "canceled" && !entitlement.reactivationPending) return {status: "canceled"};

    const checkoutStatus = await checkoutPaymentStatus(entitlement.asaasCheckoutId);
    await ref.set({
      status: accessStatus(entitlement, checkoutStatus),
      asaasStatus: checkoutStatus,
      ...(checkoutStatus === "PAID" ? {
        accessEndsAt: admin.firestore.FieldValue.delete(),
        cancellationReason: admin.firestore.FieldValue.delete(),
        cancellationRequestedAt: admin.firestore.FieldValue.delete(),
        cancellationStartedAt: admin.firestore.FieldValue.delete(),
        reactivationPending: admin.firestore.FieldValue.delete(),
      } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
    return {status: checkoutStatus};
  }
);

exports.cancelSubscription = onCall(
  {secrets: [asaasApiKey]},
  async (request) => {
    const auth = requireUser(request);
    const reason = String(request.data?.reason || "").trim().replace(/\s+/g, " ");
    if (reason.length < 3) {
      throw new HttpsError("invalid-argument", "Informe o motivo do cancelamento.");
    }
    if (reason.length > 500) {
      throw new HttpsError("invalid-argument", "O motivo deve ter no máximo 500 caracteres.");
    }

    const entitlementRef = db.collection("entitlements").doc(auth.uid);
    const snap = await entitlementRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "Assinatura não encontrada.");
    const entitlement = snap.data();

    if (entitlement.status === "canceled") {
      return {
        status: "canceled",
        accessEndsAt: entitlement.accessEndsAt?.toDate?.().toISOString() || null,
      };
    }
    if (!(entitlement.status === "authorized" || entitlement.status === "active")) {
      throw new HttpsError("failed-precondition", "Não existe uma assinatura ativa para cancelar.");
    }

    try {
      const {subscription, payments} = await findAsaasSubscription(
        auth.uid,
        entitlement,
        auth.token.email || entitlement.email || null,
      );
      if (!subscription?.id) throw new Error("O Asaas não retornou o identificador da assinatura.");
      const accessEndsAt = cancellationAccessEnd(subscription, payments);

      await entitlementRef.set({
        cancellationReason: reason,
        cancellationStartedAt: admin.firestore.FieldValue.serverTimestamp(),
        asaasSubscriptionId: subscription.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});

      try {
        await asaasRequest(`/subscriptions/${encodeURIComponent(subscription.id)}`, {method: "DELETE"});
      } catch (error) {
        if (error.status !== 404) throw error;
      }

      const now = admin.firestore.Timestamp.now();
      const accessEndsAtTimestamp = admin.firestore.Timestamp.fromDate(accessEndsAt);
      const cancellationRef = db.collection("subscriptionCancellations").doc();
      const batch = db.batch();
      batch.set(entitlementRef, {
        status: "canceled",
        asaasStatus: "CANCELED",
        asaasSubscriptionId: subscription.id,
        cancellationReason: reason,
        cancellationRequestedAt: now,
        cancellationStartedAt: admin.firestore.FieldValue.delete(),
        accessEndsAt: accessEndsAtTimestamp,
        reactivationPending: admin.firestore.FieldValue.delete(),
        updatedAt: now,
      }, {merge: true});
      batch.set(cancellationRef, {
        uid: auth.uid,
        email: auth.token.email || entitlement.email || null,
        reason,
        paymentProvider: "asaas",
        asaasCheckoutId: entitlement.asaasCheckoutId || null,
        asaasSubscriptionId: subscription.id,
        accessEndsAt: accessEndsAtTimestamp,
        createdAt: now,
      });
      await batch.commit();

      return {status: "canceled", accessEndsAt: accessEndsAt.toISOString()};
    } catch (error) {
      console.error("Erro ao cancelar assinatura Asaas", error);
      throw new HttpsError("internal", error.message || "Não foi possível cancelar a assinatura agora.");
    }
  }
);

exports.asaasWebhook = onRequest(
  {secrets: [asaasWebhookToken, ingestSharedSecret]},
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }
    const receivedToken = String(req.get("asaas-access-token") || "");
    console.info("Asaas webhook authentication", {
      receivedLength: receivedToken.length,
      expectedLength: asaasWebhookToken.value().length,
      matches: receivedToken === asaasWebhookToken.value(),
      event: req.body?.event || null,
    });
    if (!receivedToken || receivedToken !== asaasWebhookToken.value()) {
      res.status(401).send("Invalid token");
      return;
    }

    const eventId = String(req.body?.id || "");
    const event = String(req.body?.event || "");
    const checkout = req.body?.checkout;
    if (!eventId || !checkout?.id) {
      res.status(200).send("Ignored");
      return;
    }

    try {
      let uid = checkout.externalReference;
      let entitlementRef;
      let entitlementSnap;
      if (uid) {
        entitlementRef = db.collection("entitlements").doc(uid);
        entitlementSnap = await entitlementRef.get();
      } else {
        const match = await db.collection("entitlements")
          .where("asaasCheckoutId", "==", checkout.id).limit(1).get();
        if (!match.empty) {
          entitlementRef = match.docs[0].ref;
          entitlementSnap = match.docs[0];
          uid = match.docs[0].id;
        }
      }
      if (!uid || !entitlementSnap?.exists) throw new Error("Conta do checkout não encontrada.");
      const entitlement = entitlementSnap.data();
      if (entitlement.asaasCheckoutId && entitlement.asaasCheckoutId !== checkout.id) {
        throw new Error("Checkout não corresponde à conta associada.");
      }

      const paid = event === "CHECKOUT_PAID" || checkout.status === "PAID";
      const webhookSubscriptionId = typeof checkout.subscription === "string" ?
        checkout.subscription : checkout.subscription?.id;
      await entitlementRef.set({
        paymentProvider: "asaas",
        asaasCheckoutId: checkout.id,
        asaasStatus: checkout.status || event,
        status: paid ? "authorized" : accessStatus(entitlement, checkout.status || event),
        ...(webhookSubscriptionId ? {asaasSubscriptionId: webhookSubscriptionId} : {}),
        ...(paid ? {
          accessEndsAt: admin.firestore.FieldValue.delete(),
          cancellationReason: admin.firestore.FieldValue.delete(),
          cancellationRequestedAt: admin.firestore.FieldValue.delete(),
          cancellationStartedAt: admin.firestore.FieldValue.delete(),
          reactivationPending: admin.firestore.FieldValue.delete(),
        } : {}),
        lastAsaasEventId: eventId,
        lastWebhookAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});

      const centralEventType = paid ?
        "payment_paid" :
        event === "CHECKOUT_CANCELED" ?
        "subscription_canceled" :
        event === "CHECKOUT_EXPIRED" ?
        "subscription_expired" :
        null;
      if (centralEventType) {
        await notifyCentralPanel({
          app_slug: "financaspro",
          external_customer_id: uid,
          email: entitlement.email || null,
          event_type: centralEventType,
          gateway: "asaas",
          amount_cents: paid ? Math.round(subscriptionAmount * 100) : undefined,
          currency: "BRL",
          occurred_at: new Date().toISOString(),
          external_payment_id: eventId,
        });
      }

      res.status(200).send("OK");
    } catch (error) {
      console.error("Erro ao processar webhook Asaas", error);
      res.status(500).send("Webhook processing failed");
    }
  }
);

