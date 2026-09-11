import { EventEmitter } from "events";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictResolver } from "../src/conflictResolver";
import { DEFAULT_SETTINGS } from "../src/constants";
import { SimpleGit } from "../src/gitManager/simpleGit";
import { mergeSettingsByPriority } from "../src/types";
import { createFakePlugin, type FakePlugin } from "./helpers/createFakePlugin";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("child_process", () => ({ spawn: spawnMock }));

type GitStatus = {
    files: { path: string }[];
    conflicted: string[];
};

function childProcess({
    code = 0,
    error,
    closeOnKill = false,
    autoClose = true,
    stdout = "",
    stderr = "",
}: {
    code?: number | null;
    error?: Error;
    closeOnKill?: boolean;
    autoClose?: boolean;
    stdout?: string;
    stderr?: string;
} = {}) {
    const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn((signal: string) => {
        if (closeOnKill && signal === "SIGTERM") {
            queueMicrotask(() => child.emit("close", null));
        }
        return true;
    });
    if (autoClose) {
        queueMicrotask(() => {
            if (stdout) child.stdout.emit("data", Buffer.from(stdout));
            if (stderr) child.stderr.emit("data", Buffer.from(stderr));
            if (error) child.emit("error", error);
            else child.emit("close", code);
        });
    }
    return child;
}

function makeResolver(
    statuses: GitStatus[],
    repoPath: string,
    settings: Partial<
        NonNullable<FakePlugin["settings"]>["conflictResolution"]
    > = {}
) {
    const plugin = createFakePlugin();
    plugin.settings = {
        conflictResolution: {
            enabled: true,
            cli: "codex",
            model: "test-model",
            timeoutSeconds: 30,
            ...settings,
        },
        syncMethod: "merge",
    } as FakePlugin["settings"];
    const manager = new SimpleGit(plugin);
    const status = vi.fn<() => Promise<GitStatus>>();
    for (const value of statuses) status.mockResolvedValueOnce(value);
    const add = vi.fn().mockResolvedValue(undefined);
    const raw = vi.fn().mockResolvedValue("");
    manager.git = {
        status,
        add,
        raw,
    } as unknown as SimpleGit["git"];
    manager.absoluteRepoPath = repoPath;
    plugin.gitManager = manager;
    return {
        plugin,
        manager,
        resolver: new ConflictResolver(plugin),
        add,
        raw,
    };
}

function status(
    pathname: string,
    conflicted: string[] = [pathname]
): GitStatus {
    return { files: [{ path: pathname }], conflicted };
}

describe("ConflictResolver", () => {
    let repoPath: string;

    beforeEach(() => {
        repoPath = mkdtempSync(path.join(tmpdir(), "obsi-sync-resolver-"));
        writeFileSync(path.join(repoPath, "note.md"), "resolved\n");
        spawnMock.mockReset();
        Platform.isWin = false;
    });

    afterEach(() => {
        rmSync(repoPath, { recursive: true, force: true });
    });

    it("provides and merges backward-compatible resolver settings", () => {
        expect(DEFAULT_SETTINGS.conflictResolution).toEqual({
            enabled: false,
            cli: "codex",
            model: "",
            timeoutSeconds: 300,
        });
        const merged = mergeSettingsByPriority(DEFAULT_SETTINGS, {
            ...DEFAULT_SETTINGS,
            conflictResolution: {
                enabled: true,
                cli: "opencode",
                model: "openai/test",
                timeoutSeconds: 60,
            },
        });
        expect(merged.conflictResolution).toEqual({
            enabled: true,
            cli: "opencode",
            model: "openai/test",
            timeoutSeconds: 60,
        });
    });

    it("runs Codex, stages the conflict, and continues a merge", async () => {
        spawnMock.mockImplementation(() =>
            childProcess({ stdout: "resolver finished" })
        );
        const { resolver, add, raw } = makeResolver(
            [
                status("note.md"),
                status("note.md"),
                status("note.md", []),
                status("note.md", []),
            ],
            repoPath
        );

        await expect(resolver.resolve(["note.md"])).resolves.toBe(true);

        expect(spawnMock).toHaveBeenCalledWith(
            "codex",
            expect.arrayContaining([
                "exec",
                "--model",
                "test-model",
                "--dangerously-bypass-approvals-and-sandbox",
                "--cd",
                repoPath,
            ]),
            expect.objectContaining({ cwd: repoPath, shell: false })
        );
        expect(add).toHaveBeenCalledWith(["note.md"]);
        expect(raw).toHaveBeenCalledWith([
            "-c",
            "core.editor=true",
            "merge",
            "--continue",
        ]);
    });

    it("runs OpenCode and supports a resolver that already stages files", async () => {
        Platform.isWin = true;
        spawnMock.mockImplementation(() => childProcess());
        const { resolver, raw } = makeResolver(
            [
                status("note.md"),
                status("note.md", []),
                status("note.md", []),
                status("note.md", []),
            ],
            repoPath,
            { cli: "opencode", model: "openai/test" }
        );

        await expect(resolver.resolve(["note.md"])).resolves.toBe(true);
        expect(spawnMock).toHaveBeenCalledWith(
            "opencode.cmd",
            expect.arrayContaining([
                "run",
                "--auto",
                "--model",
                "openai/test",
                "--dir",
                repoPath,
            ]),
            expect.anything()
        );
        expect(raw).toHaveBeenCalledWith([
            "-c",
            "core.editor=true",
            "merge",
            "--continue",
        ]);
    });

    it("repairs staged integrity failures and lets the host restage the file", async () => {
        spawnMock.mockImplementation(() => {
            writeFileSync(path.join(repoPath, "note.md"), "resolved\n");
            return childProcess({ stdout: "integrity repaired" });
        });
        const { resolver, manager, add, raw } = makeResolver(
            [status("note.md", []), status("note.md", [])],
            repoPath
        );
        raw.mockResolvedValueOnce("note.md\n");
        vi.spyOn(manager, "verifyStagedIntegrity").mockResolvedValue({
            ok: true,
            issues: [],
        });

        await expect(
            resolver.repairIntegrity(
                [
                    {
                        kind: "diff-check",
                        path: "note.md",
                        detail: "note.md:1: trailing whitespace.",
                    },
                ],
                "staged-files"
            )
        ).resolves.toBe(true);

        expect(spawnMock).toHaveBeenCalledWith(
            "codex",
            expect.arrayContaining([
                "exec",
                "--dangerously-bypass-approvals-and-sandbox",
                "--cd",
                repoPath,
            ]),
            expect.objectContaining({ cwd: repoPath, shell: false })
        );
        const spawnCall = spawnMock.mock.calls[0] as [
            string,
            string[],
            { env: NodeJS.ProcessEnv },
        ];
        expect(spawnCall[2].env.OBSI_SYNC_INTEGRITY_REPAIR).toBe("1");
        expect(add).toHaveBeenCalledWith(["note.md"]);
        expect(raw).not.toHaveBeenCalledWith(
            expect.arrayContaining(["commit"])
        );
    });

    it("rejects missing configuration, disabled resolution, and mobile backends", async () => {
        const disabled = makeResolver([], repoPath, { enabled: false });
        await expect(disabled.resolver.resolve(["note.md"])).resolves.toBe(
            false
        );
        expect(spawnMock).not.toHaveBeenCalled();

        const empty = makeResolver([], repoPath);
        await expect(empty.resolver.resolve([])).resolves.toBe(true);
        expect(spawnMock).not.toHaveBeenCalled();

        const missingModel = makeResolver([], repoPath, { model: "" });
        await expect(missingModel.resolver.resolve(["note.md"])).resolves.toBe(
            false
        );
        expect(missingModel.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("no model")
        );

        const mobile = createFakePlugin();
        mobile.settings = {
            conflictResolution: { enabled: true, model: "test" },
        } as FakePlugin["settings"];
        mobile.gitManager = {} as FakePlugin["gitManager"];
        await expect(
            new ConflictResolver(mobile).resolve(["note.md"])
        ).resolves.toBe(false);
    });

    it("fails closed for CLI errors, unexpected files, and conflict markers", async () => {
        spawnMock.mockImplementationOnce(() => childProcess({ code: 2 }));
        const failed = makeResolver([status("note.md")], repoPath);
        await expect(failed.resolver.resolve(["note.md"])).resolves.toBe(false);
        expect(failed.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("failed")
        );

        spawnMock.mockClear();
        spawnMock.mockImplementationOnce(() => {
            throw new Error("spawn threw synchronously");
        });
        const thrown = makeResolver([status("note.md")], repoPath);
        await expect(thrown.resolver.resolve(["note.md"])).resolves.toBe(false);
        expect(thrown.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("failed")
        );

        spawnMock.mockImplementationOnce(() => childProcess());
        const unexpected = makeResolver(
            [
                status("note.md"),
                {
                    files: [{ path: "note.md" }, { path: "other.md" }],
                    conflicted: ["note.md"],
                },
            ],
            repoPath
        );
        await expect(unexpected.resolver.resolve(["note.md"])).resolves.toBe(
            false
        );
        expect(unexpected.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("unexpected files")
        );

        writeFileSync(
            path.join(repoPath, "note.md"),
            "<<<<<<< HEAD\nlocal\n=======\nremote\n>>>>>>> origin/main\n"
        );
        spawnMock.mockImplementationOnce(() => childProcess());
        const markers = makeResolver(
            [status("note.md"), status("note.md")],
            repoPath
        );
        await expect(markers.resolver.resolve(["note.md"])).resolves.toBe(
            false
        );
        expect(markers.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("conflict markers")
        );
    });

    it("handles unresolved staging, continuation retries, and continuation failure", async () => {
        spawnMock.mockImplementationOnce(() => childProcess());
        const unresolved = makeResolver(
            [status("note.md"), status("note.md"), status("note.md")],
            repoPath
        );
        await expect(unresolved.resolver.resolve(["note.md"])).resolves.toBe(
            false
        );
        expect(unresolved.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("still reports unresolved")
        );

        spawnMock.mockClear();
        spawnMock
            .mockImplementationOnce(() => childProcess())
            .mockImplementationOnce(() => childProcess());
        const retry = makeResolver(
            [
                status("note.md"),
                status("note.md"),
                status("note.md", []),
                status("note.md"),
                status("note.md"),
                status("note.md", []),
                status("note.md", []),
                status("note.md", []),
            ],
            repoPath
        );
        retry.raw
            .mockRejectedValueOnce(new Error("still conflicted"))
            .mockResolvedValueOnce("");
        await expect(retry.resolver.resolve(["note.md"])).resolves.toBe(true);
        expect(spawnMock).toHaveBeenCalledTimes(2);

        spawnMock.mockClear();
        spawnMock.mockImplementationOnce(() => childProcess());
        const continuation = makeResolver(
            [
                status("note.md"),
                status("note.md"),
                status("note.md", []),
                status("note.md", []),
            ],
            repoPath
        );
        continuation.raw.mockRejectedValue(new Error("cannot continue"));
        await expect(continuation.resolver.resolve(["note.md"])).resolves.toBe(
            false
        );
        expect(continuation.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("could not continue")
        );

        spawnMock.mockClear();
        spawnMock.mockImplementationOnce(() => childProcess());
        const rebase = makeResolver(
            [
                status("note.md"),
                status("note.md"),
                status("note.md", []),
                status("note.md", []),
            ],
            repoPath
        );
        rebase.plugin.settings.syncMethod = "rebase";
        await expect(rebase.resolver.resolve(["note.md"])).resolves.toBe(true);
        expect(rebase.raw).toHaveBeenCalledWith([
            "-c",
            "core.editor=true",
            "rebase",
            "--continue",
        ]);
    });

    it("times out a stuck CLI and reports spawn errors", async () => {
        vi.useFakeTimers();
        try {
            spawnMock.mockImplementationOnce(() =>
                childProcess({ closeOnKill: true, autoClose: false })
            );
            const timedOut = makeResolver([status("note.md")], repoPath, {
                timeoutSeconds: 30,
            });
            const promise = timedOut.resolver.resolve(["note.md"]);
            await vi.advanceTimersByTimeAsync(30_000);
            await expect(promise).resolves.toBe(false);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(timedOut.plugin.displayError).toHaveBeenCalledWith(
                expect.stringContaining("timed out")
            );
        } finally {
            vi.useRealTimers();
        }

        spawnMock.mockImplementationOnce(() =>
            childProcess({
                error: new Error("missing CLI"),
                stderr: "not found",
            })
        );
        const spawnError = makeResolver([status("note.md")], repoPath);
        await expect(spawnError.resolver.resolve(["note.md"])).resolves.toBe(
            false
        );
        expect(spawnError.plugin.displayError).toHaveBeenCalledWith(
            expect.stringContaining("failed")
        );
    });
});
