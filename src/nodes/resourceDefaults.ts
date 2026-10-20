// ─── Defaults risorse — unica fonte di verità ─────────────────────

export const HTTP_DEFAULTS = {
  url:      'https://jsonplaceholder.typicode.com/users',
  method:   'GET',
  authType: 'none',
  headers:  '{}',
  timeout:  '30',
} as const



// ─── DB defaults per dialetto ─────────────────────────────────────

export const DB_DEFAULTS = {
  postgresql: {
    dialect:  'postgresql',
    host:     'localhost',
    port:     '5432',
    database: 'mydb',
    schema:   'public',
    user:     'postgres',
    password: '',
    ssl:      'false',
  },
  mysql: {
    dialect:  'mysql',
    host:     'localhost',
    port:     '3306',
    database: 'mydb',
    schema:   '',
    user:     'root',
    password: '',
    charset:  'utf8mb4',
    ssl:      'false',
  },
  sqlite: {
    dialect:  'sqlite',
    host:     '',
    port:     '',
    database: '/data/mydb.sqlite',
    schema:   '',
    user:     '',
    password: '',
    ssl:      'false',
  },
  oracle: {
    dialect:     'oracle',
    host:        'localhost',
    port:        '1521',
    database:    'ORCL',
    schema:      '',
    user:        'system',
    password:    '',
    serviceName: '',
    ssl:         'false',
  },
  informix: {
    dialect:      'informix',
    host:         'localhost',
    port:         '9088',
    database:     'mydb',
    schema:       '',
    user:         'informix',
    password:     '',
    dbServerName: 'ol_informix',
    ssl:          'false',
  },
  // P344: qualunque sorgente ODBC (SQL Server, DB2, …) via DSN o connection string.
  odbc: {
    dialect:          'odbc',
    host:             '',
    port:             '',
    database:         '',
    schema:           '',
    user:             '',
    password:         '',
    dsn:              '',
    connectionString: '',
    ssl:              'false',
  },
} as const

export type DbDialect = keyof typeof DB_DEFAULTS

export const DB_DIALECT_LABELS: Record<DbDialect, string> = {
  postgresql: 'PostgreSQL',
  mysql:      'MySQL',
  sqlite:     'SQLite',
  oracle:     'Oracle',
  informix:   'Informix',
  odbc:       'ODBC',
}

export const DB_DIALECT_COLORS: Record<DbDialect, string> = {
  postgresql: '#336791',
  mysql:      '#00758f',
  sqlite:     '#003b57',
  oracle:     '#c74634',
  informix:   '#0047ab',
  odbc:       '#7a8599',
}

export const DB_DIALECT_PORTS: Record<DbDialect, string> = {
  postgresql: '5432',
  mysql:      '3306',
  sqlite:     '',
  oracle:     '1521',
  informix:   '9088',
  odbc:       '',
}

/** Dialetti che il motore raggiunge via ODBC (P344): servono il gestore ODBC
 *  (unixODBC su Linux/macOS) e il driver del fornitore sulla macchina che esegue. */
export const ODBC_DIALECTS: readonly string[] = ['oracle', 'informix', 'odbc']
export const isOdbcDialect = (d: string): boolean => ODBC_DIALECTS.includes(d)

/** Parametri di connessione per i comandi DB dello studio (db_query,
 *  db_infer_schema, db_list_constraints), presi dalla configurazione della
 *  risorsa. UNICA fonte: prima ogni pannello ne costruiva una copia, e le copie
 *  divergevano (alcune senza serviceName/dbServerName). */
export function dbConnectionParams(cfg: Record<string, unknown>, fallbackDialect = 'postgresql') {
  const s = (k: string): string | undefined => (cfg[k] == null ? undefined : String(cfg[k]))
  const dialect = s('dialect') ?? s('driver') ?? fallbackDialect
  return {
    dialect,
    host:             s('host') ?? 'localhost',
    port:             parseInt(s('port') || DB_DIALECT_PORTS[dialect as DbDialect] || '5432', 10),
    database:         s('database') ?? '',
    user:             s('user') ?? s('username') ?? '',
    password:         s('password') ?? '',
    schema:           s('schema'),
    serviceName:      s('serviceName'),
    dbServerName:     s('dbServerName'),
    charset:          s('charset'),
    ssl:              s('ssl') ?? 'false',
    connectTimeout:   parseInt(s('connectTimeout') ?? s('timeoutSec') ?? '10', 10),
    odbcDriver:       s('odbcDriver'),
    dsn:              s('dsn'),
    connectionString: s('connectionString'),
    odbcParams:       s('odbcParams'),
  }
}