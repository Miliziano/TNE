import type { ResourceKind, ResourceAction } from '../types'

/**
 * Fonte UNICA delle azioni "Aggiungi al canvas" per kind di risorsa.
 *
 * Usata sia dal template alla creazione della risorsa (LaneCanvas) sia da
 * ActionButtons in fase di rendering. Derivare le azioni dal kind — invece di
 * leggerle solo da quelle salvate nella risorsa alla creazione — fa sì che
 * anche le risorse create PRIMA che il nodo corrispondente esistesse mostrino
 * l'azione. Es.: una risorsa LDAP creata in fetta 1 (quando ldap_source non
 * esisteva ancora) vede «query» non appena il nodo arriva in fetta 2, senza
 * doverla ri-creare. Aggiungere qui l'azione «auth» quando arriverà ldap_auth.
 */
export const RESOURCE_ACTIONS: Partial<Record<ResourceKind, ResourceAction[]>> = {
  ldap: [
    { id: 'query', label: 'Aggiungi come query (source)', nodeType: 'ldap_source', propsOverride: {} },
    { id: 'auth',  label: 'Aggiungi come autenticatore',   nodeType: 'ldap_auth',   propsOverride: {} },
  ],
  github: [
    { id: 'source', label: 'Aggiungi come source GitHub', nodeType: 'github_source', propsOverride: {} },
  ],
}

export function actionsForKind(kind: ResourceKind): ResourceAction[] {
  return RESOURCE_ACTIONS[kind] ?? []
}
