import type { ProviderTypeInfo } from '../../shared/types';
import { africastalking } from './africastalking';
import { clicksend } from './clicksend';
import { generic } from './generic';
import { infobip } from './infobip';
import { plivo } from './plivo';
import { sandbox } from './sandbox';
import { sinch } from './sinch';
import { telnyx } from './telnyx';
import { twilio } from './twilio';
import type { ProviderDefinition } from './types';
import { vonage } from './vonage';

export const PROVIDERS: ProviderDefinition[] = [twilio, vonage, plivo, sinch, telnyx, infobip, clicksend, africastalking, generic, sandbox];

const byType = new Map(PROVIDERS.map((p) => [p.type, p]));

export function getProviderDefinition(type: string): ProviderDefinition | undefined {
  return byType.get(type);
}

export function providerTypeInfo(def: ProviderDefinition): ProviderTypeInfo {
  return {
    type: def.type,
    label: def.label,
    description: def.description,
    website: def.website,
    coverage: def.coverage,
    fields: def.fields,
    senderRequired: def.senderRequired,
    deliveryReports: def.deliveryReports,
    webhookHelp: def.webhookHelp,
  };
}

export function isSecretField(def: ProviderDefinition, key: string): boolean {
  const f = def.fields.find((field) => field.key === key);
  return !!f && (f.type === 'secret' || !!f.secret);
}
