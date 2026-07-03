/**
 * src/lib/ftpClient.ts
 *
 * Wrapper TypeScript per i comandi Tauri FTP/SFTP.
 * Usato dal resource panel (test connessione) e dagli executor.
 */
import { invoke } from '@tauri-apps/api/core'

export interface FtpConnection {
  protocol:       'ftp' | 'ftps' | 'sftp'
  host:           string
  port:           number
  user:           string
  password?:      string
  keyPath?:       string
  authType?:      'password' | 'key'
  connectTimeout?: number
}

export interface FtpTestResult {
  ok:         boolean
  message:    string
  elapsed_ms: number
}

export interface FtpFileEntry {
  name:        string
  path:        string
  is_dir:      boolean
  size:        number
  modified_at?: string
}

/** Testa la connessione — usato dal pannello risorsa */
export async function ftpTest(connection: FtpConnection): Promise<FtpTestResult> {
  return invoke<FtpTestResult>('ftp_test', { connection })
}

/** Lista file in una directory remota */
export async function ftpList(
  connection:  FtpConnection,
  remotePath:  string,
  pattern?:    string,
  recursive?:  boolean,
): Promise<FtpFileEntry[]> {
  return invoke<FtpFileEntry[]>('ftp_list', { connection, remotePath, pattern, recursive })
}

/** Legge un file remoto come stringa */
export async function ftpRead(
  connection:  FtpConnection,
  remotePath:  string,
): Promise<string> {
  return invoke<string>('ftp_read', { connection, remotePath })
}

/** Scrive contenuto su un file remoto, restituisce byte scritti */
export async function ftpWrite(
  connection:  FtpConnection,
  remotePath:  string,
  content:     string,
  createDirs?: boolean,
  atomic?:     boolean,
): Promise<number> {
  return invoke<number>('ftp_write', { connection, remotePath, content, createDirs, atomic })
}

/** Costruisce FtpConnection dai props di un nodo e dalla risorsa Lane */
export function buildFtpConnection(
  resource: { config?: Record<string, string> },
  props?:   Record<string, string>,
): FtpConnection {
  const cfg = resource.config ?? {}
  return {
    protocol:       (cfg.protocol ?? 'sftp') as FtpConnection['protocol'],
    host:           cfg.host ?? 'localhost',
    port:           parseInt(cfg.port ?? (cfg.protocol === 'ftp' ? '21' : '22'), 10),
    user:           cfg.user ?? cfg.username ?? '',
    password:       cfg.password ?? '',
    keyPath:        cfg.keyPath ?? cfg.key_path,
    authType:       (cfg.authType ?? 'password') as FtpConnection['authType'],
    connectTimeout: parseInt(props?.connectTimeout ?? cfg.connectTimeout ?? '30', 10),
  }
}
