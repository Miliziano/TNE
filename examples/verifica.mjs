#!/usr/bin/env node
/**
 * verifica.mjs — confronta il LOG di un run con il suo `atteso.json`.
 *
 * Non serve strumentazione nuova: il log contiene già tutto (statistiche per nodo
 * dentro RunCompleted, eventi, etichette dei nodi).
 *
 * USO
 *   node verifica.mjs <cartella-esempio> <log.ndjson> [--exit N] [--taratura]
 *
 *   --exit N     codice d'uscita del runner (confrontato con `exit_code`).
 *                Ometterlo salta quel controllo.
 *   --taratura   NON verifica: stampa i valori OSSERVATI nella forma di
 *                `atteso.json`, da incollare la prima volta o quando l'esempio
 *                cambia di proposito. Serve a tarare le attese sui numeri veri
 *                invece di indovinarli.
 *
 * ESITO: 0 se tutto torna, 1 altrimenti (con l'elenco preciso delle differenze).
 *
 * I nodi si indicano per ETICHETTA, non per id: `node_4` cambia se ridisegni il
 * flusso, "Filtro maggiorenni" no. Le etichette si ricavano dagli eventi.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ─── lettura del log ──────────────────────────────────────────────
/** Righe NDJSON → eventi normalizzati. Tollera: intestazione, righe
 *  incapsulate `{timestamp,event}`, righe nude `{type,payload}`, righe sporche. */
export function leggiLog(testo) {
  const eventi = [];
  let intestazione = null;
  for (const riga of testo.split(/\r?\n/)) {
    const t = riga.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }        // righe non-JSON: ignorate
    if (o && o.kind === 'flowpilot-log-header') { intestazione = o; continue; }
    const ts = typeof o.timestamp === 'number' ? o.timestamp : null;
    const ev = (ts !== null && o.event && typeof o.event === 'object') ? o.event : o;
    if (!ev || typeof ev !== 'object' || !ev.type) continue;
    if (ev.ts == null && ts !== null) ev.ts = ts;
    eventi.push(ev);
  }
  return { intestazione, eventi };
}

/** Mappa id-nodo → etichetta, ricavata dagli eventi che la portano. */
export function etichettePerId(eventi) {
  const m = new Map();
  for (const e of eventi) {
    const p = e.payload || {};
    const et = p.label || p.node_label;
    if (p.node_id && et && !m.has(p.node_id)) m.set(p.node_id, et);
  }
  return m;
}

/** Statistiche per ETICHETTA, prese da RunCompleted/RunFailed (o dai NodeCompleted). */
export function statistichePerEtichetta(eventi) {
  const etichette = etichettePerId(eventi);
  const out = {};
  const metti = (nodeId, st) => {
    const nome = etichette.get(nodeId) || nodeId;
    out[nome] = {
      rows_in: st.rows_in ?? 0,
      rows_out: st.rows_out ?? 0,
      rows_rejected: st.rows_rejected ?? 0,
    };
  };
  for (const e of eventi) {
    if (e.type === 'NodeCompleted' && e.payload?.stats && e.payload.node_id) {
      metti(e.payload.node_id, e.payload.stats);
    }
  }
  // Il riepilogo finale ha la parola definitiva.
  const fine = eventi.find(e => e.type === 'RunCompleted' || e.type === 'RunFailed');
  const ns = fine?.payload?.stats?.node_stats;
  if (ns) for (const [id, st] of Object.entries(ns)) metti(id, st);
  return out;
}

export function esitoDelRun(eventi) {
  if (eventi.some(e => e.type === 'RunFailed')) return 'fallito';
  if (eventi.some(e => e.type === 'RunCompleted')) return 'completato';
  return 'incompleto';
}

/** Un evento contiene contenuto di riga? (dump destinati alla finestra dello studio) */
const portaDatiDiRiga = (e) => e.type === 'NodeLog' && e.payload?.target === 'window';

// ─── controlli ────────────────────────────────────────────────────
export function verifica(atteso, eventi, cartella, exitCode) {
  const errori = [];
  const ok = [];

  if (atteso.exit_code != null && exitCode != null) {
    if (exitCode !== atteso.exit_code) errori.push(`codice d'uscita: atteso ${atteso.exit_code}, trovato ${exitCode}`);
    else ok.push(`codice d'uscita ${exitCode}`);
  }

  if (atteso.esito) {
    const e = esitoDelRun(eventi);
    if (e !== atteso.esito) errori.push(`esito: atteso "${atteso.esito}", trovato "${e}"`);
    else ok.push(`esito ${e}`);
  }

  for (const tipo of atteso.eventi_richiesti || []) {
    if (!eventi.some(e => e.type === tipo)) errori.push(`manca l'evento richiesto: ${tipo}`);
    else ok.push(`evento ${tipo} presente`);
  }

  const stats = statistichePerEtichetta(eventi);
  for (const [etichetta, attese] of Object.entries(atteso.nodi || {})) {
    const trovate = stats[etichetta];
    if (!trovate) {
      errori.push(`nodo "${etichetta}": nessuna statistica nel log (etichetta cambiata? nodo mai eseguito?)`);
      continue;
    }
    for (const [campo, valore] of Object.entries(attese)) {
      if (trovate[campo] !== valore) errori.push(`"${etichetta}" ${campo}: atteso ${valore}, trovato ${trovate[campo]}`);
      else ok.push(`"${etichetta}" ${campo}=${valore}`);
    }
  }

  for (const f of atteso.file_attesi || []) {
    const p = resolve(cartella, f.path);
    if (!existsSync(p)) { errori.push(`file mancante: ${f.path}`); continue; }
    const testo = readFileSync(p, 'utf8');
    const righe = testo.split(/\r?\n/).filter(r => r.trim() !== '').length;
    if (f.righe != null && righe !== f.righe) errori.push(`${f.path}: righe attese ${f.righe}, trovate ${righe}`);
    else if (f.righe != null) ok.push(`${f.path} ${righe} righe`);
    if (f.contiene && !testo.includes(f.contiene)) errori.push(`${f.path}: non contiene "${f.contiene}"`);
    else if (f.contiene) ok.push(`${f.path} contiene "${f.contiene}"`);
  }

  for (const inv of atteso.invarianti || []) {
    if (inv === 'nessun_dato_di_riga') {
      const colpevoli = eventi.filter(portaDatiDiRiga);
      if (colpevoli.length) {
        errori.push(`invariante "nessun_dato_di_riga": ${colpevoli.length} eventi trasportano contenuto di riga ` +
                    `(primo: nodo "${colpevoli[0].payload?.node_label || '?'}") — livello di log troppo alto?`);
      } else ok.push('invariante nessun_dato_di_riga');
    } else {
      errori.push(`invariante sconosciuta: "${inv}"`);
    }
  }

  return { errori, ok };
}

/** Modalità taratura: i valori osservati, nella forma di atteso.json. */
export function taratura(eventi, exitCode) {
  return {
    exit_code: exitCode ?? null,
    esito: esitoDelRun(eventi),
    nodi: statistichePerEtichetta(eventi),
    eventi_richiesti: [...new Set(eventi.map(e => e.type))].sort(),
    invarianti: eventi.some(portaDatiDiRiga) ? [] : ['nessun_dato_di_riga'],
  };
}

// ─── riga di comando ──────────────────────────────────────────────
const eseguitoDaCLI = import.meta.url === `file://${process.argv[1]}`;
if (eseguitoDaCLI) {
  const args = process.argv.slice(2);
  const modoTaratura = args.includes('--taratura');
  const iExit = args.indexOf('--exit');
  const exitCode = iExit >= 0 ? Number(args[iExit + 1]) : null;
  const posizionali = args.filter((a, i) =>
    !a.startsWith('--') && !(iExit >= 0 && i === iExit + 1));
  const [cartella, logPath] = posizionali;

  if (!cartella || !logPath) {
    console.error('uso: node verifica.mjs <cartella-esempio> <log.ndjson> [--exit N] [--taratura]');
    process.exit(2);
  }
  if (!existsSync(logPath)) { console.error(`log non trovato: ${logPath}`); process.exit(2); }

  const { eventi } = leggiLog(readFileSync(logPath, 'utf8'));
  if (!eventi.length) { console.error('il log non contiene eventi leggibili'); process.exit(2); }

  if (modoTaratura) {
    console.log(JSON.stringify(taratura(eventi, exitCode), null, 2));
    process.exit(0);
  }

  const attesoPath = join(cartella, 'atteso.json');
  if (!existsSync(attesoPath)) { console.error(`atteso.json non trovato in ${cartella}`); process.exit(2); }
  const atteso = JSON.parse(readFileSync(attesoPath, 'utf8'));

  const { errori, ok } = verifica(atteso, eventi, cartella, exitCode);
  const nome = atteso.descrizione || cartella;

  if (errori.length === 0) {
    console.log(`✅ ${nome} — ${ok.length} controlli superati`);
    process.exit(0);
  }
  console.log(`❌ ${nome} — ${errori.length} differenze (${ok.length} controlli ok)`);
  for (const e of errori) console.log(`   · ${e}`);
  console.log(`\nSuggerimento: "node verifica.mjs ${cartella} ${logPath} --taratura" mostra i valori osservati.`);
  process.exit(1);
}
