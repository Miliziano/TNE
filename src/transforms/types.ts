import type { TransformCategory } from './catalog'

export type TransformMode = 'pipeline' | 'inline' | 'script'

export interface PipelineStep {
  id:       string
  fnId:     string                    // riferimento a catalog
  params:   Record<string, string>    // parametri configurati
  label?:   string                    // override label display
}

export interface CastStep {
  fromType: TransformCategory
  toType:   TransformCategory
  format?:  string
}

export interface FieldTransform {
  mode:       TransformMode
  pipeline?:  PipelineStep[]          // usato in modalità pipeline
  cast?:      CastStep                // cast esplicito se tipi diversi
  expression?: string                 // usato in modalità inline/script
  outputType: TransformCategory
  outputName: string
}