# HANDOFF — Catena di fiducia degli artifact (FIRMA, v1)

> Design della firma e verifica degli `.ffart` prima dell'esecuzione in una runtime.
> Decisione di questa fase: **solo autenticità (firma)**. La riservatezza (cifratura)
> è fuori scope v1 ed è agganciabile dopo senza rifare nulla (vedi §14).
> Da leggere insieme a: `HANDOFF.md` (generale), `flowpilot-rilascio`, `flowpilot-distribuzione`.

---

## ✅ STATO DI IMPLEMENTAZIONE — aggiornamento (18 settembre)

La catena è **implementata e in albero**: firma P314–P327, hardening dello studio
P328–P331. Alcune scelte sono cambiate rispetto al design originale qui sotto:
**dove differiscono, vale questo blocco.**

### Mappa patch (firma)
- **P314** forma canonica del piano + planHash — TS `src/ir/canonicalPlan.ts` ⟷ Rust
  `src-tauri/src/signing/canonical.rs`, vettore condiviso `vectors/canonical_plan_v1.json`.
- **P315** l'export usa il planHash canonico.
- **P316** nucleo firma Rust: `keys.rs` + `sign.rs` (Ed25519, sign/verify del manifesto).
- **P317** comando Tauri `artifact_seal` + l'export produce il `.ffart` **firmato**.
- **P318** verifica lato runner (`verify.rs`, 7 passi fail-closed) + trust store
  (`trust.rs`) + modalità `FLOWPILOT_SIGNATURE_MODE = off | warn | enforce`.
- **P319** identità di firma in CompileModal + esportazione voce trust store.
- **P320** **vault**: chiave privata **cifrata a riposo** (`vault.rs`).
- **P321** seal/identity agganciati al vault; comandi `vault_*`; rimosso il salvataggio in chiaro.
- **P322** voce UI dedicata **Signing** (`SigningKeyModal.tsx`).
- **P326** **Modo A** (vedi sotto).
- **P327** **zeroize** del seme/chiavi in RAM.

### Delta di design rispetto al testo sotto
1. **Hash = SHA-256** (non BLAKE3): riusa il prefisso `sha256:` e `sha2` già in albero. (§15.1)
2. **Solo autenticità (firma)**; cifratura degli artifact rimandata. (§0/§14)
3. **Busta = Modo A** (sostituisce §5): il **MANIFESTO è l'unica fonte di verità** e
   **assorbe tutti i campi operativi** (planName, monitor, logLevel, studio, studioVersion,
   profile, platform, requiredSecrets, planVersion, engineVersionRange, createdAt) più i
   calcolati/autoritativi (planHash, keyId, hashAlg, sigAlg). La busta è minimale:
   `{ formatVersion, kind, manifest, sig, publicKey, plan }` — nessun campo operativo
   fuori dal manifesto (là non sarebbe firmato). Il runner li legge dal **manifesto
   verificato** (`man`, fallback alla radice per piani nudi). → Chiude il buco per cui
   cambiare `monitor`/`logLevel` in transito **non** rompeva la firma.
4. **Chiave a riposo CIFRATA** (aggiorna §7): file `~/.flowpilot/signing-key.json` con
   `keyId`/`public` in chiaro e `enc = { kdf:"argon2id", salt, nonce, ciphertext(seed) }`.
   Flusso: passphrase → **argon2id** → chiave → **XChaCha20-Poly1305** sul seme. Sblocco
   **in memoria per la sessione** (`vault.rs`) e **zeroize** al lock/chiusura (seme, chiave
   derivata e buffer decifrato azzerati dalla RAM). UI: voce **Signing** (genera/importa/
   sblocca/blocca/esporta pubblica). Firma **libera multi-sviluppatore**: il trust store è
   un allowlist a più voci, nessun coordinamento tra sviluppatori.

### Modello di minaccia (cosa protegge, e cosa NO)
1. **Il vero gioiello è `trust-store.json` sulla runtime.** Chi può SCRIVERLO decide di
   chi ci si fida → permessi del file e sicurezza dell'host sono portanti quanto la cripto.
2. **Cifratura a riposo ≠ desktop compromesso.** Mentre è sbloccata, la chiave è in RAM;
   un malware-come-utente può estrarla. Mitigato con zeroize *dopo* l'uso; cura vera = HSM.
3. **La firma prova *chi*, non *cosa*.** Un firmatario autorizzato può produrre un artifact
   ostile. Difesa complementare = policy nodi pericolosi + sandbox della runtime (DA FARE).
4. **Copertura firma:** con Modo A copre piano + TUTTO il manifesto (chiuso il buco del §4
   originale sui campi non firmati).
5. **Forza della passphrase:** argon2id rallenta il brute-force offline sul file rubato, ma
   una passphrase debole resta attaccabile.
6. **Revoca:** il runner verifica a ogni avvio → la revoca (togliere/`revoked` nel trust
   store) ha effetto al run successivo. Niente scadenza automatica (`notBefore/notAfter` non
   ancora applicati); con lo scheduler "caldo" futuro la cache andrà invalidata al cambio.
7. **Ci si fida del BINARIO del runner.** Firmiamo gli artifact, non gli eseguibili
   (supply-chain = capitolo a sé: `cargo audit`/`npm audit`, firma dei binari).
8. **`engineVersionRange` = `"*"`:** gancio, non ancora un vincolo reale.

> Hardening dello studio (P328–P331) — protegge l'INTERA catena, perché una XSS→RCE nella
> webview scavalcherebbe firma e vault: capability Tauri minime (via `shell:*`/`fs:*`), CSP
> `default-src 'self'` (blocca gli script iniettati), icone/font bundlati in locale (niente
> CDN), e guardrail ESLint anti-XSS. Dettaglio nel `HANDOFF.md` generale.

---

## 0. Stato e decisioni già prese

- **Solo firma** in v1 (autenticità + integrità + attribuzione). Niente cifratura ora.
- Firme **Ed25519** (crate `ed25519-dalek`). Hash del piano canonico con **BLAKE3**
  (fallback/alternativa SHA-256 — decisione in §13/§15).
- **Nessuna crittografia scritta in casa.** Solo crate audited.
- La runtime tiene un **trust store** di chiavi *pubbliche* autorizzate. Nel modello
  solo-firma **la runtime non ha una propria chiave privata** (serviva solo per la
  cifratura, rimandata).
- Tutto **offline / air-gap friendly**: l'unico passo di enrollment è portare una
  chiave *pubblica* dello sviluppatore nel trust store, out-of-band, una volta.
- **Verifica all'AMMISSIONE, non a ogni esecuzione** → costo crittografico fuori dal
  percorso caldo, compatibile con lo scheduling near-real-time futuro (§8).
- Questo lavoro è la **Fase B** dei campi di provenienza già presenti nell'`.ffart`
  (§2): oggi `planHash`/`studio`/`planVersion` sono *dichiarati e non verificati*.

---

## 1. Scopo e non-scopo (mini modello di minaccia)

**Cosa garantisce (in scope v1):**
- *Autenticità*: la runtime esegue solo artifact firmati da una chiave che essa
  riconosce come autorizzata → risponde a "eseguo solo gli artifact permessi?".
- *Integrità*: l'artifact non è stato manomesso dopo la firma (`planHash` finalmente
  **enforced**, non solo dichiarato).
- *Attribuzione*: si sa **quale sviluppatore** ha prodotto l'artifact (audit).

**Cosa NON garantisce (onesto e da mettere agli atti):**
- *Riservatezza*: l'artifact viaggia in chiaro; logica, SQL, host, struttura sono
  leggibili. (Rimandata: §14.)
- *Innocenza del firmatario*: la firma dice *chi*, non che l'artifact sia benigno. Un
  firmatario autorizzato può produrre un artifact dannoso. Contro questo servono la
  **policy dei nodi pericolosi** e la **sandbox della runtime** (capitolo di sicurezza
  P1, separato da qui).
- *Furto della chiave privata*: se la privata di uno sviluppatore è compromessa, la
  difesa è la **revoca** (§7).
- *Autenticità del canale di enrollment*: quando l'admin importa una chiave pubblica
  nel trust store, quel passaggio deve essere autentico (out-of-band verificato via
  fingerprint). Fuori dal software: è procedura.

---

## 2. Aggancio all'esistente — Fase A → Fase B

L'`.ffart` odierno è un JSON con, al top-level (verificato nel runner):
`formatVersion`, `planName`, `planVersion {label,id}`, `studio {id,label}`,
`studioVersion`, `planHash`, `monitor`, `logLevel`, `plan {…, run_id}`, `run_id`.

Il `flowpilot_runner` oggi li **riporta e basta**: commento nel sorgente —
*"PROVENIENZA (fase A): … sono dati DICHIARATI dall'artifact, non verificati."*
Ossia `planHash` è cosmetico e `studio` è auto-dichiarato.

**Fase B (questo design):** gli stessi campi diventano *verificabili*. Aggiungiamo un
**manifesto firmato** che copre `planHash` (ricalcolato in modo canonico) e l'identità
del firmatario; il runner verifica prima di ammettere. Non buttiamo via nulla: i campi
di provenienza restano, ma smettono di essere sulla parola.

---

## 3. Componenti crittografici

- **Firma:** Ed25519 (`ed25519-dalek`). Chiavi piccole (32B pub / 32B seed), verifica
  ~20–50 µs, nessun parametro da sbagliare.
- **Hash del piano canonico:** BLAKE3 (`blake3`) — velocissimo; oppure SHA-256
  (`sha2`, già in albero: usato dalle FPEL `hash_sha256`). L'algoritmo scelto è
  dichiarato nel manifesto (`hashAlg`) per non incastrarsi in futuro.
- **Codifica chiavi/firme:** testo, formato robusto e copincollabile (es. base64url,
  o formato riga stile `age`/OpenSSH per le pubbliche). Da fissare in §15.
- **Regola d'oro:** nessuna primitiva fatta a mano; nessun formato busta inventato
  oltre a JSON+campi qui sotto.

---

## 4. Il piano canonico (punto critico #1)

Firma e `planHash` devono essere **riproducibili bit-per-bit** su studio (che firma) e
runtime (che riverifica). Serve una **canonicalizzazione** deterministica del piano.

**Regole della forma canonica (JSON canonico):**
- chiavi degli oggetti **ordinate** lessicograficamente;
- **nessuno spazio** insignificante; UTF-8; escape unicode normalizzato (NFC);
- numeri in forma normalizzata (niente `1.0` vs `1`, niente zeri/segni ridondanti) —
  o, più sicuro, **serializzare i numeri come stringhe** già in fase di piano;
- array nell'**ordine dichiarato** (l'ordine è semantico e va preservato).

**Cosa entra nell'hash = solo la semantica di esecuzione.** Vanno **esclusi** i campi
volatili/non-esecutivi che oggi girano nel file ma non cambiano *cosa fa* la pipeline:
- coordinate/zoom/UI dei nodi (posizioni sul canvas), colori, note visive;
- `run_id` e timestamp generati all'export;
- eventuali id di sessione.

→ Serve una funzione `canonical_plan(plan) -> bytes` **condivisa** tra studio (TS) e
runtime (Rust) con **la stessa identica specifica**. Questa è la causa #1 di verifiche
che "a volte falliscono": va scritta una volta, testata con vettori di test condivisi
(stesso input → stesso hash in TS e in Rust).

> Nota: oggi `planHash` esiste già ma probabilmente **non** è calcolato su questa forma
> canonica. Parte del lavoro è *definire* l'algoritmo e allineare l'export a esso.

---

## 5. Manifesto firmato e busta `.ffart`

L'`.ffart` firmato resta JSON, con un blocco **`manifest`** e un blocco **`sig`**
accanto al `plan`. Il manifesto è **ciò che si firma** (per intero, non solo il
`planHash`: così non si può sostituire un metadato senza invalidare la firma).

Struttura (indicativa):

```
{
  "formatVersion": 2,
  "manifest": {
    "planHash":       "<hex BLAKE3 del piano canonico>",
    "hashAlg":        "blake3",
    "sigAlg":         "ed25519",
    "engineVersionRange": ">=0.9 <2.0",   // la runtime rifiuta motori incompatibili
    "keyId":          "<fingerprint della chiave pubblica del firmatario>",
    "studio":         { "id": "...", "label": "..." },
    "planName":       "...",
    "planVersion":    { "label": "...", "id": "..." },
    "createdAt":      "2026-09-16T...Z"
  },
  "sig": "<firma Ed25519 sui BYTE CANONICI di `manifest`>",
  "plan": { ... }            // il piano vero (immutato)
}
```

Cosa si firma esattamente: `sig = Ed25519_sign(privkey, canonical_bytes(manifest))`.
Poiché `manifest.planHash` copre il `plan`, la firma copre transitivamente **piano +
metadati**. `formatVersion`, `keyId`, `hashAlg`, `sigAlg` restano leggibili in chiaro
per poter *scegliere come* verificare prima di verificare.

Il piano **nudo** (senza `manifest`/`sig`) resta accettabile solo in modalità di
transizione (§10); in `enforce` viene rifiutato.

---

## 6. Trust store della runtime

La runtime tiene l'elenco delle chiavi **pubbliche** autorizzate. Nel solo-firma non ha
chiavi private.

Per ogni chiave: `keyId` (fingerprint), `publicKey`, `owner` (chi è lo sviluppatore),
`stato` (`active` | `revoked` | `expired`), validità `notBefore/notAfter` (opzionale),
`note`. Il trust store nel suo insieme porta una **generazione/versione** (un intero o
un hash), che serve alla cache (§8).

- **Posizione:** file protetto (permessi stretti) in una dir di configurazione della
  runtime, es. `~/.flowpilot/trust/keys.json` (o percorso da env). Solo l'admin scrive.
- **Aggiornamento autenticato:** su reti critiche, il trust store si aggiorna
  out-of-band (chiavetta/deploy controllato). Se un giorno lo si vorrà aggiornare da
  remoto, quell'update va **a sua volta firmato** da una chiave admin — ma è fuori
  scope v1.

---

## 7. Ciclo di vita delle chiavi (tutto offline)

- **Generazione:** lo studio genera la coppia dello sviluppatore (comando dedicato).
  La **privata** resta sulla macchina dello sviluppatore, protetta (keychain OS o file
  a permessi stretti, mai nel repo). Si può legare al `studio.id` già esistente.
- **Esportazione:** lo studio esporta la **sola pubblica** + il `keyId` (fingerprint).
- **Enrollment:** l'admin della runtime aggiunge la pubblica al trust store,
  verificando il fingerprint out-of-band (telefonata/canale fidato). Una volta.
- **Rotazione:** si aggiunge la nuova chiave `active` **prima** di ritirare la vecchia;
  entrambe coesistono nel trust store durante la transizione.
- **Revoca:** si porta la chiave a `revoked` (o la si rimuove). Vedi §8 per come la
  revoca raggiunge anche gli artifact già "caldi".
- **Air-gap:** in nessun momento serve connettività studio↔runtime. Lo sviluppatore
  cifra… pardon, *firma* da qualsiasi rete isolata; solo la pubblica ha attraversato
  il confine, all'enrollment.

---

## 8. Ammissione vs esecuzione (near-real-time)

Due momenti distinti, ed è ciò che tiene la firma **fuori dal percorso caldo**:

- **Ammissione** (una tantum, al deploy/registrazione dell'artifact): esegui l'intera
  verifica (§9). Se passa, metti in **cache** il piano *già parsato e pronto*, indicizzato
  per **content-hash** (`planHash`), insieme a: `keyId` firmatario, generazione del
  trust store al momento dell'ammissione, esito.
- **Esecuzione** (ogni trigger dello scheduler futuro): riusa il piano **già ammesso**
  dalla cache. **Zero crittografia per tick.** Uno scheduler che rilancia lo stesso
  artifact ogni 2 s verifica una sola volta.
- **Runner longevo:** il modello caldo (motore su, connessioni in pool) carica+verifica
  all'ammissione e resta caldo. (Anche lo spawn a freddo ri-verificherebbe solo quei
  ~µs: mai un problema; l'importante è non verificare *per riga*.)
- **Revoca e cache:** la cache è legata alla **generazione del trust store**. Quando il
  trust store cambia (revoca/rotazione), gli artifact ammessi vengono **rivalidati**
  (subito o su timer lento, es. ogni N minuti). Così il percorso caldo resta pulito **e**
  la revoca viene comunque onorata in tempi ragionevoli, senza ri-verificare a ogni tick.

---

## 9. Flusso di verifica lato runner (ordine dei controlli)

All'ammissione, in quest'ordine (fail-closed: qualunque passo fallito → **rifiuto
esplicito** + audit):

1. **Parse** della busta; leggi `formatVersion`. Se sconosciuta → rifiuta.
2. **Compatibilità motore:** `engineVersionRange` include la versione del motore della
   runtime? No → rifiuta (evita che un artifact giri su un motore che lo interpreta
   diversamente).
3. **Firma:** `Ed25519_verify(pub(keyId), sig, canonical_bytes(manifest))`. Fallita →
   rifiuta.
4. **Autorizzazione:** `keyId` presente nel trust store **e** stato `active` **e** entro
   validità. No → rifiuta (chiave sconosciuta/revocata/scaduta).
5. **Integrità:** ricalcola `planHash` dal `plan` con `canonical_plan` + `hashAlg`, e
   confronta con `manifest.planHash`. Diverso → rifiuta (manomissione).
6. **Policy runtime:** l'artifact usa nodi vietati su questa runtime (es. shell/ssh
   disabilitati)? Sì → rifiuta. (Gancio verso il capitolo sandbox/policy P1.)
7. **Ammetti:** metti in cache (§8) ed emetti l'evento di provenienza verificata (§11).

---

## 10. Transizione e compatibilità

Esistono `.ffart` non firmati (formato attuale). Introduciamo una **modalità della
runtime**:

- `off` — nessuna verifica (solo per sviluppo locale isolato).
- `warn` — verifica se la firma c'è; se manca/fallisce **avvisa** ma esegue (grace
  period per migrare gli artifact esistenti).
- `enforce` — **rifiuta** tutto ciò che non è firmato&valido. **Default per il rilascio
  pubblico.**

Il passaggio `warn → enforce` è la data-cutoff oltre la quale ogni pipeline dev'essere
ri-esportata firmata. Da documentare nel manuale di distribuzione.

---

## 11. Audit e attribuzione

Ogni ammissione/esecuzione registra nel **monitor** (che già emette la provenienza):
`planHash`, `keyId` firmatario, `owner`, esito verifica, generazione trust store. Così
"chi ha eseguito cosa, con quale artifact, autorizzato da quale chiave" diventa una riga
d'audit verificata — non più auto-dichiarata. (Ricorda: il monitor va comunque messo in
sicurezza — TLS, auth in lettura, bind locale — è il capitolo P0 separato.)

---

## 12. Superfici da toccare

**Studio (Tauri/React):**
- comandi: genera coppia, esporta pubblica (+fingerprint), mostra il proprio `keyId`;
  (si appoggia a `studio_identity` già esistente).
- export/compila: calcolare `planHash` **canonico**, costruire `manifest`, **firmare**
  con la privata locale, scrivere la busta.
- protezione della privata (keychain OS via un provider dedicato, come per i segreti).

**Runtime / `flowpilot_runner`:**
- `canonical_plan` in Rust (gemello bit-esatto di quello TS, con vettori di test comuni).
- verifica §9 all'ammissione; cache per `planHash` legata alla generazione del trust store.
- modalità `off|warn|enforce` (env/config).

**CLI amministrativa (trust store):**
- `trust add <pubkey>`, `trust list`, `trust revoke <keyId>`, `trust show` — con
  fingerprint ben visibile per l'enrollment out-of-band.

---

## 13. Dipendenze / crate

- `ed25519-dalek` (firme), `blake3` (hash) — o `sha2` se si preferisce riusare quanto
  già in albero.
- lato TS: una lib Ed25519 audited (es. `@noble/ed25519`) + BLAKE3/SHA-256 coerenti col
  Rust. **I vettori di test condivisi sono obbligatori**, non opzionali.

---

## 14. Estensione futura — riservatezza (senza rifare)

Quando/se servirà cifrare (reti critiche): busta **firma-poi-cifra**. La runtime avrà
allora una *sua* coppia; la sua **pubblica** viene distribuita agli sviluppatori una
volta; l'artifact firmato viene cifrato **per** quella pubblica (formato `age` / X25519
+ AEAD), **multi-destinatario** se deve girare su più runtime. Resta tutto offline:
allo sviluppatore basta la pubblica dell'ambiente bersaglio. Il §5 non cambia — la busta
firmata diventa il *plaintext* dell'involucro cifrato. Nessuna rilavorazione della firma.

---

## 15. Punti aperti (da decidere prima di implementare)

1. **Hash:** BLAKE3 (più veloce) vs SHA-256 (già in albero, familiare). Propongo BLAKE3.
2. **`keyId`:** fingerprint della pubblica (indipendente) vs riuso del `studio.id`.
   Propongo fingerprint della pubblica (l'identità è la chiave, non l'installazione).
3. **Forma esatta del piano canonico:** confermare la lista di campi ESCLUSI (UI,
   `run_id`, timestamp) e la regola sui numeri (stringhe vs normalizzati). È il pezzo da
   blindare per primo, con i vettori di test.
4. **Formato busta:** JSON con `sig` detached (come §5) — confermare, vs contenitore
   binario. Propongo JSON, coerente col formato attuale.
5. **Default modalità** al primo rilascio: `enforce` (proposto) con guida di migrazione.
6. **Dove/chi aggiorna il trust store** e se in v1 basta l'aggiornamento manuale
   out-of-band (proposto) o serve già l'update firmato da chiave admin.

---

### Prossimo passo suggerito
Partire dal §4 (`canonical_plan` + vettori di test TS↔Rust) e dal §5 (formato busta),
perché sbloccano sia la firma nello studio sia la verifica nel runner e sono la fonte
del 90% dei bug di "verifica che a volte fallisce". Poi §9 (verifica) e §6/§12-CLI
(trust store), infine §10 (modalità) per il rilascio.
