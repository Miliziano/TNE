<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Mail Sink  `mail_sink`

**Categoria:** Output  ·  **Icona:** `✉`  ·  **Colore:** `#4a9eff`

Invia email tramite SMTP, SendGrid, Amazon SES o Mailgun.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `sink`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Priorità (P367).** *High* aggiunge `X-Priority: 1 (Highest)` e `Importance: High`,
*Low* `X-Priority: 5 (Lowest)` e `Importance: Low`; *Normal* non aggiunge niente.

**SMTP senza autenticazione (P367).** Con l'utente vuoto il nodo non tenta l'AUTH: un relay
interno che non chiede credenziali ora funziona (prima ogni invio falliva con "No
compatible authentication mechanism").

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
