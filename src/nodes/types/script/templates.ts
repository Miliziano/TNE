/**
 * src/nodes/types/script/templates.ts
 *
 * Esempi pronti per il nodo Script, nel linguaggio di FlowPilot
 * (istruzioni + espressioni FPEL — v. src-tauri/docs/design-nodo-script.md).
 *
 * Prima questo file conteneva ~120 esempi in TypeScript, Python, Java e
 * Groovy: quattro linguaggi che il motore non ha mai eseguito e che
 * nessun codegen ha mai tradotto. Ora ce n'e' uno solo, ed e' quello che
 * gira davvero.
 *
 * Ogni esempio usa SOLO funzioni che esistono in `expr_functions.rs`.
 * Un template che non funziona e' peggio di un template che manca:
 * insegna una sintassi sbagliata e fa perdere tempo a capire di chi sia
 * la colpa.
 */

export interface ScriptTemplate {
  id:          string
  label:       string
  description: string
  category:    string
  code:        string
}

const T = (...righe: string[]) => righe.join('\n')

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [

  // == Base =====================================================
  {
    id: 'base_trasforma', category: 'Base',
    label: 'Aggiungere campi',
    description: 'Calcola campi nuovi; quelli che non tocchi passano invariati',
    code: T(
      '// I campi si leggono per nome. Assegnare crea o sovrascrive.',
      '// Quello che non assegni passa a valle com\'era.',
      'elaborato_il  = today()',
      'nome_completo = concat_ws(" ", nome, cognome)',
    ),
  },
  {
    id: 'base_intermedi', category: 'Base',
    label: 'Valori intermedi con let',
    description: 'Calcoli d\'appoggio che non finiscono nella riga in uscita',
    code: T(
      '// "let" NON crea un campo: vale solo dentro lo script.',
      'let imponibile = quantita * prezzo_unitario',
      'let iva        = round(imponibile * 0.22, 2)',
      '',
      'totale = round(imponibile + iva, 2)',
    ),
  },
  {
    id: 'base_condizione', category: 'Base',
    label: 'Condizione',
    description: 'Rami diversi secondo il contenuto della riga',
    code: T(
      'if totale > 1000 {',
      '  fascia = "alta"',
      '  log "Ordine sopra soglia: " + codice',
      '} else if totale > 100 {',
      '  fascia = "media"',
      '} else {',
      '  fascia = "bassa"',
      '}',
    ),
  },
  {
    id: 'base_filtro', category: 'Base',
    label: 'Filtrare (skip)',
    description: 'Le righe che non interessano non escono da nessuna porta',
    code: T(
      '// "skip" ferma l\'elaborazione di QUESTA riga: non esce da nessuna',
      '// parte e le istruzioni successive non vengono eseguite.',
      'if stato != "attivo" {',
      '  skip',
      '}',
    ),
  },
  {
    id: 'base_scarto', category: 'Base',
    label: 'Scartare con motivo (reject)',
    description: 'Manda la riga sulla porta reject spiegando perche',
    code: T(
      '// Richiede la porta "reject" attiva nel pannello. Il motivo finisce',
      '// nel campo _reject_reason della riga scartata.',
      'if email is null {',
      '  reject "email mancante"',
      '}',
      'if quantita <= 0 {',
      '  reject "quantita non valida: " + to_string(quantita)',
      '}',
    ),
  },
  {
    id: 'base_errore', category: 'Base',
    label: 'Fallire (error)',
    description: 'Ferma il nodo e manda l\'errore all\'error handler della lane',
    code: T(
      '// Diverso da reject: qui e\' il NODO a fallire, e l\'errore prende il',
      '// canale di controllo come qualunque altro fallimento.',
      'if tipo_record is null {',
      '  error "record senza tipo: il file non ha il formato atteso"',
      '}',
    ),
  },

  // == Piu righe ================================================
  {
    id: 'fanout_ripeti', category: 'Piu righe',
    label: 'Una riga -> N copie',
    description: 'Duplica ogni riga un numero di volte',
    code: T(
      '// "emit" manda a valle una copia della riga com\'e in quel momento;',
      '// non interrompe niente. Il "skip" finale evita che esca ANCHE',
      '// l\'originale: senza, uscirebbero N copie piu la riga di partenza.',
      'repeat quantita as copia {',
      '  numero_copia = copia',
      '  emit',
      '}',
      'skip',
    ),
  },
  {
    id: 'fanout_array', category: 'Piu righe',
    label: 'Espandere un array',
    description: 'Un campo che contiene un array JSON diventa una riga per elemento',
    code: T(
      '// Il campo deve contenere un array (per esempio da un JSON Parser).',
      'for elemento in dettagli {',
      '  dettaglio = elemento',
      '  emit',
      '}',
      'skip',
    ),
  },
  {
    id: 'gen_serie', category: 'Piu righe',
    label: 'Generare righe dal nulla',
    description: 'Nodo di partenza: nessun ingresso, le righe le produce lui',
    code: T(
      '// Metti "Sorgente delle righe" su GENERA: la porta d\'ingresso',
      '// sparisce, il corpo gira UNA volta sola e le righe escono solo',
      '// dalle "emit". Qui non serve "skip": senza ingresso non c\'e',
      '// nessuna riga originale da trattenere.',
      'repeat 12 as mese {',
      '  numero_mese = mese',
      '  etichetta   = "mese " + to_string(mese)',
      '  emit',
      '}',
    ),
  },

  // == Stringhe =================================================
  {
    id: 'str_normalizza', category: 'Stringhe',
    label: 'Normalizzare',
    description: 'Spazi, maiuscole, accenti',
    code: T(
      'nome    = title_case(trim(nome))',
      'codice  = upper(trim(codice))',
      'ricerca = to_slug(remove_accents(descrizione))',
    ),
  },
  {
    id: 'str_maschera', category: 'Stringhe',
    label: 'Mascherare dati sensibili',
    description: 'Email e carte di credito offuscate',
    code: T(
      'email_pubblica = mask_email(email)',
      'carta_pubblica = mask_card(numero_carta)',
    ),
  },
  {
    id: 'str_estrai', category: 'Stringhe',
    label: 'Estrarre e sostituire',
    description: 'Sottostringhe, riempimenti, espressioni regolari',
    code: T(
      'prefisso    = left(codice, 3)',
      'progressivo = pad_left(to_string(numero), 6, "0")',
      'pulito      = replace_regex(telefono, "[^0-9]", "")',
    ),
  },

  // == Date =====================================================
  {
    id: 'data_formatta', category: 'Date',
    label: 'Formattare una data',
    description: 'Da data a stringa nel formato che serve',
    code: T(
      '// Il pattern accetta sia dd/MM/yyyy sia %d/%m/%Y.',
      'data_italiana = date_format(data_ordine, "dd/MM/yyyy")',
      'anno_mese     = date_format(data_ordine, "yyyy-MM")',
    ),
  },
  {
    id: 'data_calcoli', category: 'Date',
    label: 'Calcoli sulle date',
    description: 'Scadenze, differenze, trimestri',
    code: T(
      'scadenza      = add_days(data_fattura, 30)',
      'giorni_aperto = diff_days(today(), data_apertura)',
      'trimestre     = quarter(data_ordine)',
      '',
      'if is_weekend(data_consegna) {',
      '  nota = "consegna nel fine settimana"',
      '}',
    ),
  },

  // == Numeri ===================================================
  {
    id: 'num_calcoli', category: 'Numeri',
    label: 'Calcoli e arrotondamenti',
    description: 'Sconti, totali, valori entro un intervallo',
    code: T(
      'let sconto_valido = clamp(sconto_percentuale, 0, 100)',
      'let scontato      = prezzo * (1 - sconto_valido / 100)',
      '',
      'prezzo_finale = round(scontato, 2)',
      'risparmio     = round(prezzo - scontato, 2)',
    ),
  },
  {
    id: 'num_sicuri', category: 'Numeri',
    label: 'Difendersi dai valori mancanti',
    description: 'Valori predefiniti e divisioni sicure',
    code: T(
      '// coalesce restituisce il primo valore non nullo.',
      'let q = coalesce(quantita, 0)',
      'let t = coalesce(totale, 0)',
      '',
      '// La divisione per zero da null: iif evita di propagarlo.',
      'prezzo_medio = iif(q > 0, round(t / q, 2), 0)',
    ),
  },

  // == Controlli ================================================
  {
    id: 'val_obbligatori', category: 'Controlli',
    label: 'Campi obbligatori',
    description: 'Scarta le righe incomplete dicendo cosa manca',
    code: T(
      'if codice is null {',
      '  reject "manca il codice"',
      '}',
      'if descrizione is null {',
      '  reject "manca la descrizione per " + codice',
      '}',
      'if length(trim(coalesce(descrizione, ""))) < 3 {',
      '  reject "descrizione troppo corta per " + codice',
      '}',
    ),
  },
  {
    id: 'val_formato', category: 'Controlli',
    label: 'Formato di un campo',
    description: 'Controlla la forma con un\'espressione regolare',
    code: T(
      'if regex_match(email, "^[^@ ]+@[^@ ]+\\\\.[a-z]{2,}$") == false {',
      '  reject "email non valida: " + email',
      '}',
      'if starts_with(iban, "IT") == false {',
      '  log "IBAN estero su " + codice',
      '  estero = true',
      '}',
    ),
  },
  {
    id: 'chiave_hash', category: 'Controlli',
    label: 'Chiave stabile',
    description: 'Un\'impronta riproducibile da piu campi',
    code: T(
      '// concat_ws con un separatore evita che "AB"+"C" e "A"+"BC"',
      '// producano la stessa chiave.',
      'chiave = hash_sha256(concat_ws("|", codice, to_string(data_ordine), cliente))',
    ),
  },

  // == Variabili di lane ========================================
  {
    id: 'lane_leggi', category: 'Variabili di lane',
    label: 'Leggere una variabile di lane',
    description: 'Valori condivisi nella lane, letti con var()',
    code: T(
      '// var("nome") legge una variabile della lane. Scriverle dallo',
      '// script non e ancora possibile: arriva con una fetta successiva.',
      'ambiente    = var("ambiente")',
      'data_carico = var("data_esecuzione")',
      '',
      'if var("ambiente") == "test" {',
      '  log "riga elaborata in test: " + codice',
      '}',
    ),
  },
]

// === Accesso ========================================================

export function getTemplates(): ScriptTemplate[] {
  return SCRIPT_TEMPLATES
}

export function getTemplatesByCategory(): Record<string, ScriptTemplate[]> {
  return SCRIPT_TEMPLATES.reduce((acc, t) => {
    (acc[t.category] ??= []).push(t)
    return acc
  }, {} as Record<string, ScriptTemplate[]>)
}

export function getDefaultTemplate(): string {
  return SCRIPT_TEMPLATES[0]?.code ?? ''
}
