import { describe, expect, it } from "bun:test";
import { answersTreeSitterVersion } from "../../../src/services/smart-file-read/tree-sitter-cli-provision.js";

type ProbeCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

/** Answers after the caller's try block, like a real child process's callback. */
function execFileAnswering(
  error: NodeJS.ErrnoException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) {
  return (
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: ProbeCallback,
  ) => {
    queueMicrotask(() => callback(error, stdout, stderr));
    return { stdin: { end() {} } };
  };
}

/** A probe that never settles is the failure this test file exists for. */
function settlesWithinSecond<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the probe never settled")), 1000);
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

describe("answersTreeSitterVersion output handling", () => {
  it("accepts a version answer that arrives as a Buffer", async () => {
    const probe = await settlesWithinSecond(answersTreeSitterVersion(
      "/missing",
      execFileAnswering(null, Buffer.from("tree-sitter 0.26.9\n"), Buffer.from("")),
    ));

    expect(probe).toEqual({ usable: true });
  });

  it("reads a spawn failure from Buffer stderr instead of throwing", async () => {
    const error = Object.assign(new Error("spawn tree-sitter ENOENT"), { code: "ENOENT" });
    const probe = await settlesWithinSecond(answersTreeSitterVersion(
      "/missing",
      execFileAnswering(error, Buffer.from(""), Buffer.from("libc: cannot load\nsecond line")),
    ));

    expect(probe).toEqual({ usable: false, reason: "libc: cannot load" });
  });

  it("still reads string output", async () => {
    const probe = await settlesWithinSecond(answersTreeSitterVersion(
      "/missing",
      execFileAnswering(null, "tree-sitter 0.26.9\n", ""),
    ));

    expect(probe).toEqual({ usable: true });
  });
});
