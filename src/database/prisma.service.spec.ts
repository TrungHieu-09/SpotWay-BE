import { withConnectionTimeouts } from "./prisma.service";

describe("withConnectionTimeouts", () => {
  const base =
    "postgresql://user:pa%40ss@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres";

  it("adds connect_timeout and pool_timeout (30 s) when missing and keeps the rest of the URL", () => {
    const url = new URL(withConnectionTimeouts(base, {}));
    expect(url.searchParams.get("connect_timeout")).toBe("30");
    expect(url.searchParams.get("pool_timeout")).toBe("30");
    expect(url.username).toBe("user");
    expect(url.password).toBe("pa%40ss");
    expect(url.host).toBe("aws-0-ap-southeast-2.pooler.supabase.com:5432");
    expect(url.pathname).toBe("/postgres");
  });

  it("never overrides values already in the URL, and honours env overrides", () => {
    const custom = new URL(
      withConnectionTimeouts(`${base}?connect_timeout=7&pgbouncer=true`, {
        DB_POOL_TIMEOUT_S: "12",
      } as never),
    );
    expect(custom.searchParams.get("connect_timeout")).toBe("7");
    expect(custom.searchParams.get("pool_timeout")).toBe("12");
    expect(custom.searchParams.get("pgbouncer")).toBe("true");
  });

  it("returns an unparsable value unchanged", () => {
    expect(withConnectionTimeouts("not a url")).toBe("not a url");
  });
});
