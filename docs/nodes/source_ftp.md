<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# FTP/SFTP Source  `source_ftp`

**Categoria:** Input  ·  **Icona:** `⇄`  ·  **Colore:** `#4a9eff`

Legge file da server FTP, FTPS o SFTP.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `scan`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** `projection`, `limit`

**Porte di ingresso (statiche):**

- `input` · ruolo data · archi: 1 · righe: 1

**Porte di uscita (statiche):**

- `output` · ruolo data

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
