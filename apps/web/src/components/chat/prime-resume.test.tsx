// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  initialPrimeResumeModel,
  primeResumeReduce,
  primeResumeSurface,
  type PrimeResumeModel,
} from "@t3tools/client-runtime/prime-resume";
import { PrimeResumeBanner } from "./PrimeResumeBanner";

const model = (over: Partial<PrimeResumeModel> = {}): PrimeResumeModel => ({
  ...initialPrimeResumeModel,
  ...over,
});
const noop = () => {};

describe("prime resume and recovery surface (web/desktop)", () => {
  it("renders nothing until the host publishes a resume state", () => {
    expect(
      renderToStaticMarkup(
        <PrimeResumeBanner providerName="prime-agent" model={model()} onRecover={noop} />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <PrimeResumeBanner
          providerName="codex"
          model={model({ state: { status: "reconnecting" } })}
          onRecover={noop}
        />,
      ),
    ).toBe("");
  });

  it("says the composer is paused while a resume is unresolved", () => {
    const markup = renderToStaticMarkup(
      <PrimeResumeBanner
        providerName="prime-agent"
        model={model({ state: { status: "reconnecting" } })}
        onRecover={noop}
      />,
    );
    expect(markup).toContain('data-state="reconnecting"');
    expect(markup).toContain("prime-resume-composer-blocked");
    expect(markup).toContain("Nothing is sent until this resolves.");
  });

  it("offers retry, fork and a confirmed fresh start for a refused resume", () => {
    const markup = renderToStaticMarkup(
      <PrimeResumeBanner
        providerName="prime-agent"
        model={model({ state: { status: "unavailable", reason: "incompatibleVersion" } })}
        onRecover={noop}
      />,
    );
    expect(markup).toContain('data-state="incompatible"');
    for (const choice of ["retry", "fork", "fresh"])
      expect(markup).toContain(`prime-resume-${choice}`);
    // The irreversible choice never fires from the first press.
    expect(markup).not.toContain("prime-resume-fresh-confirm");
  });

  it("shows a two-device conflict as retry-only, with history intact", () => {
    const markup = renderToStaticMarkup(
      <PrimeResumeBanner
        providerName="prime-agent"
        model={model({ state: { status: "unavailable", reason: "conflict" } })}
        onRecover={noop}
      />,
    );
    expect(markup).toContain('data-state="conflict"');
    expect(markup).toContain("This thread&#x27;s history is intact");
    expect(markup).not.toContain("prime-resume-fresh");
    expect(markup).not.toContain("prime-resume-fork");
  });

  it("stops blocking the composer once the exact session came back", () => {
    const markup = renderToStaticMarkup(
      <PrimeResumeBanner
        providerName="prime-agent"
        model={model({ state: { status: "resumed", mode: "adopted" } })}
        onRecover={noop}
      />,
    );
    expect(markup).toContain('data-state="resumed"');
    expect(markup).not.toContain("prime-resume-composer-blocked");
  });

  // The reconnect → failed relaunch path PA-B02 left without a terminal state.
  it("turns a reconnect with no follow-up into an actionable state", () => {
    const stalled = primeResumeReduce(
      primeResumeReduce(model(), { type: "state", state: { status: "reconnecting" } }),
      { type: "sessionStatus", status: "error" },
    );
    expect(primeResumeSurface("prime-agent", stalled).kind).toBe("stalled");
    const markup = renderToStaticMarkup(
      <PrimeResumeBanner providerName="prime-agent" model={stalled} onRecover={noop} />,
    );
    expect(markup).toContain('data-state="stalled"');
    expect(markup).toContain("no new session was started in its place");
  });

  it("keeps desktop on the same component and the same shared model as web", () => {
    // Desktop is the web bundle in an Electron shell: reuse is proven by there
    // being exactly one banner implementation and one shared surface module.
    const banner = NodeFS.readFileSync(
      "apps/web/src/components/chat/PrimeResumeBanner.tsx",
      "utf8",
    );
    expect(banner).toContain('from "@t3tools/client-runtime/prime-resume"');
    const mobile = NodeFS.readFileSync(
      "apps/mobile/src/features/threads/PrimeResumeBanner.tsx",
      "utf8",
    );
    expect(mobile).toContain('from "@t3tools/client-runtime/prime-resume"');
    // Neither client re-derives copy or choices locally; both read the surface.
    expect(banner).toContain("primeResumeSurface(props.providerName, props.model)");
    expect(mobile).toContain("primeResumeSurface(props.providerName, props.model)");
  });
});
