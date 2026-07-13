INSERT INTO "chains" ("id", "name", "nativeSymbol", "explorerTxUrl", "explorerAddressUrl") VALUES
  ('ETHEREUM', 'Ethereum', 'ETH', 'https://etherscan.io/tx/{hash}', 'https://etherscan.io/address/{address}'),
  ('BASE', 'Base', 'ETH', 'https://basescan.org/tx/{hash}', 'https://basescan.org/address/{address}'),
  ('ARBITRUM', 'Arbitrum One', 'ETH', 'https://arbiscan.io/tx/{hash}', 'https://arbiscan.io/address/{address}')
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "nativeSymbol" = EXCLUDED."nativeSymbol",
  "explorerTxUrl" = EXCLUDED."explorerTxUrl",
  "explorerAddressUrl" = EXCLUDED."explorerAddressUrl";
