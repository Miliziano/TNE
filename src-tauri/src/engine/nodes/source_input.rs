// ─── src-tauri/src/engine/nodes/source_input.rs ────────────────────
//
// R8 — "barriera + parametri", per i nodi SORGENTE.
// Contratto: `src-tauri/docs/contratto-porte.md` R7, R8 e §9.9.
//
// LA STORIA, perché non si ripeta.
//
// Le sorgenti hanno una porta d'ingresso DICHIARATA dal contratto (P18):
// un source_file può ricevere il path da monte, un source_db un parametro
// della query. Lo studio la disegna e ci si può attaccare un arco.
// Il motore, però, non l'ha mai letta:
//
//     "source_db" => { let tx = take_primary_output(&mut outputs);
//                      source_db::run(ctx, tx).await }
//
// La mappa `inputs` non veniva MAI toccata. E qui sta il danno vero: il
// receiver non preso viene DROPPATO, il canale si chiude, e le
// `let _ = tx.send(row).await` del nodo a monte falliscono — con l'errore
// ignorato. Risultato: le righe sparivano in silenzio e il source
// eseguiva la sua query statica come se niente fosse. Non un errore: un
// RISULTATO SBAGLIATO che sembra giusto. È il §2 del contratto — un
// comportamento dichiarato e non implementato si scopre in produzione.
//
// Prendere il receiver e drenarlo chiude entrambe le cose in un colpo: le
// send a monte riescono di nuovo (niente più righe perdute) e l'attesa
// diventa vera.
//
// PERCHÉ DRENARE È GIÀ ASPETTARE (R7). Il motore è concorrente a canali:
// tutti i nodi partono insieme e la **chiusura del canale è il "ho
// finito"** di chi sta a monte. Un nodo che legge il proprio ingresso
// fino all'esaurimento sta aspettando, per costruzione — che siano
// passate mille righe o zero. La barriera è gratis: non serve inventare
// un segnale per ordinare l'esecuzione, e non si deve (una riga-segnale
// si confonde con un dato, la chiusura di un canale no).
//
// IL CALCO È `window.rs`, che questo pattern ce l'ha già:
// `rx: Option<RowReceiver>` — "nel caso 2 il nodo non ha archi in
// ingresso e si sblocca da solo".

use crate::engine::executor::RowReceiver;
use crate::engine::types::Row;

/// Aspetta chi sta a monte e raccoglie la riga di parametri.
///
/// - `rx = None` → il nodo non ha archi in ingresso: non c'è niente da
///   aspettare, si parte subito con la configurazione statica.
/// - `rx = Some(..)` → si drena fino alla chiusura del canale (= si
///   aspetta che il nodo a monte finisca), e si tiene **al massimo una**
///   riga di parametri.
///
/// **Cardinalità 1** (decisione utente, 16 lug): un source si configura
/// con UNA riga. Due o più sono un errore parlante, non un comportamento.
/// L'alternativa scartata era "N righe = N esecuzioni": farebbe del source
/// un **lookup**, cioè un altro nodo, in cui `rows_out` non è più
/// predicibile in design — e il pre-compilatore perderebbe la capacità di
/// dire quanto esce. Se servirà, avrà un nome suo.
///
/// Ritorna `Ok(None)` se non è arrivato niente: legittimo, ed è anche il
/// caso "barriera pura" (aspetta e poi configurati da solo).
pub async fn await_params(
    node_id: &str,
    node_type: &str,
    rx: Option<RowReceiver>,
) -> Result<Option<Row>, String> {
    let Some(mut rx) = rx else { return Ok(None) };

    let mut first: Option<Row> = None;
    let mut count: usize = 0;

    // Si drena SEMPRE fino in fondo, anche dopo aver preso la prima riga:
    // uscire prima lascerebbe il canale aperto e il nodo a monte a
    // spingere righe contro un muro. Drenare fino alla chiusura è
    // l'attesa (R7), e ci dice anche quante ne sono arrivate davvero.
    while let Some(row) = rx.recv().await {
        count += 1;
        if first.is_none() {
            first = Some(row);
        }
    }

    if count > 1 {
        return Err(format!(
            "{} {}: sull'ingresso sono arrivate {} righe, ma un nodo sorgente si \
             configura con UNA sola riga di parametri. Riduci il flusso a monte a \
             una riga (per esempio con un aggregate o un filter), oppure scollega \
             l'arco e configura il nodo dal pannello.",
            node_type, node_id, count
        ));
    }

    Ok(first)
}
