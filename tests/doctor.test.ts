import { describe, expect, it } from "vitest";
import type { DoctorReport } from "../src/cli/doctor.js";
import { formatReport } from "../src/cli/doctor.js";

describe("doctor report formatter", () => {
  it("renders status badges per check", () => {
    const r: DoctorReport = {
      generatedAt: "2024-06-01T00:00:00Z",
      overall: "warn",
      checks: [
        { id: "browser", label: "Browser", status: "warn", detail: "port not reachable", recommendation: "launch it" },
        { id: "packs", label: "Packs", status: "ok", detail: "1 pack ok" },
      ],
    };
    const t = formatReport(r);
    expect(t).toMatch(/\[WARN\] Browser/);
    expect(t).toMatch(/\[OK\]   Packs/);
    expect(t).toMatch(/overall=WARN/);
    expect(t).toMatch(/→ launch it/);
  });
});
