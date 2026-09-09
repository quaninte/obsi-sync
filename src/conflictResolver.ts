import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { Platform } from "obsidian";
import type ObsiSync from "./main";
import type { ConflictResolutionCli } from "./types";
import { SimpleGit } from "./gitManager/simpleGit";

const MAX_ATTEMPTS = 3;

type ProcessResult = {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
};

export class ConflictResolver {
    constructor(private readonly plugin: ObsiSync) {}

    async resolve(conflicted: string[]): Promise<boolean> {
        const settings = this.plugin.settings.conflictResolution;
        if (
            !settings.enabled ||
            !(this.plugin.gitManager instanceof SimpleGit)
        ) {
            return false;
        }
        if (!settings.model.trim()) {
            this.plugin.displayError(
                "Automatic conflict resolution is enabled, but no model is configured."
            );
            return false;
        }

        const manager = this.plugin.gitManager;
        let remaining = [...conflicted];
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (remaining.length === 0) return true;

            const before = await manager.git.status();
            const allowedPaths = new Set(remaining);
            const prompt = this.buildPrompt(remaining, attempt);
            const result = await this.runCli(
                settings.cli,
                settings.model.trim(),
                prompt,
                manager.absoluteRepoPath,
                settings.timeoutSeconds
            );

            if (result.timedOut) {
                this.plugin.displayError(
                    `Automatic conflict resolution timed out after ${settings.timeoutSeconds} seconds.`
                );
                return false;
            }
            if (result.code !== 0) {
                const detail = (result.stderr || result.stdout).trim();
                this.plugin.displayError(
                    `Automatic conflict resolution failed (${settings.cli}, exit ${result.code})${detail ? `: ${detail.slice(0, 1000)}` : "."}`
                );
                return false;
            }
            if (result.stdout.trim()) {
                this.plugin.log(
                    `Automatic conflict resolver output:\n${result.stdout.trim().slice(-4000)}`
                );
            }

            const afterCli = await manager.git.status();
            const unexpected = afterCli.files
                .map((file) => file.path)
                .filter(
                    (file) =>
                        !allowedPaths.has(file) &&
                        !before.files.some((item) => item.path === file)
                );
            if (unexpected.length > 0) {
                this.plugin.displayError(
                    `Automatic conflict resolution changed unexpected files: ${unexpected.join(", ")}`
                );
                return false;
            }

            const unresolvedMarkers = await this.findConflictMarkers(
                manager.absoluteRepoPath,
                remaining
            );
            if (unresolvedMarkers.length > 0) {
                this.plugin.displayError(
                    `Automatic conflict resolution left conflict markers in: ${unresolvedMarkers.join(", ")}`
                );
                return false;
            }

            remaining =
                afterCli.conflicted.length > 0
                    ? afterCli.conflicted
                    : remaining;
            await manager.git.add(remaining);
            const staged = await manager.git.status();
            if (staged.conflicted.length > 0) {
                this.plugin.displayError(
                    `Git still reports unresolved conflicts in: ${staged.conflicted.join(", ")}`
                );
                return false;
            }

            try {
                await this.continueGitOperation(manager, settings.cli);
                return (await manager.git.status()).conflicted.length === 0;
            } catch (error) {
                const status = await manager.git.status();
                if (
                    status.conflicted.length === 0 ||
                    attempt === MAX_ATTEMPTS
                ) {
                    this.plugin.displayError(
                        `Git could not continue after automatic conflict resolution: ${String(error)}`
                    );
                    return false;
                }
                remaining = status.conflicted;
            }
        }
        return false;
    }

    private buildPrompt(files: string[], attempt: number): string {
        return [
            "You are resolving an existing Git merge or rebase conflict for an Obsidian vault.",
            `This is automatic pass ${attempt} of ${MAX_ATTEMPTS}.`,
            "Resolve the conflict semantically by editing only the listed files.",
            "Do not reset, clean, stash, checkout, abort, commit, push, or edit .git.",
            "Do not modify any file outside this list. Preserve both sides when their content is compatible.",
            `Conflicted files:\n${files.map((file) => `- ${file}`).join("\n")}`,
            "When finished, leave the files saved in the worktree. The host plugin will stage them and continue Git.",
        ].join("\n\n");
    }

    private async continueGitOperation(
        manager: SimpleGit,
        cli: ConflictResolutionCli
    ): Promise<void> {
        const args =
            this.plugin.settings.syncMethod === "rebase"
                ? ["-c", "core.editor=true", "rebase", "--continue"]
                : ["-c", "core.editor=true", "merge", "--continue"];
        try {
            await manager.git.raw(args);
        } catch (error) {
            this.plugin.log(
                `Git continuation after ${cli} resolver failed: ${String(error)}`
            );
            throw error;
        }
    }

    private async findConflictMarkers(
        repoPath: string,
        files: string[]
    ): Promise<string[]> {
        const unresolved: string[] = [];
        for (const file of files) {
            try {
                const content = await fs.readFile(
                    path.join(repoPath, file),
                    "utf8"
                );
                if (
                    content.includes("<<<<<<<") ||
                    content.includes("=======") ||
                    content.includes(">>>>>>>")
                ) {
                    unresolved.push(file);
                }
            } catch {
                // Git will report a deleted/unreadable path as unresolved when appropriate.
            }
        }
        return unresolved;
    }

    private runCli(
        cli: ConflictResolutionCli,
        model: string,
        prompt: string,
        cwd: string,
        timeoutSeconds: number
    ): Promise<ProcessResult> {
        const executable = Platform.isWin ? `${cli}.cmd` : cli;
        const args =
            cli === "codex"
                ? [
                      "exec",
                      "--model",
                      model,
                      "--dangerously-bypass-approvals-and-sandbox",
                      "--cd",
                      cwd,
                      prompt,
                  ]
                : ["run", "--auto", "--model", model, "--dir", cwd, prompt];

        return new Promise((resolve) => {
            let child: ChildProcess;
            try {
                child = spawn(executable, args, {
                    cwd,
                    env: { ...process.env, OBSI_SYNC_CONFLICT_RESOLUTION: "1" },
                    stdio: ["ignore", "pipe", "pipe"],
                    shell: false,
                });
            } catch (error) {
                resolve({
                    code: 1,
                    stdout: "",
                    stderr: String(error),
                    timedOut: false,
                });
                return;
            }

            let stdout = "";
            let stderr = "";
            let timedOut = false;
            const timer = setTimeout(
                () => {
                    timedOut = true;
                    child.kill("SIGTERM");
                    setTimeout(() => child.kill("SIGKILL"), 1000);
                },
                Math.max(1, timeoutSeconds) * 1000
            );

            child.stdout!.on(
                "data",
                (data: Buffer) => (stdout += data.toString())
            );
            child.stderr!.on(
                "data",
                (data: Buffer) => (stderr += data.toString())
            );
            child.on("error", (error) => {
                clearTimeout(timer);
                resolve({
                    code: 1,
                    stdout,
                    stderr: `${stderr}\n${String(error)}`,
                    timedOut,
                });
            });
            child.on("close", (code) => {
                clearTimeout(timer);
                resolve({ code: code ?? 1, stdout, stderr, timedOut });
            });
        });
    }
}
