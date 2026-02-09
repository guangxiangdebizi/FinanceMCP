import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * MCP 标准日志系统
 *
 * 符合 Model Context Protocol 官方规范：
 * - STDIO 模式：日志输出到 stderr（不污染 stdout 的 MCP 通信）
 * - 文件存储：生产环境持久化
 * - 自动清理：防止磁盘无限增长
 *
 * 官方文档：https://modelcontextprotocol.io/docs/develop/build-server#logging-in-mcp-servers
 */

enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3
}

class Logger {
  private logLevel: LogLevel;
  private logToFile: boolean;
  private logToStderr: boolean;
  private logsDir: string;
  private maxLogFiles: number;
  private maxLogSize: number; // bytes

  constructor() {
    // 从环境变量读取配置
    this.logLevel = this.parseLogLevel(process.env.LOG_LEVEL || 'INFO');
    this.logToFile = process.env.LOG_TO_FILE !== 'false'; // 默认开启
    this.logToStderr = process.env.LOG_TO_STDERR !== 'false'; // 默认开启
    this.maxLogFiles = parseInt(process.env.LOG_MAX_FILES || '7', 10); // 保留 7 天
    this.maxLogSize = parseInt(process.env.LOG_MAX_SIZE || '10485760', 10); // 10MB

    // 日志目录：优先使用环境变量，否则使用用户数据目录
    const customLogsDir = process.env.LOG_DIR;
    if (customLogsDir) {
      this.logsDir = customLogsDir;
    } else {
      // 跨平台用户数据目录
      const platform = os.platform();
      const baseDir = platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'finance-mcp')
        : platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Logs', 'finance-mcp')
        : path.join(os.homedir(), '.local', 'share', 'finance-mcp', 'logs');

      this.logsDir = baseDir;
    }

    // 确保日志目录存在
    if (this.logToFile && !fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // 启动时清理旧日志
    if (this.logToFile) {
      this.cleanOldLogs();
    }
  }

  private parseLogLevel(level: string): LogLevel {
    const levels: Record<string, LogLevel> = {
      'ERROR': LogLevel.ERROR,
      'WARN': LogLevel.WARN,
      'INFO': LogLevel.INFO,
      'DEBUG': LogLevel.DEBUG
    };
    return levels[level.toUpperCase()] ?? LogLevel.INFO;
  }

  private formatMessage(level: string, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
  }

  private getCurrentLogFile(): string {
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    return path.join(this.logsDir, `combined-${date}.log`);
  }

  private getErrorLogFile(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logsDir, `error-${date}.log`);
  }

  private writeToFile(level: string, message: string, formatted: string) {
    if (!this.logToFile) return;

    try {
      // 检查文件大小，超过限制则轮转
      const logFile = this.getCurrentLogFile();
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size >= this.maxLogSize) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const rotatedFile = logFile.replace('.log', `-${timestamp}.log`);
          fs.renameSync(logFile, rotatedFile);
        }
      }

      // 写入日志
      fs.appendFileSync(logFile, formatted + '\n', 'utf8');

      // ERROR 级别同时写入错误日志
      if (level === 'ERROR') {
        fs.appendFileSync(this.getErrorLogFile(), formatted + '\n', 'utf8');
      }
    } catch (error) {
      // 日志写入失败时，输出到 stderr（避免递归错误）
      console.error(`[Logger] Failed to write to log file: ${error}`);
    }
  }

  private writeToStderr(formatted: string) {
    if (this.logToStderr) {
      console.error(formatted); // stderr 是安全的，符合 MCP 标准
    }
  }

  /**
   * 清理超过保留天数的日志文件
   */
  private cleanOldLogs() {
    try {
      if (!fs.existsSync(this.logsDir)) return;

      const now = Date.now();
      const maxAge = this.maxLogFiles * 24 * 60 * 60 * 1000; // 毫秒

      const files = fs.readdirSync(this.logsDir);
      let deletedCount = 0;

      for (const file of files) {
        const filepath = path.join(this.logsDir, file);
        const stats = fs.statSync(filepath);

        // 删除超过保留期的日志
        if (now - stats.mtime.getTime() > maxAge) {
          fs.unlinkSync(filepath);
          deletedCount++;
        }
      }

      if (deletedCount > 0 && process.env.NODE_ENV !== 'production') {
        console.error(`[Logger] Cleaned up ${deletedCount} old log file(s)`);
      }
    } catch (error) {
      console.error(`[Logger] Failed to clean old logs: ${error}`);
    }
  }

  error(message: string, meta?: any) {
    if (this.logLevel >= LogLevel.ERROR) {
      const formatted = this.formatMessage('ERROR', message, meta);
      this.writeToStderr(formatted);
      this.writeToFile('ERROR', message, formatted);
    }
  }

  warn(message: string, meta?: any) {
    if (this.logLevel >= LogLevel.WARN) {
      const formatted = this.formatMessage('WARN', message, meta);
      this.writeToStderr(formatted);
      this.writeToFile('WARN', message, formatted);
    }
  }

  info(message: string, meta?: any) {
    if (this.logLevel >= LogLevel.INFO) {
      const formatted = this.formatMessage('INFO', message, meta);
      this.writeToStderr(formatted);
      this.writeToFile('INFO', message, formatted);
    }
  }

  debug(message: string, meta?: any) {
    if (this.logLevel >= LogLevel.DEBUG) {
      const formatted = this.formatMessage('DEBUG', message, meta);
      this.writeToStderr(formatted);
      this.writeToFile('DEBUG', message, formatted);
    }
  }

  /**
   * 工具调用日志（包含上下文）
   */
  toolCall(toolName: string, params: any, duration?: number) {
    this.info(`Tool called: ${toolName}`, {
      tool: toolName,
      params: this.sanitizeParams(params),
      duration: duration ? `${duration}ms` : undefined
    });
  }

  /**
   * 工具错误日志
   */
  toolError(toolName: string, error: any, params?: any) {
    this.error(`Tool error: ${toolName}`, {
      tool: toolName,
      error: error instanceof Error ? error.message : String(error),
      params: params ? this.sanitizeParams(params) : undefined
    });
  }

  /**
   * API 调用日志
   */
  apiCall(apiName: string, params: any, success: boolean, duration?: number) {
    const level = success ? 'info' : 'error';
    this[level](`API ${success ? 'called' : 'failed'}: ${apiName}`, {
      api: apiName,
      params: this.sanitizeParams(params),
      success,
      duration: duration ? `${duration}ms` : undefined
    });
  }

  /**
   * 清理敏感参数（Token、密码等）
   */
  private sanitizeParams(params: any): any {
    if (!params || typeof params !== 'object') return params;

    const sanitized = { ...params };
    const sensitiveKeys = ['token', 'password', 'api_key', 'secret', 'authorization'];

    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        sanitized[key] = '***REDACTED***';
      }
    }

    return sanitized;
  }
}

// 导出单例
export const logger = new Logger();
