-- DropIndex
DROP INDEX "executions_decisionId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "executions_decisionId_key" ON "executions"("decisionId");
