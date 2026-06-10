import type { PreTokenGenerationTriggerEvent } from 'aws-lambda';

export async function handler(event: PreTokenGenerationTriggerEvent) {
  const tenantId = event.request.userAttributes['custom:tenant_id'];
  const email = event.request.userAttributes.email;

  if (!tenantId) {
    throw new Error('tenant_id attribute missing - login denied');
  }
  if (!email) {
    throw new Error('email attribute missing - login denied');
  }

  const claimsToAddOrOverride = {
    tenant_id: tenantId,
    email,
  };

  (event as any).response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride,
      },
      accessTokenGeneration: {
        claimsToAddOrOverride,
      },
    },
  };

  return event;
}
