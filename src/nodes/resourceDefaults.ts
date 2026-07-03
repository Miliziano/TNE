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
} as const

export type DbDialect = keyof typeof DB_DEFAULTS

export const DB_DIALECT_LABELS: Record<DbDialect, string> = {
  postgresql: 'PostgreSQL',
  mysql:      'MySQL',
  sqlite:     'SQLite',
  oracle:     'Oracle',
  informix:   'Informix',
}

export const DB_DIALECT_COLORS: Record<DbDialect, string> = {
  postgresql: '#336791',
  mysql:      '#00758f',
  sqlite:     '#003b57',
  oracle:     '#c74634',
  informix:   '#0047ab',
}

export const DB_DIALECT_PORTS: Record<DbDialect, string> = {
  postgresql: '5432',
  mysql:      '3306',
  sqlite:     '',
  oracle:     '1521',
  informix:   '9088',
}