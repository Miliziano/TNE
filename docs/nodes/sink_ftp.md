<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# FTP/SFTP Sink  `sink_ftp`

**Categoria:** Output  ·  **Icona:** `⇄`  ·  **Colore:** `#3ddc84`

Scrive file su server FTP, FTPS o SFTP.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `sink`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Protocolli e cifratura (P337).**
- `ftp`: FTP in chiaro. Password e file viaggiano leggibili: solo su reti fidate.
- `ftps`: **FTPS esplicito** — connessione sulla porta FTP (di solito 21), poi `AUTH TLS`
  **prima** del login; canale dati protetto (`PROT P`); certificato del server verificato
  con i certificati di sistema. Se il server non parla TLS, o il certificato non è
  fidato, il nodo **fallisce** (non ripiega in chiaro). L'FTPS *implicito* (porta 990)
  non è supportato. Fino al P336 `ftps` si collegava per errore in chiaro.
- `sftp`: SSH (password o chiave).

I trasferimenti FTP/FTPS sono **binari**: il file arriva byte per byte com'è (niente
conversione dei fine riga).
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
