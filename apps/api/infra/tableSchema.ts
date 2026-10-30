/**
 * Single source of truth for the gdp-backend DynamoDB table schema.
 * Consumed by both CDK (dev / prod table provisioning)
 * and integration test setup (DynamoDB Local).
 */

export const tableSchema = {
  partitionKey: 'pk',
  sortKey: 'sk',
  ttlAttribute: 'ttlAt',
  globalSecondaryIndexes: [
    {
      indexName: 'GSI1',
      partitionKey: 'GSI1PK',
      sortKey: 'GSI1SK',
    },
    {
      indexName: 'GSI2',
      partitionKey: 'GSI2PK',
    },
  ],
} as const;
