import { appendFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { homedir } from "os";
import * as path from "path";
import { Platform, type FileSystemAdapter } from "obsidian";
import type ObsidianGit from "./main";

export interface DiagnosticEvent {
    event: string;
    operationId?: string;
    [key: string]: unknown;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const RETENTION_DAYS = 14;

function stableHash(value: string): string {
    let hash = 2166136261;
    for (const character of value) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function errorDetails(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
        return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
}

export class Diagnostics {
    private writeQueue = Promise.resolve();
    private readonly vaultHash: string;

    constructor(private readonly plugin: ObsidianGit) {
        const adapter = plugin.app.vault.adapter as FileSystemAdapter;
        this.vaultHash = stableHash(adapter.getBasePath());
    }

    get logDirectory(): string | undefined {
        if (!Platform.isDesktopApp) return undefined;

        let root: string;
        if (process.platform === "darwin") {
            root = path.join(homedir(), "Library", "Logs", "Obsi Sync");
        } else if (process.platform === "win32") {
            root = path.join(
                process.env.LOCALAPPDATA ??
                    path.join(homedir(), "AppData", "Local"),
                "Obsi Sync",
                "logs"
            );
        } else {
            root = path.join(
                process.env.XDG_STATE_HOME ??
                    path.join(homedir(), ".local", "state"),
                "obsi-sync"
            );
        }
        return path.join(root, this.vaultHash);
    }

    get currentLogPath(): string | undefined {
        const directory = this.logDirectory;
        return directory
            ? path.join(
                  directory,
                  `operations-${new Date().toISOString().slice(0, 10)}.jsonl`
              )
            : undefined;
    }

    createOperationId(kind: string): string {
        return `${kind}-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
    }

    record(event: DiagnosticEvent): void {
        if (!Platform.isDesktopApp) return;

        this.writeQueue = this.writeQueue
            .then(async () => {
                const logPath = this.currentLogPath;
                const directory = this.logDirectory;
                if (!logPath || !directory) return;

                await mkdir(directory, { recursive: true });
                await appendFile(
                    logPath,
                    JSON.stringify({
                        timestamp: new Date().toISOString(),
                        vaultHash: this.vaultHash,
                        ...event,
                    }) + "\n",
                    "utf8"
                );
                await this.rotate(directory);
            })
            .catch((error) => {
                console.warn("obsi-sync: failed to write diagnostics", error);
            });
    }

    recordError(
        event: Pick<DiagnosticEvent, "event" | "operationId"> &
            Record<string, unknown>,
        error: unknown
    ): void {
        const details = errorDetails(error);
        this.record({
            ...event,
            error: details.message.slice(0, 2000),
            stack: details.stack?.slice(0, 4000),
        });
    }

    private async rotate(directory: string): Promise<void> {
        const entries = await readdir(directory);
        const now = Date.now();
        for (const entry of entries.filter((item) => item.endsWith(".jsonl"))) {
            const filePath = path.join(directory, entry);
            const fileStat = await stat(filePath).catch(() => undefined);
            if (!fileStat) continue;
            if (
                now - fileStat.mtimeMs > RETENTION_DAYS * 24 * 60 * 60 * 1000 ||
                fileStat.size > MAX_LOG_BYTES
            ) {
                await unlink(filePath).catch(() => undefined);
            }
        }
    }
}
