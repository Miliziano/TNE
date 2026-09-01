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
import { LdapSourcePanel } from './types/ldap_source/Panel'
import { LdapAuthPanel } from './types/ldap_auth/Panel'
import { GithubSourcePanel } from './types/github_source/Panel'
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
import { ShellExecPanel, SshExecPanel } from './types/shell_exec/Panel'
import { ErrorHandlerPanel } from './types/error_handler/Panel'
import { StopPanel } from './types/stop/Panel'
import { ErrorHandlerNodesPanel } from './types/error_handler/MappingPanel'
import { UnionPreviewPanel } from './types/union/PreviewPanel'
import { TransformPreviewPanel } from './types/transform/PreviewPanel'
import { SourceDbPreviewPanel } from './types/source_db/PreviewPanel'

// NODE_DEFS + PALETTE_SECTIONS vivono ora in ./nodeDefs (dati puri, senza React);
// qui li ri-esportiamo così gli importatori storici (`from '.../registry'`) non cambiano.
export { NODE_DEFS, PALETTE_SECTIONS } from './nodeDefs'

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
  ldap_source: LdapSourcePanel,
  github_source: GithubSourcePanel,
  ldap_auth: LdapAuthPanel,
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
  shell_exec: ShellExecPanel,
  ssh_exec:   SshExecPanel,
  error_handler: ErrorHandlerPanel,
  stop:          StopPanel,
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
  union:   UnionPreviewPanel,
  transform: TransformPreviewPanel,
  source_db: SourceDbPreviewPanel,
  
}
export const NODE_SIDEBAR_PANELS: Record<string, ComponentType<{ nodeId: string }>> = {
  source_file: SourceFileSidebarPanel,
  dir_watcher: DirWatcherSidebarPanel,
 // bridge_in: BridgeInPanel,
}