// Anonymous probes (RLM-384): what someone holding only a page URL, and nothing else, gets back.
import { describe, expect, it } from "vitest";
import { assetToken, call, newOwner, publish } from "./helpers";

const TITLE = "Quarterly layoffs plan — confidential";

async function page(): Promise<string> {
  const { id, ack } = await publish(await newOwner(), { args: { title: TITLE } });
  expect(ack.error).toBeUndefined();
  return id;
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: { message: string } }).error.message;
}

describe("anonymous probes of a published, invite-only page", () => {
  it("asset-token without an invite: 403 this page needs an invite", async () => {
    const res = await assetToken(await page());
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("this page needs an invite");
  });

  it("asset-token with a wrong invite: 403 this invite is not valid", async () => {
    const id = await page();
    for (const wrong of ["A".repeat(43), "not a token"]) {
      const res = await assetToken(id, wrong);
      expect(res.status, wrong).toBe(403);
      expect(await errorOf(res)).toBe("this invite is not valid");
    }
  });

  it("the artifact with a made-up asset token: 403", async () => {
    const id = await page();
    expect((await call(`/p/${id}/a/${"x".repeat(43)}/`)).status).toBe(403);
  });

  it("an owner cookie that is not a session is ignored", async () => {
    const id = await page();
    const res = await assetToken(id, undefined, { cookie: `austere_owner=${"A".repeat(43)}` });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toBe("this page needs an invite");
  });

  it("the owner's page list without a token: 401", async () => {
    const res = await call("/api/pages");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing bearer token" });
  });

  it("the shell is titled `Shared page · austere` and never carries the page title", async () => {
    const id = await page();
    for (const path of [`/p/${id}`, `/p/${id}?login=${"A".repeat(43)}`, `/p/${id}/a/${"x".repeat(43)}/`]) {
      const res = await call(path);
      const body = await res.text();
      for (const part of [TITLE, "layoffs", "confidential"]) expect(body, path).not.toContain(part);
      for (const value of res.headers.values()) expect(value, path).not.toContain("layoffs");
    }
    const html = await (await call(`/p/${id}`)).text();
    expect(/<title>(.*?)<\/title>/.exec(html)![1]).toBe("Shared page · austere");
  });
});
