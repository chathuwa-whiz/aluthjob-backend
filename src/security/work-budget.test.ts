import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkBudget, SingleFlight } from "./work-budget.js";

describe("bounded expensive work", () => {
    it("rejects excess work, releases failed work and cannot release twice", async () => {
        const budget = new WorkBudget(1, "Work");
        const release = budget.acquire();
        assert.throws(() => budget.acquire(), /busy/);
        release(); release();
        await assert.rejects(budget.run(async () => { throw new Error("failed"); }), /failed/);
        const once = budget.acquire();
        assert.throws(() => budget.acquire(), /busy/);
        once();
    });
    it("shares concurrent work and retries after failures", async () => {
        const flight = new SingleFlight<number>();
        let calls = 0;
        const work = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 7; };
        assert.deepEqual(await Promise.all([flight.run(1, work), flight.run(1, work)]), [7, 7]);
        assert.equal(calls, 1);
        await assert.rejects(flight.run(1, async () => { throw new Error("failed"); }), /failed/);
        assert.equal(await flight.run(1, work), 7);
        assert.equal(calls, 2);
    });
});
