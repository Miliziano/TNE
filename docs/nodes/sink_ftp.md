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

**Cosa fa (P356).** Raccoglie tutte le righe e carica il file in un solo trasferimento
quando l'ingresso finisce.
- *Percorso*: cartella remota + nome file, con `{date}` (2026-10-23), `{datetime}`
  (20261023_143000), `{timestamp}` (secondi Unix), `{run_id}`. Nome vuoto = la cartella
  è il percorso completo (progetti precedenti).
- *Modalità*: **Overwrite**; **Append** (in coda; l'intestazione CSV solo se il file è
  nuovo o vuoto; solo CSV, TSV, JSON Lines o valore di campo, senza ZIP); **New file**
  (se il nome è preso: `_1`, `_2`… prima dell'estensione); **Error** (fallisce se il
  file esiste).
- *Contenuto*: righe nel formato scelto (CSV, TSV, JSON, JSON Lines, XML, Excel .xlsx)
  oppure il valore di un campo (testo o base64 — es. l'uscita del Report Generator).
- *Encoding* dei formati di testo: UTF-8, UTF-16 (LE con BOM), ISO-8859-1,
  Windows-1252; un carattere non rappresentabile diventa `?` e il log lo conta.
- *Compressione*: GZIP o ZIP (un file nell'archivio); l'estensione si aggiunge al nome
  se manca.
- *Scrittura atomica*: prima `nome.tmp`, poi rinomina (non in append).
- *Permessi*: ottale (es. `644`); su SFTP con setstat, su FTP con `SITE CHMOD` — se il
  server non lo supporta il file resta scritto e il log lo dice.
- *Uscita*: **Signal** (una riga: status, rows_written, bytes_written, file_path,
  file_name, completed_at, error_message, duration_ms) o **Passthrough** (le righe,
  dopo la scrittura).
- *Retry* (scheda Advanced): ripete connessione e upload — l'upload non in append.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
