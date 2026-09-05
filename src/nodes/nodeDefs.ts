import type { NodeDef } from '../types'
import { HTTP_DEFAULTS } from './resourceDefaults'

// ─────────────────────────────────────────────────────────────────
// DATI PURI del registry dei nodi — nessuna dipendenza da React.
// Estratto da registry.ts (che ora li ri-esporta) così che strumenti
// esterni (es. il generatore di schede-nodo in scripts/gen-node-docs.ts,
// e in prospettiva il pre-compilatore coverage/metriche) possano
// importare i metadati dei nodi senza trascinare i Panel .tsx.
// Fonte unica: modificare QUI type/label/categoria/campi/descrizione.
// ─────────────────────────────────────────────────────────────────

export const NODE_DEFS: Record<string, NodeDef> = {
  
  json_serializer: {
    type:        'json_serializer',
    label:       'JSON Serializer',
    icon:        '{ }',
    color:       '#22d3ee',
    category:    'output',
    description: 'Serializza righe del flusso in stringhe JSON con struttura configurabile.',
    fields:      [],
  },
   log: {
    type:        'log',
    label:       'Log',
    icon:        '📋',
    color:       '#a78bfa',
    category:    'transform',
    description: 'Nodo trasparente — logga le righe in transito per debug. Non modifica i dati.',
    fields:      [],
  },

  xml_serializer: {
    type:        'xml_serializer',
    label:       'XML Serializer',
    icon:        '</>',
    color:       '#f97316',
    category:    'output',
    description: 'Serializza righe del flusso in stringhe XML con struttura e namespace configurabili.',
    fields:      [],
  },

  data_quality: {
    type:        'data_quality',
    label:       'Data Quality',
    icon:        '✓',
    color:       '#3ddc84',
    category:    'transform',
    description: 'Valida ogni riga contro regole configurabili — output valid e reject.',
    fields:      [],
  },

  source_kafka: {
    type:        'source_kafka',
    label:       'Kafka Source',
    icon:        '≋',
    color:       '#4a9eff',
    category:    'input',
    description: 'Consumer Kafka — legge messaggi da topic con configurazione offset e deserializzazione.',
    fields:      [],
  },

  union: {
    type:        'union',
    label:       'Union',
    icon:        '⊕',
    color:       '#a78bfa',
    category:    'transform',
    description: 'Fonde N flussi in uno — modalità concat, interleave o zip.',
    fields:      [],
  },

  source_ftp: {
    type:        'source_ftp',
    label:       'FTP/SFTP Source',
    icon:        '⇄',
    color:       '#4a9eff',
    category:    'input',
    description: 'Legge file da server FTP, FTPS o SFTP.',
    fields:      [],
  },

  ldap_source: {
    type:        'ldap_source',
    label:       'LDAP Source',
    icon:        '⧉',
    color:       '#4a9eff',
    category:    'input',
    description: 'Interroga una directory LDAP e produce una riga per voce.',
    fields:      [],
  },

  github_source: {
    type:        'github_source',
    label:       'GitHub Source',
    icon:        '⑃',
    color:       '#4a9eff',
    category:    'input',
    description: 'Preleva dati da GitHub (repo, issue/PR, commit) via API REST.',
    fields:      [],
  },

  sink_ftp: {
    type:        'sink_ftp',
    label:       'FTP/SFTP Sink',
    icon:        '⇄',
    color:       '#3ddc84',
    category:    'output',
    description: 'Scrive file su server FTP, FTPS o SFTP.',
    fields:      [],
  },
  pivot: {
    type:        'pivot',
    label:       'Pivot / Unpivot',
    icon:        '⊞',
    color:       '#f97316',
    category:    'transform',
    description: 'Trasforma la struttura della tabella — righe in colonne (Pivot) o colonne in righe (Unpivot).',
    fields:      [],
  },

  source_db: {
    type: 'source_db',
    label: 'DB Source',
    category: 'input',
    icon: '⬡',
    color: '#4a9eff',
    description: 'Legge righe da una tabella di database.',
    fields: [
      // ignoredWhenSet: 'query' — con una query personalizzata il motore
      // esegue quella e basta (source_db.rs: "custom verbatim se presente").
      { key: 'schema',       label: 'Schema',          type: 'text',   default: 'public', ignoredWhenSet: 'query' },
      { key: 'table',        label: 'Tabella',         type: 'text',   default: '',       ignoredWhenSet: 'query' },
      { key: 'limit',        label: 'Row limit',    type: 'number', default: '0',      ignoredWhenSet: 'query' },
      { key: 'orderBy',      label: 'Order by',      type: 'text',   default: '',       ignoredWhenSet: 'query' },
      { key: 'query',        label: 'Query SQL',       type: 'code',   default: 'SELECT * FROM ' },
    ],
  },
  source_file: {
    type: 'source_file',
    label: 'File Input',
    category: 'input',
    icon: '▤',
    color: '#4a9eff',
    description: 'Legge record da un file locale.',
    fields: [
    ],
  },

  explode: {
    type:        'explode',
    label:       'Explode',
    category:    'transform',
    icon:        '⊕',
    color:       '#a78bfa',
    description: 'Trasforma strutture dense (Materialize, variabili lane, campi object) in un flusso di righe.',
    fields:      [],
  },
  source_http: {
    type: 'source_http',
    label: 'HTTP Source',
    category: 'input',
    icon: '⇄',
    color: '#4a9eff',
    description: 'Recupera dati da un endpoint HTTP.',
    fields: [
    { key: 'url',          label: 'URL',           type: 'text',   default: HTTP_DEFAULTS.url  },
    { key: 'method',       label: 'Method',        type: 'select', default: 'GET', options: ['GET','POST','PUT','PATCH','DELETE'] },
    { key: 'responseType', label: 'Response type', type: 'select', default: 'json', options: ['json','text','xml','binary','pdf','csv'] },
    { key: 'authType',     label: 'Auth',          type: 'select', default: 'none', options: ['none','basic','bearer','api_key','digest','oauth2_cc','oauth2_ac'] },
    { key: 'customFields', label: 'JSON fields',    type: 'text',   default: '[]' },
   ],
  },

  filter: {
      type: 'filter',
      label: 'Filter',
      category: 'transform',
      icon: '⊻',
      color: '#ffb347',
      description: 'Smista le righe su N uscite in base a condizioni — first-match.',
      fields: [],
  },

  ldap_auth: {
      type: 'ldap_auth',
      label: 'LDAP Auth',
      category: 'transform',
      icon: '⊞',
      color: '#ffb347',
      description: 'Autentica le credenziali di ogni riga contro LDAP (search-then-bind).',
      fields: [],
  },
  
  
  join: {
    type: 'join',
    label: 'Join',
    category: 'transform',
    icon: '⋈',
    color: '#ffb347',
    description: 'Unisce due flussi su un campo chiave.',
    fields: [
      { key: 'join_type', label: 'Join type', type: 'select', default: 'inner', options: ['inner','left','right','full'] },
      { key: 'key',       label: 'Key field', type: 'text', default: 'user_id' },
    ],
  },
  aggregate: {
    type: 'aggregate',
    label: 'Aggregate',
    category: 'transform',
    icon: 'Σ',
    color: '#ffb347',
    description: 'Raggruppa le righe e calcola funzioni aggregate.',
    fields: [
      { key: 'group_by',  label: 'Raggruppa per', type: 'text', default: 'region' },
      { key: 'functions', label: 'Functions',       type: 'code', default: '{"count": "*", "sum": "amount"}' },
    ],
  },
  script: {
    type: 'script',
    label: 'Script',
    category: 'transform',
    icon: 'λ',
    color: '#a78bfa',
    description: 'Trasforma, filtra o scarta ogni riga con istruzioni ed espressioni.',
    // `lang` è sparito: prometteva TypeScript o Java, ma nessun codegen ha
    // mai avuto un generatore per lo Script e il motore non ha mai eseguito
    // né l'uno né l'altro. Il corpo è ora un linguaggio di istruzioni su
    // FPEL — v. src-tauri/docs/design-nodo-script.md.
    fields: [
      { key: 'sourceMode', label: 'Row source', type: 'select', default: 'flusso',
        options: ['flusso', 'genera'] },
      { key: 'code', label: 'Instructions', type: 'code',
        default: '// I campi si usano per nome; "let" per i valori intermedi.\n// Istruzioni: let, assegnazione, if/else, skip, reject, log, error.\n' },
    ],
  },
  tmap: {
      type: 'tmap',
      label: 'TMap',
      category: 'transform',
      icon: '⇌',
      color: '#a78bfa',
      description: 'Trasformatore visuale multi-input/output con mapping, join lookup e routing condizionale.',
      fields: [
        { key: 'shortLabel', label: 'Label', type: 'text', default: '' },
      ],
    },
  sink_db: {
    type: 'sink_db',
    label: 'DB Sink',
    category: 'output',
    icon: '⬡',
    color: '#3ddc84',
    description: 'Scrive righe in una tabella di database.',
    fields: [
      { key: 'schema',    label: 'Schema',           type: 'text',   default: 'public' },
      { key: 'table',     label: 'Tabella',          type: 'text',   default: '' },
      { key: 'mode',      label: 'Mode',         type: 'select', default: 'insert', options: ['insert','upsert','update','truncate_insert','merge'] },
      { key: 'keyFields', label: 'Key fields',     type: 'text',   default: 'id' },
      { key: 'batchSize', label: 'Batch size',       type: 'number', default: '1000' },
    ],
  },
  sink_kafka: {
    type: 'sink_kafka',
    label: 'Kafka',
    category: 'output',
    icon: '≋',
    color: '#3ddc84',
    description: 'Pubblica righe su un topic Kafka.',
    fields: [
      { key: 'topic',       label: 'Topic',          type: 'text',   default: 'pipeline-out' },
      { key: 'key_field',   label: 'Key field',   type: 'text',   default: 'id' },
      { key: 'valueFormat', label: 'Format',        type: 'select', default: 'json', options: ['json','avro','protobuf','string'] },
      { key: 'acks',        label: 'Acks',           type: 'select', default: 'all', options: ['0','1','all'] },
    ],
  },
  sink_file: {
    type: 'sink_file',
    label: 'File Output',
    category: 'output',
    icon: '▤',
    color: '#3ddc84',
    description: 'Scrive righe su file.',
    fields: [
      { key: 'path',           label: 'Path',    type: 'text',   default: '/data/output.csv' },
      { key: 'format',         label: 'Format',     type: 'select', default: 'csv',       options: ['csv','json','jsonl','parquet','tsv','xml','excel'] },
      { key: 'mode',           label: 'Mode',    type: 'select', default: 'overwrite', options: ['overwrite','append','new','error'] },
      { key: 'partition',      label: 'Partition',  type: 'select', default: 'none',      options: ['none','field','date','size'] },
      { key: 'processingMode', label: 'Processing',type: 'select', default: 'streaming', options: ['streaming','batch'] },
      { key: 'passthrough',    label: 'Pass-through', type: 'text',  default: 'false' },
    ],
  },
    lane_start: {
    type: 'lane_start',
    label: 'Start',
    category: 'input',
    icon: '▶',
    color: '#3ddc84',
    description: 'Punto di avvio della lane. Ha solo un handle di uscita.',
    fields: [
      { key: 'label', label: 'Label', type: 'text', default: 'Start' },
    ],
  },
  lane_end: {
    type: 'lane_end',
    label: 'End',
    category: 'output',
    icon: '⏹',
    color: '#ff5f57',
    description: 'Punto di fine della lane. Ha solo un handle di ingresso.',
    fields: [
      { key: 'label', label: 'Label', type: 'text', default: 'End' },
    ],
  },
  bridge_out: {
    type:        'bridge_out',
    label:       'Bridge Out',
    icon:        '→',
    color:       '#a78bfa',
    category:    'output',
    description: 'Porta di uscita dal flusso della lane — pubblica sul canale bridge.',
    fields: [
      { key: 'channelName',  label: 'Channel name',   type: 'text',   default: '' },
      { key: 'channelColor', label: 'Color',        type: 'text',   default: '#a78bfa' },
      { key: 'syncMode',     label: 'Sincronismo',   type: 'text',   default: 'fire_and_forget' },
      { key: 'transferMode', label: 'Trasferimento', type: 'text',   default: 'content' },
      { key: 'batchSize',    label: 'Batch size',    type: 'number', default: '100' },
      { key: 'bufferSize',   label: 'Buffer size',   type: 'number', default: '0' },
      { key: 'outputMode', label: 'Output mode', type: 'text', default: 'none' },
    ],
  },
  bridge_in: {
    type:        'bridge_in',
    label:       'Bridge In',
    icon:        '←',
    color:       '#a78bfa',
    category:    'input',
    description: "Porta di ingresso da un'altra lane — riceve dal canale bridge.",
    fields: [
      { key: 'channelName',  label: 'Channel name',    type: 'text',   default: '' },
      { key: 'channelColor', label: 'Color',         type: 'text',   default: '#a78bfa' },
      { key: 'syncMode',     label: 'Sincronismo',    type: 'text',   default: 'fire_and_forget' },
      { key: 'timeoutSec',   label: 'Timeout (sec)',  type: 'number', default: '30' },
    ],
  },
  json_parser: {
    type:        'json_parser',
    label:       'JSON Parser',
    category:    'transform',
    icon:        '{ }',
    color:       '#22d3ee',
    description: 'Estrae e trasforma dati JSON in flussi strutturati.',////
    fields:      [],
  },
  xml_parser: {
    type: 'xml_parser', label: 'XML Parser', category: 'transform',
    icon: '</>', color: '#f97316',
    description: 'Estrae e trasforma dati XML in flussi strutturati.',
    fields: [],
  },
   dir_watcher: {
    type: 'dir_watcher',
    label: 'Dir Watcher',
    category: 'input',
    icon: '📁',
    color: '#22d3ee',
    description: 'Osserva una directory per nuovi file (watch) o ne enumera il contenuto (scan).',
    fields: [],
  },

  window: {
    type: 'window',
    label: 'Window',
    category: 'transform',
    icon: 'W',
    color: '#a78bfa',
    description: 'Calcola window functions (ROW_NUMBER, RANK, LAG, LEAD, CUMSUM, MOVING_AVG...).',
    fields: [],
  },

  materialize: {
    type: 'materialize',
    label: 'Materialize',
    category: 'transform',
    icon: '◈',
    color: '#22d3ee',
    description: 'Hashtable in-memory per esecuzione — accessibile da qualsiasi nodo tramite context.materialize().',
    fields: [],
  },

  source_activemq: {
    type: 'source_activemq',
    label: 'ActiveMQ',
    category: 'input',
    icon: '⊛',
    color: '#fb923c',
    description: 'Consumer/Producer ActiveMQ — protocolli STOMP, OpenWire, AMQP.',
    fields: [],
  },

  sink_activemq: {
    type: 'sink_activemq',
    label: 'ActiveMQ Sink',
    category: 'output',
    icon: '⊛',
    color: '#fb923c',
    description: 'Producer ActiveMQ — pubblica messaggi su queue o topic.',
    fields: [],
  },

  source_mqtt: {
    type: 'source_mqtt',
    label: 'MQTT',
    category: 'input',
    icon: '⊙',
    color: '#84cc16',
    description: 'Subscriber MQTT — riceve messaggi da broker MQTT/MQTTS.',
    fields: [],
  },

  sink_mqtt: {
    type: 'sink_mqtt',
    label: 'MQTT Sink',
    category: 'output',
    icon: '⊙',
    color: '#84cc16',
    description: 'Publisher MQTT — pubblica messaggi su topic.',
    fields: [],
  },
    report_generator: {
    type: 'report_generator',
    label: 'Report Generator',
    category: 'transform',
    icon: '📊',
    color: '#f472b6',
    description: 'Bufferizza il flusso e genera un report PDF/HTML/Excel con tabelle e grafici.',
    fields: [],
  },

  mail_sink: {
    type: 'mail_sink',
    label: 'Mail Sink',
    category: 'output',
    icon: '✉',
    color: '#4a9eff',
    description: 'Invia email tramite SMTP, SendGrid, Amazon SES o Mailgun.',
    fields: [],
  },


  transform: {
    type: 'transform',
    label: 'Transform fields',
    category: 'transform',
    icon: '↦',
    color: '#ffb347',
    description: 'Trasforma, rinomina e converte i campi di ogni riga con espressioni FPEL.',

    fields: [
    
    ],
  },
  webhook_receiver: {
    type: 'webhook_receiver', label: 'Webhook Receiver',
    icon: '⤵', color: '#3ddc84', category: 'input',
    description: 'Riceve webhook — server condiviso con HMAC, buffer e dedup.',
    fields: [],
  },
  webhook_responder: {
    type: 'webhook_responder', label: 'Webhook Responder',
    icon: '⤴', color: '#4a9eff', category: 'output',
    description: 'Risponde HEAD/GET con header sintetici dalla riga corrente.',
    fields: [],
  },
  watchdog: {
    type: 'watchdog', label: 'Watchdog',
    icon: '👁', color: '#ffb347', category: 'input',
    description: 'Monitora servizi via HEAD — sblocca il flusso sull\'header atteso.',
    fields: [],
  },
  shell_exec: {
    type:        'shell_exec',
    label:       'Shell',
    icon:        '>_',
    color:       '#22d3ee',
    category:    'transform' as const,
    description: 'Esegue comandi bash/shell locali — output nel flusso.',
    fields:      [],
  },
  ssh_exec: {
    type:        'ssh_exec',
    label:       'SSH',
    icon:        '⌁',
    color:       '#a78bfa',
    category:    'transform' as const,
    description: 'Esegue comandi su host remoto via SSH.',
    fields:      [],
  },
  error_handler: {
    type:        'error_handler',
    label:       'Error Handler',
    icon:        '⚠',
    color:       '#ff5f57',
    category:    'transform' as const,
    description: 'Collettore centrale degli errori della lane — sempre attivo, non eliminabile. Riceve automaticamente ogni errore non gestito da catch/reject (e in copia quelli gestiti, se "Log centralizzato" è attivo).',
    fields:      [],
  },

  stop: {
    type:        'stop',
    label:       'Stop',
    icon:        '⏹',
    color:       '#ff5f57',
    category:    'transform' as const,   // border neutro; la validazione va per _uiRef.type, non per category
    description: 'Controllo di flusso: ferma deliberatamente la lane (rollback + chiusura connessioni) quando il flusso raggiunge questo nodo. Non è un fallimento. Multi-istanza — tipicamente a valle di un reject o di un handle di un filter.',
    fields: [
      { key: 'trigger', label: 'Trigger', type: 'select', default: 'immediate', options: ['immediate', 'after_input'] },
      { key: 'message', label: 'Message', type: 'text', default: '' },
    ],
  },
}

export const PALETTE_SECTIONS = [
  { label: 'Input',     types: [  'source_kafka','source_db', 'source_file', 'source_http', 'source_ftp','ldap_source','github_source','dir_watcher', 'source_activemq', 'source_mqtt', 'webhook_receiver', 'watchdog','bridge_in'] },
  { label: 'Transform', types: [  'log','data_quality', 'union','filter', 'transform', 'join', 'tmap', 'aggregate', 'json_parser', 'xml_parser', 'script', 'window', 'materialize', 'explode','report_generator','pivot','ldap_auth'] },
  { label: 'Output',    types: [ 'json_serializer', 'xml_serializer','sink_db', 'sink_kafka', 'sink_file', 'sink_activemq', 'sink_mqtt', 'sink_ftp','mail_sink', 'webhook_responder','bridge_out'] },
  { label: 'Flow', types: ['stop'] },
  { label: 'DevOps', types: ['shell_exec', 'ssh_exec'] },
]
