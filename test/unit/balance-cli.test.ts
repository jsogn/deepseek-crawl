import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/run.js";
import { cliDependencies as dependencies } from "../helpers/cli.js";

const balanceResponse = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "110.00",
      granted_balance: "10.00",
      topped_up_balance: "100.00",
    },
  ],
};

describe("balance command", () => {
  it("prints human output without a billable POST", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json(balanceResponse),
    );
    const { deps, stdout, stderr } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(await runCli(["balance"], deps)).toBe(0);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.deepseek.com/user/balance");
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.method).toBe("GET");
    expect(stdout.value()).toBe(
      "DeepSeek balance\nAvailable: yes\nCNY: 110.00\n  Granted: 10.00\n  Topped up: 100.00\n",
    );
    expect(stderr.value()).toBe("");
  });

  it("writes normalized JSON atomically for automation", async () => {
    const root = await mkdtemp(join(tmpdir(), "deepseek-crawl-balance-"));
    const output = join(root, "nested", "balance.json");
    const fetchImpl = vi.fn(async () => Response.json(balanceResponse));
    const { deps, stdout } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(await runCli(["balance", "--json", "-o", output], deps)).toBe(0);

    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      version: 1,
      provider: "deepseek",
      available: true,
      balances: [
        {
          currency: "CNY",
          total: "110.00",
          granted: "10.00",
          topped_up: "100.00",
        },
      ],
    });
    expect(stdout.value()).toBe(`Wrote ${output}\n`);
  });

  it("emits normalized JSON on stdout", async () => {
    const fetchImpl = vi.fn(async () => Response.json(balanceResponse));
    const { deps, stdout } = dependencies(fetchImpl as unknown as typeof fetch);

    expect(await runCli(["balance", "--json"], deps)).toBe(0);

    expect(JSON.parse(stdout.value())).toEqual({
      version: 1,
      provider: "deepseek",
      available: true,
      balances: [
        {
          currency: "CNY",
          total: "110.00",
          granted: "10.00",
          topped_up: "100.00",
        },
      ],
    });
  });

  it("documents the non-billable balance command", async () => {
    const { deps, stdout } = dependencies(vi.fn() as unknown as typeof fetch);

    expect(await runCli(["help", "balance"], deps)).toBe(0);

    expect(stdout.value()).toContain("deepseek-crawl balance [--json]");
    expect(stdout.value()).toContain("without making a billable request");
  });
});
