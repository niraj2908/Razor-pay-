-- CreateEnum
CREATE TYPE "RazorpayPaymentStatus" AS ENUM ('CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RiskDiagnosis" AS ENUM ('CONFIRMED_FAILURE', 'PENDING', 'STATE_UNCERTAIN', 'CUSTOMER_ABANDONMENT', 'NETWORK_DEGRADATION', 'OTHER_RECOVERABLE');

-- CreateEnum
CREATE TYPE "RecoveryDecision" AS ENUM ('ACT', 'WAIT', 'STOP', 'ESCALATE');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('NONE', 'RETRY_NOW', 'RETRY_LATER', 'PAYMENT_LINK', 'PAYMENT_METHOD_CHANGE', 'CUSTOMER_CONTACT', 'HUMAN_ESCALATION', 'STOP_RECOVERY');

-- CreateEnum
CREATE TYPE "ExperimentGroup" AS ENUM ('CONTROL', 'TREATMENT');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('REAL_RAZORPAY_TEST_MODE', 'SIMULATED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'LLM', 'HUMAN');

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "razorpayAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "razorpayCustomerId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT,
    "razorpayOrderId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT,
    "customerId" TEXT,
    "razorpayPaymentId" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "method" TEXT,
    "status" "RazorpayPaymentStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT,
    "razorpayEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_risk_events" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "diagnosis" "RiskDiagnosis" NOT NULL,
    "amountAtRisk" INTEGER NOT NULL,
    "naturalRecoveryProbability" DOUBLE PRECISION,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "dataSource" "DataSource" NOT NULL DEFAULT 'SIMULATED',

    CONSTRAINT "revenue_risk_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidate_actions" (
    "id" TEXT NOT NULL,
    "revenueRiskEventId" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "predictedSuccessProbability" DOUBLE PRECISION NOT NULL,
    "incrementalLift" DOUBLE PRECISION NOT NULL,
    "estimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expectedNetValue" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "revenueRiskEventId" TEXT NOT NULL,
    "decisionType" "RecoveryDecision" NOT NULL,
    "chosenActionId" TEXT,
    "expectedIncrementalValue" DOUBLE PRECISION,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_evidence" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "evidenceType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT,
    "passed" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_policies" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "razorpayReferenceId" TEXT,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" TEXT NOT NULL,
    "revenueRiskEventId" TEXT NOT NULL,
    "recovered" BOOLEAN NOT NULL,
    "recoveredAmount" INTEGER,
    "attributedIncremental" BOOLEAN,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RUNNING',

    CONSTRAINT "experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_assignments" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "revenueRiskEventId" TEXT NOT NULL,
    "group" "ExperimentGroup" NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "experiment_results" (
    "id" TEXT NOT NULL,
    "experimentId" TEXT NOT NULL,
    "group" "ExperimentGroup" NOT NULL,
    "populationCount" INTEGER NOT NULL,
    "totalAtRiskAmount" INTEGER NOT NULL,
    "totalRecoveredAmount" INTEGER NOT NULL,
    "interventionCount" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experiment_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_events" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "instrument" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "source" "DataSource" NOT NULL DEFAULT 'SIMULATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "network_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_predictions" (
    "id" TEXT NOT NULL,
    "revenueRiskEventId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "predictedValue" DOUBLE PRECISION NOT NULL,
    "inputFeatures" JSONB,
    "predictedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_razorpayAccountId_key" ON "merchants"("razorpayAccountId");

-- CreateIndex
CREATE INDEX "customers_merchantId_idx" ON "customers"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "customers_merchantId_razorpayCustomerId_key" ON "customers"("merchantId", "razorpayCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_razorpayOrderId_key" ON "orders"("razorpayOrderId");

-- CreateIndex
CREATE INDEX "orders_merchantId_idx" ON "orders"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_razorpayPaymentId_key" ON "payments"("razorpayPaymentId");

-- CreateIndex
CREATE INDEX "payments_merchantId_idx" ON "payments"("merchantId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_razorpayEventId_key" ON "payment_events"("razorpayEventId");

-- CreateIndex
CREATE INDEX "payment_events_eventType_idx" ON "payment_events"("eventType");

-- CreateIndex
CREATE INDEX "payment_events_receivedAt_idx" ON "payment_events"("receivedAt");

-- CreateIndex
CREATE INDEX "revenue_risk_events_merchantId_idx" ON "revenue_risk_events"("merchantId");

-- CreateIndex
CREATE INDEX "revenue_risk_events_diagnosis_idx" ON "revenue_risk_events"("diagnosis");

-- CreateIndex
CREATE INDEX "revenue_risk_events_resolvedAt_idx" ON "revenue_risk_events"("resolvedAt");

-- CreateIndex
CREATE INDEX "candidate_actions_revenueRiskEventId_idx" ON "candidate_actions"("revenueRiskEventId");

-- CreateIndex
CREATE INDEX "decisions_revenueRiskEventId_idx" ON "decisions"("revenueRiskEventId");

-- CreateIndex
CREATE INDEX "decisions_decisionType_idx" ON "decisions"("decisionType");

-- CreateIndex
CREATE INDEX "decision_evidence_decisionId_idx" ON "decision_evidence"("decisionId");

-- CreateIndex
CREATE INDEX "merchant_policies_merchantId_idx" ON "merchant_policies"("merchantId");

-- CreateIndex
CREATE INDEX "executions_decisionId_idx" ON "executions"("decisionId");

-- CreateIndex
CREATE INDEX "executions_status_idx" ON "executions"("status");

-- CreateIndex
CREATE INDEX "outcomes_revenueRiskEventId_idx" ON "outcomes"("revenueRiskEventId");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_assignments_revenueRiskEventId_key" ON "experiment_assignments"("revenueRiskEventId");

-- CreateIndex
CREATE INDEX "experiment_assignments_experimentId_idx" ON "experiment_assignments"("experimentId");

-- CreateIndex
CREATE UNIQUE INDEX "experiment_results_experimentId_group_key" ON "experiment_results"("experimentId", "group");

-- CreateIndex
CREATE INDEX "network_events_instrument_idx" ON "network_events"("instrument");

-- CreateIndex
CREATE INDEX "network_events_startedAt_idx" ON "network_events"("startedAt");

-- CreateIndex
CREATE INDEX "model_predictions_revenueRiskEventId_idx" ON "model_predictions"("revenueRiskEventId");

-- CreateIndex
CREATE INDEX "model_predictions_modelName_modelVersion_idx" ON "model_predictions"("modelName", "modelVersion");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_idx" ON "audit_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_risk_events" ADD CONSTRAINT "revenue_risk_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_risk_events" ADD CONSTRAINT "revenue_risk_events_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_actions" ADD CONSTRAINT "candidate_actions_revenueRiskEventId_fkey" FOREIGN KEY ("revenueRiskEventId") REFERENCES "revenue_risk_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_revenueRiskEventId_fkey" FOREIGN KEY ("revenueRiskEventId") REFERENCES "revenue_risk_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_chosenActionId_fkey" FOREIGN KEY ("chosenActionId") REFERENCES "candidate_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decision_evidence" ADD CONSTRAINT "decision_evidence_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_policies" ADD CONSTRAINT "merchant_policies_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_revenueRiskEventId_fkey" FOREIGN KEY ("revenueRiskEventId") REFERENCES "revenue_risk_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_revenueRiskEventId_fkey" FOREIGN KEY ("revenueRiskEventId") REFERENCES "revenue_risk_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "experiment_results" ADD CONSTRAINT "experiment_results_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "experiments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_events" ADD CONSTRAINT "network_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_predictions" ADD CONSTRAINT "model_predictions_revenueRiskEventId_fkey" FOREIGN KEY ("revenueRiskEventId") REFERENCES "revenue_risk_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
