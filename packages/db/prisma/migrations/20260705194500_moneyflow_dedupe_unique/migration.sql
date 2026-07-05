-- Add unique constraint on MoneyFlowEdge for deduplication
ALTER TABLE "money_flow_edges" 
ADD CONSTRAINT "money_flow_edges_txHash_sourceAddress_destinationAddress_actionType_key" 
UNIQUE ("txHash", "sourceAddress", "destinationAddress", "actionType");