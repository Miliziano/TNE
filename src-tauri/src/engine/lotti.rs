// ─── src-tauri/src/engine/lotti.rs ────────────────────────────────
// Righe in uscita a LOTTI (P387, voce D di docs/STUDIO-motore-prestazioni.md).
//
// Perché. Fra due nodi le righe passano su un canale; ogni riga che arriva a
// un nodo fermo in attesa, o ogni posto che si libera per un nodo fermo su un
// canale pieno, può costare un risveglio di thread (una chiamata di sistema).
// Una riga alla volta, il coordinamento costa più del lavoro sulla riga
// (misurato nel P386: `futex` da 107.000 a 136.000 in un run, TMap più lento
// pur facendo meno lavoro).
//
// Regola, per non aggiungere attese ai flussi lenti (near real time):
//   - un nodo accumula le righe in uscita mentre ha altre righe in ingresso
//     già pronte;
//   - il lotto parte appena l'ingresso è vuoto (il nodo sta per mettersi in
//     attesa) o quando arriva a `LOTTO_MAX` righe.
// Con un flusso lento ogni riga parte subito, come prima; con un flusso
// veloce le righe viaggiano a gruppi.
//
// Ordine. Le righe partono nell'ordine in cui sono state prodotte, anche fra
// uscite diverse: un lotto si spedisce a tratti consecutivi per uscita, così
// due uscite che confluiscono nello stesso ingresso vedono lo stesso ordine di
// prima.
//
// Spedizione. Un tratto si spedisce prenotando i posti del canale tutti
// insieme (`reserve_many`): se il canale è pieno, chi scrive si risveglia una
// volta per tratto, non una per riga.

use crate::engine::executor::RowSender;
use crate::engine::types::Row;

/// Righe al massimo in un lotto prima di spedirlo comunque.
pub const LOTTO_MAX: usize = 64;

/// Spedisce `rows` su `tx` prenotando i posti tutti insieme (a pezzi grandi
/// al più quanto il canale). `Err` = il canale a valle è chiuso: le righe non
/// ancora spedite sono perse, come con `send`.
pub async fn spedisci(tx: &RowSender, rows: Vec<Row>) -> Result<(), ()> {
    let mut rows = rows.into_iter();
    loop {
        let n = rows.len().min(tx.max_capacity());
        if n == 0 { return Ok(()) }
        let posti = tx.reserve_many(n).await.map_err(|_| ())?;
        for (posto, row) in posti.zip(rows.by_ref()) {
            posto.send(row);
        }
    }
}

/// Esito della spedizione di un lotto.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Consegna {
    /// righe consegnate a un canale aperto, per indice d'uscita
    pub per_uscita: Vec<u64>,
    /// almeno un'uscita aveva il canale chiuso
    pub chiuse: bool,
}

impl Consegna {
    /// Righe consegnate in tutto.
    pub fn totale(&self) -> u64 {
        self.per_uscita.iter().sum()
    }

    /// Righe consegnate all'uscita `i`.
    pub fn a(&self, i: usize) -> u64 {
        self.per_uscita.get(i).copied().unwrap_or(0)
    }
}

/// Lotto di righe in uscita, ognuna con l'indice dell'uscita a cui va.
#[derive(Default)]
pub struct Lotto {
    righe: Vec<(usize, Row)>,
}

impl Lotto {
    pub fn new() -> Self {
        Lotto { righe: Vec::with_capacity(LOTTO_MAX) }
    }

    pub fn push(&mut self, uscita: usize, row: Row) {
        self.righe.push((uscita, row));
    }

    pub fn len(&self) -> usize {
        self.righe.len()
    }

    pub fn is_empty(&self) -> bool {
        self.righe.is_empty()
    }

    /// Va spedito ora? `ingresso_vuoto`: il nodo non ha altre righe pronte
    /// in ingresso e sta per mettersi in attesa.
    pub fn da_spedire(&self, ingresso_vuoto: bool) -> bool {
        !self.righe.is_empty() && (ingresso_vuoto || self.righe.len() >= LOTTO_MAX)
    }

    /// Spedisce tutto, nell'ordine di produzione, a tratti consecutivi per
    /// uscita. `canale(i)` dà il canale dell'uscita `i` (`None` = non collegata:
    /// le sue righe si scartano, come prima).
    pub async fn spedisci<'a>(&mut self, canale: impl Fn(usize) -> Option<&'a RowSender>) -> Consegna {
        let mut esito = Consegna::default();
        let mut righe = std::mem::take(&mut self.righe).into_iter().peekable();
        while let Some((uscita, row)) = righe.next() {
            let mut tratto = vec![row];
            while let Some((u, _)) = righe.peek() {
                if *u != uscita { break }
                tratto.push(righe.next().expect("visto con peek").1);
            }
            let n = tratto.len() as u64;
            if let Some(tx) = canale(uscita) {
                match spedisci(tx, tratto).await {
                    Ok(()) => {
                        if esito.per_uscita.len() <= uscita { esito.per_uscita.resize(uscita + 1, 0) }
                        esito.per_uscita[uscita] += n;
                    }
                    Err(()) => esito.chiuse = true,
                }
            }
        }
        // il vettore si riusa: la capacità resta per il lotto successivo
        if self.righe.capacity() == 0 { self.righe.reserve(LOTTO_MAX) }
        esito
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::types::Value;
    use tokio::sync::mpsc;

    fn riga(i: i64) -> Row {
        std::iter::once(("i".to_string(), Value::Int(i))).collect()
    }

    #[tokio::test]
    async fn ordine_e_uscite() {
        // due uscite che confluiscono nello stesso canale: stesso ordine di prima
        let (tx, mut rx) = mpsc::channel::<Row>(4);
        let (tx2, mut rx2) = mpsc::channel::<Row>(100);
        let mut l = Lotto::new();
        for i in 0..10 { l.push(if i % 3 == 0 { 1 } else { 0 }, riga(i)) }
        l.push(2, riga(99)); // uscita non collegata: scartata
        assert!(l.da_spedire(true));
        assert!(!l.da_spedire(false), "sotto il massimo e con ingresso pronto si aspetta");
        let lettore = tokio::spawn(async move {
            let mut visti = Vec::new();
            while let Some(r) = rx.recv().await { visti.push(r.get("i").cloned()) }
            visti
        });
        let canali = [tx.clone(), tx];
        let esito = l.spedisci(|i| canali.get(i)).await;
        assert_eq!(esito.totale(), 10);
        assert_eq!((esito.a(0), esito.a(1), esito.a(2)), (6, 4, 0));
        assert!(!esito.chiuse);
        drop(canali);
        let visti = lettore.await.unwrap();
        assert_eq!(visti, (0..10).map(|i| Some(Value::Int(i))).collect::<Vec<_>>());
        assert!(l.is_empty());

        // canale chiuso: si dice, senza bloccare
        rx2.close();
        let mut l = Lotto::new();
        l.push(0, riga(1));
        let esito = l.spedisci(|_| Some(&tx2)).await;
        assert_eq!((esito.totale(), esito.chiuse), (0, true));
    }

    #[tokio::test]
    async fn lotto_piu_grande_del_canale() {
        let (tx, mut rx) = mpsc::channel::<Row>(3);
        let lettore = tokio::spawn(async move {
            let mut n = 0;
            while rx.recv().await.is_some() { n += 1 }
            n
        });
        spedisci(&tx, (0..10).map(riga).collect()).await.unwrap();
        drop(tx);
        assert_eq!(lettore.await.unwrap(), 10);
    }

    fn ctx(spec: serde_json::Value) -> crate::engine::executor::NodeContext {
        use crate::engine::types::{LaneId, NodeId, RunId};
        use std::collections::HashMap;
        crate::engine::executor::NodeContext {
            run_id: RunId("lotti".into()), lane_id: LaneId("l".into()), node_id: NodeId("n".into()),
            label: "n".into(), config: serde_json::json!({}), spec,
            variables: HashMap::new(),
            lane_resources: crate::engine::pool::LaneResources::new(HashMap::new()),
            lane_txns: crate::engine::txregistry::LaneTransactions::new(Vec::new(), "lotti".into()),
            lane_datasets: crate::engine::datasets::LaneDatasets::new(&[]),
            lane_abort: crate::engine::abort::LaneAbort::new(),
            cancel: tokio_util::sync::CancellationToken::new(),
            err_collector: None,
            lane_done: crate::engine::completion::LaneCompletion::empty(),
            progress_last: Default::default(),
        }
    }

    /// Near real time: con l'ingresso APERTO e una riga alla volta, ogni riga
    /// esce subito (il lotto parte quando il nodo sta per aspettare).
    #[tokio::test]
    async fn nessuna_attesa_per_i_flussi_lenti() {
        async fn entro(rx: &mut mpsc::Receiver<Row>) -> Option<Row> {
            tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await.ok().flatten()
        }

        // Transform
        let (tx_in, rx_in) = mpsc::channel::<Row>(1000);
        let (tx_out, mut rx_out) = mpsc::channel::<Row>(1000);
        let spec = serde_json::json!({"props": {}, "config": {"mode": "add", "fields": []}});
        let nodo = tokio::spawn(crate::engine::nodes::transform::run(ctx(spec), rx_in, tx_out));
        for i in 0..3 {
            tx_in.send(riga(i)).await.unwrap();
            let r = entro(&mut rx_out).await.expect("la riga deve uscire senza aspettare altre righe");
            assert_eq!(r.get("i"), Some(&Value::Int(i)));
        }
        drop(tx_in);
        assert_eq!(nodo.await.unwrap().unwrap().rows_out, 3);

        // Filter (senza condizioni: tutto allo scarto)
        let (tx_in, rx_in) = mpsc::channel::<Row>(1000);
        let (tx_out, mut rx_out) = mpsc::channel::<Row>(1000);
        let spec = serde_json::json!({"props": {}, "config": {"conditions": []}});
        let uscite = std::collections::HashMap::from([("reject".to_string(), tx_out)]);
        let nodo = tokio::spawn(crate::engine::nodes::filter::run(ctx(spec), rx_in, uscite));
        for i in 0..3 {
            tx_in.send(riga(i)).await.unwrap();
            assert!(entro(&mut rx_out).await.is_some(), "la riga scartata deve uscire subito");
        }
        drop(tx_in);
        assert_eq!(nodo.await.unwrap().unwrap().rows_rejected, 3);
    }
}
