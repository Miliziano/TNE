import type { NodeDef } from '../types'
// ─── Pannelli personalizzati per tipo di nodo ─────────────────────
import type { ComponentType } from 'react'
import { SourceDbPanel }   from './types/source_db/Panel'
import { SourceFilePanel } from './types/source_file/Panel'
import { SourceHttpPanel } from './types/source_http/Panel'
//import { FilterPanel }     from './types/filter/Panel'

import { JoinPanel }       from './types/join/Panel'
import { AggregatePanel }  from './types/aggregate/Panel'
import { ScriptPanel }     from './types/script/Panel'
import { SinkDbPanel}     from './types/sink_db/Panel'
import { SinkKafkaPanel }  from './types/sink_kafka/Panel'
import { SinkFilePanel }   from './types/sink_file/Panel'
import { ScriptMappingPanel } from './types/script/MappingPanel'
import { HttpMappingPanel } from './types/source_http/HttpMappingPanel'
import { HTTP_DEFAULTS } from '../nodes/resourceDefaults'
import { DbMappingPanel } from './types/source_db/DbMappingPanel'
import { SourceDbQueryPanel } from './types/source_db/QueryPanel'
import { SinkDbQueryPanel } from './types/sink_db/QueryPanel'

import { DirWatcherPanel }  from './types/dir_watcher/Panel'
import { WindowPanel }       from './types/window/Panel'
import { MaterializePanel }  from './types/materialize/Panel'
import { ActiveMQPanel }     from './types/activemq/Panel'
import { MQTTPanel }         from './types/mqtt/Panel'
import { ReportGeneratorPanel } from './types/report_generator/Panel'
import { MailSinkPanel }        from './types/mail_sink/Panel'

import { BridgePanel } from './types/bridge/Panel'
import { BridgeInMappingPanel } from './types/bridge/MappingPanel'
import { SourceFileSidebarPanel }  from './types/source_file/SidebarPanel'
import { DirWatcherSidebarPanel }  from './types/dir_watcher/SidebarPanel'
import { ExplodePanel } from './types/explode/Panel'
import { MaterializeMappingPanel } from './types/materialize/MappingPanel'
import { ExplodeMappingPanel }     from './types/explode/MappingPanel'
import { AggregateMappingPanel } from './types/aggregate/MappingPanel'
import { PivotPanel } from './types/pivot/Panel'
import { PivotMappingPanel } from './types/pivot/MappingPanel'
import { SourceFtpPanel } from './types/source_ftp/Panel'
import { SinkFtpPanel }   from './types/sink_ftp/Panel'
import { JsonSerializerPanel } from './types/json_serializer/Panel'
import { XmlSerializerPanel }  from './types/xml_serializer/Panel'
import { DataQualityPanel }    from './types/data_quality/Panel'
import { KafkaSourcePanel }    from './types/source_kafka/Panel'
import { UnionPanel }          from './types/union/Panel'
import { LogPanel } from './types/log/Panel'
import { LogMappingPanel } from './types/log/MappingPanel'
import { DataQualityMappingPanel } from './types/data_quality/MappingPanel'
import { FilterPanel }        from './types/filter/Panel'
import { FilterMappingPanel } from './types/filter/MappingPanel'
import { ReportGeneratorMappingPanel } from './types/report_generator/MappingPanel'
import { UnionMappingPanel } from './types/union/MappingPanel'
import { JoinMappingPanel } from './types/join/MappingPanel'
import { FtpMappingPanel } from './types/source_ftp/MappingPanel'
import { SinkDbMappingPanel } from './types/sink_db/MappingPanel'
import { SinkDbPreviewPanel } from './types/sink_db/PreviewPanel'
// Import: sostituisci MapPanel con TransformPanel
import { TransformPanel } from './types/transform/Panel'
  import { WebhookReceiverPanel }  from './types/webhook/Panel'
import { WebhookResponderPanel } from './types/webhook/Panel'
import { WatchdogPanel_ as WatchdogPanel } from './types/webhook/Panel'
import { SequencerPanel } from './types/sequencer/Panel'
import { ShellExecPanel, SshExecPanel } from './types/shell_exec/Panel'
import { ErrorHandlerPanel } from './types/error_handler/Panel'
import { ErrorHandlerNodesPanel } from './types/error_handler/MappingPanel'

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
      { key: 'schema',       label: 'Schema',          type: 'text',   default: 'public' },
      { key: 'table',        label: 'Tabella',         type: 'text',   default: '' },
      { key: 'limit',        label: 'Limite righe',    type: 'number', default: '0' },
      { key: 'orderBy',      label: 'Ordina per',      type: 'text',   default: '' },
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
    { key: 'method',       label: 'Metodo',        type: 'select', default: 'GET', options: ['GET','POST','PUT','PATCH','DELETE'] },
    { key: 'responseType', label: 'Tipo risposta', type: 'select', default: 'json', options: ['json','text','xml','binary','pdf','csv'] },
    { key: 'authType',     label: 'Auth',          type: 'select', default: 'none', options: ['none','basic','bearer','api_key','digest','oauth2_cc','oauth2_ac'] },
    { key: 'customFields', label: 'Campi JSON',    type: 'text',   default: '[]' },
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
  
  
  join: {
    type: 'join',
    label: 'Join',
    category: 'transform',
    icon: '⋈',
    color: '#ffb347',
    description: 'Unisce due flussi su un campo chiave.',
    fields: [
      { key: 'join_type', label: 'Tipo join', type: 'select', default: 'inner', options: ['inner','left','right','full'] },
      { key: 'key',       label: 'Campo chiave', type: 'text', default: 'user_id' },
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
      { key: 'functions', label: 'Funzioni',       type: 'code', default: '{"count": "*", "sum": "amount"}' },
    ],
  },
  script: {
    type: 'script',
    label: 'Script',
    category: 'transform',
    icon: 'λ',
    color: '#a78bfa',
    description: 'Esegue codice personalizzato su ogni riga.',
    fields: [
      { key: 'lang', label: 'Linguaggio', type: 'select', default: 'typescript', options: ['typescript','java'] },
      { key: 'code', label: 'Codice',     type: 'code',   default: '// row è disponibile come input\nreturn row' },
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
        { key: 'shortLabel', label: 'Etichetta', type: 'text', default: '' },
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
      { key: 'mode',      label: 'Modalità',         type: 'select', default: 'insert', options: ['insert','upsert','update','truncate_insert','merge'] },
      { key: 'keyFields', label: 'Campi chiave',     type: 'text',   default: 'id' },
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
      { key: 'key_field',   label: 'Campo chiave',   type: 'text',   default: 'id' },
      { key: 'valueFormat', label: 'Formato',        type: 'select', default: 'json', options: ['json','avro','protobuf','string'] },
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
      { key: 'path',           label: 'Percorso',    type: 'text',   default: '/data/output.csv' },
      { key: 'format',         label: 'Formato',     type: 'select', default: 'csv',       options: ['csv','json','jsonl','parquet','tsv','xml','excel'] },
      { key: 'mode',           label: 'Modalità',    type: 'select', default: 'overwrite', options: ['overwrite','append','new','error'] },
      { key: 'partition',      label: 'Partizione',  type: 'select', default: 'none',      options: ['none','field','date','size'] },
      { key: 'processingMode', label: 'Elaborazione',type: 'select', default: 'streaming', options: ['streaming','batch'] },
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
      { key: 'label', label: 'Etichetta', type: 'text', default: 'Start' },
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
      { key: 'label', label: 'Etichetta', type: 'text', default: 'End' },
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
      { key: 'channelName',  label: 'Nome canale',   type: 'text',   default: '' },
      { key: 'channelColor', label: 'Colore',        type: 'text',   default: '#a78bfa' },
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
      { key: 'channelName',  label: 'Nome canale',    type: 'text',   default: '' },
      { key: 'channelColor', label: 'Colore',         type: 'text',   default: '#a78bfa' },
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
    type: 'map',
    label: 'Transform fields',
    category: 'transform',
    icon: '↦',
    color: '#ffb347',
    description: 'Trasforma, rinomina e converte i campi di ogni riga.',
    fields: [
      { key: 'mapping',    label: 'Mapping (JSON)', type: 'code',   default: '{"id": "user_id"}' },
      { key: 'drop_nulls', label: 'Scarta null',    type: 'select', default: 'false', options: ['true','false'] },
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
  sequencer: {
    type:        'sequencer',
    label:       'Sequencer',
    icon:        '⬇',
    color:       '#a78bfa',
    category:    'transform' as const,
    description: 'Avvia pipeline in sequenza — una dopo l\'altra con condizioni onOk/onError/always.',
    fields: [
      { key: 'seqCount', label: 'Sequenze', type: 'number', default: '2' },  // ← aggiungere
    ],
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
}
 

 


export const PALETTE_SECTIONS = [
  { label: 'Input',     types: [  'source_kafka','source_db', 'source_file', 'source_http', 'source_ftp','dir_watcher', 'source_activemq', 'source_mqtt', 'webhook_receiver', 'watchdog','bridge_in'] },
  { label: 'Transform', types: [  'log','sequencer','data_quality', 'union','filter', 'transform', 'join', 'tmap', 'aggregate', 'json_parser', 'xml_parser', 'script', 'window', 'materialize', 'explode','report_generator','pivot'] },
  { label: 'Output',    types: [ 'json_serializer', 'xml_serializer','sink_db', 'sink_kafka', 'sink_file', 'sink_activemq', 'sink_mqtt', 'sink_ftp','mail_sink', 'webhook_responder','bridge_out'] },
  { label: 'DevOps', types: ['shell_exec', 'ssh_exec'] },
]

// ─── Pannelli personalizzati per tipo di nodo ─────────────────────

export const NODE_PANELS: Record<string, ComponentType<{ nodeId: string }>> = {
 source_db:      SourceDbPanel,
  source_file:    SourceFilePanel,
  source_http:    SourceHttpPanel,
 
  join:           JoinPanel,
  aggregate:      AggregatePanel,
  script:         ScriptPanel,
  sink_db:        SinkDbPanel,
  sink_kafka:     SinkKafkaPanel,
  sink_file:      SinkFilePanel,
  dir_watcher:    DirWatcherPanel,  // ← nuovo
  window:         WindowPanel,      // ← nuovo
  materialize:    MaterializePanel, // ← nuovo
  source_activemq: ActiveMQPanel,   // ← nuovo (consumer mode preset)
  sink_activemq:   ActiveMQPanel,   // ← stesso panel, mode preset diverso
  source_mqtt:     MQTTPanel,       // ← nuovo (subscriber mode preset)
  sink_mqtt:       MQTTPanel,       // ← stesso panel, mode preset diverso
  report_generator: ReportGeneratorPanel,
  mail_sink:        MailSinkPanel,

  bridge_out: BridgePanel,
  bridge_in:  BridgePanel,
  explode: ExplodePanel,
  pivot: PivotPanel,   // ← aggiungere
  source_ftp: SourceFtpPanel,
  sink_ftp:   SinkFtpPanel,
  //json_serializer: JsonSerializerPanel,
  xml_serializer:  XmlSerializerPanel,
  data_quality:    DataQualityPanel,
  source_kafka:    KafkaSourcePanel,
  union:           UnionPanel,
  log: LogPanel,
  filter: FilterPanel,
  webhook_receiver:  WebhookReceiverPanel,
  webhook_responder: WebhookResponderPanel,
  watchdog:          WatchdogPanel,
  sequencer: SequencerPanel,
  shell_exec: ShellExecPanel,
  ssh_exec:   SshExecPanel,
  error_handler: ErrorHandlerPanel,
}

import { SourceFileMappingPanel } from './types/source_file/MappingPanel'

import { SinkFileMappingPanel } from './types/sink_file/MappingPanel'

export const NODE_MAPPING_PANELS: Record<string, ComponentType<{ nodeId: string }>> = {
  source_file: SourceFileMappingPanel,
  sink_file:   SinkFileMappingPanel,
  script: ScriptMappingPanel,
  source_http: HttpMappingPanel,
  source_db: DbMappingPanel,
  materialize: MaterializeMappingPanel,   // ← aggiungere
  explode:     ExplodeMappingPanel,       // ← aggiungere
  aggregate:    AggregateMappingPanel,   // ← aggiungere
  pivot: PivotMappingPanel,
  log: LogMappingPanel,
  data_quality: DataQualityMappingPanel,
  filter: FilterMappingPanel,
  report_generator: ReportGeneratorMappingPanel,
  union: UnionMappingPanel,
  join: JoinMappingPanel,
  source_ftp: FtpMappingPanel,
  bridge_in: BridgeInMappingPanel,
  sink_db: SinkDbMappingPanel,
  transform: TransformPanel,
  error_handler: ErrorHandlerNodesPanel,
}
export const NODE_QUERY_PANELS: Record<string, ComponentType<{ nodeId: string }>> = {
  source_db: SourceDbQueryPanel,
  sink_db: SinkDbQueryPanel,
 
}

export const NODE_PREVIEW_PANELS: Record<string, ComponentType<{ nodeId: string }>> = {
  sink_db: SinkDbPreviewPanel,
}
export const NODE_SIDEBAR_PANELS: Record<string, ComponentType<{ nodeId: string }>> = {
  source_file: SourceFileSidebarPanel,
  dir_watcher: DirWatcherSidebarPanel,
 // bridge_in: BridgeInPanel,
}