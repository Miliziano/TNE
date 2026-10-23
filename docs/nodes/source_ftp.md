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

**Lettura (P362).** Un file scaricato si legge col lettore del File Input: stessi
formati (testo, CSV, TSV, Excel, JSON, JSON Lines, XML, binario), stesse codifiche e,
per CSV/TSV/Excel, lo stesso mapping (colonna nel file → nome, tipo). *Raw* mette
tutto il file, come testo, nel campo `content`. Ogni riga porta anche `_filename`,
`_filepath`, `_filesize`, `_modified_at`.

**Ricerca.** Il filtro vale sui nomi dei file; con *Search in subfolders* si
esplorano tutte le sottocartelle (fino a 32 livelli). In FTP la lista usa MLSD (o
LIST): dimensione, data e cartelle sono veri, quindi anche l'ordine per data o
dimensione funziona. Ordine dei file, poi *Max files per run*.

**Compressione.** GZIP (un file) o ZIP (ogni file dell'archivio, nel formato scelto).
BZIP2 non è supportato.

**Wait for files.** Interroga la cartella ogni N secondi (minimo 5) finché almeno un
file corrisponde, poi li legge e finisce. Per non aspettare all'infinito si imposta
*Max run time* nella scheda Advanced. Con *Delete* o *Move* dopo la lettura la
cartella funziona da coda.

**Dopo la lettura.** *Move* (nella cartella d'archivio, creata se manca; un file con
lo stesso nome viene sostituito) o *Delete*, solo per i file letti senza errori. Se lo
spostamento o la cancellazione falliscono, il nodo fallisce: un file rimasto al suo
posto verrebbe riletto la volta dopo.

**Errori su un file** (scaricamento, decompressione, lettura): *Skip* (avviso e si
continua), *Stop*, o *Move to error directory* (cartella da indicare).

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
