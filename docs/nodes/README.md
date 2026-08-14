<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Riferimento nodi FlowPilot

Schede generate automaticamente dal registry (`NODE_DEFS`) e dalla semantica (`NODE_SEMANTICS`). Rigenera con `npm run docs:nodes`. La sezione «Approfondimento» di ogni scheda è scritta a mano e viene preservata.

**47 nodi.**

## Input

- [`source_kafka`](./source_kafka.md) — **Kafka Source** · Consumer Kafka — legge messaggi da topic con configurazione offset e deserializzazione
- [`source_db`](./source_db.md) — **DB Source** · Legge righe da una tabella di database
- [`source_file`](./source_file.md) — **File Input** · Legge record da un file locale
- [`source_http`](./source_http.md) — **HTTP Source** · Recupera dati da un endpoint HTTP
- [`source_ftp`](./source_ftp.md) — **FTP/SFTP Source** · Legge file da server FTP, FTPS o SFTP
- [`ldap_source`](./ldap_source.md) — **LDAP Source** · Interroga una directory LDAP e produce una riga per voce
- [`github_source`](./github_source.md) — **GitHub Source** · Preleva dati da GitHub (repo, issue/PR, commit) via API REST
- [`dir_watcher`](./dir_watcher.md) — **Dir Watcher** · Osserva una directory per nuovi file (watch) o ne enumera il contenuto (scan)
- [`source_activemq`](./source_activemq.md) — **ActiveMQ** · Consumer/Producer ActiveMQ — protocolli STOMP, OpenWire, AMQP
- [`source_mqtt`](./source_mqtt.md) — **MQTT** · Subscriber MQTT — riceve messaggi da broker MQTT/MQTTS
- [`webhook_receiver`](./webhook_receiver.md) — **Webhook Receiver** · Riceve webhook — server condiviso con HMAC, buffer e dedup
- [`watchdog`](./watchdog.md) — **Watchdog** · Monitora servizi via HEAD — sblocca il flusso sull'header atteso
- [`bridge_in`](./bridge_in.md) — **Bridge In** · Porta di ingresso da un'altra lane — riceve dal canale bridge

## Transform

- [`log`](./log.md) — **Log** · Nodo trasparente — logga le righe in transito per debug
- [`data_quality`](./data_quality.md) — **Data Quality** · Valida ogni riga contro regole configurabili — output valid e reject
- [`union`](./union.md) — **Union** · Fonde N flussi in uno — modalità concat, interleave o zip
- [`filter`](./filter.md) — **Filter** · Smista le righe su N uscite in base a condizioni — first-match
- [`transform`](./transform.md) — **Transform fields** · Trasforma, rinomina e converte i campi di ogni riga con espressioni FPEL
- [`join`](./join.md) — **Join** · Unisce due flussi su un campo chiave
- [`tmap`](./tmap.md) — **TMap** · Trasformatore visuale multi-input/output con mapping, join lookup e routing condizionale
- [`aggregate`](./aggregate.md) — **Aggregate** · Raggruppa le righe e calcola funzioni aggregate
- [`json_parser`](./json_parser.md) — **JSON Parser** · Estrae e trasforma dati JSON in flussi strutturati
- [`xml_parser`](./xml_parser.md) — **XML Parser** · Estrae e trasforma dati XML in flussi strutturati
- [`script`](./script.md) — **Script** · Trasforma, filtra o scarta ogni riga con istruzioni ed espressioni
- [`window`](./window.md) — **Window** · Calcola window functions (ROW_NUMBER, RANK, LAG, LEAD, CUMSUM, MOVING_AVG
- [`materialize`](./materialize.md) — **Materialize** · Hashtable in-memory per esecuzione — accessibile da qualsiasi nodo tramite context
- [`explode`](./explode.md) — **Explode** · Trasforma strutture dense (Materialize, variabili lane, campi object) in un flusso di righe
- [`report_generator`](./report_generator.md) — **Report Generator** · Bufferizza il flusso e genera un report PDF/HTML/Excel con tabelle e grafici
- [`pivot`](./pivot.md) — **Pivot / Unpivot** · Trasforma la struttura della tabella — righe in colonne (Pivot) o colonne in righe (Unpivot)
- [`ldap_auth`](./ldap_auth.md) — **LDAP Auth** · Autentica le credenziali di ogni riga contro LDAP (search-then-bind)

## Output

- [`json_serializer`](./json_serializer.md) — **JSON Serializer** · Serializza righe del flusso in stringhe JSON con struttura configurabile
- [`xml_serializer`](./xml_serializer.md) — **XML Serializer** · Serializza righe del flusso in stringhe XML con struttura e namespace configurabili
- [`sink_db`](./sink_db.md) — **DB Sink** · Scrive righe in una tabella di database
- [`sink_kafka`](./sink_kafka.md) — **Kafka** · Pubblica righe su un topic Kafka
- [`sink_file`](./sink_file.md) — **File Output** · Scrive righe su file
- [`sink_activemq`](./sink_activemq.md) — **ActiveMQ Sink** · Producer ActiveMQ — pubblica messaggi su queue o topic
- [`sink_mqtt`](./sink_mqtt.md) — **MQTT Sink** · Publisher MQTT — pubblica messaggi su topic
- [`sink_ftp`](./sink_ftp.md) — **FTP/SFTP Sink** · Scrive file su server FTP, FTPS o SFTP
- [`mail_sink`](./mail_sink.md) — **Mail Sink** · Invia email tramite SMTP, SendGrid, Amazon SES o Mailgun
- [`webhook_responder`](./webhook_responder.md) — **Webhook Responder** · Risponde HEAD/GET con header sintetici dalla riga corrente
- [`bridge_out`](./bridge_out.md) — **Bridge Out** · Porta di uscita dal flusso della lane — pubblica sul canale bridge

## Flusso

- [`stop`](./stop.md) — **Stop** · Controllo di flusso: ferma deliberatamente la lane (rollback + chiusura connessioni) quando il flusso raggiunge questo nodo

## DevOps

- [`shell_exec`](./shell_exec.md) — **Shell** · Esegue comandi bash/shell locali — output nel flusso
- [`ssh_exec`](./ssh_exec.md) — **SSH** · Esegue comandi su host remoto via SSH

## Altri

- [`error_handler`](./error_handler.md) — **Error Handler** · Collettore centrale degli errori della lane — sempre attivo, non eliminabile
- [`lane_end`](./lane_end.md) — **End** · Punto di fine della lane
- [`lane_start`](./lane_start.md) — **Start** · Punto di avvio della lane

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->
